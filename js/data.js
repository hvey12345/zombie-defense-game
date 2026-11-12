// js/data.js — 纯配置，无状态无副作用。所有数值只在这里出现。
export const TILE = Object.freeze({ GROUND: 0, ROAD: 1, BUILDING: 2, RUBBLE: 3, WATER: 4, HIGHLAND: 5, LOWLAND: 6, BRIDGE: 7 });

export const TILE_NAME = Object.freeze({
  [TILE.GROUND]: '空地',
  [TILE.ROAD]: '马路',
  [TILE.RUBBLE]: '碎石堆',
  [TILE.BUILDING]: '建筑',
  [TILE.WATER]: '水面',
  [TILE.HIGHLAND]: '高地',
  [TILE.LOWLAND]: '低地',
  [TILE.BRIDGE]: '桥面',
});

export const TERRAIN = Object.freeze({
  [TILE.GROUND]: { walkable: true, cost: 1.2, color: '#1f2731', zSpeed: 1.0, uSpeed: 1.0, range: 1.0 },
  // 马路：跑得快，但没地基——不能搭固定炮台（工事、步兵、载具不受限）
  [TILE.ROAD]: {
    walkable: true, cost: 1.0, color: '#2c3643',
    zSpeed: 1.12, uSpeed: 1.15, range: 1.0, buildBlock: ['炮台'],
  },
  [TILE.RUBBLE]: {
    walkable: true, cost: 1.6, color: '#39424e',
    zSpeed: 0.85, uSpeed: 0.85, range: 0.92,
  },
  [TILE.BUILDING]: { walkable: false, cost: Infinity, color: '#4b5665', hp: 400 },
  [TILE.WATER]: { walkable: false, cost: Infinity, color: '#123049' },
  // 高地：射程 +25%，但僵尸上坡变慢
  [TILE.HIGHLAND]: {
    walkable: true, cost: 1.35, color: '#2a3444',
    zSpeed: 0.82, uSpeed: 0.92, range: 1.25, elev: 1,
  },
  // 低地：射程 -28%，僵尸跑得快
  [TILE.LOWLAND]: {
    walkable: true, cost: 1.35, color: '#181f28',
    zSpeed: 1.18, uSpeed: 0.95, range: 0.72, elev: -1,
  },
  // 桥面：跨水的唯一通道（森林图用）。可走、可建，速度与空地一致。
  [TILE.BRIDGE]: { walkable: true, cost: 1.0, color: '#57452f', zSpeed: 1.0, uSpeed: 1.0, range: 1.0 },
});

// 可进入建筑（据点外的掩体）：按格子容纳，一格一个单位
export const GARRISON = Object.freeze({
  range: 1.15,     // 射程 +15%（工兵除外）
  dr: 0.20,        // 进入后受伤害 -20%
  enterT: 1.5,     // 进入耗时（秒）
  exitT: 1.0,      // 撤出耗时
  slideT: 0.25,   // 进/出楼入位滑行时间
  insideSpeedMul: 0.9,  // 楼内移动速度
  crush: 0.40,     // 建筑被摧毁时，里面单位吃 25% 最大生命的伤害
});

// 给地图打「可进入建筑」标记：面积 2~8 格、按坐标哈希取约 30%
// 资源点自带高地：3×3 中心铺成 HIGHLAND（射程 ×1.35）
// 单位姿态：自由开火 / 停火 / 巡逻（两点往返）
export const STANCE = Object.freeze({ FREE: 'free', HOLD: 'hold', PATROL: 'patrol' });
export const COMMAND = Object.freeze({ patrolWait: 0.25 });

export function markNodeHighland(map) {
  const W = map.w, T = TILE.HIGHLAND;
  for (const n of map.nodes || []) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = n.x + dx, y = n.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= map.h) continue;
        map.tiles[y * W + x] = T;
      }
    }
  }
  map.dirty = true;
  return map;
}

export function markGarrison(map, ratio = 3) {
  for (const b of map.buildings) {
    const area = b.w * b.h;
    if (area < 4 || area > 9) continue;   // 城区全是 3×3
    const h = ((b.x * 73856093) ^ (b.y * 19349663) ^ (b.w * 83492791)) >>> 0;
    if (h % 10 < ratio) {
      b.garrison = true;
      // 驻军上限 = ceil(格数/2)，由形状决定（不再随机）
      {
        const cells = b.cells && b.cells.length
          ? b.cells.slice()
          : (() => { const a = []; for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) a.push([x, y]); return a; })();
        const cx0 = (b.w - 1) / 2, cy0 = (b.h - 1) / 2;
        cells.sort((p1, p2) => {
          const d1 = (p1[0] - cx0) ** 2 + (p1[1] - cy0) ** 2;
          const d2 = (p2[0] - cx0) ** 2 + (p2[1] - cy0) ** 2;
          return d1 - d2;
        });
        const cap = Math.ceil(cells.length / 2);
        b.garrCap = cap;
        b.slots = cells.slice(0, cap).map(([dx, dy]) => ({ x: b.x + dx, y: b.y + dy }));
      }
    }
  }
  return map;
}

export const UNITS = Object.freeze({
  // ---- 步兵 ----
  // 音效分组：inf=步兵 / heavy=重武器 / veh=载具 / sup=支援
  infantry: {
    id: 'infantry', mag: { size: 5, reload: 1.0 }, name: '步兵', type: '步兵', cost: 50, buildTime: 2, parts: 0, pop: 1, hp: 45,
    dmg: 10, fireInterval: 0.30, range: 120, r: 7,
    fx: 'bullet', armor: 'none',
    mobile: true, speed: 54, icon: 'infantry',
     vsArmor: { none: 1.0, light: 0.9, heavy: 0.8 },
    canGarrison: true,
  },
  rocket: {
    id: 'rocket', name: '火箭筒兵', type: '步兵', cost: 180, buildTime: 4, parts: 25, pop: 1, hp: 30,
    dmg: 30, fireInterval: 1.83, range: 180, r: 7,
    fx: 'rocket', armor: 'none', boomTag: 'rocket',   // 落地爆炸压一档并收混响（见 sfx.boom）
    mobile: true, speed: 44, icon: 'rocket',
    splash: { radius: 26, factor: 0.30 },   // 范围伤害：中心满伤，边缘 30%（1.5 次方衰减）
    buildingMul: 1.2,   // 拆楼 5.4/发 = 30 × 0.3 × 0.5 × 1.2
     vsArmor: { none: 0.6, light: 1.1, heavy: 2.7 },
    targetBias: { heavy: 0.62, raiderVehicle: 0.42 },   // 优先锁重甲（bias 越小越优先，0.62 ⇒ 等效距离 x0.62）   // 平衡 2026-11-05：heavy 2.2→2.7（对重甲 36.1→44.3）
    // 叛军装甲车：射程 160 能压住步枪/机枪，是场上最危险的目标 ⇒ 火箭筒兵最优先锁它，且给反载具加成
    // 标定（2026-11-07 用户）：叛军装甲车 170 血 ⇒ 2 发清掉，单发需 >= 85 ⇒ 30 x 2.9 = 87
    vsRaiderVehicle: 2.9,
    canGarrison: true,
  },
  // ---- 新增步兵 ----
  // 机枪组：C 方案「架设式」——行军态禁火，手动架设（2.0s）后获得 -10% 减伤与 0.8x1.5s 减速压制
  // 无甲 / 不可进楼 / 只有医疗兵能治（工兵 repair.target 只含载具、炮台）
  mg: {
    id: 'mg', mag: { size: 120, reload: 3.0 }, critRate: 0.02, name: '机枪组', type: '步兵', cost: 200, buildTime: 5, parts: 30, pop: 2, hp: 75,
    dmg: 8, fireInterval: 0.10, range: 150, r: 7,   // 平衡 2026-11-05：7→8（2 人口的单体输出偏弱；持续 56→64）
    fx: 'bullet', armor: 'none',
    mobile: true, speed: 30, icon: 'mg',
    slow: { mul: 0.8, dur: 1.5 },          // 命中减速：-20% / 1.5s（只在架设态开火，因此只在架设态触发）
    deploy: { setUpT: 2.0, tearDownT: 1.5, dr: 0.10 },   // 架设后受伤 -10%
    vsArmor: { none: 1.1, light: 1.0, heavy: 0.85 },   // 与装甲车统一：无甲 1.1 / 轻甲 1.0 / 重甲 0.85
    canGarrison: false,
  },
    // 喷火兵：会走路的喷火塔 —— 射程更短、血更薄、死后自爆；过热与塔同一套机制
    // 生态位：狭窄走廊的群体清扫；单目标 DPS 很低（8.2），打单体不如步枪兵
    flamer: {
      id: 'flamer', name: '喷火兵', type: '步兵', cost: 130, buildTime: 4, parts: 15, pop: 1, hp: 40,
      dmg: 2.4, fireInterval: 0.14, range: 92, r: 7, fx: 'flame', armor: 'none',
      mobile: true, speed: 46, icon: 'flamer', aimOnMove: true,
      canGarrison: false,          // 火器不进楼（也把「楼内机枪」的卖点留给轻机枪兵）
      jet: { half: 0.40, w0: 8, w1: 20, edge: 0.60, nearK: 1.25, nearR: 20 },   // 锥角 46°、长 92
      burn: { dur: 2.0, dps: 4, slow: 0.30 },              // 灼烧 2s、减速 30%（塔是 0.25，兵更黏）
      // 连喷 5.5s（heatMax 1.2 ÷ perShot 0.03 × 0.14s）→ 散热 2.0s，占空比 ~73%
      heat: { perShot: 0.030, cool: 0.60, idle: 0.30, max: 1.2 },
      boom: { dmg: 62, radius: 44, falloff: 0.5, unitMul: 0.3, buildingMul: 0, delay: 0.12 },
      vsArmor: { none: 1.4, light: 0.8, heavy: 0.4 },
    },
    // 轻机枪兵：1 人口的「可移动火力点」——能边走边打、能进楼、也能在楼外架设强化
    // 生态位：机枪组（2 人口 64dps 但进不了楼）与步兵（50 资金但只有 20dps）之间的机动档
    lmg: {
      id: 'lmg', name: '轻机枪兵', type: '步兵', cost: 140, buildTime: 4.5, parts: 12, pop: 1, hp: 55,
      dmg: 6, fireInterval: 0.088, range: 128, r: 7, fx: 'bullet', armor: 'none',   // 面板射速 7.5（含 1.8s 换弹）
      mag: { size: 40, reload: 1.8 },
      mobile: true, speed: 50, icon: 'lmg',
      canGarrison: true,           // 楼内：射程 ×1.15（147）＋ 受伤 -20%
      moveMul: 1.3,                // 移动中开火间隔 ×1.3（边走边打不稳）
      deploy: { setUpT: 1.2, tearDownT: 1.0, intervalMul: 0.78, rangeAdd: 18, noInside: true, fireFolded: true, foldMul: 1.15 },
      vsArmor: { none: 1.1, light: 1.0, heavy: 0.85 },
    },
  shotgun: {
    id: 'shotgun', mag: { size: 8, reload: 2.6 }, name: '霰弹枪兵', type: '步兵', cost: 80, buildTime: 3, parts: 2, pop: 1, hp: 60,
    dmg: 9, fireInterval: 0.55, range: 96, r: 7,   // 平衡 2026-11-05：7/0.65/1.8 → 9/0.55/2.6（爆发 10.8→16.4，持续 8.0→10.3，装填占比 26%→37%）；射程 100→96
    fx: 'bullet', armor: 'light',
    mobile: true, speed: 52, icon: 'shotgun',
    splash: { radius: 35, factor: 0.45 },   // 近距离高爆发；边缘只剩 45%，鼓励贴脸（半径 30→35：24px 网格下 30 只溅到 1.25 只）
     vsArmor: { none: 1.3, light: 1.0, heavy: 0.7 },
    canGarrison: true,
    critRate: 0.08,
  },
  sniper: {
    id: 'sniper', mag: { size: 8, reload: 3.0 }, name: '狙击手', type: '步兵', cost: 150, buildTime: 6.5, parts: 5, pop: 1, hp: 30,
    dmg: 42, fireInterval: 1.25, range: 240, r: 7,
    fx: 'bullet', armor: 'none',
    mobile: true, speed: 46, icon: 'sniper',
     vsArmor: { none: 1.0, light: 1.2, heavy: 0.85 },
     // 优先锁定「非重甲特感」：候选距离 ×0.45 参与排序（重甲特感/普通僵尸不享受）
     // raiderVehicle：叛军装甲车同样点名（射程 240 是一线唯一能安全够到它的武器）
     targetBias: { specialNoHeavy: 0.45, raiderVehicle: 0.5 },
     // 特感加成下调（配合优先锁定：从「偶尔打到」变成「稳定点名」，总收益仍然更高）
     specBonus: { hunter: 1.10, spitter: 1.10, smoker: 1.0 },
     // 叛军装甲车有反载具加成（狙击是点杀重目标的主力）
     // 标定（2026-11-07 用户）：叛军装甲车 170 血 ⇒ 4 枪清掉，单发需 >= 42.5；42 x 0.8(轻甲) x 1.4 = 47.04 ⇒ 4 枪 188
     vsRaiderVehicle: 1.4,
    vsBoss: 1.5,   // 只对 boss（暴君）生效：42 × 1.4 × 1.5 = 88/发，17 发清 1500 血；不动 vsArmor.heavy
    canGarrison: true,
    critRate: 0.12,
  },
  medic: {
    id: 'medic', mag: { size: 15, reload: 1.2 }, pistol: true, name: '医疗兵', type: '步兵', cost: 80, buildTime: 3, parts: 0, pop: 1, hp: 30,
    dmg: 7, fireInterval: 0.5, range: 76, r: 6,
    fx: 'bullet', armor: 'none',
    mobile: true, speed: 56, icon: 'medic',
    heal: { rate: 9, radius: 96, target: '步兵', crossMul: 0.2,   // 跨楼（楼外治楼内）速率 ×0.2
      aura: { radius: 96, dr: 0.12 } },   // 战地光环：圈内步兵受击 -12%（不叠加）
     vsArmor: { none: 1.0, light: 0.8, heavy: 0.8 },
    canGarrison: true,
  },
  engineer: {
    id: 'engineer', mag: { size: 15, reload: 1.2 }, pistol: true, name: '工兵', type: '步兵', cost: 100, buildTime: 3, parts: 10, pop: 1, hp: 30,
    noPatrol: true, produces: ['turret', 'flame', 'mortar', 'barricade', 'wire', 'mine', 'factory'],
    buildRadius: 2, towerRadius: 2,   // 统一 2 格（炮台/工事/建筑同口径）
    dmg: 7, fireInterval: 0.5, range: 76, r: 6,
    fx: 'bullet', armor: 'none',
    mobile: true, speed: 52, icon: 'engineer',
    repair: { rate: 12, radius: 76, target: ['载具', '炮台'] },   // 修车/工事/建筑
     vsArmor: { none: 1.0, light: 0.8, heavy: 0.8 },
    canGarrison: true, garrisonRole: 'support',
  },
  // ---- 新增载具 ----
  howitzer: { stun: 0.30,
    id: 'howitzer', name: '自行火炮', type: '载具', cost: 650, buildTime: 10, unlockWave: 3, parts: 240, pop: 4, hp: 360,
    dmg: 90, fireInterval: 2.963, range: 650, minRange: 120, r: 13,
    fx: 'mortar', armor: 'heavy',
    mobile: true, speed: 30, icon: 'howitzer',
    splash: { radius: 80, factor: 0.60 },
    boom: { dmg: 90, radius: 60, falloff: 0.5, unitMul: 0.5, buildingMul: 0.3, delay: 2.0 },
     vsArmor: { none: 1.6, light: 1.1, heavy: 0.6 },
     // 需架设：移动中/收起中不能开火；架设 4.0s、收起 2.5s、架设态受伤 -15%
     deploy: { setUpT: 4.0, tearDownT: 2.5, dr: 0.15 },
     iconScale: 1.15,   // 图标放大（15%）：重炮要比坦克看起来大
  // 碾压：撞得最轻、陷得最快 —— 本质是「能自保一下的远程」
  ram: { dmg: 18, knock: 12, cd: 0.30, slowPer: 0.10, slowMax: 0.80, stuckAt: 6, self: 5 },
  },
  // ---- 载具 ----
  vehicle: {
    id: 'vehicle', mag: { size: 150, reload: 3.0 }, critRate: 0.02, name: '装甲车', type: '载具', cost: 300, buildTime: 8, unlockWave: 3, parts: 80, pop: 2, hp: 200,
    // 加特林：射速极快、单发伤害低；命中减速 20% / 2s
    slow: { mul: 0.8, dur: 2 },
    // 阵亡自爆：A 档半径，僵尸 100% / 建筑 30% / 我方 50%
    boom: { dmg: 54, radius: 36, falloff: 0.5, unitMul: 0.5, buildingMul: 0.3, delay: 2.0 },
    dmg: 11, fireInterval: 0.08, range: 160, r: 12, gatling: true,   // 平衡 2026-11-05：12→11（持续 120→110）
    fx: 'bullet', armor: 'light',
    mobile: true, speed: 76, icon: 'humvee', iconScale: 1.0,
     vsArmor: { none: 1.1, light: 1.0, heavy: 0.85 },
  // 碾压：伤害只有坦克一半，但减速更狠、9 只就卡死
  ram: { dmg: 30, knock: 24, cd: 0.30, slowPer: 0.08, slowMax: 0.70, stuckAt: 9, self: 3 },
  },
  tank: {
    id: 'tank', name: '坦克', type: '载具', cost: 500, buildTime: 12, unlockWave: 3, parts: 160, pop: 3, hp: 500,
    dmg: 60, fireInterval: 2.01, range: 216, r: 13,
    fx: 'ap', armor: 'heavy',
    mobile: true, speed: 40, icon: 'tank',
    splash: { radius: 34, factor: 0.40 },
    buildingMul: 1.2,   // 拆楼 14.4/发 = 60 × 0.4 × 0.5 × 1.2
    boom: { dmg: 72, radius: 48, falloff: 0.5, unitMul: 0.5, buildingMul: 0.3, delay: 2.0 },
     vsArmor: { none: 0.9, light: 1.1, heavy: 1.9 },
    targetBias: { heavy: 0.62, raiderVehicle: 0.45 },   // 优先锁重甲（bias 越小越优先，0.62 ⇒ 等效距离 x0.62）   // 平衡 2026-11-05：heavy 1.65→1.9（对重甲 49.3→56.8）
    // 坦克单挑能赢叛军装甲车，但 2.01s 一发的节奏太慢 ⇒ 点名 + 反载具加成
    // 标定（2026-11-07 用户）：叛军装甲车 170 血 ⇒ 1 发清掉，单发需 >= 170 ⇒ 60 x 2.9 = 174
    vsRaiderVehicle: 2.9,
  // 碾压：一撞死行尸，被围也能慢慢挪出来（12 只才卡死）
  ram: { dmg: 60, knock: 48, cd: 0.30, slowPer: 0.05, slowMax: 0.55, stuckAt: 12, self: 3 },
  },
  // ---- 英雄 ----
  // 指挥官：全图限 1 个（unique 由 capOk 读），吃军衔；阵亡不是真死，走「重伤」（RULE.hero）
  hero: {
    id: 'hero', name: '指挥官', type: '步兵', cost: 240, buildTime: 8, unlockWave: 2,
    parts: 30, pop: 1, upkeep: 0.05, hp: 120, mag: { size: 40, reload: 2.6 },
    dmg: 9, fireInterval: 0.136, range: 125, r: 8,
    fx: 'bullet', armor: 'light',
    mobile: true, speed: 58, icon: 'hero', iconScale: 1.05,
    vsArmor: { none: 1.0, light: 1.05, heavy: 0.75 },
    canGarrison: true,
    unique: true,   // 全图限 1 个
    hero: true,     // 阵亡走重伤流程（cleanDeadUnits 拦截）
  },
  // ---- 炮台 ----
  turret: {
    id: 'turret', name: '自动炮台', type: '炮台', cost: 150, buildTime: 8, parts: 30, pop: 0, hp: 160,
    slow: { mul: 0.7, dur: 2 },
    dmg: 18, fireInterval: 0.4348, range: 150, r: 8,
    fx: 'bullet', armor: 'light',
    mobile: false, speed: 0, icon: 'turret',
     vsArmor: { none: 1.1, light: 1.0, heavy: 0.9 },
  },
  mortar: { stun: 0.22,
    id: 'mortar', name: '迫击炮', type: '炮台', cost: 240, buildTime: 14, parts: 50, pop: 0, hp: 120,
    dmg: 30, fireInterval: 2.83, range: 288, minRange: 72, r: 9,   // minRange 90->72（3 格）：原来 3.75 格内一炮不放，被贴脸只能等死
    fx: 'mortar', armor: 'none',
    mobile: false, speed: 0, icon: 'mortar',
    splash: { radius: 70, factor: 0.55 },
    buildingMul: 0.7273,   // 拆楼 6/发 = 30 × 0.55 × 0.5 × 0.7273
     vsArmor: { none: 1.5, light: 1.0, heavy: 0.6 },
  },
  flame: {
    id: 'flame', name: '燃烧塔', type: '炮台', cost: 180, buildTime: 10, parts: 40, pop: 0, hp: 310,
    dmg: 2.0, fireInterval: 0.16, range: 96, r: 8,
    fx: 'flame', armor: 'heavy',
    // 火舌判定：沿炮塔朝向的锥形（张角 55°、长 96、入口 12 宽 → 出口 30 宽）
    jet: { half: 0.48, w0: 12, w1: 30, edge: 0.60, nearK: 1.25, nearR: 20 },
    // 灼烧：被打到的僵尸点燃 2.5 秒（4/s 真实伤害），期间移速 ×0.75
    burn: { dur: 2.5, dps: 4, slow: 0.25 },
    // 地面残火：只剩「刚被烧过的地」，范围缩到 16（0.7 格）
    zone: { r: 16, dps: 12, duration: 0.6, gap: 0.25, slow: 0.25, merge: 14, edge: 0.60 },
    heat: { perShot: 0.03, cool: 0.30, idle: 0.35 },
    boom: { dmg: 54, radius: 36, falloff: 0.5, unitMul: 0.5, buildingMul: 0.3, delay: 2.0 },   // 每发积累热量 / 每秒散热（满 1 = 过热停火）
    mobile: false, speed: 0, icon: 'flame', iconScale: 1.20,
     vsArmor: { none: 1.5, light: 0.8, heavy: 0.45 },
  },
});

// 空袭技能（战斗阶段主动干预）
export const SKILLS = Object.freeze({
  strike: {
    id: 'strike', name: '炮击', icon: 'assets/icons/skill_strike.png', cost: 200,
    cd: 120, delay: 0.55, rounds: 9, interval: 0.16, radius: 79.2, dmg: 80, stun: 0.45,
    splash: { radius: 72, factor: 0.50 },
    buildingMul: 1.2,   // 对建筑额外 +20%   // 每轮落点也按 1.5 次方衰减
    hint: '轰炸指定区域，8 轮落弹',
     vsArmor: { none: 1.4, light: 1.0, heavy: 0.8 },
    raiderMul: 0.5,   // 对叛军只造成 50% 伤害（2026-11-06 用户要求）
  },
  fire: {
    id: 'fire', name: '燃烧弹', icon: 'assets/icons/skill_fire.png', cost: 80,
    cd: 60, duration: 8, radius: 37, dps: 20, slow: 0.5, tick: 0.4, edge: 0.60,
    hint: '在区域内烧 8 秒，减速 50%',
     vsArmor: { none: 1.4, light: 0.9, heavy: 0.6 },
    raiderMul: 0.5,   // 对叛军只造成 50% 伤害（2026-11-06 用户要求）
  },
  airdrop: {
    id: 'airdrop', name: '空降兵', icon: 'assets/icons/infantry.png', cost: 100,
    cd: 180, unit: 'infantry', shadowSec: 0.35, invSec: 1.2,
    hint: '任意空地空投 1 名步兵（占人口、计维护费）',
  },
});
export const SKILL_ORDER = Object.freeze(['strike', 'fire', 'airdrop']);

// 英雄技能：不花资金、只有 CD，且只有「指挥官」能放（键位与全局技能错开）
export const HERO_SKILLS = Object.freeze({
  grenade: {
    id: 'grenade', name: '手雷', key: 'G', icon: 'assets/icons/skill_grenade.png',
    cd: 12, range: 120, radius: 60, dmg: 55, falloff: 0.5, raiderMul: 0.8, delay: 0.28, stun: 0.20,
    buildingMul: 0.5,       // 对建筑
    friendlyMul: 0.3,       // 误伤友军（含自己）；改这里要同步改下面 hint 里的百分比
    hint: '向射程内投掷手雷（半径 60，对建筑 ×0.5，误伤友军 30%）',
  },
  warcry: {
    id: 'warcry', name: '战吼', key: 'E', icon: 'assets/icons/skill_warcry.png',
    cd: 35, radius: 120, dur: 7, dmgMul: 1.18, speedMul: 1.10, dr: 0.10,
    hint: '周围单位 7 秒：伤害 +18% / 移速 +10% / 受伤 -10%',
  },
  adrenaline: {
    id: 'adrenaline', name: '肾上腺素', key: 'Q', icon: 'assets/icons/skill_adrenaline.png',
    cd: 30, healPct: 0.15, speedMul: 1.20, dur: 5,
    hint: '立即回复自身 15% 最大生命，并在 5 秒内移速 +20%（与其它加速取最高）',
  },
  grapple: {
    id: 'grapple', name: '钩爪', key: 'F', icon: 'assets/icons/skill_grapple.png',
    cd: 15, range: 200,
    flyT: 0.42,      // 飞行时长（200px ⇒ 约 476px/s，和拉长前手感一致）
    landT: 0.30,     // 落地硬直：这段时间不能攻击
    landDr: 0.25,    // 落地减伤（不是无敌）
    landDrT: 0.50,
    dmg: 22,         // 突进撞击伤害
    vsArmorHeavy: 0.6,
    knock: 10,
    garrisonT: 0.4,  // 冲向建筑时直接入驻（跳过 1.5s 读条）
    hint: 'Shift+F：点空地→拉自己过去；点敌人→撞过去；点建筑→直接入驻',
  },
});

export const HERO_SKILL_ORDER = Object.freeze(['grenade', 'warcry', 'adrenaline', 'grapple']);

// 护甲：减伤百分比（僵尸的 pen 会抵消部分）
export const ARMOR = Object.freeze({ none: 0, light: 0.20, heavy: 0.40 });
export const ARMOR_LABEL = Object.freeze({ none: '无甲', light: '轻甲', heavy: '重甲' });

// 资源点类型
export const NODE_TYPES = Object.freeze({
  // 丙档：资金井 0.71×3.5=2.485；零件矿 0.28×2.5=0.70
  cash: { id: 'cash', name: '资金井', icon: 'supply', color: '#e8c15a', cash: 2.49, parts: 0 },
  parts: { id: 'parts', name: '零件矿', icon: 'wire', color: '#7ec8ff', cash: 0, parts: 0.70 },
});


// 单位选中/阵亡音效的分组（inf 步兵 / heavy 重武器 / veh 载具 / sup 支援）
export const VOICE_GROUP = {
  infantry: 'inf',
  mg: 'heavy', shotgun: 'heavy', sniper: 'heavy', rocket: 'heavy',
  flamer: 'heavy', lmg: 'heavy',   // 喷火兵/轻机枪兵都算重武器声部
  vehicle: 'veh', tank: 'veh', howitzer: 'veh',
  engineer: 'sup', medic: 'sup',
  hero: 'hero',   // 指挥官单独一个声部：三音上行动机
};

export const FORTS = Object.freeze({
  barricade: { id: 'barricade', icon: 'barricade', name: '路障', cost: 50, buildTime: 2, parts: 2, pop: 0, hp: 450, blocks: true, refund: 0.5, armor: 'heavy' },
  wire: { id: 'wire', icon: 'wire', name: '铁丝网', cost: 20, buildTime: 1, parts: 1, pop: 0, hp: 150, blocks: false, slow: 0.55, refund: 0.5, armor: 'light' },
  // 雷区：一次性工事，僵尸贴近就引爆（伤害 + 减速），同时最多 5 片
  mine: { id: 'mine', icon: 'mine', name: '破甲地雷', cost: 60, buildTime: 2, parts: 5, pop: 0, hp: 120, blocks: false, refund: 0, armor: 'none',
    // vsHeavy：只对重甲僵尸（冲锋者 210 / 壮尸 280 / 暴君 1500）乘倍率，80 × 3.5 = 280 刚好一发带走壮尸
    trigger: { radius: 20, dmg: 80, vsHeavy: 3.5, unitMul: 0.5, splash: { radius: 46, factor: 0.55 }, slow: { mul: 0.5, dur: 3 } } },
  // 基地建筑：只能盖在据点旁边（本身是出兵点，不再给人口）
  barracks: { id: 'barracks', icon: 'barracks', name: '兵营', cost: 50, buildTime: 5, parts: 20, pop: 0, popBonus: 0, hp: 720, blocks: false, refund: 0.5, armor: 'light', base: true, size: 2, limitedBy: 'barracks', garrCap: 1, noRoad: true,
    produces: ['infantry', 'shotgun', 'mg', 'flamer', 'lmg', 'engineer', 'sniper', 'medic', 'rocket'],
    aura: { target: 'inf', radius: 2.5, hps: 1.05, delay: 12 } },
  // 载具工厂：只能造载具类，周围给载具回血
  factory: { id: 'factory', icon: 'factory', name: '载具工厂', requires: { barracks: 1 }, limitedBy: 'factory',
    cost: 120, buildTime: 7, parts: 80, pop: 0, popBonus: 0, hp: 720, blocks: false, refund: 0.5, armor: 'heavy', base: true, size: 2, garrCap: 1, noRoad: true,
    produces: ['veh'],
    aura: { target: 'veh', radius: 2.5, hps: 1.4, delay: 12 } },
});

// 生产分组：建筑只能造它 produces 里列出的分组
export const PROD_GROUPS = Object.freeze({
  inf: ['infantry', 'shotgun', 'mg', 'sniper', 'medic', 'engineer', 'rocket'],
  veh: ['vehicle', 'tank', 'howitzer'],
  tow: ['turret', 'flame'],
  sup: ['barricade', 'wire', 'mine', 'barracks', 'factory'],
});

// 据点本身的生产与光环配置
export const CORE_PROD = Object.freeze({
  // 据点只造：步兵、散弹枪兵、工兵、兵营；炮台/工事/载具工厂全部由工兵建造
  produces: ['infantry', 'shotgun', 'engineer', 'hero', 'barracks'],   // hero：指挥官，全图限 1（unlockWave 2）
  aura: { target: 'all', radius: 1.5, hps: 1.5, delay: 3 },
  footprint: 3,   // 基地 3x3 占地
  garrCap: 2,     // 基地里最多进 2 人
  deployRadius: 3,
});

// 建筑血量：按占格数计价（4 格 720 / 6 格 1080 / 9 格 1620）
export const BUILDING_HP_PER_TILE = 180;

// 僵尸进楼规则（仅普通僵尸读条进入，猎手跳入不伤楼；基地/兵营/工厂为禁区）
export const ZOMBIE_GARRISON = Object.freeze({
  canEnter: ['walker', 'hunter'],
  enterT: 8,
  enterDps: 2.5,
  insideBuildMul: 0.2,
  outsideDpsMul: 0.35,   // 楼满时在楼外强行拆楼的伤害系数（每人 0.35×）
  zCapMul: 2,
  jumpInMobs: ['hunter'],
});

export const ZOMBIES = Object.freeze({
  walker: {
    id: 'walker', name: '行尸', hp: 40, speed: 32, dmg: 15,
    attackInterval: 1.0, threat: 1.0, size: 9, pen: 0, ramWeight: 1,
    armor: 'none',
    // 形态变体：按 z.id 取，稳定不抖。想加减就改这个数组（图片放 assets/icons/）
    icons: ['zombie_1', 'zombie_2', 'zombie_3', 'zombie_4', 'zombie_5', 'zombie_6'],
  },
  brute: {
    id: 'brute', name: '壮尸', hp: 280, speed: 22, dmg: 40,
    attackInterval: 1.5, threat: 8.0, size: 14, vsBuilding: 3, pen: 0.15, ramWeight: 2,
    armorPierce: { light: 1 },   // 无视轻甲（重甲照常减伤）
    armor: 'heavy',
  },
  // ---- 特感（参考求生之路）----
  charger: {
    id: 'charger', name: '冲锋者', hp: 210, speed: 40, dmg: 30,
    attackInterval: 1.4, threat: 8.0, size: 12, icon: 'charger', pen: 0.20, ramWeight: 2,
    special: {
      ability: 'charge', role: 'siege', cd: 5.0, range: 170, windup: 0.55,
      dashSpeed: 230, dashTime: 0.6, dmg: 90, vsFort: 2.2, unitMul: 0.8, stun: 0.6,
      // 击退按护甲分档：无甲撞飞 2 格、轻甲（装甲车）1 格、重甲（坦克/火炮）只退 8px 并减速
      knockback: 48, knockbackLight: 24, knockbackHeavy: 8,
      slowHeavyMul: 0.55, slowHeavyDur: 1.2,
    },
    armorPierce: { light: 1 },   // 无视轻甲：冲锋撞穿装甲车/炮台
    armor: 'heavy',
  },
  hunter: {
    id: 'hunter', name: '猎手', hp: 160, speed: 72, dmg: 20,
    ramWeight: 2,
    attackInterval: 1.1, threat: 6.0, size: 10, icon: 'hunter', pen: 0.10,
    special: { ability: 'pounce', role: 'assassin', cd: 5.5, range: 130, leap: 0.5, dmg: 26, stun: 0.9, radius: 22, preferRange: 72, lockT: 1.5 },
    armor: 'light',
  },
  spitter: {
    id: 'spitter', name: '吐酸者', hp: 120, speed: 26, dmg: 15,
    ramWeight: 2,
    attackInterval: 2.2, threat: 6.0, size: 10, icon: 'spitter', pen: 0.10,
    special: {
    ability: 'spit', cd: 4.5, range: 190, warn: 0.4, radius: 34, dmg: 26,
    slow: 0.55, slowT: 2.2, flightBase: 0.28, flightPer: 900,
    acid: {
      r: 34, dps: 8, dur: 3, gap: 0.25, edge: 0.7,
      unitSlow: 0.55, slowT: 2.2, allyMul: 0.05, allySlow: 0.8,
      vsVehicle: 1.5,   // 酸池对玩家载具额外 1.5 倍（直击本身就是 2 倍）
    },
  },
    armor: 'none',
  },
  smoker: {
    id: 'smoker', name: '烟雾者', hp: 180, speed: 24, dmg: 12,
    ramWeight: 2,
    attackInterval: 2.4, threat: 7.0, size: 11, icon: 'smoker', pen: 0,
    special: { ability: 'smoke', cd: 6.0, range: 170, pullSpeed: 62, dps: 9, maxT: 2.6,
      suppress: { rateMul: 1.6, dur: 3.5, kinds: ['mg'] } },   // 拖不动架设单位时改为缠绕：射击间隔 ×1.6（射速 -38%）3.5s；对自行火炮无效
    armor: 'none',
  },
  screamer: {
    id: 'screamer', name: '尖叫者', hp: 120, speed: 34, dmg: 0,
    ramWeight: 2,
    attackInterval: 1.0, threat: 20.0, size: 11, icon: 'screamer', pen: 0,
    canGarrison: false,   // 不进楼：它要站在 168 的固定距离上
    // 两态：行进（没有玩家资产进入 168）→ 展开 0.8s → 架设站桩；距离拉大到 192 才收架（迟滞防抖）
    // 架设态**不给减伤**，否则 120hp 有效血量变 133，狙击 42×3=126 就打不死，「3 发」失效
    special: {
      ability: 'scream',
      parkRange: 168, resumeRange: 192, parkTime: 0.8, leaveTime: 0.4,
      // 架设态：强尖啸
      cd: 5.5, radius: 240, speedMul: 1.2, rateMul: 1.25, dur: 3.2,
      // 行进态：弱化尖啸
      move: { cd: 6.5, radius: 180, speedMul: 1.08, rateMul: 1.1, dur: 2.4 },
    },
    armor: 'none',
  },
  behemoth: {
    id: 'behemoth', name: '暴君', hp: 1500, speed: 16, dmg: 90,
    ramWeight: 10,
    attackInterval: 1.6, threat: 26.0, size: 18, vsBuilding: 4, icon: 'behemoth', boss: true, pen: 0.35,
    armorPierce: { light: 1, heavy: 0.5 },   // 无视轻甲，重甲减伤减半
    // 狂暴：血量低于 40% 后移速 ×1.5、攻速 ×1.6（配合践踏压最后两波）
    enrage: { at: 0.4, speedMul: 1.5, rateMul: 1.6 },
    // 践踏：蓄力亮地面预警圈，落地对半径内的我方单位减速（不进楼、不拆工事）
    special: { ability: 'stomp', cd: 7.5, radius: 100, windup: 0.7, dmg: 10, slowMul: 0.45, slowDur: 2.6, stun: 0.12, minTargets: 1 },
    armor: 'heavy',
  },
});

// 特感生成方案（可选）：counts[波次-1] 为该波多少只特感
export const SPEC_SCHEMES = Object.freeze([
  { id: 0, key: 'off', label: '关', counts: [0, 0, 0, 0, 0], pool: [] },
  { id: 1, key: 'normal', label: '标', counts: [0, 1, 2, 2, 3], pool: ['hunter', 'spitter', 'smoker', 'charger'], tanks: 1, tankWave: 5 },
  { id: 2, key: 'rage', label: '暴', counts: [1, 2, 3, 4, 5], pool: ['hunter', 'spitter', 'smoker', 'charger'], tanks: 2, tankWave: 5 },
]);

export const SPECIAL_IDS = Object.freeze(['charger', 'hunter', 'spitter', 'smoker', 'behemoth', 'screamer']);

// 核心升级三选一：清完第 1/3/5/7 波各出一次（无尽模式第 7 波后每 2 波再出，
// 直到 12 项全部拿完为止）。每项整局只能拿一次，从没拿过的里面抽 3 选 1。
// 主题波（仅 forest 地图）：每波循环取一个，改僵尸构成。
// 不在地图 meta.themes 里的图完全不生效，标准图逐字节不变。
export const THEMES = Object.freeze({
  swarm:   { name: '群袭', desc: '行尸铺天盖地，没有壮尸', walkerMul: 1.8, noBrute: true },
  armor:   { name: '重甲', desc: '壮尸与冲锋者打头阵', brutePct: 0.60, chargers: 6 },
  special: { name: '特感', desc: '特感数量翻倍', specMul: 2 },
  rush:    { name: '疾行', desc: '猎手成群，直扑防线', hunters: 10 },
});

export const PERKS = Object.freeze([
  { id: 'ammo',    name: '强化弹药', desc: '对无甲 / 轻甲伤害 +30%', tag: '火力', tint: '#f87171' },
  { id: 'pierce',  name: '穿甲弹芯', desc: '对重甲伤害 +25%',       tag: '火力', tint: '#fb923c' },
  { id: 'crit',    name: '精准射击', desc: '暴击率 +3%',            tag: '火力', tint: '#fbbf24' },
  { id: 'reload',  name: '快速装填', desc: '弹夹换弹时间 -20%',     tag: '火力', tint: '#facc15' },
  { id: 'economy', name: '战时经济', desc: '基地资金产出 +12%',     tag: '经济', tint: '#4ade80' },
  { id: 'parts',   name: '回收站',   desc: '零件产出 +30%',         tag: '经济', tint: '#34d399' },
  { id: 'upkeep',  name: '铁腕管理', desc: '所有维护费 -25%',       tag: '经济', tint: '#2dd4bf' },
  { id: 'supply',  name: '战时配给', desc: '清波补给 +40%',         tag: '经济', tint: '#22d3ee' },
  { id: 'fort',    name: '加固工事', desc: '工事血量 +30%',         tag: '生存', tint: '#60a5fa' },
  { id: 'hp',      name: '战地医疗', desc: '单位血量 +20%',         tag: '生存', tint: '#818cf8' },
  { id: 'core',    name: '核心装甲', desc: '核心血量 +300（立即回满）', tag: '生存', tint: '#a78bfa' },
  { id: 'pop',     name: '扩编',     desc: '人口上限 +4',           tag: '功能', tint: '#e879f9' },
]);

// 标准模式：清完这几波（1 基）各出一次
export const PERK_WAVES = Object.freeze([1, 3, 5, 7]);
// 选择窗口（秒），超时自动选第一张
export const PERK_SECS = 8;

export const RULE = Object.freeze({
  // 指挥官近战：贴脸时用枪托横扫（不吃护甲，钝击）
  // 枪托是钝击：不吃弹药也不看距离，但对重甲明显吃亏（避免它变成「特感秒杀器」）
  heroSweep: { dmg: 28, cd: 0.45, reach: 24, maxTargets: 3, knock: 16, slow: { mul: 0.5, dur: 1.0 },
    vsArmor: { none: 1.0, light: 1.0, heavy: 0.6 } },
  // 指挥官反伤：被近身啃咬时回敬 20% 的实际伤害，同一只 0.5s 内只触发一次
  heroThorns: { mul: 0.2, cd: 0.5 },

  grid: { W: 76, H: 50, T: 24 },
  caps: { towTotal: 6, turret: 2, flame: 2, mortar: 2, barricade: 20, wire: 30, mine: 5,
    howitzer: 2, tank: 3, vehicle: 3 },   // 后三个是载具按类型限量：防止全堆远程炮 // 炮台类每种最多 2 座、合计 6；工事另有上限（不限波次）
  core: { hp: 1500, contactDmg: 5 },
  // 多选行军时「下一格有同伴」的减速系数：0.65 = 跟着前车走 65% 速度。
  // 曾经的实现是速度归零（原地等），多人同点右键会变成「一格一停」。
  // 注：这里曾经还有 radiusMul / iters / share / idlePush，是像素推挤的参数；
  // 推挤已整段删除（行军期间只由路径插值写坐标，停下交给 settleUnits），因此一并清掉。
  collide: { stuckFrames: 60 },
  // ---- 叛军（劫掠者）：第三方红方人类 ----
  // 需 ?raider=1 才开；只出这三种兵，数值按 scale 打折；不产出资源、不拆建筑。
  raider: {
    scale: 0.85,
    think: 0.5,
    engageTiles: 6,
    minCoreDist: 9,
    startSquad: ['infantry', 'infantry', 'rocket', 'vehicle'],
    reinforce: ['infantry', 'infantry', 'rocket'],   // 第 5 波增援：不再带装甲车（2026-11-07 用户要求）
    reinforceWave: 5,
    pushWave: 8,
    // 叛军火箭筒兵打玩家载具的专精倍率（2026-11-07 用户要求：火箭打载具是本职，但别让一辆车秒掉坦克）
    rocketVsVehicle: 1.6,
    // 装甲车狂暴自爆：血量低于 hpPct 后冲向最近的玩家步兵/载具（不冲工事与炮台）
    selfBoom: {
      hpPct: 0.5,        // 触发狂暴的血量比例（2026-11-06 用户要求：半血就冲锋）
      chargeMul: 1.7,    // 冲刺速度倍率（普通 65 → 约 110）
      delay: 0.6,        // 被打死时的引爆延迟（比玩家载具的 2.0s 短，才有威胁）
      touchDelay: 0.12,  // 贴身主动引爆的延迟
      teammateMul: 0.7,  // 炸叛军队友的伤害系数（炸玩家沿用 unitMul 0.5）
      vehicleMul: 1.6,   // 对玩家载具的自爆伤害倍率（否则 27 点对 500 血坦克只占 5%）
      windup: 0.7,       // 狂暴预警时长：红光脉冲 + 头顶「!」，之后再开始冲刺
    fleePct: 0.2,      // 残血后不再主动出击（只打 3 格内的近身威胁，否则缩回资源点）
    fleeTiles: 3,      // 残血时仍会还击的半径（格）
    },
  },

  // 暴击：命中时按概率翻倍。霰弹枪兵/狙击手单独调高到 20%（sharpshooter），
  // 溅射武器同样参与，一次开火只 roll 一次 ⇒ 整片同生共死，不会出现半片暴击
  crit: { rate: 0.03, splashRate: 0.02, mult: 2.0 },
  combat: {
    splashAttackMul: 1.35, // 范围伤害单位开火间隔 x1.35
    unitDamageScale: 0.45,  // 僵尸对玩家单位的伤害缩放
    zombieDmgMul: 1.5,     // 所有僵尸伤害 x1.5
  },
  // 特感数量倍率（1 = 原方案；2 = 翻倍）
  spec: { countMul: 2 },
  // 尖叫者：独立于特感档位的固定投放（counts[波次-1] 为该波只数；特感=关 时不投放）
  scream: { counts: [0, 0, 1, 1, 1, 2, 2, 2] },

  // 死亡转行尸（B 档）：被僵尸咬死/打死的步兵按概率延迟起身变成行尸；友伤、自爆不转化
  rise: {
    probs: [0.25, 0.35, 0.45],   // 第 1 / 2 / 3 波起的转变概率
    cap: 10,                     // 每波最多转化出的行尸数
    delay: 0.9,                  // 原单位倒下到行尸起身的延迟（秒）
    mob: 'walker',
  },
  // 游荡僵尸：开局就撒在地图上，不打据点，只给占点添阻力
  roam: {
    count: 18,
    minCoreTiles: 8,      // 生成时离据点至少这么多格
    patrolR: 7,           // 巡逻半径（格）
    leash: 6,             // 追出「巡逻半径 + leash」就放弃
    idleMin: 1.0,         // 到点停顿（秒）
    idleMax: 2.5,
    outerBias: 3,         // 距离加权：每个位置抽几次、留最远的那次（越大越偏外围）
  },
  // 仇恨值（0=关 / 1=轻度（只钉移动单位）/ 2=完整）
  aggro: {
    sightTiles: 5,      // 感知半径（格）
    leashTiles: 4,      // 离获取仇恨位置的最远偏离（格）
    reEval: 0.4,        // 重评半径
    stick: 0.3,         // 已锁定目标的惯性加分
    fireWindow: 4,      // 开火后多久内仍被视为“有威胁”（打它 的时间窗）
    cone: 1.35,          // 只追与“去据点方向”夹角 ≤ 77° 的单位
    maxChase: 8,        // 单次追击最长时间（秒）
    fullDmgMul: 1.5,    // 完整模式下僵尸咬单位的伤害倍率（换取核心安全，有取舍）
    // 叛军拉仇恨：平时与玩家单位同池竞争（视野 1.5 倍、权重持平）；扑核心时退回轻档只做兜底
    raiderAggro: { sightMul: 1.5, weight: 1.0, leashMul: 2, chaseMul: 2 },
    raiderAggroPush: { sightMul: 1, weight: 0.8, leashMul: 1, chaseMul: 1 },
    coreRush: 6,        // 距据点 ≤ 6 格时不再被单位吸引，直接冲据点
    weight: { moving: 1.0, shot: 0.85, idle: 0.7 },   // 行为：移动中 > 正在打它 > 静止
    kind: { ground: 1.0, inside: 0.6, vehicle: 0.6, tower: 0.35 },  // 兵种：空地步兵 > 楼内/载具 > 炮台
    switchHyst: 1.2,    // 换目标需要比当前高 20% 才切（防抖）
  },
  // 友军伤害：范围伤害也会打到自己人（暂停菜单可关）
  friendlyFire: {
    on: true,
    unit: 0.20,   // 步兵 / 载具
    tower: 0.10,  // 炮台类（自动炮台 / 迫击炮 / 燃烧塔）
    building: 0.5, // 玩家范围伤害对建筑的系数（不吃重甲）
    fort: 0.05,   // 工事与建筑（路障 / 铁丝网 / 兵营 / 工厂）
  },
  supply: { start: 700, perSec: 0, cap: 9999, capBase: 1500, capPerLevel: 0, capMax: 1500, clearWave: 30, killRefund: 0, killMul: 0, timeoutCashRatio: 0.5 },  // capBase+capPerLevel×核心等级，上限 1500（2026-11-07 用户要求，全地图；老城开局 1200 留 300 缓冲）
  // 经济：基地产出 + 资源点，击杀不产出
  econ: {
    baseCash: 4.5, baseParts: 0.35,         // 基地每秒（零件 2026-11-08 用户定为 0.35，原 0.224）
    perLevelCash: 0.41, perLevelParts: 0.104,   // 核心每级附加
    clearParts: 4.88,
    captureTime: 10.0,                     // 玩家占领所需秒数
    loseTime: 5.0,                        // 僵尸反推所需秒数
    holdGrace: 25.0,                      // 无人驻守时，多少秒掉光占领进度
    radius: 2.5,                          // 占领半径（格）
    captureCash: 26, captureParts: 10.4,      // 占下一个点的一次性奖励
    upkeepPop: 0.1,                       // 每秒维护费：每 1 人口（基础档）
    upkeepPopStep: { size: 5, add: 0.02 },   // 阶梯维护：每满 5 点人口，每人维护 +0.02/s（30 人口 ⇒ 0.22/人 = 6.6/s）
    upkeepTower: 0.15,                    // 每秒维护费：每座炮台（自动炮台 / 迫击炮 / 燃烧塔）
    // 双向兑换（据点面板 / 键盘）：把后期溢出的资金换成稀缺零件，也能应急把零件变现
    swap: {
      buyCost: 20,                        // 20 资金 → 1 零件
      sellGain: 2,                        // 1 零件 → 2 资金（价差 10 倍，卖只是应急，基本不划算）
      perWave: 20,                        // 每个整备期最多兑换 20 次（买卖合计）
    },
    lateWaveNoClear: 7,                   // 从第 N 波起清波不再发资金
    nodeLevelPer: 0.125,                  // 资源点收益随核心等级：每级 +12.5%
    nodeLevelCap: 1.5,                    // …但封顶 1.5倍
    raid: { fromWave: 2, base: 3, perWave: 2, max: 15, specMul: [1, 1, 1.35], sight: 4.2 },
  },
  // 整备期僵尸照常行动：间隔压到 8s，僵尸只按 70% 速度走，我方伤害补 20%
  prep: { duration: 10, intermission: 8, zombieSpeed: 0.7, unitDmgMul: 1.2 },
  // 建造范围（格）：步兵/载具只能在基地出兵，炮台/工事有半径上限（玩家可调）
  build: { deployRadius: 3, towerRadius: 8, fortRadius: 5 },   // 据点建造范围：炮塔 8 格、工事（兵营）5 格（不再可调）
  queue: { mobile: 1.2, tower: 2.0, fort: 1.5, base: 2.6, perCost: 0.006, towCd: 10 },
  pop: { baseCap: 10, perLevel: 0, maxLevel: 5, capMax: 32, waveCurve: [12, 18, 23, 27, 30, 31, 32] },  // 按「已清波数」取人口上限：开局 10，第 7 波前到 32
  parts: { start: 200, perWave: 24, specKill: 3, bossKill: 15 },
  // 无尽模式：8 波之后不再指数爆炸，转 1.06 的缓增长；每 5 波一个 Boss 波
  // 无尽模式的胜利条件：累计击杀 ≥ kills 且「同时」占领 ≥ nodes 个资源点
  endlessGoal: { kills: 10000, nodes: 4 },
  wave: { total: 8, endlessGrow: 1.06, bossEvery: 5, bossMult: 1.4, threatBase: 112,
    firstBase: 18, threatGrow: 1.18, finalMult: 1.25, batchGap: 3.5, lateWaves: 2, lateMult: 0.98,
    walkerMul: 2.65,          // 行尸数量倍数（潮水感）
    batches: 14,           // 每波拆成多少批（越大越细水长流；18 实测反而更难，保持 14）
  },
  // 行尸个体差异：血量三档（4/4/5 发），攻击与攻速连续 ±12% / ±8%
  zVary: { hp: [35, 40, 46], w: [0.25, 0.5, 0.25], dmg: 0.12, atkSpd: 0.08 },
  // 军衔（精英化）：经验只挂单兵，单位死亡即清零；不做付费升级
  // 经验权重复用 ZOMBIES[].ramWeight（行尸 1 / 特感 2 / 暴君 10）
  // 门槛按「一局 8 波 2000~3000 击杀」定：12 点升老兵（约 12 只行尸），50 点升精英
  rank: {
    xp: [12, 50],        // 累计经验：老兵 / 精英
    dmg: [0.08, 0.16],   // 累计伤害加成：老兵 +8% / 精英 +16%（2026-11-10 用户裁定下调）
    hp: [0.10, 0.20],    // 累计血量加成：老兵 +10% / 精英 +20%
  },
  // 英雄重伤：hp 归零不真死、不殉爆，90 秒后在据点重生；每多倒一次 +30 秒，上限 180 秒
  // 倒地扣 downXp 点经验，掉出阈值 ⇒ 重生后按新经验重算军衔（可能降级）
  hero: { downXp: 15, respawnSec: 30, respawnStep: 10, respawnMax: 60 },
  // 无尽模式里程碑：累计击杀达到这些值就汇报 + 发零件，之后每 step 一档
  milestone: { kills: [1000, 3000, 8000, 20000, 50000], step: 50000, parts: 2 },
  path: { maxPerFrame: 6, repathBatch: 12 },
  // 进攻车道：三个出生点各自沿一条横道推进，到 mergeX 才并入中央大道
  // bands 里每项是「该 spawn 走哪一行」，合流点 mergeX 取纵向大道 54
  // spawnWeight: 三路出怪权重（下/中/上），只改分布不改总量；18% / 41% / 41%
  lane: { bands: [6, 25, 45], mergeX: 42, spawnWeight: [0.41, 0.41, 0.18] },
  perf: { maxZombies: 900, stepDt: 1 / 60, maxSteps: 60 * 60 * 30 },
});

// 默认地图：48×30 城市街区，先铺路再放建筑，保证连通
// 建筑轮廓：用字符串画出来，'#' 为实体格。参考多格拼块，但不做带洞的（U/C 形会围死格子）。
const SHAPE_ART = [
  // 3x3 组
  ['full9', ['###', '###', '###']],
  ['l7', ['###', '###', '#..']],
  ['c7', ['###', '###', '..#']],
  ['t5', ['###', '.#.', '.#.']],
  ['z4', ['.##', '##.', '...']],
  ['plus5', ['.#.', '###', '.#.']],
  ['u5', ['#.#', '###', '...']],
  // 2x2 / 3x2 / 2x3 组
  ['sq4', ['##', '##']],
  ['l3', ['#.', '##']],
  ['rect6', ['###', '###']],
  ['rect6v', ['##', '##', '##']],
  ['s4', ['##.', '.##']],
];
export const BUILDING_SHAPES = Object.freeze(SHAPE_ART.map(([id, rows]) => {
  const raw = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') raw.push([x, y]);
  });
  // 裁到真实外接框：形状必须贴边，不留空行/空列（否则建筑会「悬空」在街区里）
  const minX = Math.min(...raw.map(([x]) => x));
  const minY = Math.min(...raw.map(([, y]) => y));
  const maxX = Math.max(...raw.map(([x]) => x));
  const maxY = Math.max(...raw.map(([, y]) => y));
  const cells = raw.map(([x, y]) => [x - minX, y - minY]);
  return Object.freeze({ id, w: maxX - minX + 1, h: maxY - minY + 1, cells });
}));
function shapesOf(w, h) {
  return BUILDING_SHAPES.filter((s) => s.w === w && s.h === h);
}

export function makeDefaultMap() {
  const W = RULE.grid.W, H = RULE.grid.H, T = RULE.grid.T;
  const map = {
    _id: 'm' + Math.random().toString(36).slice(2, 9),
    schema: 'dcl.map/1',
    meta: { name: '旧城區', author: 'local', v: 1 },
    w: W, h: H, tile: T,
    tiles: new Uint8Array(W * H),
    buildings: [],
    spawns: [],
    core: { x: 68, y: 25 },
    waves: [],
    dirty: true,
  };
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) map.tiles[y * W + x] = v; };
  const get = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? map.tiles[y * W + x] : TILE.BUILDING);

  // 1) 十字主干道：5 条横路 + 5 条纵路（每条宽 2）
  const roadsY = [5, 6, 15, 16, 25, 26, 35, 36, 45, 46];
  const roadsX = [6, 7, 18, 19, 30, 31, 42, 43, 54, 55];
  for (const y of roadsY) for (let x = 0; x < W; x++) map.tiles[y * W + x] = TILE.ROAD;
  for (const x of roadsX) for (let y = 0; y < H; y++) map.tiles[y * W + x] = TILE.ROAD;

  // 2) 街区：4 格节奏的 2x2 / 3x2 / 2x3 建筑，避开道路与据点
  const nearCore = (x, y) => Math.abs(x - map.core.x) <= 3 && Math.abs(y - map.core.y) <= 3;
  const NODE_PTS = [
    { x: 12, y: 2, kind: 'cash' },
    { x: 26, y: 47, kind: 'parts' },
    { x: 38, y: 8, kind: 'parts' },
    { x: 52, y: 41, kind: 'cash' },
    { x: 16, y: 32, kind: 'parts' },
    { x: 62, y: 12, kind: 'cash' },
  ];
  const nearNode = (x, y) => {
    for (const n of NODE_PTS) if (Math.abs(n.x - x) <= 2 && Math.abs(n.y - y) <= 2) return true;
    return false;
  };
  const tryBlock = (bx, by, bw, bh, pick) => {
    const pool = shapesOf(bw, bh);
    if (!pool.length) return false;
    const shape = pool[((pick >>> 0) % pool.length)];
    for (const [dx, dy] of shape.cells) {
      const x = bx + dx, y = by + dy;
      if (get(x, y) !== TILE.GROUND || nearCore(x, y) || nearNode(x, y)) return false;
    }
    const maxHp = BUILDING_HP_PER_TILE * shape.cells.length;
    map.buildings.push({
      x: bx, y: by, w: bw, h: bh, shape: shape.id,
      cells: shape.cells.map(([dx, dy]) => [dx, dy]),
      hp: maxHp, maxHp, destructible: true,
    });
    for (const [dx, dy] of shape.cells) set(bx + dx, by + dy, TILE.BUILDING);
    return true;
  };
  // 4x4 街区内尽量铺满：先试 3x3，再试 2x2 / 3x2 / 2x3
  // 3x3 建筑 + 四周强制 1 格留白 => 相邻建筑之间至少 2 格宽街道
  const areaFree = (bx, by, bw, bh) => {
    for (let y = by - 1; y <= by + bh; y++) {
      for (let x = bx - 1; x <= bx + bw; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (get(x, y) === TILE.BUILDING) return false;
      }
    }
    return true;
  };
  for (let by = 1; by < H - 3; by += 1) {
    for (let bx = 1; bx < W - 3; bx += 1) {
      const k = (bx * 7 + by * 13) % 23;
      if (k === 0) continue;
      if (!areaFree(bx, by, 3, 3)) continue;
      tryBlock(bx, by, 3, 3, bx * 131 + by * 197);
    }
  }
  // 再补一轮小块：2x2 / 3x2 / 2x3 的拼块把空隙吃掉
  for (let by = 1; by < H - 2; by += 1) {
    for (let bx = 1; bx < W - 3; bx += 1) {
      const k = (bx * 11 + by * 17) % 7;
      const sizes = k < 2 ? [[2, 2]] : (k < 4 ? [[3, 2], [2, 3]] : [[2, 3], [3, 2], [2, 2]]);
      for (const [sw, sh] of sizes) {
        if (!areaFree(bx, by, sw, sh)) continue;
        if (tryBlock(bx, by, sw, sh, bx * 71 + by * 233 + sw * 13)) break;
      }
    }
  }

  // 3) 据点广场（中间两行马路，四角高地）
  for (let y = map.core.y - 3; y <= map.core.y + 3; y++) {
    for (let x = map.core.x - 3; x <= map.core.x + 3; x++) {
      const onRoad = (y === map.core.y || y === map.core.y - 1);
      set(x, y, onRoad ? TILE.ROAD : TILE.GROUND);
    }
  }
  for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    set(map.core.x + dx, map.core.y + dy, TILE.HIGHLAND);
  }
  // 两块低地（死尸减速）+ 两块高地（射程加成）
  for (let y = 20; y <= 22; y++) for (let x = 24; x <= 28; x++) set(x, y, TILE.LOWLAND);
  for (let y = 30; y <= 31; y++) for (let x = 58; x <= 62; x++) set(x, y, TILE.LOWLAND);
  for (let y = 10; y <= 11; y++) for (let x = 12; x <= 16; x++) set(x, y, TILE.HIGHLAND);
  for (let y = 40; y <= 41; y++) for (let x = 36; x <= 40; x++) set(x, y, TILE.HIGHLAND);
  for (let i = map.buildings.length - 1; i >= 0; i--) {
    const b = map.buildings[i];
    const hit = b.x <= map.core.x + 3 && b.x + b.w > map.core.x - 4 &&
                b.y <= map.core.y + 3 && b.y + b.h > map.core.y - 4;
    if (hit) map.buildings.splice(i, 1);
  }

  // 4) 资源点：6 个，越靠近工业区越危险
  map.nodes = NODE_PTS.map((n) => ({ ...n }));
  markNodeHighland(map);
  // 5) 三条进攻路线（均从西侧射入）
  map.spawns = [{ x: 0, y: 6 }, { x: 0, y: 25 }, { x: 0, y: 44 }];
  for (const s of map.spawns) {
    for (let y = s.y; y <= s.y + 1; y++) for (let x = s.x; x <= s.x + 2; x++) set(x, y, TILE.ROAD);
  }
  for (let i = map.buildings.length - 1; i >= 0; i--) {
    const b = map.buildings[i];
    let overlap = false;
    for (const s of map.spawns) {
      if (b.x <= s.x + 2 && b.x + b.w >= s.x && b.y <= s.y + 1 && b.y + b.h >= s.y) overlap = true;
    }
    if (overlap) {
      for (const [dx, dy] of (b.cells && b.cells.length ? b.cells : [])) set(b.x + dx, b.y + dy, TILE.GROUND);
      if (!(b.cells && b.cells.length)) {
        for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) set(xx, yy, TILE.GROUND);
      }
      map.buildings.splice(i, 1);
    }
  }
  // 资源点周围留出空地：清掉覆盖它的建筑 / 树，保证 5×5 可走
  for (const n of (map.nodes || [])) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const xx = n.x + dx, yy = n.y + dy;
        if (xx < 0 || yy < 0 || xx >= map.w || yy >= map.h) continue;
        const bi = map.buildings.findIndex((bb) => (bb.cells && bb.cells.length
          ? bb.cells.some(([dx, dy]) => bb.x + dx === xx && bb.y + dy === yy)
          : (xx >= bb.x && xx < bb.x + bb.w && yy >= bb.y && yy < bb.y + bb.h)));
        if (bi >= 0) {
          const bb = map.buildings[bi];
          if (bb.cells && bb.cells.length) {
            for (const [dx, dy] of bb.cells) set(bb.x + dx, bb.y + dy, TILE.GROUND);
          } else {
            for (let yy2 = bb.y; yy2 < bb.y + bb.h; yy2++) for (let xx2 = bb.x; xx2 < bb.x + bb.w; xx2++) set(xx2, yy2, TILE.GROUND);
          }
          map.buildings.splice(bi, 1);
        }
        if (map.tiles[yy * map.w + xx] === TILE.BUILDING) map.tiles[yy * map.w + xx] = TILE.GROUND;
      }
    }
  }
  // 收尾：建筑格强制回到 BUILDING（高地/广场/道路的后续雕刻不得吃掉建筑格）
  for (const b of map.buildings) {
    if (b.hp <= 0) continue;
    if (b.cells && b.cells.length) {
      for (const [dx, dy] of b.cells) set(b.x + dx, b.y + dy, TILE.BUILDING);
    } else {
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) set(b.x + x, b.y + y, TILE.BUILDING);
    }
  }
  // 兜底：没有任何楼认领的 BUILDING 格 = 隐形占格，清回地面
  {
    const owner = new Uint8Array(W * H);
    for (const b of map.buildings) {
      if (b.hp <= 0) continue;
      const cs = b.cells && b.cells.length ? b.cells : null;
      if (cs) {
        for (const [dx, dy] of cs) {
          const x = b.x + dx, y = b.y + dy;
          if (x >= 0 && y >= 0 && x < W && y < H) owner[y * W + x] = 1;
        }
      } else {
        for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
          if (x >= 0 && y >= 0 && x < W && y < H) owner[y * W + x] = 1;
        }
      }
    }
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] === TILE.BUILDING && !owner[i]) map.tiles[i] = TILE.GROUND;
    }
  }
  markGarrison(map);
  return map;
}

