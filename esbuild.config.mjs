import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const worker = await build({
  entryPoints: ['src/engine-worker.ts'], bundle: true, write: false, format: 'iife',
  platform: 'browser', target: 'es2022', define: { 'import.meta.url': '"file:///rhwp.js"' },
});
const wasm = await readFile('node_modules/@rhwp/core/rhwp_bg.wasm');
const notices = (await readFile('THIRD_PARTY_NOTICES.md', 'utf8')).replaceAll('*/', '* /');
await build({
  entryPoints: ['src/main.ts'], bundle: true, outfile: 'main.js', format: 'cjs',
  platform: 'browser', target: 'es2022', external: ['obsidian', 'electron', 'node:crypto', 'node:fs/promises', 'node:zlib'],
  define: {
    'import.meta.url': '"file:///rhwp.js"',
    __HWP_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text),
    __HWP_WASM_GZIP__: JSON.stringify(gzipSync(wasm, { level: 9 }).toString('base64')),
    __HWP_WASM_SHA256__: JSON.stringify(createHash('sha256').update(wasm).digest('hex')),
  },
  banner: { js: `/*! ${manifest.name} ${manifest.version} | Third-party notices:\n${notices}\n*/` },
});
