/**
 * WebSocket 协议与实时通道测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  WsHub,
  computeAcceptKey,
  createParser,
  encodeClientFrame,
  encodeFrame,
  OPCODES,
} from '../server/ws.js';
import { silentLogger } from './helpers.js';

test('握手 Accept Key 符合 RFC 6455 示例', () => {
  assert.equal(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('帧编码：不同长度的头部', () => {
  const short = encodeFrame({ payload: 'hi' });
  assert.equal(short[0], 0x81);
  assert.equal(short[1], 2);

  const medium = encodeFrame({ payload: Buffer.alloc(300) });
  assert.equal(medium[1], 126);
  assert.equal(medium.readUInt16BE(2), 300);

  const large = encodeFrame({ payload: Buffer.alloc(70000) });
  assert.equal(large[1], 127);
  assert.equal(Number(large.readBigUInt64BE(2)), 70000);
});

test('帧解析：往返一致（含中文与 8 位长度边界）', () => {
  for (const text of ['hello', '你好，山水', 'x'.repeat(125), 'y'.repeat(126), 'z'.repeat(70000)]) {
    const parser = createParser({ maxPayload: 200000 });
    const events = parser.push(encodeClientFrame({ payload: text }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, text);
  }
});

test('帧解析：逐字节喂入与多帧粘包', () => {
  const parser = createParser();
  const frame = encodeClientFrame({ payload: '分片测试' });
  let events = [];
  for (const byte of frame) events = events.concat(parser.push(Buffer.from([byte])));
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '分片测试');

  const two = Buffer.concat([
    encodeClientFrame({ payload: 'one' }),
    encodeClientFrame({ payload: 'two' }),
    encodeClientFrame({ opcode: OPCODES.PING, payload: Buffer.from('p') }),
  ]);
  const batch = parser.push(two);
  assert.deepEqual(batch.map((e) => e.type), ['text', 'text', 'ping']);
  assert.deepEqual(batch.map((e) => (e.type === 'ping' ? e.data.toString() : e.data)), ['one', 'two', 'p']);
});

test('帧解析：分片消息与控制帧交织', () => {
  const parser = createParser();
  const events = [];
  events.push(...parser.push(encodeClientFrame({ opcode: OPCODES.TEXT, payload: '上半', fin: false })));
  events.push(...parser.push(encodeClientFrame({ opcode: OPCODES.PING, payload: Buffer.from('beat') })));
  events.push(...parser.push(encodeClientFrame({ opcode: OPCODES.CONTINUATION, payload: '下半', fin: true })));
  assert.equal(events[0].type, 'ping');
  assert.equal(events[1].type, 'text');
  assert.equal(events[1].data, '上半下半');
});

test('帧解析：协议错误与超限', () => {
  const parser = createParser({ maxPayload: 1024 });
  assert.throws(() => parser.push(encodeClientFrame({ payload: 'x'.repeat(2000) })), /超过允许大小/);

  const unmasked = encodeFrame({ payload: 'no mask' }); // 服务端帧没有掩码，客户端发来应报错
  assert.throws(() => createParser().push(unmasked), /掩码/);

  const fragmentedControl = Buffer.from([0x09, 0x80, 0, 0, 0, 0]);
  assert.throws(() => createParser().push(fragmentedControl), /控制帧不能分片/);
});

test('WebSocket 端到端：握手、hello、广播、心跳', async (t) => {
  const server = http.createServer((req, res) => res.end('ok'));
  const hub = new WsHub({ logger: silentLogger() });
  hub.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    hub.closeAll();
    await new Promise((resolve) => server.close(resolve));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=wall`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  };
  const nextMessage = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待消息超时')), 3000);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });
  assert.equal(hub.stats.connected, 1);

  const hello = new Promise((resolve) => hub.once('hello', (client, msg) => resolve({ client, msg })));
  ws.send(JSON.stringify({ type: 'hello', role: 'wall' }));
  const { client, msg } = await hello;
  assert.equal(msg.role, 'wall');
  assert.equal(client.role, 'wall');

  // 业务广播
  const broadcastPromise = nextMessage();
  hub.broadcast({ type: 'signature:new', item: { id: 'sig_test' } });
  const got = await broadcastPromise;
  assert.equal(got.type, 'signature:new');
  assert.equal(got.item.id, 'sig_test');

  // 心跳
  ws.send(JSON.stringify({ type: 'ping', t: 123 }));
  const pong = await nextMessage();
  assert.deepEqual(pong, { type: 'pong', t: 123 });

  // 角色过滤：没有 mobile 客户端时，广播 mobile 不应报错
  assert.equal(hub.broadcast({ type: 'stats' }, { role: 'mobile' }), 0);
  assert.equal(hub.countByRole().wall, 1);

  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hub.stats.connected, 0);
});
