// Needs-you inbox: the agents waiting on the person (blocked, or done and waiting for review),
// each with a granular state badge and a short summary from the tail of its terminal.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, terminals, hc, run, theme, nextCommand, checking } from "herdr";

// Summaries refresh on a state change, and otherwise at most this often per agent.
const SUMMARY_EVERY = 10000;
const RANK = { blocked: 2, done: 1 };

// Granular states. `color: null` means the theme accent (done).
const STATES = {
  permission: { label: "Needs approval", color: "#e5787a", pulse: true },
  question: { label: "Asked a question", color: "#a78bfa" },
  auth: { label: "Needs sign-in", color: "#f5b84d" },
  error: { label: "Error", color: "#ef4444" },
  waiting: { label: "Waiting", color: "#a78bfa" },
  done: { label: "Done — review", color: null },
};

// Escape sequences: CSI, OSC (BEL or ST terminated), and two-byte escapes.
const ANSI = /\x1b\[[0-9;?<=>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const BOX = /[─-▟]/g;
// Decorations around a line: box edges, prompts, bullets, spinners.
const EDGE = /^[\s─-▟⠀-⣿|>›❯$#*•·⏺●◦✦✻✳-]+|[\s─-▟|]+$/gu;
// Footer hints agents draw under their prompt, not what they said.
const HINT = /^(type,? or \/|\? for shortcuts|esc to|ctrl\+|shift\+tab|press |enjoying |tip:|context left|auto-accept|bypass permissions)/i;
// Status lines: token rates and counts.
const STATS = /\btok\/s\b|\b\d[\d.,]*\s*tokens?\b|\bcache r\/w\b/i;

function summarize(text, msg) {
  const lines = [];
  for (const raw of (text ?? "").replace(ANSI, "").split(/\r?\n/)) {
    const boxes = (raw.match(BOX) ?? []).length;
    const line = raw.replace(EDGE, "").replace(/\s+/g, " ").trim();
    if (!line || !/[\p{L}\p{N}]{2,}/u.test(line)) continue;
    if (boxes > raw.trim().length * 0.3) continue;
    if (HINT.test(line) || STATS.test(line)) continue;
    lines.push(line.length > 160 ? `${line.slice(0, 159)}…` : line);
  }
  const tail = lines.slice(-2);
  const m = typeof msg === "string" ? msg.trim() : "";
  if (m && !tail.includes(m)) return [m, ...tail].slice(0, 2);
  return tail;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class NeedsInbox extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.sel = 0;
    this.list = [];
    // address -> { key, at, lines }
    this.summaries = new Map();
    this.loading = new Set();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.handle.focus(); cx.notify(); }
      }
    });
    if (checking()) return;
    cx.timer.every(SUMMARY_EVERY, (cx) => this.refresh(cx, false));
  }

  // The terminal record for an agent: its raw word (error stays error) and its report.
  facts(byAddress, a) {
    const term = byAddress.get(a.address);
    const report = term?.report && typeof term.report === "object" ? term.report : null;
    return { word: term?.status ?? a.status, kind: report?.kind ?? null, msg: typeof report?.msg === "string" ? report.msg : null };
  }

  stateOf(a, f) {
    if (a.status === "done") return STATES.done;
    if (f.kind === "permission") return STATES.permission;
    if (f.kind === "question") return STATES.question;
    if (f.kind === "auth") return STATES.auth;
    const text = [f.msg ?? "", ...(this.summaries.get(a.address)?.lines ?? [])].join(" ");
    if (f.word === "error" || /error/i.test(text)) return STATES.error;
    return STATES.waiting;
  }

  // Fetches summaries: every listed agent whose state changed, and (force) any older than SUMMARY_EVERY.
  refresh(cx, onlyChanged) {
    if (checking()) return;
    const now = Date.now();
    for (const { a, key } of this.list) {
      const s = this.summaries.get(a.address);
      const changed = !s || s.key !== key;
      if (this.loading.has(a.address)) continue;
      if (onlyChanged ? !changed : !changed && now - s.at < SUMMARY_EVERY) continue;
      this.loading.add(a.address);
      const address = a.address;
      cx.spawn(async (cx) => {
        try {
          const r = await hc(["read", address, "--lines", "40", "--json"]);
          let text = r.stdout;
          try { text = JSON.parse(r.stdout)?.text ?? r.stdout; } catch {}
          const old = this.summaries.get(address);
          const item = this.list.find((x) => x.a.address === address);
          const lines = summarize(r.code === 0 ? text : "", item?.msg);
          this.summaries.set(address, { key: item?.key ?? key, at: Date.now(), lines });
          if (JSON.stringify(old?.lines) !== JSON.stringify(lines)) cx.notify();
        } catch {
          this.summaries.set(address, { key, at: Date.now(), lines: this.summaries.get(address)?.lines ?? [] });
        } finally {
          this.loading.delete(address);
        }
      });
    }
    // Forget agents that left the inbox.
    const listed = new Set(this.list.map((x) => x.a.address));
    for (const k of [...this.summaries.keys()]) if (!listed.has(k)) this.summaries.delete(k);
  }

  move(by, cx) {
    if (!this.list.length) return;
    this.sel = Math.max(0, Math.min(this.list.length - 1, this.sel + by));
    this.scroll.scroll_to_item(this.sel);
    cx.notify();
  }

  open(a) {
    run("agent.focus", { terminal: a.address });
  }

  badge(t, st) {
    const color = st.color ?? t.accent;
    return h_flex().flex_none().h(18).px(6).gap(5).rounded(5).items_center().bg(color + "26")
      .child(div().size(6).rounded(3).bg(color).when(Boolean(st.pulse), (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1100 })))
      .child(div().text_size(10.5).font_semibold().text_color(color).child(st.label));
  }

  row(t, item, i, focusedList) {
    const { a, st } = item;
    const lines = this.summaries.get(a.address)?.lines ?? [];
    const pic = icon(a.program, 16, t.foreground);
    const on = focusedList && i === this.sel;
    const where = [a.space_name, a.tab_name].filter(Boolean).join(" / ");
    return v_flex()
      .id(`inbox-${a.address}`)
      .flex_none()
      .px(10)
      .py(7)
      .gap(3)
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.sel = i; this.open(a); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().flex_none().max_w(140).truncate().font_semibold().text_color(t.foreground).child(a.program?.name || a.app || a.address))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(where))
        .child(this.badge(t, st)))
      .when(Boolean(a.title), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(a.title)))
      .children(lines.map((l) => div().truncate().text_size(11.5).text_color(t.dim).child(l)));
  }

  render(cx) {
    const t = theme();
    const byAddress = new Map(terminals().map((x) => [x.address, x]));
    const waiting = agents().filter((a) => RANK[a.status]);
    waiting.sort((x, y) => RANK[y.status] - RANK[x.status] || (y.seq ?? 0) - (x.seq ?? 0));
    this.list = waiting.map((a) => {
      const f = this.facts(byAddress, a);
      return { a, msg: f.msg, key: `${a.status}|${f.word}|${f.kind ?? ""}|${f.msg ?? ""}`, st: this.stateOf(a, f) };
    });
    if (this.sel >= this.list.length) this.sel = Math.max(0, this.list.length - 1);
    this.refresh(cx, true);
    // No blur callback exists: the highlight follows focus on the next redraw.
    const focusedList = this.handle.is_focused();
    const count = this.list.length;

    return v_flex()
      .id("needs-inbox")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "j" || k === "down") { this.move(1, cx); cx.stop_propagation(); }
        else if (k === "k" || k === "up") { this.move(-1, cx); cx.stop_propagation(); }
        else if (k === "enter" && this.list[this.sel]) { this.open(this.list[this.sel].a); cx.stop_propagation(); }
      })
      .child(h_flex().h(40).px(16).flex_none().gap(8).items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Needs you"))
        .child(div().px(6).h(16).rounded(5).flex().items_center().text_size(10.5).font_semibold()
          .bg(count ? t.blocked + "26" : t.raised).text_color(count ? t.blocked : t.dim).child(String(count))))
      .when(count === 0, (el) => el.child(div().px(16).py(8).text_size(12).text_color(t.dim).child("Nobody needs you right now")))
      .child(v_flex().id("inbox-list").flex_1().min_h(0).px(8).pb(8).gap(2).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(this.list.map((item, i) => this.row(t, item, i, focusedList))));
  }
}
