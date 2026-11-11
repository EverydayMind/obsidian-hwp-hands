# HWP Hands

[한국어](README.ko.md)

Open and edit Hangul HWP and HWPX documents inside Obsidian Desktop. Documents are parsed, laid out and saved locally by a bundled RHWP WebAssembly engine; nothing leaves your computer.

The user interface is in Korean.

## Features

- Open `.hwp` and `.hwpx` files from the file explorer or from links, and type directly into body text, table cells and form fields on the page.
- Edit paragraphs and character formatting, insert tables, search and replace, and apply formatting across ranges of paragraphs, sections and cell blocks.
- Create a new HWPX document from the command palette.
- Links can target a page or a paragraph: `[[Plan.hwpx#page=3]]` jumps to page 3, `[Summary](Plan.hwp#Summary)` jumps to the first paragraph with that text.
- Embeds such as `![[Plan.hwpx]]` or `![[Plan.hwpx#page=3]]` show a sanitized read-only preview of one page, with a button to open the editor.
- Save as `.hwp` or `.hwpx`. A copy is refused if a re-parse check finds lost content, formatting or resources; the original stays untouched.
- Safety: the original is backed up before each save (the three most recent backups per document are kept), unsaved edits are journaled and restored after a restart, and external changes to an open file never overwrite your unsaved edits.
- Optional search index: a Markdown projection (`.index.md`) of body text, nested table cells, fields, text boxes, headers, footers and notes, regenerated after saves. Editing the index never changes the HWP/HWPX original.
- API for other plugins (see below).

## Installation

Install **HWP Hands** from Community plugins. For a manual installation, copy `main.js`, `manifest.json` and `styles.css` from a release into `.obsidian/plugins/hwp-hands/` and enable the plugin.

## Usage

Open an HWP or HWPX file. Click on the page to type; edits apply to the document model immediately. Save with the save button or `Ctrl+S`.

Commands (command palette): open an HWP/HWPX document, create a new HWPX document, save the current document, generate the Markdown index, recover unapplied input, cancel the current engine task, and clean up stored backups and temporary files.

Settings: open HWP/HWPX by default (turn off if another plugin should handle these files), show editor tools, input preview, back up the original before saving, generate the search index automatically, maximum document size, and keeping a whole document private from AI tools.

## API for other plugins

```ts
const api = app.plugins.plugins['hwp-hands']?.api;
if (api?.version === 1) {
  const lease = await api.documents.acquire('Docs/Report.hwpx');
  try {
    const tree = await api.query.tree('Docs/Report.hwpx');
    const receipt = await api.edit.transaction('Docs/Report.hwpx', [
      { type: 'replaceText', query: 'draft', replacement: 'final' },
    ], { expectedRevision: tree.state.revision });
    await api.documents.save('Docs/Report.hwpx', { expectedRevision: receipt.revision });
  } finally {
    await lease.release();
  }
}
```

The API shares the editor's document session, so a person and another plugin see the same state. Writes must name the revision they expect; a stale revision is rejected instead of overwriting newer edits.

## Limitations

- Desktop only.
- Not every HWP/HWPX feature can be edited, and some can only be preserved. Read the warnings shown when saving and keep backups of important documents.
- Page appearance depends on the fonts installed on your computer.

## Disclosures

- **Files:** reads and writes the HWP/HWPX documents you open in the vault, and the `.index.md` files when the search index is enabled. Backups, recovery journals and unsaved input drafts are stored in the plugin folder.
- **Network:** none. The plugin makes no network requests and does not download or run remote code.
- **Bundled engine:** `main.js` contains the RHWP WebAssembly engine and its worker. The engine is built from RHWP 0.9.0 with local patches; origin, patches and build instructions are in [vendor/rhwp-core/UPSTREAM.md](vendor/rhwp-core/UPSTREAM.md). The engine's SHA-256 is checked before it starts.

## License

MIT, see [LICENSE](LICENSE). Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and at the top of `main.js`.

---

**Verbex**, an AI agent plugin for Obsidian that works together with this plugin, is planned for public release.
