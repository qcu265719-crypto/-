/**
 * 后台访问二维码：方便工作人员用手机 / 平板 / 其他网络打开管理后台。
 * 优先使用服务端解析出的对外地址（publicBaseUrl）：
 *   - 局域网访问时是 http://<局域网IP>:8080
 *   - 域名 / 反向代理 / 公网隧道部署时是 https://<域名>
 * 这样即使二维码页面是在 localhost 上打开的，其他设备扫到的也是可达地址。
 */
import { drawQr } from '/js/lib/qr.js';

const urlEl = document.getElementById('url');
const canvas = document.getElementById('qr');

(async () => {
  let base = location.origin;
  try {
    const res = await fetch('/api/config');
    const json = await res.json();
    const publicBase = json?.data?.publicBaseUrl;
    if (publicBase) base = String(publicBase).replace(/\/+$/, '');
  } catch {
    /* 网络异常时退回当前地址 */
  }

  const url = `${base}/admin`;
  try {
    drawQr(canvas, url, { size: 280, margin: 3, dark: '#12283f', light: '#f6f1e6', ecLevel: 'M' });
  } catch (err) {
    console.warn('二维码生成失败', err);
  }
  urlEl.textContent = url;

  document.getElementById('copy').addEventListener('click', async () => {
    const btn = document.getElementById('copy');
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '已复制';
    } catch {
      window.prompt('请手动复制下面的地址：', url);
    }
    setTimeout(() => {
      btn.textContent = '复制地址';
    }, 1800);
  });
})();
