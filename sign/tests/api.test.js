/**
 * 接口集成测试：真实启动服务，覆盖公开接口、后台鉴权、CSRF、审核、导出与 WebSocket 推送
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { makeTempDir, removeDir, silentLogger, TINY_PNG, ROOT_DIR } from './helpers.js';

const ADMIN_PASSWORD = 'test-admin-123';

async function boot(t) {
  const dataDir = makeTempDir('api');
  const app = await createApp({ rootDir: ROOT_DIR, dataDir, logger: silentLogger(), adminInitPassword: ADMIN_PASSWORD });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    removeDir(dataDir);
  });
  return { app, dataDir, port, base };
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
}

function postJson(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function login(base) {
  const res = await postJson(base, '/api/admin/login', { password: ADMIN_PASSWORD });
  assert.equal(res.status, 200);
  const cookie = (res.headers.getSetCookie?.()[0] || '').split(';')[0];
  assert.match(cookie, /^sw_session=/);
  return cookie;
}

test('静态页面与安全响应头', async (t) => {
  const { base } = await boot(t);

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') || '', /text\/html/);
  assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await home.text(), /山水留痕/);

  for (const [pathname, pattern] of [
    ['/mobile', /手机签名/],
    ['/admin', /管理后台/],
    ['/admin/qr.html', /在手机 \/ 平板上打开后台/],
    ['/404.html', /这一页不在这片山水里/],
  ]) {
    const res = await fetch(`${base}${pathname}`);
    assert.equal(res.status, 200, `${pathname} 应可访问`);
    assert.match(await res.text(), pattern);
  }

  const js = await fetch(`${base}/js/wall.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  assert.match(js.headers.get('content-encoding') || '', /gzip|^$/);

  const missing = await fetch(`${base}/no-such-page`);
  assert.equal(missing.status, 404);
});

test('目录穿越防护：读不到源码与数据目录', async (t) => {
  const { base } = await boot(t);
  for (const attempt of ['/../server/app.js', '/..%2fserver/app.js', '/%2e%2e/server/app.js', '/media/../db.json']) {
    const res = await fetch(`${base}${attempt}`);
    assert.notEqual(res.status, 200, `${attempt} 不应返回 200`);
    const body = await res.text();
    assert.ok(!body.includes('createApp'), `${attempt} 泄露了源码`);
  }
});

test('公开接口：配置、健康检查、签名提交与查询', async (t) => {
  const { base } = await boot(t);

  const health = await json(await fetch(`${base}/healthz`));
  assert.equal(health.ok, true);
  assert.equal(typeof health.uptime, 'number');

  const config = await json(await fetch(`${base}/api/config`));
  assert.equal(config.ok, true);
  assert.ok(config.data.event.title);
  assert.equal(config.data.admin, undefined, '公开配置不能带管理员字段');
  assert.match(config.data.mobileUrl, /\/mobile$/);

  // 缺少签名
  const bad = await postJson(base, '/api/signatures', { name: '没有签名' });
  assert.equal(bad.status, 400);
  const badJson = await json(bad);
  assert.equal(badJson.error.code, 'SIGNATURE_REQUIRED');

  // 正常提交
  const created = await postJson(base, '/api/signatures', {
    name: '林见山',
    message: '山水有相逢',
    signature: TINY_PNG,
    source: 'kiosk',
  });
  assert.equal(created.status, 201);
  const createdJson = await json(created);
  const item = createdJson.data;
  assert.equal(item.status, 'approved');
  assert.ok(item.signatureUrl.startsWith('/media/'));

  // 媒体文件可访问且缓存策略正确
  const media = await fetch(`${base}${item.signatureUrl}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.match(media.headers.get('cache-control') || '', /immutable/);
  assert.ok((await media.arrayBuffer()).byteLength > 0);

  // 大屏快照
  const wall = await json(await fetch(`${base}/api/wall`));
  assert.equal(wall.data.items.length, 1);
  assert.equal(wall.data.items[0].name, '林见山');
  assert.equal(wall.data.stats.approved, 1);

  // 单条查询
  const detail = await json(await fetch(`${base}/api/signatures/${item.id}`));
  assert.equal(detail.data.id, item.id);
  const notFound = await fetch(`${base}/api/signatures/sig_not_exist`);
  assert.equal(notFound.status, 404);

  // 幂等：相同 clientToken 不重复入库
  const payload = { name: '重复提交', signature: TINY_PNG, clientToken: 'token-abc' };
  const first = await json(await postJson(base, '/api/signatures', payload));
  const second = await json(await postJson(base, '/api/signatures', payload));
  assert.equal(second.duplicate, true);
  assert.equal(second.data.id, first.data.id);
  const wall2 = await json(await fetch(`${base}/api/wall`));
  assert.equal(wall2.data.items.length, 2);
});

test('敏感词：打码与拒收策略生效', async (t) => {
  const { base } = await boot(t);
  const masked = await json(await postJson(base, '/api/signatures', { name: '游客', message: '代开发票找我', signature: TINY_PNG }));
  assert.equal(masked.data.moderation.masked, true);
  assert.ok(!masked.data.message.includes('发票'));

  // 切换为拒收需要登录
  const cookie = await login(base);
  const patch = await postJson(base, '/api/admin/config', { moderation: { action: 'reject' } }, {
    Cookie: cookie,
    'X-Requested-With': 'signature-wall-admin',
  });
  assert.equal(patch.status, 200);

  const rejected = await postJson(base, '/api/signatures', { name: '游客', message: '办证 快速出证', signature: TINY_PNG });
  assert.equal(rejected.status, 422);
  const body = await json(rejected);
  assert.equal(body.error.code, 'TEXT_REJECTED');
});

test('后台鉴权：登录、CSRF、会话过期', async (t) => {
  const { base } = await boot(t);

  assert.equal((await fetch(`${base}/api/admin/overview`)).status, 401);
  assert.equal((await postJson(base, '/api/admin/login', { password: 'wrong-password' })).status, 401);

  const cookie = await login(base);
  const session = await json(await fetch(`${base}/api/admin/session`, { headers: { Cookie: cookie } }));
  assert.equal(session.data.role, 'admin');
  assert.equal(session.data.mustChange, true);

  const overview = await json(await fetch(`${base}/api/admin/overview`, { headers: { Cookie: cookie } }));
  assert.equal(overview.ok, true);
  assert.ok(Array.isArray(overview.data.words));
  assert.ok(overview.data.system.node.startsWith('v'));

  // 网络诊断：给出可用的二维码地址，且不会把虚拟网卡作为推荐
  const network = await json(await fetch(`${base}/api/network`, { headers: { Cookie: cookie } }));
  assert.ok(Array.isArray(network.data.candidates));
  assert.match(network.data.effective, /\/mobile$/);
  assert.match(network.data.effective, /^https?:\/\//);
  for (const c of network.data.candidates) {
    assert.equal(typeof c.virtual, 'boolean');
    assert.match(c.mobileUrl, /^https?:\/\/.+\/mobile$/);
  }
  if (network.data.candidates.length) {
    assert.equal(network.data.recommended, network.data.candidates[0].mobileUrl);
  }
  assert.equal((await fetch(`${base}/api/network`)).status, 401);

  // 缺少 CSRF 头
  const noCsrf = await postJson(base, '/api/admin/config', { event: { title: 'x' } }, { Cookie: cookie });
  assert.equal(noCsrf.status, 403);
  assert.equal((await json(noCsrf)).error.code, 'CSRF_CHECK_FAILED');

  // 修改配置
  const patch = await json(
    await postJson(base, '/api/admin/config', { event: { title: '云栖山 · 山水留痕' }, wall: { mode: 'star' } }, {
      Cookie: cookie,
      'X-Requested-With': 'signature-wall-admin',
    }),
  );
  assert.equal(patch.data.event.title, '云栖山 · 山水留痕');
  assert.equal(patch.data.wall.mode, 'star');

  const publicConfig = await json(await fetch(`${base}/api/config`));
  assert.equal(publicConfig.data.event.title, '云栖山 · 山水留痕');
  assert.equal(publicConfig.data.wall.mode, 'star');

  // 修改口令
  const weak = await postJson(base, '/api/admin/password', { current: ADMIN_PASSWORD, next: '123' }, {
    Cookie: cookie,
    'X-Requested-With': 'signature-wall-admin',
  });
  assert.equal(weak.status, 400);
  const changed = await postJson(base, '/api/admin/password', { current: ADMIN_PASSWORD, next: 'new-password-888' }, {
    Cookie: cookie,
    'X-Requested-With': 'signature-wall-admin',
  });
  assert.equal(changed.status, 200);
  assert.equal((await postJson(base, '/api/admin/login', { password: ADMIN_PASSWORD })).status, 401);
  assert.equal((await postJson(base, '/api/admin/login', { password: 'new-password-888' })).status, 200);
});

test('公网 / 反向代理：二维码与后台使用外部地址', async (t) => {
  const { base } = await boot(t);
  const forwarded = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'wall.example.com' };

  const cfg = await json(await fetch(`${base}/api/config`, { headers: forwarded }));
  assert.equal(cfg.data.mobileUrl, 'https://wall.example.com/mobile');
  assert.equal(cfg.data.publicBaseUrl, 'https://wall.example.com');

  const cookie = await login(base);
  const adminHeaders = { Cookie: cookie, 'X-Requested-With': 'signature-wall-admin' };

  // 只填域名根地址，也应规范化为 /mobile
  const patched = await json(
    await postJson(base, '/api/admin/config', { mobileUrl: 'https://wall.example.com' }, adminHeaders),
  );
  assert.equal(patched.data.mobileUrl, 'https://wall.example.com/mobile');

  const cfg2 = await json(await fetch(`${base}/api/config`, { headers: forwarded }));
  assert.equal(cfg2.data.mobileUrl, 'https://wall.example.com/mobile');
  assert.equal(cfg2.data.publicBaseUrl, 'https://wall.example.com');

  // HTTPS 反向代理下，会话 Cookie 必须带 Secure
  const loginRes = await postJson(base, '/api/admin/login', { password: ADMIN_PASSWORD }, forwarded);
  const setCookie = loginRes.headers.getSetCookie?.()[0] || '';
  assert.match(setCookie, /;\s*Secure/i, 'HTTPS 代理下 Cookie 应为 Secure');
});

test('签名审核：待审核、通过、隐藏、删除、一键清屏', async (t) => {
  const { base, dataDir } = await boot(t);
  const cookie = await login(base);
  const adminHeaders = { Cookie: cookie, 'X-Requested-With': 'signature-wall-admin' };

  // 关闭自动通过，提交进入待审核
  await postJson(base, '/api/admin/config', { moderation: { autoApprove: false } }, adminHeaders);
  const pending = await json(await postJson(base, '/api/signatures', { name: '待审核用户', signature: TINY_PNG }));
  assert.equal(pending.data.status, 'pending');
  let wall = await json(await fetch(`${base}/api/wall`));
  assert.equal(wall.data.items.length, 0, '待审核签名不应出现在大屏');

  const approve = await postJson(base, `/api/admin/signatures/${pending.data.id}`, { action: 'approve' }, adminHeaders);
  assert.equal(approve.status, 200);
  wall = await json(await fetch(`${base}/api/wall`));
  assert.equal(wall.data.items.length, 1);
  assert.equal(wall.data.stats.approved, 1, '通过后展示人数 +1');

  const hide = await postJson(base, `/api/admin/signatures/${pending.data.id}`, { action: 'hide' }, adminHeaders);
  assert.equal(hide.status, 200);
  wall = await json(await fetch(`${base}/api/wall`));
  assert.equal(wall.data.items.length, 0);
  assert.equal(wall.data.stats.approved, 0, '隐藏后展示人数 -1');

  const overview = await json(await fetch(`${base}/api/admin/overview?status=hidden`, { headers: { Cookie: cookie } }));
  assert.equal(overview.data.signatures.length, 1);

  // 词库增删
  const words = await json(await postJson(base, '/api/admin/words', { add: ['自定义违禁词'], remove: ['sb'] }, adminHeaders));
  assert.ok(words.data.words.includes('自定义违禁词'));
  assert.ok(!words.data.words.includes('sb'));

  // 删除
  const del = await postJson(base, `/api/admin/signatures/${pending.data.id}`, { action: 'delete' }, adminHeaders);
  assert.equal(del.status, 200);

  // 清屏需要确认
  await postJson(base, '/api/signatures', { name: '清屏测试', signature: TINY_PNG });
  const noConfirm = await postJson(base, '/api/admin/wall/clear', {}, adminHeaders);
  assert.equal(noConfirm.status, 400);
  const cleared = await postJson(base, '/api/admin/wall/clear', { confirm: 'CLEAR' }, adminHeaders);
  assert.equal(cleared.status, 200);
  assert.equal((await json(cleared)).data.count, 1);
  assert.ok(fs.existsSync(path.join(dataDir, 'exports')), '清屏应留下备份目录');
  const afterClear = await json(await fetch(`${base}/api/wall`));
  assert.equal(afterClear.data.stats.approved, 0, '清屏后展示人数归零');
  assert.equal(afterClear.data.stats.total, 2, '累计提交数不因清屏减少');
});

test('数据导出：CSV 带 BOM、JSON 不含口令', async (t) => {
  const { base } = await boot(t);
  const cookie = await login(base);
  await postJson(base, '/api/signatures', { name: '苏晚晴', message: '把此刻留在这里', signature: TINY_PNG, source: 'mobile' });

  const csvRes = await fetch(`${base}/api/admin/export?format=csv`, { headers: { Cookie: cookie } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
  assert.match(csvRes.headers.get('content-disposition') || '', /attachment; filename="signatures-/);
  const csvBytes = Buffer.from(await csvRes.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 应带 UTF-8 BOM');
  const csv = csvBytes.toString('utf8');
  assert.ok(csv.includes('苏晚晴'));

  const jsonRes = await fetch(`${base}/api/admin/export?format=json`, { headers: { Cookie: cookie } });
  const text = await jsonRes.text();
  const data = JSON.parse(text);
  assert.equal(data.signatures.length, 1);
  assert.ok(!text.includes('passwordHash'), '导出不应包含口令哈希');
  assert.ok(!text.includes('passwordSalt'));

  assert.equal((await fetch(`${base}/api/admin/export?format=csv`)).status, 401);
});

test('WebSocket：提交签名后大屏实时收到推送', async (t) => {
  const { base, app } = await boot(t);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?role=wall`);
  const messages = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else messages.push(msg);
  };
  const nextMessage = (predicate, timeout = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 WebSocket 消息超时')), timeout);
      const tryResolve = (msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
          return true;
        }
        return false;
      };
      for (const msg of messages) if (tryResolve(msg)) return;
      waiters.push((msg) => {
        if (!tryResolve(msg)) nextMessage(predicate, timeout).then(resolve, reject);
      });
    });

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WS 连接失败'));
  });

  const hello = await nextMessage((m) => m.type === 'hello');
  assert.ok(hello.config, 'hello 应携带配置');
  assert.ok(Array.isArray(hello.items));

  ws.send(JSON.stringify({ type: 'hello', role: 'wall' }));
  const created = await json(await postJson(base, '/api/signatures', { name: '陆听澜', message: '山海皆可平', signature: TINY_PNG }));
  const event = await nextMessage((m) => m.type === 'signature:new');
  assert.equal(event.item.id, created.data.id);
  assert.equal(event.item.name, '陆听澜');

  // 后台隐藏后广播移除
  const cookie = await login(base);
  await postJson(base, `/api/admin/signatures/${created.data.id}`, { action: 'hide' }, {
    Cookie: cookie,
    'X-Requested-With': 'signature-wall-admin',
  });
  const removed = await nextMessage((m) => m.type === 'signature:remove');
  assert.equal(removed.id, created.data.id);
  assert.equal(removed.stats.approved, 0, '删除广播应携带最新展示人数');

  assert.ok(app.hub.stats.connected >= 1);
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
});
