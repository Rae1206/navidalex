// Forest compact rail.
import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";
import { sidebarTear } from "./torn.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const FULL = PathBuilder.fill().add_polygon([[0, 0], ["100%", 0], ["100%", "100%"], [0, "100%"]]).build();
const FOOTER = PathBuilder.fill().add_polygon([[0, "22%"], ["100%", 0], ["100%", "100%"], [0, "100%"]]).build();
const stripes = (path = FULL) => globalThis.window.paint_path(path, Background.pattern_slash("#00000020", 3, 14)).absolute().inset_0();

// Paints `color` over a torn fill with paper showing at the tear, or untorn without a tear.
// torn.js returns the same tear object while its inputs don't change, so the built paths are
// kept per tear: rebuilding 2000+ points on every render could run past the script's time
// limit ("This view could not be re-rendered … interrupted").
const builtTears = new WeakMap();
function paintTear(el, tear, color) {
  if (!tear) return el.bg(color).child(stripes());
  let built = builtTears.get(tear);
  if (!built) {
    built = {
      fill: PathBuilder.fill().add_polygon(tear.fill).build(),
      rims: tear.rims.map(({ color, polygons }) => ({ color, path: polygons.reduce((b, p) => b.add_polygon(p), PathBuilder.fill()).build() })),
    };
    builtTears.set(tear, built);
  }
  return el
    .child(globalThis.window.paint_path(built.fill, color).absolute().inset_0())
    .child(stripes(built.fill))
    .children(built.rims.map(({ color, path }) => globalThis.window.paint_path(path, color).absolute().inset_0()));
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = { ...theme(), chrome: "#123D2Ee6", foreground: "#D4F7DE", muted: "#D4F7DE", dim: "#8FBFA3", hover: "#00000033" };
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(collapsed ? 0 : 8).gap(collapsed ? 0 : 9).items_center().when(collapsed, el => el.justify_center()).tooltip(label).font_weight(800).italic()
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/workspace-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label.toUpperCase()));
      const tear = sidebarTear(layout() ?? {}, "sidebar-footer", globalThis.window.viewport_size().height);
      const ink = tear ? PathBuilder.fill().add_polygon([[0, "22%"], ...tear.fill.slice(1)]).build() : FOOTER;
      return paintTear(v_flex().size_full().relative(), tear, t.chrome).child(globalThis.window.paint_path(ink, "#000000").absolute().inset_0()).px(collapsed ? 2 : 8).pt(26).pb(10).text_size(13)
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg("#D4F7DE"))))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    return paintTear(h_flex().size_full().relative(), sidebarTear(layout() ?? {}, "brand", globalThis.window.viewport_size().height), t.chrome).pl(collapsed ? 4 : 14).pr(collapsed ? 4 : 10).when(collapsed, el => el.justify_center()).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(div().flex_1()))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome/search.svg").size(15), () => run("mod.open", { name: "p5-picker-forest" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome/sidebar.svg").size(15), toggleSidebar).tooltip(collapsed ? "Expand sidebar" : "Collapse sidebar")));
  }
}
