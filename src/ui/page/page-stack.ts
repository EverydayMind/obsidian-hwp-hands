import { releaseCanvases } from '../../canvas-page';
export interface PageStackEntry {
  slot: HTMLElement;
  page: HTMLElement;
}

export type PageStackRenderer = (page: number, element: HTMLElement, isCurrent: () => boolean) => Promise<boolean>;

interface ManagedPage extends PageStackEntry {
  token: number;
  renderedRevision?: number;
  renderingRevision?: number;
  renderTask?: Promise<void>;
  staleVisible?: boolean;
}

/** Scrolling coalesces render requests: the worker answers in order and cannot cancel, so stale windows must never be queued. */
const SCROLL_RENDER_DELAY_MS = 90;
const RASTER_SETTLE_MS = 120;
/** A hidden window pauses animation frames and may hold image loads; neighbours then wait no longer than this. */
export const NEIGHBOUR_PAINT_WAIT_LIMIT_MS = 250;
export const INPUT_FRAME_GUARD_MS = 50;
const documentInputAt = new WeakMap<Document, number>();

/** All HWP leaves in the same browser document share the input's paint opportunity. */
export function markDocumentInput(owner: Document): void { documentInputAt.set(owner, performance.now()); }
export function documentInputNeedsPaint(owner: Document, viewInputAt: number): boolean {
  return performance.now() - Math.max(viewInputAt, documentInputAt.get(owner) ?? -Infinity) < INPUT_FRAME_GUARD_MS;
}

type PaintTimers = Pick<Window, 'setTimeout' | 'clearTimeout' | 'requestAnimationFrame'>;

/**
 * Resolves in a task after the active page's image has shown and two frames have begun, or after `limitMs`.
 * Mounting a neighbour sanitises and decodes a whole page SVG, which is a long main-thread task; run before the edited page is
 * presented, it pushes that page back by about 100 ms on a small document. The second frame callback runs only once the frame
 * after the image load has been painted, so the decoded image is on screen before the neighbour starts.
 */
export function afterActivePagePaint(shown: Promise<void>, timers: PaintTimers, limitMs = NEIGHBOUR_PAINT_WAIT_LIMIT_MS): Promise<void> {
  return new Promise(resolve => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true; timers.clearTimeout(limit);
      timers.setTimeout(resolve, 0);
    };
    const limit = timers.setTimeout(finish, limitMs);
    void shown.then(() => timers.requestAnimationFrame(() => timers.requestAnimationFrame(finish)), finish);
  });
}

/** Keeps page placeholders for the document, but mounts SVG only near the viewport. */
export class PageStack {
  private readonly pages: ManagedPage[] = [];
  private activePage = 0;
  private pageCount = 0;
  private revision = -1;
  private renderer?: PageStackRenderer;
  private scrollFrame = 0;
  private scrollRenderTimer = 0;
  private rasterTimer = 0;
  private inFlight = 0;
  private intersectionObserver?: IntersectionObserver;
  private readonly visiblePages = new Map<number, number>();
  private scalePercent?: number;
  private widthByPage = new Map<number, number>();
  private onActivate?: (page: number, element: HTMLElement) => void;
  private onUnmount?: (page: number) => void;
  private onScaleChange?: (percent?: number) => void;
  private onRenderError?: (error: unknown, page: number) => void;
  private onMount?: (page: number, element: HTMLElement) => void;
  private readonly handleScroll = (): void => {
    if (this.scrollFrame) return;
    const view = this.scroll.ownerDocument.defaultView;
    const request = view?.requestAnimationFrame?.bind(view) ?? ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number);
    this.scrollFrame = request(() => {
      this.scrollFrame = 0;
      this.activateMostVisiblePage();
    });
  };

  constructor(private readonly scroll: HTMLElement, callbacks: {
    onActivate?: (page: number, element: HTMLElement) => void;
    onUnmount?: (page: number) => void;
    onMount?: (page: number, element: HTMLElement) => void;
    onScaleChange?: (percent?: number) => void;
    onRenderError?: (error: unknown, page: number) => void;
  } = {}) {
    this.onActivate = callbacks.onActivate;
    this.onUnmount = callbacks.onUnmount;
    this.onMount = callbacks.onMount;
    this.onScaleChange = callbacks.onScaleChange;
    this.onRenderError = callbacks.onRenderError;
    this.scroll.addEventListener('scroll', this.handleScroll, { passive: true });
    this.scroll.addEventListener('wheel', this.handleWheel, { passive: false });
    const Observer = this.scroll.ownerDocument.defaultView?.IntersectionObserver;
    if (Observer) this.intersectionObserver = new Observer(entries => {
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.page);
        if (!Number.isSafeInteger(page)) continue;
        if (entry.isIntersecting) this.visiblePages.set(page, entry.intersectionRatio);
        else this.visiblePages.delete(page);
      }
      const mostVisible = [...this.visiblePages.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
      if (mostVisible !== undefined && mostVisible !== this.activePage) this.activateFromScroll(mostVisible);
    }, { root: this.scroll, threshold: [0, 0.25, 0.5, 0.75, 1] });
  }

  setRenderer(renderer: PageStackRenderer): void { this.renderer = renderer; }

  get currentPage(): number { return this.activePage; }
  get currentElement(): HTMLElement | undefined { return this.pages[this.activePage]?.page; }
  get mountedCount(): number { return this.pages.filter(item => item.renderedRevision === this.revision).length; }

  setDocument(pageCount: number, revision: number, changedPages?: readonly number[], activePage?: number): void {
    const count = Math.max(1, Math.trunc(pageCount));
    const revisionChanged = revision !== this.revision;
    const oldCount = this.pageCount;
    this.pageCount = count;
    this.revision = revision;
    this.activePage = Math.max(0, Math.min(activePage ?? this.activePage, count - 1));

    while (this.pages.length < count) this.pages.push(this.createPage(this.pages.length));
    while (this.pages.length > count) {
      const page = this.pages.pop()!;
      this.dropPage(page, this.pages.length);
    }

    if (revisionChanged) {
      const invalid = changedPages ? new Set(changedPages) : undefined;
      for (let index = 0; index < this.pages.length; index++) {
        const entry = this.pages[index];
        if (entry.renderedRevision === undefined && entry.renderingRevision === undefined) continue;
        if (!changedPages || invalid?.has(index)) this.invalidateRevision(entry);
        else if (entry.renderedRevision !== undefined) entry.renderedRevision = revision;
      }
    }
    if (oldCount !== count) this.applyScale();
    this.onActivate?.(this.activePage, this.pages[this.activePage].page);
    void this.renderAroundActivePage();
  }

  setActivePage(page: number, scrollIntoView = false, render = true, until: 'all' | 'active' = 'all'): Promise<void> {
    const target = Math.max(0, Math.min(Math.trunc(page), Math.max(0, this.pageCount - 1)));
    this.activePage = target;
    if (scrollIntoView) this.scrollToPage(target);
    this.onActivate?.(target, this.pages[target].page);
    return render ? this.renderAroundActivePage(until) : Promise.resolve();
  }

  pageForTarget(target: EventTarget | null): number | undefined {
    if (!(target instanceof this.scroll.ownerDocument.defaultView!.Element)) return undefined;
    const page = target.closest<HTMLElement>('.hwp-page[data-page]');
    if (!page || !this.scroll.contains(page)) return undefined;
    const index = Number(page.dataset.page);
    return Number.isSafeInteger(index) && index >= 0 && index < this.pageCount ? index : undefined;
  }

  pageElement(page: number): HTMLElement | undefined { return this.pages[page]?.page; }

  mountedPages(): Array<{ page: number; element: HTMLElement }> {
    return this.pages.flatMap((entry, page) => entry.renderedRevision === this.revision ? [{ page, element: entry.page }] : []);
  }

  invalidateAll(): Promise<void> {
    for (let index = 0; index < this.pages.length; index++) {
      const entry = this.pages[index];
      if (entry.renderedRevision !== undefined || entry.renderingRevision !== undefined) this.clearPage(entry, index);
    }
    return this.renderAroundActivePage();
  }

  /**
   * Re-renders mounted pages at the current raster scale. The previous surface stays visible, stretched by CSS, until its
   * replacement arrives, and a burst of zoom steps produces one Worker render per page instead of one per step.
   */
  rerasterize(): void {
    const view = this.scroll.ownerDocument.defaultView;
    if (this.rasterTimer) { if (view) view.clearTimeout(this.rasterTimer); else clearTimeout(this.rasterTimer); }
    const fire = (): void => {
      this.rasterTimer = 0;
      for (const entry of this.pages) if (entry.renderedRevision !== undefined || entry.renderingRevision !== undefined) this.invalidateRevision(entry);
      void this.renderAroundActivePage().catch(error => this.onRenderError?.(error, this.activePage));
    };
    this.rasterTimer = view ? view.setTimeout(fire, RASTER_SETTLE_MS) : setTimeout(fire, RASTER_SETTLE_MS) as unknown as number;
  }

  pageAtPoint(clientX: number, clientY: number): number | undefined {
    const from = Math.max(0, this.activePage - 1), to = Math.min(this.pageCount - 1, this.activePage + 1);
    for (let page = from; page <= to; page++) {
      const bounds = this.pages[page]?.page.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0
        && clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom) return page;
    }
    return undefined;
  }

  setPageSize(page: number, width: number, height: number): void {
    const entry = this.pages[page];
    if (!entry || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    this.widthByPage.set(page, width);
    entry.page.style.aspectRatio = `${width} / ${height}`;
    this.applyPageScale(page);
  }

  setScale(percent?: number): void {
    const next = percent === undefined ? undefined : Math.max(50, Math.min(500, percent));
    if (next === this.scalePercent) return;
    this.scalePercent = next;
    this.applyScale();
    this.onScaleChange?.(this.scalePercent);
  }

  fitPage(width: number, height: number): number {
    const availableWidth = Math.max(100, this.scroll.clientWidth - 36);
    const availableHeight = Math.max(100, this.scroll.clientHeight - 36);
    const percent = Math.max(50, Math.min(500, Math.floor(Math.min(availableWidth / width, availableHeight / height) * 100 / 10) * 10));
    this.setScale(percent);
    return percent;
  }

  restoreScrollTop(scrollTop: number): void {
    if (Number.isFinite(scrollTop) && scrollTop >= 0) this.scroll.scrollTop = scrollTop;
  }

  get scrollTop(): number { return this.scroll.scrollTop; }

  rasterScale(page: number): number {
    const width = this.widthByPage.get(page) ?? 794;
    const cssScale = this.scalePercent === undefined ? (this.pages[page]?.page.clientWidth || width) / width : this.scalePercent / 100;
    return Math.max(0.1, cssScale * (this.scroll.ownerDocument.defaultView?.devicePixelRatio || 1));
  }

  dispose(): void {
    this.scroll.removeEventListener('scroll', this.handleScroll);
    this.scroll.removeEventListener('wheel', this.handleWheel);
    if (this.rasterTimer) { const view = this.scroll.ownerDocument.defaultView; if (view) view.clearTimeout(this.rasterTimer); else clearTimeout(this.rasterTimer); this.rasterTimer = 0; }
    if (this.scrollRenderTimer) { const view = this.scroll.ownerDocument.defaultView; if (view) view.clearTimeout(this.scrollRenderTimer); else clearTimeout(this.scrollRenderTimer); this.scrollRenderTimer = 0; }
    this.intersectionObserver?.disconnect(); this.intersectionObserver = undefined; this.visiblePages.clear();
    if (this.scrollFrame) this.scroll.ownerDocument.defaultView?.cancelAnimationFrame?.(this.scrollFrame);
    this.pages.forEach((entry, index) => this.dropPage(entry, index));
    this.pages.length = 0;
  }

  /**
   * Mounts the active page and its neighbours. The active page is requested first so the worker answers it first;
   * `until: 'active'` lets a caller resume as soon as the page being edited is on screen while neighbours finish in the background.
   */
  async renderAroundActivePage(until: 'all' | 'active' = 'all'): Promise<void> {
    const active = this.activePage, from = Math.max(0, active - 1), to = Math.min(this.pageCount - 1, active + 1);
    for (let index = 0; index < this.pages.length; index++) {
      const entry = this.pages[index];
      if ((index < from || index > to) && (entry.renderedRevision !== undefined || entry.renderingRevision !== undefined || entry.staleVisible)) this.clearPage(entry, index);
    }
    const pending: Promise<void>[] = [];
    let activeTask: Promise<void> | undefined;
    for (const index of [active, active + 1, active - 1]) {
      const entry = this.pages[index];
      if (!entry || index < from || index > to || entry.renderedRevision === this.revision) continue;
      if (entry.renderingRevision === this.revision && entry.renderTask) {
        pending.push(entry.renderTask);
        if (index === active) activeTask = entry.renderTask;
        continue;
      }
      const renderer = this.renderer;
      if (!renderer) continue;
      const revision = this.revision;
      const token = ++entry.token;
      entry.renderingRevision = revision;
      this.inFlight++;
      const isCurrent = (): boolean => entry.token === token && entry.renderingRevision === revision
        && this.revision === revision && index >= Math.max(0, this.activePage - 1) && index <= Math.min(this.pageCount - 1, this.activePage + 1);
      const task = renderer(index, entry.page, isCurrent).catch(error => {
        this.onRenderError?.(error, index);
        return false;
      }).then(mounted => {
        if (mounted && isCurrent()) { entry.renderedRevision = revision; entry.staleVisible = false; this.onMount?.(index, entry.page); }
      }).finally(() => {
        this.inFlight--;
        if (entry.token === token) { entry.renderingRevision = undefined; entry.renderTask = undefined; }
      });
      entry.renderTask = task;
      pending.push(task);
      if (index === active) activeTask = task;
    }
    if (until === 'active' && activeTask) {
      // Neighbours are not awaited, so their failures must be reported here instead of surfacing as unhandled rejections.
      for (const task of pending) if (task !== activeTask) task.catch(error => this.onRenderError?.(error, active));
      await activeTask;
    } else await Promise.all(pending);
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.deltaY === 0) return;
    event.preventDefault();
    const activePage = this.activePage;
    const page = this.pages[activePage]?.page;
    const nativeWidth = this.widthByPage.get(activePage);
    if (!page || !nativeWidth) return;
    const bounds = page.getBoundingClientRect();
    const currentScale = this.scalePercent ?? (bounds.width > 0 ? bounds.width / nativeWidth * 100 : 100);
    const nextScale = Math.max(50, Math.min(500, Math.round((currentScale + (event.deltaY < 0 ? 10 : -10)) / 10) * 10));
    const underPointer = this.pages.findIndex(entry => {
      const rect = entry.page.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    const anchorEntry = this.pages[underPointer >= 0 ? underPointer : activePage];
    const anchorBounds = anchorEntry.page.getBoundingClientRect();
    const anchorX = anchorBounds.width > 0 ? Math.max(0, Math.min(1, (event.clientX - anchorBounds.left) / anchorBounds.width)) : 0.5;
    const anchorY = anchorBounds.height > 0 ? Math.max(0, Math.min(1, (event.clientY - anchorBounds.top) / anchorBounds.height)) : 0.5;
    this.setScale(nextScale);
    const resized = anchorEntry.page.getBoundingClientRect();
    if (resized.width > 0 && resized.height > 0) {
      this.scroll.scrollLeft += resized.left + anchorX * resized.width - event.clientX;
      this.scroll.scrollTop += resized.top + anchorY * resized.height - event.clientY;
    }
  };

  private createPage(index: number): ManagedPage {
    const document = this.scroll.ownerDocument;
    const slot = document.createElement('div');
    slot.className = 'hwp-page-slot';
    slot.dataset.page = String(index);
    slot.setAttribute('aria-label', `${index + 1}쪽`);
    const page = document.createElement('div');
    page.className = 'hwp-page';
    page.dataset.page = String(index);
    const content = document.createElement('div');
    content.className = 'hwp-page-content';
    page.append(content);
    slot.append(page);
    const entry: ManagedPage = { slot, page, token: 0 };
    this.scroll.append(slot);
    this.intersectionObserver?.observe(slot);
    this.applyPageScale(index);
    return entry;
  }

  private clearPage(entry: ManagedPage, index: number): void {
    this.invalidateRevision(entry);
    entry.staleVisible = false;
    const content = entry.page.querySelector<HTMLElement>(':scope > .hwp-page-content');
    if (content) {
      releaseCanvases(content);
      content.replaceChildren();
      for (const child of Array.from(entry.page.children)) if (child !== content) child.remove();
    } else entry.page.replaceChildren();
    this.onUnmount?.(index);
  }

  /** Mark a page stale while leaving its previous image visible until the new render is ready. */
  private invalidateRevision(entry: ManagedPage): void {
    entry.staleVisible = !!entry.page.querySelector(':scope > .hwp-page-content')?.hasChildNodes();
    entry.token++;
    entry.renderedRevision = undefined;
    entry.renderingRevision = undefined;
    entry.renderTask = undefined;
  }

  private dropPage(entry: ManagedPage, index: number): void {
    this.clearPage(entry, index);
    this.intersectionObserver?.unobserve(entry.slot);
    this.visiblePages.delete(index);
    entry.slot.remove();
    this.widthByPage.delete(index);
  }

  private scrollToPage(page: number): void {
    const entry = this.pages[page];
    if (!entry) return;
    const scrollBounds = this.scroll.getBoundingClientRect();
    const slotBounds = entry.slot.getBoundingClientRect();
    if (scrollBounds.height && slotBounds.height) this.scroll.scrollTop += slotBounds.top - scrollBounds.top - 12;
    else this.scroll.scrollTop = page === 0 ? 0 : this.scroll.scrollTop;
  }

  private activateMostVisiblePage(): void {
    if (!this.pageCount || this.intersectionObserver) return;
    const bounds = this.scroll.getBoundingClientRect();
    const center = bounds.top + (bounds.height ? bounds.height / 2 : 0);
    let best = this.activePage, distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.pages.length; index++) {
      const rect = this.pages[index].slot.getBoundingClientRect();
      if (bounds.height && (rect.bottom < bounds.top || rect.top > bounds.bottom)) continue;
      const nextDistance = Math.abs((rect.top + rect.bottom) / 2 - center);
      if (nextDistance < distance) { best = index; distance = nextDistance; }
    }
    if (best !== this.activePage) this.activateFromScroll(best);
  }

  /** Scroll-driven activation updates the active page at once but renders the window later, at most one window in flight. */
  private activateFromScroll(page: number): void {
    void this.setActivePage(page, false, false);
    this.scheduleScrollRender();
  }

  private scheduleScrollRender(): void {
    if (this.scrollRenderTimer) return;
    const view = this.scroll.ownerDocument.defaultView;
    const schedule = (callback: () => void): number => (view ? view.setTimeout(callback, SCROLL_RENDER_DELAY_MS) : setTimeout(callback, SCROLL_RENDER_DELAY_MS) as unknown as number);
    const fire = (): void => {
      this.scrollRenderTimer = 0;
      if (this.inFlight > 0) { this.scrollRenderTimer = schedule(fire); return; }
      void this.renderAroundActivePage().catch(error => this.onRenderError?.(error, this.activePage));
    };
    this.scrollRenderTimer = schedule(fire);
  }

  private applyScale(): void { for (let index = 0; index < this.pages.length; index++) this.applyPageScale(index); }

  private applyPageScale(index: number): void {
    const page = this.pages[index]?.page;
    if (!page) return;
    const width = this.widthByPage.get(index);
    page.style.width = width && this.scalePercent !== undefined ? `${width * this.scalePercent / 100}px` : '';
  }
}
