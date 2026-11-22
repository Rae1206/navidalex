export const FIREWORK_TICK = 100;
export const FIREWORK_ROWS = 54;
const CYCLE = 16000 / FIREWORK_TICK;
const RIGHT_DELAY = 5000 / FIREWORK_TICK;
const FLIGHT = 1500 / FIREWORK_TICK;
const BURST = 3000 / FIREWORK_TICK;
const BLOOM = 6;
const FADE = 3;
const DESIGN_REACH = 12;
const VERTICAL_SCALE = 1 / 2;

// Paths are local to the rocket head: x spans ±DESIGN_REACH, y is in
// design rows. Wider x scaling compensates for tall mono cells.
const HEART_RIGHT = [[0, -2], [3, -4], [7, -4], [9, -2],
  [9, 0], [7, 2], [5, 4], [1, 6], [0, 8]];
const HEART = [HEART_RIGHT, HEART_RIGHT.map(([x, y]) => [-x, y])];

// Clawd, the Claude Code mascot, reinterpreted as a small spark mosaic.
// Keep eyes and the gaps between the feet empty, even on the narrowest rail.
const CLAWD = [
  "  *****  ",
  " ******* ",
  " ** * ** ",
  "*** * ***",
  "*********",
  " ******* ",
  " * * * * ",
];

const ROCKETS = {
  left: { id: "red", color: "#FF686C", origin: 0.83, center: 0.69, crown: 8, delay: 0, paths: HEART },
  right: { id: "green", color: "#66F5A2", origin: 0.36, center: 0.31, crown: 13, delay: RIGHT_DELAY, sprite: CLAWD },
};
const EMPTY = "\u00a0";
const cache = new Map();

// Round local offsets symmetrically so an outline remains balanced at small sizes.
const roundOffset = value => Math.sign(value) * Math.round(Math.abs(value));

function drawFrame(columns, draw) {
  const grid = Array.from({ length: FIREWORK_ROWS }, () => []);
  draw((x, y, glyph) => {
    if (x >= 0 && x < columns && y >= 0 && y < FIREWORK_ROWS) grid[y][x] = glyph;
  });
  return grid.map(row => Array.from(row, glyph => glyph ?? EMPTY).join("") || EMPTY).join("\n");
}

function drawSprite(plot, sprite, reach, scale) {
  const sourceY = (sprite.length - 1) / 2;
  const sourceX = (sprite[0].length - 1) / 2;
  const halfHeight = Math.round(sourceY * scale);
  const halfWidth = Math.round(reach * scale);
  for (let y = -halfHeight; y <= halfHeight; y++) {
    const row = sprite[sourceY + roundOffset(y * sourceY / Math.max(1, halfHeight))];
    for (let x = -halfWidth; x <= halfWidth; x++) {
      if (row[sourceX + roundOffset(x * sourceX / Math.max(1, halfWidth))] === "*") plot(x, y);
    }
  }
}

function drawBurst(mark, center, crown, reach, { paths, sprite }, age, fade) {
  const scale = 0.18 + 0.82 * age / BLOOM;
  const plot = (x, y) => {
    const grain = (x + 2 * y) & 3;
    const glyph = fade === 0 || grain < FADE - fade ? "*" : ".";
    mark(center + x, crown + y + Math.min(2, fade), glyph);
  };
  if (sprite) drawSprite(plot, sprite, reach, scale);
  for (const path of paths ?? []) {
    const points = path.map(([x, y]) => [
      roundOffset(x * reach * scale / DESIGN_REACH), roundOffset(y * VERTICAL_SCALE * scale),
    ]);
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i - 1];
      const dx = points[i][0] - x, dy = points[i][1] - y;
      const steps = Math.max(1, Math.abs(dx), Math.abs(dy));
      for (let step = 0; step <= steps; step++) {
        plot(roundOffset(x + dx * step / steps), roundOffset(y + dy * step / steps));
      }
    }
  }
  if (age < 2) mark(center, crown, "+");
}

function rocketFrames(columns, rocket) {
  const { origin, crown, delay } = rocket;
  const floor = FIREWORK_ROWS - 1;
  const from = Math.round((columns - 1) * origin);
  const center = Math.round((columns - 1) * (rocket.center ?? 0.31));
  const room = Math.max(0, Math.min(18, center - 1, columns - center - 2));
  // Broader, shorter figures read better in the rail's tall monospace cells.
  const reach = Math.min(room, Math.max(5, Math.round(room * 0.58)));
  const flightX = frame => Math.round(from + (center - from) * Math.max(0, frame) / (FLIGHT - 1));
  const frames = Array(CYCLE).fill(EMPTY);
  for (let frame = 0; frame < FLIGHT; frame++) {
    frames[delay + frame] = drawFrame(columns, mark => {
      const y = Math.round(floor + (crown - floor) * frame / (FLIGHT - 1));
      if (frame > 0) mark(flightX(frame - 1), y + 2, ".");
      if (frame > 1) mark(flightX(frame - 2), y + 5, ".");
      mark(flightX(frame), y + 1, "|");
      mark(flightX(frame), y, "^");
    });
  }

  const start = delay + FLIGHT;
  const fadeStart = start + BURST - FADE;
  const burstFrame = (age, fade = 0) => drawFrame(columns, mark => drawBurst(mark, center, crown, reach, rocket, age, fade));
  for (let age = 0; age < BLOOM; age++) frames[start + age] = burstFrame(age);
  // Rasterize the long hold only once; it occupies many samples of the same track.
  frames.fill(burstFrame(BLOOM), start + BLOOM, fadeStart);
  for (let i = 0; i < FADE; i++) frames[fadeStart + i] = burstFrame(BLOOM, i + 1);
  return frames;
}

export function fireworkTracks(rail, side) {
  const font = rail >= 300 ? 13 : 11;
  const columns = Math.min(80, Math.floor((rail - 8) / (font * 0.57)));
  const key = `${columns}:${font}:${side}`;
  if (cache.has(key)) return cache.get(key);
  const rocket = side === "right" ? ROCKETS.right : ROCKETS.left;
  const { id, color } = rocket;
  const result = { font, columns, tracks: [{ id, color, frames: rocketFrames(columns, rocket) }] };
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
