/**
 * 管理后台：签名审核、敏感词、活动配置、一键清屏、数据导出、系统状态
 */
import { bootGuard } from '/js/lib/boot-guard.js';
import { api, ApiError } from '/js/lib/api.js';
import { ReconnectingSocket, wallSocketPath } from '/js/lib/wsclient.js';
import { clockText, formatBytes, timeText } from '/js/lib/util.js';

bootGuard();

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  words: [],
  stats: {},
  signatures: [],
  total: 0,
  system: null,
  filter: { status: 'all', q: '' },
  tab: 'overview',
  socket: null,
  network: null,
};

init();

async function init() {
  bindEvents();
  try {
    await api.adminSession();
    showApp();
  } catch {
    showLogin();
  }
  setInterval(() => {
    $('clock').textContent = clockText(new Date());
  }, 1000);
}

function bindEvents() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    const err = $('login-error');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const result = await api.adminLogin($('password').value);
      $('password').value = '';
      showApp();
      if (result?.mustChange) showMustChange(true);
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || '登录失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  $('logout').addEventListener('click', async () => {
    try {
      await api.adminLogout();
    } catch {}
    state.socket?.close();
    location.reload();
  });

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('btn-refresh').addEventListener('click', () => loadOverview());
  $('btn-open-wall').addEventListener('click', () => window.open('/', '_blank', 'noopener'));
  $('btn-clear-quick').addEventListener('click', clearWall);
  $('sig-refresh').addEventListener('click', () => loadSignatures());
  $('sig-status').addEventListener('change', () => {
    state.filter.status = $('sig-status').value;
    loadSignatures();
  });
  let searchTimer = null;
  $('sig-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.q = $('sig-search').value.trim();
      loadSignatures();
    }, 260);
  });

  $('word-add').addEventListener('click', addWord);
  $('word-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addWord();
    }
  });
  $('word-import').addEventListener('click', importWords);
  $('word-export').addEventListener('click', exportWords);

  $('config-form').addEventListener('submit', saveConfig);
  $('config-reset').addEventListener('click', () => loadOverview());
  $('mobile-url-select').addEventListener('change', onMobileUrlPick);
  $('mobile-url').addEventListener('input', () => syncMobileUrlSelection());
  $('btn-export-csv').addEventListener('click', () => download('csv'));
  $('btn-export-json').addEventListener('click', () => download('json'));
  $('sys-refresh').addEventListener('click', loadSystem);
  $('password-form').addEventListener('submit', changePassword);
}

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
  setTimeout(() => $('password').focus(), 50);
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  connectSocket();
  loadOverview();
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.dataset.tab === tab));
  const titles = {
    overview: ['概览', '实时掌握活动现场数据'],
    signatures: ['签名墙', '审核、隐藏或删除签名'],
    words: ['敏感词', '维护现场留言的文明边界'],
    config: ['活动配置', '活动信息、视觉主题与大屏行为'],
    export: ['数据导出', '把活动现场的数据带回去'],
    system: ['系统状态', '服务健康与账号安全'],
  };
  const [title, sub] = titles[tab] || ['概览', ''];
  $('page-title').textContent = title;
  $('page-sub').textContent = sub;
  if (tab === 'signatures') loadSignatures();
  if (tab === 'system') loadSystem();
  if (tab === 'config') loadNetwork();
}

// ---------------------------------------------------------------- 数据

async function loadOverview() {
  try {
    const data = await api.adminOverview({ status: state.filter.status, q: state.filter.q });
    applyOverview(data);
    if (state.tab === 'signatures') renderSignatures(data.signatures);
  } catch (err) {
    handleAuthError(err);
  }
}

function applyOverview(data) {
  state.config = data.config;
  state.words = data.words;
  state.stats = data.stats;
  state.system = data.system;
  state.signatures = data.signatures;
  state.total = data.signaturesTotal;
  renderStats();
  renderRecent();
  renderWords();
  fillConfig();
  renderSystem();
  showMustChange(!!state.config?.admin?.mustChange);
}

async function loadSignatures() {
  try {
    const data = await api.adminOverview({ status: $('sig-status').value, q: $('sig-search').value.trim() });
    state.config = data.config;
    state.words = data.words;
    state.stats = data.stats;
    state.system = data.system;
    renderStats();
    renderSignatures(data.signatures);
    renderWords();
    renderSystem();
    showMustChange(!!state.config?.admin?.mustChange);
  } catch (err) {
    handleAuthError(err);
  }
}

async function loadSystem() {
  try {
    const info = await api.adminSystem();
    state.system = info;
    renderSystem();
    const overview = await api.adminOverview({});
    state.stats = overview.stats;
    renderStats();
  } catch (err) {
    handleAuthError(err);
  }
}

function handleAuthError(err) {
  if (err instanceof ApiError && err.status === 401) {
    toast('登录已过期，请重新登录', 'error');
    setTimeout(() => showLogin(), 600);
    return;
  }
  toast(err.message || '操作失败', 'error');
}

// ---------------------------------------------------------------- 渲染

function renderStats() {
  const s = state.stats || {};
  $('ov-today').textContent = s.today ?? 0;
  $('ov-total').textContent = s.total ?? 0;
  $('ov-approved').textContent = s.approved ?? 0;
  $('ov-pending').textContent = s.pending ?? 0;
  $('ov-photos').textContent = s.photos ?? 0;
  $('ov-words').textContent = s.words ?? 0;
  $('nav-pending').hidden = !s.pending;
  $('nav-pending').textContent = s.pending ?? 0;
  $('sig-count').textContent = `共 ${state.total} 条`;
  $('word-count').textContent = state.words.length;
  $('media-size').textContent = s.media ? `${s.media.count} 个文件 · ${formatBytes(s.media.bytes)}` : '-';
  if (state.system?.dataDir) $('path-media').textContent = `${state.system.dataDir}\\media`;
}

function renderRecent() {
  const list = $('recent-list');
  list.textContent = '';
  const recent = state.signatures.slice(0, 6);
  if (!recent.length) {
    list.innerHTML = '<div class="empty">还没有签名，等待第一位游客…</div>';
    return;
  }
  for (const item of recent) list.appendChild(signatureRow(item, { compact: true }));
}

function renderSignatures(items = state.signatures) {
  const list = $('sig-list');
  list.textContent = '';
  if (!items.length) {
    list.innerHTML = '<div class="empty">没有符合条件的签名</div>';
    return;
  }
  for (const item of items) list.appendChild(signatureRow(item));
}

function signatureRow(item, { compact = false } = {}) {
  const row = document.createElement('div');
  row.className = 'item-row';

  const img = document.createElement('img');
  img.className = 'thumb';
  img.loading = 'lazy';
  img.alt = `${item.name} 的签名`;
  img.src = item.signatureUrl;
  row.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const nameLine = document.createElement('b');
  nameLine.textContent = item.name || '匿名';
  meta.appendChild(nameLine);
  const tag = document.createElement('span');
  tag.className = `tag ${item.status}`;
  tag.textContent = { approved: '展示中', pending: '待审核', hidden: '已隐藏' }[item.status] || item.status;
  tag.style.marginLeft = '8px';
  meta.appendChild(tag);
  if (item.photoUrl) {
    const photoTag = document.createElement('span');
    photoTag.className = 'tag';
    photoTag.textContent = '含留影';
    photoTag.style.marginLeft = '6px';
    meta.appendChild(photoTag);
  }
  const msg = document.createElement('p');
  msg.textContent = item.message || '（未留言）';
  meta.appendChild(msg);
  const small = document.createElement('small');
  small.textContent = `${timeText(item.createdAt)} · ${item.source === 'mobile' ? '手机扫码' : '现场大屏'}${item.moderation?.masked ? ' · 含敏感词已处理' : ''}`;
  meta.appendChild(small);
  row.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (compact) {
    const open = document.createElement('button');
    open.className = 'btn secondary small';
    open.type = 'button';
    open.textContent = '查看';
    open.addEventListener('click', () => window.open(`/print.html?id=${encodeURIComponent(item.id)}`, '_blank', 'noopener'));
    actions.appendChild(open);
  } else {
    if (item.status !== 'approved') actions.appendChild(actionButton('通过', 'btn small', () => setStatus(item.id, 'approve')));
    if (item.status !== 'hidden') actions.appendChild(actionButton('隐藏', 'btn secondary small', () => setStatus(item.id, 'hide')));
    actions.appendChild(actionButton('删除', 'btn danger small', () => removeSignature(item)));
  }
  row.appendChild(actions);
  return row;
}

function actionButton(text, cls, handler) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', handler);
  return b;
}

function renderWords() {
  const list = $('word-list');
  list.textContent = '';
  if (!state.words.length) {
    list.innerHTML = '<div class="empty">词库为空</div>';
    return;
  }
  for (const word of state.words) {
    const chip = document.createElement('span');
    chip.className = 'word';
    chip.textContent = word;
    const del = document.createElement('button');
    del.type = 'button';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', () => removeWord(word));
    chip.appendChild(del);
    list.appendChild(chip);
  }
}

function fillConfig() {
  const c = state.config;
  if (!c) return;
  $('ev-title').value = c.event?.title || '';
  $('ev-subtitle').value = c.event?.subtitle || '';
  $('ev-org').value = c.event?.org || '';
  $('ev-venue').value = c.event?.venue || '';
  $('ev-date').value = c.event?.date || '';
  $('theme-preset').value = c.theme?.preset || 'ink';
  $('theme-accent').value = c.theme?.accent || '#e0b45c';
  $('theme-paper').value = c.theme?.paper || '#f6f1e6';
  $('wall-mode').value = c.wall?.mode || 'globe';
  $('wall-max').value = c.wall?.maxItems ?? 72;
  $('wall-standby').value = c.wall?.standbySeconds ?? 45;
  $('wall-qr').checked = c.wall?.showQr !== false;
  $('wall-ticker').checked = c.wall?.showTicker !== false;
  $('wall-sound').checked = c.wall?.sound !== false;
  $('kiosk-camera').checked = !!c.kiosk?.camera;
  $('kiosk-print').checked = c.kiosk?.print !== false;
  $('kiosk-msg').checked = c.kiosk?.allowMessage !== false;
  $('mod-auto').checked = c.moderation?.autoApprove !== false;
  $('mod-action').value = c.moderation?.action || 'mask';
  $('mod-maxname').value = c.moderation?.maxName ?? 16;
  $('mod-maxmsg').value = c.moderation?.maxMessage ?? 80;
  $('mobile-url').value = c.mobileUrl || '';
  syncMobileUrlSelection();
  updateNetworkHint(state.network);
}

// ---------------------------------------------------------------- 网络地址

async function loadNetwork() {
  try {
    const data = await api.adminNetwork();
    state.network = data;
    const select = $('mobile-url-select');
    select.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动选择（推荐：已选手机最可能可达的网卡）';
    select.appendChild(auto);
    for (const c of data.candidates || []) {
      const opt = document.createElement('option');
      opt.value = c.mobileUrl;
      opt.textContent = `${c.mobileUrl}  ${c.virtual ? '（虚拟网卡，手机通常打不开）' : `（${c.name}）`}`;
      select.appendChild(opt);
    }
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = '自定义地址（在下方输入）';
    select.appendChild(custom);
    syncMobileUrlSelection();
    updateNetworkHint(data);
  } catch (err) {
    handleAuthError(err);
  }
}

function syncMobileUrlSelection() {
  const select = $('mobile-url-select');
  if (!select) return;
  const value = $('mobile-url').value.trim();
  if (!value) {
    select.value = '';
    return;
  }
  const matched = [...select.options].some((o) => o.value === value);
  select.value = matched ? value : '__custom__';
}

function onMobileUrlPick() {
  const select = $('mobile-url-select');
  const value = select.value;
  if (value === '__custom__') {
    $('mobile-url').focus();
    return;
  }
  $('mobile-url').value = value;
  if (state.network) {
    const effective = value || state.network.recommended || state.network.effective;
    updateNetworkHint({ ...state.network, effective });
  }
}

function updateNetworkHint(network) {
  const hint = $('mobile-url-hint');
  if (!hint) return;
  if (!network) {
    hint.textContent = '';
    return;
  }
  const effective = network.effective || '';
  const host = effective.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const matched = (network.candidates || []).find((c) => c.address === host);
  const warning = matched?.virtual
    ? '　⚠ 该地址属于虚拟网卡（VMware / Hyper-V 等），手机通常无法访问，请改选 Wi-Fi 地址。'
    : '';
  let text = `当前二维码指向：${effective}${warning}`;
  if (network.configured && network.configured !== effective) text += `（已手动配置：${network.configured}）`;
  hint.textContent = text;
  hint.style.color = warning ? '#ffc7c4' : '';
}

function renderSystem() {  const info = state.system;
  if (!info) return;
  const rows = [
    ['运行时长', formatUptime(info.uptime)],
    ['Node 版本', info.node],
    ['运行平台', info.platform],
    ['内存占用', `${info.memoryMB} MB`],
    ['WebSocket 连接', `${info.ws?.connected ?? 0} 个（大屏 ${info.ws?.roles?.wall ?? 0} / 手机 ${info.ws?.roles?.mobile ?? 0} / 后台 ${info.ws?.roles?.admin ?? 0}）`],
    ['数据目录', info.dataDir],
    ['媒体文件', info.media ? `${info.media.count} 个 · ${formatBytes(info.media.bytes)}` : '-'],
    ['局域网地址', (info.lan || []).map((n) => `${n.address}${n.virtual ? '（虚拟网卡）' : ''}`).join('  ') || '未检测到'],
    ['签名总数', `${state.stats?.total ?? 0}（存储 ${state.stats?.stored ?? 0}）`],
  ];
  const kv = $('sys-kv');
  kv.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    kv.append(dt, dd);
  }
  if (info.dataDir) $('path-media').textContent = `${info.dataDir}\\media`;
}

function formatUptime(seconds = 0) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d ? `${d} 天 ` : ''}${h} 小时 ${m} 分`;
}

// ---------------------------------------------------------------- 操作

async function setStatus(id, action) {
  try {
    await api.adminSignatureAction(id, action);
    toast(action === 'approve' ? '已通过，签名将出现在大屏' : '已隐藏', 'ok');
    await loadOverview();
  } catch (err) {
    handleAuthError(err);
  }
}

async function removeSignature(item) {
  if (!window.confirm(`确定删除「${item.name}」的签名吗？删除后不可恢复。`)) return;
  try {
    await api.adminSignatureAction(item.id, 'delete');
    toast('已删除', 'ok');
    await loadOverview();
  } catch (err) {
    handleAuthError(err);
  }
}

async function clearWall() {
  const answer = window.prompt('此操作会清空所有签名与留影文件（自动备份到 data/exports）。\n请输入 CLEAR 确认：');
  if (answer !== 'CLEAR') return;
  try {
    const result = await api.adminClear('CLEAR');
    toast(`已清屏，共移除 ${result.count} 条签名`, 'ok');
    await loadOverview();
  } catch (err) {
    handleAuthError(err);
  }
}

async function saveConfig(e) {
  e.preventDefault();
  const patch = {
    event: {
      title: $('ev-title').value.trim(),
      subtitle: $('ev-subtitle').value.trim(),
      org: $('ev-org').value.trim(),
      venue: $('ev-venue').value.trim(),
      date: $('ev-date').value || '',
    },
    theme: {
      preset: $('theme-preset').value,
      accent: $('theme-accent').value,
      paper: $('theme-paper').value,
    },
    wall: {
      mode: $('wall-mode').value,
      maxItems: Number($('wall-max').value),
      standbySeconds: Number($('wall-standby').value),
      showQr: $('wall-qr').checked,
      showTicker: $('wall-ticker').checked,
      sound: $('wall-sound').checked,
    },
    kiosk: {
      camera: $('kiosk-camera').checked,
      print: $('kiosk-print').checked,
      allowMessage: $('kiosk-msg').checked,
    },
    moderation: {
      autoApprove: $('mod-auto').checked,
      action: $('mod-action').value,
      maxName: Number($('mod-maxname').value),
      maxMessage: Number($('mod-maxmsg').value),
    },
    mobileUrl: $('mobile-url').value.trim(),
  };
  try {
    const config = await api.adminConfig(patch);
    state.config = config;
    toast('配置已保存，大屏将实时生效', 'ok');
    await loadOverview();
    await loadNetwork();
  } catch (err) {
    handleAuthError(err);
  }
}

async function addWord() {
  const input = $('word-input');
  const word = input.value.trim();
  if (!word) return;
  try {
    const result = await api.adminWords([word], []);
    state.words = result.words;
    input.value = '';
    renderWords();
    $('word-count').textContent = state.words.length;
    toast(result.added.length ? `已添加「${word}」` : '该词已在词库中', result.added.length ? 'ok' : '');
  } catch (err) {
    handleAuthError(err);
  }
}

async function importWords() {
  const raw = $('word-batch').value;
  const words = raw
    .split(/[\n,，、;；|]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 500);
  if (!words.length) {
    toast('请先粘贴要导入的词', 'error');
    return;
  }
  try {
    const result = await api.adminWords(words, []);
    state.words = result.words;
    $('word-batch').value = '';
    renderWords();
    $('word-count').textContent = state.words.length;
    toast(`已导入 ${result.added.length} 个词`, 'ok');
  } catch (err) {
    handleAuthError(err);
  }
}

async function removeWord(word) {
  try {
    const result = await api.adminWords([], [word]);
    state.words = result.words;
    renderWords();
    $('word-count').textContent = state.words.length;
  } catch (err) {
    handleAuthError(err);
  }
}

function exportWords() {
  const text = state.words.join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `敏感词库-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function download(format) {
  window.location.href = api.exportUrl(format);
  toast(format === 'csv' ? '已开始下载 CSV' : '已开始下载 JSON', 'ok');
}

async function changePassword(e) {
  e.preventDefault();
  const current = $('pwd-current').value;
  const next = $('pwd-next').value;
  const confirm = $('pwd-confirm').value;
  if (next.length < 8) return toast('新口令至少 8 位', 'error');
  if (next !== confirm) return toast('两次输入的新口令不一致', 'error');
  try {
    await api.adminPassword(current, next);
    $('pwd-current').value = '';
    $('pwd-next').value = '';
    $('pwd-confirm').value = '';
    showMustChange(false);
    toast('口令已更新，请牢记', 'ok');
  } catch (err) {
    handleAuthError(err);
  }
}

function showMustChange(visible) {
  $('must-change').hidden = !visible;
}

// ---------------------------------------------------------------- 实时

function connectSocket() {
  if (state.socket) return;
  state.socket = new ReconnectingSocket(wallSocketPath('admin'), {
    role: 'admin',
    onStatus: (status) => {
      const dot = $('ws-dot');
      const text = $('ws-text');
      if (status === 'open') {
        dot.className = 'dot';
        text.textContent = '实时同步';
      } else if (status === 'reconnecting' || status === 'connecting') {
        dot.className = 'dot warn';
        text.textContent = '正在重连';
      } else {
        dot.className = 'dot bad';
        text.textContent = '已断开';
      }
    },
    onEvent: (msg) => {
      if (msg.stats) {
        state.stats = { ...state.stats, ...msg.stats };
        renderStats();
      }
      if (msg.type === 'config:update' && msg.config) {
        state.config = { ...state.config, ...msg.config };
        if (state.tab === 'config') {
          fillConfig();
          updateNetworkHint(state.network);
        }
        toast('活动配置已更新');
      }
      if (msg.type === 'signature:new' || msg.type === 'signature:pending') {
        toast(`新签名：${msg.item?.name || ''}`, 'ok');
        scheduleRefresh();
      } else if (msg.type === 'signature:remove' || msg.type === 'wall:clear') {
        scheduleRefresh();
      }
    },
  });
  state.socket.connect();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (state.tab === 'overview') loadOverview();
    else if (state.tab === 'signatures') loadSignatures();
  }, 900);
}

// ---------------------------------------------------------------- 提示

let toastTimer = null;
function toast(text, type = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 3200);
}
