import { MarkdownRenderChild, type App, type MarkdownPostProcessorContext, type TFile } from 'obsidian';
import type { HwpHandsApiV1 } from './api';
import type { DocumentManager } from './manager';
import { parseHwpLinkText, type HwpLinkTarget } from './hwp-links';
import { safeSvg } from './svg';

export interface HwpMarkdownHost {
  app: App;
  api: HwpHandsApiV1;
  manager: DocumentManager;
  openInEditor(file: TFile, target?: HwpLinkTarget): Promise<void>;
  report(error: unknown): void;
}

function isHwpFile(file: TFile | null): file is TFile {
  return !!file && /^(hwp|hwpx)$/i.test(file.extension);
}

function findHwpFile(app: App, linkText: string, sourcePath: string): { file: TFile; target?: HwpLinkTarget } | undefined {
  const parsed = parseHwpLinkText(linkText);
  if (!parsed) return undefined;
  const file = app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath);
  return isHwpFile(file) ? { file, target: parsed.target } : undefined;
}

interface RoutedLink { anchor: HTMLAnchorElement; file: TFile; target: HwpLinkTarget }

class HwpLinkRouteChild extends MarkdownRenderChild {
  private readonly handlers = new Map<HTMLAnchorElement, (event: MouseEvent) => void>();
  constructor(container: HTMLElement, private readonly host: HwpMarkdownHost, private readonly links: RoutedLink[]) { super(container); }
  onload(): void {
    for (const { anchor, file, target } of this.links) {
      const handler = (event: MouseEvent): void => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); event.stopPropagation();
        void this.host.openInEditor(file, target).catch(error => this.host.report(error));
      };
      this.handlers.set(anchor, handler);
      anchor.addEventListener('click', handler);
    }
  }
  onunload(): void {
    for (const [anchor, handler] of this.handlers) anchor.removeEventListener('click', handler);
    this.handlers.clear();
  }
}

class HwpEmbedPreview extends MarkdownRenderChild {
  private disposed = false;
  private releaseLease?: () => Promise<void>;
  private renderTask: Promise<void> = Promise.resolve();
  private openHandler?: () => void;
  constructor(container: HTMLElement, private readonly host: HwpMarkdownHost, private readonly file: TFile, private readonly page: number) { super(container); }
  onload(): void { this.renderTask = this.render(); }
  onunload(): void {
    this.disposed = true;
    if (this.openHandler) this.containerEl.querySelector('button')?.removeEventListener('click', this.openHandler);
    void this.renderTask.then(() => this.release(), () => this.release());
  }
  private async release(): Promise<void> {
    const release = this.releaseLease; this.releaseLease = undefined;
    if (release) await release();
  }
  private async render(): Promise<void> {
    try {
      const lease = await this.host.manager.retainView(this.file.path);
      if (this.disposed) { await lease.release(); return; }
      this.releaseLease = () => lease.release();
      const rendered = await this.host.api.render.page(this.file.path, this.page);
      if (this.disposed) return;
      const document = this.containerEl.ownerDocument;
      const card = document.createElement('div'); card.className = 'hwp-embed-preview';
      const title = document.createElement('div'); title.className = 'hwp-embed-title';
      title.textContent = `${this.file.basename} · ${this.page + 1}쪽 미리보기`;
      const page = document.createElement('div'); page.className = 'hwp-embed-page';
      const projection = safeSvg(rendered.svg, document);
      const svg = projection.querySelector('svg');
      if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${this.file.name} ${this.page + 1}쪽 읽기 전용 미리보기`); }
      page.append(projection);
      const open = document.createElement('button'); open.type = 'button'; open.textContent = '편집기로 열기';
      this.openHandler = () => { void this.host.openInEditor(this.file, { page: this.page + 1 }).catch(error => this.host.report(error)); };
      open.addEventListener('click', this.openHandler);
      card.append(title, page, open);
      this.containerEl.replaceChildren(card);
    } catch (error) {
      if (this.disposed) return;
      await this.release();
      const message = this.containerEl.ownerDocument.createElement('div');
      message.className = 'hwp-embed-error'; message.textContent = `HWP 미리보기를 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      this.containerEl.replaceChildren(message);
    }
  }
}

/** Routes deep links and replaces HWP embeds with a sanitized, read-only first-page projection. */
export function processHwpMarkdown(host: HwpMarkdownHost, element: HTMLElement, context: MarkdownPostProcessorContext): void {
  const routed: RoutedLink[] = [];
  const anchors = [...(element.matches('a.internal-link, a[href]') ? [element as HTMLAnchorElement] : []), ...element.querySelectorAll<HTMLAnchorElement>('a.internal-link, a[href]')];
  for (const anchor of anchors) {
    if (anchor.closest('.internal-embed')) continue;
    const linkText = anchor.dataset.href ?? anchor.getAttribute('href') ?? '';
    const target = findHwpFile(host.app, linkText, context.sourcePath);
    if (target?.target) routed.push({ anchor, file: target.file, target: target.target });
  }
  if (routed.length) context.addChild(new HwpLinkRouteChild(element, host, routed));

  const embeds = [...(element.matches('.internal-embed') ? [element] : []), ...element.querySelectorAll<HTMLElement>('.internal-embed')];
  for (const embed of embeds) {
    const linkText = embed.dataset.href ?? embed.dataset.src ?? embed.getAttribute('src') ?? embed.getAttribute('href') ?? '';
    const target = findHwpFile(host.app, linkText, context.sourcePath);
    if (!target) continue;
    embed.classList.add('hwp-embed-container');
    context.addChild(new HwpEmbedPreview(embed, host, target.file, Math.max(0, (target.target?.page ?? 1) - 1)));
  }
}
