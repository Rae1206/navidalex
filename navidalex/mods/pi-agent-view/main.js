// One Gentle Pi subagent, opened from pi-agents as a draggable window: its prompt, every
// thinking block, tool call and result, and the final answer, read from its session JSONL.
// Re-reads while the task is active and follows the end unless you scrolled up.
// Props: { file, id, overlay }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, ScrollHandle } from "gpui-base";
import { props, closeOverlay, theme, readTextFile, exec, notify, appHome } from "herdr";
import * as fs from "fs/promises";
import { parse as parseAny } from "./transcripts.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACTIVE = new Set(["running", "queued", "waiting", "starting"]);
const CLIP = 700;
const RECENT = 250;

function fmtElapsed(task) {
  const start = task?.startedAt ?? task?.createdAt;
  if (!start) return "";
  const s = Math.max(0, Math.round(((task.endedAt ?? Date.now()) - start) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function k(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0);
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Flattens the JSONL into display items.
function parse(jsonl) {
  const items = [];
  const usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0 };
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (!m) continue;
    if (m.role === "user") items.push({ kind: "user", text: textOf(m.content) });
    else if (m.role === "assistant") {
      if (m.usage) {
        usage.input += m.usage.input ?? 0; usage.output += m.usage.output ?? 0;
        usage.cacheRead += m.usage.cacheRead ?? 0; usage.reasoning += m.usage.reasoning ?? 0;
        usage.cost += m.usage.cost?.total ?? 0;
      }
      for (const b of m.content ?? []) {
        if (b.type === "thinking" && b.thinking?.trim()) items.push({ kind: "thinking", text: b.thinking.trim() });
        else if (b.type === "text" && b.text?.trim()) items.push({ kind: "text", text: b.text });
        else if (b.type === "toolCall") items.push({ kind: "call", name: b.name, args: b.arguments, id: b.id });
      }
      if (m.errorMessage) items.push({ kind: "error", text: m.errorMessage });
    } else if (m.role === "toolResult") {
      items.push({ kind: "result", name: m.toolName, text: textOf(m.content), error: m.isError === true, id: m.toolCallId });
    }
  }
  return { items, usage };
}

function argSummary(name, args) {
  if (!args || typeof args !== "object") return "";
  const v = args.path ?? args.file_path ?? args.command ?? args.pattern ?? args.query ?? args.url;
  return typeof v === "string" ? v : JSON.stringify(args).slice(0, 160);
}

export default class PiAgentView extends View {
  init(_props, cx) {
    this.task = null;
    this.items = [];
    this.usage = null;
    this.open = new Set();      // expanded item indexes
    this.hideThinking = false;
    this.hideTools = false;
    this.follow = true;
    this.lastSize = -1;
    this.scroll = ScrollHandle.new();
    this.load(cx);
    cx.timer.every(1500, (cx) => { if (!this.task || ACTIVE.has(this.task.status)) this.load(cx); });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const pr = props() ?? {};
      if (pr.source && pr.source !== "pi") { await this.loadOther(pr); cx.notify(); return; }
      const { file } = pr;
      try {
        const j = JSON.parse((await readTextFile(file)) ?? "null");
        this.task = j?.task ?? this.task;
      } catch { /* mid-write; next tick */ }
      const path = this.task?.sessionPath;
      if (path) {
        const text = (await readTextFile(path)) ?? "";
        if (text.length !== this.lastSize) {
          this.lastSize = text.length;
          const p = parse(text);
          this.items = p.items;
          this.usage = p.usage;
          if (this.follow) this.scroll.scroll_to_item(Math.max(0, this.shown().length - 1));
        }
      }
      cx.notify();
    });
  }

  // Claude Code / Codex / OpenCode sub-agent: its own transcript, in this view's item shapes.
  async loadOther(pr) {
    this.task = { id: pr.id, label: pr.label, agent: pr.agent, model: pr.model, status: pr.status,
      createdAt: pr.createdAt, endedAt: pr.endedAt, sessionPath: pr.ref };
    let raw = "";
    try {
      if (pr.source === "opencode") raw = (await exec("cmd", ["/d", "/c", "opencode", "export", pr.ref], { timeout: 60000 })).stdout;
      else raw = await fs.readFile(pr.ref, "utf8");
      // Every line of a Claude sub-agent transcript is a sidechain; the parser skips those in a main chat.
      if (pr.source === "claude") raw = raw.replace(/"isSidechain":true/g, "\"isSidechain\":false");
    } catch { return; }
    if (raw.length === this.lastSize) return;
    this.lastSize = raw.length;
    const items = [];
    for (const it of parseAny(pr.source, raw).items) {
      if (it.role === "user") items.push({ kind: "user", text: it.text });
      else if (it.kind === "thinking") items.push({ kind: "thinking", text: it.text });
      else if (it.kind === "text") items.push({ kind: "text", text: it.text });
      else if (it.kind === "tool") {
        items.push({ kind: "call", name: it.name, args: it.args });
        if (it.result !== undefined) items.push({ kind: "result", name: it.name, text: String(it.result), error: Boolean(it.error) });
      }
    }
    this.items = items;
    this.usage = null;
    if (this.follow) this.scroll.scroll_to_item(Math.max(0, this.shown().length - 1));
  }

  // Long runs have hundreds of blocks: show the newest RECENT unless "show all".
  shown() {
    const list = this.items
      .map((it, i) => ({ ...it, i }))
      .filter((it) => !(this.hideThinking && it.kind === "thinking") && !(this.hideTools && (it.kind === "call" || it.kind === "result")));
    this.hiddenCount = this.showAll ? 0 : Math.max(0, list.length - RECENT);
    return this.hiddenCount ? [list[0], ...list.slice(-RECENT)] : list;
  }

  toggle(i, cx) {
    if (this.open.has(i)) this.open.delete(i); else this.open.add(i);
    cx.notify();
  }

  btn(t, id, label, onClick, active = false) {
    return div().id(id).px(8).py(2).rounded(5).text_size(11.5).cursor_pointer()
      .bg(active ? t.selected : t.surface).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick).child(label);
  }

  clipped(text, i) {
    return this.open.has(i) || text.length <= CLIP ? text : `${text.slice(0, CLIP)}…`;
  }

  item(t, it) {
    const more = (text) => text.length > CLIP;
    const expander = (text) => more(text)
      ? div().id(`more-${it.i}`).text_size(11).text_color(t.accent).cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.toggle(it.i, cx)).child(this.open.has(it.i) ? "show less" : "show more")
      : null;
    const card = (accent) => v_flex().id(`it-${it.i}`).gap(4).px(10).py(8).rounded(8).border_l(3).border_color(accent).bg(t.background);
    switch (it.kind) {
      case "user":
        return card(t.accent)
          .child(div().text_size(11).font_semibold().text_color(t.accent).child("PROMPT"))
          .child(TextView.markdown(`md-${it.i}`, this.clipped(it.text, it.i)).selectable(true))
          .when(more(it.text), (el) => el.child(expander(it.text)));
      case "thinking":
        return card(t.ansi5)
          .child(div().text_size(11).font_semibold().text_color(t.ansi5).child("💭 THINKING"))
          .child(div().text_size(12).italic().text_color(t.muted).child(this.clipped(it.text, it.i)))
          .when(more(it.text), (el) => el.child(expander(it.text)));
      case "text":
        return card(t.done)
          .child(TextView.markdown(`md-${it.i}`, it.text).selectable(true));
      case "call":
        return h_flex().id(`it-${it.i}`).gap(8).px(10).py(5).rounded(6).bg(t.surface).items_center().cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.toggle(it.i, cx))
          .child(div().flex_none().text_color(t.working).font_semibold().child(`⚙ ${it.name}`))
          .child(div().flex_1().text_size(12).text_color(t.muted).when(!this.open.has(it.i), (el) => el.truncate())
            .child(this.open.has(it.i) ? JSON.stringify(it.args, null, 2) : argSummary(it.name, it.args)));
      case "result": {
        const text = it.text || "(no output)";
        return v_flex().id(`it-${it.i}`).gap(2).pl(22).pr(10).py(2)
          .child(div().text_size(11.5).font_family("monospace").text_color(it.error ? t.blocked : t.dim)
            .child(this.open.has(it.i) ? text : text.split("\n").slice(0, 4).join("\n").slice(0, 400) + (text.length > 400 || text.split("\n").length > 4 ? " …" : "")))
          .when(text.length > 400 || text.split("\n").length > 4, (el) => el.child(
            div().id(`rm-${it.i}`).text_size(11).text_color(t.accent).cursor_pointer()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => this.toggle(it.i, cx)).child(this.open.has(it.i) ? "collapse" : "full output")));
      }
      case "error":
        return card(t.blocked).child(div().text_color(t.blocked).child(it.text));
      default:
        return div();
    }
  }

  render(cx) {
    const t = theme();
    const x = this.task;
    const active = x && ACTIVE.has(x.status);
    const items = this.shown();
    const u = this.usage;
    return v_flex().id("pi-agent-view").size_full().bg(t.popover).text_size(13).rounded(10).border_1().border_color(t.border)
      // Title bar: drag the window by it.
      .child(h_flex().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().w(12).flex_none().text_color(active ? t.working : x?.status === "failed" ? t.blocked : t.done)
          .when(Boolean(active), (el) => el.frames(SPIN, 90)).child(active ? SPIN[0] : x?.status === "failed" ? "✕" : "✓"))
        .child(div().flex_1().truncate().font_semibold().text_color(t.foreground).child(x?.label || x?.id || "Subagent"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child([x?.agent, x?.model, x?.thinking, x?.status, fmtElapsed(x)].filter(Boolean).join(" · ")))
        .child(this.btn(t, "close", "✕", () => closeOverlay(props()?.overlay))))
      .child(h_flex().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.btn(t, "thinking", this.hideThinking ? "show thinking" : "hide thinking", (_e, cx) => { this.hideThinking = !this.hideThinking; cx.notify(); }))
        .child(this.btn(t, "tools", this.hideTools ? "show tools" : "hide tools", (_e, cx) => { this.hideTools = !this.hideTools; cx.notify(); }))
        .child(this.btn(t, "follow", "follow", (_e, cx) => { this.follow = !this.follow; if (this.follow) this.scroll.scroll_to_item(Math.max(0, items.length - 1)); cx.notify(); }, this.follow))
        .child(this.btn(t, "copy", "copy answer", (_e, cx) => cx.spawn(async () => {
          const answer = [...this.items].reverse().find((it) => it.kind === "text")?.text ?? x?.result ?? "";
          try {
            const tmp = `${appHome().replace(/\\/g, "/")}/pi-images/.clip.txt`;
            await fs.writeFile(tmp, String(answer), "utf8");
            await exec("powershell", ["-NoProfile", "-Command", `Get-Content -Raw -Encoding UTF8 -LiteralPath '${tmp}' | Set-Clipboard`]);
            notify({ title: "Copied", body: "Final answer copied", level: "success", timeout: 1500 });
          } catch (e) {
            notify({ title: "Copy failed", body: String(e?.message ?? e), level: "error" });
          }
        })))
        .child(div().flex_1())
        .when(Boolean(u), (el) => el.child(div().text_size(11).text_color(t.dim)
          .child(`in ${k(u.input)} · out ${k(u.output)} · think ${k(u.reasoning)} · cache ${k(u.cacheRead)}${u.cost ? ` · $${u.cost.toFixed(3)}` : ""}`))))
      .child(v_flex().id("pi-agent-items").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
        .on_scroll_wheel((_e, cx) => { if (this.follow) { this.follow = false; cx.notify(); } })
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .p(12).gap(6)
        .when(!x?.sessionPath, (el) => el.child(div().text_color(t.dim).child(x ? "No transcript yet (queued)." : "Loading…")))
        .children(items.map((it, n) => n === 1 && this.hiddenCount
          ? v_flex().gap(6).child(div().id("show-all").py(4).text_size(11.5).text_color(t.accent).cursor_pointer()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { this.showAll = true; cx.notify(); })
              .child(`… ${this.hiddenCount} earlier steps — show all`)).child(this.item(t, it))
          : this.item(t, it)))
        .when(Boolean(x?.error), (el) => el.child(div().px(10).py(8).rounded(8).bg(t.background).text_color(t.blocked).child(`Error: ${x.error}`))));
  }
}
