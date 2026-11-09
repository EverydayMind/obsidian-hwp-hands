import { safeSvg } from '../../svg';

export interface SvgObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

interface PageImageUrl {
  url: string;
  revoke: (url: string) => void;
}

/** Displays a sanitized page SVG as an image and owns its object URL lifecycle. */
export class SvgPageImages {
  /** Optional internal diagnostics; never participates in rendering or the public API. */
  onTiming?: (phase: 'sanitize' | 'dom' | 'decode' | 'unchanged', milliseconds: number, page: number) => void;
  private readonly urls = new Map<number, PageImageUrl>();
  private readonly sources = new Map<number, { source: string; element: HTMLElement }>();
  private readonly loads = new Map<number, { promise: Promise<void>; resolve: () => void }>();

  constructor(private readonly owner: Document, private readonly objectUrls?: SvgObjectUrlApi) {}

  /** Resolves once the image last mounted for the page has loaded or failed, or has been replaced or released. */
  settled(page: number): Promise<void> {
    return this.loads.get(page)?.promise ?? Promise.resolve();
  }

  mount(page: number, element: HTMLElement, source: string, label: string, imageClass = 'hwp-page-image'): boolean {
    const previousSource = this.sources.get(page);
    if (previousSource?.element === element && previousSource.source === source && element.hasChildNodes()) {
      this.timing('unchanged', 0, page); return true;
    }
    this.settle(page);
    const sanitizeStarted = performance.now();
    const sanitized = safeSvg(source, this.owner);
    this.timing('sanitize', performance.now() - sanitizeStarted, page);
    const domStarted = performance.now();
    const svg = sanitized.querySelector('svg');
    if (!svg) {
      this.release(page);
      element.replaceChildren(sanitized);
      return false;
    }
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    // This tree remains detached while the image loads. Reuse it on failure instead of cloning every page eagerly.
    const inlineFallback = svg;
    const view = this.owner.defaultView;
    const urls = this.objectUrls ?? (view?.URL && typeof view.URL.createObjectURL === 'function' ? view.URL : undefined);
    const Serializer = view?.XMLSerializer;
    const BlobType = view?.Blob;
    if (!urls || !Serializer || !BlobType) {
      this.release(page);
      element.replaceChildren(sanitized);
      this.sources.set(page, { source, element });
      return false;
    }

    let url: string;
    try {
      const serialized = new Serializer().serializeToString(svg);
      url = urls.createObjectURL(new BlobType([serialized], { type: 'image/svg+xml;charset=utf-8' }));
    } catch {
      this.release(page);
      element.replaceChildren(sanitized);
      this.sources.set(page, { source, element });
      return false;
    }

    const previous = this.urls.get(page);
    this.urls.set(page, { url, revoke: urls.revokeObjectURL.bind(urls) });
    const image = this.owner.createElement('img');
    let decodeStarted: number, resolveLoad!: () => void;
    const load = { promise: new Promise<void>(resolve => { resolveLoad = resolve; }), resolve: () => resolveLoad() };
    this.loads.set(page, load);
    image.addEventListener('load', () => { this.timing('decode', performance.now() - decodeStarted, page); this.settle(page, load); }, { once: true });
    image.className = imageClass;
    image.alt = label;
    image.draggable = false;
    image.addEventListener('error', () => {
      this.settle(page, load);
      if (this.urls.get(page)?.url !== url || !element.contains(image)) return;
      this.release(page);
      element.replaceChildren(inlineFallback);
    }, { once: true });
    element.replaceChildren(image);
    decodeStarted = performance.now();
    image.src = url;
    if (previous) this.revoke(previous);
    this.sources.set(page, { source, element });
    this.timing('dom', performance.now() - domStarted, page);
    return true;
  }

  release(page: number): void {
    this.settle(page);
    this.sources.delete(page);
    const current = this.urls.get(page);
    if (!current) return;
    this.urls.delete(page);
    this.revoke(current);
  }

  dispose(): void {
    for (const page of this.urls.keys()) this.release(page);
    for (const page of [...this.loads.keys()]) this.settle(page);
  }

  /** Resolves the page's pending load; with `load`, only while that load is still the page's current one. */
  private settle(page: number, load = this.loads.get(page)): void {
    if (!load) return;
    if (this.loads.get(page) === load) this.loads.delete(page);
    load.resolve();
  }

  private revoke(record: PageImageUrl): void {
    try { record.revoke(record.url); } catch { /* Revocation after the owning window closes is harmless. */ }
  }
  private timing(phase: 'sanitize' | 'dom' | 'decode' | 'unchanged', milliseconds: number, page: number): void {
    try { this.onTiming?.(phase, milliseconds, page); } catch { /* Diagnostics cannot interrupt rendering. */ }
  }
}
