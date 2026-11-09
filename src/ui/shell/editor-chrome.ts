export interface EditorChrome {
  menu: boolean;
  basicToolbox: boolean;
  formatToolbox: boolean;
}

export const DEFAULT_EDITOR_CHROME: EditorChrome = {
  menu: true,
  basicToolbox: true,
  formatToolbox: true,
};

/** Migrate the 0.2.x combined visibility switch once, without losing explicit 0.3.x choices. */
export function editorChromeFromSettings(saved: {
  editorChrome?: Partial<EditorChrome>;
  editorPreviewEnabled?: boolean;
}): EditorChrome {
  const legacyVisible = saved.editorPreviewEnabled !== false;
  return {
    menu: saved.editorChrome?.menu ?? legacyVisible,
    basicToolbox: saved.editorChrome?.basicToolbox ?? legacyVisible,
    formatToolbox: saved.editorChrome?.formatToolbox ?? legacyVisible,
  };
}

export function editorChromePreset(chrome: EditorChrome): 'expanded' | 'basic-collapsed' | 'all-collapsed' | 'custom' {
  if (!chrome.menu && !chrome.basicToolbox && !chrome.formatToolbox) return 'all-collapsed';
  if (chrome.menu && !chrome.basicToolbox && chrome.formatToolbox) return 'basic-collapsed';
  if (chrome.menu && chrome.basicToolbox && chrome.formatToolbox) return 'expanded';
  return 'custom';
}
