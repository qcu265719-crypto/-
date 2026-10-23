/**
 * 签名墙舞台：把签名变成"可触摸的星空"。
 * 三种展示形态：地球仪（globe）/ 星空（star）/ 气泡（bubble）。
 * 新签名上墙：先由墨点粒子汇聚成签名，再飞入墙中成为一个漂浮的签名卡。
 */
import {
  clamp,
  createCanvas,
  easeInOutCubic,
  easeOutCubic,
  easeOutExpo,
  loadImage,
  rand,
  rgba,
  roundRect,
} from '../lib/util.js';

const TEX_SCALE = 2;
const CARD_W = 360;
const CARD_H = 240;
const LAYOUT = {
  pad: 22,
  sigTop: 24,
  sigH: 122,
  nameY: 180,
  msgY: 204,
  footY: 224,
  sealX: CARD_W - 50,
  sealY: CARD_H - 56,
  sealS: 30,
};

const FONT_SANS = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const FONT_SERIF = '"Songti SC", "SimSun", "Noto Serif SC", serif';

function containRect(iw, ih, dx, dy, dw, dh) {
  const scale = Math.min(dw / iw, dh / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { x: dx + (dw - w) / 2, y: dy + (dh - h) / 2, w, h };
}

function truncate(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

export class SignatureWall {
  constructor(canvas, { accent = '#e0b45c', ink = '#0f2438', paper = '#f6f1e6', onSelect = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.accent = accent;
    this.ink = ink;
    this.paper = paper;
    this.onSelect = onSelect;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.mode = 'globe';
    this.cards = [];
    this.byId = new Map();
    this.hero = null;
    this.t = 0;
    this.rotY = 0;
    this.maxCards = 72;
    this.highlightId = null;
    this.parallax = { x: 0, y: 0, tx: 0, ty: 0 };
    this.debug = { added: 0, setItems: 0, dropped: 0, layouts: 0 };
    this.stars = [];
    this.bubbles = [];
    this.paused = false;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  resize(cssWidth, cssHeight, dpr = 1) {
    this.width = Math.max(320, Math.round(cssWidth));
    this.height = Math.max(240, Math.round(cssHeight));
    this.dpr = clamp(dpr, 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this._seedAmbient();
    this._layout();
  }

  _seedAmbient() {
    const { width: w, height: h } = this;
    this.stars = Array.from({ length: 140 }, () => ({
      x: rand(-w, w),
      y: rand(-h, h),
      z: rand(0.1, 1),
      size: rand(0.5, 2.1),
      twinkle: rand(0, Math.PI * 2),
    }));
    this.bubbles = Array.from({ length: 22 }, () => ({
      x: rand(0, w),
      y: rand(0, h),
      r: rand(4, 16),
      vy: rand(8, 26),
      phase: rand(0, Math.PI * 2),
    }));
  }

  setMode(mode) {
    this.mode = ['globe', 'star', 'bubble'].includes(mode) ? mode : 'globe';
    for (const card of this.cards) this._assignSlot(card);
  }

  setTheme({ accent, ink, paper }) {
    const changed = (accent && accent !== this.accent) || (ink && ink !== this.ink) || (paper && paper !== this.paper);
    if (accent) this.accent = accent;
    if (ink) this.ink = ink;
    if (paper) this.paper = paper;
    if (!changed) return;
    for (const card of this.cards) this._buildTexture(card).catch(() => {});
  }

  async setItems(items = []) {
    this.debug.setItems++;
    const keep = new Set();
    for (const item of items.slice(0, this.maxCards)) {
      keep.add(item.id);
      if (this.byId.has(item.id)) {
        const card = this.byId.get(item.id);
        card.item = item;
        continue;
      }
      const card = this._createCard(item, { visible: true });
      this.cards.push(card);
      this.byId.set(item.id, card);
    }
    for (const card of [...this.cards]) {
      if (!keep.has(card.id) && (!this.hero || this.hero.card.id !== card.id)) this._dropCard(card.id);
    }
    this._assignSlots();
    await Promise.all(this.cards.map((c) => this._buildTexture(c).catch(() => { c.failed = true; })));
    this._layout();
  }

  async addItem(item, { hero = true } = {}) {
    this.debug.added++;
    if (this.byId.has(item.id)) return;
    const card = this._createCard(item, { visible: !hero });
    this.cards.push(card);
    this.byId.set(item.id, card);
    this._assignSlots();
    try {
      await this._buildTexture(card);
    } catch {
      return;
    }
    if (this.cards.length > this.maxCards) {
      const oldest = this.cards.find((c) => c.id !== item.id && (!this.hero || this.hero.card.id !== c.id));
      if (oldest) this._dropCard(oldest.id);
    }
    this._layout();
    if (hero && !this.reduced) {
      // 上一条签名还在飞行时又来了新签名：把旧卡片直接落到墙上，避免"消失"
      if (this.hero) this._finishHero();
      this._startHero(card);
    } else {
      card.entry = 0;
    }
  }

  _finishHero() {
    if (!this.hero) return;
    this.hero.card.visible = true;
    this.hero.card.entry = 0.35;
    this.hero = null;
  }

  /** 立即结束当前飞入动画（切回待机/清屏时调用，避免残留大字卡） */
  finishHero() {
    this._finishHero();
  }

  removeItem(id) {
    if (this.hero?.card.id === id) this.hero = null;
    this._dropCard(id);
    this._assignSlots();
  }

  clear() {
    this.cards = [];
    this.byId.clear();
    this.hero = null;
    this.highlightId = null;
  }

  _dropCard(id) {
    const idx = this.cards.findIndex((c) => c.id === id);
    if (idx >= 0) this.cards.splice(idx, 1);
    this.byId.delete(id);
  }

  _createCard(item, { visible }) {
    return {
      id: item.id,
      item,
      texture: null,
      img: null,
      visible,
      entry: visible ? 1 : 0,
      slot: 0,
      pos: { x: 0, y: 0, size: 0, alpha: 0, z: 0, rot: 0 },
      bubble: null,
      star: null,
      dirty: false,
      rotSeed: rand(-0.05, 0.05),
    };
  }

  _assignSlots() {
    const n = Math.max(1, this.cards.length);
    const golden = Math.PI * (3 - Math.sqrt(5));
    this.cards.forEach((card, i) => {
      card.slot = i;
      const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * golden;
      card.sphere = { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
      if (this.mode === 'star') {
        card.star ||= {
          x: rand(-1, 1),
          y: rand(-1, 1),
          z: rand(-1.2, 1.2),
          speed: rand(0.018, 0.05),
          size: rand(0.85, 1.15),
        };
      }
      if (this.mode === 'bubble') {
        card.bubble ||= {
          x: rand(0.08, 0.92),
          y: rand(0.1, 1.2),
          speed: rand(0.012, 0.03),
          sway: rand(10, 30),
          phase: rand(0, Math.PI * 2),
          scale: rand(0.8, 1.1),
        };
      }
    });
  }

  _assignSlot(card) {
    this._assignSlots();
  }

  async _buildTexture(card) {
    const item = card.item;
    const canvas = createCanvas(CARD_W * TEX_SCALE, CARD_H * TEX_SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(TEX_SCALE, TEX_SCALE);

    let img = null;
    try {
      img = await loadImage(item.signatureUrl);
    } catch {
      img = null;
    }
    let photo = null;
    if (item.photoUrl) {
      try {
        photo = await loadImage(item.photoUrl);
      } catch {
        photo = null;
      }
    }

    // 纸卡底（不透明，避免山景透进来显得发灰）
    const grad = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
    grad.addColorStop(0, '#fcf8ef');
    grad.addColorStop(0.55, '#f5eddd');
    grad.addColorStop(1, '#e9dfc9');
    roundRect(ctx, 0.5, 0.5, CARD_W - 1, CARD_H - 1, 16);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = rgba(this.accent, 0.55);
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 纸张纹理：细横线
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = this.ink;
    ctx.lineWidth = 0.6;
    for (let y = 12; y < CARD_H - 8; y += 6) {
      ctx.beginPath();
      ctx.moveTo(10, y + 0.5);
      ctx.lineTo(CARD_W - 10, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // 内描边
    roundRect(ctx, 7, 7, CARD_W - 14, CARD_H - 14, 11);
    ctx.strokeStyle = rgba(this.ink, 0.12);
    ctx.lineWidth = 1;
    ctx.stroke();

    // 签名
    if (img) {
      const box = containRect(img.naturalWidth || 4, img.naturalHeight || 3, LAYOUT.pad, LAYOUT.sigTop, CARD_W - LAYOUT.pad * 2, LAYOUT.sigH);
      ctx.save();
      ctx.globalAlpha = 0.94;
      ctx.drawImage(img, box.x, box.y, box.w, box.h);
      ctx.restore();
    }

    // 姓名
    const name = item.name || '山水过客';
    ctx.fillStyle = this.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let nameSize = 24;
    ctx.font = `600 ${nameSize}px ${FONT_SERIF}`;
    const maxNameWidth = CARD_W - LAYOUT.pad * 2 - 74;
    while (nameSize > 15 && ctx.measureText(name).width > maxNameWidth) {
      nameSize -= 1;
      ctx.font = `600 ${nameSize}px ${FONT_SERIF}`;
    }
    ctx.fillText(truncate(ctx, name, maxNameWidth), LAYOUT.pad, LAYOUT.nameY);

    // 留言
    if (item.message) {
      ctx.font = `400 13px ${FONT_SANS}`;
      ctx.fillStyle = rgba(this.ink, 0.62);
      ctx.fillText(truncate(ctx, item.message, CARD_W - LAYOUT.pad * 2 - 22), LAYOUT.pad, LAYOUT.msgY);
    }

    // 日期与来源
    const d = new Date(item.createdAt);
    const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    ctx.font = `400 12px ${FONT_SANS}`;
    ctx.fillStyle = rgba(this.ink, 0.42);
    ctx.fillText(`${dateStr} · ${item.source === 'mobile' ? '手机签名' : '现场签名'}`, LAYOUT.pad, LAYOUT.footY);

    // 印章
    const sx = LAYOUT.sealX;
    const sy = LAYOUT.sealY;
    const s = LAYOUT.sealS;
    roundRect(ctx, sx, sy, s, s, 5);
    ctx.fillStyle = '#a8332e';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    roundRect(ctx, sx + 3, sy + 3, s - 6, s - 6, 3);
    ctx.stroke();
    ctx.fillStyle = '#f7ece0';
    ctx.font = `600 15px ${FONT_SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('留', sx + s / 2, sy + s / 2 + 1);

    // 留影贴纸
    if (photo) {
      const pw = 74;
      const ph = 74;
      const px = CARD_W - pw - 18;
      const py = 14;
      ctx.save();
      ctx.translate(px + pw / 2, py + ph / 2);
      ctx.rotate(0.07);
      ctx.fillStyle = '#fffdf8';
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      roundRect(ctx, -pw / 2 - 3, -ph / 2 - 3, pw + 6, ph + 6, 4);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.save();
      roundRect(ctx, -pw / 2, -ph / 2, pw, ph, 2);
      ctx.clip();
      const box = containRect(photo.naturalWidth || 1, photo.naturalHeight || 1, -pw / 2, -ph / 2, pw, ph);
      ctx.drawImage(photo, box.x, box.y, box.w, box.h);
      ctx.restore();
      ctx.restore();
    }

    card.texture = canvas;
    card.img = img;
    card.photo = photo;
    card.dirty = false;
  }

  // ---------------- 动画 ----------------

  _startHero(card) {
    const sigRect = this._heroSignatureRect();
    const particles = this._sampleParticles(card.img, sigRect, 820);
    const { width: w, height: h } = this;
    for (const p of particles) {
      const edge = Math.floor(rand(0, 4));
      if (edge === 0) p.sx = rand(-w * 0.1, w * 1.1);
      else if (edge === 1) p.sx = rand(-w * 0.1, w * 1.1);
      else if (edge === 2) p.sx = w * rand(-0.1, 0.05);
      else p.sx = w * rand(0.95, 1.1);
      p.sy = edge < 2 ? (edge === 0 ? h * rand(-0.05, 0.15) : h * rand(0.85, 1.05)) : rand(0, h);
      p.cx = rand(0, w);
      p.cy = rand(-h * 0.1, h * 0.4);
      p.delay = (p.nx || 0) * 0.22 + rand(0, 0.18);
      p.dur = rand(0.55, 0.95);
      p.size = rand(0.8, 2.4);
      p.spark = Math.random() < 0.25;
    }
    const burst = Array.from({ length: 70 }, () => {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(60, 420);
      return {
        x: 0,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.7,
        life: rand(0.5, 1.4),
        size: rand(0.8, 2.6),
      };
    });
    this.hero = {
      card,
      t: 0,
      phase: 'gather',
      particles,
      burst,
      burstAt: null,
      sigRect,
      rect: this._heroRect(),
      exitFrom: null,
    };
  }

  _heroRect() {
    const { width: w, height: h } = this;
    const width = clamp(Math.min(w * 0.46, h * 0.72), 420, 980);
    const height = (width * CARD_H) / CARD_W;
    return { x: (w - width) / 2, y: (h - height) / 2 - h * 0.02, w: width, h: height };
  }

  _heroSignatureRect() {
    const rect = this._heroRect();
    const s = rect.w / CARD_W;
    return {
      x: rect.x + LAYOUT.pad * s,
      y: rect.y + LAYOUT.sigTop * s,
      w: (CARD_W - LAYOUT.pad * 2) * s,
      h: LAYOUT.sigH * s,
    };
  }

  _sampleParticles(img, sigRect, max) {
    if (!img) {
      return Array.from({ length: 260 }, () => ({
        x: rand(sigRect.x, sigRect.x + sigRect.w),
        y: rand(sigRect.y, sigRect.y + sigRect.h),
        nx: rand(0, 1),
        ny: rand(0, 1),
      })).map((p) => ({ ...p, targetX: p.x, targetY: p.y }));
    }
    const sw = 220;
    const sh = 150;
    const canvas = createCanvas(sw, sh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const box = containRect(img.naturalWidth || 1, img.naturalHeight || 1, 0, 0, sw, sh);
    ctx.drawImage(img, box.x, box.y, box.w, box.h);
    let data;
    try {
      data = ctx.getImageData(0, 0, sw, sh).data;
    } catch {
      return [];
    }
    const points = [];
    for (let y = 0; y < sh; y += 2) {
      for (let x = 0; x < sw; x += 2) {
        const alpha = data[(y * sw + x) * 4 + 3];
        if (alpha > 110) points.push({ nx: x / sw, ny: y / sh });
      }
    }
    for (let i = points.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [points[i], points[j]] = [points[j], points[i]];
    }
    const chosen = points.slice(0, Math.min(max, Math.max(180, Math.floor(points.length * 0.45))));
    return chosen.map((p) => ({
      nx: p.nx,
      ny: p.ny,
      targetX: sigRect.x + p.nx * sigRect.w,
      targetY: sigRect.y + p.ny * sigRect.h,
    }));
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.t += dt;
    this.rotY += dt * (this.reduced ? 0.02 : 0.075);
    this.parallax.x += (this.parallax.tx - this.parallax.x) * Math.min(1, dt * 3);
    this.parallax.y += (this.parallax.ty - this.parallax.y) * Math.min(1, dt * 3);

    for (const card of this.cards) {
      card.entry = Math.min(1, card.entry + dt * 3.2);
      if (this.mode === 'star' && card.star) {
        card.star.z += card.star.speed * dt * 1.4;
        if (card.star.z > 1.25) {
          card.star.z = -1.25;
          card.star.x = rand(-1, 1);
          card.star.y = rand(-1, 1);
        }
      }
      if (this.mode === 'bubble' && card.bubble) {
        const b = card.bubble;
        b.y -= b.speed * dt;
        b.phase += dt * 0.7;
        if (b.y < -0.35) {
          b.y = 1.15;
          b.x = rand(0.08, 0.92);
        }
      }
    }

    if (this.hero) this._updateHero(dt);

    for (const s of this.stars) {
      s.twinkle += dt * 1.6;
      s.x += dt * 4 * s.z;
      if (s.x > this.width / 2) s.x = -this.width / 2;
    }
    for (const b of this.bubbles) {
      b.y -= b.vy * dt;
      b.phase += dt;
      if (b.y < -40) {
        b.y = this.height + 40;
        b.x = rand(0, this.width);
      }
    }
    this._layout();
  }

  _updateHero(dt) {
    const hero = this.hero;
    hero.t += dt;
    const card = hero.card;
    if (hero.t < 1.05) hero.phase = 'gather';
    else if (hero.t < 1.7) hero.phase = 'settle';
    else if (hero.t < 4.1) hero.phase = 'hold';
    else if (hero.t < 4.8) hero.phase = 'exit';
    else {
      card.visible = true;
      card.entry = 0;
      this.hero = null;
      return;
    }
    hero.rect = this._heroRect();
    if (hero.phase === 'hold' && hero.burstAt === null) {
      hero.burstAt = hero.t;
    }
  }

  // ---------------- 布局 ----------------

  _layout() {
    this.debug.layouts++;
    const { width: w, height: h } = this;
    if (!w || !h) return;
    const cx = w / 2 + this.parallax.x * 18;
    const cy = h / 2 + this.parallax.y * 12;
    const count = Math.max(1, this.cards.length);
    const countFactor = clamp(Math.pow(7 / count, 0.3), 0.55, 1.45);
    const baseCard = clamp(Math.min(w, h) * 0.235 * countFactor, 104, 420);
    this._baseCard = baseCard;
    this._globeCenter = { cx, cy, R: Math.min(w * 0.33, h * 0.4) };

    if (this.mode === 'globe') {
      const { R } = this._globeCenter;
      for (const card of this.cards) {
        const p = this._projectSphere(card.sphere, R, cx, cy);
        const depth = (p.z + 1) / 2;
        card.pos.x = p.x;
        card.pos.y = p.y;
        card.pos.size = baseCard * (0.7 + 0.42 * depth) * (clamp(card.entry, 0, 1) * 0.25 + 0.75);
        card.pos.alpha = (0.34 + 0.66 * depth) * clamp(card.entry, 0, 1);
        card.pos.z = p.z;
        card.pos.rot = card.rotSeed * (1 - depth);
      }
      this.cards.sort((a, b) => a.pos.z - b.pos.z);
    } else if (this.mode === 'star') {
      for (const card of this.cards) {
        const st = card.star;
        if (!st) continue;
        const persp = 1 / (1.55 - st.z * 0.45);
        const z = st.z;
        const size = baseCard * (0.5 + 0.85 * persp) * 0.72;
        card.pos.x = cx + st.x * w * 0.42 * persp * 0.75;
        card.pos.y = cy + st.y * h * 0.42 * persp * 0.75;
        card.pos.size = size * (clamp(card.entry, 0, 1) * 0.3 + 0.7);
        card.pos.alpha = clamp((1.15 - Math.abs(z)) * 0.9, 0, 1) * clamp(card.entry, 0, 1) * 0.95;
        card.pos.z = z;
        card.pos.rot = Math.sin(this.t * 0.3 + card.rotSeed * 40) * 0.05;
      }
      this.cards.sort((a, b) => a.pos.z - b.pos.z);
    } else {
      for (const card of this.cards) {
        const b = card.bubble;
        if (!b) continue;
        const scale = b.scale * (0.75 + 0.35 * (1 - b.y));
        const size = baseCard * scale * 0.9;
        card.pos.x = b.x * w + Math.sin(b.phase) * b.sway;
        card.pos.y = b.y * h;
        card.pos.size = size * (clamp(card.entry, 0, 1) * 0.3 + 0.7);
        card.pos.alpha = clamp(0.45 + 0.55 * (1 - b.y), 0.35, 1) * clamp(card.entry, 0, 1);
        card.pos.z = 1 - b.y;
        card.pos.rot = Math.sin(b.phase * 0.8) * 0.03;
      }
      this.cards.sort((a, b) => b.pos.z - a.pos.z);
    }
  }

  /** 球面坐标 → 屏幕坐标（与卡片共用同一套投影，保证与经纬网对齐） */
  _projectSphere(sp = { x: 0, y: 0, z: 0 }, R = 300, cx = this.width / 2, cy = this.height / 2) {
    const cosY = Math.cos(this.rotY);
    const sinY = Math.sin(this.rotY);
    const x1 = sp.x * cosY + sp.z * sinY;
    const z1 = -sp.x * sinY + sp.z * cosY;
    const tilt = -0.22;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const y2 = sp.y * cosT - z1 * sinT;
    const z2 = sp.y * sinT + z1 * cosT;
    const persp = 1 / (1 - z2 * 0.34);
    return { x: cx + x1 * R * persp, y: cy + y2 * R * persp, z: z2, persp };
  }

  // ---------------- 绘制 ----------------

  draw() {
    const ctx = this.ctx;
    const { width: w, height: h, dpr } = this;
    if (!w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.mode === 'globe') this._drawGlobeRings(ctx);
    if (this.mode === 'star') this._drawStars(ctx);
    if (this.mode === 'bubble') this._drawBubbles(ctx);

    for (const card of this.cards) {
      if (!card.texture || !card.visible) continue;
      if (this.hero && this.hero.card.id === card.id) continue;
      this._drawCard(ctx, card, card.pos.x, card.pos.y, card.pos.size, card.pos.alpha, card.pos.rot);
      if (this.highlightId === card.id) this._drawHighlight(ctx, card);
    }

    if (this.hero) this._drawHero(ctx);
  }

  _drawGlobeRings(ctx) {
    const { width: w, height: h } = this;
    const { cx, cy, R } = this._globeCenter || { cx: w / 2, cy: h / 2, R: Math.min(w * 0.33, h * 0.4) };
    ctx.save();
    ctx.lineWidth = 1;

    // 中心微光，让球体有体积感
    const glow = ctx.createRadialGradient(cx, cy, R * 0.08, cx, cy, R * 1.35);
    glow.addColorStop(0, rgba(this.accent, 0.1));
    glow.addColorStop(0.55, rgba(this.accent, 0.035));
    glow.addColorStop(1, rgba(this.accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);

    // 纬线
    for (let lat = -75; lat <= 75; lat += 15) {
      if (lat === 0) continue;
      const phi = (lat * Math.PI) / 180;
      const cosPhi = Math.cos(phi);
      ctx.beginPath();
      for (let i = 0; i <= 72; i++) {
        const theta = (i / 72) * Math.PI * 2;
        const p = this._projectSphere({ x: cosPhi * Math.cos(theta), y: Math.sin(phi), z: cosPhi * Math.sin(theta) }, R, cx, cy);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = rgba(this.accent, 0.05);
      ctx.stroke();
    }

    // 赤道加重
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const theta = (i / 96) * Math.PI * 2;
      const p = this._projectSphere({ x: Math.cos(theta), y: 0, z: Math.sin(theta) }, R, cx, cy);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = rgba(this.accent, 0.14);
    ctx.stroke();

    // 经线
    for (let lon = 0; lon < 180; lon += 45) {
      const l = (lon * Math.PI) / 180;
      ctx.beginPath();
      for (let i = 0; i <= 72; i++) {
        const theta = (i / 72) * Math.PI * 2;
        const p = this._projectSphere({ x: Math.cos(theta) * Math.cos(l), y: Math.sin(theta), z: Math.cos(theta) * Math.sin(l) }, R, cx, cy);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = rgba(this.accent, 0.035);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawStars(ctx) {
    const { width: w, height: h } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.stars) {
      const x = ((s.x % (w / 2)) + w / 2) % w;
      const y = ((s.y % (h / 2)) + h / 2) % h;
      const a = 0.18 + 0.45 * (0.5 + 0.5 * Math.sin(s.twinkle));
      ctx.globalAlpha = a * s.z;
      ctx.fillStyle = '#dbe9ff';
      ctx.beginPath();
      ctx.arc(x, y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawBubbles(ctx) {
    ctx.save();
    for (const b of this.bubbles) {
      ctx.strokeStyle = rgba(this.accent, 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(b.x + Math.sin(b.phase) * 8, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
      const g = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, 0, b.x, b.y, b.r);
      g.addColorStop(0, rgba('#ffffff', 0.14));
      g.addColorStop(1, rgba('#ffffff', 0));
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
  }

  _drawCard(ctx, card, x, y, size, alpha, rot) {
    if (size <= 1 || alpha <= 0.01) return;
    const cw = size;
    const ch = (size * CARD_H) / CARD_W;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (card.pos.z > 0.3 && this.mode === 'globe') {
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 10;
    }
    if (this.mode === 'bubble') {
      const r = Math.max(cw, ch) * 0.66;
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
      g.addColorStop(0, rgba('#ffffff', 0.16 * alpha));
      g.addColorStop(0.7, rgba(this.accent, 0.05 * alpha));
      g.addColorStop(1, rgba(this.accent, 0.14 * alpha));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(this.accent, 0.28 * alpha);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.drawImage(card.texture, -cw / 2, -ch / 2, cw, ch);
    ctx.restore();
  }

  _drawHighlight(ctx, card) {
    const { x, y, size } = card.pos;
    const cw = size * 1.06;
    const ch = (cw * CARD_H) / CARD_W;
    ctx.save();
    ctx.strokeStyle = rgba(this.accent, 0.85);
    ctx.lineWidth = 3;
    ctx.shadowColor = rgba(this.accent, 0.8);
    ctx.shadowBlur = 26;
    roundRect(ctx, x - cw / 2, y - ch / 2, cw, ch, 18);
    ctx.stroke();
    ctx.restore();
  }

  _drawHero(ctx) {
    const hero = this.hero;
    const card = hero.card;
    const rect = hero.rect;
    const scale = rect.w / CARD_W;
    const alphaIn = clamp((hero.t - 0.35) / 0.55, 0, 1);

    // 光晕
    const glow = ctx.createRadialGradient(rect.x + rect.w / 2, rect.y + rect.h / 2, 10, rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w * 0.78);
    glow.addColorStop(0, rgba(this.accent, 0.18 * alphaIn));
    glow.addColorStop(0.5, rgba(this.accent, 0.06 * alphaIn));
    glow.addColorStop(1, rgba(this.accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(rect.x - rect.w * 0.4, rect.y - rect.h * 0.4, rect.w * 1.8, rect.h * 1.8);

    let drawRect = rect;
    let drawAlpha = 1;
    if (hero.phase === 'exit') {
      const p = easeInOutCubic(clamp((hero.t - 4.1) / 0.7, 0, 1));
      const slot = card.pos;
      const from = rect;
      const to = { x: slot.x - slot.size / 2, y: slot.y - (slot.size * CARD_H) / CARD_W / 2, w: slot.size, h: (slot.size * CARD_H) / CARD_W };
      drawRect = {
        x: from.x + (to.x - from.x) * p,
        y: from.y + (to.y - from.y) * p,
        w: from.w + (to.w - from.w) * p,
        h: from.h + (to.h - from.h) * p,
      };
      drawAlpha = 1 - p;
    } else if (hero.phase === 'hold') {
      drawRect = { ...rect, y: rect.y + Math.sin(hero.t * 1.6) * 5 };
    }

    if (hero.phase !== 'exit') this._drawHeroParticles(ctx, hero);

    if (alphaIn > 0) {
      ctx.save();
      ctx.globalAlpha = alphaIn * drawAlpha;
      ctx.translate(drawRect.x + drawRect.w / 2, drawRect.y + drawRect.h / 2);
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 46;
      ctx.shadowOffsetY = 18;
      const s = drawRect.w;
      ctx.drawImage(card.texture, -s / 2, -(s * CARD_H) / CARD_W / 2, s, (s * CARD_H) / CARD_W);
      ctx.restore();
    }

    if (hero.burstAt !== null && hero.phase === 'hold') {
      this._drawBurst(ctx, hero);
    }

    // 顶部提示文字
    if (hero.phase !== 'exit') {
      const a = clamp((hero.t - 1.2) / 0.8, 0, 1) * alphaIn;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.fillStyle = rgba(this.accent, 0.95);
      ctx.font = `600 ${Math.round(clamp(rect.w * 0.038, 16, 30))}px ${FONT_SERIF}`;
      ctx.fillText('落笔成景 · 已上墙', rect.x + rect.w / 2, rect.y - rect.h * 0.16);
      ctx.fillStyle = rgba('#e9f0f6', 0.55);
      ctx.font = `400 ${Math.round(clamp(rect.w * 0.024, 12, 18))}px ${FONT_SANS}`;
      ctx.fillText('愿你在山水之间，留下此刻的心意', rect.x + rect.w / 2, rect.y + rect.h * 1.14);
      ctx.restore();
    }
  }

  _drawHeroParticles(ctx, hero) {
    const t = hero.t;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of hero.particles) {
      const local = clamp((t - p.delay) / p.dur, 0, 1);
      if (local <= 0) continue;
      const e = easeOutCubic(local);
      const x = (1 - e) * (1 - e) * p.sx + 2 * (1 - e) * e * p.cx + e * e * p.targetX;
      const y = (1 - e) * (1 - e) * p.sy + 2 * (1 - e) * e * p.cy + e * e * p.targetY;
      const fade = local < 0.75 ? 1 : 1 - (local - 0.75) / 0.25;
      const alpha = clamp(fade, 0, 1) * (0.55 + 0.45 * Math.sin(t * 6 + p.targetX));
      ctx.globalAlpha = alpha * 0.75;
      ctx.fillStyle = p.spark ? 'rgba(255, 236, 190, 0.95)' : rgba(this.accent, 0.9);
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawBurst(ctx, hero) {
    const elapsed = hero.t - hero.burstAt;
    if (elapsed > 1.6) return;
    const rect = hero.rect;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of hero.burst) {
      const p = elapsed / s.life;
      if (p > 1) continue;
      const x = cx + s.vx * elapsed;
      const y = cy + s.vy * elapsed + 160 * elapsed * elapsed;
      ctx.globalAlpha = (1 - p) * 0.8;
      ctx.fillStyle = 'rgba(255, 240, 200, 0.9)';
      ctx.beginPath();
      ctx.arc(x, y, s.size * (1 - p * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------- 交互 ----------------

  hitTest(x, y) {
    const sorted = [...this.cards].filter((c) => c.visible && c.texture).sort((a, b) => b.pos.z - a.pos.z);
    for (const card of sorted) {
      const w = card.pos.size;
      const h = (w * CARD_H) / CARD_W;
      const pad = 8;
      if (Math.abs(x - card.pos.x) <= w / 2 + pad && Math.abs(y - card.pos.y) <= h / 2 + pad) return card.item;
    }
    return null;
  }

  setParallax(nx, ny) {
    this.parallax.tx = clamp(nx, -1, 1) * 0.6;
    this.parallax.ty = clamp(ny, -1, 1) * 0.6;
  }

  setHighlight(id) {
    this.highlightId = id;
  }
}
