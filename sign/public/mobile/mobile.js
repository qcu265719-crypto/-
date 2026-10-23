/**
 * 手机端 H5：签名 → 留影 → 留言 → 海报 → 提交上墙
 * 弱网/断网时把提交暂存在本地，恢复后自动补传（同一 clientToken 幂等）。
 */
import { bootGuard } from '/js/lib/boot-guard.js';
import { api, ApiError } from '/js/lib/api.js';
import { SignPad } from '/js/lib/signpad.js';
import { drawPoster, posterToBlob } from '/js/lib/poster.js';
import { ReconnectingSocket, wallSocketPath } from '/js/lib/wsclient.js';
import * as sound from '/js/lib/sound.js';
import { makeToken } from '/js/lib/util.js';

bootGuard();

const $ = (id) => document.getElementById(id);
const els = {
  title: $('m-title'),
  org: $('m-org'),
  sub: $('m-sub'),
  count: $('m-count'),
  foot: $('m-foot'),
  badge: $('step-badge'),
  toast: $('m-toast'),
  bootError: $('boot-error'),
  goSign: $('go-sign'),
  pad: $('m-pad'),
  padGuide: $('pad-guide'),
  swatches: $('swatches'),
  widths: $('widths'),
  padUndo: $('pad-undo'),
  padClear: $('pad-clear'),
  signBack: $('sign-back'),
  signNext: $('sign-next'),
  video: $('m-video'),
  preview: $('m-preview'),
  photoEmpty: $('photo-empty'),
  photoCam: $('photo-cam'),
  photoFileBtn: $('photo-file-btn'),
  photoFile: $('photo-file'),
  photoShot: $('photo-shot'),
  photoBack: $('photo-back'),
  photoNext: $('photo-next'),
  name: $('m-name'),
  msg: $('m-msg'),
  msgCount: $('m-msgcount'),
  chips: $('chips'),
  textBack: $('text-back'),
  textNext: $('text-next'),
  poster: $('poster'),
  previewBack: $('preview-back'),
  previewSubmit: $('preview-submit'),
  doneTitle: $('done-title'),
  doneText: $('done-text'),
  posterDone: $('poster-done'),
  savePoster: $('save-poster'),
  sharePoster: $('share-poster'),
  again: $('again'),
  saveHint: $('save-hint'),
};

const INK_COLORS = ['#12283f', '#a8332e', '#2f5d50', '#3c3a6b'];
const BRUSH_WIDTHS = [3, 4.6, 6.4];
const BADGE = { intro: '签名墙', sign: '01 / 手写', photo: '02 / 留影', text: '03 / 留言', preview: '04 / 确认', done: '完成' };
const QUICK_MESSAGES = ['到此一游', '山水有相逢', '把此刻留在这里', '与山海同框', '下次还来'];

const state = {
  config: null,
  step: 'intro',
  pad: null,
  photo: null,
  signatureData: null,
  item: null,
  submitting: false,
  cameraStream: null,
  socket: null,
  posterReady: false,
  clientToken: null,
};

const PENDING_KEY = 'sw_pending_submit';

init();

async function init() {
  buildControls();
  bindEvents();
  try {
    const [config, wall] = await Promise.all([api.getConfig(), api.getWall(1)]);
    state.config = config;
    applyConfig(config);
    updateCount(wall.stats);
  } catch (err) {
    state.config = fallbackConfig();
    applyConfig(state.config);
    showBootError(err);
  }
  connectSocket();
  attemptPending();
  window.addEventListener('online', attemptPending);
  setInterval(attemptPending, 20000);
}

function fallbackConfig() {
  return {
    event: { title: '山水留痕', subtitle: '落笔成景 · 把此刻留在山水之间', org: '云栖山风景区' },
    theme: { preset: 'ink', accent: '#e0b45c' },
    wall: { mode: 'globe' },
    kiosk: { allowMessage: true },
    moderation: { maxName: 16, maxMessage: 80 },
    mobileUrl: `${location.origin}/mobile`,
  };
}

function applyConfig(config) {
  const { event, moderation, kiosk } = config;
  els.title.textContent = event?.title || '山水留痕';
  els.org.textContent = event?.org || '电子签名墙';
  els.sub.textContent = event?.subtitle || '';
  els.foot.textContent = `© ${event?.org || '主办方'} · 山水留痕电子签名墙`;
  document.title = `${event?.title || '山水留痕'} · 手机签名`;
  els.name.maxLength = moderation?.maxName || 16;
  els.msg.maxLength = moderation?.maxMessage || 80;
  els.msgCount.textContent = `0/${els.msg.maxLength}`;
  if (kiosk && kiosk.allowMessage === false) {
    els.msg.closest('.field').hidden = true;
    els.chips.hidden = true;
  }
}

function updateCount(stats) {
  if (!stats) return;
  // "已有 N 位游客上墙"应反映当前大屏上的数量，而不是累计提交量
  els.count.textContent = String(stats.approved ?? stats.today ?? 0);
}

function buildControls() {
  INK_COLORS.forEach((color, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch${i === 0 ? ' active' : ''}`;
    b.style.background = color;
    b.setAttribute('aria-label', `墨色${i + 1}`);
    b.addEventListener('click', () => {
      els.swatches.querySelectorAll('.swatch').forEach((n) => n.classList.toggle('active', n === b));
      state.pad?.setColor(color);
    });
    els.swatches.appendChild(b);
  });
  BRUSH_WIDTHS.forEach((width, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `width-dot${i === 1 ? ' active' : ''}`;
    b.innerHTML = `<i style="width:${4 + i * 5}px;height:${4 + i * 5}px"></i>`;
    b.setAttribute('aria-label', `笔粗${width}`);
    b.addEventListener('click', () => {
      els.widths.querySelectorAll('.width-dot').forEach((n) => n.classList.toggle('active', n === b));
      state.pad?.setWidth(width);
    });
    els.widths.appendChild(b);
  });
  QUICK_MESSAGES.forEach((text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = text;
    b.addEventListener('click', () => {
      const current = els.msg.value.trim();
      if (current.includes(text)) return;
      els.msg.value = current ? `${current} ${text}` : text;
      els.msg.dispatchEvent(new Event('input'));
    });
    els.chips.appendChild(b);
  });
}

function bindEvents() {
  els.goSign.addEventListener('click', () => {
    sound.unlock();
    go('sign');
  });
  els.signBack.addEventListener('click', () => go('intro'));
  els.signNext.addEventListener('click', () => {
    if (!state.pad || state.pad.strokeCount === 0) {
      toast('请先写下你的名字', 'error');
      return;
    }
    state.signatureData = state.pad.exportPng({ maxWidth: 1400, padding: 0.05 });
    go('photo');
  });
  els.padUndo.addEventListener('click', () => state.pad?.undo());
  els.padClear.addEventListener('click', () => {
    state.pad?.clear();
    els.padGuide.classList.remove('hide');
  });

  els.photoCam.addEventListener('click', openCamera);
  els.photoShot.addEventListener('click', takePhoto);
  els.photoFileBtn.addEventListener('click', () => els.photoFile.click());
  els.photoFile.addEventListener('change', onFileChosen);
  els.photoBack.addEventListener('click', () => go('sign'));
  els.photoNext.addEventListener('click', () => go('text'));

  els.msg.addEventListener('input', () => {
    els.msgCount.textContent = `${els.msg.value.length}/${els.msg.maxLength}`;
  });
  els.textBack.addEventListener('click', () => go('photo'));
  els.textNext.addEventListener('click', async () => {
    els.textNext.disabled = true;
    try {
      await goPreview();
    } finally {
      els.textNext.disabled = false;
    }
  });

  els.previewBack.addEventListener('click', () => go('text'));
  els.previewSubmit.addEventListener('click', submit);
  els.savePoster.addEventListener('click', savePoster);
  els.sharePoster.addEventListener('click', sharePoster);
  els.again.addEventListener('click', reset);

  window.addEventListener('beforeunload', stopCamera);
}

function go(step) {
  state.step = step;
  document.querySelectorAll('.step').forEach((sec) => sec.classList.toggle('active', sec.dataset.step === step));
  els.badge.textContent = BADGE[step] || '';
  window.scrollTo(0, 0);
  if (step === 'sign' && !state.pad) {
    requestAnimationFrame(() => {
      state.pad = new SignPad(els.pad, {
        colors: INK_COLORS,
        onChange: (pad) => els.padGuide.classList.toggle('hide', !pad.isEmpty()),
      });
    });
  }
  if (step !== 'photo') stopCamera();
}

async function goPreview() {
  if (!state.signatureData) {
    toast('签名丢失了，请重新书写', 'error');
    go('sign');
    return;
  }
  go('preview');
  try {
    await drawPoster(els.poster, {
      item: {
        signatureUrl: state.signatureData,
        photoUrl: state.photo,
        name: els.name.value.trim() || '山水过客',
        message: els.msg.value.trim(),
        createdAt: new Date().toISOString(),
      },
      config: state.config,
      mobileUrl: mobileUrl(),
    });
    state.posterReady = true;
  } catch (err) {
    toast('海报生成失败，可直接提交上墙');
  }
}

function mobileUrl() {
  return state.config?.mobileUrl || `${location.origin}/mobile`;
}

// ---------------------------------------------------------------- 拍照

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('当前浏览器不支持拍照，可从相册选择', 'error');
    els.photoFile.click();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    state.cameraStream = stream;
    els.video.srcObject = stream;
    els.video.hidden = false;
    els.preview.hidden = true;
    els.photoEmpty.hidden = true;
    els.photoShot.hidden = false;
    await els.video.play().catch(() => {});
  } catch (err) {
    toast('无法打开相机，可改用相册选择', 'error');
  }
}

function stopCamera() {
  if (state.cameraStream) {
    for (const track of state.cameraStream.getTracks()) track.stop();
    state.cameraStream = null;
  }
  els.video.srcObject = null;
  els.video.hidden = true;
  els.photoShot.hidden = true;
}

function takePhoto() {
  const video = els.video;
  if (!video.videoWidth) return;
  const size = Math.min(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL('image/jpeg', 0.85);
  applyPhoto(data);
  stopCamera();
  sound.playPop();
}

async function onFileChosen() {
  const file = els.photoFile.files?.[0];
  els.photoFile.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件', 'error');
    return;
  }
  try {
    const data = await cropImageFile(file, 900);
    applyPhoto(data);
    sound.playPop();
  } catch {
    toast('图片处理失败，请换一张试试', 'error');
  }
}

function applyPhoto(data) {
  state.photo = data;
  els.preview.src = data;
  els.preview.hidden = false;
  els.photoEmpty.hidden = true;
  els.video.hidden = true;
}

function cropImageFile(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- 提交

async function submit() {
  if (state.submitting) return;
  state.submitting = true;
  els.previewSubmit.disabled = true;
  els.previewSubmit.textContent = '正在上墙…';
  const payload = {
    name: els.name.value.trim(),
    message: els.msg.value.trim(),
    signature: state.signatureData,
    photo: state.photo,
    source: 'mobile',
    clientToken: state.clientToken || (state.clientToken = makeToken('mob')),
  };
  try {
    const item = await api.submitSignature(payload);
    localStorage.removeItem(PENDING_KEY);
    state.item = item;
    sound.playChime();
    await showDone(item);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'TEXT_REJECTED') {
      toast(err.message, 'error');
      go('text');
    } else if (err instanceof ApiError && (err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.status === 0 || err.status >= 500)) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(payload));
      toast('网络不太稳定，已暂存，恢复后会自动补传');
      await showDone(null, { queued: true });
    } else {
      toast(err.message || '提交失败，请稍后再试', 'error');
    }
  } finally {
    state.submitting = false;
    els.previewSubmit.disabled = false;
    els.previewSubmit.textContent = '提交上墙';
  }
}

async function showDone(item, { queued = false } = {}) {
  go('done');
  if (queued) {
    els.doneTitle.textContent = '已暂存';
    els.doneText.textContent = '网络恢复后会自动补传到签名墙';
  } else if (item?.status === 'pending') {
    els.doneTitle.textContent = '已提交';
    els.doneText.textContent = '工作人员审核后会出现在大屏上';
  } else {
    els.doneTitle.textContent = '已上墙';
    els.doneText.textContent = '你的签名已经出现在大屏上，快去看看';
  }
  try {
    await drawPoster(els.posterDone, {
      item: item
        ? { ...item, signatureUrl: state.signatureData, photoUrl: state.photo }
        : {
            signatureUrl: state.signatureData,
            photoUrl: state.photo,
            name: els.name.value.trim() || '山水过客',
            message: els.msg.value.trim(),
            createdAt: new Date().toISOString(),
          },
      config: state.config,
      mobileUrl: mobileUrl(),
    });
  } catch {
    /* 海报失败不影响上墙结果 */
  }
  detectSaveSupport();
}

function detectSaveSupport() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  els.saveHint.textContent = isIOS ? 'iPhone 可长按海报保存到相册' : '海报已生成，点击按钮保存到相册';
  if (!navigator.canShare) els.sharePoster.hidden = true;
}

function reset() {
  state.item = null;
  state.signatureData = null;
  state.photo = null;
  state.clientToken = null;
  location.href = '/mobile';
}

// ---------------------------------------------------------------- 海报保存 / 分享

async function currentPosterBlob() {
  const canvas = state.step === 'done' ? els.posterDone : els.poster;
  return posterToBlob(canvas, 'image/png');
}

async function savePoster() {
  try {
    const blob = await currentPosterBlob();
    if (!blob) throw new Error('no blob');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `山水留痕-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('已开始保存，如未出现请长按海报保存');
  } catch {
    toast('保存失败，请长按海报手动保存', 'error');
  }
}

async function sharePoster() {
  try {
    const blob = await currentPosterBlob();
    const file = blob ? new File([blob], '山水留痕-海报.png', { type: 'image/png' }) : null;
    if (file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: state.config?.event?.title || '山水留痕',
        text: '我在现场留下了签名，一起来写一笔吧',
      });
      return;
    }
    if (navigator.share) {
      await navigator.share({
        title: state.config?.event?.title || '山水留痕',
        text: '我在现场留下了签名，一起来写一笔吧',
        url: mobileUrl(),
      });
      return;
    }
    await navigator.clipboard?.writeText(mobileUrl());
    toast('链接已复制，可以粘贴分享给朋友');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('分享未完成，可保存海报后手动分享', 'error');
  }
}

// ---------------------------------------------------------------- 弱网补传

async function attemptPending() {
  const raw = localStorage.getItem(PENDING_KEY);
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    localStorage.removeItem(PENDING_KEY);
    return;
  }
  try {
    const item = await api.submitSignature(payload);
    localStorage.removeItem(PENDING_KEY);
    toast('上次的签名已补传上墙');
    if (state.step === 'done') {
      state.item = item;
      await showDone(item);
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === 'TEXT_REJECTED') {
      localStorage.removeItem(PENDING_KEY);
      toast('暂存的留言未通过审核，已移除', 'error');
    }
  }
}

// ---------------------------------------------------------------- 实时状态

function connectSocket() {
  state.socket = new ReconnectingSocket(wallSocketPath('mobile'), {
    role: 'mobile',
    onEvent: (msg) => {
      // 新增 / 删除 / 清屏 / 定时统计都会带 stats，人数始终保持最新
      if (msg && msg.stats) updateCount(msg.stats);
    },
    onStatus: () => {},
  });
  state.socket.connect();
}

// ---------------------------------------------------------------- 提示

let toastTimer = null;
function toast(text, type = '') {
  els.toast.textContent = text;
  els.toast.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
  }, 3400);
}

function showBootError(err) {
  const message = err instanceof ApiError ? err.message : err?.message || '网络异常';
  els.bootError.hidden = false;
  els.bootError.textContent = `暂时无法连接签名墙：${message}。请检查网络后刷新页面。`;
}
