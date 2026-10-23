/**
 * 打印留念：按签名 ID 取数据，复用海报绘制，自动弹出打印对话框
 */
import { bootGuard } from '/js/lib/boot-guard.js';
import { api, ApiError } from '/js/lib/api.js';
import { drawPoster } from '/js/lib/poster.js';

bootGuard();

const params = new URLSearchParams(location.search);
const id = params.get('id');
const auto = params.get('auto') === '1';
const status = document.getElementById('status');
const canvas = document.getElementById('poster');

document.getElementById('btn-print').addEventListener('click', () => window.print());
document.getElementById('btn-close').addEventListener('click', () => window.close());

init();

async function init() {
  if (!id) {
    setStatus('缺少签名 ID，无法打印', true);
    return;
  }
  try {
    const [item, config] = await Promise.all([api.getSignature(id), api.getConfig()]);
    setStatus('正在生成海报…');
    await drawPoster(canvas, {
      item,
      config,
      mobileUrl: config.mobileUrl || `${location.origin}/mobile`,
    });
    await document.fonts?.ready?.catch?.(() => {});
    setStatus(`已就绪 · ${item.name}`);
    if (auto) {
      setTimeout(() => window.print(), 700);
    }
  } catch (err) {
    const message = err instanceof ApiError ? err.message : err?.message || '生成失败';
    setStatus(`打印失败：${message}`, true);
  }
}

function setStatus(text, error = false) {
  status.textContent = text;
  if (error) {
    status.style.color = '#ffc7c4';
    const box = document.getElementById('boot-error');
    box.hidden = false;
    box.textContent = text;
  }
}
