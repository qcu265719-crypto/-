/**
 * HTTP 接口封装（与 server/app.js 的返回结构一一对应）
 * 统一返回 { ok, data }，失败抛出 ApiError
 */

export class ApiError extends Error {
  constructor(message, { code = 'NETWORK', status = 0, detail = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const ADMIN_HEADERS = { 'X-Requested-With': 'signature-wall-admin' };

async function request(path, { method = 'GET', body = null, timeout = 20_000, admin = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (admin) Object.assign(headers, ADMIN_HEADERS);
  try {
    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!res.ok || !payload || payload.ok !== true) {
      const err = payload?.error || {};
      throw new ApiError(err.message || `请求失败（${res.status}）`, {
        code: err.code || 'HTTP_ERROR',
        status: res.status,
        detail: err.detail || null,
      });
    }
    return payload.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError('网络超时，请检查与大屏是否在同一网络', { code: 'TIMEOUT' });
    throw new ApiError('网络连接失败，请稍后重试', { code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  // 公开
  getConfig: () => request('/api/config'),
  getWall: (limit) => request(`/api/wall${limit ? `?limit=${limit}` : ''}`),
  getSignature: (id) => request(`/api/signatures/${encodeURIComponent(id)}`),
  submitSignature: (payload, { timeout = 30_000 } = {}) => request('/api/signatures', { method: 'POST', body: payload, timeout }),

  // 后台
  adminLogin: (password) => request('/api/admin/login', { method: 'POST', body: { password } }),
  adminLogout: () => request('/api/admin/logout', { method: 'POST', body: {}, admin: true }),
  adminSession: () => request('/api/admin/session'),
  adminOverview: ({ status = 'all', q = '' } = {}) =>
    request(`/api/admin/overview?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`, { admin: true }),
  adminConfig: (patch) => request('/api/admin/config', { method: 'POST', body: patch, admin: true }),
  adminPassword: (current, next) => request('/api/admin/password', { method: 'POST', body: { current, next }, admin: true }),
  adminWords: (add = [], remove = []) => request('/api/admin/words', { method: 'POST', body: { add, remove }, admin: true }),
  adminClear: (confirm = 'CLEAR', keepMedia = false) => request('/api/admin/wall/clear', { method: 'POST', body: { confirm, keepMedia }, admin: true }),
  adminSignatureAction: (id, action) =>
    request(`/api/admin/signatures/${encodeURIComponent(id)}`, { method: 'POST', body: { action }, admin: true }),
  adminSystem: () => request('/api/admin/system', { admin: true }),
  adminNetwork: () => request('/api/network', { admin: true }),
  exportUrl: (format) => `/api/admin/export?format=${format}`,
};
