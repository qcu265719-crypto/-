/**
 * 启动守护：捕获脚本异常并显示可读提示，避免现场"白屏无解释"。
 * 同时把错误写入 documentElement.dataset，便于自动化冒烟测试检测。
 */
const errors = [];

export function bootGuard() {
  const record = (kind, detail) => {
    const text = typeof detail === 'string' ? detail : detail?.stack || detail?.message || String(detail);
    errors.push(`[${kind}] ${text}`);
    document.documentElement.dataset.bootErrors = errors.join(' || ').slice(0, 4000);
    const box = document.getElementById('boot-error');
    if (box) {
      box.hidden = false;
      box.textContent = `页面出现异常：${text.split('\n')[0]}`
        + '\u3000（可按 F5 刷新；若反复出现请联系技术人员）';
    }
    console.error(kind, detail);
  };

  window.addEventListener('error', (ev) => {
    // 忽略资源加载错误（图片 404 等），只报告脚本异常
    if (ev.target && ev.target !== window && ev.target.tagName) return;
    record('error', ev.error || ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    record('promise', ev.reason);
  });

  window.__BOOT_ERRORS__ = errors;
  return { record, get errors() { return errors; } };
}
