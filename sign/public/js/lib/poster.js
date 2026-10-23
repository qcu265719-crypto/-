/**
 * 专属海报合成（1080×1440）：签名 + 留影 + 留言 + 二维码。
 * 手机端保存/分享、现场打印留念、后台预览共用同一套绘制逻辑。
 */
import { encodeQr } from './qr.js';
import { loadImage, mixHex, rgba, roundRect } from './util.js';

const W = 1080;
const H = 1440;
const FONT_SANS = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const FONT_SERIF = '"Songti SC", "SimSun", "Noto Serif SC", serif';

const PALETTES = {
  ink: { sky: ['#07141f', '#0d2434', '#164050', '#2e5f5e'], ridge: ['#0a1c28', '#0e2634', '#123240', '#173d47'], glow: '#f3dCA8', accent: '#e0b45c' },
  dawn: { sky: ['#1a2338', '#3b4260', '#8a5f63', '#e0a06f'], ridge: ['#20283f', '#2b3349', '#3a4053', '#4a4c58'], glow: '#ffe0ae', accent: '#e8a869' },
  night: { sky: ['#02040a', '#050b1a', '#081428', '#0d1d34'], ridge: ['#050b16', '#071020', '#0a162a', '#0d1d34'], glow: '#d6e4ff', accent: '#9fc0ff' },
};

function hashRand(seed, i) {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function ridgePoints(width, count, seed) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const envelope = 0.34 + 0.66 * Math.sin(Math.PI * (0.06 + 0.9 * t));
    pts.push({ x: -width * 0.06 + width * 1.12 * t, y: envelope * (0.28 + hashRand(seed, i) * 0.95) });
  }
  return pts;
}

function drawBackground(ctx, palette) {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  palette.sky.forEach((c, i) => sky.addColorStop(i / (palette.sky.length - 1), c));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // 光晕
  const glow = ctx.createRadialGradient(W * 0.76, H * 0.3, 20, W * 0.76, H * 0.3, W * 0.8);
  glow.addColorStop(0, rgba(palette.glow, 0.5));
  glow.addColorStop(0.35, rgba(palette.glow, 0.14));
  glow.addColorStop(1, rgba(palette.glow, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // 星点
  for (let i = 0; i < 90; i++) {
    const x = (i * 733.7) % W;
    const y = (i * 401.3) % (H * 0.55);
    ctx.globalAlpha = 0.15 + ((i * 37) % 60) / 100;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 1 + (i % 3) * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 山峦：四层，越近越暗，山脊带一点天光
  for (let layer = 0; layer < 4; layer++) {
    const depth = layer / 3;
    const baseY = H * (0.6 + depth * 0.16);
    const amp = H * (0.2 - depth * 0.08);
    const color = mixHex(palette.ridge[layer], palette.sky[1], 0.1 * (3 - layer));
    const pts = ridgePoints(W, 5 + layer * 2, layer * 7 + 3);

    const grad = ctx.createLinearGradient(0, baseY - amp, 0, H);
    grad.addColorStop(0, mixHex(color, palette.glow, 0.16 - depth * 0.1));
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, mixHex(color, '#02070c', 0.4));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, H);
    ctx.lineTo(pts[0].x, baseY - pts[0].y * amp);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const mx = (prev.x + cur.x) / 2;
      const my = baseY - ((prev.y + cur.y) / 2) * amp;
      ctx.quadraticCurveTo(prev.x, baseY - prev.y * amp, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, baseY - last.y * amp);
    ctx.lineTo(last.x, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = rgba(palette.glow, 0.14 + depth * 0.06);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 雾气
  for (let i = 0; i < 4; i++) {
    const y = H * (0.56 + i * 0.07);
    const g = ctx.createRadialGradient(W * (0.2 + i * 0.2), y, 10, W * (0.2 + i * 0.2), y, W * 0.6);
    g.addColorStop(0, rgba(palette.glow, 0.08));
    g.addColorStop(1, rgba(palette.glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 120, W, 240);
  }

  // 底部压暗
  const bottom = ctx.createLinearGradient(0, H * 0.7, 0, H);
  bottom.addColorStop(0, 'rgba(0,0,0,0)');
  bottom.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H * 0.7, W, H * 0.3);
}

function drawSeal(ctx, x, y, size, accent = '#a8332e') {
  roundRect(ctx, x, y, size, size, size * 0.16);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x + size * 0.12, y + size * 0.12, size * 0.76, size * 0.76, size * 0.08);
  ctx.stroke();
  ctx.fillStyle = '#f7ece0';
  ctx.font = `600 ${Math.round(size * 0.5)}px ${FONT_SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('留', x + size / 2, y + size / 2 + 2);
}

function wrapText(ctx, text, maxWidth, maxLines = 3) {
  const chars = [...String(text || '')];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line += ch;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.join('').length < chars.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

/** 把二维码画进指定区域（不改变目标画布尺寸） */
export function drawQrInto(ctx, text, x, y, size, { dark = '#0f2438', light = '#ffffff', margin = 3 } = {}) {
  const qr = encodeQr(text, { ecLevel: 'M' });
  const total = qr.size + margin * 2;
  const cell = size / total;
  ctx.save();
  ctx.fillStyle = light;
  roundRect(ctx, x, y, size, size, size * 0.06);
  ctx.fill();
  ctx.fillStyle = dark;
  for (let row = 0; row < qr.size; row++) {
    for (let col = 0; col < qr.size; col++) {
      if (qr.modules[row * qr.size + col] !== 1) continue;
      ctx.fillRect(x + (col + margin) * cell, y + (row + margin) * cell, cell + 0.5, cell + 0.5);
    }
  }
  ctx.restore();
  return qr;
}

/**
 * 绘制海报
 * @param {HTMLCanvasElement} canvas
 * @param {{item:any, config:any, mobileUrl:string, posterTheme?:string}} opts
 */
export async function drawPoster(canvas, { item, config, mobileUrl, posterTheme = 'ink' }) {
  if (!canvas) throw new Error('缺少画布');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const palette = { ...(PALETTES[posterTheme] || PALETTES.ink), accent: config?.theme?.accent || PALETTES.ink.accent };
  const title = config?.event?.title || '山水留痕';
  const subtitle = config?.event?.subtitle || '';
  const org = config?.event?.org || '';
  const qrText = mobileUrl || `${location.origin}/mobile`;

  drawBackground(ctx, palette);

  // 顶部标题
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(palette.accent, 0.85);
  ctx.font = `400 26px ${FONT_SANS}`;
  ctx.fillText(org.toUpperCase(), W / 2, 104);
  ctx.fillStyle = '#f4efe4';
  ctx.font = `600 74px ${FONT_SERIF}`;
  ctx.fillText(title, W / 2, 196);
  if (subtitle) {
    ctx.fillStyle = 'rgba(240,236,225,0.66)';
    ctx.font = `400 26px ${FONT_SANS}`;
    ctx.fillText(subtitle, W / 2, 244);
  }
  ctx.strokeStyle = rgba(palette.accent, 0.5);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 60, 276);
  ctx.lineTo(W / 2 + 60, 276);
  ctx.stroke();

  let cursorY = 320;
  let photoImg = null;
  if (item?.photoUrl) {
    try {
      photoImg = await loadImage(item.photoUrl);
    } catch {
      photoImg = null;
    }
  }

  if (photoImg) {
    const pw = 500;
    const ph = 500;
    const px = (W - pw) / 2;
    const py = cursorY;
    ctx.save();
    ctx.translate(px + pw / 2, py + ph / 2);
    ctx.rotate(-0.018);
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 16;
    ctx.fillStyle = '#fbf8f1';
    roundRect(ctx, -pw / 2 - 18, -ph / 2 - 18, pw + 36, ph + 66, 8);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save();
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, 3);
    ctx.clip();
    const scale = Math.max(pw / photoImg.naturalWidth, ph / photoImg.naturalHeight);
    const dw = photoImg.naturalWidth * scale;
    const dh = photoImg.naturalHeight * scale;
    ctx.drawImage(photoImg, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    ctx.fillStyle = 'rgba(40,50,60,0.55)';
    ctx.font = `400 20px ${FONT_SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${item.name || ''} · 留影`, 0, ph / 2 + 32);
    ctx.restore();
    cursorY = py + ph + 74;
  }

  // 签名卡片
  const cardW = photoImg ? 880 : 900;
  const cardH = photoImg ? 250 : 330;
  const cardX = (W - cardW) / 2;
  const cardY = photoImg ? Math.min(cursorY, 1000) : 470;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 12;
  const paper = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + cardH);
  paper.addColorStop(0, 'rgba(252,249,242,0.97)');
  paper.addColorStop(1, 'rgba(240,234,221,0.95)');
  roundRect(ctx, cardX, cardY, cardW, cardH, 22);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = rgba(palette.accent, 0.45);
  ctx.lineWidth = 1.5;
  roundRect(ctx, cardX, cardY, cardW, cardH, 22);
  ctx.stroke();

  if (item?.signatureUrl) {
    try {
      const sig = await loadImage(item.signatureUrl);
      const boxW = cardW - 110;
      const boxH = cardH - 92;
      const scale = Math.min(boxW / (sig.naturalWidth || 1), boxH / (sig.naturalHeight || 1));
      const dw = (sig.naturalWidth || boxW) * scale;
      const dh = (sig.naturalHeight || boxH) * scale;
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(sig, cardX + (cardW - dw) / 2, cardY + 28 + (boxH - dh) / 2, dw, dh);
      ctx.restore();
    } catch {
      /* 签名加载失败时保留空白卡片，海报仍可输出 */
    }
  }

  // 姓名
  ctx.textAlign = 'left';
  ctx.fillStyle = '#12283f';
  ctx.font = `600 40px ${FONT_SERIF}`;
  const nameX = cardX + 44;
  const nameY = cardY + cardH - 44;
  ctx.fillText(String(item?.name || '山水过客').slice(0, 14), nameX, nameY);
  drawSeal(ctx, cardX + cardW - 92, cardY + cardH - 88, 56, '#a8332e');

  // 留言
  let msgY = cardY + cardH + 66;
  if (item?.message) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(244,240,230,0.9)';
    ctx.font = `400 34px ${FONT_SERIF}`;
    const lines = wrapText(ctx, `“${item.message}”`, W - 220, 2);
    for (const line of lines) {
      ctx.fillText(line, W / 2, msgY);
      msgY += 48;
    }
  }

  // 地点 / 日期，填补下半部留白
  const venue = config?.event?.venue || '';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(240,236,226,0.5)';
  ctx.font = `400 24px ${FONT_SANS}`;
  if (venue) ctx.fillText(`· ${venue} ·`, W / 2, msgY + 47);

  // 分隔金线
  ctx.strokeStyle = rgba(palette.accent, 0.3);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 120, msgY + 83);
  ctx.lineTo(W / 2 + 120, msgY + 83);
  ctx.stroke();

  // 底部信息
  const footerY = H - 210;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(240,236,226,0.72)';
  ctx.font = `400 24px ${FONT_SANS}`;
  const d = item?.createdAt ? new Date(item.createdAt) : new Date();
  const dateStr = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  ctx.fillText(`${dateStr}`, 96, footerY + 24);
  ctx.fillStyle = rgba(palette.accent, 0.9);
  ctx.font = `600 30px ${FONT_SERIF}`;
  ctx.fillText('山水留痕 · 电子签名墙', 96, footerY - 20);
  ctx.fillStyle = 'rgba(240,236,226,0.5)';
  ctx.font = `400 22px ${FONT_SANS}`;
  ctx.fillText('扫码留下你的一笔', 96, footerY + 70);
  ctx.fillText(org, 96, footerY + 108);

  // 二维码
  const qrSize = 168;
  drawQrInto(ctx, qrText, W - qrSize - 96, H - qrSize - 92, qrSize, { dark: '#0b1a26', light: '#f8f4ea', margin: 3 });
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(240,236,226,0.6)';
  ctx.font = `400 20px ${FONT_SANS}`;
  ctx.fillText('长按识别 · 一起上墙', W - qrSize / 2 - 96, H - 66);

  // 细金边框（海报成品感）
  ctx.save();
  ctx.strokeStyle = rgba(palette.accent, 0.28);
  ctx.lineWidth = 2;
  roundRect(ctx, 26, 26, W - 52, H - 52, 12);
  ctx.stroke();
  ctx.strokeStyle = rgba(palette.accent, 0.12);
  ctx.lineWidth = 1;
  roundRect(ctx, 36, 36, W - 72, H - 72, 8);
  ctx.stroke();
  // 四角装饰
  ctx.strokeStyle = rgba(palette.accent, 0.65);
  ctx.lineWidth = 2.5;
  const corners = [
    [26, 26, 1, 1],
    [W - 26, 26, -1, 1],
    [26, H - 26, 1, -1],
    [W - 26, H - 26, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x, y + 46 * sy);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 46 * sx, y);
    ctx.stroke();
  }
  ctx.restore();

  return canvas;
}

export function posterToBlob(canvas, type = 'image/png', quality = 0.95) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((blob) => resolve(blob), type, quality);
    else resolve(null);
  });
}

export const POSTER_SIZE = { width: W, height: H };
