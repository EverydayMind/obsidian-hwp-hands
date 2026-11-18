import * as obsidian from 'obsidian';
import type { App } from 'obsidian';
import { filterFolderSuggestions, replaceFolderInPath } from './path-suggest';

export interface FolderSuggestHandle { close(): void }

/**
 * Offers vault folders while a path is typed. Returns undefined where the host has no
 * AbstractInputSuggest (older Obsidian); the input then works as a plain text box.
 */
export function attachFolderSuggest(app: App, inputEl: HTMLInputElement): FolderSuggestHandle | undefined {
  let Base: typeof obsidian.AbstractInputSuggest | undefined;
  try { Base = obsidian.AbstractInputSuggest; } catch { Base = undefined; }
  if (typeof Base !== 'function') return undefined;
  class FolderPathSuggest extends Base<string> {
    protected getSuggestions(query: string): string[] {
      const folders = this.app.vault.getAllLoadedFiles()
        .filter((entry): entry is obsidian.TFolder => entry instanceof obsidian.TFolder && !entry.isRoot())
        .map(folder => folder.path);
      return filterFolderSuggestions(folders, query);
    }
    renderSuggestion(folder: string, el: HTMLElement): void { el.setText(folder); }
    selectSuggestion(folder: string): void {
      this.setValue(replaceFolderInPath(this.getValue(), folder));
      this.close();
      inputEl.focus();
    }
  }
  return new FolderPathSuggest(app, inputEl);
}
