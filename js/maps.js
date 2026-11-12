// js/maps.js — 两张默认地图：城市 / 森林
// 只依赖 data.js 的 TILE / RULE / makeDefaultMap，不碰 DOM。
import { TILE, RULE, makeDefaultMap, markGarrison, markNodeHighland, BUILDING_SHAPES } from './data.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;

function blank(kind, name, core, w, h) {
  const W = w || RULE.grid.W, H = h || RULE.grid.H, T = RULE.grid.T;
  return {
    _id: 'm' + Math.random().toString(36).slice(2, 9),
    _rev: 0,
    schema: 'dcl.map/1',
    meta: { name, author: 'local', v: 1 },
    kind,
    w: W, h: H, tile: T,
    tiles: new Uint8Array(W * H),
    buildings: [],
    spawns: [],
    core,
    waves: [],
    dirty: true,
  };
}

const helpers = (map) => {
  const W = map.w;
  return {
    set: (x, y, v) => { if (x >= 0 && y >= 0 && x < map.w && y < map.h) map.tiles[y * W + x] = v; },
    get: (x, y) => (x >= 0 && y >= 0 && x < map.w && y < map.h ? map.tiles[y * W + x] : TILE.WATER),
    rect: (x, y, w, h, v) => {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        if (xx >= 0 && yy >= 0 && xx < map.w && yy < map.h) map.tiles[yy * W + xx] = v;
      }
    },
    tree: (x, y, hp) => {
      // 树 = 可破坏的阻挡物（僵尸会砍树开路）。
      // tone:'tree' 是绘制/悬停名/小地图三处的唯一开关，漏了就会画成灰方块、显示「建筑」。
      const t = { x, y, w: 1, h: 1, hp, maxHp: hp, destructible: true, kind: 'tree', tone: 'tree' };
      map.buildings.push(t);
      map.tiles[y * W + x] = TILE.BUILDING;
    },
  };
};


// 通用种树：只落在空地上，避开核心、路网路口、据点、资源点、刷怪口；
// 每棵树种下后立刻校验「所有刷怪口仍能到达核心」，挡死通路就拔掉。
// 取点全部由 hash 决定 ⇒ 同一张图每次结果一致，sim 可复现。
function plantTrees(map, opts = {}) {
  const { ring = 0, block = 0, hp = 150 } = opts;
  const W = map.w, H = map.h, core = map.core;
  const { get, tree } = helpers(map);
  const idx = (x, y) => y * W + x;
  const dist = (x, y) => Math.hypot(x - core.x, y - core.y);

  // 占位判定：用建筑的「包围盒」而不是 cells。
  // 可进入楼只把 cells 那几格设成 BUILDING，洞里是空地；树若长进洞里，
  // 点树时 main.js 的 building.find 会先命中那栋楼，面板就显示「可进入建筑」。
  const occupied = (x, y) => {
    for (const b of map.buildings) {
      if (b.hp <= 0) continue;
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return true;
    }
    return false;
  };
  const keepOut = [core, ...(map.spawns || []), ...(map.nodes || [])];
  const nearAny = (x, y, r) => keepOut.some((p) => Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const roadN = (x, y) => DIRS.filter(([dx, dy]) => get(x + dx, y + dy) === TILE.ROAD).length;
  const buildN = (x, y) => DIRS.filter(([dx, dy]) => get(x + dx, y + dy) === TILE.BUILDING).length;

  const canPlant = (x, y) => {
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    if (get(x, y) !== TILE.GROUND || occupied(x, y)) return false;
    if (nearAny(x, y, 2)) return false;
    if (dist(x, y) < 5) return false;    // 核心周围留空，别挡建造与出兵
    if (roadN(x, y) > 0) return false;   // 贴路的格子不放：那里是路口/巷口
    return true;
  };

  // 从核心泛洪（不穿建筑/水面），要求所有刷怪口仍然可达
  const spawnOk = () => {
    const seen = new Uint8Array(W * H);
    const q = [idx(core.x, core.y)];
    seen[q[0]] = 1;
    while (q.length) {
      const i = q.pop(), x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of DIRS) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = idx(xx, yy);
        if (seen[j]) continue;
        const t = get(xx, yy);
        if (t === TILE.BUILDING || t === TILE.WATER) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    return (map.spawns || []).every((s) => seen[idx(s.x, s.y)]);
  };

  const planted = [];
  const place = (x, y) => {
    for (const p of planted) {
      if (Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 2) return false; // 不挨着，别连成墙
    }
    tree(x, y, hp);
    if (!spawnOk()) {                    // 挡死通路 → 立刻拔掉
      map.tiles[idx(x, y)] = TILE.GROUND;
      map.buildings.pop();
      return false;
    }
    planted.push({ x, y });
    return true;
  };

  const ringCand = [], blockCand = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!canPlant(x, y)) continue;
      const d = dist(x, y);
      if (d >= 5 && d <= 12) ringCand.push({ x, y });
      if (buildN(x, y) >= 1) blockCand.push({ x, y });
    }
  }
  const order = (a) => hash(a.x * 29 + 7, a.y * 31 + 11);
  ringCand.sort((a, b) => order(a) - order(b));
  blockCand.sort((a, b) => order(a) - order(b));

  let nr = 0, nb = 0;
  for (const p of ringCand) { if (nr >= ring) break; if (place(p.x, p.y)) nr++; }
  for (const p of blockCand) { if (nb >= block) break; if (place(p.x, p.y)) nb++; }
  return { ring: nr, block: nb, total: planted.length };
}



// ============ 森林图（第三张）：一条大河 + 三座桥 + 密林 ============
// 主题波只在 forest 上生效（map.meta.themes），见 data.js 的 THEMES。
function makeForestMap() {
  const W = 76, H = 50;
  const map = blank('forest', '黑松林', { x: 61, y: 36 }, W, H);
  const { set, get, rect, tree } = helpers(map);
  const idx = (x, y) => y * W + x;

  // 1) 铺草
  rect(0, 0, W, H, TILE.GROUND);

  // 2) 边缘 2 圈：做成起伏的地形边界，不再留规整空地
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const edge = x < 2 || y < 2 || x >= W - 2 || y >= H - 2;
      if (!edge) continue;
      const h = hash(x * 13 + 5, y * 17 + 9);
      set(x, y, h < 0.62 ? TILE.HIGHLAND : TILE.LOWLAND);
    }
  }

  // 3) 大河：5 格宽，中段向西弯
  const riverX = (y) => (y < 14 ? 27 : y < 26 ? 25 : y < 38 ? 24 : 26);
  for (let y = 0; y < H; y++) {
    const rx = riverX(y);
    for (let d = 0; d < 5; d++) set(rx + d, y, TILE.WATER);
  }

  // 4) 主路（遇水跳过，桥在后面补）
  const drawH = (x0, x1, y) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (get(x, y) !== TILE.WATER) set(x, y, TILE.ROAD);
    }
  };
  const drawV = (x, y0, y1) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      if (get(x, y) !== TILE.WATER) set(x, y, TILE.ROAD);
    }
  };
  for (const ry of [10, 24, 39]) { drawH(3, 61, ry); drawH(3, 61, ry + 1); }
  drawV(61, 10, 41);
  drawV(62, 10, 41);
  drawH(44, 61, 30);

  // 5) 桥：最后画，覆盖河面上的路（否则会出现"水上高速公路"）
  const bridges = [10, 24, 39];
  for (const by of bridges) {
    // 桥与马路同宽（1 格），否则桥头会凸出来一块
    const rx = riverX(by);
    for (let x = rx - 1; x <= rx + 6; x++) set(x, by, TILE.BRIDGE);
  }

  // 6) 高低地：成片散布（给机枪位与惩罚位，也让地面有起伏）
  const blobs = [
    [30, 5, 5, 3, TILE.HIGHLAND], [14, 17, 5, 4, TILE.LOWLAND],
    [44, 30, 4, 4, TILE.HIGHLAND], [34, 43, 5, 3, TILE.LOWLAND],
    [53, 19, 4, 3, TILE.HIGHLAND], [8, 33, 4, 4, TILE.HIGHLAND],
    [66, 45, 4, 3, TILE.LOWLAND], [20, 8, 4, 3, TILE.LOWLAND],
  ];
  for (const [bx, by, bw, bh, tv] of blobs) {
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
        if (get(x, y) !== TILE.GROUND) continue;
        if (hash(x * 3 + 11, y * 5 + 7) < 0.18) continue;   // 留缝，别成方块
        set(x, y, tv);
      }
    }
  }

  // 7) 刷怪口 / 资源点 / 核心
  map.spawns = [
    { x: 3, y: 10, side: 0 },
    { x: 3, y: 24, side: 0 },
    { x: 3, y: 39, side: 0 },
  ];
  map.nodes = [];
  for (const [nx, ny] of [[14, 6], [14, 30], [40, 18], [40, 44], [52, 6], [52, 33]]) {
    map.nodes.push({ x: nx, y: ny, r: 1, owner: 0, guard: 0, cap: 0 });
  }
  const core = map.core;
  for (let y = 31; y < 42; y++) for (let x = 55; x < 68; x++) {
    if (get(x, y) === TILE.WATER || get(x, y) === TILE.BRIDGE) set(x, y, TILE.GROUND);
  }
  markNodeHighland(map);

  // 8) 建筑：林间废弃小屋，6~8 栋（避开路/水/桥/核心/据点/刷怪口）
  const RES = new Uint8Array(W * H);
  const res = (x, y, r) => {
    for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++) {
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) RES[yy * W + xx] = 1;
    }
  };
  res(core.x, core.y, 5);
  for (const n of map.nodes) res(n.x, n.y, 2);
  for (const sp of map.spawns) res(sp.x, sp.y, 2);
  for (const by of bridges) for (let x = 20; x < 36; x++) res(x, by, 1);

  const shapes = BUILDING_SHAPES.filter((sh) => sh.cells.length >= 2 && sh.cells.length <= 6);
  const fits = (x, y, sh) => {
    for (const [dx, dy] of sh.cells) {
      const xx = x + dx, yy = y + dy;
      if (xx < 2 || yy < 2 || xx >= W - 2 || yy >= H - 2) return false;
      if (get(xx, yy) !== TILE.GROUND) return false;
      if (RES[yy * W + xx]) return false;
    }
    return true;
  };
  const put = (x, y, sh) => {
    const hp = 180 * sh.cells.length;
    map.buildings.push({
      x, y, w: sh.w, h: sh.h,
      cells: sh.cells.map((c) => [c[0], c[1]]),
      shape: sh.id, hp, maxHp: hp, destructible: true,
    });
    for (const [dx, dy] of sh.cells) set(x + dx, y + dy, TILE.BUILDING);
  };
  let built = 0;
  for (let y = 2; y < H - 2 && built < 8; y++) {
    for (let x = 2; x < W - 2 && built < 8; x++) {
      if (get(x, y) !== TILE.GROUND) continue;
      if (hash(x * 7 + 3, y * 11 + 5) < 0.42) continue;   // 只在少数点位长楼
      const cands = shapes.filter((sh) => fits(x, y, sh));
      if (!cands.length) continue;
      const sh = cands[Math.floor(hash(x * 5 + 2, y * 13 + 7) * cands.length) % cands.length];
      put(x, y, sh);
      built++;
    }
  }

  // 9) 密林：hash 决定位置（同图可复现），避开路/水/桥/建筑/核心/入口/据点
  const roadNear = (x, y, r) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (get(x + dx, y + dy) === TILE.ROAD) return true;
    }
  };
  const keep = [core, ...map.spawns, ...map.nodes];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const t = get(x, y);
      if (t !== TILE.GROUND && t !== TILE.HIGHLAND && t !== TILE.LOWLAND) continue;
      // 粗层（4×4 一块）决定这一片该密还是该疏，细层打散格子感
      const coarse = hash(Math.floor(x / 4) * 7 + 1, Math.floor(y / 4) * 11 + 3);
      const fine = hash(x * 13 + 5, y * 17 + 9);
      const dens = coarse * 0.20 + fine * 0.80;
      if (dens < 0.52) continue;
      if (Math.hypot(x - core.x, y - core.y) < 6) continue;
      if (roadNear(x, y, 2)) continue;
      if (RES[idx(x, y)]) continue;
      if (keep.some((q) => Math.abs(q.x - x) <= 2 && Math.abs(q.y - y) <= 2)) continue;
      if (map.buildings.some((b) => x >= b.x - 1 && x < b.x + b.w + 1 && y >= b.y - 1 && y < b.y + b.h + 1)) continue;
      tree(x, y, 150);
    }
  }

  // 10) 连通性兜底：树成团可能把某个刷怪口封死 —— 通不了就拔掉三分之一，最多 6 轮
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const spawnOk = () => {
    const seen = new Uint8Array(W * H);
    const q = [idx(core.x, core.y)];
    seen[q[0]] = 1;
    while (q.length) {
      const i = q.pop(), x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of DIRS4) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = idx(xx, yy);
        if (seen[j]) continue;
        const t = get(xx, yy);
        if (t === TILE.BUILDING || t === TILE.WATER) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    return (map.spawns || []).every((sp) => seen[idx(sp.x, sp.y)]);
  };
  for (let attempt = 0; attempt < 6 && !spawnOk(); attempt++) {
    const trees = map.buildings.filter((b) => b.tone === 'tree');
    if (!trees.length) break;
    const cut = Math.max(1, Math.ceil(trees.length / 3));
    for (let i = 0; i < cut; i++) {
      const b = trees[trees.length - 1 - i];
      set(b.x, b.y, TILE.GROUND);
      const at = map.buildings.indexOf(b);
      if (at >= 0) map.buildings.splice(at, 1);
    }
  }

  map.meta = {
    name: '黑松林',
    author: 'local',
    v: 1,
    style: 'forest',
    desc: '一条大河把林子劈成两半，三座桥是唯一通道。树木可砍伐清出射界，河面不可通行；林间小屋可进驻，坡地与洼地会改变射程。',
    waveMul: 0.37,
    startSupply: 1100,
    maxSpec: 2,
    bgm: 'forest',
    themes: ['swarm', 'armor', 'special', 'rush'],
  };
  map.core = { x: 61, y: 36 };
  return map;
}

export const MAP_KINDS = ['city17', 'forest', 'oldtown'];   // 顺序即难度递进：开阔城区 → 独木桥森林 → 窄巷老城

export const MAP_LABEL = {
  city17: 'city-17',
  oldtown: 'Rust Block',
  forest: '黑松林',
};

// 旧 id 兼容：?map=city / ?map=city3 / ?map=harbor 仍然能开（分别落到 city-17 和 老城）
const MAP_ALIAS = { city: 'city17', city3: 'city17', harbor: 'oldtown' };


// ---------------- 老城（不规则路网：弯曲大道 + 错位小街 + 阶梯斜街 + 广场）----------------
function makeOldtownMap() {
  const W = 88, H = 60;
  const core = { x: 64, y: 30 };
  const map = blank('oldtown', 'Rust Block', core, W, H);
  map.meta.style = 'harbor';
  // 老城独立波次强度：5 个出口、最近 22 格，按 city-17 的 3 口同侧算量会直接压死。
  // 0.45 是同 seed 实测出来的分界：0.7 只有「无特感」能过，0.5 标准档会僵持到超时，
  // 0.45 标准档可通关（核心剩 582）。
  map.meta.waveMul = 0.90;   // 第三张图（最难）：0.45 -> 0.70 -> 0.90，向「比 city-17 更难」收；再高会压垮首波经济
  // 这张图不提供「狂暴」特感档：5 个出口 + 两个近口，狂暴档任何资金/布防都守不住。
  // 标题页会把「狂暴」置灰；带 ?spec=2 直连也会被 createRun 压回「标准」。
  map.meta.maxSpec = 1;
  // 叛军强度全图统一（2026-11-07 用户要求取消老城额外折扣，两图都走 RULE.raider.scale）。
  // 开局资金：老城 5 个出口、核心离最近口 22 格，400/700/1000/1200 都来不及铺第一圈火力，给到 1400（上限 1500，留 100 缓冲）
  map.meta.startSupply = 1400;
  const { set, get, rect, tree } = helpers(map);
  const R = (x, y) => set(x, y, TILE.ROAD);

  // 1) 街道骨架：竖 7 条 / 横 5 条，宽窄相间（2~3 格为主干，1 格为巷）
  const VS = [[6, 1], [17, 2], [29, 1], [40, 2], [52, 1], [63, 2], [75, 1]];
  const HS = [[5, 1], [15, 2], [26, 1], [37, 2], [48, 1], [55, 2]];
  for (const [x0, w] of VS) for (let y = 0; y < H; y++) for (let d = 0; d < w; d++) R(x0 + d, y);
  for (const [y0, w] of HS) for (let x = 0; x < W; x++) for (let d = 0; d < w; d++) R(x, y0 + d);

  // 2) 局部「鼓包」：让部分街区被街道咬掉一角，形状不规整
  for (const [bx, by, bw, bh] of [[9, 18, 5, 4], [33, 7, 4, 5], [46, 40, 6, 4], [70, 18, 4, 4], [20, 50, 5, 3], [56, 28, 4, 3]]) rect(bx, by, bw, bh, TILE.ROAD);

  // 3) 一条西南→东北的斜街，切开若干街区（阶梯式，宽 2）
  for (let y = 58, x = 2; y >= 20; y--) {
    if ((58 - y) % 4 === 2) x += 1;
    R(x, y); R(x + 1, y);
  }

  // 4) 广场 + 据点环路
  rect(22, 30, 8, 7, TILE.ROAD);
  for (let y = core.y - 6; y <= core.y + 6; y++) {
    for (let x = core.x - 6; x <= core.x + 6; x++) {
      const edge = Math.abs(x - core.x) === 6 || Math.abs(y - core.y) === 6;
      if (edge) R(x, y);
    }
  }

  // 5) 地形：广场旁的小公园 + 几处高地/低地/废墟（先铺地形，后面建筑自动避开）
  rect(30, 41, 6, 5, TILE.HIGHLAND);
  rect(58, 9, 5, 4, TILE.HIGHLAND);
  rect(12, 24, 4, 4, TILE.LOWLAND);
  rect(74, 43, 5, 4, TILE.LOWLAND);
  rect(43, 18, 3, 2, TILE.RUBBLE);
  rect(8, 46, 3, 2, TILE.RUBBLE);

  // 6) 保留区：据点、广场、资源点、刷怪口附近不长楼
  const RES = new Uint8Array(W * H);
  const res = (x, y, r) => {
    for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++) {
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) RES[yy * W + xx] = 1;
    }
  };
  // 核心周围只留 ±4 格空场（够出兵与贴脸防守），4~7 格环带交给街区；
  // ±6 那圈是环路（已是 ROAD，本来就不长楼），刷怪口回据点的通路由第 9 步 carve 强行开出
  res(core.x, core.y, 4);
  for (let y = 29; y <= 38; y++) for (let x = 21; x <= 31; x++) RES[y * W + x] = 1;
  const nodePos = [
    { x: 11, y: 11, kind: 'cash' }, { x: 35, y: 52, kind: 'parts' },
    { x: 47, y: 9, kind: 'cash' }, { x: 24, y: 19, kind: 'parts' },
    { x: 69, y: 9, kind: 'cash' }, { x: 83, y: 51, kind: 'parts' },
  ];
  for (const n of nodePos) res(n.x, n.y, 2);
  const spawnPos = [{ x: 2, y: 9 }, { x: 2, y: 47 }, { x: 45, y: 2 }, { x: 86, y: 33 }, { x: 62, y: 57 }];
  for (const sp of spawnPos) res(sp.x, sp.y, 2);

  // 7) 密集街区：2~7 格的碎地块铺满，随机留 1 格巷/内院
  const shapes = BUILDING_SHAPES.filter((s) => s.cells.length >= 2 && s.cells.length <= 7);
  const fits = (x, y, s) => {
    for (const [dx, dy] of s.cells) {
      const xx = x + dx, yy = y + dy;
      if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) return false;
      if (get(xx, yy) !== TILE.GROUND) return false;
      if (RES[yy * W + xx]) return false;
    }
    return true;
  };
  const put = (x, y, s) => {
    const hp = 180 * s.cells.length;
    map.buildings.push({
      x, y, w: s.w, h: s.h,
      cells: s.cells.map((c) => [c[0], c[1]]),
      shape: s.id, hp, maxHp: hp, destructible: true,
    });
    for (const [dx, dy] of s.cells) set(x + dx, y + dy, TILE.BUILDING);
  };
  let built = 0;
  for (const pass of [7, 5, 3]) {
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (get(x, y) !== TILE.GROUND || RES[y * W + x]) continue;
        if (hash(x * 3 + 1, y * 7 + 5) < 0.12) continue;      // 留缝：巷子与内院
        const room = hash(x * 5 + 2, y * 11 + 3);
        if (pass < 6 && room > 0.35 + pass * 0.1) continue;   // 大块优先，小块补缝
        const cands = shapes.filter((s) => s.cells.length <= pass && fits(x, y, s));
        if (!cands.length) continue;
        const s = cands[Math.floor(hash(x * 7 + 3, y * 13 + 9) * cands.length) % cands.length];
        put(x, y, s);
        built++;
      }
    }
  }

  // 7.5) 核心环带补楼：老城核心被环路 + 5 条放射街道切得太碎，随机填充放不下 2 格形状，
  //      导致核心 ±9 格几乎没有楼可依托。这里用 1~7 格小楼在 ±5..±9 环带补出街区，
  //      范围只到 ±9，且第 9 步 carve 仍会为每个刷怪口强行拆出通路，不会把核心堵死。
  const coreFills = shapes.slice().sort((a, b) => b.cells.length - a.cells.length);
  for (let y = core.y - 9; y <= core.y + 9; y++) {
    for (let x = core.x - 9; x <= core.x + 9; x++) {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const d = Math.max(Math.abs(x - core.x), Math.abs(y - core.y));
      if (d < 5 || d > 9) continue;
      if (get(x, y) !== TILE.GROUND || RES[y * W + x]) continue;
      if (hash(x * 13 + 7, y * 17 + 5) < 0.3) continue;       // 留出巷口，别铺成实心
      const s = coreFills.find((c) => fits(x, y, c));
      if (s) { put(x, y, s); built++; continue; }
      // 连 2 格都放不下时补一栋单格小楼，保证有掩体
      map.buildings.push({
        x, y, w: 1, h: 1, cells: [[0, 0]], shape: 's1',
        hp: 180, maxHp: 180, destructible: true,
      });
      set(x, y, TILE.BUILDING);
      built++;
    }
  }

  // 8) 连通性兜底：把被围死的空地并进楼里，别留「僵尸进不去也出不来」的口袋
  const walkable = (x, y) => {
    const t = get(x, y);
    return t !== TILE.BUILDING && t !== TILE.WATER && x >= 0 && y >= 0 && x < W && y < H;
  };
  const seen = new Uint8Array(W * H);
  const stack = [[core.x, core.y]];
  seen[core.y * W + core.x] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (seen[yy * W + xx]) continue;
      if (!walkable(xx, yy)) continue;
      seen[yy * W + xx] = 1;
      stack.push([xx, yy]);
    }
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (seen[y * W + x]) continue;
      const t = get(x, y);
      if (t === TILE.GROUND || t === TILE.ROAD) set(x, y, TILE.BUILDING);
    }
  }

  // 9) 刷怪口：清出 3x3，并保证有一条街连到据点
  map.spawns = spawnPos.slice();
  const carve = (sx, sy) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        for (let i = map.buildings.length - 1; i >= 0; i--) {
          const b = map.buildings[i];
          const hit = b.cells ? b.cells.some(([cx, cy]) => b.x + cx === x && b.y + cy === y) : (b.x === x && b.y === y);
          if (hit) map.buildings.splice(i, 1);
        }
        set(x, y, TILE.GROUND);
      }
    }
    let x = sx, y = sy, guard = 0;
    while (guard++ < 400) {
      if (Math.abs(x - core.x) <= 3 && Math.abs(y - core.y) <= 3) break;
      if (get(x, y) === TILE.BUILDING) {
        for (let i = map.buildings.length - 1; i >= 0; i--) {
          const b = map.buildings[i];
          const hit = b.cells ? b.cells.some(([cx, cy]) => b.x + cx === x && b.y + cy === y) : (b.x === x && b.y === y);
          if (hit) map.buildings.splice(i, 1);
        }
      }
      if (get(x, y) !== TILE.WATER) set(x, y, TILE.ROAD);
      if (Math.abs(core.x - x) > Math.abs(core.y - y)) x += Math.sign(core.x - x);
      else y += Math.sign(core.y - y);
    }
  };
  for (const sp of map.spawns) carve(sp.x, sp.y);

  // 10) 资源点：清出 5x5 空地 + 拉一条路回据点
  map.nodes = nodePos.map((n) => ({ x: n.x, y: n.y, kind: n.kind }));
  for (const n of map.nodes) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = n.x + dx, y = n.y + dy;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        for (let i = map.buildings.length - 1; i >= 0; i--) {
          const b = map.buildings[i];
          const hit = b.cells ? b.cells.some(([cx, cy]) => b.x + cx === x && b.y + cy === y) : (b.x === x && b.y === y);
          if (hit) map.buildings.splice(i, 1);
        }
        if (get(x, y) !== TILE.WATER) set(x, y, TILE.GROUND);
      }
    }
    let x = n.x, y = n.y, guard = 0;
    while (guard++ < 400) {
      if (Math.abs(x - core.x) <= 3 && Math.abs(y - core.y) <= 3) break;
      if (get(x, y) !== TILE.WATER) set(x, y, TILE.ROAD);
      if (Math.abs(core.x - x) > Math.abs(core.y - y)) x += Math.sign(core.x - x);
      else y += Math.sign(core.y - y);
    }
  }
  markNodeHighland(map);

  // 11) 少量树：只落在空地上（不占马路），老城 20 棵
  plantTrees(map, { ring: 0, block: 20 });

  // 12) 据点收尾
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set(core.x + dx, core.y + dy, TILE.GROUND);
  set(core.x, core.y, TILE.GROUND);
  markGarrison(map);
  return map;
}

// ---------------- city-17（默认城市图 + 叛军派系；开局资金 400）----------------
function makeCity17Map() {
  const map = makeDefaultMap();
  map.kind = 'city17';
  map.id = 'city17';
  map.name = 'city-17';
  map.meta = { ...(map.meta || {}), style: 'city', raider: true, startSupply: 600 };
  // 少量树：核心环 10 棵（填空场但不挡建造主轴）+ 街区空洞 30 棵
  plantTrees(map, { ring: 10, block: 30 });
  return map;
}

export function makeMap(kind) {
  const k = MAP_ALIAS[kind] || kind;
  if (k === 'oldtown') return makeOldtownMap();
  if (k === 'forest') return makeForestMap();
  return makeCity17Map();
}
