import { LT, L } from '../../i18n/locale';
import { SvgPageImages } from '../page/svg-page-images';
import type { FormValues } from './form-values';

/** A read-only dialog preview: a later edit or closing the dialog invalidates pending render results. */
export class DialogSvgPreview {
  private readonly images: SvgPageImages;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private disposed = false;
  constructor(private readonly element: HTMLElement, private readonly render: (values: FormValues) => Promise<string | undefined>, private readonly delay = 220) {
    this.images = new SvgPageImages(element.ownerDocument);
  }
  update(values: FormValues): void {
    if (this.disposed) return;
    const sequence = ++this.sequence;
    if (this.timer) clearTimeout(this.timer);
    this.images.release(0);
    this.element.textContent = L({ ko: '수식 미리보기를 만드는 중…', en: "Creating equation preview…" });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.render({ ...values }).then(svg => {
        if (this.disposed || sequence !== this.sequence) return;
        if (svg) this.images.mount(0, this.element, svg, L({ ko: '수식 미리보기', en: "Equation preview" }), 'hwp-equation-preview-image');
        else this.element.replaceChildren();
      }).catch(error => {
        if (this.disposed || sequence !== this.sequence) return;
        this.element.textContent = LT({ ko: () => `수식 미리보기를 만들 수 없습니다: ${error instanceof Error ? error.message : String(error)}`, en: () => `Cannot create equation preview: ${error instanceof Error ? error.message : String(error)}` });
      });
    }, this.delay);
  }
  dispose(): void {
    this.disposed = true; this.sequence++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.images.dispose(); this.element.replaceChildren();
  }
}
