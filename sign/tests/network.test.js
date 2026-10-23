/**
 * 网络地址选择：确保二维码优先使用手机可达的物理网卡
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, scoreAddress } from '../server/util.js';

test('网卡评分：物理 Wi-Fi / 有线优先于虚拟网卡', () => {
  const wifi = scoreAddress('WLAN', '10.206.118.146');
  const vmware = scoreAddress('VMware Network Adapter VMnet1', '192.168.189.1');
  const hyperv = scoreAddress('vEthernet (Default Switch)', '172.20.0.1');
  const virtualbox = scoreAddress('VirtualBox Host-Only Network', '192.168.56.1');

  assert.ok(wifi > vmware, `WLAN(${wifi}) 应高于 VMware(${vmware})`);
  assert.ok(wifi > hyperv, `WLAN(${wifi}) 应高于 Hyper-V(${hyperv})`);
  assert.ok(wifi > virtualbox, `WLAN(${wifi}) 应高于 VirtualBox(${virtualbox})`);
  assert.ok(vmware < 0, '虚拟网卡应得负分');
});

test('网卡评分：私网地址优先，APIPA 降级', () => {
  assert.ok(scoreAddress('以太网', '192.168.1.20') > scoreAddress('以太网', '8.8.8.8'));
  assert.ok(scoreAddress('Wi-Fi', '172.16.0.5') > scoreAddress('Wi-Fi', '8.8.8.8'));
  assert.ok(scoreAddress('Wi-Fi', '169.254.10.2') < scoreAddress('Wi-Fi', '192.168.1.2'));
});

test('lanAddresses：返回结构完整并按得分倒序', () => {
  const list = lanAddresses();
  assert.ok(Array.isArray(list));
  for (const item of list) {
    assert.equal(typeof item.name, 'string');
    assert.match(item.address, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.equal(typeof item.score, 'number');
    assert.equal(typeof item.virtual, 'boolean');
  }
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].score >= list[i].score, '应按得分倒序');
  }
  // 若存在物理网卡，首位不应是虚拟网卡
  if (list.some((c) => !c.virtual)) {
    assert.equal(list[0].virtual, false, '首选地址不应是虚拟网卡');
  }
});
