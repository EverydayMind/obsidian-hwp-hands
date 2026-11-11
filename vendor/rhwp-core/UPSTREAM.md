# Local RHWP core build

This package is built from RHWP source tag v0.9.0 (commit c9095c5f67632e6721e800ccc7fb43ea49d26682, npm `@rhwp/core` 0.9.0) with seven local patches. The local package version 0.9.0-hwp-editor.1 identifies the binary. README.md and LICENSE are copied from the upstream 0.9.0 npm package.

## Build

1. Check out tag v0.9.0.
2. Apply the patches in `patches/` in this order: `header-footer-dynamic-field-metadata`, `double-slim-border-geometry`, `cell-paragraph-delete`, `style-attribute-propagation`, `geometry-preserving-body-edit`, `offscreen-canvas-backend`, `body-format-batch-deferral`. Each applies cleanly on top of the previous ones.
3. Generate the Worker renderer: `python scripts/patch-rhwp-offscreen.py <checkout>` (from this repository). It derives `src/renderer/offscreen_canvas.rs`, `src/renderer/offscreen_canvas/*.rs` (one file per upstream `web_canvas/` submodule) and `src/renderer/equation/offscreen_render.rs` from the checkout's `web_canvas` and `equation/canvas_render.rs`. It stops with an error if an expected anchor is missing and refuses to finish if a generated file still names a DOM type.
4. `cargo +1.93.1 build --release --target wasm32-unknown-unknown --lib --locked -p rhwp --no-default-features --features console_error_panic_hook,wasm-api`
5. `wasm-bindgen 0.2.127 --target web` on `target/wasm32-unknown-unknown/release/rhwp.wasm`. rhwp.js, rhwp.d.ts and rhwp_bg.wasm.d.ts are this build's output; they differ from the upstream npm wrappers (feature set and two local methods).

The upstream default features include PDF import (`pdf-import`, `pdf-jbig2`, `pdf-jpeg2000`, `pdf-icc`). They are left out: the plugin does not import PDF, and with them the WASM is more than twice as large (npm 0.9.0: 26.8 MB). PDF-import methods exist in the typings but return `PDF_IMPORT_DISABLED`.

`rhwp_bg.wasm` SHA-256: `e3cad5cddf4df9466e2d9c0f760d5565405c85db82baf952b26c06d53230907c` (21,771,028 bytes; 7,523,399 bytes at gzip -9). The same bytes are in `vendor/rhwp-core-0.9.0-hwp-editor.1.tgz`.

## Local patches

1. `header-footer-dynamic-field-metadata` — the header/footer query returns a format-independent `logicalText` and native page-number, total-page and file-name field metadata next to the raw text and edit coordinates. A trailing automatic-number control is mapped back to its one-character placeholder in that metadata only.
2. `double-slim-border-geometry` — a `DOUBLE_SLIM` border of declared width W is two strokes of W/4 whose centres are 3W/8 either side of the edge, so the pair spans exactly W (rule measured against Hancom output). v0.9.0 also changed this border but rounds the strokes to a 600 dpi grid (0.12/0.5/0.7 mm → 0.16/0.48/0.64 px instead of 0.113/0.472/0.661 px), which fails `tests/layout-rules-wasm.test.ts`; the local rule is kept.
3. `cell-paragraph-delete` — `deleteParagraphInCellByPath` removes a cell paragraph without merging it into a neighbour, keeping the other paragraphs' formatting.
4. `style-attribute-propagation` — applying a style keeps individually overridden attributes (per attribute, not per shape id as upstream), and a style change propagates through body paragraphs and nested containers (tables in tables, text boxes, notes). Upstream's cell indentation restamp and section invalidation are kept.
5. `geometry-preserving-body-edit` — a body insertText/deleteText whose reflow keeps the same number of lines with identical geometry recomposes only that paragraph and skips the section vpos pass and pagination. Every other case, including any case where a v0.9.0 cache or font source state could differ, takes the upstream path. Unpatched v0.9.0 measured about 165–187 ms per edit on a generated 103-page document versus about 0.2 ms with the fast path.
6. `offscreen-canvas-backend` — `renderPageToOffscreenCanvas`, a typed OffscreenCanvas sibling of the DOM renderer for the document Worker (Cargo features, module declarations, the exported method; the drawing code is generated, see Build). The Worker backend never touches `window`, `document`, `HtmlImageElement` or a URL loader. Pictures are decoded in Rust; WMF/EMF/PCX/TIFF/EPS go through the upstream converters and vector results are rasterized with resvg with href resolution disabled. Limits: 8192 px per picture axis (checked before decoding), 64 MiB decoder allocation, 64 MiB of decoded pictures per render call, 16,777,216 px per rasterized vector picture; the renderer's decoded-picture caches are cleared before and after every call. An SVG with `<text>` or `<image>` is refused because no font database or href loader is supplied. A picture that cannot be drawn under these rules makes the call throw; the plugin then shows the page through SVG. The upstream converters' internal allocations are bounded only by the plugin's document size limit.

7. `body-format-batch-deferral` — v0.9.0 defers body character formatting in batch mode but still rebuilt styles, recomposed the section and paginated on every body `applyParaFormat` and `applyStyle`. In batch mode these now only record the section; `endBatch` resolves styles, recomposes each recorded section once and paginates. A Rust test compares batched and unbatched application (page count, every page's SVG and layer tree). Measured on a generated 103-page document, 100 paragraphs in one batch: paragraph format 23.6 s → 0.21 s, style 25.5 s → 0.26 s (0.8.7-hwp-editor.10: about 0.1 s).

## Dropped since 0.8.7-hwp-editor.10

Upstream v0.9.0 covers these 0.8.7 patches; the plugin's regression tests for each pass on unpatched v0.9.0: `textbox-storage-bit` (RHWP #8176), `field-leading-offsets`, `hwpx-placeholder-float-flow`, `paragraph-start-control-insertion`, `font-name-classification-memo` (upstream name cache; upstream's KoPub classification is kept). The `useFontSpace` half-width space rule from the 0.8.7 geometry patch is implemented upstream.

## Recovery records

Recovery records carry the engine version. Records written by 0.8.7-hwp-editor.10 or older are refused by this build and stay on disk; they are recovered only with the exact historical runtime (docs/DECISIONS.md, decision 54). The 0.8.7-series build history is in the git history of this file.
