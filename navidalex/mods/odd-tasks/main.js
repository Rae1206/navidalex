// ODD tasks: the feature documents (odd/tasks/*.md) of the shown space's folder and repo,
// plus ~/.config/herdr-app/odd/tasks and ~/odd/tasks, with S#/T# progress, kept live.
// As a pane with props { file }, it is a live Markdown viewer for one document.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { readdir } from "fs/promises";
import {
  spaces, panes, focused, layout, exec, readTextFile, watchFolder, theme, run, props,
  setShared, appHome, home, checking, notify, nextCommand,
} from "herdr";
import { parseOdd } from "./parse.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FILTERS = [["all", "All"], ["progress", "In progress"], ["done", "Done"]];
const POLL_MS = 15000;     // fallback when a folder can't be watched (never faster than 5 s)
const MAX_FILES = 200;

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const keyOf = (p) => norm(p).toLowerCase();
const base = (p) => norm(p).split("/").pop();
const dirOf = (p) => norm(p).replace(/\/[^/]*$/, "");

function findMod(node, mod) {
  if (!node || typeof node !== "object") return false;
  if (node.content?.mod === mod) return true;
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) if (findMod(c, mod)) return true;
  return false;
}

export default class OddTasks extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.file = props()?.file ?? null;
    this.features = [];
    this.open = new Set();
    this.openTasks = new Set();
    this.filter = "all";
    this.selected = 0;
    this.tops = new Map();     // folder -> repo root (or null)
    this.cwdBySpace = new Map();
    this.gen = 0;
    this.watches = [];
    this.text = null;
    if (checking()) {
      // The check renders once: draw a sample so cards, task rows and the spinner are exercised.
      const doc = parseOdd(["# sample", "## Specs", "- S1 One", "- S2 Two", "## Tasks", "- T1 S1 a — done", "- T2 S1-S2 b — running", "- T3 S2 c — pending", "- T4 S2 d — failed"].join("\n"),"sample/odd/tasks/sample.md");
      doc.source = "sample/odd/tasks";
      this.features = [doc]; this.open.add(doc.path); this.openTasks.add(`${doc.path}#T2#1`); this.loaded = true;
      return;
    }
    if (this.file) this.loadFile(cx);
    else this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => { if (this.poll) this.file ? this.loadFile(cx, false) : this.reload(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "reload") this.file ? this.loadFile(cx) : this.reload(cx);
        cx.notify();
      }
    });
  }

  async close() { this.stopWatches(); }

  // ---- sources --------------------------------------------------------------

  // The shown space's folders: its own, and the live folder of its focused (or first) terminal.
  folders() {
    const space = spaces().find((s) => s.active);
    if (!space || space.machine) return [];
    const tab = space.tabs.find((t) => t.active);
    const f = focused();
    const mine = panes().filter((p) => p.tab === tab?.id && p.terminal && p.cwd);
    const live = mine.find((p) => p.pane === f?.pane)?.cwd ?? (f?.pane === null && f?.cwd) ?? null;
    if (live) this.cwdBySpace.set(space.id, live);
    const cwd = this.cwdBySpace.get(space.id) ?? mine[0]?.cwd ?? null;
    return [space.folder, cwd].filter(Boolean).map(norm);
  }

  sourceKey() { return JSON.stringify(this.folders().map(keyOf)); }

  async sources() {
    const dirs = [];
    for (const folder of this.folders()) {
      dirs.push(folder);
      if (!this.tops.has(keyOf(folder))) {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, timeout: 5000 }).catch(() => null);
        this.tops.set(keyOf(folder), r?.code === 0 ? norm(r.stdout.trim()) : null);
      }
      const top = this.tops.get(keyOf(folder));
      if (top) dirs.push(top);
    }
    dirs.push(norm(appHome()), norm(home()));
    const seen = new Set(), out = [];
    for (const d of dirs) {
      const t = `${d}/odd/tasks`;
      if (!seen.has(keyOf(t))) { seen.add(keyOf(t)); out.push(t); }
    }
    return out;
  }

  // ---- loading --------------------------------------------------------------

  refresh(cx) {
    this.key = this.sourceKey();
    this.gen++;
    this.stopWatches();
    this.reload(cx, true);
  }

  reload(cx, startWatches = false) {
    const gen = this.gen;
    cx.spawn(async (cx) => {
      try {
        const dirs = await this.sources();
        const found = [], seen = new Set(), live = [];
        for (const dir of dirs) {
          const names = await readdir(dir).catch(() => null);
          if (!names) continue;
          live.push(dir);
          for (const name of names.filter((n) => /\.md$/i.test(n)).sort()) {
            const path = `${dir}/${name}`;
            if (seen.has(keyOf(path)) || found.length >= MAX_FILES) continue;
            seen.add(keyOf(path));
            const text = await readTextFile(path).catch(() => null);
            if (text == null) continue;
            const doc = parseOdd(text, path);
            doc.source = dir;
            found.push(doc);
          }
        }
        if (gen !== this.gen) return;
        this.features = found;
        this.error = null;
        this.poll = live.length < dirs.length;   // a missing folder can't be watched: look again later
        if (startWatches) for (const dir of live) this.watch(dir, gen, cx);
      } catch (e) {
        if (gen === this.gen) this.error = String(e?.message ?? e);
      } finally {
        if (gen === this.gen) { this.loaded = true; cx.notify(); }
      }
    });
  }

  watch(dir, gen, cx) {
    cx.spawn(async (cx) => {
      try {
        while (gen === this.gen) {
          const w = watchFolder(dir);
          this.watches.push(w);
          const changed = await w;
          this.watches = this.watches.filter((x) => x !== w);
          if (gen !== this.gen) return;
          if (changed.length) this.file ? this.loadFile(cx, false) : this.reload(cx);
        }
      } catch {
        if (gen === this.gen) { this.poll = true; cx.notify(); }
      }
    });
  }

  stopWatches() {
    for (const w of this.watches) { try { w.cancel(); } catch {} }
    this.watches = [];
  }

  loadFile(cx, first = true) {
    const path = this.file;
    cx.spawn(async (cx) => {
      const text = await readTextFile(path).catch(() => null);
      if (path !== this.file) return;
      this.text = text;
      this.missing = text == null;
      this.doc = text == null ? null : parseOdd(text, path);
      if (first) { this.gen++; this.stopWatches(); this.watch(dirOf(path), this.gen, cx); }
      cx.notify();
    });
  }

  // ---- actions --------------------------------------------------------------

  shown() {
    const f = this.filter;
    return this.features.filter((d) => f === "all" || (f === "done" ? d.complete : !d.complete));
  }

  copy(path, cx) {
    cx.write_to_clipboard(path.replace(/\//g, "\\"));
    notify({ title: "Path copied", body: path, level: "info", timeout: 2500 });
  }

  // The chat layouts' viewer (file-view) shows it in their right panel; elsewhere it opens
  // beside the shown pane as this mod's own Markdown view; with no tab to split, the path is copied.
  openDoc(path, cx) {
    if (findMod(layout(), "file-view")) { setShared("view.open", { path, at: Date.now() }); return; }
    if (focused()?.tab) { run("pane.split", { direction: "right", mod: "odd-tasks", props: { file: path } }); return; }
    this.copy(path, cx);
  }

  toggle(set, key, cx) { set.has(key) ? set.delete(key) : set.add(key); cx.notify(); }

  onKey(e, cx) {
    const list = this.shown();
    const k = e.key;
    if (k === "down" || k === "j") this.selected = Math.min(list.length - 1, this.selected + 1);
    else if (k === "up" || k === "k") this.selected = Math.max(0, this.selected - 1);
    else if (k === "enter" || k === "space" || k === "right" || k === "left") {
      const d = list[this.selected];
      if (d) this.toggle(this.open, d.path, cx);
    } else if (k === "o") { const d = list[this.selected]; if (d) this.openDoc(d.path, cx); }
    else if (k === "c") { const d = list[this.selected]; if (d) this.copy(d.path, cx); }
    else if (k === "f") { const i = FILTERS.findIndex(([id]) => id === this.filter); this.filter = FILTERS[(i + 1) % FILTERS.length][0]; this.selected = 0; }
    else if (k === "r") this.reload(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- drawing --------------------------------------------------------------

  icon(status, t) {
    if (status === "running") return div().w(14).flex_none().text_color(t.working).frames(SPINNER, 90).child(SPINNER[0]);
    const [glyph, color] = status === "done" ? ["✓", t.done] : status === "blocked" ? ["✗", t.blocked] : status === "other" ? ["•", t.unknown ?? t.dim] : ["○", t.dim];
    return div().w(14).flex_none().text_color(color).child(glyph);
  }

  bar(doc, t) {
    const pct = doc.total ? Math.round((doc.done / doc.total) * 100) : 0;
    return div().h(4).w_full().rounded(2).bg(t.border).overflow_hidden()
      .child(div().h(4).w(`${pct}%`).rounded(2).bg(doc.complete ? t.done : t.accent));
  }

  counts(doc, t) {
    const parts = [["done", "done", t.done], ["running", "running", t.working], ["pending", "pending", t.dim], ["blocked", "blocked", t.blocked], ["other", "other", t.muted]]
      .filter(([s]) => doc.counts[s] > 0);
    return h_flex().gap(8).flex_wrap().text_size(11)
      .children(parts.map(([s, label, color]) => div().text_color(color).child(`${doc.counts[s]} ${label}`)))
      .when(!doc.total, (el) => el.child(div().text_color(t.dim).child("no tasks")));
  }

  taskRow(doc, task, i, t) {
    const key = `${doc.path}#${task.id}#${i}`;
    const expanded = this.openTasks.has(key);
    const specs = task.specs.map((id) => doc.specs.find((s) => s.id === id) ?? { id, text: "" });
    const tip = specs.length ? specs.map((s) => `${s.id} ${s.text}`.trim()).join("\n").slice(0, 600) : task.label;
    return v_flex().flex_none()
      .child(h_flex().id(`task-${key}`).min_h(24).px(6).gap(6).items_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(tip)
        .on_click((_e, cx) => this.toggle(this.openTasks, key, cx))
        .child(this.icon(task.status, t))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(task.id))
        .child(div().flex_1().min_w(0).truncate().child(task.title || task.text))
        .when(specs.length > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim)
          .child(specs.length > 3 ? `${specs[0].id}–${specs[specs.length - 1].id}` : specs.map((s) => s.id).join(" ")))))
      .when(expanded, (el) => el.child(v_flex().pl(26).pr(6).pb(4).gap(2).text_size(11)
        .child(div().text_color(t.dim).child(`Status: ${task.label}`))
        .children(specs.map((s) => h_flex().gap(6)
          .child(div().flex_none().text_color(t.accent).child(s.id))
          .child(div().flex_1().min_w(0).text_color(s.text ? t.muted : t.dim).child(s.text || "(not in Specs)"))))));
  }

  featureCard(doc, idx, t) {
    const opened = this.open.has(doc.path);
    const selected = idx === this.selected;
    return v_flex().id(`feat-${doc.path}`).flex_none().p(8).gap(6).rounded(8).bg(t.surface).border_1()
      .border_color(selected && this.focusedNow ? t.accent : t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().id(`chev-${doc.path}`).w(14).flex_none().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.selected = idx; this.toggle(this.open, doc.path, cx); }).child(opened ? "▾" : "▸"))
        .child(div().id(`title-${doc.path}`).flex_1().min_w(0).truncate().font_semibold().cursor_pointer()
          .hover((s) => s.text_color(t.accent)).tooltip(`Open ${base(doc.path)}`)
          .on_click((_e, cx) => { this.selected = idx; this.openDoc(doc.path, cx); }).child(doc.name))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(`${doc.done}/${doc.total}`))
        .child(div().id(`copy-${doc.path}`).flex_none().px(4).rounded(4).cursor_pointer().text_size(11).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Copy path").on_click((_e, cx) => this.copy(doc.path, cx)).child("⧉")))
      .child(this.bar(doc, t))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).child(this.counts(doc, t)))
        .child(div().flex_none().max_w(140).truncate().text_size(10).text_color(t.dim).tooltip(doc.source).id(`src-${doc.path}`)
          .child(doc.source.replace(/\/odd\/tasks$/, "").split("/").pop() || doc.source)))
      .when(opened, (el) => el.child(v_flex().gap(1).pt(2).border_t(1).border_color(t.border)
        .when(doc.header.length > 0, (el) => el.child(div().px(6).py(2).text_size(11).text_color(t.dim).child(doc.header.join(" "))))
        .children(doc.tasks.map((task, i) => this.taskRow(doc, task, i, t)))
        .when(!doc.tasks.length, (el) => el.child(div().px(6).text_size(11).text_color(t.dim).child("No T# tasks in this document")))));
  }

  renderList(t) {
    const list = this.shown();
    if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
    const all = this.features;
    const done = all.reduce((n, d) => n + d.done, 0), total = all.reduce((n, d) => n + d.total, 0);
    return v_flex().id("odd-tasks").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("ODD tasks"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(all.length ? `${all.length} features · ${done}/${total} tasks` : ""))
        .child(div().id("odd-reload").flex_none().px(4).rounded(4).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Reload (r)")
          .on_click((_e, cx) => { this.refresh(cx); cx.notify(); }).child("↻")))
      .child(h_flex().h(32).flex_none().px(10).gap(4).items_center()
        .children(FILTERS.map(([id, label]) => {
          const n = id === "all" ? all.length : all.filter((d) => (id === "done" ? d.complete : !d.complete)).length;
          const on = this.filter === id;
          return div().id(`filter-${id}`).px(8).py(2).rounded(10).cursor_pointer().text_size(11)
            .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.input : t.border)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.filter = id; this.selected = 0; cx.notify(); })
            .child(`${label} ${n}`);
        })))
      .child(v_flex().id("odd-list").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(6)
        .children(list.map((d, i) => this.featureCard(d, i, t)))
        .when(!list.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(
          this.error ?? (!this.loaded ? "Looking for odd/tasks…" : all.length ? "Nothing matches this filter" : "No ODD feature documents (odd/tasks/*.md) here")))));
  }

  renderFile(t) {
    const doc = this.doc;
    return v_flex().id("odd-file").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(doc?.name ?? base(this.file)))
        .when(Boolean(doc), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`${doc.done}/${doc.total} tasks`)))
        .child(div().id("odd-file-copy").flex_none().px(6).rounded(4).cursor_pointer().text_size(11).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.copy(this.file, cx)).child("Copy path")))
      .when(Boolean(doc), (el) => el.child(div().px(12).py(6).flex_none().child(this.bar(doc, t))))
      .child(this.text == null
        ? div().p(12).text_color(t.dim).child(this.missing ? "This file is not there." : "Loading…")
        : v_flex().id("odd-md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(12).child(TextView.markdown("odd-md", this.text).selectable(true)));
  }

  render(cx) {
    const t = theme();
    if (this.file) return this.renderFile(t);
    if (!checking() && this.key !== undefined && this.sourceKey() !== this.key) this.refresh(cx);
    this.focusedNow = this.handle?.is_focused?.() ?? false;
    return this.renderList(t);
  }
}
