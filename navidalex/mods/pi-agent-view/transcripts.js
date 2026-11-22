// Transcript parsers for Pi, Claude Code, Codex and OpenCode (a copy of agent-chat's:
// mods can't import from another mod's folder).

const SYSTEM_TAGS = /<(system-reminder|local-command-[a-z]+|command-[a-z]+|environment_context|recommended_plugins|app-context|user_instructions|turn_aborted)[\s\S]*?<\/\1>/g;

function cleanUser(text) {
  const s = String(text ?? "").replace(SYSTEM_TAGS, "").trim();
  // Context the harness injects as a user turn (Codex AGENTS.md, Claude caveats), not the person.
  return /^(# AGENTS.md instructions|<INSTRUCTIONS>|Caveat: The messages below)/.test(s) ? "" : s;
}

function blockText(c) {
  if (typeof c === "string") return c;
  return (c ?? []).map((b) => b.text ?? (typeof b.content === "string" ? b.content : "")).filter(Boolean).join("\n");
}

function lines(text) {
  const out = [];
  for (const l of text.split(/\r?\n/)) { if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* partial line */ } } }
  return out;
}

export function parse(kind, raw) {
  const items = [];
  const calls = new Map();
  const tool = (id, name, args) => { const it = { role: "assistant", kind: "tool", name, args }; items.push(it); if (id) calls.set(id, it); };
  const result = (id, text, error) => { const it = calls.get(id); if (it) { it.result = text; it.error = error; } };
  const say = (role, kind2, text) => { if (text && text.trim()) items.push({ role, kind: kind2, text: text.trim() }); };
  let model = null;

  if (kind === "pi") {
    for (const e of lines(raw)) {
      if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
      const m = e.message;
      if (!m) continue;
      if (m.role === "user") say("user", "text", cleanUser(blockText(m.content)));
      else if (m.role === "assistant") {
        for (const b of m.content ?? []) {
          if (b.type === "thinking") say("assistant", "thinking", b.thinking);
          else if (b.type === "text") say("assistant", "text", b.text);
          else if (b.type === "toolCall") tool(b.id, b.name, b.arguments);
        }
      } else if (m.role === "toolResult") result(m.toolCallId, blockText(m.content), m.isError);
    }
  } else if (kind === "claude") {
    for (const e of lines(raw)) {
      if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain || e.isMeta) continue;
      const m = e.message;
      if (e.type === "assistant" && m?.model) model = m.model;
      if (typeof m?.content === "string") { say(e.type, "text", e.type === "user" ? cleanUser(m.content) : m.content); continue; }
      for (const b of m?.content ?? []) {
        if (b.type === "text") say(e.type, "text", e.type === "user" ? cleanUser(b.text) : b.text);
        else if (b.type === "thinking") say("assistant", "thinking", b.thinking);
        else if (b.type === "tool_use") tool(b.id, b.name, b.input);
        else if (b.type === "tool_result") result(b.tool_use_id, blockText(b.content), b.is_error);
      }
    }
  } else if (kind === "codex") {
    for (const e of lines(raw)) {
      if (e.type === "turn_context" && e.payload?.model) model = e.payload.model;
      if (e.type !== "response_item") continue;
      const p = e.payload ?? {};
      if (p.type === "message" && p.role === "user") say("user", "text", cleanUser(blockText(p.content)));
      else if (p.type === "message" && p.role === "assistant") say("assistant", "text", blockText(p.content));
      else if (p.type === "reasoning") say("assistant", "thinking", (p.summary ?? []).map((s) => s.text).join("\n"));
      else if (p.type === "function_call") { let a = p.arguments; try { a = JSON.parse(a); } catch { /* keep text */ } tool(p.call_id, p.name, a); }
      else if (p.type === "custom_tool_call") tool(p.call_id, p.name, p.input);
      else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") result(p.call_id, typeof p.output === "string" ? p.output : blockText(p.output), false);
    }
  } else if (kind === "opencode") {
    let j = null;
    try { j = JSON.parse(raw); } catch { return { items, model }; }
    for (const m of j?.messages ?? []) {
      const role = m.info?.role === "user" ? "user" : "assistant";
      if (m.info?.modelID) model = `${m.info.providerID}/${m.info.modelID}`;
      for (const p of m.parts ?? []) {
        if (p.type === "text" && !p.synthetic) say(role, "text", role === "user" ? cleanUser(p.text) : p.text);
        else if (p.type === "reasoning") say("assistant", "thinking", p.text);
        else if (p.type === "tool") { tool(p.callID ?? p.id, p.tool, p.state?.input); result(p.callID ?? p.id, p.state?.output ?? p.state?.error ?? "", p.state?.status === "error"); }
      }
    }
  }
  return { items, model };
}
