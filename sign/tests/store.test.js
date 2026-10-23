/**
 * 数据层测试：媒体落盘、审核状态、清屏备份、导出、持久化
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../server/store.js';
import { makeTempDir, removeDir, silentLogger, TINY_PNG } from './helpers.js';

async function freshStore(t, prefix = 'store') {
  const dir = makeTempDir(prefix);
  const store = new Store({ dataDir: dir, logger: silentLogger() });
  await store.load();
  t.after(() => {
    store.flushSync();
    removeDir(dir);
  });
  return { store, dir };
}

test('新增签名：媒体落盘、字段与统计', async (t) => {
  const { store, dir } = await freshStore(t);
  const item = await store.addSignature({
    name: '林见山',
    message: '山水有相逢',
    signature: TINY_PNG,
    source: 'kiosk',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
  });
  assert.match(item.id, /^sig_/);
  assert.equal(item.name, '林见山');
  assert.equal(item.status, 'approved');
  assert.equal(item.moderation.masked, false);
  assert.ok(item.signatureUrl.startsWith('/media/'));
  const mediaFile = path.join(dir, 'media', path.basename(item.signatureUrl));
  assert.ok(fs.existsSync(mediaFile), '签名文件应落盘');
  assert.equal(item.signatureSize.width, 1);
  assert.equal(item.signatureSize.height, 1);
  assert.equal(item.ipHash.length, 12, 'IP 应哈希后存储');
  assert.ok(!JSON.stringify(item).includes('127.0.0.1'));

  const stats = store.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.approved, 1);
  assert.equal(stats.today, 1);
  assert.equal(store.listVisible(10).length, 1);
});

test('敏感词：打码模式与拒收模式', async (t) => {
  const { store } = await freshStore(t, 'store-words');
  const masked = await store.addSignature({ name: '游客', message: '加微信 领福利', signature: TINY_PNG });
  assert.equal(masked.moderation.masked, true);
  assert.ok(masked.message.includes('＊'));
  assert.ok(!masked.message.includes('微信'));

  store.config.moderation.action = 'reject';
  await assert.rejects(
    () => store.addSignature({ name: '游客', message: '代开发票', signature: TINY_PNG }),
    (err) => err.code === 'TEXT_REJECTED' && err.statusCode === 422,
  );
  // 注：拒收时不应留下媒体文件
  const media = fs.readdirSync(path.join(store.mediaDir));
  assert.equal(media.length, 1, '只有上一条被打码的签名留下文件');
});

test('长度限制与默认昵称', async (t) => {
  const { store } = await freshStore(t, 'store-length');
  const item = await store.addSignature({ name: '', message: 'x'.repeat(500), signature: TINY_PNG });
  assert.equal(item.name, '山水过客');
  assert.equal(item.message.length, store.config.moderation.maxMessage);
});

test('审核状态：隐藏后不出现在大屏，删除后清理媒体', async (t) => {
  const { store, dir } = await freshStore(t, 'store-status');
  const item = await store.addSignature({ name: '沈砚', signature: TINY_PNG, photo: TINY_PNG });
  assert.ok(item.photoUrl, '留影应保存');
  assert.equal(store.listVisible(10).length, 1);

  store.updateSignatureStatus(item.id, 'hidden');
  assert.equal(store.listVisible(10).length, 0);
  assert.equal(store.listSignatures({ status: 'hidden' }).total, 1);

  const files = fs.readdirSync(path.join(dir, 'media'));
  assert.equal(files.length, 2, '签名 + 留影');
  const removed = await store.deleteSignature(item.id);
  assert.ok(removed);
  assert.equal(fs.readdirSync(path.join(dir, 'media')).length, 0, '删除后媒体文件应清理');
});

test('一键清屏：备份、清空数据与媒体', async (t) => {
  const { store, dir } = await freshStore(t, 'store-clear');
  await store.addSignature({ name: 'A', signature: TINY_PNG });
  await store.addSignature({ name: 'B', signature: TINY_PNG, photo: TINY_PNG });
  await store.save();

  const result = await store.clearAll();
  assert.equal(result.count, 2);
  assert.equal(store.signatures.length, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'media')).length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'exports', result.backup)), '清屏前应自动备份');
  const backup = JSON.parse(fs.readFileSync(path.join(dir, 'exports', result.backup), 'utf8'));
  assert.equal(backup.signatures.length, 2);
  // 累计计数保留，便于活动统计
  assert.equal(store.stats().total, 2);
});

test('导出 CSV / JSON 转义', async (t) => {
  const { store } = await freshStore(t, 'store-export');
  await store.addSignature({
    name: '=SUM(A1)',
    message: '他说"你好",然后走了',
    signature: TINY_PNG,
    source: 'mobile',
  });
  const csv = store.exportCsv();
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('"ID"'));
  assert.ok(lines[1].includes(`"'=SUM(A1)"`), '应防止 Excel 公式注入');
  assert.ok(lines[1].includes('""你好""'));
  const json = store.exportJson();
  assert.equal(json.signatures.length, 1);
  assert.equal(json.signatures[0].source, 'mobile');
  assert.equal(json.config.admin, undefined, '导出不应包含口令字段');
});

test('持久化：重新加载后数据与配置仍存在', async (t) => {
  const dir = makeTempDir('store-persist');
  t.after(() => removeDir(dir));
  const store = new Store({ dataDir: dir, logger: silentLogger() });
  await store.load();
  await store.addSignature({ name: '陆听澜', message: '愿此行山海皆可平', signature: TINY_PNG });
  store.updateConfig({ event: { title: '云栖山签名墙' } });
  store.addWords(['测试敏感词']);
  await store.save();

  const reloaded = new Store({ dataDir: dir, logger: silentLogger() });
  await reloaded.load();
  assert.equal(reloaded.signatures.length, 1);
  assert.equal(reloaded.signatures[0].name, '陆听澜');
  assert.equal(reloaded.config.event.title, '云栖山签名墙');
  assert.ok(reloaded.listWords().includes('测试敏感词'));
});

test('损坏的数据文件会被备份并重建', async (t) => {
  const dir = makeTempDir('store-corrupt');
  t.after(() => removeDir(dir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.json'), '{ not json');
  const store = new Store({ dataDir: dir, logger: silentLogger() });
  await store.load();
  assert.equal(store.signatures.length, 0);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('db.corrupt-'));
  assert.equal(backups.length, 1);
});
