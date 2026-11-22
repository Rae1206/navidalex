// Forest active defaults and two-tone agent contour.
// Forest floating cards and status-only tasks.
// Forest compact rail.
// Subagents of every agent, live: Gentle Pi tasks (subagent_run) plus Claude Code, Codex and
// OpenCode sub-agents found by scan.ps1. Status, agent, model and elapsed time; click one to open
// its transcript window (pi-agent-view): prompt, thinking, tool calls, results and final answer.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, appHome, exec, openOverlay, theme, watchFolder, agents, terminals, hc, layout, props, shared, setShared } from "herdr";
import * as fs from "fs/promises";

// Forest compact rail. Opt-in keeps other layouts unchanged.
function railWidth(node) {
  if (node?.id === 'sidebar') return node.size?.px ?? Infinity;
  for (const child of node?.children ?? []) {
    const width = railWidth(child);
    if (width !== Infinity) return width;
  }
  return Infinity;
}
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_TASKS = 60;
const ACTIVE = new Set(["running", "queued", "waiting", "starting"]);

export function tasksDir() {
  return `${home().replace(/\\/g, "/")}/.pi/agent/gentle-agents/tasks`;
}

export function statusColor(t, status) {
  if (ACTIVE.has(status)) return status === "running" ? t.working : t.blocked;
  if (status === "completed") return t.done;
  if (status === "failed" || status === "cancelled") return t.blocked;
  return t.dim;
}

export function elapsed(task, now = Date.now()) {
  const start = task.startedAt ?? task.createdAt;
  if (!start) return "";
  const s = Math.max(0, Math.round(((task.endedAt ?? now) - start) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function ago(ms, now = Date.now()) {
  const m = Math.round((now - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

const norm = (p) => String(p ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const SLACK_MS = 120000;
const SOURCES = { pi: "Pi", claude: "Claude", codex: "Codex", opencode: "OpenCode" };
const SCAN_EVERY_MS = 8000;
const SCOPES = [["now", "Now"], ["project", "Project"], ["all", "All"]];

function base(path) {
  return (path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

export default class PiAgents extends View {
  init(_props, cx) {
    if (props()?.filterMenu) return;
    this.tasks = [];
    this.filter = props()?.forestRail ? "active" : "all";
    this.scope = "now";
    this.src = "all";
    this.others = [];
    this.scannedAt = 0;
    this.scan(cx);
    cx.timer.every(SCAN_EVERY_MS, (cx) => this.scan(cx));
    this.opened = {};   // terminal → created_ms
    this.error = null;
    this.reload(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(tasksDir()); } catch { return; }
        this.reload(cx);
      }
    });
    // Fallback and elapsed-time tick; only redraws when something is running.
    cx.timer.every(5000, (cx) => {
      if (this.tasks.some((t) => ACTIVE.has(t.status))) this.reload(cx);
    });
  }

  // Claude Code, Codex and OpenCode sub-agents (scan.ps1 runs outside the UI thread).
  scan(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const script = `${appHome().replace(/\//g, "\\")}\\mods\\pi-agents\\scan.ps1`;
        const r = await exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Days", "14"], { timeout: 60000 });
        const rows = JSON.parse(r.stdout.trim() || "[]");
        this.others = (Array.isArray(rows) ? rows : [rows]).map((x) => ({ ...x, endedAt: ACTIVE.has(x.status) ? null : x.updatedAt }));
        await this.learnOpened();
      } catch { /* keep the last scan */ }
      this.scanning = false;
      cx.notify();
    });
  }

  all() {
    const list = [...this.tasks.map((x) => ({ ...x, source: "pi" })), ...this.others];
    return list.sort((a, b) => (ACTIVE.has(b.status) - ACTIVE.has(a.status)) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        const names = (await fs.readdir(tasksDir())).filter((n) => n.endsWith(".json")).sort().slice(-MAX_TASKS);
        const out = [];
        for (const n of names) {
          try {
            const j = JSON.parse(await fs.readFile(`${tasksDir()}/${n}`, "utf8"));
            if (j?.task?.id) out.push({ ...j.task, file: `${tasksDir()}/${n}`, steps: j.thread?.items?.length ?? 0 });
          } catch { /* a task being rewritten; next change reloads it */ }
        }
        out.sort((a, b) => (ACTIVE.has(b.status) - ACTIVE.has(a.status)) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
        this.tasks = out;
        await this.learnOpened();
        this.error = null;
      } catch (e) {
        this.error = `No subagents yet (${String(e?.message ?? e).slice(0, 80)})`;
      }
      cx.notify();
    });
  }

  // Agents open now: their folder and when their terminal opened.
  contexts() {
    const byAddr = new Map(terminals().map((t) => [t.address, t]));
    return agents().map((a) => ({ cwd: norm(byAddr.get(a.address)?.cwd), since: (this.opened[a.address] ?? 0) - SLACK_MS }))
      .filter((c) => c.cwd);
  }

  async learnOpened() {
    for (const a of agents()) {
      if (this.opened[a.address] !== undefined) continue;
      try { this.opened[a.address] = JSON.parse((await hc(["get", a.address, "--json"])).stdout).created_ms ?? 0; }
      catch { this.opened[a.address] = 0; }
    }
  }

  inScope(x, ctx) {
    if (this.scope === "all") return true;
    const cwd = norm(x.cwd);
    return ctx.some((c) => (cwd === c.cwd || cwd.startsWith(c.cwd + "\\") || c.cwd.startsWith(cwd + "\\"))
      && (this.scope === "project" || (x.createdAt ?? 0) >= c.since));
  }

  open(task) {
    openOverlay({
      kind: "window",
      key: `sub-${task.source}-${task.id}`,
      mod: "pi-agent-view",
      props: task.source === "pi" ? { source: "pi", file: task.file, id: task.id }
        : { source: task.source, ref: task.ref, id: task.id, label: task.label, agent: task.agent, model: task.model, status: task.status, createdAt: task.createdAt, endedAt: task.endedAt },
      width: 820,
      height: 0.8,
    });
  }

  // A small pill showing the current choice; a click moves to the next one.
  cycle(t, id, options, current, set, tip) {
    const at = Math.max(0, options.findIndex(([k]) => k === current));
    const [, label] = options[at];
    const changed = at !== 0;
    return div().id(id).flex_none().px(5).py(1).rounded(4).text_size(10.5).cursor_pointer()
      .bg(changed ? t.selected : t.chrome).text_color(changed ? t.foreground : t.muted)
      .border(1).border_color(t.border).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { set(options[(at + 1) % options.length][0]); cx.notify(); })
      .child(label);
  }

  chip(t, id, label, active, onClick) {
    return div().id(id).px(7).py(2).rounded(5).text_size(11).cursor_pointer()
      .bg(active ? t.selected : t.chrome).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  setChoice(key, value) {
    this[key] = value;
    if (props()?.forestRail || props()?.filterMenu) {
      const before = shared('forest.subagent.filters') ?? { scope: 'now', src: 'all', filter: 'active' };
      setShared('forest.subagent.filters', { ...before, [key]: value });
    }
  }

  filterMenu(t) {
    const state = shared('forest.subagent.filters') ?? { scope: 'now', src: 'all', filter: 'active' };
    const section = (title, key, choices) => v_flex().gap(5)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title))
      .children(Array.from({ length: Math.ceil(choices.length / 3) }, (_, row) => h_flex().gap(4).children(
        choices.slice(row * 3, row * 3 + 3).map(([value, label]) => this.chip(t, `filter-${key}-${value}`, label,
          state[key] === value, (_e, cx) => { this.setChoice(key, value); cx.notify(); })))));
    return v_flex().w_full().p(12).gap(12).bg(t.chrome)
      .child(div().font_semibold().text_color(t.foreground).child('Subagent filters'))
      .child(section('Scope', 'scope', SCOPES))
      .child(section('Agent', 'src', [['all', 'Any'], ...Object.entries(SOURCES)]))
      .child(section('Status', 'filter', [['all', 'All'], ['active', 'Active'], ['failed', 'Failed']]))
      .child(div().text_size(10).text_color(t.dim).child('Applied immediately · click outside to close'));
  }

  render(cx) {
    const t = theme();
    const moving = shared("p5.motion") !== false;
    if (props()?.filterMenu) return this.filterMenu(t);
    if (props()?.forestRail) {
      // Apply the new default once. Later user choices (including All) remain respected.
      if (!shared('forest.subagent.activeDefault')) {
        const previous = shared('forest.subagent.filters') ?? { scope: 'now', src: 'all' };
        setShared('forest.subagent.filters', { ...previous, filter: 'active' });
        setShared('forest.subagent.activeDefault', true);
      }
      const saved = shared('forest.subagent.filters');
      if (saved) { this.scope = saved.scope ?? 'now'; this.src = saved.src ?? 'all'; this.filter = saved.filter ?? 'active'; }
    }
    const now = Date.now();
    const ctx = this.contexts();
    const scoped = this.all().filter((x) => this.inScope(x, ctx) && (this.src === "all" || x.source === this.src));
    const active = scoped.filter((x) => ACTIVE.has(x.status));
    const shown = this.filter === "active" ? active : this.filter === "failed" ? scoped.filter((x) => x.status === "failed") : scoped;
    if (props()?.forestRail && railWidth(layout()) < 160) {
      const filtered = this.scope !== 'now' || this.src !== 'all' || this.filter !== 'all';
      const summary = `Scope: ${SCOPES.find(([key]) => key === this.scope)?.[1] || this.scope} · Agent: ${SOURCES[this.src] || 'Any'} · Status: ${this.filter}`;
      const statusGlyph = (status) => status === 'running' ? SPIN[0] : status === 'completed' ? '✓'
        : status === 'failed' ? '✕' : status === 'cancelled' ? '∅' : status === 'waiting' ? '◷'
        : ACTIVE.has(status) ? '◌' : '·';
      return v_flex().id('pi-agents-rail').size_full().min_h(0).bg(t.chrome)
        .child(v_flex().flex_none().items_center().pt(3).pb(4).gap(3)
          .child(div().text_size(10).text_color(active.length ? t.working : t.dim)
            .tooltip(`Subagents: ${active.length} active, ${shown.length} shown, ${scoped.length} in scope`).child(`↳${active.length}`))
          .child(div().id('rail-filters').relative().size(26).flex().items_center().justify_center().rounded(5)
            .bg(filtered ? t.selected : t.raised).text_color(t.foreground).text_size(17).cursor_pointer()
            .hover((el) => el.bg(t.hover)).tooltip(`Filters · ${summary}`)
            .on_click(() => openOverlay({ kind: 'popup', mod: 'pi-agents', props: { filterMenu: true }, width: 260, height: 270 }))
            .child('☷').when(filtered, (el) => el.child(div().absolute().top(2).right(2).size(5).rounded_full().bg(t.accent)))))
        .child(v_flex().id('pi-rail-list').flex_1().min_h(0).overflow_y_scrollbar().gap(4).children(
          shown.map((x) => h_flex().id(`rail-task-${x.source}-${x.id}`).h(32).flex_none()
            .items_center().justify_center().cursor_pointer()
            .tooltip(`${x.label || x.prompt?.slice(0, 60) || x.id} · ${x.agent || SOURCES[x.source]} · ${x.status} · ${elapsed(x, now)}`)
            .on_click(() => this.open(x))
            .child(div().size(26).flex().items_center().justify_center().rounded(6).bg(t.raised)
              .hover((el) => el.bg(t.hover)).text_size(16).text_color(statusColor(t, x.status))
              .when(moving && x.status === 'running', (el) => el.frames(SPIN, 90)).child(statusGlyph(x.status))))))
        .when(!shown.length || Boolean(this.error), (el) => el.child(div().h(24).text_center().text_size(11).text_color(t.dim)
          .tooltip(this.error || 'No subagents in the selected scope · use Filters to change scope').child(this.error ? '!' : '—')));
    }
    return v_flex().id("pi-agents").size_full().bg(t.chrome).text_size(12.5)
      // One compact row: title, count, and three filters that each cycle on click.
      .child(h_flex().px(8).py(5).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.foreground).child("Subagents"))
        .child(div().flex_none().text_size(10.5).text_color(active.length ? t.working : t.dim).child(active.length ? `${active.length}▶` : `${scoped.length}`))
        .child(div().flex_1())
        .child(this.cycle(t, "c-scope", SCOPES, this.scope, (k) => { this.setChoice('scope', k); }, "Which: agents open now · their projects · everything"))
        .child(this.cycle(t, "c-src", [["all", "Any"], ...Object.entries(SOURCES)], this.src, (k) => { this.setChoice('src', k); }, "Agent: any · Pi · Claude · Codex · OpenCode"))
        .child(this.cycle(t, "c-status", [["all", "All"], ["active", "Active"], ["failed", "Failed"]], this.filter, (k) => { this.setChoice('filter', k); }, "Status: all · active · failed")))
      .when(Boolean(this.error), (el) => el.child(div().px(10).py(6).text_color(t.dim).child(this.error)))
      .when(!this.error && !shown.length, (el) => el.child(div().px(12).py(8).text_size(11.5).text_color(t.dim).child(
        this.scope === "now" ? "No subagents from the agents open now." : this.scope === "project" ? "No subagents in these projects." : "No subagents yet.")))
      .child(v_flex().id("pi-agents-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(8).gap(2).children(
        shown.map((x, i) => {
          const run = x.status === "running";
          return v_flex().id(`task-${i}`).px(8).py(6).gap(2).rounded(7).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click(() => this.open(x))
            .child(h_flex().gap(6).items_center()
              .child(div().w(12).flex_none().text_color(statusColor(t, x.status)).when(moving && run, (el) => el.frames(SPIN, 90)).child(run ? SPIN[0] : ACTIVE.has(x.status) ? "◌" : x.status === "completed" ? "✓" : x.status === "failed" ? "✕" : "·"))
              .child(div().flex_1().truncate().text_color(t.foreground).child(x.label || x.prompt?.slice(0, 60) || x.id))
              .child(div().flex_none().text_size(11).text_color(t.dim).child(elapsed(x, now))))
            .child(h_flex().pl(18).gap(6).text_size(11).text_color(t.dim)
              .child(div().flex_none().px(4).rounded(4).bg(t.raised).text_color(t.muted).child(SOURCES[x.source] ?? x.source))
              .child(div().flex_none().text_color(t.muted).child(x.agent ?? ""))
              .child(div().truncate().child(`${x.model ?? ""}${x.thinking ? " · " + x.thinking : ""}`))
              .child(div().flex_1())
              .child(div().flex_none().child(`${base(x.cwd)} · ${ago(x.createdAt ?? now, now)}`)))
            .when(Boolean(x.error) || Boolean(x.lastStep && ACTIVE.has(x.status)), (el) => el.child(
              div().pl(18).truncate().text_size(11).text_color(x.error ? t.blocked : t.muted).child(x.error || x.lastStep)));
        }),
      ));
  }
}
