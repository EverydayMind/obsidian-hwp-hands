from pathlib import Path
import re, sys
root = Path(sys.argv[1])
def read(p): return (root/p).read_text(encoding='utf-8')
def write(p,s):
 p=root/p; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(s,encoding='utf-8',newline='\n')
def once(s,old,new,name):
 n=s.count(old)
 if n != 1: raise ValueError(f'{name}: expected 1, got {n}')
 return s.replace(old,new)
def span(s,a,b,repl,name):
 if s.count(a)!=1 or s.count(b)!=1: raise ValueError(name)
 i=s.index(a); j=s.index(b,i); return s[:i]+repl+s[j:]
def mechanical(s):
 for a,b in [('CanvasRenderingContext2d','OffscreenCanvasRenderingContext2d'),('HtmlCanvasElement','OffscreenCanvas'),('WebCanvasRenderer','OffscreenCanvasRenderer'),('html_canvas_element','offscreen_canvas'),('web_canvas::','offscreen_canvas::'),('canvas_render::','offscreen_render::')]: s=s.replace(a,b)
 return s
def scratch(s,name):
 pattern=r'let canvas = web_sys::window\(\)\?\s*\.document\(\)\?\s*\.create_element\("canvas"\)\s*\.ok\(\)\?\s*\.dyn_into::<OffscreenCanvas>\(\)\s*\.ok\(\)\?;\s*canvas.set_width\(([^;]+)\);\s*canvas.set_height\(([^;]+)\);'
 s,n=re.subn(pattern,lambda m:f'let canvas = OffscreenCanvas::new({m[1]}, {m[2]}).ok()?;',s)
 expected={'cubic_reduction.rs':2,'metafile_print.rs':1,'print_image_sampling.rs':1,'print_jpeg_replay.rs':1}.get(name,0)
 if n!=expected: raise ValueError(f'{name} scratch: {n} != {expected}')
 return s
decode='// Per-render resource cache: released before returning the bitmap.\n#[cfg(target_arch = "wasm32")]\nthread_local! {\n    static DECODED_CANVAS_CACHE: std::cell::RefCell<std::collections::HashMap<u64, Option<OffscreenCanvas>>> = Default::default();\n    static RESOURCE_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };\n    static RESOURCE_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };\n}\n\npub fn reset_resources() {\n    DECODED_CANVAS_CACHE.with(|c| c.borrow_mut().clear());\n    RESOURCE_FAILURE.with(|c| c.set(false));\n    RESOURCE_BYTES.with(|c| c.set(0));\n}\npub fn resources_failed() -> bool { RESOURCE_FAILURE.with(|c| c.get()) }\n\nfn decode_image_to_canvas(data: &[u8]) -> Option<OffscreenCanvas> {\n    // Only embedded bytes are decoded. No DOM, URL loader, or network resolver.\n    let mime = detect_image_mime_type(data);\n    let converted = match mime {\n        "image/x-wmf" => super::svg::convert_wmf_to_svg(data),\n        "image/x-emf" => crate::emf::convert_to_standalone_svg(data),\n        "image/x-pcx" => super::image_resolver::pcx_bytes_to_png_bytes(data),\n        "image/tiff" => super::image_resolver::tiff_bytes_to_png_bytes(data),\n        "application/postscript" => super::image_resolver::eps_renderable_bytes(data).map(|(_, bytes)| bytes),\n        _ => None,\n    };\n    let bytes = converted.as_deref().unwrap_or(data);\n    let (buf, iw, ih) = if super::svg_fragment::is_svg_prefix(bytes) {\n        let mut options = resvg_worker::usvg::Options::default();\n        // Never resolve local paths from an imported SVG image.\n        options.image_href_resolver.resolve_string = Box::new(|_, _| None);\n        let tree = resvg_worker::usvg::Tree::from_data(bytes, &options).ok()?;\n        // Without a supplied font database SVG text must not silently disappear.\n        if String::from_utf8_lossy(bytes).contains("<text") { return None; }\n        let size = tree.size().to_int_size();\n        if u64::from(size.width()) * u64::from(size.height()) > 16_777_216 { return None; }\n        let mut pixmap = resvg_worker::tiny_skia::Pixmap::new(size.width(), size.height())?;\n        resvg_worker::render(&tree, resvg_worker::tiny_skia::Transform::identity(), &mut pixmap.as_mut());\n        // tiny-skia stores premultiplied RGBA; ImageData expects straight alpha.\n        let mut rgba = pixmap.data().to_vec();\n        for pixel in rgba.chunks_exact_mut(4) {\n            let alpha = pixel[3] as u32;\n            if alpha > 0 { for c in &mut pixel[..3] { *c = ((*c as u32 * 255 + alpha / 2) / alpha).min(255) as u8; } }\n        }\n        (rgba, size.width(), size.height())\n    } else {\n        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?;\n        let mut limits = image::Limits::default();\n        limits.max_alloc = Some(64 * 1024 * 1024);\n        limits.max_image_width = Some(8192); limits.max_image_height = Some(8192);\n        reader.limits(limits);\n        let rgba = reader.decode().ok()?.to_rgba8();\n        let (w, h) = (rgba.width(), rgba.height());\n        (rgba.into_raw(), w, h)\n    };\n    if iw == 0 || ih == 0 || buf.len() > 64 * 1024 * 1024 { return None; }\n    let allowed = RESOURCE_BYTES.with(|c| {\n        let next = c.get().saturating_add(buf.len()); c.set(next); next <= 64 * 1024 * 1024\n    });\n    if !allowed { return None; }\n    let image_data = web_sys::ImageData::new_with_u8_clamped_array_and_sh(wasm_bindgen::Clamped(&buf), iw, ih).ok()?;\n    let canvas = OffscreenCanvas::new(iw, ih).ok()?;\n    let ctx = canvas.get_context("2d").ok()??.dyn_into::<OffscreenCanvasRenderingContext2d>().ok()?;\n    ctx.put_image_data(&image_data, 0.0, 0.0).ok()?;\n    Some(canvas)\n}\n\n'
decode=decode.replace('resvg_worker::','resvg::')
decode=decode.replace('        options.image_href_resolver.resolve_string =', '        options.image_href_resolver.resolve_data = Box::new(|_, _, _| None);\n        options.image_href_resolver.resolve_string =')
decode=decode.replace('        let mut reader = image::ImageReader::new', '        let dimensions = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?.into_dimensions().ok()?;\n        if dimensions.0 > 8192 || dimensions.1 > 8192 { return None; }\n        let mut reader = image::ImageReader::new')
decode=decode.replace('    RESOURCE_FAILURE.with(|c| c.set(false));', '    cubic_reduction::clear_cache();\n    print_image_sampling::clear_cache();\n    RESOURCE_FAILURE.with(|c| c.set(false));')
decode=decode.replace('        if String::from_utf8_lossy(bytes).contains("<text") { return None; }', '''        let svg = String::from_utf8_lossy(bytes);
        // Reject nodes the disabled href resolver or empty font database would omit.
        if svg.split('<').skip(1).any(|tag| {
            let name = tag.split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next().unwrap_or("").rsplit(':').next().unwrap_or("");
            name == "text" || name == "image"
        }) { return None; }''')
decode=decode.replace('        let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())?;', '        if !picture_fits_budget(size.width(), size.height()) { return None; }\n        let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())?;')
decode=decode.replace('        if dimensions.0 > 8192 || dimensions.1 > 8192 { return None; }', '        if dimensions.0 > 8192 || dimensions.1 > 8192 || !picture_fits_budget(dimensions.0, dimensions.1) { return None; }')
decode=decode.replace('fn decode_image_to_canvas(data: &[u8]) -> Option<OffscreenCanvas> {', '''fn picture_fits_budget(w: u32, h: u32) -> bool {
    let bytes = u64::from(w) * u64::from(h) * 4;
    RESOURCE_BYTES.with(|used| bytes <= (64 * 1024 * 1024usize).saturating_sub(used.get()) as u64)
}

fn decode_image_to_canvas(data: &[u8]) -> Option<OffscreenCanvas> {''')
decode=decode.replace('    // Only embedded bytes are decoded.', '    // Conversion helpers and upstream memo caches retain their own allocations; the host limits input to 50 MB.\n    // Only embedded bytes are decoded.')
s=mechanical(read('src/renderer/web_canvas.rs'))
s=s.replace(', HtmlImageElement','')
s=span(s,'// 이미지 캐시:', '/// 빠른 해시',decode,'decode')
s=span(s,'        let window = match web_sys::window()', '        let sz: u32 = 8;', '        let tile_canvas = match OffscreenCanvas::new(8, 8) { Ok(c) => c, Err(_) => return false };\n','pattern')
s=once(s,'        let Some(document) = web_sys::window().and_then(|window| window.document()) else {\n            return false;\n        };\n','', 'gradient document')
s=span(s,'        let Some(tile) = document\n', '        let Some(ctx) = tile\n','        let Ok(tile) = OffscreenCanvas::new(pw, ph) else { return false; };\n','gradient tile')
s=span(s,'        if super::image_resolver::png_sampling::print_jpeg_transfer(data) {\n            return;\n        }\n\n        // 캐시에서 이미 로드된 이미지를 찾는다','\n    fn draw_path(', '        RESOURCE_FAILURE.with(|c| c.set(true));\n    }\n','image fallback')
s=span(s,'        if super::image_resolver::png_sampling::print_jpeg_transfer(data) {\n            return;\n        }\n\n        let cached = IMAGE_CACHE.with', '\n    fn fill_positioned_text(','        RESOURCE_FAILURE.with(|c| c.set(true));\n    }\n','crop fallback')
s=span(s,'            // 실제 표시되는 SVG와 동일한 viewport를 source rect에 사용한다.', '        } else {\n            parse_image_dimensions_canvas(data)', '            crate::renderer::svg::convert_wmf_to_svg(data)\n                .and_then(|svg| super::metafile_geometry::svg_viewport(&svg))\n','wmf size')
# Decode failures must be reported even in submodule paths.
s=once(s, 'fn hash_bytes(data: &[u8]) -> u64 {', '''fn cached_decoded_image_canvas(data: &[u8], key: u64) -> Option<OffscreenCanvas> {
    DECODED_CANVAS_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(canvas) = cache.get(&key) { return canvas.clone(); }
        let canvas = decode_image_to_canvas(data);
        if canvas.is_none() { RESOURCE_FAILURE.with(|c| c.set(true)); }
        cache.insert(key, canvas.clone());
        canvas
    })
}
fn cached_image_canvas(data: &[u8]) -> Option<OffscreenCanvas> {
    cached_decoded_image_canvas(data, hash_bytes(data))
}

fn hash_bytes(data: &[u8]) -> u64 {''', 'decode cache')
s=once(s, '''            let _ = self
                .ctx
                .draw_image_with_offscreen_canvas_and_dw_and_dh(&canvas, x, y, w, h);''', '''            if self.ctx.draw_image_with_offscreen_canvas_and_dw_and_dh(&canvas, x, y, w, h).is_err() {
                RESOURCE_FAILURE.with(|c| c.set(true));
            }''', 'image draw error')
s=once(s, '''            let _ = self
                .ctx
                .draw_image_with_offscreen_canvas_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    &canvas, sx, sy, sw, sh, dx, dy, dw, dh,
                );''', '''            if self.ctx.draw_image_with_offscreen_canvas_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                    &canvas, sx, sy, sw, sh, dx, dy, dw, dh,
                ).is_err() { RESOURCE_FAILURE.with(|c| c.set(true)); }''', 'crop draw error')
s=once(s, '''            if let Some((_mime, bytes)) = decode_base64_data_url(data_url) {
                self.draw_image(&bytes, bbox.x, bbox.y, bbox.width, bbox.height);
            }''', '''            if let Some((_mime, bytes)) = decode_base64_data_url(data_url) {
                self.draw_image(&bytes, bbox.x, bbox.y, bbox.width, bbox.height);
            } else { RESOURCE_FAILURE.with(|c| c.set(true)); }''', 'raw image decode')
s=s.replace('use base64::Engine;\n','')
write('src/renderer/offscreen_canvas.rs','// Generated by scripts/patch-rhwp-offscreen.py.\n'+s)
for p in sorted((root/'src/renderer/web_canvas').glob('*.rs')):
 s=mechanical(p.read_text(encoding='utf-8'))
 if p.name=='print_jpeg.rs':
  s='//! Worker JPEGs use the synchronous bounded decoder in the parent module.\n'
 elif p.name=='char_overlap.rs':
  s=span(s,'            let Some(document) = web_sys::window()', '            let b = plan.bounds;', '            let Ok(canvas) = OffscreenCanvas::new(1, 1) else { self.ctx.restore(); return false; };\n','overlap')
  s=s.replace('OffscreenCanvas, JsCast,','OffscreenCanvas,')
 else: s=scratch(s,p.name)
 if p.name=='cubic_reduction.rs': s += '\npub(super) fn clear_cache() { CACHE.with(|c| c.borrow_mut().clear()); }\n'
 if p.name=='print_image_sampling.rs': s += '\npub(super) fn clear_cache() { jpeg_replay::clear_cache(); }\n'
 if p.name=='print_jpeg_replay.rs': s += '\npub(super) fn clear_cache() { CACHE.with(|c| *c.borrow_mut() = Cache::default()); }\n'
 write('src/renderer/offscreen_canvas/'+p.name,'// Generated by scripts/patch-rhwp-offscreen.py.\n'+s)
write('src/renderer/equation/offscreen_render.rs','// Generated by scripts/patch-rhwp-offscreen.py.\n'+mechanical(read('src/renderer/equation/canvas_render.rs')))
# Assert the entire output is worker-safe.
for p in [root/'src/renderer/offscreen_canvas.rs',root/'src/renderer/equation/offscreen_render.rs',*(root/'src/renderer/offscreen_canvas').glob('*.rs')]:
 for forbidden in ['HtmlImageElement','HtmlCanvasElement','web_sys::window','.document()','create_element','set_src','data:image']:
  if forbidden in p.read_text(encoding='utf-8'): raise ValueError(f'{p}: {forbidden}')
