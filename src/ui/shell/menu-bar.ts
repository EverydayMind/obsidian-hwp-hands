export interface MenuBarItem {
  label: string;
  action?: () => void;
  shortcut?: string;
  disabled?: () => boolean;
  disabledReason?: () => string | undefined;
  separator?: boolean;
  children?: MenuBarItem[];
  checked?: () => boolean;
  icon?: string;
}

export interface MenuBarGroup { label: string; items: MenuBarItem[] }

let menuSequence = 0;

/** Mounts a small ARIA menubar. Keyboard handling is scoped to its own focus tree. */
export function mountMenuBar(parent: HTMLElement, groups: MenuBarGroup[], label = '문서 메뉴'): () => void {
  const document = parent.ownerDocument;
  const bar = document.createElement('div');
  bar.className = 'hwp-menubar'; bar.setAttribute('role', 'menubar'); bar.setAttribute('aria-label', label);
  interface Popup { menu: HTMLElement; buttons: HTMLButtonElement[]; items: MenuBarItem[]; opener: HTMLButtonElement; parent?: Popup; group: number }
  const topButtons: HTMLButtonElement[] = [], roots: Popup[] = [], popups: Popup[] = [];
  const children = new Map<HTMLButtonElement, Popup>();
  let openIndex = -1;
  const refresh = (popup: Popup): void => {
    popup.items.forEach((item, index) => {
      const button = popup.buttons[index];
      button.disabled = !!(item.separator || item.disabled?.());
      button.title = button.disabled ? item.disabledReason?.() ?? '' : '';
      if (button.title) button.setAttribute('aria-description', button.title);
      else button.removeAttribute('aria-description');
      if (item.checked) button.setAttribute('aria-checked', String(item.checked()));
    });
  };
  const hide = (popup: Popup): void => {
    for (const child of popups.filter(value => value.parent === popup)) hide(child);
    popup.menu.hidden = true; popup.opener.setAttribute('aria-expanded', 'false');
  };
  const close = (focusOpener = false): void => {
    const index = openIndex;
    roots.forEach(hide); openIndex = -1;
    if (focusOpener && index >= 0) topButtons[index].focus();
  };
  const focusItem = (popup: Popup, start: number, step: 1 | -1): void => {
    refresh(popup);
    for (let count = 0; count < popup.buttons.length; count++) {
      const index = (start + count * step + popup.buttons.length) % popup.buttons.length;
      if (!popup.buttons[index].disabled) { popup.buttons[index].focus(); return; }
    }
  };
  const show = (popup: Popup, focusFirst: boolean): void => {
    refresh(popup);
    if (popup.opener.disabled) return;
    if (popup.parent) {
      popups.filter(value => value.parent === popup.parent && value !== popup).forEach(hide);
    } else {
      if (openIndex !== popup.group) close();
      openIndex = popup.group;
    }
    popup.menu.hidden = false; popup.opener.setAttribute('aria-expanded', 'true');
    if (popup.parent) {
      const bounds = popup.opener.getBoundingClientRect(), size = popup.menu.getBoundingClientRect();
      const width = document.documentElement.clientWidth || document.defaultView!.innerWidth;
      const height = document.documentElement.clientHeight || document.defaultView!.innerHeight;
      const left = Math.max(0, bounds.right + size.width <= width ? bounds.right : bounds.left - size.width);
      const top = Math.max(0, Math.min(bounds.top, height - size.height));
      // The editor's container query adds layout containment, which makes it the containing block of fixed descendants.
      popup.menu.style.removeProperty('left'); popup.menu.style.removeProperty('top');
      popup.menu.classList.add('hwp-position-origin');
      const origin = popup.menu.getBoundingClientRect();
      popup.menu.classList.remove('hwp-position-origin');
      popup.menu.style.left = `${Math.round(left - origin.left)}px`;
      popup.menu.style.top = `${Math.round(top - origin.top)}px`;
    }
    if (focusFirst) focusItem(popup, 0, 1);
  };
  const focusTop = (index: number): void => {
    const next = (index + groups.length) % groups.length;
    topButtons[next].focus();
    if (openIndex >= 0) show(roots[next], true);
  };
  const buildPopup = (items: MenuBarItem[], opener: HTMLButtonElement, group: number, parentPopup?: Popup): Popup => {
    const menu = document.createElement('div'); menu.id = `hwp-menu-${++menuSequence}`;
    menu.className = `hwp-menu-popup${parentPopup ? ' hwp-menu-submenu' : ''}`;
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `${opener.textContent} 메뉴`); menu.hidden = true;
    opener.setAttribute('aria-haspopup', 'menu'); opener.setAttribute('aria-expanded', 'false'); opener.setAttribute('aria-controls', menu.id);
    const popup: Popup = { menu, buttons: [], items, opener, group, parent: parentPopup }; popups.push(popup);
    items.forEach(item => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'hwp-menu-item';
      row.setAttribute('role', item.separator ? 'separator' : item.checked ? 'menuitemcheckbox' : 'menuitem');
      if (item.separator) row.classList.add('hwp-menu-separator');
      if (item.icon) { const icon = document.createElement('span'); icon.className = 'hwp-menu-icon'; icon.textContent = item.icon; row.append(icon); }
      const title = document.createElement('span'); title.className = 'hwp-menu-label'; title.textContent = item.label; row.append(title);
      if (item.shortcut) {
        const shortcut = document.createElement('span'); shortcut.className = 'hwp-menu-shortcut'; shortcut.textContent = item.shortcut; row.append(shortcut);
        row.setAttribute('aria-keyshortcuts', item.shortcut);
      }
      popup.buttons.push(row); menu.append(row);
      if (item.children) {
        const nested = buildPopup(item.children, row, group, popup); children.set(row, nested); menu.append(nested.menu);
        const arrow = document.createElement('span'); arrow.className = 'hwp-menu-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '›'; row.append(arrow);
        row.addEventListener('pointerenter', () => show(nested, false));
      } else row.addEventListener('pointerenter', () => popups.filter(value => value.parent === popup).forEach(hide));
      row.addEventListener('click', () => {
        refresh(popup); if (row.disabled) return;
        const nested = children.get(row);
        if (nested) show(nested, true); else { close(true); item.action?.(); }
      });
    });
    refresh(popup); return popup;
  };
  groups.forEach((group, index) => {
    const wrapper = document.createElement('div'); wrapper.setAttribute('role', 'none'); wrapper.className = 'hwp-menu-group';
    const top = document.createElement('button'); top.type = 'button'; top.className = 'hwp-menu-trigger'; top.setAttribute('role', 'menuitem'); top.textContent = group.label;
    const popup = buildPopup(group.items, top, index); roots.push(popup); topButtons.push(top);
    top.addEventListener('click', () => openIndex === index ? close() : show(popup, true));
    top.addEventListener('pointerenter', () => { if (openIndex >= 0 && openIndex !== index) show(popup, false); });
    wrapper.append(top, popup.menu); bar.append(wrapper);
  });
  bar.addEventListener('keydown', event => {
    const target = event.target as HTMLButtonElement, topIndex = topButtons.indexOf(target);
    if (event.key === 'Tab') { close(); return; }
    if (topIndex >= 0) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); focusTop(topIndex + (event.key === 'ArrowRight' ? 1 : -1)); }
      else if (['ArrowDown', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(roots[topIndex], true); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); show(roots[topIndex], false); focusItem(roots[topIndex], roots[topIndex].buttons.length - 1, -1); }
      else if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); topButtons[event.key === 'Home' ? 0 : topButtons.length - 1].focus(); }
      return;
    }
    const popup = popups.find(value => value.buttons.includes(target)); if (!popup) return;
    const index = popup.buttons.indexOf(target), nested = children.get(target);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1; focusItem(popup, index + step, step);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focusItem(popup, event.key === 'Home' ? 0 : popup.buttons.length - 1, event.key === 'Home' ? 1 : -1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault(); if (nested) show(nested, true); else if (!popup.parent) focusTop(popup.group + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      event.preventDefault(); if (popup.parent) { hide(popup); popup.opener.focus(); }
      else if (event.key === 'Escape') close(true); else focusTop(popup.group - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (nested) show(nested, true); else target.click();
    }
  });

  const closeOnOutsidePointer = (event: PointerEvent): void => { if (!bar.contains(event.target as Node)) close(); };
  document.addEventListener('pointerdown', closeOnOutsidePointer, true);
  parent.append(bar);
  return () => { close(); document.removeEventListener('pointerdown', closeOnOutsidePointer, true); bar.remove(); };
}
