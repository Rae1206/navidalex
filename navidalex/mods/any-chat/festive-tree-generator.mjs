// Pure builder for the Navidalex festive tree's ASCII layers. The code is ported unchanged from
// the build-at-init block in mods/any-chat/main.js (TREE_ART, treeLayers, TREE_LIGHT_LAYERS,
// treeColorLayers): same cells, same edits in the same order, same strings. Nothing here does
// I/O, starts timers or reads the clock. The offline build (variants/forest/build-festive-tree.mjs)
// calls it and writes festive-tree-compiled.js, which main.js imports as plain data.
// Blanks are written as escapes (\x20 = space, fromCharCode(0xa0) = NBSP) so the bytes are explicit.
import FESTIVE_ROWS from "./festive-tree-rows.js";
import { FESTIVE_CROWN_FRACTION } from "./festive-cat.js";

const SP = "\x20", SP2 = "\x20\x20";

export const TREE_COLS = 184, TREE_ROWS = 128;
// Must match main.js: TREE_LIGHTS has 3 entries and TREE_COLOR_LIGHTS has 4 (the precompile test checks both).
export const LIGHT_GROUPS = 3;
export const COLOR_GROUPS = 4;
export const TREE_PALETTE = ["#287855", "#49BA79", "#84E59B", "#BA892F", "#FFE061", "#A7444A", "#FF7276", "#F4CA7D", "#D79FFF", "#65747E", "#BDC7CF", "#C59662", "#B28ACF", "#FFF3B0", "#795237", "#436049"];
// main.js: const TREE_SPACE = " "; (non-breaking space)
export const TREE_SPACE = String.fromCharCode(0xa0);

const TREE_STAR = Array.from({ length: 10 }, (_, i) => {
  const angle = i * Math.PI / 5 - Math.PI / 2;
  const radius = i % 2 ? 0.44 : 1;
  return [92 + Math.cos(angle) * radius * 17, TREE_ROWS * FESTIVE_CROWN_FRACTION + Math.sin(angle) * radius * 8];
});
function starContains(x, y) {
  let inside = false;
  for (let i = 0, j = TREE_STAR.length - 1; i < TREE_STAR.length; j = i++) {
    const [ax, ay] = TREE_STAR[i], [bx, by] = TREE_STAR[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
const TREE_GIFTS = [
  { x: 24, top: 112, width: 29, bottom: 125, front: "5", edge: "6", lid: "6", side: "E", ribbon: "7" },
  { x: 56, top: 117, width: 23, bottom: 126, front: "0", edge: "2", lid: "1", side: "F", ribbon: "7" },
  { x: 110, top: 111, width: 34, bottom: 126, front: "C", edge: "8", lid: "C", side: "E", ribbon: "7" },
];

function treeGiftCell(x, y, gift) {
  const dx = x - gift.x, dy = y - gift.top;
  const depth = 6, face = gift.width - depth - 1;
  const center = Math.floor(face / 2);
  if (dx < 0 || dx >= gift.width || y > gift.bottom || dy < -3) return null;
  if (dy < 0) {
    const bow = ["/\\" + SP2 + "/\\", "\\_\\/_/", SP2 + "/||\\"][dy + 3][dx - center + 1];
    return bow && bow !== SP ? gift.ribbon + bow : null;
  }
  if (dy < 3) {
    const inset = (3 - dy) * 2;
    if (dx < inset || dx > face + inset) return null;
    if (dx === inset || dx === face + inset) return `${gift.edge}/`;
    if (dx === center + inset || dx === center + inset + 1) return `${gift.ribbon}=`;
    return (dy === 0 ? gift.edge + "_" : gift.lid + ":");
  }
  const slope = Math.ceil(Math.max(0, dx - face) / 2);
  if (y > gift.bottom - slope) return null;
  if (dx === center || dx === center + 1) return `${gift.ribbon}#`;
  if (dx > face) return (dx === gift.width - 1 || y === gift.bottom - slope) ? `${gift.edge}/` : `${gift.side}:`;
  if (dy === 3 || dy === 4 || y === gift.bottom) return `${gift.edge}${dx === 0 || dx === face ? "+" : "="}`;
  if (dx === 0 || dx === face) return `${gift.edge}|`;
  if (dy === 7 || dy === 8) return `${gift.ribbon}=`;
  return gift.front + ((dx + dy) % 5 ? ":" : "o");
}

const TREE_FRINGE = Array.from({ length: TREE_COLS }, (_, x) =>
  109 + 4.4 * Math.cos(x * 0.247) + 1.6 * Math.sin(x * 0.69) - Math.abs(x - 92) * 0.046);
function lowerBough(x, y) {
  const distance = Math.abs(x - 92);
  const edge = TREE_FRINGE[x];
  const reach = 65 + Math.min(13, (y - 94) * 1.35);
  if (distance > reach || y > edge) return SP2;
  const grain = (x * 23 + y * 17 + x * y) % 23;
  const rim = edge - y < 2 || reach - distance < 3;
  if (rim && grain < 4) return SP2;
  const shade = rim ? "0" : grain > 20 ? "2" : grain > 8 ? "1" : "0";
  const needles = x < 92 ? "-/+.:/o" : "-\\+.:\\o";
  return shade + needles[grain % needles.length];
}

// The whole tree as rows of 184 two-character cells (color digit, then glyph).
export function buildTreeArt() {
  return FESTIVE_ROWS.map((row, y) => {
    const cells = row.padEnd(TREE_COLS * 2, SP).match(/../g);
    for (let x = 0; x < TREE_COLS; x++) {
      const color = cells[x][0];
      if (color === "7" || color === "8" || ((color === "9" || color === "A") && (x < 59 || x > 123))) cells[x] = SP2;
      if (y >= 98) {
        const bough = lowerBough(x, y);
        // Keep the intact texture near the seam; replace the old fringe and gift fragments.
        const keep = y < 103 && bough !== SP2 && "01234".includes(color);
        cells[x] = keep ? cells[x] : bough;
      }
      if (cells[x] === SP2) {
        // Bark fills the opening under the canopy but stays behind the gifts.
        const trunk = y >= 108 && y <= 124 && Math.abs(x - 92) <= (y >= 121 ? 9 : 6);
        const ground = ((x - 91) / 75) ** 2 + ((y - 124) / 3.4) ** 2 < 1;
        const grain = (x * 13 + y * 23) % 17;
        if (trunk) cells[x] = x <= 89 ? `B${"|:|/"[(x + y) % 4]}` : `E${"||:#"[(x + y) % 4]}`;
        else if (ground && grain < (y === 124 ? 14 : 8)) cells[x] = `F${"_-.:'"[grain % 5]}`;
      }
      if (y >= 108) {
        for (const gift of TREE_GIFTS) {
          const cell = treeGiftCell(x, y, gift);
          if (cell) { cells[x] = cell; break; }
        }
      }
      if (y < 5 || y > 24 || x < 70 || x > 114) continue;
      if ("34D".includes(cells[x][0])) cells[x] = SP2;
      if (!starContains(x, y)) continue;
      const edge = !starContains(x - 2, y) || !starContains(x + 2, y) || !starContains(x, y - 1) || !starContains(x, y + 1);
      cells[x] = edge ? "3+" : `D${"+*#@"[(x + y * 3) % 4]}`;
    }
    return cells.join("");
  });
}

// One native multiline element per color, even at 23,552 ASCII cells.
function treeLayers(art, stride) {
  return TREE_PALETTE.map((_, color) => Array.from({ length: TREE_ROWS / stride }, (_, y) => {
    const row = art[y * stride];
    const token = color.toString(16).toUpperCase();
    const depth = y * stride / TREE_ROWS;
    return Array.from({ length: TREE_COLS / stride }, (_, x) => {
      const i = x * stride * 2, cell = row[i];
      const light = cell === "4" || cell === "D";
      // Keep a dim garland and a full canopy visible at the bottom of every pulse.
      const dimLight = light && (depth < 0.235 || (x * stride + 2 * y * stride) % 5 < 2);
      const underLight = color === 1 && light && !dimLight && depth < 0.89
        && Math.abs(x * stride / TREE_COLS - 0.51) < 0.055 + 0.55 * (depth - 0.18);
      return cell === token || (color === 3 && dimLight) || underLight ? row[i + 1] : TREE_SPACE;
    }).join("").trimEnd() || TREE_SPACE;
  }).join("\n"));
}

function treeLightLayers(art, stride) {
  return Array.from({ length: LIGHT_GROUPS }, (_, group) => Array.from({ length: TREE_ROWS / stride }, (_, y) => {
    const row = art[y * stride];
    const band = y * stride / TREE_ROWS < 0.235 ? 2 : Math.floor(y * stride / 17) % 2;
    if (band !== group) return TREE_SPACE;
    return Array.from({ length: TREE_COLS / stride }, (_, x) => {
      const i = x * stride * 2;
      return row[i] === "4" || row[i] === "D" ? row[i + 1] : TREE_SPACE;
    }).join("").trimEnd() || TREE_SPACE;
  }).join("\n"));
}

// Scan the canopy once. Even-grid bulb centers survive the half-resolution view.
function treeColorLayers(art) {
  const grids = [1, 2].map(stride => Array.from({ length: COLOR_GROUPS }, () => Array(TREE_ROWS / stride).fill("")));
  const ink = (grid, x, y, glyph) => { grid[y] = grid[y].padEnd(x, TREE_SPACE) + glyph; };
  const needle = (x, y) => x < TREE_COLS && "012".includes(art[y][x * 2]);
  for (let y = 26; y <= 108; y += 2) for (let x = 0; x < TREE_COLS; x += 2) {
    const col = x / 2, row = y / 2;
    if ((col * 17 + row * 13) % 43 >= 5 || !needle(x, y)) continue;
    const group = (col * 5 + row * 7) % COLOR_GROUPS;
    const full = grids[0][group];
    ink(full, x, y, "@");
    if (needle(x + 1, y)) ink(full, x + 1, y, "+");
    if (needle(x, y + 1)) ink(full, x, y + 1, "+");
    ink(grids[1][group], col, row, "@");
  }
  return grids.map(set => set.map(rows => rows.map(line => line || TREE_SPACE).join("\n")));
}

// Every layer the mod used to build at init: [stride 1, stride 2] for TREE_LAYERS (16 colors each),
// TREE_LIGHT_LAYERS (3 groups each) and TREE_COLOR_LAYERS (4 groups each).
export function buildTreeLayers() {
  const art = buildTreeArt();
  return {
    TREE_LAYERS: [treeLayers(art, 1), treeLayers(art, 2)],
    TREE_LIGHT_LAYERS: [1, 2].map(stride => treeLightLayers(art, stride)),
    TREE_COLOR_LAYERS: treeColorLayers(art),
  };
}

const HEADER = "// Generated by variants/forest/build-festive-tree.mjs from festive-tree-generator.mjs. Do not edit.\n"
  + "// Each string is one layer: its rows joined by a line feed, one character per column, NBSP for blank.\n"
  + "// Pure data: no imports, nothing computed when the mod loads.\n";

// The exact text of festive-tree-compiled.js for the given layers (deterministic: no timestamps).
export function serializeTreeLayers({ TREE_LAYERS, TREE_LIGHT_LAYERS, TREE_COLOR_LAYERS }) {
  const table = (name, byStride) => `export const ${name} = [\n${byStride.map(layers =>
    `  [\n${layers.map(layer => `    ${JSON.stringify(layer)},\n`).join("")}  ],\n`).join("")}];\n`;
  return HEADER + "\n" + table("TREE_LAYERS", TREE_LAYERS) + "\n"
    + table("TREE_LIGHT_LAYERS", TREE_LIGHT_LAYERS) + "\n" + table("TREE_COLOR_LAYERS", TREE_COLOR_LAYERS);
}
