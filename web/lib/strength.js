// Profile strength: new NP3s at a fraction of the way from neutral to the finished profile.
// Port of strength.scaled: blender, grading and sliders are multiplied by the fraction,
// the curve is blended with the identity line (linear interpolation of the stored table, as np.interp).
// Sharpening, Hue, Blending and Balance are not changed. Values above 100 strengthen the profile.
import { pyRound } from "./np3.js";

const SLIDERS = ["contrast", "highlights", "shadows", "white", "black", "saturation"];
const LIMIT = 100;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// as strength.scale: int(np.clip(round(v * k), -100, 100))
function scale(v, k) {
  return clamp(pyRound(v * k), -LIMIT, LIMIT);
}

// as np.interp(t, grid, table) with grid = linspace(0, 1, 257)
function interpTable(t, table) {
  const pos = clamp(t, 0, 1) * 256;
  const i = Math.min(255, Math.floor(pos));
  return table[i] + (table[i + 1] - table[i]) * (pos - i);
}

// as make_pack.curve_from: a table and 20 even points from a function f(t) -> 0..1
function curveFrom(f) {
  const raw = Array.from({ length: 257 }, (_, i) => pyRound(clamp(f(i / 256), 0, 1) * 32767));
  const points = Array.from({ length: 20 }, (_, i) => {
    const x = pyRound(i * 255 / 19);
    return [x, pyRound(clamp(f(x / 255), 0, 1) * 255)];
  });
  return { raw, points };
}

/** scaled(control, percent) -> a new Control. The source is not modified.
 *  Name: the base truncated to 19 ASCII chars, with a "-<percent>" suffix. */
export function scaled(c, percent) {
  const k = percent / 100;
  const label = `-${percent}`;
  const out = {
    ...c,
    name: c.name.slice(0, 19 - label.length) + label,
    blender: Object.fromEntries(Object.entries(c.blender).map(([n, v]) => [n, v.map((x) => scale(x, k))])),
    grade: Object.fromEntries(Object.entries(c.grade).map(([z, [hue, chroma, bright]]) =>
      [z, [hue, Math.min(LIMIT, Math.max(0, pyRound(chroma * k))), scale(bright, k)]])),
  };
  for (const s of SLIDERS) out[s] = scale(c[s], k);
  if (c.curve) {
    const table = c.curve.raw.map((v) => v / 32767);
    out.curve = curveFrom((t) => t + k * (interpTable(t, table) - t));
  }
  return out;
}
