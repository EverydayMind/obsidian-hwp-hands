import { FuzzySuggestModal, Notice, type App } from 'obsidian';
import type { Bookmark } from '../../api';
import { FocusReturnModal } from './index';
import { bookmarkPositionLabel, sortBookmarks, suggestBookmarkName, validateBookmarkName, type BookmarkSort } from './bookmark-list';

export interface BookmarkActions {
  list(): Promise<Bookmark[]>;
  add(name: string): Promise<void>;
  rename(name: string, newName: string): Promise<void>;
  remove(name: string): Promise<void>;
  goTo(bookmark: Bookmark): Promise<void>;
  /** Why adding, renaming and deleting are unavailable now (read-only document, form mode, …). */
  editBlockedReason(): string | undefined;
  /** Why a new bookmark cannot be added at the caret (no body paragraph selected). */
  addBlockedReason(): string | undefined;
}

/** Manage bookmarks: list, add at the caret, rename, delete and jump (rhwp-studio `insert:bookmark`). */
export class BookmarkModal extends FocusReturnModal {
  constructor(app: App, private readonly actions: BookmarkActions) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: '책갈피' });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const sortRow = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
    sortRow.createEl('label', { text: '정렬', attr: { for: 'hwp-bookmark-sort' } });
    const sort = sortRow.createEl('select', { attr: { id: 'hwp-bookmark-sort', 'aria-label': '책갈피 정렬' } });
    sort.createEl('option', { value: 'position', text: '위치순' }); sort.createEl('option', { value: 'name', text: '이름순' });
    const list = this.contentEl.createEl('select', { cls: 'hwp-bookmark-list', attr: { size: '8', 'aria-label': '책갈피 목록' } });
    const nameRow = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
    nameRow.createEl('label', { text: '이름', attr: { for: 'hwp-bookmark-name' } });
    const name = nameRow.createEl('input', { type: 'text', attr: { id: 'hwp-bookmark-name', 'aria-label': '책갈피 이름', maxlength: '250' } });
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const goButton = buttons.createEl('button', { text: '이동' });
    const addButton = buttons.createEl('button', { text: '추가', cls: 'mod-cta' });
    const renameButton = buttons.createEl('button', { text: '이름 바꾸기' });
    const deleteButton = buttons.createEl('button', { text: '삭제', cls: 'mod-warning' });
    buttons.createEl('button', { text: '닫기' }).addEventListener('click', () => this.close());

    let bookmarks: Bookmark[] = [];
    const selected = (): Bookmark | undefined => bookmarks.find(item => item.name === list.value);
    const refreshButtons = (): void => {
      const blocked = this.actions.editBlockedReason(), addBlocked = this.actions.addBlockedReason();
      const has = !!selected();
      goButton.disabled = !has;
      addButton.disabled = !!blocked || !!addBlocked; addButton.title = blocked ?? addBlocked ?? '캐럿 위치에 책갈피를 추가합니다.';
      renameButton.disabled = !!blocked || !has; renameButton.title = blocked ?? '선택한 책갈피의 이름을 입력란의 이름으로 바꿉니다.';
      deleteButton.disabled = !!blocked || !has; deleteButton.title = blocked ?? '선택한 책갈피를 삭제합니다.';
    };
    const render = async (keep?: string): Promise<void> => {
      try { bookmarks = await this.actions.list(); } catch (error) { status.setText(`책갈피 목록을 읽지 못했습니다: ${String(error)}`); return; }
      const ordered = sortBookmarks(bookmarks, sort.value as BookmarkSort);
      list.empty();
      for (const item of ordered) list.createEl('option', { value: item.name, text: `${item.name}  —  ${bookmarkPositionLabel(item)}` });
      if (keep && ordered.some(item => item.name === keep)) list.value = keep;
      else if (ordered.length) list.selectedIndex = 0;
      if (!name.value) name.value = suggestBookmarkName(ordered.map(item => item.name));
      status.setText(ordered.length ? `${ordered.length}개 책갈피` : '책갈피가 없습니다.');
      refreshButtons();
    };
    const run = async (label: string, action: () => Promise<void>, keep?: () => string | undefined, closeAfter = false): Promise<void> => {
      status.setText(`${label}하는 중…`);
      for (const button of [goButton, addButton, renameButton, deleteButton]) button.disabled = true;
      try { await action(); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); status.setText(`${label}하지 못했습니다: ${message}`); new Notice(`책갈피: ${message}`, 8000); await render(list.value); return; }
      if (closeAfter) { this.close(); return; }
      name.value = ''; await render(keep?.());
    };
    sort.addEventListener('change', () => void render(list.value));
    list.addEventListener('change', () => { const item = selected(); if (item) name.value = item.name; refreshButtons(); });
    list.addEventListener('dblclick', () => { const item = selected(); if (item) void run('이동', () => this.actions.goTo(item), undefined, true); });
    goButton.addEventListener('click', () => { const item = selected(); if (item) void run('이동', () => this.actions.goTo(item), undefined, true); });
    addButton.addEventListener('click', () => {
      const message = validateBookmarkName(name.value, bookmarks.map(item => item.name));
      if (message) { status.setText(message); name.focus(); return; }
      const value = name.value.trim();
      void run('추가', () => this.actions.add(value), () => value);
    });
    renameButton.addEventListener('click', () => {
      const item = selected(); if (!item) return;
      const message = validateBookmarkName(name.value, bookmarks.map(entry => entry.name), item.name);
      if (message) { status.setText(message); name.focus(); return; }
      const value = name.value.trim();
      void run('이름 바꿈', () => this.actions.rename(item.name, value), () => value);
    });
    deleteButton.addEventListener('click', () => { const item = selected(); if (item) void run('삭제', () => this.actions.remove(item.name)); });
    name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!addButton.disabled) addButton.click(); } });
    void render().then(() => name.focus());
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

/** Quick jump: pick a bookmark from a fuzzy list. */
export class BookmarkPickerModal extends FuzzySuggestModal<Bookmark> {
  constructor(app: App, private readonly bookmarks: Bookmark[], private readonly onChoose: (bookmark: Bookmark) => void) {
    super(app);
    this.setPlaceholder('이동할 책갈피 이름');
    this.emptyStateText = '책갈피가 없습니다.';
  }
  getItems(): Bookmark[] { return sortBookmarks(this.bookmarks, 'position'); }
  getItemText(item: Bookmark): string { return item.name; }
  renderSuggestion(match: { item: Bookmark }, element: HTMLElement): void {
    element.createDiv({ text: match.item.name });
    element.createEl('small', { text: bookmarkPositionLabel(match.item) });
  }
  onChooseItem(item: Bookmark): void { this.onChoose(item); }
}
