// Header for a live, explicitly targeted terminal embedded above the chat.
// Use the agent's real / menu, including its loaded extensions and custom commands.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, hc, closeOverlay, theme, notify, panes, agents } from "herdr";

export default class ChatTerminalTools extends View {
  init() {
    const initial = props();
    this.target = initial?.terminal;
    this.command = initial?.command ?? "/";
    this.label = initial?.label ?? "Agent";
  }
  insert(cx) {
    const { target, command } = this;
    if (!target || ![...agents().map(a => a.address), ...panes().map(p => p.terminal)].includes(target)) return;
    const state = agents().find(a => a.address === target)?.status ?? panes().find(p => p.terminal === target)?.status;
    if (!["idle", "done"].includes(state)) {
      notify({ title: "Agent commands", body: "Idle state is not confirmed. Use the live terminal below when it is ready.", level: "warning" });
      return;
    }
    cx.spawn(async () => {
      try {
        // Type only. Never submit, clear an existing draft or answer a permission dialog.
        const result = await hc(["keys", target, ...command]);
        if (result.code !== 0) throw new Error(result.stderr || "The terminal is unavailable.");
      } catch (e) { notify({ title: "Agent commands", body: String(e?.message ?? e), level: "warning" }); }
    });
  }
  render(cx) {
    const t = theme(), command = this.command;
    const button = (id, text, click) => div().id(id).px(10).py(5).rounded(5).bg(t.surface)
      .cursor_pointer().hover(s => s.bg(t.hover)).on_click(click).child(text);
    return h_flex().size_full().items_center().gap(10).px(12).bg(t.chrome).text_color(t.foreground).text_size(12)
      .child(div().flex_1().child(`${this.label} · ${this.target} · Live terminal: ${command === "/" ? "type / to see all commands" : "insert the command, then press Enter"}`))
      .child(button("insert-command", `Insert ${command}`, (_e, cx) => this.insert(cx)))
      .child(button("close-controls", "Close", () => closeOverlay(props()?.overlay)));
  }
}
