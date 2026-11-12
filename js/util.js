// js/util.js — 无副作用工具层（不触 DOM / canvas）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this._r = mulberry32(this.seed);
  }
  next() { return this._r(); }
  int(n) { return Math.floor(this._r() * n) % (n || 1); }
  range(a, b) { return a + this._r() * (b - a); }
  pick(arr) { return arr[Math.floor(this._r() * arr.length)]; }
  fork() { return new RNG(Math.floor(this._r() * 4294967296)); }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// 二叉堆：存 (item, f)，按 f 升序
export class MinHeap {
  constructor() { this.item = []; this.f = []; }
  get size() { return this.item.length; }
  clear() { this.item.length = 0; this.f.length = 0; }
  push(item, f) {
    const A = this.item, B = this.f;
    A.push(item); B.push(f);
    let n = A.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (B[p] <= B[n]) break;
      const ai = A[p]; A[p] = A[n]; A[n] = ai;
      const bi = B[p]; B[p] = B[n]; B[n] = bi;
      n = p;
    }
  }
  pop() {
    const A = this.item, B = this.f;
    if (A.length === 0) return undefined;
    const top = A[0];
    const last = A.length - 1;
    A[0] = A[last]; B[0] = B[last];
    A.pop(); B.pop();
    let n = 0;
    const L = A.length;
    for (;;) {
      const l = n * 2 + 1, r = l + 1;
      let m = n;
      if (l < L && B[l] < B[m]) m = l;
      if (r < L && B[r] < B[m]) m = r;
      if (m === n) break;
      const ai = A[m]; A[m] = A[n]; A[n] = ai;
      const bi = B[m]; B[m] = B[n]; B[n] = bi;
      n = m;
    }
    return top;
  }
}

// URL 参数（只在浏览器里调用）
export function params() {
  const q = new URLSearchParams(location.search);
  return {
    state: q.get('state') || '',
    wave: parseInt(q.get('wave') || '0', 10) || 0,
    seed: parseInt(q.get('seed') || '0', 10) || 0,
    map: q.get('map') || '',
    auto: q.get('auto') === '1',
    god: q.get('god') === '1',
    debug: q.get('debug') === '1',
    speed: parseFloat(q.get('speed') || '1') || 1,
    dmg: q.get('dmg'),
    path: q.get('path'),
    aggro: q.get('aggro'),
    spec: q.get('spec'),
    aura: q.get('aura'),
    zbar: q.get('zbar'),
    mute: q.get('mute') === '1',
    raider: q.has('raider') ? q.get('raider') === '1' : null,
    mode: q.get('mode') || null,   // normal | endless
    pause: q.get('pause') === '1',
    panel: q.get('panel') || '',
  };
}
