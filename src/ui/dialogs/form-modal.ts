import { Notice, type App } from 'obsidian';
import { FocusReturnModal } from './index';
import { initialFormValues, parseFormValues, type FormField, type FormValue, type FormValues } from './form-values';
import { DialogSvgPreview } from './svg-preview';

export interface FormModalOptions {
  title: string;
  hint?: string;
  fields: readonly FormField[];
  submitLabel?: string;
  /** Extra cross-field validation after each field parsed cleanly. Return a message to block applying. */
  validate?: (values: FormValues) => string | undefined;
  preview?: (values: FormValues) => Promise<string | undefined>;
}

/** Generic labelled form dialog used by the page, section, bookmark and table dialogs. */
export class FormModal extends FocusReturnModal {
  private preview?: DialogSvgPreview;
  constructor(app: App, private readonly options: FormModalOptions, private readonly action: (values: FormValues) => Promise<void>) { super(app); }
  onOpen(): void {
    const { options } = this;
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: options.title });
    if (options.hint) this.contentEl.createEl('p', { cls: 'hwp-hint', text: options.hint });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    const rows = new Map<string, HTMLElement>();
    const read = (): Record<string, FormValue> => {
      const raw: Record<string, FormValue> = {};
      for (const field of options.fields) {
        const element = inputs.get(field.key)!;
        raw[field.key] = field.kind === 'checkbox' ? (element as HTMLInputElement).checked : element.value;
      }
      return raw;
    };
    const refreshEnabled = (): void => {
      const current = parseFormValues(options.fields.map(field => ({ ...field, enabledWhen: undefined })), read()).values;
      for (const field of options.fields) {
        const enabled = field.enabledWhen ? field.enabledWhen({ ...initialFormValues(options.fields), ...current }) : true;
        inputs.get(field.key)!.disabled = !enabled;
        rows.get(field.key)!.toggleClass('hwp-format-dialog-row-disabled', !enabled);
      }
      this.preview?.update(current);
    };
    for (const field of options.fields) {
      const row = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
      rows.set(field.key, row);
      const id = `hwp-form-${field.key}`;
      if (field.kind === 'checkbox') {
        row.addClass('hwp-format-dialog-check');
        const input = row.createEl('input', { type: 'checkbox', attr: { id, 'aria-label': field.label } });
        input.checked = field.value; inputs.set(field.key, input);
        row.createEl('label', { text: field.label, attr: { for: id } });
      } else {
        row.createEl('label', { text: field.kind === 'number' && field.unit ? `${field.label} (${field.unit})` : field.label, attr: { for: id } });
        if (field.kind === 'select') {
          const select = row.createEl('select', { attr: { id, 'aria-label': field.label } });
          for (const [value, label] of field.options) select.createEl('option', { value, text: label });
          select.value = field.value; inputs.set(field.key, select);
        } else if (field.kind === 'number') {
          inputs.set(field.key, row.createEl('input', { type: 'number', value: String(field.value), attr: {
            id, 'aria-label': field.label, ...(field.min !== undefined ? { min: String(field.min) } : {}), ...(field.max !== undefined ? { max: String(field.max) } : {}), step: String(field.step ?? (field.integer ? 1 : 'any')),
          } }));
        } else if (field.kind === 'color') {
          inputs.set(field.key, row.createEl('input', { type: 'color', value: field.value, attr: { id, 'aria-label': field.label } }));
        } else if (field.rows) {
          const input = row.createEl('textarea', { attr: { id, 'aria-label': field.label, rows: String(field.rows), ...(field.maxLength ? { maxlength: String(field.maxLength) } : {}) } });
          input.value = field.value; inputs.set(field.key, input);
        } else {
          inputs.set(field.key, row.createEl('input', { type: 'text', value: field.value, attr: { id, 'aria-label': field.label, ...(field.maxLength ? { maxlength: String(field.maxLength) } : {}) } }));
        }
      }
      if (field.hint) row.setAttribute('title', field.hint);
      inputs.get(field.key)!.addEventListener('change', refreshEnabled);
      inputs.get(field.key)!.addEventListener('input', refreshEnabled);
    }
    if (options.preview) this.preview = new DialogSvgPreview(this.contentEl.createDiv({ cls: 'hwp-equation-preview', attr: { role: 'status', 'aria-live': 'polite' } }), options.preview);
    refreshEnabled();
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    buttons.createEl('button', { text: '취소' }).addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { text: options.submitLabel ?? '적용', cls: 'mod-cta' });
    const submit = (): void => {
      if (apply.disabled) return;
      const parsed = parseFormValues(options.fields, read());
      if (parsed.error) { status.setText(parsed.error.message); inputs.get(parsed.error.key)?.focus(); return; }
      const message = options.validate?.(parsed.values);
      if (message) { status.setText(message); return; }
      apply.disabled = true; status.setText('적용하는 중…');
      void this.action(parsed.values).then(() => this.close()).catch(error => {
        status.setText(`적용하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        new Notice(`${options.title}: ${error instanceof Error ? error.message : String(error)}`, 8000);
        apply.disabled = false;
      });
    };
    apply.addEventListener('click', submit);
    this.contentEl.addEventListener('keydown', event => {
      const tag = (event.target as HTMLElement).tagName;
      if (event.key === 'Enter' && !event.isComposing && tag !== 'BUTTON' && tag !== 'SELECT'
        && (tag !== 'TEXTAREA' || event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
    });
    const first = options.fields.map(field => inputs.get(field.key)!).find(element => !element.disabled);
    first?.focus();
  }
  onClose(): void { this.preview?.dispose(); this.preview = undefined; this.contentEl.empty(); this.restoreFocus(); }
}
