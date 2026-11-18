# HWP Hands

[한국어](README.ko.md)

Open and edit Hangul HWP and HWPX documents inside Obsidian Desktop. Documents are parsed, laid out and saved locally by a bundled RHWP WebAssembly engine; nothing leaves your computer.

The interface and the agent tool wording follow the app language: Korean when Obsidian is set to Korean, English otherwise.

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

Settings: open HWP/HWPX by default (turn off if another plugin should handle these files), show editor tools, input preview, back up the original before saving, generate the search index automatically, maximum document size, keeping a whole document private from AI tools, and two switches for AI agent tools. By default a host plugin such as Verbex gets only the reading tools; turn on **Allow AI agent editing tools** (and **Allow AI agent save tool** to let the host save through its approval step), reload the plugin, then approve HWP Hands again in the host.

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

## Tools for AI agents

You can skip this section if you don't use an AI agent in Obsidian.

HWP Hands exposes an agentinterop v1 capability provider on its plugin instance. A compatible agent host can read the tool definitions and call them after you approve them in the host. Reading tools such as `read_document` and `find_text` are offered by default. Editing tools such as `edit_paragraphs`, `update_table` and `fill_fields`, and the `save_document` tool, are offered only after you turn on the two AI agent switches in the settings above. Edits are applied to the open document session; the file is written only by the save tool, through the host's approval step.

agentinterop v1 is the author's own convention, not an official or widely recognized standard. It lets an Obsidian plugin that runs an AI agent discover tools offered by other plugins through an MCP-like API, without those plugins knowing about any particular agent host.

What this gives you:

- **No coupling between plugins.** The provider is a plain object on the plugin instance. This plugin does not import or depend on any agent plugin, and it works the same when none is installed.
- **Everything stays local.** A tool call is an in-process function call inside Obsidian. There is no server to start, no port to open and no network request.
- **You stay in control.** A host shows a plugin's tools to the model only after you approve them. Each tool declares its effect (`read`, `edit` or `commit` here), so the host knows which calls only read, which ones edit the open document and which ones write a file.
- **A short tool list for the model.** Keywords and groups let a host offer a tool only when the request is about it, which matters for small models.

**Verbex** is currently the only agent host that implements agentinterop v1: [EverydayMind/obsidian-verbex](https://github.com/EverydayMind/obsidian-verbex).

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

**Verbex**, an AI agent plugin for Obsidian that works together with this plugin, is available at [EverydayMind/obsidian-verbex](https://github.com/EverydayMind/obsidian-verbex).
