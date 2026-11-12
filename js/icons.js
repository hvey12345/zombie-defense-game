// js/icons.js — 统一使用 game-icons.net 的 SVG 图标作为游戏内所有单位/工事/据点的形象
// 图标是纯白字形，这里按颜色预渲染成离屏 canvas，绘制时直接 drawImage，避免每帧染色。
import { UNITS, FORTS, ZOMBIES } from './data.js';

const ICON_SRC = {
  infantry: 'assets/icons/infantry.png',
  turret: 'assets/icons/turret.png',
  vehicle: 'assets/icons/humvee.png',
  humvee: 'assets/icons/humvee.png',
  tank: 'assets/icons/tank.png',
  rocket: 'assets/icons/rocket.png',
  mortar: 'assets/icons/mortar.png',
  flame: 'assets/icons/flame.png',
  barricade: 'assets/icons/barricade.png',
  wire: 'assets/icons/wire.png',
  mine: 'assets/icons/mine.png',
  zombie: 'assets/icons/zombie.png',
  core: 'assets/icons/core.png',
  factory: 'assets/icons/factory.png',
  barracks: 'assets/icons/barracks.png',
  charger: 'assets/icons/charger.png',
  hunter: 'assets/icons/hunter.png',
  spitter: 'assets/icons/spitter.png',
  smoker: 'assets/icons/smoker.png',
  behemoth: 'assets/icons/behemoth.png',
  screamer: 'assets/icons/screamer.png',
  supply: 'assets/icons/supply.png',
  shotgun: 'assets/icons/shotgun.png',
  sniper: 'assets/icons/sniper.png',
  medic: 'assets/icons/medic.png',
  mg: 'assets/icons/mg.png',
  engineer: 'assets/icons/engineer.png',
  howitzer: 'assets/icons/howitzer.png',
  wave: 'assets/icons/wave.png',
  demolish: 'assets/icons/demolish.png',
  flamer: 'assets/icons/flamer.png',
  lmg: 'assets/icons/lmg.png',
  skill_strike: 'assets/icons/skill_strike.png',
  skill_fire: 'assets/icons/skill_fire.png',
  skill_grenade: 'assets/icons/skill_grenade.png',
  skill_warcry: 'assets/icons/skill_warcry.png',
  skill_adrenaline: 'assets/icons/skill_adrenaline.png',
  skill_grapple: 'assets/icons/skill_grapple.png',
  hero: 'assets/icons/hero.png',
  raidervehicle: 'assets/icons/raidervehicle.png',
};

// 全彩图标白名单：名单内的图「不染色」，按原图上色绘制。
// 默认图标都是纯白剪影（game-icons.net 风格），绘制时用 source-in 重染成单位颜色；
// 如果你换成彩色立绘/像素图，把名字加到这里即可保留原色。
const FULL_COLOR = new Set([
  // 'tank',
]);

// 图标版本号：改图后加一，强制浏览器重新下载（避免旧图被 304 缓存）
const ICON_VER = 31;
const RAW = {};          // 原始 <img>
const TINTED = new Map(); // key = name|color → canvas

// 任何僵尸定义里写了 icons 数组，这里自动登记，不用逐张改 ICON_SRC
for (const z of Object.values(ZOMBIES)) {
  if (Array.isArray(z.icons)) {
    for (const n of z.icons) ICON_SRC[n] = 'assets/icons/' + n + '.png';
  }
}

export function loadIcons(onDone) {
  const names = Object.keys(ICON_SRC);
  if (!names.length) { onDone && onDone(); return; }
  let left = names.length;
  for (const n of names) {
    const img = new Image();
    img.onload = () => { RAW[n] = img; if (--left === 0 && onDone) onDone(); };
    img.onerror = () => { if (--left === 0 && onDone) onDone(); };
    img.src = ICON_SRC[n] + '?v=' + ICON_VER;
  }
}

// 供 <img> 用的原始路径（面板/建造栏）；png 与 svg 混用时避免拼死扩展名
export function iconPath(name) {
  return ICON_SRC[name] || ('assets/icons/' + name + '.png');
}

// 取一张按颜色染好的图标（缓存）
export function icon(name, color) {
  const raw = RAW[name];
  if (!raw) return null;
  if (FULL_COLOR.has(name)) return raw;   // 全彩图：不染色，直接画原图
  const key = name + '|' + color;
  let cv = TINTED.get(key);
  if (cv) return cv;
  const S = 96;
  cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.drawImage(raw, 0, 0, S, S);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, S, S);
  TINTED.set(key, cv);
  return cv;
}

// 各单位的图标配色
export const ICON_COLOR = {
  infantry: '#67d0ff',
  turret: '#4fb2ef',
  vehicle: '#8fe0c0',
  tank: '#7fd6a8',
  rocket: '#ffc46b',
  mortar: '#bfa8ff',
  flame: '#ff9a5c',
  barricade: '#a8b6c4',
  wire: '#8f9db0',
  zombie: '#e2594a',
  brute: '#b23a2e',
  core: '#e8c15a',
  factory: '#c9d6e6',
  barracks: '#dfe8f3',
  shotgun: '#ffd08a',
  flamer: '#ff8f52',
  lmg: '#a9d8ff',
  sniper: '#c8b4ff',
  medic: '#8fffb0',
  engineer: '#ffcf6b',
  howitzer: '#ffb066',
  mg: '#3fb8ff',
  hero: '#ffd75e',
  mine: '#e8c15a',
  charger: '#ff7a45',
  hunter: '#d56bff',
  spitter: '#7dff8a',
  smoker: '#b8b8b8',
  behemoth: '#ff3b6b',
  screamer: '#dc78ff',
};

export function unitIcon(kind) { return icon(UNITS[kind].icon || kind, ICON_COLOR[kind]); }
export function fortIcon(kind) { return icon(FORTS[kind].icon || kind, ICON_COLOR[kind]); }
