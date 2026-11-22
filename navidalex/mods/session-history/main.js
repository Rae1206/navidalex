// Session history: past Claude Code, Codex and Pi sessions, newest first; Enter resumes one.
// Adapted from enchang1017/herdr-mod@d07a4d4 (session-history). Windows changes: real Python,
// resolved agent CLIs, Pi sessions, a "this project / all" scope, Ctrl+Enter forks, no exec
// during `herdr-app check`.
import { View } from "gpui-kit";
import { v_flex, InputState, VirtualListScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, nextCommand, notify, checking } from "herdr";
import { loadIndex, searchText, filterSessions, shortTitle } from "./data.js";
import { resumeSession, focusLive, projectFolder } from "./launch.js";
import { panelView } from "./view.js";

const SEARCH_DELAY_MS = 300;
const REFRESH_MS = 30_000;
const ACTION_GUARD_MS = 500;
const SCOPE_KEY = "session-history.scope";

const errorText = (error) => String(error?.message ?? error);

function savedScope() {
  try {
    const value = localStorage.getItem(SCOPE_KEY);
    return value === "all" || value === "project" ? value : null;
  } catch {
    return null;
  }
}

export default class SessionHistory extends View {
  init(given, cx) {
    const scope = given?.scope === "all" || given?.scope === "project" ? given.scope : (savedScope() ?? "project");
    this.state = { sessions: [], indexing: false, pending: false, query: "", hits: null, truncated: false, searching: false, selected: 0, message: "", busy: false, scope };
    this.searchToken = 0;
    this.lastAction = 0;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.queryInput = InputState.new({ placeholder: "Search sessions: title, folder, then transcript text" });
    this.queryInput.on("change", (_e, cx) => this.queryChanged(cx));
    this.queryInput.on("submit", (e, cx) => this.act(Boolean(e?.secondary), cx));
    if (checking()) return; // no Python or timers while `herdr-app check` loads the mod
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.spawn((cx) => this.commandLoop(cx));
    if (props()?.overlay) cx.timer.after(300, () => this.queryInput.focus());
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
  }

  folder() {
    return this.state.scope === "project" ? projectFolder() : null;
  }

  rows() {
    return filterSessions(this.state.sessions, this.state.query, this.state.query.trim() ? this.state.hits : null, this.folder());
  }

  toggleScope(cx) {
    const scope = this.state.scope === "project" ? "all" : "project";
    try { localStorage.setItem(SCOPE_KEY, scope); } catch {}
    this.set({ scope, selected: 0 });
    this.scroll.scroll_to_item(0);
    cx?.notify();
  }

  async commandLoop(cx) {
    for (;;) {
      const command = await nextCommand();
      if (command === "focus") this.queryInput.focus();
      else if (command === "scope") this.toggleScope(null);
      cx.notify();
    }
  }

  refresh(cx) {
    if (this.state.indexing) return;
    this.set({ indexing: true });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const index = await loadIndex();
        this.set({ sessions: index.sessions, pending: index.pending, indexError: index.errors[0] ?? "" });
        if (index.pending) cx.timer.after(200, (cx) => this.refresh(cx));
      } catch (error) {
        this.set({ message: errorText(error) });
      } finally {
        this.set({ indexing: false });
        cx.notify();
      }
    });
  }

  queryChanged(cx) {
    const query = this.queryInput.value();
    const token = ++this.searchToken;
    this.set({ query, hits: null, truncated: false, searching: false, selected: 0 });
    this.scroll.scroll_to_item(0);
    cx.notify();
    if (!query.trim()) return;
    cx.timer.after(SEARCH_DELAY_MS, (cx) => this.runSearch(token, query, cx));
  }

  runSearch(token, query, cx) {
    if (token !== this.searchToken) return;
    this.set({ searching: true });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const found = await searchText(query.trim());
        if (token === this.searchToken) this.set({ hits: found.hits, truncated: found.truncated });
      } catch (error) {
        if (token === this.searchToken) this.set({ message: errorText(error) });
      } finally {
        if (token === this.searchToken) this.set({ searching: false });
        cx.notify();
      }
    });
  }

  move(step, count) {
    if (count === 0) return;
    const selected = Math.min(count - 1, Math.max(0, this.state.selected + step));
    this.set({ selected });
    this.scroll.scroll_to_item(selected);
  }

  clickRow(index, cx) {
    if (index < 0) return;
    const again = index === this.state.selected;
    this.set({ selected: index });
    if (again) this.act(false, cx);
    cx.notify();
  }

  act(fork, cx) {
    const now = Date.now();
    if (now - this.lastAction < ACTION_GUARD_MS || this.state.busy) return;
    this.lastAction = now;
    const session = this.rows()[this.state.selected];
    if (!session) return;
    this.set({ busy: true, message: "" });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.open(session, fork, cx);
      } catch (error) {
        this.set({ message: `Could not open ${shortTitle(session)}: ${errorText(error)}` });
      } finally {
        this.set({ busy: false });
        cx.notify();
      }
    });
  }

  async open(session, fork, cx) {
    if (session.pid && !fork) {
      const address = await focusLive(session);
      if (!address) throw new Error(`it is live (pid ${session.pid}) but not in a Herdr terminal`);
      this.closeSelf();
      return;
    }
    const result = await resumeSession(session, fork, cx);
    if (!result.shown) notify({ title: "Session started", body: `${result.address} is running but its tab has not appeared yet.`, level: "warning" });
    this.closeSelf();
  }

  closeSelf() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  escape() {
    if (this.queryInput.value()) {
      this.queryInput.set_value("");
      this.searchToken += 1;
      this.set({ query: "", hits: null, truncated: false, searching: false, selected: 0 });
      this.scroll.scroll_to_item(0);
    } else {
      this.closeSelf();
    }
  }

  onKey(e, cx) {
    const { platform, control, alt, shift } = e.modifiers;
    const handled = this.handleKey(e.key, { platform, control, alt, shift }, cx);
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  handleKey(key, m, cx) {
    const plain = !m.platform && !m.control && !m.alt;
    if (m.alt && !m.control && !m.platform && key === "p") this.toggleScope(null);
    else if (key === "enter" && !m.alt) this.act(m.platform || m.control, cx); // Ctrl/Cmd+Enter forks (Claude)
    else if (!plain) return false;
    else if (key === "escape") this.escape();
    else if (key === "down") this.move(1, this.rows().length);
    else if (key === "up") this.move(-1, this.rows().length);
    else return false;
    return true;
  }

  render() {
    const t = theme();
    return v_flex().id("session-history").track_focus(this.handle).w_full().bg(t.chrome).text_color(t.foreground)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(panelView(this, t, this.rows()));
  }

  async close() {
    this.scroll?.release();
  }
}
