/**
 * 二维码编码器自检：
 * 1. 结构：尺寸、定位图形、定时图形、暗模块
 * 2. 格式信息：BCH 校验 + 掩码编号回读
 * 3. 数据：反掩码 → 之字形提取 → 反交织 → RS 校验子全零 → 还原原始字节
 * 其中解码逻辑独立实现，避免"用编码器验证编码器"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, buildCodewords, rsRemainder } from '../public/js/lib/qr.js';

const RS = {
  L: {
    1: [7, [[1, 19]]], 2: [10, [[1, 34]]], 3: [15, [[1, 55]]], 4: [20, [[1, 80]]], 5: [26, [[1, 108]]],
    6: [18, [[2, 68]]], 7: [20, [[2, 78]]], 8: [24, [[2, 97]]], 9: [30, [[2, 116]]], 10: [18, [[2, 68], [2, 69]]],
  },
  M: {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
    6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
  },
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function buildFunctionMap(size, version) {
  const fn = new Uint8Array(size * size);
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) fn[y * size + x] = 1;
  };
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  for (let i = 0; i < size; i++) {
    mark(i, 6);
    mark(6, i);
  }
  for (let i = 0; i <= 8; i++) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  const pos = ALIGN[version];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const px = pos[i];
      const py = pos[j];
      const corner = (px < 9 && py < 9) || (px > size - 10 && py < 9) || (px < 9 && py > size - 10);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(px + dx, py + dy);
    }
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return fn;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function extractBits(qr) {
  const { size, modules } = qr;
  const fn = buildFunctionMap(size, qr.version);
  const mask = MASKS[qr.mask];
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y * size + x]) continue;
        let dark = modules[y * size + x] === 1;
        if (mask(x, y)) dark = !dark;
        bits.push(dark ? 1 : 0);
      }
    }
    upward = !upward;
  }
  return bits;
}

function parseFormat(qr) {
  const { size, modules } = qr;
  const get = (x, y) => (modules[y * size + x] === 1 ? 1 : 0);
  let bits = 0;
  // 第一份：bit0 在 (8,0)
  for (let i = 0; i <= 5; i++) bits |= get(8, i) << i;
  bits |= get(8, 7) << 6;
  bits |= get(8, 8) << 7;
  bits |= get(7, 8) << 8;
  for (let i = 9; i < 15; i++) bits |= get(14 - i, 8) << i;
  const raw = bits ^ 0x5412;
  const ecBits = raw >>> 13;
  const mask = (raw >>> 10) & 0b111;
  return { bits, ecBits, mask };
}

function formatOk(bits) {
  const raw = bits ^ 0x5412;
  let v = raw;
  // 校验 BCH(15,5)：对 15 位值模生成多项式应余 0
  for (let i = 14; i >= 10; i--) {
    if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
  }
  return (v & 0x3ff) === 0;
}

/** 逐块长度展开：块长度由分组表决定，按顺序对应 */
function blockLengths(groups) {
  const lens = [];
  for (const [count, len] of groups) for (let i = 0; i < count; i++) lens.push(len);
  return lens;
}

function decodeQr(qr) {
  const { size, modules } = qr;
  const bits = extractBits(qr);
  const totalCodewords = Math.floor(bits.length / 8);
  const codewords = new Uint8Array(totalCodewords);
  for (let i = 0; i < totalCodewords; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    codewords[i] = v;
  }

  const [ecLen, groups] = RS[qr.ecLevel][qr.version];
  const lens = blockLengths(groups);
  const dataLens = lens;
  const blocks = lens.map(() => ({ data: [], ec: [] }));
  let pos = 0;
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < dataLens[b]) blocks[b].data.push(codewords[pos++]);
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < blocks.length; b++) blocks[b].ec.push(codewords[pos++]);
  }

  // RS 校验子：对每个块计算 S_i = 多项式在 α^i 处的取值，应全为 0
  const syndromes = [];
  for (const block of blocks) {
    const poly = [...block.data, ...block.ec];
    for (let i = 0; i < ecLen; i++) {
      let acc = 0;
      let power = 1;
      for (let j = poly.length - 1; j >= 0; j--) {
        acc ^= mul(poly[j], power);
        power = mul(power, EXP[i]);
      }
      syndromes.push(acc);
    }
  }

  const data = blocks.flatMap((b) => b.data);
  const out = [];
  // 解析字节模式
  let bitPos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = data[(bitPos / 8) | 0];
      v = (v << 1) | ((byte >>> (7 - (bitPos % 8))) & 1);
      bitPos++;
    }
    return v;
  };
  const mode = readBits(4);
  assert.equal(mode, 0b0100, '模式应为字节模式');
  const count = readBits(qr.version <= 9 ? 8 : 16);
  for (let i = 0; i < count; i++) out.push(readBits(8));
  return { bytes: Uint8Array.from(out), syndromes, blocks: blocks.length, darkness: countDark(modules) };
}

function countDark(modules) {
  let dark = 0;
  for (const m of modules) if (m === 1) dark++;
  return dark;
}

function matrixString(qr) {
  const lines = [];
  for (let y = 0; y < qr.size; y++) {
    let line = '';
    for (let x = 0; x < qr.size; x++) line += qr.modules[y * qr.size + x] === 1 ? '██' : '  ';
    lines.push(line);
  }
  return lines.join('\n');
}

test('编码→解码 往返一致（多版本、多内容）', () => {
  const samples = [
    'http://192.168.1.20:8080/mobile',
    'http://10.0.0.5:8080/mobile',
    'HELLO',
    'https://example.com/sign?id=sig_1234567890_abcdefgh&v=1',
    '山水留痕 · 云栖山风景区'.repeat(2),
  ];
  for (const text of samples) {
    for (const ecLevel of ['L', 'M']) {
      const qr = encodeQr(text, { ecLevel });
      assert.equal(qr.size, 17 + qr.version * 4);
      const { bits, ecBits, mask } = parseFormat(qr);
      assert.ok(formatOk(bits), '格式信息 BCH 校验失败');
      assert.equal(mask, qr.mask, '格式信息中的掩码编号应与编码一致');
      assert.equal(ecBits, ecLevel === 'L' ? 1 : 0, '格式信息中的纠错等级错误');
      const decoded = decodeQr(qr);
      assert.deepEqual(
        Buffer.from(decoded.bytes).toString('utf8'),
        text,
        `内容不一致（version=${qr.version}, ec=${ecLevel}）`,
      );
      assert.deepEqual(decoded.syndromes.filter((v) => v !== 0), [], 'RS 校验子应全零');
    }
  }
});

test('结构：定位图形、定时图形、暗模块', () => {
  const qr = encodeQr('http://example.com/mobile', { ecLevel: 'M' });
  const { size, modules } = qr;
  const at = (x, y) => modules[y * size + x] === 1;
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const border = x === 0 || y === 0 || x === 6 || y === 6;
        const center = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        assert.equal(at(ox + x, oy + y), border || center, `定位图形 (${ox},${oy}) 处 (${x},${y}) 错误`);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(at(i, 6), i % 2 === 0, `水平定时图形第 ${i} 列错误`);
    assert.equal(at(6, i), i % 2 === 0, `垂直定时图形第 ${i} 行错误`);
  }
  assert.equal(at(8, size - 8), true, '固定暗模块应为深色');
});

test('容量边界：版本随内容增长，超长抛错', () => {
  const short = encodeQr('A');
  const long = encodeQr('A'.repeat(100));
  assert.ok(long.version > short.version);
  assert.throws(() => encodeQr('A'.repeat(400)), /内容过长|超出/);
});

test('RS 纠错码字可被独立的纠错校验验证', () => {
  const bytes = new TextEncoder().encode('signature-wall');
  for (const version of [1, 2, 3, 5, 8]) {
    for (const level of ['L', 'M']) {
      const { dataCodewords } = buildCodewords(bytes, version, level);
      const [ecLen, groups] = RS[level][version];
      const lens = blockLengths(groups);
      let pos = 0;
      for (const len of lens) {
        const chunk = dataCodewords.slice(pos, pos + len);
        pos += len;
        const ec = rsRemainder(chunk, ecLen);
        // 校验：data||ec 多项式在 α^i 处均为 0
        for (let i = 0; i < ecLen; i++) {
          const poly = [...chunk, ...ec];
          let acc = 0;
          let power = 1;
          for (let j = poly.length - 1; j >= 0; j--) {
            acc ^= mul(poly[j], power);
            power = mul(power, EXP[i]);
          }
          assert.equal(acc, 0, `RS 校验失败 v${version}${level} block@${pos} i=${i}`);
        }
      }
    }
  }
});

test('打印一个二维码矩阵（人工目视定位图形用）', () => {
  const qr = encodeQr('http://192.168.1.20:8080/mobile', { ecLevel: 'M' });
  const art = matrixString(qr);
  assert.ok(art.length > 0);
  if (process.env.QR_ART) console.log(`\nversion=${qr.version} mask=${qr.mask}\n${art}\n`);
});
