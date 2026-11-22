export const FESTIVE_RAIL_INSET = 12;
export const FESTIVE_TREE_BOTTOM = 4;
export const FESTIVE_CROWN_FRACTION = 1 / 8;
const PERIOD_MS = 75000;

export function catPatrol(rail, height, status, moving, artHeight = height - FESTIVE_TREE_BOTTOM) {
  if (!rail || !Number.isFinite(height) || !Number.isFinite(artHeight) || artHeight <= 0) return null;
  const kind = status === "blocked" ? "blocked" : status === "working" ? "working" : "resting";
  const portrait = `mods/festive-rail/festive-cat-portraits/${kind}.png`;
  const size = rail < 215 ? 88 : rail < 340 ? 100 : 112;
  const top = height - FESTIVE_TREE_BOTTOM - artHeight;
  const center = Math.round((rail - size) / 2);
  const swing = Math.min(center - 5, Math.round(rail * 0.23));
  const still = Math.round((artHeight - size) * 0.60);
  const tracks = [{ side: "left", left: center, y: still, climb: null, sway: null }];
  if (moving) {
    // The vertical track gates visibility. Each portrait traverses the entire
    // height before the other enters; the shorter horizontal loop visits branches.
    const crown = Math.max(0, Math.round(artHeight * FESTIVE_CROWN_FRACTION - size / 2));
    const exit = Math.ceil(crown + (artHeight - crown) * 2.18);
    const loop = (from, to, period) => ({ from, to, period, easing: "ease-in-out" });
    tracks[0] = { side: "left", left: center, y: crown,
      climb: loop(crown, exit, PERIOD_MS), sway: loop(center, center - swing, PERIOD_MS / 4) };
    tracks.push({ side: "right", left: center, y: exit,
      climb: loop(exit, crown, PERIOD_MS), sway: loop(center, center + swing, PERIOD_MS / 4) });
  }
  return { portrait, size, top, height: artHeight, tracks };
}
