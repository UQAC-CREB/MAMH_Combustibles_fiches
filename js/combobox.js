// Liste déroulante avec saisie et suggestions automatiques (insensible aux accents)

export const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'");
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlight(label, q) {
  if (!q) return escHtml(label);
  const i = norm(label).indexOf(q);
  if (i < 0) return escHtml(label);
  return escHtml(label.slice(0, i)) + '<mark>' + escHtml(label.slice(i, i + q.length)) + '</mark>' + escHtml(label.slice(i + q.length));
}

/**
 * items : [{ value, label, sub?, keys? }] — `keys` : texte supplémentaire recherché (alias).
 * onSelect(value|null)
 */
export class Combo {
  constructor(root, { onSelect, placeholder, empty } = {}) {
    this.empty = empty;
    this.root = root;
    this.input = root.querySelector('input');
    this.list = root.querySelector('.combo-list');
    this.onSelect = onSelect;
    this.placeholder = placeholder;
    this.items = [];
    this.value = null;
    this.hl = -1;
    this.shown = [];

    this.input.addEventListener('focus', () => { this.input.select(); this.open(''); });
    this.input.addEventListener('input', () => this.open(this.input.value));
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.close(true), 150));
    root.querySelector('.combo-arrow').addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (this.input.disabled) return;
      if (this.root.classList.contains('open')) this.close(true); else { this.input.focus(); }
    });
    root.querySelector('.combo-clear').addEventListener('mousedown', (e) => {
      e.preventDefault(); this.set(null, true);
    });
    this.list.addEventListener('mousedown', (e) => {
      const el = e.target.closest('.combo-item');
      if (!el) return;
      e.preventDefault();
      this.set(this.shown[+el.dataset.i].value, true);
      this.input.blur();
    });
  }

  setItems(items, { disabled = false, placeholder } = {}) {
    this.items = items.map(it => ({ ...it, _k: norm(`${it.label} ${it.sub || ''} ${it.keys || ''}`) }));
    this.input.disabled = disabled;
    if (placeholder) this.input.placeholder = placeholder;
    if (this.value != null && !this.items.some(i => i.value === this.value)) this.set(null, false);
  }

  open(q) {
    const nq = norm(q.trim());
    const shown = nq ? this.items.filter(i => i._k.includes(nq)) : this.items;
    // les noms qui commencent par la saisie d'abord
    if (nq) shown.sort((a, b) => (norm(b.label).startsWith(nq) - norm(a.label).startsWith(nq)));
    this.shown = shown.slice(0, 400);
    this.hl = nq && this.shown.length ? 0 : -1;
    this.list.innerHTML = this.shown.length
      ? this.shown.map((it, i) => `<div class="combo-item${i === this.hl ? ' hl' : ''}" data-i="${i}">${highlight(it.label, nq)}${it.sub ? ` <small>${highlight(it.sub, nq)}</small>` : ''}</div>`).join('')
      : `<div class="combo-empty">${this.empty ? this.empty() : 'Aucun résultat'}</div>`;
    this.root.classList.add('open');
  }

  close(restore) {
    this.root.classList.remove('open');
    if (restore) {
      const cur = this.items.find(i => i.value === this.value);
      this.input.value = cur ? cur.label : '';
    }
  }

  key(e) {
    const items = this.list.querySelectorAll('.combo-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.root.classList.contains('open')) this.open(this.input.value);
      this.hl = Math.max(0, Math.min(this.shown.length - 1, this.hl + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((el, i) => el.classList.toggle('hl', i === this.hl));
      items[this.hl]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.hl >= 0 && this.shown[this.hl]) { this.set(this.shown[this.hl].value, true); this.input.blur(); }
    } else if (e.key === 'Escape') {
      this.close(true); this.input.blur();
    }
  }

  /** Sélectionne une valeur ; `fire` déclenche onSelect. */
  set(value, fire) {
    this.value = value;
    const cur = this.items.find(i => i.value === value);
    this.input.value = cur ? cur.label : '';
    this.root.classList.toggle('has-value', value != null);
    this.close(false);
    if (fire && this.onSelect) this.onSelect(value);
  }
}
