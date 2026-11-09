export type InputReceiverPlacement = 'caret' | 'line';
/** Direct page editing is the only input mode since 0.3.0; these choose where its hidden receiver sits and whether drafts preview. */
export interface InputModeSettings {
  inputReceiverPlacement: InputReceiverPlacement;
  editPreviewEnabled: boolean;
}
export const DEFAULT_INPUT_MODE: InputModeSettings = { inputReceiverPlacement: 'caret', editPreviewEnabled: true };
export function normalizeInputMode(value: Partial<InputModeSettings> | undefined): InputModeSettings {
  return {
    inputReceiverPlacement: value?.inputReceiverPlacement === 'line' ? 'line' : 'caret',
    editPreviewEnabled: value?.editPreviewEnabled !== false,
  };
}
