/* Huygens 分离后独立飞行可视化（真实 dynamo 腿数据）
 *
 * 2004-12-25 02:00 UTC 分离（相对速度 ~0.35 m/s）后，Huygens 沿 NASA Eyes
 * dynamo 的真实轨迹飞行（tools/bake_data.py 烘焙自 sc_huygens/saturn/orb
 * 土星中心巡航腿（28 个根数关键帧，转移周期 31.9 天与真实 C 轨道一致）与
 * sc_huygens/titan/orb Titan 中心进入双曲线，存于 CASSINI_DATA.spacecraft.
 * cassini.huygens），于 2005-01-14 09:06 UTC 进入 Titan 大气，经 2h27m
 * 气动减速—降落伞下降后于约 11:30 UTC 着陆（NASA science.nasa.gov：descent
 * lasted 2h27m / landed about 11:30 UTC / survived another 72 minutes on the
 * surface）——着陆 + 72 min 失联（LOS）后移除探测器模型/标记/标签，
 * 轨迹保留为已飞历史。
 *
 * 轨迹与显示（与 Cassini 同一套 SOI 参考系逻辑，item 2/3/4）：
 *   绝对轨迹（日心系）—— 巡航段 = saturn(t) + relSat；进入/下降段 =
 *     saturn(t) + titan(t) + relTit；全程显示；进入行星 SOI 降亮度，
 *     再进入 Titan SOI 再降（absDim 与 scene.js 逐值一致）。
 *   一级（相对土星）—— Saturn SOI 内淡入；进入 Titan SOI 时降亮度。
 *   二级（相对 Titan）—— Titan SOI 内淡入（真空双曲线进入段 + 下降段）。
 *   姿态：防热大底(+Z) 巡航段沿土星系轨迹切向、进入后沿相对 Titan 气流方向
 *   （进入界面处的快速重定向即真实气动减速行为）；分离后 7 rpm 自旋稳定。
 * 三条轨迹线随浮动原点逐帧重定基准；一级/二级锚定在母星当前模型位置上。
 */
window.HuygensVis = (function () {
  'use strict';

  const DATA = window.CASSINI_DATA;
  const HUY = DATA.spacecraft.cassini.huygens || null;
  const J2000_MS = 946728000000;
  const et = (utc) => (Date.parse(utc) - J2000_MS) / 1000;

  // 时间常量（与烘焙端一致；数据缺失时退回事件表口径）
  const SEP_ET = HUY ? HUY.sepEt : et('2004-12-25T02:00:00Z');
  const ENTRY_ET = HUY ? HUY.entryEt : et('2005-01-14T09:06:00Z');
  const TD_ET = HUY ? HUY.tdEt : ENTRY_ET + 2 * 3600 + 27 * 60;
  const LOS_ET = HUY ? HUY.losEt : TD_ET + 72 * 60;

  // SOI 半径与亮度联动系数（与 scene.js SOI_SHOW / ABS_DIM* 逐值一致）
  const SOI_SATURN = 5.45e7, SOI_TITAN = 4.33e4;
  const ABS_DIM1 = 0.45, ABS_DIM2 = 0.35, REL1_DIM2 = 0.45;
  const SPIN_RPM = 7;

  let ready = false;
  let probe = null, marker = null, labelEl = null;
  let lines = null;               // {abs/sat/tit: {full, flown}}
  let coast = null, desc = null;  // {t f64[n], w f64[3n]}：Three 轴本地坐标
  let absVerts = null;            // 日心系顶点（Three 轴 f64，静态）
  let absTimes = null;
  let nC = 0, nD = 0, nAbs = 0;
  let ctx = null;
  const worldNow = [0, 0, 0];     // 当前/最后位置（日心系，供视角跟随）
  let hasWorld = false;

  // ---- 解码 ----
  function b64ToBuf(b64, F) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new F(u8.buffer);
  }
  function unpack(win) {
    const t = b64ToBuf(win.t, Float64Array);
    const e = b64ToBuf(win.d, Float32Array);
    const w = new Float64Array(win.n * 3);
    for (let i = 0; i < win.n; i++) {
      const v = ctx.eclToThree([e[i * 3], e[i * 3 + 1], e[i * 3 + 2]]);
      w[i * 3] = v[0]; w[i * 3 + 1] = v[1]; w[i * 3 + 2] = v[2];
    }
    return { t, w, n: win.n };
  }

  function mkLine(color, opacity) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(nAbs * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({
      color, transparent: true, opacity, depthWrite: false,
    }));
    line.frustumCulled = false;
    line.visible = false;
    ctx.scene.add(line);
    return line;
  }

  function init(context, probeGroup) {
    ctx = context;
    probe = probeGroup;
    if (!HUY || !probe) return;
    try {
      coast = unpack(HUY.relSat);
      desc = unpack(HUY.relTit);
      nC = coast.n; nD = desc.n;
      nAbs = nC + nD;

      // 日心系顶点：巡航 = saturn(t)+relSat；进入/下降 = saturn(t)+titan(t)+relTit
      absVerts = new Float64Array(nAbs * 3);
      absTimes = new Float64Array(nAbs);
      const tmp = [0, 0, 0];
      const satTrack = ctx.registry.get('saturn').track;
      const titTrack = ctx.registry.get('titan').track;
      for (let i = 0; i < nC; i++) {
        absTimes[i] = coast.t[i];
        satTrack.at(coast.t[i], tmp);
        const w = ctx.eclToThree(tmp);
        absVerts[i * 3] = w[0] + coast.w[i * 3];
        absVerts[i * 3 + 1] = w[1] + coast.w[i * 3 + 1];
        absVerts[i * 3 + 2] = w[2] + coast.w[i * 3 + 2];
      }
      for (let j = 0; j < nD; j++) {
        absTimes[nC + j] = desc.t[j];
        satTrack.at(desc.t[j], tmp);
        const ws = ctx.eclToThree(tmp);
        titTrack.at(desc.t[j], tmp);
        const wt = ctx.eclToThree(tmp);
        absVerts[(nC + j) * 3] = ws[0] + wt[0] + desc.w[j * 3];
        absVerts[(nC + j) * 3 + 1] = ws[1] + wt[1] + desc.w[j * 3 + 1];
        absVerts[(nC + j) * 3 + 2] = ws[2] + wt[2] + desc.w[j * 3 + 2];
      }

      lines = {
        abs: { full: mkLine(0x3f9f96, 0.38), flown: mkLine(0x8fe8da, 0.92) },
        sat: { full: mkLine(0x8fb0d8, 0.30), flown: mkLine(0xdfe9f5, 0.88) },
        tit: { full: mkLine(0xd8b08f, 0.30), flown: mkLine(0xf5e3d0, 0.88) },
      };

      // 标记点 + 标签（点击聚焦 Huygens，事件由 main.js 接线）
      const sm = new THREE.SpriteMaterial({
        map: ctx.markerTexture(), transparent: true, depthTest: false, sizeAttenuation: true,
      });
      marker = new THREE.Sprite(sm);
      marker.center.set(0.5, 0.5);
      marker.renderOrder = 10;
      ctx.scene.add(marker);
      labelEl = document.createElement('div');
      labelEl.className = 'label sc';
      labelEl.textContent = 'Huygens';
      labelEl.classList.add('hide');
      labelEl.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('cassini-pick-huygens'));
      });
      document.getElementById('labels').appendChild(labelEl);
      ready = true;
    } catch (err) {
      console.error('HuygensVis: 轨迹构建失败', err);
    }
  }

  // ---- 本地轨迹插值（烘焙行间隔 30s–20min，线性插值精度足够）----
  function relAt(trk, t, out) {
    const n = trk.n, ts = trk.t, w = trk.w;
    let lo = 0, hi = n - 1;
    if (t <= ts[0]) { lo = 0; hi = 1; }
    else if (t >= ts[n - 1]) { lo = n - 2; hi = n - 1; }
    else {
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    }
    const a = (t - ts[lo]) / (ts[hi] - ts[lo] || 1);
    out[0] = w[lo * 3] + (w[hi * 3] - w[lo * 3]) * a;
    out[1] = w[lo * 3 + 1] + (w[hi * 3 + 1] - w[lo * 3 + 1]) * a;
    out[2] = w[lo * 3 + 2] + (w[hi * 3 + 2] - w[lo * 3 + 2]) * a;
    return out;
  }

  function idxAt(ts, n, t) {
    if (t <= ts[0]) return 0;
    if (t >= ts[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    return lo;
  }

  function soiK(dist, R) {
    let k = (R - dist) / (R * 0.4);
    k = Math.max(0, Math.min(1, k));
    return k * k * (3 - 2 * k);
  }

  const _rel = [0, 0, 0];
  const _rel2 = [0, 0, 0];
  const _v = new THREE.Vector3();
  const Z_AXIS = new THREE.Vector3(0, 0, 1);

  /* 任意时刻位置（日心系 Three 轴）：巡航 = saturn.world + relSat；
     进入/下降 = titan.world + relTit（entry.world 已是组合后日心坐标）；
     着陆后固定于表面。供 update() 与主循环（视角跟随）共用。 */
  function worldAt(t) {
    const satW = ctx.registry.get('saturn').world;
    const titW = ctx.registry.get('titan').world;
    if (t <= ENTRY_ET) {
      relAt(coast, t, _rel);
      return [satW[0] + _rel[0], satW[1] + _rel[1], satW[2] + _rel[2]];
    }
    const tt = Math.min(t, TD_ET);
    relAt(desc, tt, _rel);
    return [titW[0] + _rel[0], titW[1] + _rel[1], titW[2] + _rel[2]];
  }

  /* 本地轨迹切向（中心差分，Three 轴） */
  function tangentAt(trk, t, out) {
    relAt(trk, Math.max(trk.t[0], t - 60), _rel2);
    relAt(trk, Math.min(trk.t[trk.n - 1], t + 60), out);
    out[0] -= _rel2[0]; out[1] -= _rel2[1]; out[2] -= _rel2[2];
    return out;
  }

  function update(t, camWorld, projScale, hPx) {
    if (!ready || !probe || !lines) return;
    const opt = ctx.trailOpts();
    const showH = opt.cassini && opt.huygens !== false;

    if (t < SEP_ET) {
      for (const key of ['abs', 'sat', 'tit']) {
        lines[key].full.visible = false;
        lines[key].flown.visible = false;
      }
      probe.visible = false;
      if (marker) marker.visible = false;
      if (labelEl) labelEl.classList.add('hide');
      return;
    }

    // ---- 当前位置（日心系） ----
    const satW = ctx.registry.get('saturn').world;
    const titW = ctx.registry.get('titan').world;
    const after = t > TD_ET;
    const gone = t > LOS_ET;      // 失联：移除实体（模型/标记/标签），轨迹保留为历史
    const pos = worldAt(t);
    worldNow[0] = pos[0]; worldNow[1] = pos[1]; worldNow[2] = pos[2];
    hasWorld = true;

    // ---- SOI 淡入因子（绝对/一级/二级亮度联动，与 scene.js 同式） ----
    const dSat = Math.hypot(pos[0] - satW[0], pos[1] - satW[1], pos[2] - satW[2]);
    const dTit = Math.hypot(pos[0] - titW[0], pos[1] - titW[1], pos[2] - titW[2]);
    const kSat = soiK(dSat, SOI_SATURN);
    const kTit = soiK(dTit, SOI_TITAN);
    const absDim = (1 - ABS_DIM1 * kSat) * (1 - ABS_DIM2 * kTit);
    const satDim = kSat * (1 - REL1_DIM2 * kTit);

    // ---- 绝对轨迹：逐帧重定基准 + 已飞/未来 + 亮度 ----
    const rebaseAbs = (line, from, count) => {
      const arr = line.geometry.attributes.position.array;
      for (let i = from; i < from + count; i++) {
        arr[i * 3] = absVerts[i * 3] - camWorld.x;
        arr[i * 3 + 1] = absVerts[i * 3 + 1] - camWorld.y;
        arr[i * 3 + 2] = absVerts[i * 3 + 2] - camWorld.z;
      }
      line.geometry.attributes.position.needsUpdate = true;
    };
    const idxAbs = idxAt(absTimes, nAbs, t);
    if (showH) {
      rebaseAbs(lines.abs.flown, 0, nAbs);
      lines.abs.flown.geometry.setDrawRange(0, Math.min(idxAbs + 1, nAbs));
      lines.abs.flown.material.opacity = 0.92 * absDim;
      lines.abs.flown.visible = true;
      if (opt.future && !after) {
        rebaseAbs(lines.abs.full, 0, nAbs);
        lines.abs.full.geometry.setDrawRange(idxAbs, Math.max(0, nAbs - idxAbs));
        lines.abs.full.material.opacity = 0.38 * absDim;
        lines.abs.full.visible = true;
      } else lines.abs.full.visible = false;
    } else {
      lines.abs.flown.visible = false;
      lines.abs.full.visible = false;
    }

    // ---- 一级（土星）二级（Titan）相对轨迹：锚定母星当前模型位置 ----
    const anchor = (line, trk, world, from, count) => {
      const arr = line.geometry.attributes.position.array;
      for (let i = from; i < from + count; i++) {
        arr[i * 3] = world[0] + trk.w[i * 3] - camWorld.x;
        arr[i * 3 + 1] = world[1] + trk.w[i * 3 + 1] - camWorld.y;
        arr[i * 3 + 2] = world[2] + trk.w[i * 3 + 2] - camWorld.z;
      }
      line.geometry.attributes.position.needsUpdate = true;
    };
    const idxCoast = idxAt(coast.t, nC, t);
    const idxDesc = idxAt(desc.t, nD, t);
    if (showH && kSat > 0.001) {
      anchor(lines.sat.flown, coast, satW, 0, nC);
      lines.sat.flown.geometry.setDrawRange(0, idxCoast + 1);
      lines.sat.flown.material.opacity = 0.88 * satDim;
      lines.sat.flown.visible = true;
      if (opt.future && !after) {
        anchor(lines.sat.full, coast, satW, 0, nC);
        lines.sat.full.geometry.setDrawRange(idxCoast, nC - idxCoast);
        lines.sat.full.material.opacity = 0.30 * satDim;
        lines.sat.full.visible = true;
      } else lines.sat.full.visible = false;
    } else {
      lines.sat.flown.visible = false;
      lines.sat.full.visible = false;
    }
    if (showH && kTit > 0.001) {
      anchor(lines.tit.flown, desc, titW, 0, nD);
      lines.tit.flown.geometry.setDrawRange(0, idxDesc + 1);
      lines.tit.flown.material.opacity = 0.88 * kTit;
      lines.tit.flown.visible = true;
      if (opt.future && !after) {
        anchor(lines.tit.full, desc, titW, 0, nD);
        lines.tit.full.geometry.setDrawRange(idxDesc, nD - idxDesc);
        lines.tit.full.material.opacity = 0.30 * kTit;
        lines.tit.full.visible = true;
      } else lines.tit.full.visible = false;
    } else {
      lines.tit.flown.visible = false;
      lines.tit.full.visible = false;
    }

    // ---- 模型/姿态 ----
    _v.set(pos[0] - camWorld.x, pos[1] - camWorld.y, pos[2] - camWorld.z);
    probe.position.copy(_v);
    const d = _v.length();
    const modelPx = probe.userData.span / (projScale * Math.max(d, 1e-9)) * hPx;
    probe.visible = !gone && modelPx > 1.1;
    if (!gone && !after) {
      const tan = (t <= ENTRY_ET) ? tangentAt(coast, t, [0, 0, 0])
                                  : tangentAt(desc, t, [0, 0, 0]);
      _v.set(tan[0], tan[1], tan[2]);
      if (_v.lengthSq() > 1e-12) probe.quaternion.setFromUnitVectors(Z_AXIS, _v.normalize());
      probe.userData.spin.rotation.z = ((t - SEP_ET) * SPIN_RPM * 2 * Math.PI / 60) % (2 * Math.PI);
    }

    // ---- 标记点（模型不可读时接管）：屏占驱动收敛，仅模型过渡期用大标记，
    // 其余缩放级别均为 2.6px 行星档小亮点（与 Cassini 主标记同一曲线） ----
    if (marker) {
      let shrink = THREE.MathUtils.clamp((6 - modelPx) / 5.5, 0, 1);
      shrink = shrink * shrink * (3 - 2 * shrink);
      const markerPx = 10 - 7.4 * shrink;
      const op = gone ? 0 : Math.max(0, Math.min(1, (6 - modelPx) / 4)) * (1 - 0.1 * shrink);
      marker.visible = op > 0.01;
      marker.material.opacity = op;
      marker.position.copy(probe.position);
      const desired = Math.max(projScale * d * (markerPx / hPx), 0.02);   // 精确屏占（无 ×2 系数）
      marker.scale.set(desired, desired, 1);
    }
    if (labelEl) {
      if (gone) {
        labelEl.classList.add('hide');
      } else {
        const sp = window.CassiniScene.screenPosOf(pos);
        const halfTan = Math.tan(THREE.MathUtils.degToRad(window.CassiniScene.camera.fov / 2));
        const mp2 = probe.userData.span / (2 * halfTan * Math.max(sp.dist, 1e-9)) * hPx;
        if (sp.behind || mp2 > 12) labelEl.classList.add('hide');
        else {
          labelEl.classList.remove('hide');
          labelEl.classList.toggle('dim', sp.dist > 4e9);
          labelEl.style.transform = `translate(-50%,-130%) translate(${sp.x.toFixed(1)}px,${(sp.y - 8).toFixed(1)}px)`;
        }
      }
    }
  }

  /* 供 main.js 视角跟随：最近一次 update 的位置（日心系 Three 轴）。
     worldAt(t) 需要场景就绪，供主循环在相机更新前直接取当前帧位置。 */
  function getWorld() { return hasWorld ? worldNow.slice() : null; }
  function tryWorldAt(t) {
    if (!ready || !ctx) return null;
    try { return worldAt(t); } catch (e) { return null; }
  }

  return { init, update, getWorld, tryWorldAt, SEP_ET, ENTRY_ET, TD_ET, LOS_ET };
})();
