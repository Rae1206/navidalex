// What every agent did, grouped by whose move it is: Your move, Working, Idle.
// Each card's recap line comes from the tail of the agent's terminal (`hc read`), locally;
// an optional AI recap runs `claude -p --model haiku` only when the person asks for it.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, run, theme, hc, exec, home, checking, nextCommand, setAgentOrder } from "herdr";
import { plainLines, meaningfulLines, recapLine, fingerprint, aiPrompt } from "./recap.js";

const GROUPS = [
  { id: "yours", label: "Your move", statuses: ["blocked", "done"], color: "blocked" },
  { id: "working", label: "Working", statuses: ["working"], color: "working" },
  { id: "idle", label: "Idle", statuses: ["idle"], color: "idle" },
];
const PERIOD = 15000; // Local recaps refresh at most this often, plus on status changes.
const MIN_GAP = 2000; // Bursts of status changes share one refresh.
const AI_TIMEOUT = 180000;
const AI_PARALLEL = 2;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const firstLine = (s) => String(s ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export default class Recap extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.local = {}; // address -> { line, fp, lines, at }
    this.ai = {}; // address -> { fp, text?, error?, running?, queued? }
    this.seen = {}; // address -> { status, at } (at: when we saw it change, or null)
    this.selected = 0;
    this.order = [];
    this.lastRun = 0;
    this.wake = null;
    this.pendingWake = false;
    this.claudeBin = null;
    this.readError = null;

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        cx.notify();
      }
    });
    // Elapsed labels only; the list itself redraws on live data.
    cx.timer.every(30000, (cx) => cx.notify());

    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const gap = Date.now() - this.lastRun;
        if (gap < MIN_GAP) await cx.sleep(MIN_GAP - gap);
        this.lastRun = Date.now();
        await this.refresh();
        cx.notify();
        if (!this.pendingWake) await Promise.race([cx.sleep(PERIOD), new Promise((resolve) => { this.wake = resolve; })]);
        this.wake = null;
        this.pendingWake = false;
      }
    });
  }

  // Reads every agent's tail and recomputes its recap line. Drops AI recaps whose output moved on.
  async refresh() {
    const list = agents();
    const results = await Promise.all(list.map(async (a) => {
      try {
        const r = await hc(["read", a.address, "--lines", "80"]);
        return [a.address, r.code === 0 ? r.stdout : null, r.code === 0 ? null : firstLine(r.stderr)];
      } catch (e) {
        return [a.address, null, String(e?.message ?? e)];
      }
    }));
    let failed = null;
    for (const [address, text, error] of results) {
      if (text == null) { failed = error; continue; }
      const lines = meaningfulLines(text);
      const fp = fingerprint(lines);
      const tail = plainLines(text).filter((l) => l.trim()).slice(-80);
      this.local[address] = { line: recapLine(text), fp, lines: tail, at: Date.now() };
      const ai = this.ai[address];
      if (ai && !ai.running && !ai.queued && ai.fp !== fp) delete this.ai[address];
    }
    this.readError = failed;
    const live = new Set(list.map((a) => a.address));
    for (const k of Object.keys(this.local)) if (!live.has(k)) delete this.local[k];
  }

  // Notes status changes (for elapsed time) and wakes the refresh loop when one happened.
  track(list, now) {
    let changed = false;
    for (const a of list) {
      const prev = this.seen[a.address];
      if (!prev) this.seen[a.address] = { status: a.status, at: null };
      else if (prev.status !== a.status) {
        this.seen[a.address] = { status: a.status, at: now };
        changed = true;
      }
    }
    if (changed) this.kick();
  }

  // Wakes the refresh loop now, or right after the refresh that is running.
  kick() {
    if (this.wake) this.wake();
    else this.pendingWake = true;
  }

  since(a, tab) {
    const own = this.seen[a.address]?.at;
    if (own) return own;
    return (a.status === "working" ? tab?.working_since : tab?.changed_at) ?? null;
  }

  // `claude` as the person's shell finds it. The mod's PATH is minimal on Windows, so when
  // the bare name can't start, PowerShell (the shell agents start in) is asked where it is.
  async runClaude(prompt) {
    const args = ["-p", "--model", "haiku", prompt];
    const opts = { cwd: home(), timeout: AI_TIMEOUT };
    if (this.claudeBin) return exec(this.claudeBin, args, opts);
    try {
      const r = await exec("claude", args, opts);
      this.claudeBin = "claude";
      return r;
    } catch (first) {
      let found = "";
      try {
        const w = await exec("powershell", ["-NoProfile", "-Command",
          "(Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -like '*.exe' } | Select-Object -First 1).Source"],
          { timeout: 20000 });
        found = firstLine(w.stdout);
      } catch { /* fall through to the error below */ }
      if (!found) throw new Error(`claude not found (${firstLine(first?.message ?? first) || "not on PATH"})`);
      this.claudeBin = found;
      return exec(found, args, opts);
    }
  }

  async summarize(a) {
    const local = this.local[a.address];
    const entry = this.ai[a.address] ?? {};
    if (entry.running) return;
    if (!local?.lines?.length) {
      this.ai[a.address] = { fp: local?.fp ?? null, error: "Nothing to summarize yet" };
      return;
    }
    this.ai[a.address] = { fp: local.fp, running: true };
    try {
      const r = await this.runClaude(aiPrompt(a.program?.name ?? a.app ?? "agent", local.lines));
      const text = firstLine(r.stdout);
      this.ai[a.address] = r.code === 0 && text
        ? { fp: local.fp, text: clip(text, 280) }
        : { fp: local.fp, error: clip(firstLine(r.stderr) || firstLine(r.stdout) || `claude exited with ${r.code}`, 200) };
    } catch (e) {
      this.ai[a.address] = { fp: local.fp, error: clip(String(e?.message ?? e), 200) };
    }
  }

  summarizeOne(a, cx) {
    const ai = this.ai[a.address];
    if (ai?.running || ai?.queued) return;
    cx.spawn(async (cx) => {
      const pending = this.summarize(a);
      cx.notify();
      await pending;
      cx.notify();
    });
    cx.notify();
  }

  summarizeAll(list, cx) {
    const todo = list.filter((a) => {
      const ai = this.ai[a.address];
      return !ai?.running && !(ai?.text && ai.fp === this.local[a.address]?.fp);
    });
    if (!todo.length) return;
    for (const a of todo) this.ai[a.address] = { fp: this.local[a.address]?.fp ?? null, queued: true };
    cx.notify();
    for (let w = 0; w < AI_PARALLEL; w++) {
      cx.spawn(async (cx) => {
        for (;;) {
          const a = todo.shift();
          if (!a) return;
          const pending = this.summarize(a);
          cx.notify();
          await pending;
          cx.notify();
        }
      });
    }
  }

  focusAgent(a) {
    run("agent.focus", { terminal: a.address });
  }

  badge(t, status) {
    if (status === "working") return div().flex_none().w(12).text_size(12).text_color(t.working).frames(SPINNER, 90);
    if (status === "blocked") return div().size(8).flex_none().rounded(4).bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1200 });
    if (status === "done") return div().size(8).flex_none().rounded(4).bg(t.done);
    return div().size(8).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  }

  button(t, id, label, busy, onClick) {
    return h_flex().id(id).flex_none().gap(6).items_center().px(8).h(22).rounded(5)
      .border(1).border_color(t.border).bg(t.raised).text_size(11).text_color(t.foreground)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!busy) onClick(cx); })
      .when(busy, (el) => el.child(div().w(10).text_color(t.accent).frames(SPINNER, 90)))
      .child(label);
  }

  card(t, a, tab, report, now, index) {
    const local = this.local[a.address];
    const ai = this.ai[a.address];
    const fresh = ai?.text && ai.fp === local?.fp;
    const busy = Boolean(ai?.running || ai?.queued);
    const since = this.since(a, tab);
    const tabName = tab?.named ? tab.name : `tab ${a.tab_index ?? tab?.index ?? ""}`.trim();
    const where = [a.space_name, tabName].filter(Boolean).join(" / ");
    const statusText = [a.status, report, since ? duration(now - since) : null].filter(Boolean).join(" · ");
    const line = fresh ? ai.text : local?.line || (local ? "No recent output" : "Reading…");
    const pic = icon(a.program, 16, t.foreground);
    const selected = index === this.selected;

    return v_flex()
      .id(`card-${a.address}`)
      .flex_none()
      .p(10)
      .gap(5)
      .rounded(8)
      .bg(a.focused ? t.selected : t.surface)
      .border(1)
      .border_color(selected ? t.accent : a.status === "blocked" ? t.blocked : t.border)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.focusAgent(a))
      .child(h_flex().gap(8).items_center()
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(a.program?.name || a.app || a.address))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(a.address))
        .child(this.badge(t, a.status)))
      .child(h_flex().gap(8).items_center().text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(where))
        .child(div().flex_none().text_color(t[a.status] ?? t.dim).child(statusText)))
      .child(h_flex().gap(6).items_start()
        .when(Boolean(fresh), (el) => el.child(div().flex_none().px(4).rounded(3).bg(t.accent).text_color(t.accent_foreground).text_size(10).child("AI")))
        .child(div().flex_1().min_w(0).text_size(12).text_color(local?.line || fresh ? t.foreground : t.dim).child(line)))
      .when(Boolean(ai?.error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(ai.error)))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1())
        .child(this.button(t, `sum-${a.address}`, ai?.queued ? "Queued" : busy ? "Summarizing" : fresh ? "Summarize again" : "Summarize", busy,
          (cx) => this.summarizeOne(a, cx))));
  }

  group(t, g, cards) {
    return v_flex().flex_none().gap(6)
      .child(h_flex().gap(8).items_center().px(2).pt(4)
        .child(div().size(8).rounded(4).bg(t[g.color] ?? t.dim))
        .child(div().font_semibold().text_color(t.foreground).child(g.label))
        .child(div().text_color(t.dim).child(String(cards.length))))
      .when(cards.length === 0, (el) => el.child(div().px(2).text_size(12).text_color(t.dim).child("Nothing here")))
      .children(cards);
  }

  onKey(e, cx) {
    const n = this.order.length;
    if (!n) return;
    if (e.keystroke === "down" || e.keystroke === "j") this.selected = Math.min(n - 1, this.selected + 1);
    else if (e.keystroke === "up" || e.keystroke === "k") this.selected = Math.max(0, this.selected - 1);
    else if (e.keystroke === "enter") this.focusAgent(this.order[this.selected]);
    else if (e.keystroke === "s") this.summarizeOne(this.order[this.selected], cx);
    else if (e.keystroke === "r") this.kick();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const list = agents();
    this.track(list, now);
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const reports = new Map(terminals().map((x) => [x.address, typeof x.report?.kind === "string" ? x.report.kind : null]));
    const sorted = [...list].sort((x, y) => y.seq - x.seq);
    const grouped = GROUPS.map((g) => sorted.filter((a) => g.statuses.includes(a.status)));
    this.order = grouped.flat();
    if (this.selected >= this.order.length) this.selected = Math.max(0, this.order.length - 1);
    setAgentOrder(this.order.map((a) => a.address));
    const anyBusy = this.order.some((a) => this.ai[a.address]?.running || this.ai[a.address]?.queued);
    let index = 0;

    return v_flex()
      .id("recap-root")
      .size_full()
      .min_h(0)
      .bg(t.canvas)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().flex_none().h(40).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().font_semibold().text_color(t.foreground).child("Recap"))
        .child(div().text_color(t.dim).child(`${list.length} agent${list.length === 1 ? "" : "s"}`))
        .child(div().flex_1())
        .when(Boolean(this.readError), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.blocked).child(this.readError)))
        .child(this.button(t, "sum-all", anyBusy ? "Summarizing" : "Summarize all", anyBusy, (cx) => this.summarizeAll(this.order, cx))))
      .child(v_flex().id("recap-list").flex_1().min_h(0).p(10).gap(10).overflow_y_scrollbar()
        .when(list.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No agents running")))
        .when(list.length > 0, (el) => el.children(GROUPS.map((g, gi) =>
          this.group(t, g, grouped[gi].map((a) => this.card(t, a, tabs.get(a.tab), reports.get(a.address), now, index++)))))));
  }
}
