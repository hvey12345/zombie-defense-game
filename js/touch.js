// 手机版输入层：拖动平移 / 轻点选择与移动 / 双指缩放
// 复用 main.js 的点击逻辑（合成 mouse 事件），不重写选择与指令。

window.__dshMobile = true;

const cv = document.getElementById('cv');
const app = window.__dcl;
const H = () => window.__dclHit;

const TAP_MS = 260;      // 按下到抬起时长上限
const TAP_PX = 12;       // 位移阈值，超过就算拖动
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 2.2;

let pts = new Map();     // pointerId -> {x, y}
let press = null;        // 单指按下信息
let pinch = null;        // 双指缩放信息

function canvasPos(clientX, clientY) {
  const r = cv.getBoundingClientRect();
  const sx = (clientX - r.left) * (cv.width / r.width);
  const sy = (clientY - r.top) * (cv.height / r.height);
  return { sx, sy, scale: cv.width / r.width };
}

function hasSelection() {
  return !!(app.sel.size || app.selF != null || app.selCore
    || app.selNode != null || app.selRaid != null || app.selZ != null);
}

// 触点上有没有“可点中的东西”（单位/工事/敌人/据点/资源点）
function hitAt(x, y) {
  const h = H();
  if (!h) return true;  // 桥还没就绪：一律按点击处理，别误判成移动
  return !!(h.unitAt(x, y) || h.fortAt(x, y) || h.zombieAt(x, y)
    || h.raiderAt(x, y) || h.coreHit(x, y) || h.nodeAt(x, y));
}

function synth(type, clientX, clientY, button) {
  const ev = new MouseEvent(type, {
    bubbles: true, cancelable: true,
    clientX, clientY,
    button: button || 0,
    buttons: button === 2 ? 2 : 1,
  });
  cv.dispatchEvent(ev);
}

function tapAt(clientX, clientY) {
  const p = H() ? H().posFromEvent({ clientX, clientY }) : null;
  if (!p) return;
  const tool = app.tool && app.tool.kind;
  // 建造 / 拆除 / 巡逻 / 技能瞄准：一律走左键（落点优先）
  if (app.skillMode || (tool && tool !== 'select')) {
    synth('mousedown', clientX, clientY, 0);
    synth('mouseup', clientX, clientY, 0);
    return;
  }
  // 有选中 + 点到空地 = 移动（等价桌面的右键）
  if (hasSelection() && !hitAt(p.x, p.y)) {
    synth('contextmenu', clientX, clientY, 2);
    return;
  }
  synth('mousedown', clientX, clientY, 0);
  synth('mouseup', clientX, clientY, 0);
}

cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;   // 桌面鼠标仍走原逻辑
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pts.size === 1) {
    press = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    pinch = null;
  } else if (pts.size === 2) {
    press = null;
    const [a, b] = [...pts.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom: app.zoom || 1,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }
}, { passive: false });

cv.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') return;
  if (!pts.has(e.pointerId)) return;
  e.preventDefault();
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // 双指缩放
  if (pts.size >= 2 && pinch) {
    // 手机档：缩放事件最多 30Hz，避免每帧重算视图与重绘
    const _now = performance.now();
    if (_now - (pinch.lastAt || 0) < 33) return;
    pinch.lastAt = _now;
    const [a, b] = [...pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const want = pinch.zoom * (dist / pinch.dist);
    const c = canvasPos(cx, cy);
    window.__dclZoom(want, c.sx, c.sy);
    return;
  }

  // 单指拖动平移
  if (!press) return;
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  if (!press.moved && Math.hypot(dx, dy) < TAP_PX) return;
  press.moved = true;
  const c = canvasPos(e.clientX, e.clientY);
  const prev = canvasPos(press.x, press.y);
  // 手指右移 = 视野左移
  window.__dclPan(-(c.sx - prev.sx) / (app.zoom || 1), -(c.sy - prev.sy) / (app.zoom || 1));
  press.x = e.clientX;
  press.y = e.clientY;
}, { passive: false });

function endPointer(e) {
  if (e.pointerType === 'mouse') return;
  pts.delete(e.pointerId);

  if (pts.size === 1) {
    // 双指松掉一根：重新记单指起点，避免残留拖动
    const [rest] = [...pts.values()];
    press = { x: rest.x, y: rest.y, t: performance.now(), moved: true };
    pinch = null;
    return;
  }
  if (pts.size === 0) {
    const wasPinch = !!pinch;
    pinch = null;
    if (press && !press.moved && !wasPinch
      && performance.now() - press.t <= TAP_MS) {
      // 手机档：两次点击至少间隔 110ms，挡住双指抬起时的误触
      const _tn = performance.now();
      if (_tn - (window.__dshLastTap || 0) >= 110) {
        window.__dshLastTap = _tn;
        tapAt(e.clientX, e.clientY);
      }
    }
    press = null;
  }
}

cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse' && pts.has(e.pointerId)) endPointer(e);
});

// 触屏不要双指缩放整页 / 双击缩放
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

// 手机专用按钮组：默认收起成一个 ☰，点开才展开（不再常驻压住地图）
(function buildTools() {
  const fab = document.createElement('button');
  fab.id = 'mfab';
  fab.type = 'button';
  fab.innerHTML = '<span>☰</span><em class="rd"></em>';
  fab.setAttribute('aria-label', '更多操作');
  document.body.appendChild(fab);

  const box = document.createElement('div');
  box.id = 'mtools';
  box.innerHTML = [
    ['strike', '炮击'],
    ['fire', '燃烧弹'],
    ['airdrop', '空降兵'],
  ].map(([id, nm]) => '<button data-kind="skill" data-id="' + id + '"><img src="assets/icons/' + id + '.png" alt=""><b>' + nm + '</b><span class="cd"></span></button>').join('');
  document.body.appendChild(box);
  // 图标直接抄桌面技能按钮的（空降兵用的是 infantry.png，不是 skill_airdrop.png）
  for (const b of box.querySelectorAll('button[data-kind="skill"]')) {
    const src = document.getElementById('skill-' + b.dataset.id);
    const im = src && src.querySelector('img');
    const tgt = b.querySelector('img');
    if (im && tgt) {
      const u = im.getAttribute('src');
      if (u) tgt.setAttribute('src', u);
    }
  }

  // 常驻常用键：全选同类 / 取消选中（右缘竖排，3 秒无操作自动淡出）
  const quick = document.createElement('div');
  quick.id = 'mquick';
  quick.innerHTML = [
    '<button data-act="same">全选<br>同类</button>',
    '<button data-act="clear">取消<br>选中</button>',
    '<button data-act="deploy">架设</button>',
    '<button data-act="garrison" class="off">进驻</button>',
  ].join('');
  document.body.appendChild(quick);

  const qDeploy = quick.querySelector('[data-act="deploy"]');
  const qSame = quick.querySelector('[data-act="same"]');
  const qClear = quick.querySelector('[data-act="clear"]');
  const qGarrison = quick.querySelector('[data-act="garrison"]');


  let dimTimer = 0;
  function wake() {
    quick.classList.remove('dim');
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => quick.classList.add('dim'), 3000);
  }
  wake();
  window.addEventListener('pointerdown', () => { wake(); }, { passive: true });

  function syncQuick() {
    const v = window.__dclView ? window.__dclView() : null;
    const picked = v && (v.sel > 0 || v.selCore || v.selF || v.selNode);
    qSame.classList.toggle('off', !picked);
    qClear.classList.toggle('off', !picked);
    // 换弹 / 架设：跟桌面版原按钮的可点状态同步
    const mirror = (srcId, dst) => {
      const src = document.getElementById(srcId);
      if (src && dst) {
        const off = src.classList.contains('na') || src.classList.contains('locked') || src.disabled;
        dst.classList.toggle('off', off);
      }
    };
    mirror('btn-deploy', qDeploy);
    if (qGarrison) {
      const ok = window.__dclGarrisonReady ? window.__dclGarrisonReady(2) : false;
      qGarrison.classList.toggle('off', !ok);
    }
  }
  syncQuick();
  setInterval(syncQuick, 350);

  // 冷却/可用性：直接镜像原按钮（原技能按钮在冷却时把文字改成「12s」）
  const SK = ['strike', 'fire', 'airdrop'];
  function syncSkills() {
    let ready = 0;
    for (const id of SK) {
      const src = document.getElementById('skill-' + id);
      const btn = box.querySelector('[data-id="' + id + '"]');
      if (!src || !btn) continue;
      const cooling = src.classList.contains('cooling');
      const poor = src.classList.contains('poor');
      const lab = src.querySelector('i');
      const txt = cooling && lab ? lab.textContent.trim() : '';
      if (!cooling && !poor) ready += 1;
      const b1 = btn.querySelector('.cd');
      if (b1) b1.textContent = txt;
      btn.classList.toggle('off', cooling || poor);
    }
    const badge = fab.querySelector('.rd');
    if (badge) badge.textContent = ready > 0 ? String(ready) : '';
    fab.classList.toggle('off', ready === 0);
  }
  syncSkills();
  setInterval(syncSkills, 350);

  quick.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    wake();
    const act = btn.dataset.act;
    if (act === 'same') {
      const n = window.__dclSel && window.__dclSel.sameKind();
      if (n > 0) {
        btn.innerHTML = '已选 ' + n;
        setTimeout(() => { btn.innerHTML = '全选<br>同类'; }, 1200);
      }
    } else if (act === 'clear') {
      if (window.__dclSel) window.__dclSel.clearAll();
    } else if (act === 'deploy') {
      if (window.__dclSel) window.__dclSel.deploy();
    } else if (act === 'garrison') {
      if (window.__dclGarrisonGo) window.__dclGarrisonGo(2);
    }
    syncQuick();
  });

  function placeFab() {
    const bb = document.getElementById('buildbar');
    const h = bb && getComputedStyle(bb).display !== 'none' ? bb.getBoundingClientRect().height : 0;
    fab.style.bottom = (h + 14) + 'px';
    box.style.bottom = (h + 62) + 'px';
  }
  placeFab();

  function close() {
    box.classList.remove('open');
    fab.classList.remove('open');
    placeFab();
  }
  fab.addEventListener('click', () => {
    const on = box.classList.toggle('open');
    fab.classList.toggle('open', on);
    placeFab();
  });

  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.kind === 'skill' && id) {
      const src = document.getElementById('skill-' + id);
      if (src) src.click();
    }
    close();
  });
})();

// 按需浮出操作条：有可生产项 / 有可用指令时才出现，选中被清空就收起
(function barGate() {
  const bb = document.getElementById('buildbar');
  if (!bb) return;
  let last = null;
  setInterval(() => {
    const prod = bb.querySelectorAll('#prod-list .prod-item').length;
    const tools = bb.querySelectorAll('#tool-list .build:not(.na):not(.locked)').length;
    const v = window.__dclView ? window.__dclView() : null;
    const picked = !!v && (v.sel > 0 || v.selCore || !!v.selF || !!v.selNode);
    const want = picked && (prod > 0 || tools > 0);
    if (want === last) return;
    last = want;
    bb.classList.toggle('bar-open', want);
    document.body.classList.toggle('bar-open', want);
    const fab = document.getElementById('mfab');
    if (fab) fab.style.bottom = (want ? 108 : 78) + 'px';
  }, 350);
})();

// 画布铺满视口：改 backing store，宽高比跟设备一致，避免信箱黑边与拉伸
let DPR = Math.min(1.5, window.devicePixelRatio || 1);
// 尸潮降档：main.js 在僵尸爆量时调到 1.0，回落后再升回 1.5
function setDpr(v) {
  const nv = Math.max(1, Math.min(1.5, v));
  if (Math.abs(nv - DPR) < 0.01) return;
  DPR = nv;
  fitCanvas();
}
window.__dclSetDpr = setDpr;
window.__dclDpr = () => DPR;   // v23：手机上省 44% 像素填充
function fitCanvas() {
  const w = Math.round(window.innerWidth * DPR);
  const h = Math.round(window.innerHeight * DPR);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
    if (window.__dclClamp) window.__dclClamp();
  }
}
fitCanvas();

// 横竖屏提示（m.html 里有 #rotate 层，这里只管 class 与暂停）
const rotate = document.getElementById('rotate');
function syncOrient() {
  const portrait = window.innerHeight > window.innerWidth;
  if (rotate) rotate.classList.toggle('show', portrait);
}
window.addEventListener('resize', () => { fitCanvas(); syncOrient(); });
window.addEventListener('orientationchange', () => { fitCanvas(); syncOrient(); });
syncOrient();

// ===== v23：底栏两行（名称血量 / 伤害·射程·射速）+ 生产格造价缩写 + perf 面板 =====
(function mobileInfo() {
  const tag = document.querySelector('#buildbar .src-tag');
  if (!tag) return;
  let l2 = document.getElementById('msrc2');
  if (!l2) {
    l2 = document.createElement('span');
    l2.id = 'msrc2';
    tag.appendChild(l2);
  }
  const sub = document.getElementById('src-sub');
  function trimCosts() {
    const list = document.getElementById('prod-list');
    if (!list) return;
    for (const i of list.querySelectorAll('.prod-item i')) {
      const t = i.textContent;
      if (t && t.indexOf('件') >= 0) i.textContent = t.replace(/\s*\+\s*(\d+)\s*件/, '+$1');
    }
  }
  const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
  function syncPanel() {
    const app = window.__dcl;
    const pickedUnit = !!(app && app.sel && app.sel.size > 0);
    if (pickedUnit) {
      // 主读数取自 #src-sub：syncBarTitle 用 def 直接拼，永远是真实数值
      const subTxt = sub ? sub.textContent : '';
      const grab = (label) => {
        const m = subTxt.match(new RegExp(label + '\\s*([0-9.]+)'));
        return m ? m[1] : '';
      };
      const snap = window.__dclUnit;
      const d = grab('攻击') || (snap ? `${snap.dmg}` : txt('ui-dmg'));
      const r = grab('射程') || (snap ? snap.range : txt('ui-range'));
      const rt = grab('射速') || (snap ? snap.rate : txt('ui-rate'));
      const parts = [];
      if (d && d !== '—') parts.push('伤害 ' + d.replace(/\s*[（(].*[)）]\s*$/, ''));
      if (r && r !== '—') parts.push('射程 ' + r);
      if (rt && rt !== '—') parts.push('射速 ' + rt);
      l2.textContent = parts.join(' · ');
      l2.style.display = '';
      if (sub) sub.style.display = 'none';
    } else {
      l2.style.display = 'none';
      if (sub) sub.style.display = '';
    }
  }
  trimCosts();
  syncPanel();
  setInterval(() => { trimCosts(); syncPanel(); }, 300);
})();
  // ===== v27：面板分级 =====
  // 非玩家对象（空地/树/别人的建筑）不弹面板；僵尸只留图标+血量
  (function panelTier() {
    const body = document.body;
    function tick() {
      const app = window.__dcl;
      if (!app) return;
      const unitPicked = !!(app.sel && app.sel.size > 0);
      const zPicked = app.selZ != null;
      const ownPicked = !!(app.selF || app.selNode || app.selCore || app.selRaid != null);
      body.classList.toggle('m-zcard', !unitPicked && zPicked && !ownPicked);
      body.classList.toggle('m-nocard', !unitPicked && !zPicked && !ownPicked);
    }
    tick();
    setInterval(tick, 300);
  })();


// ===== v23：?perf=1 性能浮层（FPS / 帧耗时 / 实体数）=====
(function perf() {
  if (/[?&]perf=0\b/.test(location.search)) return;   // 手机档默认显示，?perf=0 关
  const box = document.createElement('div');
  box.id = 'mperf';
  document.body.appendChild(box);
  let last = 0, acc = 0, n = 0, fps = 0, lastCount = -1;
  function tick(t) {
    if (last) {
      const dt = t - last;
      acc += dt; n += 1;
    }
    last = t;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  setInterval(() => {
    const _cur = (window.__dcl && window.__dcl.renderCount) || 0;
    if (lastCount >= 0) fps = Math.max(0, Math.round((_cur - lastCount) * 2));
    lastCount = _cur;
    const run = window.__dcl && window.__dcl.run;
    const z = run ? run.zombies.length : 0;
    const u = run ? run.units.length : 0;
    const rd = run ? (run.raiders ? run.raiders.length : 0) : 0;
    const dc = run && run.decals ? run.decals.length : 0;
    
    box.textContent = `FPS ${fps} · 僵尸 ${z} · 我方 ${u} · 叛军 ${rd} · 痕迹 ${dc} · DPR ${DPR.toFixed(1)} · ${window.innerWidth}×${window.innerHeight}`;
    const _ap = window.__dcl || {};
    box.textContent += ' \u00b7 \u903b ' + (_ap.msLogic || 0).toFixed(1) + 'ms \u00b7 \u7ed8 ' + (_ap.msDraw || 0).toFixed(1) + 'ms';
  }, 500);
})();

  // ===== v28：标题页/设置/帮助/暂停面板打开时，收起手机专有按钮 =====
  (function uiGate() {
    const body = document.body;
    function tick() {
      const title = document.getElementById('title');
      const titleOn = !!(title && !title.classList.contains('hidden'));
      const panelOn = !!document.querySelector('.title-panel:not(.hidden)');
      const pauseOn = !!(document.getElementById('pausemenu') && !document.getElementById('pausemenu').classList.contains('hidden'));
      const resultOn = !!(document.getElementById('result') && !document.getElementById('result').classList.contains('hidden'));
      body.classList.toggle('m-ui-off', titleOn || panelOn || pauseOn || resultOn);
    }
    tick();
    setInterval(tick, 300);
  })();
