/**
 * 一次跑完全部测试（进程内执行，避免 node --test 在受限环境里 spawn 子进程）
 * 用法：npm test / node tests/run-all.mjs
 */
import './moderation.test.js';
import './qr.test.js';
import './network.test.js';
import './tunnel.test.js';
import './ws.test.js';
import './store.test.js';
import './api.test.js';
