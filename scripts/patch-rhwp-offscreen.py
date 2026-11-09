"""Apply the local typed OffscreenCanvas backend to a patched RHWP v0.8.7 checkout.

The DOM renderer remains unchanged. Generate the sibling from its implementation
so the drawing algorithms and equation renderer cannot drift independently.
"""
from pathlib import Path
import sys

root = Path(sys.argv[1])
def replace(text, old, new):
    assert old in text, old[:100]
    return text.replace(old, new)
def write(path, text):
    (root / path).write_text(text, encoding='utf-8', newline='\n')

p = root / 'src/renderer/web_canvas.rs'
s = p.read_text(encoding='utf-8')
s = s.replace('CanvasRenderingContext2d', 'OffscreenCanvasRenderingContext2d').replace('HtmlCanvasElement', 'OffscreenCanvas').replace('WebCanvasRenderer', 'OffscreenCanvasRenderer')
s = s.replace('html_canvas_element', 'offscreen_canvas').replace('super::equation::canvas_render::', 'super::equation::offscreen_render::')
start = s.index('// 이미지 캐시:')
end = s.index('/// 빠른 해시', start)
s = s[:start] + '''// Per-render resource cache: released before returning the bitmap.
#[cfg(target_arch = "wasm32")]
thread_local! {
    static DECODED_CANVAS_CACHE: std::cell::RefCell<std::collections::HashMap<u64, Option<OffscreenCanvas>>> = Default::default();
    static RESOURCE_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static RESOURCE_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub fn reset_resources() {
    DECODED_CANVAS_CACHE.with(|c| c.borrow_mut().clear());
    RESOURCE_FAILURE.with(|c| c.set(false));
    RESOURCE_BYTES.with(|c| c.set(0));
}
pub fn resources_failed() -> bool { RESOURCE_FAILURE.with(|c| c.get()) }

fn decode_image_to_canvas(data: &[u8]) -> Option<OffscreenCanvas> {
    // Only embedded bytes are decoded. No DOM, URL loader, or network resolver.
    let mime = detect_image_mime_type(data);
    let converted = match mime {
        "image/x-wmf" => super::svg::convert_wmf_to_svg(data),
        "image/x-emf" => crate::emf::convert_to_standalone_svg(data),
        "image/x-pcx" => super::image_resolver::pcx_bytes_to_png_bytes(data),
        "image/tiff" => super::image_resolver::tiff_bytes_to_png_bytes(data),
        "application/postscript" => super::image_resolver::eps_renderable_bytes(data).map(|(_, bytes)| bytes),
        _ => None,
    };
    let bytes = converted.as_deref().unwrap_or(data);
    let (buf, iw, ih) = if super::svg_fragment::is_svg_prefix(bytes) {
        let mut options = resvg_worker::usvg::Options::default();
        // Never resolve local paths from an imported SVG image.
        options.image_href_resolver.resolve_string = Box::new(|_, _| None);
        let tree = resvg_worker::usvg::Tree::from_data(bytes, &options).ok()?;
        // Without a supplied font database SVG text must not silently disappear.
        if String::from_utf8_lossy(bytes).contains("<text") { return None; }
        let size = tree.size().to_int_size();
        if u64::from(size.width()) * u64::from(size.height()) > 16_777_216 { return None; }
        let mut pixmap = resvg_worker::tiny_skia::Pixmap::new(size.width(), size.height())?;
        resvg_worker::render(&tree, resvg_worker::tiny_skia::Transform::identity(), &mut pixmap.as_mut());
        // tiny-skia stores premultiplied RGBA; ImageData expects straight alpha.
        let mut rgba = pixmap.data().to_vec();
        for pixel in rgba.chunks_exact_mut(4) {
            let alpha = pixel[3] as u32;
            if alpha > 0 { for c in &mut pixel[..3] { *c = ((*c as u32 * 255 + alpha / 2) / alpha).min(255) as u8; } }
        }
        (rgba, size.width(), size.height())
    } else {
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(64 * 1024 * 1024);
        limits.max_image_width = Some(8192); limits.max_image_height = Some(8192);
        reader.limits(limits);
        let rgba = reader.decode().ok()?.to_rgba8();
        let (w, h) = (rgba.width(), rgba.height());
        (rgba.into_raw(), w, h)
    };
    if iw == 0 || ih == 0 || buf.len() > 64 * 1024 * 1024 { return None; }
    let allowed = RESOURCE_BYTES.with(|c| {
        let next = c.get().saturating_add(buf.len()); c.set(next); next <= 64 * 1024 * 1024
    });
    if !allowed { return None; }
    let image_data = web_sys::ImageData::new_with_u8_clamped_array_and_sh(wasm_bindgen::Clamped(&buf), iw, ih).ok()?;
    let canvas = OffscreenCanvas::new(iw, ih).ok()?;
    let ctx = canvas.get_context("2d").ok()??.dyn_into::<OffscreenCanvasRenderingContext2d>().ok()?;
    ctx.put_image_data(&image_data, 0.0, 0.0).ok()?;
    Some(canvas)
}

''' + s[end:]
start = s.index('        let window = match web_sys::window()')
end = s.index('        let sz: u32 = 6;', start)
s = s[:start] + '''        let tile_canvas = match OffscreenCanvas::new(6, 6) {
            Ok(canvas) => canvas, Err(_) => return false,
        };
''' + s[end:]
start = s.index('        // 캐시에서 이미 로드된 이미지를 찾는다')
end = s.index('\n    fn draw_path(', start)
s = s[:start] + '''        RESOURCE_FAILURE.with(|c| c.set(true));
    }
''' + s[end:]
start = s.index('        let cached = IMAGE_CACHE.with')
end = s.index('\n    /// 텍스트 변형 효과', start)
s = s[:start] + '''        RESOURCE_FAILURE.with(|c| c.set(true));
    }
''' + s[end:]
s = s.replace(', HtmlImageElement', '')
write('src/renderer/offscreen_canvas.rs', '// Generated by scripts/patch-rhwp-offscreen.py; typed Worker backend.\n' + s)
eq = (root / 'src/renderer/equation/canvas_render.rs').read_text(encoding='utf-8').replace('CanvasRenderingContext2d', 'OffscreenCanvasRenderingContext2d')
write('src/renderer/equation/offscreen_render.rs', eq)
for path, line in [('src/renderer/mod.rs', 'pub mod offscreen_canvas;'), ('src/renderer/equation/mod.rs', 'pub mod offscreen_render;')]:
    t = (root / path).read_text(encoding='utf-8')
    write(path, t + '\n#[cfg(target_arch = "wasm32")]\n' + line + '\n')
t = (root / 'src/wasm_api.rs').read_text(encoding='utf-8')
start = t.index('    #[cfg(target_arch = "wasm32")]\n    #[wasm_bindgen(js_name = renderPageToCanvas)]')
end = t.index('\n    ///', start)
method = t[start:end].replace('renderPageToCanvas', 'renderPageToOffscreenCanvas').replace('render_page_to_canvas', 'render_page_to_offscreen_canvas').replace('&HtmlCanvasElement', '&web_sys::OffscreenCanvas').replace('web_canvas::WebCanvasRenderer', 'offscreen_canvas::OffscreenCanvasRenderer').replace('WebCanvasRenderer::new', 'OffscreenCanvasRenderer::new')
method = method.replace('        let mut renderer =', '        crate::renderer::offscreen_canvas::reset_resources();\n        let mut renderer =')
method = method.replace('        renderer.render_page(&tree).map_err(JsValue::from)?;', '''        let result = renderer.render_page(&tree).map_err(JsValue::from);
        let failed = crate::renderer::offscreen_canvas::resources_failed();
        crate::renderer::offscreen_canvas::reset_resources();
        result?;
        if failed { return Err(JsValue::from_str("Canvas image resource could not be decoded safely")); }''')
write('src/wasm_api.rs', t[:start] + method + '\n\n' + t[start:])
t = (root / 'Cargo.toml').read_text(encoding='utf-8')
t = replace(t, '[target.\'cfg(target_arch = "wasm32")\'.dependencies]', '[target.\'cfg(target_arch = "wasm32")\'.dependencies]\nresvg-worker = { package = "resvg", version = "0.47", default-features = false, features = ["raster-images"] }')
t = replace(t, '    "CanvasRenderingContext2d",', '    "CanvasRenderingContext2d",\n    "OffscreenCanvas",\n    "OffscreenCanvasRenderingContext2d",')
t = replace(t, 'features = ["bmp", "jpeg", "png", "tiff"]', 'features = ["bmp", "jpeg", "png", "tiff", "gif", "webp", "ico"]')
write('Cargo.toml', t)
