import type { WorkspaceLeaf } from 'obsidian';
import type HwpHandsPlugin from './main';
import { HwpView, VIEW_TYPE } from './view';

export const EDITOR_VIEW_TYPE = 'hwp-hands-focused-view';
export const PREVIOUS_VIEW_TYPES = ['hwp-editor-focused-view', 'hwp-editor-view'] as const;

/** A page-first FileView that keeps the shared manager session and inline editor. */
export class HwpHandsView extends HwpView {
  constructor(leaf: WorkspaceLeaf, plugin: HwpHandsPlugin) { super(leaf, plugin); }
  getViewType(): string { return EDITOR_VIEW_TYPE; }
  async onOpen(): Promise<void> {
    this.contentEl.addClass('hwp-hands-document-focused');
    await super.onOpen();
  }
}

/**
 * The compatibility screen with the structure editing panel was removed in 0.3.0. Workspaces saved with its view type still restore
 * into this page-first view, and the plugin moves those leaves to EDITOR_VIEW_TYPE once the layout is ready.
 */
export class LegacyHwpView extends HwpHandsView {
  getViewType(): string { return VIEW_TYPE; }
}

/** Read old workspace layouts once; all new persisted leaves use HWP Hands identifiers. */
export class PreviousHwpView extends HwpHandsView {
  constructor(leaf: WorkspaceLeaf, plugin: HwpHandsPlugin, private previousType: string) { super(leaf, plugin); }
  getViewType(): string { return this.previousType; }
}
