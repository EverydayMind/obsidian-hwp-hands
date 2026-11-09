/** Install the plugin's CSS into the document when Obsidian has not loaded it. */
export function installPluginStyles(document: Document, css: string): () => void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(existing => existing !== sheet); };
}
