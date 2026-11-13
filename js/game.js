// js/game.js — 纯逻辑：无 DOM / window / canvas / rAF，可直接被 node 导入做无头模拟
import { RNG, MinHeap, clamp } from './util.js';
import { TILE, TERRAIN, UNITS, FORTS, ZOMBIES, RULE, SPEC_SCHEMES, SKILLS, HERO_SKILLS, ARMOR, NODE_TYPES, PROD_GROUPS, CORE_PROD, SPECIAL_IDS, GARRISON, STANCE, COMMAND, ZOMBIE_GARRISON, PERKS, PERK_WAVES, PERK_SECS, THEMES } from './data.js';

const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];

export const PHASE = Object.freeze({ PREP: 'prep', BATTLE: 'battle', WON: 'won', LOST: 'lost' });

// 事件队列上限：以前每个 push 点自己判 `events.length < 48`，漏了十几处就会无限增长。
// 现在所有派发都走 emit()，上限只在这里判一次；读取端（main.js drainEvents）照旧整批消费。
export const EVENTS_MAX = 48;
// 地面贴花（尸体 / 焦痕）上限：满了顶掉同类型最旧的一条，永不超过表里的数字
export const DECAL_CAP = Object.freeze({ zbody: 80, ubody: 5, rbody: 10, scorch: 18 });
export const DECAL_LIFE = Object.freeze({ zbody: 20, ubody: 20, rbody: 20, scorch: 16 });

// 手机档（touch 层设置 window.__dshMobile）：尸体/痕迹减量 + 寿命缩短
export const DECAL_CAP_MOBILE = Object.freeze({ zbody: 24, ubody: 2, rbody: 4, scorch: 8 });
const DECAL_LIFE_MOBILE = Object.freeze({ zbody: 8, ubody: 8, rbody: 8, scorch: 6 });
export function mobileTuned() { return typeof window !== 'undefined' && !!window.__dshMobile; }
export function decalCap() { return mobileTuned() ? DECAL_CAP_MOBILE : DECAL_CAP; }
export function decalLife() { return mobileTuned() ? DECAL_LIFE_MOBILE : DECAL_LIFE; }

function pushDecal(run, d) {
  run._decalVer = (run._decalVer || 0) + 1;
  if (!run.decals) run.decals = [];
  const cap = decalCap()[d.k] || 40;
  let n = 0;
  for (const e of run.decals) if (e.k === d.k) n++;
  // 一次裁到 cap-1：既有「满了顶掉最旧一条」的常态，也能收拾历史超额的数组
  while (n >= cap) {
    const i = run.decals.findIndex((e) => e.k === d.k);
    if (i < 0) break;
    run.decals.splice(i, 1);
    n--;
  }
  run.decals.push(d);
  return d;
}

export function emit(run, ev) {
  const q = run.events;
  if (q.length < EVENTS_MAX) q.push(ev);
  return ev;
}

let _mapSeq = 0;   // 克隆地图的兜底 id：递增计数而不是随机数，回放/对战同步才可复现
export function cloneMap(map) {
  return {
    _id: map._id || 'm' + (++_mapSeq),
    _rev: map._rev || 0,
    schema: map.schema || 'dcl.map/1',
    meta: { ...map.meta },
    w: map.w, h: map.h, tile: map.tile,
    tiles: new Uint8Array(map.tiles),
    buildings: map.buildings.map((b) => ({ ...b })),
    spawns: map.spawns.map((s) => ({ ...s })),
    core: { ...map.core },
    nodes: (map.nodes || []).map((n) => ({ ...n })),
    waves: (map.waves || []).map((w) => JSON.parse(JSON.stringify(w))),
    dirty: true,
  };
}

// 在地图上随机撒一批游荡僵尸（不打据点，只给占点添阻力）
function spawnRoamers(run) {
  const cfg = RULE.roam || {};
  const n = cfg.count || 0;
  if (!n) return;
  const { w, h } = run.map;
  const T = run.map.tile;
  const core = run.core;
  let placed = 0, guard = 0, roamerHp = 0;
  while (placed < n && guard < n * 60) {
    guard++;
    // 距离加权：每个位置抽 picks 次，留离据点最远的那次（越靠外围越密）
    const picks = Math.max(1, cfg.outerBias || 1);
    let bx = -1, by = -1, bd = -1;
    for (let k = 0; k < picks; k++) {
      const cx0 = 1 + Math.floor(run.rng.next() * (w - 2));
      const cy0 = 1 + Math.floor(run.rng.next() * (h - 2));
      const tile0 = run.map.tiles[cy0 * w + cx0];
      if (!TERRAIN[tile0] || !TERRAIN[tile0].walkable) continue;
      if (run._fortTile && run._fortTile.has(cy0 * w + cx0)) continue;
      const d0 = Math.hypot(cx0 - core.x, cy0 - core.y);
      if (d0 < (cfg.minCoreTiles || 8)) continue;
      const b0 = (run.map.buildings || []).some((bb) => cx0 >= bb.x && cx0 < bb.x + bb.w && cy0 >= bb.y && cy0 < bb.y + bb.h);
      if (b0) continue;
      if (d0 > bd) { bd = d0; bx = cx0; by = cy0; }
    }
    if (bx < 0) continue;
    const tx = bx, ty = by;
    if (!spawnZombie(run, 'walker', { x: tx, y: ty })) break;
    const z = run.zombies[run.zombies.length - 1];
    z.roamer = true;
    z.home = { x: tx, y: ty };
    z.patrolR = cfg.patrolR || 7;
    z.wp = null;
    z.idleT = 0;
    z.pathEpoch = -1;
    placed++;
    roamerHp += z.maxHp || 0;
  }
  run.stats.roamers = placed;
  // 供顶栏「僵尸力量」当分母：游荡者这批的初始总血量（要累加实际 maxHp，
  // 变异开启时行尸血量是 35/40/46 三档，用固定 40 会从一开始就不是 100%）
  run.roamerHp = roamerHp;
  // 游荡者不走「本波已出场」这条账，清掉它刚才累加进去的血量
  run.waveSpawnedHp = 0;
}

export function createRun(map, opts = {}) {
  const w = map.w, h = map.h, size = w * h;
  const run = {
    map,
    phase: PHASE.PREP,
    seed: opts.seed || 1,
    rng: new RNG(opts.seed || 1),
    fxRng: new RNG((opts.seed || 1) ^ 0x9e3779b9),   // 只给粒子/数字用，保证玩法随机不受影响
    roamRng: new RNG((opts.seed || 1) ^ 0x5f356495),  // 游荡者巡逻点/停顿，单独一条流，别污染波次随机
  critRng: new RNG((opts.seed || 1) ^ 0x2c1b3c6d),  // 暴击判定，单独一条流
  zRng: new RNG((opts.seed || 1) ^ 0x7a3e1b93),     // 行尸个体差异，单独一条流（别污染波次）
  zVaryOn: opts.zVary !== false,                    // 行尸形态差异开关（默认开）
  critOn: opts.crit === true,                       // 暴击开关（默认关，由暂停菜单控制）
  perks: new Set(),                                  // 已拿的核心升级（id）
  perkRng: new RNG((opts.seed || 1) ^ 0x3f2a7c1d),   // 三选一抽卡，单独一条流
  pendingPerk: null,                                 // { options: [id,id,id], t: 秒 } 待选

  msIdx: 0,                                         // 无尽模式已达成的里程碑档位下标
    time: 0,
    frame: 0,
    supply: opts.supply != null ? opts.supply
      : (map.meta && map.meta.startSupply != null ? map.meta.startSupply : RULE.supply.start),
    build: { ...RULE.build, ...(opts.build || {}) },   // 玩家可调的建造范围
    parts: opts.parts != null ? opts.parts : RULE.parts.start,
    queue: [],
    towCdUntil: {},          // 每种炮台各自的冷却到期时间（run.time 计时）
    coreLevel: 1,
    swapUsed: 0,             // 本整备期已兑换次数（资金↔零件，每波上限 RULE.econ.swap.perWave）
    _qTile: new Map(),
    _pathCache: new Map(),   // 寻路缓存：同 (起点,终点,口径) 在 fort/建筑变化（epoch）内复用
    _pathCacheEpoch: -1,
    // 资源点：owner 0=中立 1=玩家；cap -1..1 为占领/被攻陷进度
    nodes: (map.nodes || []).map((n, i) => {
      // 落点合法化：不能在建筑/水面上，就近找一格可站的
      let bx = n.x, by = n.y;
      if (!TERRAIN[map.tiles[by * map.w + bx]] || !TERRAIN[map.tiles[by * map.w + bx]].walkable) {
        let best = null, bd = 1e9;
        for (let dy = -5; dy <= 5; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            const x = n.x + dx, y = n.y + dy;
            if (x < 1 || y < 1 || x >= map.w - 1 || y >= map.h - 1) continue;
            const t = map.tiles[y * map.w + x];
            if (!TERRAIN[t].walkable || t === TILE.BUILDING) continue;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = { x, y }; }
          }
        }
        if (best) { bx = best.x; by = best.y; }
      }
      return { id: 'n' + i, x: bx, y: by, kind: n.kind, owner: 0, cap: 0 };
    }),
    core: { x: map.core.x, y: map.core.y, hp: RULE.core.hp, maxHp: RULE.core.hp },
    waveIndex: 0,
    totalWaves: opts.waves || RULE.wave.total,
  endless: opts.endless === true,
    // waveMul：单张地图的波次强度系数（老城 5 个出口，默认强度扛不住），不改全局难度
    waveCfg: opts.waveCfg || {
      base: RULE.wave.threatBase,
      grow: RULE.wave.threatGrow,
      final: RULE.wave.finalMult,
      mul: (map.meta && map.meta.waveMul) || 1,
    },
    wave: null,
    waveTimer: 0,
    prepTimer: RULE.prep.duration,
    units: [],
    forts: [],
    zombies: [],
    raiders: [],             // 叛军（劫掠者）：第三方红方人类；与僵尸的 z.raider 抢点队无关
    raiderOn: !!opts.raider, // 需 ?raider=1 才开（默认关）
    raiderPush: false,       // 第 pushWave 波起全员扑核心
    raiderNode: null,        // 叛军占的那个资源点 id
    effects: [],
    decals: [],        // 地面贴花：尸体 / 爆炸焦痕（画在单位下层）
    floats: [],          // 伤害数字（纯可视化）
    events: [],
    nextId: 1,
    epoch: 1,
    godMode: !!opts.god,
    aggro: opts.aggro == null ? 1 : Math.max(0, Math.min(2, opts.aggro | 0)),
    // 地图可以限制特感档上限（老城狂暴档无解，meta.maxSpec = 1）
    spec: Math.min(
      map.meta && map.meta.maxSpec != null ? map.meta.maxSpec | 0 : SPEC_SCHEMES.length - 1,
      opts.spec == null ? 0 : Math.max(0, Math.min(SPEC_SCHEMES.length - 1, opts.spec | 0)),
    ),
    skills: { strike: 0, fire: 0 },      // 剩余冷却
    pending: [],                          // 延迟生效的技能（炮击轮次等）
    heroCd: {},                           // 英雄技能剩余冷却（grenade / warcry）
    heroDown: null,                       // 英雄重伤中：{ x, y, xp, respawnAt }
    heroDowns: 0,                         // 已倒地次数（决定复活时长递增）
    buzzedUntil: 0,                       // 战吼到期时刻（run.time 计时）
    zones: [],                            // 持续区域（燃烧弹）
    _um: null,
    debug: !!opts.debug,
    warnings: [],
    stats: {
      kills: 0, spawned: 0, leaks: 0, fortLost: 0, buildingDown: 0,
      spent: 0, earned: 0, peak: 0, pathCalls: 0, pathFail: 0, wavesCleared: 0,
      friendlyDamage: 0, friendlyKills: 0,
    },
    riseCount: 0,        // 本波已转化出的行尸数（每波清零）
    riseQueue: [],       // 待起身的行尸（延迟队列）
    ffOn: opts.ff !== false,   // 友军伤害（暂停菜单可关）
    _blocked: new Uint8Array(size),
    _blockedEpoch: -1,
    _blockedU: new Uint8Array(size),
    _blockedUT: new Uint8Array(size),
    _blockedUTStamp: -1,
    _blockedUStamp: -1,
    _bTile: new Int16Array(size).fill(-1),
    _fortTile: new Map(),
    _astar: {
      g: new Float32Array(size),
      came: new Int32Array(size),
      seen: new Uint32Array(size),
      stamp: 0,
      heap: new MinHeap(),
    },
  };
  indexBuildings(run);
  rebuildForts(run);
  ensureRooms(run);
  spawnRoamers(run);
  if (run.raiderOn) initRaiders(run);

  return run;
}

export function buildingCells(b) {
  if (b && b.cells && b.cells.length) return b.cells;
  const out = [];
  const w = (b && b.w) || 0, h = (b && b.h) || 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push([x, y]);
  return out;
}

function indexBuildings(run) {
  const b = run._bTile;
  b.fill(-1);
  run.map.buildings.forEach((bd, i) => {
    for (const [dx, dy] of buildingCells(bd)) {
      const x = bd.x + dx, y = bd.y + dy;
      if (x >= 0 && y >= 0 && x < run.map.w && y < run.map.h) b[y * run.map.w + x] = i;
    }
  });
}

function fortSize(kind) {
  const d = FORTS[kind];
  return (d && d.size) || 1;
}

function fortTiles(f) {
  const s = fortSize(f.kind), out = [];
  for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) out.push([f.tx + dx, f.ty + dy]);
  return out;
}

function rebuildForts(run) {
  run._fortTile.clear();
  for (const f of run.forts) {
    if (f.hp <= 0) continue;
    for (const [x, y] of fortTiles(f)) run._fortTile.set(y * run.map.w + x, f);
  }
  run._blockedEpoch = -1;
}

function bumped(run) { run.epoch++; run._blockedEpoch = -1; run._pathCache.clear(); run._pathCacheEpoch = run.epoch; }

// 单位索引唯一重建点：任何「加/删单位」都以本函数产出为准，避免 _um 与 run.units 漂移
function reindexUnits(run, dt = 0) {
  const um = run._um || (run._um = new Map());
  um.clear();
  for (const u of run.units) { um.set(u.id, u); u.recentShot = Math.max(0, (u.recentShot || 0) - dt); }
}

function buildBlockedUnits(run, ignoreTrees) {
  const key = ignoreTrees ? '_blockedUT' : '_blockedU';
  const stamp = ignoreTrees ? '_blockedUTStamp' : '_blockedUStamp';
  if (run[stamp] === run.epoch) return run[key];
  if (!run[key]) run[key] = new Uint8Array(run.map.w * run.map.h);
  const bl = run[key];
  bl.fill(0);
  const tiles = run.map.tiles;
  for (let i = 0; i < tiles.length; i++) if (!TERRAIN[tiles[i]].walkable) bl[i] = 1;
  if (ignoreTrees) for (const i of treeIndexSet(run)) bl[i] = 0;
  run[stamp] = run.epoch;
  return bl;
}

// 树是静态地形，所以这里只算一次并挂在 run 上。
// 以后若支持运行时种草/砍树（编辑器或技能），必须跟着 run.epoch 一起失效，否则寻路会一直以为那儿有树。
function treeIndexSet(run) {
  if (run._treeSet) return run._treeSet;
  const w = run.map.w;
  const st = new Set();
  for (const b of (run.map.buildings || [])) {
    if (b.tone !== 'tree') continue;
    if (b.cells) for (const [cx, cy] of b.cells) st.add((b.y + cy) * w + (b.x + cx));
    else st.add(b.y * w + b.x);
  }
  run._treeSet = st;
  return st;
}

function buildBlocked(run, softBarricade, ignoreTrees) {
  const cacheKey = ignoreTrees ? '_blockedZT' : softBarricade ? '_blockedSoft' : '_blocked';
  const stampKey = ignoreTrees ? '_blockedZTEpoch' : softBarricade ? '_blockedSoftEpoch' : '_blockedEpoch';
  if (run[stampKey] === run.epoch) return run[cacheKey];
  if (!run[cacheKey]) run[cacheKey] = new Uint8Array(run.map.w * run.map.h);
  const bl = run[cacheKey];
  bl.fill(0);
  const tiles = run.map.tiles;
  for (let i = 0; i < tiles.length; i++) if (!TERRAIN[tiles[i]].walkable) bl[i] = 1;
  if (ignoreTrees) for (const i of treeIndexSet(run)) bl[i] = 0;
  for (const f of run.forts) {
    if (!(f.hp > 0 && f.blocks)) continue;
    // 路障只拦载具：步兵寻路走 softBarricade 版本，把路障当可通行
    if (softBarricade && f.kind === 'barricade') continue;
    bl[f.ty * run.map.w + f.tx] = 1;
  }
  run[stampKey] = run.epoch;
  return bl;
}

export function findPath(run, sx, sy, gx, gy, ignoreForts = false, softBarricade = false, ignoreTrees = false) {
  const cache = run._pathCache;
  if (!cache) return findPathRaw(run, sx, sy, gx, gy, ignoreForts, softBarricade, ignoreTrees);
  // 建筑塌成碎石/工事增删都会 bumped()，epoch 变了缓存自然失效
  if (run._pathCacheEpoch !== run.epoch) { cache.clear(); run._pathCacheEpoch = run.epoch; }
  // key 打包成整数（1024 进制 ×8 个口径 = 8.8e12，仍在 2^53 内）：地图宽高都 <1024 时不会碰撞。
  // 越界坐标不走缓存，直接现算，避免和合法坐标撞 key。
  if (sx < 0 || sy < 0 || gx < 0 || gy < 0 || sx > 1023 || sy > 1023 || gx > 1023 || gy > 1023) {
    return findPathRaw(run, sx, sy, gx, gy, ignoreForts, softBarricade, ignoreTrees);
  }
  const ck = (((((sx * 1024 + sy) * 1024 + gx) * 1024 + gy) * 2 + (ignoreForts ? 1 : 0)) * 2 + (softBarricade ? 1 : 0)) * 2 + (ignoreTrees ? 1 : 0);
  const hit = cache.get(ck);
  if (hit !== undefined) return hit ? hit.slice() : null;
  const hit0 = run._pathBudgetHit || 0;
  const res = findPathRaw(run, sx, sy, gx, gy, ignoreForts, softBarricade, ignoreTrees);
  // 预算耗尽（大图+绕河）时返回的 null 是「没算完」，不是「不可达」。
  // 把它写进缓存会让这张图整个 epoch 都认为那条路不存在，必须跳过缓存。
  if ((run._pathBudgetHit || 0) === hit0) {
    if (cache.size > 4096) cache.clear();   // 兜底：地图切换/极端情况下不清零会吃内存
    cache.set(ck, res);
  }
  return res ? res.slice() : null;
}

function findPathRaw(run, sx, sy, gx, gy, ignoreForts, softBarricade, ignoreTrees) {
  const W = run.map.w, H = run.map.h;
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
  const blocked = ignoreForts ? buildBlockedUnits(run, ignoreTrees) : buildBlocked(run, softBarricade, ignoreTrees);
  const start = sy * W + sx, goal = gy * W + gx;
  if (blocked[goal]) return null;
  if (start === goal) return [goal];

  const s = run._astar;
  s.stamp = (s.stamp + 1) >>> 0;
  if (s.stamp === 0) { s.seen.fill(0); s.stamp = 1; }
  const g = s.g, came = s.came, seen = s.seen, stamp = s.stamp;
  const heap = s.heap;
  heap.clear();

  g[start] = 0; came[start] = -1; seen[start] = stamp;
  heap.push(start, 0);
  let found = false, guard = 0, budgetHit = false;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) { found = true; break; }
    // 大图 + 河这种"要绕远"的地形需要更大预算；真的撞上预算要标记出来，
    // 让 findPath 知道「这是没算完」，别当成不可达缓存。
    if (++guard > Math.max(6000, W * H * 8)) { budgetHit = true; break; }
    const cx = cur % W, cy = (cur / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX8[d], ny = cy + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (blocked[ni]) continue;
      if (DX8[d] && DY8[d]) {
        if (blocked[cy * W + nx] || blocked[ny * W + cx]) continue;
      }
      const tCost = TERRAIN[run.map.tiles[ni]].cost;
      const step = (DX8[d] && DY8[d] ? 1.4142 : 1) * (isFinite(tCost) ? tCost : 1.2);
      const ng = g[cur] + step;
      if (seen[ni] !== stamp || ng < g[ni]) {
        seen[ni] = stamp; g[ni] = ng; came[ni] = cur;
        const hx = Math.abs(nx - gx), hy = Math.abs(ny - gy);
        heap.push(ni, ng + (Math.max(hx, hy) + 0.4142 * Math.min(hx, hy)));   // 加权 A*：僵尸寻路不要求最优，换更少的展开
      }
    }
  }
  if (!found) {
    if (budgetHit) run._pathBudgetHit = (run._pathBudgetHit || 0) + 1;
    return null;
  }
  const path = [];
  let c = goal, hop = 0;
  while (c !== -1 && hop++ < 4096) { path.push(c); c = came[c]; }
  path.reverse();
  return path;
}

// ---------------- 放置 / 拆除 ----------------
export function tileFree(run, tx, ty, skipUnitId) {
  const W = run.map.w;
  if (tx < 0 || ty < 0 || tx >= W || ty >= run.map.h) return false;
  if (tx === run.core.x && ty === run.core.y) return false;
  for (const s of run.map.spawns) if (Math.abs(s.x - tx) <= 1 && Math.abs(s.y - ty) <= 1) return false;
  if (run._fortTile.has(ty * W + tx)) return false;
  if (run._qTile && run._qTile.has(ty * W + tx)) return false;
  const T = run.map.tile;
  // 只有「站定」的单位占格；行军中的单位不挡建造，否则路线上永远补不了东西
  for (const u of run.units) {
    if (u.id === skipUnitId || u.moving) continue;
    const ux = Math.floor(u.x / T), uy = Math.floor(u.y / T);
    if (ux === tx && uy === ty) return false;
  }
  return true;
}

// 找出「站定单位」占着的那一格（无则 null）
// 出兵区：据点或任何基地建筑（兵营）周围 deployRadius 格内
// 出兵范围：传 srcId 就只看那一座建筑；不传则保持旧行为（据点或任意 base 建筑）
function unitSource(run, srcId) {
  if (!srcId || srcId === 'core') return null;
  const u = run.units.find((q) => q.id === srcId && q.hp > 0);
  if (!u) return null;
  const d = UNITS[u.kind];
  return d && d.produces && d.produces.length ? u : null;
}

// 建造区矩形（格坐标，闭区间）。炮台/工事各自的合法范围——
//   有单位建造源（工兵等）→ 以该单位为中心的方形（deployOk 的切比雪夫判定）
//   否则 → 以据点为中心的方形（canPlaceAt 里 dCore 与 towerRadius/fortRadius 的比较）
export function buildBounds(run, srcId, kind, id) {
  const lim = run.build || RULE.build;
  const su = unitSource(run, srcId);
  if (su) {
    const ud = UNITS[su.kind] || {};
    const isTower = !!(kind === 'unit' && id && UNITS[id] && UNITS[id].type === '炮台');
    const br = (isTower ? ud.towerRadius : ud.buildRadius) || ud.buildRadius || 2;
    return { x0: su.tx - br, y0: su.ty - br, x1: su.tx + br, y1: su.ty + br };
  }
  const r = kind === 'unit' ? lim.towerRadius : lim.fortRadius;
  return { x0: run.core.x - r, y0: run.core.y - r, x1: run.core.x + r, y1: run.core.y + r };
}

export function deployOk(run, tx, ty, srcId, id) {
  const r = (run.build || RULE.build).deployRadius;
  const su = unitSource(run, srcId);
  if (su) {
    const ud = UNITS[su.kind] || {};
    const isTower = !!(id && UNITS[id] && UNITS[id].type === '炮台');
    const br = (isTower ? ud.towerRadius : ud.buildRadius) || ud.buildRadius || 2;
    return Math.max(Math.abs(tx - su.tx), Math.abs(ty - su.ty)) <= br;
  }
  const near = (cx, cy) => Math.max(Math.abs(tx - cx), Math.abs(ty - cy)) <= r;
  if (srcId && srcId !== 'core') {
    const f = run.forts.find((q) => q.id === srcId && q.hp > 0);
    if (!f) return false;
    const s = fortSize(f.kind);
    const dx = Math.max(f.tx - tx, 0, tx - (f.tx + s - 1));
    const dy = Math.max(f.ty - ty, 0, ty - (f.ty + s - 1));
    return Math.max(dx, dy) <= r;
  }
  if (srcId === 'core') return near(run.core.x, run.core.y);
  if (near(run.core.x, run.core.y)) return true;
  for (const f of run.forts) {
    if (f.hp <= 0) continue;
    const d = FORTS[f.kind];
    if (d && d.base && near(f.tx, f.ty)) return true;
  }
  return false;
}

// 出兵区矩形（格坐标，闭区间）。绘制范围圈必须走这里，才能与 deployOk 的判定完全一致：
// 单位源 = 以单位所在格为心的方块；工事源 = 整栋矩形外扩 deployRadius 格；据点 = 据点格外扩 deployRadius 格。
export function deployBounds(run, srcId, id) {
  const r = (run.build || RULE.build).deployRadius;
  const su = unitSource(run, srcId);
  if (su) {
    const ud = UNITS[su.kind] || {};
    // 炮台用 towerRadius，其它工事用 buildRadius —— 必须和 deployOk 的判定口径一致
    const isTower = !!(id && UNITS[id] && UNITS[id].type === '炮台');
    const br = (isTower ? ud.towerRadius : ud.buildRadius) || ud.buildRadius || 2;
    return { x0: su.tx - br, y0: su.ty - br, x1: su.tx + br, y1: su.ty + br };
  }
  if (srcId && srcId !== 'core') {
    const f = run.forts.find((q) => q.id === srcId && q.hp > 0);
    if (f) {
      const s = fortSize(f.kind);
      return { x0: f.tx - r, y0: f.ty - r, x1: f.tx + s - 1 + r, y1: f.ty + s - 1 + r };
    }
  }
  return { x0: run.core.x - r, y0: run.core.y - r, x1: run.core.x + r, y1: run.core.y + r };
}

// 当前所有出兵点（给 UI 画圈用）
// 数量上限（场上 + 生产队列一起算）：炮台类总计 7，自动炮台 2 / 燃烧塔 2 / 迫击炮 3；路障 20 / 铁丝网 30
export function capOk(run, kind, id) {
  const caps = RULE.caps || {};
  const qCount = (pred) => run.queue.filter(pred).length;
  // 「全图限 1」的单位（目前只有英雄）：在场 + 排队 + 重伤中 都算占位
  if (kind === 'unit' && UNITS[id] && UNITS[id].unique) {
    const n = run.units.filter((u) => u.kind === id).length
      + qCount((q) => q.kind === 'unit' && q.id === id)
      + (run.heroDown && run.heroDown.kind === id ? 1 : 0);
    if (n >= 1) return false;
  }
  if (kind === 'unit' && UNITS[id] && UNITS[id].type === '炮台') {
    const isTow = (x) => UNITS[x] && UNITS[x].type === '炮台';
    const nAll = run.units.filter((u) => isTow(u.kind)).length
      + qCount((q) => q.kind === 'unit' && isTow(q.id));
    const nSame = run.units.filter((u) => u.kind === id).length
      + qCount((q) => q.kind === 'unit' && q.id === id);
    const perKind = caps[id] != null ? caps[id] : caps.turret;
    if (perKind && nSame >= perKind) return false;
    if (caps.towTotal && nAll >= caps.towTotal) return false;
  }
  // 载具（自行火炮 / 坦克 / 装甲车）：按类型限量，防止全堆远程炮
  if (kind === 'unit' && UNITS[id] && UNITS[id].type === '载具' && caps[id] != null) {
    const n = run.units.filter((u) => u.kind === id).length
      + qCount((q) => q.kind === 'unit' && q.id === id);
    if (n >= caps[id]) return false;
  }
  if (kind === 'fort' && (id === 'barricade' || id === 'wire' || id === 'mine')) {
    const n = run.forts.filter((f) => f.kind === id && f.hp > 0).length
      + qCount((q) => q.kind === 'fort' && q.id === id);
    if (caps[id] && n >= caps[id]) return false;
  }
  return true;
}

export function canPlaceAt(run, kind, id, tx, ty, srcId) {
  if (run.phase !== PHASE.PREP && run.phase !== PHASE.BATTLE) return false;
  if (srcId && srcId !== 'core') {
    const su = run.units.find((u) => u.id === srcId);
    if (su && su.inside) return false;      // 工兵在楼里只能维修，不能建造
  }
  if (!tileFree(run, tx, ty)) return false;
  const t = run.map.tiles[ty * run.map.w + tx];
  if (!TERRAIN[t].walkable) return false;
  const def = kind === 'unit' ? UNITS[id] : FORTS[id];
  if (!def) return false;
  // 前置建筑 / 自我限量：算上正在建造的队列，避免连点造出两座
  if (kind === 'fort' && requirementOf(run, id)) return false;
  // 载具工厂必须由工兵（单位建造源）落地：placeReason 一直在判这条，canPlaceAt 以前没判，
  // 结果 UI 提示「只能由工兵建造」但 enqueueAt 照样能过，两边口径不一致。
  if (kind === 'fort' && id === 'factory' && !unitSource(run, srcId)) return false;
  // 大建筑（兵营/工厂 2x2）：整块都要空且可走
  const fs = (def.size || 1);
  if (kind === 'fort' && fs > 1) {
    for (let dy = 0; dy < fs; dy++) {
      for (let dx = 0; dx < fs; dx++) {
        const x2 = tx + dx, y2 = ty + dy;
        if (x2 >= run.map.w || y2 >= run.map.h) return false;
        if (!tileFree(run, x2, y2)) return false;
        if (!TERRAIN[run.map.tiles[y2 * run.map.w + x2]].walkable) return false;
      }
    }
  }
  // 地形降级：比如横路上不能搭固定炮台
  const block = TERRAIN[t].buildBlock;
  if (block && kind === 'unit' && block.includes(def.type)) return false;
  // 兵营 / 载具工厂：占地内不能有马路
  if (kind === 'fort' && def.noRoad) {
    const fs3 = def.size || 1;
    for (let dy = 0; dy < fs3; dy++) {
      for (let dx = 0; dx < fs3; dx++) {
        if (run.map.tiles[(ty + dy) * run.map.w + (tx + dx)] === TILE.ROAD) return false;
      }
    }
  }
  const lim = run.build || RULE.build;
  const dCore = Math.max(Math.abs(tx - run.core.x), Math.abs(ty - run.core.y));
  if (kind === 'unit') {
    if (def.mobile) { if (!deployOk(run, tx, ty, srcId, id)) return false; }
    else if (unitSource(run, srcId)) { if (!deployOk(run, tx, ty, srcId, id)) return false; }
    else if (dCore > lim.towerRadius) return false;
  } else if (unitSource(run, srcId)) {
    // 工兵/兵营造工事：锚在建造源身上，不受据点 fortRadius 限制（与 placeReason 保持一致）
    if (!deployOk(run, tx, ty, srcId, id)) return false;
  } else if (dCore > lim.fortRadius) return false;
  if (run.supply < def.cost) return false;
  if ((run.parts || 0) < (def.parts || 0)) return false;
  if (!capOk(run, kind, id)) return false;
  if (popLeft(run) < (def.pop || 0)) return false;
  return true;
}

// ---------------- 人口（上限：只由波次曲线决定） ----------------
// ── 核心升级三选一 ──────────────────────────────────────────────
export function perkHas(run, id) {
  return !!(run && run.perks && run.perks.has(id));
}
// 有就拿 val，没有就 1：直接写成 a * perkMul(run,'economy',1.12) 即可
export function perkMul(run, id, val) {
  return perkHas(run, id) ? val : 1;
}
// 从没拿过的里面抽 3 个候选；全拿完返回 null
export function rollPerks(run) {
  if (!run || !run.perks) return null;
  const bag = PERKS.filter((p) => !run.perks.has(p.id));
  if (!bag.length) return null;
  const out = [];
  for (let i = 0; i < 3 && bag.length; i++) {
    const k = Math.floor(run.perkRng.next() * bag.length);
    out.push(bag.splice(k, 1)[0].id);
  }
  return out;
}
// 选中第 idx 张（0/1/2）。返回拿到的 id，失败返回 null
export function pickPerk(run, idx, auto) {
  const pend = run && run.pendingPerk;
  if (!pend) return null;
  const id = pend.options[idx];
  run.pendingPerk = null;
  if (!id || run.perks.has(id)) return null;
  run.perks.add(id);
  // 立即生效的那几项
  if (id === 'core') {
    run.core.maxHp += 300;
    run.core.hp = Math.min(run.core.maxHp, run.core.hp + 300);
  } else if (id === 'fort') {
    for (const f of run.forts) { f.maxHp = Math.round(f.maxHp * 1.3); f.hp = Math.round(f.hp * 1.3); }
  } else if (id === 'hp') {
    for (const u of run.units) { u.maxHp = Math.round(u.maxHp * 1.2); u.hp = Math.round(u.hp * 1.2); }
  }
  emit(run, { t: 'perk', id, auto: !!auto });
  return id;
}
// 清波后决定要不要弹卡
function maybeOfferPerk(run) {
  const done = (run.waveIndex || 0) + 1;   // 刚清完的波次（1 基）
  if (run.endless && done >= 999) return;
  if (!run.endless && done >= run.totalWaves) return;   // 最后一波清完直接结算
  const want = PERK_WAVES.indexOf(done) >= 0 ||
    (run.endless && done > 7 && (done - 7) % 2 === 0);
  if (!want) return;
  if (run.perks.size >= PERKS.length) return;
  const opts = rollPerks(run);
  if (opts && opts.length) run.pendingPerk = { options: opts, t: PERK_SECS };
}

// 场上威胁总量：Σ 每只僵尸的威胁权重（行尸 1 / 特感 6~8 / 暴君 26）。
// 跟波次无关 —— 跨波残留、游荡者、无尽刷怪都算进去，只反映「眼前还有什么」。
export function threatNow(run) {
  if (!run) return 0;
  let t = 0;
  for (const z of run.zombies) {
    if (z.hp <= 0) continue;
    const zd = ZOMBIES[z.mob];
    t += (zd && zd.threat) || 1;
  }
  return t;
}

// 威胁条的满格基准（对数刻度用）
export const THREAT_FULL = 2000;

export function popCap(run) {
  // 人口上限只由波次决定：兵营 / 载具工厂 / 资源点都不再加成
  const curve = RULE.pop.waveCurve;
  const cleared = Math.max(0, Math.min((run.waveIndex || 0), (curve ? curve.length : 1) - 1));
  const waveBase = curve ? curve[cleared] : RULE.pop.baseCap;
  const cap = waveBase + (run.perks && run.perks.has('pop') ? 4 : 0);
  return Math.min((RULE.pop.capMax || 32) + 4, cap);
}

export function popUsed(run) {
  let n = 0;
  for (const u of run.units) n += (UNITS[u.kind] ? UNITS[u.kind].pop : 0) || 0;
  for (const q of run.queue) n += q.pop || 0;
  // 重伤待归队的指挥官仍然占编制：倒地不等于腾出人口，否则会有人在开战前「先弄死她」腾位置
  if (run.heroDown && UNITS[run.heroDown.kind]) n += UNITS[run.heroDown.kind].pop || 0;
  return n;
}

export function popLeft(run) {
  return popCap(run) - popUsed(run);
}

// ---------------- 生产队列 ----------------
function queueTime(kind, def) {
  // 优先用单位表里的整秒部署时间；没写就退回「类别基础 + 造价系数」
  if (def.buildTime) return def.buildTime;
  const base = kind === 'unit'
    ? (def.mobile ? RULE.queue.mobile : RULE.queue.tower)
    : (def.base ? RULE.queue.base : RULE.queue.fort);
  const per = RULE.queue.perCost || 0.006;
  return Math.max(1, Math.round(base + (def.cost || 0) * per));
}

function reserveTile(run, tx, ty, item) { run._qTile.set(ty * run.map.w + tx, item); }
// 入队：先扣资源、占格子，到点才真正出现
// 某类炮台还剩多少秒冷却（没有就用 0）
export function towCdLeft(run, id) {
  const until = (run.towCdUntil && run.towCdUntil[id]) || 0;
  return Math.max(0, until - run.time);
}

function isTowerUnit(kind, id) {
  return kind === 'unit' && UNITS[id] && UNITS[id].type === '炮台';
}

export function enqueueAt(run, kind, id, tx, ty, srcId = 'core') {
  if (kind === 'unit' && !isUnlocked(run, id)) return { ok: false, reason: 'locked', wave: unlockWaveOf(id) };
  if (!canProduce(run, srcId, id)) return { ok: false, reason: 'source' };
  if (!canPlaceAt(run, kind, id, tx, ty, srcId)) return { ok: false, reason: placeReason(run, kind, id, tx, ty, srcId) };
  // 炮台类：每种炮台各自 10 秒冷却，下单即占用（队列里的也算）
  if (isTowerUnit(kind, id)) {
    const left = towCdLeft(run, id);
    if (left > 0) return { ok: false, reason: 'cd', cd: left };
  }
  const def = kind === 'unit' ? UNITS[id] : FORTS[id];
  run.supply -= def.cost;
  run.parts = Math.max(0, run.parts - (def.parts || 0));
  run.stats.spent += def.cost;
  const dur = queueTime(kind, def);
  const size = kind === 'fort' ? (def.size || 1) : 1;
  const tiles = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) tiles.push([tx + dx, ty + dy]);
  const item = {
    kind, id, tx, ty, t: dur, dur, srcId: srcId === 'core' ? 'core' : srcId,
    cash: def.cost, parts: def.parts || 0, pop: def.pop || 0, size, tiles,
  };
  run.queue.push(item);
  for (const [qx, qy] of tiles) reserveTile(run, qx, qy, item);
  if (isTowerUnit(kind, id)) run.towCdUntil[id] = run.time + (RULE.queue.towCd || 10);
  return { ok: true, item };
}

// 取消排队中的某格（全额退还）
export function cancelQueueAt(run, tx, ty) {
  const key = ty * run.map.w + tx;
  const item = run._qTile.get(key);
  if (!item) return false;
  const i = run.queue.indexOf(item);
  if (i >= 0) run.queue.splice(i, 1);
  for (const [qx, qy] of item.tiles || [[item.tx, item.ty]]) run._qTile.delete(qy * run.map.w + qx);
  addCash(run, item.cash);
  run.parts += item.parts;
  emit(run, { t: 'cancel' });
  return true;
}

// 生产源消失（工兵阵亡/解雇）时，取消它名下所有队列并全额退款
export function cancelQueueOfSource(run, srcId) {
  let n = 0;
  for (let i = run.queue.length - 1; i >= 0; i--) {
    const item = run.queue[i];
    if (item.srcId !== srcId) continue;
    run.queue.splice(i, 1);
    for (const [qx, qy] of item.tiles || [[item.tx, item.ty]]) run._qTile.delete(qy * run.map.w + qx);
    addCash(run, item.cash);
    run.parts += item.parts;
    n++;
  }
  if (n) emit(run, { t: 'cancel' });
  return n;
}

// 每帧推进队列

// ---------------- 建筑光环回血（脱战 3s 后生效） ----------------
export function healAuras(run, dt) {
  const T = run.map.tile;
  const sources = [];
  if (CORE_PROD.aura) sources.push({ x: (run.core.x + 0.5) * T, y: (run.core.y + 0.5) * T, aura: CORE_PROD.aura });
  for (const f of run.forts) {
    if (f.hp <= 0) continue;
    const def = FORTS[f.kind];
    if (def && def.aura) sources.push({ x: f.x, y: f.y, aura: def.aura });
  }
  if (!sources.length) return;
  // 同一单位同一帧只取最强光环（不叠加）
  const best = new Map();
  for (const src of sources) {
    const a = src.aura;
    const r2 = (a.radius * T) ** 2;
    for (const u of run.units) {
      if (!UNITS[u.kind].mobile) continue;
      if (a.target !== 'all') {
        const tp = UNITS[u.kind].type;
        if (a.target === 'inf' && tp !== '步兵') continue;
        if (a.target === 'veh' && tp !== '载具') continue;
      }
      if (u.hp <= 0 || u.hp >= u.maxHp) continue;
      if ((run.time || 0) - (u.lastHitAt || -99) < a.delay) continue;
      if ((u.x - src.x) ** 2 + (u.y - src.y) ** 2 > r2) continue;
      const cur = best.get(u);
      if (!cur || a.hps > cur.hps) best.set(u, a);
    }
  }
  for (const [u, a] of best) {
    u.hp = Math.min(u.maxHp, u.hp + a.hps * dt);
    u.healing = 0.25;
    if (run.fxRng && run.fxRng.next() < dt * 6) {
      run.effects.push({ x: u.x + (run.fxRng.next() - 0.5) * 10, y: u.y, life: 0.5, max: 0.5, heal: true });
      if (run.effects.length > 260) run.effects.shift();
    }
  }
}

// ---------------- 经济（基地 + 资源点） ----------------
function nodeYield(run, node) {
  const def = NODE_TYPES[node.kind] || NODE_TYPES.cash;
  return { cash: def.cash || 0, parts: def.parts || 0 };
}

// 资源点收益系数：每级 +12.5%，封顶 1.5倍
export function nodeLevelMul(run) {
  const e = RULE.econ;
  const lv = Math.min(RULE.pop.maxLevel, run.coreLevel || 1) - 1;
  return Math.min(e.nodeLevelCap || 1.5, 1 + (e.nodeLevelPer || 0) * lv);
}

// 每人维护费：基础 upkeepPop，每满 upkeepPopStep.size 点人口，每人再加 upkeepPopStep.add
export function popUpkeepEach(run, pop) {
  const e = RULE.econ;
  const st = e.upkeepPopStep;
  if (!st || !st.size || !st.add) return e.upkeepPop || 0;
  return (e.upkeepPop || 0) + st.add * Math.floor((pop || 0) / st.size);
}

// 每秒维护费：人口 × 每人维护（阶梯） + 炮台数 × upkeepTower
export function upkeepOf(run) {   // 导出供 tools 自测（upkeep-check）
  const e = RULE.econ;
  const perkMulU = (run && run.perks && run.perks.has('upkeep')) ? 0.75 : 1;
  // 只算「活着的已建成单位」：阵亡的当帧就会被清掉，队列里的不算
  let pop = 0, towers = 0, unitFee = 0;
  for (const u of run.units) {
    if (u.hp <= 0) continue;
    const d = UNITS[u.kind];
    if (!d) continue;
    pop += d.pop || 0;
    if (d.type === '炮台') towers++;
    unitFee += d.upkeep || 0;   // 自带固定维护费的单位（英雄 0.05/s，外加 1 人口的 0.10/s），与人口维护分开算
  }
  // 重伤待归队的指挥官：人口与自身维护费照算（与 popUsed 同口径）
  if (run.heroDown) {
    const hd = UNITS[run.heroDown.kind];
    if (hd) { pop += hd.pop || 0; unitFee += hd.upkeep || 0; }
  }
  const each = popUpkeepEach(run, pop);
  const popCost = pop * each * perkMulU;
  const towerCost = towers * (e.upkeepTower || 0) * perkMulU;
  const unitCost = unitFee * perkMulU;
  return {
    pop, towers, unitFee, each: each * perkMulU, popCost, towerCost, unitCost,
    cash: popCost + towerCost + unitCost,
  };
}

export function incomeRate(run) {
  const e = RULE.econ;
  const lv = Math.min(RULE.pop.maxLevel, run.coreLevel || 1) - 1;
  const perkEcon = (run.perks && run.perks.has('economy')) ? 1.12 : 1;   // 战时经济：基地资金
  const perkParts = (run.perks && run.perks.has('parts')) ? 1.30 : 1;    // 回收站：零件全局
  const baseCash = (e.baseCash + lv * e.perLevelCash) * perkEcon;
  const baseParts = (e.baseParts + lv * e.perLevelParts) * perkParts;
  const mul = nodeLevelMul(run);
  let nodeCash = 0, nodeParts = 0, nodesActive = 0;
  for (const n of run.nodes) {
    if (n.owner !== 1) continue;
    if (!n.guard) continue;          // 守点：没人驻守就停产
    const y = nodeYield(run, n);
    nodeCash += y.cash * mul; nodeParts += y.parts * mul * perkParts; nodesActive++;
  }
  const up = upkeepOf(run);
  return {
    cash: baseCash + nodeCash, parts: baseParts + nodeParts,
    baseCash, baseParts, nodeCash, nodeParts, nodesActive, nodeMul: mul,
    nodesOwned: run.nodes.filter((n) => n.owner === 1).length,
    upkeep: up.cash, upkeepPop: up.pop, upkeepTowers: up.towers, upkeepEach: up.each,
    upkeepPopCost: up.popCost, upkeepTowerCost: up.towerCost,
    upkeepUnitFee: up.unitFee, upkeepUnitCost: up.unitCost,
    netCash: baseCash + nodeCash - up.cash,
  };
}

function econTick(run, dt) {
  const r = incomeRate(run);
  run.supply = Math.max(0, Math.min(supplyCap(run), run.supply + r.netCash * dt));
  run.parts += r.parts * dt;
  // 本局累计（供左侧分栏显示）
  run.earn = run.earn || { base: 0, node: 0 };
  run.earn.base += r.baseCash * dt;
  run.earn.node += r.nodeCash * dt;
}

// 双向兑换：dir='buy' 资金→零件；dir='sell' 零件→资金。
// 每个整备期 run.swapUsed 次上限（买卖合计），换地方核心等级不影响汇率。
export function swapParts(run, dir, times) {
  const cfg = (RULE.econ && RULE.econ.swap) || {};
  const cost = cfg.buyCost || 20;
  const gain = cfg.sellGain || 5;
  const cap = cfg.perWave || 20;
  // times 支持批量（UI 的「×10」按钮传 10），上限 10 次一单
  const n = Math.max(1, Math.min(10, Math.floor(times) || 1));
  if (run.phase !== PHASE.PREP && run.phase !== PHASE.BATTLE) return { ok: false, reason: 'phase', used: run.swapUsed || 0, cap };
  const used = run.swapUsed || 0;
  if (used >= cap) return { ok: false, reason: 'cap', used, cap, need: n };
  if (used + n > cap) return { ok: false, reason: 'cap', used, cap, need: n };
  if (dir === 'buy') {
    const total = cost * n;
    if (run.supply < total) return { ok: false, reason: 'cash', used, cap, need: total };
    run.supply -= total;
    run.parts += n;
  } else if (dir === 'sell') {
    if (run.parts < n) return { ok: false, reason: 'parts', used, cap, need: n };
    run.parts -= n;
    run.supply = Math.min(supplyCap(run), run.supply + gain * n);
  } else return { ok: false, reason: 'dir', used, cap };
  run.swapUsed = used + n;
  emit(run, { t: 'swap', dir, n });
  return { ok: true, used: run.swapUsed, cap, n };
}

// 资源点：玩家单位在圈内→推进占领；僵尸在圈内→反推（满了就失守）
export function updateNodes(run, dt) {
  if (!run.nodes || !run.nodes.length) return;
  const T = run.map.tile;
  const rad = RULE.econ.radius * T;
  for (const n of run.nodes) {
    const nx = (n.x + 0.5) * T, ny = (n.y + 0.5) * T;
    let pc = 0, zc = 0, cMul = 1;
    for (const u of run.units) {
      if (u.hp <= 0) continue;
      const ud = UNITS[u.kind];
      if (!ud) continue;
      if (Math.hypot(u.x - nx, u.y - ny) <= rad + ud.r) {
        pc++;
        cMul = Math.max(cMul, ud.captureMul || 1);
      }
    }
    for (const z of run.zombies) {
      if (z.hp <= 0) continue;
      if (Math.hypot(z.x - nx, z.y - ny) <= rad + z.size) { zc++; break; }
    }
    // 叛军（红方）也压点
    let rc = 0;
    for (const r of (run.raiders || [])) {
      if (r.hp <= 0) continue;
      if (Math.hypot(r.x - nx, r.y - ny) <= rad + r.size) { rc++; break; }
    }
    // 守点模型：占领后必须留人驻守，人一走就开始掉进度，掉光即失守
    const holding = pc > 0;
    n.guard = holding;
    if (pc && !zc) n.cap = Math.min(1, n.cap + (dt * cMul) / RULE.econ.captureTime);
    else if (zc && !pc) n.cap = Math.max(-1, n.cap - dt / RULE.econ.loseTime);
    else if (zc && pc) n.cap = Math.max(-1, n.cap - dt * 0.5 / RULE.econ.loseTime);   // 争夺中：僵尸略占优
    else if (n.owner === 1 && !pc) {
      // 圈里没人 = 没人守，按守点速度掉（比被僵尸打的慢一半）
      n.cap = Math.max(0, n.cap - dt / (RULE.econ.holdGrace || 20));
    }
    // 叛军压进度：红方独占时按失守速度扣，扣满即易主
    if (rc && !pc && !zc) n.cap = Math.max(-1, n.cap - dt / RULE.econ.loseTime);
    if (n.cap <= -1 && n.owner !== 2) {
      n.owner = 2; n.cap = -1; n.guard = false;
      run.raiderNode = n.id;
      emit(run, { t: 'node', x: nx, y: ny, own: 2 });
    }
    // 状态切换
    // 红方据点：圈里没有叛军时，玩家压满进度就能夺回（此前 owner=2 后永远抢不回来）
    if (n.owner === 2 && rc === 0 && pc && n.cap >= 1) {
      n.owner = 1; n.cap = 1; n.guard = holding;
      run.raiderNode = null;
      run.supply = Math.min(supplyCap(run), run.supply + RULE.econ.captureCash);
      run.parts += RULE.econ.captureParts;
      emit(run, { t: 'node', x: nx, y: ny, own: 1 });
    }
    if (n.owner === 0 && n.cap >= 1) {
      n.owner = 1; n.cap = 1;
      run.supply = Math.min(supplyCap(run), run.supply + RULE.econ.captureCash);
      run.parts += RULE.econ.captureParts; emit(run, { t: 'node', x: nx, y: ny, own: 1 }); }
    if (n.owner === 1 && n.cap <= 0) {
      // 资源点被夺：盯着它的抢点队立刻换目标
      for (const z of run.zombies) if (z.raider) z.pathEpoch = -1;
      n.owner = 0; n.cap = 0; n.guard = false; emit(run, { t: 'node', x: nx, y: ny, own: 0 }); }
    if (n.owner === 0 && n.cap < 0) n.cap = 0;
  }
}

function tickQueue(run, dt) {
  if (!run.queue.length) return;
  for (let i = run.queue.length - 1; i >= 0; i--) {
    const q = run.queue[i];
    // 生产源被摧毁：该队列作废并全额退款
    if (q.srcId && q.srcId !== 'core'
      && !run.forts.some((f) => f.id === q.srcId && f.hp > 0)
      && !run.units.some((u) => u.id === q.srcId && u.hp > 0)) {
      run.queue.splice(i, 1);
      for (const [qx, qy] of q.tiles || [[q.tx, q.ty]]) run._qTile.delete(qy * run.map.w + qx);
      addCash(run, q.cash);
      run.parts += q.parts;
      emit(run, { t: 'cancel' });
      continue;
    }
    q.t -= dt;
    if (q.t > 0) continue;
    // 到点：先把自己预占的格子让出来，再逐格检查是否真的空着
    const tiles = q.tiles || [[q.tx, q.ty]];
    for (const [qx, qy] of tiles) run._qTile.delete(qy * run.map.w + qx);
    if (!tiles.every(([qx, qy]) => tileFree(run, qx, qy))) {
      for (const [qx, qy] of tiles) reserveTile(run, qx, qy, q);
      // 一直等不到空格：说一声，否则玩家只看到「点了没反应」
      q.wait = (q.wait || 0) + dt;
      if (q.wait > 4 && !q.warned) {
        q.warned = true;
        emit(run, { t: 'buildwait', x: (q.tx + 0.5) * run.map.tile, y: (q.ty + 0.5) * run.map.tile });
      }
      continue;
    }
    run.queue.splice(i, 1);
    spawnAt(run, q.kind, q.id, q.tx, q.ty);
    emit(run, { t: 'built', x: (q.tx + 0.5) * run.map.tile, y: (q.ty + 0.5) * run.map.tile });
  }
}

// 建造失败的原因（给 UI 提示用）
export function placeReason(run, kind, id, tx, ty, srcId) {
  if (run.phase !== PHASE.PREP && run.phase !== PHASE.BATTLE) return 'phase';
  if (!tileFree(run, tx, ty)) return 'occupied';
  const t = run.map.tiles[ty * run.map.w + tx];
  if (!TERRAIN[t].walkable) return 'terrain';
  const def = kind === 'unit' ? UNITS[id] : FORTS[id];
  if (!def) return 'unknown';
  const fs2 = (def.size || 1);
  if (kind === 'fort' && fs2 > 1) {
    for (let dy = 0; dy < fs2; dy++) {
      for (let dx = 0; dx < fs2; dx++) {
        const x2 = tx + dx, y2 = ty + dy;
        if (x2 >= run.map.w || y2 >= run.map.h) return 'terrain';
        if (!tileFree(run, x2, y2)) return 'occupied';
        if (!TERRAIN[run.map.tiles[y2 * run.map.w + x2]].walkable) return 'terrain';
      }
    }
  }
  const block = TERRAIN[t].buildBlock;
  if (block && kind === 'unit' && block.includes(def.type)) return 'road-tower';
  if (kind === 'fort' && def.noRoad) {
    const fs4 = def.size || 1;
    for (let dy = 0; dy < fs4; dy++) {
      for (let dx = 0; dx < fs4; dx++) {
        if (run.map.tiles[(ty + dy) * run.map.w + (tx + dx)] === TILE.ROAD) return 'road-fort';
      }
    }
  }
  const lim = run.build || RULE.build;
  const dCore = Math.max(Math.abs(tx - run.core.x), Math.abs(ty - run.core.y));
  if (kind === 'unit') {
    if (def.mobile) { if (!deployOk(run, tx, ty, srcId, id)) return 'deploy-range'; }
    else if (unitSource(run, srcId)) { if (!deployOk(run, tx, ty, srcId, id)) return 'deploy-range'; }
    else if (dCore > lim.towerRadius) return 'tower-range';
  } else if (unitSource(run, srcId)) {
    // 工兵/兵营等「单位建造源」造工事：锚在单位身上（工兵 buildRadius 2）
    if (!deployOk(run, tx, ty, srcId, id)) return 'fort-range';
  } else if (dCore > lim.fortRadius) return 'fort-range';
  // 下面四条要和 canPlaceAt 末尾的四条一一对应，否则「能建」和「为什么不能建」会打架
  if (kind === 'fort' && id === 'factory' && !unitSource(run, srcId)) return 'need-engineer';
  if (run.supply < def.cost) return 'supply';
  if ((run.parts || 0) < (def.parts || 0)) return 'parts';
  if (popLeft(run) < (def.pop || 0)) return 'pop';
  if (kind === 'fort') {
    const req = requirementOf(run, id);
    if (req) return req === 'require' ? 'require' : 'limit';
  }
  if (!capOk(run, kind, id)) return 'limit';
  return '';
}

// 建筑前置统一判定：返回 '' / 'require' / 'limit'，
// UI 的锁定状态与 placeReason 共用这一份逻辑
export function requirementOf(run, id) {
  const def = FORTS[id];
  if (!def) return '';
  if (def.requires) {
    for (const [rk, need] of Object.entries(def.requires)) {
      const have = run.forts.filter((f) => f.kind === rk && f.hp > 0).length;
      if (have < need) return 'require';
    }
  }
  if (def.limitedBy) {
    // 场上已建 + 正在建造队列都要算，否则连点两下能同时造出两座
    const mine = run.forts.filter((f) => f.kind === id && f.hp > 0).length
      + run.queue.filter((q) => q.kind === 'fort' && q.id === id).length;
    if (def.limitedBy === id) {
      // 自我限制：整个场上最多 max（默认 1）座
      if (mine >= (def.max || 1)) return 'limit';
    } else {
      const base = run.forts.filter((f) => f.kind === def.limitedBy && f.hp > 0).length;
      if (mine >= base) return 'limit';
    }
  }
  return '';
}

export function spawnAt(run, kind, id, tx, ty) {
  const def = kind === 'unit' ? UNITS[id] : FORTS[id];
  if (kind === 'unit') {
    // 出兵散布：同格已有站定单位就顺延到最近空格（避免出兵瞬间叠人）
    {
      const T2 = run.map.tile;
      const taken = new Set();
      for (const u of run.units) {
        if (u.hp <= 0 || u.moving || u.inside) continue;
        taken.add(Math.floor(u.y / T2) * run.map.w + Math.floor(u.x / T2));
      }
      if (taken.has(ty * run.map.w + tx)) {
        // 只有会走的单位才「顺延到空格」。
        // 固定炮台 / 工事必须落在玩家点的那一格：建造排队期间有人走上来，
        // 若这里顺延，玩家看到的就是「炮台被顶开一格」。
        if (!def.mobile && kind === 'unit') return false;
        const spot = claimSpot(run, tx, ty, taken);
        if (spot) { tx = spot.x; ty = spot.y; }
      }
    }
    run.units.push({
      id: run.nextId++, kind: id, tx, ty,
      x: (tx + 0.5) * run.map.tile, y: (ty + 0.5) * run.map.tile,
      hp: Math.round(def.hp * perkMul(run, 'hp', 1.2)), maxHp: Math.round(def.hp * perkMul(run, 'hp', 1.2)), cd: 0, dir: -Math.PI / 2, kills: 0,
      xp: 0, rank: 0,
      ammo: def.mag ? def.mag.size : undefined, reloadT: 0,
      order: null, path: null, pathIdx: 0, pathEpoch: -1, moving: false, flash: 0,
    });
  } else {
    const fsz = FORTS[id].size || 1;
    run.forts.push({
      id: run.nextId++, kind: id, tx, ty,
      x: (tx + fsz / 2) * run.map.tile, y: (ty + fsz / 2) * run.map.tile,
      hp: Math.round(def.hp * perkMul(run, 'fort', 1.3)), maxHp: Math.round(def.hp * perkMul(run, 'fort', 1.3)), blocks: !!def.blocks, slow: def.slow || 0, cost: def.cost,
    });
    ensureRooms(run);
    rebuildForts(run);
    if (def.blocks) bumped(run);
  }
  return true;
}

export function placeAt(run, kind, id, tx, ty, srcId) {
  if (!canPlaceAt(run, kind, id, tx, ty, srcId)) return false;
  const def = kind === 'unit' ? UNITS[id] : FORTS[id];
  run.supply -= def.cost;
  run.parts = Math.max(0, run.parts - (def.parts || 0));
  run.stats.spent += def.cost;
  const spawned = spawnAt(run, kind, id, tx, ty);
  if (!spawned) {
    // 落地时目标格被占（建造期间有人走上来）：整单回滚
    addCash(run, def.cost);
    run.parts += (def.parts || 0);
    run.stats.spent -= def.cost;
  }
  return spawned;
}

export function demolishAt(run, tx, ty) {
  if (run.phase !== PHASE.PREP && run.phase !== PHASE.BATTLE) return false;
  const W = run.map.w;
  if (run._qTile && run._qTile.has(ty * W + tx)) return cancelQueueAt(run, tx, ty);
  const f = run._fortTile.get(ty * W + tx);
  if (f) {
    f.hp = 0;
    const backCash = Math.round(f.cost * (FORTS[f.kind].refund != null ? FORTS[f.kind].refund : 0.5));
    const backParts = Math.round((FORTS[f.kind].parts || 0) * (FORTS[f.kind].refund != null ? FORTS[f.kind].refund : 0.5));
    addCash(run, backCash);
    run.parts += backParts;
    run.lastRefund = { cash: backCash, parts: backParts, name: FORTS[f.kind].name };
    spillGarrison(run, f.room);   // 卖掉带驻军的建筑：把楼里的人赶到楼外（否则会永久 inside 一个不存在的楼）
    rebuildForts(run);
    if (f.blocks) bumped(run);
    return true;
  }
  const ui = run.units.findIndex((u) => u.tx === tx && u.ty === ty);
  if (ui >= 0) {
    const u = run.units[ui];
    const ud = UNITS[u.kind];
    // 指挥官是 unique 单位：拆掉不退款。
    // 否则"拆掉 → 回据点重买"只花一半钱，等于半价传送门（审查报告指出）。
    const back = ud.hero ? { cash: 0, parts: 0 } : {
      cash: Math.round(ud.cost * 0.5),
      parts: Math.round((ud.parts || 0) * 0.5),
    };
    if (back.cash > 0) addCash(run, back.cash);
    if (back.parts > 0) run.parts += back.parts;
    run.lastRefund = { cash: back.cash, parts: back.parts, name: ud.name, noRefund: !!ud.hero };
    if (back.cash > 0) addFloat(run, u.x, u.y - 10, back.cash, true);   // 脚下冒一个 +钱
    if (ud.hero) {
      // 拆掉指挥官：战吼锚点与残留的 buff 时效一起清，不给"卖完还留个圈"的余地
      run._heroRef = null;
      run.buzzedUntil = 0;
    }
    run.units.splice(ui, 1);
    return true;
  }
  return false;
}

// ---------------- 波次 ----------------
export function waveBudget(n, total, cfg) {
  const c = cfg || {};
  const base = c.base || RULE.wave.threatBase;
  const grow = c.grow || RULE.wave.threatGrow;
  const fin = c.final || RULE.wave.finalMult;
  // 无尽模式把第 8 波当作"末波"：终波倍率与末 2 波削弱都照标准模式算，
  // 这样 1~8 波与标准模式逐字节一致，老手感完全不变
  const ref = c.endless ? 8 : total;
  const lateN = c.lateWaves != null ? c.lateWaves : (RULE.wave.lateWaves || 0);
  const lateM = c.lateMult != null ? c.lateMult : (RULE.wave.lateMult || 1);
  const lastMul = n >= ref ? fin : 1;
  const lateMul = (lateN > 0 && n > ref - lateN && n <= ref) ? lateM : 1;

  let b;
  if (c.endless && n > 8) {
    // 第 9 波起转 1.06 缓增长，每 5 波一个 Boss 波
    const b8 = base * Math.pow(grow, 7) * fin * lateM;
    b = b8 * Math.pow(c.endlessGrow || RULE.wave.endlessGrow || 1.06, n - 8);
    const every = RULE.wave.bossEvery || 5;
    if (n % every === 0) b *= (RULE.wave.bossMult || 1.4);
  } else {
    b = base * Math.pow(grow, n - 1) * lastMul * lateMul;
  }
  b *= c.mul != null ? c.mul : 1;   // 地图级波次系数（老城独立）
  return Math.round(b);
}

// 当前波的主题（无 themes 的地图返回 null）
export function waveTheme(run, n) {
  const list = run && run.map && run.map.meta && run.map.meta.themes;
  if (!list || !list.length) return null;
  const id = list[(Math.max(1, n) - 1) % list.length];
  return THEMES[id] ? { id, ...THEMES[id] } : null;
}

export function createWave(run, n) {
  // 首波单独使用更低的基数（其余波仍用 waveCfg.base 的曲线）
  const cfg = n === 1 && RULE.wave.firstBase
    ? { base: RULE.wave.firstBase, grow: run.waveCfg.grow, final: run.waveCfg.final, mul: run.waveCfg.mul }
    : run.waveCfg;
  const budget = waveBudget(n, run.totalWaves, cfg);
  const mobs = [];
  let left = budget;
  // 壮尸吃不过半：只占预算的 35%、最多 24 只，剩下的人头全给行尸
  const theme = waveTheme(run, n);
  const brutePct = (theme && theme.brutePct) || 0.35;
  const bruteCap = (theme && theme.brutePct) ? 34 : 24;
  if (n >= 3 && !(theme && theme.noBrute)) {
    const bruteBudget = Math.min(budget * brutePct, bruteCap * ZOMBIES.brute.threat);
    while (left >= ZOMBIES.brute.threat && budget - left < bruteBudget && mobs.length < bruteCap) {
      mobs.push('brute');
      left -= ZOMBIES.brute.threat;
    }
  }
  while (left >= 1) { mobs.push('walker'); left -= 1; }
  if (mobs.length === 0) mobs.push('walker');

  // ---- 特感：按方案向波内塞入特感 ----
  const scheme = SPEC_SCHEMES[run.spec || 0] || SPEC_SCHEMES[0];
  const specList = [];
  if (scheme && scheme.pool && scheme.pool.length) {
    const mul = (RULE.spec && RULE.spec.countMul) || 1;
    const want = Math.round((scheme.counts[Math.min(scheme.counts.length - 1, n - 1)] || 0) * mul * ((theme && theme.specMul) || 1));
    for (let i = 0; i < want; i++) specList.push(scheme.pool[Math.floor(run.rng.next() * scheme.pool.length) % scheme.pool.length]);
    // 巨兽不受 countMul 影响（只翻小特感）
    if (scheme.tanks && n === scheme.tankWave) {
      for (let i = 0; i < scheme.tanks; i++) specList.push('behemoth');
    }
  }

  // ---- 主题波追加：疾行给猎手，重甲给冲锋者
  if (theme && theme.hunters) for (let i = 0; i < theme.hunters; i++) specList.push('hunter');
  if (theme && theme.chargers) for (let i = 0; i < theme.chargers; i++) specList.push('charger');

  // ---- 尖叫者：独立投放，不受特感档位 countMul 影响（特感=关 时不投放）----
  if ((run.spec || 0) !== 0) {
    const sc = RULE.scream || {};
    const cnt = (sc.counts && sc.counts[Math.min(sc.counts.length - 1, n - 1)]) || 0;
    for (let i = 0; i < cnt; i++) specList.push('screamer');
  }

  // 潮水感：行尸数量放大，并拆成更多小批、密集投放
  const wm = (RULE.wave.walkerMul || 1) * ((theme && theme.walkerMul) || 1);
  if (wm > 1) {
    const walkers = mobs.filter((m) => m === 'walker').length;
    for (let i = 0; i < walkers * (wm - 1); i++) mobs.push('walker');
  }
  // 打乱顺序：壮尸/行尸混在一起，不会“先一波壮尸再一波行尸”
  for (let i = mobs.length - 1; i > 0; i--) {
    const j = Math.floor(run.rng.next() * (i + 1));
    const t = mobs[i]; mobs[i] = mobs[j]; mobs[j] = t;
  }
  const perBatch = Math.max(4, Math.ceil(mobs.length / (RULE.wave.batches || 12)));
  const spawns = [];
  let at = 0;
  for (let i = 0; i < mobs.length; i += perBatch) {
    const chunk = mobs.slice(i, i + perBatch);
    const counts = new Map();
    for (const m of chunk) counts.set(m, (counts.get(m) || 0) + 1);
    spawns.push({
      at,
      spawn: pickSpawnIndex(run),
      fired: false,
      groups: [...counts.entries()].map(([mob, n2]) => ({ mob, n: n2 })),
    });
    at += RULE.wave.batchGap;
  }
  // ---- 抢点队：每波抽一小股直奔资源点 ----
  {
    const rd = RULE.econ.raid || {};
    const specMul = (rd.specMul && rd.specMul[run.spec || 0]) || 0;
    if (n >= (rd.fromWave || 2) && specMul > 0) {
      const count = Math.min(rd.max || 15, Math.round(((rd.base || 3) + (n - (rd.fromWave || 2)) * (rd.perWave || 2)) * specMul));
      const owned = run.nodes.filter((nd) => nd.owner === 1);
      const want = owned.length ? owned[Math.floor(run.rng.next() * owned.length)] : null;
      if (count > 0 && want && run.map.spawns.length) {
        // 选离目标点最近的出口
        let si = 0, sd = Infinity;
        run.map.spawns.forEach((sp, k) => {
          const d = Math.hypot(sp.x - want.x, sp.y - want.y);
          if (d < sd) { sd = d; si = k; }
        });
        spawns.unshift({ at: 1.2, spawn: si, fired: false, raid: true, raidNode: want.id, groups: [{ mob: 'walker', n: count }] });
        // 正波次整体往后让 1.2s，保证抢点队先到
        for (let i = 1; i < spawns.length; i++) spawns[i].at += 1.2;
        run.raidInfo = { n: count, nodeId: want.id, wave: n };
        emit(run, { t: 'raid', n: count, nodeId: want.id, wave: n });
      }
    }
  }

  // 把特感打散到各批次里（首批不放，让玩家有准备）
  if (specList.length && spawns.length) {
    for (const mob of specList) {
      const idx = spawns.length > 1 ? 1 + Math.floor(run.rng.next() * (spawns.length - 1)) : 0;
      spawns[idx].groups.push({ mob, n: 1 });
    }
  }

  // 本波总血量：给顶栏「僵尸力量」条做分母（含未投放的分批）
  let hpTotal = 0;
  for (const s2 of spawns) {
    for (const g of s2.groups) {
      const zd = ZOMBIES[g.mob];
      hpTotal += ((zd && zd.hp) || 40) * g.n;
    }
  }
  return { index: n, threat: budget, duration: at + 30, spawns, hpTotal };
}

// 下一波构成预告：用一条独立 RNG 预演 createWave，绝不碰 run.rng。
// 返回 [{ mob, n }...]，按数量降序；波次越界或出错返回 null。
export function wavePreview(run, n) {
  if (!run || !n || n < 1) return null;
  const total = run.totalWaves || (RULE.wave && RULE.wave.total) || 8;
  if (!run.endless && n > total) return null;
  if (n > 60) return null;                       // 无尽模式远波不必预告
  const key = n + ':' + (run.seed || 0);
  if (run._pvKey === key && run._pvCache) return run._pvCache;
  const saved = run.rng;
  try {
    run.rng = new RNG(((run.seed || 1) ^ (n * 0x9e3779b9)) >>> 0);
    const w = createWave(run, n);
    const cnt = new Map();
    for (const sp of w.spawns) for (const g of sp.groups) cnt.set(g.mob, (cnt.get(g.mob) || 0) + g.n);
    run._pvCache = [...cnt.entries()].map(([mob, n2]) => ({ mob, n: n2 })).sort((a, b) => b.n - a.n);
    // 顺带算本波总血量，给顶栏「僵尸力量」条做分母（PREP 阶段 run.wave 还是 null）
    let hpTotal = 0;
    for (const sp of w.spawns) {
      for (const g of sp.groups) {
        const zd = ZOMBIES[g.mob];
        hpTotal += ((zd && zd.hp) || 40) * g.n;
      }
    }
    run._pvHp = hpTotal;
    run._pvTheme = waveTheme(run, n);
    run._pvKey = key;
    return run._pvCache;
  } catch (e) {
    return null;
  } finally {
    run.rng = saved;
  }
}

export function startBattle(run) {
  // 最后一波：散兵不再游荡，全部压向总部
  if (run.waveIndex >= (run.totalWaves || RULE.wave.total)) {
    for (const z of run.zombies) {
      if (!z.roamer) continue;
      z.roamer = false;
      z.mode = 'move';
      z.target = null;
      z.path = null;
      z.pathEpoch = -1;
      z.eatT = 0;
    }
  }
  if (run.raiderOn) {
    const RC = RULE.raider || {};
    const nextWave = run.waveIndex + 1;
    if (nextWave === (RC.reinforceWave || 5)) raiderReinforce(run);
    if (nextWave >= (RC.pushWave || 8)) run.raiderPush = true;
  }
  if (run.phase !== PHASE.PREP) return run;
  run.phase = PHASE.BATTLE;
  run.prepTimer = 0;
  if (!run.wave) {
    run.waveIndex = 1;
    run.wave = createWave(run, 1);
  }
  run.waveTimer = 0;
  emit(run, { t: 'wave', n: run.waveIndex });
  return run;
}

// 按 RULE.lane.spawnWeight 抽出生点：只改三路分布，总量不变（缺省退回轮转）
export function pickSpawnIndex(run) {
  const sps = run.map.spawns || [];
  const n = sps.length;
  if (!n) return 0;
  const wt = (RULE.lane && RULE.lane.spawnWeight) || null;
  if (!wt || wt.length !== n) return (run._spawnSeq = ((run._spawnSeq || 0) + 1) % n);
  let sum = 0;
  for (const w of wt) sum += Math.max(0, w);
  if (!(sum > 0)) return (run._spawnSeq = ((run._spawnSeq || 0) + 1) % n);
  let r = run.rng.next() * sum;
  for (let i = 0; i < n; i++) {
    r -= Math.max(0, wt[i]);
    if (r <= 0) return i;
  }
  return n - 1;
}

function spawnDue(run) {
  const w = run.wave;
  if (!w) return;
  for (const s of w.spawns) {
    if (s.fired || s.at > run.waveTimer) continue;
    const sp = run.map.spawns[s.spawn % Math.max(1, run.map.spawns.length)] || run.map.spawns[0] || { x: 0, y: 0 };
    // 展开成待生成队列（只展开一次），之后按帧补，避免满员重试时把已生成的又生成一遍
    if (!s.queue) {
      s.queue = [];
      for (const g of s.groups) for (let k = 0; k < g.n; k++) s.queue.push(g.mob);
      s.qi = 0;
    }
    while (s.qi < s.queue.length) {
      // 同屏满员：直接把本组剩余名额丢掉，否则 s.fired 永远 false、这一波永远清不完
    // （无尽后期波次量远超 900 上限，保留进度会让玩家「杀多少补多少」，永远打不完一波）
    if (!spawnZombie(run, s.queue[s.qi], sp)) { s.qi = s.queue.length; s.fired = true; break; }
      if (s.raid) {
        const z = run.zombies[run.zombies.length - 1];
        if (z && z.hp > 0) {
          z.raider = true;
          z.raidNodeId = s.raidNode;
          z.pathEpoch = -1;                 // 到达前强制重算路径到资源点
        }
      }
      s.qi++;
    }
    s.fired = true;
    if (s.raid) emit(run, { t: 'raid', x: sp.x, y: sp.y, n: s.groups[0] ? s.groups[0].n : 0 });
  }
}

export function spawnZombie(run, mobId, sp) {
  if (run.zombies.length >= RULE.perf.maxZombies) { run.stats.leaks++; return false; }
  const def = ZOMBIES[mobId];
  const T = run.map.tile;
  // 行尸个体差异：血量三档 + 攻击/攻速连续浮动；其它兵种保持原样
  let hp = def.hp, dmgMul = 1, atkMul = 1, elite = false;
  if (mobId === 'walker' && run.zVaryOn !== false) {
    const V = RULE.zVary;
    const pick = run.zRng.next();
    const i = pick < V.w[0] ? 0 : (pick < V.w[0] + V.w[1] ? 1 : 2);
    hp = V.hp[i];
    elite = i === 2;
    dmgMul = 1 + (run.zRng.next() * 2 - 1) * V.dmg;
    atkMul = 1 + (run.zRng.next() * 2 - 1) * V.atkSpd;
  }
  const z = {
    id: run.nextId++, mob: mobId, wave: run.waveIndex,
    x: (sp.x + 0.5) * T + (run.rng.next() - 0.5) * T * 0.8,
    y: (sp.y + 0.5) * T + (run.rng.next() - 0.5) * T * 0.8,
    hp, maxHp: hp, speed: def.speed * (0.86 + run.rng.next() * 0.28),
    dmg: def.dmg * (RULE.combat.zombieDmgMul || 1) * dmgMul,
    elite,
    ox: (run.rng.next() - 0.5) * T * 0.76,
    oy: (run.rng.next() - 0.5) * T * 0.76,
    attackInterval: def.attackInterval * atkMul, attackCd: def.attackInterval * atkMul * 0.4,
    size: def.size, vsBuilding: def.vsBuilding || 1,
    laneY: laneForSpawn(sp),
    path: null, pathIdx: 0, pathEpoch: -1, mode: 'move', target: null, dir: 0, eating: false,
    sp: def.special
      ? { ...def.special, dmg: (def.special.dmg || 0) * (RULE.combat.zombieDmgMul || 1) }
      : null,
    spCd: (def.special ? 1.5 : 0), spPhase: null, spT: 0,
    pullId: 0, spT0: 0, dashA: 0, dashTid: 0, dashFid: 0, leap: null, boss: !!def.boss,
  };
  // sp.track === false：转行尸/复活这类「不是本波新刷的」不记账，
  // 否则第 N 波刚开打，威胁条与「残留」统计就先被它们撑起来。
  if (sp.track !== false) {
    run.waveSpawnedHp = (run.waveSpawnedHp || 0) + (hp || 0);
    run.stats.spawned++;
  }
  run.zombies.push(z);
  if (def.boss) {
    emit(run, { t: 'boss', x: z.x, y: z.y, name: def.name });
  }
  return true;
}

// ---------------- 战斗 ----------------
function damageFort(run, f, dmg, pen) {
  f.hp -= dmg * armorMul(FORTS[f.kind].armor, pen);
  if (f.hp <= 0) {
    f.hp = 0;
    run.stats.fortLost++;
    const fb = FORTS[f.kind] && FORTS[f.kind].boom;
    if (fb && !f._boomed) { f._boomed = true; scheduleBoom(run, fb, f.x, f.y); }
    emit(run, { t: 'fort', x: f.x, y: f.y, id: f.id, kind: f.kind });
    spillGarrison(run, f.room);
    run.forts = run.forts.filter((x) => x.hp > 0);   // 死建筑不留脏索引
    rebuildForts(run);
    bumped(run);
  }
}

export function damageBuilding(run, b, dmg, pen, ignoreArmor) {
  if (!b || b.hp <= 0 || !Number.isFinite(dmg)) return;
  const T = run.map.tile;
  b.hp -= ignoreArmor ? dmg : dmg * armorMul('heavy', pen);
  if (b.hp <= 0) {
    b.hp = 0;
    run.stats.buildingDown++;
    for (const [dx, dy] of buildingCells(b)) {
      const x = b.x + dx, y = b.y + dy;
      if (x >= 0 && y >= 0 && x < run.map.w && y < run.map.h) {
        // 树倒了直接清空（就地消失，不留碎石）
        const next = b.tone === 'tree' ? TILE.GROUND : TILE.RUBBLE;
        if (run.map.tiles[y * run.map.w + x] === TILE.BUILDING) run.map.tiles[y * run.map.w + x] = next;
      }
    }
    // 楼被砸塌：里面的人和僵尸一起被埋（25% 最大生命）后弹出
    // 塌楼对楼内僵尸造成 50% 最大生命伤害
    for (const z of run.zombies) {
      const inThis = z.zInside === b;
      const besieging = z.zAttack === b;
      if (!inThis && !besieging) continue;
      if (inThis) z.hp -= (z.maxHp || z.hp || 0) * 0.5;
      // 楼塌后一律回到「无目标 → 压基地」，不再围着废墟
      z.zInside = null; z.zEnter = null; z.zAttack = null; z.inside = null;
      z.garrCd = run.time + 20;
      z.pathEpoch = -1; z.path = null; z.pathIdx = 0;
      z.mode = 'move'; z.target = null; z.eating = false;
      run.effects.push({ x: z.x, y: z.y, life: 0.3, max: 0.3, size: 14 });
    }
    for (const u of run.units) {
      if (u.inside === b || (u.enter && u.enter.b === b)) {
        const dmg = u.maxHp * (GARRISON.crush || 0.25);
        u.inside = null; u.enter = null;
        u.x = (b.x + b.w / 2) * T; u.y = (b.y + b.h / 2 + 1) * T;
        hurtUnit(run, u, dmg, 1);
      }
    }
    b.dirty = true;
    indexBuildings(run);
    run.map._rev = (run.map._rev || 0) + 1;
    bumped(run);
  }
}

export function buildingAt(run, tx, ty) {
  const i = run._bTile[ty * run.map.w + tx];
  return i >= 0 ? run.map.buildings[i] : null;
}

// ---------------- 可进入建筑（据点外的掩体） ----------------
export function garrisonUnits(run, b) {
  return run.units.filter((u) => u.inside === b && u.hp > 0);
}

// 正在读「进入」条的单位：读条即占名额，避免多人同时挤进超员
export function garrisonEntering(run, b) {
  return run.units.filter((u) => u.enter && u.enter.b === b && u.enter.mode === 'in' && u.hp > 0);
}

export function garrisonUsed(run, b) {
  return garrisonUnits(run, b).length + garrisonEntering(run, b).length;
}

export function garrisonAt(run, px, py, pad = 0) {
  const T = run.map.tile;
  // 房间（基地/兵营/工厂）的 x/y/w/h 是格坐标，而 px/py 是世界像素，必须换算
  const hitRoom = (b) => b && b.hp > 0
    && px >= b.x * T - pad && px < (b.x + b.w) * T + pad
    && py >= b.y * T - pad && py < (b.y + b.h) * T + pad;
  if (run.core.room && hitRoom(run.core.room)) return run.core.room;
  for (const f of run.forts) if (f.room && hitRoom(f.room)) return f.room;

  for (const b of run.map.buildings) {
    if (!b.garrison || b.hp <= 0) continue;
    const tx = Math.floor(px / T), ty = Math.floor(py / T);
    // 多格拼块：必须先落在真实格上，空角/外接框不算（避免"隐形占格"点空也进楼）
    if (b.cells && b.cells.length) {
      if (insideTile(run, b, tx, ty)) return b;
      continue;
    }
    const x0 = b.x * T - pad, y0 = b.y * T - pad;
    const x1 = (b.x + b.w) * T + pad, y1 = (b.y + b.h) * T + pad;
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) return b;
  }
  return null;
}

// 房屋对象：基地 3x3、兵营/载具工厂 2x2 都可以进人
function roomOfRect(x, y, w, h, cap, hpGet, maxHpGet) {
  return {
    garrison: true, garrCap: cap, x, y, w, h,
    get hp() { return hpGet(); },
    get maxHp() { return maxHpGet(); },
  };
}
export function ensureRooms(run) {
  const fs = 3;
  const hx = run.core.x - Math.floor(fs / 2), hy = run.core.y - Math.floor(fs / 2);
  if (!run.core.room) {
    run.core.room = roomOfRect(hx, hy, fs, fs, (CORE_PROD.garrCap || 2),
      () => run.core.hp, () => run.core.maxHp);
  }
  for (const f of run.forts) {
    const def = FORTS[f.kind];
    if (!def || !def.garrCap) continue;
    if (!f.room) {
      const sz = def.size || 1;
      f.room = roomOfRect(f.tx, f.ty, sz, sz, def.garrCap, () => f.hp, () => f.maxHp);
    }
  }
}
// 工事/基地被摧毁时，楼里的人被扔出去并吃 25% 伤害
export function spillGarrison(run, room) {
  if (!room) return 0;
  let n = 0;
  for (const u of run.units) {
    if (u.inside !== room || u.hp <= 0) continue;
    u.inside = null; u.enter = null;
    const spot = garrisonFreeSpot(run, { x: room.x, y: room.y, w: room.w, h: room.h }, u.x, u.y);
    u.x = spot ? spot.x : (room.x + 0.5) * run.map.tile;
    u.y = spot ? spot.y : (room.y + 0.5) * run.map.tile;
    hurtUnit(run, u, u.maxHp * GARRISON.crush, 0);
    n++;
  }
  return n;
}

// 单位当前有效射程：基础 × 地形 × 楼内（工兵不吃楼内）
export function unitRange(run, u) {
  const d = UNITS[u.kind];
  if (!d) return 0;
  const T2 = run.map.tile;
  const tx = Math.floor(u.x / T2), ty = Math.floor(u.y / T2);
  const tile = run.map.tiles[ty * run.map.w + tx];
  const tMul = (TERRAIN[tile] && TERRAIN[tile].range) || 1;
  const gMul = (u.inside && u.kind !== 'engineer') ? GARRISON.range : 1;
  const dAdd = (u.depOn && d.deploy && d.deploy.rangeAdd) ? d.deploy.rangeAdd : 0;
  return d.range * tMul * gMul + dAdd;
}

// 楼内某格是否被别的站立单位占用（与空地 tileFree 的“只算站着的人”一致）
function cellTakenByOther(run, b, tx, ty, skipId) {
  const T = run.map.tile;
  for (const o of run.units) {
    if (o.id === skipId || o.hp <= 0 || o.moving) continue;
    if (o.inside !== b) continue;
    if (Math.floor(o.x / T) === tx && Math.floor(o.y / T) === ty) return true;
  }
  return false;
}

export function garrisonCap(b) {
  const cells = buildingCells(b).length;
  // rooms use explicit cap; neutral buildings: ceil(cells / 2)
  if (b && b.garrCap) return Math.min(b.garrCap, cells);
  return Math.ceil(cells / 2);
}

// standable cells (only a subset is open)
export function slotCells(b) {
  const all = buildingCells(b);
  if (b && Array.isArray(b.slots) && b.slots.length) {
    return b.slots.map((q) => [q.x - b.x, q.y - b.y]);
  }
  const cap = b && b.garrCap ? Math.min(b.garrCap, all.length) : Math.ceil(all.length / 2);
  const cx0 = (b.w - 1) / 2, cy0 = (b.h - 1) / 2;
  return all.slice().sort((p1, p2) =>
    ((p1[0] - cx0) ** 2 + (p1[1] - cy0) ** 2) - ((p2[0] - cx0) ** 2 + (p2[1] - cy0) ** 2)).slice(0, cap);
}

// can a unit stand on this inside tile
// 兼容旧调用：楼内任何真实格都可站（开放格限制已取消）
export function insideTile(run, b, tx, ty) {
  if (!b || b.hp <= 0) return false;
  const dx = tx - b.x, dy = ty - b.y;
  if (dx < 0 || dy < 0 || dx >= b.w || dy >= b.h) return false;
  return buildingCells(b).some(([cx, cy]) => cx === dx && cy === dy);
}

// 单位脚下的可进入建筑（u.inside 偶发被清空时用）
function roomUnder(run, u) {
  if (!u || u.hp <= 0) return null;
  const T = run.map.tile;
  const tx = Math.floor(u.x / T), ty = Math.floor(u.y / T);
  const b = buildingAt(run, tx, ty);
  return b && b.garrison && b.hp > 0 ? b : null;
}

// 楼里离 (px,py) 最近的空位（被别的楼内单位占着的格子跳过）
export function garrisonFreeSpot(run, b, px, py) {
  const T = run.map.tile;
  const taken = new Set();
  for (const u of run.units) {
    if (u.inside !== b || u.hp <= 0) continue;
    taken.add(Math.floor(u.x / T) + ',' + Math.floor(u.y / T));
  }
  let best = null, bd = Infinity;
  const pool = buildingCells(b);
  for (const [dx, dy] of pool) {
    const tx = b.x + dx, ty = b.y + dy;
    if (taken.has(tx + ',' + ty)) continue;
    const d = Math.hypot((tx + 0.5) * T - px, (ty + 0.5) * T - py);
    if (d < bd) { bd = d; best = { tx, ty, x: (tx + 0.5) * T, y: (ty + 0.5) * T }; }
  }
  return best;
}

// 该格是否站着别的单位（站定或读条中；行军中的不算，它们会继续走开）
function standingOnTile(run, tx, ty, skip) {
  const T = run.map.tile;
  for (const o of run.units) {
    if (o === skip || o.hp <= 0 || o.moving || o.enter) continue;
    if (Math.floor(o.x / T) === tx && Math.floor(o.y / T) === ty) return true;
  }
  return false;
}

// 出楼落点：楼外由近及远每一圈里，找可通行、没有工事、也没有别的单位站着的格子
// 一圈全被占就再往外找一圈；实在找不到返回 null（调用方应让单位留在楼里，绝不能把人塞进工事格）
function outsideSpot(run, b, px, py, skip) {
  const T = run.map.tile, W = run.map.w;
  for (let ring = 1; ring <= 3; ring++) {
    let best = null, bd = Infinity;
    for (let ty = b.y - ring; ty <= b.y + b.h - 1 + ring; ty++) {
      for (let tx = b.x - ring; tx <= b.x + b.w - 1 + ring; tx++) {
        // 只扫这一圈的边框
        const onEdge = tx === b.x - ring || tx === b.x + b.w - 1 + ring ||
          ty === b.y - ring || ty === b.y + b.h - 1 + ring;
        if (!onEdge) continue;
        if (tx < 0 || ty < 0 || tx >= W || ty >= run.map.h) continue;
        if (insideTile(run, b, tx, ty)) continue;
        if (!TERRAIN[run.map.tiles[ty * W + tx]].walkable) continue;
        if (run._fortTile.get(ty * W + tx)) continue;      // 炮台/工事格绝不出人
        if (standingOnTile(run, tx, ty, skip)) continue;   // 一格一人
        const d = Math.hypot((tx + 0.5) * T - px, (ty + 0.5) * T - py);
        if (d < bd) { bd = d; best = { tx, ty, x: (tx + 0.5) * T, y: (ty + 0.5) * T }; }
      }
    }
    if (best) return best;
  }
  return null;
}

// 强制出楼落点：楼没了（被打塌）又等不到空位时用。宁可和别人挤一格，也不能永远卡在废墟里。
// 与 outsideSpot 的区别：忽略「一格一人」，只要可通行；先找非工事格，实在没有就允许落在工事格上
// （僵尸压在路障上会继续拆它，比永远卡在楼里好），半径放到 12 圈。
function forcedOutSpot(run, b, px, py) {
  const T = run.map.tile, W = run.map.w;
  for (const allowFort of [false, true]) {
    for (let ring = 1; ring <= 12; ring++) {
      let best = null, bd = Infinity;
      for (let ty = b.y - ring; ty <= b.y + b.h - 1 + ring; ty++) {
        for (let tx = b.x - ring; tx <= b.x + b.w - 1 + ring; tx++) {
          const onEdge = tx === b.x - ring || tx === b.x + b.w - 1 + ring ||
            ty === b.y - ring || ty === b.y + b.h - 1 + ring;
          if (!onEdge) continue;
          if (tx < 0 || ty < 0 || tx >= W || ty >= run.map.h) continue;
          if (!TERRAIN[run.map.tiles[ty * W + tx]].walkable) continue;
          if (!allowFort && run._fortTile.get(ty * W + tx)) continue;
          const d = Math.hypot((tx + 0.5) * T - px, (ty + 0.5) * T - py);
          if (d < bd) { bd = d; best = { tx, ty, x: (tx + 0.5) * T, y: (ty + 0.5) * T }; }
        }
      }
      if (best) return best;
    }
  }
  return null;
}

function besideBuilding(run, b, u) {
  const T = run.map.tile;
  const tx = Math.floor(u.x / T), ty = Math.floor(u.y / T);
  return tx >= b.x - 1 && tx <= b.x + b.w && ty >= b.y - 1 && ty <= b.y + b.h;
}

// 进楼：必须在楼边，读条 enterT 满了才真正进去（读条期间被下令移动会取消）
export function orderGarrison(run, ids, b) {
  if (!b || !b.garrison || b.hp <= 0) return 0;
  let n = 0;
  for (const id of ids) {
    const u = run.units.find((x) => x.id === id && x.hp > 0);
    if (!u || u.inside === b || u.enter) continue;
    const def = UNITS[u.kind];
    if (!def || !def.canGarrison) continue;
    if (u.stance === STANCE.PATROL) { u.stance = STANCE.FREE; u.patrol = null; }
    if (!besideBuilding(run, b, u)) {
      // 不在楼边：先走过去，到楼边自动读条进楼（楼满了就停在楼边）
      u.garrWant = b;
      const spot = outsideSpot(run, b, u.x, u.y);
      if (spot) {
        u.order = { x: spot.tx, y: spot.ty };
        u.path = null; u.pathIdx = 0; u.pathEpoch = -1; u.moving = true;
      }
      n++;
      continue;
    }
    if (garrisonUsed(run, b) >= garrisonCap(b)) { u.garrWant = null; continue; }
    u.garrWant = null;
    u.order = null; u.path = null; u.pathEpoch = -1; u.moving = false;
    u.enter = { b, t: GARRISON.enterT, total: GARRISON.enterT, mode: 'in' };
    n++;
  }
  return n;
}

// 出楼：读条 exitT
export function orderUngarrison(run, ids) {
  let n = 0;
  for (const id of ids) {
    const u = run.units.find((x) => x.id === id && x.hp > 0);
    if (!u || !u.inside || u.enter) continue;
    u.order = null; u.moving = false;
    u.enter = { b: u.inside, t: GARRISON.exitT, total: GARRISON.exitT, mode: 'out' };
    n++;
  }
  return n;
}

// 楼内自由走位：目标必须还在这栋楼里
export function orderMoveInside(run, ids, b, tx, ty) {
  if (!b || !b.hp) return 0;
  if (!insideTile(run, b, tx, ty)) return 0;
  // 目标格已被别的站立单位占着 → 改成最近空位（与空地一致的“一格一人”）
  if (cellTakenByOther(run, b, tx, ty, ids.length === 1 ? ids[0] : -1)) {
    const alt = garrisonFreeSpot(run, b, (tx + 0.5) * run.map.tile, (ty + 0.5) * run.map.tile);
    if (!alt) return 0;
    tx = alt.tx; ty = alt.ty;
  }
  let n = 0;
  for (const id of ids) {
    const u = run.units.find((x) => x.id === id && x.hp > 0);
    if (!u || u.inside !== b || u.enter) continue;
    if (u.stance === STANCE.PATROL) { u.stance = STANCE.FREE; u.patrol = null; }
    u.order = { x: tx, y: ty };
    n++;
  }
  return n;
}

// 停火 / 解除停火（巡逻要走 setPatrol）
export function setStance(run, ids, stance) {
  let n = 0;
  for (const id of ids) {
    const u = run.units.find((x) => x.id === id && x.hp > 0);
    if (!u) continue;
    u.stance = stance;
    if (stance !== STANCE.PATROL) u.patrol = null;
    n++;
  }
  return n;
}

// 巡逻：两点往返（只对可移动、且不在楼里/不在读条的单位生效）
// 手动换弹：仅当弹量 <= 上限一半（向上取整）时可用；由玩家主动触发，读条开始后不可取消
export function manualReload(run, ids) {
  const list = Array.isArray(ids) ? ids : [...(ids || [])];
  const out = { ok: 0, busy: 0, full: 0, nomag: 0, secs: 0 };
  for (const id of list) {
    const u = run.units.find((x) => x.id === id);
    if (!u || u.hp <= 0) continue;
    const def = UNITS[u.kind];
    const mg = def && def.mag;
    if (!mg) { out.nomag++; continue; }
    if (u.reloadT > 0) { out.busy++; continue; }
    if (u.ammo > Math.ceil(mg.size * 0.5)) { out.full++; continue; }
    u.reloadT = mg.reload * perkMul(run, 'reload', 0.8);
    out.secs = mg.reload * perkMul(run, 'reload', 0.8);
    out.ok++;
  }
  return out;
}

export function setPatrol(run, ids, ax, ay, bx, by) {
  let n = 0;
  const takenA = new Set(), takenB = new Set();
  const idSet = new Set(ids);
  for (const u of run.units) {
    // 正在被命令的单位不占坑：否则它自己脚下那格会被当成「已占用」，
    // claimSpot 只好挪到左上邻居，右键巡逻就永远落不到指定格
    if (idSet.has(u.id)) continue;
    if (u.hp <= 0 || u.moving || u.inside) continue;
    takenA.add(Math.floor(u.y / run.map.tile) * run.map.w + Math.floor(u.x / run.map.tile));
  }
  for (const id of ids) {
    const u = run.units.find((x) => x.id === id && x.hp > 0);
    if (!u) continue;
    const def = UNITS[u.kind];
    if (!def || !def.mobile || u.inside || u.enter) continue;
    // 多选巡逻：A / B 两点各自散开，避免所有人挤同一个点
    const pa = claimSpot(run, ax, ay, takenA, { x: u.x, y: u.y }) || { x: ax, y: ay };
    const pb = claimSpot(run, bx, by, takenB, { x: u.x, y: u.y }) || { x: bx, y: by };
    takenA.add(pa.y * run.map.w + pa.x);
    takenB.add(pb.y * run.map.w + pb.x);
    u.stance = STANCE.PATROL;
    u.patrol = { pts: [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }], idx: 0 };
    u.patrolWait = 0;
    u.order = { x: pa.x, y: pa.y };
    u.path = null; u.pathEpoch = -1; u.moving = false;
    n++;
  }
  return n;
}

// 燃烧塔火舌：沿炮塔朝向的锥形判定（张角 2*half、长 len），命中挂「点燃」
function flameCone(run, tower, def) {
  const J = def.jet || {};
  const len = def.range || 96;
  const half = J.half != null ? J.half : 0.48;
  const edge = J.edge != null ? J.edge : 0.6;
  const B = def.burn || {};
  const base = def.dmg || 5;
  const aim = tower.dir || 0;
  const nearK = J.nearK || 1, nearR = J.nearR || 0;
  const far = { d: -1, x: 0, y: 0 };          // 锥内最远的命中点（残火圈铺这里）
  const hitOne = (z) => {
    if (!z || z.hp <= 0) return false;
    const dx = z.x - tower.x, dy = z.y - tower.y;
    const d = Math.hypot(dx, dy);
    if (d > len || d < 1) return false;
    let ang = Math.atan2(dy, dx) - aim;
    ang = Math.abs(((ang + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
    if (ang > half) return false;
    const fall = falloffK(d, len, edge);
    const nearB = (nearR && d <= nearR) ? nearK : 1;   // 贴脸加成：被围住时更痛
    const dmg = base * fall * nearB * zArmorMul({ vsArmor: def.vsArmor }, z);
    if (d > far.d) { far.d = d; far.x = z.x; far.y = z.y; }
    z.hp -= dmg;
    if (z.hp <= 0) creditFlameKill(run, tower.id, z);
    z.burnT = run.time;
    z.burnUntil = Math.max(z.burnUntil || 0, run.time + (B.dur || 2.5));
    z.burnDps = B.dps != null ? B.dps : 4;
    z.burnBy = tower.id;                       // 点燃来源：DoT 烧死也算他的击杀
    if (B.slow) applySlow(run, z, { mul: 1 - B.slow, dur: B.dur || 2.5 });
    if (!z._fxFl || run.frame - z._fxFl > 40) {
      z._fxFl = run.frame;
      addFloat(run, z.x, z.y, Math.round(dmg), false);
    }
    return true;
  };
  for (const z of run.zombies) hitOne(z);
  run._flameFar = far.d > 0 ? far : null;
  // 叛军也吃，但只吃一半
  for (const r of (run.raiders || [])) {
    if (r.hp <= 0) continue;
    const rd = UNITS[r.kind];
    if (!rd) continue;
    const dx = r.x - tower.x, dy = r.y - tower.y;
    const d = Math.hypot(dx, dy);
    if (d > len || d < 1) continue;
    let ang = Math.atan2(dy, dx) - aim;
    ang = Math.abs(((ang + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
    if (ang > half) continue;
    hurtUnit(run, r, base * falloffK(d, len, edge) * 0.5, 0, 0, null, true);
  }
}

// 命中减速：取更强的那个倍率，并把持续时间刷新
export function applySlow(run, z, slow) {
  if (!slow || !slow.mul || slow.mul >= 1) return;
  const until = run.time + (slow.dur || 2);
  if (!z.slowUntil || run.time >= z.slowUntil || slow.mul <= (z.slowMul || 1)) z.slowMul = slow.mul;
  z.slowUntil = Math.max(z.slowUntil || 0, until);
}
// 范围武器眩晕：只对僵尸生效（叛军不吃），三档抗性
//   暴君：完全免疫；重甲（壮尸/冲锋者）：×0.4；同一只 1.2 秒内递减 1 → 0.5 → 免疫
// 返回实际眩晕秒数（0 表示没震到），供测试与飘字使用
export function applyZStun(run, z, base) {
  if (!base || base <= 0 || !z || z.hp <= 0) return 0;
  const zd = ZOMBIES[z.mob];
  if (!zd) return 0;
  if (z.mob === 'behemoth') return 0;
  const armorMul = (zd.armor === 'heavy') ? 0.4 : 1;
  if (z.stunWin == null || run.time - z.stunWin > 1.2) { z.stunWin = run.time; z.stunN = 0; }
  const decay = [1, 0.5, 0][Math.min(2, z.stunN)];
  if (!(decay > 0)) return 0;
  const sec = base * armorMul * decay;
  z.stunN += 1;
  z.stunUntil = Math.max(z.stunUntil || 0, run.time + sec);   // 取最长，不累加
  return sec;
}


// 暴君狂暴：血量比例低于 enrage.at 后，移速 / 攻速按倍率提升
export function zEnrageMul(z) {
  const d = z && ZOMBIES[z.mob];
  const e = d && d.enrage;
  const max = (z && z.maxHp) || 0;
  const on = !!(e && e.at && max > 0 && z.hp > 0 && z.hp / max < e.at);
  return { on, speed: on ? (e.speedMul || 1) : 1, rate: on ? (e.rateMul || 1) : 1 };
}

// 尖叫者增益：命中时写入时间戳（多只取最大，不叠加；源死后最多残留到时间戳过期）
export function zScreamMul(z, now) {
  const t = now || 0;
  if (z && z.screamUntil && z.screamUntil > t) {
    return { on: true, speed: z.screamS || 1, rate: z.screamR || 1, left: z.screamUntil - t };
  }
  return { on: false, speed: 1, rate: 1, left: 0 };
}

// 僵尸实际的攻击间隔（秒）：狂暴后缩短，被尖叫者加速后再缩短
export function zAttackInterval(z, now) {
  const rg = zEnrageMul(z);
  const sc = zScreamMul(z, now);
  return (z.attackInterval || 1) / ((rg.rate || 1) * (sc.rate || 1));
}

// 我方单位「当前实际移动速度」（像素/秒）：与 updateUnits 里的移动公式同源
// 楼内：def.speed * insideSpeedMul；楼外：def.speed * 地形 uSpeed * 减速倍率；眩晕时视为 0
export function unitSpeedNow(run, u) {
  const def = UNITS[u.kind];
  if (!def || !def.mobile) return null;
  if ((u.stun || 0) > 0) return { now: 0, base: def.speed, tags: ["眩晕 " + u.stun.toFixed(1) + "s"] };
  const tags = [];
  let v = def.speed;
  if (u.inside) {
    const m = GARRISON.insideSpeedMul || 0.9;
    v *= m;
    if (Math.abs(m - 1) > 0.001) tags.push("楼内 ×" + m.toFixed(2));
  } else {
    const tile = run.map.tiles[(u.ty || 0) * run.map.w + (u.tx || 0)];
    const tm = (TERRAIN[tile] && TERRAIN[tile].uSpeed) || 1;
    v *= tm;
    if (Math.abs(tm - 1) > 0.001) tags.push("地形 ×" + tm.toFixed(2));
  }
  // 指挥官技能：战吼 +10% / 肾上腺素 +20%，两者取最高不叠乘（和实际移动用的是同一个函数）
  if (def.hero) {
    const hm = heroSpeedMul(run, u);
    if (Math.abs(hm - 1) > 0.001) {
      v *= hm;
      tags.push(adrSpeedMul(run, u) >= warcrySpeedMul(run, u)
        ? "肾上腺素 +" + Math.round((hm - 1) * 100) + "%"
        : "战吼 +" + Math.round((hm - 1) * 100) + "%");
    }
  }
  // 铁丝网对我方也生效，但只减速 30%（僵尸是 45%）
  if (!u.inside) {
    const T = run.map.tile;
    const ftk = Math.floor(u.y / T) * run.map.w + Math.floor(u.x / T);
    const ff = run._fortTile.get(ftk);
    if (ff && ff.slow > 0) {
      v *= 0.70;
      tags.push("铁丝网 -30%");
    }
  }
  const sm = u.slowUntil && run.time < u.slowUntil ? (u.slowMul || 1) : 1;
  if (sm < 1) {
    v *= sm;
    tags.push("减速 -" + Math.round((1 - sm) * 100) + "% " + (u.slowUntil - run.time).toFixed(1) + "s");
  }
  return { now: v, base: def.speed, tags };
}

export function slowFactor(run, z) {
  const T = run.map.tile;
  let mul = 1;
  const f = run._fortTile.get(Math.floor(z.y / T) * run.map.w + Math.floor(z.x / T));
  if (f && f.slow > 0) mul = f.slow;
  if (run.zones && run.zones.length) {
    for (const zn of run.zones) {
      if (!zn.slow) continue;
      if (Math.hypot(z.x - zn.x, z.y - zn.y) <= zn.r) { mul = Math.min(mul, zn.slow); break; }
    }
  }
  // 被「减速弹」命中的临时减速（装甲车 20% / 自动炮台 30%，各 2s）
  if (z.slowUntil && run.time < z.slowUntil) mul = Math.min(mul, z.slowMul || 1);
  // 被点燃时额外 ×0.75（火焰塔的「卡路」作用）
  if (z.burnUntil && run.time < z.burnUntil) mul = Math.min(mul, 0.75);
  return mul;
}

// 「此刻据点还能不能到」的可达图（按 epoch 缓存）：
//   withForts = false → 只看地形（判断「路是不是被工事堵死了」）
//   withForts = true  → 地形 + 工事（判断「我是不是真的无路可走」）
function reachMap(run, withForts) {
  const key = withForts ? '_reachFull' : '_reachTerrain';
  const stamp = withForts ? '_reachFullEpoch' : '_reachTerrainEpoch';
  if (run[stamp] === run.epoch && run[key]) return run[key];
  const W = run.map.w, H = run.map.h;
  const bl = withForts ? buildBlocked(run) : buildBlockedUnits(run);
  const out = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  const start = run.core.y * W + run.core.x;
  if (!bl[start]) { out[start] = 1; q[tail++] = start; }
  while (head < tail) {
    const n = q[head++], x = n % W, y = (n / W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d], ny = y + DY4[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nn = ny * W + nx;
      if (out[nn] || bl[nn]) continue;
      out[nn] = 1; q[tail++] = nn;
    }
  }
  run[key] = out; run[stamp] = run.epoch;
  return out;
}

function canReachCore(run, x, y, withForts) {
  const W = run.map.w, H = run.map.h;
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return reachMap(run, withForts)[y * W + x] === 1;
}

// 有路却贴着障碍：不拆，只沿切线方向蹭出去，并强制重算路径
function nudgeOff(run, z, ox, oy) {
  const T = run.map.tile;
  const cx = (ox + 0.5) * T, cy = (oy + 0.5) * T;
  const dx = z.x - cx, dy = z.y - cy;
  const d = Math.hypot(dx, dy) || 1;
  z.x += (dx / d) * 1.6;
  z.y += (dy / d) * 1.6;
  z.eating = false;
  if (!(z.nudgeCd > 0)) { z.nudgeCd = 0.45; z.pathEpoch = -1; }
}

function tryBump(run, z) {
  const T = run.map.tile, W = run.map.w;
  const tx = Math.floor(z.x / T), ty = Math.floor(z.y / T);
  // 有完整通路（哪怕要绕远）：一律不拆工事/建筑，只靠边蹭出去
  const hasRoute = canReachCore(run, tx, ty, true);
  for (let d = 0; d < 4; d++) {
    const nx = tx + DX4[d], ny = ty + DY4[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= run.map.h) continue;
    const f = run._fortTile.get(ny * W + nx);
    if (f && f.blocks) {
      if (hasRoute) { nudgeOff(run, z, nx, ny); return true; }
      z.mode = 'attack'; z.target = { kind: 'fort', ref: f }; return true;
    }
    if (run.map.tiles[ny * W + nx] === TILE.BUILDING) {
      const b = buildingAt(run, nx, ny);
      if (b) {
        if (hasRoute) { nudgeOff(run, z, nx, ny); return true; }
        z.mode = 'attack'; z.target = { kind: 'building', ref: b }; return true;
      }
    }
  }
  return false;
}

// 点到矩形（格子）的最短距离：站在墙边就算「贴着」，而不是要求到中心
function rectDist(px, py, x0, y0, w, h, T) {
  const cx = Math.max(x0 * T, Math.min(px, (x0 + w) * T));
  const cy = Math.max(y0 * T, Math.min(py, (y0 + h) * T));
  return Math.hypot(px - cx, py - cy);
}

function targetCenter(t, T) {
  if (t.kind === 'fort') return { x: t.ref.x, y: t.ref.y };
  const b = t.ref;
  return { x: (b.x + b.w / 2) * T, y: (b.y + b.h / 2) * T };
}

// 无通路时：挑一个「挡路的」可破坏目标——身边、且靠据点方向优先
function pickObstacle(run, z) {
  const T = run.map.tile;
  const coreX = (run.core.x + 0.5) * T, coreY = (run.core.y + 0.5) * T;
  let best = null, bestScore = Infinity;
  const consider = (kind, ref, cx, cy) => {
    const dz = Math.hypot(cx - z.x, cy - z.y);
    if (dz > T * 7) return;
    const dc = Math.hypot(cx - coreX, cy - coreY);
    const score = dz * 0.62 + dc * 0.38;
    if (score < bestScore) { bestScore = score; best = { kind, ref }; }
  };
  for (const f of run.forts) {
    if (f.hp <= 0 || !f.blocks) continue;
    consider('fort', f, f.x, f.y);
  }
  for (const b of run.map.buildings) {
    if (b.hp <= 0) continue;
    consider('building', b, (b.x + b.w / 2) * T, (b.y + b.h / 2) * T);
  }
  return best;
}

// 找目标旁边一格可走的地面，用于接近再砸
function approachTile(run, z, t) {
  const T = run.map.tile, W = run.map.w, H = run.map.h;
  const c = targetCenter(t, T);
  const cx = Math.floor(c.x / T), cy = Math.floor(c.y / T);
  const bl = buildBlockedUnits(run);
  let best = null, bestD = Infinity;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (bl[y * W + x]) continue;
      const d = Math.hypot(x + 0.5 - z.x / T, y + 0.5 - z.y / T);
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best;
}

// 游荡者：在巢穴周围挑一个可走的巡逻点（用独立的 roamRng，不碰波次随机）
function nextRoamPoint(run, z) {
  const cfg = RULE.roam || {};
  const T = run.map.tile, W = run.map.w, H = run.map.h;
  const R = Math.max(1, z.patrolR || cfg.patrolR || 7);
  const hx = z.home.x, hy = z.home.y;
  for (let k = 0; k < 24; k++) {
    const a = run.roamRng.next() * Math.PI * 2;
    const r = Math.sqrt(run.roamRng.next()) * R;
    const tx = Math.round(hx + Math.cos(a) * r);
    const ty = Math.round(hy + Math.sin(a) * r);
    if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) continue;
    const tile = run.map.tiles[ty * W + tx];
    if (!TERRAIN[tile] || !TERRAIN[tile].walkable) continue;
    if (run._fortTile && run._fortTile.has(ty * W + tx)) continue;
    const b = (run.map.buildings || []).some((bb) => tx >= bb.x && tx < bb.x + bb.w && ty >= bb.y && ty < bb.y + bb.h);
    if (b) continue;
    if (Math.hypot(tx - hx, ty - hy) > R + 0.5) continue;
    z.wp = { x: tx, y: ty };
    z.pathEpoch = -1;
    z.path = null;
    z.pathIdx = 0;
    return true;
  }
  z.wp = null;
  return false;
}

// 三个出生点各走一条横道：取离出生行最近的车道
function laneForSpawn(sp) {
  const L = RULE.lane;
  if (!L || !L.bands || !L.bands.length) return null;
  let best = L.bands[0], bd = Infinity;
  for (const y of L.bands) {
    const d = Math.abs(y - sp.y);
    if (d < bd) { bd = d; best = y; }
  }
  return best;
}

// 分两段：先沿自己的横道推进到 mergeX，再并入中央大道冲核心
function lanePath(run, sx, sy, laneY) {
  const MX = RULE.lane.mergeX;
  if (sx >= MX) return findPath(run, sx, sy, run.core.x, run.core.y);
  const p1 = findPath(run, sx, sy, MX, laneY);
  if (!p1 || !p1.length) return findPath(run, sx, sy, run.core.x, run.core.y);
  const p2 = findPath(run, MX, laneY, run.core.x, run.core.y);
  if (!p2 || p2.length < 2) return p1;
  return p1.concat(p2.slice(1));
}

function processPaths(run) {
  let budget = RULE.path.maxPerFrame;
  const T = run.map.tile;
  for (const z of run.zombies) {
    if (budget <= 0) break;
    if (z.pathEpoch === run.epoch || z.mode === 'attack') continue;
    // 游荡僵尸不打据点：在自己的巡逻区里转（wp 优先，其次回巢）
    let gx = run.core.x, gy = run.core.y;
    if (z.roamer && run.phase === PHASE.BATTLE) {
      const t0 = z.wp || z.home;
      if (t0) { gx = t0.x; gy = t0.y; }
    } else if (z.roamer && z.home) {
      const t0 = z.wp || z.home;
      gx = t0.x; gy = t0.y;
    }
    // 抢点队：盯着已占领的资源点；目标点丢了就换下一个，全丢则回归主攻
    if (z.raider && run.nodes && run.nodes.length) {
      let best = null, bd = Infinity;
      const pool = run.nodes.filter((nd) => nd.owner === 1);
      for (const nd of pool) {
        const d = Math.hypot(nd.x - Math.floor(z.x / T), nd.y - Math.floor(z.y / T));
        if (d < bd) { bd = d; best = nd; }
      }
      if (best) { z.raidNodeId = best.id; gx = best.x; gy = best.y; }
    }
    const ztx = Math.floor(z.x / T), zty = Math.floor(z.y / T);
    const p = (z.laneY != null && gx === run.core.x && gy === run.core.y)
      ? lanePath(run, ztx, zty, z.laneY)
      : findPath(run, ztx, zty, gx, gy);
    if (p && p.length > 1) {
      // 有通路：一律优先走通（哪怕要绕远）
      z.path = p; z.pathIdx = 1;
      z.mode = 'move'; z.target = null;
    } else {
      // 没通路：砸开身边的障碍（路障/建筑），砸穿后 epoch 变更会自动重算
      z.path = null;
      // 被工事堵住是设计内的正常现象，不算寻路失败；
      // 只有「忽略工事也走不通」才是真正的地图连通性问题
      if (!findPath(run, Math.floor(z.x / T), Math.floor(z.y / T), gx, gy, true, false, false)) run.stats.pathFail++;
      else run.stats.fortBlocked = (run.stats.fortBlocked || 0) + 1;
      const t0 = pickObstacle(run, z);
      // 游荡者巡逻时只拆路障，不啃楼：楼挡路就换个巡逻点（工事照拆）
      const t = t0 && z.roamer && t0.kind !== 'fort' ? null : t0;
      if (t0 && !t) { z.wp = null; z.mode = 'move'; z.target = null; }
      if (t) {
        z.mode = 'attack'; z.target = t;
        const at = approachTile(run, z, t);
        if (at) {
          const ap = findPath(run, Math.floor(z.x / T), Math.floor(z.y / T), at.x, at.y, true, false, false);
          if (ap && ap.length > 1) { z.path = ap; z.pathIdx = 1; }
        }
        run.stats.obstacleHits = (run.stats.obstacleHits || 0) + 1;
      }
    }
    z.pathEpoch = run.epoch;
    run.stats.pathCalls++;
    budget--;
  }
}

// ---------------- 特感技能 ----------------
function unitNear(run, z, maxD, filter) {
  let best = null, bd = Infinity;
  for (const u of run.units) {
    if (u.hp <= 0) continue;
    if (filter && !filter(u)) continue;
    const d = Math.hypot(u.x - z.x, u.y - z.y);
    if (d <= maxD && d < bd) { bd = d; best = u; }
  }
  return best;
}

// 基地 / 兵营 / 载具工厂 这类“据点级”室内：烟雾者拉不动，也无法被它锁定
// 特感索敌用：玩家单位 + 叛军（方案 B：叛军不并入 run.units，避免污染人口/维护/指挥）
function hostileTargets(run) {
  if (!run.raiderOn || !run.raiders || !run.raiders.length) return run.units;
  return run.units.concat(run.raiders);
}

// 叛军对僵尸/特感来说同样是「人」：统一「谁是敌人」这一方向（方案 B）
// 叛军保留在 run.raiders，不并入 run.units，避免污染人口/维护/指挥等玩家逻辑
function raiderNear(run, z, maxD) {
  if (!run.raiderOn || !run.raiders || !run.raiders.length) return null;
  let best = null, bd = Infinity;
  for (const r of run.raiders) {
    if (r.hp <= 0) continue;
    const d = Math.hypot(r.x - z.x, r.y - z.y);
    if (d <= maxD && d < bd) { bd = d; best = r; }
  }
  return best;
}

// 玩家单位 ∪ 叛军，取最近的一个（特感技能选目标统一走这里）
function enemyNear(run, z, maxD, filter) {
  const u = unitNear(run, z, maxD, filter);
  const r = raiderNear(run, z, maxD);
  if (!u) return r;
  if (!r) return u;
  const du = Math.hypot(u.x - z.x, u.y - z.y);
  const dr = Math.hypot(r.x - z.x, r.y - z.y);
  return dr < du ? r : u;
}

function smokerImmuneRoom(run, room) {
  if (!room) return false;
  if (run.core && run.core.room === room) return true;
  for (const f of run.forts) if (f && f.room === room) return true;
  return false;
}

// 烟雾者的可拉拽目标：普通楼内的步兵会被“拽出来”，据点级室内免疫
function smokerPick(run, z, sp) {
  let best = null, bd = Infinity;
  for (const u of run.units) {
    if (u.hp <= 0) continue;
    const d = UNITS[u.kind];
    if (!d || !d.mobile || d.type === '载具') continue;
    if (u.depOn) continue;   // 架设状态（机枪组/自行火炮）扎稳了，舌头拽不动
    if (u.inside && smokerImmuneRoom(run, u.inside)) continue;
    const aim = u.inside ? buildingAim(u.inside, z.x, z.y) : { x: u.x, y: u.y };
    if (!aim) continue;
    const dist = Math.hypot(aim.x - z.x, aim.y - z.y);
    if (dist > sp.range) continue;
    if (!hasLOS(run, z.x, z.y, aim.x, aim.y)) continue;
    if (dist < bd) { bd = dist; best = u; }
  }
  return best;
}

// 烟雾者的「缠绕」目标：架设住、拖不动的机枪组（对自行火炮无效，按 special.suppress.kinds 白名单）
function smokerSuppressPick(run, z, sp) {
  const cfg = sp.suppress;
  if (!cfg) return null;
  const kinds = cfg.kinds || [];
  let best = null, bd = Infinity;
  for (const u of run.units) {
    if (u.hp <= 0 || !u.depOn) continue;
    if (kinds.indexOf(u.kind) < 0) continue;
    const dist = Math.hypot(u.x - z.x, u.y - z.y);
    if (dist > sp.range) continue;
    if (!hasLOS(run, z.x, z.y, u.x, u.y)) continue;
    if (dist < bd) { bd = dist; best = u; }
  }
  return best;
}

// 施加缠绕（不叠加：倍率取更狠、时长取更长）
function applySuppress(run, z, sp, u) {
  const cfg = sp.suppress;
  u.supMul = Math.max(u.supMul || 1, cfg.rateMul);   // 倍率越大射速越慢，取更强的那一次（不叠加）
  u.supT = Math.max(u.supT || 0, cfg.dur);
  z.spCd = sp.cd;
  if (run.effects.length < 200) run.effects.push({ suppress: true, x: u.x, y: u.y, life: 0.45, max: 0.45 });
  emit(run, { t: 'suppress', id: u.id, kind: u.kind, mul: cfg.rateMul, dur: cfg.dur });
  return true;
}

// 冲锋者（攻城）：只锁工事，不被人牵着走
// 注意：地雷不算「工事靶子」—— 它 blocks:false，不是障碍物，也不该被撞毁 / 站着啃，
// 只靠 stepMines 的 20px 触发半径引爆（否则冲锋者一下 90×2.2=198 秒杀 120 血的地雷，还能毫发无伤）。
export function fortNear(run, z, maxD) {
  let best = null, bd = Infinity;
  for (const f of run.forts) {
    if (!f || f.hp <= 0) continue;
    if (f.kind === 'mine') continue;
    const d = Math.hypot(f.x - z.x, f.y - z.y);
    if (d <= maxD && d < bd) { bd = d; best = f; }
  }
  return best;
}

// 猎手（刺客）：近处低血量的远程优先，否则打最近的
function hunterTarget(run, z, sp) {
  const near = sp.preferRange || 72;
  let pri = null, priHp = Infinity, any = null, anyD = Infinity;
  for (const u of hostileTargets(run)) {
    if (u.hp <= 0) continue;
    if (u.inside && ZOMBIE_GARRISON.jumpInMobs.indexOf(z.mob) < 0) continue;
    const d = Math.hypot(u.x - z.x, u.y - z.y);
    if (d > sp.range) continue;
    if (d < anyD) { anyD = d; any = u; }
    const def = UNITS[u.kind];
    const ranged = !!(def && (def.range || 0) >= 90);
    if (ranged && d <= near && u.hp < priHp) { priHp = u.hp; pri = u; }
  }
  return pri || any;
}

// 护甲减伤：实际伤害 = dmg × (1 - (护甲值 - 破甲))
// 僵尸护甲 × 武器克制（data.js 的 vsArmor / specBonus）
// 载具碾压：贴脸僵尸造成伤害 + 击退；每只贴身僵尸降低载具移速，围满则完全停住。
// 返回速度倍率（0 = 陷住不动）。玩家载具与叛军载具共用。
export function ramTick(run, ent, def, dt) {
  const R = def && def.ram;
  if (!R || !ent) return 1;
  const rad = (ent.r || 12) + 14;
  // touch 是「碾压权重」之和：行尸 1 / 特感 2 / 暴君 10（见 data.js 的 ramWeight）
  let touch = 0;
  let hitZ = false;
  const crushed = [];   // 被碾到的僵尸位置（压痕贴花用）
  const canZ = (ent._ramAt || 0) <= run.time;
  for (const z of run.zombies) {
    if (z.hp <= 0) continue;
    const dx = z.x - ent.x, dy = z.y - ent.y;
    if (Math.abs(dx) > rad || Math.abs(dy) > rad) continue;
    const d = Math.hypot(dx, dy);
    if (d > rad || d < 0.01) continue;
    const w = (ZOMBIES[z.mob] && ZOMBIES[z.mob].ramWeight) || 1;
    touch += w;
    if (!canZ) continue;
    const nx = dx / d, ny = dy / d;
    z.hp -= R.dmg;
    addFloat(run, z.x, z.y, R.dmg, false);
    crushed.push({ x: z.x, y: z.y });
    z.x += nx * R.knock;
    z.y += ny * R.knock;
    z.path = null;
    hitZ = true;
  }
  if (hitZ) {
    ent._ramAt = run.time + (R.cd || 0.3);
    // 视觉①：车头冲击椭圆（俯视下车是宽扁的，用圆环会像爆炸）
    if (run.effects.length < 870) {
      run.effects.push({
        crush: true, x: ent.x, y: ent.y, r: rad,
        side: ent.side === 'raider' ? 'raider' : 'ally',
        life: 0.24, max: 0.24, size: rad * 2,
      });
    }
    // 视觉②：压痕贴花（每处 0.9s，全局上限 60，满了顶掉最旧的一条）
    for (const c of crushed) {
      if (run.fxRng.next() > 0.6) continue;
      let nd = 0;
      for (const e of run.effects) if (e.decal) nd++;
      if (nd >= 60) {
        const di = run.effects.findIndex((e) => e.decal);
        if (di >= 0) run.effects.splice(di, 1);
      }
      run.effects.push({
        decal: true, x: c.x, y: c.y, rot: run.fxRng.next() * Math.PI,
        size: 4.5 + run.fxRng.next() * 3.5, life: 0.9, max: 0.9,
      });
    }
    // 视觉③：血雾（复用 gib 粒子，初速度沿车头方向）
    const ha = ent.dir || 0;
    for (let p = 0; p < 3; p++) {
      if (run.effects.length >= 900) break;
      const sp = 30 + run.fxRng.next() * 40;
      run.effects.push({
        gib: true, x: ent.x, y: ent.y,
        vx: Math.cos(ha + (run.fxRng.next() - 0.5) * 1.2) * sp,
        vy: Math.sin(ha + (run.fxRng.next() - 0.5) * 1.2) * sp,
        size: 1.5 + run.fxRng.next() * 1.3, rot: 0,
        life: 0.4, max: 0.4, ember: true,
      });
    }
    // 视觉④：音效事件，power = 碾压权重档位（行尸 1 / 特感 2 / 暴君 10 → 封 4）
    emit(run, { t: 'crush', x: ent.x, y: ent.y, power: Math.min(4, Math.max(1, Math.round(touch))) });
    // 撞击的代价：越挤掉得越快。1 只 = 基础值，每多 1 只 +15%，touch=21 时正好封顶 4 倍
    if (R.self) {
      const wmul = Math.min(4, 1 + Math.max(0, touch - 1) * 0.15);
      ent.hp -= Math.round(R.self * wmul);
    }
  }
  // 叛军载具撞玩家单位：伤害与撞僵尸相同（视同行尸），但对玩家用 0.5s 独立冷却
  // —— 让它变成「撞飞」而不是「连续绞肉」
  if (ent.side === 'raider' && run.units && run.units.length) {
    const canU = (ent._ramUnitAt || 0) <= run.time;
    for (const u of run.units) {
      if (u.hp <= 0) continue;
      const dx = u.x - ent.x, dy = u.y - ent.y;
      if (Math.abs(dx) > rad || Math.abs(dy) > rad) continue;
      const d = Math.hypot(dx, dy);
      if (d > rad || d < 0.01) continue;
      touch += 1;
      if (!canU) continue;
      const nx = dx / d, ny = dy / d;
      hurtUnit(run, u, R.dmg, 0.25, 0, 'vehicle');
      u.x += nx * R.knock;
      u.y += ny * R.knock;
      u.path = null;
      u.order = null;
      ent._ramUnitAt = run.time + 0.5;
    }
  }
  if (touch >= (R.stuckAt || 99)) return 0;
  return Math.max(0.15, 1 - touch * (R.slowPer || 0.06));
}

export function zArmorMul(def, z, run) {
  if (!def || !z) return 1;
  const zd = ZOMBIES[z.mob];
  const arm = (zd && zd.armor) || 'none';
  const vs = def.vsArmor && def.vsArmor[arm];
  const base = vs == null ? 1 : vs;
  const bonus = (def.specBonus && def.specBonus[z.mob]) || 1;
  // 核心升级：强化弹药（无甲/轻甲 +30%）/ 穿甲弹芯（重甲 +25%）
  let perk = 1;
  if (run && run.perks) {
    perk = arm === 'heavy'
      ? (run.perks.has('pierce') ? 1.25 : 1)
      : (run.perks.has('ammo') ? 1.30 : 1);
  }
  // 狙击对 BOSS 专用倍率（只认 z.boss，不影响普通重甲 —— 反重甲仍归火箭筒兵）
  let bossMul = 1;
  if (def.vsBoss && z.boss) bossMul = def.vsBoss;
  return base * bonus * perk * bossMul;
}

// 该僵尸对某一档护甲的“无视程度”：1 = 完全无视，0.5 = 减伤减半，0 = 无效
export function armorPierceOf(mob, armor) {
  const zd = ZOMBIES[mob];
  const map = zd && zd.armorPierce;
  const v = map && map[armor || 'none'];
  return v ? Math.min(1, Math.max(0, v)) : 0;
}

export function armorMul(armor, pen = 0, pierce = 0) {
  const base = ARMOR[armor || 'none'] || 0;
  // 破甲按百分比抵消护甲：pen 0.35 → 剩余护甲 65%
  // pierce 是该僵尸对这一档护甲的无视程度（1=完全无视，0.5=减伤减半）
  const body = base * (1 - Math.min(0.9, pen || 0));
  return 1 - body * (1 - Math.min(1, Math.max(0, pierce || 0)));
}

// 僵尸（或任意 mob）打某个护甲档目标的综合倍率 = 护甲 × 破甲 × 兵种克甲。
// 原先这段组合在 4 处手写，新增兵种/护甲档时容易漏改，统一走这里。
export function mobHitMul(mob, pen, armor) {
  const a = armor || 'none';
  return armorMul(a, pen || 0, armorPierceOf(mob, a));
}

// 敌方酸液之类的地面减速：取更强的那个，时间取更晚的那个
function applyUnitSlow(run, u, mul, dur) {
  if (!mul || mul >= 1) return;
  const until = run.time + (dur || 2);
  if (!u.slowUntil || u.slowUntil < until) { u.slowUntil = until; u.slowMul = mul; }
  else if (mul < (u.slowMul || 1)) u.slowMul = mul;
}

// 冲锋击退：0.12s 内平滑滑到落点（原先直接 u.x = kx 是瞬移，观感像跳格）。
// 同时清掉旧路径，让它在击退结束后重新寻路，而不是沿原路硬穿回来。
export function knockUnit(run, u, kx, ky, dur) {
  const d = dur || 0.12;
  u.kbX = kx; u.kbY = ky; u.kbT = d; u.kbD = d;
  u.path = null;
  u.pathEpoch = 0;
  u.moving = false;
}


// ---- 叛军（劫掠者）：第三方势力 ------------------------------------------------
// 注意：与僵尸的 z.raider（抢点小队）完全无关。叛军是"人"，红方，同时与玩家和僵尸敌对。
// 对象字段刻意与单位对齐（kind 必须是 UNITS 的合法 key），所以 hurtUnit()、
// zArmorMul()、addFloat()、armorMul() 都能直接复用，不必另写一套伤害结算。
function raiderCfg() { return RULE.raider || {}; }
// 叛军数值缩放：全局统一 scale（2026-11-07 取消地图级 raiderMul，两图一致）
function raiderScale(run) {
  const c = raiderCfg();
  return c.scale != null ? c.scale : 0.85;
}

// 点到线段 ab 的距离（用来判断资源点离"僵尸主路"有多远）
function raiderSegDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

export function spawnRaider(run, kind, x, y) {
  const def = UNITS[kind];
  if (!def) return null;
  const s = raiderScale(run);
  const hp = Math.max(1, Math.round((def.hp || 60) * s));
  const r = {
    id: run.nextId++, kind, side: 'raider', mob: null,
    x, y, hp, maxHp: hp, r: def.r, size: def.r,
    armor: def.armor || 'none',
    speed: def.speed || 30, range: def.range || 100,
    dmg: (def.dmg || 5) * s,
    fireInterval: def.fireInterval || 1,
    splash: def.splash || null, vsArmor: def.vsArmor || null,
    ram: def.ram || null,
    cd: 0.4 + run.rng.next() * 0.6, dir: Math.PI,
    tx: Math.floor(x / run.map.tile), ty: Math.floor(y / run.map.tile),
    aimX: x, aimY: y, flash: 0, stun: 0,
    path: null, pathIdx: 0, pathEpoch: 0,
    thinkT: 0, target: null,
  };
  const _k = run.raiders.length % 3;
  const _ang = (-Math.PI / 2) + _k * (Math.PI * 2 / 3);
  r.homeDx = Math.cos(_ang) * 1.15;
  r.homeDy = Math.sin(_ang) * 1.15;
  run.raiders.push(r);
  return r;
}

// 在格 (tx,ty) 附近找一格能站的位置，返回像素坐标
function raiderSpot(run, tx, ty, taken) {
  const W = run.map.w, H = run.map.h, T = run.map.tile;
  for (let rad = 0; rad <= 5; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (rad && Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const t = run.map.tiles[y * W + x];
        if (!TERRAIN[t] || !TERRAIN[t].walkable) continue;
        if (run._fortTile && run._fortTile.has(y * W + x)) continue;
        if (taken && taken.has(y * W + x)) continue;
        return { x: (x + 0.5) * T, y: (y + 0.5) * T, tx: x, ty: y };
      }
    }
  }
  return null;
}

// 选占领点：优先「离僵尸主路远 + 偏地图下方（下方通常没有主尸潮）」，且不贴核心
function raiderPickNode(run) {
  const T = run.map.tile;
  const cx = (run.core.x + 0.5) * T, cy = (run.core.y + 0.5) * T;
  const spawns = run.map.spawns || [];
  const cfg = raiderCfg();
  const minD = (cfg.minCoreDist != null ? cfg.minCoreDist : 9) * T;
  let best = null, bestScore = -Infinity;
  for (const n of run.nodes) {
    const nx = (n.x + 0.5) * T, ny = (n.y + 0.5) * T;
    const dCore = Math.hypot(nx - cx, ny - cy);
    if (dCore < minD) continue;
    let dPath = Infinity;
    for (const sp of spawns) dPath = Math.min(dPath, raiderSegDist(nx, ny, sp.x, sp.y, cx, cy));
    if (!isFinite(dPath)) dPath = dCore * 0.5;
    const score = dPath * 2 + (ny - cy) * 0.8 + Math.min(dCore, 24 * T) * 0.15;
    if (score > bestScore) { bestScore = score; best = n; }
  }
  if (best) return best;
  let far = null, fd = -1;
  for (const n of run.nodes) {
    const d = Math.hypot(n.x - run.core.x, n.y - run.core.y);
    if (d > fd) { fd = d; far = n; }
  }
  return far;
}

export function initRaiders(run) {
  const T = run.map.tile;
  run.raiders = [];
  run.raiderPush = false;
  const node = raiderPickNode(run);
  if (node) {
    node.owner = 2; node.cap = -1;
    run.raiderNode = node.id;
    emit(run, { t: 'node', x: (node.x + 0.5) * T, y: (node.y + 0.5) * T, own: 2 });
  }
  const squad = raiderCfg().startSquad || ['infantry', 'infantry', 'rocket', 'vehicle'];
  const bx = node ? node.x : run.core.x + 8, by = node ? node.y : run.core.y;
  const taken = new Set();
  for (const k of squad) {
    const p = raiderSpot(run, bx, by, taken);
    if (!p) break;
    taken.add(p.ty * run.map.w + p.tx);
    spawnRaider(run, k, p.x, p.y);
  }
}

export function raiderReinforce(run) {
  if (!run.raiderOn) return [];
  const out = [];
  const squad = raiderCfg().reinforce || ['infantry', 'infantry', 'rocket', 'vehicle'];
  const node = run.nodes.find((n) => n.id === run.raiderNode) || raiderPickNode(run);
  const bx = node ? node.x : run.core.x + 8, by = node ? node.y : run.core.y;
  const taken = new Set();
  for (const r0 of run.raiders || []) {
    if (r0.hp > 0) taken.add(Math.floor(r0.y / run.map.tile) * run.map.w + Math.floor(r0.x / run.map.tile));
  }
  for (const k of squad) {
    const p = raiderSpot(run, bx, by, taken);
    if (!p) break;
    taken.add(p.ty * run.map.w + p.tx);
    const r = spawnRaider(run, k, p.x, p.y);
    if (r) out.push(r);
  }
  return out;
}

// 叛军选目标：玩家单位 / 僵尸 / 工事 / 据点。刻意不打地图建筑（用户拍板第 3 条）。
// 叛军有效射程：自身 range × 所在地形倍率（与 art.js 射程圈同口径，避免"圈里有敌人却不打"）
export function raiderRange(run, r) {
  const T = run.map.tile;
  const tx = Math.max(0, Math.min(run.map.w - 1, Math.floor(r.x / T)));
  const ty = Math.max(0, Math.min(run.map.h - 1, Math.floor(r.y / T)));
  const tId = run.map.tiles[ty * run.map.w + tx];
  const mul = (TERRAIN[tId] && TERRAIN[tId].range) || 1;
  return (r.range || 100) * mul;
}

function raiderPickTarget(run, r) {
  const T = run.map.tile;
  const seeR = Math.max((raiderCfg().engageTiles || 6) * T, raiderRange(run, r) + T * 0.5);
  let best = null, bd = Infinity;
  const consider = (obj, kind, x, y) => {
    const d = Math.hypot(x - r.x, y - r.y);
    if (d > seeR || d >= bd) return;
    bd = d; best = { obj, kind, x, y };
  };
  for (const u of run.units) { if (u.hp > 0) consider(u, 'unit', u.x, u.y); }
  for (const z of run.zombies) { if (z.hp > 0) consider(z, 'zombie', z.x, z.y); }
  for (const f of run.forts) { if (f.hp > 0) consider(f, 'fort', f.x, f.y); }
  if (run.core && run.core.hp > 0) {
    consider(run.core, 'core', (run.core.x + 0.5) * T, (run.core.y + 0.5) * T);
  }
  return best;
}

// 装甲车狂暴索敌：只找玩家的步兵/载具（排除炮台与工事），用于冲锋自爆
function raiderBoomTarget(run, r) {
  let best = null, bd = Infinity;
  for (const u of run.units) {
    if (u.hp <= 0) continue;
    const d = UNITS[u.kind];
    if (!d || d.type === '炮台') continue;   // 不冲防御塔
    const dist = Math.hypot(u.x - r.x, u.y - r.y);
    if (dist < bd) { bd = dist; best = { kind: 'unit', obj: u, x: u.x, y: u.y }; }
  }
  return best;
}

function raiderMoveTo(run, r, tx, ty, dt, mul) {
  const W = run.map.w, T = run.map.tile;
  if (!r.path || r.pathEpoch !== run.epoch) {
    const sx = Math.floor(r.x / T), sy = Math.floor(r.y / T);
    // 认路障（ignoreForts=false）：叛军不能穿过玩家工事。
    r.path = findPath(run, sx, sy, tx, ty, false);
    // 目标本身是阻挡工事（要贴近打）或落点被封：退到目标四邻的可达格
    if (!r.path || !r.path.length) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const p = findPath(run, sx, sy, tx + dx, ty + dy, false);
        if (p && p.length) { r.path = p; break; }
      }
    }
    // 极端情况（整条腿被封死）才退回无视工事，避免整队站桩
    if (!r.path || !r.path.length) r.path = findPath(run, sx, sy, tx, ty, true);
    r.pathIdx = 0;
    r.pathEpoch = run.epoch;
  }
  if (!r.path || r.pathIdx >= r.path.length) return false;
  const node = r.path[r.pathIdx];
  const nx = ((node % W) + 0.5) * T, ny = (((node / W) | 0) + 0.5) * T;
  const dx = nx - r.x, dy = ny - r.y, d = Math.hypot(dx, dy) || 1;
  // 减速也要对叛军生效（特感的酸池 / 践踏 / 冲锋重甲减速都写 slowUntil+slowMul）
  const slowK = r.slowUntil && run.time < r.slowUntil ? (r.slowMul || 1) : 1;
  // 叛军装甲车同样碾压：撞僵尸、也被僵尸拖慢；围满直接停住
  let ramK = 1;
  if (r.ram) {
    ramK = ramTick(run, r, { ram: r.ram }, dt);
    if (ramK <= 0) return false;
  }
  const step = (r.speed || 40) * (mul || 1) * slowK * ramK * dt;
  r.dir = Math.atan2(dy, dx);
  if (d <= step) { r.x = nx; r.y = ny; r.pathIdx++; }
  else { r.x += (dx / d) * step; r.y += (dy / d) * step; }
  return true;
}

// 叛军火箭筒兵打玩家载具：本职加成（普通步兵与装甲车不吃）
function raiderVsPlayerVehicle(r, target) {
  if (!r || r.kind !== 'rocket' || !target) return 1;
  const d = UNITS[target.kind];
  if (!d || d.type !== '载具') return 1;
  const v = raiderCfg().rocketVsVehicle;
  return v != null ? v : 1;
}

// 叛军开火：单位/僵尸走护甲结算，工事与据点直接扣
function raiderShoot(run, r, tgt) {
  const dmg = r.dmg || 5;
  if (tgt.kind === 'unit') {
    const u = tgt.obj;
    if (u.hp <= 0) return;
    const vm = raiderVsPlayerVehicle(r, u);
    hurtUnit(run, u, dmg * vm, 0, 0, null);
    if (vm > 1) addFloat(run, u.x, u.y, dmg * vm, false);
  } else if (tgt.kind === 'zombie') {
    const z = tgt.obj;
    if (z.hp <= 0) return;
    z.hp -= dmg * zArmorMul({ dmg, vsArmor: r.vsArmor, specBonus: null }, z);
    addFloat(run, z.x, z.y, dmg);
  } else if (tgt.kind === 'fort') {
    const f = tgt.obj;
    if (f.hp <= 0) return;
    const fd = FORTS[f.kind];
    f.hp -= dmg * armorMul(fd ? fd.armor : 'none', 0);
  } else if (tgt.kind === 'core') {
    run.core.hp -= dmg;
  }
  // 范围伤害：火箭筒兵是叛军唯一带 splash 的单位，此前只结算了单体，看不到爆炸特效与溅射
  if (r.splash) raiderSplash(run, r, tgt);
  r.aimX = tgt.x; r.aimY = tgt.y;
  emit(run, { t: 'shot', k: r.kind, x: r.x, y: r.y });
  if (run.effects.length < 400) {
    run.effects.push({ tracer: true, x1: r.x, y1: r.y, x2: tgt.x, y2: tgt.y, life: 0.08, max: 0.08 });
  }
}

// 叛军的溅射：落点周围按 1.5 次方衰减，僵尸与玩家单位都吃；队友不吃自己的火箭（否则 4 人小队一炮自杀）
function raiderSplash(run, r, tgt) {
  const sp = r.splash;
  const R = sp.radius || 26;
  const f = sp.factor != null ? sp.factor : 0.5;
  const dmg = r.dmg || 5;
  const x = tgt.x, y = tgt.y;
  for (const z of run.zombies) {
    if (z.hp <= 0 || z === tgt.obj) continue;
    const d = Math.hypot(z.x - x, z.y - y);
    if (d > R) continue;
    const k = falloffK(d, R, f);
    z.hp -= dmg * k * zArmorMul({ dmg, vsArmor: r.vsArmor, specBonus: null }, z);
    if (z.hp < 0) z.hp = 0;
  }
  for (const u of run.units) {
    if (u.hp <= 0 || u === tgt.obj) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d > R) continue;
    hurtUnit(run, u, dmg * falloffK(d, R, f) * raiderVsPlayerVehicle(r, u), 0, 0, null);
  }
  // 爆炸环要停够久才看得见（0.26s 常常一帧就错过），再叠一层亮芯
  if (run.effects.length < 398) {
    run.effects.push({ x, y, life: 0.6, max: 0.6, size: R * 2.4, ring: true });
    run.effects.push({ x, y, life: 0.18, max: 0.18, size: 14, ring: true });
  }
  emit(run, { t: 'boom', x, y, r: R });
}

export function stepRaiders(run, dt) {
  if (!run.raiderOn || !run.raiders || !run.raiders.length) return;
  const T = run.map.tile;
  const cfg = raiderCfg();
  const push = !!run.raiderPush;
  for (const r of run.raiders) {
    if (r.hp <= 0) continue;
    r.tx = Math.floor(r.x / T); r.ty = Math.floor(r.y / T);
    if (r.flash > 0) r.flash -= dt;
    if (r.stun > 0) { r.stun -= dt; continue; }
    if (r.cd > 0) r.cd -= dt;
    // 装甲车狂暴：血量低于阈值后冲向最近的玩家步兵/载具，贴身引爆（狂暴期仍开火）
    const sb = cfg.selfBoom;
    if (sb && r.kind === 'vehicle' && r.maxHp > 0 && r.hp <= r.maxHp * (sb.hpPct || 0.3)) {
      const bt = raiderBoomTarget(run, r);
      if (bt) {
        // 预警：先亮 0.7s 红光（art.js 画脉冲环 + 头顶「!」），期间照常开火，之后才冲刺
        if (r.windup == null) {
          r.windup = sb.windup != null ? sb.windup : 0.7;
          emit(run, { t: 'alarm', x: r.x, y: r.y });
        }
        const bd = Math.hypot(bt.x - r.x, bt.y - r.y);
        r.dir = Math.atan2(bt.y - r.y, bt.x - r.x);
        // 狂暴冲锋期也照常开火：冲撞目标够得到就打它，够不到就打射程内的其它敌人（含僵尸）
        // （此前这里只打 boom 目标，导致装甲车一旦进入狂暴就无视贴脸的僵尸，看着像「不打僵尸」）
        const rngB = raiderRange(run, r);
        let st = bd <= rngB ? bt : null;
        if (!st) {
          const nt = raiderPickTarget(run, r);
          if (nt && nt.kind !== 'core' && nt.kind !== 'fort' && Math.hypot(nt.x - r.x, nt.y - r.y) <= rngB) st = nt;
        }
        if (st && r.cd <= 0) { r.cd = r.fireInterval || 1; r.flash = 0.09; raiderShoot(run, r, st); }
        if (r.windup > 0) { r.windup -= dt; r.path = null; r.pathEpoch = 0; continue; }
        const udef = UNITS[bt.obj.kind];
        const touch = (r.r || 10) + (udef ? udef.r : 10) + 6;
        if (bd <= touch) { r.hp = 0; r._touchBoom = true; continue; }   // 贴身引爆
        raiderMoveTo(run, r, Math.floor(bt.x / T), Math.floor(bt.y / T), dt, sb.chargeMul || 1.7);
        continue;
      }
    }
    if (r.windup > 0) { r.windup -= dt; r.path = null; r.pathEpoch = 0; }   // 目标中途消失也不卡在预警态
    r.thinkT = (r.thinkT || 0) - dt;
    if (r.thinkT <= 0 || !r.target || !r.target.obj || r.target.obj.hp <= 0) {
      r.thinkT = cfg.think || 0.5;
      r.target = raiderPickTarget(run, r);
      r.path = null; r.pathEpoch = 0;
    }
    let tgt = r.target;
    // 逃跑：残血（非装甲车狂暴态）只打贴身威胁，否则缩回资源点，不再主动出击
    const fleePct = sb && sb.fleePct != null ? sb.fleePct : 0.2;
    const fleeR = (sb && sb.fleeTiles != null ? sb.fleeTiles : 3) * T;
    if (tgt && tgt.obj && tgt.obj.hp > 0 && r.maxHp > 0 && r.hp <= r.maxHp * fleePct) {
      const fd = Math.hypot((tgt.x || 0) - r.x, (tgt.y || 0) - r.y);
      if (fd > fleeR) {
        tgt = null;
        r.target = null;
        r.path = null; r.pathEpoch = 0;
      }
    }
    if (push) {
      // 扑核心不是闭眼冲锋：射程内的敌人先打掉，打完再继续往核心推
      // （此前这里无条件把 target 覆盖成核心，导致第 8 波全员无视贴脸的僵尸与玩家单位）
      const coreT = { kind: 'core', obj: run.core, x: (run.core.x + 0.5) * T, y: (run.core.y + 0.5) * T };
      const rng = raiderRange(run, r);
      const engaged = tgt && tgt.obj && tgt.obj.hp > 0 && tgt.kind !== 'core'
        && Math.hypot(tgt.x - r.x, tgt.y - r.y) <= rng;
      if (engaged) r.target = tgt;
      else { tgt = coreT; r.target = coreT; }
    }
    if (!tgt || !tgt.obj || tgt.obj.hp <= 0) {
      // 无敌人：回自己的资源点守着（开局占点的存在感）
      const nd = run.raiderNode ? run.nodes.find((n) => n.id === run.raiderNode) : null;
      if (nd) {
        const hx = nd.x + 0.5 + (r.homeDx || 0), hy = nd.y + 0.5 + (r.homeDy || 0);
        const gx = hx * T, gy = hy * T;
        if (Math.hypot(gx - r.x, gy - r.y) > 0.9 * T) raiderMoveTo(run, r, Math.floor(hx), Math.floor(hy), dt);
      }
      continue;
    }
    const d = Math.hypot(tgt.x - r.x, tgt.y - r.y);
    if (d <= raiderRange(run, r)) {
      r.path = null; r.pathEpoch = 0;
      r.dir = Math.atan2(tgt.y - r.y, tgt.x - r.x);
      if (r.cd <= 0) { r.cd = r.fireInterval || 1; r.flash = 0.09; raiderShoot(run, r, tgt); }
    } else {
      raiderMoveTo(run, r, Math.floor(tgt.x / T), Math.floor(tgt.y / T), dt);
    }
  }
  // 叛军阵亡：装甲车自爆（被打死也炸）。被友军爆炸炸死的带 _noBoom 标记，不连锁
  const dead = [];
  for (const r of run.raiders) if (r.hp <= 0) dead.push(r);
  if (dead.length) {
    for (const r of dead) {
      // 叛军尸体：和玩家单位尸体同款，但颜色偏琥珀（画在单位下层）
      {
        const rd = UNITS[r.kind] || {};
        const rveh = rd.type === '载具';
        pushDecal(run, {
          k: 'rbody', x: r.x, y: r.y, kind: r.kind, veh: rveh,
          rot: rveh ? (run.fxRng.next() - 0.5) * 0.8 : (run.fxRng.next() - 0.5) * 0.3,
          s: rveh ? 1 : 0.72,
          blood: rveh ? null : ((run.fxRng.next() * 3) | 0),
          life: decalLife().rbody, max: decalLife().rbody,
        });
      }
      // 叛军步兵阵亡也会变行尸（与玩家步兵同一套概率/上限；载具不转）
      if (r._riseSrc) maybeRise(run, r, r._riseSrc, 'raider');
      if (r.kind !== 'vehicle' || r._noBoom) continue;
      const vd = UNITS[r.kind];
      if (!vd || !vd.boom) continue;
      const sb2 = cfg.selfBoom;
      const delay = r._touchBoom ? ((sb2 && sb2.touchDelay) || 0.12) : ((sb2 && sb2.delay) || 0.15);
      const vmul = (sb2 && sb2.vehicleMul != null) ? sb2.vehicleMul : 1;
      scheduleBoom(run, Object.assign({}, vd.boom, { delay, vehicleMul: vmul }), r.x, r.y);
    }
    run.raiders = run.raiders.filter((r) => r.hp > 0);
  }
}

// 战地光环：医疗兵周围一圈内、楼外的步兵受击减伤（不叠加）
function medicAuraMul(run, u) {
  const aura = UNITS.medic && UNITS.medic.heal && UNITS.medic.heal.aura;
  if (!aura) return 1;
  const ud = UNITS[u.kind];
  if (!ud || ud.type !== '步兵') return 1;   // 只给步兵：载具/炮台不吃光环
  const R2 = aura.radius || 96;
  for (const m of run.units) {
    if (m === u || m.hp <= 0 || m.kind !== 'medic' || m.inside) continue;
    if (Math.hypot(m.x - u.x, m.y - u.y) <= R2) return 1 - (aura.dr || 0.12);
  }
  return 1;
}

// quiet = true 时不弹伤害数字、也不刷受击白闪：
// 给「每帧持续扣血」的路径（近战啃咬/舌头拉拽/持续爆炸）用，否则数字会刷满屏。
export function hurtUnit(run, u, dmg, stun, pen, srcMob, quiet = false) {   // 导出供 tools 自测（armorpath-check）
  // 统一走护甲：特感技能 / 撞击 / 酸液都吃我方单位护甲（此前这条路径完全绕过护甲）
  if ((u.invT || 0) > 0) return 0;   // 空降兵落地保护期：完全免疫
  // srcMob：伤害来源僵尸，用于 armorPierce（冲锋者/壮尸无视轻甲，暴君无视轻甲+重甲减半）
  const def = UNITS[u.kind];
  if (!def) return 0;                 // kind 被外部清掉（boomAt 延迟一帧触发）时不要抛 TypeError
  const arm = def.armor;
  let dealt = dmg * mobHitMul(srcMob, pen, arm);
  if (u.inside) dealt *= (1 - GARRISON.dr);
  else if (u.depOn && def.deploy) dealt *= (1 - (def.deploy.dr || 0));
  if (!u.inside) dealt *= medicAuraMul(run, u);   // 非楼内单位：医疗兵光环减伤（只对步兵生效）
  if (warcryInRange(run, u)) {
    const dr = HERO_SKILLS.warcry.dr;
    // 上面那行已经把医疗兵光环乘进 dealt 了。这里做「取高不叠乘」：
    // 如果战吼更强，就把原来的光环因子换掉（dealt / mm * (1-dr)）。
    // 千万别写成 dealt /= (mm * (1-dr))——那是把伤害除以 0.9，会变成"多受伤"。
    const mm = medicAuraMul(run, u);
    if (1 - dr < mm) dealt = (dealt / mm) * (1 - dr);
  }
  if (u.landDrUntil && run.time < u.landDrUntil) dealt *= (1 - ((HERO_SKILLS.grapple || {}).landDr || 0.25));
  if (!(dealt > 0)) return 0;   // NaN / 负数伤害直接丢弃：否则 hp 变 NaN，`hp > 0` 为假会被当成尸体清掉
  u.hp -= dealt;
  if (u.hp <= 0 && srcMob && !u._riseSrc) u._riseSrc = srcMob;   // 死于僵尸之手才可能转行尸
  u.lastHitAt = run.time;
  if (!quiet) u.flash = 0.14;
  if (stun) u.stun = Math.max(u.stun || 0, stun);
  if (!quiet) addFloat(run, u.x, u.y, dealt);
  // 指挥官反伤：只有「贴脸啃咬」才触发（远距离的酸液/冲锋不反），同一只 0.5s 内只回敬一次
  if (def.hero && srcMob && srcMob.hp > 0 && run.zombies && run.zombies.includes(srcMob)) {
    const TH = RULE.heroThorns || {};
    const near = Math.hypot(u.x - srcMob.x, u.y - srcMob.y) <= (u.r || 8) + (srcMob.r || 8) + 6;
    if (near && run.time - (srcMob._thornsAt ?? -9) >= (TH.cd || 0.5)) {
      const back = dealt * (TH.mul || 0.2);
      srcMob.hp -= back;
      srcMob._thornsAt = run.time;
      addFloat(run, srcMob.x, srcMob.y, back, false);
    }
  }
  return dealt;   // 调用方（炮台/友伤统计）需要知道实际造成多少
}

// 载具/燃烧塔阵亡自爆：僵尸 100% / 建筑 30% / 我方 50%，不吃友伤开关（这是硬伤）
export function boomAt(run, cfg, x, y, tag) {
  // 地面焦痕：只给「像样」的爆炸留（子弹/小口径不留，否则满屏黑点）
  if (cfg && (cfg.radius || 0) >= 28) {
    pushDecal(run, {
      k: 'scorch', x, y, r: (cfg.radius || 0) * 0.55,
      rot: run.fxRng.next() * Math.PI * 2, v: Math.floor(run.fxRng.next() * 3),
      life: decalLife().scorch, max: decalLife().scorch,
    });
  }   // 导出供 tools 自测（boom-check）
  const R = cfg.radius, f = cfg.falloff != null ? cfg.falloff : 0.5;
  const dmg = cfg.dmg;
  for (const z of run.zombies) {
    if (z.hp <= 0) continue;
    const d = Math.hypot(z.x - x, z.y - y);
    if (d > R) continue;
    const k = falloffK(d, R, f);
    z.hp -= dmg * k;
    addFloat(run, z.x, z.y, dmg * k, false);
  }
  const um = cfg.unitMul != null ? cfg.unitMul : 0.5;
  const vm = cfg.vehicleMul != null ? cfg.vehicleMul : 1;   // 叛军装甲车对载具特攻
  if (um > 0) {
    for (const u of run.units) {
      if (u.hp <= 0) continue;
      const ud = UNITS[u.kind];
      if (!ud) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d > R) continue;
      const vmul = ud.type === '载具' ? vm : 1;
      const k = falloffK(d, R, f) * um * vmul;
      // 走 hurtUnit：爆炸同样不该打穿空投落地保护 / 医疗光环 / 战吼减伤
      const hit = hurtUnit(run, u, dmg * k, 0, 0, null, true);
      if (!(hit > 0.05)) continue;
      if (u.hp <= 0) u._noBoom = true;   // 被自爆炸死的不再引爆（不连锁）
      addFloat(run, u.x, u.y, hit, true);
    }
  }
  // 叛军也吃爆炸（装甲车自爆会炸到自己的队友）
  const rm = cfg.raiderMul != null ? cfg.raiderMul
    : ((raiderCfg().selfBoom && raiderCfg().selfBoom.teammateMul != null) ? raiderCfg().selfBoom.teammateMul : 0.7);
  if (rm > 0 && run.raiders && run.raiders.length) {
    for (const r of run.raiders) {
      if (r.hp <= 0) continue;
      const d = Math.hypot(r.x - x, r.y - y);
      if (d > R) continue;
      const k = falloffK(d, R, f) * rm * armorMul(r.armor || 'none', 0);
      r.hp -= dmg * k;
      r.flash = 0.14;
      if (r.hp <= 0) r._noBoom = true;   // 被炸死的不再引爆（不连锁）
      addFloat(run, r.x, r.y, dmg * k, true);
    }
  }
  const bm = cfg.buildingMul != null ? cfg.buildingMul : 0.3;
  if (bm > 0) {
    const T = run.map.tile;
    const b = buildingAt(run, Math.floor(x / T), Math.floor(y / T));
    if (b && b.hp > 0) damageBuilding(run, b, dmg * bm, 0, true);
  }
  run.effects.push({ x, y, life: 0.34, max: 0.34, size: R * 2, ring: true });
  // tag 用来区分爆炸来源（只有玩家载具殉爆才该进战报），别处一律 null
  emit(run, { t: 'boom', x, y, r: R, tag: tag || null });
  if (run.shake !== undefined) run.shake = Math.max(run.shake || 0, 0.3);
}

// 延迟 0.15s 再炸（给视觉与反应时间），走 stepFx 的 e.boom 分支
function scheduleBoom(run, cfg, x, y, tag) {
  const d = cfg.delay != null ? cfg.delay : 0.15;
  run.effects.push({ x, y, life: d, max: d, size: 0, boom: cfg, tag });
}

// 冲锋前的危险带（蓄力期地面警示）。与真实冲锋同一套判据：沿 dashA 逐格试探，
// 遇到不可走格立即截断，上限 dashSpeed * dashTime。art.js 用它画地面警示条。
// 冲锋最短有效距离（约 1.7 格）：前面立刻是墙/水/据点时不该蓄力空冲。
// 之前这里没有下限，遇到贴墙的角度会让 len=0，蓄力完原地停住、一次伤害都没有。
export const CHARGE_MIN_LEN = 40;

// 从 (x,y) 沿 ang 能走多远（4px 步进，遇不可走格即停）。危险带与真实冲锋共用。
export function laneLen(run, x, y, ang, maxLen) {
  const T = run.map.tile, W = run.map.w, H = run.map.h;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let len = 0;
  for (let d = 4; d <= maxLen; d += 4) {
    const nx = x + ca * d, ny = y + sa * d;
    const tx = Math.floor(nx / T), ty = Math.floor(ny / T);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) break;
    if (!TERRAIN[run.map.tiles[ty * W + tx]].walkable) break;
    len = d;
  }
  return len;
}

export function chargeLane(run, z) {
  const sp = z && z.sp;
  if (!sp || sp.ability !== 'charge' || z.spPhase !== 'windup') return null;
  const maxLen = (sp.dashSpeed || 200) * (sp.dashTime || 0.5);
  const ca = Math.cos(z.dashA), sa = Math.sin(z.dashA);
  const len = laneLen(run, z.x, z.y, z.dashA, maxLen);
  const windup = sp.windup || 0.5;
  return {
    x0: z.x, y0: z.y,
    x1: z.x + ca * len, y1: z.y + sa * len,
    len,
    ok: len >= CHARGE_MIN_LEN,
    half: 20,   // 危险带半宽：命中半径 14 + 常见单位半径，覆盖步兵/载具
    t: Math.min(1, Math.max(0, 1 - (z.spT || 0) / windup)),
  };
}

// 冲锋停下时还够得着目标吗：命中判定是 14 + 单位半径，按步兵(7)取 20 留 1px 余量
export const CHARGE_HIT_WINDOW = 20;

// 这个角度值不值得冲：能走够 CHARGE_MIN_LEN，**且停下时目标在命中窗口内**
// 旧版只看「能走够 40」，而锁定范围 170 > 冲锋位移 136 ⇒ 158~170 的目标会被锁住、
// 冲过去却停在离它 20px 外，一次伤害都不结算（玩家看到的「差一格停下」）。
export function canCharge(run, z, tx, ty) {
  const sp = z.sp;
  const maxLen = (sp.dashSpeed || 200) * (sp.dashTime || 0.5);
  const ang = Math.atan2(ty - z.y, tx - z.x);
  const reach = laneLen(run, z.x, z.y, ang, maxLen);
  if (reach < CHARGE_MIN_LEN) return false;
  const d = Math.hypot(tx - z.x, ty - z.y);
  return reach >= d - CHARGE_HIT_WINDOW;
}

// 暴君践踏的地面预警圈（蓄力期）。art.js 用它画「先看见，再被震」的提示。
export function stompRing(run, z) {
  const sp = z && z.sp;
  if (!sp || sp.ability !== 'stomp' || z.spPhase !== 'stomp') return null;
  const windup = sp.windup || 0.7;
  return {
    x: z.x, y: z.y,
    r: sp.radius || 96,
    t: Math.min(1, Math.max(0, 1 - (z.spT || 0) / windup)),
  };
}

// 返回 true 表示该僵尸本帧已被特感行为占用，不再走普通移动
// 尖啸：给半径内的僵尸打时间戳（多只取 max，天然不叠加）
function screamPulse(run, z, cfg, strong) {
  const R = cfg.radius || 240;
  const dur = cfg.dur || 3.2;
  const sMul = cfg.speedMul || 1;
  const rMul = cfg.rateMul || 1;
  const until = run.time + dur;
  for (const t of run.zombies) {
    if (t === z || t.hp <= 0) continue;
    if (Math.hypot(t.x - z.x, t.y - z.y) > R) continue;
    if (!(t.screamUntil > until)) {
      t.screamUntil = until;
      t.screamS = sMul;
      t.screamR = rMul;
    }
  }
  z.screamFx = 1;              // 声波环的扩散进度（art.js 用）
  z.screamFxR = R;
  z.screamStrong = !!strong;
  run.effects.push({ x: z.x, y: z.y, life: 0.6, max: 0.6, size: R * 2, ring: true, scream: true, strong: !!strong });
  emit(run, { t: 'scream', x: z.x, y: z.y, r: R, strong: !!strong });
}

// 尖叫者与我方最近资产（单位 / 工事 / 核心）的距离；都没有时就是到核心的距离
function nearestAssetDist(run, z) {
  const T = run.map.tile;
  let nd = Infinity;
  for (const u of run.units) {
    if (u.hp <= 0) continue;
    const d = Math.hypot(u.x - z.x, u.y - z.y);
    if (d < nd) nd = d;
  }
  for (const f of run.forts) {
    if (f.hp <= 0) continue;
    const d = Math.hypot(f.x - z.x, f.y - z.y);
    if (d < nd) nd = d;
  }
  const dc = Math.hypot((run.core.x + 0.5) * T - z.x, (run.core.y + 0.5) * T - z.y);
  if (dc < nd) nd = dc;
  return nd;
}

function updateSpecial(run, z, dt) {
  const sp = z.sp;
  if (!sp || !sp.ability || sp.ability === 'none') return false;
  const T = run.map.tile, W = run.map.w, H = run.map.h;
  if (z.leapLock > 0) { z.leapLock -= dt; return true; }   // 猎手落地僵直：不能移动
  if (z.spCd > 0) z.spCd -= dt;

  // ---- 尖叫者：行进（弱尖啸）↔ 架设（强尖啸）两态，168 停 / 192 收（迟滞防抖）----
  if (sp.ability === 'scream') {
    const parkR = sp.parkRange || 168;
    const backR = sp.resumeRange || (parkR + 24);
    const nd = nearestAssetDist(run, z);
    // 展开：原地停 0.8s（最脆的窗口，且这期间不 buff）
    if (z.spPhase === 'settle') {
      z.spT -= dt; z.moving = false; z.path = null;
      if (nd > backR) { z.spPhase = null; z.spT = 0; }
      else if (z.spT <= 0) { z.spPhase = 'park'; z.spCd = 1.0; }
      return true;
    }
    // 站桩：不后退、不移动、不被推挤
    if (z.spPhase === 'park') {
      z.moving = false; z.path = null;
      if (nd > backR) { z.spPhase = null; z.spT = 0; return false; }   // 玩家退了：收架追上
      if (z.spCd <= 0) { screamPulse(run, z, sp, true); z.spCd = sp.cd || 5.5; }
      return true;
    }
    // 行进：进入 168 就展开；路上只发弱化尖啸
    if (nd <= parkR) { z.spPhase = 'settle'; z.spT = sp.parkTime || 0.8; z.moving = false; z.path = null; return true; }
    if (z.spCd <= 0) {
      const mv = sp.move || {};
      screamPulse(run, z, mv, false);
      z.spCd = mv.cd || 6.5;
    }
    return false;   // 交回常规 march：朝核心推进
  }

  // ---- 冲锋者：蓄力 → 直线冲锋 → 撞工事（不被人牵引）----
  if (sp.ability === 'charge') {
    if (z.spPhase === 'dash') {
      z.spT -= dt;
      const budget = typeof z.dashLen === 'number' ? z.dashLen : Infinity;
      const used = z.dashRun || 0;
      const step = Math.min(sp.dashSpeed * dt, Math.max(0, budget - used));
      if (step <= 0) { z.spPhase = null; z.spCd = sp.cd; return true; }
      z.dashRun = used + step;
      const nx = z.x + Math.cos(z.dashA) * step, ny = z.y + Math.sin(z.dashA) * step;
      const tx = Math.floor(nx / T), ty = Math.floor(ny / T);
      const walk = tx >= 0 && ty >= 0 && tx < W && ty < H && TERRAIN[run.map.tiles[ty * W + tx]].walkable;
      // A：工事格不可穿越。以前只判地形，冲锋会直接从炮塔那格滑过去，看起来像把炮塔顶开了。
      const fortHere = (tx >= 0 && ty >= 0 && tx < W && ty < H) ? run._fortTile.get(ty * W + tx) : null;
      if (walk && !fortHere) { z.x = nx; z.y = ny; } else { z.spPhase = null; z.spCd = sp.cd; }
      // 攻城：优先撞工事（刚被格挡的那座优先，否则按距离兜底）
      const hitF = (fortHere && fortHere.hp > 0) ? fortHere : fortNear(run, z, 12 + 8);
      if (hitF) {
        damageFort(run, hitF, sp.dmg * (sp.vsFort || 2), z.pen);
        run.effects.push({ x: hitF.x, y: hitF.y, life: 0.34, max: 0.34, size: 32, ring: true });
        emit(run, { t: 'boom', x: hitF.x, y: hitF.y, r: 26 });
        z.spPhase = null; z.spCd = sp.cd;
        return true;
      }
      // 撞人：范围内全部结算（一次冲撞撞倒一小片），并击退
      let hitAny = false;
      for (const u of hostileTargets(run)) {
        if (u.hp <= 0) continue;
        if (Math.hypot(u.x - z.x, u.y - z.y) > 14 + UNITS[u.kind].r) continue;
        hurtUnit(run, u, sp.dmg * (sp.unitMul || 0.4), sp.stun, z.pen, z.mob);
        // C：进驻建筑、架设中（depOn）、正在架设/收起（depDir）都不吃击退
        // C：进驻建筑、架设中（depOn）、正在架设/收起（depDir）、以及炮台/迫击炮/燃烧塔
        //    （mobile === false，本质是不可移动单位）都不吃击退
        if (sp.knockback && u.hp > 0 && !u.inside && !u.depOn && !u.depDir
          && UNITS[u.kind] && UNITS[u.kind].mobile !== false) {
          // 击退按护甲分档：无甲撞飞 2 格、轻甲（装甲车）只推 1 格、重甲（坦克/火炮）退 8px + 减速
          const uArmor = UNITS[u.kind].armor;
          const heavy = uArmor === 'heavy';
          const kb = heavy ? (sp.knockbackHeavy != null ? sp.knockbackHeavy : 8)
            : uArmor === 'light' ? (sp.knockbackLight != null ? sp.knockbackLight : 24)
              : sp.knockback;
          // B：沿滑行方向按 1/4 格步进，碰到工事格或地图边界就停在最后一格合法位置
          const dirx = Math.cos(z.dashA), diry = Math.sin(z.dashA);
          const seg = T * 0.25;
          let ox = u.x, oy = u.y, moved = 0;
          while (moved < kb) {
            const stepK = Math.min(seg, kb - moved);
            const nx2 = ox + dirx * stepK, ny2 = oy + diry * stepK;
            const tx2 = Math.floor(nx2 / T), ty2 = Math.floor(ny2 / T);
            const canWalk = tx2 >= 0 && ty2 >= 0 && tx2 < W && ty2 < H
              && TERRAIN[run.map.tiles[ty2 * W + tx2]].walkable
              && !run._fortTile.get(ty2 * W + tx2);
            if (!canWalk) break;
            ox = nx2; oy = ny2; moved += stepK;
          }
          if (moved > 1) {
            knockUnit(run, u, ox, oy, 0.12);
            if (heavy) applyUnitSlow(run, u, sp.slowHeavyMul || 0.55, sp.slowHeavyDur || 1.2);
          }
        }
        run.effects.push({ x: u.x, y: u.y, life: 0.32, max: 0.32, size: 28, ring: true });
        emit(run, { t: 'boom', x: u.x, y: u.y, r: 24 });
        hitAny = true;
      }
      if (hitAny) { z.spPhase = null; z.spCd = sp.cd; }
      if (z.spT <= 0) { z.spPhase = null; z.spCd = sp.cd; }
      return true;
    }
    if (z.spPhase === 'windup') {
      z.spT -= dt;
      if (z.spT <= 0) {
        // 蓄力这 0.55s 里目标一直在走：转 dash 前按它**当前**位置校正朝向。
        // 方向一旦停在蓄力开始时，1.15s 的总时长足够步兵走出 60px，冲过去必然擦肩。
        const tu = z.dashTid ? hostileTargets(run).find((u) => u.id === z.dashTid && u.hp > 0 && !u.inside) : null;
        const tf = !tu && z.dashFid ? run.forts.find((f) => f.id === z.dashFid && f.hp > 0) : null;
        if (tu) z.dashA = Math.atan2(tu.y - z.y, tu.x - z.x);
        else if (tf) z.dashA = Math.atan2(tf.y - z.y, tf.x - z.x);
        // 冲锋预算 = 蓄力时那条地面危险带的长度（判定与警示严格对齐）
        const lane = chargeLane(run, z);
        z.dashRun = 0;
        // 蓄力期间地形没变，但兜底一次：可冲距离太短就直接放弃（短冷却），
        // 避免出现「蓄力完了原地不动、也不结算伤害」的空冲。
        if (!lane || lane.len < CHARGE_MIN_LEN) {
          z.spPhase = null;
          z.spCd = Math.min(sp.cd || 5, 1.2);
          return true;
        }
        z.dashLen = lane.len;
        z.spPhase = 'dash'; z.spT = sp.dashTime;
      }
      return true;
    }
    if (z.spCd <= 0) {
      // 目标优先级：工事（拆迁本行）> 楼外的步兵/载具（楼内单位看不见）
      // 注意只锁最近的单目标，不锁人群重心 —— 否则玩家无法用落单单位把它引偏
      let tx = null, ty = null, nd = 1e9;
      let pickedU = null, pickedF = null;
      const f = fortNear(run, z, sp.range);
      if (f && hasLOS(run, z.x, z.y, f.x, f.y) && canCharge(run, z, f.x, f.y)) { tx = f.x; ty = f.y; pickedF = f; }
      if (tx === null) {
        for (const u of hostileTargets(run)) {
          // 楼内单位看不见（叛军无 inside 字段，恒 false）
          if (u.hp <= 0 || u.inside) continue;
          const d = Math.hypot(u.x - z.x, u.y - z.y);
          if (d > sp.range || d >= nd) continue;
          if (!hasLOS(run, z.x, z.y, u.x, u.y)) continue;
          // 隔着水/墙的目标冲不到，跳过它去找真正能冲的那个
          if (!canCharge(run, z, u.x, u.y)) continue;
          nd = d; tx = u.x; ty = u.y; pickedU = u;
        }
      }
      if (tx !== null) {
        z.spPhase = 'windup'; z.spT = sp.windup;
        z.dashA = Math.atan2(ty - z.y, tx - z.x);
        // 记住锁的是谁：蓄力结束时按它的新位置校正方向
        z.dashTid = pickedU ? pickedU.id : 0;
        z.dashFid = pickedF ? pickedF.id : 0;
        return true;
      }
    }
    return false;
  }

  // ---- 暴君：践踏（范围减速；只踩楼外，楼内单位不受地面震动影响）----
  if (sp.ability === 'stomp') {
    if (z.spPhase === 'stomp') {
      z.spT -= dt;
      if (z.spT <= 0) {
        const R = sp.radius || 96;
        let hit = 0;
        for (const u of hostileTargets(run)) {
          if (u.hp <= 0 || u.inside) continue;
          if (Math.hypot(u.x - z.x, u.y - z.y) > R + UNITS[u.kind].r * 0.5) continue;
          applyUnitSlow(run, u, sp.slowMul || 0.45, sp.slowDur || 2.5);
          if (sp.stun) u.stun = Math.max(u.stun || 0, sp.stun);
          if (sp.dmg) hurtUnit(run, u, sp.dmg, 0, 0, z);   // 象征性伤害：吃护甲与暴君穿透
          hit++;
        }
        run.effects.push({ x: z.x, y: z.y, life: 0.42, max: 0.42, size: R * 2, ring: true });
        emit(run, { t: 'boom', x: z.x, y: z.y, r: R * 0.8 });
        z.spPhase = null; z.spCd = sp.cd;
        return true;
      }
      // 蓄力期间站定不动，给玩家撤离窗口
      z.moving = false; z.path = null;
      return true;
    }
    if (z.spCd <= 0) {
      const R = sp.radius || 96;
      let n = 0;
      for (const u of hostileTargets(run)) {
        if (u.hp <= 0) continue;
        if (Math.hypot(u.x - z.x, u.y - z.y) <= R + UNITS[u.kind].r * 0.5) n++;
      }
      if (n >= (sp.minTargets || 1)) { z.spPhase = 'stomp'; z.spT = sp.windup || 0.7; return true; }
    }
    return false;
  }

  // ---- 猎手：飞扑 ----
  if (sp.ability === 'pounce') {
    if (z.leap) { stepLeap(run, z, dt); return true; }
    if (z.spCd <= 0) {
      const u = hunterTarget(run, z, sp);
      if (u) { z.leap = { x1: z.x, y1: z.y, x2: u.x, y2: u.y, t: 0, dur: sp.leap }; return true; }
    }
    return false;
  }

  // ---- 吐酸者：远程酸液 ----
  if (sp.ability === 'spit') {
    if (z.spPhase === 'spit') {
      z.spT -= dt;
      if (z.spT <= 0) {
        const x2 = z.spX, y2 = z.spY;
        // 抛物线：飞行时间随距离增长，落地那一帧才结算伤害并出特效
        const flight = Math.max(0.18, (sp.flightBase || 0.28) + Math.hypot(x2 - z.x, y2 - z.y) / (sp.flightPer || 900));
        run.pending.push({
          kind: 'acid', x: x2, y: y2, r: sp.radius, dmg: sp.dmg, pen: z.pen || 0,
          t: flight, acid: sp.acid || null,
        });
        run.effects.push({ proj: 'acid', x1: z.x, y1: z.y, x2, y2, life: flight, max: flight, arc: 26 });
        z.spPhase = null; z.spCd = sp.cd;
      }
      return true;
    }
    if (z.spCd <= 0) {
      const u = enemyNear(run, z, sp.range);
      if (u && hasLOS(run, z.x, z.y, u.x, u.y)) { z.spPhase = 'spit'; z.spT = sp.warn; z.spX = u.x; z.spY = u.y; return true; }
    }
    return false;
  }

  // ---- 烟雾者：舌头拉拽（只拉步兵类可移动单位）----
  if (sp.ability === 'smoke') {
    if (z.spPhase === 'pull') {
      const u = run._um ? run._um.get(z.pullId) : null;
      const ok = u && u.hp > 0 && UNITS[u.kind] && UNITS[u.kind].type !== '载具' && run.time - z.spT0 < sp.maxT
        && Math.hypot(u.x - z.x, u.y - z.y) < sp.range * 1.5;
      if (!ok) { z.spPhase = null; z.spCd = sp.cd; return false; }
      const ang = Math.atan2(z.y - u.y, z.x - u.x);
      u.x += Math.cos(ang) * sp.pullSpeed * dt;
      u.y += Math.sin(ang) * sp.pullSpeed * dt;
      hurtUnit(run, u, sp.dps * dt, 0, z.pen, z, true);   // 拖拽伤害也吃护甲/减伤/无敌
      u.stun = Math.max(u.stun || 0, 0.12);
      if (run.effects.length < 200) run.effects.push({ tongue: true, x1: z.x, y1: z.y, x2: u.x, y2: u.y, life: 0.06, max: 0.06 });
      return true;
    }
    if (z.spCd <= 0) {
      // 只拉步兵类（载具太重，拉不动）；据点/兵营/工厂里的人免疫
      const u = smokerPick(run, z, sp);
      if (!u) {
        // 拖不动（目标都在架设/室内）：改缠绕架设住的机枪组，削射速
        const su = smokerSuppressPick(run, z, sp);
        return su ? applySuppress(run, z, sp, su) : false;
      }
      if (u.inside) {
        // 普通楼里的人：先和楼解除绑定，落到朝向烟雾者的楼外沿，之后按常规拉拽
        const T2 = run.map.tile;
        const aim = buildingAim(u.inside, z.x, z.y) || { x: u.x, y: u.y };
        u.inside = null; u.enter = null; u.garrWant = null;
        const ang = Math.atan2(z.y - aim.y, z.x - aim.x) || 0;
        let nx = aim.x + Math.cos(ang) * 12, ny = aim.y + Math.sin(ang) * 12;
        if (!canOccupyPos(run, u, nx, ny)) { nx = aim.x; ny = aim.y; }
        if (!canOccupyPos(run, u, nx, ny)) { nx = u.x; ny = u.y; }
        u.x = nx; u.y = ny;
        u.tx = Math.floor(nx / T2); u.ty = Math.floor(ny / T2);
        u.path = null; u.order = null; u.moving = false;
        if (run.effects.length < 200) run.effects.push({ tongue: true, x1: z.x, y1: z.y, x2: u.x, y2: u.y, life: 0.12, max: 0.12 });
      }
      z.spPhase = 'pull'; z.pullId = u.id; z.spT0 = run.time; return true;
    }
    return false;
  }
  return false;
}

// ---------------- 仇恨值 ----------------
// 目标与当前点之间是否被建筑挡住（每 10px 采样一次，足够用）
function hasLOS(run, x1, y1, x2, y2) {
  const T = run.map.tile, W = run.map.w, H = run.map.h;
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 10));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const tx = Math.floor((x1 + dx * t) / T), ty = Math.floor((y1 + dy * t) / T);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    const tile = run.map.tiles[ty * W + tx];
    if (!TERRAIN[tile].walkable) return false;   // 建筑/水面都算遮挡
  }
  return true;
}

// 行为系数：移动中 > 正在打它（fireWindow 内开过火） > 静止
function aggroWeight(u) {
  const w = RULE.aggro.weight;
  if (u.moving) return w.moving;
  if ((u.recentShot || 0) > 0) return w.shot;
  return w.idle;
}

// 兵种系数：空地步兵 > 楼内步兵 / 载具 > 炮台（炮台最低但不为 0，否则永不被拆）
function aggroKindMul(u) {
  const K = RULE.aggro.kind;
  const def = UNITS[u.kind] || {};
  if (def.mobile === false) return K.tower;
  if (u.inside) return K.inside;
  if (def.type === '载具') return K.vehicle;
  return K.ground;
}

// 为单只僵尸重选目标：行为 × 兵种 × 距离，带锁定惯性 + 换目标滞回
// 楼内目标：用「最近的实体格中心」做距离/视线判定（人躲在墙后，但楼是看得见的）
function buildingAim(b, px, py) {
  const T = 24;
  let best = null, bd = Infinity;
  for (const [cx, cy] of buildingCells(b)) {
    const x = (b.x + cx + 0.5) * T, y = (b.y + cy + 0.5) * T;
    const d = Math.hypot(x - px, y - py);
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best;
}

// 目标网格：按 tile 分桶，把「僵尸找最近单位」从全表扫描降为邻域查询。
// 只在 stepRun 每帧重建一次（O(n)），查询侧只遍历半径内的桶。
export function buildTargetGrid(run) {
  const T = run.map.tile;
  const gu = new Map();
  const gr = new Map();
  const push = (m, x, y, o) => {
    const k = ((x / T) | 0) + ',' + ((y / T) | 0);
    const arr = m.get(k);
    if (arr) arr.push(o); else m.set(k, [o]);
  };
  for (const u of run.units) if (u.hp > 0) push(gu, u.x, u.y, u);
  for (const r of (run.raiders || [])) if (r.hp > 0) push(gr, r.x, r.y, r);
  run._gridU = gu;
  run._gridR = gr;
  run._gridT = T;
}

function gridNear(run, m, x, y, r) {
  if (!m) return null;
  const T = run._gridT || run.map.tile;
  const r2 = r * r;
  const x0 = ((x - r) / T) | 0, x1 = ((x + r) / T) | 0;
  const y0 = ((y - r) / T) | 0, y1 = ((y + r) / T) | 0;
  const out = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const arr = m.get(tx + ',' + ty);
      if (!arr) continue;
      for (const o of arr) {
        const dx = o.x - x, dy = o.y - y;
        if (dx * dx + dy * dy <= r2) out.push(o);
      }
    }
  }
  return out;
}

function pickAggroTarget(run, z) {
  if (z.mob === 'charger') return null;   // 攻城单位只盯工事/据点，不追人
  const A = RULE.aggro;
  const T = run.map.tile;
  const sight = A.sightTiles * T;
  const coreX0 = (run.core.x + 0.5) * T, coreY0 = (run.core.y + 0.5) * T;
  const dCore = Math.hypot(coreX0 - z.x, coreY0 - z.y);
  if (dCore < A.coreRush * T) return null;   // 就快到据点了，不再被单位牵引
  const a1 = Math.atan2(coreY0 - z.y, coreX0 - z.x);
  let best = null, bestScore = -1, cur = null, curScore = -1;
  for (const u of (gridNear(run, run._gridU, z.x, z.y, sight) || run.units)) {
    if (u.hp <= 0) continue;
    // 楼内单位：对“那栋楼的外沿”取距离与视线（人躲在墙后，但僵尸能看到楼）
    let ux = u.x, uy = u.y, uOff = null;
    const roomU = u.inside || roomUnder(run, u);
    if (roomU) {
      const aim = buildingAim(roomU, z.x, z.y);
      if (!aim) continue;
      // 视线只判到「楼墙面前一格」，否则最后一段必然被墙挡住
      const dd = Math.hypot(aim.x - z.x, aim.y - z.y) || 1;
      const back = Math.min(dd * 0.5, 24);
      ux = aim.x - (aim.x - z.x) / dd * back;
      uy = aim.y - (aim.y - z.y) / dd * back;
    }
    const d = Math.hypot(ux - z.x, uy - z.y);
    if (d > sight) continue;
    // 轻度模式：只追“移动中 / 正在开火”的单位
    if (run.aggro === 1 && !(u.moving || (u.recentShot || 0) > 0)) continue;
    if (!hasLOS(run, z.x, z.y, ux, uy)) continue;
    // 方向过滤：只追“挡在去据点路上”的单位（抢点队不受限，可被勾引）
    if (!z.raider && !z.roamer) {
      const a2 = Math.atan2(uy - z.y, ux - z.x);
      let da = Math.abs(a1 - a2) % (Math.PI * 2);
      if (da > Math.PI) da = Math.PI * 2 - da;
      if (da > A.cone) continue;
    }
    const distF = Math.max(0.05, 1 - d / sight);          // 近 > 远
    let score = aggroWeight(u) * aggroKindMul(u) * distF;
    if (z.raider) score = Math.max(score, 0.8 * distF);   // 抢点队见人就打
    if (z.atkId === u.id) {
      score *= 1 + A.stick;                               // 锁定惯性
      cur = u; curScore = score;
    }
    if (score > bestScore) { bestScore = score; best = u; }
  }
  // 换目标滞回：新目标必须比当前高 switchHyst 倍，否则继续追当前
  if (cur && best && best !== cur && bestScore < curScore * A.switchHyst) return cur;
  // 叛军：平时中档（与玩家单位同池竞争 + 视野 1.5x）；扑核心时轻档（只做兜底）
  const RA = (run.raiderPush ? A.raiderAggroPush : A.raiderAggro) || {};
  const rSight = sight * (RA.sightMul != null ? RA.sightMul : 1);
  const rWeight = RA.weight != null ? RA.weight : 0.8;
  let rb = null, rs = -1;
  for (const r of (gridNear(run, run._gridR, z.x, z.y, rSight) || (run.raiders || []))) {
    if (r.hp <= 0) continue;
    const d = Math.hypot(r.x - z.x, r.y - z.y);
    if (d > rSight) continue;
    if (!hasLOS(run, z.x, z.y, r.x, r.y)) continue;
    const sc = Math.max(0.05, 1 - d / rSight) * rWeight;
    if (sc > rs) { rs = sc; rb = r; }
  }
  if (!run.raiderPush && rb && (!best || rs > bestScore)) {
    if (cur && cur !== rb && rs < curScore * A.switchHyst) return cur;
    return rb;
  }
  if (best) return best;
  return rb;
}

// 放弃当前追逐：把 hunt / atk 的路径缓存一起清掉，
// 否则僵尸会沿着「追到底但人已经跑远」的旧 path 继续走（看起来就是先往回退）
function dropHunt(z) {
  z.hitBy = null;
  z.huntPath = null;
  z.huntAt = 0;
  z.atkId = 0;
  z.atkPath = null;
  z.atkTile = -1;
  z.atkIdx = 0;
  z.aggroOx = null;
  z.path = null;
  z.pathIdx = 0;
  z.pathEpoch = -1;
  if (z.mode === 'attack' && z.target && z.target.kind !== 'fort') z.target = null;
}

function updateAggro(run, z, dt) {
  const A = RULE.aggro;
  const T = run.map.tile;
  // 已锁定：目标没死、没超出 leash、仍在视线内 → 继续追
  if (z.atkId) {
    const uP = run.units.find((x) => x.id === z.atkId) || (run._um && run._um.get(z.atkId)) || null;
    const uR = uP ? null : ((run.raiders || []).find((r) => r.id === z.atkId) || null);
    const u = uP || uR;
    const RA = (run.raiderPush ? A.raiderAggroPush : A.raiderAggro) || {};
    const leashMul = uR ? (RA.leashMul || 1) : 1;
    const outOfLeash = z.aggroOx != null
      && Math.hypot(z.x - z.aggroOx, z.y - z.aggroOy) > A.leashTiles * leashMul * T;
    // 楼内标记偶尔会在帧首被清理（例如楼被移出索引），此时按脚下建筑兜底
    const room0 = uP ? (uP.inside || roomUnder(run, uP)) : null;
    let chkX = u ? u.x : z.x, chkY = u ? u.y : z.y;
    if (u && room0) {
      const aim0 = buildingAim(room0, z.x, z.y);
      if (aim0) {
        const dd0 = Math.hypot(aim0.x - z.x, aim0.y - z.y) || 1;
        const back0 = Math.min(dd0 * 0.5, 24);
        chkX = aim0.x - (aim0.x - z.x) / dd0 * back0;
        chkY = aim0.y - (aim0.y - z.y) / dd0 * back0;
      }
    }
    const d = u ? Math.hypot(chkX - z.x, chkY - z.y) : 0;
    const tooLong = z.aggroAt != null && run.time - z.aggroAt > A.maxChase * (uR ? (RA.chaseMul || 1) : 1);
    const rushCore = Math.hypot((run.core.x + 0.5) * T - z.x, (run.core.y + 0.5) * T - z.y) < A.coreRush * T;
    const losOk = hasLOS(run, z.x, z.y, chkX, chkY);
    if (!u || u.hp <= 0 || tooLong || rushCore || outOfLeash || d > A.sightTiles * T * 1.6 || !losOk) {
      dropHunt(z);
      const nu = pickAggroTarget(run, z);
      if (nu) {
        z.atkId = nu.id; z.aggroOx = z.x; z.aggroOy = z.y; z.aggroAt = run.time;
        z.atkPath = null; z.atkTile = -1; z.atkIdx = 0;
      }

    } else {
      // 追击中定期重评（独立计时器，避免与外层 aggroT 打架）；pick 内部带 1.2x 滞回
      // 注意：本函数每 reEval 才被外层调用一次，dt 累加永远到不了 reEval，故用时间戳
      if (run.time - (z.reAt || 0) >= A.reEval) {
        z.reAt = run.time;
        const nu = pickAggroTarget(run, z);
        if (nu && nu.id !== z.atkId) {
          z.atkId = nu.id;
          z.aggroOx = z.x; z.aggroOy = z.y; z.aggroAt = run.time;
          z.atkPath = null; z.atkTile = -1; z.atkIdx = 0;
        }
      }
      let ttx, tty;
      if (room0) {
        const sp = outsideSpot(run, room0, z.x, z.y);
        if (!sp) { z.atkId = 0; z.atkTile = -1; return; }
        ttx = sp.tx; tty = sp.ty;
      } else {
        ttx = Math.floor(u.x / T); tty = Math.floor(u.y / T);
      }
      const key = tty * run.map.w + ttx;
      if (key !== z.atkTile || !z.atkPath) {
        // 追击也必须把工事当障碍：以前这里传 true（忽略工事），僵尸会直接迈过路障
        const p = findPath(run, Math.floor(z.x / T), Math.floor(z.y / T), ttx, tty, false, false, false);
        z.atkPath = p && p.length ? p : null;
        z.atkIdx = z.atkPath && z.atkPath.length > 1 ? 1 : 0;
        z.atkTile = key;
        if (!z.atkPath) {
          // 追不到就放弃：路径一并清掉，回主路径时从当前位置重算（否则会倒着走回出生点）
          z.atkId = 0; z.atkTile = -1; z.atkPath = null; z.path = null; z.pathEpoch = -1;
          if (!canReachCore(run, Math.floor(z.x / T), Math.floor(z.y / T), true)) {
            const ob = pickObstacle(run, z);
            if (ob) { z.mode = 'attack'; z.target = ob; z.path = null; z.pathEpoch = -1; }
          }
        }
      }
      return;
    }
  }
  const u = pickAggroTarget(run, z);
  if (u) {
    z.atkId = u.id;
    z.aggroOx = z.x; z.aggroOy = z.y; z.aggroAt = run.time;
    z.atkPath = null; z.atkTile = -1;
    z.atkIdx = 0;
  }
}


// ---------------- 僵尸进楼（普通僵尸读条 / 猎手跳入） ----------------
// 建筑内僵尸上限 = min(cap * 2, 格数)，避免「4 格楼塞 12 只」把血量意义抹平
function zRoomCap(b) {
  const cap = garrisonCap(b) || 0;
  // 僵尸进屋上限 = min(容量×2, 格数)
  const cellsN = buildingCells(b).length || 1;
  return Math.max(1, Math.min(cap * ZOMBIE_GARRISON.zCapMul, cellsN));
}
export function unitsInRoom(run, b) {
  let n = 0;
  for (const u of run.units) if (u.hp > 0 && u.inside === b) n++;
  return n;
}
export function zombiesInRoom(run, b) {
  let n = 0;
  for (const z of run.zombies) {
    if (z.zInside === b) n++;
    else if (z.zEnter && z.zEnter.b === b) n++;
  }
  return n;
}
// 找身边一栋「可进入的城区建筑」（基地/兵营/工厂有 room，excluded）
function zRoomNear(run, z) {
  const T = run.map.tile;
  let best = null, bestD = Infinity;
  for (const b of run.map.buildings) {
    if (!b.garrison || b.room || b.hp <= 0 || !b.destructible) continue;
    const pad = T * 0.55;
    const inX = z.x > b.x * T - pad && z.x < (b.x + b.w) * T + pad;
    const inY = z.y > b.y * T - pad && z.y < (b.y + b.h) * T + pad;
    if (!inX || !inY) continue;
    // 同时够到两栋楼时取最近的那栋（原来返回第一栋，会往反方向折返）
    const d = Math.hypot(((b.x + b.w / 2) * T) - z.x, ((b.y + b.h / 2) * T) - z.y);
    if (d >= bestD) continue;
    bestD = d;
    // 楼满也要贴上去：满了就在楼外强行拆楼（不再后退绕路）
    best = { b, full: zombiesInRoom(run, b) >= zRoomCap(b) };
  }
  return best;
}

// 楼满时在楼外拆楼：每人 0.35× 结算，按 z.attackInterval 出手
function stepZombieBesiege(run, z, dt) {
  const b = z.zAttack;
  if (!b || b.hp <= 0 || !run.map.buildings.includes(b)) { z.zAttack = null; z.pathEpoch = -1; return; }
  z.eating = true; z.moving = false;
  z.attackCd -= dt;
  if (z.attackCd > 0) return;
  z.attackCd = zAttackInterval(z, run.time);
  const mul = (ZOMBIE_GARRISON.outsideDpsMul || 0.35);
  const dmg = z.dmg * (z.vsBuilding || 1) * mul;
  damageBuilding(run, b, dmg, z.pen || 0);
  run.effects.push({ x: z.x, y: z.y, life: 0.18, max: 0.18, size: 9 });
}
function zRoomAtPoint(run, x, y) {
  const T = run.map.tile;
  const tx = Math.floor(x / T), ty = Math.floor(y / T);
  for (const b of run.map.buildings) {
    if (!b.garrison || b.room || b.hp <= 0) continue;
    if (insideTile(run, b, tx, ty)) return b;
  }
  return null;
}
function zEnterRoom(run, z, b) {
  const T = run.map.tile;
  z.zEnter = null;
  z.zInside = b;
  z.zInsideAt = run.time;
  z.path = null; z.pathIdx = 0; z.pathEpoch = -1;
  z.mode = 'move'; z.target = null; z.eating = true;
  const spot = garrisonFreeSpot(run, b, z.x, z.y) || { tx: b.x, ty: b.y };
  z.x = (spot.tx + 0.5) * T;
  z.y = (spot.ty + 0.5) * T;
  emit(run, { t: 'zenter', x: z.x, y: z.y });
}
function zLeaveRoom(run, z, force) {
  const T = run.map.tile;
  const b = z.zInside;
  const spot = b ? (outsideSpot(run, b, z.x, z.y) || (force ? forcedOutSpot(run, b, z.x, z.y) : null)) : null;
  if (!spot) { z.garrCd = run.time + 25; z.leaveFailAt = z.leaveFailAt || run.time; return; }   // 外面被工事/人占满：先留在里面，别插进炮台格
  z.zInside = null;
  z.zAttack = null;
  z.inside = null;
  z.leaveFailAt = 0;
  z.x = (spot.tx + 0.5) * T; z.y = (spot.ty + 0.5) * T;
  z.path = null; z.pathIdx = 0; z.pathEpoch = -1;
  z.zInsideAt = 0;
  z.garrCd = run.time + 25;      // 出来之后 25s 内不再钻同一类房子，避免无限进出
}
// 楼内：先打楼里的人，没人就打楼（效率 insideBuildMul）
function stepZombieInside(run, z, dt) {
  const b = z.zInside;
  if (!b || b.hp <= 0 || !run.map.buildings.includes(b) || run.time - (z.zInsideAt || 0) > 60) {
    // 楼已经塌了/不在了：必须出来，否则会永远卡在废墟里（force = 允许挤一格）
    zLeaveRoom(run, z, !b || b.hp <= 0 || !run.map.buildings.includes(b));
    return;
  }
  z.eating = true; z.moving = false;
  const T = run.map.tile;
  let target = null, best = Infinity;
  for (const u of run.units) {
    if (u.inside !== b || u.hp <= 0) continue;
    const d = Math.hypot(u.x - z.x, u.y - z.y);
    if (d < best) { best = d; target = u; }
  }
  if (!target) {
    // 楼里已经没有我方单位：不白啃楼，立刻撤出；门口被堵超过 5 秒就强行挤出去（否则会永远缩在楼里）
    const stuck = z.leaveFailAt && run.time - z.leaveFailAt > 5;
    zLeaveRoom(run, z, stuck);
    return;
  }
  z.attackCd -= dt;
  if (z.attackCd > 0) return;
  if (target) {
    z.attackCd = zAttackInterval(z, run.time);
    const dps = z.dmg * RULE.combat.unitDamageScale;
    hurtUnit(run, target, dps, 0, z.pen || 0, z.mob);
    z.dir = Math.atan2(target.y - z.y, target.x - z.x);
  }
}

function stepLeap(run, z, dt) {
  const sp = (ZOMBIES[z.mob] && ZOMBIES[z.mob].special) || null;
  if (!sp || !z.leap) { z.leap = null; return; }
  const l = z.leap;
  if (!(l.dur > 0)) l.dur = 0.5;      // 兜底：dur 缺失/为 0 时 k 会变 NaN，僵尸永远卡在起飞帧
  l.t += dt;
  const k = Math.min(1, l.t / l.dur);
  z.x = l.x1 + (l.x2 - l.x1) * k;
  z.y = l.y1 + (l.y2 - l.y1) * k;
  z.dir = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
  if (k >= 1) {
    for (const u of hostileTargets(run)) {
      if (u.hp <= 0) continue;
      if (Math.hypot(u.x - z.x, u.y - z.y) > sp.radius + UNITS[u.kind].r) continue;
      hurtUnit(run, u, sp.dmg, sp.stun, z.pen, z.mob);
    }
    run.effects.push({ x: z.x, y: z.y, life: 0.26, max: 0.26, size: 30, ring: true });
    z.leap = null; z.spCd = sp.cd; z.pathEpoch = -1;
    z.leapLock = sp.lockT || 1.2;   // 扑完原地僵直，给玩家反打窗口
    // 猎手：落点在楼内就直接进屋（不拆楼）；落点是基地/兵营/工厂则退回最近可走地面
    if (ZOMBIE_GARRISON.jumpInMobs.indexOf(z.mob) >= 0) {
      const rb = zRoomAtPoint(run, z.x, z.y);
      // 基地/兵营/工厂是僵尸禁区（房间对象带 room 标记），猎手落上去也只能退回地面
      if (rb && !rb.room && zombiesInRoom(run, rb) < zRoomCap(rb)) { zEnterRoom(run, z, rb); return; }
    }
  }
}

// 雷区：僵尸踏进触发半径就引爆（一次性，爆完即毁）
// blown 标记保证「不管被什么打碎都先炸一次」：以前判据是 f.hp <= 0，同帧被打碎就直接跳过，一次都不炸。
export function stepMines(run) {
  if (!run.forts.length) return;
  let dirty = false;
  for (const f of run.forts) {
    if (f.kind !== 'mine' || f.blown) continue;
    const cfg = FORTS.mine.trigger;
    // 雷区位置与世界坐标同单位（像素），与 f.x / z.x 直接比较
    const cx = f.x, cy = f.y;
    // 已被打碎（hp 归零）⇒ 当场引爆，不再等僵尸踩；否则等僵尸进触发半径
    let hit = f.hp <= 0;
    if (!hit) {
      for (const z of run.zombies) {
        if (z.hp <= 0) continue;
        if (Math.hypot(z.x - cx, z.y - cy) <= cfg.radius) { hit = true; break; }
      }
    }
    if (!hit) continue;
    const R = cfg.splash.radius, fk = cfg.splash.factor;
    for (const z of run.zombies) {
      if (z.hp <= 0) continue;
      const d = Math.hypot(z.x - cx, z.y - cy);
      if (d > R) continue;
      const k = falloffK(d, R, fk);
      // 破甲地雷：重甲僵尸（冲锋者 210 / 壮尸 280 / 暴君 1500）吃 vsHeavy 倍率，其余护甲不变
      const heavy = (ZOMBIES[z.mob] && ZOMBIES[z.mob].armor === 'heavy') ? (cfg.vsHeavy || 1) : 1;
      const mineDmg = cfg.dmg * k * heavy;
      z.hp -= mineDmg;
      addFloat(run, z.x, z.y, mineDmg, false);
      if (cfg.slow) applySlow(run, z, cfg.slow);
    }
    // 我方也会被波及（雷区不会被自己人踩响，但炸开时不分敌我）
    const um = cfg.unitMul != null ? cfg.unitMul : 0;
    if (um > 0) {
      for (const u of run.units) {
        if (u.hp <= 0 || u.inside) continue;
        const d = Math.hypot(u.x - cx, u.y - cy);
        if (d > R) continue;
        hurtUnit(run, u, cfg.dmg * um * falloffK(d, R, fk), 0, 0);
      }
    }
    run.effects.push({ x: cx, y: cy, life: 0.34, max: 0.34, size: R * 2, ring: true });
    emit(run, { t: 'boom', x: cx, y: cy, r: R });
    f.blown = true;
    f.hp = 0;
    dirty = true;
  }
  if (!dirty) return;
  run.forts = run.forts.filter((f) => f.hp > 0);
  rebuildForts(run);
  bumped(run);
}

export function updateZombie(run, z, dt) {
  // 灼烧：被火舌点着的僵尸每秒掉血（每 0.25s 结算一次，浮字再限流）
  if (z.burnUntil && run.time < z.burnUntil && z.hp > 0) {
    z.burnTick = (z.burnTick || 0) - dt;
    if (z.burnTick <= 0) {
      z.burnTick = 0.25;
      const bd = (z.burnDps || 4) * 0.25;
      z.hp -= bd;
      if (z.hp <= 0) creditFlameKill(run, z.burnBy, z);
      z.burnT = run.time;
      if (!z._fxBF || run.frame - z._fxBF > 60) {
        z._fxBF = run.frame;
        addFloat(run, z.x, z.y, Math.round(bd), false);
      }
    }
  }
  // 狂暴状态位（暴君血线跌破时）+ 一次性事件，供 UI / 特效使用
  const rgNow = zEnrageMul(z);
  if (rgNow.on !== !!z.enraged) {
    z.enraged = rgNow.on;
    if (rgNow.on) emit(run, { t: 'rage', x: z.x, y: z.y });
  }
  if (z.leap) {
    z.eating = false;
    // 兜底：飞扑时长超过 4 倍的额定时间仍未结算 → 判定卡死，直接落地结束
    if (z.leap.t > (z.leap.dur || 0.5) * 4) { z.leap = null; z.spCd = 1.0; z.leapLock = 0; z.pathEpoch = -1; }
    else { stepLeap(run, z, dt); return; }
  }
  if (z.leap && z.eating) z.eating = false;   // 飞扑途中路过的楼不该把它钉住
  // 自愈：僵尸不该持有「我方单位」字段 inside（历史误写会让它被索敌永久跳过 ⇒ 看起来无敌）
  if (z.inside) z.inside = null;
  if (!Number.isFinite(z.hp)) z.hp = (ZOMBIES[z.mob] && ZOMBIES[z.mob].hp) || 40;
  // 楼满：在楼外强行拆楼
  if (z.zAttack) { stepZombieBesiege(run, z, dt); return; }
  // 楼内僵尸：只打楼里的人 / 拆楼
  if (z.zInside) { stepZombieInside(run, z, dt); return; }
  // 读条进楼：站定 8s，期间对建筑 2.5/s
  if (z.zEnter) {
    const b = z.zEnter.b;
    if (!b || b.hp <= 0 || !run.map.buildings.includes(b)) { z.zEnter = null; }
    else {
      z.eating = true; z.moving = false; z.path = null;
      z.zEnter.t -= dt;
      if (ZOMBIE_GARRISON.enterDps > 0) damageBuilding(run, b, ZOMBIE_GARRISON.enterDps * dt, z.pen || 0);
      if (z.zEnter.t <= 0) zEnterRoom(run, z, b);
      return;
    }
  }
  let bitNow = false;
  {
    const dmgMul = run.aggro >= 2 ? RULE.aggro.fullDmgMul : 1;
    const dps = (z.dmg / zAttackInterval(z, run.time)) * RULE.combat.unitDamageScale * dmgMul;
    if (dps > 0) {
      for (let i = run.units.length - 1; i >= 0; i--) {
        const u = run.units[i];
        const ud = UNITS[u.kind];
        if (!ud) continue;           // kind 被外部清掉（拆除/回滚的中间帧）时别抛异常
        if (u.inside) continue;      // 楼内单位不吃僵尸近战
        const d = Math.hypot(u.x - z.x, u.y - z.y);
        const reach = z.size * 0.7 + ud.r + 2;
        if (d > reach) continue;
        if (u._bite >= 2) continue;   // 同一时刻最多两只僵尸能咬到同一个单位
        u._bite++;
        z.eating = true;
        bitNow = true;
        const vsVeh = z.mob === 'spitter' && ud.type === '载具' ? 2 : 1;
        // 走 hurtUnit（quiet：每帧伤害不弹数字），空投落地保护 / 医疗光环 / 战吼减伤 / 指挥官反伤
        // 才能在这条路径上生效；以前这里是裸的 u.hp -=，全部被绕过。
        hurtUnit(run, u, dps * dt * vsVeh, 0, z.pen, z, true);
        if (u.hp <= 0) {
          // 指挥官被咬死也要走「重伤」：这条路径是直接 splice 的，不拦就会凭空消失、永不复活
          if (ud.hero) { heroDown(run, u); continue; }
          maybeRise(run, u, z.mob);   // 被咬死：按概率延迟起身
          run.units.splice(i, 1);
          const bb = ud.boom;
          if (bb && !u._noBoom) scheduleBoom(run, bb, u.x, u.y);
          run.stats.unitLost = (run.stats.unitLost || 0) + 1;
          run.effects.push({ x: u.x, y: u.y, life: 0.3, max: 0.3, size: 16 });
          emit(run, { t: 'ukill', x: u.x, y: u.y, kind: u.kind });
        }
      }
      // 叛军也吃僵尸近战（僵尸会打叛军，用户拍板第 5 条）
      for (const r of (run.raiders || [])) {
        if (r.hp <= 0) continue;
        const drz = Math.hypot(r.x - z.x, r.y - z.y);
        const reachR = z.size * 0.7 + (r.size || 7) + 2;
        if (drz > reachR) continue;
        z.eating = true;
        bitNow = true;
        r.hp -= dps * dt * mobHitMul(z.mob, z.pen, r.armor);
        r.flash = 0.1;
        if (r.hp <= 0 && !r._riseSrc) r._riseSrc = z.mob;   // 死于僵尸之手才可能转行尸
      }
    }
  }

  // 嘴里有肉就站定吃完这一口：不再沿旧路径挪动（否则看起来像「边咬边后退」）
  if (bitNow) { z.path = null; z.huntPath = null; return; }

  // 仇恨：4 秒内优先扑向打它的单位；被工事挡住就先拆工事
  // 注意：只做「定目标」，不要在这里 return —— 否则被射击的僵尸会原地僵住、也不咬身边单位
  if (z.hitBy) {
    if (run.time - z.hitBy.t > 4) { dropHunt(z); z.aggroT = 0; }
    else {
      const tu = run.units.find((u) => u.id === z.hitBy.id) || (run._um && run._um.get(z.hitBy.id));
      if (!tu || tu.hp <= 0) dropHunt(z);
      else {
        const T0 = run.map.tile;
        const d = Math.hypot(tu.x - z.x, tu.y - z.y);
        if (d >= T0 * 14) {
          // 勾引单位跑远了：不再沿旧路径倒着走，清干净后当帧换目标
          dropHunt(z);
          z.aggroT = 0;
          const nu = pickAggroTarget(run, z);
          if (nu) {
            z.atkId = nu.id; z.aggroOx = z.x; z.aggroOy = z.y; z.aggroAt = run.time;
            z.atkPath = null; z.atkTile = -1; z.atkIdx = 0;
          }
        }
        if (d < T0 * 14) {
          // 重算路径节流：0.45 秒一次，避免每帧重寻路 + 每帧把 pathIdx 打回 1 导致原地抖动
          const needPath = !z.huntPath || run.time >= (z.huntAt || 0);
          if (needPath) {
            z.huntAt = run.time + 0.45;
            const tx = Math.floor(tu.x / T0), ty = Math.floor(tu.y / T0);
            const p = findPath(run, Math.floor(z.x / T0), Math.floor(z.y / T0), tx, ty, false);
            if (p && p.length > 1) {
              z.mode = 'move';
              z.path = p; z.pathIdx = 1; z.pathEpoch = run.epoch;
              z.target = null;
              z.huntPath = p;
            } else {
              // 被工事挡住且绕不过去：只有在「整条路都堵死」时才拆墙，
              // 否则放弃这次仇恨、照常绕行（绝不能直接迈过路障）
              z.huntPath = null;
              if (!canReachCore(run, Math.floor(z.x / T0), Math.floor(z.y / T0), true)) {
                const ob = pickObstacle(run, z);
                if (ob) { z.mode = 'attack'; z.target = ob; z.path = null; z.pathEpoch = -1; }
              }
              dropHunt(z);
            }
          }
        }
      }
    }
  }

  const T = run.map.tile, W = run.map.w;
  const coreX = (run.core.x + 0.5) * T, coreY = (run.core.y + 0.5) * T;
  const dCore = Math.hypot(coreX - z.x, coreY - z.y);
  if (!z.roamer && dCore < T * 1.45) {   // 抢点/主攻：站到据点边上就开妑（之前 1.05 会挤在外圈不咬）
    z.eating = true;
    if (!run.godMode) run.core.hp = Math.max(0, run.core.hp - RULE.core.contactDmg * (RULE.combat.zombieDmgMul || 1) * dt);
    return;
  }
  z.attackCd -= dt;
  if (z.nudgeCd > 0) z.nudgeCd -= dt;
  z.eating = false;
  // 普通僵尸只在「楼里有我方单位」时才贴楼读条；空楼不碰（挡路的楼走 pickObstacle 那条线拆）
  if (!z.raider && ZOMBIE_GARRISON.canEnter.indexOf(z.mob) >= 0 && !z.leap && run.time >= (z.garrCd || 0)) {
    const near = zRoomNear(run, z);
    const room = near && near.b;
    if (room && unitsInRoom(run, room) > 0) {
      z.path = null; z.pathEpoch = -1; z.mode = 'move'; z.target = null;
      z.eating = true;
      // 楼满：在楼外强行拆楼（每人 0.35×），不再空读条/后退
      if (near.full) { z.zAttack = room; z.zEnter = null; return; }
      z.zAttack = null;
      z.zEnter = { b: room, t: ZOMBIE_GARRISON.enterT, total: ZOMBIE_GARRISON.enterT };
      return;
    }
  }
  // 入驻可进入建筑（先到先得：里面有玩家单位就不进）
  if (run.aggro > 0 || z.raider) {
    z.aggroT = (z.aggroT || 0) - dt;
    if (z.aggroT <= 0) { z.aggroT = RULE.aggro.reEval; updateAggro(run, z, dt); }
  }

  if (z.mode === 'attack' && z.target) {
    // 如果其实还有路（工事拦不住），就别拆了——放弃目标、回去走路
    if (z.target.kind === 'fort' && canReachCore(run, Math.floor(z.x / T), Math.floor(z.y / T), true)) {
      z.mode = 'move'; z.target = null; z.path = null; z.pathEpoch = -1; z.eating = false;
      z.nudgeCd = 0.3;
    }
  }
  if (z.mode === 'attack' && z.target) {
    const ref = z.target.ref;
    if (!ref || ref.hp <= 0 || (z.target.kind === 'fort' && ref.hp <= 0)) {
      z.mode = 'move'; z.target = null; z.path = null; z.pathEpoch = -1;
    } else {
      const c = targetCenter(z.target, T);
      // 工事的 x/y 已经是像素坐标（不是格坐标），按点距离算；建筑用矩形距离
      const dist = z.target.kind === 'fort'
        ? Math.hypot(c.x - z.x, c.y - z.y)
        : rectDist(z.x, z.y, z.target.ref.x, z.target.ref.y, z.target.ref.w, z.target.ref.h, T);
      if (dist <= T * 0.34) {
        // 已经在贴脸位置：停下来砸
        z.eating = true;
        z.path = null;
        if (z.attackCd <= 0) {
          z.attackCd = zAttackInterval(z, run.time);
          const dmg = z.dmg * (z.target.kind === 'building' ? z.vsBuilding : 1);
          if (z.target.kind === 'fort') damageFort(run, ref, dmg, z.pen);
          else damageBuilding(run, ref, dmg, z.pen);
        }
        return;
      }
      // 还没到：直接朝目标挤过去（目标就在身边，顺手把旧路径作废，别让残path把它顶回去）
      z.path = null; z.pathEpoch = -1;
      const dx = c.x - z.x, dy = c.y - z.y;
      const d = Math.hypot(dx, dy) || 1;
      const stepLen = z.speed * zEnrageMul(z).speed * zScreamMul(z, run.time).speed * slowFactor(run, z) * (run.phase === PHASE.PREP ? (RULE.prep.zombieSpeed || 1) : 1) * dt;
      z.dir = Math.atan2(dy, dx);
      z.x += (dx / d) * stepLen;
      z.y += (dy / d) * stepLen;
      return;
    }
  }

  // 眩晕（β 只定身）：走到这里说明"咬单位 / 撞据点 / 砸工事"都已处理完，
  // 只剩移动与特感冲锋 —— 这两类动作被冻住，但已经贴上来的照样咬。
  if (z.stunUntil && run.time < z.stunUntil) {
    z.moving = false;
    z.path = null; z.pathIdx = 0; z.pathEpoch = -1;
    return;
  }

  if (z.sp && updateSpecial(run, z, dt)) return;

  const zTile = run.map.tiles[Math.floor(z.y / T) * W + Math.floor(z.x / T)];
  const spd = z.speed * zEnrageMul(z).speed * zScreamMul(z, run.time).speed * (TERRAIN[zTile].zSpeed || 1) * slowFactor(run, z) * (run.phase === PHASE.PREP ? (RULE.prep.zombieSpeed || 1) : 1) * dt;
  // 游荡者：巡逻区状态机（到点停一下、超 leash 就回巢、永不把据点当目标）
  if (z.roamer && z.home && !z.zInside && !z.leap) {
    const cfgR = RULE.roam || {};
    const homeX = (z.home.x + 0.5) * T, homeY = (z.home.y + 0.5) * T;
    const homeD = Math.hypot(z.x - homeX, z.y - homeY);
    const leashR = ((z.patrolR || cfgR.patrolR || 7) + (cfgR.leash || 6)) * T;
    if (z.atkId && homeD > leashR) { dropHunt(z); z.wp = null; }
    if (!z.atkId) {
      if (z.idleT > 0) {
        // 站着停顿也要扫人：否则停住的游荡者永远发现不了路过的单位
        z.idleT -= dt;
        if (run.aggro > 0 || z.raider) {
          z.aggroT = (z.aggroT || 0) - dt;
          if (z.aggroT <= 0) { z.aggroT = RULE.aggro.reEval; updateAggro(run, z, dt); }
        }
        if (!z.atkId) return;
      }
      if (!z.wp && homeD < T * 0.9) {
        const iMin = cfgR.idleMin != null ? cfgR.idleMin : 1.0;
        const iMax = cfgR.idleMax != null ? cfgR.idleMax : 2.5;
        z.idleT = iMin + run.roamRng.next() * Math.max(0, iMax - iMin);
        z.path = null; z.pathIdx = 0; z.pathEpoch = run.epoch;
        return;
      }
      if (!z.wp) nextRoamPoint(run, z);
    }
  }

  // 追击中：沿追击路径走（仍然绕开建筑）
  if (z.atkId && z.atkPath && z.atkIdx < z.atkPath.length) {
    const node = z.atkPath[z.atkIdx];
    const tx3 = (node % W + 0.5) * T + (z.ox || 0);
    const ty3 = (((node / W) | 0) + 0.5) * T + (z.oy || 0);
    const dx = tx3 - z.x, dy = ty3 - z.y, d = Math.hypot(dx, dy) || 1;
    z.dir = Math.atan2(dy, dx);
    if (d <= spd) { z.x = tx3; z.y = ty3; z.atkIdx++; }
    else { z.x += (dx / d) * spd; z.y += (dy / d) * spd; }
    return;
  }
  if (z.path && z.pathIdx < z.path.length) {
    const node = z.path[z.pathIdx];
    const tx2 = (node % W + 0.5) * T + (z.ox || 0);
    const ty2 = (((node / W) | 0) + 0.5) * T + (z.oy || 0);
    const dx = tx2 - z.x, dy = ty2 - z.y, d = Math.hypot(dx, dy) || 1;
    z.dir = Math.atan2(dy, dx);
    if (d <= spd) { z.x = tx2; z.y = ty2; z.pathIdx++; }
    else { z.x += (dx / d) * spd; z.y += (dy / d) * spd; }
  } else if (z.path && z.pathIdx >= z.path.length) {
    // 路径走到头但没到达目标（通常是最后一格被建筑/工事占了）：
    // 不能就这么站着——下一帧重算路径，算不通就自动去砸挡路的东西
    z.path = null; z.pathIdx = 0; z.pathEpoch = -1;
    if (z.roamer && z.wp) {
      const cfgR2 = RULE.roam || {};
      const iMin = cfgR2.idleMin != null ? cfgR2.idleMin : 1.0;
      const iMax = cfgR2.idleMax != null ? cfgR2.idleMax : 2.5;
      z.wp = null;
      z.idleT = iMin + run.roamRng.next() * Math.max(0, iMax - iMin);
    }
    if (!tryBump(run, z)) {
      const d = Math.hypot(coreX - z.x, coreY - z.y);
      if (!z.roamer && d < T * 1.6 && !run.godMode) run.core.hp = Math.max(0, run.core.hp - RULE.core.contactDmg * dt);
    }
  } else {
    // 没有路径：绝不直穿地形（普通僵尸不会游泳，也不会穿楼）。
    // 贴着障碍就开砸，否则原地等 epoch 重算，避免卡进水里。
    if (!tryBump(run, z)) {
      const d = Math.hypot(coreX - z.x, coreY - z.y);
      if (!z.roamer && d < T * 1.6 && !run.godMode) run.core.hp = Math.max(0, run.core.hp - RULE.core.contactDmg * dt);
    }
  }
}

// 医疗兵的「空间」约束：楼里只治同一栋楼里的人，楼外只治楼外的人
function sameSpace(a, b) {
  const ra = a.inside || null, rb = b.inside || null;
  if (!ra && !rb) return true;
  return ra && rb ? ra === rb : false;
}

// 医疗兵：给附近受伤的同类型单位回血
function healNearby(run, u, heal, dt) {
  let best = null, bd = Infinity, bestMul = 1;
  for (const o of run.units) {
    if (o === u || o.hp <= 0 || o.hp >= o.maxHp) continue;
    if (UNITS[o.kind].type !== heal.target) continue;
    let hmul = 1;
    if (!sameSpace(u, o)) {
      const ra = u.inside || null, rb = o.inside || null;
      if (ra && rb) continue;                  // 两栋不同的楼：不治
      hmul = heal.crossMul != null ? heal.crossMul : 0.2;   // 楼外 ↔ 楼内：打折
    }
    const d = Math.hypot(o.x - u.x, o.y - u.y);
    if (d > heal.radius || d >= bd) continue;
    bd = d; best = o; bestMul = hmul;
  }
  if (!best) return;
  best.hp = Math.min(best.maxHp, best.hp + heal.rate * bestMul * dt);
  u.healing = true;
  if ((u.fxT || 0) <= 0 && run.effects.length < 200) {
    u.fxT = 0.35;
    run.effects.push({ heal: true, x: best.x, y: best.y, life: 0.3, max: 0.3 });
  }
  u.fxT = (u.fxT || 0) - dt;
}

// 工兵：修车 / 修工事 / 修建筑
// 工兵修建筑类（据点/工事/地图建筑）上限 50%；超过就不修
const REPAIR_CAP = 0.5;
function repairNearby(run, u, rep, dt) {
  let best = null, bd = Infinity, capMul = 1;
  const want = Array.isArray(rep.target) ? rep.target : [rep.target];
  for (const o of run.units) {
    if (o === u || o.hp <= 0 || o.hp >= o.maxHp) continue;
    if (!want.includes(UNITS[o.kind].type)) continue;
    const d = Math.hypot(o.x - u.x, o.y - u.y);
    if (d > rep.radius || d >= bd) continue;
    bd = d; best = o;
  }
  for (const f of run.forts) {
    if (f.hp <= 0 || f.hp >= f.maxHp * REPAIR_CAP) continue;
    const d = Math.hypot(f.x - u.x, f.y - u.y);
    if (d > rep.radius || d >= bd) continue;
    bd = d; best = f; capMul = REPAIR_CAP;
  }
  // 据点：只在低于 50% 时才修
  const core = run.core;
  if (core && core.hp > 0 && core.hp < core.maxHp * REPAIR_CAP) {
    const cx = (core.x + 0.5) * run.map.tile, cy = (core.y + 0.5) * run.map.tile;
    const d = Math.hypot(cx - u.x, cy - u.y);
    if (d <= rep.radius && d < bd) { bd = d; best = core; capMul = REPAIR_CAP; }
  }
  for (const b of run.map.buildings) {
    if (!b.hp || b.hp >= b.maxHp * REPAIR_CAP) continue;
    const bx = (b.x + b.w / 2) * run.map.tile, by = (b.y + b.h / 2) * run.map.tile;
    const d = Math.hypot(bx - u.x, by - u.y);
    if (d > rep.radius || d >= bd) continue;
    bd = d; best = b; capMul = REPAIR_CAP;
  }
  if (!best) return;
  best.hp = Math.min(best.maxHp * capMul, best.hp + rep.rate * dt);
  if ((u.fxT || 0) <= 0 && run.effects.length < 200) {
    u.fxT = 0.35;
    run.effects.push({ heal: true, x: best.x || (best.x !== undefined ? best.x : u.x), y: best.y || u.y, life: 0.3, max: 0.3 });
  }
  u.fxT = (u.fxT || 0) - dt;
}

function updateUnits(run, dt) {
  const T = run.map.tile;
  for (const u of run.units) {
    const def = UNITS[u.kind];
    if (!def) continue;
    u.rangeNow = unitRange(run, u);
    u.cd -= dt;
    u.flash = Math.max(0, (u.flash || 0) - dt);
    if ((u.invT || 0) > 0) u.invT = Math.max(0, u.invT - dt);
    if ((u.dropT || 0) > 0) u.dropT = Math.max(0, u.dropT - dt);
    // 热量：不打了就自然散热；满 1 时本帧不允许开火（过热）
    if (def.heat) {
      // 停火 idle 秒后才开始散热：连射时热量只涨不落
      if (u.heat > 0 && run.time - (u.fireT || -9) > (def.heat.idle || 0.35)) {
        u.heat = Math.max(0, u.heat - def.heat.cool * dt);
      }
      if (u.heat <= 0) u.overheated = false;
      u.heatNow = Math.min(1, (u.heat || 0) / (def.heat.max || 1));   // 归一化给 HUD/环用
    }
    if (u.supT > 0) { u.supT = Math.max(0, u.supT - dt); if (u.supT <= 0) { u.supT = 0; u.supMul = 1; } }
    // 冲锋击退插值：0.12s 内滑到落点。必须放在 stun 之前，
    // 否则冲锋自带的 0.6s 硬直会把位移冻结，等硬直结束才突然滑走。
    if (u.kbT > 0) {
      const k = Math.min(1, dt / Math.max(0.0001, u.kbD || 0.12));
      u.x += (u.kbX - u.x) * k;
      u.y += (u.kbY - u.y) * k;
      u.kbT -= dt;
      if (u.kbT <= 0) { u.x = u.kbX; u.y = u.kbY; u.kbT = 0; }
    }
    // 钩爪飞行：位置线性插值，途中不能开火/移动；抵达后进入短硬直
    if (u.hookFly) {
      const f = u.hookFly;
      f.t += dt;
      const k = Math.min(1, f.t / Math.max(0.0001, f.dur));
      u.x = f.x0 + (f.x1 - f.x0) * k;
      u.y = f.y0 + (f.y1 - f.y0) * k;
      u.moving = false;
      if (run.effects.length < 900 && Math.floor(f.t / 0.034) % 2 === 0) {
        run.effects.push({ x: u.x, y: u.y, life: 0.25, max: 0.25, size: 4.5, trail: true });
      }
      if (k >= 1) { u.hookFly = null; heroGrappleLand(run, u, f); }
      continue;
    }
    if ((u.landT || 0) > 0) { u.landT = Math.max(0, u.landT - dt); u.moving = false; continue; }
    if (u.stun > 0) { u.stun = Math.max(0, u.stun - dt); u.moving = false; continue; }
    // 入驻状态机：进出计时；楼内不能移动
    // 进出楼读条：满了才真正进 / 出；读条期间被下令移动会被 orderMove 清掉 enter
    if (u.enter) {
      u.moving = false;
      u.enter.t -= dt;
      if (u.enter.t <= 0) {
        const b = u.enter.b;
        if (u.enter.mode === 'in') {
          const spot = garrisonFreeSpot(run, b, u.x, u.y);
          u.inside = b;
          u.x = spot ? spot.x : (b.x + 0.5) * T;
          u.y = spot ? spot.y : (b.y + 0.5) * T;
        } else {
          const out = outsideSpot(run, b, u.x, u.y, u);
          if (out) {
            u.inside = null;
            u.x = out.x; u.y = out.y;
          } else {
            // 楼外一圈没有空位（工事/同伴占满）：留在楼里，别把人塞进炮台格
            u.inside = b;
            u.enter = null;
            continue;
          }
        }
        u.enter = null;
        u.order = null; u.path = null; u.pathEpoch = -1; u.moving = false;
      }
      if (u.enter) continue;
    }
    // 想进楼但还没到：到楼边就自动读条；楼满则停在楼边
    if (u.garrWant && !u.inside && !u.enter) {
      const gb = u.garrWant;
      if (!gb || gb.hp <= 0 || !gb.garrison) u.garrWant = null;
      else if (besideBuilding(run, gb, u)) {
        if (garrisonUsed(run, gb) < garrisonCap(gb)) {
          u.order = null; u.path = null; u.pathEpoch = -1; u.moving = false;
          u.enter = { b: gb, t: GARRISON.enterT, total: GARRISON.enterT, mode: 'in' };
          u.garrWant = null;
        } else {
          u.garrWant = null;
        }
      } else if (!u.order && !u.moving && !u.path) {
        const sp2 = outsideSpot(run, gb, u.x, u.y);
        if (sp2) { u.order = { x: sp2.tx, y: sp2.ty }; u.path = null; u.pathEpoch = -1; u.moving = true; }
        else u.garrWant = null;
      }
    }
    if (u.inside) {
      // 楼内：只能在本楼格子里自由走位，不寻路、不受地形减速
      // 楼内只修「自己所在的这一栋」：修不了楼外单位/工事
      if (def.repair && u.inside.hp > 0 && u.inside.hp < u.inside.maxHp) {
        u.inside.hp = Math.min(u.inside.maxHp, u.inside.hp + def.repair.rate * dt);
      }
      if (u.order && def.mobile) {
        if (!insideTile(run, u.inside, u.order.x, u.order.y)) {
          u.order = null; u.moving = false;
        } else {
          // 楼内与空地一致：一格一人，目标格被别人占了就找最近空着的格子
          let gx = u.order.x, gy = u.order.y;
          if (cellTakenByOther(run, u.inside, gx, gy, u.id)) {
            const alt = garrisonFreeSpot(run, u.inside, u.x, u.y);
            if (alt && insideTile(run, u.inside, alt.tx, alt.ty)) { gx = alt.tx; gy = alt.ty; }
            else { u.order = null; u.moving = false; }
          }
          if (u.order) {
            const ax = (gx + 0.5) * T, ay = (gy + 0.5) * T;
            const dx = ax - u.x, dy = ay - u.y, d = Math.hypot(dx, dy);
            const spd = def.speed * (GARRISON.insideSpeedMul || 0.9) * heroSpeedMul(run, u) * dt;
            if (d <= spd + 0.5) {
              // 到点前再确认一次：被抢了就继续找位
              if (cellTakenByOther(run, u.inside, gx, gy, u.id)) {
                const alt2 = garrisonFreeSpot(run, u.inside, u.x, u.y);
                if (alt2) { u.order = { x: alt2.tx, y: alt2.ty }; u.moving = true; }
                else { u.order = null; u.moving = false; }
              } else {
                u.x = ax; u.y = ay; u.order = null; u.moving = false;
              }
            } else {
              u.x += (dx / d) * spd; u.y += (dy / d) * spd;
              u.dir = Math.atan2(dy, dx); u.moving = true;
            }
          }
        }
      } else u.moving = false;
    }
    // 医疗兵楼内也能治（healNearby 内部限定「同层」：同楼 ↔ 同楼、楼外 ↔ 楼外）
    if (def.heal) healNearby(run, u, def.heal, dt);
    else if (def.repair) {
      // 楼内禁止维修：工兵必须先撤出建筑，才能在野外修车/修炮台/修工事
      if (!u.inside) repairNearby(run, u, def.repair, dt);
    }

    // 移动指令（楼内单位不动）
    // 错峰起步：同一批下令的单位如果在同一帧一起出发，会一起挤过同一条瓶颈，
    // 视觉上就是一坨。这里让它们按序号隔几帧动身，自然排成纵队。
    // 注意只拦"移动"，不能 continue —— 等待出发的单位仍要跑冷却/开火。
    const waitingStart = u.goAt != null && run.frame < u.goAt;
    if (u.goAt != null && !waitingStart) u.goAt = null;
    if (waitingStart) u.moving = false;
    if (!waitingStart && def.mobile && u.order && !u.inside && !(u.kbT > 0)) {
      if (u.pathEpoch !== run.epoch) {
        const ignoreForts = UNITS[u.kind].type !== '载具';   // 载具绕开工事，步兵/炮台照走
        // 跟随者：先沿领队路径走，最后一节换成自己的落点。
        // 领队路径未就绪（比如刚下令还没算）、或拼接后出现不相邻
        // 的穿墙段时，就退回自己跑 A*，保证不会走不动。
        let p = null;
        const F = u.followId ? run.units.find((o) => o.id === u.followId && o.hp > 0) : null;
        if (F && F.path && F.pathEpoch === run.epoch && F.path.length > 1) {
          const cand = F.path.slice(0, F.path.length - 1);
          cand.push(u.order.y * run.map.w + u.order.x);
          let okp = cand.length > 1;
          for (let i = 1; okp && i < cand.length; i++) {
            const a = cand[i - 1], b = cand[i];
            if (b === a) continue;
            const ax = a % run.map.w, ay = (a / run.map.w) | 0;
            const bx = b % run.map.w, by = (b / run.map.w) | 0;
            if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1) okp = false;
            else if (!TERRAIN[run.map.tiles[by * run.map.w + bx]].walkable) okp = false;
          }
          if (okp) {
            // cand[0] 是「领队下令时所在的格」，不是跟随者脚下那一格。
            // 直接拿它当 path[0] 会让 pathIdx=1 指向 cand[1]，而 cand[1] 完全可能在
            // 跟随者身后（横队整体前进时必然如此），于是它先倒走一段再回头 —— 肉眼就是抽搐。
            // 所以必须从「自己当前格」开始截取，让 path[0] 与自己脚下一致，语义才和 A* 一致。
            const selfTk = Math.floor(u.y / T) * run.map.w + Math.floor(u.x / T);
            const at = cand.indexOf(selfTk);
            if (at >= 0) p = cand.slice(at);
            else okp = false; // 自己不在领队路线上，退回自己的 A*
          }
        }
        const isVeh = !!(UNITS[u.kind] && UNITS[u.kind].type === '载具');
        if (!p) {
          p = findPath(run, Math.floor(u.x / T), Math.floor(u.y / T), u.order.x, u.order.y, ignoreForts, !isVeh);
        }
        u.path = p && p.length ? p : null;
        // 路径第一节点就是当前所在格，从 1 开始，否则会往回倒走一下（看起来像抽搐）
        u.pathIdx = u.path && u.path.length > 1 ? 1 : 0;
        u.pathEpoch = run.epoch;
        if (!u.path) {
          // 载具被路障封死：命令直接作废，给一条战报，别让它悄悄不动
          if (isVeh) emit(run, { t: 'nopath', kind: u.kind });
          u.order = null;
        }
      }
      if (u.path && u.pathIdx < u.path.length) {
        const node = u.path[u.pathIdx];
        const nx = (node % run.map.w + 0.5) * T, ny = (((node / run.map.w) | 0) + 0.5) * T;
        const dx = nx - u.x, dy = ny - u.y, d = Math.hypot(dx, dy);
        const uTile = run.map.tiles[Math.floor(u.y / T) * run.map.w + Math.floor(u.x / T)];
        const slowMul = u.slowUntil && run.time < u.slowUntil ? (u.slowMul || 1) : 1;
        // 载具碾压：撞僵尸、也被僵尸拖慢；围满直接陷住不动（下一帧再试）
        let ramK = 1;
        if (def.ram) {
          ramK = ramTick(run, u, def, dt);
          if (ramK <= 0) { u.moving = false; continue; }
        }
        const spd = def.speed * (TERRAIN[uTile].uSpeed || 1) * slowMul * ramK * heroSpeedMul(run, u) * dt;
        u.dir = Math.atan2(dy, dx);
        u.moving = true;
        // 同路行军**同速**：过去这里给每个单位一个 0.90~1.00 的速度差（错速），
        // 本意是让多人行军自然拉成一列。但速度差意味着快的一定会追上并穿过慢的 ——
        // 两人像素重叠的那一下，肉眼就是「后一个把前一个反超、还抽一下」。
        // 现在统一全速，队列先后只由落点顺序和起步错峰决定，不会出现超车。
        const spdU = spd;
        // 行军途中不做任何「让行」判定：允许重叠、允许擦身，全速前进。
        // 位置整理全部交给停下后的 settleUnits（吸格中心 + 一格一人）。
        // 只剩一个例外：下一格若被「已站定的同伴」占着、而那格正好是我的终点，
        // 就地收队，不硬挤进别人的格子。
        // 这里曾经有一段「终点被别人先站了就地收队」的判定，实测会让 8 个人
        // 互相占住目标格、全员原地不动。现在彻底不判：行军允许重叠、允许擦身，
        // 位置整理全部交给停下后的 settleUnits（吸格中心 + 一格一人）。
        // 全速前进：行军不再因为「前方一格有同伴」而减速。
        // 旧实现在这里乘一个 0.65 的让行系数，7 个兵排队时第 2~7 个全程打折，
        // 肉眼就是「没达到全部移速」；现在允许重叠穿过，位置整理只发生在停下之后。
        const stepLen = spdU;
        // 等前车就让 stepLen=0：原地不动即可，**不能**把 u.moving 置 false ——
        // moving 一旦变 false，上层会认为它"没在行军"并让路径失效重算，
        // pathIdx 被清零 ⇒ 永远卡在第一格（实测 8 人互等 9 秒一步没挪）。
        if (stepLen > 0) {
          u._stuck = 0;
          if (d <= stepLen + 0.001) { u.x = nx; u.y = ny; u.pathIdx++; }
          else { u.x += (dx / d) * stepLen; u.y += (dy / d) * stepLen; }
          // 记下"真的动过"的帧号：settleUnits 靠它区分「在走」和「在等」。
          // 只靠 u.moving 会误判 —— 让行等待时 moving 仍为 true（这是必须的，见上），
          // 但单位其实一步没挪，这时候就该按静止处理、吸到格中心。
          u._movedAt = run.frame;
        }
        u.tx = Math.floor(u.x / run.map.tile);
        u.ty = Math.floor(u.y / run.map.tile);
        if (stepLen <= 0) {
          // 走不动（spdU 为 0 / 被减速到停）：累计卡死帧数，超过阈值就重算路径（星际 1 的做法）。
          // 现在行军不再互相让行，这条只剩防御作用。
          u._stuck = (u._stuck || 0) + 1;
          if (u._stuck > (RULE.collide.stuckFrames || 60)) {
            u._stuck = 0;
            u._retry = (u._retry || 0) + 1;
            if (u._retry > 3) {
              // 连算三次还被堵：放弃这条命令，停在原地交给 settleUnits 吸到格中心，
              // 总比永远卡在半路、路径虚线一直挂着好。
              u.order = null; u.path = null; u.pathEpoch = -1; u.moving = false; u._retry = 0;
            } else {
              u.pathEpoch = -1;   // 下一帧重算（换个走法/换个时机）
            }
          }
        }
      } else {
        u.moving = false;
        u.order = null;
        u.path = null;
        u.followId = null; u._stuck = 0; u._retry = 0;
      }
      if (u.order && !u.moving && u.path && u.pathIdx >= u.path.length) { u.order = null; u.path = null; }
    } else {
      u.moving = false;
    }

    // 巡逻：到达一端（order 被清空）就转向另一端，中间留 0.25s 停顿
    // 架设式单位（机枪组）：读条期间原地不动、不开火；受击不打断，但移动指令会取消架设
    if (def.deploy) {
      if (u.depDir) {
        if (u.depDir > 0 && u.order) { u.depDir = 0; u.depT = 0; }
        else {
          u.moving = false;
          u.depT = (u.depT || 0) + dt;
          if (u.depDir > 0 && u.depT >= def.deploy.setUpT) {
            u.depOn = true; u.depDir = 0; u.depT = 0;
            emit(run, { t: 'deploy', x: u.x, y: u.y, on: true });
          } else if (u.depDir < 0 && u.depT >= def.deploy.tearDownT) {
            u.depOn = false; u.depDir = 0; u.depT = 0;
            emit(run, { t: 'deploy', x: u.x, y: u.y, on: false });
            const od = u.depOrder; u.depOrder = null;
            if (od) { u.order = od; u.path = null; u.pathEpoch = -1; }
          }
        }
      }
      if (u.depDir) continue;   // 读条期间不索敌、不开火
    }

    if (u.stance === STANCE.PATROL && u.patrol && !u.enter && !u.inside && !u.order) {
      u.patrolWait = (u.patrolWait || 0) - dt;
      if (u.patrolWait <= 0) {
        u.patrol.idx = u.patrol.idx ? 0 : 1;
        const pt = u.patrol.pts[u.patrol.idx];
        if (pt) { u.order = { x: pt.x, y: pt.y }; u.path = null; u.pathEpoch = -1; u.moving = false; }
        u.patrolWait = COMMAND.patrolWait;
      }
    }
    // 机枪组行军态禁止开火；轻机枪兵（deploy.fireFolded）折叠着也能打
    if (def.deploy && !u.depOn && !def.deploy.fireFolded) continue;
    if (u.stance === STANCE.HOLD) continue;   // 停火：不索敌、不开火
    // 指挥官：敌人贴到身上时先用枪托横扫（打完照常开枪，不占射击节奏）
    // 注意必须放在换弹分支之前——装填的 2.6 秒正是最需要近战顶住的时候
    if (u.sweepT > 0) u.sweepT -= dt;
    if (def.hero && !(u.sweepT > 0) && heroSweep(run, u)) { /* 继续走开火流程 */ }
    // 弹夹：换弹期间可移动但不能开火；读秒结束补满
    if (u.reloadT > 0) {
      u.reloadT -= dt;
      if (u.reloadT <= 0) {
        u.reloadT = 0;
        const mg = def.mag;
        if (mg) u.ammo = mg.size;
      }
      continue;
    }
    if (u.cd > 0) continue;
    // 过热是「闩锁」：必须完全冷却到 0 才恢复，避免刚好掉到阈值下就继续扫射
    if (def.heat && (u.overheated || (u.heat || 0) >= (def.heat.max || 1) - 0.001)) { u.overheated = true; continue; }
    const effRange = u.rangeNow || unitRange(run, u);
    u.rangeNow = effRange;
    const r2 = effRange * effRange;
    const min2 = (def.minRange || 0) ** 2;
    let best = null, bestScore = Infinity;
    // 目标粘性：已锁定的目标只要还活着就压低其评分（0.7），避免两个重甲在射程边缘来回抢目标
    if (u.tgt && (u.tgt.hp <= 0)) u.tgt = null;
    const stickyMul = u.tgt ? 0.7 : 1;
    if (!best) {
      // 目标偏置（狙击手等）：把「有效距离」乘 bias，bias 越小越优先，但仍要求在真实射程内
      const tb = def.targetBias;
      for (const z of run.zombies) {
        if (z.hp <= 0) continue;
        const d = (z.x - u.x) ** 2 + (z.y - u.y) ** 2;
        if (d > r2 || d < min2) continue;
        let bias = 1;
        const zd2 = ZOMBIES[z.mob];
        const zArmor = (zd2 && zd2.armor) || 'none';
        if (tb && tb.specialNoHeavy) {
          if (zd2 && SPECIAL_IDS.includes(z.mob) && zArmor !== 'heavy') bias = tb.specialNoHeavy;
        }
        if (tb && tb.heavy && zArmor === 'heavy') bias = Math.min(bias, tb.heavy);
        let score = d * bias * bias;
        if (u.tgt && u.tgt === z) score *= stickyMul;
        if (score < bestScore) { bestScore = score; best = z; }
      }
      // 叛军也是敌人（第三方红方人类），同一套距离打分
      for (const r of (run.raiders || [])) {
        if (r.hp <= 0) continue;
        const d = (r.x - u.x) ** 2 + (r.y - u.y) ** 2;
        if (d > r2 || d < min2) continue;
        let rbias = 1;
        if (tb && tb.heavy && (r.armor || 'none') === 'heavy') rbias = Math.min(rbias, tb.heavy);
        // 叛军装甲车：射程 160 能压住步枪/机枪，是全图最该先点的目标（sniper/rocket/tank 各带权重）
        if (tb && tb.raiderVehicle && r.kind === 'vehicle') rbias = Math.min(rbias, tb.raiderVehicle);
        let rscore = d * rbias * rbias;
        if (u.tgt && u.tgt === r) rscore *= stickyMul;
        if (rscore < bestScore) { bestScore = rscore; best = r; }
      }
    }
    if (!best) { u.tgt = null; continue; }
    // 范围伤害单位开火间隔受惩罚（只对玩家单位生效）
    const splashMul = def.splash && RULE.combat.splashAttackMul ? RULE.combat.splashAttackMul : 1;
    const mvMul = (u.moving && def.moveMul) ? def.moveMul : 1;
    // 架设收益 / 折叠惩罚：架设 ×intervalMul，折叠（可开火但不架）时吃到 foldMul
    // 收架读条期间就算还能开枪，也不该按架设射速——只看「稳稳定定架着」这一种状态
    const deployedSteady = u.depOn && !u.depDir;
    const depMul = def.deploy
      ? (deployedSteady ? (def.deploy.intervalMul || 1) : (def.deploy.fireFolded ? (def.deploy.foldMul || 1) : 1))
      : 1;
    u.cd = def.fireInterval * splashMul * (u.supMul || 1) * mvMul * depMul;
    // 弹夹：开一枪扣一发，打空进入换弹（换弹不刷新 cd）
    if (def.mag) {
      if (u.ammo === undefined) u.ammo = def.mag.size;
      u.ammo -= 1;
      if (u.ammo <= 0) {
        u.ammo = 0;
        u.reloadT = def.mag.reload * perkMul(run, 'reload', 0.8);
      }
    }
    if (def.heat) {
      const hmax0 = def.heat.max || 1;
      u.heat = Math.min(hmax0, (u.heat || 0) + def.heat.perShot);
      u.fireT = run.time;
      if (u.heat >= hmax0 - 0.001) u.overheated = true;
    }
    if (def.fx === 'flame') {
      // 火焰：以「最近目标」为基准，仅当**射界内**的敌人重心仍落在射界内时才微调过去。
      // 这样一堆人挤在一起时枪口不会来回甩；左右各来一只时也不会指向中间空处。
      const fr = def.range || 84;
      const half = (def.jet && def.jet.half) || 0.4;
      const off = (v) => Math.abs(((v + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
      const a0 = Math.atan2(best.y - u.y, best.x - u.x);
      let mx = 0, my = 0, mn = 0;
      for (const zz of run.zombies) {
        if (!zz || zz.hp <= 0) continue;
        const dx = zz.x - u.x, dy = zz.y - u.y;
        const dd = Math.hypot(dx, dy);
        if (dd < 1 || dd > fr) continue;
        if (off(Math.atan2(dy, dx) - a0) > half) continue;   // 只统计当前射界内的
        mx += dx / dd; my += dy / dd; mn++;
      }
      let a1 = a0;
      if (mn > 1) {
        const ac = Math.atan2(my, mx);
        if (off(ac - a0) <= half) a1 = ac;
      }
      u.dir = a1;
    } else if (!u.moving || def.aimOnMove) {
      u.dir = Math.atan2(best.y - u.y, best.x - u.x);
    }
    u.flash = 0.09;
    u.tgt = best;
    u.aimX = best.x;
    u.aimY = best.y;
    // 抛射类（坦克炮弹 / 迫击炮 / 火箭）把伤害挂到落点上，落地才结算
    const fxKind = def.fx || 'bullet';
    const isProj = fxKind === 'shell' || fxKind === 'mortar' || fxKind === 'rocket' || fxKind === 'ap';
    if (!isProj && fxKind !== 'flame') {
      hitAt(run, u, def, best.x, best.y);
    }
    // 燃烧塔：伤害真的沿火舌方向走（锥形），落点圆只留一小片残火
    if (fxKind === 'flame') flameCone(run, u, def);
    // 燃烧塔：落点撒一个短命燃烧区（与主动技能燃烧弹同一套 zones 判定）；
    // 同一座的相邻落点原地续命，避免几秒内堆出上百个区域
    if (fxKind === 'flame' && def.zone) {
      const zn = def.zone;
      // 残火圈铺在「锥内最远的命中点」；没有命中就铺在射程 80% 处（不再贴着脚）
      const ff = run._flameFar;
      const zx0 = ff ? ff.x : u.x + Math.cos(u.dir) * (def.range || 84) * 0.8;
      const zy0 = ff ? ff.y : u.y + Math.sin(u.dir) * (def.range || 84) * 0.8;
      let near = null;
      for (const zz of run.zones) {
        if (zz.id !== 'flame' || zz.owner !== u.id) continue;
        if (Math.hypot(zz.x - zx0, zz.y - zy0) <= (zn.merge || 18)) { near = zz; break; }
      }
      if (near) {
        near.x = zx0; near.y = zy0;
        near.left = zn.duration; near.dps = zn.dps; near.r = zn.r; near.slow = zn.slow;
      } else {
        run.zones.push({
          id: 'flame', owner: u.id, x: zx0, y: zy0, r: zn.r,
          left: zn.duration, tick: 0, dps: zn.dps, slow: zn.slow, gap: zn.gap,
          edge: zn.edge != null ? zn.edge : 0.6, vsArmor: def.vsArmor || null,
        });
      }
    }
    // ---- 武器特效：步枪曳光、火焰喷射、抛射物 ----
    {
      const fx = def.fx || 'bullet';
      const sx = u.x, sy = u.y, tx = best.x, ty = best.y;
      const boomR = def.splash ? def.splash.radius : 16;
      if (fx === 'bullet') {
        // 加特林（装甲车）：短命曳光 + 每发随机散布，连射时是一串弹幕而非一根实线
        const gat = !!def.gatling;
        const jx = gat ? (run.fxRng.next() * 2 - 1) * 3.2 : 0;
        const jy = gat ? (run.fxRng.next() * 2 - 1) * 3.2 : 0;
        run.effects.push({
          bullet: true, x1: sx, y1: sy, x2: tx + jx, y2: ty + jy,
          life: gat ? 0.055 : 0.10, max: gat ? 0.055 : 0.10,
          w: u.kind === 'vehicle' ? (gat ? 2.0 : 2.6) : 2.0,
          hot: gat,
        });
      } else if (fx === 'flame') {
        // 火舌长度恒定 = 射程（曾用「到最近目标的距离」，贴脸时会缩成一小撮，看着像只喷脚边）
        const flen = def.range || 84;
        run.effects.push({ flame: true, x1: sx, y1: sy,
          x2: sx + Math.cos(u.dir) * flen, y2: sy + Math.sin(u.dir) * flen,
          life: 0.19, max: 0.19 });
      } else {
        const speed = fx === 'mortar' ? 210 : fx === 'rocket' ? 380 : fx === 'ap' ? 2400 : 620;
        const dist = Math.hypot(tx - sx, ty - sy);
        const minLife = fx === 'ap' ? 0.04 : 0.09;
        const life = Math.max(minLife, Math.min(0.55, dist / speed));
        run.effects.push({
          proj: fx, x1: sx, y1: sy, x2: tx, y2: ty, life, max: life,
          arc: fx === 'ap' ? 0 : fx === 'mortar' ? 30 : fx === 'rocket' ? 7 : 12,
          boomR,
          // 落地时才结算的伤害
          impact: { ownerId: u.id, dmg: def.dmg, splash: def.splash || null, kind: u.kind },
        });
      }
    }
    u.recentShot = RULE.aggro.fireWindow;
    run.stats.shots = (run.stats.shots || 0) + 1;
    emit(run, { t: 'shot', k: u.kind, x: u.x, y: u.y });
  }
}

// 下达移动指令（同样给可移动单位排一个松散阵位，避免叠在一起）
// 以 (tx,ty) 为圆心向外螺旋，找第一个「可走 + 没人占」的格子
// 找落点：点到空地就是那一格；点在楼/工事/同伴身上时，退到最近的空格。
// 退格时不再按「左上优先」的扫描顺序，而是取同一圈里离点击点最近、其次离单位最近的那格，
// 否则玩家点右侧的楼，单位会被甩到左上角去。
function claimSpot(run, tx, ty, taken, from) {
  const W = run.map.w, H = run.map.h, T = run.map.tile;
  const fx = from ? from.x / T : null, fy = from ? from.y / T : null;
  for (let r = 0; r <= 8; r++) {
    let best = null, bestScore = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const t = run.map.tiles[y * W + x];
        if (!TERRAIN[t].walkable) continue;
        if (run._fortTile && run._fortTile.has(y * W + x)) continue;   // 工事占的格不能站人
        if (taken.has(y * W + x)) continue;
        if (r === 0) return { x, y };
        const nearClick = dx * dx + dy * dy;
        const nearUnit = fx === null ? 0 : ((x + 0.5 - fx) ** 2 + (y + 0.5 - fy) ** 2) * 0.35;
        const score = nearClick + nearUnit;
        if (score < bestScore) { bestScore = score; best = { x, y }; }
      }
    }
    if (best) return best;   // 这一圈已经有可用格：取这圈里最贴点击点的，不再往外扩
  }
  return null;
}

// 判断一个坐标能不能站人（地形可走 / 在楼内的就查楼内格 / 工事占格不行）。
// 注意：这个函数不是碰撞，它只回答「这个位置能不能站」。
function canOccupyPos(run, u, x, y) {
  const T = run.map.tile, W = run.map.w;
  const tx = Math.floor(x / T), ty = Math.floor(y / T);
  if (tx < 0 || ty < 0 || tx >= W || ty >= run.map.h) return false;
  if (u.inside) return insideTile(run, u.inside, tx, ty);
  if (!TERRAIN[run.map.tiles[ty * W + tx]].walkable) return false;
  if (run._fortTile && run._fortTile.has(ty * W + tx)) return false;
  return true;
}

// 收队整理（A 方案）：行军途中允许贴近，但**停下之后**做格级整理 ——
// 1) 吸附格中心：行军期间只有路径插值写坐标（不做像素推挤），停下时人可能正卡在格线上，
//    看上去"没站在格子里"。这里统一吸到 (tx+0.5)*T。
// 2) 一格一人：同格有多人时，只让 id 最大的（后来者）去 claimSpot 找空格，
//    先站定的人原地不动 —— 否则一停下就整群人乱窜。
// 每帧对静止单位跑一遍是幂等的：已经在格中心就什么都不改。
export function settleUnits(run) {
  const W = run.map.w, T = run.map.tile;
  // 搬家用 5 帧滑过去，不做整格瞬移 —— 24px 的瞬移肉眼就是「抽搐」，
  // 但格级分离必须做（同格不能站两个人），所以把位移摊成动画。
  for (const u of run.units) {
    const g = u._glide;
    if (!g) continue;
    g.left -= 1;
    const k = 1 - g.left / 5;
    u.x = g.fx + (g.tx - g.fx) * k;
    u.y = g.fy + (g.ty - g.fy) * k;
    if (g.left <= 0) { u.x = g.tx; u.y = g.ty; u._glide = null; }
  }
  const still = [];
  for (const u of run.units) {
    if (u.hp <= 0 || u.inside || !UNITS[u.kind] || u._glide) continue;
    // 「最近 2 帧真的挪动过」才算在走；让行等待中 moving 仍是 true 但一步没动，
    // 这种情况按静止处理，否则会永远停在格线上不居中。
    // 在行军（含被挡等待）一律不归 settle 管，交给路径插值。
    // 光看 moving/path 不够：错峰起步（goAt）期间 moving 被置 false 且 path 还没算出来，
    // 这种"有移动指令但还没动身"的人会被当成静止单位整理 —— 若这一格恰好挤了两个人，
    // 就会被 claimSpot 搬走并触发 _glide 滑动，与随后的出发叠在一起，肉眼就是一抽。
    // 所以只要还有未完成的移动指令（u.order）就一律不碰。
    if (u.moving || u.path || u.order) continue;
    still.push(u);
  }
  if (!still.length) return;
  // 会占格的有两种人：
  //   ①还在走的 —— 临时占住他当前格，免得把站定的人吸到正在经过的人身上；
  //   ②已经稳稳站在格中心的老单位 —— 他那一格永久归他。
  // ②是必须的：以前 taken 每帧从空开始，同一批静止单位只按 id 大小决定谁占格，
  // 于是每有一批人从"行进"切成"静止"，id 大的就被 claimSpot 挤到邻格（整整一格 24px 的瞬移）。
  // 下一批人再停下时历史重演 ⇒ 同一个兵被连续挤两格，肉眼就是"抽搐一下"。
  const taken = new Set();
  for (const u of run.units) {
    if (u.hp <= 0 || u.inside || !UNITS[u.kind]) continue;
    const utx = Math.floor(u.x / T), uty = Math.floor(u.y / T);
    const utk = uty * W + utx;
    // 只预占「还在走」的格；静止的人交给下面两轮认领，别在这里提前占掉
    if (u.moving || u.path) taken.add(utk);
  }
  // 每个静止格上站了几个人：>1 是重叠（历史遗留/挤在一起），必须拆开；
  // 只有 1 个人的格子属于「老兵自己的地盘」，不碰。
  const tileCount = new Map();
  for (const u of still) {
    const k = Math.floor(u.y / T) * W + Math.floor(u.x / T);
    tileCount.set(k, (tileCount.get(k) || 0) + 1);
  }
  const stillTile = (u) => {
    const tx = Math.floor(u.x / T), ty = Math.floor(u.y / T);
    return { tx, ty, tk: ty * W + tx, onFort: !!(run._fortTile && run._fortTile.has(ty * W + tx)) };
  };
  const steadyAt = (u, tx, ty) =>
    Math.abs(u.x - (tx + 0.5) * T) < 0.6 && Math.abs(u.y - (ty + 0.5) * T) < 0.6;
  // 「刚停下」= 出生后还没结算过，或者停下不满 6 帧。
  // 只有这种人才允许被整理（吸附格中心 / 被挤到邻格）；早就站定的老兵一律不碰 ——
  // 否则每来一批新人都把老兵再挤一格，收队那一刻整群接连弹跳，比原来更难看。
  const justStopped = (u) => u._movedAt == null || run.frame - u._movedAt <= 6;

  // 第一轮：已经稳稳站在格中心的人，先把自己那一格认领掉（不看 id、也不让后来者插队）。
  // 这一步是「抽搐」的根治点：以前所有静止单位混在一起按 id 排序抢格，
  // 每有一批人从"行进"切成"静止"，id 大的就被挤到邻格（整整一格 24px 瞬移）。
  // 老兵先认领自己的格，新兵后认领 —— 冲突时永远是刚到的那个让位。
  still.sort((a, b) => (justStopped(a) ? 1 : 0) - (justStopped(b) ? 1 : 0) || a.id - b.id);
  for (const u of still) {
    const d = stillTile(u);
    if (d.onFort) continue;                 // 工事格不能站人，交给第二轮搬家
    // 同格的两个「已站稳」单位只能有一个人保住格：先认领的先得。
    // 另一个进第二轮被 claimSpot 搬走（会闪一格，这是需求：同格必须分开）。
    if (steadyAt(u, d.tx, d.ty) && !taken.has(d.tk)) { taken.add(d.tk); u._holdTile = d.tk; }
  }

  // 第二轮：其余人吸附到格中心；格子被占（或压在工事上）就找最近的空位搬过去
  for (const u of still) {
    const { tx, ty, tk, onFort } = stillTile(u);
    if (u._holdTile === tk) { u._holdTile = null; continue; }   // 第一轮已认领，原地不动
    u._holdTile = null;
    // 搬家限流：刚被挤过的人 2 秒内不再挪。
    // 不加这句的话，每有一批人从"行进"切成"静止"，都会把上一次被挤开的人再挤一格 —— 连环抽搐。
    // 老兵且独占自己的格 ⇒ 一律不碰；只有「刚停下」或「这格挤了两个人」才整理。
    if (!justStopped(u) && (tileCount.get(tk) || 0) < 2) { taken.add(tk); continue; }
    if (!taken.has(tk) && !onFort) {
      u.x = (tx + 0.5) * T; u.y = (ty + 0.5) * T;   // 吸附格中心（幂等）
      taken.add(tk);
      continue;
    }
    // 这格已被别人站住：找最近的空格搬过去
    const spot = claimSpot(run, tx, ty, taken, { x: u.x, y: u.y });
    if (spot) {
      // 只挪坐标：不要动 moving/path —— 它们本来就是静止的，
      // 这里把 moving 置 false 会让上层以为"没在行军"，进而让路径失效重算。
      u._glide = { fx: u.x, fy: u.y, tx: (spot.x + 0.5) * T, ty: (spot.y + 0.5) * T, left: 5 };
      taken.add(spot.y * W + spot.x);
    } else {
      u.x = (tx + 0.5) * T; u.y = (ty + 0.5) * T;   // 找不到空格就留在原地
    }
  }
}

export function orderMove(run, ids, tx, ty) {
  const T = run.map.tile;
  const set = new Set(ids);
  const busySrc = new Set((run.queue || []).map((q) => q.srcId).filter(Boolean));
  const blocked = (u) => {
    const d = UNITS[u.kind];
    return !!(d && d.produces && d.produces.length && busySrc.has(u.id));
  };
  const movers = run.units.filter((u) => set.has(u.id) && UNITS[u.kind] && UNITS[u.kind].mobile && !blocked(u) && !u.inside);
  for (const u of movers) {
    if (u.enter) u.enter = null;              // 下令移动 = 取消进出楼读条
    if (u._glide) u._glide = null;            // 取消还没滑完的整理位移
    if (u.stance === STANCE.PATROL) { u.stance = STANCE.FREE; u.patrol = null; }
  }   // 下令移动 = 取消进出楼读条
  if (!movers.length) {
    // 全部都在架炮：返回 -1 让 UI 能区分「没选中可移动单位」与「正在架炮」
    return set.size && run.units.some((u) => set.has(u.id) && blocked(u)) ? -1 : 0;
  }
  // 一个格子最多站 1 个单位：给每个单位分配一个不同的落点。
  // 注意：被命令的这批单位「自己脚下」和「自己的旧预约」不算占坑，否则点自己脚下/相邻格时
  // 会被挤到左上邻居去；同批其他人仍然互相避让。
  const moverIds = new Set(movers.map((u) => u.id));
  const taken = new Set();
  for (const u of run.units) {
    if (moverIds.has(u.id)) continue;
    // 行进中的单位也要占坑：否则连点两次会把同一个格子发给两个人，终点撞在一起
    taken.add(Math.floor(u.y / T) * run.map.w + Math.floor(u.x / T));
    if (u.order) taken.add(u.order.y * run.map.w + u.order.x);
  }
  // 多单位：所有人都点同一个目标格，靠 claimSpot 就近找空位自然铺开。
  // 不再手算方阵（旧写法 side=ceil(√n) × gap=2 会让 8 人铺满 5×5 格、
  // 目标区面积随人数平方级膨胀）。claimSpot 本身就在目标格周围逐圈搜空位，
  // 再加上下面 taken 已经占住了同批其他人的脚下格，第二个人自然去隔壁，
  // 最终铺成一个 1 格间距的紧凑堆；停下后再由 settleUnits 整理成一格一人。
  let assigned = 0;
  // 领队寻路：多人同一条命令时只让第一个人跑 A*，其余沿领队路径跟到自己的落点。
  // 星际 1 就是这么做的 —— 8 人点一格现在要跑 8 次 A*，终点几乎相同、路径高度重合，
  // 纯属浪费；跟随后 CPU 降到 1/8，队伍也天然排成纵队而不是各自劈叉。
  const leaderId = movers.length > 1 ? movers[0].id : null;
  for (let mi = 0; mi < movers.length; mi++) {
    const u = movers[mi];
    for (const o of movers) {                 // 同批其他单位的脚下也算占用，只放开自己
      if (o !== u) taken.add(Math.floor(o.y / T) * run.map.w + Math.floor(o.x / T));
    }
    const goal = { x: tx, y: ty };
    const spot = claimSpot(run, goal.x, goal.y, taken, { x: u.x, y: u.y });
    if (!spot) continue;
    taken.add(spot.y * run.map.w + spot.x);
    if (!UNITS[u.kind]) return;
    if (UNITS[u.kind].deploy && u.depOn) {   // 架设中：先收起（1.5s），完成后再执行移动
      u.depDir = -1; u.depT = 0; u.depOrder = { x: spot.x, y: spot.y };
      u.order = null;   // 必须清掉旧目标，否则收起完会被旧 order 拉回去
      u.path = null; u.pathEpoch = -1; u.moving = false;
      continue;
    }
    u.order = { x: spot.x, y: spot.y };
    u.path = null;
    u.pathEpoch = -1;
    u.followId = u.id === leaderId ? null : leaderId;
    u._stuck = 0;
    u._retry = 0;
    // 错峰：同批下令的第二个人起，每个晚 12 帧（约 0.2s）出发，自然排成纵队而不是一坨
    u.goAt = run.frame + assigned * 12;
    assigned++;
    emit(run, { t: 'move', x: (spot.x + 0.5) * run.map.tile, y: (spot.y + 0.5) * run.map.tile });
  }
  return assigned;
}

// 伤害数字（纯可视化，上限 70 条防止刷屏）
// ---- 军衔（精英化）：经验只挂单兵，单位死亡即清零 ----
// 0 = 新兵 / 1 = 老兵 / 2 = 精英。加成是「累计值」，不是每级叠乘。
export function unitRank(u) {
  const R = RULE.rank;
  if (!u || !R) return 0;
  const xp = u.xp || 0;
  if (xp >= R.xp[1]) return 2;
  if (xp >= R.xp[0]) return 1;
  return 0;
}
export function unitDmgMul(u) {
  const r = unitRank(u);
  return r ? 1 + RULE.rank.dmg[r - 1] : 1;
}
export function unitHpMul(u) {
  const r = unitRank(u);
  return r ? 1 + RULE.rank.hp[r - 1] : 1;
}
// 下一级还差多少（满级返回 null），给底栏「击杀 8/12」用
export function unitXpNext(u) {
  const r = unitRank(u);
  return r >= RULE.rank.xp.length ? null : RULE.rank.xp[r];
}
// 僵尸经验权重：直接复用碾压权重（行尸 1 / 特感 2 / 暴君 10），三者本来就按威胁度排过
export function zXpWeight(mob) {
  const d = ZOMBIES[mob];
  return d && d.ramWeight != null ? d.ramWeight : 1;
}
// 叛军不是僵尸：步兵 1 点、装甲车 3 点（打完就没了，不必给太高）
export function raiderXpWeight(r) {
  return r && r.kind === 'vehicle' ? 3 : 1;
}
// 升级：按加成比例抬 maxHp 并把增量补进当前血量（升级顺带一口奶，老兵不至于原地残血）
// 火焰路径（火舌 / 残火圈 / 点燃）不走 hitAt，这里补一次击杀经验；
// z._xpBy 保证同一只僵尸只记一次，避免同一帧多处伤害重复加经验
function creditFlameKill(run, ownerId, z) {
  if (!z || z._xpBy != null || ownerId == null) return;
  const owner = run.units.find((u) => u.id === ownerId);
  if (!owner || owner.hp <= 0) return;
  z._xpBy = ownerId;
  owner.kills = (owner.kills || 0) + 1;
  addUnitXp(run, owner, zXpWeight(z.mob));
}

function addUnitXp(run, u, xp) {
  if (!u || !(xp > 0)) return;
  if (u.side === 'raider') return;          // 叛军不吃军衔
  if (!UNITS[u.kind]) return;
  const before = unitRank(u);
  u.xp = (u.xp || 0) + xp;
  const after = unitRank(u);
  if (after <= before) return;
  u.rank = after;
  const ratio = unitHpMul(u) / (before ? 1 + RULE.rank.hp[before - 1] : 1);
  const oldMax = u.maxHp || 0;
  u.maxHp = Math.round(oldMax * ratio);
  u.hp = Math.min(u.maxHp, Math.max(0, u.hp) + (u.maxHp - oldMax));
  addTextFloat(run, u.x, u.y, after >= 2 ? '精英' : '老兵');
  emit(run, { t: 'rankup', id: u.id, kind: u.kind, rank: after });
}

// 纯文字浮字（军衔提升等），跟伤害数字共用 run.floats 队列
function addTextFloat(run, x, y, text) {
  if (!text || run.floats.length >= 70) return;
  run.floats.push({
    x: x + (run.fxRng.next() - 0.5) * 6,
    y: y - 10,
    text: String(text),
    life: 1.1, max: 1.1,
    friendly: true, crit: false,
  });
}

// kind: null = 旧行为（伤害/友伤）；'heal' = 回血（绿色 + 前缀）
function addFloat(run, x, y, amount, friendly, crit, kind) {
  if (!(amount > 0.4)) return;
  if (run.floats.length >= 70) return;
  run.floats.push({
    x: x + (run.fxRng.next() - 0.5) * 10,
    y: y - 6,
    v: Math.round(amount),
    life: crit ? 0.82 : 0.62,
    max: crit ? 0.82 : 0.62,
    friendly: !!friendly,
    crit: !!crit,
    kind: kind || null,
  });
}

// 一次开火只 roll 一次：溅射打一片时整片同倍率，视觉上是一记重击而不是零散跳数字
function rollCrit(run, def) {
  if (!run || run.critOn !== true) return 1;
  const baseRate = def.critRate != null
    ? def.critRate
    : (def.splash ? (RULE.crit.splashRate || 0.08) : (RULE.crit.rate || 0));
  const rate = baseRate + (run.perks && run.perks.has('crit') ? 0.03 : 0);
  if (!(rate > 0)) return 1;
  // critRng 在 createRun 里必定建立；这里兜底也走同一条确定性序列，绝不走非确定性随机
  if (!run.critRng) run.critRng = new RNG(((run.seed || 1) ^ 0x2c1b3c6d) >>> 0);
  const r = run.critRng.next();
  return r < rate ? (RULE.crit.mult || 2) : 1;
}

// 落点衰减：中心满伤 → 边缘 factor；用 1.5 次方，越靠外掉得越快
export function falloffK(d, R, f) {
  if (!(R > 0)) return 1;
  const t = Math.min(1, Math.max(0, d / R));
  return f + (1 - f) * (1 - Math.pow(t, 1.5));
}

// 该单位吃多少比例的友军伤害：步兵/载具 20%，炮台类 10%
function ffMulForUnit(kind) {
  const d = UNITS[kind];
  if (!d) return 0;
  return d.type === '炮台' ? RULE.friendlyFire.tower : RULE.friendlyFire.unit;
}

// 范围伤害的友军结算：我方单位 / 炮台 / 工事都会被自己的火力打到
function friendlyHit(run, ownerId, x, y, R, dmg, f) {
  if (!run.ffOn || !RULE.friendlyFire.on) return 0;
  const T = run.map.tile;
  let total = 0;
  for (const u of run.units) {
    if (u.hp <= 0) continue;
    if (ownerId != null && u.id === ownerId) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d > R) continue;
    const mul = ffMulForUnit(u.kind);
    if (!(mul > 0)) continue;
    // 友伤也吃护甲（hurtUnit 里按护甲档算），并且同样不该打穿空投保护/光环减伤
    const amount = hurtUnit(run, u, dmg * falloffK(d, R, f) * mul, 0, 0, null, true);
    if (!(amount > 0.05)) continue;
    total += amount;
    addFloat(run, u.x, u.y, amount, true);
    if (u.hp <= 0) run.stats.friendlyKills += 1;
  }
  for (const ft of run.forts) {
    if (ft.hp <= 0) continue;
    const fx = ft.x != null ? ft.x : (ft.tx + 0.5) * T;
    const fy = ft.y != null ? ft.y : (ft.ty + 0.5) * T;
    const d = Math.hypot(fx - x, fy - y);
    if (d > R) continue;
    const amount = dmg * falloffK(d, R, f) * RULE.friendlyFire.fort;
    if (!(amount > 0.05)) continue;
    ft.hp -= amount;
    total += amount;
    if (ft.hp > 0) addFloat(run, fx, fy, amount, true);
  }
  run.stats.friendlyDamage += total;
  return total;
}

// 僵尸死亡：崩出几块细碎，先停留再逐渐消失
function spawnGibs(run, z) {
  if (run.effects.length > 220) return;
  const n = z.mob === 'brute' ? 9 : 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + run.fxRng.next() * 0.9;
    const sp = 26 + run.fxRng.next() * 46;
    run.effects.push({
      x: z.x, y: z.y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.85 + run.fxRng.next() * 0.45,
      max: 1.3,
      size: 2 + run.fxRng.next() * 2.4,
      gib: true,
      rot: run.fxRng.next() * Math.PI,
    });
  }
}

// ---------------- 死亡转行尸（B 档：概率 + 起身延迟；友伤/自爆不转） ----------------
// 概率分波：第 1 波 25%、第 2 波 35%、第 3 波起 45%；每波上限 10 只；延迟 0.9s 起身且满血。
export function riseChance(run) {
  const cfg = RULE.rise;
  if (!cfg || !cfg.probs || !cfg.probs.length) return 0;
  const w = Math.max(1, run.waveIndex || 1);
  return cfg.probs[Math.min(cfg.probs.length - 1, w - 1)] || 0;
}

// srcMob 有值 = 死于僵尸之手；友伤/自爆破片/酸池等不传 srcMob 的路径不会转化
export function maybeRise(run, u, srcMob, side) {
  const cfg = RULE.rise;
  if (!cfg || !srcMob || !u) return 0;
  const def = UNITS[u.kind];
  if (!def || def.type !== '步兵') return 0;          // 载具 / 炮台 / 工事不转
  const p = riseChance(run);
  if (p <= 0) return 0;
  const cap = cfg.cap || 10;
  const heads = Math.max(1, def.pop || 1);            // 机枪组 2 人：两个人口各自 roll
  let made = 0;
  for (let i = 0; i < heads; i++) {
    if ((run.riseCount || 0) + made >= cap) break;
    if (!(run.rng.next() < p)) continue;
    made += 1;
    run.riseQueue.push({
      x: u.x, y: u.y,
      inside: u.inside || null,
      t: cfg.delay || 0.9,
      mob: cfg.mob || 'walker',
      side: side || 'unit',
    });
  }
  if (made > 0) {
    run.riseCount = (run.riseCount || 0) + made;
    emit(run, { t: 'rise', x: u.x, y: u.y, n: made, inside: u.inside || null });
  }
  return made;
}

// 延迟到点：在倒下处（楼内就在楼内）把行尸放出来，满血
export function stepRise(run, dt) {
  if (!run.riseQueue || !run.riseQueue.length) return;
  for (let i = run.riseQueue.length - 1; i >= 0; i--) {
    const r = run.riseQueue[i];
    r.t -= dt;
    if (r.t > 0) continue;
    run.riseQueue.splice(i, 1);
    const T = run.map.tile;
    const tx = Math.max(0, Math.min(run.map.w - 1, Math.floor(r.x / T)));
    const ty = Math.max(0, Math.min(run.map.h - 1, Math.floor(r.y / T)));
    if (!spawnZombie(run, r.mob, { x: tx, y: ty, track: false })) continue;
    const z = run.zombies[run.zombies.length - 1];
    z.x = r.x; z.y = r.y; z.ox = 0; z.oy = 0;
    // 楼内起身：必须用楼内僵尸的真字段 zInside（z.inside 是「我方单位在楼里」，用错会让它变成打不到的无敌僵尸）
    if (r.inside) { z.zInside = r.inside; z.zInsideAt = run.time; z.path = null; z.pathIdx = 0; z.pathEpoch = -1; }
    if (run.effects.length < 900) run.effects.push({ x: r.x, y: r.y, life: 0.55, max: 0.55, size: 26, rise: true });
    emit(run, { t: 'riseup', x: r.x, y: r.y, side: r.side || 'unit' });
  }
}

function cleanDeadUnits(run) {
  for (let i = run.units.length - 1; i >= 0; i--) {
    const u = run.units[i];
    if (u.hp > 0) continue;
    if (UNITS[u.kind] && UNITS[u.kind].hero) { heroDown(run, u); continue; }
    maybeRise(run, u, u._riseSrc, 'unit');
    // 尸体：躺倒的暗色剪影（载具不躺倒，画成歪斜车体 + 焦黑底）
    {
      const ud = UNITS[u.kind] || {};
      const veh = ud.type === '载具';
      pushDecal(run, {
        k: 'ubody', x: u.x, y: u.y, kind: u.kind, veh,
        rot: veh ? (run.fxRng.next() - 0.5) * 0.8 : (run.fxRng.next() - 0.5) * 0.3,
        s: veh ? 1 : 0.72,
        blood: veh ? null : ((run.fxRng.next() * 3) | 0),
        life: decalLife().ubody, max: decalLife().ubody,
      });
    }
    run.units.splice(i, 1);
    const bdef = (UNITS[u.kind] || {}).boom;
    if (bdef && !u._noBoom) {
      // 只有玩家载具阵亡才算「殉爆」，建筑/工事/僵尸的爆炸不进战报
      const vtag = (UNITS[u.kind] || {}).type === '载具' ? 'vboom' : null;
      scheduleBoom(run, bdef, u.x, u.y, vtag);
    }
    cancelQueueOfSource(run, u.id);
    run.stats.unitLost = (run.stats.unitLost || 0) + 1;
    run.effects.push({ x: u.x, y: u.y, life: 0.3, max: 0.3, size: 16 });
    emit(run, { t: 'ukill', x: u.x, y: u.y, kind: u.kind });
  }
}

// 无尽里程碑：累计击杀跨过档位就发奖 + 抛事件（标准模式不启用）
function nextMilestone(idx) {
  const cfg = RULE.milestone;
  const list = cfg.kills;
  return idx < list.length ? list[idx] : list[list.length - 1] + (idx - list.length + 1) * cfg.step;
}

function checkMilestone(run) {
  if (!run.endless) return;
  if (run.msIdx == null) run.msIdx = 0;
  let guard = 0;
  while (run.stats.kills >= nextMilestone(run.msIdx) && guard++ < 8) {
    const n = nextMilestone(run.msIdx);
    run.msIdx += 1;
    run.parts += RULE.milestone.parts;
    emit(run, { t: 'milestone', n, parts: RULE.milestone.parts });
  }
}

function cleanDead(run) {
  if (run.zombies.length === 0) return;
  let w = 0;
  for (let i = 0; i < run.zombies.length; i++) {
    const z = run.zombies[i];
    if (z.hp > 0) { run.zombies[w++] = z; continue; }
    run.stats.kills++;
    spawnGibs(run, z);
    // 尸体：暗血色剪影，特感按体型放大（暴君再放大一档）
    {
      // 体型取定义表里的 size（实例上的 z.size 不可靠）：行尸 9、壮尸 14、冲锋者 12、暴君 18
      const zdef = ZOMBIES[z.mob] || {};
      const bodySize = zdef.size || z.size || 9;
      // 70% 的尸体带肢体破损：1=缺手臂 2=缺腿 3=断头
      const wound = run.fxRng.next() < 0.7 ? 1 + Math.floor(run.fxRng.next() * 3) : 0;
      const limbA = run.fxRng.next() * Math.PI * 2;
      const limbD = 9 + run.fxRng.next() * 7;
      // 3 秒内被火烧过 ⇒ 焦黑尸体：不铺血泊，改铺一小片灰烬
      const charred = z.burnT != null && run.time - z.burnT < 3;
      if (charred) {
        pushDecal(run, {
          k: 'scorch', x: z.x, y: z.y,
          r: 9 + bodySize * 0.6,
          rot: run.fxRng.next() * Math.PI * 2,
          v: 0, life: decalLife().scorch * 0.6, max: decalLife().scorch * 0.6,
        });
      }
      pushDecal(run, {
        k: 'zbody', x: z.x, y: z.y, mob: z.mob, id: z.id, wound, charred,
        // 断肢落在尸体旁 8~16px，角度随机；6 秒后先淡出（画的时候按 life 判断）
        limbDx: Math.cos(limbA) * limbD,
        limbDy: Math.sin(limbA) * limbD,
        limbRot: (run.fxRng.next() - 0.5) * 3.2,
        rot: (run.fxRng.next() - 0.5) * 2.72,   // ±78°：躺得更横七竖八
        s: Math.min(2.6, bodySize / 11),
        blood: charred ? null : Math.floor(run.fxRng.next() * 3),
        life: decalLife().zbody, max: decalLife().zbody,
      });
    }
    emit(run, { t: 'zdie', x: z.x, y: z.y, mob: z.mob });
  }
  run.zombies.length = w;
}

// 本局技能状态初始化（新开一局时重置）
// 架设 / 收起（G 键或面板按钮）：只对带 deploy 字段的单位生效
// 返回：变更个数；-1 表示选中里没有可架设单位
export function toggleDeploy(run, ids) {
  const set = new Set(ids);
  let ready = 0, changed = 0;
  for (const u of run.units) {
    if (!set.has(u.id) || u.hp <= 0) continue;
    const def = UNITS[u.kind];
    if (!def || !def.deploy) continue;
    if (def.deploy.noInside && u.inside) continue;   // 轻机枪兵：楼里不能架设
    ready++;
    if (u.depOn) { u.depDir = -1; u.depT = 0; u.depOrder = null; changed++; }
    else if (!u.depDir) {
      u.depDir = 1; u.depT = 0;
      u.order = null; u.path = null; u.pathEpoch = -1; u.moving = false;
      changed++;
    }
  }
  return ready ? changed : -1;
}

export function resetSkills(run) {
  run.skills = { strike: 0, fire: 0 };
  run.pending = [];
  run.zones = [];
}

// 释放空袭：回到 {ok, reason}；座标用世界像素
// 空降落点是否合法：可走 + 无单位/工事 + 人口够（不受「距核心建造范围」限制，全图可放）
export function airdropOk(run, tx, ty) {
  if (!run || !run.map) return false;
  const W = run.map.w, H = run.map.h;
  if (!(tx >= 0 && ty >= 0 && tx < W && ty < H)) return false;
  const t = run.map.tiles[ty * W + tx];
  if (!TERRAIN[t] || !TERRAIN[t].walkable) return false;
  if (!tileFree(run, tx, ty)) return false;
  const uk = (SKILLS.airdrop && SKILLS.airdrop.unit) || 'infantry';
  if (popLeft(run) < (UNITS[uk].pop || 0)) return false;
  return true;
}

export function castSkill(run, id, wx, wy) {
  const def = SKILLS[id];
  if (!def) return { ok: false, reason: 'unknown' };
  if (run.phase !== PHASE.PREP && run.phase !== PHASE.BATTLE) return { ok: false, reason: 'phase' };
  const cd = run.skills[id] || 0;
  if (cd > 0) return { ok: false, reason: 'cd', left: cd };
  const cost = def.cost || 0;
  if (cost > 0 && run.supply < cost) return { ok: false, reason: 'supply', need: cost };
  if (id === 'airdrop') {
    // 落点校验必须在扣钱之前，否则放不下也照样扣钱扣 CD
    const atx = Math.floor(wx / run.map.tile), aty = Math.floor(wy / run.map.tile);
    if (!airdropOk(run, atx, aty)) return { ok: false, reason: 'spot' };
  }

  if (cost > 0) run.supply -= cost;
  run.skills[id] = def.cd;
  if (id === 'strike') {
    run.pending.push({
      kind: 'strike', x: wx, y: wy, r: def.radius, dmg: def.dmg,
      left: def.rounds, gap: def.interval, t: def.delay,
      factor: (def.splash && def.splash.factor) || 0.5,
      buildingMul: def.buildingMul || 1,
      vsArmor: def.vsArmor || null,
      raiderMul: def.raiderMul != null ? def.raiderMul : 0.5,
      stun: def.stun || 0,
    });
  } else if (id === 'fire') {
    run.zones.push({
      id: id, x: wx, y: wy, r: def.radius, left: def.duration,
      tick: 0, dps: def.dps, slow: def.slow, gap: def.tick, edge: def.edge || 0.6,
      vsArmor: def.vsArmor || null,
      raiderMul: def.raiderMul != null ? def.raiderMul : 0.5,
    });
    run.effects.push({ x: wx, y: wy, life: 0.5, max: 0.5, size: def.radius * 2, ring: true });
  } else if (id === 'airdrop') {
    const T1 = run.map.tile;
    const atx = Math.floor(wx / T1), aty = Math.floor(wy / T1);
    const uk = def.unit || 'infantry';
    if (spawnAt(run, 'unit', uk, atx, aty)) {
      const u = run.units[run.units.length - 1];
      if (u) { u.invT = def.invSec || 1.2; u.dropT = def.shadowSec || 0.35; }
      const px = (atx + 0.5) * T1, py = (aty + 0.5) * T1;
      run.effects.push({ x: px, y: py, life: 0.45, max: 0.45, size: T1 * 2.4, ring: true });
      for (let i = 0; i < 5; i++) {
        run.effects.push({
          x: px + (i - 2) * 6, y: py + 3,
          life: 0.42 + i * 0.04, max: 0.42 + i * 0.04,
          size: 3.2, vx: (i - 2) * 9, vy: -10, dust: true,
        });
      }
    } else {
      run.supply += cost;              // 理论不会走到，双保险
      run.skills[id] = 0;
      return { ok: false, reason: 'spot' };
    }
  }
  emit(run, { t: 'skill', id, x: wx, y: wy });
  run.stats.skills = (run.stats.skills || 0) + 1;
  return { ok: true };
}

// ---------------- 英雄 ----------------
export function heroOf(run) {
  if (!run || !run.units) return null;
  for (const u of run.units) if (UNITS[u.kind] && UNITS[u.kind].hero && u.hp > 0) return u;
  return null;
}

// 战吼是否还在生效
export function warcryOn(run) {
  return !!(run && run.buzzedUntil && run.time < run.buzzedUntil);
}

// 战吼生效范围：必须是友军 + 技能没结束 + 在指挥官周围半径内。
// 三种收益（伤害 / 移速 / 减伤）必须共用这一个判断，否则会出现
// 「伤害全图加、移速只加圈内」这种口径不一致。
export function warcryInRange(run, u) {
  if (!u || u.side === 'raider' || !warcryOn(run)) return false;
  const h = run._heroRef;
  if (!h || h.hp <= 0) return false;
  return Math.hypot(u.x - h.x, u.y - h.y) <= HERO_SKILLS.warcry.radius;
}

export function warcryDmgMul(run, u) {
  return warcryInRange(run, u) ? HERO_SKILLS.warcry.dmgMul : 1;
}

export function warcrySpeedMul(run, u) {
  return warcryInRange(run, u) ? HERO_SKILLS.warcry.speedMul : 1;
}

// 肾上腺素：只作用于指挥官自己，且与战吼等加速「取最高」，不叠乘
export function adrSpeedMul(run, u) {
  if (!u || u.side === 'raider' || u.inside) return 1;
  return u.adrUntil && run.time < u.adrUntil ? HERO_SKILLS.adrenaline.speedMul : 1;
}

export function heroSpeedMul(run, u) {
  return Math.max(warcrySpeedMul(run, u), adrSpeedMul(run, u));
}

// 手雷：只打僵尸与叛军，不碰我方、不碰建筑（避免隔着墙拆楼）
// 指挥官枪托横扫：敌人贴到身上时优先于开枪，扇形内最多打 maxTargets 只，不吃护甲
export function heroSweep(run, u) {
  const S = RULE.heroSweep || {};
  const reach = (S.reach != null ? S.reach : 20) + (u.r || 8);
  let n = 0;
  const hits = [];   // 命中的僵尸（特效与音效要用）
  for (const z of run.zombies) {
    if (z.hp <= 0) continue;
    const dx = z.x - u.x, dy = z.y - u.y;
    const d = Math.hypot(dx, dy);
    if (d > reach + (z.r || 0)) continue;
    // 只打正面 120°：身后贴脸的不算（避免被打背也白嫖一刀）
    const ang = Math.abs(Math.atan2(dy, dx) - (u.dir || 0));
    const inArc = Math.min(ang, Math.PI * 2 - ang) <= Math.PI / 3;
    // 第一个目标（n === 0，就是最近的那只）不看向：背后的贴脸僵尸也照砍一刀，
    // 这是有意为之——「先打最近的威胁」，不是漏判。
    if (!inArc && n > 0) continue;
    // 护甲：枪托对重甲只算 60%（ZOMBIES[].armor），轻甲/无甲不变
    const rawDmg = S.dmg != null ? S.dmg : 16;
    const zArm = (ZOMBIES[z.mob] && ZOMBIES[z.mob].armor) || 'none';
    const armMul = (S.vsArmor && S.vsArmor[zArm]) || 1;
    const dealt = rawDmg * armMul;
    z.hp -= dealt;
    addFloat(run, z.x, z.y, dealt, false);
    hits.push(z);
    if (d > 0.01) {
      const T = run.map.tile;
      const k = S.knock != null ? S.knock : 12;
      // 钳在地图内：击退不该把人推出地图边或推进建筑格里（下一帧寻路会拉回来，但会闪一下）
      z.x = Math.max(T * 0.5, Math.min((run.map.w - 0.5) * T, z.x + (dx / d) * k));
      z.y = Math.max(T * 0.5, Math.min((run.map.h - 0.5) * T, z.y + (dy / d) * k));
      z.path = null;
      if (S.slow) applySlow(run, z, S.slow);
    }
    if (n === 0 && d > 0.01) u.dir = Math.atan2(dy, dx);
    n++;
    if (n >= (S.maxTargets || 2)) break;
  }
  if (!n) return false;
  u.sweepT = S.cd != null ? S.cd : 0.45;   // 独立冷却：不占用射击节奏
  u.flash = 0.09;
  // 视觉①：120° 扇形擦除（核心辨识度——让人看见「抡了一下」）
  if (run.effects.length < 880) {
    run.effects.push({
      sweep: true, x: u.x, y: u.y, a: u.dir || 0, r: reach, half: Math.PI / 3,
      life: 0.19, max: 0.19, size: reach * 2,
    });
  }
  for (const z of hits) {
    // 视觉③：命中处白色小十字
    if (run.effects.length < 890) {
      run.effects.push({ hit: true, x: z.x, y: z.y, life: 0.09, max: 0.09, size: 11 });
    }
    // 视觉②：沿击退方向甩出两粒尘土
    for (let p = 0; p < 2; p++) {
      if (run.effects.length >= 900) break;
      const sp = 26 + run.fxRng.next() * 34;
      const a1 = Math.atan2(z.y - u.y, z.x - u.x) + (run.fxRng.next() - 0.5) * 1.1;
      run.effects.push({
        dust: true, x: z.x, y: z.y,
        vx: Math.cos(a1) * sp, vy: Math.sin(a1) * sp,
        life: 0.26, max: 0.26, size: 2.2 + run.fxRng.next() * 1.4,
      });
    }
  }
  // 视觉④：音效事件（只有命中才响，空挥不响）
  emit(run, { t: 'melee', x: u.x, y: u.y, n });
  return true;
}

function heroGrenade(run, x, y, cfg) {
  const R = cfg.radius, f = cfg.falloff, dmg = cfg.dmg;
  for (const z of run.zombies) {
    if (z.hp <= 0) continue;
    const d = Math.hypot(z.x - x, z.y - y);
    if (d > R + (z.r || 0)) continue;
    z.hp -= dmg * falloffK(d, R, f);
    addFloat(run, z.x, z.y, dmg * falloffK(d, R, f), false);
    if (cfg.stun) applyZStun(run, z, cfg.stun * (0.5 + 0.5 * falloffK(d, R, f)));
  }
  for (const r of (run.raiders || [])) {
    if (r.hp <= 0) continue;
    const d = Math.hypot(r.x - x, r.y - y);
    if (d > R + r.r) continue;
    const k = falloffK(d, R, f) * (cfg.raiderMul != null ? cfg.raiderMul : 0.8);
    r.hp -= dmg * k;
    addFloat(run, r.x, r.y, dmg * k, false);
  }
  // 友军误伤：手雷是抛物线，落在自己人堆里一样会炸 —— 固定 30%，同样按距离衰减。
  // 走 hurtUnit 才会吃护甲/医疗光环/战吼减伤/空投落地保护（爆炸不该是特例）。
  const ff = cfg.friendlyMul != null ? cfg.friendlyMul : 0.3;
  for (const u of run.units) {
    if (u.hp <= 0 || !UNITS[u.kind]) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d > R + (UNITS[u.kind].r || 0)) continue;
    const k = falloffK(d, R, f) * ff;
    const hit = hurtUnit(run, u, dmg * k, 0, 0, null, true);
    if (hit > 0.05) addFloat(run, u.x, u.y, hit, true);
  }
  // 建筑：只吃一半伤害（友军误伤在上面的 run.units 段），楼塌了照常结算埋人/碎石
  const Tb = run.map.tile;
  const bmul = cfg.buildingMul != null ? cfg.buildingMul : 0.5;
  for (const b of (run.map.buildings || [])) {
    if (!b || b.hp <= 0) continue;
    const x0 = b.x * Tb, y0 = b.y * Tb;
    const nx = Math.max(x0, Math.min(x, x0 + b.w * Tb));
    const ny = Math.max(y0, Math.min(y, y0 + b.h * Tb));
    const d = Math.hypot(x - nx, y - ny);
    if (d > R) continue;
    damageBuilding(run, b, dmg * bmul * falloffK(d, R, f), 0, false);
  }
  if (run.effects.length < 900) {
    run.effects.push({ x, y, life: 0.30, max: 0.30, size: R * 1.4, ring: true });
    for (let i = 0; i < 10 && run.effects.length < 940; i++) {
      const a = run.fxRng.next() * Math.PI * 2, sp = 40 + run.fxRng.next() * 90;
      run.effects.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.34, max: 0.34, size: 2 + run.fxRng.next() * 2, spark: true,
      });
    }
  }
  emit(run, { t: 'boom', x, y, tag: 'grenade' });
}


// ---------------- 钩爪 ----------------
// 直线上有没有东西挡着：按 0.25 格采样，起点自身所在的 2 个采样点跳过
export function grappleClear(run, x0, y0, x1, y1, tailTiles = 0) {
  const T = run.map.tile;
  const blocked = buildBlocked(run, false, false);
  const dist = Math.hypot(x1 - x0, y1 - y0);
  // tailTiles：终点前允许「进墙」的格数（冲建筑时最后一段本来就在墙里）
  const tailPx = tailTiles * T;
  const steps = Math.max(1, Math.ceil(dist / (T * 0.25)));
  for (let i = 2; i <= steps; i++) {
    const k = i / steps;
    if (k * dist > dist - tailPx) break;
    const tx = Math.floor((x0 + (x1 - x0) * k) / T);
    const ty = Math.floor((y0 + (y1 - y0) * k) / T);
    if (tx < 0 || ty < 0 || tx >= run.map.w || ty >= run.map.h) return false;
    if (blocked[ty * run.map.w + tx]) return false;
  }
  return true;
}

// 目标旁边的可站立落点（突进时用）：取离起点最近的一格
function grappleSpotNear(run, z) {
  const T = run.map.tile;
  const cx = Math.floor(z.x / T), cy = Math.floor(z.y / T);
  let best = null, bd = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const tx = cx + dx, ty = cy + dy;
      if (!tileFree(run, tx, ty)) continue;
      const d = Math.hypot((tx + 0.5) * T - z.x, (ty + 0.5) * T - z.y);
      if (d < bd) { bd = d; best = { x: (tx + 0.5) * T, y: (ty + 0.5) * T, tx, ty }; }
    }
  }
  return best;
}

// 落地结算：突进伤害 / 入驻建筑 / 硬直与减伤
function heroGrappleLand(run, u, f) {
  const T = run.map.tile;
  const sk = HERO_SKILLS.grapple;
  u.x = f.x1; u.y = f.y1;
  u.tx = Math.floor(u.x / T); u.ty = Math.floor(u.y / T);
  u.landT = sk.landT;
  u.landDrUntil = run.time + sk.landDrT;
  if (f.mode === 'dash' && f.zid != null) {
    const z = run.zombies.find((o) => o.id === f.zid && o.hp > 0);
    if (z) {
      const zd = ZOMBIES[z.mob] || {};
      const mul = zd.armor === 'heavy' ? (sk.vsArmorHeavy || 1) : 1;
      const dealt = sk.dmg * mul;
      z.hp -= dealt;
      addFloat(run, z.x, z.y, dealt, false, false);
      if (z.mob !== 'behemoth') {
        const nx = z.x - u.x, ny = z.y - u.y, d = Math.hypot(nx, ny) || 1;
        const k = sk.knock || 0;
        z.x = Math.max(T * 0.5, Math.min((run.map.w - 0.5) * T, z.x + (nx / d) * k));
        z.y = Math.max(T * 0.5, Math.min((run.map.h - 0.5) * T, z.y + (ny / d) * k));
        z.path = null;
      }
    }
  } else if (f.mode === 'garrison' && f.bldId != null) {
    const b = f.bldId >= 0 ? run.map.buildings[f.bldId] : null;
    if (b && b.hp > 0) { u.enter = { b, mode: 'in', t: 0.02 }; }   // 走官方读条通道，2 帧内落位
  }
  if (run.effects.length < 900) {
    run.effects.push({ x: u.x, y: u.y, life: 0.32, max: 0.32, size: 22, ring: true });
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI * 2 * i) / 4 + run.fxRng.next() * 0.5;
      run.effects.push({ x: u.x, y: u.y, vx: Math.cos(a) * 46, vy: Math.sin(a) * 46, life: 0.22, max: 0.22, size: 2.6, dust: true });
    }
  }
  emit(run, { t: 'hook', x: u.x, y: u.y, mode: f.mode });
}

// 放英雄技能：返回 {ok} 或 {ok:false, reason}
// 手雷需要 tx/ty（世界像素）；战吼不需要
export function castHeroSkill(run, sid, tx, ty) {
  const sk = HERO_SKILLS[sid];
  if (!sk) return { ok: false, reason: 'bad' };
  const h = heroOf(run);
  if (!h) return { ok: false, reason: 'nohero' };
  if ((run.heroCd[sid] || 0) > 0) return { ok: false, reason: 'cd' };
  if (sid === 'grenade') {
    if (!(tx >= 0 && ty >= 0)) return { ok: false, reason: 'pos' };
    if (Math.hypot(tx - h.x, ty - h.y) > sk.range) return { ok: false, reason: 'range' };
    run.pending.push({
      t: sk.delay, kind: 'grenade', x: tx, y: ty,
      dmg: sk.dmg, r: sk.radius, falloff: sk.falloff,
      raiderMul: sk.raiderMul, buildingMul: sk.buildingMul, friendlyMul: sk.friendlyMul,
    });
  } else if (sid === 'adrenaline') {
    const before = h.hp;
    h.hp = Math.min(h.maxHp, h.hp + h.maxHp * sk.healPct);
    h.adrUntil = run.time + sk.dur;
    const gained = h.hp - before;
    if (gained >= 0.5) addFloat(run, h.x, h.y - ((UNITS[h.kind] || {}).r || 8) - 6, gained, true, false, 'heal');
    if (run.effects.length < 900) run.effects.push({ x: h.x, y: h.y, life: 0.5, max: 0.5, size: 30, ring: true });
  } else if (sid === 'warcry') {
    run.buzzedUntil = run.time + sk.dur;
    // 圈心跟着指挥官走：这里给初始值，stepHero 每帧用实时坐标刷新。
    run._heroRef = { x: h.x, y: h.y, hp: h.hp };
    if (run.effects.length < 900) run.effects.push({ x: h.x, y: h.y, life: 0.5, max: 0.5, size: sk.radius, ring: true });
  } else if (sid === 'grapple') {
    if (!(tx >= 0 && ty >= 0)) return { ok: false, reason: 'pos' };
    const T = run.map.tile;
    if (Math.hypot(tx - h.x, ty - h.y) > sk.range) return { ok: false, reason: 'range' };
    const ttx = Math.floor(tx / T), tty = Math.floor(ty / T);
    const zT = run.zombies.find((z) => z.hp > 0 && z.enter == null
      && Math.hypot(z.x - tx, z.y - ty) <= (z.r || 9) + 8) || null;
    const bld = (ttx >= 0 && tty >= 0 && ttx < run.map.w && tty < run.map.h) ? buildingAt(run, ttx, tty) : null;
    let mode = 'move', x1 = tx, y1 = ty;
    if (zT) {
      const spot = grappleSpotNear(run, zT);
      if (!spot) return { ok: false, reason: 'pos' };
      mode = 'dash'; x1 = spot.x; y1 = spot.y;
    } else if (bld && bld.hp > 0) {
      if (garrisonUsed(run, bld) >= garrisonCap(bld)) return { ok: false, reason: 'full' };
      const spot = garrisonFreeSpot(run, bld, h.x, h.y);
      if (!spot) return { ok: false, reason: 'full' };
      mode = 'garrison'; x1 = spot.x; y1 = spot.y;
    } else if (!tileFree(run, ttx, tty)) {
      return { ok: false, reason: 'pos' };
    }
    if (!grappleClear(run, h.x, h.y, x1, y1, mode === 'garrison' ? 1.4 : 0)) return { ok: false, reason: 'blocked' };
    h.order = null; h.path = null; h.pathIdx = 0; h.moving = false;
    h.hookFly = {
      x0: h.x, y0: h.y, x1, y1, t: 0, dur: sk.flyT, mode,
      zid: zT ? zT.id : null, bldId: (mode === 'garrison' && bld) ? run.map.buildings.indexOf(bld) : -1,
    };
  }
  run.heroCd[sid] = sk.cd;
  emit(run, { t: 'heroskill', id: sid, x: h.x, y: h.y });
  return { ok: true };
}

// 解雇指挥官：主动撤离，不结算阵亡、不返钱；unique 名额立刻释放，
// 之后可以回据点重新招募（按当前价格，240 资金 + 30 零件）。

// 英雄倒地：不真死、不殉爆，扣经验后进重伤队列
function heroDown(run, u) {
  const R = RULE.hero || {};
  u.adrUntil = 0;
  const before = u.rank || 0;
  const xpLoss = R.downXp || 15;
  u.xp = Math.max(0, (u.xp || 0) - xpLoss);
  let rank = 0;
  const th = (RULE.rank && RULE.rank.xp) || [12, 50];
  if (u.xp >= th[1]) rank = 2; else if (u.xp >= th[0]) rank = 1;
  run.heroDowns = (run.heroDowns || 0) + 1;
  const wait = Math.min(R.respawnMax || 180, (R.respawnSec || 90) + (run.heroDowns - 1) * (R.respawnStep || 30));
  run.heroDown = { kind: u.kind, x: u.x, y: u.y, xp: u.xp, rank, respawnAt: run.time + wait, wait };
  // 从 units 里摘掉（不触发 uKill 统计/殉爆/转行尸）
  const i = run.units.indexOf(u);
  if (i >= 0) run.units.splice(i, 1);
  cancelQueueOfSource(run, u.id);
  addTextFloat(run, u.x, u.y, '重伤');
  emit(run, { t: 'herodown', id: u.id, x: u.x, y: u.y, rank: before, nextRank: rank, xp: u.xp, wait, loss: xpLoss });
}

// 每帧：技能冷却、战吼到期、英雄重生
function stepHero(run, dt) {
  for (const k of Object.keys(run.heroCd)) {
    if (run.heroCd[k] > 0) run.heroCd[k] = Math.max(0, run.heroCd[k] - dt);
  }
  const h = heroOf(run);
  if (h) run._heroRef = { x: h.x, y: h.y, hp: h.hp };
  else if (!warcryOn(run)) run._heroRef = null;
  const d = run.heroDown;
  if (!d) return;
  if (run.time < d.respawnAt) return;
  run.heroDown = null;
  // 在据点旁边找个空位放回来，满血、按扣过经验的军衔重算上限
  const T = run.map.tile;
  const cx = Math.round(run.core.x), cy = Math.round(run.core.y);
  let spot = null;
  // 整圈扫描（不是只扫 8 个方向）：据点周围被建筑和单位围满时也能找到落脚点
  for (let rad = 1; rad <= 6 && !spot; rad++) {
    for (let dy = -rad; dy <= rad && !spot; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;  // 只走这一圈
        const tx = cx + dx, ty = cy + dy;
        if (tx < 1 || ty < 1 || tx >= run.map.w - 1 || ty >= run.map.h - 1) continue;
        const t = run.map.tiles[ty * run.map.w + tx];
        if (!TERRAIN[t] || !TERRAIN[t].walkable) continue;
        if (!tileFree(run, tx, ty)) continue;
        spot = { tx, ty };
        break;
      }
    }
  }
  if (!spot) { run.heroDown = d; d.respawnAt = run.time + 2; return; }   // 没地方就 2 秒后再试
  const def = UNITS[d.kind];
  const n0 = run.units.length;
  // 复活是「归队」不是「再造一次」：直接 spawnAt，不走 placeAt 的建造校验
  // （建造校验有「据点 N 格内 / 人口 / unique 名额」，据点周围一被围满就永远放不回来，
  //   玩家看到的就是「第二次倒地后再也没回来」）
  const ok = spawnAt(run, 'unit', d.kind, spot.tx, spot.ty);
  if (!ok || run.units.length <= n0) { run.heroDown = d; d.respawnAt = run.time + 2; return; }
  const u = run.units[run.units.length - 1];
  u.xp = d.xp; u.rank = d.rank || 0;
  u.maxHp = Math.round(def.hp * unitHpMul(u) * perkMul(run, 'hp', 1.2));
  u.hp = u.maxHp;
  // spawnAt 遇到同格站定单位会顺延一格，所以以它落地的格子为准（别硬写回 spot）
  u.x = (u.tx + 0.5) * T; u.y = (u.ty + 0.5) * T;
  u.px = u.x; u.py = u.y;
  run._heroRef = { x: u.x, y: u.y, hp: u.hp };
  emit(run, { t: 'heroback', x: u.x, y: u.y, rank: u.rank });
}

function tickSkills(run, dt) {
  for (const id of Object.keys(run.skills)) {
    if (run.skills[id] > 0) run.skills[id] = Math.max(0, run.skills[id] - dt);
  }
  // 炮击：按间隔落轮
  for (let i = run.pending.length - 1; i >= 0; i--) {
    const p = run.pending[i];
    p.t -= dt;
    if (p.t > 0) continue;
    if (p.kind === 'grenade') {
      heroGrenade(run, p.x, p.y, {
        dmg: p.dmg, radius: p.r, falloff: p.falloff,
        raiderMul: p.raiderMul, buildingMul: p.buildingMul, friendlyMul: p.friendlyMul,
        stun: p.stun,
      });
      run.pending.splice(i, 1);
      continue;
    }
    if (p.kind === 'acid') {
      const ac = p.acid || {};
      const edge = ac.edge != null ? ac.edge : 0.7;
      for (const u of run.units) {
        if (u.hp <= 0) continue;
        if (!UNITS[u.kind] || Math.hypot(u.x - p.x, u.y - p.y) > p.r + UNITS[u.kind].r) continue;
        // 酸液对载具双倍（专门克制重甲）；先上减速再结算伤害
        const vehMul = UNITS[u.kind].type === '载具' ? 2 : 1;
        applyUnitSlow(run, u, ac.unitSlow, ac.slowT);
        hurtUnit(run, u, p.dmg * vehMul * falloffK(Math.hypot(u.x - p.x, u.y - p.y), p.r, edge), 0, p.pen);
      }
      for (const r of (run.raiders || [])) {
        if (r.hp <= 0) continue;
        const rd = UNITS[r.kind];
        if (!rd) continue;
        const dd = Math.hypot(r.x - p.x, r.y - p.y);
        if (dd > p.r + rd.r) continue;
        const vehMul = rd.type === '载具' ? 2 : 1;
        applyUnitSlow(run, r, ac.unitSlow, ac.slowT);
        hurtUnit(run, r, p.dmg * vehMul * falloffK(dd, p.r, edge), 0, p.pen);
      }
      run.zones.push({
        x: p.x, y: p.y, r: p.r, dps: ac.dps || 12, left: ac.dur || 4,
        tick: 0, gap: ac.gap || 0.25, edge,
        side: 'enemy', slow: ac.allySlow != null ? ac.allySlow : 0.8, vsVehicle: ac.vsVehicle || 1.5,
        unitSlow: ac.unitSlow, slowT: ac.slowT, allyMul: ac.allyMul != null ? ac.allyMul : 0.05,
      });
      run.effects.push({ x: p.x, y: p.y, life: 0.34, max: 0.34, size: p.r * 1.3, ring: true });
      for (let n = 0; n < 5 && run.effects.length < 240; n++) {
        const a = run.fxRng.next() * Math.PI * 2, sp2 = 30 + run.fxRng.next() * 70;
        run.effects.push({
          x: p.x, y: p.y, vx: Math.cos(a) * sp2, vy: Math.sin(a) * sp2,
          life: 0.4, max: 0.4, size: 2.6, gib: true, rot: 0, acidDrop: true,
        });
      }
      run.pending.splice(i, 1);
      continue;
    }
    for (const z of run.zombies) {
      if (z.hp <= 0) continue;
      const d = Math.hypot(z.x - p.x, z.y - p.y);
      if (d > p.r) continue;
      const k = falloffK(d, p.r, p.factor != null ? p.factor : 0.5) * zArmorMul(p, z);
      z.hp -= p.dmg * k;
      addFloat(run, z.x, z.y, p.dmg * k, false);
      if (p.stun) applyZStun(run, z, p.stun * (0.5 + 0.5 * falloffK(d, p.r, p.factor != null ? p.factor : 0.5)));
    }
    // 叛军也吃炮击，但只吃 raiderMul（默认 50%）
    const rmul = p.raiderMul != null ? p.raiderMul : 0.5;
    for (const r of (run.raiders || [])) {
      if (r.hp <= 0) continue;
      const rd = UNITS[r.kind];
      if (!rd) continue;
      const dr = Math.hypot(r.x - p.x, r.y - p.y);
      if (dr > p.r + rd.r) continue;
      const k2 = falloffK(dr, p.r, p.factor != null ? p.factor : 0.5) * rmul;
      hurtUnit(run, r, p.dmg * k2, 0, 0);
    }
    friendlyHit(run, null, p.x, p.y, p.r, p.dmg, p.factor != null ? p.factor : 0.5);
    splashBuilding(run, p.dmg, p.factor, p.buildingMul, p.x, p.y);
    const ox = p.x + (run.fxRng.next() - 0.5) * p.r * 1.1;
    const oy = p.y + (run.fxRng.next() - 0.5) * p.r * 1.1;
    // 每轮落弹在地面留一个弹坑（半径 22~30 随机、10 秒），9 轮就是一小片弹坑群
    pushDecal(run, {
      k: 'scorch', crater: true, x: ox, y: oy,
      r: 22 + run.fxRng.next() * 8,
      rot: run.fxRng.next() * Math.PI * 2,
      v: Math.floor(run.fxRng.next() * 3),
      life: 10, max: 10,
    });
    run.effects.push({ x: ox, y: oy, life: 0.3, max: 0.3, size: 40, ring: true });
    for (let n = 0; n < 4 && run.effects.length < 220; n++) {
      const a = run.fxRng.next() * Math.PI * 2, sp = 40 + run.fxRng.next() * 90;
      run.effects.push({
        x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.35, max: 0.35, size: 2.5, gib: true, rot: 0,
      });
    }
    emit(run, { t: 'boom', x: ox, y: oy, r: 40 });
    if (run.shake !== undefined) run.shake = 0.25;
    p.left -= 1;
    p.t = p.gap;
    if (p.left <= 0) run.pending.splice(i, 1);
  }
  // 燃烧弹：度时间内按 tick 造成伤害
  for (let i = run.zones.length - 1; i >= 0; i--) {
    const z2 = run.zones[i];
    z2.left -= dt;
    z2.tick -= dt;
    if (z2.tick <= 0) {
      z2.tick = z2.gap;
      const edge = z2.edge != null ? z2.edge : 0.6;
      if (z2.side === 'enemy') {
        // 敌方酸液：主力打我方单位，僵尸同伴只吃 allyMul（默认 5%），减速走 slowFactor
        const allyMul = z2.allyMul != null ? z2.allyMul : 0.05;
        for (const u of run.units) {
          if (u.hp <= 0) continue;
          const d = Math.hypot(u.x - z2.x, u.y - z2.y);
          if (!UNITS[u.kind] || d > z2.r + UNITS[u.kind].r) continue;
          applyUnitSlow(run, u, z2.unitSlow, z2.slowT);
          const acidVeh = UNITS[u.kind].type === '载具' ? (z2.vsVehicle || 1.5) : 1;
          hurtUnit(run, u, z2.dps * z2.gap * acidVeh * falloffK(d, z2.r, edge), 0, 0);
        }
        for (const r of (run.raiders || [])) {
          if (r.hp <= 0) continue;
          const rd = UNITS[r.kind];
          if (!rd) continue;
          const dd = Math.hypot(r.x - z2.x, r.y - z2.y);
          if (dd > z2.r + rd.r) continue;
          applyUnitSlow(run, r, z2.unitSlow, z2.slowT);
          const acidVehR = rd.type === '载具' ? (z2.vsVehicle || 1.5) : 1;
          hurtUnit(run, r, z2.dps * z2.gap * acidVehR * falloffK(dd, z2.r, edge), 0, 0);
        }
        for (const z of run.zombies) {
          if (z.hp <= 0) continue;
          const d = Math.hypot(z.x - z2.x, z.y - z2.y);
          if (d > z2.r) continue;
          z.hp -= z2.dps * allyMul * z2.gap * falloffK(d, z2.r, edge);
        }
      } else {
        for (const z of run.zombies) {
          if (z.hp <= 0) continue;
          const d = Math.hypot(z.x - z2.x, z.y - z2.y);
          if (d > z2.r) continue;
          const zdmg = z2.dps * z2.gap * falloffK(d, z2.r, edge) * zArmorMul(z2, z);
          z.hp -= zdmg;
          if (z.hp <= 0) creditFlameKill(run, z2.owner, z);
          z.burnT = run.time;   // 站在火里 ⇒ 记一笔燃烧时间
          // 燃烧区每 0.25~0.4 秒跳一次伤害，飘字按 50 帧限流，避免一屏数字
          if (!z._fxF || run.frame - z._fxF > 50) { z._fxF = run.frame; addFloat(run, z.x, z.y, Math.round(zdmg), false); }
        }
        // 叛军也吃燃烧瓶，但只吃 raiderMul（默认 50%）
        const rmk = z2.raiderMul != null ? z2.raiderMul : 0.5;
        for (const r of (run.raiders || [])) {
          if (r.hp <= 0) continue;
          const rd = UNITS[r.kind];
          if (!rd) continue;
          const dr = Math.hypot(r.x - z2.x, r.y - z2.y);
          if (dr > z2.r + rd.r) continue;
          hurtUnit(run, r, z2.dps * z2.gap * falloffK(dr, z2.r, edge) * rmk, 0, 0);
        }
        friendlyHit(run, z2.owner != null ? z2.owner : null, z2.x, z2.y, z2.r, z2.dps * z2.gap, edge);
      }
    }
    if (run.effects.length < 240 && run.fxRng.next() < 0.35) {
      const a = run.fxRng.next() * Math.PI * 2, rr = Math.sqrt(run.fxRng.next()) * z2.r;
      run.effects.push({
        x: z2.x + Math.cos(a) * rr, y: z2.y + Math.sin(a) * rr,
        life: 0.3, max: 0.3, size: 8 + run.fxRng.next() * 10, fire: true,
      });
    }
    if (z2.left <= 0) run.zones.splice(i, 1);
  }
}


// 特效与伤害数字的每帧推进（布防期也要跑，否则停在上一波的最后一帧）

// 统一的命中结算：落点 (x,y)，范围伤害按距离衰减

// 玩家范围伤害波及建筑：一发只结算落点那一栋，系数 friendlyFire.building（不吃重甲）
function splashBuilding(run, dmg, factor, buildingMul, x, y) {
  const ff = RULE.friendlyFire;
  if (!ff || ff.on === false) return;
  const mul = ff.building || 0;
  if (mul <= 0) return;
  const T = run.map.tile;
  const b = buildingAt(run, Math.floor(x / T), Math.floor(y / T));
  if (!b || b.hp <= 0) return;
  const f = factor == null ? 0.5 : factor;
  const bm = buildingMul || 1;
  damageBuilding(run, b, dmg * f * mul * bm, 0, true);
}

export function hitAt(run, owner, def, x, y) {   // 导出供 tools 自测（ff-check）
  // 整备期我方火力补正（僵尸在整备期也会行动，给玩家清残敌的窗口）
  const dmul = run.phase === PHASE.PREP ? (RULE.prep.unitDmgMul || 1) : 1;
  const crit = rollCrit(run, def);   // 整次开火只 roll 一次，溅射整片同倍率
  const isCrit = crit > 1;
  // 军衔伤害加成放在 hitAt 里：抛射落地也走这里，保证只乘一次
  const rkMul = owner ? unitDmgMul(owner) * warcryDmgMul(run, owner) : 1;
  let xpGain = 0;
  if (def.splash) {
    const R = def.splash.radius, f = def.splash.factor;
    let killed = 0;
    for (const z of run.zombies) {
      if (z.hp <= 0) continue;
      const dz = Math.hypot(z.x - x, z.y - y);
      if (dz > R) continue;
      const k = falloffK(dz, R, f) * zArmorMul(def, z, run);
      z.hp -= def.dmg * dmul * rkMul * k * crit;
      if (def.fx === 'flame') z.burnT = run.time;   // 火焰伤害：3 秒内死就是焦黑尸体
      if (def.slow) applySlow(run, z, def.slow);
      if (def.stun) applyZStun(run, z, def.stun * (0.5 + 0.5 * falloffK(dz, R, f)));
      if (owner && owner.id != null) z.hitBy = { id: owner.id, t: run.time };
      addFloat(run, z.x, z.y, def.dmg * rkMul * k * crit, false, isCrit);   // 飘字要含军衔/战吼倍率
      if (z.hp <= 0) { killed++; xpGain += zXpWeight(z.mob); }
    }
    for (const r of (run.raiders || [])) {
      if (r.hp <= 0) continue;
      const dr = Math.hypot(r.x - x, r.y - y);
      if (dr > R) continue;
      const kr = falloffK(dr, R, f);
      // 反载具加成（vsRaiderVehicle）：狙击/火箭筒/坦克对叛军装甲车有专精倍率
      const rvMul = (def.vsRaiderVehicle && r.kind === 'vehicle') ? def.vsRaiderVehicle : 1;
      r.hp -= def.dmg * dmul * rkMul * kr * rvMul * crit;
      addFloat(run, r.x, r.y, def.dmg * rkMul * kr * crit, false, isCrit);
      if (r.hp <= 0) { killed++; xpGain += raiderXpWeight(r); }
    }
    if (owner) owner.kills += killed;
    if (owner) addUnitXp(run, owner, xpGain);
    friendlyHit(run, owner ? owner.id : null, x, y, R, def.dmg, f);
    splashBuilding(run, def.dmg, f, def.buildingMul, x, y);
    emit(run, { t: 'boom', x, y, r: R, tag: def.boomTag || null });
    return;
  }
  // 单体：找落点附近最近的僵尸
  let best = null, bd = Infinity;
  for (const z of run.zombies) {
    if (z.hp <= 0) continue;
    const d = (z.x - x) ** 2 + (z.y - y) ** 2;
    if (d <= 26 * 26 && d < bd) { bd = d; best = z; }
  }
  // 叛军也吃单体火力（护甲按自身 kind 走，不扣僵尸那套 vsArmor）
  let bestR = null, bdr = Infinity;
  for (const r of (run.raiders || [])) {
    if (r.hp <= 0) continue;
    const d = (r.x - x) ** 2 + (r.y - y) ** 2;
    if (d <= 26 * 26 && d < bdr) { bdr = d; bestR = r; }
  }
  if (!best && bestR) {
    // 反载具加成（vsRaiderVehicle）：狙击/火箭筒/坦克对叛军装甲车有专精倍率
    const rvMul = (def.vsRaiderVehicle && bestR.kind === 'vehicle') ? def.vsRaiderVehicle : 1;
    const dealt = def.dmg * dmul * rkMul * armorMul(bestR.armor || 'none', 0) * rvMul * crit;
    bestR.hp -= dealt;
    addFloat(run, bestR.x, bestR.y, dealt, false, isCrit);
    if (owner && bestR.hp <= 0) {
      owner.kills += 1;
      addUnitXp(run, owner, raiderXpWeight(bestR));
    }
    return;
  }
  if (!best) return;
  const m1 = zArmorMul(def, best, run);
  best.hp -= def.dmg * dmul * rkMul * m1 * crit;
  if (def.fx === 'flame') best.burnT = run.time;   // 同上
  if (def.slow) applySlow(run, best, def.slow);
  if (owner && owner.id != null) best.hitBy = { id: owner.id, t: run.time };
  addFloat(run, best.x, best.y, def.dmg * rkMul * m1 * crit, false, isCrit);   // 同上：显示实际伤害
  if (owner && best.hp <= 0) {
    owner.kills += 1;
    addUnitXp(run, owner, zXpWeight(best.mob));
  }
}

// 抛射物落地：结算伤害 + 爆炸环
function impactAt(run, e) {
  const hit = e.impact;
  if (!hit) return;
  const owner = run.units.find((u) => u.id === hit.ownerId) || null;
  const wdef = (owner && UNITS[owner.kind]) || (hit.kind && UNITS[hit.kind]) || null;
  const fake = {
    splash: hit.splash, dmg: hit.dmg,
    vsArmor: wdef ? wdef.vsArmor : null,
    specBonus: wdef ? wdef.specBonus : null,
    // 抛射落点也要带反载具加成，否则坦克/火箭筒的 vsRaiderVehicle 在 impactAt 里丢失
    vsRaiderVehicle: wdef ? wdef.vsRaiderVehicle : null,
    // 眩晕/减速同理：迫击炮、自行火炮都是抛射，不带过来就永远不生效
    stun: wdef ? wdef.stun : null,
    slow: wdef ? wdef.slow : null,
  };
  hitAt(run, owner, fake, e.x2, e.y2);
  const R = hit.splash ? hit.splash.radius : 16;
  run.effects.push({ x: e.x2, y: e.y2, life: 0.32, max: 0.32, size: R * 2, ring: true });
  for (let i = 0; i < 4 && run.effects.length < 900; i++) {
    const a = run.fxRng.next() * Math.PI * 2, sp = 40 + run.fxRng.next() * 60;
    run.effects.push({
      gib: true, x: e.x2, y: e.y2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      size: 1.6 + run.fxRng.next() * 1.6, rot: 0, life: 0.45, max: 0.45, ember: true,
    });
  }
}

function stepDecals(run, dt) {
  const d = run.decals;
  if (!d || !d.length) return;
  for (let i = d.length - 1; i >= 0; i--) {
    d[i].life -= dt;
    if (d[i].life <= 0) d.splice(i, 1);
  }
}

function stepFx(run, dt) {
  stepDecals(run, dt);
  // 大场面兜底：特效/尸块数量封顶，避免长时间战斗内存与绘制压力线性增长
  if (run.effects.length > 900) run.effects.splice(0, run.effects.length - 900);

  for (let i = run.effects.length - 1; i >= 0; i--) {
    const e = run.effects[i];
    e.life -= dt;
    if (e.gib || e.dust) {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vx *= 0.90;
      e.vy *= 0.90;
      e.rot = (e.rot || 0) + dt * 6;
    }
    if (e.life <= 0) {
      if (e.impact) impactAt(run, e);
      else if (e.boom) boomAt(run, e.boom, e.x, e.y, e.tag);
      else if (e.boomR) run.effects.push({ x: e.x2, y: e.y2, life: 0.32, max: 0.32, size: e.boomR * 2, ring: true });
      run.effects.splice(i, 1);
    }
  }
  for (let i = run.floats.length - 1; i >= 0; i--) {
    const f = run.floats[i];
    f.life -= dt;
    f.y -= 16 * dt;
    if (f.life <= 0) run.floats.splice(i, 1);
  }
}

export function stepRun(run, dt, snap) {
  buildTargetGrid(run);
  // 核心升级三选一：窗口结束自动选第一张（不阻塞游戏推进）
  if (run.pendingPerk) {
    run.pendingPerk.t -= dt;
    if (run.pendingPerk.t <= 0) pickPerk(run, 0, true);   // 超时：自动选第一张，事件带 auto
  }

  // 渲染插值（A2）：记下"这一帧开始前"的位置，main.js 用 acc/stepDt 在它与当前值之间插值。
  // snap=false 表示本帧已经跑过至少一步 —— 此时绝不能重记，否则掉帧（一帧跑 N 步）时
  // px/py 会被覆写成倒数第二步的起点，画面等于每帧只插最后一步、整体时间点前后跳 = 抽搐。
  // 僵尸同样要插值：尸潮掉帧时它一帧能跑好几步（每步 ≈0.9px），不插值就是整段跳过去。
  if (snap !== false) {
    for (let i = 0; i < run.units.length; i++) { const u = run.units[i]; u.px = u.x; u.py = u.y; }
    if (run.raiders) for (let i = 0; i < run.raiders.length; i++) { const r = run.raiders[i]; r.px = r.x; r.py = r.y; }
    const zs = run.zombies;
    for (let i = 0; i < zs.length; i++) { const z = zs[i]; z.px = z.x; z.py = z.y; }
  }
  // 建筑表变化时重建瓦片索引（编辑器/测试会动态增删楼，_bTile 过期会让 buildingAt 失效）
  if (run._bCount !== run.map.buildings.length) {
    indexBuildings(run);
    run._bCount = run.map.buildings.length;
  }
  // 兜底：清掉任何不在表里的单位/僵尸（存档、编辑器导入、旧版本数据都可能带进来）
  if (run.units.some((u) => !UNITS[u.kind])) run.units = run.units.filter((u) => UNITS[u.kind]);
  if (run.zombies.some((z) => !ZOMBIES[z.mob])) run.zombies = run.zombies.filter((z) => ZOMBIES[z.mob]);

  // 兜底：任何路径把工事打成 hp<=0，都在这一帧清出数组，避免脏索引
  if (run.forts.some((f) => f.hp <= 0)) {
    for (const f of run.forts) {
      if (f.hp > 0) continue;
      const fb = FORTS[f.kind] && FORTS[f.kind].boom;
      if (fb && !f._boomed) { f._boomed = true; scheduleBoom(run, fb, f.x, f.y); }
      spillGarrison(run, f.room);
    }
    run.forts = run.forts.filter((f) => f.hp > 0);
    rebuildForts(run);
    bumped(run);
  }

  stepHero(run, dt);
  if (run.phase === PHASE.WON || run.phase === PHASE.LOST) return run;
  // 无尽模式：达成目标（击杀 + 同时占点）立刻胜利；标准模式不受影响
  if (run.endless) {
    const G = RULE.endlessGoal;
    if (G && run.stats.kills >= G.kills && (run.nodes || []).filter((n) => n.owner === 1).length >= G.nodes) {
      run.phase = PHASE.WON;
      emit(run, { t: 'win' });
      return run;
    }
  }
  run.frame++;
  run.time += dt;

  if (run.phase === PHASE.PREP) {
    econTick(run, dt);
    updateNodes(run, dt);
    run.prepTimer -= dt;
    tickSkills(run, dt);
    healAuras(run, dt);
    tickQueue(run, dt);
    stepFx(run, dt);
    // 整备期僵尸不再定格：上一波的残敌继续推进/拆楼/咬人（只是不刷新波次）
    processPaths(run);
    for (let i = 0; i < run.units.length; i++) run.units[i]._bite = 0;
    reindexUnits(run, dt);
    stepMines(run);
    for (let i = 0; i < run.zombies.length; i++) updateZombie(run, run.zombies[i], dt);
    updateUnits(run, dt);
    if (run.raiderOn) stepRaiders(run, dt);
    settleUnits(run);
    cleanDeadUnits(run);
    stepRise(run, dt);
    cleanDead(run);
    run.stats.peak = Math.max(run.stats.peak, run.zombies.length);
    if (run.core.hp <= 0) { run.phase = PHASE.LOST; emit(run, { t: 'lose' }); return run; }
    if (run.prepTimer <= 0) startBattle(run);
    return run;
  }

  run.waveTimer += dt;
  econTick(run, dt);
  updateNodes(run, dt);
  spawnDue(run);
  tickQueue(run, dt);
  processPaths(run);
  healAuras(run, dt);
  tickSkills(run, dt);
  stepFx(run, dt);

  for (let i = 0; i < run.units.length; i++) run.units[i]._bite = 0;
  reindexUnits(run, dt);
  stepMines(run);   // 雷区：僵尸踩进半径就引爆，爆完即毁（一次性）
  for (let i = 0; i < run.zombies.length; i++) updateZombie(run, run.zombies[i], dt);
  updateUnits(run, dt);
  if (run.raiderOn) stepRaiders(run, dt);
  cleanDeadUnits(run);
  stepRise(run, dt);
  cleanDead(run);
  checkMilestone(run);

  run.stats.peak = Math.max(run.stats.peak, run.zombies.length);

  if (run.core.hp <= 0) { run.phase = PHASE.LOST; emit(run, { t: 'lose' }); return run; }

  // 卡死看门狗：某波打超过预计时长很久、且 25 秒内一只没死，就强制重置所有僵尸的目标与路径，
  // 避免「拆工事 / 走路」来回跳导致波次永不结束。
  if (run.phase === PHASE.BATTLE && run.wave) {
    const lastK = run.stats.kills;
    if (lastK !== run._killsMark) { run._killsMark = lastK; run._killMarkT = run.time; }
    const stuckT = run.time - (run._killMarkT || 0);
    const waveLong = run.waveTimer > (run.wave.duration || 40) + 90;
    // 每 30 秒最多重置一次（原来「一波只允许一次」，同一波第二次卡死就永远卡住不会自愈）
    if (waveLong && stuckT > 25 && run.time - (run.aggroResetT || 0) > 30) {
      run.aggroResetT = run.time;
      for (const z of run.zombies) {
        if (z.roamer) continue;
        z.hitBy = null; z.target = null; z.mode = 'move';
        z.path = null; z.pathEpoch = -1; z.pathIdx = 0;
      }
      run.warnings.push('wave-stall-reset');
    }
  }

  // 游荡僵尸不算在波次里，否则不会结束
  const waveLeft = run.zombies.some((z) => !z.roamer);
  const allSpawned = run.wave && run.wave.spawns.every((s) => s.fired);
  const cleared = !!allSpawned && !waveLeft;
  // 时间制：刷怪出完后到时自动进下一波（残敌留场继续施压）
  const timedOut = !!allSpawned && !cleared && run.waveTimer >= (run.wave.duration || 40);
  const isFinalWave = (run.waveIndex || 0) >= run.totalWaves;
  // 最后一波必须清完，不能靠时间混过去
  if (run.wave && allSpawned && (cleared || (timedOut && !isFinalWave))) {
    // 奖励口径 A：清完才给清波资金+零件；到点只给升级
    const lateNoClear = (run.waveIndex || 0) >= (RULE.econ.lateWaveNoClear || 99);
    // 到点保底：给 50% 清波资金（不给零件），避免「清不完 -> 没钱 -> 更清不完」的雪球
    const timeoutCash = Math.round(RULE.supply.clearWave * (RULE.supply.timeoutCashRatio || 0));
    if (!lateNoClear) {
      const cash = cleared ? Math.round(RULE.supply.clearWave * perkMul(run, 'supply', 1.4)) : timeoutCash;
      if (cash > 0) run.supply = Math.min(supplyCap(run), run.supply + cash);
    }
    if (cleared) run.parts += RULE.econ.clearParts;          // 清波零件
    if (cleared || timedOut) maybeOfferPerk(run);            // 核心升级三选一（第 1/3/5/7 波；清不完超时推进也算）
    run.coreLevel = Math.min(RULE.pop.maxLevel, (run.coreLevel || 1) + 1);   // 核心升级（同时抬高资金上限）
    if (cleared || timedOut) run.stats.wavesCleared = run.waveIndex;
    emit(run, cleared
      ? { t: 'clear', n: run.waveIndex }
      : { t: 'timeout', n: run.waveIndex, left: run.zombies.filter((z) => !z.roamer).length });
    if (cleared && run.waveIndex >= run.totalWaves) {
      run.phase = PHASE.WON;
      emit(run, { t: 'win' });
      return run;
    }
    run.waveIndex++;
    run.riseCount = 0; run.waveSpawnedHp = 0;
    // 无尽模式的两个缓冲：核心回血 + 定期补给，否则被指数压力磨死没有翻盘空间
    if (run.endless) {
      if (run.waveIndex % 3 === 0 && run.core.hp < run.core.maxHp) {
        const heal = Math.round(run.core.maxHp * 0.06);
        run.core.hp = Math.min(run.core.maxHp, run.core.hp + heal);
        emit(run, { t: 'coreheal', amt: heal });
      }
      if (run.waveIndex % 5 === 0) {
        const bonus = Math.round(RULE.supply.clearWave * 1.5);
        run.supply = Math.min(supplyCap(run), run.supply + bonus);
        emit(run, { t: 'bonus', amt: bonus });
      }
    }
    run.wave = createWave(run, run.waveIndex);
    run.waveTimer = 0;
    run.swapUsed = 0;        // 新的一波：兑换次数重置
    run.phase = PHASE.PREP;
    run.prepTimer = RULE.prep.intermission;
  }
  return run;
}

// ---------------- 生产源（建筑才能造兵） ----------------
export function sourceOf(run, srcId) {
  if (!srcId || srcId === 'core') {
    return { id: 'core', name: '指挥据点', produces: CORE_PROD.produces, x: run.core.x, y: run.core.y, tile: run.map.tile };
  }
  const su = unitSource(run, srcId);
  if (su) {
    const ud = UNITS[su.kind];
    return {
      id: su.id, name: ud.name, produces: ud.produces || [],
      x: su.tx, y: su.ty, tile: run.map.tile, unit: su,
      deployRadius: ud.buildRadius || 2,
    };
  }
  const f = run.forts.find((x) => x.id === srcId && x.hp > 0);
  if (!f) return null;
  const def = FORTS[f.kind];
  return { id: f.id, name: def.name, produces: def.produces || [], x: Math.floor(f.x / run.map.tile), y: Math.floor(f.y / run.map.tile), tile: run.map.tile, fort: f };
}

// 退款专用：退回的钱**不受**本局资金上限截断。
// 收入类（经济/资源点/波次奖励）仍然走 Math.min(supplyCap(...))，
// 但「取消建造 / 拆建筑」是把已经花出去的还回来，钱满时截断会直接蒸发。
export function addCash(run, cash) {
  if (!(cash > 0)) return 0;
  run.supply += cash;
  return cash;
}

// 本局资金上限：核心等级越高，能囤的钱越多
export function supplyCap(run) {
  const lv = (run && run.coreLevel) || 1;
  const base = RULE.supply.capBase != null ? RULE.supply.capBase : 9999;
  const per = RULE.supply.capPerLevel || 0;
  const hard = RULE.supply.capMax || RULE.supply.cap || 9999;
  return Math.min(hard, base + per * lv);
}

// 单位在「第几波」解锁（默认第 1 波就能造）
export function unlockWaveOf(id) {
  const def = UNITS[id];
  return (def && def.unlockWave) || 1;
}

// 当前是否已经解锁（开场 waveIndex=0，清掉第 1 波后 waveIndex=1）
export function isUnlocked(run, id) {
  if (!UNITS[id]) return true;
  const need = unlockWaveOf(id);
  return ((run.waveIndex || 0) + 1) >= need;
}

// 该源能不能造这个物件
export function canProduce(run, srcId, id) {
  if (UNITS[id] && !isUnlocked(run, id)) return false;
  const src = sourceOf(run, srcId);
  if (!src) return false;
  const isUnit = !!UNITS[id];
  const def = isUnit ? UNITS[id] : FORTS[id];
  if (!def) return false;
  const group = isUnit
    ? (Object.keys(PROD_GROUPS).find((g) => PROD_GROUPS[g].includes(id)) || '')
    : 'sup';
  const list = src.produces || [];
  return list.includes(group) || list.includes(id);
}

// 返回该源可造的 id 列表（按固定顺序）
export function producibleList(run, srcId) {
  const src = sourceOf(run, srcId);
  if (!src) return [];
  const out = [];
  const list = src.produces || [];
  for (const grp of ['inf', 'veh', 'tow', 'sup']) {
    const whole = list.includes(grp);
    for (const id of PROD_GROUPS[grp]) {
      if (whole || list.includes(id)) out.push(id);
    }
  }
  // 不属于任何分组的「单独条目」（如工兵的迫击炮）也要出现
  for (const id of list) {
    if (out.includes(id)) continue;
    if (UNITS[id] || FORTS[id]) out.push(id);
  }
  return out;
}

// ---------------- 自动布防（用于 ?auto=1 与无头模拟） ----------------
export function autoBuild(run) {
  // 机器人也遵守解锁节奏，否则 sim 会高估玩家前期能力
  const canBuild = (id) => isUnlocked(run, id);
  const W = run.map.w;
  const cx = run.core.x, cy = run.core.y;
  const cand = [];
  for (let y = 0; y < run.map.h; y++) {
    for (let x = 0; x < W; x++) {
      if (!TERRAIN[run.map.tiles[y * W + x]].walkable) continue;
      cand.push({ x, y, d: Math.hypot(x - cx, y - cy) });
    }
  }
  cand.sort((a, b) => a.d - b.d);
  const at = (min, max) => cand.filter((c) => c.d >= min && c.d <= max);
  const hasFort = (kind) => run.forts.some((f) => f.kind === kind && f.hp > 0);
  const busy = new Set((run.queue || []).map((q) => q.srcId).filter(Boolean));

  // 0) 兵营（据点可造）→ 工兵（据点可造，120）
  if (!hasFort('barracks') && run.supply >= FORTS.barracks.cost) {
    for (const c of at(2.0, 7.0)) if (placeAt(run, 'fort', 'barracks', c.x, c.y, 'core')) break;
  }
  let eng = run.units.find((u) => u.kind === 'engineer' && u.hp > 0);
  if (!eng && run.supply >= UNITS.engineer.cost) {
    for (const c of at(2.0, 6.0)) {
      if (TERRAIN[run.map.tiles[c.y * W + c.x]].buildBlock) continue;
      if (placeAt(run, 'unit', 'engineer', c.x, c.y, 'core')) {
        eng = run.units.find((u) => u.kind === 'engineer' && u.hp > 0);
        break;
      }
    }
  }

  // 1) 炮台：全部从工兵出；有维护费后，净收入不够就先别铺炮台（否则被 upkeep 拖死）
  const netCash = incomeRate(run).netCash;
  const TOW_CAP = netCash > 2.5 ? { turret: 5, flame: 3, mortar: 3 } : { turret: 3, flame: 2, mortar: 2 };
  const TOW = TOW_CAP;
  // 1a) mixBot：迫击炮是 0 人口的 AoE 主力，单独优先铺满 3 个，不和 turret/flame 抢同一轮工兵
  if (run.mixBot && eng && !busy.has(eng.id) && netCash > 0.5) {
    let nm = run.units.filter((u) => u.kind === 'mortar' && u.hp > 0).length;
    for (const c of at(1.0, 4.0)) {
      if (nm >= 3) break;
      if (run.supply < UNITS.mortar.cost) break;
      if (canBuild('mortar') && placeAt(run, 'unit', 'mortar', c.x, c.y, eng.id)) nm++;
    }
  }
  if (eng && !busy.has(eng.id) && netCash > 1.0) {
    for (const id of (run.mixBot ? ['turret', 'flame'] : ['turret', 'flame', 'mortar'])) {
      let n = 0;
      const capN = TOW[id] || 2;
      const cost = UNITS[id].cost;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (n >= capN) break;
          if (run.supply < cost) break;
          const x = eng.tx + dx, y = eng.ty + dy;
          if (x < 0 || y < 0 || x >= W || y >= run.map.h) continue;
          if (TERRAIN[run.map.tiles[y * W + x]].buildBlock) continue;
          if (canBuild(id) && placeAt(run, 'unit', id, x, y, eng.id)) n++;
        }
      }
    }
  }

  // 2) 步兵填内侧（据点出）：先攒够 4 个能打的，再考虑工事
  //    mixBot 时压到 4 个，把人口让给霰弹/机枪/火箭等多元配比（Lv1 人口 12 会被 12 个步兵吃满）
  const GRUNT_CAP = run.mixBot ? 4 : 12;
  let grunts = run.units.filter((u) => u.kind === 'infantry' && u.hp > 0).length;
  for (const c of at(1.5, 8.0)) {
    if (grunts >= GRUNT_CAP) break;
    if (run.supply < UNITS.infantry.cost) break;
    if (popLeft(run) < UNITS.infantry.pop) break;
    if (placeAt(run, 'unit', 'infantry', c.x, c.y, 'core')) grunts++;
  }

  // 2b) 可选多元配比：只由 tools/sim.mjs 的 MIXBOT=1 打开，用于「改了 mg/霰弹/火箭/装甲车/坦克」后的平衡回归。
  //     默认关闭，保持纯炮台流的基线可比（autoBuild 默认完全不造这五个）。
  if (run.mixBot) {
    const barSrc = (run.forts || []).find((f) => f.kind === 'barracks' && f.hp > 0);
    if (barSrc) {
      // AoE 优先：霰弹（溅射 30@0.45、克无甲 1.3）→ 机枪（裸 DPS 80）→ 火箭（克重甲 2.7）→ 狙击
      for (const [id, cap] of [['shotgun', 4], ['mg', 2], ['rocket', 2], ['sniper', 1]]) {
        if (!canBuild(id)) continue;
        const def = UNITS[id];
        let n = run.units.filter((u) => u.kind === id && u.hp > 0).length;
        for (const c of at(1.0, 9.0)) {
          if (n >= cap) break;
          if (run.supply < def.cost) break;
          if (popLeft(run) < def.pop) break;
          if (placeAt(run, 'unit', id, c.x, c.y, barSrc.id)) n++;
        }
      }
    }
    // 载具必须从载具工厂出：先自己攒钱补一座，再产装甲车/坦克
    if (!hasFort('factory') && run.supply >= FORTS.factory.cost + 120) {
      for (const c of at(2.0, 9.0)) if (placeAt(run, 'fort', 'factory', c.x, c.y, 'core')) break;
    }
    const facSrc = (run.forts || []).find((f) => f.kind === 'factory' && f.hp > 0);
    if (facSrc) {
      // 自行火炮溅射 80@0.60（半径最大）、坦克溅射 34@0.40 且有 500 血，装甲车补机动
      for (const [id, cap] of [['howitzer', 2], ['tank', 2], ['vehicle', 1]]) {
        const def = UNITS[id];
        let n = run.units.filter((u) => u.kind === id && u.hp > 0).length;
        for (const c of at(2.0, 9.0)) {
          if (n >= cap) break;
          if (run.supply < def.cost) break;
          if (popLeft(run) < def.pop) break;
          if (placeAt(run, 'unit', id, c.x, c.y, facSrc.id)) n++;
        }
      }
    }
  }

  // 3) 工事：全部从工兵出（半径 2 格）；留足 200 再铺，且最多各摆几道
  if (eng && !busy.has(eng.id) && run.supply >= 200 && netCash > 0.6) {
    let walls = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (walls >= 4) break;
        if (run.supply < FORTS.barricade.cost) break;
        const x = eng.tx + dx, y = eng.ty + dy;
        if (x < 0 || y < 0 || x >= W || y >= run.map.h) continue;
        if (placeAt(run, 'fort', 'barricade', x, y, eng.id)) walls++;
      }
    }
    let nets = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (nets >= 6) break;
        if (run.supply < FORTS.wire.cost) break;
        const x = eng.tx + dx, y = eng.ty + dy;
        if (x < 0 || y < 0 || x >= W || y >= run.map.h) continue;
        if (placeAt(run, 'fort', 'wire', x, y, eng.id)) nets++;
      }
    }
  }

  // 4) 重火力：兵营已有 → 工厂 → 自走火炮（mixBot 已在 2b 按兵种表产 howitzer/tank，这里跳过）
  if (!run.mixBot && run.supply > 700 && !run._botHvy) {
    if (!hasFort('factory')) {
      for (const c of at(2.0, 9.0)) if (placeAt(run, 'fort', 'factory', c.x, c.y, 'core')) break;
    } else {
      let hv = 0;
      for (const c of at(3.0, 10.0)) {
        if (hv >= 2) break;
        if (run.supply < UNITS.howitzer.cost) break;
        if (TERRAIN[run.map.tiles[c.y * W + c.x]].buildBlock) continue;
        if (placeAt(run, 'unit', 'howitzer', c.x, c.y, 'factory')) hv++;
      }
      if (hv) run._botHvy = true;
    }
  }

  // 5) 分兵占点 / 推前线
  const idle = run.units.filter((u) => UNITS[u.kind] && UNITS[u.kind].mobile && !u.order && u.kind !== 'engineer');
  const freeNodes = (run.nodes || [])
    .filter((n) => n.owner !== 1)
    .sort((a, b) => (Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy)));
  let sent = 0;
  if (run.botNodes !== false && freeNodes.length && idle.length >= 4) {
    for (const n of freeNodes.slice(0, 2)) {
      const squad = idle.splice(0, Math.min(2, idle.length));
      if (!squad.length) break;
      orderMove(run, squad.map((u) => u.id), n.x, n.y);
      sent += squad.length;
    }
  }
  const mobile = idle.map((u) => u.id);
  if (mobile.length) {
    const rx = clamp(cx - 9, 1, W - 2);
    const ry = clamp(cy, 1, run.map.h - 2);
    orderMove(run, mobile, rx, ry);
  }
  // 工兵留在炮台旁（架炮期间不能动，所以只在造完后才推）
  if (eng && !busy.has(eng.id) && !eng.order) {
    const gx = clamp(cx - 5, 1, W - 2);
    const gy = clamp(cy + 1, 1, run.map.h - 2);
    orderMove(run, [eng.id], gx, gy);
  }
  void sent;
  return run;
}
