import { FuzzySuggestModal, type App } from 'obsidian';
import type { StyleDefinition } from '../../api';

/** Pick one of the document's styles by name (used by style edit and delete). */
export class StylePickerModal extends FuzzySuggestModal<StyleDefinition> {
  constructor(app: App, private readonly styles: readonly StyleDefinition[], placeholder: string, private readonly onChoose: (style: StyleDefinition) => void) {
    super(app);
    this.setPlaceholder(placeholder);
    this.emptyStateText = '스타일이 없습니다.';
  }
  getItems(): StyleDefinition[] { return [...this.styles]; }
  getItemText(item: StyleDefinition): string { return item.name; }
  renderSuggestion(match: { item: StyleDefinition }, element: HTMLElement): void {
    element.createDiv({ text: match.item.name });
    element.createEl('small', { text: `${match.item.type === 1 ? '글자' : '문단'} 스타일${match.item.englishName ? ` · ${match.item.englishName}` : ''}` });
  }
  onChooseItem(item: StyleDefinition): void { this.onChoose(item); }
}
