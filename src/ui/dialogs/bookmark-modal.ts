import { LT, L } from '../../i18n/locale';
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
    this.contentEl.createEl('h2', { text: L({ ko: '책갈피', en: "Bookmark" }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const sortRow = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
    sortRow.createEl('label', { text: L({ ko: '정렬', en: "Sort" }), attr: { for: 'hwp-bookmark-sort' } });
    const sort = sortRow.createEl('select', { attr: { id: 'hwp-bookmark-sort', 'aria-label': L({ ko: '책갈피 정렬', en: "Sort bookmarks" }) } });
    sort.createEl('option', { value: 'position', text: L({ ko: '위치순', en: "By position" }) }); sort.createEl('option', { value: 'name', text: L({ ko: '이름순', en: "By name" }) });
    const list = this.contentEl.createEl('select', { cls: 'hwp-bookmark-list', attr: { size: '8', 'aria-label': L({ ko: '책갈피 목록', en: "Bookmark list" }) } });
    const nameRow = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
    nameRow.createEl('label', { text: L({ ko: '이름', en: "Name" }), attr: { for: 'hwp-bookmark-name' } });
    const name = nameRow.createEl('input', { type: 'text', attr: { id: 'hwp-bookmark-name', 'aria-label': L({ ko: '책갈피 이름', en: "Bookmark name" }), maxlength: '250' } });
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const goButton = buttons.createEl('button', { text: L({ ko: '이동', en: "Go" }) });
    const addButton = buttons.createEl('button', { text: L({ ko: '추가', en: "Add" }), cls: 'mod-cta' });
    const renameButton = buttons.createEl('button', { text: L({ ko: '이름 바꾸기', en: "Rename" }) });
    const deleteButton = buttons.createEl('button', { text: L({ ko: '삭제', en: "Delete" }), cls: 'mod-warning' });
    buttons.createEl('button', { text: L({ ko: '닫기', en: "Close" }) }).addEventListener('click', () => this.close());

    let bookmarks: Bookmark[] = [];
    const selected = (): Bookmark | undefined => bookmarks.find(item => item.name === list.value);
    const refreshButtons = (): void => {
      const blocked = this.actions.editBlockedReason(), addBlocked = this.actions.addBlockedReason();
      const has = !!selected();
      goButton.disabled = !has;
      addButton.disabled = !!blocked || !!addBlocked; addButton.title = blocked ?? addBlocked ?? L({ ko: '캐럿 위치에 책갈피를 추가합니다.', en: "Adds a bookmark at the caret." });
      renameButton.disabled = !!blocked || !has; renameButton.title = blocked ?? L({ ko: '선택한 책갈피의 이름을 입력란의 이름으로 바꿉니다.', en: "Renames the selected bookmark to the entered name." });
      deleteButton.disabled = !!blocked || !has; deleteButton.title = blocked ?? L({ ko: '선택한 책갈피를 삭제합니다.', en: "Deletes the selected bookmark." });
    };
    const render = async (keep?: string): Promise<void> => {
      try { bookmarks = await this.actions.list(); } catch (error) { status.setText(LT({ ko: () => `책갈피 목록을 읽지 못했습니다: ${String(error)}`, en: () => `Could not read bookmarks: ${String(error)}` })); return; }
      const ordered = sortBookmarks(bookmarks, sort.value as BookmarkSort);
      list.empty();
      for (const item of ordered) list.createEl('option', { value: item.name, text: `${item.name}  —  ${bookmarkPositionLabel(item)}` });
      if (keep && ordered.some(item => item.name === keep)) list.value = keep;
      else if (ordered.length) list.selectedIndex = 0;
      if (!name.value) name.value = suggestBookmarkName(ordered.map(item => item.name));
      status.setText(ordered.length ? LT({ ko: () => `${ordered.length}개 책갈피`, en: () => `${ordered.length} bookmarks` }) : L({ ko: '책갈피가 없습니다.', en: "No bookmarks." }));
      refreshButtons();
    };
    const run = async (label: string, action: () => Promise<void>, keep?: () => string | undefined, closeAfter = false): Promise<void> => {
      status.setText(LT({ ko: () => `${label}하는 중…`, en: () => `${label} in progress…` }));
      for (const button of [goButton, addButton, renameButton, deleteButton]) button.disabled = true;
      try { await action(); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); status.setText(LT({ ko: () => `${label}하지 못했습니다: ${message}`, en: () => `Could not complete ${label}: ${message}` })); new Notice(LT({ ko: () => `책갈피: ${message}`, en: () => `Bookmark: ${message}` }), 8000); await render(list.value); return; }
      if (closeAfter) { this.close(); return; }
      name.value = ''; await render(keep?.());
    };
    sort.addEventListener('change', () => void render(list.value));
    list.addEventListener('change', () => { const item = selected(); if (item) name.value = item.name; refreshButtons(); });
    list.addEventListener('dblclick', () => { const item = selected(); if (item) void run(L({ ko: '이동', en: "Go" }), () => this.actions.goTo(item), undefined, true); });
    goButton.addEventListener('click', () => { const item = selected(); if (item) void run(L({ ko: '이동', en: "Go" }), () => this.actions.goTo(item), undefined, true); });
    addButton.addEventListener('click', () => {
      const message = validateBookmarkName(name.value, bookmarks.map(item => item.name));
      if (message) { status.setText(message); name.focus(); return; }
      const value = name.value.trim();
      void run(L({ ko: '추가', en: "Add" }), () => this.actions.add(value), () => value);
    });
    renameButton.addEventListener('click', () => {
      const item = selected(); if (!item) return;
      const message = validateBookmarkName(name.value, bookmarks.map(entry => entry.name), item.name);
      if (message) { status.setText(message); name.focus(); return; }
      const value = name.value.trim();
      void run(L({ ko: '이름 바꿈', en: "Renamed" }), () => this.actions.rename(item.name, value), () => value);
    });
    deleteButton.addEventListener('click', () => { const item = selected(); if (item) void run(L({ ko: '삭제', en: "Delete" }), () => this.actions.remove(item.name)); });
    name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!addButton.disabled) addButton.click(); } });
    void render().then(() => name.focus());
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

/** Quick jump: pick a bookmark from a fuzzy list. */
export class BookmarkPickerModal extends FuzzySuggestModal<Bookmark> {
  constructor(app: App, private readonly bookmarks: Bookmark[], private readonly onChoose: (bookmark: Bookmark) => void) {
    super(app);
    this.setPlaceholder(L({ ko: '이동할 책갈피 이름', en: "Bookmark name to navigate to" }));
    this.emptyStateText = L({ ko: '책갈피가 없습니다.', en: "No bookmarks." });
  }
  getItems(): Bookmark[] { return sortBookmarks(this.bookmarks, 'position'); }
  getItemText(item: Bookmark): string { return item.name; }
  renderSuggestion(match: { item: Bookmark }, element: HTMLElement): void {
    element.createDiv({ text: match.item.name });
    element.createEl('small', { text: bookmarkPositionLabel(match.item) });
  }
  onChooseItem(item: Bookmark): void { this.onChoose(item); }
}
