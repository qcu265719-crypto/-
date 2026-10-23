/**
 * 大屏主程序：待机 → 手写签名 → 粒子上墙 → 浏览/详情/打印
 * 通过 WebSocket 与手机端、后台实时同步；断线自动重连。
 */
import { bootGuard } from './lib/boot-guard.js';
import { api, ApiError } from './lib/api.js';
import { ReconnectingSocket, wallSocketPath } from './lib/wsclient.js';
import { ScenicBackground } from './stage/background.js';
import { SignatureWall } from './stage/wallstage.js';
import { SignPad } from './lib/signpad.js';
import { drawQr } from './lib/qr.js';
import * as sound from './lib/sound.js';
import { clockText, dateText, dateTextCN, makeToken, now, storage } from './lib/util.js';

bootGuard();

const $ = (id) => document.getElementById(id);
const els = {
  bg: $('bg'),
  stage: $('stage'),
  title: $('event-title'),
  sub: $('event-sub'),
  clock: $('clock'),
  date: $('event-date'),
  conn: $('conn'),
  connText: $('conn-text'),
  qrCard: $('qr-card'),
  qrCanvas: $('qr-canvas'),
  qrUrl: $('qr-url'),
  ticker: $('ticker'),
  tickerText: $('ticker-text'),
  hint: $('hint'),
  hintText: $('hint-text'),
  standby: $('standby'),
  standbyTitle: $('standby-title'),
  standbySub: $('standby-sub'),
  standbyCount: $('standby-count'),
  standbyCta: $('standby-cta'),
  toast: $('toast'),
  signPanel: $('sign-panel'),
  signClose: $('sign-close'),
  signCanvas: $('sign-canvas'),
  paperGuide: $('paper-guide'),
  swatches: $('swatches'),
  widths: $('widths'),
  btnUndo: $('btn-undo'),
  btnClear: $('btn-clear'),
  name: $('sign-name'),
  msg: $('sign-msg'),
  msgCount: $('msg-count'),
  photoRow: $('photo-row'),
  photoCheck: $('sign-photo'),
  photoPreview: $('photo-preview'),
  photoImg: $('photo-img'),
  photoRetake: $('photo-retake'),
  submit: $('sign-submit'),
  cameraPanel: $('camera-panel'),
  cameraVideo: $('camera-video'),
  cameraShot: $('camera-shot'),
  cameraCancel: $('camera-cancel'),
  cameraClose: $('camera-close'),
  detailPanel: $('detail-panel'),
  detailName: $('detail-name'),
  detailSig: $('detail-sig'),
  detailPhotoWrap: $('detail-photo-wrap'),
  detailPhoto: $('detail-photo'),
  detailMsg: $('detail-msg'),
  detailMeta: $('detail-meta'),
  detailClose: $('detail-close'),
  detailOk: $('detail-ok'),
  detailPrint: $('detail-print'),
  bootError: $('boot-error'),
};

const state = {
  config: null,
  items: [],
  stats: { total: 0, today: 0, approved: 0 },
  mode: 'standby',
  pad: null,
  photo: null,
  cameraStream: null,
  submitting: false,
  detailItem: null,
  lastActive: Date.now(),
  carouselTimer: null,
  carouselId: null,
  tickerIndex: 0,
  socket: null,
  audioReady: false,
  frameCount: 0,
};

const INK_COLORS = ['#12283f', '#a8332e', '#2f5d50', '#3c3a6b'];
const BRUSH_WIDTHS = [3, 4.6, 6.4];
let bg = null;
let wall = null;
let quality = { dpr: 1, slow: 0, fast: 0, frames: 0, acc: 0 };

// ---------------------------------------------------------------- 启动

init();

async function init() {
  setupCanvas();
  buildBrushControls();

  try {
    const [config, snapshot] = await Promise.all([api.getConfig(), api.getWall()]);
    state.config = config;
    applyConfig(config, { initial: true });
    state.items = snapshot.items || [];
    state.stats = { ...state.stats, ...(snapshot.stats || {}) };
    await wall.setItems(state.items);
    updateStats();
  } catch (err) {
    showBootError(err);
    state.config = fallbackConfig();
    applyConfig(state.config, { initial: true });
  }

  bindEvents();
  connectSocket();
  startClock();
  startIdleWatcher();
  startCarousel();
  sound.setSoundEnabled(state.config?.wall?.sound !== false);
  enterStandby();
  requestAnimationFrame(frame);
  setupWakeLock();
}

function setupCanvas() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, width > 2400 ? 1.35 : 1.75);
  quality.dpr = dpr;
  bg = new ScenicBackground(els.bg, { theme: 'ink' });
  bg.resize(width, height, Math.min(dpr, 1.6));
  wall = new SignatureWall(els.stage, { accent: '#e0b45c', ink: '#0f2438' });
  wall.resize(width, height, dpr);
  // 暴露给运维排查与自动化冒烟测试使用（只读用途）
  window.__signWall = wall;
  window.__signWallMeta = () => ({
    mode: wall.mode,
    cards: wall.cards.length,
    byId: wall.byId.size,
    items: state.items.length,
    base: Math.round(wall._baseCard || 0),
    textured: wall.cards.filter((c) => !!c.texture).length,
    sizes: wall.cards.slice(0, 6).map((c) => Math.round(c.pos.size)),
    debug: { ...wall.debug },
  });
  window.addEventListener('resize', onResize);
}

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  bg.resize(width, height, Math.min(quality.dpr, 1.6));
  wall.resize(width, height, quality.dpr);
  drawQrCanvas();
}

function fallbackConfig() {
  return {
    event: { title: '山水留痕', subtitle: '落笔成景 · 把此刻留在山水之间', org: '云栖山风景区', venue: '', date: dateText() },
    theme: { preset: 'ink', accent: '#e0b45c', ink: '#0f2438', paper: '#f6f1e6' },
    wall: { mode: 'globe', maxItems: 72, showQr: true, showTicker: true, standbySeconds: 45, sound: true },
    kiosk: { camera: false, print: true, allowMessage: true },
    moderation: { autoApprove: true, action: 'mask', maxName: 16, maxMessage: 80 },
    mobileUrl: `${location.origin}/mobile`,
  };
}

function applyConfig(config, { initial = false } = {}) {
  const previous = state.config || fallbackConfig();
  const merged = { ...previous, ...config };
  // WebSocket 的 config:update 不带解析后的手机地址时，保留已解析的局域网地址，避免二维码退回 localhost
  if (!merged.mobileUrl) merged.mobileUrl = previous.mobileUrl || '';
  if (/\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(merged.mobileUrl) && previous.mobileUrl && !/\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(previous.mobileUrl)) {
    merged.mobileUrl = previous.mobileUrl;
  }
  state.config = merged;
  const { event, theme, wall: wallCfg, kiosk } = state.config;

  els.title.textContent = event?.title || '山水留痕';
  els.sub.textContent = event?.subtitle || '';
  els.standbyTitle.textContent = event?.title || '山水留痕';
  els.standbySub.textContent = event?.subtitle || '';
  els.date.textContent = formatEventDate(event?.date);

  document.documentElement.style.setProperty('--accent', theme?.accent || '#e0b45c');
  document.documentElement.style.setProperty('--ink', theme?.ink || '#0f2438');
  document.documentElement.style.setProperty('--paper', theme?.paper || '#f6f1e6');

  bg?.setTheme(theme?.preset || 'ink', theme?.accent);
  wall?.setTheme({ accent: theme?.accent, ink: theme?.ink, paper: theme?.paper });
  if (wallCfg?.mode && wall?.mode !== wallCfg.mode) wall?.setMode(wallCfg.mode);

  els.qrCard.hidden = !wallCfg?.showQr;
  els.ticker.hidden = !wallCfg?.showTicker;
  els.photoRow.hidden = !kiosk?.camera;
  els.detailPrint.hidden = !kiosk?.print;
  els.name.maxLength = state.config.moderation?.maxName || 16;
  els.msg.maxLength = state.config.moderation?.maxMessage || 80;
  els.msgCount.textContent = `0/${els.msg.maxLength}`;
  sound.setSoundEnabled(wallCfg?.sound !== false);
  drawQrCanvas();
  updateStats();
}

function formatEventDate(value) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return dateTextCN(d);
  }
  return dateTextCN(new Date());
}

function drawQrCanvas() {
  if (!state.config) return;
  const url = state.config.mobileUrl || `${location.origin}/mobile`;
  const size = Math.round(Math.min(320, Math.max(220, window.innerHeight * 0.2)));
  try {
    drawQr(els.qrCanvas, url, { size, margin: 4, dark: '#0f2438', light: '#f6f1e6', ecLevel: 'M' });
    if (els.qrUrl) els.qrUrl.textContent = url.replace(/^https?:\/\//, '').replace(/\/mobile$/, '');
  } catch (err) {
    console.warn('二维码绘制失败', err);
  }
}

// ---------------------------------------------------------------- 时钟 / 统计

function startClock() {
  const tick = () => {
    els.clock.textContent = clockText(new Date());
  };
  tick();
  setInterval(tick, 1000);
}

function updateStats() {
  const s = state.stats;
  // 人数 = 当前展示中的签名数：新增实时 +1，删除 / 隐藏 / 清屏实时减少
  const count = Number(s.approved ?? 0);
  setStandbyCount(count);
  els.hintText.textContent = count > 0 ? `触摸屏幕 · 写下你的名字　已有 ${count} 位游客留下足迹` : '触摸屏幕 · 写下你的名字';
  updateTicker();
}

function setStandbyCount(count) {
  if (!els.standbyCount) return;
  const next = String(count);
  if (els.standbyCount.textContent === next) return;
  els.standbyCount.textContent = next;
  els.standbyCount.classList.remove('bump');
  void els.standbyCount.offsetWidth;
  els.standbyCount.classList.add('bump');
}

function updateTicker() {
  if (!state.config?.wall?.showTicker) return;
  const latest = state.items.filter((i) => i.message).slice(0, 8);
  if (!latest.length) {
    els.tickerText.innerHTML = '写下你的名字，让它留在这片山水之间';
    return;
  }
  state.tickerIndex = (state.tickerIndex + 1) % latest.length;
  const item = latest[state.tickerIndex];
  els.tickerText.innerHTML = `<b>${escapeText(item.name)}</b>：${escapeText(item.message)}`;
}

function escapeText(text = '') {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- 待机 / 轮播

function enterStandby() {
  if (state.mode === 'signing') return;
  state.mode = 'standby';
  wall?.finishHero();
  els.standby.classList.remove('hide');
  els.qrCard.classList.remove('hide');
  els.hint.style.opacity = '0';
  wall?.setHighlight(null);
  startCarousel();
}

function leaveStandby() {
  els.standby.classList.add('hide');
  els.hint.style.opacity = '0';
  stopCarousel();
}

function startCarousel() {
  stopCarousel();
  if (!state.items.length) return;
  const step = () => {
    if (state.mode !== 'standby' || !state.items.length) return;
    const pool = state.items;
    const item = pool[Math.floor(Math.random() * pool.length)];
    if (item) {
      state.carouselId = item.id;
      wall?.setHighlight(item.id);
      els.tickerText.innerHTML = `<b>${escapeText(item.name)}</b>${item.message ? `：${escapeText(item.message)}` : ' 刚刚留下了签名'}`;
    }
    state.carouselTimer = setTimeout(step, 7200);
  };
  state.carouselTimer = setTimeout(step, 2400);
}

function stopCarousel() {
  clearTimeout(state.carouselTimer);
  state.carouselTimer = null;
  wall?.setHighlight(null);
}

// ---------------------------------------------------------------- 签名流程

function buildBrushControls() {
  INK_COLORS.forEach((color, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch${i === 0 ? ' active' : ''}`;
    b.style.background = color;
    b.setAttribute('aria-label', `墨色 ${i + 1}`);
    b.dataset.color = color;
    b.addEventListener('click', () => {
      els.swatches.querySelectorAll('.swatch').forEach((n) => n.classList.toggle('active', n === b));
      state.pad?.setColor(color);
      sound.playClick();
    });
    els.swatches.appendChild(b);
  });

  BRUSH_WIDTHS.forEach((width, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `width-dot${i === 1 ? ' active' : ''}`;
    b.innerHTML = `<i style="width:${4 + i * 5}px;height:${4 + i * 5}px"></i>`;
    b.setAttribute('aria-label', `笔粗 ${width}`);
    b.addEventListener('click', () => {
      els.widths.querySelectorAll('.width-dot').forEach((n) => n.classList.toggle('active', n === b));
      state.pad?.setWidth(width);
      sound.playClick();
    });
    els.widths.appendChild(b);
  });
}

function openSign() {
  if (state.mode === 'signing') return;
  if (state.detailItem) closeDetail(true);
  leaveStandby();
  state.mode = 'signing';
  state.lastActive = Date.now();
  resetSignForm();
  els.signPanel.hidden = false;
  requestAnimationFrame(() => {
    if (!state.pad) {
      state.pad = new SignPad(els.signCanvas, {
        colors: INK_COLORS,
        onChange: (pad) => {
          els.paperGuide.classList.toggle('hide', !pad.isEmpty());
        },
      });
    } else {
      state.pad.resize();
      state.pad.clear();
    }
    els.paperGuide.classList.remove('hide');
  });
}

function resetSignForm() {
  els.name.value = '';
  els.msg.value = '';
  els.msgCount.textContent = `0/${els.msg.maxLength}`;
  els.photoCheck.checked = false;
  state.photo = null;
  els.photoPreview.hidden = true;
  els.submit.disabled = false;
  els.submit.textContent = '落笔生花 · 上墙';
}

function closeSign() {
  els.signPanel.hidden = true;
  state.photo = null;
  if (state.mode === 'signing') {
    state.mode = 'browse';
    state.lastActive = Date.now();
    els.hint.style.opacity = '1';
    stopCarousel();
  }
}

async function submitSignature() {
  if (state.submitting || !state.pad) return;
  if (state.pad.strokeCount === 0) {
    toast('请先写下你的名字', 'error');
    sound.playError();
    return;
  }
  const signature = state.pad.exportPng({ maxWidth: 1600, padding: 0.045 });
  if (!signature) {
    toast('签名内容为空，请重新书写', 'error');
    return;
  }
  state.submitting = true;
  els.submit.disabled = true;
  els.submit.textContent = '正在上墙…';
  const payload = {
    name: els.name.value.trim(),
    message: els.msg.value.trim(),
    signature,
    photo: state.photo,
    source: 'kiosk',
    clientToken: makeToken('kiosk'),
  };
  try {
    const item = await api.submitSignature(payload);
    closeSign();
    if (item.status === 'pending') {
      toast('已提交，等待工作人员审核');
    } else {
      sound.playChime();
      if (!state.items.some((i) => i.id === item.id)) {
        state.items = [item, ...state.items].slice(0, state.config.wall.maxItems || 72);
        wall.addItem(item, { hero: true }).catch(() => {});
      }
      toast('你的签名已经飞入山水之间');
      updateStats();
    }
  } catch (err) {
    const message = err instanceof ApiError ? err.message : '提交失败，请稍后重试';
    toast(message, 'error');
    sound.playError();
    els.submit.disabled = false;
    els.submit.textContent = '落笔生花 · 上墙';
  } finally {
    state.submitting = false;
  }
}

function handleNewSignature(item, { fromSelf = false } = {}) {
  if (!item?.id) return;
  if (state.items.some((i) => i.id === item.id)) return;
  if (item.status && item.status !== 'approved') return;
  state.items = [item, ...state.items].slice(0, state.config?.wall?.maxItems || 72);
  // 待机遮罩打开时不播放"飞入"大动画，避免与遮罩文字叠在一起；签名面板打开时照常播放
  const hero = state.mode !== 'standby';
  wall?.addItem(item, { hero }).catch(() => {});
  if (!fromSelf) {
    sound.playChime();
    toast(`「${item.name}」的签名已上墙`);
  }
  updateStats();
}

// ---------------------------------------------------------------- 拍照

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('当前设备不支持拍照，可跳过留影直接上墙', 'error');
    els.photoCheck.checked = false;
    return;
  }
  els.cameraPanel.hidden = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    state.cameraStream = stream;
    els.cameraVideo.srcObject = stream;
    await els.cameraVideo.play().catch(() => {});
  } catch (err) {
    toast('无法打开摄像头，请检查设备或被浏览器拦截', 'error');
    els.cameraPanel.hidden = true;
    els.photoCheck.checked = false;
  }
}

function stopCamera() {
  if (state.cameraStream) {
    for (const track of state.cameraStream.getTracks()) track.stop();
    state.cameraStream = null;
  }
  els.cameraVideo.srcObject = null;
  els.cameraPanel.hidden = true;
}

function takePhoto() {
  const video = els.cameraVideo;
  if (!video.videoWidth) return;
  const size = Math.min(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size, 0, 0, canvas.width, canvas.height);
  state.photo = canvas.toDataURL('image/jpeg', 0.82);
  els.photoImg.src = state.photo;
  els.photoPreview.hidden = false;
  stopCamera();
  sound.playPop();
}

// ---------------------------------------------------------------- 详情

function openDetail(item) {
  if (!item) return;
  state.mode = 'detail';
  state.detailItem = item;
  state.lastActive = Date.now();
  stopCarousel();
  wall?.setHighlight(item.id);
  els.detailName.textContent = item.name || '山水过客';
  els.detailSig.src = item.signatureUrl;
  els.detailMsg.textContent = item.message ? `“${item.message}”` : '';
  if (item.photoUrl) {
    els.detailPhoto.src = item.photoUrl;
    els.detailPhotoWrap.hidden = false;
  } else {
    els.detailPhotoWrap.hidden = true;
  }
  const d = new Date(item.createdAt);
  els.detailMeta.innerHTML = [
    `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    item.source === 'mobile' ? '手机扫码签名' : '现场手写签名',
    item.photoUrl ? '含留影' : '',
  ].filter(Boolean).join('<span>·</span>');
  els.detailPanel.hidden = false;
}

function closeDetail(silent = false) {
  els.detailPanel.hidden = true;
  state.detailItem = null;
  wall?.setHighlight(null);
  if (!silent && state.mode === 'detail') {
    state.mode = 'browse';
    state.lastActive = Date.now();
  }
}

function printDetail() {
  const item = state.detailItem;
  if (!item) return;
  const w = Math.min(900, screen.availWidth - 80);
  const h = Math.min(1200, screen.availHeight - 80);
  const win = window.open(`/print.html?id=${encodeURIComponent(item.id)}&auto=1`, 'printWindow', `width=${w},height=${h},menubar=no,toolbar=no`);
  if (!win) toast('浏览器拦截了打印窗口，请允许弹窗', 'error');
}

// ---------------------------------------------------------------- 实时同步

function connectSocket() {
  state.socket = new ReconnectingSocket(wallSocketPath('wall'), {
    role: 'wall',
    onStatus: setConnectionStatus,
    onEvent: handleSocketEvent,
  });
  state.socket.connect();
}

function setConnectionStatus(status) {
  const map = {
    connecting: ['warn', '连接中…'],
    reconnecting: ['warn', '正在重连…'],
    open: ['', '实时同步'],
    closed: ['bad', '已断开'],
  };
  const [cls, text] = map[status] || ['warn', '连接中…'];
  els.conn.className = `conn ${cls}`;
  els.connText.textContent = text;
}

function handleSocketEvent(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'hello': {
      if (msg.config) applyConfig({ ...state.config, ...msg.config });
      if (Array.isArray(msg.items)) syncItems(msg.items);
      if (msg.stats) {
        state.stats = { ...state.stats, ...msg.stats };
        updateStats();
      }
      break;
    }
    case 'signature:new':
      handleNewSignature(msg.item);
      if (msg.stats) {
        state.stats = { ...state.stats, ...msg.stats };
        updateStats();
      }
      break;
    case 'signature:remove':
      state.items = state.items.filter((i) => i.id !== msg.id);
      wall?.removeItem(msg.id);
      if (state.detailItem?.id === msg.id) closeDetail();
      if (msg.stats) {
        state.stats = { ...state.stats, ...msg.stats };
        updateStats();
      }
      break;
    case 'wall:clear':
      state.items = [];
      wall?.clear();
      if (state.detailItem) closeDetail();
      if (msg.stats) {
        state.stats = { ...state.stats, ...msg.stats };
        updateStats();
      }
      toast('大屏已清空');
      break;
    case 'config:update':
      applyConfig({ ...state.config, ...msg.config });
      toast('活动配置已更新');
      break;
    case 'stats':
      if (msg.stats) {
        state.stats = { ...state.stats, ...msg.stats };
        updateStats();
      }
      break;
    default:
      break;
  }
}

function syncItems(items) {
  const currentIds = state.items.map((i) => i.id).join(',');
  const nextIds = items.map((i) => i.id).join(',');
  state.items = items;
  if (currentIds !== nextIds) {
    stopCarousel();
    wall?.setItems(items).catch(() => {});
  }
}

// ---------------------------------------------------------------- 待机计时 / 键盘

function startIdleWatcher() {
  setInterval(() => {
    if (state.mode !== 'browse') return;
    const seconds = Number(state.config?.wall?.standbySeconds) || 45;
    if (Date.now() - state.lastActive > seconds * 1000) enterStandby();
  }, 1000);
  setInterval(() => {
    if (state.mode === 'standby') updateTicker();
  }, 6500);
}

function bindEvents() {
  els.standbyCta.addEventListener('click', (e) => {
    e.stopPropagation();
    openSign();
  });
  els.standby.addEventListener('click', () => openSign());
  els.stage.addEventListener('pointerdown', (e) => {
    sound.unlock();
    state.lastActive = Date.now();
    if (state.mode === 'standby') {
      if (e.target === els.stage) openSign();
      return;
    }
    if (state.mode === 'signing' || state.mode === 'detail') return;
    const item = wall?.hitTest(e.clientX, e.clientY);
    if (item) openDetail(item);
    else openSign();
  });
  window.addEventListener('pointermove', (e) => {
    wall?.setParallax((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  });

  els.signClose.addEventListener('click', closeSign);
  els.btnUndo.addEventListener('click', () => {
    state.pad?.undo();
    sound.playClick();
  });
  els.btnClear.addEventListener('click', () => {
    state.pad?.clear();
    els.paperGuide.classList.remove('hide');
    sound.playClick();
  });
  els.msg.addEventListener('input', () => {
    els.msgCount.textContent = `${els.msg.value.length}/${els.msg.maxLength}`;
  });
  els.photoCheck.addEventListener('change', () => {
    if (els.photoCheck.checked) openCamera();
    else if (!state.photo) stopCamera();
  });
  els.photoRetake.addEventListener('click', () => openCamera());
  els.cameraShot.addEventListener('click', takePhoto);
  els.cameraCancel.addEventListener('click', () => {
    stopCamera();
    if (!state.photo) els.photoCheck.checked = false;
  });
  els.cameraClose.addEventListener('click', () => {
    stopCamera();
    if (!state.photo) els.photoCheck.checked = false;
  });
  els.submit.addEventListener('click', submitSignature);

  els.detailClose.addEventListener('click', () => closeDetail());
  els.detailOk.addEventListener('click', () => closeDetail());
  els.detailPrint.addEventListener('click', printDetail);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.cameraPanel.hidden) {
        stopCamera();
        return;
      }
      if (!els.signPanel.hidden) return closeSign();
      if (!els.detailPanel.hidden) return closeDetail();
    }
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', onResize);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// ---------------------------------------------------------------- 渲染循环

function frame(ts) {
  const dt = Math.min(0.05, (ts - (frame.last || ts)) / 1000);
  frame.last = ts;
  try {
    bg.update(dt);
    bg.draw();
    wall.update(dt);
    wall.draw();
  } catch (err) {
    console.error('渲染异常', err);
  }
  adaptQuality(dt);
  state.frameCount++;
  requestAnimationFrame(frame);
}

function adaptQuality(dt) {
  quality.frames++;
  quality.acc += dt;
  if (quality.frames < 120) return;
  const avg = quality.acc / quality.frames;
  quality.frames = 0;
  quality.acc = 0;
  if (avg > 0.028 && quality.dpr > 1) {
    quality.dpr = Math.max(1, quality.dpr - 0.25);
    wall.resize(window.innerWidth, window.innerHeight, quality.dpr);
  } else if (avg < 0.014 && quality.dpr < Math.min(2, window.devicePixelRatio || 1)) {
    quality.dpr = Math.min(2, quality.dpr + 0.25);
    wall.resize(window.innerWidth, window.innerHeight, quality.dpr);
  }
}

// ---------------------------------------------------------------- 其他

let toastTimer = null;
function toast(text, type = '') {
  els.toast.textContent = text;
  els.toast.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
  }, 3200);
}

function showBootError(err) {
  const message = err instanceof ApiError ? err.message : err?.message || '无法连接到服务';
  els.bootError.hidden = false;
  els.bootError.textContent = `数据加载失败：${message}。页面会自动重试，或请检查服务是否启动。`;
  setTimeout(() => window.location.reload(), 15000);
}

async function setupWakeLock() {
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch {
    /* 部分浏览器不支持，忽略 */
  }
}

// 看门狗：长时间无渲染帧（浏览器卡死/休眠唤醒后）自动刷新
let lastFrameSeen = Date.now();
(function beat() {
  lastFrameSeen = Date.now();
  requestAnimationFrame(beat);
})();
setInterval(() => {
  if (Date.now() - lastFrameSeen > 20000) window.location.reload();
}, 5000);
