/* camera.js — 镜头控制：跟随/自由/聚焦，平滑过渡，对数缩放
 * 所有镜头计算在"世界坐标"（three 系 km, double）中完成，
 * 每帧把相机世界坐标交给 scene 做浮动原点渲染。
 * 偏移向量为严格单位球坐标（sinφ·cosθ, cosφ, sinφ·sinθ），
 * 保证旋转时视距不发生变化。 */
(function () {
  'use strict';

  const state = {
    mode: 'follow',            // 'follow'（跟随 Cassini）| 'free'（全局自由）
    focusName: 'cassini',      // 当前聚焦目标（body 名或 'cassini'）
    theta: 0.9, phi: 1.05,
    dist: 4.2e6,
    sTheta: 0.9, sPhi: 1.05, sDist: 4.2e6,
    anim: null,
    target: [0, 0, 0],
    panX: 0, panY: 0,          // 平移偏移目标值
    panSX: 0, panSY: 0,        // 平移偏移平滑显示值（update() 中缓动追踪目标）
  };

  let canvas;
  let dragging = 0;
  let lastX = 0, lastY = 0;
  let lastUpdate = 0;

  const MIN_DIST = 0.02;       // 20 m
  const MAX_DIST = 2.6e10;     // 足以纳入海王星轨道（45 亿 km）的全景

  function init(canvasEl) {
    canvas = canvasEl;

    canvas.addEventListener('mousedown', (e) => {
      dragging = e.button === 2 ? 2 : 1;
      lastX = e.clientX; lastY = e.clientY;
      state.anim = null;
    });
    window.addEventListener('mouseup', () => { dragging = 0; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging === 1) {
        // 只更新目标角：sTheta/sPhi 由 update() 的指数缓动追踪，拖拽旋转带轻微平滑
        state.theta += dx * 0.005;
        state.phi = Math.max(0.02, Math.min(Math.PI - 0.02, state.phi - dy * 0.005));
      } else {
        const scale = state.dist * 0.0016;
        state.panX -= dx * scale;
        state.panY += dy * scale;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = Math.exp(e.deltaY * 0.0012);
      state.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, state.dist * k));
      state.anim = null;
      // 不直接同步 sDist：update() 中按帧率无关的指数缓动追踪目标距离，实现平滑缩放
    }, { passive: false });

    let touchDist = 0;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        dragging = 1; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        dragging = 0;
        touchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && dragging === 1) {
        const dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY;
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        // 同鼠标拖拽：只更新目标角，平滑交给 update()
        state.theta += dx * 0.005;
        state.phi = Math.max(0.02, Math.min(Math.PI - 0.02, state.phi - dy * 0.005));
      } else if (e.touches.length === 2) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        if (touchDist > 0) {
          const k = touchDist / d;
          state.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, state.dist * k));
        }
        touchDist = d;
      }
    }, { passive: true });
    canvas.addEventListener('touchend', () => { dragging = 0; touchDist = 0; });
  }

  function focus(name, opts) {
    opts = opts || {};
    state.focusName = name;
    state.panX = 0; state.panY = 0;
    if (opts.theta !== undefined) { state.theta = opts.theta; state.sTheta = opts.theta; }
    if (opts.phi !== undefined) { state.phi = opts.phi; state.sPhi = opts.phi; }
    if (opts.dist !== undefined) {
      state.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, opts.dist));
      if (opts.animate === false) state.sDist = state.dist;
    }
  }

  function nearestAngle(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return from + d;
  }

  /* 带缓动过渡的聚焦（对数距离插值 + 角度插值 + 目标位置插值）
   * 切换聚焦天体时，镜头目标点从旧目标平滑过渡到新目标（而非跳变），
   * 距离/角度同步插值，形成完整的飞掠式过渡动画。 */
  function flyTo(name, opts) {
    opts = opts || {};
    state._fromFocus = state.focusName;   // 记录旧聚焦目标，动画期间目标点在其与新目标间插值
    focus(name, {});
    const fromDist = state.sDist;
    const toDist = Math.max(MIN_DIST, Math.max(MIN_DIST, Math.min(MAX_DIST, opts.dist !== undefined ? opts.dist : state.dist)));
    state.dist = toDist;
    const fromTheta = state.sTheta, toTheta = opts.theta !== undefined ? opts.theta : nearestAngle(state.sTheta, state.theta);
    const fromPhi = state.sPhi, toPhi = opts.phi !== undefined ? opts.phi : state.phi;
    const dur = opts.duration || 1.8;
    const start = performance.now();
    state._animK = 0;
    state.anim = (now) => {
      let k = (now - start) / (dur * 1000);
      if (k >= 1) k = 1;
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      state.sDist = Math.exp(Math.log(fromDist) * (1 - e) + Math.log(toDist) * e);
      state.dist = state.sDist;
      state.sTheta = fromTheta * (1 - e) + toTheta * e;
      state.sPhi = fromPhi * (1 - e) + toPhi * e;
      state._animK = e;
      if (k >= 1) { state.anim = null; state._animK = 0; state._fromFocus = null; }
    };
  }

  /* 启动序章：自黄道上方极远处推近至 Cassini */
  function intro(durationSec) {
    state.focusName = 'cassini';
    state.theta = 2.35; state.phi = 0.72;
    state.dist = 1.8e10; state.sDist = 1.8e10;
    state.sTheta = 2.35; state.sPhi = 0.72;
    flyTo('cassini', { dist: 4.2e6, theta: 0.9, phi: 1.05, duration: durationSec || 5 });
  }

  /* 每帧更新。bodyWorld: name -> [x,y,z]（three 系世界坐标），cassWorld: Cassini 世界坐标 */
  function update(now, bodyWorld, cassWorld, scene) {
    if (state.anim) state.anim(now);

    let tgt;
    if (state.focusName === 'cassini') tgt = cassWorld;
    else if (bodyWorld[state.focusName]) tgt = bodyWorld[state.focusName];
    else tgt = cassWorld;

    // 切换聚焦过渡：目标点在旧聚焦体与新聚焦体的实时世界坐标之间插值（两边都在动，逐帧取实时位置）
    if (state.anim && state._animK !== undefined) {
      let fromTgt;
      if (state._fromFocus === 'cassini') fromTgt = cassWorld;
      else fromTgt = bodyWorld[state._fromFocus];
      if (!fromTgt) fromTgt = state.target;   // 旧目标缺失时退回上一帧镜头目标
      const e = state._animK;
      tgt = [
        fromTgt[0] + (tgt[0] - fromTgt[0]) * e,
        fromTgt[1] + (tgt[1] - fromTgt[1]) * e,
        fromTgt[2] + (tgt[2] - fromTgt[2]) * e,
      ];
    } else {
      state._fromFocus = null;
    }
    state.target = tgt;

    let minD = MIN_DIST;
    const reg = scene.registry;
    if (state.focusName !== 'cassini' && reg.get(state.focusName)) {
      minD = reg.get(state.focusName).radius * 1.25;
    }
    const dEff = Math.max(state.sDist, minD);

    // 帧率无关的指数缓动：旋转/平移稍缓（拖拽带轻微平滑），缩放追踪略快
    const dtS = lastUpdate ? Math.min(0.1, Math.max(0, (now - lastUpdate) / 1000)) : 1 / 60;
    lastUpdate = now;
    const smRot = 1 - Math.exp(-dtS * 9);
    const sm = 1 - Math.exp(-dtS * 12);
    state.sTheta += (state.theta - state.sTheta) * smRot;
    state.sPhi += (state.phi - state.sPhi) * smRot;
    state.panSX += (state.panX - state.panSX) * sm;
    state.panSY += (state.panY - state.panSY) * sm;
    state.sDist = Math.exp(Math.log(state.sDist) + (Math.log(state.dist) - Math.log(state.sDist)) * sm);

    // 严格单位球坐标偏移：旋转不改变视距
    const st = Math.sin(state.sTheta), ct = Math.cos(state.sTheta);
    const sp = Math.sin(state.sPhi), cp = Math.cos(state.sPhi);
    const off = [sp * ct, cp, sp * st];
    const cam = [
      tgt[0] + off[0] * dEff,
      tgt[1] + off[1] * dEff,
      tgt[2] + off[2] * dEff,
    ];

    if (state.panSX || state.panSY) {
      const f = [tgt[0] - cam[0], tgt[1] - cam[1], tgt[2] - cam[2]];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      f[0] /= fl; f[1] /= fl; f[2] /= fl;
      const r = [f[2], 0, -f[0]];
      const rl = Math.hypot(r[0], r[2]) || 1;
      r[0] /= rl; r[2] /= rl;
      cam[0] += r[0] * state.panSX; cam[2] += r[2] * state.panSX;
      cam[1] += state.panSY;
      tgt[0] += r[0] * state.panSX; tgt[2] += r[2] * state.panSX; tgt[1] += state.panSY;
    }

    scene.setCameraWorld(cam);
    const camObj = scene.camera;
    camObj.position.set(0, 0, 0);
    const look = new THREE.Vector3(
      tgt[0] - cam[0], tgt[1] - cam[1], tgt[2] - cam[2]);
    if (look.lengthSq() < 1e-24) look.set(0, 0, -1);
    camObj.lookAt(look);
    camObj.updateMatrixWorld(); // 立即生效，避免标签投影滞后一帧
  }

  function currentDist() { return state.sDist; }
  function currentFocus() { return state.focusName; }
  function currentMode() { return state.mode; }
  function setMode(m) { state.mode = m; }
  function markManualEdit() { state.anim = null; }

  window.CassiniCamera = {
    init, focus, flyTo, intro, update, currentDist, currentFocus, currentMode, setMode,
    get state() { return state; },
    MAX_DIST, MIN_DIST,
  };
})();
