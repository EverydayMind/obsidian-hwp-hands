import type { ActiveViewContext, EditorViews, HwpHandsApiV1, SelectionRange } from '../../api';
import { HwpHandsError } from '../../api';

export interface ViewContextProbe {
  element: HTMLElement;
  read(): { context: Omit<ActiveViewContext, 'selection'>; range?: SelectionRange } | undefined;
}

/** Tracks actual editor interaction in each owner Document, without stealing focus. */
export class ViewContextService {
  private last?: ViewContextProbe;
  private probes: ViewContextProbe[] = [];
  private detach: Array<() => void> = [];
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  readonly views: EditorViews;

  constructor(private api: HwpHandsApiV1) {
    this.views = {
      activeContext: () => this.capture(),
      list: () => this.probes.flatMap(probe => {
        const context = probe.read()?.context;
        return context ? [{ path: context.path, sessionId: context.sessionId, revision: context.revision }] : [];
      }),
      onContextChanged: listener => {
        if (!this.disposed) this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };
  }

  bind(probes: ViewContextProbe[]): void {
    if (this.disposed) return;
    this.detach.splice(0).forEach(detach => detach());
    const previous = this.last?.element;
    this.probes = probes;
    this.last = probes.find(probe => probe.element === previous);
    for (const probe of probes) {
      const interacted = () => { this.last = probe; this.changed(); };
      for (const event of ['focusin', 'pointerdown', 'pointerup', 'keyup', 'input', 'select', 'compositionstart', 'compositionend']) {
        probe.element.addEventListener(event, interacted, true);
        this.detach.push(() => probe.element.removeEventListener(event, interacted, true));
      }
      if (probe.element.contains(probe.element.ownerDocument.activeElement)) this.last = probe;
    }
    this.changed();
  }

  changed(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.listeners.forEach(listener => listener());
    }, 100);
  }

  private async capture(): Promise<ActiveViewContext | undefined> {
    const probe = this.last;
    if (this.disposed || !probe || !probe.element.isConnected) return undefined;
    const before = probe.read();
    if (!before) return undefined;
    const snapshot = structuredClone(before);
    // Draft/composition positions are not positions in the committed document.
    if (snapshot.context.humanInput.composing || snapshot.context.humanInput.draftPending) return undefined;
    const range = snapshot.range;
    let selection: ActiveViewContext['selection'];
    if (range) {
      try {
        const copied = await this.api.query.copy(snapshot.context.path, range, {
          sessionId: snapshot.context.sessionId, expectedRevision: snapshot.context.revision,
        });
        selection = { range, text: copied.text };
      } catch (error) {
        if (error instanceof HwpHandsError && ['REVISION_CONFLICT', 'CLOSED', 'NOT_FOUND'].includes(error.code)) return undefined;
        throw error;
      }
    }
    const current = this.api.documents.list().find(state => state.path === snapshot.context.path);
    if (this.disposed || !this.probes.includes(probe) || !probe.element.isConnected
      || JSON.stringify(probe.read()) !== JSON.stringify(before)
      || current?.sessionId !== snapshot.context.sessionId || current.revision !== snapshot.context.revision) return undefined;
    return { ...snapshot.context, ...(selection ? { selection } : {}) };
  }

  dispose(): void {
    this.disposed = true;
    this.detach.splice(0).forEach(detach => detach());
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear(); this.probes = []; this.last = undefined;
  }
}
