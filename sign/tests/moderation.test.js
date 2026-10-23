/**
 * 敏感词过滤单元测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WordFilter, normalize, normalizeWithMap, DEFAULT_WORDS } from '../server/moderation.js';

test('归一化：全角、空格、符号、零宽字符', () => {
  assert.equal(normalize('Ｓ Ｂ'), 'sb');
  assert.equal(normalize('加 微 信'), '加微信');
  assert.equal(normalize('加\u200b微\u200b信'), '加微信');
  assert.equal(normalize('傻-逼'), '傻逼');
  assert.equal(normalize('  Hello, World!  '), 'helloworld');
  assert.equal(normalize('ＡＢＣ１２３'), 'abc123');
});

test('归一化保留原文下标映射', () => {
  const text = '今天 加 微 信 聊';
  const { norm, map } = normalizeWithMap(text);
  assert.equal(norm, '今天加微信聊');
  assert.equal(map.length, norm.length);
  // "加" 在原文的位置是 3
  assert.equal(text[map[2]], '加');
  assert.equal(text[map[map.length - 1]], '聊');
});

test('命中、打码与重叠处理', () => {
  const filter = new WordFilter(DEFAULT_WORDS);
  const r1 = filter.scan('加微信 领福利');
  assert.equal(r1.clean, false);
  assert.equal(r1.hits[0].word, '加微信');
  assert.ok(r1.masked.includes('＊'));

  const r2 = filter.scan('山水有相逢，愿此行山海皆可平');
  assert.equal(r2.clean, true);
  assert.equal(r2.masked, '山水有相逢，愿此行山海皆可平');

  const r3 = filter.scan('傻 逼 才不来');
  assert.equal(r3.clean, false);
  assert.ok(r3.masked.startsWith('＊'), `实际输出：${r3.masked}`);
  assert.ok(!r3.masked.includes('傻') && !r3.masked.includes('逼'));

  const r4 = filter.scan('代开 发 票');
  assert.equal(r4.clean, false);
});

test('英文词边界：不误伤正常单词', () => {
  const filter = new WordFilter(['sb', 'fuck', 'porn']);
  assert.equal(filter.scan('absb').clean, true, '"absb" 不应命中 "sb"');
  assert.equal(filter.scan('sb').clean, false);
  assert.equal(filter.scan('你好 sb 再见').clean, false);
  assert.equal(filter.scan('fuck').clean, false);
  assert.equal(filter.scan('pornography').clean, false, '长英文词中应命中 porn');
});

test('词库增删与重置', () => {
  const filter = new WordFilter(['测试词']);
  assert.equal(filter.scan('这是测试词').clean, false);
  assert.equal(filter.remove('测试词'), true);
  assert.equal(filter.scan('这是测试词').clean, true);
  assert.equal(filter.add('新词'), true);
  assert.equal(filter.scan('新词出现').clean, false);
  filter.reset(['甲', '乙']);
  assert.equal(filter.scan('甲').clean, false);
  assert.equal(filter.scan('新词').clean, true);
  assert.deepEqual(filter.list().sort(), ['乙', '甲'].sort());
});

test('超长文本与空文本', () => {
  const filter = new WordFilter(DEFAULT_WORDS);
  assert.equal(filter.scan('').clean, true);
  const long = '山水'.repeat(5000) + '加微信';
  const result = filter.scan(long);
  assert.equal(result.clean, false);
  assert.ok(result.hits.length >= 1);
});
