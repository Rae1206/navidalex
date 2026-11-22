// One side of the festive chat view (props { side: "left" | "right", stack?, self? }): the tree,
// its lights, snow, fireworks and the cat, in a block of its own beside the chat. Its motion
// redraws this small view only, never the chat's transcript.
import { View, div, image } from "gpui-kit";
import { v_flex } from "gpui-base";
import { agents, checking, focused, layout, nextCommand, props, shared, theme } from "herdr";
import { FIREWORK_ROWS, FIREWORK_TICK, fireworkTracks } from "./festive-fireworks.js";
import { catPatrol, FESTIVE_RAIL_INSET, FESTIVE_TREE_BOTTOM } from "./festive-cat.js";
import {
  CAT_TICK, LIGHT_TICK, SNOW_TICK, TREE_COLOR_LIGHTS, TREE_GLINTS, TREE_LIGHTS,
  loopAt, railSize, snowFrames, treeMetrics,
} from "./festive.js";

const TYPING_SHARED_KEY = "chat.festiveTyping";
const TYPING_LEASE = /^typing-lease-([a-z0-9]+)-(\d+)$/;
const frameText = (frames, ms, elapsed) => frames[Math.floor(elapsed / ms) % frames.length];

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
// A saved #rrggbb in the pink-to-red range: an old Forest pink choice, drawn as the theme's background.
const pinkish = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return false;
  let h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h >= 300 || h < 30;
};
// The chat's look (any-chat's ⚙, shared "chat.look"): its width, and the background its log has,
// so the gutters and the chat read as one surface.
const chatLook = () => ({ width: "narrow", bg: "background", ...(shared("chat.look") ?? {}) });
function chatBackground(t, bg) {
  if (HEX.test(bg)) return pinkish(bg) ? t.background : bg;
  return t[bg] ?? t.background;
}

export default class FestiveRail extends View {
  init(_props, cx) {
    this.lights = new Map();
    // Reuse the cat's 100 ms cadence. Independent native .frames cannot hold their current index.
    cx.timer.every(CAT_TICK, (cx) => {
      if (shared("p5.motion") === false || !this.showing() || !this.rail() || this.typingPaused(Date.now())) {
        this.frameWall = null;
        return;
      }
      cx.notify();
    });
    if (!checking()) cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        const match = TYPING_LEASE.exec(command);
        if (match && shared(TYPING_SHARED_KEY)?.owner === match[1]) {
          const expiresAt = Number(match[2]);
          if (Number.isSafeInteger(expiresAt)) this.typingLease = { owner: match[1], expiresAt };
        }
      }
    });
  }

  typingPaused(now) {
    const lease = shared(TYPING_SHARED_KEY);
    if (!lease || typeof lease.owner !== "string" || !Number.isSafeInteger(lease.expiresAt)) return false;
    const renewed = this.typingLease?.owner === lease.owner ? this.typingLease.expiresAt : 0;
    return now < Math.max(lease.expiresAt, renewed);
  }

  // Only render commits a sample; a timer tick queued just before typing cannot advance it.
  sample(now, visible, moving) {
    if (!moving) this.frame = null;
    const paused = moving && visible && this.typingPaused(now);
    if (!moving || !visible || paused) this.frameWall = null;
    if (!moving || !visible) return null;
    if (paused && this.frame) return this.frame;

    const wall = Math.floor(now / CAT_TICK) * CAT_TICK;
    const step = this.frameWall == null ? CAT_TICK : Math.max(0, wall - this.frameWall);
    this.frame = this.frame
      ? { elapsed: this.frame.elapsed + step, catAt: this.frame.catAt + step, status: this.liveStatus() }
      : { elapsed: 0, catAt: wall, status: this.liveStatus() };
    if (!paused) this.frameWall = wall;
    return this.frame;
  }

  side() { return props()?.side === "right" ? "right" : "left"; }

  // Inside a layout stack (props { stack, self }): drawn only while that child is the shown one.
  showing() {
    const { stack, self } = props() ?? {};
    if (!stack) return true;
    const find = (node) => (node?.id === stack ? node : (node?.children ?? []).map(find).find(Boolean));
    const node = find(layout());
    return (node?.active ?? node?.children?.[0]?.id) === self;
  }

  rail() {
    return railSize(this.size?.width ?? 0, this.size?.height ?? 0, chatLook().width === "narrow");
  }

  status() { return this.frame ? this.frame.status : this.liveStatus(); }

  // The focused tab's agent, the one the chat shows: its status picks the cat's portrait.
  liveStatus() {
    const f = focused();
    const mine = agents().filter((a) => a.tab === f?.tab);
    return (mine.find((a) => a.address === (f?.agent ?? f?.terminal)) ?? mine[0])?.status;
  }

  render() {
    const t = theme();
    const side = this.side();
    const rail = this.rail();
    const height = this.size?.height ?? 0;
    const visible = rail > 0 && this.showing();
    const moving = shared("p5.motion") !== false;
    const frame = this.sample(Date.now(), visible, moving);
    return div().id("root").relative().size_full().overflow_hidden().bg(chatBackground(t, chatLook().bg))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .when(visible, (el) => el
        .child(this.tree(side, rail, height, frame))
        .children(this.cat(side, rail, height, moving)));
  }

  tree(side, rail, height, frame) {
    const { stride, artHeight } = treeMetrics(rail, height);
    const treeW = rail - 8;
    const elapsed = frame ? Math.floor(frame.elapsed / LIGHT_TICK) * LIGHT_TICK : null;
    const isLit = (pulse) => elapsed === null || loopAt(pulse, elapsed) >= 0.5;
    const sprite = (id, file) => div().id(id).absolute().inset_0()
      .child(image(`mods/festive-rail/sprites/${file}`).w(treeW).h(artHeight));
    const litLayers = [];
    TREE_LIGHTS.forEach((pulse, i) => {
      if (isLit(pulse)) litLayers.push(sprite(`festive-${side}-light-bank-${i}`, `tree-s${stride}-light-${i}.png`));
    });
    TREE_COLOR_LIGHTS.forEach((pulse, i) => {
      if (isLit(pulse)) litLayers.push(sprite(`festive-${side}-color-light-${i}`, `tree-s${stride}-color-${i}.png`));
    });
    TREE_GLINTS.forEach((pulse, i) => {
      if (isLit(pulse)) litLayers.push(sprite(`festive-${side}-glint-${i}`, `tree-s${stride}-glint-${i}.png`));
    });
    return v_flex().id(`festive-${side}`).absolute().top(0).bottom(0).w(rail)
      .when(side === "left", (el) => el.left(FESTIVE_RAIL_INSET)).when(side === "right", (el) => el.right(FESTIVE_RAIL_INSET))
      .when(side === "right", (el) => el.child(this.fullMoon(rail)))
      .child(div().id(`festive-tree-${side}`).absolute().bottom(FESTIVE_TREE_BOTTOM).left(0).w(treeW).h(artHeight)
        .child(sprite(`festive-${side}-tree-base`, `tree-s${stride}-base.png`))
        .children(litLayers))
      .child(this.snow(side, rail, height, frame))
      .children(this.fireworks(side, rail, height, frame));
  }

  // Pre-rendered ASCII full moon sprite at top-right of the right rail.
  fullMoon(rail) {
    const font = Math.max(5.5, Math.min(8.5, Math.round((rail * 0.025) * 10) / 10));
    const line = Math.round(font * 1.12 * 10) / 10;
    const w = Math.ceil(29 * font * 0.58) + 6;
    const h = Math.ceil(15 * line) + 4;
    return div().id("festive-full-moon").absolute().top(10).right(10).w(w).h(h)
      .child(image("mods/festive-rail/sprites/moon.png").w(w).h(h));
  }

  snow(side, rail, height, frame) {
    const key = `${side}:${rail}:${height}`;
    if (this.snowTrack?.key !== key) this.snowTrack = { key, ...snowFrames(rail, height, side) };
    const { frames, line } = this.snowTrack;
    return div().id(`festive-flakes-${side}`).absolute().top(6).left(4).right(4)
      .font_family("Consolas").text_size(9).line_height(`${line}px`).whitespace_nowrap()
      .text_color("#A5C3D1").child(frameText(frames, SNOW_TICK, frame?.elapsed ?? 0));
  }

  fireworks(side, rail, height, frame) {
    if (!frame) return [];
    const { tracks, font } = fireworkTracks(rail, side);
    return tracks.map(({ id, color, frames }) => div().id(`festive-firework-${side}-${id}`)
      .absolute().top(0).bottom(0).left(4).right(4).overflow_hidden()
      .font_family("Consolas").text_size(font).line_height(`${(height - 6) / FIREWORK_ROWS}px`)
      .text_color(color).whitespace_nowrap().child(frameText(frames, FIREWORK_TICK, frame.elapsed)));
  }

  // The cat uses the same wall-clock grid on both sides, minus time held on a frame.
  cat(side, rail, height, moving) {
    const patrol = catPatrol(rail, height, this.status(), moving, treeMetrics(rail, height).artHeight);
    const track = patrol?.tracks.find((tr) => tr.side === side);
    if (!track) return [];
    const now = this.frame?.catAt ?? 0;
    const y = track.climb ? Math.round(loopAt(track.climb, now)) : track.y;
    const left = track.sway ? Math.round(loopAt(track.sway, now)) : track.left;
    return [div().id(`festive-cat-${side}`)
      .absolute().top(patrol.top).h(patrol.height).w(rail).overflow_hidden()
      .when(side === "left", (el) => el.left(FESTIVE_RAIL_INSET)).when(side === "right", (el) => el.right(FESTIVE_RAIL_INSET))
      .child(div().id(`festive-cat-${side}-climb`).absolute().top(y).left(0).w(rail).h(patrol.size)
        .child(div().id(`festive-cat-${side}-portrait`).absolute().top(0).left(left).size(patrol.size)
          .child(image(patrol.portrait).size(patrol.size))))];
  }
}
