// Forest floating cards and status-only tasks.
import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";

// Native cached islands (navidalex-native fork): a marked subtree is reused while it is
// unchanged. Older Herdr builds have no .island(); they draw it inline as before.
const ISLAND = typeof div().island === "function";
const island = (el) => (ISLAND ? el.island() : el);
import { h_flex } from "gpui-base";
import { barTear, noise, spanOf } from "./torn.js";
import { closeRequest } from "./confirm.js";
import { spaces, panes, focused, nextCommand, run, openOverlay, theme, window as appWindow, shared, setShared, layout, settings } from "herdr";

const STRIPES_FULL = PathBuilder.fill().add_polygon([[0, 0], ["100%", 0], ["100%", "100%"], [0, "100%"]]).build();
const stripes = (path = STRIPES_FULL) => globalThis.window.paint_path(path, Background.pattern_slash("#00000020", 3, 14)).absolute().inset_0();

// Paints `color` over a torn fill with paper showing at the tear, or untorn without a tear.
// The tear only depends on the window width, the sidebar width and the bar's height, so its
// paths are built once per size and reused: rebuilt on every render (2000+ points) they could
// run past the script's time limit on an agent switch ("This view could not be re-rendered").
let tearCache = { key: null, tear: null };
function cachedBarTear(root, width) {
  const key = `${width}|${root.children?.find((c) => c.id === "sidebar")?.size?.px ?? 0}|${spanOf(root, "tabs", 0)?.height ?? 0}`;
  if (tearCache.key !== key) {
    const tear = barTear(root, "tabs", width, "bottom");
    tearCache = { key, tear: tear && {
      fill: PathBuilder.fill().add_polygon(tear.fill).build(),
      rims: tear.rims.map(({ color, polygons }) => ({ color, path: polygons.reduce((b, p) => b.add_polygon(p), PathBuilder.fill()).build() })),
    } };
  }
  return tearCache.tear;
}
function paintTear(el, tear, color) {
  if (!tear) return el.bg(color).child(stripes());
  // The torn paper never changes between ticks of the animated slab: one cached island.
  return el.child(island(div().id("tear-paper").absolute().inset_0()
    .child(globalThis.window.paint_path(tear.fill, color).absolute().inset_0())
    .child(stripes(tear.fill))
    .children(tear.rims.map(({ color, path }) => globalThis.window.paint_path(path, color).absolute().inset_0()))));
}
const SLANT = PathBuilder.fill().add_polygon([["8%", 0], ["100%", 0], ["92%", "100%"], [0, "100%"]]).build();
const slant = (color) => globalThis.window.paint_path(SLANT, color).absolute().inset_0();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The active tab's slabs are their own views, so a frame rebuilds only them.
const MORPH_STEP = 240;
// Forest variant: smooth motion — each corner blends from one pose to the next (ease in-out),
// redrawn every MORPH_FRAME ms. Each pose is still a hash of its number, as in the original.
const MORPH_FRAME = 33;
const ease = (t) => t * t * (3 - 2 * t);
const pull = (now, i) => {
  const k = now / MORPH_STEP, n = Math.floor(k), t = ease(k - n);
  return noise(n * 8 + i) * (1 - t) + noise((n + 1) * 8 + i) * t;
};
const morphed = (now) => [
  [`${4 * pull(now, 0)}%`, `${16 + 12 * pull(now, 1)}%`],
  [`${97 - 4 * pull(now, 2)}%`, `${12 * pull(now, 3)}%`],
  [`${100 - 4 * pull(now, 4)}%`, `${82 - 12 * pull(now, 5)}%`],
  [`${4 + 4 * pull(now, 6)}%`, `${100 - 12 * pull(now, 7)}%`],
];

// The selected slab: black with a light-green edge, two green shadows lagging behind it.
const SHADOWS = [
  { color: "#2FBF6E", lag: 6, x: 10, y: 6 },
  { color: "#123D2E", lag: 3, x: -8, y: -5 },
];

class Morph extends View {
  init(_props, cx) {
    cx.timer.every(MORPH_FRAME, (cx) => {
      if (shared("p5.motion") !== false || !this.still) cx.notify();
    });
  }

  render() {
    this.still = shared("p5.motion") === false;
    const now = this.still ? 0 : Date.now();
    const shape = morphed(now);
    const fill = (shape, color) => globalThis.window.paint_path(PathBuilder.fill().add_polygon(shape).build(), color).absolute().inset_0();
    return div()
      .size_full()
      .relative()
      .children(SHADOWS.map((s) => div().absolute().left(s.x).top(s.y).size_full().child(fill(morphed(this.still ? 0 : now - MORPH_STEP * s.lag), s.color))))
      .child(fill(shape, "#000000"))
      .child(globalThis.window.paint_path(PathBuilder.stroke(2).add_polygon(shape, true).build(), "#D4F7DE").absolute().inset_0());
  }
}

// Hero legend (mods/hero-legend): every day, on the hour from 9:00 to 17:00 "N hours after the
// hero's death" counted from the 8:00 start, plus custom title cards at 11:10 ("Dream."),
// 12:27 ("Go eat."), and 17:25 ("Run."). Shown once per slot (shared key, so reloads and
// other copies don't repeat it).
const HERO_START = 8, HERO_LAST = 17;
const HERO_SPECIALS = [
  { h: 11, m: 10, key: "dream", text: "Dream." },
  { h: 12, m: 27, key: "eat", text: "Go eat." },
  { h: 17, m: 25, key: "run", text: "Run." },
];
function heroCard(d) {
  const h = d.getHours(), m = d.getMinutes();
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const special = HERO_SPECIALS.find((s) => s.h === h && s.m === m);
  if (special) return { key: `${day}-${special.key}`, text: special.text };
  if (m === 0 && h > HERO_START && h <= HERO_LAST) {
    const n = h - HERO_START;
    return { key: `${day}-${h}`, text: `${n} hour${n === 1 ? "" : "s"} after the hero's death` };
  }
  return null;
}
function heroLegend() {
  if (shared("p5.motion") === false) return;
  const card = heroCard(new Date());
  if (!card || shared("hero-legend.last") === card.key) return;
  setShared("hero-legend.last", card.key);
  // The whole window, in px (the drawable area).
  const v = globalThis.window.viewport_size();
  openOverlay({ mod: "hero-legend", kind: "window", frame: "none", at: { x: 0, y: 0 }, width: v.width, height: v.height, props: { text: card.text } });
}

const clockText = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default class Tabs extends View {
  init(_props, cx) {
    this.morph = cx.new(Morph, {});
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Forest clock before NEW: redraw only when the minute changes.
    this.clock = clockText();
    cx.timer.every(5000, (cx) => { heroLegend(); const c = clockText(); if (c !== this.clock) { this.clock = c; cx.notify(); } });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "close-pane") this.closePane();
        cx.notify();
      }
    });
  }

  closePane() {
    if (shared("p5.agentCloseOverlay")) return;
    const pane = panes().find(p => p.pane === focused()?.pane);
    if (!pane) return;
    if (!pane.program?.agent) {
      run("pane.close", { pane: pane.pane });
      return;
    }
    const alone = panes().filter(p => p.tab === pane.tab).length === 1;
    const overlay = openOverlay({
      mod: "p5-confirm-forest", kind: "dialog", modal: true, frame: "none", width: 560, height: 360,
      props: {
        title: "Close agent?",
        detail: `${pane.program.name} — ${pane.title}`,
        warning: "THIS ENDS THE AGENT'S TERMINAL.",
        command: alone
          ? { name: "tab.close", args: { id: pane.tab, confirmed: true } }
          : { name: "pane.close", args: { pane: pane.pane } },
      },
    });
    setShared("p5.agentCloseOverlay", overlay);
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = { ...theme(), chrome: "#123D2Ee6", raised: "#000000", muted: "#A8D8B8", foreground: "#D4F7DE", dim: "#A8D8B8", hover: "#00000033", selected: "#000000" };
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).relative().h(30).px(16).gap(6).items_center().flex_none().text_size(12.5).font_weight(700).italic()
        .text_color(c.active ? "#D4F7DE" : "#A8D8B8")
        .when(c.active, el => el.h(46).px(26).py(4).text_size(14)
          .child(div().absolute().top(-2).bottom(2).left(-4).right(-4).child(this.morph)))
        .when(!c.active, el => el.h(26).text_size(12).child(globalThis.window.paint_path(SLANT, "#000000").absolute().top(2).left(2).w_full().h_full()).child(slant("#0F3326")))
        .hover(s => s.text_color("#D4F7DE"))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "p5-menu-forest", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child((c.zoomed ? `${name} Z` : name).toUpperCase()))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(1800)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color("#D4F7DE").on_mouse_down("left", stop).on_click((_e, cx) => {
          cx.stop_propagation();
          const request = closeRequest(spaces(), panes(), "tab.close", c.id);
          if (request) openOverlay({ mod: "p5-confirm-forest", kind: "dialog", modal: true, frame: "none", width: 560, height: 360, props: request });
          else run("tab.close", { id: c.id });
        }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout() ?? {}, sidebar = find(root, "sidebar"), w = appWindow();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    const hasInbox = Boolean(find(body ?? {}, "inbox"));
    const hasLazygit = Boolean(find(body ?? {}, "lazygit"));
    this.syncPanel(space, panel, body, [...enabled, ...(hasInbox ? ["inbox"] : []), ...(hasLazygit ? ["lazygit"] : [])]);
    const panelButton = (id, label, icon, hint) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(6).flex_none().items_center().rounded(5)
        .text_size(12).when(on, s => s.bg(t.selected)).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).when(Boolean(hint), s => s.cursor_pointer().tooltip(hint))
        .when(Boolean(icon), s => s.child(svg(icon).size(14))).child(label);
    };
    const overlayButton = (name, label, hint) => h_flex().id(`quick-${name}`).h(26).px(8).flex_none().items_center().rounded(5)
      .text_size(12).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(() => run("mod.open", { name })).tooltip(hint).child(label);
    const width = globalThis.window.viewport_size().width;
    const headerWidth = width - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0);
    return paintTear(h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().relative(), cachedBarTear(root, width), t.chrome)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().pl(18).pr(8).items_center().gap(8).overflow_x_scrollbar().children(shown.map(item)))
      .when(headerWidth >= 620 && hasInbox, el => el.child(panelButton("inbox", "Inbox", null, "Agent inbox")))
      .when(headerWidth >= 620 && hasLazygit, el => el.child(panelButton("lazygit", "Lazygit", null, "Open Lazygit")))
      .when(headerWidth >= 860, el => el.child(overlayButton("redline", "PRs", "Redline: review GitHub pull requests (Ctrl+Shift+R)")))
      .when(headerWidth >= 860, el => el.child(overlayButton("session-history", "History", "Agent session history (Ctrl+Shift+Y)")))
      // Forest clock.
      .child(h_flex().id('tab-clock').h(26).px(8).mr(4).flex_none().items_center()
        .text_size(13).font_weight(800).italic().text_color('#D4F7DE').tooltip('Local time').child(this.clock ?? clockText()))
      // Forest visible new terminal button.
      .child(h_flex().id('tab-new').relative().h(26).px(14).mr(5).gap(6).flex_none()
        .items_center().justify_center().text_size(11.5).font_weight(800).italic()
        .text_color('#03140B').cursor_pointer().hover((el) => el.text_color('#000000'))
        .on_mouse_down('left', stop)
        .on_click(() => openOverlay({ mod: 'new-menu', kind: 'popup', width: 250, height: 512 }))
        .tooltip('New terminal or agent')
        .child(globalThis.window.paint_path(SLANT, '#000000').absolute().top(3).left(3).w_full().h_full())
        .child(slant('#5CE08A'))
        .child(svg('mods/workspace-chrome/plus.svg').size(14)).child('NEW'))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
