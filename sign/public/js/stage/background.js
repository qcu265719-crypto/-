/**
 * 大屏背景：水墨山水的实时绘制。
 * 静态部分（天空 / 山峦 / 雾气）预渲染到离屏画布，逐帧只绘制视差与动态粒子，4K 下也能跑满帧。
 */
import { clamp, mixHex, rand, rgba } from '../lib/util.js';

/** 固定种子随机数，保证山形在窗口缩放/重绘时一致 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRidge(seed, width, count) {
  const rnd = mulberry32(seed);
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = -width * 0.08 + width * 1.16 * t;
    const envelope = 0.3 + 0.7 * Math.sin(Math.PI * (0.04 + 0.92 * t));
    // 峰谷交替：偶数点为山峰，奇数点为山谷，再加一点随机起伏
    const isPeak = i % 2 === 0;
    const height = isPeak ? 0.72 + rnd() * 0.5 : 0.16 + rnd() * 0.3;
    pts.push({ x, y: envelope * height });
  }
  return pts;
}

const THEMES = {  ink: {
    sky: ['#050e17', '#0a1d2b', '#123343', '#2c5a5c', '#c8b58c'],
    mountain: ['#0b2230', '#0e2a37', '#123340', '#173d47'],
    glow: '#f0d9a8',
    mist: 'rgba(214, 232, 228, 0.10)',
    star: 'rgba(240, 246, 255, 0.9)',
    motes: '#f2d79a',
  },
  dawn: {
    sky: ['#122238', '#2a3c5c', '#6a5a78', '#c97f63', '#f4cf9a'],
    mountain: ['#20283f', '#2b3349', '#3a4053', '#4a4c58'],
    glow: '#ffd9a0',
    mist: 'rgba(255, 226, 196, 0.14)',
    star: 'rgba(255, 246, 224, 0.75)',
    motes: '#ffd9a0',
  },
  night: {
    sky: ['#02040a', '#040a18', '#071229', '#0d1c3a', '#1a2a4a'],
    mountain: ['#050b16', '#071020', '#0a162a', '#0d1d34'],
    glow: '#cfe0ff',
    mist: 'rgba(180, 205, 255, 0.08)',
    star: 'rgba(255, 255, 255, 0.95)',
    motes: '#bcd4ff',
  },
};

export class ScenicBackground {
  constructor(canvas, { theme = 'ink', accent = '#e0b45c' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.themeName = theme;
    this.accent = accent;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.static = document.createElement('canvas');
    this.staticCtx = this.static.getContext('2d');
    this.stars = [];
    this.motes = [];
    this.mist = [];
    this.ridges = [];
    this.t = 0;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  get theme() {
    return THEMES[this.themeName] || THEMES.ink;
  }

  setTheme(name, accent) {
    this.themeName = THEMES[name] ? name : 'ink';
    if (accent) this.accent = accent;
    this._buildScene();
  }

  resize(cssWidth, cssHeight, dpr = 1) {
    this.width = Math.max(320, Math.round(cssWidth));
    this.height = Math.max(240, Math.round(cssHeight));
    this.dpr = clamp(dpr, 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this._buildScene();
  }

  _buildScene() {
    const { width: w, height: h } = this;
    if (!w || !h) return;
    const theme = this.theme;
    this.static.width = w;
    this.static.height = h;
    const ctx = this.staticCtx;
    ctx.clearRect(0, 0, w, h);

    // 天空
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    theme.sky.forEach((c, i) => sky.addColorStop(i / (theme.sky.length - 1), c));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // 光源（落日 / 月亮）
    const sunX = w * 0.74;
    const sunY = h * 0.46;
    const sunR = Math.min(w, h) * 0.075;
    const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.2, sunX, sunY, sunR * 7);
    glow.addColorStop(0, rgba(theme.glow, 0.85));
    glow.addColorStop(0.16, rgba(theme.glow, 0.35));
    glow.addColorStop(0.45, rgba(theme.glow, 0.09));
    glow.addColorStop(1, rgba(theme.glow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    const disc = ctx.createRadialGradient(sunX - sunR * 0.3, sunY - sunR * 0.3, sunR * 0.1, sunX, sunY, sunR);
    disc.addColorStop(0, rgba('#fffaf0', 0.98));
    disc.addColorStop(0.7, rgba(theme.glow, 0.95));
    disc.addColorStop(1, rgba(theme.glow, 0.72));
    ctx.fillStyle = disc;
    ctx.fill();

    // 静态星点
    const starCount = this.themeName === 'night' ? 260 : this.themeName === 'ink' ? 130 : 60;
    ctx.fillStyle = theme.star;
    for (let i = 0; i < starCount; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h * 0.62;
      const r = Math.random() * 1.4 + 0.3;
      ctx.globalAlpha = 0.25 + Math.random() * 0.65 * (1 - y / (h * 0.7));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 远山：四层，越远越淡；用固定种子生成峰峦，窗口缩放时山形保持稳定
    const layers = theme.mountain.length;
    for (let layer = 0; layer < layers; layer++) {
      const depth = layer / (layers - 1);
      const baseY = h * (0.55 + depth * 0.17);
      const amp = h * (0.2 - depth * 0.085);
      const color = mixHex(theme.mountain[layer], theme.sky[2], 0.12 * (layers - layer - 1));
      const peaks = makeRidge(layer * 17 + 3, w, 9 + layer * 3);

      const top = baseY - amp * 1.1;
      const grad = ctx.createLinearGradient(0, top, 0, h);
      grad.addColorStop(0, mixHex(color, theme.glow, 0.16 - depth * 0.09));
      grad.addColorStop(0.3, color);
      grad.addColorStop(1, mixHex(color, '#02070c', 0.45));

      ctx.beginPath();
      ctx.moveTo(peaks[0].x, h);
      ctx.lineTo(peaks[0].x, baseY - peaks[0].y * amp);
      for (let i = 1; i < peaks.length; i++) {
        const prev = peaks[i - 1];
        const cur = peaks[i];
        const mx = (prev.x + cur.x) / 2;
        const my = baseY - ((prev.y + cur.y) / 2) * amp;
        ctx.quadraticCurveTo(prev.x, baseY - prev.y * amp, mx, my);
      }
      const last = peaks[peaks.length - 1];
      ctx.lineTo(last.x, baseY - last.y * amp);
      ctx.lineTo(last.x, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // 山脊微光
      ctx.strokeStyle = rgba(theme.glow, 0.16 + depth * 0.08);
      ctx.lineWidth = Math.max(1, h * 0.0012);
      ctx.stroke();

      // 山脚雾气，拉开层次
      const mistBand = ctx.createLinearGradient(0, baseY - amp * 0.15, 0, baseY + h * 0.08);
      mistBand.addColorStop(0, rgba(theme.glow, 0));
      mistBand.addColorStop(0.55, rgba(theme.glow, 0.05 + depth * 0.05));
      mistBand.addColorStop(1, rgba(theme.glow, 0));
      ctx.fillStyle = mistBand;
      ctx.fillRect(0, baseY - amp * 0.15, w, h * 0.16);
    }

    // 水面倒影（底部渐隐）
    const water = ctx.createLinearGradient(0, h * 0.78, 0, h);
    water.addColorStop(0, rgba('#000000', 0));
    water.addColorStop(1, rgba('#000000', 0.45));
    ctx.fillStyle = water;
    ctx.fillRect(0, h * 0.78, w, h * 0.22);

    // 动态元素初始化
    this.stars = Array.from({ length: 70 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h * 0.6,
      r: rand(0.6, 1.8),
      phase: rand(0, Math.PI * 2),
      speed: rand(0.6, 2.2),
    }));
    this.motes = Array.from({ length: 36 }, () => ({
      x: rand(0, w),
      y: rand(h * 0.2, h * 0.95),
      r: rand(1, 3.2),
      vx: rand(-6, 6),
      vy: rand(-10, -2),
      phase: rand(0, Math.PI * 2),
      alpha: rand(0.15, 0.6),
    }));
    this.mist = Array.from({ length: 5 }, (_, i) => ({
      x: rand(-w * 0.2, w),
      y: h * (0.52 + i * 0.07),
      rx: rand(w * 0.22, w * 0.45),
      ry: rand(h * 0.02, h * 0.06),
      vx: rand(2, 8) * (i % 2 ? 1 : -1),
      alpha: rand(0.05, 0.14),
    }));
  }

  update(dt) {
    this.t += dt;
    const { width: w, height: h } = this;
    for (const m of this.motes) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.phase += dt * 0.8;
      if (m.y < h * 0.15 || m.x < -20 || m.x > w + 20) {
        m.x = rand(0, w);
        m.y = rand(h * 0.55, h * 1.02);
      }
    }
    for (const c of this.mist) {
      c.x += c.vx * dt;
      if (c.x - c.rx > w + 40) c.x = -c.rx;
      if (c.x + c.rx < -40) c.x = w + c.rx;
    }
    for (const s of this.stars) s.phase += dt * s.speed;
  }

  draw() {
    const ctx = this.ctx;
    const { width: w, height: h, dpr } = this;
    if (!w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 视差：静态底图轻微呼吸位移
    const drift = this.reduced ? 0 : Math.sin(this.t * 0.06) * w * 0.006;
    ctx.drawImage(this.static, drift - w * 0.004, 0, w * 1.008, h);

    const theme = this.theme;

    // 闪烁星点
    ctx.save();
    for (const s of this.stars) {
      const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(s.phase));
      ctx.globalAlpha = a;
      ctx.fillStyle = theme.star;
      ctx.beginPath();
      ctx.arc(s.x + drift * 0.4, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 雾气
    for (const c of this.mist) {
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.rx);
      g.addColorStop(0, rgba(theme.glow, c.alpha));
      g.addColorStop(1, rgba(theme.glow, 0));
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(1, c.ry / c.rx);
      ctx.translate(-c.x, -c.y);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 光尘
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes) {
      const a = m.alpha * (0.55 + 0.45 * Math.sin(m.phase));
      ctx.globalAlpha = a;
      ctx.fillStyle = theme.motes;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 暗角
    const vignette = ctx.createRadialGradient(w / 2, h * 0.52, Math.min(w, h) * 0.25, w / 2, h * 0.5, Math.max(w, h) * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }
}
