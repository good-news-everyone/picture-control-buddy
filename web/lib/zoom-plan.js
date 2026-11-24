// Geometry of the Compare zoom (spec/ui-zoom-plan.md stage Z3, decisions D1, D2, D7): pure functions,
// no DOM, no wasm. Given a pair's preparation, the decoded frame and a visible rectangle of the working
// space, they pick the source level, build the window map for that rectangle (pair-prepare.js viewRemap
// with { k, window }) and work out which rectangle of the held mosaic (raw.js roi()) feeds it, how to
// turn the decoder's unrotated ROI into the decoded (rotated) orientation, and the affine that ties
// the ROI's pixels to the main compare frame (renderer.renderRegion's lowRes).
//
// Frames and units
//  - The decoded frame (pair.raw.image, w x h, orientation applied) comes from develop(long) with the
//    integer shrink k = info.k: one decoded px = k half px = 2k sensor px. Unrotated (sensor
//    orientation) it is sw x sh and covers the held area's half px [0, sw*k) x [0, sh*k) from the
//    margin-cropped origin (develop floors the size, so it can be a few px short of the held area).
//  - A "level frame" is the same area at the ROI's resolution: level 2 (half px, develop(long = 0))
//    is sw*k x sh*k, level 1 (full sensor px) is sw*2k x sh*2k. s = level px per decoded px = k | 2k.
//    Level-frame continuous coordinate / s = main-frame continuous coordinate (px i centred at i + 0.5),
//    in either orientation (rotation is a symmetry of both frames).
//  - viewRemap is called with the level frame's size in the decoded orientation (fw x fh) and
//    k = level px per working px, so one output grid px = one level px; its sx/sy are level-frame
//    indices (px i centred at i).

import { viewRemap } from "./pair-prepare.js";

/** The decoder's EXIF rotation, in np.rot90 counter-clockwise steps (render.TURNS). */
export const DECODER_TURNS = { 3: 2, 6: 3, 8: 1 };
export const turnsOf = (orientation) => DECODER_TURNS[orientation] ?? 0;

// Zoom pyramid (D2): percent = device px per sensor px (1 = 100%, D1).
export const LEVEL2_FROM = 0.30;        // below: no ROI (the compare render is sharp enough)
export const LEVEL1_FROM = 0.75;        // from here: full sensor resolution
export const ROI_PAD = [0.25, 0.12, 0]; // the pad (a fraction of the visible size on each side), tried in order
export const ROI_MAX_PX = 5e6;          // the padded ROI (region and output window), pixels
export const ROI_HARD_MAX_PX = 8e6;     // the unpadded ROI: above this the level is not available
export const MARGIN_SMALL_SIGMA = 16;   // sensor px: the largest blur computed on the ROI itself (lowRes)
export const MARGIN_BIG_SIGMA = 180;    // sensor px: Clarity's largest blur (no lowRes: margin of 3 sigma, capped)
export const MARGIN_CAP = 160;          // region px

/** Which level the zoom wants: 0 - none (the compare render), 2 - half sensor, 1 - full sensor.
 *  percent: device px per sensor px; scale: the user's view.scale (1 = fitted). */
export function pickLevel({ percent, scale, level1 = true }) {
  if (!(scale > 1.001) || !(percent >= LEVEL2_FROM)) return 0;
  return percent >= LEVEL1_FROM && level1 ? 1 : 2;
}

/** The decoded frame's geometry. w, h: pair.raw.image size; k: info.k; orientation: info.orientation. */
export function frameGeometry({ w, h, k, orientation }) {
  const turns = turnsOf(orientation);
  const odd = turns % 2 === 1;
  return { w, h, k, turns, sw: odd ? h : w, sh: odd ? w : h };
}

/** The level frame: s (level px per decoded px), unrotated size ufw x ufh, decoded-orientation size fw x fh,
 *  the unrotate count for viewRemap and sensorPerLevel (sensor px per level px). */
export function levelFrame(geom, level) {
  const s = level === 1 ? 2 * geom.k : geom.k;
  const ufw = geom.sw * s, ufh = geom.sh * s;
  const odd = geom.turns % 2 === 1;
  return { level, s, ufw, ufh, fw: odd ? ufh : ufw, fh: odd ? ufw : ufh,
           unrotate: (4 - geom.turns) % 4, sensorPerLevel: level === 1 ? 1 : 2 };
}

/** Decoded-orientation px (x, y) -> unrotated px of a level frame (the inverse of develop's np.rot90). */
export function toUnrotated(turns, ufw, ufh, x, y) {
  switch (turns) {
    case 1: return [ufw - 1 - y, x];
    case 2: return [ufw - 1 - x, ufh - 1 - y];
    case 3: return [y, ufh - 1 - x];
    default: return [x, y];
  }
}

/** The unrotated rectangle { x, y, w, h } covering a decoded-orientation rectangle. */
export function unrotatedRect(turns, ufw, ufh, r) {
  const [ax, ay] = toUnrotated(turns, ufw, ufh, r.x, r.y);
  const [bx, by] = toUnrotated(turns, ufw, ufh, r.x + r.w - 1, r.y + r.h - 1);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx) + 1, h: Math.abs(ay - by) + 1 };
}

/**
 * The decoded-orientation region as float RGB: roiRgb is raw.roi()'s output (unrotated, rect `roi`),
 * region = plan.region in the decoded level frame; gain - the pair's edit gain [r, g, b] or null.
 */
export function rotateRegion(roiRgb, roi, region, turns, ufw, ufh, gain = null) {
  const out = new Float32Array(region.w * region.h * 3);
  const g0 = gain ? gain[0] : 1, g1 = gain ? gain[1] : 1, g2 = gain ? gain[2] : 1;
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const [ux, uy] = toUnrotated(turns, ufw, ufh, region.x + x, region.y + y);
      const i = ((uy - roi.y) * roi.w + (ux - roi.x)) * 3, o = (y * region.w + x) * 3;
      out[o] = roiRgb[i] * g0; out[o + 1] = roiRgb[i + 1] * g1; out[o + 2] = roiRgb[i + 2] * g2;
    }
  }
  return out;
}

// Main-frame px per grid px of a compare map along its middle row; 1 if unknown.
function stepAlongRow(map) {
  const r = Math.floor(map.h / 2) * map.w;
  let a = -1, b = -1;
  for (let x = 0; x < map.w; x++) if (map.sx[r + x] === map.sx[r + x]) { if (a < 0) a = x; b = x; }
  return b > a ? Math.hypot(map.sx[r + b] - map.sx[r + a], map.sy[r + b] - map.sy[r + a]) / (b - a) : 1;
}

/** Sensor px per working px at the middle of the compare map (the zoom readout, D1: percent =
 *  device px per working px / this). mainMap: the compare viewRemap map; W: prepared.size.w. */
export function sensorPerWorking(mainMap, geom, W) {
  const step = Math.max(stepAlongRow(mainMap), 1e-6);
  return step * (mainMap.fullW / W) * 2 * geom.k;
}

/** The visible rectangle of the working space for a viewport: image point = (screen - centre - pan) / s + size / 2,
 *  clipped to [0, W] x [0, H]; null when empty. s: canvas px per working px (base * view.scale). */
export function visibleRect(vp, view, s, W, H) {
  const cx = vp.x + vp.w / 2 + view.x, cy = vp.y + vp.h / 2 + view.y;
  const x0 = Math.max(0, (vp.x - cx) / s + W / 2), x1 = Math.min(W, (vp.x + vp.w - cx) / s + W / 2);
  const y0 = Math.max(0, (vp.y - cy) / s + H / 2), y1 = Math.min(H, (vp.y + vp.h - cy) / s + H / 2);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export const rectContains = (outer, inner, eps = 1e-6) => !!outer && !!inner
  && inner.x >= outer.x - eps && inner.y >= outer.y - eps
  && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;

/** The margin (region px) around the sampled area that the ROI's own detail blurs need. */
export function detailMargin(level, lowRes) {
  const scale = level === 1 ? 1 : 2;
  return lowRes ? Math.ceil(3 * MARGIN_SMALL_SIGMA / scale) + 4
                : Math.min(MARGIN_CAP, Math.ceil(3 * MARGIN_BIG_SIGMA / scale) + 4);
}

// One attempt at a given pad. Returns a plan, { empty: true } (the rectangle sees nothing of the
// source) or { tooLarge: true }.
function attempt({ prepared, geom, level, rect, pad, margin, lowRes, maxPx, maxTex, spw, hold }) {
  const W = prepared.size.w, H = prepared.size.h;
  const lf = levelFrame(geom, level);
  const kz = spw / lf.sensorPerLevel;                     // level px per working px
  const OW = Math.max(1, Math.round(W * kz)), OH = Math.max(1, Math.round(H * kz));
  const ex0 = Math.max(0, rect.x - pad * rect.w), ex1 = Math.min(W, rect.x + rect.w * (1 + pad));
  const ey0 = Math.max(0, rect.y - pad * rect.h), ey1 = Math.min(H, rect.y + rect.h * (1 + pad));
  const gx0 = Math.min(OW - 1, Math.max(0, Math.floor(ex0 * OW / W)));
  const gy0 = Math.min(OH - 1, Math.max(0, Math.floor(ey0 * OH / H)));
  const gx1 = Math.min(OW, Math.max(gx0 + 1, Math.ceil(ex1 * OW / W)));
  const gy1 = Math.min(OH, Math.max(gy0 + 1, Math.ceil(ey1 * OH / H)));
  const window = { x0: gx0, y0: gy0, w: gx1 - gx0, h: gy1 - gy0 };
  if (window.w * window.h > maxPx) return { tooLarge: true };
  const map = viewRemap(prepared, lf.fw, lf.fh, lf.unrotate, { k: kz, window });
  // the bbox of the source px the bicubic gather reads (floor - 1 .. floor + 2), plus the detail margin
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (let i = 0; i < map.sx.length; i++) {
    const u = map.sx[i];
    if (u !== u) continue;
    const v = map.sy[i];
    if (u < mnx) mnx = u;
    if (u > mxx) mxx = u;
    if (v < mny) mny = v;
    if (v > mxy) mxy = v;
  }
  if (!(mnx <= mxx)) return { empty: true };
  const bx0 = Math.max(0, Math.floor(mnx) - 1 - margin), by0 = Math.max(0, Math.floor(mny) - 1 - margin);
  const bx1 = Math.min(lf.fw - 1, Math.floor(mxx) + 2 + margin), by1 = Math.min(lf.fh - 1, Math.floor(mxy) + 2 + margin);
  const region = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
  if (region.w * region.h > maxPx) return { tooLarge: true };
  if (maxTex && (region.w > maxTex || region.h > maxTex)) return { tooLarge: true };
  const roi = unrotatedRect(geom.turns, lf.ufw, lf.ufh, region);
  const hs = lf.sensorPerLevel;                           // held area in level px = sensor px / hs
  if (hold && (roi.x + roi.w > hold[0] / hs || roi.y + roi.h > hold[1] / hs)) return { tooLarge: true };
  // sx/sy -> region indices (NaN stays NaN)
  for (let i = 0; i < map.sx.length; i++) { map.sx[i] -= region.x; map.sy[i] -= region.y; }
  return {
    level, s: lf.s, scale: lf.sensorPerLevel, pad,
    map, window, region, roi, turns: geom.turns, ufw: lf.ufw, ufh: lf.ufh,
    rect: { x: gx0 * W / OW, y: gy0 * H / OH, w: window.w * W / OW, h: window.h * H / OH },
    lowRes: lowRes ? { affine: [1 / lf.s, 0, region.x / lf.s, 0, 1 / lf.s, region.y / lf.s] } : null,
    px: region.w * region.h,
  };
}

/**
 * Plans one zoom region. Inputs: prepared (the pair's preparation), geom (frameGeometry), level (1 | 2),
 * rect (the visible rectangle, working space), spw (sensorPerWorking), lowRes (bool: the main compare
 * frame of this pair is available to the renderer), hold ([W, H] of the held area in sensor px, optional),
 * maxTex (MAX_TEXTURE_SIZE or 0). Tries the pads of ROI_PAD; the padded ROI stays within ROI_MAX_PX,
 * the unpadded one within ROI_HARD_MAX_PX. Returns the plan, { empty: true } or { tooLarge: true }.
 * The plan: level, s, scale (sensor px per region px), map (applyRemap map onto the region), window
 * (the grid window), rect (the working rectangle the output covers), region (the decoded-orientation
 * level-frame rectangle rendered), roi (the unrotated rectangle to ask the decoder for), turns, ufw,
 * ufh, lowRes ({ affine } | null), px.
 */
export function planRegion({ prepared, geom, level, rect, spw, lowRes = true, hold = null, maxTex = 0 }) {
  const margin = detailMargin(level, lowRes);
  let last = { tooLarge: true };
  for (const pad of ROI_PAD) {
    const maxPx = pad > 0 ? ROI_MAX_PX : ROI_HARD_MAX_PX;
    const r = attempt({ prepared, geom, level, rect, pad, margin, lowRes, maxPx, maxTex, spw, hold });
    if (!r.tooLarge) return r;
    last = r;
  }
  return last;
}

// ---------- the profile editor's zoom (spec/ui-zoom-plan.md "Profile editor") ----------
// The editor's main frame IS the renderer's frame, so there is no compare map and no pair geometry:
// working space = the decoded frame (w x h, orientation applied), image point (x, y) in frame px, and the
// level frames of levelFrame() relate to it by a plain scale s (level px per frame px). Pure functions
// for the view (percent, pan, zoom to a point) and for planEditorRegion; no DOM.

/** Sensor px per decoded-frame px (D1, the readout factor): one frame px = k half px = 2k sensor px. */
export const editorSensorPerFrame = (geom) => 2 * geom.k;

/** The zoom as device px per sensor px (1 = 100%). base: CSS px per frame px at the fit; scale: the view's
 *  multiplier (1 = fitted); dpr: device px per CSS px. */
export const editorPercent = (geom, base, dpr, scale) => base * dpr * scale / editorSensorPerFrame(geom);

/** The view multiplier that shows `percent` (1 = 100%). */
export const editorScaleForPercent = (geom, base, dpr, percent) => percent * editorSensorPerFrame(geom) / (base * dpr);

/** The pan (CSS px, relative to the viewport centre) kept inside the image: no empty border while the
 *  image is larger than the viewport on that axis, centred when it is smaller. s: CSS px per frame px. */
export function clampPan(view, vp, s, W, H) {
  const ex = Math.max(0, (s * W - vp.w) / 2), ey = Math.max(0, (s * H - vp.h) / 2);
  return { x: Math.min(ex, Math.max(-ex, view.x)), y: Math.min(ey, Math.max(-ey, view.y)) };
}

/** Zoom to `next` keeping the image point under the viewport point (mx, my) fixed (the unclamped view). */
export function zoomViewAt(view, next, mx, my, vp, base) {
  const s0 = base * view.scale, s1 = base * next;
  const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
  return { scale: next, x: mx - cx - (mx - cx - view.x) * (s1 / s0), y: my - cy - (my - cy - view.y) * (s1 / s0) };
}

/**
 * Plans one editor ROI. geom: frameGeometry of the decoded frame; level: 1 | 2; rect: the visible rectangle in
 * frame px ({ x, y, w, h }, continuous, inside [0, w] x [0, h]); lowRes: the renderer's main frame is the
 * frame (always in the editor); hold: [W, H] of the held area in sensor px (optional); maxTex: MAX_TEXTURE_SIZE or 0.
 * Tries the pads of ROI_PAD like planRegion: the padded rectangle (and the region with the detail margin)
 * stays within ROI_MAX_PX, the unpadded one within ROI_HARD_MAX_PX. Returns the plan, { empty: true } or
 * { tooLarge: true }. The plan:
 *   level, s (level px per frame px), scale (sensor px per level px = renderRegion's `scale`), pad,
 *   inner   - the integer level-frame rectangle (decoded orientation) the output covers,
 *   region  - inner + the detail margin, clipped to the level frame: what is rendered,
 *   crop    - inner inside the region ({ x, y, w, h }, region px),
 *   rect    - inner in frame px (what the layer covers on the stretched base: inner / s),
 *   roi     - the unrotated rectangle of the held area to ask raw.roi() for, turns, ufw, ufh,
 *   lowRes  - { affine } region px centres -> main-frame continuous coordinates, px - region px.
 */
export function planEditorRegion({ geom, level, rect, lowRes = true, hold = null, maxTex = 0 }) {
  const lf = levelFrame(geom, level);
  const s = lf.s, FW = geom.w, FH = geom.h;
  const margin = detailMargin(level, lowRes);
  let last = { tooLarge: true };
  for (const pad of ROI_PAD) {
    const maxPx = pad > 0 ? ROI_MAX_PX : ROI_HARD_MAX_PX;
    const ex0 = Math.max(0, rect.x - pad * rect.w), ex1 = Math.min(FW, rect.x + rect.w * (1 + pad));
    const ey0 = Math.max(0, rect.y - pad * rect.h), ey1 = Math.min(FH, rect.y + rect.h * (1 + pad));
    const ix0 = Math.min(lf.fw - 1, Math.max(0, Math.floor(ex0 * s))), iy0 = Math.min(lf.fh - 1, Math.max(0, Math.floor(ey0 * s)));
    const ix1 = Math.min(lf.fw, Math.ceil(ex1 * s)), iy1 = Math.min(lf.fh, Math.ceil(ey1 * s));
    if (!(ex1 > ex0) || !(ey1 > ey0) || ix1 <= ix0 || iy1 <= iy0) return { empty: true };
    const inner = { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 };
    if (inner.w * inner.h > maxPx) { last = { tooLarge: true }; continue; }
    const rx0 = Math.max(0, inner.x - margin), ry0 = Math.max(0, inner.y - margin);
    const rx1 = Math.min(lf.fw, inner.x + inner.w + margin), ry1 = Math.min(lf.fh, inner.y + inner.h + margin);
    const region = { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
    if (region.w * region.h > maxPx || (maxTex && (region.w > maxTex || region.h > maxTex))) { last = { tooLarge: true }; continue; }
    const roi = unrotatedRect(geom.turns, lf.ufw, lf.ufh, region);
    const hs = lf.sensorPerLevel;
    if (hold && (roi.x + roi.w > hold[0] / hs || roi.y + roi.h > hold[1] / hs)) { last = { tooLarge: true }; continue; }
    return {
      level, s, scale: hs, pad, inner, region,
      crop: { x: inner.x - region.x, y: inner.y - region.y, w: inner.w, h: inner.h },
      rect: { x: inner.x / s, y: inner.y / s, w: inner.w / s, h: inner.h / s },
      roi, turns: geom.turns, ufw: lf.ufw, ufh: lf.ufh,
      lowRes: lowRes ? { affine: [1 / s, 0, region.x / s, 0, 1 / s, region.y / s] } : null,
      px: region.w * region.h,
    };
  }
  return last;
}
