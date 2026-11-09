import type { CommandRegistry } from './command-registry';

/** `menu` turns the tool into a split button: the face runs `command`, the arrow opens these commands in order. */
export interface CommandToolbarTool { command: string; icon: string; label?: string; menu?: readonly string[] }
export interface CommandToolbarGroup { label: string; tools: readonly CommandToolbarTool[]; overflow?: boolean; visible?: () => boolean }
export interface MountedCommandToolbar { element: HTMLElement; refresh(): void; dispose(): void }

/** Places a shown fixed popup below its anchor, or above it when only that fits, and keeps it inside the window. */
export function placeFixedPopup(popup: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect(), viewport = popup.ownerDocument.documentElement;
  // Keep the popup inside the window: a narrow tab can put the anchor near the right edge or the bottom of the screen.
  const width = popup.offsetWidth, height = popup.offsetHeight;
  const left = Math.max(4, Math.min(rect.left, viewport.clientWidth - width - 4));
  const top = rect.bottom + 2 + height > viewport.clientHeight && rect.top - 2 - height >= 0 ? rect.top - 2 - height : rect.bottom + 2;
  // The editor's container query adds layout containment, which makes it the containing block of fixed descendants.
  popup.style.removeProperty('left'); popup.style.removeProperty('top');
  popup.classList.add('hwp-position-origin');
  const origin = popup.getBoundingClientRect();
  popup.classList.remove('hwp-position-origin');
  popup.style.left = `${Math.round(left - origin.left)}px`;
  popup.style.top = `${Math.round(top - origin.top)}px`;
}

export interface CommandMenuButton { element: HTMLButtonElement; menu: HTMLElement; refresh(): void; dispose(): void }

/**
 * A menu button of on/off commands, like RHWP's 글자 효과 dropdown. `checked` reads each item's state for the current selection;
 * the button is pressed while any item is on. Items stay focusable when unavailable so their reasons can be read.
 */
export function createCommandMenuButton(
  parent: HTMLElement,
  registry: CommandRegistry,
  options: { label: string; text: string; commands: readonly string[]; checked: (command: string) => boolean | 'mixed' | undefined; run: (command: string) => unknown },
): CommandMenuButton {
  const document = parent.ownerDocument;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'hwp-command-menu-button';
  toggle.textContent = `${options.text} ▾`;
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', options.label);
  toggle.title = options.label;
  const menu = document.createElement('div');
  menu.className = 'hwp-command-split-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', options.label);
  menu.hidden = true;
  const items = options.commands.map(id => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'hwp-command-split-item';
    item.setAttribute('role', 'menuitemcheckbox');
    item.dataset.command = id;
    item.textContent = registry.get(id)?.label ?? id;
    item.addEventListener('click', () => {
      if (item.getAttribute('aria-disabled') === 'true') return;
      close(true);
      options.run(id);
    });
    menu.append(item);
    return item;
  });
  const refresh = (): void => {
    let pressed = false;
    for (const item of items) {
      const id = item.dataset.command!, command = registry.get(id);
      const available = !!command && registry.isAvailable(id);
      const reason = command?.unavailableReason?.() || (command ? `${command.label} 명령을 현재 상태에서 사용할 수 없습니다.` : '명령 정의를 찾을 수 없습니다.');
      const checked = options.checked(id);
      if (checked === true) pressed = true;
      item.setAttribute('aria-checked', checked === undefined ? 'false' : String(checked));
      item.setAttribute('aria-disabled', String(!available));
      item.title = available ? command.label : reason;
      if (available) item.removeAttribute('aria-description');
      else item.setAttribute('aria-description', reason);
    }
    toggle.setAttribute('aria-pressed', String(pressed));
  };
  const close = (restoreFocus = false): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
  };
  const open = (focusLast = false): void => {
    refresh();
    menu.hidden = false;
    placeFixedPopup(menu, toggle);
    toggle.setAttribute('aria-expanded', 'true');
    (focusLast ? items[items.length - 1] : items.find(item => item.getAttribute('aria-disabled') !== 'true') ?? items[0])?.focus();
  };
  toggle.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
  toggle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open(event.key === 'ArrowUp');
  });
  menu.addEventListener('keydown', event => {
    const index = items.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(); return; }
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  });
  const onOutsidePointer = (event: Event): void => {
    if (!menu.hidden && !toggle.contains(event.target as Node) && !menu.contains(event.target as Node)) close();
  };
  document.addEventListener('pointerdown', onOutsidePointer, true);
  parent.append(toggle, menu);
  refresh();
  return { element: toggle, menu, refresh, dispose: () => { document.removeEventListener('pointerdown', onOutsidePointer, true); toggle.remove(); menu.remove(); } };
}

export function mountCommandToolbar(
  parent: HTMLElement,
  registry: CommandRegistry,
  groups: readonly CommandToolbarGroup[],
  run: (command: string) => unknown,
  setIcon: (button: HTMLButtonElement, icon: string) => void,
): MountedCommandToolbar {
  const document = parent.ownerDocument;
  const root = document.createElement('div');
  root.className = 'hwp-command-toolbar';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', '기본 도구 상자');
  root.setAttribute('aria-orientation', 'horizontal');
  const scroller = document.createElement('div');
  scroller.className = 'hwp-command-toolbar-scroll';
  root.append(scroller);

  const buttons = new Map<string, HTMLButtonElement[]>();
  const menuItems: HTMLButtonElement[] = [];
  const splitMenus: Array<{ toggle: HTMLButtonElement; menu: HTMLElement }> = [];
  const conditionalGroups: Array<{ element: HTMLElement; visible: () => boolean }> = [];
  let overflowDetails: HTMLDetailsElement | undefined;
  const overflowGroups = groups.filter(group => group.overflow);
  const visibleGroups = groups.filter(group => !group.overflow);
  const createGroup = (group: CommandToolbarGroup, destination: HTMLElement): HTMLElement => {
    const container = document.createElement('div');
    container.className = 'hwp-command-toolbar-group';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', group.label);
    if (group.visible) {
      container.hidden = !group.visible();
      conditionalGroups.push({ element: container, visible: group.visible });
    }
    for (const tool of group.tools) {
      const command = registry.get(tool.command);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hwp-command-tool';
      button.dataset.command = tool.command;
      button.setAttribute('aria-label', command?.label ?? tool.command);
      button.title = command?.label ?? '명령 정의를 찾을 수 없습니다.';
      setIcon(button, tool.icon);
      const caption = document.createElement('span');
      caption.className = 'hwp-command-tool-label';
      caption.textContent = tool.label ?? command?.label ?? tool.command;
      button.append(caption);
      button.addEventListener('click', () => run(tool.command));
      buttons.set(tool.command, [...(buttons.get(tool.command) ?? []), button]);
      if (tool.menu?.length) container.append(createSplit(button, tool.menu, command?.label ?? tool.command));
      else container.append(button);
    }
    destination.append(container);
    return container;
  };
  // The toolbar scroller clips its overflow, so the popup is fixed-positioned from the arrow's rectangle when it opens.
  const closeMenu = (entry: { toggle: HTMLButtonElement; menu: HTMLElement }, restoreFocus = false): void => {
    if (entry.menu.hidden) return;
    entry.menu.hidden = true;
    entry.toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) entry.toggle.focus();
  };
  const openMenu = (entry: { toggle: HTMLButtonElement; menu: HTMLElement }, focusLast = false): void => {
    for (const other of splitMenus) if (other !== entry) closeMenu(other);
    refresh();
    entry.menu.hidden = false;
    placeFixedPopup(entry.menu, entry.toggle);
    entry.toggle.setAttribute('aria-expanded', 'true');
    // Unavailable items stay focusable so their reasons can be read; start on the first runnable one.
    const items = Array.from(entry.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const runnable = items.find(item => item.getAttribute('aria-disabled') !== 'true');
    (focusLast ? items[items.length - 1] : runnable ?? items[0])?.focus();
  };
  const createSplit = (face: HTMLButtonElement, commands: readonly string[], label: string): HTMLElement => {
    const split = document.createElement('div');
    split.className = 'hwp-command-split';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'hwp-command-split-toggle';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `${label} 메뉴`);
    toggle.title = `${label} 메뉴`;
    setIcon(toggle, 'chevron-down');
    const menu = document.createElement('div');
    menu.className = 'hwp-command-split-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${label} 메뉴`);
    menu.hidden = true;
    const entry = { toggle, menu };
    for (const id of commands) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'hwp-command-split-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.command = id;
      const name = document.createElement('span');
      name.textContent = registry.get(id)?.label ?? id;
      const shortcut = document.createElement('span');
      shortcut.className = 'hwp-command-split-shortcut';
      shortcut.textContent = registry.get(id)?.shortcut ?? '';
      item.append(name, shortcut);
      item.addEventListener('click', () => {
        if (item.getAttribute('aria-disabled') === 'true') return;
        closeMenu(entry, true);
        run(id);
      });
      menuItems.push(item);
      menu.append(item);
    }
    toggle.addEventListener('click', () => { if (menu.hidden) openMenu(entry); else closeMenu(entry); });
    toggle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu(entry, event.key === 'ArrowUp');
    });
    menu.addEventListener('keydown', event => {
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const index = items.indexOf(event.target as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(entry, true); return; }
      if (event.key === 'Tab') { closeMenu(entry); return; }
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      items[next]?.focus();
    });
    split.append(face, toggle, menu);
    splitMenus.push(entry);
    return split;
  };
  const onOutsidePointer = (event: Event): void => {
    for (const entry of splitMenus) if (!entry.menu.hidden && !entry.menu.parentElement?.contains(event.target as Node)) closeMenu(entry);
  };
  document.addEventListener('pointerdown', onOutsidePointer, true);
  const responsiveGroups = visibleGroups.map(group => createGroup(group, scroller));

  if (overflowGroups.length) {
    const details = document.createElement('details');
    details.className = 'hwp-command-toolbar-overflow';
    const summary = document.createElement('summary');
    summary.textContent = '더 보기';
    details.append(summary);
    const contents = document.createElement('div');
    contents.className = 'hwp-command-toolbar-overflow-content';
    for (const group of overflowGroups) createGroup(group, contents);
    details.append(contents);
    root.append(details);
    overflowDetails = details;
  }
  parent.append(root);

  // Keep the group order intact while moving only groups that do not fit into the menu.
  // A resize can also restore them when the pane grows again.
  const fitGroups = (): void => {
    if (!overflowDetails || !root.clientWidth) return;
    const contents = overflowDetails.querySelector<HTMLElement>('.hwp-command-toolbar-overflow-content')!;
    for (const entry of splitMenus) closeMenu(entry);
    for (const group of responsiveGroups) scroller.append(group);
    for (let index = responsiveGroups.length - 1; index >= 0 && scroller.scrollWidth > scroller.clientWidth; index--) {
      contents.prepend(responsiveGroups[index]);
    }
  };
  const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fitGroups);
  resizeObserver?.observe(parent);
  fitGroups();

  let tabStop: HTMLElement | undefined;
  const controlSelector = '.hwp-command-tool, .hwp-command-split-toggle, .hwp-command-toolbar-overflow > summary';
  const controls = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(controlSelector))
    .filter(control => {
      if (control.tagName === 'SUMMARY') return true;
      const closedOverflow = control.closest('details:not([open])');
      return !control.closest('[hidden]') && !closedOverflow && !(control.tagName === 'BUTTON' && (control as HTMLButtonElement).disabled);
    });
  const refreshFocusStops = (): void => {
    const available = controls();
    if (!tabStop || !available.includes(tabStop)) tabStop = available[0];
    for (const control of root.querySelectorAll<HTMLElement>(controlSelector)) {
      control.tabIndex = control === tabStop ? 0 : -1;
    }
  };
  overflowDetails?.addEventListener('toggle', refreshFocusStops);
  for (const group of buttons.values()) for (const button of group) button.addEventListener('focus', () => { tabStop = button; refreshFocusStops(); });
  for (const { toggle } of splitMenus) toggle.addEventListener('focus', () => { tabStop = toggle; refreshFocusStops(); });
  root.querySelector('summary')?.addEventListener('focus', event => { tabStop = event.currentTarget as HTMLElement; refreshFocusStops(); });
  root.addEventListener('keydown', event => {
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    if ((event.target as Element | null)?.closest?.('[role="menu"]')) return;
    const available = controls();
    if (!available.length) return;
    const current = event.target instanceof document.defaultView!.HTMLElement ? event.target : tabStop;
    const index = Math.max(0, available.indexOf(current as HTMLElement));
    const nextIndex = key === 'Home' ? 0 : key === 'End' ? available.length - 1
      : (index + (key === 'ArrowLeft' ? -1 : 1) + available.length) % available.length;
    event.preventDefault();
    tabStop = available[nextIndex];
    refreshFocusStops();
    tabStop?.focus();
  });

  const refresh = (): void => {
    let visibilityChanged = false;
    for (const group of conditionalGroups) {
      const hidden = !group.visible();
      if (group.element.hidden === hidden) continue;
      visibilityChanged = true;
      group.element.hidden = hidden;
    }
    if (visibilityChanged) fitGroups();
    for (const [id, group] of buttons) for (const button of group) {
      const command = registry.get(id);
      const available = !!command && registry.isAvailable(id);
      button.disabled = !available;
      const reason = command?.unavailableReason?.();
      const unavailableMessage = reason || (command ? `${command.label} 명령을 현재 상태에서 사용할 수 없습니다.` : '명령 정의를 찾을 수 없습니다.');
      button.setAttribute('aria-label', available ? command.label : `${command?.label ?? id}. 사용할 수 없음. ${unavailableMessage}`);
      if (available) button.removeAttribute('aria-description');
      else button.setAttribute('aria-description', unavailableMessage);
      if (available) delete button.dataset.unavailableReason;
      else button.dataset.unavailableReason = unavailableMessage;
      button.title = available
        ? `${command.label}${command.shortcut ? ` (${command.shortcut})` : ''}`
        : unavailableMessage;
    }
    // Menu items keep focus when unavailable (aria-disabled) so the reason is announced, as in the menu bar.
    for (const item of menuItems) {
      const id = item.dataset.command!, command = registry.get(id);
      const available = !!command && registry.isAvailable(id);
      const reason = command?.unavailableReason?.() || (command ? `${command.label} 명령을 현재 상태에서 사용할 수 없습니다.` : '명령 정의를 찾을 수 없습니다.');
      item.setAttribute('aria-disabled', String(!available));
      item.title = available ? command.label : reason;
      if (available) item.removeAttribute('aria-description');
      else item.setAttribute('aria-description', reason);
    }
    refreshFocusStops();
  };
  refresh();
  return { element: root, refresh, dispose: () => { resizeObserver?.disconnect(); document.removeEventListener('pointerdown', onOutsidePointer, true); root.remove(); } };
}
