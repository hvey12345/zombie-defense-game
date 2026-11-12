// js/main.js — 状态机 / DOM HUD / 输入 / 编辑器。唯一允许碰浏览器 API 的文件。
import { params, clamp } from './util.js';
import { TERRAIN, UNITS, FORTS, ZOMBIES, RULE, SPEC_SCHEMES, SKILLS, SKILL_ORDER, HERO_SKILLS, HERO_SKILL_ORDER, TILE_NAME, ARMOR, ARMOR_LABEL, NODE_TYPES, STANCE, CORE_PROD, GARRISON, SPECIAL_IDS, VOICE_GROUP, PERKS, PERK_SECS } from './data.js';
import { PHASE, THREAT_FULL, airdropOk, autoBuild, buildBounds, canPlaceAt, canProduce, capOk, castHeroSkill, castSkill, cloneMap, createRun, createWave, demolishAt, deployBounds, enqueueAt, garrisonAt, garrisonCap, garrisonUsed, heroOf, incomeRate, isUnlocked, manualReload, orderGarrison, orderMove, orderMoveInside, orderUngarrison, pickPerk, popCap, popLeft, popUsed, producibleList, requirementOf, resetSkills, setPatrol, setStance, sourceOf, startBattle, stepRun, supplyCap, swapParts, threatNow, toggleDeploy, towCdLeft, unitDmgMul, unitHpMul, unitRange, unitSpeedNow, unitXpNext, unitRank, warcryDmgMul, adrSpeedMul, buildingAt, unlockWaveOf, wavePreview, zAttackInterval, zEnrageMul, zScreamMul } from './game.js';
import { drawScene, loadSprites } from './art.js';
import { iconPath } from './icons.js';
import { Sfx } from './sfx.js';
import { makeMap, MAP_KINDS, MAP_LABEL } from './maps.js';

const STATE = { TITLE: 'title', PREP: 'prep', BATTLE: 'battle', RESULT: 'result' };
// ?bgm=mp3 可强制森林也用 mp3，方便 A/B 试听

const $ = (id) => document.getElementById(id);

// 运行期异常兜底：把信息显示出来，别让页面静默卡死
function reportCrash(kind, msg) {
  try {
    const box = document.getElementById('crash');
    if (box) {
      box.classList.remove('hidden');
      box.textContent = `[${kind}] ${msg}`;
    } else {
      const el = document.createElement('div');
      el.id = 'crash';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;max-width:70vw;padding:10px 12px;'
        + 'background:#3b0d0d;color:#ffd7d7;border:1px solid #8b2b2b;border-radius:8px;font:12px/1.5 monospace;white-space:pre-wrap';
      el.textContent = `[${kind}] ${msg}`;
      document.body.appendChild(el);
    }
  } catch (e) { /* 兜底失败就算了 */ }
}
window.addEventListener('error', (e) => {
  reportCrash('error', `${e.message || 'unknown'} @ ${e.filename || '?'}:${e.lineno || 0}`);
});
window.addEventListener('unhandledrejection', (e) => {
  reportCrash('promise', String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

const cv = $('cv');
const ctx = cv.getContext('2d');
const sfx = new Sfx();
window.__dclSfx = sfx;   // 调试用：在控制台查音频状态

const app = {
  state: STATE.TITLE,
  map: makeMap('city17'),
  mapKind: 'city17',
  run: null,
  preview: null,
  cfg: { total: 8, base: 90, grow: 1.31, final: 1.2 },
  tool: { kind: 'select' },
  hover: null,
  drag: null,
  box: null,
  sel: new Set(),
  markers: [],
  selectedUnitId: null,
  speed: 1,
  paused: false,
  muted: false,
  damageNum: true,
  showPath: true,
  aggro: 1,
  spec: 2,
  selZ: null,
  selF: null,      // 选中的工事/兵营 id
  selNode: null,
  selTile: null,
  srcId: null,   // 选中的资源点 id
  selRaid: null,   // 选中的叛军 id
  selCore: false,  // 选中据点
  zbar: true,
  decal: true,   // 战场痕迹（尸体 / 焦痕）
  ffOn: true,
  showAura: false,
  autoCollapse: true,
  cam: { x: 0, y: 0 },
  zoom: 1.4,
  keys: new Set(),
  mouse: { x: 0, y: 0, inside: false },
  skillMode: null,
  debug: false,
  god: false,
  seed: 0,
  acc: 0,
  last: 0,
  hudT: 0,
  lastCoreHp: 0,
  shake: 0,
  log: [],        // 战报日志（最近 24 条，底栏只显示 3 条）
  logDirty: false,
};

const groups = new Map();   // 编队：数字键 -> 单位 id 数组

// ---------------- 基础设施 ----------------
// 音频：采样音效 + BGM（全部 CC0）
function initAudio() {
  sfx.init(); sfx.resume();
  sfx.loadSamples();
  sfx.loadMusic();
  sfx.loadVolumes();
  // 楼内闷音：这个点在不在建筑里（建筑格都算"室内"，门洞也一样）
  sfx.setInsideFn((x, y) => {
    const run = app.run;
    if (!run || !run.map) return false;
    const T = run.map.tile;
    const tx = Math.floor(x / T), ty = Math.floor(y / T);
    if (tx < 0 || ty < 0 || tx >= run.map.w || ty >= run.map.h) return false;
    const bld = buildingAt(run, tx, ty);
    return !!(bld && bld.hp > 0);
  });
  const b = $('vol-bgm'), f = $('vol-sfx');
  if (b) b.value = String(Math.round(sfx.volBgm * 100));
  if (f) f.value = String(Math.round(sfx.volSfx * 100));
  for (const k of ['weapon', 'boom', 'ui', 'amb', 'voice']) {
    const el = $('vol-' + k);
    if (el) el.value = String(Math.round((sfx.trkVol && sfx.trkVol[k] != null ? sfx.trkVol[k] : 1) * 100));
  }
  sfx.music(app.state === STATE.TITLE ? 'title' : 'prep');
  // 浏览器首次互动才允许放音乐：再补一次
  const kick = () => { sfx.resume(); sfx.retryMusic(); };
  document.addEventListener('pointerdown', kick);
  document.addEventListener('keydown', kick);
}
// 指挥官语音字幕：底栏上方飘一行，2.2s 后淡出（同一句连续触发只续时间）
let _subTimer = 0;
function showVoiceSub(text) {
  const el = $('voice-sub');
  if (!el || !text) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(_subTimer);
  _subTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function bindVolumes() {
  if (sfx.setVoiceTextFn) sfx.setVoiceTextFn(showVoiceSub);
  const b = $('vol-bgm'), f = $('vol-sfx');
  if (b) b.addEventListener('input', () => sfx.setVolumes(Number(b.value) / 100, null));
  if (f) f.addEventListener('input', () => sfx.setVolumes(null, Number(f.value) / 100));
  // 五轨：武器 / 爆炸 / 界面 / 环境 / 语音，各乘在「音效」总音量之上
  for (const k of ['weapon', 'boom', 'ui', 'amb', 'voice']) {
    const el = $('vol-' + k);
    if (el) el.addEventListener('input', () => {
      const trk = Object.assign({}, sfx.trkVol);
      trk[k] = Number(el.value) / 100;
      sfx.setVolumes(null, null, trk);
    });
  }
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 1600);
}

// ── 战报日志：底栏右侧那三行
// 只记「值得回头看」的事件（波次 / 据点易主 / 建筑被拆 / 巨兽 / 抢点队），
// 不走 toast 通道 —— toast 有 107 处调用，全塞进来会刷屏。
const LOG_MAX = 24;
function pushLog(text, kind) {
  if (!text) return;
  app.log.unshift({ text: String(text), kind: kind || '' });
  if (app.log.length > LOG_MAX) app.log.length = LOG_MAX;
  app.logDirty = true;
}
// 战报限流：据点扣血、资源满、僵尸贴脸这类状态没有一次性事件可挂，
// 靠 key + 时间窗口去重，否则每帧一条会把真正的关键信息挤出 24 条上限。
app.logThr = app.logThr || {};
function logThr(key, ms) {
  const now = Date.now();
  if ((app.logThr[key] || 0) + ms > now) return false;
  app.logThr[key] = now;
  return true;
}

function renderLog() {
  const el = $('battlelog');
  if (!el || !app.logDirty) return;
  app.logDirty = false;
  if (!app.log.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = app.log.slice(0, 3)
    .map((r) => `<div class="lg${r.kind ? ' ' + r.kind : ''}">${r.text}</div>`)
    .join('');
}

function makePreview(map) {
  return {
    map,
    core: { x: map.core.x, y: map.core.y, hp: RULE.core.hp, maxHp: RULE.core.hp },
    forts: [], units: [], zombies: [], effects: [], events: [], epoch: 1,
  };
}

function pruneSelection() {
  const run = app.run;
  if (!run || !app.sel.size) return;
  const alive = new Set(run.units.map((u) => u.id));
  for (const id of [...app.sel]) if (!alive.has(id)) app.sel.delete(id);
}

function setState(s) {
  app.state = s;
  $('title').classList.toggle('hidden', s !== STATE.TITLE);
  $('result').classList.toggle('hidden', s !== STATE.RESULT);
  if (s !== STATE.RESULT) {
    document.body.classList.remove('menu-win', 'menu-lose');
  }
  $('topbar').classList.toggle('hidden', !(s === STATE.PREP || s === STATE.BATTLE));
  syncBarLayout();
  $('minimap-wrap').classList.toggle('hidden', !(s === STATE.PREP || s === STATE.BATTLE));
  if (s !== STATE.PREP && s !== STATE.BATTLE) closeSource();
  if (s === STATE.TITLE) {
    app.preview = makePreview(app.map);
    app.run = null;
  }
  if (s !== STATE.PREP && s !== STATE.BATTLE) setPaused(false);
  syncMenuOpen();
  // BGM 跟随状态
  const MUSIC_OF = {
    [STATE.TITLE]: 'title',
    [STATE.PREP]: 'prep', [STATE.BATTLE]: 'battle',
    [STATE.RESULT]: 'title',
  };
  // 森林图用专属 BGM（备战/战斗同一首，氛围连续）
  // 一张图一套 BGM：只有森林与 Rust Block 有专属曲，其余走通用曲表
  const MAP_BGM = { forest: 'forest', oldtown: 'rust' };
  const mapTrack = MAP_BGM[app.mapKind || 'city17'];
  const track = (mapTrack && (s === STATE.PREP || s === STATE.BATTLE)) ? mapTrack : MUSIC_OF[s];
  if (track) sfx.music(track);
  app.sel.clear();
  refreshHud(true);
  refreshUnitInfo();
}


// ---------------- 单位信息面板 ----------------
// 射速口径（含换弹的平均射速）：弹夹武器用「一个弹夹周期」计算，
// 否则瞬时 1/间隔 会把 DPS 系统性高估（步兵 5 发/0.3s + 换弹 1s：瞬时 3.33 → 实际 2.00）
function fireRateOf(d) {
  if (!d || !d.fireInterval) return 0;
  const iv = d.fireInterval * (d.splash ? RULE.combat.splashAttackMul : 1);
  const mg = d.mag;
  if (!mg || !mg.size) return 1 / iv;
  const rt = Math.max(0, mg.reload != null ? mg.reload : 1);
  return mg.size / (mg.size * iv + rt);
}

function uiLabels(a, b2, c, d, e) {
  const set = (id, txt) => {
    const el = $(id);
    if (el && el.previousElementSibling) el.previousElementSibling.textContent = txt;
  };
  set('ui-dmg', a); set('ui-rate', b2); set('ui-range', c); set('ui-speed', d); set('ui-armor', e);
}

// 据点面板的资金 ↔ 零件兑换行：次数用掉/资源不够时按钮置灰
function paintSwapRow(run) {
  const box = $('ui-swap');
  const cb = $('swap-buy'), cs = $('swap-sell');
  const cfg = (RULE.econ && RULE.econ.swap) || {};
  const cap = cfg.perWave || 20;
  const used = run.swapUsed || 0;
  box.classList.remove('hidden');
  $('swap-buy-cost').textContent = cfg.buyCost || 20;
  $('swap-sell-gain').textContent = cfg.sellGain || 2;
  const buyCost = cfg.buyCost || 20;
  const sellGain = cfg.sellGain || 2;
  // 次数提示只在用过之后才占地方（正常玩基本用不完 20 次）
  $('swap-cap').textContent = used > 0 ? `本波 ${used}/${cap}` : '';
  cb.disabled = used >= cap || run.supply < buyCost;
  cs.disabled = used >= cap || run.parts < 1;
  cb.title = `花 ${buyCost} 资金换 1 零件（每个整备期最多 ${cap} 次，快捷键 B）`;
  cs.title = `1 零件换 ${sellGain} 资金（每个整备期最多 ${cap} 次，快捷键 K）`;
  // 第二行：一次换 10 次（买 / 卖），共用同一个 perWave 次数池
  const cb10 = $('swap-buy10'), cs10 = $('swap-sell10');
  $('swap-buy10-cost').textContent = buyCost * 10;
  $('swap-sell10-gain').textContent = sellGain * 10;
  cb10.disabled = used + 10 > cap || run.supply < buyCost * 10;
  cs10.disabled = used + 10 > cap || run.parts < 10;
  cb10.title = `一次换 10 个：花 ${buyCost * 10} 资金（占 10 次额度）`;
  cs10.title = `一次卖 10 个：换回 ${sellGain * 10} 资金（占 10 次额度）`;
  box.title = `买与卖有差价：买入价 ${buyCost} 资金/零件，卖出价只有 ${sellGain} 资金/零件。`
    + `每个整备期最多兑换 ${cap} 次（买和卖共用次数）。`;
}

function doSwap(dir, times) {
  const run = app.run;
  if (!run) return;
  const n = times || 1;
  const res = swapParts(run, dir, n);
  if (!res.ok) {
    if (res.reason === 'cap') toast(`本波兑换额度不够（剩 ${res.cap - res.used} 次，这次要 ${n} 次）`);
    else if (res.reason === 'cash') toast('资金不够：需要 ' + (res.need || 20));
    else if (res.reason === 'parts') toast(`零件不够：需要 ${res.need || 1}`);
    return;
  }
  sfx.build();
  const sw = (RULE.econ && RULE.econ.swap) || {};
  toast(dir === 'buy'
    ? `买入 ${n} 零件，花掉 ${(sw.buyCost || 20) * n} 资金`
    : `卖出 ${n} 零件，换回 ${(sw.sellGain || 2) * n} 资金`);
  refreshHud(true);
}

function refreshUnitInfo() {
  // 选中的工事/资源点可能已经被拆了，先做一次自净
  if (app.run && app.selF) {
    const still = app.run.forts.some((f) => f.id === app.selF && f.hp > 0);
    if (!still) { app.selF = null; }
  }

  const el = $('unitinfo');
  if (!el) return;
  const run = app.run;
  let u = null;
  if (run && app.sel.size === 1) {
    const id = [...app.sel][0];
    u = run.units.find((x) => x.id === id) || null;
  }
  // 僵尸面板
  let z = null;
  if (run && app.selZ) {
    z = run.zombies.find((x) => x.id === app.selZ && x.hp > 0) || null;
    if (!z) app.selZ = null;
  }
  // 叛军面板
  let raid = null;
  if (run && app.selRaid != null) {
    raid = (run.raiders || []).find((x) => x.id === app.selRaid && x.hp > 0) || null;
    if (!raid) app.selRaid = null;
  }
  // 地块面板：只有在「没有选中任何实体」时才显示，避免选中单位后面板还显示空地
  const hasEntity = !!(u || z || raid || app.selF || app.selNode || app.selCore);
  if (run && app.selTile && !hasEntity) {
    const { tx, ty } = app.selTile;
    if (tx < 0 || ty < 0 || tx >= run.map.w || ty >= run.map.h) app.selTile = null;
    else {
      const tt = run.map.tiles[ty * run.map.w + tx];
      const td = TERRAIN[tt] || {};
      const nm = TILE_NAME[tt] || '地面';
      const b = run.map.buildings.find((bb) => tx >= bb.x && tx < bb.x + bb.w && ty >= bb.y && ty < bb.y + bb.h);
      el.classList.remove('hidden');
      $('ui-icon').style.display = 'none';
      const gb = b && b.garrison ? b : null;
      const gCap = gb ? garrisonCap(gb) : 0;
      const gCnt = gb ? garrisonUsed(run, gb) : 0;
      $('ui-name').textContent = b ? (b.tone === 'tree' ? '树木' : (gb ? '可进入建筑' : '建筑')) : nm;
      $('ui-hp').textContent = b ? `${Math.max(0, Math.ceil(b.hp))}/${b.maxHp || 400}` : '—';
      $('ui-hpfill').style.width = b ? `${clamp((b.hp / (b.maxHp || 400)) * 100, 0, 100).toFixed(1)}%` : '0%';
      $('ui-hpfill').style.background = '#4fa3d9';
      $('ui-dmg').textContent = td.zSpeed ? `×${td.zSpeed.toFixed(2)}` : '—';
      $('ui-rate').textContent = td.uSpeed ? `×${td.uSpeed.toFixed(2)}` : '—';
      $('ui-range').textContent = td.range ? `×${td.range.toFixed(2)}` : '—';
      const block = (td.buildBlock || []).join('/');
      $('ui-speed').textContent = !td.walkable ? '不可进入' : (block ? `禁止${block}` : '全部可建');
      uiLabels('僵尸速度', '我方速度', '射程倍率', '建造', '耐久');
      $('ui-armor').textContent = b ? '可破坏' : '—';
      $('ui-note').textContent = gb
        ? `可进入：楼内 ${gCnt}/${gCap}（格数 ${b && b.cells ? b.cells.length : 0} · 每 2 格 1 人）· 读条进 1.5s／出 1.0s · 射程 ×1.15 · 受伤 -20%；楼内可自由走位`
        : (b
          ? '可破坏，僵尸拆完后变成碎石'
          : (td.walkable ? '可通行、可布防' : '僵尸与单位均无法穿越'));
      return;
    }
  }
  $('ui-icon').style.display = '';

  if (z && (app.state === STATE.BATTLE || app.state === STATE.PREP)) {
    const zd = ZOMBIES[z.mob] || ZOMBIES.walker;
    el.classList.remove('hidden');
    $('ui-icon').src = iconPath(zd.icon || 'zombie');
    $('ui-name').textContent = zd.name || z.mob;
    const zhp = Math.max(0, Math.ceil(z.hp));
    $('ui-hp').textContent = `${zhp}/${z.maxHp}`;
    $('ui-hpfill').style.width = `${clamp((z.hp / z.maxHp) * 100, 0, 100).toFixed(1)}%`;
    $('ui-hpfill').style.background = z.hp / z.maxHp > 0.35 ? '#e2594a' : '#e0603a';
    $('ui-dmg').textContent = z.dmg > 0 ? `${z.dmg}${z.vsBuilding > 1 ? ` · 建筑×${z.vsBuilding}` : ''}` : '无攻击';
    const zrg = zEnrageMul(z);
    const zsc = zScreamMul(z, run.time);
    $('ui-rate').textContent = z.dmg > 0
      ? `${(1 / zAttackInterval(z, run.time)).toFixed(1)} 次/秒${zrg.on ? '（狂暴）' : ''}${zsc.on ? '（尖啸加速）' : ''}`
      : '无';
    $('ui-range').textContent = `${Math.round(z.size * 0.7 + 9)}`;
    $('ui-speed').textContent = `${Math.round(z.speed * zrg.speed * zsc.speed)}${zrg.on ? '（狂暴）' : ''}${zsc.on ? '（尖啸加速）' : ''}`;
    const zarm = zd.armor || 'none';
    $('ui-armor').textContent = ARMOR_LABEL[zarm] || '无甲';
    uiLabels('攻击力', '攻击频率', '攻击距离', '移动速度', '甲质');
    const slowLeft = (z.slowUntil || 0) - run.time;
    if (slowLeft > 0) {
      const pct = Math.round((1 - (z.slowMul || 1)) * 100);
      $('ui-speed').textContent = `${Math.round(z.speed * zrg.speed * zsc.speed * (z.slowMul || 1))}（减速 -${pct}%，${slowLeft.toFixed(1)}s）`;
    }
    const zp = zd.armorPierce || {};
    const pierceTxt = zp.light >= 1 && zp.heavy >= 1 ? ' · 无视轻甲/重甲'
      : zp.light >= 1 && zp.heavy ? ' · 无视轻甲，重甲减伤减半'
        : zp.light >= 1 ? ' · 无视轻甲'
          : zp.heavy >= 1 ? ' · 无视重甲'
            : zp.heavy ? ' · 重甲减伤减半' : '';
    const spz = zd.special || {};
    const smv = spz.move || {};
    const screamTxt = spz.ability === 'scream'
      ? (z.spPhase === 'park'
        ? `架设中：每 ${spz.cd}s 尖啸一次，半径 ${spz.radius} 内僵尸移速 ×${spz.speedMul}、攻速 ×${spz.rateMul}（${spz.dur}s）· 保持距离 ${spz.parkRange} · `
        : `行进中：每 ${smv.cd}s 弱尖啸一次（移速 ×${smv.speedMul}、攻速 ×${smv.rateMul}）· 逼近到 ${spz.parkRange} 就架设 · `)
      : '';
    $('ui-note').textContent = `${screamTxt}${zrg.on ? `狂暴：血量低于 40%，移速 ×${zrg.speed}、攻速 ×${zrg.rate} · ` : ''}威胁值 ${zd.threat}${pierceTxt} · ${zarm === 'none' ? '火焰与远程通吃' : zarm === 'light' ? '狙击有加成' : '坦克/火箭筒破甲最有效'} · 甲质决定我方武器的克制倍率（见我方单位面板「克制」）· ${z.atkId ? '正在追击单位' : (z.mode === 'attack' ? '正在拆工事' : '向据点推进')}`;
    return;
  }
  // 工事 / 兵营面板
  if (run && app.selF) {
    const f = run.forts.find((x) => x.id === app.selF && x.hp > 0) || null;
    if (!f) { app.selF = null; } else {
      const fd = FORTS[f.kind];
      el.classList.remove('hidden');
      $('ui-icon').src = iconPath(fd.icon || f.kind);
      $('ui-name').textContent = fd.name || f.kind;
      const fhp = Math.max(0, Math.ceil(f.hp));
      $('ui-hp').textContent = `${fhp}/${f.maxHp}`;
      $('ui-hpfill').style.width = `${clamp((f.hp / f.maxHp) * 100, 0, 100).toFixed(1)}%`;
      $('ui-hpfill').style.background = f.hp / f.maxHp > 0.35 ? '#a8b6c4' : '#e0603a';
      $('ui-dmg').textContent = fd.blocks ? '阻挡寻路' : (fd.slow ? `减速 ${Math.round(fd.slow * 100)}%` : '—');
      $('ui-rate').textContent = '—';
      $('ui-range').textContent = '—';
      $('ui-speed').textContent = '—';
      $('ui-armor').textContent = ARMOR_LABEL[fd.armor || 'none'];
      uiLabels('效果', '—', '—', '—', '护甲');
      {
        let note = fd.base
          ? '基地建筑：人口上限 +6，本身也是出兵点'
          : (fd.blocks ? '堵住单路，僵尸只能拆掉才能过' : '不阻挡行动，走过去的僵尸会被打');
        if (f.room) note += ` · 楼内 ${garrisonUsed(run, f.room)}/${garrisonCap(f.room)}（步兵右键进驻；左键点楼内小人可单独选中）`;
        $('ui-note').textContent = note;
      }
      return;
    }
  }
  // 资源点面板
  if (run && app.selNode) {
    const n = (run.nodes || []).find((x) => x.id === app.selNode) || null;
    if (!n) { app.selNode = null; } else {
      const nt = NODE_TYPES[n.kind] || NODE_TYPES.cash;
      const owned = n.owner === 1;
      el.classList.remove('hidden');
      $('ui-icon').src = iconPath(nt.icon);
      $('ui-name').textContent = nt.name;
      const graceSec = Math.max(0, Math.ceil(n.cap * (RULE.econ.holdGrace || 20)));
      $('ui-hp').textContent = owned
        ? (n.guard ? '已占领 · 有人驻守' : `无人驻守 · ${graceSec}s 后失守`)
        : (Math.abs(n.cap) < 0.01 ? '中立' : (n.cap > 0 ? `占领中 ${Math.round(n.cap * 100)}%` : `被反推 ${Math.round(-n.cap * 100)}%`));
      $('ui-hpfill').style.width = `${Math.round(Math.abs(n.cap) * 100)}%`;
      $('ui-hpfill').style.background = (owned && !n.guard) ? '#f0b45c' : (n.cap >= 0 ? '#7ec8ff' : '#e2594a');
      $('ui-dmg').textContent = nt.cash ? `+${nt.cash}/s` : `+${nt.parts}/s`;
      $('ui-rate').textContent = owned ? '持续产出' : '占领后才产出';
      $('ui-range').textContent = `${RULE.econ.radius} 格`;
      $('ui-speed').textContent = owned ? '已归属' : '中立';
      $('ui-armor').textContent = '—';
      uiLabels('状态', '产出', '范围', '归属', '护甲');
      $('ui-note').textContent = owned
        ? (n.guard
          ? `圈里有己方单位在守，产出正常；单位一撤走，占领度就按每秒掉，约 ${RULE.econ.holdGrace || 20} 秒掉光`
          : '圈里没有己方单位 —— 占领度正在掉，掉光就变回中立；随便派一个单位站进圈里就能稳住')
        : '派单位站在圈里 6 秒即可占领；占下后必须留人驻守，否则会掉光';
      return;
    }
  }
  // 据点面板
  if (run && app.selCore) {
    const lv = run.coreLevel || 1;
    const inc = incomeRate(run);
    el.classList.remove('hidden');
    $('ui-icon').src = 'assets/icons/core.png';
    $('ui-name').textContent = '指挥据点';
    $('ui-hp').textContent = `${Math.max(0, Math.ceil(run.core.hp))}/${run.core.maxHp}`;
    $('ui-hpfill').style.width = `${clamp((run.core.hp / run.core.maxHp) * 100, 0, 100).toFixed(1)}%`;
    $('ui-hpfill').style.background = run.core.hp / run.core.maxHp > 0.35 ? '#e8c15a' : '#e0603a';
    $('ui-dmg').textContent = `+${inc.cash.toFixed(1)}/s`;
    $('ui-rate').textContent = `+${inc.parts.toFixed(1)}/s`;
    $('ui-range').textContent = `Lv${lv} · ${popUsed(run)}/${popCap(run)}`;
    $('ui-speed').textContent = `${(run.nodes || []).filter((n) => n.owner === 1).length}/${(run.nodes || []).length}`;
    $('ui-armor').textContent = '—';
    uiLabels('资金', '零件', '等级·人口', '资源点', '护甲');
    {
      const room = run.core.room;
      const gtxt = room ? `楼内 ${garrisonUsed(run, room)}/${garrisonCap(room)}（步兵右键进驻，射程 ×1.15、受伤 -20%；左键点楼内小人可单独选中） · ` : '';
      $('ui-note').textContent = gtxt + '每清一波升 1 级（最高 Lv5），产出与资金上限随之提高';
    }
    paintSwapRow(run);

    return;
  }

  // ---- 叛军面板 ----
  if (raid && (app.state === STATE.PREP || app.state === STATE.BATTLE || app.state === STATE.RESULT)) {
    const rdef = UNITS[raid.kind] || {};
    el.classList.remove('hidden');
    $('ui-swap').classList.add('hidden');
    $('ui-icon').style.display = '';
    $('ui-icon').src = iconPath(rdef.icon || raid.kind);
    $('ui-name').textContent = `叛军 · ${rdef.name || raid.kind}`;
    const rhp = Math.max(0, Math.ceil(raid.hp));
    $('ui-hp').textContent = `${rhp}/${raid.maxHp}`;
    $('ui-hpfill').style.width = `${clamp((raid.hp / raid.maxHp) * 100, 0, 100).toFixed(1)}%`;
    $('ui-hpfill').style.background = raid.hp / raid.maxHp > 0.35 ? '#ff9f1c' : '#e0603a';
    $('ui-dmg').textContent = raid.splash
      ? `${Math.round(raid.dmg)} · 溅射${raid.splash.radius}`
      : `${Math.round(raid.dmg)}`;
    $('ui-rate').textContent = `${(1 / (raid.fireInterval || 1)).toFixed(2)} 次/秒`;
    {
      const tId = run.map.tiles[(raid.ty || 0) * run.map.w + (raid.tx || 0)];
      const rm = (TERRAIN[tId] && TERRAIN[tId].range) || 1;
      const base = raid.range || rdef.range || 100;
      $('ui-range').textContent = Math.abs(rm - 1) < 0.001
        ? `${Math.round(base)}`
        : `${Math.round(base)} → ${Math.round(base * rm)} (地形×${rm.toFixed(2)})`;
    }
    {
      const sp = raid.speed || 0;
      $('ui-speed').textContent = sp ? `${Math.round(sp)}` : '固定';
    }
    const rarm = raid.armor || 'none';
    $('ui-armor').textContent = `${ARMOR_LABEL[rarm] || rarm}（-${Math.round((ARMOR[rarm] || 0) * 100)}%）`;
    uiLabels('攻击力', '射速', '射程', '移动速度', '护甲');
    return;
  }

  // 单位信息已并入左下底栏（方案 A）；右侧浮动卡只留给僵尸 / 建筑 / 工事 / 资源点
  if (u) {
    el.classList.add('hidden');
    $('ui-swap').classList.add('hidden');
    // 选中我方单位时这里就直接返回了，而 syncStanceButtons() 原本挂在函数末尾
    // => 指令格的显隐（架设/换弹按能力隐藏）只有点过按钮才同步一次。
    // 底栏是靠手算宽度排版的，格子数量必须每次刷新都是准的，所以在这里补一次。
    syncStanceButtons();
    return;
  }
  // 走到这里说明僵尸 / 工事 / 资源点 / 据点 / 叛军都没命中（那些分支各自 return 了），
  // u 存在则在上面单位分支返回，所以这一句就是"什么都没选中"的兜底：隐藏右卡。
  if (!u || !(app.state === STATE.PREP || app.state === STATE.BATTLE || app.state === STATE.RESULT)) {
    el.classList.add('hidden');
    $('ui-swap').classList.add('hidden');
    return;
  }
  const def = UNITS[u.kind];
  el.classList.remove('hidden');
  $('ui-swap').classList.add('hidden');
  $('ui-icon').src = iconPath(def.icon || u.kind);
  $('ui-name').textContent = def.name || u.kind;
  const hp = Math.max(0, Math.ceil(u.hp));
  $('ui-hp').textContent = `${hp}/${u.maxHp}`;
  $('ui-hpfill').style.width = `${clamp((u.hp / u.maxHp) * 100, 0, 100).toFixed(1)}%`;
  $('ui-hpfill').style.background = u.hp / u.maxHp > 0.35 ? '#67d0ff' : '#e0603a';
  $('ui-dmg').textContent = def.zone
    ? `${def.zone.dps}/秒灼烧 · ${def.zone.r}px`
    : def.splash ? `${def.dmg} · 溅射${def.splash.radius}` : `${def.dmg}`;
  const trueGap = def.fireInterval * (def.splash ? RULE.combat.splashAttackMul : 1);
  {
    const sup = u.supMul || 1;
    const baseRate = 1 / trueGap;
    if (sup > 1 && (u.supT || 0) > 0) {
      const cut = Math.round((1 - 1 / sup) * 100);
      $('ui-rate').textContent = `${baseRate.toFixed(2)} → ${(baseRate / sup).toFixed(2)} 次/秒`
        + `（被缠绕 -${cut}%，${u.supT.toFixed(1)}s）`;
    } else {
      $('ui-rate').textContent = `${baseRate.toFixed(2)} 次/秒`;
    }
  }
  // 有效射程：基准×所在格形的 range 倍率；倍率不是 1 时同时标出基准值
  {
    // 必须用「脚下格」而不是 u.tx/u.ty：站定的单位 tx/ty 是上次下令的目标格，
    // 和实际站的位置不一定相同（拆单位、射程显示都踩过这个坑）
    const T2 = run.map.tile;
    const gx = Math.floor((u.x || 0) / T2), gy = Math.floor((u.y || 0) / T2);
    const tId = run.map.tiles[gy * run.map.w + gx];
    const rm = (TERRAIN[tId] && TERRAIN[tId].range) || 1;
    const gm = (u.inside && u.kind !== 'engineer') ? GARRISON.range : 1;
    const total = def.range * rm * gm;
    const minR = def.minRange ? Math.round(def.minRange) : 0;
    const lo = minR ? `${minR}~` : '';
    $('ui-range').textContent = `${lo}${Math.round(total)}`;
  }
  // 实时速度：与移动公式同源（地形 / 楼内 / 减速 / 眩晕）
  {
    const sp = unitSpeedNow(run, u);
    if (!sp) {
      $('ui-speed').textContent = '固定';
      $('ui-speed').title = '';
    } else {
      const mult = sp.base ? sp.now / sp.base : 1;
      if (Math.abs(mult - 1) < 0.001) {
        $('ui-speed').textContent = `${Math.round(sp.now)}`;
        $('ui-speed').title = '';
      } else {
        $('ui-speed').textContent = `${Math.round(sp.now)} ×${mult.toFixed(2)}`;
        $('ui-speed').title = `基准速度 ${Math.round(sp.base)} · ${sp.tags.join(' · ')}`;
      }
    }
  }
  const arm = def.armor || 'none';
  $('ui-armor').textContent = `${ARMOR_LABEL[arm]}（-${Math.round((ARMOR[arm] || 0) * 100)}%）`;
  uiLabels('攻击力', '射速', '射程', '移动速度', '护甲');
  const fmt1 = (v) => String(Number(v.toFixed(2)));
  const vsText = (d) => (d.vsArmor
    ? `克制 无甲 ${fmt1(d.vsArmor.none)} / 轻甲 ${fmt1(d.vsArmor.light)} / 重甲 ${fmt1(d.vsArmor.heavy)}`
    : '');
  if (def.heat) {
    const heat = Math.min(1, (u.heat || 0));
    const pct = Math.round(heat * 100);
    if (u.overheated) {
      $('ui-note').textContent = `过热！强制停火，冷却到 0 才会重新喷射（当前 ${pct}%）`;
    } else {
      $('ui-note').textContent = `热量 ${pct}%（连续喷射约 ${(1 / (def.heat.perShot * (1 / (def.fireInterval * (def.splash ? RULE.combat.splashAttackMul : 1)))))} 秒打满就过热）`;
    }
  } else {
    {
    $('ui-note').textContent = `姿态：${u.stance === 'hold' ? '停火' : u.stance === 'patrol' ? '巡逻（往返）' : '自由开火'}`;
  }
  }
  {
    const parts = [];
    if (def.mag) {
      const cur = u.ammo === undefined ? def.mag.size : u.ammo;
      parts.push(u.reloadT > 0
        ? `弹夹 换弹中 ${u.reloadT.toFixed(1)}s（${def.mag.size} 发）`
        : `弹夹 ${cur}/${def.mag.size}`);
    }
    if (def.heal) {
      parts.push(`治疗 ${def.heal.rate}/s（只治${u.inside ? '同一栋楼里' : '楼外'}的${def.heal.target}）`);
    }
    const vs = vsText(def);
    if (vs) parts.push(vs);
    // 对特感加成已移到帮助页（只有狙击手有，且是静态数值，不必常驻面板）
    if (parts.length) $('ui-note').textContent += ' · ' + parts.join(' · ');
    if (def.deploy) {
      const dd = def.deploy;
      const pc = (v, t) => Math.min(100, Math.round((v / t) * 100));
      const txt = u.depDir > 0 ? `架设中 ${pc(u.depT || 0, dd.setUpT)}%（读条完成后才开火）`
        : u.depDir < 0 ? `收起中 ${pc(u.depT || 0, dd.tearDownT)}%`
        : u.depOn ? `已架设：受伤 -${Math.round(dd.dr * 100)}% · 不可被拖拽（G 收起）`
        : '行军态：禁止开火（G 架设）';
      $('ui-note').textContent += ' · ' + txt;
    }
  }
  syncStanceButtons();
}

// ---------------- 新手引导 ----------------
const TUT_KEY = 'dcl.tut';
const TUT_STEPS = [
  '第 1 步：造兵。点左下角「步兵」，再点据点附近的空地放下；攒 2~3 个就够开局。',
  '第 2 步：调兵。拖框或 Ctrl+A 选中单位，右键点目标位置移动。',
  '第 3 步：封路。先造一个「工兵」，选中它后面板会变成建造列表，点「路障」再点路面横着堵住，僵尸就得绕进炮台射程。',
];
let tutIdx = 0;
let tutTimer = null;
const TUT_AUTO_MS = 10000;

function clearTutTimer() {
  if (tutTimer) { clearTimeout(tutTimer); tutTimer = null; }
}

function renderTut() {
  const box = $('tut');
  if (!box) return;
  const isLast = tutIdx >= TUT_STEPS.length - 1;
  $('tut-idx').textContent = isLast
    ? `${tutIdx + 1}/${TUT_STEPS.length} · 看完点「开始」`
    : `${tutIdx + 1}/${TUT_STEPS.length} · ${TUT_AUTO_MS / 1000} 秒后自动继续`;
  $('tut-text').textContent = TUT_STEPS[tutIdx];
  $('tut-next').textContent = isLast ? '开始' : '下一步';
  const bar = $('tut-bar');
  // 最后一步不再自动跳：只停在这里等玩家点「开始」。
  // 否则「自动走完 3 步 → closeTut(true) → 写 localStorage」会让教程从此再也不出现。
  if (isLast) {
    app._tutAt = 0;
    clearTutTimer();
    if (bar) bar.style.animation = 'none';
    return;
  }
  // 重启顶部进度条（5 秒走完）
  if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; }
  // 双保险：帧内时间戳判断 + setTimeout（前者不受后台节流影响）
  app._tutAt = Date.now() + TUT_AUTO_MS;
  clearTutTimer();
  tutTimer = setTimeout(advanceTut, TUT_AUTO_MS);
}

function advanceTut() {
  app._tutAt = 0;
  clearTutTimer();
  if (tutIdx >= TUT_STEPS.length - 1) {
    closeTut(true);
    toast('引导结束，祝守城顺利', 2200);
    return;
  }
  tutIdx += 1;
  renderTut();
  sfx.click();
}

function closeTut(done) {
  app._tutAt = 0;
  clearTutTimer();
  const box = $('tut');
  if (box) box.classList.add('hidden');
  if (done) localStorage.setItem(TUT_KEY, '1');
}

function startTutorial() {
  let done = false;
  try { done = localStorage.getItem(TUT_KEY) === '1'; } catch (e) { done = false; }
  const box = $('tut');
  if (!box || done) return;
  tutIdx = 0;
  renderTut();
  box.classList.remove('hidden');
}

$('tut-next').addEventListener('click', () => { sfx.click(); advanceTut(); });
$('tut-skip').addEventListener('click', () => { closeTut(true); sfx.click(); });

// ---------------- 编队 ----------------
function saveGroup(n) {
  if (!app.sel.size) { toast('先选中单位再存编队'); return; }
  groups.set(n, [...app.sel]);
  sfx.click();
  toast(`编队 ${n} 已记录（${app.sel.size} 个）`);
}

function recallGroup(n) {
  const ids = groups.get(n);
  if (!ids || !ids.length) { toast(`编队 ${n} 是空的`); return; }
  const run = app.run;
  if (!run) return;
  const alive = new Set(run.units.map((u) => u.id));
  const keep = ids.filter((id) => alive.has(id));
  if (!keep.length) { toast(`编队 ${n} 已全部阵亡`); return; }
  app.sel = new Set(keep);
  app.tool = { kind: 'select' };
  sfx.click();
  toast(`召回编队 ${n}（${keep.length} 个）`);
  app.groupFlash = { n, until: Date.now() + 1000 };
  refreshHud(true);
}

// 编队徽章点击 = 选中该编队（等价 Alt+数字）
{
  const gb = $('hud-groups');
  if (gb) {
    gb.addEventListener('click', (e) => {
      const el = e.target.closest('.gb');
      if (!el) return;
      const n = Number(el.dataset.n);
      if (n >= 1 && n <= 9) recallGroup(n);
    });
  }
}

// ---------------- 暂停 / 音效 ----------------
function seedText() {
  const kind = app.mapKind || 'city17';
  const label = MAP_LABEL[kind] || kind;
  const q = [`map=${kind}`, `seed=${app.seed}`];
  if (app.raider) q.push('raider=1');
  if (app.spec) q.push(`spec=${app.spec}`);
  return { label, kind, seed: app.seed, url: q.join('&') };
}

function fillSeedRow() {
  const t = seedText();
  const m = $('pause-map');
  const sd = $('pause-seed');
  if (m) m.textContent = t.label;
  if (sd) sd.textContent = String(t.seed);
}

function setPaused(on) {
  app.paused = !!on;
  document.body.classList.toggle('menu-pause', app.paused);
  $('pausemenu').classList.toggle('hidden', !app.paused);
  if (app.paused) { fillSeedRow(); sfx.click(); }
  syncMenuOpen();
}

// 暂停/结算任一打开时，给 body 挂 menu-open，用来淡出主界面立绘（.hud-art）
function syncMenuOpen() {
  const open = app.state === STATE.RESULT || !!app.paused;
  document.body.classList.toggle('menu-open', open);
}

function togglePause() {
  if (app.state !== STATE.PREP && app.state !== STATE.BATTLE) return;
  setPaused(!app.paused);
}

function setMuted(on) {
  app.muted = !!on;
  sfx.setEnabled(!app.muted);
  const img = $('ico-sound');
  if (img) img.src = app.muted ? 'assets/icons/sound-off.png' : 'assets/icons/sound-on.png';
  $('btn-sound').classList.toggle('off', app.muted);
}

function setAggro(n) {
  app.aggro = Math.max(0, Math.min(2, n | 0));
  const b = $('btn-aggro');
  if (b) {
    b.textContent = '仇恨·' + ['关', '轻', '全'][app.aggro];
    b.classList.toggle('on', app.aggro > 0);
  }
  try { localStorage.setItem('dcl.aggro', String(app.aggro)); } catch (e) {}
  if (app.run) app.run.aggro = app.aggro;
}

// 特感生成方案：关闭 / 轻度 / 标准 / 狂暴
// 老城有 5 个出口（最近 22 格），狂暴档实测无解，所以这张图最高只到「标准」。
const MAP_MAX_SPEC = { oldtown: 1 };
function specCapFor(kind) {
  const cap = MAP_MAX_SPEC[kind];
  return cap != null ? cap : SPEC_SCHEMES.length - 1;
}
function refreshSpecLocks() {
  const cap = specCapFor(app.mapKind);
  for (const b2 of document.querySelectorAll('.mapbtn[data-spec]')) {
    const n = Number(b2.dataset.spec);
    const locked = n > cap;
    b2.classList.toggle('locked', locked);
    b2.disabled = locked;
    b2.title = locked ? `${MAP_LABEL[app.mapKind] || '这张图'}不支持该特感档` : '';
  }
}
function setSpec(n) {
  const cap = specCapFor(app.mapKind);
  app.spec = Math.max(0, Math.min(cap, n | 0));
  refreshSpecLocks();
  const b = $('btn-spec');
  if (b) {
    const sc = SPEC_SCHEMES[app.spec];
    b.textContent = '特感·' + sc.label;
    b.title = specHint(app.spec);
    b.classList.toggle('on', app.spec > 0);
  }
  try { localStorage.setItem('dcl.spec', String(app.spec)); } catch (e) {}
  if (app.run) app.run.spec = app.spec;
  for (const b2 of document.querySelectorAll('.mapbtn[data-spec]')) {
    b2.classList.toggle('active', Number(b2.dataset.spec) === app.spec);
  }
  const d = $('spec-desc');
  if (d) d.textContent = specHint(app.spec);
  syncPlayNote();
}

// 叛军（第三方）：默认关；标题页「叛军」行切换，或用 ?raider=1 强制开
function setRaider(on) {
  app.raider = !!on;
  document.querySelectorAll('.mapbtn[data-raider]').forEach((b) => {
    b.classList.toggle('active', (b.dataset.raider === '1') === app.raider);
  });
  try { localStorage.setItem('dcl.raider', app.raider ? '1' : '0'); } catch (e) {}
  if (app.run) app.run.raiderOn = app.raider;
  syncPlayNote();
}

// 无尽模式：默认「标准」；标题页「模式」行切换
function setMode(mode) {
  app.mode = mode === 'endless' ? 'endless' : 'normal';
  document.querySelectorAll('.mapbtn[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === app.mode);
  });
  const d = $('mode-desc');
  if (d) {
    d.textContent = app.mode === 'endless'
      ? '波次无上限：8 波后每波 +6%，每 5 波一个 Boss 波；每 3 波核心回 6% 血、每 5 波补一笔资金。没有胜利，只有坚持到第几波'
      : '8 波定局：守住第 8 波清空即胜利';
  }
  try { localStorage.setItem('dcl.mode', app.mode); } catch (e) {}
  syncPlayNote();
}

function setDecal(on) {
  app.decal = !!on;
  const b = $('btn-decal');
  if (b) {
    b.classList.toggle('on', app.decal);
    b.textContent = '痕迹·' + (app.decal ? '开' : '关');
  }
  try { localStorage.setItem('dcl.decal', app.decal ? '1' : '0'); } catch (e) {}
}

function setZbar(on) {
  app.zbar = !!on;
  const b = $('btn-zbar');
  if (b) b.classList.toggle('on', app.zbar);
  try { localStorage.setItem('dcl.zbar', app.zbar ? '1' : '0'); } catch (e) {}
}

function setShowPath(on) {
  app.showPath = !!on;
  const b = $('btn-path');
  if (b) b.classList.toggle('on', app.showPath);
  try { localStorage.setItem('dcl.path', app.showPath ? '1' : '0'); } catch (e) {}
}

// 战斗中的右侧立绘：默认关，开关存 localStorage
function setHudArt(on) {
  app.hudArt = !!on;
  const el = $('hud-art');
  if (el) el.classList.toggle('show', app.hudArt);
  const b = $('btn-hudart');
  if (b) b.classList.toggle('on', app.hudArt);
  try { localStorage.setItem('dcl.hudart', app.hudArt ? '1' : '0'); } catch (e) {}
}

// 暴击开关：默认开（关掉时完全走原伤害口径，老平衡不受影响）
function setCrit(on) {
  app.critOn = !!on;
  const b = $('btn-crit');
  if (b) {
    b.classList.toggle('on', app.critOn);
    b.textContent = '暴击·' + (app.critOn ? '开' : '关');
  }
  try { localStorage.setItem('dcl.crit', app.critOn ? '1' : '0'); } catch (e) {}
}

// 行尸个体差异开关：默认开（关掉时所有行尸回到 40 血、15 伤害、1.0s 攻速）
function setZVary(on) {
  app.zVaryOn = on !== false;
  const b = $('btn-zvary');
  if (b) {
    b.classList.toggle('on', app.zVaryOn);
    b.textContent = '变异·' + (app.zVaryOn ? '开' : '关');
  }
  try { localStorage.setItem('dcl.zvary', app.zVaryOn ? '1' : '0'); } catch (e) {}
}

// 鼠标贴边移动视角开关：默认开
function setEdgeScroll(on) {
  app.edgeScroll = !!on;
  const b = $('btn-edge');
  if (b) {
    b.classList.toggle('on', app.edgeScroll);
    b.textContent = '贴边·' + (app.edgeScroll ? '开' : '关');
  }
  try { localStorage.setItem('dcl.edge', app.edgeScroll ? '1' : '0'); } catch (e) {}
}

// 友军伤害开关：默认开（关掉后范围伤害只打僵尸）
function setFf(on, silent) {
  app.ffOn = !!on;
  const b = $('btn-ff');
  if (b) {
    b.classList.toggle('on', app.ffOn);
    b.textContent = '友伤·' + (app.ffOn ? '开' : '关');
  }
  if (app.run) app.run.ffOn = app.ffOn;
  try { localStorage.setItem('dcl.ff', app.ffOn ? '1' : '0'); } catch (e) {}
  if (!silent) toast(app.ffOn ? '友军伤害：开（单位 20% / 炮台 10% / 工事 5%）' : '友军伤害：关');
}

function setDamageNum(on) {
  app.damageNum = !!on;
  const b = $('btn-dmg');
  if (b) b.classList.toggle('on', app.damageNum);
  try { localStorage.setItem('dcl.dmg', app.damageNum ? '1' : '0'); } catch (e) {}
}

// ---------------- 开局 / 结束 ----------------
function startGame(opts = {}) {
  if (!app.seed || opts.newSeed) app.seed = opts.seed || Math.floor(Math.random() * 1e6) || 7;
  const map = cloneMap(app.map);
  const run = createRun(map, {
    raider: app.raider,
    seed: app.seed,
    god: app.god,
    waves: app.mode === 'endless' ? 999 : app.cfg.total,
    endless: app.mode === 'endless',
    aggro: app.aggro,
    spec: app.spec,
    waveCfg: {
      base: app.cfg.base, grow: app.cfg.grow, final: app.cfg.final,
      mul: map.meta && map.meta.waveMul,   // 地图级波次系数（forest / oldtown），漏了它这两张图的难度就不生效
      endless: app.mode === 'endless',
    },
    crit: app.critOn === true,
    zVary: app.zVaryOn !== false,
  });
  run.debug = app.debug;
  run.ffOn = app.ffOn !== false;
  resetSkills(run);      // 开局技能一律就绪：不带着上一局/默认值的冷却进场
  app.run = run;
  app.acc = 0;
  app.sel.clear();
  app.markers = [];
  app.lastCoreHp = run.core.hp;
  app._upkeepWarned = false;   // 每局重新提示一次「入不敷出」
  app._boomHint = false;       // 每局重新提示一次载具自爆
  app._heroSeen = false;       // 每局重新播一次「待命」（否则第二局起哑火）
  if (sfx.resetVoice) sfx.resetVoice();   // 语音冷却/抢占状态不跨局
  // 开局视角对准据点
  centerCamOn(map.core.x * map.tile + map.tile / 2, map.core.y * map.tile + map.tile / 2);
  setPaused(false);
  setState(STATE.PREP);
  if (opts.pause) setPaused(true);   // 调试：?pause=1 直接停在暂停面板

  if (opts.auto) autoBuild(run);

  if (opts.wave && opts.wave > 1) {
    run.phase = PHASE.BATTLE;
    run.prepTimer = 0;
    run.waveIndex = Math.min(opts.wave, run.totalWaves);
    run.wave = createWave(run, run.waveIndex);
    run.waveTimer = 0;
    setState(STATE.BATTLE);
  }
  openSource('core');
  refreshHud(true);
}

function restart() {
  const seed = app.seed;
  startGame({ seed });
  toast('已重开本局');
}

// 结算立绘：三个阶段用不同构图（素材三张轮换，靠 CSS 状态类做色调与位置）
function setResultArt(won) {
  const box = $('result');
  if (!box) return;
  const L = box.querySelector('.side-art.left');
  const R = box.querySelector('.side-art.right');
  // 胜利沿用待命那张（两人并肩是“守住了”）；失败换一张——金发那张是跪姿特写，
  // 压暗去饱和后只剩轮廓，正好读作“就剩她一个还跪在这里”。
  if (L) {
    L.onerror = null;
    if (won) {
      L.src = 'assets/portraits/art-left.png';
    } else {
      // WebP 只有 PNG 的 1/7，老浏览器不支持时回落原图
      L.onerror = () => { L.onerror = null; L.src = 'assets/portraits/art-lose.png'; };
      L.src = 'assets/portraits/art-lose.webp';
    }
  }
  if (R) R.src = 'assets/portraits/art-right.png';
  document.body.classList.toggle('menu-win', !!won);
  document.body.classList.toggle('menu-lose', !won);
}

function finish() {
  const run = app.run;
  if (!run) return;
  const won = run.phase === PHASE.WON;
  setResultArt(won);
  $('res-title').textContent = won ? '据点守住了' : '据点失守';
  $('res-title').style.color = won ? '#e0b341' : '#e0603a';
  $('res-sub').textContent = won
    ? `第 ${run.stats.wavesCleared} / ${run.totalWaves} 波全部清空 · 种子 ${run.seed}`
    : (run.endless
      ? `击杀 ${s.kills} 只 · 占点 ${(run.nodes || []).filter((n) => n.owner === 1).length}/${(RULE.endlessGoal || {}).nodes || 4} · 第 ${Math.max(1, run.waveIndex)} 波 · 种子 ${run.seed}`
      : `坚持到第 ${run.waveIndex} / ${run.totalWaves} 波 · 种子 ${run.seed}`);
  const s = run.stats;
  const mm = Math.floor(run.time / 60), ss = Math.floor(run.time % 60);
  $('res-stats').innerHTML = [
    ['击杀', s.kills],
    ['出怪', s.spawned],
    ['用时', `${mm}:${String(ss).padStart(2, '0')}`],
    ['工事损失', s.fortLost],
    ['拆毁建筑', s.buildingDown],
    ['补给消耗', s.spent],
    ...(s.friendlyDamage > 0.5 ? [['友军伤害', Math.round(s.friendlyDamage) + (s.friendlyKills ? `（误杀 ${s.friendlyKills}）` : '')]] : []),
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  setState(STATE.RESULT);
  app.run = run;
  if (won) sfx.win(); else sfx.lose();
}

// ---------------- 事件 → 音效 ----------------
// 每帧把相机中心与半宽交给音效（距离衷减 + 左右声像）
function syncSfxView() {
  const cv = $('cv');
  if (!cv) return;
  const z = app.zoom || 1;
  const halfW = cv.width / z / 2;
  sfx.setView({
    cx: app.cam.x + halfW,
    cy: app.cam.y + cv.height / z / 2,
    halfW,
    camX: app.cam.x,
    camY: app.cam.y,
    zoom: z,
    w: cv.width / z,
    h: cv.height / z,
  });
}

// 左侧分栏：基地 / 资源点 / 本局累计（每 0.25s 刷新）
let incomeCardEl = null, incomeCardT = 0;
function paintIncomeCard(run) {
  if (!incomeCardEl) {
    const el = document.createElement('div');
    el.id = 'income-card';
    el.style.cssText = [
      'position:absolute', 'left:12px', 'top:70px', 'z-index:12', 'display:none',
      'padding:8px 10px', 'border-radius:10px', 'font:12px/1.55 system-ui,sans-serif',
      'background:rgba(11,16,23,0.94)', 'border:1px solid rgba(120,170,220,0.30)', 'backdrop-filter:blur(6px)', 'box-shadow:0 8px 22px rgba(0,0,0,.45)',
      'color:#cfe3f6', 'pointer-events:none', 'min-width:168px',
    ].join(';');
    // 必须挂在 #app 里：画面是按 1.6 比例居中缩放的，fixed 会让面板飘到画面外的黑边上
    ($('app') || document.body).appendChild(el);
    incomeCardEl = el;
  }
  const el = incomeCardEl;
  if (!run || (app.state !== 'prep' && app.state !== 'battle' && app.state !== 'result')) {
    el.style.display = 'none';
    return;
  }
  const r = incomeRate(run);
  const tot = run.earn || { base: 0, node: 0 };
  const zero = r.nodesActive === 0;
  const broke = r.netCash < -0.05;
  if (broke && !app._upkeepWarned && app.state !== STATE.RESULT) {
    app._upkeepWarned = true;
    toast(`入不敷出：维护 -${r.upkeep.toFixed(1)}/s 已超过收入，撤掉部分炮台或去占资源点`);
  }
  el.style.display = 'block';
  const netTxt = (r.netCash >= 0 ? '+' : '') + r.netCash.toFixed(1);
  el.innerHTML =
    `<div class="inc-head${broke ? ' broke' : ''}">` +
      `<span style="color:#8fa9c2;letter-spacing:.06em">经济</span> ` +
      `<b>${netTxt}</b><span style="color:#7d93a8">/s</span>` +
      `<span style="color:#6c7d8e;font-size:11px"> · 本局 ${Math.floor(tot.base + tot.node)}</span>` +
    `</div>` +
    `<div class="inc-rows">` +
    `<div style="color:#8fa9c2;letter-spacing:.06em;margin:2px 0">明细</div>` +
    `<div><span style="color:#9fb6cc">基地</span> <b style="color:#e8c15a">+${r.baseCash.toFixed(1)}</b><span style="color:#7d93a8">/s</span></div>` +
    `<div><span style="color:${zero ? '#6c7d8e' : '#9fb6cc'}">资源点</span> <b style="color:${zero ? '#6c7d8e' : '#7ec8ff'}">+${r.nodeCash.toFixed(1)}</b><span style="color:#7d93a8">/s</span>` +
    `<span style="color:${zero ? '#6c7d8e' : '#5f9ec7'}"> (${r.nodesActive}/${run.nodes.length} 在产)</span></div>` +
    (r.nodeMul > 1.001 ? `<div style="color:#89a;font-size:11px">点位 ×${r.nodeMul.toFixed(2)}（核心 Lv${run.coreLevel}）</div>` : '') +
    `<div><span style="color:${broke ? '#e0776f' : '#9fb6cc'}">${broke ? '⚠ 维护' : '维护'}</span> <b style="color:#e0776f">-${r.upkeep.toFixed(1)}</b><span style="color:#7d93a8">/s</span>` +
    `<span style="color:#6c7d8e;font-size:11px"> (人口 ${r.upkeepPop}×${(r.upkeepEach || 0).toFixed(2)}=${r.upkeepPopCost.toFixed(1)} / 炮台 ${r.upkeepTowers}×0.15=${r.upkeepTowerCost.toFixed(1)}` +
    `${(r.upkeepUnitFee || 0) > 0 ? ` / 单位 ${r.upkeepUnitFee.toFixed(1)}` : ''})</span></div>` +
    `<div style="margin-top:2px"><span style="color:#9fb6cc">净收入</span> <b style="color:${r.netCash >= 0 ? '#7ee0a0' : '#e0776f'}">${r.netCash >= 0 ? '+' : ''}${r.netCash.toFixed(1)}</b><span style="color:#7d93a8">/s</span></div>` +
    `<div style="color:#7d93a8;font-size:11px;margin-top:2px">本局累计 基地 ${Math.floor(tot.base)} · 资源点 ${Math.floor(tot.node)}</div>` +
    `<div style="height:1px;background:rgba(120,170,220,.18);margin:6px 0 4px"></div>` +
    `<div style="color:#8fa9c2;letter-spacing:.06em">零件 <b style="color:#7ec8ff">+${r.parts.toFixed(2)}</b><span style="color:#7d93a8">/s</span></div>` +
    `<div style="font-size:11px"><span style="color:#9fb6cc">基地</span> <b style="color:#7ec8ff">+${r.baseParts.toFixed(2)}</b>` +
    `<span style="color:#7d93a8"> / </span><span style="color:${zero ? '#6c7d8e' : '#9fb6cc'}">资源点</span> <b style="color:${zero ? '#6c7d8e' : '#7ec8ff'}">+${r.nodeParts.toFixed(2)}</b>` +
    `<span style="color:${zero ? '#6c7d8e' : '#5f9ec7'}"> (${r.nodesActive}/${run.nodes.length} 在产)</span></div>` +
    `<div style="color:#7d93a8;font-size:11px;margin-top:2px">拥有资源点 ${r.nodesOwned}/${run.nodes.length} · 核心 Lv${run.coreLevel || 1}</div>` +
    `</div>`;
}

// 顶栏「资金 / 零件」胶囊 hover 时展开左上角的经济明细卡（默认收着，不占画面）
const INCOME_HOVER = '#res-supply, #res-parts, #hud-net, #topbar .stat';
let incomeHideT = 0;
function incomeHoverOn(e) {
  if (!incomeCardEl || !e.target || !e.target.closest) return false;
  return !!e.target.closest(INCOME_HOVER);
}
document.addEventListener('mouseover', (e) => {
  if (!incomeHoverOn(e)) return;
  clearTimeout(incomeHideT);
  incomeCardEl.classList.add('show');
});
document.addEventListener('mouseout', (e) => {
  if (!incomeHoverOn(e)) return;
  // 延迟收起：鼠标从胶囊移到卡片上时不要立刻闪掉
  clearTimeout(incomeHideT);
  incomeHideT = setTimeout(() => {
    if (incomeCardEl) incomeCardEl.classList.remove('show');
  }, 160);
});

// 底栏标题区 hover 时展开「详情卡」：敌方单位 / 空地的完整说明默认收着，
// 只在鼠标放到左下标题区（或已经展开的卡片本身）上时才浮出来。
const unitInfoEl = $('unitinfo');
document.addEventListener('mouseover', (e) => {
  if (!unitInfoEl || !e.target || !e.target.closest) return;
  if (e.target.closest('.src-tag') || e.target.closest('#unitinfo')) unitInfoEl.classList.add('show');
});
document.addEventListener('mouseout', (e) => {
  if (!unitInfoEl || !e.target || !e.target.closest) return;
  if (!e.target.closest('.src-tag') && !e.target.closest('#unitinfo')) return;
  // 从标题移到卡片（或反过来）时不要收，否则会闪
  const to = e.relatedTarget;
  if (to && to.closest && (to.closest('.src-tag') || to.closest('#unitinfo'))) return;
  unitInfoEl.classList.remove('show');
});

// 无尽里程碑：屏幕中上方飘一行金字，2.6s 自己消失
function pushMilestone(kills, parts) {
  const box = $('mstone');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'ms';
  el.innerHTML = `累计击杀 ${kills}<small>+${parts} 零件</small>`;
  box.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2700);
  // 最多同时留 3 条，防止极端情况堆满屏幕
  while (box.children.length > 3) box.removeChild(box.firstChild);
}

function drainEvents(run) {
  if (!run.events || !run.events.length) return;
  for (const ev of run.events) {
    if (ev.t === 'shot') sfx.shot(ev.k, ev.x, ev.y);
    else if (ev.t === 'melee') sfx.melee(ev.x, ev.y, ev.n);
    else if (ev.t === 'crush') sfx.crush(ev.x, ev.y, ev.power);
    else if (ev.t === 'hook') {
      sfx.thud(ev.x, ev.y);
      app.shake = Math.max(app.shake, ev.mode === 'dash' ? 3.4 : 2.2);
    }
    else if (ev.t === 'deploy') sfx.deploy(ev.on !== false, ev.x, ev.y);
    else if (ev.t === 'zdie') sfx.zdie(ev.x, ev.y, ev.mob);
    else if (ev.t === 'fort') {
      sfx.fort(ev.x, ev.y);
      app.shake = Math.max(app.shake, 4);
      app.markers.push({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, kind: 'break' });
      const nm = (ev.kind && FORTS[ev.kind] && FORTS[ev.kind].name) || '建筑';
      pushLog(`${nm}被摧毁`, 'bad');
      // 被拆掉的正好是当前生产源：立刻回落到据点，避免底栏悬空
      if (ev.id && app.srcId === ev.id) {
        app.srcId = 'core';
        refreshProdPanel();
        toast(`${nm}被摧毁，生产源切回据点`);
      }
    }
    else if (ev.t === 'uhit') sfx.click();
    else if (ev.t === 'rankup') {
      const nm = (UNITS[ev.kind] && UNITS[ev.kind].name) || '单位';
      const rkName = ev.rank >= 2 ? '精英' : '老兵';
      const isHero = !!(UNITS[ev.kind] && UNITS[ev.kind].hero);
      if (sfx.rankup) sfx.rankup(isHero);
      pushLog(`${nm} 晋升 ${rkName}`, 'good');
      // 只对当前选中的那个单位弹 toast，免得一局刷屏
      if (app.sel && app.sel.has(ev.id)) toast(`${nm} 晋升${rkName}：伤害与血量都涨了`);
    }
    else if (ev.t === 'herodown') {
      const wait = Math.round(ev.wait || 90);
      if (sfx.heroDown) sfx.heroDown();
      if (sfx.voice) sfx.voice('scream');
      pushLog(`指挥官重伤 · ${wait}s 后归队（经验 -${ev.loss != null ? ev.loss : 15}）`, 'warn');
      toast(`指挥官重伤！${wait} 秒后在据点归队`, 3200);
      // 人已经离开地图，选中要一起撤掉，否则底栏会继续显示这个已不在场的单位
      if (ev.id != null && app.sel && app.sel.has(ev.id)) {
        app.sel.delete(ev.id);
        if (app.srcId === ev.id) app.srcId = '';
        clearPick();
        syncBarTitle();
      }
    }
    else if (ev.t === 'heroback') {
      const rkName = ev.rank >= 2 ? '精英' : ev.rank >= 1 ? '老兵' : '新兵';
      pushLog(`指挥官准备就绪（${rkName}）`, 'good');
      toast(`指挥官归队（${rkName}）`);
      if (sfx.heroBack) sfx.heroBack();
      if (sfx.voice) sfx.voice('ready');
    }
    else if (ev.t === 'raid') {
      toast(`敌人分兵来抢你的资源点了（${ev.n} 只），守住别让它们断补给`);
      pushLog(`敌方分兵抢点 · ${ev.n} 只`, 'warn');
    }
    else if (ev.t === 'heroskill') {
      // 手雷/战吼/肾上腺素各有音色；钩爪的绳索与落地由 hook()/thud() 负责
      if (sfx.heroSkill) sfx.heroSkill(ev.id, ev.x, ev.y);
      if (sfx.voice && ev.id === 'grenade') sfx.voice('roger', ev.x, ev.y);
    }
    else if (ev.t === 'boom') {
      sfx.boom(ev.x, ev.y, ev.r, ev.tag);
      app.shake = Math.max(app.shake, 6);
      // 只有玩家载具殉爆（tag='vboom'）才进战报；僵尸/建筑/工事爆炸只出音效与震屏
      if (ev.tag === 'vboom') {
        pushLog('我方载具殉爆', 'warn');
        if (!app._boomHint) {
          app._boomHint = true;
          toast('载具阵亡会殉爆：别把残血装甲车/坦克堆在自己人旁边');
        }
      }
    }
    else if (ev.t === 'buildwait') {
      if (logThr('buildwait', 2500)) {
        toast('建造停滞：目标格被占，等它空出来', 2600);
        pushLog('建造停滞：目标格被占', 'warn');
      }
    }
    else if (ev.t === 'nopath') {
      if (logThr('nopath', 8000)) {
        const nm = (ev.kind && UNITS[ev.kind] && UNITS[ev.kind].name) || '载具';
        pushLog(`${nm}无路可走：检查路障是否把出口封死了`, 'warn');
      }
    }
    else if (ev.t === 'skill') {
      if (ev.id === 'airdrop') { sfx.drop(ev.x, ev.y); toast('空降兵已抵达'); pushLog('空降兵抵达', 'good'); }
      else {
        sfx.click();
        const sname = ev.id === 'strike' ? '炮击' : '燃烧弹';
        toast(ev.id === 'strike' ? '炮击已喊到，落弹中…' : '燃烧弹已投下');
        pushLog(`${sname}落地`, 'good');
      }
    }
    else if (ev.t === 'alarm') {
      // 叛军装甲车狂暴预警：声音 + 轻微震屏，给玩家 0.7s 反应时间
      sfx.alarm(ev.x, ev.y);
      app.shake = Math.max(app.shake, 3);
    }
    else if (ev.t === 'boss') {
      sfx.boss(ev.x, ev.y);
      app.shake = Math.max(app.shake, 10);
      toast(`巨兽出现！集中火力打它`);
      pushLog('巨兽出现', 'bad');
    }
    else if (ev.t === 'ukill') {
      sfx.fort(ev.x, ev.y);
      app.shake = Math.max(app.shake, 3);
      app.markers.push({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, kind: 'break' });
      const deadDef = ev.kind && UNITS[ev.kind];
      if (deadDef) {
        pushLog(`${deadDef.name}阵亡`, 'bad');
        sfx.unitDie(VOICE_GROUP[ev.kind]);
      }
    }
    else if (ev.t === 'perk') {
      const pk = PERKS.find((x) => x.id === ev.id);
      if (pk) {
        if (ev.auto) {
          toast('超时未选，已自动选择：' + pk.name, 2600);
          pushLog('核心升级 · ' + pk.name + '（超时自动选择）', 'warn');
        } else {
          toast('已获得：' + pk.name, 2200);
          pushLog('核心升级 · ' + pk.name + '（' + pk.desc + '）', 'good');
        }
      }
    }
    else if (ev.t === 'riseup') {
      // 起身变行尸：同帧可能连起好几只，1.5s 内按来源各自合并成一条
      const raider = ev.side === 'raider';
      if (logThr('riseup:' + (raider ? 'r' : 'u'), 1500)) {
        pushLog(raider ? '叛军残兵变为行尸' : '我方阵亡单位变为行尸', 'warn');
      }
    }
    else if (ev.t === 'milestone') {
      pushLog(`累计击杀 ${ev.n} · +${ev.parts} 零件`, 'good');
      pushMilestone(ev.n, ev.parts);
      sfx.wave(run.waveIndex || 1);
    }
    else if (ev.t === 'wave') {
      sfx.wave(ev.n);
      const total = run.totalWaves || RULE.wave.total;
      const lateN = RULE.wave.lateWaves || 0;
      if (lateN > 0 && ev.n === total - lateN + 1) {
        // 末段波次的第一波：提前警告，告诉玩家后面是硬仗
        toast(`尸潮主力压境 · 最后 ${lateN} 波，守住据点！`, 2600);
        pushLog(`最后的 ${lateN} 波开打`, 'bad');
      } else if (ev.n === total) {
        toast(`最终波 · 全力防守！`, 2200);
        pushLog('最终波 · 全力防守', 'bad');
      } else if (ev.n === 1) {
        toast(`第 ${ev.n} 波开始 · 战斗中也能补建（1~7）`);
        pushLog('第 1 波开始', '');
      } else {
        toast(`第 ${ev.n} 波开始`);
        pushLog(`第 ${ev.n} 波开始`, '');
      }
    }
    else if (ev.t === 'clear') {
      sfx.clear();
      const late = (ev.n || 0) >= (RULE.econ.lateWaveNoClear || 99);
      toast(`第 ${ev.n} 波清空${late ? ' · 后勤见底，本波不发资金' : ' · 补给 +30'}`, 2400);
      pushLog(`第 ${ev.n} 波清空${late ? '（不发补给）' : ' · 补给 +30'}`, 'good');
    }
    else if (ev.t === 'node') {
      if (ev.own === 0) {
        sfx.deny();
        toast('资源点失守了 · 派单位回圈里守住', 2400);
        pushLog('资源点失守', 'bad');
        app.nodeFlash = { x: ev.x, y: ev.y, until: Date.now() + 3000 };
      } else if (ev.own === 2) {
        sfx.deny();
        toast('资源点被叛军抢走了', 2400);
        pushLog('资源点被叛军抢走', 'bad');
        app.nodeFlash = { x: ev.x, y: ev.y, until: Date.now() + 3000 };
      } else if (ev.own === 1) {
        pushLog('占领一处资源点', 'good');
        app.nodeFlash = { x: ev.x, y: ev.y, until: Date.now() + 2000 };
      }
    }
    else if (ev.t === 'move') app.markers.push({ x: ev.x, y: ev.y, life: 0.7, max: 0.7 });
    else if (ev.t === 'timeout') {
      toast(`第 ${ev.n} 波时间到，残敌 ${ev.left} 只留在场上（下一波继续）`, 2400);
      pushLog(`第 ${ev.n} 波超时 · 残留 ${ev.left} 只`, 'warn');
    }
    else if (ev.t === 'raid') toast(`抢点队 ${ev.n} 只 直奔资源点，分人去守`, 2200);
    else if (ev.t === 'suppress') {
      if (!app._supWarned) {
        app._supWarned = true;
        toast('烟雾者缠住了你的机枪组：射速 -38%，3.5 秒内别指望它压住这一波', 3000);
      }
    }
    else if (ev.t === 'win') sfx.win();
    else if (ev.t === 'lose') sfx.lose();
  }
  run.events.length = 0;
}

// ---------------- 主循环 ----------------
function loop(t) {
  const now = t || 0;
  const dt = app.last ? Math.min(0.12, (now - app.last) / 1000) : 0;
  app.last = now;

  updateCamera(dt);
  syncSfxView();
  const run = app.run;
  if (run && !app.paused && (app.state === STATE.PREP || app.state === STATE.BATTLE)) {
    app.acc += dt * app.speed;
    let steps = 0;
    while (app.acc >= RULE.perf.stepDt && steps < 10) {
      // 只有本帧的第一步才快照起点：一帧跑多步时插值区间覆盖整帧，画面时间点才稳
      stepRun(run, RULE.perf.stepDt, steps === 0);
      app.acc -= RULE.perf.stepDt;
      steps++;
      if (run.phase === PHASE.WON || run.phase === PHASE.LOST) break;
    }
    // 渲染插值系数：acc 是还没消耗掉的逻辑时间，占一逻辑帧的比例即插值进度。
    // 暂停时不会进入这段，alpha 自然冻结在暂停那一刻的中间态，不会跳到未来位置。
    app.alpha = Math.max(0, Math.min(1, app.acc / RULE.perf.stepDt));
    drainEvents(run);
    if (run.core.hp < app.lastCoreHp) {
      sfx.coreHit();
      app.shake = Math.max(app.shake, 3);
    }
    app.lastCoreHp = run.core.hp;
    pruneSelection();
    if (run.phase === PHASE.WON || run.phase === PHASE.LOST) finish();
    else if (run.phase === PHASE.PREP && app.state !== STATE.PREP) { app.tool = { kind: 'unit', id: 'infantry' }; setState(STATE.PREP); }
    else if (run.phase === PHASE.BATTLE && app.state !== STATE.BATTLE) setState(STATE.BATTLE);
  }

  if (run && !app.paused && (app.state === STATE.PREP || app.state === STATE.BATTLE)) syncAmbient(run, dt);
  else if (sfx.loops && sfx.loops.size) sfx.stopAllLoops();

  for (let i = app.markers.length - 1; i >= 0; i--) {
    app.markers[i].life -= dt;
    if (app.markers[i].life <= 0) app.markers.splice(i, 1);
  }

  render();
  app.hudT += dt;
  if (app.hudT > 0.08) { app.hudT = 0; refreshHud(); refreshUnitInfo(); }
  requestAnimationFrame(loop);
}

// 环境音：载具引擎/履带常驻循环 + 步兵脚步。
// 载具只有真的在挪（或刚开火震了一下）才响引擎；停下就静音，省声部也更真实。
const AMB_VEH = { vehicle: ['engine'], tank: ['engine', 'track'], howitzer: ['engine', 'track'] };
function syncAmbient(run, dt) {
  app.ambT = (app.ambT || 0) + dt;
  if (app.ambT < 0.1) return;
  app.ambT = 0;
  const list = [];
  for (const u of run.units) {
    const def = UNITS[u.kind];
    if (!def) continue;
    const kinds = AMB_VEH[u.kind];
    if (kinds) {
      const moving = !!u.moving || !!u.path;
      if (!moving) continue;
      for (const k of kinds) {
        list.push({ id: u.id + ':' + k, kind: k, x: u.x, y: u.y, gain: k === 'track' ? 0.13 : 0.20 });
      }
      continue;
    }
    if (def.mobile === false) continue;
    if (def.type === '载具') continue;
    if (!(u.moving || u.path)) continue;
    // 脚步：0.58s 基础节奏，再按 id 加 ±0.06s 相位 —— 多人同行不至于踩成节拍器
    const gap = 0.68 + ((u.id * 37) % 100) / 100 * 0.14;
    if (run.time - (u._stepSndAt || 0) > gap) {
      u._stepSndAt = run.time;
      sfx.step(u.x, u.y);
    }
  }
  sfx.setAmbient(list);
}

function render() {
  const run = app.run && (app.state === STATE.PREP || app.state === STATE.BATTLE || app.state === STATE.RESULT)
    ? app.run
    : app.preview;
  if (!run) return;

  const view = { debug: app.debug, hover: null, selected: app.sel, selRaid: app.selRaid, markers: app.markers, box: app.box, patrolFrom: app.patrolFrom, alpha: app.alpha };
  if (app.hover && app.state === STATE.PREP && app.tool.kind !== 'select') {
    const { tx, ty } = app.hover;
    let ok = true, range = 0, minRange = 0;
    if (app.state === STATE.PREP) {
      if (app.tool.kind === 'demolish' || app.tool.kind === 'patrol') ok = true;
      else {
        ok = canPlaceAt(app.run, app.tool.kind, app.tool.id, tx, ty);
        if (app.tool.kind === 'unit') {
          const hTile = app.run.map.tiles[ty * app.run.map.w + tx];
          const hMul = (TERRAIN[hTile] && TERRAIN[hTile].range) || 1;
          range = UNITS[app.tool.id].range * hMul;
          minRange = UNITS[app.tool.id].minRange || 0;
        } else range = 0;
      }
    }
    const hovSize = app.tool.kind === 'fort' && FORTS[app.tool.id] ? (FORTS[app.tool.id].size || 1) : 1;
    // 拆除模式用红色靶框（ok:false => ghostBad），提醒这里点下去会拆东西
    const hOk = app.tool.kind === 'demolish' ? false : ok;
    view.hover = { tx, ty, ok: hOk, range, minRange, size: hovSize };
  }

  // 屏幕震动
  ctx.save();
  if (app.shake > 0.1) {
    ctx.translate((Math.random() - 0.5) * app.shake, (Math.random() - 0.5) * app.shake);
    app.shake *= 0.86;
  } else app.shake = 0;

  view.cam = { x: app.cam.x, y: app.cam.y };
  view.zoom = app.zoom;
  view.damageNum = app.damageNum;
  view.showPath = app.showPath;
  view.zbar = app.zbar;
  view.decals = app.decal;
  view.selZ = app.selZ;
  view.selF = app.selF;
  view.selNode = app.selNode;
  view.selCore = app.selCore;
  view.selTile = app.selTile;
  // 选中建筑时画它的回血光环
  view.auraRings = null;
  if (!app.showAura) view.auraRings = null;
  else if (view.selCore) view.auraRings = [{
    x: (run.core.x + 0.5) * app.map.tile, y: (run.core.y + 0.5) * app.map.tile,
    r: (CORE_PROD.aura ? CORE_PROD.aura.radius : 1.5) * app.map.tile,
  }];
  else if (view.selF) {
    const fq = run.forts.find((q) => q.id === view.selF);
    if (fq && FORTS[fq.kind] && FORTS[fq.kind].aura) {
      view.auraRings = [{ x: fq.x, y: fq.y, r: FORTS[fq.kind].aura.radius * app.map.tile }];
    }
  }
  // 建造范围：选中哪类建筑就画哪个方块（与 canPlaceAt 同一套切比雪夫判定）
  view.buildRings = null;
  view.deployBox = null;
  view.buildBox = null;
  if (app.tool.kind === 'unit') view.buildRings = UNITS[app.tool.id].mobile ? 'deploy' : 'tower';
  else if (app.tool.kind === 'fort') view.buildRings = 'fort';
  if (run && run.core) {
    // 出兵圈要带上要放的兵种 id：炮台走 towerRadius，和 deployOk 判定同口径
  if (view.buildRings === 'deploy') view.deployBox = deployBounds(run, app.srcId, app.tool && app.tool.id);
    else if (view.buildRings === 'tower' || view.buildRings === 'fort') {
      view.buildBox = buildBounds(run, app.srcId, app.tool.kind, app.tool.id);
    }
  }
  if (app.skillMode && app.skillPreview) {
    const heroSid = app.skillMode.startsWith('hero:') ? app.skillMode.slice(5) : null;
    const sd = heroSid ? (HERO_SKILLS[heroSid] || {}) : (SKILLS[app.skillMode] || {});
    if (app.skillMode === 'airdrop') {
      const cell = run.map.tile;
      const tx = Math.floor(app.skillPreview.x / cell), ty = Math.floor(app.skillPreview.y / cell);
      view.skillPreview = {
        id: 'airdrop', x: (tx + 0.5) * cell, y: (ty + 0.5) * cell,
        r: 0, cell, ok: airdropOk(run, tx, ty),
      };
    } else {
      let inRange = true;
      if (heroSid) {
        const h = heroOf(run);
        inRange = !!h && Math.hypot(app.skillPreview.x - h.x, app.skillPreview.y - h.y) <= (sd.range || 120);
      }
      // 英雄技能：给一个「以她脚下为圆心」的射程圈，再加英雄→光标的距离，
      // 让玩家在点下去之前就知道够不够得到（圆心必须用 h.x/h.y，判定用的也是它）
      let ring = null;
      if (heroSid && sd.range) {
        const h = heroOf(run);
        if (h && h.hp > 0) {
          ring = {
            x: h.x, y: h.y, r: sd.range,
            dist: Math.hypot(app.skillPreview.x - h.x, app.skillPreview.y - h.y),
          };
        }
      }
      view.skillPreview = {
        id: heroSid || app.skillMode, hero: !!heroSid, ok: inRange,
        x: app.skillPreview.x, y: app.skillPreview.y, r: sd.radius || 0,
        ring,
      };
    }
  } else view.skillPreview = null;
  drawScene(ctx, run, view);
  ctx.restore();

  drawMinimap(app.run);
}


// ---------- 小地图 ----------
const mm = $('minimap');
const mmx = mm ? mm.getContext('2d') : null;
let mmBase = null;          // 地形底图缓存
let mmKey = '';

function mmGeo(map) {
  // 内容按地图比例内接居中，画和点击用同一套坐标，避免半格偏差
  const s = Math.min(mm.width / (map.w * map.tile), mm.height / (map.h * map.tile));
  const w = map.w * map.tile * s;
  const h = map.h * map.tile * s;
  return { s, ox: (mm.width - w) / 2, oy: (mm.height - h) / 2, w, h };
}

function buildMinimapBase(map) {
  const cv2 = document.createElement('canvas');
  cv2.width = mm.width; cv2.height = mm.height;
  const g = cv2.getContext('2d');
  const { s, ox, oy } = mmGeo(map);
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const t = map.tiles[y * map.w + x];
      const b = map.buildings.find((bb) => x >= bb.x && x < bb.x + bb.w && y >= bb.y && y < bb.y + bb.h);
      let col = TERRAIN[t] ? TERRAIN[t].color : '#1f2731';
      if (b) col = b.tone === 'tree' ? '#3c5a41' : '#5a6675';
      g.fillStyle = col;
      g.fillRect(ox + x * map.tile * s, oy + y * map.tile * s, Math.ceil(map.tile * s), Math.ceil(map.tile * s));
    }
  }
  return cv2;
}

function drawMinimap(run) {
  if (!mmx || !mm) return;
  const map = app.map;
  const key = `${map._id}:${map._rev}`;
  if (key !== mmKey) { mmBase = buildMinimapBase(map); mmKey = key; }
  const { s, ox, oy } = mmGeo(map);
  mmx.clearRect(0, 0, mm.width, mm.height);
  if (mmBase) mmx.drawImage(mmBase, 0, 0);
  if (!run) return;

  const tri = (x, y, r2, col) => {
    mmx.fillStyle = col;
    mmx.beginPath();
    mmx.moveTo(x, y - r2);
    mmx.lineTo(x + r2, y + r2);
    mmx.lineTo(x - r2, y + r2);
    mmx.closePath();
    mmx.fill();
  };
  const dot = (x, y, r2, col) => {
    mmx.fillStyle = col;
    mmx.beginPath(); mmx.arc(x, y, r2, 0, Math.PI * 2); mmx.fill();
  };
  const sq = (x, y, r2, col) => {
    mmx.fillStyle = col;
    mmx.fillRect(x - r2, y - r2, r2 * 2, r2 * 2);
  };
  // 三角旗（旗杆 + 右向旗面）：用于资源点，形状与僵尸的实心三角区分开
  // 资源点标：旗杆 + 矩形旗面（早期用三角形旗面，形状太像箭头，误认成流向指示）
  const flag = (x, y, h, col, alpha) => {
    mmx.save();
    mmx.globalAlpha = alpha == null ? 1 : alpha;
    mmx.strokeStyle = col;
    mmx.lineWidth = 1.3;
    mmx.beginPath();
    mmx.moveTo(x + 0.5, y + h);
    mmx.lineTo(x + 0.5, y - h);
    mmx.stroke();
    mmx.fillStyle = col;
    mmx.fillRect(x + 0.9, y - h, h * 1.5, h * 1.15);
    mmx.restore();
  };

  const F = '#4ade80';
  const E = '#ef4444';

  for (const f of run.forts) tri(ox + f.x * s, oy + f.y * s, 3.2, F);
  for (const u of run.units) {
    if (UNITS[u.kind].mobile) continue;
    tri(ox + u.x * s, oy + u.y * s, 3, F);
  }
  for (const u of run.units) {
    if (!UNITS[u.kind].mobile) continue;
    if (UNITS[u.kind].type === '载具') sq(ox + u.x * s, oy + u.y * s, 2.4, F);
    else dot(ox + u.x * s, oy + u.y * s, 2.4, F);
  }
  // 基地：金色双环 + 中心点 + 呼吸脉冲外环
  // 早期用实心三角，形状自带指向，被误认成「流向箭头」，所以换成无方向的圆环
  {
    const cx = ox + run.core.x * map.tile * s;
    const cy = oy + run.core.y * map.tile * s;
    const ph = (Date.now() % 2000) / 2000;
    mmx.save();
    mmx.strokeStyle = `rgba(232,193,90,${((1 - ph) * 0.5).toFixed(3)})`;
    mmx.lineWidth = 1.4;
    mmx.beginPath();
    mmx.arc(cx, cy, 4.5 + ph * 4.5, 0, Math.PI * 2);
    mmx.stroke();
    mmx.strokeStyle = '#e8c15a';
    mmx.lineWidth = 2.2;
    mmx.beginPath();
    mmx.arc(cx, cy, 5, 0, Math.PI * 2);
    mmx.stroke();
    mmx.fillStyle = '#e8c15a';
    mmx.beginPath();
    mmx.arc(cx, cy, 1.9, 0, Math.PI * 2);
    mmx.fill();
    mmx.restore();
  }
  // 资源点：三角旗三色 —— 中立白 / 我方蓝 / 敌方红
  // 我方无人驻守时闪烁（cap 正在 25s 掉光），占领/反推进度中半透明
  {
    const nowMs = Date.now();
    const fh = Math.max(4, map.tile * s * 1.8);
    for (const n of run.nodes || []) {
      const nx = ox + (n.x + 0.5) * map.tile * s;
      const ny = oy + (n.y + 0.5) * map.tile * s;
      const mid = Math.abs(n.cap) > 0.01 && Math.abs(n.cap) < 0.999;
      let col = '#8fa6bd';
      if (n.owner === 1) col = '#4aa8ff';
      else if (n.owner === 2) col = '#ef4444';
      let a = mid ? 0.55 : 1;
      if (n.owner === 1 && !n.guard) a = 0.4 + 0.6 * Math.abs(Math.sin(nowMs / 150));
      flag(nx, ny, fh, col, a);
    }
  }
  // 资源点易主：小地图上闪一圈琥珀（3 秒）
  if (app.nodeFlash && Date.now() < app.nodeFlash.until) {
    const k = 0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 160));
    mmx.strokeStyle = 'rgba(240,198,92,' + k.toFixed(2) + ')';
    mmx.lineWidth = 2;
    mmx.beginPath();
    mmx.arc(ox + app.nodeFlash.x * s, oy + app.nodeFlash.y * s, 7, 0, Math.PI * 2);
    mmx.stroke();
  }

  // 威胁热区（预测型）：沿 z.path 从 pathIdx 往前推 2.5 秒，得到「马上会在哪」。
  // 用径向光斑 + lighter 叠加，不用网格 —— 网格在小地图上必然一坨一坨的方块。
  {
    const tw = map.tile;
    const SEC = 2.5;
    const cx0 = run.core.x * tw, cy0 = run.core.y * tw;
    const spots = [];
    for (const z of run.zombies) {
      if (z.hp <= 0) continue;
      const sp = (ZOMBIES[z.mob] && ZOMBIES[z.mob].speed) || 32;
      let remain = SEC * sp;
      let px = z.x, py = z.y;
      const pa = z.path;
      let idx = z.pathIdx || 0;
      if (pa && pa.length > idx) {
        let x0 = px, y0 = py;
        while (remain > 0.5 && idx < pa.length) {
          const tk = pa[idx];
          const nx = (tk % map.w + 0.5) * tw;
          const ny = (Math.floor(tk / map.w) + 0.5) * tw;
          const d = Math.hypot(nx - x0, ny - y0);
          if (d <= remain) { x0 = nx; y0 = ny; remain -= d; idx++; }
          else { x0 += (nx - x0) / d * remain; y0 += (ny - y0) / d * remain; remain = 0; }
        }
        px = x0; py = y0;
      } else {
        // 还没算路径（待机 / 刚出生）：按「朝核心直线走」推演，方向至少是对的
        const dx = cx0 - z.x, dy = cy0 - z.y;
        const dd = Math.hypot(dx, dy) || 1;
        px = z.x + dx / dd * remain;
        py = z.y + dy / dd * remain;
      }
      spots.push({ x: px, y: py, w: z.boss ? 2.2 : 1 });
    }
    if (spots.length) {
      mmx.save();
      // 用 source-over 而不是 lighter：lighter 叠三层会把 rgba(239,68,68) 推成白点
      mmx.globalCompositeOperation = 'source-over';
      for (const sp2 of spots) {
        const sx = ox + sp2.x * s, sy = oy + sp2.y * s;
        const rr = 4.2;
        const gr = mmx.createRadialGradient(sx, sy, 0, sx, sy, rr);
        const a0 = Math.min(0.40, 0.30 * sp2.w);
        gr.addColorStop(0, 'rgba(239,68,68,' + a0.toFixed(3) + ')');
        gr.addColorStop(0.55, 'rgba(239,68,68,' + (a0 * 0.42).toFixed(3) + ')');
        gr.addColorStop(1, 'rgba(239,68,68,0)');
        mmx.fillStyle = gr;
        mmx.beginPath();
        mmx.arc(sx, sy, rr, 0, Math.PI * 2);
        mmx.fill();
      }
      mmx.restore();
    }
  }

  for (const z of run.zombies) {
    if (z.boss || z.sp) tri(ox + z.x * s, oy + z.y * s, z.boss ? 4 : 3, E);
    else dot(ox + z.x * s, oy + z.y * s, 1.8, 'rgba(239,68,68,0.85)');
  }

  // 叛军：画在最上层（僵尸之上），小地图专用琥珀橙；形状沿用我方（载具=方块，其余=圆点）
  if (run.raiderOn && run.raiders && run.raiders.length) {
    const R = '#ff9f1c';
    for (const r of run.raiders) {
      if (r.hp <= 0) continue;
      const kd = UNITS[r.kind] || {};
      if (kd.type === '载具') sq(ox + r.x * s, oy + r.y * s, 2.4, R);
      else dot(ox + r.x * s, oy + r.y * s, 2.4, R);
    }
  }

  if (app.state === STATE.PREP || app.state === STATE.BATTLE) {
    mmx.strokeStyle = 'rgba(255,255,255,0.9)';
    mmx.lineWidth = 1;
    const vs = viewSize();
    mmx.strokeRect(ox + app.cam.x * s + 0.5, oy + app.cam.y * s + 0.5, vs.w * s - 1, vs.h * s - 1);
  }
}

function mmJump(e) {
  const r = mm.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (mm.width / r.width);
  const my = (e.clientY - r.top) * (mm.height / r.height);
  const { s, ox, oy } = mmGeo(app.map);
  centerCamOn((mx - ox) / s, (my - oy) / s);
}

const RF = { cash: 0, parts: 0, tCash: 0, tParts: 0, init: false };

function pushResFloat(text, col, which) {
  const box = $('resfloats');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'rf';
  el.textContent = text;
  el.style.color = col;
  // C 方案：资金 / 零件的漂字分别对准顶栏里自己的胶囊
  const anchor = $(which === 'parts' ? 'res-parts' : 'res-supply');
  if (anchor) {
    const ar = anchor.getBoundingClientRect();
    el.style.left = `${Math.round(ar.left + ar.width / 2)}px`;
    el.style.top = `${Math.round(ar.bottom + 2)}px`;
  }
  box.appendChild(el);
  while (box.children.length > 6) box.firstChild.remove();
  setTimeout(() => el.remove(), 1500);
}
function trackRes(run, now) {
  if (!run) return;
  const cash = run.supply || 0, parts = run.parts || 0;
  if (!RF.init) { RF.init = true; RF.cash = cash; RF.parts = parts; RF.tCash = now; RF.tParts = now; return; }
  const dc = cash - RF.cash, dp = parts - RF.parts;
  RF.cash = cash; RF.parts = parts;
  if (dc) RF.accCash = (RF.accCash || 0) + dc;
  if (dp) RF.accParts = (RF.accParts || 0) + dp;
  const flush = (key, label, thr, gap) => {
    const acc = RF[key];
    if (!acc) return;
    const lastT = key === 'accCash' ? RF.tCash : RF.tParts;
    if (Math.abs(acc) < thr || now - lastT < gap) return;
    const v = Math.round(acc);
    if (!v) return;
    pushResFloat(`${v > 0 ? '+' : ''}${v} ${label}`, v > 0 ? '#7ee08a' : '#ff8a7a', key === 'accCash' ? 'cash' : 'parts');
    RF[key] = 0;
    if (key === 'accCash') RF.tCash = now; else RF.tParts = now;
  };
  flush('accCash', '资金', 5, 420);
  flush('accParts', '零件', 2, 420);
}


// 小地图交互：点击 / 拖拽跳转视角
if (mm) {
  let dragging = false;
  mm.addEventListener('pointerdown', (e) => { dragging = true; mmJump(e); });
  mm.addEventListener('pointermove', (e) => { if (dragging) mmJump(e); });
  const stop = () => { dragging = false; };
  mm.addEventListener('pointerup', stop);
  mm.addEventListener('pointerleave', stop);
  mm.addEventListener('pointercancel', stop);
}


// ---------------- 生产面板（建筑选中 → 右侧生产） ----------------
const PROD_GROUP_NAME = { inf: '步兵', veh: '载具', tow: '炮台', sup: '工事' };


function setShowAura(on) {
  app.showAura = !!on;
  const b = $('btn-aura');
  if (b) b.classList.toggle('on', app.showAura);
  try { localStorage.setItem('dcl.aura', app.showAura ? '1' : '0'); } catch (e) {}
}

// 单位面板底部的一行说明：克制倍率 + 弹夹 / 姿态 / 操作（方案 A：并进左下底栏）
function buildUnitHint(run, u, def) {
  const fmt1 = (v) => String(Number(v.toFixed(2)));
  const parts = [];
  // 护甲是本单位的固有属性，放在最后一行（副行只放攻击/射速/射程/移速这类数值）
  {
    const arm = def.armor || 'none';
    const cut = Math.round((ARMOR[arm] || 0) * 100);
    parts.push(`护甲 ${ARMOR_LABEL[arm] || '无甲'}${cut ? `（-${cut}%）` : ''}`);
  }
  // 炮台 / 载具这类「不会自己说话」的单位：把军衔的收益和进度单独写一行，
  // 否则玩家只看到攻击数字变了，不知道是升级给的。
  if (def.type === '炮台') {
    const rk = unitRank(u);
    const nx = unitXpNext(u);
    const rkName = rk >= 2 ? '精英' : (rk === 1 ? '老兵' : '新兵');
    const dmgUp = Math.round((unitDmgMul(u) - 1) * 100);
    const hpUp = Math.round((unitHpMul(u) - 1) * 100);
    const gains = [];
    if (dmgUp) gains.push(`伤害 +${dmgUp}%`);
    if (hpUp) gains.push(`生命 +${hpUp}%`);
    const left = nx == null ? null : Math.max(0, Math.ceil(nx - (u.xp || 0)));
    parts.push(left == null
      ? `军衔 ${rkName} · 击杀 ${u.kills || 0}${gains.length ? ' · ' + gains.join(' / ') : ''}`
      : `军衔 ${rkName} · 击杀 ${u.kills || 0} · 再 ${left} 点升级${gains.length ? '（现 ' + gains.join(' / ') + '）' : ''}`);
  }
  if (def.zone) parts.push(`火区 ${def.zone.r}px · ${def.zone.dps}/s`);
  else if (def.splash) parts.push(`溅射 ${def.splash.radius}`);
  if (def.vsArmor) {
    // 只列不等于 1 的护甲类型：等于 1 就是标准伤害，写出来纯占位。
    // 三条全是 1 的单位（步兵、工兵这类）整段省略。
    const vs = [['无甲', def.vsArmor.none], ['轻甲', def.vsArmor.light], ['重甲', def.vsArmor.heavy]]
      .filter(([, v]) => v !== undefined && Math.abs(v - 1) > 0.001)
      .map(([k, v]) => `${k} ${fmt1(v)}`);
    if (vs.length) parts.push(`克制 ${vs.join(' / ')}`);
  }
  // 医疗兵：治疗参数 + 光环只作用于步兵，免得玩家以为坦克也吃减伤
  if (def.heal) {
    const h = def.heal;
    parts.push(`治疗 ${h.rate}/s · 半径 ${h.radius} · 跨楼 ×${fmt1(h.crossMul != null ? h.crossMul : 1)}`);
    if (h.aura) parts.push(`光环 -${Math.round((h.aura.dr || 0) * 100)}%（仅步兵）`);
  }
  if (def.mag) {
    const cur = u.ammo === undefined ? def.mag.size : u.ammo;
    parts.push(u.reloadT > 0 ? `换弹中 ${u.reloadT.toFixed(1)}s` : `弹夹 ${cur}/${def.mag.size}`);
  }
  // 架设状态：让「架没架」在面板上一眼可见（射速差 47%，不写出来玩家感知不到）
  if (def.deploy) {
    const gain = Math.round((1 / (def.deploy.intervalMul || 1) - 1) * 100);
    if (u.depOn) parts.push(`架设中 · 射速 +${gain}% · 射程 +${def.deploy.rangeAdd || 0}`);
    else if (u.depDir > 0) parts.push(`架设中 ${Math.max(0, (def.deploy.setUpT || 0) - (u.depT || 0)).toFixed(1)}s`);
    else if (u.depDir < 0) parts.push('收架中');
    else parts.push(`未架设 · 架设后 射速 +${gain}%`);
  }
  // 只留这一屏用得上的信息：姿态。移动、停火、巡逻、换弹的按键都在帮助页和格子角标上，
  // 不再往消费不掉的一行里堆全局快捷键。
  if (def.mobile) {
    parts.push(`姿态：${u.stance === 'hold' ? '停火' : u.stance === 'patrol' ? '巡逻' : '自由开火'}`);
  }
  // 当前生效的增益：副行放不下（会被右侧拆除按钮截断），单独列在第三条 hint 行
  {
    const buffs = [];
    const wc = warcryDmgMul(run, u);
    if (Math.abs(wc - 1) > 1e-6) {
      const sk = HERO_SKILLS.warcry;
      buffs.push(`战吼 +${Math.round((wc - 1) * 100)}% 伤害 / +${Math.round((sk.speedMul - 1) * 100)}% 移速 / -${Math.round(sk.dr * 100)}% 受伤`);
    }
    const ad = adrSpeedMul(run, u);
    if (Math.abs(ad - 1) > 1e-6) {
      const sk = HERO_SKILLS.adrenaline;
      const left = Math.max(0, Math.ceil((u.adrUntil || 0) - run.time));
      buffs.push(`肾上腺素 +${Math.round((ad - 1) * 100)}% 移速（${left}s）`);
    }
    if (buffs.length) parts.push(`增益 ${buffs.join(' · ')}`);
  }
  return parts.join(' · ');
}

// 底栏 40px 兵种图标：形状认对象、底色+血条认血量。抽出来是因为生产源（据点/兵营/载具工厂）
// 的标题归 refreshProdPanel() 写，不走 syncBarTitle() 的常规流程，但图标要一起换。
function syncBarIcon(iconName, hpRatio, hurtInSquad) {
  const icEl = $('src-icon');
  if (!icEl) return;
  if (!iconName) {
    icEl.classList.add('hidden');
    return;
  }
  icEl.classList.remove('hidden');
  const icImg = $('src-icon-img');
  if (icImg && icImg.getAttribute('data-k') !== iconName) {
    icImg.src = iconPath(iconName);
    icImg.setAttribute('data-k', iconName);
  }
  const p = Math.max(0, Math.min(1, hpRatio < 0 ? 1 : hpRatio));
  const fill = $('src-hpfill');
  if (fill) {
    fill.style.width = (p * 100).toFixed(1) + '%';
    fill.style.background = p > 0.66 ? '#4ade80' : p > 0.33 ? '#fbbf24' : '#f87171';
  }
  icEl.classList.toggle('warn', p > 0.33 && p <= 0.66);
  icEl.classList.toggle('crit', p <= 0.33);
  icEl.classList.toggle('hurt', !!hurtInSquad && p > 0.33);
}

let barTitleSig = '';
function syncBarTitle() {
  const run = app.run;
  const nm = $('src-name');
  const sb = $('src-sub');
  if (!nm || !sb || !run) return;
  let name = '未选中';
  let sub = '点据点 / 兵营 / 载具工厂';
  // 底栏 40px 兵种图标：形状认兵种，底色+血条认血量（多选混编换 squad.png）
  let iconName = '';
  let hpRatio = -1;
  let hurtInSquad = false;
  const sel = [...app.sel]
    .map((id) => run.units.find((u) => u.id === id))
    .filter((u) => u && u.hp > 0);
  app.unitHint = '';
  if (sel.length === 1) {
    const u = sel[0];
    const d = UNITS[u.kind] || {};
    name = `${d.name || u.kind} ${Math.ceil(u.hp)}/${Math.ceil(u.maxHp)}`;
    const bits = [];
    {
      // 军衔：新兵/老兵/精英 + 距下一级的经验（击杀按威胁加权：行尸 1 / 特感 2 / 暴君 10）
      const rk = unitRank(u);
      const nx = unitXpNext(u);
      const rkName = rk >= 2 ? '精英' : (rk === 1 ? '老兵' : '新兵');
      const xp = Math.floor(u.xp || 0);
      bits.push(nx == null ? `${rkName} · 经验 ${xp}` : `${rkName} · 经验 ${xp}/${nx}`);
    }
    if (d.dmg) {
      // 面板必须显示「实际生效」的伤害：军衔是单兵状态，战吼是 6 秒团队增益，
      // 两者都乘在同一个 hitAt 上，所以这里也要一起乘，并把生效来源列出来。
      const rkMul = unitDmgMul(u);
      const wcMul = warcryDmgMul(run, u);
      const dm = rkMul * wcMul;
      const src = [];
      if (Math.abs(rkMul - 1) > 1e-6) src.push(`军衔 +${Math.round((rkMul - 1) * 100)}%`);
      if (Math.abs(wcMul - 1) > 1e-6) src.push(`战吼 +${Math.round((wcMul - 1) * 100)}%`);
      bits.push(src.length
        ? `攻击 ${Number((d.dmg * dm).toFixed(2))}（${src.join(' · ')}）`
        : `攻击 ${d.dmg}`);
    }
    if (d.fireInterval) bits.push(`射速 ${fireRateOf(d).toFixed(2)}`);
    if (d.range) bits.push(`射程 ${Math.round(unitRange(run, u))}`);
    {
      const sp = unitSpeedNow(run, u);
      if (sp) bits.push(`移速 ${Math.round(sp.now)}`);
    }
    // 护甲放到最后一行（buildUnitHint 里输出），副行只留会变的数值
    sub = bits.join(' · ');
    iconName = d.icon || u.kind;
    hpRatio = u.maxHp > 0 ? Math.max(0, u.hp) / u.maxHp : 0;
    app.unitHint = buildUnitHint(run, u, d);
  } else if (sel.length > 1) {
    const hp = sel.reduce((a, u) => a + Math.max(0, u.hp), 0);
    const full = sel.reduce((a, u) => a + Math.max(0, u.maxHp), 0);
    // 编队血量用「平均百分比」而不是总血量：混编时坦克那 500 血会把 4 个残血步兵盖掉
    const avg = sel.reduce((a, u) => a + (u.maxHp > 0 ? Math.max(0, u.hp) / u.maxHp : 0), 0) / sel.length;
    const cnt = new Map();
    for (const u of sel) cnt.set(u.kind, (cnt.get(u.kind) || 0) + 1);
    const kinds = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    const kd = UNITS[kinds[0][0]] || {};
    // 同兵种沿用该兵种图标；混编才换通用方阵图标
    iconName = kinds.length === 1 ? (kd.icon || kinds[0][0]) : 'squad';
    hpRatio = avg;
    hurtInSquad = sel.some((u) => u.maxHp > 0 && u.hp / u.maxHp <= 0.25);
    name = `${sel.length} 个单位`;
    const comp = kinds.map(([k, n]) => `${(UNITS[k] || {}).name || k} ${n}`).join(' · ');
    sub = `${comp} | ${Math.round(avg * 100)}% · ${Math.ceil(hp)}/${Math.ceil(full)}`;
  } else if (app.selF) {
    const f = run.forts.find((x) => x.id === app.selF);
    if (f) {
      name = (FORTS[f.kind] || {}).name || '工事';
      const mx = Math.ceil(f.maxHp || f.hpMax || f.hp);
      sub = `${Math.ceil(f.hp)}/${mx}`;
      iconName = (FORTS[f.kind] || {}).icon || f.kind;
      hpRatio = mx > 0 ? Math.max(0, f.hp) / mx : 0;
    }
  } else if (app.selNode) {
    // 资源点：占领状态直接进底栏标题区 —— 右侧详情卡默认 opacity:0，要 hover 才出来
    const n = (run.nodes || []).find((x) => x.id === app.selNode) || null;
    if (n) {
      const nt = NODE_TYPES[n.kind] || NODE_TYPES.cash;
      const owned = n.owner === 1;
      const graceSec = Math.max(0, Math.ceil(n.cap * (RULE.econ.holdGrace || 20)));
      const rate = nt.cash ? `+${nt.cash}/s` : `+${nt.parts}/s`;
      name = nt.name || '资源点';
      const bits = [];
      if (owned) {
        bits.push(n.guard ? '已占领 · 有人驻守' : `无人驻守 · ${graceSec}s 后失守`);
        bits.push(rate);
      } else if (Math.abs(n.cap) < 0.01) {
        bits.push('中立 · 派兵站进圈里 6s 占领');
      } else if (n.cap > 0) {
        bits.push(`占领中 ${Math.round(n.cap * 100)}%`);
      } else {
        bits.push(`被反推 ${Math.round(-n.cap * 100)}% · 派兵夺回`);
      }
      sub = bits.join(' · ');
      iconName = nt.icon || 'supply';
      hpRatio = Math.abs(n.cap);
    }
  } else if (app.selZ && run.zombies) {
    // 僵尸：底栏只给「名称+血量 / 攻·射速·移速·甲」，完整说明在 hover 展开的详情卡里
    const z = run.zombies.find((x) => x.id === app.selZ && x.hp > 0) || null;
    if (z) {
      const zd = ZOMBIES[z.mob] || ZOMBIES.walker;
      name = `${zd.name || z.mob} ${Math.ceil(z.hp)}/${z.maxHp}`;
      const bits = [];
      if (z.dmg > 0) bits.push(`攻 ${z.dmg}`);
      if (z.dmg > 0) bits.push(`射速 ${(1 / zAttackInterval(z, run.time)).toFixed(1)}`);
      bits.push(`移速 ${Math.round(z.speed)}`);
      bits.push(ARMOR_LABEL[zd.armor || 'none'] || '无甲');
      sub = bits.join(' · ');
      iconName = zd.icon || 'zombie';
      hpRatio = z.maxHp > 0 ? Math.max(0, z.hp) / z.maxHp : 0;
    }
  } else if (app.selRaid != null && run.raiders) {
    // 叛军：同上，摘要进底栏
    const r = run.raiders.find((x) => x.id === app.selRaid && x.hp > 0) || null;
    if (r) {
      const rd = UNITS[r.kind] || {};
      name = `叛军 · ${rd.name || r.kind} ${Math.ceil(r.hp)}/${r.maxHp}`;
      const bits = [];
      if (r.dmg) bits.push(`攻 ${Math.round(r.dmg)}`);
      if (r.fireInterval) bits.push(`射速 ${(1 / r.fireInterval).toFixed(2)}`);
      if (r.range) bits.push(`射程 ${Math.round(r.range)}`);
      if (r.speed) bits.push(`移速 ${Math.round(r.speed)}`);
      bits.push(ARMOR_LABEL[r.armor || 'none'] || '无甲');
      sub = bits.join(' · ');
      iconName = rd.icon || r.kind;
      hpRatio = r.maxHp > 0 ? Math.max(0, r.hp) / r.maxHp : 0;
    }
  } else if (app.selTile) {
    // 空地：地形名 + 四个倍率/建造限制，一行放得下
    const { tx, ty } = app.selTile;
    if (tx >= 0 && ty >= 0 && tx < run.map.w && ty < run.map.h) {
      const tt = run.map.tiles[ty * run.map.w + tx];
      const td = TERRAIN[tt] || {};
      const b = (run.map.buildings || []).find((bb) => tx >= bb.x && tx < bb.x + bb.w && ty >= bb.y && ty < bb.y + bb.h);
      name = b ? (b.tone === 'tree' ? '树木' : (b.garrison ? '可进入建筑' : '建筑')) : (TILE_NAME[tt] || '地面');
      if (b) {
        iconName = b.tone === 'tree' ? 'tree' : 'building';
        const bm = b.maxHp || b.hp || 0;
        hpRatio = bm > 0 ? Math.max(0, b.hp) / bm : 0;
      }
      const bits = [];
      // 建筑 / 树木有血量就先报血量（它们是可被拆的目标，玩家最关心还剩多少）
      if (b) bits.push(`血量 ${Math.max(0, Math.ceil(b.hp))}/${Math.max(1, b.maxHp || 400)}`);
      if (td.zSpeed) bits.push(`僵尸×${td.zSpeed.toFixed(2)}`);
      if (td.uSpeed) bits.push(`我方×${td.uSpeed.toFixed(2)}`);
      if (td.range) bits.push(`射程×${td.range.toFixed(2)}`);
      const block = (td.buildBlock || []).join('/');
      bits.push(!td.walkable ? '不可进入' : (block ? `禁${block}` : '全可建'));
      sub = bits.join(' · ');
    }
  }
  // 没有选中任何实体、但有生产源时，标题归 refreshProdPanel() 管（显示"指挥据点 / 可生产…"）
  const hasAnySel = sel.length > 0 || !!app.selF || !!app.selNode || app.selZ != null || app.selRaid != null || !!app.selTile;
  if (!hasAnySel && app.srcId && sourceOf(run, app.srcId)) {
    // 生产源（据点 / 兵营 / 载具工厂）：标题文字归 refreshProdPanel() 写，
    // 但图标必须在这里同步，否则从单位切到生产源时图标会停在上一个选中态。
    const src = sourceOf(run, app.srcId);
    // 标题文字归 refreshProdPanel 写，但它只在换波时重建面板；
    // 选中单位阵亡/重伤消失后就会一直显示那个已经不在场的单位。
    if (nm.textContent !== src.name) refreshProdPanel();
    let p = -1;
    if (app.srcId === 'core') {
      p = run.core.maxHp > 0 ? Math.max(0, run.core.hp) / run.core.maxHp : 0;
    } else if (src.unit && src.unit.maxHp > 0) {
      p = Math.max(0, src.unit.hp) / src.unit.maxHp;
    }
    const sm = src.unit ? UNITS[src.unit.kind] : null;
    syncBarIcon(app.srcId === 'core' ? 'core' : ((sm && sm.icon) || app.srcId), p, false);
    return;
  }
  const sig = name + '|' + sub + '|' + iconName + '|' + Math.round(hpRatio * 100) + '|' + (hurtInSquad ? 1 : 0);
  if (sig === barTitleSig) return;
  barTitleSig = sig;
  nm.title = name;
  sb.title = sub;
  nm.textContent = name;
  sb.textContent = sub;
  syncBarIcon(iconName, hpRatio, hurtInSquad);
}

function closeSource() {
  app.srcId = null;
  const list = $('prod-list');
  if (list) list.textContent = '';
  syncBarTitle();
}

function openSource(srcId) {
  const run = app.run;
  if (!run) return false;
  const src = sourceOf(run, srcId);
  if (!src || !src.produces.length) return false;
  app.srcId = srcId;
  refreshProdPanel();
  return true;
}


// Tab：在据点/兵营/载具工厂之间循环切换生产源
function cycleSource(dir = 1) {
  const run = app.run;
  if (!run) return;
  const list = ['core'];
  for (const f of run.forts) if (f.hp > 0 && FORTS[f.kind].produces) list.push(f.id);
  if (list.length <= 1) { toast('只有据点可用：先造兵营或载具工厂'); return; }
  const i = list.indexOf(app.srcId);
  const next = list[(i + dir + list.length) % list.length];
  openSource(next);
  const src = sourceOf(run, next);
  if (src) toast('生产源：' + src.name);
  sfx.click();
}

// 建造栏高亮：当前工具 active、钱不够 poor（生产面板/建造栏共用一套 .prod-item）
// 选中单位即为生产源（工兵 → 迫击炮）
function syncSourceFromSel() {
  const run = app.run;
  if (!run || !app.sel || app.sel.size !== 1) return;
  const id = Array.from(app.sel)[0];
  const u = run.units.find((q) => q.id === id);
  const d = u && UNITS[u.kind];
  if (d && d.produces && d.produces.length) {
    if (app.srcId !== id) { if (openSource(id)) refreshProdPanel(); }
  } else if (app.srcId === id) {
    closeSource();
  }
}

function refreshProdPanel() {
  const run = app.run;
  const list0 = $('prod-list');
  if (!list0 || !run) return;
  if (!app.srcId) { closeSource(); return; }
  const src = sourceOf(run, app.srcId);
  if (!src) { closeSource(); return; }
  // 选中单位时标题由 syncBarTitle() 负责（显示单位与血量），这里只在没选单位时写生产源标题
  if (app.sel.size === 0) $('src-name').textContent = src.name;
  barTitleSig = '';
  // produces 里可能混着分组键（inf/tow/sup）和具体 id（infantry/sniper），统一翻成中文名
  const labelOf = (g) => PROD_GROUP_NAME[g]
    || (UNITS[g] && UNITS[g].name) || (FORTS[g] && FORTS[g].name) || g;
  // 兵营 / 载具工厂的产物是整组，逐项列出来太长，直接用一句话说明
  const SUB_SHORT = { barracks: '生产步兵单位', factory: '生成载具单位' };
  const shortSub = SUB_SHORT[(src.fort && src.fort.kind) || ''];
  if (app.sel.size === 0) $('src-sub').textContent = shortSub || ('可生产：' + src.produces.map(labelOf).join(' / '));
  const list = $('prod-list');
  list.textContent = '';
  producibleList(run, app.srcId).forEach((id, idx) => {
    const isUnit = !!UNITS[id];
    const def = isUnit ? UNITS[id] : FORTS[id];
    const kind = isUnit ? 'unit' : 'fort';
    const btn = document.createElement('button');
    btn.className = 'prod-item';
    btn.dataset.kind = kind;
    btn.dataset.id = id;
    const cost = `${def.cost}${def.parts ? ' +' + def.parts + '件' : ''}`;
    btn.innerHTML = `<em>${idx + 1}</em><img src="${iconPath(def.icon || id)}" alt="" /><b>${def.name}</b><i>${cost}</i>`;
    const bits = [`资金 ${def.cost}`];
    if (def.parts) bits.push(`零件 ${def.parts}`);
    if (def.pop) bits.push(`人口 ${def.pop}`);
    if (def.hp) bits.push(`耐久 ${def.hp}`);
    let locked = '';
    if (kind === 'fort') {
      const miss = requirementOf(run, id);
      if (miss === 'require') {
        const rk = Object.keys(def.requires)[0];
        locked = `需先建 ${def.requires[rk]} 座${FORTS[rk] ? FORTS[rk].name : rk}`;
      } else if (miss === 'limit') {
        locked = `每座${FORTS[def.limitedBy] ? FORTS[def.limitedBy].name : def.limitedBy}只能带 1 座`;
      }
    }
    if (!locked && kind === 'unit' && !isUnlocked(run, id)) {
      const uw = unlockWaveOf(id);
      locked = `第 ${uw} 波解锁`;
      btn.dataset.lockWave = `W${uw}`;
    }
    if (!locked && kind === 'unit' && def.type === '炮台' && (run.waveIndex || 0) === 0
        && id === 'turret' && !capOk(run, kind, id)) {
      locked = '第 1 波只能造 1 座自动炮台';
    }
    if (!locked && !capOk(run, kind, id)) {
      const capTxt = kind === 'unit'
        ? `已达上限：炮台类合计 ${RULE.caps.towTotal} 座`
        : `已达上限：${def.name}最多 ${RULE.caps[id]} 座`;
      locked = capTxt;
    }
    if (locked) {
      btn.classList.add('locked');
      if (!btn.dataset.capped) btn.dataset.hardLock = '1';   // 需求/限量类锁定不被实时刷新解除
      bits.push(`锁：${locked}`);
    }
    btn.title = `${def.name}：${bits.join(' · ')}`;
    btn.addEventListener('click', () => {
      if (kind === 'unit' && def.type === '炮台') {
        const left = towCdLeft(run, id);
        if (left > 0) { sfx.deny(); toast(`炮台冷却中：还剩 ${Math.ceil(left)} 秒`); return; }
      }
      if (locked) { sfx.deny(); toast(locked); return; }
      app.tool = { kind, id };
      sfx.click();
      refreshHud(true);
    });
    list.appendChild(btn);
  });
}

// 面板按钮状态（高亮/买不起）
function refreshProdStates(run) {
  const list = $('prod-list');
  if (!list) return;
  for (const btn of list.children) {
    const def = btn.dataset.kind === 'unit' ? UNITS[btn.dataset.id] : FORTS[btn.dataset.id];
    if (!def) continue;
    btn.classList.toggle('poor', (run.supply || 0) < def.cost || (run.parts || 0) < (def.parts || 0));
    btn.classList.toggle('active', app.tool.kind === btn.dataset.kind && app.tool.id === btn.dataset.id);
    if (btn.dataset.kind === 'unit' && def.type === '炮台') {
      const left = towCdLeft(run, btn.dataset.id);
      btn.classList.toggle('cooling', left > 0);
      btn.dataset.cool = left > 0 ? String(Math.ceil(left)) : '';
    }
    if (!btn.dataset.hardLock) {
      const capped = !capOk(run, btn.dataset.kind, btn.dataset.id);
      btn.classList.toggle('locked', capped);
      btn.dataset.capped = capped ? '1' : '';
    }
  }
}

let barSig = '';
// 底栏跟随上下文：有生产源就只看生产列表，选中单位才给单位控制，什么都没有就整条收起
function syncBarLayout() {
  const bar = $('buildbar');
  if (!bar) return;
  const inGame = app.state === STATE.PREP || app.state === STATE.BATTLE;
  const hasUnit = app.sel.size > 0;
  const demolish = inGame && app.tool.kind === 'demolish';
  const patrol = inGame && app.tool.kind === 'patrol';
  const pFrom = patrol && app.patrolFrom ? `${app.patrolFrom.x},${app.patrolFrom.y}` : '';
  // 底栏常驻：星际/铁锈那类 RTS 的底栏一直在，位置不跳。
  // 没选中任何东西时它退化成"当前生产源"的造兵面板（srcId 默认是据点），
  // 所以不需要再按 demolish/patrol/hasUnit/srcId 这些条件隐藏整条。
  const show = !!app.run && inGame;
  const unitMode = show && hasUnit;
  const compact = show && !hasUnit;
  // 选中敌方单位 / 空地 / 工事时标题区要显示「名称+血量」和一行摘要，
  // 196px 的固定宽放不下，单独给一个 .named 放开宽度（不影响指令格与生产格的显隐）
  const named = show && (hasUnit || !!app.selF || !!app.selNode || app.selZ != null || app.selRaid != null || !!app.selTile);
  // 只有「选中的这个单位本身就是生产源」（工兵）才把建造项排在指令后面；
  // 选普通步兵时不显示基地的建造项，避免和"选中据点"的面板重复。
  const selOne = unitMode && app.sel.size === 1 ? [...app.sel][0] : '';
  const srcNow = selOne && app.srcId === selOne ? sourceOf(app.run, app.srcId) : null;
  const prodAlong = !!(srcNow && srcNow.produces && srcNow.produces.length);
  const sig = `${show ? 1 : 0}${compact ? 1 : 0}${named ? 1 : 0}${demolish ? 1 : 0}${patrol ? 1 : 0}${prodAlong ? 1 : 0}${pFrom}|${unitMode ? (app.unitHint || '') : ''}`;
  if (sig === barSig) return;
  barSig = sig;
  bar.classList.toggle('hidden', !show);
  bar.classList.toggle('compact', compact);
  bar.classList.toggle('unit', unitMode);
  bar.classList.toggle('named', named);
  bar.classList.toggle('demolish', demolish);
  bar.classList.toggle('patrol', patrol);
  bar.classList.toggle('prod-along', prodAlong);
  const hint = $('hint');
  if (hint) {
    if (hint.dataset.base === undefined) hint.dataset.base = hint.innerHTML;
    if (demolish) {
      hint.innerHTML = '<b>拆除模式</b>：左键点目标（返还 50%）· <b>右键</b> / <b>Esc</b> 退出';
    } else if (unitMode && app.unitHint) {
      hint.innerHTML = app.unitHint;
    } else if (patrol) {
      hint.innerHTML = pFrom
        ? `起点 <b>(${pFrom})</b> → 点<b>终点</b> · <b>右键</b> / <b>Esc</b> / <b>T</b> 取消`
        : '巡逻：左键点<b>起点</b> → 再点<b>终点</b> · <b>右键</b> / <b>Esc</b> / <b>T</b> 退出';
    } else if (hint.dataset.base) {
      hint.innerHTML = hint.dataset.base;
    }
    // 单行省略时，悬停看全文
    hint.title = hint.textContent.trim();
  }
}

// 轮询型告警：这些状态没有一次性事件（扣血是每帧连续结算、资源满是持续状态），
// 只能在 HUD 刷新（约 12 次/秒）时对比上一次快照再决定要不要记一条。
function pollAlerts(run) {
  if (!run || !run.core) return;
  if (run.phase !== PHASE.BATTLE && run.phase !== PHASE.PREP) return;
  app._seenSpec = app._seenSpec || {};
  // ① 据点受击（10s 一条，带当前血量百分比）
  const hp = Math.max(0, Math.round(run.core.hp));
  if (app._lastCoreHp != null && hp < app._lastCoreHp && logThr('corehit', 10000)) {
    const pct = Math.round((hp / (run.core.maxHp || RULE.core.hp)) * 100);
    pushLog(`指挥据点遭到攻击 · ${pct}%`, 'bad');
  }
  app._lastCoreHp = hp;
  // ② 据点升级
  const lv = run.coreLevel || 1;
  if (app._lastCoreLv != null && lv > app._lastCoreLv) {
    pushLog(`据点升至 Lv${lv} · 产出提高`, 'good');
  }
  app._lastCoreLv = lv;
  // ③ 资金 / 人口满（30s 一条，别一直念）
  const cap = supplyCap(run);
  if (cap < 9000 && run.cash >= cap && logThr('cashfull', 30000)) {
    pushLog(`资金已满 ${cap} · 再多也不会涨`, 'warn');
  }
  const pc = popCap(run);
  const pu = popUsed(run);
  if (pc > 0 && pu >= pc && logThr('popfull', 30000)) {
    pushLog(`人口已满 ${pu}/${pc} · 造不了新兵`, 'warn');
  }
  // ④ 特感首次出现（每种只报一次）
  for (let i = 0; i < run.zombies.length; i++) {
    const kind = run.zombies[i].kind;
    if (!SPECIAL_IDS.includes(kind) || app._seenSpec[kind]) continue;
    app._seenSpec[kind] = 1;
    const zd = ZOMBIES[kind] || UNITS[kind];
    pushLog(`${(zd && zd.name) || kind}出现`, kind === 'behemoth' ? 'bad' : 'warn');
  }
  // ⑤ 僵尸贴到核心 3 格内（20s 一条）
  const T = run.map.tile;
  const cxp = run.core.x * T + T / 2;
  const cyp = run.core.y * T + T / 2;
  const near = T * 3;
  for (let i = 0; i < run.zombies.length; i++) {
    const z = run.zombies[i];
    if (Math.hypot(z.x - cxp, z.y - cyp) > near) continue;
    if (logThr('zclose', 20000)) pushLog('僵尸已贴到指挥据点！', 'bad');
    break;
  }
}

// 选中「从无到有」时播一次兵种音；框选 20 人只响一声
function noteSelSfx() {
  const ids = [...app.sel].sort((a, b) => a - b);
  const sig = ids.join(',');
  if (sig === app._selSig) return;
  const prevN = app._selSig ? app._selSig.split(',').length : 0;
  app._selSig = sig;
  if (ids.length <= prevN || !app.run) return;
  const u = app.run.units.find(x => x.id === ids[0]);
  if (u) sfx.selectUnit(VOICE_GROUP[u.kind]);
}

// ── 核心升级三选一 ───────────────────────────────
let perkSig = '';
let perkPaintAt = 0;
let threatPaintAt = 0;
let threatTier = -1;
function renderPerkBar(run) {
  const bar = $('perkbar');
  if (!bar) return;
  const pend = run && run.pendingPerk;
  if (!pend) {
    if (perkSig) {
      perkSig = '';
      bar.classList.remove('on');
      bar.classList.add('hidden');
    }
    return;
  }
  const sig = pend.options.join(',');
  if (sig !== perkSig) {
    perkSig = sig;
    bar.classList.remove('hidden');
    bar.classList.add('on');
    $('perk-row').innerHTML = pend.options.map((id, i) => {
      const pk = PERKS.find((x) => x.id === id);
      if (!pk) return '';
      return '<div class="perk" data-i="' + i + '">'
        + '<span class="pk-tag" style="color:' + pk.tint + ';border:1px solid ' + pk.tint + '55;background:' + pk.tint + '16">' + pk.tag + '</span>'
        + '<span class="pk-name">' + pk.name + '</span>'
        + '<span class="pk-desc">' + pk.desc + '</span>'
        + '</div>';
    }).join('');
  }
  // 倒计时不必每帧写：60fps 下每帧改 textContent + 进度条会多一次 layout
  const nowMs = performance.now();
  if (nowMs - perkPaintAt < 100) return;
  perkPaintAt = nowMs;
  const left = Math.max(0, pend.t);
  const tEl = $('perk-timer'), pEl = $('perk-progress');
  if (tEl) tEl.textContent = left.toFixed(1) + 's';
  // scaleX 走合成层，不触发布局；width 会
  if (pEl) pEl.style.width = (left / PERK_SECS * 100).toFixed(1) + '%';
}

function refreshHud(force) {
  // 指挥官第一次出现在场上（招募完成）——只有在场时才算，重伤倒地不算
  if (app.run && app.state !== STATE.TITLE) {
    const hh = heroOf(app.run);
    if (hh) {
      if (!app._heroSeen) { app._heroSeen = true; if (sfx.voice) sfx.voice('ready'); }
      // 血量跌破 50% → taking_fire（内部有 22s 冷却）
      if (hh.hp <= hh.maxHp * 0.5 && sfx.voice) sfx.voice('taking_fire', hh.x, hh.y);
    }
  }
  noteSelSfx();
  syncBarLayout();
  renderPerkBar(app.run);
  if (app.run) {
    const now = performance.now();
    if (force || now - incomeCardT > 250) { incomeCardT = now; paintIncomeCard(app.run); }
  } else if (incomeCardEl) incomeCardEl.style.display = 'none';
  trackRes(app.run, performance.now());
  // 生产面板：源被摧毁就关掉，否则刷新可买状态
  if (app.run && app.srcId && app.srcId !== 'core') {
    // 源可以是工事，也可以是带 produces 的单位（工兵造迫击炮）
    const srcAlive = app.run.forts.some((f) => f.id === app.srcId && f.hp > 0)
      || app.run.units.some((u) => u.id === app.srcId && u.hp > 0);
    if (!srcAlive) {
      // 生产源没了就回落到据点，绝不把底栏留成空白
      app.srcId = 'core';
      refreshProdPanel();
      toast('生产源已被摧毁，切回据点');
    }
  }
  if (app.run && app.srcId) {
    // 每清一波都会解锁新东西/抬高上限，面板要重建一次，否则锁图标不会消失
    if (app._prodWave !== app.run.waveIndex) {
      app._prodWave = app.run.waveIndex;
      refreshProdPanel();
    }
    refreshProdStates(app.run);
  }
  // 标题永远由 syncBarTitle 决定：选中单位时显示单位与血量，没选单位才回落生产源名。
  // （原来只在「没有生产源」时才调，选中工兵这类"单位即生产源"的对象时标题就卡在生产源上）
  if (app.run) syncBarTitle();
  const run = app.run;
  const bar = $('hud-corebar');
  if (!run) { bar.style.width = '100%'; return; }
  const capNow = supplyCap(run);
  const supEl = $('hud-supply');
  // 资源簇把「当前值」和「上限」拆成两个元素：数字要单独放大加粗，上限用小号灰字
  supEl.textContent = String(Math.floor(run.supply));
  const supCapEl = $('hud-supply-cap');
  if (supCapEl) supCapEl.textContent = `/${capNow}`;
  const supFull = run.supply >= capNow - 1;
  supEl.classList.toggle('full', supFull);
  const resSup = $('res-supply');
  if (resSup) resSup.classList.toggle('full', supFull);
  supEl.title = `资金 ${Math.floor(run.supply)} / ${capNow}（核心每升 1 级 +${RULE.supply.capPerLevel||0}，已满时基地停产）`;
  $('hud-parts').textContent = Math.floor(run.parts);
  const incHud = incomeRate(run);
  const netEl = $('hud-net');
  if (netEl) {
    netEl.textContent = `${incHud.netCash >= 0 ? '+' : ''}${incHud.netCash.toFixed(1)}`;
    netEl.classList.toggle('neg', incHud.netCash < -0.05);
    netEl.title = `净收入 ${incHud.netCash.toFixed(1)}/s（基地 +${incHud.baseCash.toFixed(1)} · 资源点 +${incHud.nodeCash.toFixed(1)} · 维护 -${incHud.upkeep.toFixed(1)}）`;
  }
  const partsNetEl = $('hud-parts-net');
  if (partsNetEl) {
    partsNetEl.textContent = `${incHud.parts >= 0 ? '+' : ''}${incHud.parts.toFixed(1)}`;
    partsNetEl.classList.toggle('neg', incHud.parts < -0.005);
    partsNetEl.title = `零件产出 ${incHud.parts.toFixed(2)}/s（基地 +${incHud.baseParts.toFixed(2)} · 资源点 +${incHud.nodeParts.toFixed(2)} · 占点越多越高）`;
  }
  // 人口同样拆成「已用 / 上限」
  $('hud-pop').textContent = String(popUsed(run));
  const popCapEl = $('hud-pop-cap');
  if (popCapEl) popCapEl.textContent = `/${popCap(run)}`;
  $('hud-lv').textContent = String(run.coreLevel || 1);
  const owned = (run.nodes || []).filter((n) => n.owner === 1).length;
  $('hud-nodes').textContent = `${owned}/${(run.nodes || []).length}`;
  // 无尽模式顶栏显示击杀进度（胜利条件：击杀 10000 + 同时占 4 点）
  const wLbl = $('lbl-wave');
  if (run.endless) {
    const G = RULE.endlessGoal || { kills: 10000, nodes: 4 };
    $('hud-wave').textContent = `${Math.min(run.stats.kills, G.kills)}/${G.kills}`;
    if (wLbl) {
      wLbl.textContent = '击杀';
      wLbl.title = `无尽目标：击杀 ${G.kills} 只 + 同时占领 ${G.nodes} 个资源点（当前 ${owned} 个）`;
    }
  } else {
    $('hud-wave').textContent = `${Math.max(1, run.waveIndex)}/${run.totalWaves}`;
    if (wLbl) wLbl.textContent = '波次';
  }
  $('hud-zombies').textContent = run.zombies.length;
  const rw = $('hud-raiderwrap');
  if (rw) {
    const rn = (run.raiders || []).filter((r) => r.hp > 0).length;
    rw.style.display = run.raiderOn ? '' : 'none';
    $('hud-raiders').textContent = rn;
  }

  const hp = Math.max(0, Math.round(run.core.hp));
  $('hud-core').textContent = hp;
  // 威胁条：场上所有僵尸的威胁权重之和（行尸 1 / 特感 6~8 / 暴君 26）。
  // 跟波次无关，所以跨波残留、游荡者、无尽刷怪都不会让它跳变；对数刻度保证
  // 早期十几个行尸也能看出来，后期几百只也不会一直顶着满格。
  {
    const zb = $('hud-zbar');
    if (zb) {
      // 100ms 节流：这条每帧算 Σ 威胁值 + 写样式，几百只僵尸时是实打实的开销
      const nowMs2 = performance.now();
      if (nowMs2 - threatPaintAt >= 100) {
        threatPaintAt = nowMs2;
        let cur = 0, n = 0;
        for (const z of run.zombies) {
          if (z.hp <= 0) continue;
          const zd = ZOMBIES[z.mob];
          cur += (zd && zd.threat) || 1;
          n++;
        }
        const frac = clamp(Math.log1p(cur) / Math.log1p(THREAT_FULL), 0, 1);
        zb.style.width = (frac * 100).toFixed(1) + '%';
        const tier = frac > 0.70 ? 2 : frac > 0.30 ? 1 : 0;
        if (tier !== threatTier) {
          threatTier = tier;
          zb.style.background = tier === 2
            ? 'linear-gradient(90deg, #ef4444 0%, #b91c1c 100%)'
            : tier === 1
              ? 'linear-gradient(90deg, #fb923c 0%, #ea580c 100%)'
              : 'linear-gradient(90deg, #64748b 0%, #475569 100%)';
        }
        const zp = $('hud-zpct');
        if (zp) {
          const txt = Math.round(cur) + ' · ' + n;
          if (zp.textContent !== txt) {
            zp.textContent = txt;
            zp.title = '威胁 ' + Math.round(cur) + ' · 场上僵尸 ' + n + ' 只';
          }
        }
      }
    }
  }
  bar.style.width = `${clamp((run.core.hp / run.core.maxHp) * 100, 0, 100).toFixed(1)}%`;
  bar.style.background = run.core.hp / run.core.maxHp > 0.35 ? '#e0b341' : '#e0603a';
  // 下一波构成预告（只列前 4 类，按数量降序）
  {
    const pv = wavePreview(run, (run.waveIndex || 0) + 1);
    const pvTxt = (pv && pv.length)
      ? pv.slice(0, 4).map((q) => `${q.n} ${(ZOMBIES[q.mob] && ZOMBIES[q.mob].name) || q.mob}`).join(' · ')
      : '';
    const th = run._pvTheme;
    app._pvHtml = pvTxt ? `<em>${th ? '【' + th.name + '】' : ''}${pvTxt}</em>` : '';
  }
  $('hud-timer').innerHTML = app.state === STATE.PREP
    ? `<b>${Math.ceil(run.prepTimer)}</b><i>秒后开战</i>${app._pvHtml || ''}`
    : (() => {
      const w = run.wave;
      const stamp = `<b>${Math.floor(run.time / 60)}:${String(Math.floor(run.time % 60)).padStart(2, '0')}</b><i>已用时</i>`;
      if (!w) return stamp;
      if ((run.waveIndex || 0) >= run.totalWaves) return `<b>最后一波</b><i>清完才算赢</i>`;
      const left = Math.max(0, (w.duration || 40) - run.waveTimer);
      $('hud-timer').classList.toggle('warn', left > 0 && left <= 5);
      const sec = Math.ceil(left);
      if (run.wave === 1 && sec <= 10 && !app._firstTip) {
        app._firstTip = true;
        toast('先造几个步兵：左下面板点「步兵」，再点地图空地', 3600);
      }
      if (sec > 0 && sec <= 5 && app._beatSec !== sec) {
        app._beatSec = sec;
        sfx.click();
      }
      return `<b>${sec}</b><i>秒后下一波</i>${sec > 0 ? (app._pvHtml || '') : ''}`;
    })();
  // 第 1 波前是“立即开战”；波间整备是“下一波 +N 补给”
  if (app.state === STATE.PREP) {
    const early = run.waveIndex > 1 ? Math.max(0, Math.ceil(run.prepTimer)) : 0;
    $('btn-wave').textContent = early > 0 ? `下一波 (+${early} 补给)` : '立即开战';
  } else {
    $('btn-wave').textContent = '战斗中';
  }
  $('btn-wave').disabled = app.state !== STATE.PREP;

  // 人口是否已满：满了给顶栏一个醒目提示，避免玩家狂点造兵没反应
  if (!app._tutInit) { app._tutInit = true; startTutorial(); }
  if (app._tutAt && Date.now() >= app._tutAt) { app._tutAt = 0; advanceTut(); }
  // 编队徽章（Shift+数字 存 / Alt+数字 召回）
  {
    const gb = $('hud-groups');
    if (gb) {
      const now = Date.now();
      let html = '';
      for (let n = 1; n <= 9; n++) {
        const ids = groups.get(n);
        if (!ids || !ids.length) continue;
        const alive = ids.filter((id) => run.units.some((u) => u.id === id)).length;
        if (!alive) continue;
        const fl = app.groupFlash && app.groupFlash.n === n && now < app.groupFlash.until ? ' flash' : '';
        // 成员构成：兵种 → 数量（只统计还活着的）
        const kinds = new Map();
        for (const id of ids) {
          const u = run.units.find((x) => x.id === id);
          if (!u) continue;
          const nm = (UNITS[u.kind] && UNITS[u.kind].name) || u.kind;
          kinds.set(nm, (kinds.get(nm) || 0) + 1);
        }
        const comp = [...kinds.entries()].map(([k, v]) => `${v} ${k}`).join(' · ') || '已全灭';
        const tip = `编队 ${n}｜${comp}\nAlt+${n} 召回 · Shift+${n} 覆盖`;
        html += `<i class="gb${fl}" data-n="${n}" title="${tip}" data-tip="${tip}">${n}<em>${alive}</em></i>`;
      }
      if (gb.dataset.sig !== html) { gb.innerHTML = html; gb.dataset.sig = html; }
      gb.style.display = html ? '' : 'none';
    }
  }
  pollAlerts(run);
  renderLog();
  const popLimit = popCap(run);
  const popNow = popUsed(run);
  $('hud-pop').classList.toggle('full', popLimit > 0 && popNow >= popLimit);
  const resPop = $('res-pop');
  if (resPop) resPop.classList.toggle('full', popLimit > 0 && popNow >= popLimit);

  // 技能冷却
  for (const id of SKILL_ORDER) {
    const b = $('skill-' + id);
    if (!b) continue;
    const cd = (run.skills && run.skills[id]) || 0;
    b.classList.toggle('cooling', cd > 0);
    b.classList.toggle('armed', app.skillMode === id);
    const lab = b.querySelector('i');
    const cost = SKILLS[id].cost || 0;
    const cdMax = SKILLS[id].cd || 60;
    b.style.setProperty('--cddeg', cd > 0 ? Math.round((cd / cdMax) * 360) + 'deg' : '0deg');
    if (lab) lab.textContent = cd > 0 ? Math.ceil(cd) + 's' : SKILLS[id].name;
    b.dataset.cost = cost > 0 ? String(cost) : '';
    b.classList.toggle('poor', cost > 0 && run.supply < cost && cd <= 0);
  }
  // 指挥官技能：并进左侧工具行，只有「选中的就是指挥官本人」时按钮才出现
  {
    const bar = $('buildbar');
    const selOne = app.sel.size === 1 ? [...app.sel][0] : null;
    const su = run && selOne != null ? run.units.find((u) => u.id === selOne) : null;
    const heroSel = !!(su && UNITS[su.kind] && UNITS[su.kind].hero);
    if (bar) bar.classList.toggle('hero-sel', heroSel);
    for (const sid of HERO_SKILL_ORDER) {
      const b = $('skill-' + sid);
      if (!b) continue;
      const sk = HERO_SKILLS[sid];
      const cd = (run && run.heroCd && run.heroCd[sid]) || 0;
      b.classList.toggle('cooling', cd > 0);
      b.classList.toggle('armed', app.skillMode === 'hero:' + sid);
      const lab = b.querySelector('i');
      if (lab) lab.textContent = cd > 0 ? Math.ceil(cd) + 's' : '就绪';
      // 冷却时把按键角标换成剩余秒数：这是玩家唯一能看出「还要等多久」的地方
      const kb = b.querySelector('em');
      if (kb) kb.textContent = cd > 0 ? Math.ceil(cd) + 's' : (sid === 'grenade' ? 'G' : '⇧' + sk.key);
      b.title = `${sk.name}（${sk.key}）——${sk.hint || ''}${cd > 0 ? ` · 冷却 ${Math.ceil(cd)}s` : ''}`;
    }
  }
  $('btn-speed').textContent = `×${app.speed}`;
  $('btn-pause').classList.toggle('on', app.paused);
  if (force || app.state === STATE.PREP || app.state === STATE.BATTLE) {
    syncSourceFromSel();
    $('btn-demolish').classList.toggle('active', app.tool.kind === 'demolish');
    $('btn-select').classList.toggle('active', app.tool.kind === 'select');
  }
}

// ---------------- 输入 ----------------
// 屏幕 → 世界坐标（相机参与）
function posFromEvent(e) {
  const r = cv.getBoundingClientRect();
  const sx = (e.clientX - r.left) * (cv.width / r.width);
  const sy = (e.clientY - r.top) * (cv.height / r.height);
  const z = app.zoom;
  return { x: sx / z + app.cam.x, y: sy / z + app.cam.y };
}

// 屏幕 → 画布坐标（不加相机，给叠加层用）
// 相机限位：不让野外露出来
// 底部面板（#buildbar）是浮层，盖住画面最下方约 164 CSS 像素。
// 相机视口高度必须扣掉这一条，否则"滚到底"时地图最下缘正好藏在面板下面、永远看不见。
// 返回的是画布坐标下的遮挡高度（CV 内部分辨率与 CSS 尺寸不同，要按比例换算）。
function hudBottomCv() {
  const cvs = document.getElementById('cv');
  const bar = document.getElementById('buildbar');
  if (!cvs || !bar) return 0;
  const cssH = cvs.getBoundingClientRect().height || cvs.height || 1;
  const usedCss = (bar.offsetHeight || 152) + 12;   // 12 = #buildbar 的 bottom
  return usedCss * (cvs.height / cssH);
}

function viewSize() {
  const z = app.zoom;
  const cvs = document.getElementById('cv');
  if (!cvs) return { w: cv.width / z, h: cv.height / z };
  // 至少保留 120 画布像素，防止面板异常变大时视口被算成负数
  const hCv = Math.max(120, cvs.height - hudBottomCv());
  return { w: cvs.width / z, h: hCv / z };
}

function clampCam() {
  const W = app.map.w * app.map.tile, H = app.map.h * app.map.tile;
  const vs = viewSize();
  const vw = vs.w, vh = vs.h;
  app.cam.x = clamp(app.cam.x, 0, Math.max(0, W - vw));
  app.cam.y = clamp(app.cam.y, 0, Math.max(0, H - vh));
}

// 把相机对准某个世界点（用于小地图跳转）
function centerCamOn(wx, wy) {
  const vs = viewSize();
  app.cam.x = clamp(wx - vs.w / 2, 0, Math.max(0, app.map.w * app.map.tile - vs.w));
  app.cam.y = clamp(wy - vs.h / 2, 0, Math.max(0, app.map.h * app.map.tile - vs.h));
  clampCam();
}

// 每帧：方向键 + 鼠标贴边移动视角
function updateCamera(dt) {
  if (app.state !== STATE.PREP && app.state !== STATE.BATTLE) return;
  const sp = 900 * dt;
  let dx = 0, dy = 0;
  if (app.keys.has('arrowleft') || app.keys.has('a')) dx -= sp;
  if (app.keys.has('arrowright') || app.keys.has('d')) dx += sp;
  if (app.keys.has('arrowup') || app.keys.has('w')) dy -= sp;
  if (app.keys.has('arrowdown') || app.keys.has('s')) dy += sp;
  // 鼠标贴边：判真屏幕边缘（HUD 压在画布上时同样生效），但压在按钮/卡片上不算
  if (app.edgeScroll !== false && app.mouse.inside && !app.box) {
    const ESP = 1100 * dt;
    const edge = 40;
    const W = window.innerWidth, H = window.innerHeight;
    const mx = app.mouse.clientX, my = app.mouse.clientY;
    let ex = 0, ey = 0;
    if (mx <= edge) ex = -1; else if (mx >= W - edge) ex = 1;
    if (my <= edge) ey = -1; else if (my >= H - edge) ey = 1;
    if (ex || ey) {
      const el = document.elementFromPoint(mx, my);
      const onCtrl = el && el.closest
        ? el.closest('button, input, select, textarea, .build, .tb-btn, .mapbtn, .card, .unitinfo, #battlelog, #skillbar .skill')
        : null;
      if (!onCtrl) {
        const k = (ex && ey) ? Math.SQRT1_2 : 1;
        dx += ex * ESP * k;
        dy += ey * ESP * k;
      }
    }
  }
  if (dx || dy) { app.cam.x += dx; app.cam.y += dy; clampCam(); }
}

function tileFromEvent(e) {
  const p = posFromEvent(e);
  const T = app.map.tile;
  return { tx: Math.floor(p.x / T), ty: Math.floor(p.y / T), x: p.x, y: p.y };
}

const inBounds = (p) => p.tx >= 0 && p.ty >= 0 && p.tx < app.map.w && p.ty < app.map.h;
const canCommand = () => app.state === STATE.PREP || app.state === STATE.BATTLE;

function unitAt(x, y) {
  // 楼内单位不参与点击命中（点楼才能选）
  const run = app.run;
  if (!run) return null;
  let best = null, bestD = Infinity;
  for (const u of run.units) {
    // 图标画得比格子大，命中半径也放宽；行军中的单位常跨两格，按像素距离判定
    const r = u.inside ? 13 : Math.max(UNITS[u.kind].r + 6, 18);
    const d = (u.x - x) ** 2 + (u.y - y) ** 2;
    if (d <= r * r && d < bestD) { bestD = d; best = u; }
  }
  return best;
}

// 叛军（第三方）点击命中：单独一套，避免混进玩家多选
function raiderAt(x, y) {
  const run = app.run;
  if (!run || !run.raiderOn || !run.raiders || !run.raiders.length) return null;
  let best = null, bestD = Infinity;
  for (const r of run.raiders) {
    if (r.hp <= 0) continue;
    const rr = Math.max((r.r || 10) + 6, 18);
    const d = (r.x - x) ** 2 + (r.y - y) ** 2;
    if (d <= rr * rr && d < bestD) { bestD = d; best = r; }
  }
  return best;
}

// 进入技能施放模式（Q 炮击 / E 燃烧弹）
function enterSkill(id) {
  const run = app.run;
  if (!run || (app.state !== STATE.PREP && app.state !== STATE.BATTLE)) return;
  const cd = run.skills[id] || 0;
  if (cd > 0) { sfx.deny(); toast(`${SKILLS[id].name} 冷却中：${Math.ceil(cd)}s`); return; }
  const cost = SKILLS[id].cost || 0;
  if (cost > 0 && run.supply < cost) {
    sfx.deny();
    toast(`${SKILLS[id].name} 需要 ${cost} 资金，当前 ${Math.floor(run.supply)}`);
    return;
  }
  app.skillMode = id;
  app.tool = { kind: 'select' };
  app.sel.clear();
  sfx.click();
  toast(`${SKILLS[id].name}：左键选位置，右键/Esc 取消`);
}

// 英雄技能：手雷要选落点，战吼是即时圈
function enterHeroSkill(sid) {
  const run = app.run;
  if (!run || (app.state !== STATE.PREP && app.state !== STATE.BATTLE)) return;
  const sk = HERO_SKILLS[sid];
  if (!sk) return;
  const h = heroOf(run);
  if (!h) { sfx.deny(); toast('指挥官不在场（建造或等他归队）'); return; }
  const cd = (run.heroCd && run.heroCd[sid]) || 0;
  if (cd > 0) { sfx.deny(); toast(`${sk.name} 冷却中：${Math.ceil(cd)}s`); return; }
  if (sid === 'warcry' || sid === 'adrenaline') {
    const r0 = castHeroSkill(run, sid);
    if (r0.ok) {
      sfx.click();
      toast(sid === 'warcry'
        ? `战吼：周围单位 ${sk.dur} 秒强化（伤害 +${Math.round((sk.dmgMul - 1) * 100)}%）`
        : `肾上腺素：回复 ${Math.round(h.maxHp * sk.healPct)} 生命，${sk.dur} 秒移速 +${Math.round((sk.speedMul - 1) * 100)}%`);
    } else sfx.deny();
    refreshHud(true);
    return;
  }
  app.skillMode = 'hero:' + sid;
  app.tool = { kind: 'select' };
  app.sel.clear();
  sfx.click();
  toast(sid === 'grapple'
    ? `钩爪：左键点空地→拉过去 / 点敌人→撞过去（${sk.dmg} 伤）/ 点建筑→直接入驻 · 射程 ${sk.range}`
    : `${sk.name}：左键选落点（射程 ${sk.range}），右键/Esc 取消`);
}

function castAt(p) {
  const run = app.run;
  const id = app.skillMode;
  if (!run || !id) return;
  const heroSid = id.startsWith('hero:') ? id.slice(5) : null;
  const r = heroSid ? castHeroSkill(run, heroSid, p.x, p.y) : castSkill(run, id, p.x, p.y);
  if (!r.ok) {
    sfx.deny();
    if (r.reason === 'nohero') toast('指挥官不在场');
    else if (r.reason === 'range') toast(heroSid === 'grapple' ? '超出射程：钩爪只有 5 格' : '超出射程：靠近一点再扔');
    else if (r.reason === 'blocked') toast('中间有建筑或障碍挡着，钩不到');
    else if (r.reason === 'full') toast('那栋楼里站满了');
    else toast(r.reason === 'cd' ? `冷却中：${Math.ceil(r.left)}s`
        : r.reason === 'supply' ? `资金不足：需 ${r.need}` : '当前不能放技能');;
  } else {
    if (heroSid === 'grapple') sfx.hook(p.x, p.y);
    else sfx.click();
    if (sfx.voice && !heroSid) sfx.voice('come_in', p.x, p.y);
    app.skillMode = null;
  }
  refreshHud(true);
}

// X 键：拆除模式开关（再按一次退出）。拆除模式本身有可见提示（底栏琥珀边 + 提示行换文案 +
// hover 红框），所以单按进入不会误触；想拆掉自己造的单位，也是进拆除模式后点它（返还 50%）。
function requestDemolish() {
  const run = app.run;
  if (!run) return;
  const on = app.tool.kind === 'demolish';
  app.tool = { kind: on ? 'select' : 'demolish' };
  sfx.click();
  toast(
    on
      ? '已退出拆除模式'
      : '拆除模式：左键点建筑 / 工事 / 单位拆除（返还 50%）· 右键或 Esc 退出',
    on ? undefined : 3000,
  );
  refreshHud(true);
}

function prepClick(p) {
  const run = app.run;
  if (!run) return false;
  if (app.tool.kind === 'demolish') {
    if (demolishAt(run, p.tx, p.ty)) { sfx.sell(); toast('已拆除（或取消队列），按比例退还'); return true; }
    return false;
  }
  if (app.tool.kind === 'select') return false;
  const def = app.tool.kind === 'unit' ? UNITS[app.tool.id] : FORTS[app.tool.id];
  if (!app.srcId || !canProduce(run, app.srcId, app.tool.id)) {
    sfx.deny();
    toast(app.srcId ? '这个建筑造不了它' : '先点选据点 / 兵营 / 载具工厂');
    return false;
  }
  if (run.supply < def.cost) { sfx.deny(); toast('资金不足'); return false; }
  if ((run.parts || 0) < (def.parts || 0)) { sfx.deny(); toast(`零件不足（需 ${def.parts}）`); return false; }
  if (popLeft(run) < (def.pop || 0)) { sfx.deny(); toast(`人口不够（${popUsed(run)}/${popCap(run)}）：人口随波次增长，清波即涨`); return false; }
  const r0 = enqueueAt(run, app.tool.kind, app.tool.id, p.tx, p.ty, app.srcId);
  if (!r0.ok) {
    sfx.deny();
    const msg = {
      occupied: '这格已经有东西了',
      terrain: '这里不能建',
      'road-tower': '马路上没地基，炮台要放在平地/高地',
    'road-fort': '马路上不能盖兵营/载具工厂，请换到街区里',
      'deploy-range': `超出${(sourceOf(run, app.srcId) || {}).name || '据点'}的出兵范围（${(sourceOf(run, app.srcId) || {}).deployRadius || run.build.deployRadius} 格内）`,
      'tower-range': `超出炮台建造范围（${run.build.towerRadius} 格）`,
      'fort-range': `超出建造范围（工兵 3 格 / 据点 5 格）`,
    'need-engineer': '载具工厂只能由工兵建造',
      supply: '资金不足',
      parts: '零件不足',
      pop: '人口不足（人口随波次增长，清波即涨）',
      cd: `炮台冷却中：还剩 ${Math.ceil(r0.cd || 0)} 秒（每种炮台各自 10 秒）`,
      locked: `第 ${r0.wave || 1} 波解锁`, // 未到解锁波次
      require: '需要先建 1 座兵营',
      limit: (() => {
        const caps = RULE.caps || {};
        const d = app.tool.kind === 'unit' ? UNITS[app.tool.id] : null;
        if (d && d.type === '炮台') {
          const per = caps[app.tool.id] != null ? caps[app.tool.id] : caps.turret;
          return `已达上限：${d.name}最多 ${per} 座（炮台类合计 ${caps.towTotal} 座）`;
        }
        if (d && d.type === '载具' && caps[app.tool.id] != null) {
          return `已达上限：${d.name}最多 ${caps[app.tool.id]} 辆`;
        }
        return '每座兵营只能带 1 座载具工厂';
      })(),
    }[r0.reason] || '这里放不下';
    toast(msg);
    return false;
  }
  sfx.build();
  return true;
}

// 右键：有选中单位 → 移动；否则拆除
function exitBuild(msg) {
  app.tool = { kind: 'select' };
  app.patrolFrom = null;
  app.sel.clear();
  app.skillMode = null;
  app.skillPreview = null;
  app.drag = null;
  app.box = null;
  closeSource();
  refreshHud(true);
  if (msg !== false) toast(msg || '已退出建造');
}

function toggleHoldFire() {
  const run = app.run;
  if (!run || !app.sel.size) { sfx.deny(); toast('先选中单位，再切停火'); return; }
  const ids = [...app.sel];
  const units = ids.map((id) => run.units.find((u) => u.id === id)).filter(Boolean);
  const allHold = units.length > 0 && units.every((u) => u.stance === STANCE.HOLD);
  const k = setStance(run, ids, allHold ? STANCE.FREE : STANCE.HOLD);
  if (k > 0) {
    sfx.click();
    toast(allHold ? `解除停火：${k} 队恢复自动开火` : `停火：${k} 队（不索敌、不开火，仍可移动）`);
  }
  syncStanceButtons();
  refreshHud(true);
}

function toggleDeploySel() {
  const run = app.run;
  if (!run || !canCommand() || !app.sel.size) { sfx.deny(); toast('先选中机枪组，再按 G 架设'); return; }
  const ids = [...app.sel];
  const wasOn = ids.some((id) => { const u = run.units.find((x) => x.id === id); return u && (u.depOn || u.depDir > 0); });
  const n = toggleDeploy(run, ids);
  if (n === -1) { sfx.deny(); toast('选中里没有可架设的单位（只有机枪组能架设）'); return; }
  sfx.click();
  toast(wasOn ? `收起架设：${n} 队（1.5s 后可移动）` : `开始架设：${n} 队（2.0s 后开火，受伤 -10%）`);
  syncStanceButtons();
  refreshHud(true);
}

function startPatrolMode() {
  const run = app.run;
  if (!run) return;
  // 再按一次 T / 再点一次按钮就退出（和 X 拆除模式一致）
  if (app.tool.kind === 'patrol') {
    app.tool = { kind: 'select' };
    app.patrolFrom = null;
    sfx.click();
    toast('已退出巡逻模式');
    syncStanceButtons();
    refreshHud(true);
    return;
  }
  if (!app.sel.size) { sfx.deny(); toast('先选中要巡逻的单位（固定炮台不能巡逻）'); return; }
  app.tool = { kind: 'patrol' };
  app.patrolFrom = null;
  sfx.click();
  toast('巡逻模式：左键点起点 → 再点终点 · 右键 / Esc / T 退出', 3200);
  syncStanceButtons();
  refreshHud(true);
}

function patrolClick(p) {
  const run = app.run;
  if (!run || !app.sel.size) { toast('先选中要巡逻的单位'); return; }
  if (!app.patrolFrom) {
    app.patrolFrom = { x: p.tx, y: p.ty };
    sfx.click();
    toast('巡逻起点已设，再点终点');
    return;
  }
  const a = app.patrolFrom;
  const k = setPatrol(run, [...app.sel], a.x, a.y, p.tx, p.ty);
  app.patrolFrom = null;
  app.tool = { kind: 'select' };
  if (k > 0) { sfx.click(); toast(`巡逻：${k} 队往返 ${a.x},${a.y} ↔ ${p.tx},${p.ty}`); }
  else { sfx.deny(); toast('这些单位不能巡逻：固定炮台、楼内单位（先出楼）或读条中'); }
  syncStanceButtons();
  refreshHud(true);
}

// 手动换弹：只有弹量 <= 上限一半（向上取整）时才允许，读条开始后不可取消
function reloadSel() {
  const run = app.run;
  if (!run || !app.sel.size) { sfx.deny(); toast('先选中单位，再按 R 换弹'); return; }
  const res = manualReload(run, [...app.sel]);
  if (res.ok > 0) { sfx.click(); toast(`换弹：${res.ok} 队装填 ${res.secs.toFixed(1)}s（期间不能开火）`); }
  else if (res.busy > 0) { sfx.deny(); toast('选中单位正在换弹'); }
  else if (res.full > 0) { sfx.deny(); toast('弹量还在一半以上，不用换'); }
  else if (res.nomag > 0) { sfx.deny(); toast('选中的单位没有弹夹（炮台 / 工事不换弹）'); }
  else { sfx.deny(); toast('没有可换弹的单位'); }
  syncStanceButtons();
  refreshHud(true);
}

// 换弹按钮可用态：选中里至少一队「有弹夹 + 不在读条 + 弹量 <= 一半」
function syncReloadBtn() {
  const btn = $('btn-reload');
  if (!btn) return;
  const run = app.run;
  const units = run && app.sel.size ? [...app.sel].map((id) => run.units.find((u) => u.id === id)).filter(Boolean) : [];
  const ready = units.some((u) => {
    const mg = UNITS[u.kind] && UNITS[u.kind].mag;
    return !!mg && u.reloadT <= 0 && u.ammo <= Math.ceil(mg.size * 0.5);
  });
  const anyMag = units.some((u) => UNITS[u.kind] && UNITS[u.kind].mag);
  // 两级灰：没有弹夹 = 该单位根本没这条指令（.na，不可点）；
  // 有弹夹但弹药还够 / 正在读条 = 只是暂时不用换（.full，可点，点了给提示）
  // 没有弹夹 = 这条指令不存在（不是"暂时不可用"）—— 直接隐藏，把格子让给建造项
  btn.classList.toggle('hide', !anyMag);
  btn.classList.toggle('na', false);
  btn.classList.toggle('full', anyMag && !ready);
  btn.classList.remove('poor');
  btn.disabled = !anyMag;
  btn.title = anyMag
    ? (ready ? '弹量 <= 一半，可以换弹（R）' : '弹量还在一半以上，暂时不用换（R）')
    : '选中的单位没有弹夹';
}

// 按钮点亮：选中单位是否处于停火 / 巡逻模式
function syncStanceButtons() {
  const run = app.run;
  const hold = $('btn-hold'), patrol = $('btn-patrol'), dep = $('btn-deploy');
  if (!hold || !patrol) return;
  const units = run && app.sel.size ? [...app.sel].map((id) => run.units.find((u) => u.id === id)).filter(Boolean) : [];
  const anyHold = units.length > 0 && units.every((u) => u.stance === STANCE.HOLD);
  const anyPatrol = app.tool.kind === 'patrol';
  hold.classList.toggle('active', anyHold);
  patrol.classList.toggle('active', anyPatrol);
  hold.classList.toggle('poor', units.length === 0);
  patrol.classList.toggle('poor', units.length === 0);
  hold.classList.toggle('na', units.length === 0);
  patrol.classList.toggle('na', units.length === 0);
  // 巡逻格按能力出：只有「会走、又不需要玩家手动瞄目标」的单位才给。
  // 工兵带 noPatrol（它的 repair 是右键指定目标修，不是自动巡查），不给这一格，
  // 省下的宽度是底栏 680 版式里工兵 10 格放得下的关键。
  {
    const canPatrol = units.some((u) => UNITS[u.kind].mobile && !UNITS[u.kind].noPatrol);
    patrol.classList.toggle('hide', !canPatrol);
  }
  const dotHold = hold.querySelector('.dot');
  if (dotHold) dotHold.classList.toggle('on', anyHold);
  const dotPatrol = patrol.querySelector('.dot');
  if (dotPatrol) dotPatrol.classList.toggle('on', anyPatrol);
  if (dep) {
    const depu = units.filter((u) => UNITS[u.kind].deploy);
    const anyOn = depu.some((u) => u.depOn || u.depDir > 0);
    dep.classList.toggle('active', anyOn);
    // 这个单位没有 deploy 字段（如工兵/步兵）时，架设这条指令根本不存在 —— 直接不渲染，
    // 别用 .na 占一个格子：底栏格子行是按 800px 手算的，多一格就会把后面的建造项挤出可视区
    dep.classList.toggle('hide', depu.length === 0);
    const lb = dep.querySelector('b');
    if (lb) lb.textContent = anyOn ? '收起' : '架设';
    const dotDep = dep.querySelector('.dot');
    if (dotDep) { dotDep.classList.add('dep'); dotDep.classList.toggle('on', anyOn); }
  }
  syncReloadBtn();
}

function rightClick(p) {
  const run = app.run;
  if (!run) return;
  // 建造 / 拆除 / 技能瞄准中：右键只做「退出」，不移动、不拆除
  if (app.tool.kind === 'unit' || app.tool.kind === 'fort' || app.tool.kind === 'demolish' || app.tool.kind === 'patrol' || app.skillMode) {
    exitBuild();
    sfx.click();
    return;
  }
  if (app.sel.size) {
    const selIds = [...app.sel];
    const selUnits = selIds.map((id) => run.units.find((u) => u.id === id)).filter(Boolean);
    const insideSel = selUnits.filter((u) => u.inside);
    const gb = garrisonAt(run, p.x, p.y, 0);
    // 一）选中的单位都在楼里
    if (insideSel.length && insideSel.length === selUnits.length) {
      const b0 = insideSel[0].inside;
      if (gb === b0) {
        // 点自己这栋楼 → 楼内自由走位
        const k2 = orderMoveInside(run, selIds, b0, p.tx, p.ty);
        if (k2 > 0) { sfx.click(); return; }
        sfx.deny(); toast('楼内只能走到真实的格子上'); return;
      }
      // 点楼外 → 读条出楼
      const k2 = orderUngarrison(run, selIds);
      if (k2 > 0) { sfx.click(); toast(`开始撤出建筑（${k2}队，读条中）`); return; }
      return;
    }
    // 二）点到可进入建筑 → 读条进入
    if (gb) {
      const k2 = orderGarrison(run, selIds, gb);
      if (k2 > 0) { sfx.click(); toast(`已命令 ${k2} 队前往建筑：到楼边自动读条进楼`); return; }
      sfx.deny();
      if (garrisonUsed(run, gb) >= garrisonCap(gb)) toast('楼内已满：将停在楼边等待');
      else toast('进不去：该类单位不能进入建筑');
      return;
    }
    const n = orderMove(run, selIds, p.tx, p.ty);
    if (n > 0) {
      sfx.click();
      if (sfx.voice && heroOf(run) && selIds.indexOf(heroOf(run).id) >= 0) sfx.voice('roger', p.x, p.y);
      return;
    }
    if (n === -1) { sfx.deny(); toast('工兵正在架炮，不能移动（等待造完或取消）'); return; }
  }
  // 只有拆除模式才拆；选择模式下右键空地不再误拆
  if (app.tool.kind === 'demolish') {
    if (demolishAt(run, p.tx, p.ty)) { sfx.sell(); toast('已拆除，返还 50% 补给'); }
  }
}

cv.addEventListener('mousemove', (e) => {
  app.mouse.clientX = e.clientX;
  app.mouse.clientY = e.clientY;
  app.mouse.inside = true;
  const p = tileFromEvent(e);
  app.hover = p;
  // 悬停自己的可架设单位（机枪组/自行火炮）时换成手型光标，提示"这里能按 G"
  const q0 = posFromEvent(e);
  const hv = unitAt(q0.x, q0.y);
  const hvDep = hv && UNITS[hv.kind] && UNITS[hv.kind].deploy && !hv.inside;
  if (hvDep !== !!app._curDep) {
    app._curDep = hvDep;
    cv.style.cursor = hvDep ? 'pointer' : '';
  }
  if (app.skillMode) app.skillPreview = { x: p.x, y: p.y };
  if (app.drag) { app.drag.ex = p.tx; app.drag.ey = p.ty; }
  if (app.box) {
    const q = posFromEvent(e);
    app.box.x1 = q.x; app.box.y1 = q.y;
  }
});

function fortAt(wx, wy) {
  const run = app.run;
  if (!run) return null;
  const T = run.map.tile;
  const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
  return run._fortTile.get(ty * run.map.w + tx) || null;
}


function nodeAt(x, y) {
  const run = app.run;
  if (!run || !run.nodes) return null;
  let best = null, bd = Infinity;
  for (const n of run.nodes) {
    const nx = (n.x + 0.5) * run.map.tile, ny = (n.y + 0.5) * run.map.tile;
    const d = Math.hypot(nx - x, ny - y);
    if (d <= run.map.tile * 0.75 && d < bd) { bd = d; best = n; }
  }
  return best;
}

function coreHit(x, y) {
  const run = app.run;
  if (!run) return false;
  const T = run.map.tile;
  const r = run.core.room;
  if (r) return x >= r.x * T && x < (r.x + r.w) * T && y >= r.y * T && y < (r.y + r.h) * T;
  const cx = (run.core.x + 0.5) * T, cy = (run.core.y + 0.5) * T;
  return Math.hypot(cx - x, cy - y) <= T * 0.85;
}

function clearPick() {
  app.selZ = null; app.selF = null; app.selNode = null; app.selCore = false;
  app.selTile = null;   // 选中实体时，上一次的地块选择要让位
  app.selRaid = null;
}


// 该格上有什么（单位优先，其次建筑）；用于「有东西的格子只选东西」
function occupantAt(p) {
  const run = app.run;
  if (!run) return null;
  const T = run.map.tile;
  const tx = Math.floor(p.x / T), ty = Math.floor(p.y / T);
  let bu = null, bd = Infinity;
  for (const u of run.units) {
    if (Math.floor(u.x / T) !== tx || Math.floor(u.y / T) !== ty) continue;
    const d = (u.x - p.x) ** 2 + (u.y - p.y) ** 2;
    if (d < bd) { bd = d; bu = u; }
  }
  if (bu) return { kind: 'unit', obj: bu };
  const f = run.forts.find((q) => {
    if (q.hp <= 0) return false;
    const sz = (FORTS[q.kind] && FORTS[q.kind].size) || 1;
    return tx >= q.tx && tx < q.tx + sz && ty >= q.ty && ty < q.ty + sz;
  });
  if (f) return { kind: 'fort', obj: f };
  return null;
}

function zombieAt(x, y) {
  const run = app.run;
  if (!run) return null;
  let best = null, bd = Infinity;
  for (const z of run.zombies) {
    if (z.hp <= 0) continue;
    const d = Math.hypot(z.x - x, z.y - y);
    const r = Math.max(11, z.size * 1.55);
    if (d <= r && d < bd) { bd = d; best = z; }
  }
  return best;
}

cv.addEventListener('mousedown', (e) => {
  const p = tileFromEvent(e);
  sfx.init(); sfx.resume();
  if (!inBounds(p)) return;

  if (!canCommand()) return;

  if (app.skillMode) {
    if (e.button === 2) { app.skillMode = null; toast('已取消'); return; }
    castAt(p);
    return;
  }

  if (e.button === 2) { rightClick(p); return; }

  if (app.tool.kind === 'patrol') { patrolClick(p); return; }


  // 拆除模式优先：先拆，别被「点工事=选中」的分支吃掉
  if ((app.state === STATE.PREP || app.state === STATE.BATTLE) && app.tool.kind === 'demolish') {
    if (demolishAt(app.run, p.tx, p.ty)) {
      sfx.sell();
      const r = app.run.lastRefund;
      toast(r && r.noRefund
        ? `已拆除 ${r.name}（唯一单位不退款，可回据点重新招募）`
        : r && (r.cash || r.parts)
          ? `已拆除 ${r.name}，返还 ${r.cash} 资金${r.parts ? ' / ' + r.parts + ' 零件' : ''}`
          : '已拆除（或取消队列），按比例退还');
    } else {
      sfx.deny();
      toast('这里没有可拆的东西（建筑 / 工事 / 单位）');
    }
    refreshHud(true);
    return;
  }

  // 左键
  const z = zombieAt(p.x, p.y);
  if (z) {
    if (app.sel.size) {
      app.selZ = z.id;
      app.selF = null; app.selNode = null; app.selCore = false; app.selTile = null;
      const mob = [...app.sel].filter((id) => {
        const q = run.units.find((x) => x.id === id);
        return q && UNITS[q.kind].mobile;
      });
      if (mob.length) orderMove(run, mob, Math.floor(z.x / app.map.tile), Math.floor(z.y / app.map.tile));
      toast(mob.length ? `移动到：${ZOMBIES[z.mob] ? ZOMBIES[z.mob].name : '僵尸'}（${mob.length} 队）` : '已选中目标');
      sfx.click();
      refreshHud(true);
      return;
    }
    app.sel.clear();
    clearPick();
    app.selZ = z.id;
    app.tool = { kind: 'select' };
    sfx.click();
    refreshHud(true);
    return;
  }

  // 叛军优先：点到自己人身上不误选，也方便看它的射程圈
  const rh = raiderAt(p.x, p.y);
  if (rh) {
    app.sel.clear();
    clearPick();
    app.selRaid = rh.id;
    app.tool = { kind: 'select' };
    sfx.click();
    refreshHud(true);
    return;
  }

  // 该格上站着单位/建筑 → 只选它，不落到空地
  const occ = occupantAt(p);
  // 单位优先：先按像素距离命中（图标比格子大、行军时常跨格）
  const uh = unitAt(p.x, p.y);
  if (uh) {
    clearPick();
    if (!e.shiftKey) app.sel.clear();
    if (app.sel.has(uh.id) && !e.shiftKey) app.sel.delete(uh.id);
    else app.sel.add(uh.id);
    app.selF = null; app.selZ = null;
    app.tool = { kind: 'select' };
    sfx.click(); refreshHud(true);
    const udef = UNITS[uh.kind];
    if (udef && udef.produces && udef.produces.length) { if (openSource(uh.id)) refreshProdPanel(); }
    else closeSource();
    return;
  }
  if (occ && occ.kind === 'fort') {
    const fo = occ.obj;
    app.sel.clear(); clearPick(); app.selF = fo.id;
    const fdef = FORTS[fo.kind];
    if (fdef && fdef.produces) openSource(fo.id); else closeSource();
    sfx.click(); refreshHud(true);
    return;
  }

  // 点据点：任何时候都优先选中并切换生产源（建造模式下也一样）
  if (coreHit(p.x, p.y)) {
    app.sel.clear(); clearPick();
    app.selCore = true;
    openSource('core');
    sfx.click(); refreshHud(true);
    return;
  }
  // 工事 / 兵营 / 资源点 / 据点：先尝试选中它们（仅在选择模式下）
  if (app.tool.kind === 'select') {
    const f = fortAt(p.x, p.y);
    if (f) {
      app.sel.clear(); clearPick(); app.selF = f.id;
      const fdef = FORTS[f.kind];
      if (fdef && fdef.produces) openSource(f.id); else closeSource();
      sfx.click(); refreshHud(true); return;
    }
    const nd = nodeAt(p.x, p.y);
    if (nd) { app.sel.clear(); clearPick(); app.selNode = nd.id; sfx.click(); refreshHud(true); return; }
    if (coreHit(p.x, p.y)) { app.sel.clear(); clearPick(); app.selCore = true; openSource('core'); sfx.click(); refreshHud(true); return; }
  }

  if ((app.state === STATE.PREP || app.state === STATE.BATTLE) && (app.tool.kind === 'unit' || app.tool.kind === 'fort')) {
    // 建造成功就继续造；点空地/超出范围 → 自动切到框选模式（而不是干决拒）
    if (prepClick(p)) return;
    app.justFailedBuild = true;
    app.tool = { kind: 'select' };
    refreshHud(true);
  } else if ((app.state === STATE.PREP || app.state === STATE.BATTLE) && app.tool.kind === 'demolish') {
    prepClick(p);
    return;
  }

  // 框选（也是建造失败后的落点）
  app.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  app.selZ = null;
  app.selTile = null;
  if (!e.shiftKey) app.sel.clear();
});

cv.addEventListener('mouseup', (e) => {
  if (!app.box) return;
  const b = app.box;
  app.box = null;
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
  const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  if (x1 - x0 < 6 && y1 - y0 < 6) {
    // 刚刚建造失败（比如超出生产源范围）→ 保留生产面板，不当成"点空地"
    if (app.justFailedBuild) { app.justFailedBuild = false; return; }
    // 单击空地：选中该地块并显示地形 buff
    const T = app.map.tile;
    closeSource();
    // 这里以前是手工逐个清，漏了 selRaid ⇒ 选中叛军后再点空地，面板还显示叛军。
    // clearPick() 就是干这事的（含 selTile），先清干净再设本格。
    app.sel.clear(); clearPick();
    app.selTile = { tx: Math.floor(x0 / T), ty: Math.floor(y0 / T) };
    refreshHud(true);
    return;
  }          // 单击空地＝取消选择
  const run = app.run;
  if (!run) return;
  for (const unit of run.units) {
    if (unit.x >= x0 && unit.x <= x1 && unit.y >= y0 && unit.y <= y1) app.sel.add(unit.id);
  }
  if (app.sel.size) {
    // 框选到单位 → 地块信息要让位
    app.selTile = null; app.selZ = null; app.selF = null; app.selNode = null; app.selCore = false;
    sfx.click(); app.tool = { kind: 'select' };
  }
  refreshHud(true);
});

// 指针离开 canvas 时只清悬停/拖拽；inside 交给窗口级监听，否则压到顶栏/底栏上就失去贴边滚动
cv.addEventListener('mouseleave', () => {
  app.hover = null; app.drag = null; app.box = null;
  if (app._curDep) { app._curDep = false; cv.style.cursor = ''; }
});

// 窗口级指针跟踪：贴边滚动要用到 HUD 上方/下方的坐标
document.addEventListener('mousemove', (e) => {
  app.mouse.clientX = e.clientX;
  app.mouse.clientY = e.clientY;
  app.mouse.inside = true;
});
document.addEventListener('mouseleave', () => { app.mouse.inside = false; });

cv.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!canCommand()) return;
  const p = tileFromEvent(e);
  rightClick(p);
});

// ---- 建造栏四分类折叠 ----
const BGROUP_OF = {
  infantry: 'inf', rocket: 'inf', mg: 'inf',
  vehicle: 'veh', tank: 'veh',
  turret: 'tow', mortar: 'tow', flame: 'tow',
  barricade: 'sup', wire: 'sup', mine: 'sup',
};
const collapsedGroups = new Set(
  (localStorage.getItem('dcl.bgroup') || 'veh,sup').split(',').filter(Boolean)
);
function applyGroups() {
  for (const el of document.querySelectorAll('.bitems[data-group]')) {
    el.classList.toggle('collapsed', collapsedGroups.has(el.dataset.group));
  }
  for (const h of document.querySelectorAll('.bhead[data-group]')) {
    const off = collapsedGroups.has(h.dataset.group);
    h.classList.toggle('off', off);
    h.classList.toggle('on', !off);
  }
  const hasActive = Object.entries(BGROUP_OF).some(([k, g]) =>
    !collapsedGroups.has(g) && app.tool && app.tool.id === k);
  void hasActive;
}
applyGroups();
for (const b of document.querySelectorAll('.bhead[data-group]')) {
  b.addEventListener('click', () => {
    const g = b.dataset.group;
    if (collapsedGroups.has(g)) collapsedGroups.delete(g); else collapsedGroups.add(g);
    applyGroups();
    try { localStorage.setItem('dcl.bgroup', [...collapsedGroups].join(',')); } catch (e) {}
  });
}
// 建造卡加完整成本提示（资金/零件/人口/耐久/护甲）
for (const b of document.querySelectorAll('#buildbar .build[data-id]')) {
  const id = b.dataset.id;
  const d = b.dataset.kind === 'unit' ? UNITS[id] : FORTS[id];
  if (!d) continue;
  const bits = [`资金 ${d.cost}`];
  if (d.parts) bits.push(`零件 ${d.parts}`);
  if (d.pop) bits.push(`人口 ${d.pop}`);
  if (d.hp) bits.push(`耐久 ${d.hp}`);
  if (d.armor) bits.push(`护甲 ${ARMOR_LABEL[d.armor]}`);
  if (d.buildTime) bits.push(`部署 ${d.buildTime}s`);
  b.title = `${d.name}：${bits.join(' · ')}`;
}

const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7'];

window.addEventListener('keyup', (e) => { app.keys.delete(e.key.toLowerCase()); });

window.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  // 方向键：按住移动视角
  // WASD / 方向键：按住移动视角（A 单独按也是平移，全选改为 Ctrl+A / H）
  // WASD / 方向键：按住平移视角。
  // 停火早就改到 C 了；S 现在只负责平移视角。
  const panKey = k === 'w' || k === 'a' || k === 'd' || k === 's';
  if (k.startsWith('arrow') || (panKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
    app.keys.add(k); e.preventDefault(); return;
  }
  sfx.init(); sfx.resume();

  // Esc：先退建造/拆除/取消技能，再才是暂停
  if (k === 'escape') {
    e.preventDefault();
    if (app.skillMode) { app.skillMode = null; app.skillPreview = null; toast('已取消'); refreshHud(true); return; }
    if (app.tool.kind === 'unit' || app.tool.kind === 'fort' || app.tool.kind === 'demolish') { exitBuild(); return; }
    togglePause();
    return;
  }
  if (k === 'p') { e.preventDefault(); togglePause(); return; }
  if (k === 'b' || k === 'k') {
    if (app.state === STATE.PREP || app.state === STATE.BATTLE) { e.preventDefault(); doSwap(k === 'b' ? 'buy' : 'sell'); }
    return;
  }
  // G 一个键两件事：架设 / 手雷。按「当前选中了什么」分流，
  // 和工具行里实际显示的那个按钮保持一致（架设按钮和手雷按钮不会同时出现）。
  //   选中里有能架设的单位（机枪组/火炮）→ 架设
  //   否则英雄在场            → 手雷
  //   都没有                   → 交给 toggleDeploySel() 给出提示
  if (k === 'g') {
    const run = app.run;
    const inGame = !!(run && (app.state === STATE.PREP || app.state === STATE.BATTLE));
    if (inGame) {
      let canSetUp = false;
      for (const id of app.sel) {
        const u = run.units.find((x) => x.id === id);
        if (u && UNITS[u.kind] && UNITS[u.kind].deploy) { canSetUp = true; break; }
      }
      if (canSetUp) { toggleDeploySel(); return; }
      if (heroOf(run)) { enterHeroSkill('grenade'); return; }
    }
    toggleDeploySel();
    return;
  }
  // F9：僵尸诊断（定位「不被瞄准/无敌」这类问题）
  if (k === 'f9') {
    e.preventDefault();
    const r = app.run;
    if (!r) return;
    const zs = r.zombies.filter((z) => z.hp > 0);
    if (!zs.length) { toast('当前没有存活僵尸'); return; }
    const bad = zs.filter((z) => z.inside || z.zInside || !Number.isFinite(z.x) || !Number.isFinite(z.y) || !Number.isFinite(z.hp));
    const near = zs.slice().sort((a, b) => Math.hypot(a.x - r.core.x, a.y - r.core.y) - Math.hypot(b.x - r.core.x, b.y - r.core.y))[0];
    toast(`僵尸 ${zs.length} 只，异常 ${bad.length} 只｜最近核心：${near.mob} hp=${near.hp} 位置=${Math.round(near.x)},${Math.round(near.y)} 楼内=${near.zInside ? 'Y' : '-'} 单位字段=${near.inside ? 'Y' : '-'}`);
    console.log('[F9] zombies', zs.length, 'bad', bad.length);
    console.log('[F9] near', JSON.stringify({ mob: near.mob, hp: near.hp, x: near.x, y: near.y, zInside: !!near.zInside, inside: !!near.inside, mode: near.mode, target: near.target && near.target.kind, eating: !!near.eating, path: near.path ? near.path.length : null }));
    if (bad.length) console.log('[F9] bad list', JSON.stringify(bad.slice(0, 8).map((z) => ({ id: z.id, mob: z.mob, hp: z.hp, x: z.x, y: z.y, zInside: !!z.zInside, inside: !!z.inside }))));
    return;
  }
  if (k === 'q') {
    if (e.shiftKey) { e.preventDefault(); enterHeroSkill('adrenaline'); return; }
    enterSkill('strike');
    return;
  }
  if (k === 'e') {
    if (e.shiftKey) { e.preventDefault(); enterHeroSkill('warcry'); return; }
    enterSkill('fire');
    return;
  }
  if (k === 'i') { enterSkill('airdrop'); return; }
  if (k === 'm') { setMuted(!app.muted); toast(app.muted ? '音效已关闭' : '音效已开启'); return; }
  if (k === 'r') {
    if (e.shiftKey) { if (app.state === STATE.PREP || app.state === STATE.BATTLE || app.state === STATE.RESULT) restart(); return; }
    reloadSel();
    return;
  }
  if (k === 'f3') { e.preventDefault(); app.debug = !app.debug; return; }

  if (canCommand()) {
    // Shift+1~9 存编队；Alt+1~9 召回编队（用 e.code 避开 Shift 变出的 !@#）
    const dm = /^Digit([1-9])$/.exec(e.code || '');
    if (dm) {
      const n = Number(dm[1]);
      if (e.shiftKey) { e.preventDefault(); saveGroup(n); return; }
      if (e.altKey) { e.preventDefault(); recallGroup(n); return; }
    }
    if (k === 'tab') { e.preventDefault(); cycleSource(e.shiftKey ? -1 : 1); return; }
    // 1~9 对应右侧生产面板的第 n 项
    const slot = HOTKEYS.indexOf(k);
    if (slot >= 0 && app.srcId && app.run) {
      const ids = producibleList(app.run, app.srcId);
      const id = ids[slot];
      if (id) {
        app.tool = UNITS[id] ? { kind: 'unit', id } : { kind: 'fort', id };
        refreshHud(true);
        return;
      }
    }
    if (k === 'x') requestDemolish();
    if (k === 'c') { toggleHoldFire(); return; }
    if (k === 't') { startPatrolMode(); return; }
    if (k === 'v') { app.tool = { kind: 'select' }; toast('选择/移动模式：左键框选，右键下达移动'); }
    if ((k === 'a' && (e.ctrlKey || e.metaKey)) || k === 'h') {
      app.sel.clear();
      for (const unit of app.run.units) if (UNITS[unit.kind].mobile) app.sel.add(unit.id);
      app.tool = { kind: 'select' };
      toast(`已选中 ${app.sel.size} 个可移动单位`);
    }
    if (k === ' ') {
      e.preventDefault();
      if (app.state === STATE.PREP) startBattleNow(); else togglePause();
    }
    refreshHud(true);
  }
  if (k === 'f' && e.shiftKey) {
    // 必须先判 shiftKey 再 return，否则会连带触发下面的倍速切换
    e.preventDefault();
    enterHeroSkill('grapple');
    return;
  }
  if (k === 'f' && canCommand()) cycleSpeed();
});

function startBattleNow() {
  const run = app.run;
  if (!run || run.phase !== PHASE.PREP) return;
  // 波间提前开战：按剩余整备时间返补给（使想多休息就得牺牲资源）
  if (run.waveIndex > 1) {
    const bonus = Math.max(0, Math.ceil(run.prepTimer));
    if (bonus > 0) {
      run.supply = Math.min(RULE.supply.cap, run.supply + bonus);
      toast(`提前开战：+${bonus} 补给`);
    }
  }
  startBattle(run);
  setState(STATE.BATTLE);
  sfx.wave(run.waveIndex);
}

function cycleSpeed() {
  // 倍速环：×1 → ×2 → ×4 → ×0.5 → ×1 …（0.5 倍用于微操，放在快档之后）
  const seq = [1, 2, 4, 0.5];
  app.speed = seq[(seq.indexOf(app.speed) + 1) % seq.length];
  sfx.click();
  toast(`速度 ×${app.speed}`);
}


// 标题页的说明文字全部写在 index.html 的按钮 data-desc 上（改文案只改那个文件）
// 这里只负责读出来显示
function mapDesc(kind) {
  const b = document.querySelector(`.mapbtn[data-map="${kind}"]`);
  return b ? (b.dataset.desc || '') : '';
}
function specHint(n) {
  const b = document.querySelector(`.mapbtn[data-spec="${n}"]`);
  return b ? (b.dataset.desc || '') : '';
}

// 切图后把特感档压到这张图允许的上限（老城没有狂暴档）
function applySpecCap() {
  const cap = specCapFor(app.mapKind);
  if (app.spec > cap) {
    const oldLabel = SPEC_SCHEMES[app.spec] ? SPEC_SCHEMES[app.spec].label : '?';
    setSpec(cap);
    toast(`${MAP_LABEL[app.mapKind] || '这张图'}不支持「${oldLabel}」，已切到「${SPEC_SCHEMES[cap].label}」`);
  } else {
    refreshSpecLocks();
  }
}

function selectMapSilent(kind) {
  app.mapKind = kind;
  document.querySelectorAll('.mapbtn[data-map]').forEach((b) => b.classList.toggle('active', b.dataset.map === kind));
  const d = $('map-desc');
  if (d) d.textContent = mapDesc(kind);
  applySpecCap();
}

function selectMap(kind) {
  if (!mapDesc(kind)) return;
  app.mapKind = kind;
  app.map = makeMap(kind);
  app.map._rev = (app.map._rev || 0) + 1;
  app.preview = makePreview(app.map);
  document.querySelectorAll('.mapbtn[data-map]').forEach((b) => b.classList.toggle('active', b.dataset.map === kind));
  const d = $('map-desc');
  if (d) d.textContent = mapDesc(kind);
  applySpecCap();
  syncPlayNote();
  toast(`已选择地图：${MAP_LABEL[kind]}`);
}

document.querySelectorAll('.mapbtn[data-map]').forEach((b) => {
  b.addEventListener('click', () => selectMap(b.dataset.map));
});

// ── 开始菜单：设置 / 帮助浮层 + 悬停高亮 ─────────────────────────────
const titlePanels = { settings: $('panel-settings'), help: $('panel-help') };
function showTitlePanel(which) {
  const p = titlePanels[which];
  if (p) p.classList.remove('hidden');
}
function hideTitlePanels() {
  for (const k in titlePanels) if (titlePanels[k]) titlePanels[k].classList.add('hidden');
}
// 让「开始游戏」与右侧立绘的眼睛同高；视口变化时重算
function alignMenuToEyes() {
  const hero = $('title-hero');
  const col = document.querySelector('.title-col');
  const play = $('btn-play');
  if (!hero || !col || !play) return;
  col.style.transform = '';
  const hr = hero.getBoundingClientRect();
  if (!hr.height) return;
  const eyeY = hr.top + hr.height * 0.27;
  const pr = play.getBoundingClientRect();
  const dy = Math.round(eyeY - (pr.top + pr.height / 2));
  col.style.transform = `translateY(calc(-52% + ${dy}px))`;
}

const SPEC_NOTE = { off: '关闭', normal: '标准', rage: '狂暴' };
function syncPlayNote() {
  const n = $('play-note');
  if (!n) return;
  const mapName = MAP_LABEL[app.mapKind] || app.mapKind;
  const sc = SPEC_SCHEMES[app.spec];
  const specName = sc ? (SPEC_NOTE[sc.key] || sc.label) : '?';
  n.textContent = `${mapName} · ${specName} · 叛军${app.raider ? '开' : '关'}`;
}
{
  const menuIds = ['btn-play', 'btn-settings', 'btn-help', 'btn-quit'];
  const setActive = (id) => {
    for (const mid of menuIds) {
      const b = $(mid);
      if (b) b.classList.toggle('active', mid === id);
    }
  };
  for (const id of menuIds) {
    const b = $(id);
    if (!b) continue;
    b.addEventListener('mouseenter', () => setActive(id));
    b.addEventListener('focus', () => setActive(id));
  }
  const bs = $('btn-settings');
  if (bs) bs.addEventListener('click', () => { initAudio(); sfx.click(); syncPlayNote(); showTitlePanel('settings'); });
  const bh = $('btn-help');
  if (bh) bh.addEventListener('click', () => { initAudio(); sfx.click(); showTitlePanel('help'); });
  const sd = $('btn-settings-done');
  if (sd) sd.addEventListener('click', () => { sfx.click(); hideTitlePanels(); setActive('btn-play'); syncPlayNote(); });
  const hd = $('btn-help-done');
  if (hd) hd.addEventListener('click', () => { sfx.click(); hideTitlePanels(); setActive('btn-play'); });
  // 重看新手引导：清掉「已看过」标记，回到标题页，下次开局会重新走一遍
  const ht = $('btn-help-tut');
  if (ht) ht.addEventListener('click', () => {
    sfx.click();
    try { localStorage.removeItem(TUT_KEY); } catch (e) {}
    hideTitlePanels();
    setActive('btn-play');
    // 标题页 #hud 是隐藏的，toast 看不到 ⇒ 直接在「开始游戏」右侧备注行给反馈
    const n = $('play-note');
    if (n) {
      const old = n.textContent;
      n.textContent = '✓ 已重置引导';
      setTimeout(() => { if (n.textContent === '✓ 已重置引导') { syncPlayNote(); } else { n.textContent = old; } }, 2400);
    }
  });
  const bq = $('btn-quit');
  if (bq) bq.addEventListener('click', () => {
    sfx.click();
    try { window.close(); } catch (e) {}
    setTimeout(() => { if (!document.hidden) toast('网页版无法关闭标签页：直接关掉这个页面即可'); }, 150);
  });
  syncPlayNote();
}

$('btn-play').addEventListener('click', () => {
  initAudio(); sfx.click();
  app.seed = Math.floor(Math.random() * 1e6) || 7;
  // 先黑幕盖住，再开局，最后淡出——掩盖开始界面与战场之间的画风跳变
  const fd = $('fade');
  if (fd) fd.classList.add('on');
  setTimeout(() => {
    startGame({ newSeed: true });
    if (fd) fd.classList.remove('on');
  }, 200);
});
$('btn-wave').addEventListener('click', startBattleNow);
$('hud-timer').addEventListener('click', () => { if (app.state === STATE.PREP) startBattleNow(); });
$('btn-speed').addEventListener('click', cycleSpeed);
$('btn-pause').addEventListener('click', togglePause);
$('btn-restart').addEventListener('click', restart);
$('btn-dmg').addEventListener('click', () => { setDamageNum(!app.damageNum); toast(app.damageNum ? '伤害数字已开' : '伤害数字已关'); });
$('btn-aggro').addEventListener('click', () => { setAggro((app.aggro + 1) % 3); toast('仇恨值：' + ['关闭', '轻度（只钉移动单位）', '完整（并聚到区域狙击）'][app.aggro]); });
for (const b2 of document.querySelectorAll('.mapbtn[data-spec]')) {
  b2.addEventListener('click', () => setSpec(Number(b2.dataset.spec)));
}
for (const b2 of document.querySelectorAll('.mapbtn[data-mode]')) {
  b2.addEventListener('click', () => setMode(b2.dataset.mode));
}
for (const b2 of document.querySelectorAll('.mapbtn[data-raider]')) {
  b2.addEventListener('click', () => {
    setRaider(b2.dataset.raider === '1');
    toast(app.raider ? '叛军：开启（第 5 波增援、第 8 波扑核心）' : '叛军：关闭');
  });
}
$('btn-zbar').addEventListener('click', () => { setZbar(!app.zbar); toast(app.zbar ? '僵尸血条已开' : '僵尸血条已关'); });
$('btn-decal').addEventListener('click', () => { setDecal(!app.decal); toast(app.decal ? '战场痕迹已开（尸体与焦痕）' : '战场痕迹已关'); });
// 按 SKILL_ORDER 统一绑定：新增技能只要加进 SKILLS + SKILL_ORDER + 一个按钮即可
for (const sid of SKILL_ORDER) {
  const btn = $('skill-' + sid);
  if (btn) btn.addEventListener('click', () => enterSkill(sid));
}
for (const sid of HERO_SKILL_ORDER) {
  const btn = $('skill-' + sid);
  if (btn) btn.addEventListener('click', () => enterHeroSkill(sid));
}
$('btn-path').addEventListener('click', () => { setShowPath(!app.showPath); toast(app.showPath ? '路径线已开' : '路径线已关'); });
$('btn-hudart').addEventListener('click', () => { setHudArt(!app.hudArt); toast(app.hudArt ? '立绘已开' : '立绘已关'); });
$('btn-edge').addEventListener('click', () => { setEdgeScroll(!app.edgeScroll); toast(app.edgeScroll ? '贴边滚动已开' : '贴边滚动已关'); });
$('btn-crit').addEventListener('click', () => { setCrit(!app.critOn); toast(app.critOn ? '暴击已开（下次开局生效）' : '暴击已关'); });
$('btn-zvary').addEventListener('click', () => { setZVary(!app.zVaryOn); toast(app.zVaryOn ? '行尸变异已开（下次开局生效）' : '行尸变异已关'); });
$('btn-ff').addEventListener('click', () => { setFf(!app.ffOn); });

// 核心升级三选一：点卡片选，超时由 game.js 自动选第一张
const perkRow = $('perk-row');
if (perkRow) {
  perkRow.addEventListener('click', (e) => {
    const el = e.target.closest('.perk');
    if (!el || !app.run) return;
      // 提示统一由 drainEvents 的 perk 分支发出（点击/超时共用一套文案），这里只负责选中
      pickPerk(app.run, Number(el.dataset.i));
  });
}
$('btn-sound').addEventListener('click', () => { setMuted(!app.muted); toast(app.muted ? '音效已关闭' : '音效已开启'); });
$('btn-retry').addEventListener('click', () => startGame({ seed: app.seed }));
$('btn-newmap').addEventListener('click', () => { startGame({ newSeed: true }); });
$('btn-home').addEventListener('click', () => setState(STATE.TITLE));
$('btn-resume').addEventListener('click', () => setPaused(false));
$('btn-pause-restart').addEventListener('click', () => { setPaused(false); restart(); });
$('btn-pause-home').addEventListener('click', () => { setPaused(false); setState(STATE.TITLE); });
$('btn-copy-seed').addEventListener('click', () => {
  const t = seedText();
  const text = `${t.label} · 种子 ${t.seed}\n?${t.url}`;
  const ok = () => toast(`已复制：${t.label} · 种子 ${t.seed}`);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok, () => toast(text));
  } else {
    toast(text);
  }
});

document.querySelectorAll('#buildbar .build[data-id]').forEach((btn) => {
  btn.addEventListener('click', () => {
    app.tool = { kind: btn.dataset.kind, id: btn.dataset.id };
    sfx.click();
    refreshHud(true);
  });
});
$('btn-demolish').addEventListener('click', () => {
  // 再点一次同一个按钮就退出，和 X 键的行为一致
  app.tool = { kind: app.tool.kind === 'demolish' ? 'select' : 'demolish' };
  sfx.click();
  refreshHud(true);
});
$('btn-select').addEventListener('click', () => { app.tool = { kind: 'select' }; sfx.click(); refreshHud(true); });
$('btn-hold').addEventListener('click', () => { toggleHoldFire(); });
$('btn-patrol').addEventListener('click', () => { startPatrolMode(); });
$('btn-deploy').addEventListener('click', () => { toggleDeploySel(); });
$('btn-reload').addEventListener('click', () => { reloadSel(); });

function boot() {
  const P = params();
  // 一次性 UI 绑定。历史上这几行被误放进 setSpec()，导致每次切换特感都重复 addEventListener
  bindVolumes();
  // 据点面板的双向兑换（资金 ↔ 零件），第二行是「一次换 10 次」的批量
  for (const [id, dir, n] of [['swap-buy', 'buy', 1], ['swap-sell', 'sell', 1], ['swap-buy10', 'buy', 10], ['swap-sell10', 'sell', 10]]) {
    const eb = $(id);
    if (eb) eb.addEventListener('click', (ev) => { ev.stopPropagation(); doSwap(dir, n); });
  }
  if (P.map && MAP_KINDS.includes(P.map)) {
    app.mapKind = P.map;
    app.map = makeMap(P.map);
  }
  app.debug = !!P.debug;
  const dmgPref = P.dmg != null ? String(P.dmg) !== '0' : localStorage.getItem('dcl.dmg') !== '0';
  app.damageNum = dmgPref;
  setDamageNum(dmgPref);
  setShowPath(P.path != null ? String(P.path) !== '0' : localStorage.getItem('dcl.path') !== '0');
  setHudArt(localStorage.getItem('dcl.hudart') === '1');
  setEdgeScroll(localStorage.getItem('dcl.edge') !== '0');
  setCrit(localStorage.getItem('dcl.crit') !== '0');   // 默认开
setZVary(localStorage.getItem('dcl.zvary') !== '0');
  setAggro(P.aggro != null ? parseInt(P.aggro, 10) : (parseInt(localStorage.getItem('dcl.aggro') || '1', 10) || 0));
  // 默认「标准」难度（0 关闭 / 1 标准 / 2 狂暴）；没存过偏好时用 1
  setSpec(P.spec != null ? parseInt(P.spec, 10) : (parseInt(localStorage.getItem('dcl.spec') || '1', 10) || 0));
  setZbar(P.zbar != null ? String(P.zbar) !== '0' : localStorage.getItem('dcl.zbar') !== '0');
  setDecal(P.decal != null ? String(P.decal) !== '0' : localStorage.getItem('dcl.decal') !== '0');
  setFf(P.ff != null ? String(P.ff) !== '0' : localStorage.getItem('dcl.ff') !== '0', true);
  app.god = !!P.god;
  setRaider(P.raider != null ? !!P.raider : localStorage.getItem('dcl.raider') !== '0');
  setMode(P.mode != null ? String(P.mode) : (localStorage.getItem('dcl.mode') || 'normal'));
  if (P.speed && P.speed > 0) app.speed = P.speed >= 8 ? 8 : P.speed;
  app.map._rev = 1;
  app.preview = makePreview(app.map);
  selectMapSilent(app.mapKind);
  setMuted(!!P.mute);
  const auraInit = P.aura === '0' ? false : (P.aura === '1' ? true : localStorage.getItem('dcl.aura') === '1');
  setShowAura(auraInit);
  const auraBtn = $('btn-aura');
  if (auraBtn) auraBtn.addEventListener('click', () => { setShowAura(!app.showAura); toast(app.showAura ? '光环显示开' : '光环显示已关（仍在回血）'); });
  loadSprites(() => { toast('素材已加载'); });
  setState(STATE.TITLE);
  if (P.panel === 'settings' || P.panel === 'help') showTitlePanel(P.panel);
  alignMenuToEyes();
  window.addEventListener('resize', alignMenuToEyes);
  document.querySelectorAll('#buildbar .build[data-id]').forEach((b) => b.classList.remove('active'));
  $('btn-select').classList.add('active');

  const wantState = P.state || 'title';
  if (wantState === 'prep' || wantState === 'battle' || wantState === 'play') {
    startGame({ seed: P.seed || 0, auto: P.auto, wave: P.wave || 0, pause: P.pause === true });
  } else if (wantState === 'title' && P.auto) {
    startGame({ seed: P.seed || 0, auto: true, wave: P.wave || 0, pause: P.pause === true });
  }
  const VER = 'raid-2026-11-12';
  window.__dclBuild = VER;
  const verEl = $('build-ver');
  if (verEl) verEl.textContent = `版本 ${VER}`;
  window.__dcl = app; // 调试入口：控制台可查 run / map / sel
  requestAnimationFrame(loop);
}

boot();
