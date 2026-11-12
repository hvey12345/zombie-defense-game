// js/sfx.js — 采样 + 合成音效（WebAudio），只被 main.js 使用。
// 关键改动（相对上一版）：
//  1) 一次性音效改用 AudioBufferSourceNode（延迟 ~5ms），不再用 HTMLAudioElement 小池子
//  2) 统一走 sfxBus → 压缩器 → 主音量，几十个声部叠加也不削波
//  3) 按世界坐标做距离衰减 + 左右声像：远处交火轻、近处响，屏幕左/右能听出来
//  4) 变调（±8%）+ 音量抖动，连发不再机械
//  5) 全局声部上限 + 按距离加权的节流，最吵的时候也不会糊成一团
//  6) BGM 用 MediaElementSource → GainNode 线性斜坡换曲（不再 setInterval 抖）

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);

// pri：语音优先级。高级可以打断正在播的低级（倒地喊话不能被刚播的“收到”吞掉）
const VOICE = {
  ready:       { file: 'v_ready',       text: '待命',     cd: 0,  pri: 1, variants: [{ rate: 1.0 }] },
  roger:       { file: 'v_roger',       text: '收到',     cd: 14,  pri: 0, variants: [{ rate: 1.0 }, { rate: 0.94, lp: 4200 }, { rate: 1.06 }] },
  come_in:     { file: 'v_come_in',     text: '呼叫支援', cd: 18, pri: 1, variants: [{ rate: 1.0 }] },
  taking_fire: { file: 'v_taking_fire', text: '正在交火', cd: 22, pri: 2, variants: [{ rate: 1.0 }] },
  scream:      { file: 'v_scream',      text: '啊——',    cd: 0,  pri: 3, variants: [{ rate: 1.0 }] },
};

const MAX_VOICES = 26;

// 每个兵种一类音色：cls 同时当节流键用（同类共享配额、异类互不影响）。
// rate 是采样变调区间；gap 是这一类自己的最小间隔（秒）。
// 火焰里的"爆燃"概率：A 路线默认 0（听到的都是音爆），想留一点质感就调到 0.02~0.05
const FLAME_CRACKLE = 0;

const SHOT_KIND = {
  // 以下 5 条改用 CC0 真实枪声（tools/make_gun_samples.py 从 96k/24bit 源抠单发 → 44.1k 单声道）
  // 步兵：AR-15 近距单发
  infantry:  { cls: 'inf',    buf: 'rifle1',  rate: [0.98, 1.06], gap: 0.06, verb: 0.12 },
  hero:      { cls: 'inf',    buf: 'hero1',   rate: [1.00, 1.06], gap: 0.06, gain: 1.0, lp: 6000, verb: 0.10 },
  raider:    { cls: 'inf',    buf: 'rrifle1', rate: [1.00, 1.10], gap: 0.07, gain: 0.95, lp: 6000, verb: 0.08 },
  // 机枪组：AK-47 近距单发，12.5 发/s 靠 gap 压出连发感
  mg:        { cls: 'mg',     buf: 'mg2',     rate: [0.92, 1.02], gap: 0.05, gain: 0.92, lp: 6800 },
  // 轻机枪：AK-47 中距单发（比机枪组更沉、更远）
  lmg:       { cls: 'mg',     buf: 'lmg2',    rate: [1.0, 1.08], gap: 0.042, gain: 0.82, lp: 6500 },
  flamer:    { cls: 'flame',                                       gap: 0.11 },
  // 霰弹：Mossberg 12GA 近距
  shotgun:   { cls: 'sg',     buf: 'sg1',     rate: [0.95, 1.05], gap: 0.08, gain: 1.12, verb: 0.16 },
  // 狙击：Springfield 1917 栓动近距（真实采样自带枪机回波，不再叠三层合成）
  sniper:    { cls: 'sniper', buf: 'sniper2', rate: [1.04, 1.10], gap: 0.12, gain: 1.15, verb: 0.10 },
  // 火箭筒：发射不发声（用户指定），只留落地爆炸的 boom；silent 让 shot() 直接返回
  // 火箭筒：发射不播采样（只留落地爆炸），但给一记很轻的气动“扑”声当存在感
  rocket:    { cls: 'rocket', buf: null, gap: 0.14, silent: true, puff: true },
  raiderrocket: { cls: 'rocket', buf: null, gap: 0.16, silent: true, puff: true },
  // 装甲车加特林：机枪组采样降调（0.72~0.80）压成“重机炮”，独立声部 vehgun
  vehicle:   { cls: 'vehgun', buf: 'mg2', rate: [0.72, 0.80], gap: 0.06, gain: 1.05, lp: 4200 },
  // 叛军装甲车：与玩家装甲车统一成机枪变体（同一支 mg1、同样的低通与音高区间）
  raidervehicle: { cls: 'vehgun', buf: 'rveh1', rate: [0.74, 0.82], gap: 0.12, gain: 1.0, lp: 3600 },
  tank:      { cls: 'cannon', buf: 'cannon2', rate: [0.82, 0.88], gap: 0.12, verb: 0.25, lp: 2200 },
  howitzer:  { cls: 'cannon', buf: 'cannon2b', rate: [0.78, 0.86], gap: 0.16, verb: 0.38, lp: 1600 },
  // 迫击炮：cannon1 降调 + 少量混响；以前缺这一条，炮塔开火会回落成步枪声
  mortar:    { cls: 'mortar', buf: 'mortar2', rate: [0.86, 0.94], gap: 0.12, verb: 0.30, lp: 1200 },
  turret:    { cls: 'turret', buf: 'turret2', rate: [0.96, 1.04], gap: 0.07, lp: 4800 },
};


export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;      // 静音开关
    this.sfxBus = null;
    this.bgmBus = null;
    this.comp = null;
    this.verb = null;
    this.verbGain = null;
    this.noise = null;
    this.bufs = Object.create(null);    // 解码后的采样
    this.pools = null;                  // 兼容旧字段（不再使用）
    this.tracks = null;
    this.trackGain = Object.create(null);
    this.cur = null;
    this.volBgm = 0.62;
    this.volSfx = 0.75;
    this.volume = 0.55;                 // 兼容旧字段
    this.enabled = true;
    this.voices = 0;
    this.last = Object.create(null);
    this.view = null;                   // { cx, cy, halfW, camX, camY, zoom, w, h }
    this._bud = Object.create(null);    // 各类音效的窗口预算 { key: { t, n } }
    this._shotWin = null;               // 枪声距离优先级窗口 { t, att }
    this._spatial = null;               // 最近一次 mix() 的结果（给 _out 判闷音）
    this._track = 'weapon';             // 当前正在发的音属于哪一轨（武器/爆炸/界面/环境）
    this.trkVol = { weapon: 1, boom: 1, ui: 1, amb: 0.52, voice: 1 };  // 五轨各自的相对音量（环境略低）
    this.bus = null;                    // 四条子总线（init 时建）
    this.insideFn = null;               // (x,y)=>bool：这个点是否在楼里（楼内闷音用）
    this._duckT = 0;                    // ducking 结束时间
    this.loops = new Map();             // 持续音（引擎/履带）：id -> { src, g, p }
    this._ambT = 0;                      // 脚步节流时间戳
    this.onVoiceText = null;            // 语音字幕回调（main.js 注入）
    this._lastVoice = -9;               // 全局语音间隔（2.5s）
    this._voiceCd = Object.create(null); // 每句独立冷却
    this._voicePri = -1;                 // 正在播的语音优先级
    this._voiceUntil = 0;                // 正在播的语音预计结束时间
    this._voiceGain = null;              // 正在播的语音增益节点（抢占时快速淡出）
    this._voiceSrc = null;
    this._loaded = false;
    this._degraded = false;
  }

  // 必须在用户手势里调用一次（浏览器自动播放策略）
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const c = (this.ctx = new AC());

    this.master = c.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    this.master.connect(c.destination);

    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;
    this.comp.connect(this.master);

    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = this.volSfx;
    this.sfxBus.connect(this.comp);

    // 四轨子总线：都汇到 sfxBus（总音量）之上，各自再乘一个相对音量
    this.bus = {};
    for (const k of ['weapon', 'boom', 'ui', 'amb', 'voice']) {
      const g = c.createGain();
      g.gain.value = this.trkVol[k];
      g.connect(this.sfxBus);
      this.bus[k] = g;
    }

    this.bgmBus = c.createGain();
    this.bgmBus.gain.value = this.volBgm;
    this.bgmBus.connect(this.master);

    // 一小段程序化混响（0.5s 衰减噪声 IR），给爆炸/号角一点空间
    try {
      const len = Math.floor(c.sampleRate * 0.5);
      const ir = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      this.verb = c.createConvolver();
      this.verb.buffer = ir;
      this.verbGain = c.createGain();
      this.verbGain.gain.value = 0.16;
      this.verb.connect(this.verbGain).connect(this.sfxBus);
    } catch (e) { this.verb = null; }

    // 1s 白噪声，后续复用
    const len = Math.floor(c.sampleRate * 1.0);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return c;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      const r = this.ctx.resume();
      if (r && r.catch) r.catch(() => {});
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master) this.master.gain.value = this.enabled ? 1 : 0;
  }

  // 楼内判定：由 main.js 注入（用 buildingAt 查这个点是否在建筑里）
  setInsideFn(fn) { this.insideFn = fn || null; }

  // 重要事件压背景：核心被打、Boss 出场、警报、开波时让 BGM 让一让
  duck(depth = 0.42, dur = 0.8) {
    if (!this.ctx || !this.bgmBus) return;
    const now = this.ctx.currentTime;
    const g = this.bgmBus.gain;
    try { g.cancelScheduledValues(now); } catch (e) {}
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.enabled ? this.volBgm * depth : 0, now + 0.06);
    g.linearRampToValueAtTime(this.enabled ? this.volBgm : 0, now + Math.max(0.2, dur));
    this._duckT = now + dur;
  }

  // ---------------- 采样加载（decodeAudioData，一次性） ----------------
  loadSamples() {
    const c = this.ctx || this.init();
    if (!c || this._loaded) return;
    this._loaded = true;
    const S = {
      shot1: 'assets/audio/sfx/shot1.ogg',
      shot2: 'assets/audio/sfx/shot2.ogg',
      shot3: 'assets/audio/sfx/shot3.ogg',
      cannon1: 'assets/audio/sfx/cannon1.ogg',
      cannon3: 'assets/audio/sfx/cannon3.ogg',
      boom1: 'assets/audio/sfx/boom1.ogg',
      boom2: 'assets/audio/sfx/boom2.ogg',
      burst1: 'assets/audio/sfx/burst1.ogg',
      mg1: 'assets/audio/sfx/mg1.ogg',
      sniper1: 'assets/audio/sfx/sniper1.ogg',
      rocket1: 'assets/audio/sfx/rocket1.ogg',
      rifle1: 'assets/audio/sfx/rifle1.wav',
      mg2: 'assets/audio/sfx/mg2.wav',
      lmg2: 'assets/audio/sfx/lmg2.wav',
      sg1: 'assets/audio/sfx/sg1.wav',
      sniper2: 'assets/audio/sfx/sniper2.wav',
  cannon2: 'assets/audio/sfx/cannon2.wav',
  cannon2b: 'assets/audio/sfx/cannon2b.wav',
  mortar2: 'assets/audio/sfx/mortar2.wav',
  hero1: 'assets/audio/sfx/hero1.wav',
  turret2: 'assets/audio/sfx/turret2.wav',
  rrifle1: 'assets/audio/sfx/rrifle1.wav',
  rveh1: 'assets/audio/sfx/rveh1.wav',
      v_ready: 'assets/audio/voice/ready.flac',
      v_roger: 'assets/audio/voice/roger.flac',
      v_come_in: 'assets/audio/voice/come_in.flac',
      v_taking_fire: 'assets/audio/voice/taking_fire.flac',
      v_scream: 'assets/audio/voice/scream.flac',
      engine: 'assets/audio/sfx/engine.ogg',
      track: 'assets/audio/sfx/track.ogg',
      step: 'assets/audio/sfx/step.ogg',
    };
    const keys = Object.keys(S);
    let pending = keys.length;
    let failed = 0;
    for (const k of keys) {
      fetch(S[k])
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('miss'))))
        .then((ab) => new Promise((res, rej) => c.decodeAudioData(ab, res, rej)))
        .then((buf) => { this.bufs[k] = buf; })
        .catch(() => { failed++; })
        .finally(() => {
          pending--;
          if (pending === 0 && failed === keys.length) this._degraded = true;
        });
    }
  }

  // 兼容旧调用（外部可能直接用 play/名字）
  play(name, gain = 1) {
    return this.playBuf(name, { gain });
  }

  // ---------------- 位置混音 ----------------
  setView(view) { this.view = view || null; }

  // 位置混音：距离衰减（1.6 次方，屏幕边缘≈0.33）+ 左右声像 + 视野内外
  mix(x, y) {
    const v = this.view;
    if (!v || typeof x !== 'number' || typeof y !== 'number') {
      this._spatial = null;
      return { pan: 0, att: 1, dist: 0, off: false, edge: false };
    }
    const dx = x - v.cx, dy = y - v.cy;
    const dist = Math.hypot(dx, dy);
    const half = v.halfW || 700;
    // 中心 1.0 → 半个视口(≈屏幕边缘) 0.33 → 1.9 个视口 0.05
    let att = Math.pow(Math.max(0, 1 - dist / (half * 2)), 1.6);
    let off = false, edge = false;
    // 屏幕空间判定：不在注视框内就压低 + 闷音
    if (typeof v.camX === 'number' && typeof v.zoom === 'number' && v.w && v.h) {
      const sx = (x - v.camX) * v.zoom;
      const sy = (y - v.camY) * v.zoom;
      const M = 80;
      off = sx < -M || sx > v.w + M || sy < (-M) || sy > v.h + M;
      if (!off) {
        const E = 120;
        edge = sx < E || sx > v.w - E || sy < E || sy > v.h - E;
      }
    }
    if (off) att *= 0.30;        // 视野外：只剩 30%
    else if (edge) att *= 0.75;  // 屏幕边缘过渡带
    att = clamp(att, 0.02, 1);
    let inside = false;
    if (this.insideFn) {
      try { inside = !!this.insideFn(x, y); } catch (e) { inside = false; }
    }
    const out = {
      pan: clamp(dx / (half * 1.15), -0.72, 0.72),
      att, dist, off, edge, inside,
    };
    this._spatial = out;
    return out;
  }

  _out(node, pan, verb) {
    const c = this.ctx;
    const sp = this._spatial;
    let src = node;
    // 楼内：墙把高频吸掉，听感上就"进楼了"
    if (sp && sp.inside) {
      try {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1500;
        lp.Q.value = 0.7;
        node.connect(lp);
        src = lp;
        verb *= 0.55;
      } catch (e) { src = node; }
    }
    // 视野外的声音过一级低通：听得出"那边在打"，但明显闷、远
    if (sp && sp.off) {
      try {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        lp.Q.value = 0.7;
        node.connect(lp);
        src = lp;
      } catch (e) { src = node; }
    }
    const p = c.createStereoPanner ? c.createStereoPanner() : null;
    const bus = (this.bus && this.bus[this._track]) || this.sfxBus;
    if (p) { p.pan.value = pan; src.connect(p).connect(bus); }
    else src.connect(bus);
    if (verb > 0 && this.verb) {
      const s = c.createGain();
      s.gain.value = verb;
      (p || src).connect(s).connect(this.verb);
    }
  }

  // ---------------- 底层发声 ----------------
  playBuf(name, { gain = 1, rate = 1, pan = 0, delay = 0, verb = 0, lp = 0, onNode = null } = {}) {
    const c = this.ctx;
    const buf = this.bufs[name];
    if (!c || !buf || !this.enabled) return false;
    if (this.voices >= MAX_VOICES) return true;
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    let flt = null;
    if (lp > 0 && typeof c.createBiquadFilter === 'function') {
      flt = c.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = lp;
      flt.Q.value = 0.7;
    }
    const dur = Math.max(0.05, (buf.duration || 0.2) / Math.max(0.25, rate || 1));
    const rel = Math.min(dur * 0.5, dur > 1 ? 0.25 : 0.06);   // 长音 250ms，短音 60ms
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);            // 起音，避免咔哒
    g.gain.setValueAtTime(gain, t + Math.max(0.01, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);       // 淡出
    if (flt) src.connect(flt).connect(g); else src.connect(g);
    this._out(g, pan, verb);
    this.voices++;
    src.onended = () => { this.voices = Math.max(0, this.voices - 1); };
    src.start(t);
    if (onNode) onNode(src, g, dur);
    return true;
  }

  // attack：起音时长（秒）。噪声类默认 4ms 很脆；火焰要 20ms 才不会“啪”一声
  burst({ type = 'bandpass', f0 = 1800, f1 = 400, q = 1, dur = 0.09, gain = 0.25, delay = 0, pan = 0, verb = 0, attack = 0.004 } = {}) {
    if (!this.ctx || !this.enabled || this.voices >= MAX_VOICES) return;
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rnd(0.85, 1.2);
    const flt = c.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.max(0.002, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g);
    this._out(g, pan, verb);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.03);
  }

  tone({ f0 = 220, f1 = 80, dur = 0.12, gain = 0.16, type = 'sine', delay = 0, pan = 0, verb = 0 } = {}) {
    if (!this.ctx || !this.enabled || this.voices >= MAX_VOICES) return;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this._out(g, pan, verb);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // 节流：越远、同类越密，越容易略过
  ok(key, gap, dist = 0) {
    if (!this.enabled || !this.ctx) return false;
    const half = (this.view && this.view.halfW) || 700;
    const g = gap * (1 + dist / (half * 1.6));
    const t = this.ctx.currentTime;
    if (this.last[key] && t - this.last[key] < g) return false;
    this.last[key] = t;
    return true;
  }

  // 窗口预算：同一 key 在 window 秒内最多响 maxN 次。
  // 用途是「一片东西同时死/同时炸」时别把 26 个声部吃光，留给真正重要的声音。
  budget(key, maxN, window) {
    if (!this.ctx || !this.enabled) return false;
    const now = this.ctx.currentTime;
    let b = this._bud[key];
    if (!b || now - b.t > window) { b = { t: now, n: 0 }; this._bud[key] = b; }
    if (b.n >= maxN) return false;
    b.n++;
    return true;
  }

  // 枪声的距离优先级：60ms 内只留最响的一声；后到的更响可以挤进来。
  // 效果是混战时听见的是最近的那几枪，而不是先到先得。
  takeShot(att) {
    const now = this.ctx.currentTime;
    const w = this._shotWin;
    if (!w || now - w.t > 0.06) { this._shotWin = { t: now, att }; return true; }
    if (att > w.att * 1.15) { w.att = att; w.t = now; return true; }
    return false;
  }

  // ---------------- 战斗音效 ----------------
  // 武器音色表：采样 + 变调区间 + 该类自己的节流间隔。
  // cls 同时是节流键，所以机枪和步枪各有一份配额，不会互相挤掉。
  shot(kind, x, y) {
    this._track = 'weapon';
    // 燃烧塔不是"一发一响"：单独走火啸，别和枪声共用一个采样
    if (kind === 'flame') { this.flame(x, y, 1.0); return; }
    if (kind === 'flamer') { this.flame(x, y, 0.78); return; }
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.14) return;
    const M = SHOT_KIND[kind] || SHOT_KIND.infantry;
    if (M.silent) {
      // 发射无采样，但要有一记气动“扑”：80→40Hz / 40ms / gain .03（用户定值）
      if (M.puff && this.ok('puff:' + M.cls, 0.10, dist)) {
        this.tone({ f0: 80, f1: 40, dur: 0.040, gain: 0.03 * att, type: 'sine', pan });
      }
      return;
    }
    if (!this.ok('shot:' + M.cls, M.gap, dist)) return;
    // 混战总预算：整体不超过 12 声 / 0.5 秒，剩下的声部留给爆炸和受伤
    if (!this.budget('shot', 12, 0.5)) return;
    // 60ms 内只留最响的一枪
    if (!this.takeShot(att)) return;

    const g = 0.6 * att;   // 采样与合成统一走 att，不再各自打折
    const rate = M.rate ? rnd(M.rate[0], M.rate[1]) : 1;
    if (M.buf && this.playBuf(M.buf, { gain: g * (M.gain || 1), rate, pan, verb: M.verb || 0, lp: M.lp || 0 })) {
      // 狙击：采样之上补一条短促的低频尾音，让"砰"有余味
      if (M.tail) this.tone({ f0: 210, f1: 62, dur: 0.14, gain: 0.10 * att, type: 'triangle', pan });
      /* ---- A 路线：按实测频谱补层（重心 Hz / 低中高占比见 docs 里的实测表）---- */
      if (M.cls === 'sniper') {
        // 采样本身 41% 能量在 120Hz 以下 ⇒ 不再叠低频托底，改补一记很短的枪口爆音给“脆”
        this.burst({ f0: 5200, f1: 2000, q: 1.1, dur: 0.025, gain: 0.090 * att, pan });
      } else if (M.cls === 'mg' || M.cls === 'vehgun') {
        // 现采样 120~500Hz 占 72%、500~2000 只有 13% ⇒ 补一层"咔"的存在感
        this.burst({ f0: 2600, f1: 1200, q: 1.4, dur: 0.028, gain: 0.062 * att, pan });
      } else if (M.cls === 'cannon' || M.cls === 'mortar') {
        // 现采样低频只有 1% ⇒ 补 55Hz 大身板
        this._sub(att * 0.85, pan, true);
        this.tone({ f0: 58, f1: 26, dur: 0.40, gain: 0.085 * att, type: 'sine', pan, delay: 0.01 });
      }
      return;
    }
    // 没有采样（或采样还没加载完）时的合成兜底
    if (M.cls === 'cannon' || M.cls === 'mortar') {
      this.tone({ f0: 150, f1: 48, dur: 0.16, gain: 0.2 * att, type: 'square', pan });
      this.burst({ f0: 900, f1: 120, dur: 0.14, gain: 0.18 * att, q: 0.7, pan });
      this._sub(att * 0.8, pan, false);
    } else if (M.cls === 'turret') {
      this.tone({ f0: 260, f1: 90, dur: 0.08, gain: 0.12 * att, type: 'triangle', pan });
      this.burst({ f0: 2200, f1: 500, dur: 0.07, gain: 0.14 * att, pan });
    } else if (M.cls === 'sniper') {
      this.burst({ f0: 3000, f1: 800, dur: 0.06, gain: 0.14 * att, q: 1.2, pan });
      this.tone({ f0: 210, f1: 62, dur: 0.14, gain: 0.10 * att, type: 'triangle', pan });
    } else if (M.cls === 'mg' || M.cls === 'vehgun') {
      this.burst({ f0: 1800, f1: 600, dur: 0.045, gain: 0.13 * att, q: 0.9, pan });
    } else {
      this.burst({ f0: 2600, f1: 700, dur: 0.05, gain: 0.12 * att, q: 0.8, pan });
    }
  }

  // 燃烧塔：一段持续的火啸（喷射气流），连发时互相叠住像连续燃烧
  flame(x, y, k = 1) {
    this._track = 'weapon';
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.10) return;
    if (!this.ok('flame', 0.12, dist)) return;
    if (!this.budget('flame', 4, 0.3)) return;     // 一屏多座塔同喷时降密度
    const g = att * k;
    // 主体：宽带气流，慢起音（attack 20ms）避免每次都有"啪"的瞬态
    this.burst({ type: 'lowpass', f0: 620, f1: 260, q: 0.5, dur: 0.36, gain: 0.140 * g, pan, verb: 0.10, attack: 0.02 });
    // 上层：湍流，但压到 1.2k 以下，不再有 6k 以上的嘶嘶
    this.burst({ type: 'lowpass', f0: 1150, f1: 620, q: 0.9, dur: 0.28, gain: 0.030 * g, pan, delay: 0.012 });
    // 低频轰鸣：给"喷"的重量（92→56 已有，再补 68Hz 一层）
    this.tone({ f0: 92, f1: 56, dur: 0.32, gain: 0.062 * g, type: 'sine', pan });
    this.tone({ f0: 68, f1: 44, dur: 0.30, gain: 0.040 * g, type: 'sine', pan, delay: 0.01 });
    // 偶发爆燃：默认关（A 路线就是要去掉音爆）；需要时把 FLAME_CRACKLE 调回 0.03~0.05
    if (Math.random() < FLAME_CRACKLE) {
      this.burst({ f0: 1500, f1: 700, q: 1.6, dur: 0.05, gain: 0.012 * g, pan, delay: 0.02 });
    }
  }

  // 僵尸死亡：按体型分档 + 每档多种音色，成片击杀不再像单曲循环
  //   walker/runner 三选一（湿裂 / 骨头碎 / 干呕），charger~brute 走重尸闷响，
  //   behemoth 单独一套长尾。都带 ±10% 变调与随机时长。
  zdie(x, y, mob) {
    this._track = 'boom';
    if (!this.ctx || !this.enabled) return;
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.16) return;
    if (!this.ok('zdie', 0.05, dist)) return;
    // 声部预算：一片倒的时候只让最响的几次出声，别把 26 个声部吃光（暴君不受限）
    if (mob !== 'behemoth' && !this.budget('zdie', 3, 0.2)) return;

    if (mob === 'behemoth') { this._zdieBoss(att, pan); return; }
    const heavy = mob === 'brute' || mob === 'charger' || mob === 'hunter';
    if (heavy) {
      // 重尸：闷响倒地；一半概率再叠一层骨头碎
      const dry = Math.random() < 0.5;
      this.tone({ f0: rnd(100, 132), f1: 34, dur: rnd(0.34, 0.5), gain: 0.13 * att, type: 'sine', pan, verb: 0.35 });
      this.burst({ type: 'lowpass', f0: dry ? rnd(430, 560) : rnd(700, 900), f1: 80, dur: rnd(0.3, 0.46), gain: (dry ? 0.14 : 0.17) * att, q: 0.7, pan, verb: 0.3 });
      this._sub(att * 0.75, pan, false);
      return;
    }

    const r = Math.random();
    if (r < 0.34) {
      // A 湿裂：优先用录好的迸溅采样，随机变调
      if (this.playBuf('burst1', { gain: 0.32 * att, rate: rnd(0.86, 1.18), pan })) return;
      this.burst({ type: 'lowpass', f0: rnd(900, 1300), f1: rnd(150, 220), dur: rnd(0.12, 0.17), gain: 0.15 * att, q: 0.75, pan });
      this.tone({ f0: rnd(190, 240), f1: rnd(60, 80), dur: rnd(0.1, 0.14), gain: 0.07 * att, type: 'triangle', pan });
    } else if (r < 0.68) {
      // B 骨头碎：三连极短脆响，音高逐拍下滑
      const d = rnd(0.04, 0.055), f = rnd(1900, 2700);
      for (let i = 0; i < 3; i++) {
        this.burst({ type: 'bandpass', f0: f * (1 - i * 0.12), f1: 900, dur: d, gain: (0.1 - i * 0.02) * att, q: 2.4, delay: i * d * 0.85, pan });
      }
    } else {
      // C 干呕：锯齿下滑 + 带通尾音
      this.tone({ f0: rnd(140, 190), f1: rnd(50, 70), dur: rnd(0.22, 0.3), gain: 0.09 * att, type: 'sawtooth', pan, verb: 0.2 });
      this.burst({ type: 'bandpass', f0: rnd(650, 850), f1: 240, dur: rnd(0.18, 0.24), gain: 0.07 * att, q: 1.5, pan });
    }
  }

  _zdieBoss(att, pan) {
    this._track = 'boom';
    const v = Math.max(att, 0.6);
    this.tone({ f0: 120, f1: 28, dur: 1.0, gain: 0.22 * v, type: 'sawtooth', pan, verb: 0.7 });
    this.burst({ type: 'lowpass', f0: 700, f1: 70, dur: 0.8, gain: 0.18 * v, q: 0.6, pan, verb: 0.6 });
    this._sub(v, pan, true);
  }

  fort(x, y) {
    this._track = 'boom';
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.16) return;
    if (!this.ok('fort', 0.1, dist)) return;
    if (!this.budget('fort', 4, 0.35)) return;
    if (this.playBuf('cannon1', { gain: 0.5 * att, rate: rnd(0.95, 1.05), pan })) return;
    this.burst({ type: 'highpass', f0: 400, f1: 1800, dur: 0.2, gain: 0.16 * att, q: 0.5, pan });
    this.tone({ f0: 120, f1: 50, dur: 0.2, gain: 0.12 * att, type: 'triangle', pan });
    this._sub(att * 0.85, pan, false);
  }

  // 次低频冲击：40~70Hz 的短促推力，现代游戏「打击感」的根基。
  // heavy=true 更低更长（爆炸 / BOSS），否则短促（炮台 / 落地 / 重尸倒地）。
  _sub(att, pan, heavy) {
    this._track = 'weapon';
    if (!this.ctx || !this.enabled) return;
    const g = Math.max(0, Math.min(1, att));
    if (g < 0.12) return;
    this.tone({
      f0: heavy ? 72 : 64,
      f1: heavy ? 22 : 26,
      dur: heavy ? 0.36 : 0.2,
      gain: (heavy ? 0.30 : 0.19) * g,
      type: 'sine',
      pan,
      verb: heavy ? 0.5 : 0.15,
    });
  }

  boom(x, y, r, tag) {
    this._track = 'boom';
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.12) return;
    if (!this.ok('boom', 0.09, dist)) return;
    if (!this.budget('boom', 5, 0.4)) return;
    // 火箭弹是小范围爆炸，却和火炮共用一个采样 ⇒ 单独压一档并收混响（刺耳主要来自 verb 0.45）
    const soft = tag === 'rocket' ? 0.72 : 1;
    const g = clamp01(att * ((r || 24) >= 40 ? 1.15 : 1)) * soft;
    const verb = tag === 'rocket' ? 0.28 : 0.45;
    if (this.playBuf(Math.random() < 0.5 ? 'boom1' : 'boom2', { gain: 0.58 * g, rate: rnd(0.92, 1.04), pan, verb })) return;
    this.burst({ type: 'lowpass', f0: 900, f1: 120, dur: 0.32, gain: 0.26 * g, q: 0.7, pan, verb: 0.55 });
    this.tone({ f0: 90, f1: 38, dur: 0.3, gain: 0.2 * g, type: 'sine', pan, verb: 0.4 });
    this._sub(g, pan, (r || 24) >= 40);
  }

  boss(x, y) {
    this._track = 'boom';
    this.duck(0.35, 1.2);
    if (!this.ok('boss', 2.0)) return;
    const { pan, att } = this.mix(x, y);
    const v = Math.max(att, 0.55);
    this.tone({ f0: 150, f1: 48, dur: 1.1, gain: 0.26 * v, type: 'sawtooth', pan, verb: 0.7 });
    this.burst({ type: 'lowpass', f0: 400, f1: 90, dur: 0.9, gain: 0.2 * v, q: 0.8, pan, verb: 0.6 });
  }

  // 叛军装甲车狂暴预警：两声急促上行的三角波（比 boss 短、比 click 重）
  alarm(x, y) {
    this._track = 'boom';
    this.duck(0.5, 0.8);
    const { pan, att } = this.mix(x, y);
    if (att < 0.2) return;
    if (!this.ok('alarm', 0.45)) return;
    const v = Math.max(att, 0.5);
    this.tone({ f0: 760, f1: 980, dur: 0.09, gain: 0.16 * v, type: 'triangle', pan });
    this.tone({ f0: 760, f1: 980, dur: 0.09, gain: 0.16 * v, type: 'triangle', pan, delay: 0.13 });
  }

  drop(x, y) {
    this._track = 'boom';
    // 空降：下落哨音 → 落地闷响
    const { pan, att } = this.mix(x, y);
    if (att < 0.15) return;
    if (!this.ok('drop', 0.3)) return;
    const v = Math.max(att, 0.4);
    this.tone({ f0: 1500, f1: 380, dur: 0.28, gain: 0.06 * v, type: 'sine', pan, verb: 0.2 });
    this.tone({ f0: 150, f1: 58, dur: 0.16, gain: 0.17 * v, type: 'sine', pan, delay: 0.28 });
    this.burst({ f0: 900, f1: 180, q: 0.8, dur: 0.14, gain: 0.11 * v, pan, delay: 0.28 });
    this._sub(v * 0.9, pan, false);
  }

  coreHit() {
    this._track = 'boom';
    this.duck(0.35, 1.0);
    if (!this.ok('core', 1.1)) return;
    this.tone({ f0: 520, f1: 300, dur: 0.16, gain: 0.15, type: 'square' });
    this.tone({ f0: 380, f1: 220, dur: 0.2, gain: 0.09, type: 'square', delay: 0.14 });
  }

  // ---------------- UI 音效（不带位置） ----------------
  // 选中单位：只在「从无到有」时由 main.js 播一次，按兵种分组给不同音色
  selectUnit(group) {
    this._track = 'ui';
    const g = group || 'inf';
    if (g === 'veh') {
      // 载具：引擎短咳（锯齿低频 + 一点机械噪声）
      this.tone({ f0: 82, f1: 56, dur: 0.22, gain: 0.15, type: 'sawtooth' });
      this.burst({ type: 'lowpass', f0: 300, f1: 140, dur: 0.12, gain: 0.07, delay: 0.02 });
    } else if (g === 'heavy') {
      // 重武器：金属咔嗒（步枪拉栓感）
      this.burst({ type: 'bandpass', f0: 2400, f1: 800, q: 2.2, dur: 0.05, gain: 0.15 });
      this.tone({ f0: 430, f1: 300, dur: 0.06, gain: 0.07, type: 'square', delay: 0.02 });
    } else if (g === 'hero') {
      // 指挥官：三音上行动机（比步兵哨音更“正式”，一耳朵能分出是指挥官）
      this.heroSelect();
    } else if (g === 'sup') {
      this.tone({ f0: 1240, f1: 1560, dur: 0.07, gain: 0.10, type: 'triangle' });
      this.tone({ f0: 1860, f1: 1860, dur: 0.05, gain: 0.045, type: 'sine', delay: 0.055 });
    } else {
      // 步兵：短促哨音
      this.tone({ f0: 860, f1: 1060, dur: 0.06, gain: 0.10, type: 'square' });
    }
  }

  // 单位阵亡：同样按分组，载具最重
  unitDie(group) {
    this._track = 'ui';
    const g = group || 'inf';
    if (g === 'veh') {
      this.burst({ type: 'lowpass', f0: 1100, f1: 130, dur: 0.34, gain: 0.20 });
      this.tone({ f0: 72, f1: 38, dur: 0.30, gain: 0.16, type: 'sine' });
    } else if (g === 'heavy') {
      this.burst({ type: 'bandpass', f0: 1500, f1: 260, q: 1.4, dur: 0.18, gain: 0.13 });
    } else if (g === 'sup') {
      this.tone({ f0: 720, f1: 300, dur: 0.18, gain: 0.09, type: 'triangle' });
    } else {
      this.tone({ f0: 420, f1: 170, dur: 0.16, gain: 0.11, type: 'sawtooth' });
    }
  }

  // 英雄枪托横扫（命中才响，n = 命中数）
  melee(x, y, n) {
    this._track = 'weapon';
    if (!this.ctx || !this.enabled) return;
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.16) return;
    if (!this.ok('melee', 0.07, dist)) return;
    const g2 = Math.min(1, 0.6 + (n || 1) * 0.2);
    this.tone({ f0: rnd(150, 175), f1: 62, dur: 0.11, gain: 0.12 * att * g2, type: 'sine', pan });
    this.burst({ type: 'bandpass', f0: rnd(1100, 1500), f1: 500, dur: 0.09, gain: 0.09 * att * g2, q: 0.8, pan });
  }

  // 钩爪发射：绳子弹出的「嗖」——高频快速下扫
  // 架设/收起：金属支架落地。setup = 两声脆响 + 一下低频；teardown = 一声闷响
  // 架设 / 收起：两声卡榫 + 低频落座。注意 burst()/tone() 都是对象参数
  deploy(on = true, x, y) {
    const { pan, att, dist } = this.mix(x, y);
    if (!this.ok('deploy', 0.15, dist)) return;
    if (on) {
      this.burst({ type: 'bandpass', f0: 2400, f1: 800, dur: 0.045, gain: 0.30 * att, q: 1.4, pan });                 // 卡榫 1
      this.burst({ type: 'bandpass', f0: 1800, f1: 600, dur: 0.055, gain: 0.34 * att, q: 1.4, pan, delay: 0.09 });  // 卡榫 2
      this.tone({ type: 'triangle', f0: 420, f1: 210, dur: 0.10, gain: 0.10 * att, pan, delay: 0.08 });
      this.tone({ f0: 120, f1: 70, dur: 0.16, gain: 0.12 * att, pan, delay: 0.10 });
    } else {
      this.burst({ type: 'bandpass', f0: 1200, f1: 400, dur: 0.05, gain: 0.22 * att, q: 1.2, pan });
      this.tone({ f0: 200, f1: 110, dur: 0.10, gain: 0.08 * att, pan, delay: 0.01 });
    }
  }

  hook(x, y) {
    this._track = 'ui';
    if (!this.ctx || !this.enabled) return;
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.14) return;
    if (!this.ok('hook', 0.10, dist)) return;
    this.burst({ type: 'bandpass', f0: 3200, f1: 900, dur: 0.13, gain: 0.10 * att, q: 1.6, pan });
    this.tone({ f0: 900, f1: 260, dur: 0.12, gain: 0.05 * att, type: 'triangle', pan });
  }

  // 钩爪落地 / 撞击：一声闷响
  thud(x, y) {
    this._track = 'weapon';
    if (!this.ctx || !this.enabled) return;
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.14) return;
    if (!this.ok('thud', 0.08, dist)) return;
    this.tone({ f0: 120, f1: 46, dur: 0.16, gain: 0.14 * att, type: 'sine', pan });
    this.burst({ type: 'lowpass', f0: 900, f1: 160, dur: 0.12, gain: 0.10 * att, pan });
  }

  // 载具碾压：power 1~4（按碾压权重），越重越沉
  crush(x, y, power) {
    this._track = 'weapon';
    if (!this.ctx || !this.enabled) return;
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.14) return;
    if (!this.ok('crush', 0.15, dist)) return;
    const p = Math.max(1, Math.min(4, power || 1));
    const g2 = 0.55 + p * 0.15;
    this.tone({ f0: rnd(70, 84) - p * 3, f1: 30 - p * 2, dur: 0.16 + p * 0.03, gain: 0.17 * att * g2, type: 'sine', pan, verb: 0.15 });
    this.burst({ type: 'lowpass', f0: rnd(320, 420), f1: 90, dur: 0.12 + p * 0.03, gain: 0.13 * att * g2, q: 0.6, pan });
  }

  // ---------------- 指挥官语音（电台应答，5 句） ----------------
  // 素材：Charlotte Duckett 录制 / Iwan Gabovitch 剪辑（CC-BY 3.0 或 GPLv2）
  // 只有 5 句、每句 <1s，所以定位是「电台应答」：确认指令、受压、倒地
  setVoiceTextFn(fn) { this.onVoiceText = typeof fn === 'function' ? fn : null; }

  // 每局重开时清掉语音冷却与抢占状态（否则上局刚播的 roger 会压住新局第一次指令）
  resetVoice() {
    this._lastVoice = -9;
    this._voiceCd = Object.create(null);
    this._voicePri = -1;
    this._voiceUntil = 0;
    this._voiceGain = null;
    this._voiceSrc = null;
  }

  // id: ready | roger | come_in | taking_fire | scream
  // 返回 true = 真的播了语音（false 时调用方可回落到合成音）
  voice(id, x, y) {
    const T = VOICE[id];
    if (!T) return false;
    if (!this.ctx || !this.enabled) return false;
    const now = this.ctx.currentTime;
    const pri = T.pri || 0;
    const playing = now < (this._voiceUntil || 0);
    // 正在播：同级或更低优先级直接放弃；更高优先级可以打断
    if (playing && pri <= this._voicePri) return false;
    const preempt = playing && pri > this._voicePri;
    // 全局间隔：两条语音至少隔 2.5s（抢占不受此限），避免「roger roger roger」叠成一串
    if (!preempt && now - this._lastVoice < 2.5) return false;
    if (now < (this._voiceCd[id] || -9)) return false;
    const sp = this.mix(x, y);
    if (sp.att < 0.12) return false;
    const v = T.variants[(Math.random() * T.variants.length) | 0] || { rate: 1, lp: 0 };
    // 先记账：即使采样没加载出来，也不要让调用方每帧重试
    this._lastVoice = now;
    this._voiceCd[id] = now + (T.cd || 0);
    const buf = this.bufs[T.file];
    if (!buf) return false;            // 没采样：不出字幕、不压音乐，交给调用方兜底
    if (this.onVoiceText) this.onVoiceText(T.text);
    this.duck(0.4, 0.55);              // 说话时把音乐压一下
    const inside = this.insideFn ? !!this.insideFn(x, y) : false;
    let lp = v.lp || 0;
    if (inside) lp = Math.min(lp || 6000, 2600);   // 楼内像隔着墙的电台
    // 抢占：上一句在 90ms 内淡掉并停住，别让两句话叠在一起
    if (preempt && this._voiceSrc) {
      try {
        const g0 = this._voiceGain;
        if (g0) {
          g0.gain.cancelScheduledValues(now);
          g0.gain.setTargetAtTime(0.0001, now, 0.03);
        }
        this._voiceSrc.stop(now + 0.12);
      } catch (e) { /* 已经停了就算了 */ }
      this._voiceSrc = null;
      this._voiceGain = null;
    }
    const prevTrk = this._track;
    this._track = 'voice';
    const ok = this.playBuf(T.file, {
      gain: (v.gain || 1) * sp.att, rate: v.rate || 1, pan: sp.pan, lp,
      onNode: (src, g, dur) => {
        this._voiceSrc = src;
        this._voiceGain = g;
        this._voiceUntil = now + dur;
        this._voicePri = pri;
        // 播完自己清状态：否则下一句抢占会对已经结束的节点 stop()（靠 catch 兜着，但不干净）
        const prevEnd = src.onended;
        src.onended = () => {
          if (prevEnd) prevEnd();
          if (this._voiceSrc === src) {
            this._voiceSrc = null;
            this._voiceGain = null;
            this._voiceUntil = 0;
          }
        };
      },
    });
    this._track = prevTrk;
    if (!ok) this._voicePri = -1;    // 没播出去（采样缺失/声部满）就别留优先级
    return ok;
  }

  // ---------------- 指挥官音效 ----------------
  // 选中：三音上行（C5-E5-G5），短、带一点厅堂，和步兵单声哨音区分
  heroSelect() {
    this._track = 'ui';
    if (!this.ok('heroSel', 0.25)) return;
    [[523, 0.00], [659, 0.075], [784, 0.150]].forEach(([f, d]) => {
      this.tone({ f0: f, f1: f * 1.005, dur: 0.115, gain: 0.085, type: 'triangle', delay: d, verb: 0.32 });
    });
    this.tone({ f0: 1568, f1: 1568, dur: 0.09, gain: 0.028, type: 'sine', delay: 0.155, verb: 0.3 });
  }

  // 技能：四个技能各有一套音色（爆炸本身由 boom 事件负责，这里只做“出手”）
  heroSkill(id, x, y) {
    this._track = 'weapon';
    if (!this.ctx || !this.enabled) return;
    const { pan, att } = this.mix(x, y);
    if (att < 0.12) return;
    if (id === 'grenade') {
      if (!this.ok('hkGrenade', 0.12)) return;
      // 拔销「咔」+ 甩出的破空声
      this.burst({ type: 'bandpass', f0: 2800, f1: 1200, q: 2.6, dur: 0.05, gain: 0.10 * att, pan });
      this.burst({ type: 'bandpass', f0: 1500, f1: 320, q: 0.9, dur: 0.26, gain: 0.085 * att, pan, delay: 0.05, verb: 0.2 });
      this.tone({ f0: 240, f1: 120, dur: 0.16, gain: 0.05 * att, type: 'sine', pan, delay: 0.05 });
    } else if (id === 'warcry') {
      // 战吼：低铜管上扬 + 一点点嘶吼噪声，气势为主，别做成警报
      this.duck(0.16, 0.6);
      this.tone({ f0: 110, f1: 165, dur: 0.46, gain: 0.13 * att, type: 'sawtooth', pan, verb: 0.45 });
      this.tone({ f0: 110.8, f1: 166, dur: 0.46, gain: 0.07 * att, type: 'sawtooth', pan, delay: 0.012, verb: 0.45 });
      this.burst({ type: 'bandpass', f0: 900, f1: 420, q: 0.7, dur: 0.34, gain: 0.055 * att, pan, delay: 0.02 });
      this.tone({ f0: 55, f1: 40, dur: 0.5, gain: 0.09 * att, type: 'sine', pan });
    } else if (id === 'adrenaline') {
      // 肾上腺素：两记心跳 + 一针注射
      this.tone({ f0: 62, f1: 40, dur: 0.15, gain: 0.16 * att, type: 'sine', pan });
      this.tone({ f0: 58, f1: 36, dur: 0.13, gain: 0.11 * att, type: 'sine', pan, delay: 0.16 });
      this.burst({ type: 'bandpass', f0: 3000, f1: 2000, q: 3.0, dur: 0.05, gain: 0.09 * att, pan, delay: 0.10 });
      this.tone({ f0: 1320, f1: 1980, dur: 0.12, gain: 0.045, type: 'triangle', pan, delay: 0.12, verb: 0.25 });
    }
    // grapple 的绳索与落地音由 hook()/thud() 负责，这里不再重复
  }

  // 晋升：两音小铃（英雄版更亮、更响一点）
  rankup(isHero = false) {
    this._track = 'ui';
    if (!this.ok('rankup', 0.55)) return;
    const a = isHero ? 784 : 660;
    const b = isHero ? 1175 : 990;
    this.tone({ f0: a, f1: a, dur: 0.14, gain: isHero ? 0.11 : 0.075, type: 'triangle', verb: 0.35 });
    this.tone({ f0: b, f1: b * 1.004, dur: 0.22, gain: isHero ? 0.095 : 0.062, type: 'triangle', delay: 0.09, verb: 0.4 });
    if (isHero) this.tone({ f0: 2350, f1: 2350, dur: 0.10, gain: 0.03, type: 'sine', delay: 0.20, verb: 0.35 });
  }

  // 重伤：闷响 + 下行的短三度（“被打倒”的落感，不用惨叫）
  heroDown() {
    this._track = 'ui';
    this.duck(0.2, 0.7);
    this.burst({ type: 'lowpass', f0: 700, f1: 110, dur: 0.36, gain: 0.18, verb: 0.25 });
    this.tone({ f0: 96, f1: 42, dur: 0.34, gain: 0.16, type: 'sine' });
    this.tone({ f0: 392, f1: 330, dur: 0.30, gain: 0.070, type: 'triangle', delay: 0.05, verb: 0.4 });
  }

  // 归队：上行三音 + 高泛音（和 clear() 的音高不同，避免听起来像“清完一波”）
  heroBack() {
    this._track = 'ui';
    if (!this.ok('heroBack', 0.5)) return;
    [[587, 0.00], [740, 0.09], [880, 0.18]].forEach(([f, d]) => {
      this.tone({ f0: f, f1: f * 1.006, dur: 0.18, gain: 0.092, type: 'triangle', delay: d, verb: 0.42 });
    });
    this.tone({ f0: 1760, f1: 1760, dur: 0.14, gain: 0.030, type: 'sine', delay: 0.20, verb: 0.4 });
  }

  build() { this.tone({ f0: 520, f1: 660, dur: 0.09, gain: 0.13, type: 'triangle' }); }
  sell() { this.tone({ f0: 480, f1: 260, dur: 0.1, gain: 0.11, type: 'triangle' }); }
  deny() {
    this._track = 'ui';
    if (!this.ok('deny', 0.28)) return;
    this.tone({ f0: 180, f1: 120, dur: 0.12, gain: 0.13, type: 'square' });
  }
  click() { this.tone({ f0: 700, f1: 900, dur: 0.05, gain: 0.07, type: 'square' }); }

  wave(n) {
    this._track = 'ui';
    this.duck(0.55, 0.9);
    if (!this.ok('wave', 0.5)) return;
    const base = 190 + n * 10;
    this.tone({ f0: base, f1: base * 1.5, dur: 0.55, gain: 0.13, type: 'sawtooth', verb: 0.5 });
    this.tone({ f0: base * 1.5, f1: base * 2, dur: 0.5, gain: 0.075, type: 'sawtooth', delay: 0.18, verb: 0.5 });
  }

  clear() {
    this._track = 'ui';
    if (!this.ok('clear', 0.8)) return;
    [523, 659, 784].forEach((f, i) => this.tone({ f0: f, f1: f * 1.01, dur: 0.16, gain: 0.1, type: 'triangle', delay: i * 0.09, verb: 0.4 }));
  }

  win() {
    this._track = 'ui';
    this.duck(0.25, 2.0);
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ f0: f, f1: f * 1.01, dur: 0.34, gain: 0.12, type: 'triangle', delay: i * 0.13, verb: 0.5 }));
  }

  lose() {
    this._track = 'ui';
    this.duck(0.25, 2.0);
    [392, 330, 262, 196].forEach((f, i) => this.tone({ f0: f, f1: f * 0.99, dur: 0.42, gain: 0.12, type: 'sawtooth', delay: i * 0.16, verb: 0.5 }));
  }

  // ---------------- 环境音（持续音 + 脚步） ----------------
  // 载具引擎/履带：按 id 维护一条常驻循环，随位置更新声像与音量
  setAmbient(list) {
    if (!this.ctx) return;
    const want = new Map();
    if (this.enabled && list) for (const a of list) want.set(a.id, a);
    for (const id of [...this.loops.keys()]) if (!want.has(id)) this._stopLoop(id);
    if (!this.enabled) return;
    for (const [id, a] of want) {
      let L = this.loops.get(id);
      if (!L) {
        L = this._startLoop(id, a.kind);
        if (!L) continue;
      }
      this._track = 'amb';
      const { pan, att } = this.mix(a.x, a.y);
      const target = Math.max(0.0001, att * (a.gain || 1) * 0.5);
      const now = this.ctx.currentTime;
      try {
        L.g.gain.setTargetAtTime(target, now, 0.09);
        if (L.p) L.p.pan.setTargetAtTime(pan, now, 0.09);
      } catch (e) {
        L.g.gain.value = target;
        if (L.p) L.p.pan.value = pan;
      }
    }
  }

  _startLoop(id, kind) {
    const c = this.ctx;
    const buf = this.bufs[kind];
    if (!c || !buf || this.loops.size >= 8) return null;
    try {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = rnd(0.94, 1.06);
      const g = c.createGain();
      g.gain.value = 0.0001;
      // 低通：引擎只留 260Hz 以下、履带 170Hz 以下，远听是闷响而不是电流声
      const LP = { engine: 260, track: 170 };
      const flt = (typeof c.createBiquadFilter === 'function') ? c.createBiquadFilter() : null;
      if (flt) {
        flt.type = 'lowpass';
        flt.frequency.value = LP[kind] || 300;
        flt.Q.value = 0.6;
      }
      const p = c.createStereoPanner ? c.createStereoPanner() : null;
      if (flt) src.connect(flt).connect(g); else src.connect(g);
      const bus = (this.bus && this.bus.amb) || this.sfxBus;
      if (p) g.connect(p).connect(bus); else g.connect(bus);
      src.start();
      const L = { src, g, p, flt };
      this.loops.set(id, L);
      return L;
    } catch (e) {
      return null;
    }
  }

  _stopLoop(id) {
    const L = this.loops.get(id);
    if (!L) return;
    this.loops.delete(id);
    try { L.src.stop(); } catch (e) {}
    try { L.src.disconnect(); if (L.flt) L.flt.disconnect(); L.g.disconnect(); if (L.p) L.p.disconnect(); } catch (e) {}
  }

  stopAllLoops() {
    for (const id of [...this.loops.keys()]) this._stopLoop(id);
  }

  // 脚步：士兵行进时踩地的闷响（离散，受预算限制）
  step(x, y) {
    this._track = 'amb';
    const { pan, att, dist } = this.mix(x, y);
    if (att < 0.12) return;
    // 脚步：整屏最多 2 声/0.45s（≈4.4 声/秒）。大战里几十个人一起走，
    // 宁可抽稀也不能糊成一片；节奏的自然感靠 main.js 里按 id 的相位抖动，
    // 这里不再随机抽样（否则同一帧的调用次数不可预测，测试也没法断言）。
    if (!this.budget('step', 2, 0.45)) return;
    const g = 0.062 * att;
    if (this.playBuf('step', { gain: g, rate: rnd(0.88, 1.08), pan, lp: 900 })) return;
    this.burst({ type: 'lowpass', f0: 200, f1: 90, q: 0.9, dur: 0.06, gain: 0.030 * att, pan });
  }

  // ---------------- BGM ----------------
  loadMusic() {
    const c = this.ctx;
    if (!c || this.tracks) return;
    // OGG Vorbis 只有 WAV 的 1/20 体积，但 iOS Safari 不支持 => 探测一次，不支持就用 wav
    const canOgg = (() => {
      try { return !!new Audio().canPlayType('audio/ogg; codecs="vorbis"'); } catch (e) { return false; }
    })();
    const M = {
      title: 'assets/audio/bgm/airy.mp3',
      prep: 'assets/audio/bgm/pulse.mp3',
      battle: 'assets/audio/bgm/urgent.mp3',
      win: 'assets/audio/bgm/victory.mp3',
      lose: 'assets/audio/bgm/transmission.mp3',
      // 黑松林专属：Mixkit 悬疑低频，31.9s 无缝循环
      forest: canOgg ? 'assets/audio/bgm/forest-suspense.ogg' : 'assets/audio/bgm/forest-suspense.wav',
      // Rust Block 专属：Mixkit 低频脉冲，15.9s 无缝循环
      rust: canOgg ? 'assets/audio/bgm/rust-pulse.ogg' : 'assets/audio/bgm/rust-pulse.wav',
    };
    this.tracks = {};
    for (const k in M) {
      const el = new Audio();
      el.loop = true;
      el.preload = 'none';           // 懒加载：只有真正切到这首曲子才下载
      el.dataset.src = M[k];
      el.volume = 1;
      let node = null;
      try {
        const src = c.createMediaElementSource(el);
        const g = c.createGain();
        g.gain.value = 0;
        src.connect(g).connect(this.bgmBus);
        node = g;
      } catch (e) {
        el.volume = 0;    // 兜底：直接用元素音量
      }
      this.tracks[k] = el;
      this.trackGain[k] = node;
    }
  }

  _setTrackVol(k, v, fade) {
    const g = this.trackGain[k];
    const el = this.tracks && this.tracks[k];
    if (!g) { if (el) el.volume = clamp01(v); return; }
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(clamp01(v), now + Math.max(0.05, fade));
  }

  music(name, fade = 1.0) {
    if (!this.tracks || !this.tracks[name]) return;
    if (this.cur === name) return;
    const prev = this.cur;
    this.cur = name;
    if (prev && this.tracks[prev]) {
      this._setTrackVol(prev, 0, fade);
      const el = this.tracks[prev];
      setTimeout(() => {
        if (this.cur !== prev && el) { try { el.pause(); } catch (e) {} }
      }, fade * 1000 + 80);
    }
    const to = this.tracks[name];
    if (!to.src && to.dataset && to.dataset.src) to.src = to.dataset.src;
    try {
      to.currentTime = 0;
      const r = to.play();
      if (r && r.catch) r.catch(() => {});
    } catch (e) {}
    this._setTrackVol(name, this.enabled ? 1 : 0, fade);   // 音量统一由 bgmBus 控制，这里只做淡入
  }

  retryMusic() {
    const n = this.cur;
    if (!n || !this.tracks || !this.tracks[n]) return;
    const el = this.tracks[n];
    if (!el.src && el.dataset && el.dataset.src) el.src = el.dataset.src;
    if (!el.paused) return;
    this.cur = null;
    this.music(n, 0.4);
  }

  setVolumes(bgm, sfx, trk) {
    if (typeof bgm === 'number') this.volBgm = clamp01(bgm);
    if (typeof sfx === 'number') this.volSfx = clamp01(sfx);
    if (trk && typeof trk === 'object') {
      for (const k of ['weapon', 'boom', 'ui', 'amb', 'voice']) {
        if (typeof trk[k] === 'number') this.trkVol[k] = clamp01(trk[k]);
      }
      if (this.bus) for (const k in this.bus) this.bus[k].gain.value = this.trkVol[k];
    }
    if (this.sfxBus) this.sfxBus.gain.value = this.volSfx;
    if (this.bgmBus) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      if (this.ctx) {
        this.bgmBus.gain.cancelScheduledValues(now);
        this.bgmBus.gain.setValueAtTime(this.bgmBus.gain.value, now);
        this.bgmBus.gain.linearRampToValueAtTime(this.enabled ? this.volBgm : 0, now + 0.12);
      } else {
        this.bgmBus.gain.value = this.enabled ? this.volBgm : 0;
      }
    }
    if (this.cur) this._setTrackVol(this.cur, this.enabled ? 1 : 0, 0.12);
    try {
      localStorage.setItem('dcl.vol', JSON.stringify({
        bgm: this.volBgm, sfx: this.volSfx, trk: this.trkVol,
      }));
    } catch (e) {}
  }

  loadVolumes() {
    try {
      const v = JSON.parse(localStorage.getItem('dcl.vol') || 'null');
      if (v && typeof v.bgm === 'number') this.volBgm = clamp01(v.bgm);
      if (v && typeof v.sfx === 'number') this.volSfx = clamp01(v.sfx);
      if (v && v.trk) {
        for (const k of ['weapon', 'boom', 'ui', 'amb', 'voice']) {
          if (typeof v.trk[k] === 'number') this.trkVol[k] = clamp01(v.trk[k]);
        }
      }
    } catch (e) {}
  }
}
