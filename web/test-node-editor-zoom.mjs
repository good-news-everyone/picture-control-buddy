// The profile editor's zoom geometry (lib/zoom-plan.js: planEditorRegion, editorPercent, clampPan,
// zoomViewAt; spec/ui-zoom-plan.md "Profile editor"). Pure Node, no browser, no RAW, no wasm. Standalone:
//     node web/test-node-editor-zoom.mjs        (exit 1 on any failure)
//
// What is checked, for decoder orientations 0..3 (EXIF 1 / 8 / 3 / 6), shrinks k = 1..3, both levels,
// frame sizes whose decoded size is FLOORED below the held area (develop floors), the frame edges and corners:
//  1. a plan is consistent: region inside the level frame, inner inside region, crop = inner in region, the layer
//     rect (inner / s, frame px) contains the visible rectangle, the unrotated roi is the exact image of the region
//     (corners, a sample of px), integer, inside the held area; guards (hold too small, maxTex, caps, empty rect);
//  2. SOURCE AGREEMENT (stated tolerance TOL_POS = 1e-6 sensor px): a simulated mosaic whose value is its own held-area
//     coordinate is run through the real code path (roi rectangle -> rotateRegion) and compared with the main frame
//     a simulated develop would make (box-shrink by k, np.rot90 by the orientation, implemented independently here),
//     sampled bilinearly at the position the lowRes affine gives for each region px; also the layer's drawing
//     position (rect) and the affine agree. This is the "the ROI lines up with the stretched frame" check;
//  3. the readout factor (percent <-> view scale, D1), the level thresholds, the view math (zoom to a point keeps the
//     point, clamped pan, visible rectangle = the inverse of the drawing transform).
import { frameGeometry, levelFrame, planEditorRegion, rotateRegion, unrotatedRect, toUnrotated, pickLevel,
         visibleRect, rectContains, detailMargin, editorPercent, editorScaleForPercent, editorSensorPerFrame,
         clampPan, zoomViewAt, ROI_MAX_PX, ROI_HARD_MAX_PX, ROI_PAD, LEVEL1_FROM, LEVEL2_FROM } from "./lib/zoom-plan.js";

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log(`FAIL ${msg}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const TOL_POS = 1e-6;                     // sensor px
const ORIENTATIONS = [[1, 0], [8, 1], [3, 2], [6, 3]];   // EXIF orientation, np.rot90 turns
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---------- an independent develop model: np.rot90 by definition, box-shrink positions ----------
// a field is { w, h, a: Float64Array(w*h) } row-major; rot90 CCW: out[i][j] = a[j][w-1-i], out is (w rows, h cols)
function rot90(f) {
  const out = { w: f.h, h: f.w, a: new Float64Array(f.w * f.h) };
  for (let i = 0; i < out.h; i++) for (let j = 0; j < out.w; j++) out.a[i * out.w + j] = f.a[j * f.w + (f.w - 1 - i)];
  return out;
}
const rotN = (f, n) => { for (let i = 0; i < n; i++) f = rot90(f); return f; };
// bilinear sample at a continuous coordinate (pixel i centred at i + 0.5); null near/outside the border (no clamping effects)
function sample(f, mx, my) {
  const x = mx - 0.5, y = my - 0.5;
  if (x < 0 || y < 0 || x > f.w - 1 || y > f.h - 1) return null;
  const x0 = Math.min(Math.floor(x), f.w - 2), y0 = Math.min(Math.floor(y), f.h - 2);
  const fx = x - x0, fy = y - y0;
  const at = (xx, yy) => f.a[yy * f.w + xx];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

const SC = 2 ** -13;   // values are stored as coordinate * 2^-13: exact in float32 (14 significant bits)

// ---------- 1 + 2: plans and the source agreement ----------
function checkPlan(tag, geom, level, rect, hold, plan) {
  const lf = levelFrame(geom, level), s = lf.s;
  ok(plan.level === level && plan.s === s && plan.scale === lf.sensorPerLevel, `${tag}: level / s / scale`);
  const { inner, region, crop, roi } = plan;
  ok(region.x >= 0 && region.y >= 0 && region.x + region.w <= lf.fw && region.y + region.h <= lf.fh
     && region.w > 0 && region.h > 0, `${tag}: region inside the level frame (${JSON.stringify(region)} in ${lf.fw}x${lf.fh})`);
  ok(inner.x >= region.x && inner.y >= region.y && inner.x + inner.w <= region.x + region.w
     && inner.y + inner.h <= region.y + region.h, `${tag}: inner inside region`);
  ok(crop.x === inner.x - region.x && crop.y === inner.y - region.y && crop.w === inner.w && crop.h === inner.h, `${tag}: crop`);
  ok(Number.isInteger(inner.x + inner.y + inner.w + inner.h + region.x + region.y + region.w + region.h), `${tag}: integer rectangles`);
  // the layer's rect (frame px) is the inner rectangle / s and contains the visible rectangle
  ok(near(plan.rect.x, inner.x / s, 1e-12) && near(plan.rect.w, inner.w / s, 1e-12) && near(plan.rect.h, inner.h / s, 1e-12),
     `${tag}: rect = inner / s`);
  ok(rectContains(plan.rect, rect, 1e-9), `${tag}: the layer rect contains the visible rectangle`);
  // margin: the region extends inner by the detail margin unless clipped by the level frame
  const m = detailMargin(level, true);
  ok(inner.x - region.x === Math.min(m, inner.x) && inner.y - region.y === Math.min(m, inner.y)
     && region.x + region.w - (inner.x + inner.w) === Math.min(m, lf.fw - inner.x - inner.w)
     && region.y + region.h - (inner.y + inner.h) === Math.min(m, lf.fh - inner.y - inner.h), `${tag}: the detail margin (${m}) or the frame edge`);
  // the unrotated roi is exactly the image of the region (all four corners and random px), inside the held area
  ok(roi.w === region.w * (geom.turns % 2 ? 0 : 1) + (geom.turns % 2 ? region.h : 0) && roi.h === (geom.turns % 2 ? region.w : region.h),
     `${tag}: roi size ${roi.w}x${roi.h} for region ${region.w}x${region.h}`);
  let inRoi = true;
  const pts = [[0, 0], [region.w - 1, 0], [0, region.h - 1], [region.w - 1, region.h - 1]];
  for (let i = 0; i < 20; i++) pts.push([Math.floor(rnd() * region.w), Math.floor(rnd() * region.h)]);
  for (const [x, y] of pts) {
    const [ux, uy] = toUnrotated(geom.turns, lf.ufw, lf.ufh, region.x + x, region.y + y);
    if (ux < roi.x || uy < roi.y || ux >= roi.x + roi.w || uy >= roi.y + roi.h) inRoi = false;
  }
  ok(inRoi, `${tag}: every region px maps into the roi`);
  ok(roi.x >= 0 && roi.y >= 0 && roi.x + roi.w <= lf.ufw && roi.y + roi.h <= lf.ufh, `${tag}: roi inside the unrotated level frame`);
  ok(roi.x + roi.w <= hold[0] / lf.sensorPerLevel && roi.y + roi.h <= hold[1] / lf.sensorPerLevel, `${tag}: roi inside the held area`);
  ok(plan.lowRes && plan.lowRes.affine.length === 6, `${tag}: lowRes affine`);

  // ---- 2. simulated decoder: values = held-area coordinates (sensor px) * 2^-13 ----
  const cx = (u) => (level === 1 ? u + 0.5 : 2 * u + 1);   // the centre of level px u in held sensor px (Z2 conventions)
  const rgb = new Float32Array(roi.w * roi.h * 3);
  for (let y = 0; y < roi.h; y++) for (let x = 0; x < roi.w; x++) {
    const o = (y * roi.w + x) * 3;
    rgb[o] = cx(roi.x + x) * SC; rgb[o + 1] = cx(roi.y + y) * SC; rgb[o + 2] = 0;
  }
  const reg = rotateRegion(rgb, roi, region, plan.turns, plan.ufw, plan.ufh, null);
  // the main frame develop would make: unrotated px (i, j) is the mean of k x k half px: centre 2k (i + 0.5); then np.rot90
  const k = geom.k;
  const uMain = { w: geom.sw, h: geom.sh };
  const fx = { w: uMain.w, h: uMain.h, a: new Float64Array(uMain.w * uMain.h) }, fy = { w: uMain.w, h: uMain.h, a: new Float64Array(uMain.w * uMain.h) };
  for (let j = 0; j < uMain.h; j++) for (let i = 0; i < uMain.w; i++) { fx.a[j * uMain.w + i] = 2 * k * (i + 0.5) * SC; fy.a[j * uMain.w + i] = 2 * k * (j + 0.5) * SC; }
  const mx = rotN(fx, geom.turns), my = rotN(fy, geom.turns);
  ok(mx.w === geom.w && mx.h === geom.h, `${tag}: the rotated main frame has the decoded size`);
  const [a, b, c, d, e, f] = plan.lowRes.affine;
  let worst = 0, n = 0;
  for (let t = 0; t < 400; t++) {
    const X = Math.floor(rnd() * region.w), Y = Math.floor(rnd() * region.h);
    // region px centre -> the main frame's continuous coordinate by the affine (renderRegion's lowRes contract)
    const mxc = a * (X + 0.5) + b * (Y + 0.5) + c, myc = d * (X + 0.5) + e * (Y + 0.5) + f;
    const sx = sample(mx, mxc, myc), sy = sample(my, mxc, myc);
    if (sx === null) continue;                                  // within half a main px of the frame border
    const ex = Math.abs(sx - reg[(Y * region.w + X) * 3]) / SC, ey = Math.abs(sy - reg[(Y * region.w + X) * 3 + 1]) / SC;
    worst = Math.max(worst, ex, ey); n++;
  }
  ok(worst <= TOL_POS, `${tag}: ROI source position vs the stretched frame, ${n} px, worst ${worst.toExponential(2)} sensor px (tol ${TOL_POS})`);
  // the drawing position: layer px p (centre p + 0.5) of the crop lands at frame (inner.x + p + 0.5) / s = the affine of the region px
  let dw = 0;
  for (let t = 0; t < 50; t++) {
    const px = Math.floor(rnd() * crop.w), py = Math.floor(rnd() * crop.h);
    const drawX = plan.rect.x + (px + 0.5) * plan.rect.w / crop.w, drawY = plan.rect.y + (py + 0.5) * plan.rect.h / crop.h;
    const X = crop.x + px, Y = crop.y + py;
    dw = Math.max(dw, Math.abs(drawX - (a * (X + 0.5) + b * (Y + 0.5) + c)), Math.abs(drawY - (d * (X + 0.5) + e * (Y + 0.5) + f)));
  }
  ok(dw <= 1e-9, `${tag}: layer drawing position = the lowRes affine (${dw.toExponential(1)} frame px)`);
}

let nPlans = 0;
for (const [orientation, turns] of ORIENTATIONS) {
  for (const k of [1, 2, 3]) {
    for (const [w0, h0] of [[1512, 1008], [301, 203], [64, 48]]) {
      // the decoded frame in the decoder's orientation; w0 x h0 is the unrotated size
      const odd = turns % 2 === 1;
      const geom = frameGeometry({ w: odd ? h0 : w0, h: odd ? w0 : h0, k, orientation });
      ok(geom.turns === turns && geom.sw === w0 && geom.sh === h0, `geometry o${orientation} k${k} ${w0}x${h0}`);
      // the held area is larger than the floored decoded size by 0..2k*... sensor px (develop floors), even sizes
      const extra = [0, 2, 2 * (2 * k - 1)];
      for (const ex of extra) for (const level of [1, 2]) {
        const hold = [geom.sw * 2 * k + ex, geom.sh * 2 * k + (ex ? 2 : 0)];
        const FW = geom.w, FH = geom.h;
        const rects = [
          { x: 0, y: 0, w: FW, h: FH },                                          // the whole frame
          { x: 0, y: 0, w: FW / 7, h: FH / 7 },                                  // top-left corner
          { x: FW - FW / 7, y: FH - FH / 7, w: FW / 7, h: FH / 7 },              // bottom-right corner
          { x: FW - FW / 9, y: FH / 3, w: FW / 9, h: FH / 5 },                   // right edge
          { x: FW / 3, y: 0, w: FW / 5, h: FH / 9 },                             // top edge
          { x: FW * 0.31, y: FH * 0.27, w: FW * 0.13, h: FH * 0.11 },            // interior
          { x: FW / 2, y: FH / 2, w: Math.min(FW, 3) / 3, h: Math.min(FH, 3) / 3 },   // ~1 px
        ];
        for (const [ri, rect] of rects.entries()) {
          const plan = planEditorRegion({ geom, level, rect, hold });
          const tag = `o${orientation} k${k} ${w0}x${h0} hold+${ex} L${level} rect${ri}`;
          if (plan.empty || plan.tooLarge) {
            // only a rectangle whose level-px area is over the caps may be refused
            const sLv = levelFrame(geom, level).s;
            ok(plan.tooLarge && rect.w * rect.h * sLv * sLv > 0.9 * ROI_HARD_MAX_PX, `${tag}: no plan (${JSON.stringify(plan)}) only when over the cap`);
            continue;
          }
          nPlans++;
          checkPlan(tag, geom, level, rect, hold, plan);
        }
      }
    }
  }
}
console.log(`plans checked: ${nPlans}`);

// ---------- guards ----------
{
  const geom = frameGeometry({ w: 1512, h: 1008, k: 2, orientation: 1 });
  const rect = { x: 100, y: 100, w: 300, h: 200 };
  const lf2 = levelFrame(geom, 2);
  ok(!planEditorRegion({ geom, level: 2, rect, hold: [3024, 2016] }).tooLarge, "guard: a hold exactly the level frame is fine");
  ok(planEditorRegion({ geom, level: 2, rect: { x: 1300, y: 800, w: 212, h: 208 }, hold: [3024 - 2, 2016] }).tooLarge,
     "guard: a hold smaller than the level frame at the edge -> tooLarge");
  ok(planEditorRegion({ geom, level: 1, rect, maxTex: 1000 }).tooLarge, "guard: maxTex");
  ok(planEditorRegion({ geom, level: 2, rect: { x: 5, y: 5, w: 0, h: 10 } }).empty, "guard: an empty rectangle");
  // the whole 24 MP frame: level 1 is over the hard cap, level 2 (6.1 MP) only unpadded
  const whole = { x: 0, y: 0, w: 1512, h: 1008 };
  ok(planEditorRegion({ geom, level: 1, rect: whole }).tooLarge, "caps: the whole frame at level 1 is too large");
  const l2 = planEditorRegion({ geom, level: 2, rect: whole });
  ok(!l2.tooLarge && l2.pad === 0 && l2.px <= ROI_HARD_MAX_PX && lf2.fw * lf2.fh > ROI_MAX_PX, "caps: the whole frame at level 2 takes pad 0 (hard cap)");
  // a view of about 1/4 of the frame at level 1: the pad shrinks until it fits 5 MP
  const q = planEditorRegion({ geom, level: 1, rect: { x: 400, y: 300, w: 400, h: 300 } });
  ok(!q.tooLarge && q.pad === 0.25 && q.px <= ROI_MAX_PX, `caps: 400x300 frame px at level 1: pad ${q.pad}, ${(q.px / 1e6).toFixed(2)} MP`);
  const q2 = planEditorRegion({ geom, level: 1, rect: { x: 300, y: 200, w: 600, h: 400 } });
  ok(!q2.tooLarge && q2.pad < 0.25 && q2.px <= ROI_HARD_MAX_PX, `caps: 600x400 at level 1 loses the pad (${q2.pad}) and fits ${(q2.px / 1e6).toFixed(2)} MP`);
  // the floored decoded size: a decoded 1512x1008 on a held 6048-8 -> 6040 sensor px wide would be 755 decoded px at k=4;
  // here: the last decoded px's region ends at the level frame, short of the held area
  const g2 = frameGeometry({ w: 1000, h: 700, k: 3, orientation: 1 });
  const edge = planEditorRegion({ geom: g2, level: 1, rect: { x: 900, y: 600, w: 100, h: 100 }, hold: [1000 * 6 + 4, 700 * 6 + 2] });
  ok(edge.inner.x + edge.inner.w === 6000 && edge.roi.x + edge.roi.w === 6000, "floored size: the roi ends at the level frame (6000), not the held area (6004)");
}

// ---------- 3. readout factor, thresholds, view math ----------
{
  const geom = frameGeometry({ w: 1512, h: 1008, k: 2, orientation: 1 });
  ok(editorSensorPerFrame(geom) === 4, "readout: sensor px per frame px = 2k");
  for (const dpr of [1, 1.25, 2, 3]) for (const base of [0.4, 0.6, 1.1]) {
    const sc100 = editorScaleForPercent(geom, base, dpr, 1);
    // 100%: one sensor px (= 1/4 frame px) per device px: base * scale CSS px per frame px * dpr device px per CSS px = 4
    ok(near(base * sc100 * dpr, 4, 1e-12) && near(editorPercent(geom, base, dpr, sc100), 1, 1e-12),
       `readout: dpr ${dpr} base ${base}: scale for 100% = ${sc100.toFixed(3)} (4 device px per frame px)`);
    ok(near(editorPercent(geom, base, dpr, editorScaleForPercent(geom, base, dpr, 4)), 4, 1e-12), "readout: 400% round trip");
  }
  // an example: Z f frame 1512 px shown at 900 CSS px, dpr 1: fit = 900 / 6048 = 14.9%
  ok(near(editorPercent(geom, 900 / 1512, 1, 1), 900 / 6048, 1e-12), "readout: the fit percent of a 900 px view");
  ok(pickLevel({ percent: 0.29, scale: 2 }) === 0 && pickLevel({ percent: LEVEL2_FROM, scale: 2 }) === 2
     && pickLevel({ percent: 0.74, scale: 3 }) === 2 && pickLevel({ percent: LEVEL1_FROM, scale: 3 }) === 1
     && pickLevel({ percent: 0.9, scale: 3, level1: false }) === 2 && pickLevel({ percent: 1, scale: 1 }) === 0, "levels: thresholds");
  // view math: the image point under the cursor stays under it; the visible rectangle inverts the drawing transform
  const vp = { x: 0, y: 0, w: 900, h: 600 }, base = 900 / 1512, W = 1512, H = 1008;
  let view = { scale: 1, x: 0, y: 0 };
  const pointAt = (v, mx, my) => {   // the frame point drawn at the box point (mx, my): draw transform of lib/editor-zoom.js
    const s = base * v.scale;
    return [(mx - (vp.w - s * W) / 2 - v.x) / s, (my - (vp.h - s * H) / 2 - v.y) / s];
  };
  for (let i = 0; i < 200; i++) {
    const mx = rnd() * vp.w, my = rnd() * vp.h, next = 1 + rnd() * 20;
    const p0 = pointAt(view, mx, my);
    const z = zoomViewAt(view, next, mx, my, vp, base);
    const p1 = pointAt(z, mx, my);
    ok(near(p0[0], p1[0], 1e-9) && near(p0[1], p1[1], 1e-9), "view: zoom keeps the point under the cursor");
    const c = clampPan(z, vp, base * z.scale, W, H);
    const ex = Math.max(0, (base * z.scale * W - vp.w) / 2), ey = Math.max(0, (base * z.scale * H - vp.h) / 2);
    ok(Math.abs(c.x) <= ex + 1e-9 && Math.abs(c.y) <= ey + 1e-9, "view: the clamped pan stays inside the image");
    const vr = visibleRect(vp, { ...z, ...c }, base * z.scale, W, H);
    const tl = pointAt({ ...z, ...c }, 0, 0), br = pointAt({ ...z, ...c }, vp.w, vp.h);
    ok(vr && near(vr.x, Math.max(0, tl[0]), 1e-9) && near(vr.x + vr.w, Math.min(W, br[0]), 1e-9)
       && near(vr.y, Math.max(0, tl[1]), 1e-9) && near(vr.y + vr.h, Math.min(H, br[1]), 1e-9), "view: visibleRect = the inverse of the drawing transform");
    view = i % 7 === 0 ? { scale: 1, x: 0, y: 0 } : { ...z, ...c };
  }
  const c0 = clampPan({ x: 500, y: -500 }, vp, base * 1, W, H);   // the fit: the image fits the viewport on one axis (aspect) -> pan 0 there
  ok(c0.x === 0 && c0.y === 0, "view: no pan at the fit");
  // pad contract used by the plan
  ok(ROI_PAD[0] === 0.25 && ROI_PAD[ROI_PAD.length - 1] === 0, "constants: the pads are Compare's");
}

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
