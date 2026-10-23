/**
 * 手写签名板：压感笔迹、平滑曲线、撤销/清空、墨迹裁剪导出。
 * 大屏与手机端共用；内部坐标归一化，旋转/缩放后仍可重绘。
 */
import { clamp } from './util.js';

const DEFAULTS = {
  colors: ['#12283f', '#a8332e', '#2f5d50', '#3c3a6b'],
  width: 4.2,
};

export class SignPad {
  constructor(canvas, { colors = DEFAULTS.colors, color = DEFAULTS.colors[0], width = DEFAULTS.width, onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = colors;
    this.color = color;
    this.width = width;
    this.strokes = [];
    this.redoStack = [];
    this.current = null;
    this.onChange = onChange;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.pointerId = null;
    this._bind();
    this.resize();
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('pointerleave', (e) => {
      if (this.pointerId === e.pointerId && e.buttons === 0) this._up(e);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.render();
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
      p: e.pressure && e.pressure > 0 ? e.pressure : 0.5,
    };
  }

  _down(e) {
    if (this.pointerId !== null) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointerId = e.pointerId;
    this.redoStack = [];
    const pt = this._pos(e);
    this.current = { color: this.color, width: this.width, points: [pt] };
    this.strokes.push(this.current);
    this.render();
    this.onChange(this);
  }

  _move(e) {
    if (this.pointerId !== e.pointerId || !this.current) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const pt = this._pos(ev);
      const last = this.current.points[this.current.points.length - 1];
      const dx = (pt.x - last.x) * this.cssWidth;
      const dy = (pt.y - last.y) * this.cssHeight;
      if (dx * dx + dy * dy < 0.6) continue;
      this.current.points.push(pt);
    }
    this.render();
    this.onChange(this);
  }

  _up(e) {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    this.current = null;
    this.render();
    this.onChange(this);
  }

  setColor(color) {
    this.color = color;
  }

  setWidth(width) {
    this.width = width;
  }

  undo() {
    if (!this.strokes.length) return false;
    this.redoStack.push(this.strokes.pop());
    this.render();
    this.onChange(this);
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.strokes.push(this.redoStack.pop());
    this.render();
    this.onChange(this);
    return true;
  }

  clear() {
    this.strokes = [];
    this.redoStack = [];
    this.render();
    this.onChange(this);
  }

  isEmpty() {
    return this.strokes.every((s) => s.points.length === 0);
  }

  /** 笔画数量（用于判断是否真的写了字） */
  get strokeCount() {
    return this.strokes.filter((s) => s.points.length > 0).length;
  }

  render() {
    const ctx = this.ctx;
    const { dpr, cssWidth: w, cssHeight: h } = this;
    if (!w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of this.strokes) this._drawStroke(ctx, stroke);
  }

  _drawStroke(ctx, stroke) {
    const pts = stroke.points;
    if (!pts.length) return;
    const w = this.cssWidth;
    const h = this.cssHeight;
    ctx.strokeStyle = stroke.color;
    if (pts.length === 1) {
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(pts[0].x * w, pts[0].y * h, (stroke.width * 0.55) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const speed = Math.hypot((b.x - a.x) * w, (b.y - a.y) * h);
      const taper = clamp(1 - speed / 90, 0.45, 1);
      const pressure = 0.55 + b.p * 0.9;
      const startTaper = i < 3 ? 0.55 + i * 0.15 : 1;
      ctx.lineWidth = stroke.width * pressure * taper * startTaper;
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      if (i < pts.length - 1) {
        const c = pts[i + 1];
        ctx.quadraticCurveTo(b.x * w, b.y * h, ((b.x + c.x) / 2) * w, ((b.y + c.y) / 2) * h);
      } else {
        ctx.lineTo(b.x * w, b.y * h);
      }
      ctx.stroke();
    }
  }

  /** 墨迹包围盒（归一化） */
  bounds() {
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    for (const s of this.strokes) {
      for (const p of s.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (minX > maxX) return null;
    return { minX, minY, maxX, maxY };
  }

  /**
   * 导出透明背景 PNG（按墨迹裁剪，保留少量留白，适合上墙显示）
   * @param {{padding?:number, maxWidth?:number, background?:string|null}} opts
   */
  exportPng({ padding = 0.06, maxWidth = 1600, background = null } = {}) {
    const b = this.bounds();
    const w = this.cssWidth || 800;
    const h = this.cssHeight || 400;
    if (!b) return null;
    const pad = Math.max(w, h) * padding;
    const x0 = Math.max(0, b.minX * w - pad);
    const y0 = Math.max(0, b.minY * h - pad);
    const x1 = Math.min(w, b.maxX * w + pad);
    const y1 = Math.min(h, b.maxY * h + pad);
    const bw = Math.max(12, x1 - x0);
    const bh = Math.max(12, y1 - y0);

    const out = document.createElement('canvas');
    const scale = clamp(maxWidth / (bw * this.dpr), 0.4, 2.2);
    out.width = Math.round(bw * this.dpr * scale);
    out.height = Math.round(bh * this.dpr * scale);
    const ctx = out.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.setTransform(this.dpr * scale, 0, 0, this.dpr * scale, -x0 * this.dpr * scale, -y0 * this.dpr * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of this.strokes) this._drawStroke(ctx, stroke);
    return out.toDataURL('image/png');
  }
}
