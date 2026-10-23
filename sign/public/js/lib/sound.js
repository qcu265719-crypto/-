/**
 * 声音：全部用 WebAudio 实时合成，无需音频素材文件（离线部署友好）。
 * 浏览器要求用户手势后才能播放，因此首次触摸时调用 unlock()。
 */

let ctx = null;
let enabled = true;
let master = null;

function ensureCtx() {
  if (!enabled) return null;
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  return ctx;
}

export function setSoundEnabled(value) {
  enabled = !!value;
  if (master) master.gain.value = enabled ? 0.5 : 0;
}

export function unlock() {
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

function tone({ freq = 440, type = 'sine', dur = 0.6, gain = 0.2, at = 0, slideTo = null, filter = 0 }) {
  const c = ensureCtx();
  if (!c) return;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  if (filter) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filter;
    osc.connect(f);
    f.connect(g);
  } else {
    osc.connect(g);
  }
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** 签名上墙：五声音阶上行，清亮不刺耳 */
export function playChime() {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.9, gain: 0.12, at: i * 0.09 }));
  tone({ freq: 261.63, type: 'triangle', dur: 1.4, gain: 0.06, at: 0.02, filter: 1200 });
}

/** 粒子飞入的呼啸声 */
export function playWhoosh() {
  tone({ freq: 900, slideTo: 180, type: 'sawtooth', dur: 0.7, gain: 0.03, filter: 900 });
}

export function playPop() {
  tone({ freq: 660, slideTo: 990, type: 'sine', dur: 0.18, gain: 0.08 });
}

export function playClick() {
  tone({ freq: 1200, type: 'square', dur: 0.05, gain: 0.02 });
}

export function playError() {
  tone({ freq: 220, slideTo: 140, type: 'triangle', dur: 0.35, gain: 0.12 });
}

/** 待机时的环境音：极轻的低频铺底，可按需启用 */
export function startAmbient() {
  const c = ensureCtx();
  if (!c) return () => {};
  const osc = c.createOscillator();
  const g = c.createGain();
  const lfo = c.createOscillator();
  const lfoGain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = 110;
  lfo.frequency.value = 0.08;
  lfoGain.gain.value = 12;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  g.gain.value = 0.02;
  osc.connect(g);
  g.connect(master);
  osc.start();
  lfo.start();
  return () => {
    try {
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.6);
      setTimeout(() => {
        osc.stop();
        lfo.stop();
      }, 700);
    } catch {}
  };
}
