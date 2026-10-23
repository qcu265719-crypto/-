/**
 * 零依赖二维码编码器（QR Code Model 2）
 * 支持字节模式、纠错等级 L/M、版本 1~10（约 200 字节以内，活动地址绰绰有余）。
 * 实现遵循 ISO/IEC 18004：模式/字符计数、RS 纠错、块交织、掩码评分、格式/版本信息。
 */

const EC_LEVEL_BITS = { L: 1, M: 0 };

/** 每个版本的 RS 分块结构：ecPerBlock + [[块数, 每块数据码字数], ...] */
const RS_BLOCKS = {
  L: {
    1: [7, [[1, 19]]],
    2: [10, [[1, 34]]],
    3: [15, [[1, 55]]],
    4: [20, [[1, 80]]],
    5: [26, [[1, 108]]],
    6: [18, [[2, 68]]],
    7: [20, [[2, 78]]],
    8: [24, [[2, 97]]],
    9: [30, [[2, 116]]],
    10: [18, [[2, 68], [2, 69]]],
  },
  M: {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]],
    10: [26, [[4, 43], [1, 44]]],
  },
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const EC_LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

// GF(256) 表
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

const generatorCache = new Map();
function rsGenerator(degree) {
  if (generatorCache.has(degree)) return generatorCache.get(degree);
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  const out = Uint8Array.from(poly);
  generatorCache.set(degree, out);
  return out;
}

/** 计算 RS 纠错码字（返回余式，长度 = degree） */
export function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const buf = new Uint8Array(data.length + degree);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor);
  }
  return buf.slice(data.length);
}

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  putBytes(bytes) {
    for (const b of bytes) this.put(b, 8);
  }
  get length() {
    return this.bits.length;
  }
  toCodewords(totalData) {
    const bits = this.bits.slice();
    if (bits.length > totalData * 8) throw new Error('数据超出容量');
    // 终止符（最多 4 个 0）
    for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
    // 补齐到字节边界
    while (bits.length % 8 !== 0) bits.push(0);
    const used = bits.length / 8;
    const out = new Uint8Array(totalData);
    for (let i = 0; i < used; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
      out[i] = v;
    }
    // 填充码字 0xEC / 0x11 交替
    const pad = [0xec, 0x11];
    for (let i = used, p = 0; i < totalData; i++, p++) out[i] = pad[p % 2];
    return out;
  }
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

/** 计算数据码字总数 */
function totalDataCodewords(version, ecLevel) {
  const [, groups] = RS_BLOCKS[ecLevel][version];
  return groups.reduce((sum, [count, len]) => sum + count * len, 0);
}

/** 选择最小可容纳版本 */
function chooseVersion(byteLength, ecLevel) {
  for (let v = 1; v <= 10; v++) {
    const cap = totalDataCodewords(v, ecLevel);
    const header = 4 + (v <= 9 ? 8 : 16);
    if (byteLength * 8 + header <= cap * 8) return v;
  }
  throw new Error(`内容过长（${byteLength} 字节），超出二维码容量`);
}

/** 生成数据码字（含模式、长度、填充、分块与纠错、交织） */
export function buildCodewords(bytes, version, ecLevel) {
  const [ecPerBlock, groups] = RS_BLOCKS[ecLevel][version];
  const totalData = totalDataCodewords(version, ecLevel);
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // 字节模式
  bb.put(bytes.length, version <= 9 ? 8 : 16);
  bb.putBytes(bytes);

  const data = bb.toCodewords(totalData);

  // 分块
  const blocks = [];
  let pos = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(pos, pos + len);
      pos += len;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecPerBlock) });
    }
  }

  // 交织
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return { codewords: Uint8Array.from(out), blocks, dataCodewords: data };
}

class QrMatrix {
  constructor(size) {
    this.size = size;
    this.modules = new Int8Array(size * size).fill(-1);
    this.isFunction = new Uint8Array(size * size);
  }
  idx(x, y) {
    return y * this.size + x;
  }
  setFunction(x, y, dark) {
    this.modules[this.idx(x, y)] = dark ? 1 : 0;
    this.isFunction[this.idx(x, y)] = 1;
  }
  set(x, y, dark) {
    this.modules[this.idx(x, y)] = dark ? 1 : 0;
  }
  get(x, y) {
    return this.modules[this.idx(x, y)] === 1;
  }
  isFn(x, y) {
    return this.isFunction[this.idx(x, y)] === 1;
  }
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      m.setFunction(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      m.setFunction(cx + dx, cy + dy, dist !== 1);
    }
  }
}

function drawFunctionPatterns(m, version, ecLevel) {
  const size = m.size;

  // 定位图形
  drawFinder(m, 3, 3);
  drawFinder(m, size - 4, 3);
  drawFinder(m, 3, size - 4);

  // 定时图形
  for (let i = 0; i < size; i++) {
    if (!m.isFn(6, i)) m.setFunction(6, i, i % 2 === 0);
    if (!m.isFn(i, 6)) m.setFunction(i, 6, i % 2 === 0);
  }

  // 校正图形
  const positions = ALIGNMENT[version];
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const px = positions[i];
      const py = positions[j];
      const overlapsFinder =
        (px <= 8 && py <= 8) || (px >= size - 9 && py <= 8) || (px <= 8 && py >= size - 9);
      if (overlapsFinder) continue;
      drawAlignment(m, px, py);
    }
  }

  // 预留格式信息区（先填 0，最后写入真实格式位）
  for (let i = 0; i <= 8; i++) {
    if (!m.isFn(i, 8)) m.setFunction(i, 8, false);
    if (!m.isFn(8, i)) m.setFunction(8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    m.setFunction(size - 1 - i, 8, false);
    m.setFunction(8, size - 1 - i, false);
  }
  m.setFunction(8, size - 8, true); // 固定暗模块

  // 版本信息
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.setFunction(a, b, bit === 1);
      m.setFunction(b, a, bit === 1);
    }
  }
}

function bchRemainder(value, generator, degree) {
  let v = value << degree;
  const genDegree = 31 - Math.clz32(generator);
  for (let i = 31 - Math.clz32(v); i >= degree; i--) {
    if ((v >>> i) & 1) v ^= generator << (i - genDegree);
  }
  return v & ((1 << degree) - 1);
}

function versionInfoBits(version) {
  return (version << 12) | bchRemainder(version, 0x1f25, 12);
}

function formatInfoBits(ecLevel, mask) {
  const data = (EC_LEVEL_BITS[ecLevel] << 3) | mask;
  const bits = (data << 10) | bchRemainder(data, 0x537, 10);
  return bits ^ 0x5412;
}

function drawFormatBits(m, ecLevel, mask) {
  const bits = formatInfoBits(ecLevel, mask);
  const size = m.size;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(i));
  m.setFunction(8, 7, bit(6));
  m.setFunction(8, 8, bit(7));
  m.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFunction(8, size - 15 + i, bit(i));
  m.setFunction(8, size - 8, true);
}

function placeData(m, codewords) {
  const size = m.size;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过定时列
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (m.isFn(x, y)) continue;
        let dark = false;
        if (bitIndex < codewords.length * 8) {
          dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        m.set(x, y, dark);
      }
    }
    upward = !upward;
  }
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

function applyMask(m, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isFn(x, y)) continue;
      if (fn(x, y)) m.modules[m.idx(x, y)] ^= 1;
    }
  }
}

function penalty(m) {
  const size = m.size;
  const get = (x, y) => (m.modules[y * size + x] === 1 ? 1 : 0);
  let score = 0;

  // 规则 1：连续同色
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (get(x, y) === get(x - 1, y)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (get(x, y) === get(x, y - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = get(x, y);
      if (v === get(x + 1, y) && v === get(x, y + 1) && v === get(x + 1, y + 1)) score += 3;
    }
  }

  // 规则 3：类似定位图形的 1:1:3:1:1 序列
  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      for (const p of patterns) {
        let ok = true;
        for (let k = 0; k < 11; k++) {
          if (get(x + k, y) !== p[k]) {
            ok = false;
            break;
          }
        }
        if (ok) score += 40;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      for (const p of patterns) {
        let ok = true;
        for (let k = 0; k < 11; k++) {
          if (get(x, y + k) !== p[k]) {
            ok = false;
            break;
          }
        }
        if (ok) score += 40;
      }
    }
  }

  // 规则 4：黑白比例
  let dark = 0;
  for (let i = 0; i < m.modules.length; i++) if (m.modules[i] === 1) dark++;
  const total = size * size;
  score += Math.floor(Math.abs((dark * 20) / total - 10)) * 10;
  return score;
}

/**
 * 生成二维码矩阵
 * @param {string} text
 * @param {{ecLevel?: 'L'|'M'}} opts
 * @returns {{version:number,size:number,mask:number,ecLevel:string,modules:Uint8Array}}
 */
export function encodeQr(text, { ecLevel = 'M' } = {}) {
  if (!RS_BLOCKS[ecLevel]) ecLevel = 'M';
  const bytes = utf8Bytes(text);
  const version = chooseVersion(bytes.length, ecLevel);
  const { codewords } = buildCodewords(bytes, version, ecLevel);

  const size = 17 + version * 4;
  const base = new QrMatrix(size);
  drawFunctionPatterns(base, version, ecLevel);
  placeData(base, codewords);

  let bestMask = 0;
  let bestScore = Infinity;
  let bestModules = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = new QrMatrix(size);
    candidate.modules = base.modules.slice();
    candidate.isFunction = base.isFunction;
    applyMask(candidate, mask);
    drawFormatBits(candidate, ecLevel, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestModules = candidate.modules;
    }
  }

  return { version, size, mask: bestMask, ecLevel, modules: bestModules, penalty: bestScore };
}

/**
 * 在 Canvas 上绘制二维码
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {string} text
 * @param {{size?:number, margin?:number, dark?:string, light?:string, ecLevel?:'L'|'M', radius?:number}} opts
 */
export function drawQr(canvas, text, { size = 320, margin = 3, dark = '#12283f', light = '#ffffff', ecLevel = 'M', radius = 0 } = {}) {
  const qr = encodeQr(text, { ecLevel });
  const ctx = canvas.getContext('2d');
  const modules = qr.size;
  const total = modules + margin * 2;
  const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  const px = Math.round(size * dpr);
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  const cell = px / total;
  ctx.fillStyle = dark;
  const r = Math.min(cell * radius, cell / 2);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (qr.modules[y * modules + x] !== 1) continue;
      const px0 = (x + margin) * cell;
      const py0 = (y + margin) * cell;
      if (r > 0.2) roundRect(ctx, px0, py0, cell + 0.4, cell + 0.4, r);
      else ctx.fillRect(px0, py0, cell + 0.4, cell + 0.4);
    }
  }
  return qr;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

export const QR_EC_LEVEL_INDEX = EC_LEVEL_INDEX;
