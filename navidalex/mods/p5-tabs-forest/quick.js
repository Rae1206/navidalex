// Quick-action buttons for the top bar (left of the clock).
// Each mirrors a keys.json shortcut so the feature is reachable by mouse too.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run } from "herdr";

const NVIM = "C:/Program Files/Neovim/bin/nvim.exe";

export const QUICK_ACTIONS = [
  { id: "history", icon: "mods/workspace-chrome/clock.svg", tip: "Session history (Ctrl+Shift+Y)",
    act: () => run("mod.open", { name: "session-history" }) },
  { id: "redline", icon: "mods/workspace-chrome/git-compare.svg", tip: "Review PRs — Redline (Ctrl+Shift+R)",
    act: () => run("mod.open", { name: "redline" }) },
  { id: "lazygit", icon: "mods/workspace-chrome/git-branch.svg", tip: "Lazygit panel (Ctrl+Shift+G)",
    act: () => { run("layout.select", { stack: "panel-body", child: "lazygit" }); run("layout.show", { id: "panel" }); } },
  { id: "nvim", icon: "mods/workspace-chrome/file-text.svg", tip: "Neovim in a split (Ctrl+Shift+D)",
    act: () => run("pane.split", { direction: "right", argv: [NVIM, "."] }) },
  { id: "screenshot", icon: "mods/workspace-chrome/monitor.svg", tip: "Screenshot mode (Ctrl+Shift+A)",
    act: () => run("layout.switch", { name: "screenshot" }) },
];

// colors: { idle, hover, bg }
export function quickBar(colors) {
  const stop = (_e, cx) => cx.stop_propagation();
  return h_flex().id("quick-actions").h(26).mr(6).gap(2).flex_none().items_center().children(
    QUICK_ACTIONS.map((a) => div().id(`qa-${a.id}`).size(26).flex_none().flex().items_center().justify_center()
      .rounded(5).cursor_pointer().text_color(colors.idle)
      .hover((s) => s.bg(colors.bg).text_color(colors.hover))
      .on_mouse_down("left", stop)
      .on_click(() => a.act())
      .tooltip(a.tip)
      .child(svg(a.icon).size(15))));
}
