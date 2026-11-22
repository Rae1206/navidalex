// The agents other than Claude Code, for the chat: which agent a terminal runs, where its
// session is, and how its transcript becomes the chat's items ({ kind: "user" | "claude" |
// "tool" | "note", ... }, the same shapes claude-chat's ingest makes).
//
// - Pi:       ~/.pi/agent/sessions/--<cwd>--/*.jsonl (message lines, toolCall / toolResult)
// - Codex:    ~/.codex/sessions/**/rollout-*.jsonl (response_item lines), matched by cwd
// - OpenCode: ~/.local/share/opencode/opencode.db (message + part rows), read with sqlite3
//
// Pi session identity is published by the companion herdr-chat-session extension.
// A working directory is not a session identity: multiple agents can share it.

import { exec, hc, home, appHome, panes, agents } from "herdr";
import { readFile } from "fs/promises";

export const NAMES = { claude: "Claude", pi: "Pi", codex: "Codex", opencode: "OpenCode" };
const SLACK_MS = 120000;

export function kindOf(agent) {
  if (!agent) return null;
  if (agent.app === "claude-code") return "claude";
  // The title too: OpenCode reports no status to Herdr, so its pane is known by program or title.
  const s = `${agent.app ?? ""} ${agent.program?.key ?? ""} ${agent.program?.name ?? ""} ${agent.title ?? ""}`.toLowerCase();
  if (/\bpi\b|gentle/.test(s)) return "pi";
  if (/codex/.test(s)) return "codex";
  if (/opencode/.test(s)) return "opencode";
  if (/claude/.test(s)) return "claude";
  return null;
}

const win = (p) => p.replace(/\//g, "\\");
const norm = (p) => win(String(p ?? "")).replace(/\\+$/, "").toLowerCase();
const H = () => win(home());
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The terminal's folder and when it opened.
export async function terminalInfo(address) {
  const t = JSON.parse((await hc(["get", address, "--json"])).stdout);
  return { cwd: t.foreground?.cwd ?? t.cwd ?? null, pid: t.pid,
    foregroundPid: t.foreground?.pid, since: Math.max(0, (t.created_ms ?? 0) - SLACK_MS) };
}

// Newest files under dir written since `since`, as full paths (PowerShell: fs has no stat).
async function newest(dir, filter, since, recurse = false, count = 30) {
  const r = await exec("powershell", ["-NoProfile", "-Command",
    `$s=[DateTimeOffset]::FromUnixTimeMilliseconds(${since}).UtcDateTime; Get-ChildItem -LiteralPath ${q(dir)} -Filter ${q(filter)} -File ${recurse ? "-Recurse" : ""} -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -ge $s } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First ${count} | ForEach-Object { $_.FullName }`],
    { timeout: 20000 });
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// First line of a file, read by PowerShell (shared, so a file being written is fine).
async function firstLines(files) {
  if (!files.length) return [];
  const r = await exec("powershell", ["-NoProfile", "-Command",
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; foreach ($f in @(${files.map(q).join(",")})) { $s=[IO.File]::Open($f,'Open','Read','ReadWrite'); $r=New-Object IO.StreamReader($s); $l=$r.ReadLine(); $r.Close(); if ($l.Length -gt 4000) { $l=$l.Substring(0,4000) }; Write-Output $l }`],
    { timeout: 20000 });
  return r.stdout.split(/\r?\n/);
}

async function sqlite(sql) {
  let reply;
  try {
    reply = await exec("sqlite3", ["-readonly", "-separator", "\t", `${H()}\\.local\\share\\opencode\\opencode.db`, sql], { timeout: 20000 });
  } catch (cause) {
    throw new Error("Could not run sqlite3 to read the OpenCode database. Check that sqlite3 is installed and available to Herdr.", { cause });
  }
  if (reply.code !== 0) {
    throw new Error(`Could not read the OpenCode database (sqlite3 exit ${reply.code ?? "unknown"}). Check the database path and permissions.`);
  }
  return reply;
}
const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

// A bridge file is named by the terminal address (herdr-app: HC_TERMINAL_ID) or by the Herdr
// pane id (Herdr TUI: HERDR_PANE_ID); its own "pane" field must name the same key.
async function readBridge(address, suffix) {
  const pane = panes().find(p => p.terminal === address)?.pane ?? agents().find(a => a.address === address)?.pane;
  for (const key of new Set([address, pane])) {
    if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) continue;
    try {
      const data = JSON.parse(await readFile(`${appHome()}/data/any-chat/sessions/${key}${suffix}`, "utf8"));
      if (data?.pane === key) return data;
    } catch {}
  }
  return null;
}

// Metadata is pane-specific and checked against the terminal's live process tree.
export async function runtimeMetadata(address) {
  const data = await readBridge(address, ".json");
  if (!data || data.version !== 1 || !Number.isInteger(data.pid)
    || !data.id || Date.now() - data.updated > 35000) return null;
  const info = await terminalInfo(address);
  if (![info.pid, info.foregroundPid].includes(data.pid)) {
    if (!Number.isInteger(info.pid)) return null;
    const check = await exec("powershell", ["-NoProfile", "-Command",
      `$n=${data.pid}; for($i=0;$i -lt 32 -and $n -gt 0;$i++){ if($n -eq ${info.pid}){exit 0}; $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$n\"; if(!$p){exit 1}; $n=$p.ParentProcessId }; exit 1`], { timeout: 10000 });
    if (check.code !== 0) return null;
  }
  return data;
}

// Codex and OpenCode publish their exact session per pane (~/.codex/hooks/herdr-chat-session.mjs,
// ~/.config/opencode/plugins/herdr-chat-session.js) as data/any-chat/sessions/<pane>.<kind>.json.
// A file older than the terminal belongs to an earlier program in that pane and is ignored.
async function bridgedSession(kind, address, since) {
  if (kind !== "codex" && kind !== "opencode") return null;
  const data = await readBridge(address, `.${kind}.json`);
  if (data?.version !== 1 || data.kind !== kind || typeof data.id !== "string"
    || !/^[a-zA-Z0-9_-]+$/.test(data.id) || !(data.updated >= since)) return null;
  if (kind === "opencode") return `opencode:${data.id}`;
  if (typeof data.file === "string" && data.file) return data.file;
  return (await newest(`${H()}\\.codex\\sessions`, `rollout-*${data.id}.jsonl`, 0, true, 1))[0] ?? null;
}

// The session file (Pi, Codex) or "opencode:<id>" the agent in `address` is on, or null.
export async function findSession(kind, address) {
  if (kind === "pi") {
    const runtime = await runtimeMetadata(address);
    if (!runtime) throw new Error("Run /reload once in this Pi terminal to enable its isolated chat, models and commands.");
    return runtime.file ?? null;
  }
  const { cwd, since } = await terminalInfo(address);
  const bound = await bridgedSession(kind, address, since);
  if (bound) return bound;
  if (kind === "opencode") {
    throw new Error("Restart this OpenCode once with the Herdr session plugin enabled, or continue in Terminal until this pane reports its session.");
  }
  if (!cwd) return null;
  // Legacy Codex lookup: do not guess when more than one agent shares this folder.
  const twins = panes().filter(p => p.terminal && p.terminal !== address && kindOf(p) === kind && p.cwd && norm(p.cwd) === norm(cwd));
  if (twins.length) throw new Error(`Restart this ${NAMES[kind]} once so the chat can tell it apart from the other ${NAMES[kind]} in this folder.`);
  if (kind === "codex") {
    const files = await newest(`${H()}\\.codex\\sessions`, "rollout-*.jsonl", since, true, 12);
    const heads = await firstLines(files);
    for (let i = 0; i < files.length; i++) {
      // Sub-agents' rollouts share the folder: only a main thread is this terminal's chat.
      if (/"subagent"/.test(heads[i] ?? "")) continue;
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(heads[i] ?? "");
      if (m && norm(JSON.parse(`"${m[1]}"`)) === norm(cwd)) return files[i];
    }
    return null;
  }
  return null;
}

// ---------- transcripts → items ----------

const SYSTEM_TAGS = /<(system-reminder|local-command-[a-z]+|command-[a-z]+|environment_context|recommended_plugins|app-context|user_instructions|turn_aborted|INSTRUCTIONS)[\s\S]*?<\/\1>/g;
function userText(s) {
  const t = String(s ?? "").replace(SYSTEM_TAGS, "").trim();
  return /^(# AGENTS\.md instructions|<INSTRUCTIONS>)/.test(t) ? "" : t;
}
const blockText = (c) => typeof c === "string" ? c
  : (c ?? []).map((b) => b.text ?? (typeof b.content === "string" ? b.content : "")).filter(Boolean).join("\n");
const blockRawImages = (c) => {
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const b of c) {
    if (!b) continue;
    if (b.type === "image" && (b.data || b.source?.data)) {
      out.push({ data: b.data ?? b.source.data, mimeType: b.mimeType ?? b.source?.media_type ?? "image/png" });
    } else if (b.type === "input_image" && typeof b.image_url === "string" && b.image_url.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(b.image_url);
      if (m) out.push({ data: m[2], mimeType: m[1] });
    }
  }
  return out;
};
const clip = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

function add(into, item) { into.items.push(item); }
function tool(into, id, name, input) {
  const t = { kind: "tool", id, name, input: input && typeof input === "object" ? input : { input } };
  if (id) into.tools.set(id, t);
  into.items.push(t);
}
function result(into, id, text, error) {
  const t = into.tools.get(id);
  if (t) { t.result = clip(String(text ?? "")); t.error = Boolean(error); }
}

// New whole lines of a Pi or Codex transcript. Returns the model the lines name, if any.
export function ingestLines(kind, chunk, into) {
  let model = null;
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (kind === "pi") {
      if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
      const m = e.message;
      if (!m) continue;
      if (m.role === "user") {
        const t = userText(blockText(m.content));
        const rawImages = blockRawImages(m.content);
        if (t || rawImages.length) add(into, rawImages.length ? { kind: "user", text: t, rawImages } : { kind: "user", text: t });
      }
      else if (m.role === "assistant") {
        const rawImages = blockRawImages(m.content);
        let attachedImages = false;
        for (const b of m.content ?? []) {
          if (b.type === "text" && b.text?.trim()) {
            const item = { kind: "claude", text: b.text.trim() };
            if (!attachedImages && rawImages.length) { item.rawImages = rawImages; attachedImages = true; }
            add(into, item);
          }
          else if (b.type === "thinking" && b.thinking?.trim()) add(into, { kind: "thinking", text: b.thinking.trim() });
          else if (b.type === "toolCall") tool(into, b.id, b.name, b.arguments);
        }
        if (!attachedImages && rawImages.length) add(into, { kind: "claude", text: "", rawImages });
        if (m.errorMessage) add(into, { kind: "note", text: m.errorMessage });
      } else if (m.role === "toolResult") result(into, m.toolCallId, blockText(m.content), m.isError);
    } else if (kind === "codex") {
      if (e.type === "turn_context" && e.payload?.model) model = e.payload.model;
      if (e.type !== "response_item") continue;
      const p = e.payload ?? {};
      if (p.type === "message" && p.role === "user") {
        const t = userText(blockText(p.content));
        const rawImages = blockRawImages(p.content);
        if (t || rawImages.length) add(into, rawImages.length ? { kind: "user", text: t, rawImages } : { kind: "user", text: t });
      }
      else if (p.type === "message" && p.role === "assistant") {
        const t = blockText(p.content).trim();
        const rawImages = blockRawImages(p.content);
        if (t || rawImages.length) add(into, rawImages.length ? { kind: "claude", text: t, rawImages } : { kind: "claude", text: t });
      }
      else if (p.type === "reasoning") {
        const t = (p.summary ?? []).map((x) => x.text).filter(Boolean).join("\n\n").trim();
        if (t) add(into, { kind: "thinking", text: t });
      }
      else if (p.type === "function_call") { let a = p.arguments; try { a = JSON.parse(a); } catch { /* text */ } tool(into, p.call_id, p.name, a); }
      else if (p.type === "custom_tool_call") tool(into, p.call_id, p.name, { input: p.input });
      else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        result(into, p.call_id, typeof p.output === "string" ? p.output : blockText(p.output), false);
      }
    }
  }
  return model;
}

// OpenCode: a cheap fingerprint of the session (part count and last update), to read again
// only when it changed.
export async function opencodeStamp(id) {
  const r = await sqlite(`select count(*) || ':' || coalesce(max(time_updated),0) from part where session_id = ${sqlText(id)}`);
  return r.stdout.trim();
}

// OpenCode: the session's last `limit` text and tool parts, as items (rebuilt each time:
// parts are updated in place while they stream).
export async function opencodeItems(id, into, limit = 800) {
  const sql = `select json_object('role', json_extract(m.data,'$.role'), 'model', json_extract(m.data,'$.modelID'),
    'type', json_extract(p.data,'$.type'), 'synthetic', json_extract(p.data,'$.synthetic'),
    'text', substr(coalesce(json_extract(p.data,'$.text'),''),1,20000), 'tool', json_extract(p.data,'$.tool'),
    'call', coalesce(json_extract(p.data,'$.callID'), p.id), 'input', json_extract(p.data,'$.state.input'),
    'output', substr(coalesce(json_extract(p.data,'$.state.output'), json_extract(p.data,'$.state.error'), ''),1,4000),
    'status', json_extract(p.data,'$.state.status'))
    from part p join message m on m.id = p.message_id
    where p.session_id = ${sqlText(id)} and json_extract(p.data,'$.type') in ('text','tool','reasoning')
    order by m.time_created, p.id`;
  const r = await sqlite(`select * from (${sql.replace(/\s+/g, " ")}) limit -1 offset max(0, (select count(*) from part where session_id = ${sqlText(id)} and json_extract(data,'$.type') in ('text','tool','reasoning')) - ${limit})`);
  into.items = [];
  into.tools = new Map();
  let model = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    if (p.model) model = p.model;
    if (p.type === "text" && !p.synthetic) {
      const t = p.role === "user" ? userText(p.text) : String(p.text ?? "").trim();
      if (t) add(into, { kind: p.role === "user" ? "user" : "claude", text: t });
    } else if (p.type === "reasoning") {
      const t = String(p.text ?? "").trim();
      if (t) add(into, { kind: "thinking", text: t });
    } else if (p.type === "tool") {
      let input = p.input;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* text */ } }
      tool(into, p.call, p.tool, input);
      if (p.status === "completed" || p.status === "error") result(into, p.call, p.output, p.status === "error");
    }
  }
  return model;
}
