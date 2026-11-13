// js/art.js — 只画，不改状态。零贴图，纯几何。
import { TILE, TERRAIN, UNITS, FORTS, ZOMBIES, RULE, NODE_TYPES, GARRISON, HERO_SKILLS } from './data.js';
import { icon, unitIcon, fortIcon, loadIcons, ICON_TOTAL, ICON_COLOR } from './icons.js';
import { chargeLane, stompRing, unitRank } from './game.js';

const PAL = Object.freeze({
  bg: '#14181d',
  grid: 'rgba(255,255,255,0.035)',
  ground: '#1a2028',
  road: '#222a33',
  roadLine: 'rgba(255,255,255,0.05)',
  rubble: '#2b333d',
  building: '#39424e',
  buildingEdge: '#4a5563',
  buildingHp: 'rgba(224,96,58,0.85)',
  friendly: '#4fa3d9',
  friendlyDim: 'rgba(79,163,217,0.35)',
  fort: '#8b98a6',
  fortDim: 'rgba(139,152,166,0.35)',
  zombie: '#c0453c',
  zombieBrute: '#8e322c',
  core: '#e0b341',
  danger: '#e0603a',
  ghostOk: 'rgba(79,163,217,0.28)',
  ghostBad: 'rgba(224,96,58,0.28)',
  ghostEdgeOk: 'rgba(79,163,217,0.85)',
  ghostEdgeBad: 'rgba(224,96,58,0.85)',
  rangeRing: 'rgba(79,163,217,0.16)',
  path: 'rgba(224,96,58,0.25)',
});

const SPRITE_SRC = {
  soldier: 'assets/sprites/soldier.png',
  zombie: 'assets/sprites/zombie.png',
  vehicle: 'assets/sprites/vehicle.png',
};

const SPRITES = {};

// 帖图自身的朝向修正：素材默认朝东为 0，车头朝北的要 +90°

export function loadSprites(onDone, onProgress) {
  // 总量 = 图标数 + 3 张贴图，进度条按这个走
  const names = Object.keys(SPRITE_SRC);
  const total = ICON_TOTAL + names.length;
  let done = 0;
  const tick = () => {
    done += 1;
    if (onProgress) onProgress(done, total);
    if (done >= total && onDone) onDone();
  };
  loadIcons(tick, tick);
  for (const n of names) {
    const img = new Image();
    img.onload = () => { SPRITES[n] = img; tick(); };
    img.onerror = () => { tick(); };
    img.src = SPRITE_SRC[n];
  }
}

// 旋转贴图：用 setTransform 代替 save/restore，600 僵尸时省一半开销
let terrainCache = null;
let terrainKey = '';

// 树贴图：想用自己画的树，把 PNG 放到 assets/icons/tree.png，
// 再把下面这一行改成 true 即可（默认 false = 用程序化画法，零额外请求）。
const USE_TREE_ICON = false;
const treeImg = new Image();
let treeImgOk = false;
if (USE_TREE_ICON) {
  treeImg.onload = () => { treeImgOk = true; terrainKey = ''; };   // 置空 key ⇒ 底图下一帧重绘
  treeImg.src = 'assets/icons/tree.png';
}

function makeTerrainLayer(map) {
  const T = map.tile;
  const cv = document.createElement('canvas');
  cv.width = map.w * T;
  cv.height = map.h * T;
  const g = cv.getContext('2d');
  g.fillStyle = PAL.bg;
  g.fillRect(0, 0, cv.width, cv.height);

  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const t = map.tiles[y * map.w + x];
      let base = TERRAIN[t].color;
      if (map.meta && map.meta.style === 'harbor') {
        // 灰港市：街道亮、街区暗，读起来像一张「路网图」
        if (t === TILE.ROAD) base = '#3b4757';
        else if (t === TILE.BUILDING) base = '#333b46';
        else if (t === TILE.GROUND) base = '#1b2129';
      }
      g.fillStyle = base;
      g.fillRect(x * T, y * T, T, T);
      if (t === TILE.WATER) {
        // 水面：两道横向波纹，让江面读起来是水
        g.fillStyle = 'rgba(120,180,220,0.10)';
        g.fillRect(x * T, y * T + ((x * 7 + y * 3) % 14) + 3, T, 2);
        if ((x + y) % 3 === 0) g.fillRect(x * T + 4, y * T + ((x * 5) % 12) + 9, T - 8, 1);
      }
      if (t === TILE.HIGHLAND) {
        // 高地：顶部提亮 + 等高线斜纹
        const grd = g.createLinearGradient(x * T, y * T, x * T, y * T + T);
        grd.addColorStop(0, 'rgba(255,255,255,0.10)');
        grd.addColorStop(1, 'rgba(0,0,0,0.18)');
        g.fillStyle = grd;
        g.fillRect(x * T, y * T, T, T);
        g.strokeStyle = 'rgba(150,180,205,0.16)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x * T + 2, y * T + T - 5);
        g.lineTo(x * T + T - 4, y * T + 5);
        g.stroke();
      }
      if (t === TILE.LOWLAND) {
        // 低地：下陷阴影 + 内边暗
        const grd = g.createLinearGradient(x * T, y * T, x * T, y * T + T);
        grd.addColorStop(0, 'rgba(0,0,0,0.30)');
        grd.addColorStop(0.55, 'rgba(0,0,0,0.06)');
        grd.addColorStop(1, 'rgba(90,140,180,0.06)');
        g.fillStyle = grd;
        g.fillRect(x * T, y * T, T, T);
      }
      if (t === TILE.BRIDGE) {
        // 桥面：亮木板 + 深色板缝 + 上下栏杆影
        g.fillStyle = 'rgba(206,176,128,0.66)';
        for (let i = 0; i < 4; i++) {
          g.fillRect(x * T + 1, y * T + 2 + i * 5, T - 2, 3);
        }
        g.fillStyle = 'rgba(24,16,8,0.34)';
        for (let i = 0; i < 4; i++) {
          g.fillRect(x * T + 1, y * T + 5 + i * 5, T - 2, 1);
        }
        g.fillStyle = 'rgba(0,0,0,0.42)';
        g.fillRect(x * T, y * T, T, 2);
        g.fillRect(x * T, y * T + T - 2, T, 2);
      }
      if (t === TILE.RUBBLE) {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        for (let i = 0; i < 3; i++) {
          g.fillRect(x * T + 4 + i * 6, y * T + 8 + ((i * 7) % 10), 4, 3);
        }
      }
    }
  }

  // 道路中线
    g.strokeStyle = PAL.roadLine;
    g.lineWidth = 2;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        if (map.tiles[y * map.w + x] !== TILE.ROAD) continue;
        g.beginPath();
        g.moveTo(x * T + T / 2, y * T + 2);
        g.lineTo(x * T + T / 2, y * T + T - 2);
        g.stroke();
      }
  }

  // 建筑体块
  for (const b of map.buildings) {
    if (b.hp <= 0) continue;
    const px = b.x * T, py = b.y * T, pw = b.w * T, ph = b.h * T;
    const isTree = b.tone === 'tree';
    const shaped = Array.isArray(b.cells) && b.cells.length && b.cells.length !== b.w * b.h;
    const rects = shaped
      ? b.cells.map(([dx, dy]) => [px + dx * T, py + dy * T, T, T])
      : [[px, py, pw, ph]];
    const cellSet = shaped ? new Set(b.cells.map(([cx, cy]) => cx + ',' + cy)) : null;
    for (const [rx, ry, rw, rh] of rects) {
      if (isTree) {
        drawTreeTile(g, rx, ry, rw, rh);
        continue;
      }
      const gx = shaped ? Math.round((rx - px) / T) : 0;
      const gy = shaped ? Math.round((ry - py) / T) : 0;
      if (!shaped) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(rx + 3, ry + 4, rw - 2, rh - 2);
      }
      // 填充：多格建筑整格铺满，相邻格之间不留缝（留缝会读成一格格瓷砖）
      g.fillStyle = b.garrison ? 'rgba(58,96,140,0.55)' : PAL.building;
      if (shaped) g.fillRect(rx, ry, rw, rh);
      else g.fillRect(rx + 1, ry + 1, rw - 2, rh - 2);
      // 轮廓：多格建筑只画外轮廓，四邻同属本楼的边不画
      g.strokeStyle = b.garrison ? 'rgba(120,190,255,0.75)' : PAL.buildingEdge;
      g.lineWidth = shaped ? 1.1 : (b.garrison ? 1.6 : 1);
      g.beginPath();
      if (!shaped) {
        g.rect(rx + 0.6, ry + 0.6, rw - 1.2, rh - 1.2);
      } else {
        if (!cellSet.has(gx + ',' + (gy - 1))) { g.moveTo(rx, ry + 0.5); g.lineTo(rx + rw, ry + 0.5); }
        if (!cellSet.has(gx + ',' + (gy + 1))) { g.moveTo(rx, ry + rh - 0.5); g.lineTo(rx + rw, ry + rh - 0.5); }
        if (!cellSet.has((gx - 1) + ',' + gy)) { g.moveTo(rx + 0.5, ry); g.lineTo(rx + 0.5, ry + rh); }
        if (!cellSet.has((gx + 1) + ',' + gy)) { g.moveTo(rx + rw - 0.5, ry); g.lineTo(rx + rw - 0.5, ry + rh); }
      }
      g.stroke();
      // 顶部高光
      g.fillStyle = b.garrison ? 'rgba(150,215,255,0.16)' : 'rgba(255,255,255,0.05)';
      if (shaped) g.fillRect(rx, ry, rw, 3);
      else g.fillRect(rx + 1, ry + 1, rw - 2, 3);
    }
    if (b.garrison) {
      g.strokeStyle = 'rgba(170,225,255,0.85)';
      g.lineWidth = 1.4;
      const anchor = anchorCell(b);
      const dx0 = px + anchor[0] * T + 4, dy0 = py + anchor[1] * T + T - 9;
      g.beginPath();
      g.moveTo(dx0, dy0 + 6); g.lineTo(dx0, dy0 + 1.5);
      g.lineTo(dx0 + 3.4, dy0 + 1.5); g.lineTo(dx0 + 3.4, dy0 + 6);
      g.stroke();
    }
    if (b.hp < b.maxHp) {
      const k = Math.max(0, b.hp / b.maxHp);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(px + 3, py + ph - 6, pw - 6, 3);
      g.fillStyle = PAL.buildingHp;
      g.fillRect(px + 3, py + ph - 6, (pw - 6) * k, 3);
    }
  }

  // 细网格
  g.strokeStyle = PAL.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= map.w; x++) { g.moveTo(x * T + 0.5, 0); g.lineTo(x * T + 0.5, map.h * T); }
  for (let y = 0; y <= map.h; y++) { g.moveTo(0, y * T + 0.5); g.lineTo(map.w * T, y * T + 0.5); }
  g.stroke();
  return cv;
}

function refreshTerrain(map) {
  const key = `${map._id || 'x'}:${map._rev || 0}`;
  if (!terrainCache || key !== terrainKey) {
    terrainCache = makeTerrainLayer(map);
    terrainKey = key;
  }
  return terrainCache;
}

function hpBar(g, x, y, w, h, k, color) {
  if (k >= 0.999) return;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(x, y, w, h);
  g.fillStyle = color;
  g.fillRect(x, y, w * Math.max(0, k), h);
}
// 弹药条：画在血条下方 2px，打空的弹夹用黄色表示换弹进度
function ammoBar(g, x, y, w, h, u, def) {
  const mg = def && def.mag;
  if (!mg) return;
  const size = mg.size || 1;
  const cur = (u.ammo === undefined) ? size : Math.max(0, Math.min(size, u.ammo));
  g.fillStyle = 'rgba(10,14,20,0.55)';
  g.fillRect(x, y, w, h);
  if (u.reloadT > 0) {
    const k2 = Math.max(0, Math.min(1, 1 - u.reloadT / (mg.reload || 1)));
    g.fillStyle = 'rgba(232,193,90,0.95)';
    g.fillRect(x, y, w * k2, h);
  } else {
    g.fillStyle = cur > 0 ? 'rgba(160,215,255,0.85)' : 'rgba(224,96,58,0.9)';
    g.fillRect(x, y, w * (cur / size), h);
  }
}


// 军衔角标：血条上方的小三角，1 个=老兵、2 个=精英（金色，和暴击同色系）
function rankPips(g, x, y, rank) {
  if (!rank) return;
  for (let i = 0; i < rank; i++) {
    const bx = x + 1 + i * 6;
    // 深色底衬一层，浅色地形上才不会糊掉
    g.fillStyle = 'rgba(8,12,18,0.75)';
    g.beginPath();
    g.moveTo(bx - 0.6, y + 1);
    g.lineTo(bx + 2.4, y - 4);
    g.lineTo(bx + 5.4, y + 1);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffcf3d';
    g.beginPath();
    g.moveTo(bx, y);
    g.lineTo(bx + 2.4, y - 3.4);
    g.lineTo(bx + 4.8, y);
    g.closePath();
    g.fill();
  }
}

// 树的绘制：一棵小圆冠树，固定占 1 格。想换成自己的图，只改这个函数即可
// （比如 g.drawImage(树图, rx, ry, rw, rh)）。
function drawTreeTile(g, rx, ry, rw, rh) {
  if (treeImgOk) {                       // 有贴图就用贴图（assets/icons/tree.png）
    g.drawImage(treeImg, rx + 1, ry + 1, rw - 2, rh - 2);
    return;
  }
  const cx = rx + rw / 2, cy = ry + rh / 2;
  const s = Math.min(rw, rh);
  // 地面影
  g.fillStyle = 'rgba(0,0,0,0.26)';
  g.beginPath();
  g.ellipse(cx, cy + s * 0.30, s * 0.34, s * 0.15, 0, 0, Math.PI * 2);
  g.fill();
  // 树干
  g.fillStyle = '#2a2318';
  g.fillRect(cx - s * 0.055, cy + s * 0.02, s * 0.11, s * 0.26);
  // 树冠：三团交叠，比单一方块更像树
  g.fillStyle = '#2f5238';
  for (const [ox, oy, r] of [[0, -0.07, 0.32], [-0.19, 0.10, 0.22], [0.18, 0.12, 0.20]]) {
    g.beginPath();
    g.arc(cx + ox * s, cy + oy * s, r * s, 0, Math.PI * 2);
    g.fill();
  }
  // 冠顶高光（小块，别糊住半个树冠）
  g.fillStyle = 'rgba(152,212,162,0.12)';
  g.beginPath();
  g.arc(cx - s * 0.10, cy - s * 0.17, s * 0.10, 0, Math.PI * 2);
  g.fill();
}

// 建筑锚点格：最靠下、其次最靠右的真实格（门牌/角标/血条都贴它）
function anchorCell(b) {
  if (!b || !Array.isArray(b.cells) || !b.cells.length) return [0, (b ? b.h : 1) - 1];
  let best = b.cells[0];
  for (const c of b.cells) {
    if (c[1] > best[1] || (c[1] === best[1] && c[0] > best[0])) best = c;
  }
  return best;
}

export function drawScene(ctx, run, view = {}) {
  const map = run.map, T = map.tile;
  const camX = view.cam ? view.cam.x : 0;
  // A2 渲染插值：只插值玩家单位与叛军（僵尸太多、太慢，插不插值肉眼无差）。
  // alpha = 尚未消耗的逻辑时间占一逻辑帧的比例，在「上一逻辑帧 -> 当前逻辑帧」之间线性插值，
  // 所以逻辑 60Hz 也能在 144Hz 屏幕上画成连续移动，不再每 2~3 帧重复同一位置。
  const IALPHA = view.alpha == null ? 1 : Math.max(0, Math.min(1, view.alpha));
  const vU = (o) => {
    if (IALPHA >= 1 || o.px == null || o.py == null) return o;
    const w = Object.create(o);
    w.x = o.px + (o.x - o.px) * IALPHA;
    w.y = o.py + (o.y - o.py) * IALPHA;
    return w;
  };
  const camY = view.cam ? view.cam.y : 0;
  const zoom = view.zoom || 1;
  // 视锥剔除：屏幕外的僵尸/单位直接跳过 400+ 个 drawImage
  const viewW = view.w || (ctx.canvas.width / zoom);
  const viewH = view.h || (ctx.canvas.height / zoom);
  const cpX = view.cx != null ? view.cx - viewW / 2 : camX;
  const cpY = view.cy != null ? view.cy - viewH / 2 : camY;
  const CULL = (typeof window !== 'undefined' && window.__dshMobile) ? 16 : 48;
  const cullX0 = cpX - CULL, cullY0 = cpY - CULL, cullX1 = cpX + viewW + CULL, cullY1 = cpY + viewH + CULL;
  const inView = (x, y) => x >= cullX0 && x <= cullX1 && y >= cullY0 && y <= cullY1;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  if (zoom !== 1) ctx.scale(zoom, zoom);
  ctx.translate(-Math.round(camX), -Math.round(camY));
  ctx.drawImage(refreshTerrain(map), 0, 0);

  // 选中单位的射程环
  if (view.selectedUnit) {
    const u = view.selectedUnit;
    ctx.beginPath();
    ctx.arc(u.x, u.y, UNITS[u.kind].range, 0, Math.PI * 2);
    ctx.fillStyle = PAL.rangeRing;
    ctx.fill();
    ctx.strokeStyle = PAL.friendlyDim;
    ctx.stroke();
  }

  // 地面区域：燃烧弹（橙）与敌方酸液（绿）
  if (run.zones) {
    for (const zn of run.zones) {
      const a = Math.min(1, zn.left / 1.2) * 0.18;
      ctx.beginPath();
      ctx.arc(zn.x, zn.y, zn.r, 0, Math.PI * 2);
      if (zn.side === 'enemy') {
        const pulse = 0.85 + Math.sin(run.time * 6 + zn.x * 0.5) * 0.15;
        ctx.fillStyle = `rgba(96,220,120,${Math.min(0.34, a * 1.7) * pulse})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(140,255,160,${0.7 * pulse})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        // 气泡：按格点伪随机，随 time 抖动
        for (let k = 0; k < 7; k++) {
          const ang = (k * 2.399 + zn.x * 0.017) % (Math.PI * 2);
          const rr = ((k * 37) % 100) / 100 * zn.r * 0.82;
          const bx = zn.x + Math.cos(ang) * rr;
          const by = zn.y + Math.sin(ang) * rr;
          const bob = Math.sin(run.time * 3.2 + k) * 1.6;
          const rad = 1.4 + ((k * 13) % 10) / 10 * 1.6;
          ctx.beginPath();
          ctx.arc(bx, by + bob, rad, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(190,255,200,${0.30 * pulse})`;
          ctx.fill();
        }
      } else {
        const flick = 0.85 + Math.sin(run.time * 9 + zn.x) * 0.15;
        ctx.fillStyle = `rgba(255,120,50,${a * flick})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255,170,80,${0.55 * (a / 0.3)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }
  // 炮击落点预警（缩小的红环）
  if (run.pending) {
    for (const pd of run.pending) {
      ctx.beginPath();
      ctx.arc(pd.x, pd.y, pd.r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,90,70,0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(pd.x, pd.y, pd.r * 0.35, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,120,90,0.75)';
      ctx.stroke();
    }
  }
  // 技能施放预览
  if (view.skillPreview) {
    const sp = view.skillPreview;
    // 射程圈：以英雄脚下为圆心（和判定同一口径），虚线金色，低透明不抢画面
    if (sp.ring) {
      const rg = sp.ring;
      const bad = sp.ok === false;
      ctx.save();
      ctx.setLineDash([7, 7]);
      ctx.lineDashOffset = -(performance.now() / 90) % 14;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      ctx.strokeStyle = bad ? 'rgba(232,110,90,0.55)' : 'rgba(255,208,120,0.45)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
      // 连线：英雄 → 光标；超距时变红，并在光标旁写「当前/上限」
      ctx.beginPath();
      ctx.moveTo(rg.x, rg.y);
      ctx.lineTo(sp.x, sp.y);
      ctx.strokeStyle = bad ? 'rgba(232,110,90,0.55)' : 'rgba(255,208,120,0.40)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      const dtxt = Math.round(rg.dist) + ' / ' + Math.round(rg.r);
      const tw = ctx.measureText(dtxt).width + 10;
      const ty = sp.y - 18;
      ctx.fillStyle = 'rgba(10,15,22,0.72)';
      ctx.fillRect(sp.x - tw / 2, ty - 11, tw, 15);
      ctx.fillStyle = bad ? '#ff9c86' : '#ffd98a';
      ctx.fillText(dtxt, sp.x, ty);
      ctx.textAlign = 'left';
      ctx.restore();
    }
    if (sp.r > 0) {
      const bad = sp.ok === false;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.r, 0, Math.PI * 2);
      ctx.fillStyle = bad ? 'rgba(232,86,66,0.16)'
        : sp.hero ? 'rgba(255,196,90,0.15)'
        : sp.id === 'fire' ? 'rgba(255,120,50,0.16)' : 'rgba(255,90,70,0.13)';
      ctx.fill();
      ctx.strokeStyle = bad ? 'rgba(255,120,100,0.9)'
        : sp.hero ? 'rgba(255,208,120,0.85)'
        : sp.id === 'fire' ? 'rgba(255,170,80,0.8)' : 'rgba(255,110,90,0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (sp.id === 'airdrop') {
      // 空降：单格高亮（绿=可放，红=不可放）
      const h = (sp.cell || 24) / 2;
      const bad = sp.ok === false;
      ctx.fillStyle = bad ? 'rgba(232,86,66,0.34)' : 'rgba(110,225,145,0.30)';
      ctx.fillRect(sp.x - h, sp.y - h, h * 2, h * 2);
      ctx.strokeStyle = bad ? 'rgba(255,130,110,1)' : 'rgba(150,255,180,1)';
      ctx.lineWidth = 2.6;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(sp.x - h, sp.y - h, h * 2, h * 2);
      ctx.setLineDash([]);
      if (!bad) {
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.moveTo(sp.x + sx * h, sp.y + sy * h - sy * 9);
          ctx.lineTo(sp.x + sx * h, sp.y + sy * h);
          ctx.lineTo(sp.x + sx * h - sx * 9, sp.y + sy * h);
        }
        ctx.strokeStyle = 'rgba(190,255,205,0.95)';
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
    } else {
      // 有射程但没有作用半径的技能（钩爪）：光标处画准星，不画范围
      const bad = sp.ok === false;
      const rr = 9;
      ctx.strokeStyle = bad ? 'rgba(255,130,110,0.95)' : 'rgba(255,214,130,0.95)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(sp.x - rr, sp.y); ctx.lineTo(sp.x - 3, sp.y);
      ctx.moveTo(sp.x + 3, sp.y);  ctx.lineTo(sp.x + rr, sp.y);
      ctx.moveTo(sp.x, sp.y - rr); ctx.lineTo(sp.x, sp.y - 3);
      ctx.moveTo(sp.x, sp.y + 3);  ctx.lineTo(sp.x, sp.y + rr);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = bad ? 'rgba(255,130,110,0.9)' : 'rgba(255,214,130,0.9)';
      ctx.fill();
    }
  }

  // 战吼：指挥官周围的金色脉冲圈（只在自己身上画，不铺满屏）
  if (run.buzzedUntil && run.time < run.buzzedUntil) {
    const hz = run.units.find((u) => UNITS[u.kind] && UNITS[u.kind].hero && u.hp > 0);
    if (hz) {
      const R = HERO_SKILLS.warcry.radius, left = run.buzzedUntil - run.time;
      const pulse = 0.45 + 0.55 * Math.abs(Math.sin(run.time * 4.2));
      ctx.save();
      ctx.beginPath();
      ctx.arc(hz.x, hz.y, R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,205,110,${0.07 * pulse})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255,214,130,${0.55 * pulse})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      // 圈内友军脚下点一个小勾，表示吃到了 buff
      ctx.strokeStyle = 'rgba(255,226,160,0.55)';
      ctx.lineWidth = 1.6;
      for (const u of run.units) {
        if (!UNITS[u.kind] || u.hp <= 0) continue;
        if (Math.hypot(u.x - hz.x, u.y - hz.y) > R) continue;
        ctx.beginPath();
        ctx.arc(u.x, u.y + 11, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      void left;
    }
  }

  // 英雄重伤：倒地位置留一个倒计时标记（十字 + 剩余秒数）
  if (run.heroDown) {
    const d = run.heroDown;
    const left = Math.max(0, Math.ceil(d.respawnAt - run.time));
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = 'rgba(255,150,120,0.95)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(d.x, d.y, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(d.x - 6, d.y - 6); ctx.lineTo(d.x + 6, d.y - 6);
    ctx.moveTo(d.x, d.y - 6); ctx.lineTo(d.x, d.y + 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,196,160,0.95)';
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${left}s`, d.x, d.y - 16);
    ctx.restore();
  }

  // 资源点：卡片式图标 + 占领进度环
  if (run.nodes && run.nodes.length) {
    for (const n of run.nodes) {
      const x = (n.x + 0.5) * T, y = (n.y + 0.5) * T;
      const def = NODE_TYPES[n.kind] || NODE_TYPES.cash;
      const owned = n.owner === 1;
      // 目标圈
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.arc(x, y, RULE.econ.radius * T, 0, Math.PI * 2);
      ctx.strokeStyle = owned ? 'rgba(120,200,255,0.55)' : 'rgba(150,170,190,0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      // 底盘
      ctx.fillStyle = owned ? 'rgba(30,60,90,0.75)' : 'rgba(28,34,42,0.75)';
      ctx.beginPath();
      ctx.arc(x, y, T * 0.78, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = owned ? def.color : 'rgba(120,135,150,0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 图标
      const img = icon(def.icon, owned ? def.color : '#d3dbe4');
      if (img) ctx.drawImage(img, x - T * 0.5, y - T * 0.5, T, T);
      // 占领 / 被攻陷 进度环
      if (Math.abs(n.cap) > 0.01) {
        const p = Math.min(1, Math.abs(n.cap));
        ctx.beginPath();
        ctx.arc(x, y, T * 0.95, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
        ctx.strokeStyle = n.cap >= 0 ? 'rgba(120,200,255,0.95)' : 'rgba(226,89,74,0.95)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      // 无人驻守：占领后圈里没有己方单位 ⇒ 占领度按 holdGrace 掉光，必须给可见警告
      if (owned && !n.guard && n.cap > 0.01) {
        const blink = 0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 220));
        const secs = Math.max(0, Math.ceil(n.cap * (RULE.econ.holdGrace || 20)));
        ctx.save();
        ctx.globalAlpha = blink;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(x, y, T * 1.12, 0, Math.PI * 2);
        ctx.strokeStyle = '#f0b45c';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        // 右上角「小人 + 斜杠」
        ctx.save();
        const bx = x + T * 0.62, by = y - T * 0.66;
        ctx.strokeStyle = '#f0b45c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, 2.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(bx - 3.8, by + 1.2);
        ctx.lineTo(bx + 3.8, by - 10.2);
        ctx.stroke();
        ctx.restore();
        // 剩余秒数
        ctx.save();
        ctx.font = 'bold 11px ui-monospace,Consolas,monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = blink > 0.7 ? '#ffd08a' : '#f0b45c';
        ctx.fillText(secs + 's', x, y + T * 1.34);
        ctx.restore();
      }
    }
  }

  // 生产队列中的幽灵：虚线框 + 进度环
  if (run.queue && run.queue.length) {
    for (const q of run.queue) {
      const x = (q.tx + 0.5) * T, y = (q.ty + 0.5) * T;
      const d = q.kind === 'unit' ? UNITS[q.id] : FORTS[q.id];
      const half = T * 0.42;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(120,200,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - half, y - half, half * 2, half * 2);
      ctx.setLineDash([]);
      const img = d && (d.icon ? (q.kind === 'unit' ? unitIcon(q.id) : fortIcon(q.id)) : null);
      if (img) { ctx.globalAlpha = 0.28; ctx.drawImage(img, x - half * 0.8, y - half * 0.8, half * 1.6, half * 1.6); ctx.globalAlpha = 1; }
      const p = 1 - Math.max(0, q.t / q.dur);
      ctx.beginPath();
      ctx.arc(x, y, half + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      ctx.strokeStyle = '#7ec8ff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // 建造范围圈（选中建造项时显示）
  if (view.buildRings && run.build) {
    // 炮台 / 工事的可建范围也画方块：与 canPlaceAt 的切比雪夫判定同源（buildBounds）
    const boxDraw = (box, fill, stroke) => {
      if (!box) return;
      const bx = box.x0 * T, by = box.y0 * T;
      const bw = (box.x1 - box.x0 + 1) * T, bh = (box.y1 - box.y0 + 1) * T;
      ctx.fillStyle = fill;
      ctx.fillRect(bx, by, bw, bh);
      ctx.setLineDash([7, 6]);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);
    };
    if (view.buildRings === 'tower') boxDraw(view.buildBox, 'rgba(79,163,217,0.07)', 'rgba(79,163,217,0.55)');
    if (view.buildRings === 'fort') boxDraw(view.buildBox, 'rgba(150,175,200,0.06)', 'rgba(150,175,200,0.55)');
    if (view.buildRings === 'deploy') {
      // 与 deployOk 同源：直接画 deployBounds 给出的矩形（切比雪夫距离 = 方块）
      const box = view.deployBox;
      if (box) {
        const bx = box.x0 * T, by = box.y0 * T;
        const bw = (box.x1 - box.x0 + 1) * T, bh = (box.y1 - box.y0 + 1) * T;
        ctx.fillStyle = 'rgba(120,220,150,0.10)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(120,220,150,0.7)';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
      }
    }
  }

  // 工事
  for (const f of run.forts) {
    if (f.hp <= 0) continue;
    const img = fortIcon(f.kind);
    const fs = (FORTS[f.kind] && FORTS[f.kind].size) || 1;
    const box = T * fs;
    const size = box * 0.92;
    if (fs > 1) {
      ctx.fillStyle = 'rgba(20,26,34,0.55)';
      ctx.fillRect(f.tx * T + 1, f.ty * T + 1, box - 2, box - 2);
    }
    if (img) {
      ctx.globalAlpha = 0.95;
      ctx.drawImage(img, f.x - size / 2, f.y - size / 2, size, size);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = f.kind === 'wire' ? 'rgba(143,157,176,0.35)' : '#6f7b88';
      ctx.fillRect(f.x - box * 0.4, f.y - box * 0.4, box * 0.8, box * 0.8);
    }
    hpBar(ctx, f.x - box / 2 + 3, f.y - box / 2 - 3, box - 6, 3, f.hp / f.maxHp, PAL.fort);
  }

  // 地面贴花（尸体 / 焦痕）：画在单位与僵尸下层
  drawDecals(ctx, run, view, inView);

  // 钩爪绳索：飞行中从指挥官连到落点（虚线，金）
  for (const u of run.units) {
    const f = u.hookFly;
    if (!f) continue;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#ffd98a';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    ctx.moveTo(u.x, u.y - 6);
    ctx.lineTo(f.x1, f.y1);
    ctx.stroke();
    ctx.restore();
  }

  // 单位
  // 选中僵尸：红环 + 血条
  if (view.selZ) {
    const z = run.zombies.find((q) => q.id === view.selZ && q.hp > 0);
    if (z) {
      // 攻击范围：咬合（实线）+ 特感技能（虚线）
      const reach = z.size * 0.7 + 9;
      ctx.beginPath();
      ctx.arc(z.x, z.y, reach, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(226,89,74,0.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const zd = ZOMBIES[z.mob];
      const sp = zd && zd.special;
      if (sp && sp.range) {
        ctx.beginPath();
        ctx.setLineDash([6, 6]);
        ctx.arc(z.x, z.y, sp.range, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,138,61,0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        if (sp.radius) {
          ctx.beginPath();
          ctx.setLineDash([3, 5]);
          ctx.arc(z.x, z.y, sp.radius, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,200,120,0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.size * 1.5 + 3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(226,89,74,0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      const w = z.size * 2.4;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(z.x - w / 2, z.y - z.size * 1.5 - 12, w, 4);
      ctx.fillStyle = '#e2594a';
      ctx.fillRect(z.x - w / 2, z.y - z.size * 1.5 - 12, w * Math.max(0, z.hp / z.maxHp), 4);
    }
  }

  // 单位的行进路径：所有在动单位都画（淡色），选中的加亮并标出目标格
  // 与巡逻线（蓝色）区分：行进用绿色；已走过的段不保留，从当前脚下画起
  if (view.showPath) {
    const PT = run.map.tile, PW = run.map.w;
    ctx.save();
    ctx.lineWidth = 1.3;
    for (const u0 of run.units) {
      const u = vU(u0);
      if (!u.path || u.pathIdx >= u.path.length) continue;
      const picked = !!(view.selected && view.selected.has(u.id));
      if (!picked && !inView(u.x, u.y)) continue;
      ctx.setLineDash(picked ? [5, 5] : [4, 6]);
      ctx.strokeStyle = picked ? 'rgba(120,220,150,0.50)' : 'rgba(120,220,150,0.28)';
      ctx.beginPath();
      ctx.moveTo(u.x, u.y);
      for (let i = u.pathIdx; i < u.path.length; i++) {
        const node = u.path[i];
        ctx.lineTo(((node % PW) + 0.5) * PT, (((node / PW) | 0) + 0.5) * PT);
      }
      ctx.stroke();
      // 目标格高亮：只给选中的单位画，未选中时淡线不抢视线
      if (picked && u.order) {
        const gx = u.order.x * PT, gy = u.order.y * PT;
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(120,220,150,0.14)';
        ctx.fillRect(gx + 2, gy + 2, PT - 4, PT - 4);
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(150,240,175,0.85)';
        ctx.strokeRect(gx + 2, gy + 2, PT - 4, PT - 4);
        ctx.lineWidth = 1.3;
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 单选单位：画出它的射程圈（只在选中一个时）
  if (view.selected && view.selected.size === 1) {
    const sid = view.selected.values().next().value;
    const su = run.units.find((x) => x.id === sid);
    if (su) {
      const d = UNITS[su.kind];
      const suTile = run.map.tiles[(su.ty || 0) * run.map.w + (su.tx || 0)];
      const suMul = (TERRAIN[suTile] && TERRAIN[suTile].range) || 1;
      const suG = (su.inside && su.kind !== 'engineer') ? GARRISON.range : 1;
      const suRange = d.range * suMul * suG;
      const suMin = d.minRange || 0;      // 最小射程：死区挖空，不画填充
      ctx.save();
      ctx.beginPath();
      ctx.arc(su.x, su.y, suRange, 0, Math.PI * 2);
      if (suMin > 0) ctx.arc(su.x, su.y, suMin, 0, Math.PI * 2, true);   // 反向 → 环形
      ctx.fillStyle = 'rgba(120,220,150,0.055)';
      ctx.fill(suMin > 0 ? 'evenodd' : undefined);
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = 'rgba(120,220,150,0.42)';
      ctx.lineWidth = 1.4;
      if (suMin > 0) {
        ctx.beginPath();
        ctx.arc(su.x, su.y, suRange, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.stroke();
      }
      if (suMin > 0) {
        // 死区边界：内侧虚线红圈
        ctx.beginPath();
        ctx.arc(su.x, su.y, suMin, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(224,96,58,0.42)';
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  } else if (view.selRaid != null && run.raiders) {
    // 选中叛军：橙色射程圈（与玩家单位的绿圈区分）
    const rr = run.raiders.find((x) => x.id === view.selRaid && x.hp > 0);
    if (rr) {
      const rd = UNITS[rr.kind] || {};
      const tId = run.map.tiles[(rr.ty || 0) * run.map.w + (rr.tx || 0)];
      const mul = (TERRAIN[tId] && TERRAIN[tId].range) || 1;
      const rng = (rr.range || rd.range || 100) * mul;
      ctx.save();
      ctx.beginPath();
      ctx.arc(rr.x, rr.y, rng, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,150,70,0.06)';
      ctx.fill();
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = 'rgba(255,150,70,0.55)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // 可进入建筑：楼内 n/cap 角标（动态层，需随单位进出变化）
  if (run && run.units) {
    const T2 = run.map.tile;
    // 死亡转行尸：楼内有我方步兵倒下、行尸正在起身 → 楼体红框 + 角标
    for (const b of run.map.buildings) {
      if (b.hp <= 0) continue;
      let rn = 0;
      for (const q of run.riseQueue || []) if (q.inside === b) rn++;
      if (rn <= 0) continue;
      const bp = b.x * T2, bq = b.y * T2, bw4 = b.w * T2, bh4 = b.h * T2;
      ctx.strokeStyle = 'rgba(232,72,58,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(bp + 1, bq + 1, bw4 - 2, bh4 - 2);
      ctx.setLineDash([]);
      const t2 = '行尸' + rn;
      ctx.font = 'bold 10px system-ui, sans-serif';
      const tw2 = ctx.measureText(t2).width + 7;
      ctx.fillStyle = 'rgba(120,26,22,0.92)';
      ctx.fillRect(bp + 2, bq + bh4 - 15, tw2, 13);
      ctx.strokeStyle = 'rgba(255,140,120,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bp + 2.5, bq + bh4 - 14.5, tw2 - 1, 12);
      ctx.fillStyle = '#ffd9d2';
      ctx.textAlign = 'left';
      ctx.fillText(t2, bp + 5, bq + bh4 - 5);
    }

    for (const b of run.map.buildings) {
      if (!b.garrison || b.hp <= 0) continue;
      let cnt = 0;
      for (const u2 of run.units) {
        if (u2.inside === b) cnt++;
        else if (u2.enter && u2.enter.b === b && u2.enter.mode === 'in') cnt++;
      }
      const cap = b.garrCap || b.w * b.h;
      const label = `${cnt}/${cap}`;
      const px2 = b.x * T2, py2 = b.y * T2, pw2 = b.w * T2, ph2 = b.h * T2;
      const an = anchorCell(b);
      ctx.font = 'bold 10px system-ui, sans-serif';
      const w2 = ctx.measureText(label).width + 6;
      const bx2 = px2 + an[0] * T2 + T2 - w2 - 3, by2 = py2 + an[1] * T2 + T2 - 15;
      ctx.fillStyle = cnt > 0 ? 'rgba(30,70,110,0.9)' : 'rgba(18,28,42,0.7)';
      ctx.fillRect(bx2, by2, w2, 12);
      ctx.strokeStyle = cnt > 0 ? 'rgba(150,215,255,0.9)' : 'rgba(110,150,190,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx2 + 0.5, by2 + 0.5, w2 - 1, 11);
      ctx.fillStyle = cnt > 0 ? '#cfeaff' : 'rgba(150,190,225,0.7)';
      ctx.textAlign = 'left';
      ctx.fillText(label, bx2 + 3, by2 + 9.5);

      // 受击血条（只在被打过之后显示）
      if (b.hp < b.maxHp) {
        const k = Math.max(0, b.hp / b.maxHp);
        const bw3 = T2 * 0.84, bh3 = 4, bx3 = px2 + an[0] * T2 + T2 * 0.08, by3 = py2 + an[1] * T2 + 4;
        ctx.fillStyle = 'rgba(8,12,18,0.8)';
        ctx.fillRect(bx3 - 1, by3 - 1, bw3 + 2, bh3 + 2);
        ctx.fillStyle = k > 0.5 ? '#e8c15a' : k > 0.25 ? '#e0863a' : '#d8483a';
        ctx.fillRect(bx3, by3, bw3 * k, bh3);
      }
      // 楼内僵尸数（红色小角标，画在左上）
      let zn = 0;
      for (const z2 of run.zombies) if (z2.zInside === b) zn++;
      if (zn > 0) {
        const lab2 = '\u5c38' + zn;
        ctx.font = 'bold 9px system-ui, sans-serif';
        const w3 = ctx.measureText(lab2).width + 6;
        ctx.fillStyle = 'rgba(120,26,22,0.92)';
        ctx.fillRect(px2 + 2, py2 + 2, w3, 12);
        ctx.strokeStyle = 'rgba(255,140,120,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px2 + 2.5, py2 + 2.5, w3 - 1, 11);
        ctx.fillStyle = '#ffd9d2';
        ctx.fillText(lab2, px2 + 5, py2 + 11.5);
      }
    }
    ctx.textAlign = 'left';
  }

  // 同格重排：多个单位挤在一格里时（狭窄路口、建筑密集区），逻辑上虽然各占各的
  // 落点，但像素位置会重叠成一坨。这里按"同格第几个"给每个单位一个环形小偏移，
  // 让它至少看得出是几个单位。纯渲染，不影响碰撞与寻路。
  const tileKey = (u) => `${Math.floor(u.x / 40)},${Math.floor(u.y / 40)}`;
  const tileTotal = new Map();
  for (const u0 of run.units) {
    const u = vU(u0);
    if (u.inside || !UNITS[u.kind]) continue;
    const k = tileKey(u);
    tileTotal.set(k, (tileTotal.get(k) || 0) + 1);
  }
  for (const u0 of run.units) {
    const u = vU(u0);
    const def = UNITS[u.kind];
    if (!def) continue;
    if (u.inside) continue;   // 楼内单位在建筑之后单独画，否则会被底板盖住
    if (!inView(u.x, u.y)) continue;
    const img = unitIcon(u.kind);
    const baseSize = def.r * 2.9 * (def.iconScale || 1);
    // 空降落地：0.35s 内从 1.6 倍缩回原尺寸
    const dropK = (u.dropT || 0) / 0.35;
    const size = baseSize * (dropK > 0 ? 1 + 0.6 * dropK : 1);
    const invuln = (u.invT || 0) > 0;
    if (invuln) ctx.globalAlpha = 0.62;
    // 图标画在单位逻辑坐标的正中，**不做任何同格环形偏移**。
    // 之前按 id 的黄金角 + 7/11/15px 半径错开同格单位，好处是叠在一起时能看出是几个人，
    // 坏处是图标相对血条（血条始终以 u.x 为中心）整体偏出去，看着就是「图标不在格子里」。
    // 现在同格分散由逻辑层的 settleUnits 负责（停下即格中心 + 一格一人），
    // 渲染层不再偏移，图标和血条都严格居中。
    if (img) {
      ctx.drawImage(img, u.x - size / 2, u.y - size / 2, size, size);
    } else {
      ctx.beginPath();
      // 图标还没加载完（如新加的兵种首帧）就画个圆兜底；不能再加偏移，
      // 渲染层现在严格以 u.x/u.y 为图标中心（同格分散由 settleUnits 负责）
      ctx.arc(u.x, u.y, def.r, 0, Math.PI * 2);
      ctx.fillStyle = PAL.friendly;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (invuln) {
      // 落地保护期：白色虚线圈
      ctx.beginPath();
      ctx.arc(u.x, u.y, (def.r + 5) * (def.iconScale || 1), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(235,248,255,0.85)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    hpBar(ctx, u.x - def.r - 3, u.y - def.r - 8, def.r * 2 + 6, 2.5, u.hp / u.maxHp, PAL.friendly);
    ammoBar(ctx, u.x - def.r - 3, u.y - def.r - 4.6, def.r * 2 + 6, 2, u, def);
    rankPips(ctx, u.x - def.r + 1, u.y - def.r - 11.5, unitRank(u));

    // 姿态角标：停火=灰色静音标，巡逻=蓝色循环箭头
    if (u.stance === 'hold') {
      const bx = u.x + def.r + 5, by = u.y - def.r - 5;
      ctx.beginPath(); ctx.arc(bx, by, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(12,18,28,0.75)'; ctx.fill();
      ctx.strokeStyle = 'rgba(190,200,215,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx - 2.6, by + 2.6); ctx.lineTo(bx + 2.6, by - 2.6);
      ctx.strokeStyle = 'rgba(230,110,90,0.95)'; ctx.lineWidth = 1.6; ctx.stroke();
    } else if (u.stance === 'patrol') {
      const bx = u.x + def.r + 5, by = u.y - def.r - 5;
      ctx.beginPath(); ctx.arc(bx, by, 4.4, -0.4, Math.PI * 1.25);
      ctx.strokeStyle = 'rgba(126,200,255,0.95)'; ctx.lineWidth = 1.8; ctx.stroke();
      ctx.beginPath(); ctx.arc(bx, by, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(126,200,255,0.95)'; ctx.fill();
    }
    // 巡逻路线：两点之间画一条淡色虚线
    if (u.stance === 'patrol' && u.patrol && u.patrol.pts) {
      const T3 = run.map.tile, a3 = u.patrol.pts[0], b3 = u.patrol.pts[1];
      if (a3 && b3) {
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(126,200,255,0.30)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo((a3.x + 0.5) * T3, (a3.y + 0.5) * T3);
        ctx.lineTo((b3.x + 0.5) * T3, (b3.y + 0.5) * T3);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 进出楼读条：环形进度（蓝=进入 / 金=撤出）
    if (u.enter) {
      const tot = u.enter.total || 1;
      const k = Math.max(0, Math.min(1, 1 - u.enter.t / tot));
      ctx.beginPath();
      ctx.arc(u.x, u.y, (def.r + 7) * (def.iconScale || 1), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
      ctx.strokeStyle = u.enter.mode === 'in' ? '#7ec8ff' : '#e8c15a';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(u.x, u.y, (def.r + 7) * (def.iconScale || 1), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(120,150,180,0.25)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // 燃烧塔过热表现：热量条（白→黄→红）、过热时红圈 + 白汽
    if (def.heat) {
      const heat = Math.max(0, Math.min(1, u.heat || 0));
      if (heat > 0.02 || u.overheated) {
        const bw = def.r * 2.6, bx = u.x - bw / 2, by = u.y - def.r - 13;
        ctx.fillStyle = 'rgba(20,26,34,0.72)';
        ctx.fillRect(bx, by, bw, 2.6);
        const col = u.overheated ? '#ff5a4a' : heat > 0.7 ? '#ff9a3c' : heat > 0.4 ? '#ffd166' : '#dfe8f3';
        ctx.fillStyle = col;
        ctx.fillRect(bx, by, bw * heat, 2.6);
      }
      if (u.overheated) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, def.r + 5.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,90,74,0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
        // 白汽：每帧少量
        if (Math.random() < 0.25 && run.effects.length < 200) {
          run.effects.push({ steam: true, x: u.x + (Math.random() - 0.5) * def.r, y: u.y - def.r * 0.6, life: 0.55, max: 0.55, vy: -16 });
        }
      }
    }

    // 架设表现（A 方案）：图标下方横条 + 右下角状态角标；已架设时只剩一层低透明虚线圈
    if (def.deploy) {
      const sc = def.iconScale || 1;
      const bx = u.x - def.r - 3, bw = def.r * 2 + 6;
      if (u.depDir) {
        const tot = u.depDir > 0 ? def.deploy.setUpT : def.deploy.tearDownT;
        const left = Math.max(0, u.depT || 0);
        const k = Math.max(0, Math.min(1, 1 - left / tot));
        const by = u.y + def.r + 6;
        ctx.fillStyle = 'rgba(10,15,22,0.85)';
        ctx.fillRect(bx - 1, by - 1, bw + 2, 6);
        ctx.fillStyle = u.depDir > 0 ? '#e8c15a' : '#9fb0c4';
        ctx.fillRect(bx, by, bw * k, 4);
        // 剩余秒数写在条左侧，避免和右下角角标打架
        ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = u.depDir > 0 ? '#f0cf7a' : '#c3d2e2';
        ctx.fillText(left.toFixed(1) + 's', bx - 4, by + 4.5);
        ctx.textAlign = 'left';
      } else if (u.depOn) {
        // 支架：两条短腿从图标底部撑开，一眼看出「架起来了」
        ctx.beginPath();
        ctx.moveTo(u.x - 1.5 * sc, u.y + def.r * 0.85 * sc);
        ctx.lineTo(u.x - def.r * 0.82 * sc, u.y + def.r * 1.32 * sc);
        ctx.moveTo(u.x + 1.5 * sc, u.y + def.r * 0.85 * sc);
        ctx.lineTo(u.x + def.r * 0.82 * sc, u.y + def.r * 1.32 * sc);
        ctx.strokeStyle = 'rgba(198,178,134,0.85)';
        ctx.lineWidth = 1.7;
        ctx.stroke();

        // 架设完成：低透明虚线 + 轻微外发光（不再喧宾夺主）
        ctx.save();
        ctx.shadowColor = 'rgba(232,193,90,0.35)';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.setLineDash([3, 5]);
        ctx.arc(u.x, u.y, (def.r + 6) * sc, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(232,193,90,0.55)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);
      }

      // 右下角状态角标：灰斜杠=未架设 / 金色进度=读条 / 金色对勾=已架设
      const gx = u.x + def.r + 5, gy = u.y + def.r + 5;
      ctx.beginPath();
      ctx.arc(gx, gy, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(12,18,28,0.80)';
      ctx.fill();
      if (u.depOn) {
        ctx.strokeStyle = 'rgba(232,193,90,0.95)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(gx - 2.2, gy + 0.2);
        ctx.lineTo(gx - 0.3, gy + 2.1);
        ctx.lineTo(gx + 2.4, gy - 2.2);
        ctx.strokeStyle = '#e8c15a';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else if (u.depDir) {
        const tot = u.depDir > 0 ? def.deploy.setUpT : def.deploy.tearDownT;
        const left = Math.max(0, u.depT || 0);
        const k = Math.max(0, Math.min(1, 1 - left / tot));
        ctx.beginPath();
        ctx.arc(gx, gy, 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
        ctx.strokeStyle = u.depDir > 0 ? '#e8c15a' : '#9fb0c4';
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(gx, gy, 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(120,138,160,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(150,165,185,0.85)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(gx - 2.4, gy + 2.4);
        ctx.lineTo(gx + 2.4, gy - 2.4);
        ctx.strokeStyle = 'rgba(190,200,215,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // 被烟雾者缠绕：紫色环，环粗随剩余时间收缩
    if ((u.supT || 0) > 0 && (u.supMul || 1) > 1) {
      const k = Math.min(1, u.supT / 3.5);
      ctx.beginPath();
      ctx.arc(u.x, u.y, (def.r + 5) * (def.iconScale || 1), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(176,124,255,${(0.35 + 0.45 * k).toFixed(2)})`;
      ctx.lineWidth = 1.2 + 2.2 * k;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 选中圈
  if (view.selected) {
    for (const u0 of run.units) {
      const u = vU(u0);
      if (!view.selected.has(u.id)) continue;
      const def = UNITS[u.kind];
      ctx.beginPath();
      ctx.arc(u.x, u.y, (def.r + 4) * (def.iconScale || 1), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(120,220,150,0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (u.kind !== 'turret') {
        ctx.beginPath();
        ctx.arc(u.x, u.y, def.r * 0.6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(120,220,150,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // 选中工事 / 兵营
  if (view.selF) {
    const f = run.forts.find((q) => q.id === view.selF && q.hp > 0);
    if (f) {
      ctx.beginPath();
      ctx.arc(f.x, f.y, T * 0.62, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(168,182,196,0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  // 选中资源点
  if (view.selNode && run.nodes) {
    const n = run.nodes.find((q) => q.id === view.selNode);
    if (n) {
      const nx = (n.x + 0.5) * T, ny = (n.y + 0.5) * T;
      ctx.beginPath();
      ctx.arc(nx, ny, RULE.econ.radius * T, 0, Math.PI * 2);
      ctx.strokeStyle = n.owner === 1 ? 'rgba(126,200,255,0.9)' : 'rgba(200,210,220,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  // 选中据点
  if (view.selCore) {
    const cx2 = (run.core.x + 0.5) * T, cy2 = (run.core.y + 0.5) * T;
    ctx.beginPath();
    ctx.arc(cx2, cy2, T * 0.95, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(232,193,90,0.95)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // 移动指令标记
  if (view.markers) {
    for (const m of view.markers) {
      const a = Math.max(0, m.life / m.max);
      if (m.kind === 'break') {
        // 单位阵亡 / 工事倒塌：灰色碎片向外散开
        const r = 5 + (1 - a) * 13;
        ctx.strokeStyle = `rgba(196,206,220,${a * 0.9})`;
        ctx.lineWidth = 2;
        for (let k = 0; k < 3; k++) {
          const ang = -Math.PI / 2 + k * (Math.PI * 2 / 3) + (1 - a) * 0.5;
          const cx = m.x + Math.cos(ang) * r;
          const cy = m.y + Math.sin(ang) * r;
          const s2 = 3.5 * a + 1.5;
          ctx.beginPath();
          ctx.moveTo(cx, cy - s2);
          ctx.lineTo(cx + s2, cy + s2 * 0.7);
          ctx.lineTo(cx - s2, cy + s2 * 0.7);
          ctx.closePath();
          ctx.stroke();
        }
        continue;
      }
      ctx.strokeStyle = `rgba(120,220,150,${a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 6 + (1 - a) * 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 框选
  if (view.box) {
    const b = view.box;
    ctx.fillStyle = 'rgba(120,220,150,0.12)';
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.strokeStyle = 'rgba(120,220,150,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0 - 1, b.y1 - b.y0 - 1);
  }

  // 回血光环（仅选中建筑时）
  if (view.auraRings && view.auraRings.length) {
    for (const r of view.auraRings) {
      ctx.strokeStyle = 'rgba(120,230,150,0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(120,230,150,0.045)';
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 叛军（第三方，红方）：红色描边、0.85 尺寸、血条
  for (const r0 of (run.raiders || [])) {
    const r = vU(r0);
    if (r.hp <= 0) continue;
    if (!inView(r.x, r.y)) continue;
    const rdef = UNITS[r.kind];
    if (!rdef) continue;
    // 叛军载具用专属图标（武装皮卡：车顶机枪 + 射手），步兵/火箭筒兵沿用玩家图标
    const rimg = icon(r.kind === 'vehicle' ? 'raidervehicle' : (rdef.icon || r.kind), '#ff5a4a');
    // 与玩家单位同一套尺寸公式：叛军整体比正规军弱（scale 0.85），图标不该更大
    const rsize = rdef.r * 2.9 * (rdef.iconScale || 1);
    // 红色底环：与玩家蓝色单位、僵尸灰色一眼区分（叛军站得再密也能数出人数）
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(r.x, r.y, rdef.r + 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff5a4a';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
    if (rimg) {
      ctx.drawImage(rimg, r.x - rsize / 2, r.y - rsize / 2, rsize, rsize);
    } else {
      ctx.beginPath();
      ctx.arc(r.x, r.y, rdef.r * 0.85, 0, Math.PI * 2);
      ctx.fillStyle = '#ff5a4a';
      ctx.fill();
    }
    if (r.flash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.6, r.flash * 4);
      ctx.fillStyle = '#fff2ee';
      ctx.beginPath();
      ctx.arc(r.x, r.y, rdef.r * 1.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // 装甲车狂暴预警：红色脉冲环 + 头顶「!」（windup 期间）
    if (r.windup > 0) {
      const ph = (run.time * 6) % 1;
      ctx.save();
      ctx.beginPath();
      ctx.arc(r.x, r.y, rdef.r + 4 + ph * 12, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,72,60,${0.85 * (1 - ph)})`;
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r.x, r.y, rdef.r + 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,72,60,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      const my = r.y - rdef.r - 15 - Math.abs(Math.sin(run.time * 8)) * 2;
      ctx.beginPath();
      ctx.arc(r.x, my, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(232,60,48,0.95)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,235,0.9)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#fff6f2';
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', r.x, my + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
    }
    hpBar(ctx, r.x - rdef.r - 3, r.y - rdef.r - 8, rdef.r * 2 + 6, 2.5, r.hp / r.maxHp, '#ff5a4a');
    // 右上一颗红点：与玩家单位一眼区分
    ctx.beginPath();
    ctx.arc(r.x + rdef.r + 4, r.y - rdef.r - 4, 2.3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff5a4a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,34,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 选中地块
  if (view.selTile) {
    const st = view.selTile;
    ctx.strokeStyle = 'rgba(150,220,255,0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(st.tx * T + 1, st.ty * T + 1, T - 2, T - 2);
    ctx.fillStyle = 'rgba(150,220,255,0.12)';
    ctx.fillRect(st.tx * T + 1, st.ty * T + 1, T - 2, T - 2);
  }

  // 僵尸
  for (const z of run.zombies) {
    if (!inView(z.x, z.y)) continue;
    const iz = vU(z);
    // 暴君践踏蓄力：地面预警圈（半径=真实减速半径，圈内逐渐填色表示进度）
    if (z.spPhase === 'stomp') {
      const ring = stompRing(run, z);
      if (ring) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(226,70,50,0.10)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r * Math.max(0.05, ring.t), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,90,60,0.16)';
        ctx.fill();
        ctx.setLineDash([7, 6]);
        ctx.strokeStyle = 'rgba(255,96,64,0.62)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
    // 狂暴（暴君血线 <40%）：跳动的红环，提示这只要更危险
    if (z.enraged) {
      const pulse = 0.5 + 0.5 * Math.sin(run.time * 9 + z.id * 1.7);
      ctx.save();
      ctx.beginPath();
      ctx.arc(iz.x, iz.y, z.size * 1.45, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,66,48,${(0.28 + 0.34 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }
    // 冲锋者蓄力：地面危险带（长度=真实冲锋距离，遇墙/越界即截断，末端箭头标落点）
    if (z.spPhase === 'windup' && z.sp && z.sp.ability === 'charge') {
      const lane = chargeLane(run, z);
      if (lane && lane.len > 8) {
        const ca = Math.cos(z.dashA), sa = Math.sin(z.dashA);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(226,70,50,0.20)';
        ctx.lineWidth = lane.half * 2;
        ctx.beginPath(); ctx.moveTo(lane.x0, lane.y0); ctx.lineTo(lane.x1, lane.y1); ctx.stroke();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(255,96,64,0.68)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(lane.x0, lane.y0); ctx.lineTo(lane.x1, lane.y1); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,80,50,0.34)';
        ctx.lineWidth = lane.half;
        ctx.beginPath(); ctx.moveTo(lane.x0, lane.y0);
        ctx.lineTo(lane.x0 + ca * lane.len * lane.t, lane.y0 + sa * lane.len * lane.t);
        ctx.stroke();
        const ax = lane.x1, ay = lane.y1, k = 8;
        ctx.fillStyle = 'rgba(255,96,64,0.8)';
        ctx.beginPath();
        ctx.moveTo(ax + ca * k, ay + sa * k);
        ctx.lineTo(ax - sa * k * 0.8 - ca * k * 0.5, ay + ca * k * 0.8 - sa * k * 0.5);
        ctx.lineTo(ax + sa * k * 0.8 - ca * k * 0.5, ay - ca * k * 0.8 - sa * k * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    const zdv = ZOMBIES[z.mob];
    const vlist = zdv && zdv.icons;
    const iconName = (vlist && vlist.length)
      ? vlist[z.id % vlist.length]
      : (zdv && zdv.icon ? zdv.icon : 'zombie');
    const iconCol = ICON_COLOR[z.mob] || (z.mob === 'brute' ? ICON_COLOR.brute : ICON_COLOR.zombie);
    const img = icon(iconName, iconCol);
    const size = z.size * 2.6;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(iz.x, iz.y + size * 0.26, size * 0.28, size * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    // 硬骨头（46 血那档）：脚下一圈静态淡红环，和尖叫者的脉冲环区分开
    if (z.elite) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(iz.x, iz.y + z.size * 0.12, z.size * 0.98, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,120,90,0.42)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }
    // 眩晕：脚下一圈淡青环 + 头顶三颗打转的星点（时长越短越淡）
    if (z.stunUntil && z.stunUntil > run.time) {
      const left = z.stunUntil - run.time;
      const kt = Math.min(1, left / 0.5);
      ctx.save();
      ctx.beginPath();
      ctx.arc(iz.x, iz.y + z.size * 0.1, z.size * 0.88, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(150,225,255,${(0.5 * (0.4 + 0.6 * kt)).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      const spin = run.time * 7 + z.id * 0.7;
      const rr = z.size * 0.62;
      for (let k = 0; k < 3; k++) {
        const a2 = spin + k * 2.094;
        ctx.beginPath();
        ctx.arc(iz.x + Math.cos(a2) * rr, iz.y - z.size * 1.05 + Math.sin(a2) * rr * 0.42,
          1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(205,240,255,${(0.85 * (0.35 + 0.65 * kt)).toFixed(3)})`;
        ctx.fill();
      }
      ctx.restore();
    }
    // 被尖叫者增益：脚下红色脉冲环，随剩余时间变暗
    if (z.screamUntil && z.screamUntil > run.time) {
      const left = z.screamUntil - run.time;
      const kt = Math.min(1, left / 3.2);
      const pulse = 0.5 + 0.5 * Math.sin(run.time * 10 + z.id * 1.3);
      ctx.save();
      ctx.beginPath();
      ctx.arc(iz.x, iz.y + z.size * 0.1, z.size * (0.9 + 0.14 * pulse), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,80,60,${(0.34 * (0.45 + 0.55 * kt)).toFixed(3)})`;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();
    }
    if (img) {
      ctx.drawImage(img, iz.x - size / 2, iz.y - size / 2, size, size);
    } else {
      ctx.fillStyle = z.mob === 'brute' ? PAL.zombieBrute : PAL.zombie;
      ctx.fillRect(iz.x - z.size / 2, iz.y - z.size / 2, z.size, z.size);
    }
    // 尖叫者架设：身下两根短支架（与玩家架设同语言，颜色偏紫）
    if (z.mob === 'screamer' && z.spPhase === 'park') {
      ctx.save();
      ctx.strokeStyle = 'rgba(220,150,255,0.85)';
      ctx.lineWidth = 2;
      const legH = z.size * 0.8;
      const ly = iz.y + size * 0.24;
      ctx.beginPath(); ctx.moveTo(iz.x - size * 0.20, ly); ctx.lineTo(iz.x - size * 0.30, ly + legH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(iz.x + size * 0.20, ly); ctx.lineTo(iz.x + size * 0.30, ly + legH); ctx.stroke();
      ctx.restore();
    }
    // 抢点队：橙红虚线圈 + 小旗，与普通僵尸区分
    if (z.raider) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(iz.x, iz.y, z.size * 1.25, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,150,60,0.85)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,150,60,0.9)';
      ctx.fillRect(iz.x - 1, iz.y - z.size * 1.9, 2, 6);
      ctx.beginPath();
      ctx.moveTo(iz.x + 1, iz.y - z.size * 1.9);
      ctx.lineTo(iz.x + 7, iz.y - z.size * 1.65);
      ctx.lineTo(iz.x + 1, iz.y - z.size * 1.4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    if (z.mob === 'brute' || (ZOMBIES[z.mob] && ZOMBIES[z.mob].special && !z.boss)) {
      ctx.beginPath();
      ctx.arc(iz.x, iz.y, z.size * 1.05, 0, Math.PI * 2);
      ctx.strokeStyle = z.mob === 'brute' ? 'rgba(224,60,40,0.55)' : 'rgba(255,140,90,0.45)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (z.boss) {
      // boss：双环 + 血条
      ctx.beginPath();
      ctx.arc(iz.x, iz.y, z.size * 1.35, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,59,107,0.85)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (z.spPhase === 'windup' || z.spPhase === 'pull') {
      ctx.beginPath();
      ctx.arc(iz.x, iz.y, z.size * 1.25 + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,80,60,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  // 巨兽血条：挂在它自己头顶，满血也显示（它是关卡目标，玩家要一直能看到还剩多少）
  // 不受 Z「僵尸血条」开关影响 —— 那个开关管的是普通僵尸的细条
  for (const z of run.zombies) {
    if (!z.boss || z.hp <= 0) continue;
    if (!inView(z.x, z.y)) continue;
    const bw2 = Math.max(38, z.size * 2.3), bh2 = 3.4;
    const by2 = z.y - z.size * 1.15 - 10;
    ctx.fillStyle = 'rgba(8,10,14,0.72)';
    ctx.fillRect(z.x - bw2 / 2 - 1.5, by2 - 1.5, bw2 + 3, bh2 + 3);
    ctx.fillStyle = 'rgba(255,59,107,0.22)';
    ctx.fillRect(z.x - bw2 / 2, by2, bw2, bh2);
    ctx.fillStyle = 'rgba(255,59,107,0.95)';
    ctx.fillRect(z.x - bw2 / 2, by2, bw2 * Math.max(0, z.hp / z.maxHp), bh2);
    ctx.fillStyle = 'rgba(255,235,240,0.95)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('巨兽 ' + Math.ceil(z.hp) + '/' + z.maxHp, z.x, by2 - 5);
    ctx.textAlign = 'left';
  }

  // 受伤僵尸的细血条（开关：Z）
  if (view.zbar) {
    for (const z of run.zombies) {
      if (z.hp >= z.maxHp || z.boss) continue;
      if (!inView(z.x, z.y)) continue;
      const w = Math.max(9, z.size * 1.15);
      const y = z.y - z.size * 0.9 - 5;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(z.x - w / 2, y, w, 2.2);
      ctx.fillStyle = z.hp / z.maxHp > 0.4 ? 'rgba(226,89,74,0.95)' : 'rgba(255,190,80,0.95)';
      ctx.fillRect(z.x - w / 2, y, w * Math.max(0, z.hp / z.maxHp), 2.2);
    }
  }

  ctx.strokeStyle = 'rgba(224,96,58,0.9)';
  ctx.lineWidth = 2;
  for (const z of run.zombies) {
    if (!z.eating) continue;
    if (!inView(z.x, z.y)) continue;
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.size * 1.15, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }

  // 弹道与命中特效
  for (const u0 of run.units) {
    const u = vU(u0);
    if (!u.flash || u.flash <= 0) continue;
    const a = Math.min(1, u.flash / 0.09);
    ctx.strokeStyle = `rgba(180,225,255,${0.15 + a * 0.5})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(u.x, u.y);
    ctx.lineTo(u.aimX ?? u.x, u.aimY ?? u.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(u.aimX ?? u.x, u.aimY ?? u.y, 2 + (1 - a) * 4, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(224,96,58,${a * 0.7})`;
    ctx.stroke();
  }
  // 叛军开火：同一条光斑链路，橙色调以区分敌我
  if (run.raiders) {
    for (const r0 of run.raiders) {
      const r = vU(r0);
      if (r.hp <= 0 || !r.flash || r.flash <= 0) continue;
      if (!inView(r.x, r.y)) continue;
      const a = Math.min(1, r.flash / 0.09);
      const ax = r.aimX ?? r.x, ay = r.aimY ?? r.y;
      ctx.strokeStyle = `rgba(255,196,132,${0.15 + a * 0.5})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ax, ay, 2 + (1 - a) * 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,140,66,${a * 0.75})`;
      ctx.stroke();
    }
  }
  for (const e of run.effects) {
    const k = 1 - e.life / e.max;
    if (e.rise) {
      // 行尸起身：地面红雾向外扩散
      const kk = 1 - e.life / e.max;
      const rr = (e.size || 26) * (0.35 + 0.65 * kk);
      const g2 = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rr);
      g2.addColorStop(0, `rgba(210,60,46,${0.42 * (1 - kk)})`);
      g2.addColorStop(1, 'rgba(210,60,46,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,120,96,${0.75 * (1 - kk)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, rr * 0.9, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    if (e.heal) {
      const k3 = 1 - e.life / e.max;
      ctx.fillStyle = `rgba(120,240,150,${0.85 * (1 - k3)})`;
      ctx.fillRect(e.x - 1.5, e.y - 6 - k3 * 12, 3, 3);
      continue;
    }
    if (e.boom) {
      // 引信：死亡后 2s 才炸，这段时间给玩家一个可读的倒计时圈
      const rr = (e.boom.radius || 36) * (0.55 + 0.45 * k);
      const pulse = 0.35 + 0.45 * Math.abs(Math.sin(k * Math.PI * 6));
      ctx.strokeStyle = `rgba(240,120,60,${0.85 * pulse})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(e.x, e.y, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(255,170,90,${0.10 + 0.20 * pulse})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, rr, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    if (e.steam) {
      const k2 = 1 - e.life / e.max;
      ctx.fillStyle = `rgba(235,240,245,${0.45 * (1 - k2)})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y - k2 * 12, 2.2 + k2 * 3.2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    if (e.tongue) {
      ctx.strokeStyle = 'rgba(220,200,190,0.85)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
      continue;
    }
    if (e.acidDrop) {
      ctx.globalAlpha = Math.max(0, 1 - k) * 0.85;
      ctx.fillStyle = '#9dffb0';
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    if (e.bullet) {
      ctx.globalAlpha = Math.max(0, 1 - k) * 0.95;
      ctx.strokeStyle = '#ffe6a8';
      ctx.lineWidth = e.w || 1.5;
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
      ctx.globalAlpha = Math.max(0, 1 - k) * 0.8;
      ctx.fillStyle = '#fff4d6';
      ctx.beginPath();
      ctx.arc(e.x1, e.y1, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    if (e.flame) {
      // 火舌（俯视）：一条贴地喷出的火焰带 —— 窄入口、宽出口、团块翻滚、末端炸开
      const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
      const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = -sa, ny = ca;
      const t = run.time + e.x1 * 0.013 + e.y1 * 0.011;
      const alpha = 1 - k;
      const w0 = 6, w1 = 15;   // 半径（直径 12 → 30）
      const jitter = (i, seed) => Math.sin(t * (14 + i * 3.1) + seed) ;
      ctx.save();
      // ① 黑烟：正常叠加，压在火下面往外散
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < 5; i++) {
        const u = (i + 0.5) / 5;
        const d = len * u * 1.04;
        const r = (w0 + (w1 - w0) * u) * (1.35 + 0.35 * jitter(i, 2.1));
        const jp = jitter(i, 1.7) * 4;
        ctx.beginPath();
        ctx.arc(e.x1 + ca * d + nx * jp, e.y1 + sa * d + ny * jp, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(38,30,26,${0.16 * alpha})`;
        ctx.fill();
      }
      // ② 外形：一条从入口到出口逐渐变宽的锥形轮廓（没有它，团块看着像一根光束）
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.moveTo(e.x1 + nx * w0 * 0.55, e.y1 + ny * w0 * 0.55);
      ctx.lineTo(e.x2 + nx * w1 * 1.05, e.y2 + ny * w1 * 1.05);
      ctx.lineTo(e.x2 - nx * w1 * 1.05, e.y2 - ny * w1 * 1.05);
      ctx.lineTo(e.x1 - nx * w0 * 0.55, e.y1 - ny * w0 * 0.55);
      ctx.closePath();
      ctx.fillStyle = `rgba(255,110,35,${0.20 * alpha})`;
      ctx.fill();
      // ③ 火焰本体：加色混合，团块沿射程翻滚
      for (let i = 0; i < 9; i++) {
        const u = (i + 0.5) / 9;
        const d = len * u;
        const rr = (w0 + (w1 - w0) * u) * (0.92 + 0.22 * jitter(i, 3.3));
        const jp = jitter(i, 0.9) * (2.2 + 3.4 * u);
        const g = ctx.createRadialGradient(
          e.x1 + ca * d + nx * jp, e.y1 + sa * d + ny * jp, rr * 0.15,
          e.x1 + ca * d + nx * jp, e.y1 + sa * d + ny * jp, rr);
        g.addColorStop(0, `rgba(255,${Math.round(190 + 40 * (1 - u))},120,${0.34 * alpha})`);
        g.addColorStop(0.55, `rgba(255,${Math.round(120 + 50 * (1 - u))},40,${0.26 * alpha})`);
        g.addColorStop(1, 'rgba(180,40,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(e.x1 + ca * d + nx * jp, e.y1 + sa * d + ny * jp, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      // ④ 亮芯：贴着轴线的一根白黄色火柱
      const coreG = ctx.createLinearGradient(e.x1, e.y1, e.x2, e.y2);
      coreG.addColorStop(0, `rgba(255,250,225,${0.58 * alpha})`);
      coreG.addColorStop(0.55, `rgba(255,226,140,${0.55 * alpha})`);
      coreG.addColorStop(1, `rgba(255,150,50,${0.10 * alpha})`);
      ctx.strokeStyle = coreG;
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x1 + ca * len * 0.92 + nx * jitter(2, 4.4) * 1.6,
        e.y1 + sa * len * 0.92 + ny * jitter(2, 4.4) * 1.6);
      ctx.stroke();
      // ⑤ 末端炸开：两团更大的火球
      for (let i = 0; i < 2; i++) {
        const rr = w1 * (1.05 + 0.3 * jitter(i, 5.5) + i * 0.25);
        const g2 = ctx.createRadialGradient(e.x2, e.y2, 0, e.x2, e.y2, rr);
        g2.addColorStop(0, `rgba(255,236,170,${0.5 * alpha})`);
        g2.addColorStop(0.5, `rgba(255,140,40,${0.34 * alpha})`);
        g2.addColorStop(1, 'rgba(200,50,0,0)');
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.arc(e.x2, e.y2, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      // ⑥ 火星：沿火舌方向甩出去的小亮点
      for (let i = 0; i < 4; i++) {
        const u = 0.55 + 0.45 * ((i * 0.37 + (t * 0.6) % 1) % 1);
        const jp = Math.sin(i * 2.1 + t * 7) * 9 * u;
        ctx.beginPath();
        ctx.arc(e.x1 + ca * len * u + nx * jp, e.y1 + sa * len * u + ny * jp,
          1.1 + 0.7 * ((i % 2)), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,${180 + i * 15},90,${0.65 * alpha})`;
        ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      continue;
    }
    if (e.proj === 'ap') {
      // 坦克直射：一根高速曳光，尾部带一点余辉
      const head = k;
      const tail = Math.max(0, k - 0.45);
      const hx = e.x1 + (e.x2 - e.x1) * head, hy = e.y1 + (e.y2 - e.y1) * head;
      const tx2 = e.x1 + (e.x2 - e.x1) * tail, ty2 = e.y1 + (e.y2 - e.y1) * tail;
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = '#fff0c8';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(tx2, ty2);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#ffb066';
      ctx.lineWidth = 5.5;
      ctx.beginPath();
      ctx.moveTo(tx2, ty2);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }
    if (e.proj) {
      const px = e.x1 + (e.x2 - e.x1) * k;
      const py = e.y1 + (e.y2 - e.y1) * k - Math.sin(k * Math.PI) * (e.arc || 0);
      ctx.fillStyle = e.proj === 'mortar' ? '#cfd6dd' : e.proj === 'rocket' ? '#ffd9a0'
        : e.proj === 'acid' ? '#8dffa4' : '#ffcf7a';
      ctx.beginPath();
      ctx.arc(px, py, e.proj === 'mortar' ? 2.7 : e.proj === 'acid' ? 3.0 : 2.2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    if (e.scream) {
      // 尖叫者的声波：向外扩散的品红环（强尖啸更亮更粗）
      const rr = e.size * 0.5 * (0.12 + k * 0.88);
      const fade = 1 - k;
      ctx.save();
      ctx.globalAlpha = fade * (e.strong ? 0.9 : 0.55);
      ctx.strokeStyle = e.strong ? '#dc78ff' : '#b478ff';
      ctx.lineWidth = e.strong ? 3.4 : 2.2;
      ctx.beginPath(); ctx.arc(e.x, e.y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = fade * (e.strong ? 0.42 : 0.26);
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(e.x, e.y, rr * 0.7, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      continue;
    }
    if (e.sweep) {
      // 英雄横扫：120° 扇形随前缘扫过（白金低透明度，只强化外缘，避免盖住僵尸）
      const kk = 1 - e.life / e.max;
      const a0 = (e.a || 0) - (e.half || Math.PI / 3);
      const a1 = (e.a || 0) + (e.half || Math.PI / 3);
      const head = a0 + (a1 - a0) * Math.min(1, kk * 1.35);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - kk) * 0.30;
      ctx.fillStyle = '#fff3cf';
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.arc(e.x, e.y, e.r, a0, head);
      ctx.closePath();
      ctx.fill();
      // 外缘：先铺一层辉光，再压一条亮弧，保证在深色地形上也看得见
      const edgeA = Math.max(0, 1 - kk * 1.1);
      const edgeR = e.r * (0.86 + 0.14 * kk);
      ctx.globalAlpha = edgeA * 0.30;
      ctx.strokeStyle = '#ffe9b0';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(e.x, e.y, edgeR, Math.max(a0, head - 0.55), head);
      ctx.stroke();
      ctx.globalAlpha = edgeA * 0.95;
      ctx.strokeStyle = '#fff6da';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, edgeR, Math.max(a0, head - 0.55), head);
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (e.crush) {
      // 载具碾压：车头椭圆冲击波（我方青白 / 叛军琥珀）
      const kk = 1 - e.life / e.max;
      const rx = e.r * (0.75 + 0.45 * kk), ry = rx * 0.62;
      ctx.save();
      ctx.globalAlpha = (1 - kk) * 0.8;
      ctx.strokeStyle = e.side === 'raider' ? '#ff9f1c' : '#bfe6ff';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = (1 - kk) * 0.26;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, rx * 1.25, ry * 1.25, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (e.decal) {
      // 压痕：暗红椭圆贴花，缓慢淡出
      const fade = Math.min(1, e.life / (e.max * 0.55));
      ctx.save();
      ctx.globalAlpha = 0.42 * fade;
      ctx.fillStyle = '#5d1a16';
      ctx.translate(e.x, e.y);
      ctx.rotate(e.rot || 0);
      ctx.beginPath();
      ctx.ellipse(0, 0, e.size, e.size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      continue;
    }
    if (e.hit) {
      // 命中白十字：0.09s 一闪
      const kk = 1 - e.life / e.max;
      const s2 = e.size * (0.55 + 0.65 * kk);
      ctx.save();
      ctx.globalAlpha = (1 - kk) * 0.95;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(e.x - s2, e.y); ctx.lineTo(e.x + s2, e.y);
      ctx.moveTo(e.x, e.y - s2); ctx.lineTo(e.x, e.y + s2);
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (e.trail) {
      // 钩爪拖尾：淡金小圆点
      const fade = Math.min(1, e.life / (e.max * 0.7));
      ctx.globalAlpha = 0.55 * fade;
      ctx.fillStyle = '#ffd98a';
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    if (e.dust) {
      // 击退尘土：小灰方块
      const fade = Math.min(1, e.life / (e.max * 0.6));
      ctx.globalAlpha = 0.5 * fade;
      ctx.fillStyle = '#c9cfd6';
      ctx.fillRect(e.x - e.size / 2, e.y - e.size / 2, e.size, e.size);
      ctx.globalAlpha = 1;
      continue;
    }
    if (e.ring) {
      // 范围伤害的爆炸环
      const rr = e.size * 0.5 * (0.35 + k * 0.75);
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.beginPath();
      ctx.arc(e.x, e.y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffb066';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(e.x, e.y, rr * 0.62, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,120,60,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }
    if (e.gib) {
      // 尸块：先飞散停住，最后 40% 时间淡出
      const fade = Math.min(1, e.life / (e.max * 0.4));
      ctx.globalAlpha = fade;
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.rot || 0);
      ctx.fillStyle = '#c0453c';
      ctx.fillRect(-e.size / 2, -e.size / 2, e.size, e.size * 0.8);
      ctx.fillStyle = 'rgba(120,32,28,0.9)';
      ctx.fillRect(-e.size / 3, -e.size / 3, e.size * 0.45, e.size * 0.45);
      ctx.restore();
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = '#c0453c';
    const r = e.size * (0.6 + k * 0.9);
    ctx.fillRect(e.x - r / 2, e.y - r / 2, r, r);
    ctx.globalAlpha = 1;
  }

  // 伤害数字
  if (view.damageNum && run.floats && run.floats.length) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of run.floats) {
      const k = 1 - f.life / f.max;
      ctx.globalAlpha = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35;
      const isHeal = f.kind === 'heal';
      const fs = (f.text || isHeal) ? 13 : (f.crit ? 16 : (f.v >= 30 ? 13 : 11));
      ctx.font = `bold ${fs}px Consolas, monospace`;
      const label = f.text ? f.text
        : (isHeal ? '+' + f.v
        : (f.crit ? String(f.v) + '!' : String(f.v)));
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillText(label, f.x + 1, f.y + 1);
      // 回血绿色；军衔文字青蓝；暴击金色；友军误伤红色；普通白/黄
      ctx.fillStyle = isHeal ? '#6fe08a'
        : (f.text ? '#8fe3ff'
        : (f.crit ? '#ffcf3d' : (f.friendly ? '#ff7a6b' : (f.v >= 30 ? '#ffd166' : '#f2f6fa'))));
      ctx.fillText(label, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // 据点
  const cx = (run.core.x + 0.5) * T, cy = (run.core.y + 0.5) * T;
  const k = Math.max(0, run.core.hp / run.core.maxHp);
  ctx.beginPath();
  ctx.arc(cx, cy, T * 0.95, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(224,179,65,0.12)';
  ctx.fill();
  // 基地占地 3x3：先铺一块底板
  const pad = T * 3;
  ctx.fillStyle = 'rgba(28,34,44,0.72)';
  ctx.fillRect(cx - pad / 2 + 2, cy - pad / 2 + 2, pad - 4, pad - 4);
  ctx.strokeStyle = 'rgba(224,179,65,0.35)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - pad / 2 + 2, cy - pad / 2 + 2, pad - 4, pad - 4);
  const coreImg = icon('core', ICON_COLOR.core);
  const coreSize = T * 2.5;
  if (coreImg) ctx.drawImage(coreImg, cx - coreSize / 2, cy - coreSize / 2, coreSize, coreSize);
  ctx.beginPath();
  ctx.arc(cx, cy, T * 1.02, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
  ctx.strokeStyle = k > 0.35 ? PAL.core : PAL.danger;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // 楼内人数角标：基地 / 兵营 / 载具工厂
  const gBadge = (room, bx, by) => {
    if (!room) return;
    let n = 0;
    for (const u2 of run.units) {
      if (u2.hp <= 0) continue;
      if (u2.inside === room) n++;
      else if (u2.enter && u2.enter.b === room && u2.enter.mode === 'in') n++;
    }
    const cap = Math.min(room.garrCap || ((room.w || 1) * (room.h || 1)), (room.w || 1) * (room.h || 1));
    const txt = n + '/' + cap;
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    const w2 = ctx.measureText(txt).width + 8;
    ctx.fillStyle = n > 0 ? 'rgba(30,70,110,0.9)' : 'rgba(18,24,32,0.72)';
    ctx.fillRect(bx - w2, by - 13, w2, 14);
    ctx.fillStyle = n > 0 ? '#cfeaff' : 'rgba(150,190,225,0.75)';
    ctx.fillText(txt, bx - 4, by - 2);
    ctx.textAlign = 'left';
  };
  if (run.core.room) gBadge(run.core.room, cx + pad / 2 - 3, cy + pad / 2 - 3);
  // 建筑级读条：有人正在进楼（enter.mode==='in'）时，在建筑外围画一圈进度环
  const gArc = (room) => {
    if (!room) return;
    let k = -1;
    for (const u2 of run.units) {
      if (u2.hp <= 0 || !u2.enter || u2.enter.b !== room || u2.enter.mode !== 'in') continue;
      const p2 = u2.enter.total ? 1 - u2.enter.t / u2.enter.total : 0;
      if (p2 > k) k = p2;
    }
    if (k < 0) return;
    const bx = (room.x + room.w / 2) * T;
    const by = (room.y + room.h / 2) * T;
    const rr = Math.max(room.w, room.h) * T * 0.5 + 10;
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, rr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(120,150,180,0.20)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx, by, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, k));
    ctx.strokeStyle = '#7ec8ff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  };
  gArc(run.core.room);
  for (const f of run.forts) if (f.hp > 0 && f.room) gArc(f.room);
  // 楼内单位：画在建筑上面，缩小一圈并加描边，方便左键点选
  for (const u0 of run.units) {
    const u = vU(u0);
    if (!u.inside) continue;
    const def = UNITS[u.kind];
    if (!def) continue;
    const img = unitIcon(u.kind);
    const size = def.r * 2.0 * (def.iconScale || 1);
    ctx.save();
    ctx.beginPath();
    ctx.arc(u.x, u.y, size * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12,18,28,0.72)';
    ctx.fill();
    if (img) {
      ctx.globalAlpha = 0.96;
      ctx.drawImage(img, u.x - size / 2, u.y - size / 2, size, size);
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(u.x, u.y, size * 0.62, 0, Math.PI * 2);
    ctx.strokeStyle = u.hp < u.maxHp * 0.35 ? 'rgba(224,96,58,0.9)' : 'rgba(160,215,255,0.55)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    hpBar(ctx, u.x - def.r, u.y - def.r - 9, def.r * 2, 2.2, u.hp / u.maxHp, PAL.friendly);
    ammoBar(ctx, u.x - def.r, u.y - def.r - 6, def.r * 2, 1.8, u, def);
    rankPips(ctx, u.x - def.r + 1, u.y - def.r - 12.5, unitRank(u));
    ctx.restore();
  }
  for (const f of run.forts) {
    if (f.hp <= 0 || !f.room) continue;
    const fs2 = (FORTS[f.kind] && FORTS[f.kind].size) || 1;
    gBadge(f.room, f.tx * T + fs2 * T - 3, f.ty * T + fs2 * T - 3);
  }

  for (const s of map.spawns) {
    const sx = (s.x + 0.5) * T, sy = (s.y + 0.5) * T;
    ctx.strokeStyle = 'rgba(224,96,58,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - T * 0.7, sy - T * 0.7, T * 1.4, T * 1.4);
    ctx.beginPath();
    ctx.moveTo(sx - 4, sy); ctx.lineTo(sx + 4, sy);
    ctx.moveTo(sx, sy - 4); ctx.lineTo(sx, sy + 4);
    ctx.stroke();
  }

  // 调试：僵尸路径
  if (view.debug) {
    ctx.strokeStyle = PAL.path;
    ctx.lineWidth = 1;
    for (const z of run.zombies) {
      if (!z.path) continue;
      ctx.beginPath();
      ctx.moveTo(z.x, z.y);
      for (let i = z.pathIdx; i < z.path.length; i++) {
        const node = z.path[i];
        ctx.lineTo((node % map.w + 0.5) * T, (((node / map.w) | 0) + 0.5) * T);
      }
      ctx.stroke();
      const t = z.target;
      if (t && t.ref) {
        const tx = t.kind === 'fort' ? t.ref.x : (t.ref.x + t.ref.w / 2) * T;
        const ty = t.kind === 'fort' ? t.ref.y : (t.ref.y + t.ref.h / 2) * T;
        ctx.strokeStyle = 'rgba(224,96,58,0.6)';
        ctx.beginPath();
        ctx.arc(tx, ty, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = PAL.path;
      }
    }
  }


  // 悬停格子
  if (view.hover && view.hover.show) {
    const { tx, ty } = view.hover;
    const ok = view.hover.ok;
    const hs = view.hover.size || 1;
    const hb = T * hs;
    ctx.fillStyle = ok ? PAL.ghostOk : PAL.ghostBad;
    ctx.fillRect(tx * T, ty * T, hb, hb);
    ctx.strokeStyle = ok ? PAL.ghostEdgeOk : PAL.ghostEdgeBad;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tx * T + 0.5, ty * T + 0.5, hb - 1, hb - 1);
    if (view.hover.range) {
      const hMin = view.hover.minRange || 0;
      const hx = (tx + 0.5) * T, hy = (ty + 0.5) * T;
      ctx.beginPath();
      ctx.arc(hx, hy, view.hover.range, 0, Math.PI * 2);
      if (hMin > 0) ctx.arc(hx, hy, hMin, 0, Math.PI * 2, true);
      ctx.fillStyle = PAL.rangeRing;
      ctx.fill(hMin > 0 ? 'evenodd' : undefined);
      if (hMin > 0 && hMin < view.hover.range) {
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(hx, hy, hMin, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(224,96,58,0.5)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // 巡逻起点 + 到鼠标的虚线预览
  if (view.patrolFrom) {
    const px = (view.patrolFrom.x + 0.5) * T;
    const py = (view.patrolFrom.y + 0.5) * T;
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, T * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(124,192,255,0.26)';
    ctx.fill();
    ctx.strokeStyle = '#7cc0ff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - T * 0.2, py); ctx.lineTo(px + T * 0.2, py);
    ctx.moveTo(px, py - T * 0.2); ctx.lineTo(px, py + T * 0.2);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // 中间一面小旗
    ctx.beginPath();
    ctx.moveTo(px, py - T * 0.22);
    ctx.lineTo(px, py + T * 0.18);
    ctx.moveTo(px, py - T * 0.22);
    ctx.lineTo(px + T * 0.22, py - T * 0.11);
    ctx.lineTo(px, py);
    ctx.lineWidth = 1.7;
    ctx.stroke();
    if (view.hover && view.hover.tx != null && view.hover.ty != null) {
      const mx = (view.hover.tx + 0.5) * T;
      const my = (view.hover.ty + 0.5) * T;
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = 'rgba(124,192,255,0.7)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(mx, my, T * 0.3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(124,192,255,0.9)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  // （巨兽血条已改挂到它自己头顶，见上；这里不再画屏幕顶部的大条）
  ctx.restore();
}

// ---- 战场痕迹（尸体 / 焦痕）预渲染贴图：3 种血泊 + 3 种焦痕，运行时只 drawImage ----
const DECAL_TEX = { blood: [], bloodA: [], scorch: [] };

// 玩家血泊偏暗红；叛军偏琥珀（贴合叛军尸体系 #6d4a1c），所以颜色要能传
function makeBloodTex(seed, color) {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const rnd = (a) => 0.5 + (Math.sin(seed * 12.9898 + a * 78.233) * 43758.5453 % 1 + 1) % 1 * 0;
  // 主血泊：椭圆 + 随机外溢小滴
  g.fillStyle = color || 'rgba(94,26,22,0.85)';
  g.beginPath();
  g.ellipse(S / 2, S / 2, S * 0.34, S * 0.24, seed * 0.7, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 5; i++) {
    const a = seed * 2.1 + i * 1.26;
    const rr = S * (0.34 + (i % 3) * 0.09);
    const px = S / 2 + Math.cos(a) * rr, py = S / 2 + Math.sin(a) * rr * 0.72;
    g.beginPath();
    g.ellipse(px, py, S * (0.05 + (i % 4) * 0.014), S * (0.035 + (i % 3) * 0.012), a, 0, Math.PI * 2);
    g.fill();
  }
  return cv;
}

function makeScorchTex(seed) {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.5);
  grd.addColorStop(0, 'rgba(10,10,12,0.92)');
  grd.addColorStop(0.45, 'rgba(16,15,17,0.72)');
  grd.addColorStop(0.78, 'rgba(34,30,28,0.35)');
  grd.addColorStop(1, 'rgba(40,34,30,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.5, 0, Math.PI * 2);
  g.fill();
  // 碎屑
  g.fillStyle = 'rgba(12,12,14,0.75)';
  for (let i = 0; i < 10; i++) {
    const a = seed * 3.3 + i * 0.63;
    const rr = S * (0.12 + (i % 5) * 0.07);
    const px = S / 2 + Math.cos(a) * rr, py = S / 2 + Math.sin(a) * rr;
    const s = S * (0.012 + (i % 3) * 0.008);
    g.fillRect(px, py, s, s);
  }
  return cv;
}

function decalTex(kind, v) {
  const list = DECAL_TEX[kind];
  if (!list.length) {
    if (kind === 'blood') for (let i = 0; i < 3; i++) list.push(makeBloodTex(i + 1));
    else if (kind === 'bloodA') for (let i = 0; i < 3; i++) list.push(makeBloodTex(i + 1, 'rgba(122,74,28,0.85)'));
    else for (let i = 0; i < 3; i++) list.push(makeScorchTex(i + 1));
  }
  return list[v % list.length];
}

// ---- 破损尸体：预渲染时挖掉一块肢体，被挖掉的那块单独留作「断肢」 ----
const WOUND_CACHE = new Map();   // name|color|wound → { body, limb }

function woundRnd(seed) {
  let t = (seed >>> 0) || 1;
  return () => { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; };
}

// 断口位置（0~1 的贴图坐标）：1 手臂 / 2 小腿 / 3 头
const WOUND_ANCHOR = {
  1: { x: 0.71, y: 0.42, r: 0.155 },   // 手臂
  2: { x: 0.44, y: 0.83, r: 0.165 },   // 小腿
  3: { x: 0.35, y: 0.16, r: 0.135 },   // 头
};

function woundPair(name, color, wound) {
  const key = name + '|' + color + '|' + wound;
  const hit = WOUND_CACHE.get(key);
  if (hit) return hit;
  const src = icon(name, color);
  if (!src) return null;
  const S = 96;
  const mk = () => {
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    return cv;
  };
  const body = mk(), limb = mk();
  const gb = body.getContext('2d');
  const gl = limb.getContext('2d');
  gb.drawImage(src, 0, 0, S, S);
  gl.drawImage(src, 0, 0, S, S);
  const anc = WOUND_ANCHOR[wound] || WOUND_ANCHOR[1];
  const rnd = woundRnd(wound * 7919 + name.length * 131 + color.charCodeAt(1));
  const cx = anc.x * S, cy = anc.y * S, rr = anc.r * S;
  const poly = [];
  const N = 11;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const rad = rr * (0.72 + rnd() * 0.62);
    poly.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad * 0.92]);
  }
  const path = (c) => {
    c.beginPath();
    c.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) c.lineTo(poly[i][0], poly[i][1]);
    c.closePath();
  };
  // 尸体：挖掉这块
  gb.globalCompositeOperation = 'destination-out';
  path(gb);
  gb.fill();
  gb.globalCompositeOperation = 'source-over';
  // 断肢：只保留这块
  gl.globalCompositeOperation = 'destination-in';
  path(gl);
  gl.fill();
  gl.globalCompositeOperation = 'source-over';
  const pair = { body, limb };
  WOUND_CACHE.set(key, pair);
  return pair;
}

function drawDecals(ctx, run, view, inView) {
  if (!view.decals || !run.decals || !run.decals.length) return;
  const ld = (d) => Math.min(1, d.life / ((d.max || 20) * 0.25));   // 最后 25% 淡出

  // 第一遍：地面层（血泊 / 载具下的焦黑 / 爆炸焦痕）——必须先铺完，
  // 否则后画的尸体自带血泊会盖住先画的尸体，尸体一多就糊成一锅红汤。
  for (const d of run.decals) {
    if (!inView(d.x, d.y)) continue;
    const fade = ld(d);
    if (d.k === 'zbody') {
      if (d.charred || d.blood == null) continue;   // 焦黑尸体不铺血泊（下面单独铺灰烬）
      const wounded = (d.wound || 0) > 0;
      const bt = decalTex('blood', d.blood || 0);
      const bs = 24 * (d.s || 1) * (wounded ? 1.15 : 1);
      ctx.globalAlpha = (wounded ? 0.46 : 0.38) * fade;
      ctx.drawImage(bt, d.x - bs / 2, d.y - bs / 2, bs, bs);
    } else if ((d.k === 'ubody' || d.k === 'rbody') && !d.veh && d.blood != null) {
      // 步兵尸体：先铺血泊（载具不流血，走下面的焦黑分支），再画尸体
      const bt = decalTex(d.k === 'rbody' ? 'bloodA' : 'blood', d.blood || 0);
      const bs = 24 * (d.s || 0.72) * 1.1;
      ctx.globalAlpha = 0.42 * fade;
      ctx.drawImage(bt, d.x - bs / 2, d.y - bs / 2, bs, bs);
    } else if ((d.k === 'ubody' || d.k === 'rbody') && d.veh) {
      const ud = UNITS[d.kind];
      const sz = 26 * (d.s || 1) * ((ud && ud.iconScale) || 1);
      const bt = decalTex('scorch', 0);
      ctx.globalAlpha = 0.5 * fade;
      ctx.drawImage(bt, d.x - sz * 0.9, d.y - sz * 0.9, sz * 1.8, sz * 1.8);
    } else if (d.k === 'scorch') {
      const st = decalTex('scorch', d.v || 0);
      const r2 = (d.r || 20) * 2;
      ctx.globalAlpha = 0.55 * fade;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot || 0);
      ctx.drawImage(st, -r2 / 2, -r2 / 2, r2, r2);
      // 炮击弹坑：补一块更实的坑心 + 一圈暗边，否则在大地图上会糊成一团烟
      if (d.crater) {
        const rr = d.r || 20;
        ctx.globalAlpha = 0.34 * fade;
        ctx.fillStyle = '#0b0908';
        ctx.beginPath();
        ctx.arc(0, 0, rr * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.4 * fade;
        ctx.strokeStyle = '#211a16';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, rr * 0.8, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 第二遍：尸体与断肢
  for (const d of run.decals) {
    if (!inView(d.x, d.y)) continue;
    const fade = ld(d);
    if (d.k === 'zbody') {
      const zd = ZOMBIES[d.mob];
      const vlist = zd && zd.icons;
      const nm = (vlist && vlist.length) ? vlist[(d.id || 0) % vlist.length] : ((zd && zd.icon) || 'zombie');
      const tint = d.charred ? '#241d1a' : '#7a2a20';
      const pair = d.wound ? woundPair(nm, tint, d.wound) : null;
      const img = pair ? pair.body : icon(nm, tint);
      const sz = 32 * (d.s || 1);
      ctx.globalAlpha = 0.66 * fade;
      if (img) {
        ctx.save();
        ctx.translate(d.x, d.y + sz * 0.12);
        ctx.rotate(d.rot || 0);
        ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      }
      // 断肢：只有前 6 秒存在，最后 1.5 秒淡出
      if (pair && d.wound && d.life > (d.max || 20) - 6) {
        const la = Math.min(1, (d.life - ((d.max || 20) - 6)) / 1.5) * 0.62;
        ctx.globalAlpha = la * fade;
        ctx.save();
        ctx.translate(d.x + (d.limbDx || 0), d.y + (d.limbDy || 0) + sz * 0.12);
        ctx.rotate(d.limbRot || 0);
        const ls = sz * 0.72;
        ctx.drawImage(pair.limb, -ls / 2, -ls / 2, ls, ls);
        ctx.restore();
      }
    } else if (d.k === 'ubody' || d.k === 'rbody') {
      const ud = UNITS[d.kind];
      const nm = (ud && (ud.icon || ud.kind)) || 'infantry';
      const img = icon(nm, d.k === 'rbody'
        ? (d.veh ? '#5a3d16' : '#6d4a1c')          // 叛军：琥珀棕
        : (d.veh ? '#3a3128' : '#39424e'));         // 我方：冷灰
      const sz = 26 * (d.s || 1) * ((ud && ud.iconScale) || 1);
      ctx.globalAlpha = 0.72 * fade;
      if (img) {
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(d.veh ? (d.rot || 0) : (Math.PI / 2) + (d.rot || 0));
        ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = 1;
}

