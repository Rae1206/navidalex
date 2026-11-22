// Tabs over the right panel's stack (layout header of "panel-body"): Viewer · Changes · Files,
// and ✕ to collapse the panel. Props: { stack, panel, tabs: [[id, label], ...] }.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, props, run, theme } from "herdr";

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const r = findNode(c, id); if (r) return r; }
  return null;
}

export default class PanelTabs extends View {
  render() {
    const t = theme();
    const { stack = "panel-body", panel = "panel", tabs = [["viewer", "Viewer"], ["changes", "Changes"], ["files", "Files"]] } = props() ?? {};
    const node = findNode(layout(), stack);
    const active = node?.active ?? node?.children?.[0]?.id;
    const strip = h_flex().id("pt-strip").flex_1().min_w(0).h_full().gap(4).items_center().overflow_x_scrollbar()
      .children(tabs.map(([id, label]) => div().id(`pt-${id}`).flex_none().px(10).py(3).rounded(6).text_size(12).cursor_pointer()
        .bg(id === active ? t.selected : t.chrome).text_color(id === active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("layout.select", { stack, child: id }))
        .child(label)));
    // Only tabs scroll. The panel-level close action is pinned outside the strip.
    return h_flex().id("panel-tabs").size_full().min_w(0).px(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(strip)
      .child(h_flex().id("pt-close").flex_none().w(28).h(26).items_center().justify_center().rounded(6)
        .text_size(13).text_color(t.muted).cursor_pointer().tooltip("Close panel")
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("layout.hide", { id: panel }))
        .child("✕"));
  }
}
