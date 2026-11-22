// The one-slot Pi control protocol. Files and clock are supplied by the host adapter.
const MAX_BYTES = 4096;
const REQUEST_MS = 8000;
const ACK_MS = 9000;
const instancePattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const safePane = /^[a-zA-Z0-9_-]{1,128}$/;

export function controlBinding(runtime) {
  if (runtime?.control?.version !== 1 || typeof runtime.control.instance !== "string" || !instancePattern.test(runtime.control.instance)
    || typeof runtime.pane !== "string" || !safePane.test(runtime.pane) || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0
    || typeof runtime.id !== "string" || !runtime.id || runtime.id.length > 128) return null;
  return { version: 1, pane: runtime.pane, pid: runtime.pid, id: runtime.id, instance: runtime.control.instance };
}

function matches(binding, value) {
  return Boolean(value) && Object.keys(binding).every(key => binding[key] === value[key]);
}

function sameModel(a, b) {
  return a === b || Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function decode(raw) {
  if (typeof raw !== "string" || raw.length > MAX_BYTES) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function submitControl({ runtime, action, value, readRuntime, readSlot, writeSlot, sleep, now = Date.now, alive = () => true }) {
  const binding = controlBinding(runtime);
  if (!binding) return { status: "unavailable" };
  const fresh = await readRuntime().catch(() => null);
  if (!matches(binding, controlBinding(fresh))) return { status: "stale" };
  const expectedModel = fresh.control.model;
  if (!sameModel(expectedModel, runtime.control.model)) return { status: "stale" };
  if (action === "set-model" ? !fresh.control.models?.some(m => sameModel(m, value))
    : action !== "set-thinking" || !fresh.control.levels?.includes(value)) return { status: "rejected" };

  const raw = await readSlot().catch(() => null);
  const slot = decode(raw);
  if (!matches(binding, slot) || !Number.isSafeInteger(slot.sequence) || slot.sequence < 0) return { status: "stale" };
  if (slot.request) {
    return { status: now() - slot.request.created > REQUEST_MS ? "unconfirmed" : "pending" };
  }
  if (!alive()) return { status: "unconfirmed" };
  const created = now();
  const sequence = slot.sequence;
  const requestId = `${sequence.toString(36)}-${created.toString(36)}-${Math.random().toString(36).slice(2) || "0"}`;
  const request = JSON.stringify({ ...binding, sequence, request: { ...binding, sequence, requestId, created, action, value, expectedModel } });
  // Restrict UTF-8 byte size conservatively without requiring browser or Node globals.
  if (request.length > MAX_BYTES / 3) return { status: "rejected" };
  try { await writeSlot(request, raw); }
  catch { return { status: "unconfirmed" }; } // A competing write or an uncertain transport result; never retry.

  for (let attempt = 0; attempt <= 60 && alive() && now() - created <= ACK_MS; attempt++) {
    const reply = decode(await readSlot().catch(() => null));
    if (reply && !matches(binding, reply)) return { status: "stale" };
    if (reply?.sequence > slot.sequence) {
      const ack = reply.ack;
      if (reply.sequence !== slot.sequence + 1 || ack?.requestId !== requestId) return { status: "unconfirmed" };
      const current = await readRuntime().catch(() => null);
      if (!matches(binding, controlBinding(current))) return { status: "stale" };
      if (["busy", "stale", "rejected", "unconfirmed"].includes(ack.status)) return { status: ack.status };
      const effective = ack.effective;
      if (ack.status === "applied" && Array.isArray(effective?.levels) && effective.levels.includes(effective.thinking)
        && (action === "set-model" ? sameModel(value, effective.model)
          : sameModel(expectedModel, effective.model) && value === effective.thinking)) {
        return { status: "applied", effective };
      }
      return { status: "unconfirmed" };
    }
    await sleep(150);
  }
  return { status: "unconfirmed" };
}
