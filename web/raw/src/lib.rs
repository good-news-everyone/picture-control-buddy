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
