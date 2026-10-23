/**
 * 测试辅助：临时数据目录、测试用图片、静默日志
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 1x1 透明 PNG，用于测试图片落盘与尺寸解析 */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const TINY_PHOTO = TINY_PNG;

export function makeTempDir(prefix = 'test') {
  const dir = path.join(ROOT, 'data', `.${prefix}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 下偶发占用，忽略即可 */
  }
}

export function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, file: null, close: noop };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export const ROOT_DIR = ROOT;
