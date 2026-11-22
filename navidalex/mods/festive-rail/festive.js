// The festive gutter beside the navidalex chat: sizes, tree palette, stepped light and snow tracks.
// Pure: no herdr calls, so tests import it as is.

// The chat's reading column and the padding the chat keeps beside it (mods/any-chat NARROW).
export const NARROW = 880;
export const CHAT_PAD = 16;
// The chat block between the two rail blocks: the column plus its padding on both sides.
export const CHAT_BLOCK = NARROW + 2 * CHAT_PAD;

const TREE_COLS = 184, TREE_ROWS = 128;
const TREE_ASPECT = 1.51;
const TREE_FIT_ASPECT = 1.1;
export const TREE_PALETTE = ["#287855", "#49BA79", "#84E59B", "#BA892F", "#FFE061", "#A7444A", "#FF7276", "#F4CA7D", "#D79FFF", "#65747E", "#BDC7CF", "#C59662", "#B28ACF", "#FFF3B0", "#795237", "#436049"];
export const TREE_SPACE = "\u00a0";
// The from/to/period of each light are the old continuous fades; they now set its blink pattern.
export const TREE_LIGHTS = [
  { color: "#FFE061", from: 0, to: 1, period: 3700 },
  { color: "#FFE9A0", from: 1, to: 0, period: 5100 },
  { color: "#FFF3B0", from: 0.12, to: 1, period: 6600 },
];
export const TREE_STATIC_COLORS = TREE_PALETTE.map((_, i) => i).filter(i => ![4, 9, 10, 13].includes(i));
export const TREE_COLOR_LIGHTS = [
  { color: "#FF697D", from: 0.08, to: 1, period: 2500 },
  { color: "#78DCFF", from: 1, to: 0.10, period: 3200 },
  { color: "#DFA3FF", from: 0.12, to: 1, period: 4100 },
  { color: "#B7FF8D", from: 1, to: 0.13, period: 5300 },
];
// The two glints: the tree's palette colors 9 and 10.
export const TREE_GLINTS = [
  { color: 9, from: 0.92, to: 0.12, period: 3200 },
  { color: 10, from: 0.13, to: 1, period: 2300 },
];

// Stepped motion. Every `.frames` track shares one native clock, so these multiples of
// 100 ms land on the same redraws: about 10 a second at most, lights change 3.3 times a second.
export const LIGHT_TICK = 300;
export const SNOW_TICK = 100;
export const CAT_TICK = 100;

// The rail (tree column) width for a rail block, or 0 when it gets none. Same rule as the
// old in-chat gutter: the gutter is this block plus the chat's own padding beside the column.
export function railSize(blockWidth, height, narrow) {
  const gutter = blockWidth + CHAT_PAD;
  if (!narrow || !(height >= 400) || !(gutter >= 174)) return 0;
  const rail = Math.min(830, Math.floor(gutter - 17), Math.floor((height - 48) / TREE_FIT_ASPECT));
  return rail < 150 ? 0 : rail;
}

export function treeMetrics(rail, height) {
  const stride = rail < 335 ? 2 : 1;
  const rows = TREE_ROWS / stride, cols = TREE_COLS / stride;
  const font = Math.floor((rail - 14) / (cols * 0.57) * 10) / 10;
  const line = Math.floor((Math.min(rail * TREE_ASPECT, height - 8) / rows) * 10) / 10;
  return { stride, font, line, artHeight: Math.ceil(rows * line) };
}

// Where a native `.loop` would be at `ms`: from -> to -> from every period, eased in and out.
export function loopAt({ from, to, period }, ms) {
  const x = (((ms % period) + period) % period) / period;
  const there = x < 0.5 ? x * 2 : 2 - x * 2;
  return from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * there));
}

// A light as on/off text frames, LIGHT_TICK apart: lit while its old fade was past half.
export function lightFrames(text, pulse) {
  const steps = Math.max(2, Math.round(pulse.period / LIGHT_TICK));
  return Array.from({ length: steps }, (_, i) => (loopAt(pulse, (i * pulse.period) / steps) >= 0.5 ? text : TREE_SPACE));
}

// One precomputed text track per gutter, advancing one row per SNOW_TICK.
const SNOW_ROWS = 224;
const SNOW = new Map();
function snowTrack(cols) {
  if (SNOW.has(cols)) return SNOW.get(cols);
  const count = cols < 35 ? 15 : cols < 52 ? 18 : 22;
  const flakes = Array.from({ length: count }, (_, i) => ({
    x: 2 + Math.round((cols - 5) * (((i * 47 + 13) % 101) / 101)),
    start: (7 + i * 73) % SNOW_ROWS,
    phase: i * 2.39996,
    gust: 1 + (i % 4),
    drift: 0.7 + (i % 3) * 0.48,
    glyph: i % 6 ? (i % 3 ? "." : "+") : "*",
  }));
  const indent = Array.from({ length: cols }, (_, x) => TREE_SPACE.repeat(x));
  const frames = Array.from({ length: SNOW_ROWS }, (_, step) => {
    const rows = Array(SNOW_ROWS).fill(TREE_SPACE);
    for (const flake of flakes) {
      const y = (flake.start + step) % SNOW_ROWS;
      const wind = Math.sin(flake.phase + y * flake.gust * 2 * Math.PI / SNOW_ROWS);
      const x = Math.max(0, Math.min(cols - 1, flake.x + Math.round(wind * flake.drift)));
      rows[y] = indent[x] + flake.glyph;
    }
    return rows.join("\n");
  });
  SNOW.set(cols, frames);
  return frames;
}

// The snow frames for a rail, and the row height that spreads them over the gutter. The right
// gutter starts half a cycle later, so the two sides don't fall in lockstep.
export function snowFrames(rail, height, side) {
  const frames = snowTrack(rail >= 380 ? 69 : rail >= 290 ? 52 : rail >= 200 ? 35 : 22);
  const shift = side === "right" ? frames.length / 2 : 0;
  return { frames: shift ? [...frames.slice(shift), ...frames.slice(0, shift)] : frames, line: (height - 19) / SNOW_ROWS };
}

// Static 3-layer ASCII full moon (halo, luminous disc with limb shading, and subtle craters).
let MOON_CACHE = null;
export function fullMoonAscii() {
  if (MOON_CACHE) return MOON_CACHE;
  const cols = 29, rows = 15, cx = 14, cy = 7, rx = 10.6, ry = 5.3;
  const craters = [
    { x: -0.44, y: -0.32, r: 0.28 },
    { x: 0.24, y: -0.40, r: 0.20 },
    { x: 0.22, y: 0.16, r: 0.34 },
    { x: -0.36, y: 0.38, r: 0.22 },
    { x: 0.56, y: 0.42, r: 0.15 },
  ];
  const halo = [], disc = [], shade = [];
  for (let y = 0; y < rows; y++) {
    let hRow = "", dRow = "", sRow = "";
    for (let x = 0; x < cols; x++) {
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      const dist = Math.hypot(nx, ny);
      if (dist <= 1.0) {
        const hit = craters.find((c) => Math.hypot(nx - c.x, ny - c.y) <= c.r);
        if (hit) {
          const cd = Math.hypot(nx - hit.x, ny - hit.y) / hit.r;
          hRow += TREE_SPACE;
          dRow += TREE_SPACE;
          sRow += cd < 0.55 ? ":" : "o";
        } else {
          hRow += TREE_SPACE;
          sRow += TREE_SPACE;
          dRow += dist > 0.90 ? "+" : dist > 0.78 ? "=" : dist > 0.58 ? "%" : "#";
        }
      } else if (dist <= 1.26 && ((x + y * 2) % 3 === 0)) {
        hRow += dist < 1.12 ? ":" : ".";
        dRow += TREE_SPACE;
        sRow += TREE_SPACE;
      } else {
        hRow += TREE_SPACE;
        dRow += TREE_SPACE;
        sRow += TREE_SPACE;
      }
    }
    halo.push(hRow);
    disc.push(dRow);
    shade.push(sRow);
  }
  MOON_CACHE = [
    { id: "halo", color: "#FFF3B055", text: halo.join("\n") },
    { id: "disc", color: "#FFF6D6", text: disc.join("\n") },
    { id: "craters", color: "#C8B88A", text: shade.join("\n") },
  ];
  return MOON_CACHE;
}
