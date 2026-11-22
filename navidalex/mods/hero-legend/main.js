// Hero legend: a full-window title card, opened by p5-tabs-forest's clock every hour of the
// workday ("N hours after the hero's death", counted from the 8:00 start) and at 17:25 ("Run.").
// Minimal: a light veil over the window and one line of serif text that fades in, holds and
// fades out; the card then closes itself. A click closes it early.
// props: { text }.

import { View, div } from "gpui-kit";
import { props, closeOverlay, shared } from "herdr";

const FADE_IN = 1200;
const HOLD = 4800;
const FADE_OUT = 1400;
const VEIL_BG = "#0000008C"; // how dark the window gets behind the text (alpha 0x8C = 55 %)
const INK = "#F2EEE4";
const SERIF = "Garamond"; // Windows ships it (GARA.TTF); GPUI falls back if it's missing.

export default class HeroLegend extends View {
  init(_props, cx) {
    this.phase = 0; // 0: hidden, 1: shown, 2: fading out
    cx.timer.after(60, (cx) => { this.phase = 1; cx.notify(); });
    cx.timer.after(FADE_IN + HOLD, (cx) => { this.phase = 2; cx.notify(); });
    cx.timer.after(FADE_IN + HOLD + FADE_OUT, () => this.close());
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  render() {
    const text = props()?.text ?? "1 hour after the hero's death";
    const on = this.phase === 1;
    const fade = (ms, delay = 0) => ({ duration: ms, delay, easing: "ease-in-out" });
    // The veil is the background's alpha, so the whole card fades as one and the text stays
    // fully opaque inside it.
    return div().id("hero-root").size_full().flex().items_center().justify_center().cursor_pointer()
      .bg(VEIL_BG)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a window would start a drag
      .on_click(() => this.close())
      .opacity(this.phase === 0 ? 0 : on ? 1 : 0)
      // Animation Off: no fade. The phases and the close still run on their timers, so it never sticks.
      .when(shared("p5.motion") !== false, (el) => el.transition("opacity", fade(on ? FADE_IN : FADE_OUT)))
      .child(div().id("hero-text").font_family(SERIF).text_size(text.length > 12 ? 34 : 56)
        .text_color(INK).child(text));
  }
}
