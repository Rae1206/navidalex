// Search the selected live Pi's models and set model or thinking without typing into the terminal.
// Open from chat or with mod.open:pi-models.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, focused, checking, props, closeOverlay, theme, shared, setShared } from "herdr";
import { applyControl, runtimeMetadata } from "./runtime.js";
import { controlBinding } from "./control.js";

const OUTCOME = {
  pending: "Pi is already handling a request. Wait before choosing again.",
  unavailable: "Controls unavailable. Run /reload once in this Pi terminal, then reopen the picker.",
  busy: "Pi is busy. No change was applied.",
  stale: "This Pi session or its active model changed. Reopen the picker.",
  rejected: "Pi rejected the requested model or thinking level.",
  unconfirmed: "Pi did not confirm the change. Check the current selection before trying again.",
};
const RECENT_KEY = "pi-models.recent";
const MAX_RECENT = 8;

function isPi(a) {
  return a.app === "pi" || a.app === "gentle-shell" || a.program?.key === "pi" || /\bpi\b|gentle/i.test(a.program?.name ?? "");
}

export default class PiModels extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.filter = "";
    this.at = 0;
    this.loading = true;
    this.error = null;
    this.models = [];
    this.effective = null;
    this.pending = false;
    this.closed = false;
    // Capture the explicit chat target before a popup can change keyboard focus.
    const f = focused();
    const pis = agents().filter(isPi);
    const address = props()?.terminal ?? f?.agent ?? f?.terminal;
    this.target = pis.find(a => a.address === address)?.address ?? null;
    this.input = InputState.new({ placeholder: "Search provider or model… (Enter applies)" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { const r = this.rows()[this.at]; if (r) this.apply(r, cx); });
    if (checking()) { this.loading = false; return; }
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      const runtime = this.target ? await runtimeMetadata(this.target).catch(() => null) : null;
      if (this.closed) return;
      if (!controlBinding(runtime)) this.error = "Controls unavailable. Run /reload once in this Pi terminal, then reopen the picker.";
      else if (runtime.modelError) this.error = runtime.modelError;
      else {
        this.runtime = runtime;
        const { model, thinking, levels, models } = runtime.control;
        this.effective = { model, thinking, levels };
        this.models = models;
      }
      this.loading = false;
      cx.notify();
    });
  }

  close() { this.closed = true; }

  dismiss() {
    this.close();
    closeOverlay(props()?.overlay);
  }

  recent() {
    return shared(RECENT_KEY) ?? [];
  }

  rows() {
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (m) => words.every((w) => m.ref.toLowerCase().includes(w));
    const recent = this.recent();
    const byRef = new Map(this.models.map((m) => [m.ref, m]));
    const recentRows = recent.map((ref) => byRef.get(ref)).filter(Boolean).filter(match).map((m) => ({ ...m, recent: true }));
    const rest = this.models.filter((m) => !recent.includes(m.ref) && match(m));
    return [...recentRows, ...rest];
  }

  apply(m, cx) {
    this.change("set-model", { provider: m.provider, id: m.id }, cx);
  }

  change(action, value, cx) {
    if (!this.runtime || this.pending || this.closed) return;
    this.pending = true;
    this.error = null;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const result = await applyControl(this.target, this.runtime, action, value, ms => cx.sleep(ms), () => !this.closed)
        .catch(() => ({ status: "unconfirmed" }));
      if (this.closed) return;
      this.pending = false;
      if (result.status === "applied") {
        this.effective = result.effective;
        this.runtime = { ...this.runtime, control: { ...this.runtime.control, ...result.effective } };
        this.notice = "Pi confirmed the change.";
        if (action === "set-model") {
          const ref = `${value.provider}/${value.id}`;
          setShared(RECENT_KEY, [ref, ...this.recent().filter(r => r !== ref)].slice(0, MAX_RECENT));
        }
      } else {
        this.error = OUTCOME[result.status] ?? OUTCOME.unconfirmed;
        if (["stale", "unavailable", "unconfirmed"].includes(result.status)) {
          this.runtime = this.effective = null;
          this.models = [];
        }
      }
      cx.notify();
    });
  }

  chip(t, id, label, active, onClick) {
    return div().id(id).px(8).py(3).rounded(6).text_size(11.5).cursor_pointer()
      .bg(active ? t.selected : t.surface).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick).child(label);
  }

  render(cx) {
    const t = theme();
    const rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const pis = agents().filter(isPi);
    const targets = pis.filter(a => a.address === this.target);

    let lastProvider = null;
    const list = [];
    rows.forEach((m, i) => {
      const group = m.recent ? "Recent" : m.provider;
      if (group !== lastProvider) {
        lastProvider = group;
        list.push(div().pt(8).pb(2).px(6).text_size(10.5).font_semibold().text_color(t.dim).child(group.toUpperCase()));
      }
      const sel = i === this.at;
      list.push(
        h_flex().id(`m-${i}`).px(8).py(5).gap(10).rounded(7).items_center().cursor_pointer()
          .bg(sel ? t.selected : t.popover).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.apply(m, cx))
          .child(div().flex_1().truncate().text_color(t.foreground).child(m.recent ? m.ref : m.id))
          .child(div().flex_none().text_size(11).text_color(t.dim).child([m.context, m.thinking ? "think" : "", m.images ? "img" : ""].filter(Boolean).join(" · "))),
      );
    });

    return v_flex().id("pi-models").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const n = rows.length || 1;
        if (e.key === "escape") return this.dismiss();
        if (e.key === "down") this.at = (this.at + 1) % n;
        else if (e.key === "up") this.at = (this.at + n - 1) % n;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Pi model and thinking"))
        .child(div().text_size(11).text_color(t.dim).child(this.loading ? "Loading…" : `${this.models.length} models`))
        .child(this.chip(t, "esc", "Esc", false, () => this.dismiss())))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_size(11).text_color(t.dim).child("Agent"))
        .children(targets.map((a, i) => this.chip(t, `tg-${i}`, `${a.space_name ? a.space_name + " · " : ""}${a.title || a.address}`.slice(0, 40), a.address === this.target,
          () => {}))))
      .when(Boolean(this.effective), el => el.child(div().truncate().text_size(12).text_color(t.foreground)
        .child(this.effective.model ? `Current model: ${this.effective.model.provider}/${this.effective.model.id}` : "No active model")))
      .when(Boolean(this.effective), el => el.child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_size(11).text_color(t.dim).child(`Thinking: ${this.effective.thinking ?? "—"}`))
        .children(this.effective.levels.map(l => this.chip(t, `th-${l}`, l, l === this.effective.thinking,
          (_e, cx) => this.change("set-thinking", l, cx))))))
      .child(h_flex().h(36).flex_none().px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(this.pending || Boolean(this.notice), el => el.child(div().text_size(12).text_color(t.muted)
        .child(this.pending ? "Waiting for Pi to confirm…" : this.notice)))
      // Popups size to their content, so the list needs a real height.
      .child(v_flex().id("pi-models-list").h(440).overflow_y_scrollbar().children(list));
  }
}
