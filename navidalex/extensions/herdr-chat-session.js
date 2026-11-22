// Herdr chat integration: publish public session identity and runtime capabilities.
// No prompts, messages, API keys or authentication tokens are written here.
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, appendFileSync,
  lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

const CONTROL_BYTES = 4096;
const REQUEST_MS = 8000;
const modelKey = model => model ? { provider: model.provider, id: model.id } : null;
const publicModel = m => ({
  ...modelKey(m),
  ref: `${m.provider}/${m.id}`,
  thinking: !!m.reasoning,
  ...(Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
});
const sameModel = (a, b) => a === b || Boolean(a && b && a.provider === b.provider && a.id === b.id);
const hasKeys = (value, keys) => value && typeof value === 'object' && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const modelPart = s => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\u0000-\u001f\u007f]/.test(s);
const validModel = m => hasKeys(m, ['provider', 'id']) && modelPart(m.provider) && modelPart(m.id);
const matches = (identity, value) => value && Object.keys(identity).every(key => identity[key] === value[key]);

function scopedAvailable(ctx, available = ctx.modelRegistry.getAvailable()) {
  const scope = ctx.scopedModels;
  return scope?.length ? available.filter(m => scope.some(s => sameModel(s.model, m))) : available;
}

function readControlFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > CONTROL_BYTES) return null;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(CONTROL_BYTES + 1);
      let size = 0;
      while (size < buf.length) {
        const n = readSync(fd, buf, size, buf.length - size, null);
        if (!n) break;
        size += n;
      }
      return size <= CONTROL_BYTES ? buf.toString('utf8', 0, size) : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

export default function (pi) {
  // Herdr (TUI) sets HERDR_PANE_ID; herdr-app's terminals only get HC_TERMINAL_ID (their address).
  const pane = process.env.HERDR_ENV === '1' && process.env.HERDR_PANE_ID ? process.env.HERDR_PANE_ID : process.env.HC_TERMINAL_ID;
  // Diagnostic: which Herdr variables this Pi got (presence only, never values), so a Pi that
  // never publishes can be explained. One small file per process, overwritten.
  try {
    const diag = join(process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app'), 'data', 'any-chat');
    mkdirSync(diag, { recursive: true });
    const has = (k) => (process.env[k] ? 'set' : 'missing');
    writeFileSync(join(diag, 'pi-env.log'), `${new Date().toISOString()} pid=${process.pid} HERDR_ENV=${process.env.HERDR_ENV ?? 'missing'} HERDR_PANE_ID=${has('HERDR_PANE_ID')} HERDR_SOCKET_PATH=${has('HERDR_SOCKET_PATH')} HERDR_APP_HOME=${has('HERDR_APP_HOME')} PI_CODING_AGENT_DIR=${has('PI_CODING_AGENT_DIR')} HC_TERMINAL_ID=${has('HC_TERMINAL_ID')}\n`);
  } catch {}
  if (!pane || !/^[a-zA-Z0-9_-]{1,128}$/.test(pane)) return;
  const directory = join(process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app'), 'data', 'any-chat', 'sessions');
  const file = join(directory, `${pane}.json`);
  const controlFile = join(directory, `${pane}.control.json`);
  let active = false;
  let generation = 0;
  let lastContext;
  let timer;
  let lastPublished = 0;
  let control, controlTimer, inFlight;
  let sequence = 0;
  let consumed;

  function effective(ctx) {
    const model = ctx.model;
    return { model: modelKey(model), thinking: pi.getThinkingLevel(), levels: model ? getSupportedThinkingLevels(model) : [] };
  }

  function writeSlot(owner, slot) {
    const text = JSON.stringify(slot);
    if (Buffer.byteLength(text) > CONTROL_BYTES) throw new Error('Control slot exceeds its size limit');
    const temp = `${controlFile}.${owner.instance}.tmp`;
    try {
      writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
      renameSync(temp, controlFile);
    } finally { try { unlinkSync(temp); } catch {} }
  }

  function requestStatus(request, owner, ctx) {
    if (!matches(owner, request) || request.sequence !== sequence) return 'stale';
    if (!hasKeys(request, [...Object.keys(owner), 'sequence', 'requestId', 'created', 'action', 'value', 'expectedModel'])
      || !request.requestId.startsWith(`${sequence.toString(36)}-`)
      || !Number.isSafeInteger(request.created) || request.created > Date.now() || Date.now() - request.created > REQUEST_MS
      || (request.expectedModel !== null && !validModel(request.expectedModel))) return 'rejected';
    if (owner.id !== ctx.sessionManager.getSessionId() || !sameModel(request.expectedModel, modelKey(ctx.model))) return 'stale';
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return 'busy';
    return null;
  }

  async function applyRequest(request, owner, ctx) {
    const status = requestStatus(request, owner, ctx);
    if (status) return { status };
    // Bump before the setter; a lost or overwritten ack cannot replay this sequence.
    sequence++;
    if (request.action === 'set-thinking') {
      if (!effective(ctx).levels.includes(request.value)) return { status: 'rejected' };
      pi.setThinkingLevel(request.value);
      const current = effective(ctx);
      return current.thinking === request.value && sameModel(current.model, request.expectedModel)
        ? { status: 'applied', effective: current } : { status: 'unconfirmed' };
    }
    if (request.action !== 'set-model' || !validModel(request.value)) return { status: 'rejected' };
    const model = scopedAvailable(ctx).find(m => sameModel(m, request.value));
    if (!model || !await pi.setModel(model)) return { status: 'rejected' };
    const current = effective(ctx);
    return sameModel(current.model, request.value) && current.levels.includes(current.thinking)
      ? { status: 'applied', effective: current } : { status: 'unconfirmed' };
  }

  function inspectSlot(owner, ctx) {
    if (!active || control !== owner || inFlight) return;
    const raw = readControlFile(controlFile);
    if (!raw || raw === consumed) return;
    let slot;
    try { slot = JSON.parse(raw); } catch { return; }
    if (!matches(owner, slot) || !slot.request) return;
    const request = slot.request;
    if (typeof request.requestId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(request.requestId)) return;
    consumed = raw;
    const startSequence = sequence;
    inFlight = Promise.resolve().then(async () => {
      let ack;
      try {
        if (!active || control !== owner || slot.sequence !== request.sequence) ack = { status: 'stale' };
        else if (!hasKeys(slot, [...Object.keys(owner), 'sequence', 'request'])) ack = { status: 'rejected' };
        else ack = await applyRequest(request, owner, ctx);
      } catch { ack = { status: 'unconfirmed' }; }
      if (!active || control !== owner || owner.id !== ctx.sessionManager.getSessionId()
        || readControlFile(controlFile) !== raw) return;
      // Retire well-formed attempts even on rejection; never roll the sequence back on replay.
      sequence = Math.max(sequence, startSequence + Number(slot.sequence === startSequence));
      snapshot(ctx);
      writeSlot(owner, { ...owner, sequence, ack: { requestId: request.requestId, ...ack } });
      consumed = undefined;
    }).catch(() => { /* Leave the request unconfirmed; don't retry mutation. */ }).finally(() => { inFlight = null; });
  }

  function snapshot(ctx) {
    try {
      write({ id: ctx.sessionManager.getSessionId(), session: ctx.sessionManager.getSessionFile(), ctx,
        models: ctx.modelRegistry.getAvailable(), modelError: null, commands: commandList() });
    } catch { /* The picker can still time out without guessing state. */ }
  }

  async function publish(ctx) {
    if (!active) return;
    const token = ++generation;
    const id = ctx.sessionManager.getSessionId();
    const session = ctx.sessionManager.getSessionFile();
    const available = () => ctx.modelRegistry.getAvailable();
    let models = [], modelError = null;
    // What the registry already knows, without waiting: a slow or stuck refresh must not keep the
    // chat from finding this session.
    try { models = available(); } catch (e) { log(e); }
    if (!lastPublished) write({ id, session, ctx, models, modelError: null, commands: commandList() });
    try {
      await Promise.race([ctx.modelRegistry.refresh(), new Promise((_, no) => setTimeout(() => no(new Error('model refresh timed out')), 8000).unref?.())]);
      models = available();
    } catch (e) { log(e); if (!models.length) modelError = 'Could not query models from this Pi session.'; }
    const commands = commandList();
    if (!active || token !== generation || id !== ctx.sessionManager.getSessionId()) return;
    write({ id, session, ctx, models, modelError, commands });
  }
  function commandList() {
    try { return pi.getCommands().map(c => ({ name: c.name, description: c.description || '', source: c.source || 'extension' })); }
    catch (e) { log(e); return []; }
  }
  // Errors go next to the metadata (no secrets: messages only), so a silent failure can be seen.
  function log(e) {
    try { mkdirSync(directory, { recursive: true }); appendFileSync(`${file}.log`, `${new Date().toISOString()} ${String(e?.stack ?? e).slice(0, 800)}\n`); } catch {}
  }
  function write({ id, session, ctx, models, modelError, commands }) {
    lastPublished = Date.now();
    // Retain the original public fields for chat discovery and command consumers.
    const data = { version: 1, pane, pid: process.pid, id, file: session || null, cwd: ctx.cwd,
      models: models.map(publicModel), modelError, commands, updated: Date.now() };
    if (control?.id === id) {
      data.control = { version: 1, instance: control.instance, ...effective(ctx), models: scopedAvailable(ctx, models).map(publicModel) };
    }
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    // Windows refuses the rename while a reader has the file open: then write it in place.
    try { renameSync(temporary, file); } catch { writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); try { unlinkSync(temporary); } catch {} }
  }
  async function update(_event, ctx) {
    lastContext = ctx;
    try { await publish(ctx); } catch (e) { log(e); /* Chat reports missing/unavailable metadata. */ }
  }
  pi.on('session_start', async (event, ctx) => {
    active = false;
    clearInterval(timer);
    clearInterval(controlTimer);
    if (inFlight) await inFlight;
    active = true;
    lastPublished = sequence = 0;
    consumed = undefined;
    control = undefined;
    const id = ctx.sessionManager.getSessionId();
    if (typeof id === 'string' && id.length > 0 && id.length <= 128 && typeof ctx.isIdle === 'function'
      && typeof ctx.hasPendingMessages === 'function' && typeof pi.setModel === 'function'
      && typeof pi.setThinkingLevel === 'function' && typeof pi.getThinkingLevel === 'function') {
      const owner = { version: 1, pane, pid: process.pid, id, instance: randomUUID() };
      try {
        mkdirSync(directory, { recursive: true });
        writeSlot(owner, { ...owner, sequence });
        control = owner;
        controlTimer = setInterval(() => inspectSlot(owner, ctx), 200);
        controlTimer.unref?.();
      } catch { /* Still publish the legacy metadata if the control slot is unavailable. */ }
    }
    // Not awaited: publishing must never hold up Pi's startup.
    void update(event, ctx);
    timer = setInterval(() => { if (lastContext) void update(null, lastContext); }, 10000);
    timer.unref?.();
  });
  pi.on('agent_end', update);
  for (const event of ['model_select', 'thinking_level_select']) {
    pi.on(event, (_event, ctx) => { if (active) snapshot(ctx); });
  }
  pi.on('session_shutdown', async () => {
    active = false; generation++;
    clearInterval(timer);
    clearInterval(controlTimer);
    const owner = control;
    // Reload reuses the same AgentSession. Wait for a setter already admitted before rebinding.
    if (inFlight) await inFlight;
    control = undefined;
    try { if (owner && matches(owner, JSON.parse(readControlFile(controlFile)))) unlinkSync(controlFile); } catch {}
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.pid === process.pid && data.control?.instance === owner?.instance) unlinkSync(file);
    } catch {}
  });
}
