import { Notice, type App, type Menu, type TFile, type WorkspaceLeaf } from 'obsidian';

/** The file explorer's rename prompt. FileManager has it on every supported Obsidian version but does not declare it. */
type RenamePrompt = { promptForFileRename?: (file: TFile) => unknown };

/** The path the file explorer gives a copy: `name 1.ext`, `name 2.ext`, … beside the original. */
export function availableCopyPath(file: Pick<TFile, 'path' | 'name' | 'basename' | 'extension'>, exists: (path: string) => boolean): string {
  const folder = file.path.slice(0, file.path.length - file.name.length);
  for (let index = 1; ; index++) {
    const path = `${folder}${file.basename} ${index}.${file.extension}`;
    if (!exists(path)) return path;
  }
}

/**
 * Fills a document tab's 다른 옵션 (⋯) and tab-header menus with the file explorer's file items, then passes the menu on as a file
 * menu, as Obsidian's own file views do. A plain FileView does neither, so the tab offered only its split commands.
 * Opening to the right is left out: the split commands above already do it.
 */
export function addFilePaneMenuItems(app: App, menu: Menu, file: TFile, source: string, leaf: WorkspaceLeaf, options: {
  /** Whether the open document has edits its disk file lacks. The copy, as in the file explorer, is made from the disk file. */
  unsaved: () => boolean;
  report: (error: unknown) => void;
}): void {
  const run = (action: () => Promise<unknown>) => (): void => { void action().catch(options.report); };
  menu.addItem(item => item.setSection('open').setTitle('새 탭에서 열기').setIcon('lucide-file-plus')
    .onClick(run(() => app.workspace.duplicateLeaf(leaf, 'tab'))));
  menu.addItem(item => item.setSection('action').setTitle('복사본 생성').setIcon('lucide-files').onClick(run(async () => {
    const path = availableCopyPath(file, path => !!app.vault.getAbstractFileByPath(path));
    const copyFile = (app.vault as unknown as { copy?: (file: TFile, path: string) => Promise<TFile> }).copy;
    const copy = typeof copyFile === 'function'
      ? await copyFile.call(app.vault, file, path)
      : await app.vault.createBinary(path, await app.vault.readBinary(file));
    new Notice(options.unsaved()
      ? `디스크에 저장된 내용으로 복사본을 만들었습니다: ${copy.path}\n저장하지 않은 편집은 들어 있지 않습니다.`
      : `복사본을 만들었습니다: ${copy.path}`);
  })));
  const fileManager = app.fileManager as App['fileManager'] & RenamePrompt;
  if (typeof fileManager.promptForFileRename === 'function') {
    menu.addItem(item => item.setSection('action').setTitle('이름 변경').setIcon('lucide-edit-3').onClick(() => fileManager.promptForFileRename!(file)));
  }
  menu.addItem(item => item.setSection('danger').setTitle('파일 삭제').setIcon('lucide-trash-2').setWarning(true)
    .onClick(run(() => app.fileManager.promptForDeletion(file))));
  app.workspace.trigger('file-menu', menu, file, source, leaf);
}
