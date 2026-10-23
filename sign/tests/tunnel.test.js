/**
 * 公网隧道启动器：从 cloudflared 日志中提取快速隧道地址
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl } from '../tools/tunnel.mjs';

const SAMPLE = `
2026-10-23T11:25:53Z INF +---------------------------------------------------------------+
2026-10-23T11:25:53Z INF |  Your quick Tunnel has been created! Visit it at:             |
2026-10-23T11:25:53Z INF |  https://blind-spectacular-paste-management.trycloudflare.com |
2026-10-23T11:25:53Z INF +---------------------------------------------------------------+
2026-10-23T11:25:56Z INF Registered tunnel connection connIndex=0 location=lax09 protocol=http2
`;

test('从 cloudflared 日志中提取公网地址', () => {
  assert.equal(
    extractTunnelUrl(SAMPLE),
    'https://blind-spectacular-paste-management.trycloudflare.com',
  );
});

test('没有地址时返回 null', () => {
  assert.equal(extractTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  assert.equal(extractTunnelUrl(''), null);
  assert.equal(extractTunnelUrl(null), null);
});

test('地址后紧跟标点也能正确截断', () => {
  assert.equal(
    extractTunnelUrl('Visit it at https://a-b-c123.trycloudflare.com. Thanks'),
    'https://a-b-c123.trycloudflare.com',
  );
});
