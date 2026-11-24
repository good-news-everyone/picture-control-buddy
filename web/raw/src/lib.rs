//! Линейная проявка NEF и DNG в браузере: то же, что rawdev.develop + render.linear без виньетирования.
//!
//! Пара в Python: rawdev.develop, render.linear, render.orientation, devpairs.MX/MY/shrink.
//! Политика изменений и тесты: spec/web-tests.md.
//!
//! Повторяет `dcraw_emu -w -o 0 -4 -h -t 0`: половинный размер (блок 2×2, зелёные усредняются),
//! вычитание чёрного, баланс белого из файла (min = 1), масштаб к 16 битам с отсечением.
//! Затем поля MY, MX, уменьшение блоком k и поворот по тегу Orientation.
//! Для NEF белый 16383 (полные 14 бит), как у LibRaw; rawler даёт 15892.
//!
//! ABI без wasm-bindgen: alloc → копия файла → develop → width/height/data/info.

use rawler::{RawImageData, decoders::RawDecodeParams, rawsource::RawSource};
use std::sync::Mutex;

const MY: usize = 2;
const MX: usize = 4;
const NEF_WHITE: f32 = 16383.0;

struct Out {
    w: usize,
    h: usize,
    rgb: Vec<f32>,
    info: String,
}

static OUT: Mutex<Out> = Mutex::new(Out { w: 0, h: 0, rgb: Vec::new(), info: String::new() });

#[unsafe(no_mangle)]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Первый IFD TIFF: (Orientation, есть ли DNGVersion).
fn tiff_head(b: &[u8]) -> (u16, bool) {
    if b.len() < 8 {
        return (1, false);
    }
    let le = &b[..2] == b"II";
    let u16_at = |o: usize| -> u16 {
        if o + 2 > b.len() { return 0 }
        if le { u16::from_le_bytes([b[o], b[o + 1]]) } else { u16::from_be_bytes([b[o], b[o + 1]]) }
    };
    let u32_at = |o: usize| -> u32 {
        if o + 4 > b.len() { return 0 }
        let a = [b[o], b[o + 1], b[o + 2], b[o + 3]];
        if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) }
    };
    let ifd = u32_at(4) as usize;
    let n = u16_at(ifd) as usize;
    let (mut orient, mut dng) = (1, false);
    for i in 0..n {
        let e = ifd + 2 + 12 * i;
        match u16_at(e) {
            0x0112 => orient = u16_at(e + 8),
            0xC612 => dng = true,
            _ => {}
        }
    }
    (orient, dng)
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// long — наибольшая сторона результата: уменьшение целым шагом k = ⌈сторона/long⌉, как в render.linear;
/// 0 — без уменьшения.
/// Возвращает 1 при успехе, 0 при ошибке. Ошибка в info: код для интерфейса (переводится там)
/// и detail от rawler: nef_high_efficiency, not_bayer, decode_failed.
#[unsafe(no_mangle)]
pub extern "C" fn develop(ptr: *mut u8, n: usize, long: usize) -> u32 {
    let bytes = unsafe { Vec::from_raw_parts(ptr, n, n) };
    let (orient, is_dng) = tiff_head(&bytes);
    let src = RawSource::new_from_shared_vec(std::sync::Arc::new(bytes));
    let mut out = OUT.lock().unwrap();
    *out = Out { w: 0, h: 0, rgb: Vec::new(), info: String::new() };
    let img = match rawler::decode(&src, &RawDecodeParams::default()) {
        Ok(img) => img,
        Err(e) => {
            let detail = format!("{e:?}");
            let code = if detail.contains("HighEfficency") { "nef_high_efficiency" } else { "decode_failed" };
            out.info = format!("{{\"error\":\"{code}\",\"detail\":\"{}\"}}", esc(&detail));
            return 0;
        }
    };
    let data = match (&img.data, img.cpp) {
        (RawImageData::Integer(v), 1) if img.camera.cfa.is_rgb() => v,
        _ => {
            out.info = "{\"error\":\"not_bayer\",\"detail\":\"linear or float DNG\"}".into();
            return 0;
        }
    };
    let (w, h) = (img.width, img.height);
    let cfa = &img.camera.cfa;
    let black = img.blacklevel.as_bayer_array();
    let bdim = (img.blacklevel.width.max(1), img.blacklevel.height.max(1));
    let white = if is_dng { img.whitelevel.as_bayer_array()[0] } else { NEF_WHITE };
    let wb3 = [img.wb_coeffs[0], img.wb_coeffs[1], img.wb_coeffs[2]];
    let wmin = wb3.iter().cloned().fold(f32::INFINITY, f32::min);
    let wb = wb3.map(|x| x / wmin);

    // половинный размер: цвет пикселя мозаики → его канал в блоке 2×2
    let (hw, hh) = (w / 2, h / 2);
    let mut half = vec![0f32; hw * hh * 3];
    let mut greens = vec![0f32; hw * hh];
    for y in 0..hh * 2 {
        for x in 0..hw * 2 {
            let c = cfa.color_at(y, x);
            let b = black[(y % bdim.1) * bdim.0 + (x % bdim.0)];
            let s = 65535.0 / (white - b);
            let v = ((data[y * w + x] as f32 - b).max(0.0) * wb[c.min(2)] * s).floor().min(65535.0);
            let o = (y / 2) * hw + x / 2;
            if c == 1 {
                greens[o] += v;
            } else {
                half[o * 3 + c.min(2)] = v;
            }
        }
    }
    for o in 0..hw * hh {
        half[o * 3 + 1] = (greens[o] / 2.0).floor();
    }

    // поля и уменьшение блоком k
    let (cw, ch) = (hw - 2 * MX, hh - 2 * MY);
    let k = if long == 0 { 1 } else { cw.max(ch).div_ceil(long) };
    let (sw, sh) = (cw / k, ch / k);
    let mut small = vec![0f32; sw * sh * 3];
    let norm = 1.0 / (65535.0 * (k * k) as f32);
    for y in 0..sh * k {
        for x in 0..sw * k {
            let src = ((y + MY) * hw + x + MX) * 3;
            let dst = ((y / k) * sw + x / k) * 3;
            for c in 0..3 {
                small[dst + c] += half[src + c];
            }
        }
    }
    small.iter_mut().for_each(|v| *v *= norm);

    // поворот как np.rot90(a, turns): против часовой
    let turns = match orient { 3 => 2, 6 => 3, 8 => 1, _ => 0 };
    let (ow, oh) = if turns % 2 == 1 { (sh, sw) } else { (sw, sh) };
    let mut rgb = vec![0f32; ow * oh * 3];
    for y in 0..oh {
        for x in 0..ow {
            let (sy, sx) = match turns {
                1 => (x, sw - 1 - y),
                2 => (sh - 1 - y, sw - 1 - x),
                3 => (sh - 1 - x, y),
                _ => (y, x),
            };
            let s = (sy * sw + sx) * 3;
            let d = (y * ow + x) * 3;
            rgb[d..d + 3].copy_from_slice(&small[s..s + 3]);
        }
    }

    out.info = format!(
        "{{\"make\":\"{}\",\"model\":\"{}\",\"dng\":{},\"sensor\":[{},{}],\"wb\":[{},{},{}],\"black\":{},\"white\":{},\"orientation\":{},\"k\":{}}}",
        esc(&img.clean_make), esc(&img.clean_model), is_dng, w, h, wb[0], wb[1], wb[2], black[0], white, orient, k
    );
    out.w = ow;
    out.h = oh;
    out.rgb = rgb;
    1
}

// ---------------------------------------------------------------------------------------------
// Zoom support (plan: spec/ui-zoom-plan.md, stage Z2): hold the mosaic, develop rectangles of it.
//
// `hold` keeps the margin-cropped mosaic as u16 values ALREADY normalized exactly like `develop`
// does per mosaic pixel (black per CFA position, white balance, scale to 16 bits, floor, clamp), so
// every sample is an integer 0..65535 and a rectangle can be developed later without the RAW's
// black/white/WB numbers. 2 bytes per sensor pixel (~49 MB for 24 MP). The input bytes and rawler's
// RawImage are not kept.
//
// Coordinate convention (the "held area" is the sensor minus the margins, W = 2*(w/2 - 2*MX),
// H = 2*(h/2 - 2*MY); the margins in sensor px are 2*MX = 8 and 2*MY = 4, both even, so the CFA phase
// of the held area equals the sensor's). Output is never rotated (sensor orientation), rows top-down.
//   level 1: full sensor resolution. Full px (X, Y), 0 <= X < W, 0 <= Y < H, has its centre at sensor
//            (2*MX + X + 0.5, 2*MY + Y + 0.5). Demosaiced with PPG (see below).
//   level 2: half resolution, the superpixel arithmetic of `develop` (R, floor(mean G), B of every
//            2x2 block). Half px (u, v), 0 <= u < W/2, 0 <= v < H/2 covers full px [2u, 2u+2) x
//            [2v, 2v+2) of the same held area: half coordinates * 2 = full coordinates (edge-aligned).
//            The whole level-2 area equals `develop(long = 0)` before its rotation, bit for bit.
// Units of both levels: 0..1, `value / 65535`.
//
// Level 1 uses a port of rawler's PPG demosaic (rawler::imgop::sensor::bayer::ppg) rather than
// calling it: rawler's PPGDemosaic::demosaic calls std::time::Instant::now() (panics on
// wasm32-unknown-unknown, and panic = abort) and uses rayon. The port is the same arithmetic,
// sequential and without timing, and is tested bit-exact against rawler's PPGDemosaic natively.
// Pixels at least 4 px away from the edge of the demosaiced window do not depend on the window, so
// `roi` demosaics the rectangle plus ZMARGIN px on each side (clipped to the held area).

const ZMARGIN: usize = 8;
const NORM: f32 = 1.0 / 65535.0;

struct Held {
    w: usize,
    h: usize,
    mosaic: Vec<u16>,
    /// channel (0 R, 1 G, 2 B) at (y & 1, x & 1) of the held area
    ph: [[u8; 2]; 2],
}

static HELD: Mutex<Option<Held>> = Mutex::new(None);

fn fail(out: &mut Out, code: &str, detail: &str) -> u32 {
    out.info = format!("{{\"error\":\"{code}\",\"detail\":\"{}\"}}", esc(detail));
    0
}

/// Decodes like `develop` and keeps the margin-cropped normalized mosaic. Returns 1 / 0; info is the
/// same JSON as `develop`'s plus "held":[W,H], "margin":[2*MX,2*MY], "cfa":"RGGB", "orientation".
/// Replaces any previous hold (also on failure: a failed hold leaves nothing held).
#[unsafe(no_mangle)]
pub extern "C" fn hold(ptr: *mut u8, n: usize) -> u32 {
    let bytes = unsafe { Vec::from_raw_parts(ptr, n, n) };
    let (orient, is_dng) = tiff_head(&bytes);
    let src = RawSource::new_from_shared_vec(std::sync::Arc::new(bytes));
    let mut out = OUT.lock().unwrap();
    *out = Out { w: 0, h: 0, rgb: Vec::new(), info: String::new() };
    let mut held = HELD.lock().unwrap();
    *held = None;
    let img = match rawler::decode(&src, &RawDecodeParams::default()) {
        Ok(img) => img,
        Err(e) => {
            let detail = format!("{e:?}");
            let code = if detail.contains("HighEfficency") { "nef_high_efficiency" } else { "decode_failed" };
            return fail(&mut out, code, &detail);
        }
    };
    drop(src);
    let cfa = img.camera.cfa.clone();
    let is_int = matches!(img.data, RawImageData::Integer(_));
    if !(is_int && img.cpp == 1 && cfa.is_rgb() && cfa.width == 2 && cfa.height == 2) {
        return fail(&mut out, "not_bayer", "linear or float DNG");
    }
    let (w, h) = (img.width, img.height);
    let black = img.blacklevel.as_bayer_array();
    let bdim = (img.blacklevel.width.max(1), img.blacklevel.height.max(1));
    let white = if is_dng { img.whitelevel.as_bayer_array()[0] } else { NEF_WHITE };
    let wb3 = [img.wb_coeffs[0], img.wb_coeffs[1], img.wb_coeffs[2]];
    let wmin = wb3.iter().cloned().fold(f32::INFINITY, f32::min);
    let wb = wb3.map(|x| x / wmin);
    let mut ph = [[0u8; 2]; 2];
    let mut counts = [0usize; 3];
    for y in 0..2 {
        for x in 0..2 {
            let c = cfa.color_at(y, x);
            if c > 2 { return fail(&mut out, "not_bayer", "unexpected CFA colour"); }
            ph[y][x] = c as u8;
            counts[c] += 1;
        }
    }
    if counts != [1, 2, 1] || bdim.0 > 2 || bdim.1 > 2 || w < 2 * (2 * MX + 4) || h < 2 * (2 * MY + 4) {
        return fail(&mut out, "not_bayer", "unsupported CFA or black level layout");
    }
    let mut data = match img.data {
        RawImageData::Integer(v) => v,
        _ => unreachable!(),
    };
    let (clean_make, clean_model) = (img.clean_make, img.clean_model);

    // normalize in place: the arithmetic of `develop`, per mosaic pixel, per CFA phase
    let (hw, hh) = (w / 2, h / 2);
    let mut cst = [[(0f32, 0f32, 0f32); 2]; 2];   // (black, scale, wb) at (y & 1, x & 1)
    for y in 0..2 {
        for x in 0..2 {
            let b = black[(y % bdim.1) * bdim.0 + (x % bdim.0)];
            cst[y][x] = (b, 65535.0 / (white - b), wb[ph[y][x] as usize]);
        }
    }
    let (cw, ch) = (hw - 2 * MX, hh - 2 * MY);
    let (hold_w, hold_h) = (cw * 2, ch * 2);
    let (x0, y0) = (2 * MX, 2 * MY);
    for r in 0..hold_h {
        let sy = r + y0;
        let src = sy * w + x0;
        for c in 0..hold_w {
            let (b, s, k) = cst[sy & 1][(c + x0) & 1];
            data[r * hold_w + c] = ((data[src + c] as f32 - b).max(0.0) * k * s).floor().min(65535.0) as u16;
        }
    }
    // rows are compacted forward (destination never passes the source), so this is safe in place
    data.truncate(hold_w * hold_h);
    data.shrink_to_fit();

    out.info = format!(
        "{{\"make\":\"{}\",\"model\":\"{}\",\"dng\":{},\"sensor\":[{},{}],\"wb\":[{},{},{}],\"black\":{},\"white\":{},\"orientation\":{},\"held\":[{},{}],\"margin\":[{},{}],\"cfa\":\"{}\"}}",
        esc(&clean_make), esc(&clean_model), is_dng, w, h, wb[0], wb[1], wb[2], black[0], white, orient,
        hold_w, hold_h, x0, y0,
        [ph[0][0], ph[0][1], ph[1][0], ph[1][1]].iter().map(|&c| ["R", "G", "B"][c as usize]).collect::<String>()
    );
    *held = Some(Held { w: hold_w, h: hold_h, mosaic: data, ph });
    1
}

/// Native tests only: installs a held mosaic directly.
#[doc(hidden)]
pub fn set_hold_for_test(w: usize, h: usize, mosaic: Vec<u16>, ph: [[u8; 2]; 2]) {
    *HELD.lock().unwrap() = Some(Held { w, h, mosaic, ph });
}

/// Drops the hold and the last result.
#[unsafe(no_mangle)]
pub extern "C" fn release() {
    let mut out = OUT.lock().unwrap();
    *out = Out { w: 0, h: 0, rgb: Vec::new(), info: String::new() };
    *HELD.lock().unwrap() = None;
}

/// Float RGB of a rectangle of the held area (see the convention above): level 2 half resolution
/// (coordinates in half px), level 1 full resolution (PPG). Returns 1 / 0; on success the result is
/// read through width/height/data (interleaved RGB, unrotated, rows top-down) and info is
/// {"x","y","w","h","level"}; on failure info is {"error": no_hold | bad_level | roi_bounds, ...}.
#[unsafe(no_mangle)]
pub extern "C" fn roi(x: u32, y: u32, w: u32, h: u32, level: u32) -> u32 {
    let mut out = OUT.lock().unwrap();
    out.w = 0;
    out.h = 0;
    out.rgb = Vec::new();
    let held = HELD.lock().unwrap();
    let Some(hd) = held.as_ref() else { return fail(&mut out, "no_hold", "hold() first") };
    let (x, y, w, h) = (x as usize, y as usize, w as usize, h as usize);
    let (lw, lh) = match level {
        1 => (hd.w, hd.h),
        2 => (hd.w / 2, hd.h / 2),
        _ => return fail(&mut out, "bad_level", &format!("level {level}")),
    };
    if w == 0 || h == 0 || x.checked_add(w).is_none_or(|e| e > lw) || y.checked_add(h).is_none_or(|e| e > lh) {
        return fail(&mut out, "roi_bounds", &format!("{x},{y} {w}x{h} outside {lw}x{lh}"));
    }
    let rgb = if level == 2 { roi_half(hd, x, y, w, h) } else { roi_full(hd, x, y, w, h) };
    out.info = format!("{{\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h},\"level\":{level}}}");
    out.w = w;
    out.h = h;
    out.rgb = rgb;
    1
}

/// Superpixel arithmetic of `develop` for the half-pixel rectangle.
fn roi_half(hd: &Held, x: usize, y: usize, w: usize, h: usize) -> Vec<f32> {
    let mut rgb = vec![0f32; w * h * 3];
    for v in 0..h {
        for u in 0..w {
            let (sx, sy) = (2 * (x + u), 2 * (y + v));
            let mut px = [0f32; 3];
            let mut g = 0f32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let val = hd.mosaic[(sy + dy) * hd.w + sx + dx] as f32;
                    let c = hd.ph[dy][dx] as usize;   // sx, sy are even
                    if c == 1 { g += val } else { px[c] = val }
                }
            }
            px[1] = (g / 2.0).floor();
            let o = (v * w + u) * 3;
            for c in 0..3 {
                rgb[o + c] = px[c] * NORM;
            }
        }
    }
    rgb
}

/// PPG demosaic of the rectangle plus ZMARGIN px around it (clipped to the held area).
fn roi_full(hd: &Held, x: usize, y: usize, w: usize, h: usize) -> Vec<f32> {
    let (wx0, wy0) = (x.saturating_sub(ZMARGIN), y.saturating_sub(ZMARGIN));
    let (wx1, wy1) = ((x + w + ZMARGIN).min(hd.w), (y + h + ZMARGIN).min(hd.h));
    let (ww, wh) = (wx1 - wx0, wy1 - wy0);
    let mut ph = [[0u8; 2]; 2];
    for r in 0..2 {
        for c in 0..2 {
            ph[r][c] = hd.ph[(r + wy0) & 1][(c + wx0) & 1];
        }
    }
    let mut win = vec![[0f32; 3]; ww * wh];
    for r in 0..wh {
        let row = &hd.mosaic[(wy0 + r) * hd.w + wx0..][..ww];
        for (c, &v) in row.iter().enumerate() {
            win[r * ww + c][ph[r & 1][c & 1] as usize] = v as f32;
        }
    }
    if ww >= 7 && wh >= 7 {
        ppg(&mut win, ww, wh, &ph);
    } else {
        bilinear_small(&mut win, ww, wh, &ph);
    }
    let mut rgb = vec![0f32; w * h * 3];
    for r in 0..h {
        for c in 0..w {
            let p = win[(y - wy0 + r) * ww + (x - wx0 + c)];
            let o = (r * w + c) * 3;
            for k in 0..3 {
                rgb[o + k] = p[k].clamp(0.0, 65535.0) * NORM;
            }
        }
    }
    rgb
}

/// Windows under 7 px (a held area that small does not occur) cannot run PPG's interior passes:
/// the border rule (mean of the known neighbours) is applied everywhere.
fn bilinear_small(img: &mut [[f32; 3]], w: usize, h: usize, ph: &[[u8; 2]; 2]) {
    ppg_borders(img, w, h, ph, true);
}

fn ppg_borders(img: &mut [[f32; 3]], w: usize, h: usize, ph: &[[u8; 2]; 2], all: bool) {
    let col_at = |r: usize, c: usize| ph[r & 1][c & 1] as usize;
    for row in 0..h {
        let mut col = 0;
        while col < w {
            if !all && col == 3 && row >= 3 && row < h - 3 {
                col = w - 3;   // go to the right border
            }
            let mut sum = [(0f32, 0usize); 3];
            for yy in row.saturating_sub(1)..=row + 1 {
                for xx in col.saturating_sub(1)..=col + 1 {
                    if yy < h && xx < w {
                        let ch = col_at(yy, xx);
                        sum[ch].0 += img[yy * w + xx][ch];
                        sum[ch].1 += 1;
                    }
                }
            }
            let ch = col_at(row, col);
            for color in 0..3 {
                if color != ch && sum[color].1 > 0 {
                    img[row * w + col][color] = sum[color].0 / sum[color].1 as f32;
                }
            }
            col += 1;
        }
    }
}

fn hue_transit(l1: f32, l2: f32, l3: f32, v1: f32, v3: f32) -> f32 {
    if (l1 < l2 && l2 < l3) || (l1 > l2 && l2 > l3) {
        v1 + (v3 - v1) * (l2 - l1) / (l3 - l1)
    } else {
        (v1 + v3) / 2.0 + (l2 * 2.0 - l1 - l3) / 4.0
    }
}

/// Patterned Pixel Grouping (Chuan-kai Lin), the same passes and arithmetic as rawler 0.8's PPG,
/// in place and sequential. Requires w, h >= 7. `img` holds the mosaic samples in their own channel.
fn ppg(img: &mut [[f32; 3]], w: usize, h: usize, ph: &[[u8; 2]; 2]) {
    const G: usize = 1;
    let col_at = |r: usize, c: usize| ph[r & 1][c & 1] as usize;
    ppg_borders(img, w, h, ph, false);
    let at = |img: &[[f32; 3]], r: usize, c: usize| img[r * w + c];
    // green at red / blue
    for row in 3..h - 3 {
        for col in 3..w - 3 {
            let ch = col_at(row, col);
            if ch == G { continue }
            let x = img[row * w + col][ch];
            let n_1 = at(img, row - 1, col)[G];
            let n_2 = at(img, row - 2, col)[ch];
            let e_1 = at(img, row, col + 1)[G];
            let e_2 = at(img, row, col + 2)[ch];
            let s_1 = at(img, row + 1, col)[G];
            let s_2 = at(img, row + 2, col)[ch];
            let w_1 = at(img, row, col - 1)[G];
            let w_2 = at(img, row, col - 2)[ch];
            let n = (x - n_2).abs() * 2.0 + (n_1 - s_1).abs();
            let e = (x - e_2).abs() * 2.0 + (w_1 - e_1).abs();
            let wg = (x - w_2).abs() * 2.0 + (w_1 - e_1).abs();
            let s = (x - s_2).abs() * 2.0 + (n_1 - s_1).abs();
            let mut min = n;
            if e < min { min = e }
            if wg < min { min = wg }
            if s < min { min = s }
            img[row * w + col][G] = if min == n {
                (n_1 * 3.0 + s_1 + x - n_2) / 4.0
            } else if min == e {
                (e_1 * 3.0 + w_1 + x - e_2) / 4.0
            } else if min == wg {
                (w_1 * 3.0 + e_1 + x - w_2) / 4.0
            } else {
                (s_1 * 3.0 + n_1 + x - s_2) / 4.0
            };
        }
    }
    // red / blue at green
    for row in 3..h - 3 {
        for col in 3..w - 3 {
            if col_at(row, col) != G { continue }
            let h_ch = col_at(row, col + 1);
            let v_ch = col_at(row + 1, col);
            let g_x = img[row * w + col][G];
            let g_w = at(img, row, col - 1)[G];
            let g_e = at(img, row, col + 1)[G];
            let g_n = at(img, row - 1, col)[G];
            let g_s = at(img, row + 1, col)[G];
            let h_w = at(img, row, col - 1)[h_ch];
            let h_e = at(img, row, col + 1)[h_ch];
            let v_n = at(img, row - 1, col)[v_ch];
            let v_s = at(img, row + 1, col)[v_ch];
            img[row * w + col][h_ch] = hue_transit(g_w, g_x, g_e, h_w, h_e);
            img[row * w + col][v_ch] = hue_transit(g_n, g_x, g_s, v_n, v_s);
        }
    }
    // red / blue at blue / red
    for row in 3..h - 3 {
        for col in 3..w - 3 {
            let x_ch = col_at(row, col);
            if x_ch == G { continue }
            let y_ch = if x_ch == 0 { 2 } else { 0 };
            let y_ne_1 = at(img, row - 1, col + 1)[y_ch];
            let y_sw_1 = at(img, row + 1, col - 1)[y_ch];
            let x_ne_2 = at(img, row - 2, col + 2)[x_ch];
            let x_center = img[row * w + col][x_ch];
            let x_sw_2 = at(img, row + 2, col - 2)[x_ch];
            let g_ne_1 = at(img, row - 1, col + 1)[G];
            let g_center = img[row * w + col][G];
            let g_sw_1 = at(img, row + 1, col - 1)[G];
            let y_nw_1 = at(img, row - 1, col - 1)[y_ch];
            let y_se_1 = at(img, row + 1, col + 1)[y_ch];
            let x_nw_2 = at(img, row - 2, col - 2)[x_ch];
            let x_se_2 = at(img, row + 2, col + 2)[x_ch];
            let g_nw_1 = at(img, row - 1, col - 1)[G];
            let g_se_1 = at(img, row + 1, col + 1)[G];
            let ne = (y_ne_1 - y_sw_1).abs() + (x_ne_2 - x_center).abs() + (x_center - x_sw_2).abs() + (g_ne_1 - g_center).abs() + (g_center - g_sw_1).abs();
            let nw = (y_nw_1 - y_se_1).abs() + (x_nw_2 - x_center).abs() + (x_center - x_se_2).abs() + (g_nw_1 - g_center).abs() + (g_center - g_se_1).abs();
            img[row * w + col][y_ch] = if ne < nw {
                hue_transit(g_ne_1, g_center, g_sw_1, y_ne_1, y_sw_1)
            } else {
                hue_transit(g_nw_1, g_center, g_se_1, y_nw_1, y_se_1)
            };
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn width() -> usize { OUT.lock().unwrap().w }
#[unsafe(no_mangle)]
pub extern "C" fn height() -> usize { OUT.lock().unwrap().h }
#[unsafe(no_mangle)]
pub extern "C" fn data() -> *const f32 { OUT.lock().unwrap().rgb.as_ptr() }
#[unsafe(no_mangle)]
pub extern "C" fn info_ptr() -> *const u8 { OUT.lock().unwrap().info.as_ptr() }
#[unsafe(no_mangle)]
pub extern "C" fn info_len() -> usize { OUT.lock().unwrap().info.len() }
