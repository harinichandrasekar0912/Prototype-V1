// SVG drawing canvas: world metres (y up) on screen. Pan/zoom only change the viewBox, so redraws
// happen when the design changes, not on every wheel tick. Bubbles can be dragged (spec §97-style
// direct manipulation); the app decides what a drag means.

import { defs } from '../render/draw.js';

export class Canvas {
  constructor(svg, { onBubbleDown, onBubbleDrag, onBubbleUp, onMove } = {}) {
    this.svg = svg;
    this.view = null; // {x, y, w, h} world, y = bottom
    this.cb = { onBubbleDown, onBubbleDrag, onBubbleUp, onMove };
    this.drag = null;
    svg.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    svg.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    svg.addEventListener('dblclick', () => this.fit(this.lastBounds));
    new ResizeObserver(() => this.apply()).observe(svg);
  }

  render({ geo, txt, bounds }, { refit = false } = {}) {
    this.lastBounds = bounds;
    this.svg.innerHTML = `${defs()}<g class="geo" transform="scale(1,-1)">${geo}</g><g class="txt">${txt}</g>`;
    if (!this.view || refit) this.fit(bounds);
    else this.apply();
  }

  fit(b) {
    if (!b) return;
    const r = this.svg.getBoundingClientRect();
    const W = Math.max(50, r.width), H = Math.max(50, r.height);
    let w = b.x1 - b.x0, h = b.y1 - b.y0;
    const aspect = W / H;
    if (w / h > aspect) h = w / aspect; else w = h * aspect;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    this.view = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.apply();
  }

  apply() {
    if (!this.view) return;
    const r = this.svg.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      // keep the aspect of the element
      const aspect = r.width / r.height;
      const cx = this.view.x + this.view.w / 2, cy = this.view.y + this.view.h / 2;
      let { w, h } = this.view;
      if (Math.abs(w / h - aspect) > 1e-3) { if (w / h > aspect) h = w / aspect; else w = h * aspect; }
      this.view = { x: cx - w / 2, y: cy - h / 2, w, h };
    }
    const v = this.view;
    this.svg.setAttribute('viewBox', `${v.x} ${-(v.y + v.h)} ${v.w} ${v.h}`);
    this.pxPerM = r.width / v.w;
    this.svg.dispatchEvent(new CustomEvent('viewchange', { detail: { pxPerM: this.pxPerM } }));
  }

  toWorld(e) {
    const r = this.svg.getBoundingClientRect();
    const v = this.view;
    return [v.x + ((e.clientX - r.left) / r.width) * v.w, v.y + v.h - ((e.clientY - r.top) / r.height) * v.h];
  }

  zoom(f, at = null) {
    const v = this.view;
    const c = at || [v.x + v.w / 2, v.y + v.h / 2];
    const w = Math.min(400, Math.max(4, v.w * f)), k = w / v.w;
    this.view = { x: c[0] - (c[0] - v.x) * k, y: c[1] - (c[1] - v.y) * k, w, h: v.h * k };
    this.apply();
  }

  wheel(e) {
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * 0.0012), this.toWorld(e));
  }

  down(e) {
    const g = e.target.closest('[data-bubble]');
    if (g && this.cb.onBubbleDown) {
      const id = g.getAttribute('data-bubble');
      this.drag = { kind: 'bubble', id, start: this.toWorld(e), moved: false };
      this.cb.onBubbleDown(id, this.toWorld(e));
      this.svg.setPointerCapture?.(e.pointerId);
      return;
    }
    this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: { ...this.view } };
    this.svg.classList.add('panning');
  }

  move(e) {
    if (this.view && e.target && this.svg.contains(e.target) && this.cb.onMove) this.cb.onMove(this.toWorld(e));
    if (!this.drag) return;
    if (this.drag.kind === 'pan') {
      const r = this.svg.getBoundingClientRect();
      const dx = ((e.clientX - this.drag.sx) / r.width) * this.drag.v.w, dy = ((e.clientY - this.drag.sy) / r.height) * this.drag.v.h;
      this.view = { ...this.drag.v, x: this.drag.v.x - dx, y: this.drag.v.y + dy };
      this.apply();
    } else if (this.drag.kind === 'bubble') {
      const w = this.toWorld(e);
      if (Math.hypot(w[0] - this.drag.start[0], w[1] - this.drag.start[1]) > 0.15) this.drag.moved = true;
      if (this.drag.moved && this.cb.onBubbleDrag) this.cb.onBubbleDrag(this.drag.id, w);
    }
  }

  up() {
    if (!this.drag) return;
    if (this.drag.kind === 'bubble' && this.cb.onBubbleUp) this.cb.onBubbleUp(this.drag.id, this.drag.moved);
    this.drag = null;
    this.svg.classList.remove('panning');
  }
}

// Static thumbnail: fit the scene into a small SVG.
export function thumbSVG({ geo, txt, bounds }, cls = 'thumb') {
  const pad = 0.5;
  const w = bounds.x1 - bounds.x0 + 2 * pad, h = bounds.y1 - bounds.y0 + 2 * pad;
  return `<svg class="${cls}" viewBox="${bounds.x0 - pad} ${-(bounds.y1 + pad)} ${w} ${h}" preserveAspectRatio="xMidYMid meet">${defs()}<g transform="scale(1,-1)">${geo}</g><g>${txt}</g></svg>`;
}
