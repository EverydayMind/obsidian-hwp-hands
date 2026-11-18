import { L, getLocale, type Locale } from '../../i18n/locale';

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

export type EditorChromePreset = 'expanded' | 'basic-collapsed' | 'all-collapsed' | 'custom';

export function editorChromePreset(chrome: EditorChrome): EditorChromePreset {
  if (!chrome.menu && !chrome.basicToolbox && !chrome.formatToolbox) return 'all-collapsed';
  if (chrome.menu && !chrome.basicToolbox && chrome.formatToolbox) return 'basic-collapsed';
  if (chrome.menu && chrome.basicToolbox && chrome.formatToolbox) return 'expanded';
  return 'custom';
}

export interface EditorChromeSelectOption {
  value: EditorChromePreset;
  label: string;
  disabled?: boolean;
}

/** Excludes `'custom'` as a selectable choice while preserving a display-only option if already saved as custom. */
export function editorChromeSelectOptions(chrome: EditorChrome, locale: Locale = getLocale()): EditorChromeSelectOption[] {
  const options: EditorChromeSelectOption[] = [
    { value: 'expanded', label: L({ ko: '모두 펼침', en: "Expand all" }, locale) },
    { value: 'basic-collapsed', label: L({ ko: '기본 도구 상자 접음', en: "Collapse basic toolbox" }, locale) },
    { value: 'all-collapsed', label: L({ ko: '모두 접음', en: "Collapse all" }, locale) },
  ];
  if (editorChromePreset(chrome) === 'custom') {
    options.push({ value: 'custom', label: L({ ko: '개별 설정', en: "Custom settings" }, locale), disabled: true });
  }
  return options;
}
