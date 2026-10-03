/* Huygens 分离后独立飞行可视化（NAIF SPICE -150 CASP 真值）
 *
 * 2004-12-25 02:00 UTC 分离后，Huygens 沿 NASA/NAIF 重构星历飞行：
 * data 由 tools/bake_spice.py --huygens 直采 COSP 卷 050214R_SCPSE 内核的
 * -150 (CASP) 段（2004-11-23 .. 2005-01-14 09:05:52.5 进入界面）。分离前
 * -150 与 -82 严格同点；弹射分离相对速度 ~0.39 m/s（NASA/ESA：弹簧分离 +
 * 7 rpm 自旋稳定），sep+1h 相距 1.38 km、sep+7.1h 达 10 km、sep+20d 进入
 * Titan 大气（1270 km / 6.03 km/s / 路径角 −65.55°，与 NASA 公布进入条件
 * 一致），经 2h27m 气动减速—降落伞下降后于约 11:33 UTC 着陆（descent
 * lasted 2h27m）——着陆 + 72 min 失联（LOS）后移除探测器模型/标记/标签，
 * 轨迹保留为已飞历史。
 *
 * 轨迹与显示（与 Cassini 同一套 SOI 参考系逻辑，item 2/3/4）：
 *   绝对轨迹（日心系）—— 巡航段 = saturn(t) + relSat；进入/下降段 =
 *     saturn(t) + titan(t) + relTit；全程显示；进入行星 SOI 降亮度，
 *     再进入 Titan SOI 再降（absDim 与 scene.js 逐值一致）。
 *   一级（相对土星）—— Saturn SOI 内淡入；进入 Titan SOI 时降亮度。
 *   二级（相对 Titan）—— Titan SOI 内淡入（真空双曲线进入段 + 下降段）。
 *   分离近场渲染（item 8）：分离瞬间 ρ=0 与挂载态严格连续，近场位置 =
 *     Cassini 模型锚定 + relCass 真实相对行（0.39 m/s 实时漂移可见）；
 *     相距超过 HUY_BLEND_KM（默认 10 km，可修改）后，在 ×SPAN 带宽内
 *     smoothstep 缓慢插值到土星锚定轨道（relSat），吸收 Cassini/Saturn
 *     两套锚定各自的入差，全程无跳变。
 *   姿态（NASA 真实时序）：分离前 Cassini 已把整机定向到 Huygens 进入姿态，SED
 *   弹射并赋予 7 rpm 自旋稳定；分离后无姿态控制 → 自旋轴在惯性系中固定。实测
 *   （真实姿态回放）分离时刻探测器自旋轴 = body +Y（防热大底法向）≈ 进入走廊
 *   RAM（仅差 0.68°），故分离后**不重定向**——姿态冻结在分离瞬间的组合体姿态，
 *   仅叠加绕 body +Y 的 7 rpm 自旋；大底在进入界面处即天然正对气流。
 *   自旋轴 = 探测器回转对称轴 = wrap-local +Y（GLB 实测：φ2.615 大底在 XZ 面、
 *   Y 为 0.806 m 轴向厚度，σ_Y 最小），由 spin 组本地 Y 旋转承担。
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

  // 分离近场→轨道交接阈值（可修改）：相距 HUY_BLEND_KM 内保持 Cassini 锚定 +
  // 真实 relCass 漂移（NASA 真值实时分离）；更远后在 ×SPAN 带宽内 smoothstep
  // 缓慢插值到土星锚定轨道（relSat）——带宽取 10 倍阈值（10→100 km，约
  // sep+7h..+2.5d），对两套锚定 ~百 km 级入差完全平滑。
  const HUY_BLEND_KM = 10;
  const HUY_BLEND_SPAN = 10;

  let ready = false;
  let probe = null, marker = null, labelEl = null;
  let lines = null;               // {abs/sat/tit: {full, flown}}
  let coast = null, desc = null;  // {t f64[n], w f64[3n]}：Three 轴本地坐标
  let sepCass = null;             // relCass 行（Huygens 相对 Cassini 模型，分离定位）
  let spinAxis = null;            // 进入走廊 RAM 向（自洽性诊断；自旋轴恒为 body +Y）
  let mountLocal = null;          // 挂点（Cassini 结构系，km）——由模型实测
  let centroidLocal = new THREE.Vector3();   // 质心相对挂点的偏置（结构系，km）
  let modelQuat = null;           // 分离前组合体姿态（Cassini 体轴 → 惯性系）
  let sepQuat = null;             // 分离瞬间姿态快照（自旋轴惯性系固定，之后不变）
  let absVerts = null;            // 日心系顶点（Three 轴 f64，静态）
  let absTimes = null;
  let nC = 0, nD = 0, nAbs = 0;
  let ctx = null;
  const worldNow = [0, 0, 0];     // 当前/最后位置（日心系，供视角跟随）
  let hasWorld = false;
  let selfFade = 0;               // 本机模型级淡出因子（0=正常，1=特写），供 scene.js 联动

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
      sepCass = HUY.relCass ? unpack(HUY.relCass) : null;
      nC = coast.n; nD = desc.n;
      nAbs = nC + nD;

      /* —— 真实挂点（item：分离前后位置严格按模型结构）——
       * cassini_model.js 的 wrapProbe 不做任何平移/轴向预旋转，wrap 原点即 GLB
       * 原点 = huygens_probe 在组合体里的挂点。实测该节点局部变换为单位阵、
       * 位于 BUS 之下，故挂点在 Cassini 结构系里严格落在组合体原点 (0,0,0)，
       * 模型包围盒质心偏在 (0.2, −1404.7, −1114.6) mm——即探测器是「贴着母船
       * 原点向外悬挂」的，其自身几何自带偏移，无需再加挂点位移。
       * 因此分离前探测器模型只要按 Cassini 位置 + Cassini 姿态摆位，就与组合
       * 体（内部自带同一节点）逐点重合；分离后叠加真实相对漂移 relCass 即可。
       * 两个模型始终用各自的姿态渲染，跨模型边界不做世界坐标插值，故分离瞬间
       * 无穿模/跳变。 */
      const cen = probe.userData.centroid;
      if (cen) {
        // 挂点 = 组合体原点（实测）：结构系内挂点相对母船原点的位移为 0；
        // 质心偏置仅用于「自旋绕质心」，不参与定位。
        mountLocal = new THREE.Vector3(0, 0, 0);
        centroidLocal.set(cen.x, cen.y, cen.z);
      }
      // 分离前组合体姿态受真实姿态回放逐帧更新（scene.js 的 _attQ），故 init
      // 时不取快照，改由 update 逐帧同步。
      modelQuat = new THREE.Quaternion();

      // NASA 时序（真实姿态回放实测）：分离前 Cassini 已把整机定向到 Huygens 进入
      // 姿态——分离时刻探测器自旋轴（body +Y）在场景系 ≈ (0.3986, 0.3198, 0.8596)，
      // 与 Titan 进入走廊 RAM ≈ (0.3945, 0.3307, 0.8573) 仅差 0.68°。故分离后无需
      // 重定向，姿态 = 分离瞬间的组合体姿态（惯性系固定），自旋绕 body +Y 即可。
      // 这里仍记录 spinAxis（进入走廊 RAM），仅作姿态自洽性诊断/日志用。
      if (nD >= 2) {
        const at = Math.min(Math.max(ENTRY_ET, desc.t[0] + 120), desc.t[nD - 1] - 120);
        const tv = tangentAt(desc, at, [0, 0, 0]);     // 飞行方向（Titan 相对）
        const L = Math.hypot(tv[0], tv[1], tv[2]);
        if (L > 1e-9) spinAxis = new THREE.Vector3(-tv[0] / L, -tv[1] / L, -tv[2] / L);
      }

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
  // 探测器自旋轴（= 防热大底法向 = 回转对称轴）在 wrap-local 系里是 **Y**，由 GLB
  // 实测确定（tools/probe_huygens_axes.js）：wrap 系包围盒 size=(2.615, 0.806,
  // 2.615) m，X/Z 为 φ2.615 大底直径、Y 仅 0.806 为轴向厚度；顶点协方差最小主元
  // σ_Y=0.259（X/Z 为 0.6196/0.6159，回转对称）——故自旋绕 Y 轴。
  // 旧代码用 spin.rotation.z / setFromUnitVectors(0,0,1 → …) 把大底当径向转，
  // 即「绕直径翻滚」而非自旋，是本条 bug（惠更斯旋转轴错误）的根因。
  // 姿态/挂点计算用暂存（避免逐帧分配）
  const _mountTmp = new THREE.Vector3();
  const _cenQ = new THREE.Quaternion();
  const _cenOff = new THREE.Vector3();
  const _spinAxisTmp = new THREE.Vector3();

  /* 任意时刻位置（日心系 Three 轴）：
     分离前 = Cassini 位置 + R_cass·挂点（真实结构挂载位置，与组合体 stack 内
     同一节点逐点重合；模型仍隐藏，仅为相机/标记/标签就位）；
     巡航优先 = 锚定级 cassini 模型位置 + relCass（分离瞬间 ρ=0 与母船模型
     严格连续，模型可见的分离漂移为真实 ρ，0.39 m/s NASA 真值）；相距超过
     HUY_BLEND_KM 后在 ×SPAN 带宽内 smoothstep 缓慢插值到土星锚定轨道
     （saturn.world + relSat）。旧数据无 relCass 时退回 saturn.world + relSat。
     进入/下降 = titan.world + relTit；着陆后固定于表面。 */
  function worldAt(t) {
    // 分离前 Huygens 挂载于 Cassini 组合体：位置即 Cassini 本体位置 + 结构挂点
    // （若沿用巡航腿首点，relAt 会前向外推出去，形成脱离母船的「幻影」位置）
    if (t < SEP_ET && ctx.cassiniPosAt) {
      const cw0 = ctx.cassiniPosAt(t, [0, 0, 0]);
      if (cw0) {
        if (mountLocal && modelQuat) {
          const pm = _mountTmp.copy(mountLocal).applyQuaternion(modelQuat);
          return [cw0[0] + pm.x, cw0[1] + pm.y, cw0[2] + pm.z];
        }
        return [cw0[0], cw0[1], cw0[2]];
      }
    }
    const titW = ctx.registry.get('titan').world;
    if (t <= ENTRY_ET) {
      const satW = ctx.registry.get('saturn').world;
      const cw = (sepCass && ctx.cassiniPosAt) ? ctx.cassiniPosAt(t, [0, 0, 0]) : null;
      if (cw) {
        relAt(sepCass, t, _rel);
        // 近场：纯真实相对漂移；HUY_BLEND_KM 外：缓慢插值到轨道（交接吸收
        // Cassini/Saturn 两套锚定的入差，smoothstep 两端导数为零，无跳变）
        let s = 0;
        if (coast && HUY_BLEND_KM > 0 && t > SEP_ET) {
          const rho = Math.hypot(_rel[0], _rel[1], _rel[2]);
          s = (rho - HUY_BLEND_KM) / (HUY_BLEND_KM * (HUY_BLEND_SPAN - 1));
          s = s < 0 ? 0 : s > 1 ? 1 : s;
          s = s * s * (3 - 2 * s);
        }
        if (s > 0) {
          relAt(coast, t, _rel2);
          return [cw[0] + _rel[0] + (satW[0] + _rel2[0] - cw[0] - _rel[0]) * s,
                  cw[1] + _rel[1] + (satW[1] + _rel2[1] - cw[1] - _rel[1]) * s,
                  cw[2] + _rel[2] + (satW[2] + _rel2[2] - cw[2] - _rel[2]) * s];
        }
        return [cw[0] + _rel[0], cw[1] + _rel[1], cw[2] + _rel[2]];
      }
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

  function update(t, camWorld, projScale, hPx, sharedFade, trailOrigin) {
    if (!ready || !probe || !lines) return;
    // 组合体姿态逐帧同步（分离前探测器按结构挂点贴在母船上，须与母船同姿态）
    if (modelQuat && ctx.cassiniQuatAt) {
      const q = ctx.cassiniQuatAt();
      if (q) modelQuat.copy(q);
    }
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
      selfFade = 0;   // 未分离（无本机轨迹）：不触发航天器轨迹联动淡出
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

    // 模型级淡出：探测器屏占进入标记 → 模型交接区（1.5→6 px）时本机轨迹淡出；
    // sharedFade = scene.js 共享淡出因子（任一航天器特写 → 全部航天器轨迹淡出）
    const dProbe = Math.hypot(pos[0] - camWorld.x, pos[1] - camWorld.y, pos[2] - camWorld.z);
    const modelPx = probe.userData.span / (projScale * Math.max(dProbe, 1e-9)) * hPx;
    const ownFade = ctx.modelFadeK ? ctx.modelFadeK(modelPx) : 0;
    selfFade = ownFade;   // 仅暴露本机因子（供 scene 取 max，避免反馈回路）
    const tfade = 1 - Math.max(ownFade, sharedFade || 0);

    // ---- SOI 淡入因子（绝对/一级/二级亮度联动，与 scene.js 同式） ----
    const dSat = Math.hypot(pos[0] - satW[0], pos[1] - satW[1], pos[2] - satW[2]);
    const dTit = Math.hypot(pos[0] - titW[0], pos[1] - titW[1], pos[2] - titW[2]);
    const kSat = soiK(dSat, SOI_SATURN);
    const kTit = soiK(dTit, SOI_TITAN);
    const absDim = (1 - ABS_DIM1 * kSat) * (1 - ABS_DIM2 * kTit);
    const satDim = kSat * (1 - REL1_DIM2 * kTit);

    // ---- 绝对轨迹：逐帧重定基准 + 已飞/未来 + 亮度 ----
    // 浮动原点与 scene.js 主轨迹共用（顶点缓冲 = [世界 − trailOrigin]，线对象
    // position = trailOrigin − cam）。直接写 [世界 − cam] 在远视角下 f32 量化
    // 步长达数十 km，相机绕转时顶点逐帧跳桶 → 轨迹抖动。
    const o = trailOrigin || camWorld;
    const lox = o.x - camWorld.x, loy = o.y - camWorld.y, loz = o.z - camWorld.z;
    const rebaseAbs = (line, from, count) => {
      const arr = line.geometry.attributes.position.array;
      for (let i = from; i < from + count; i++) {
        arr[i * 3] = absVerts[i * 3] - o.x;
        arr[i * 3 + 1] = absVerts[i * 3 + 1] - o.y;
        arr[i * 3 + 2] = absVerts[i * 3 + 2] - o.z;
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.position.set(lox, loy, loz);
    };
    const idxAbs = idxAt(absTimes, nAbs, t);
    if (showH && tfade > 0.01) {
      rebaseAbs(lines.abs.flown, 0, nAbs);
      lines.abs.flown.geometry.setDrawRange(0, Math.min(idxAbs + 1, nAbs));
      lines.abs.flown.material.opacity = 0.92 * absDim * tfade;
      lines.abs.flown.visible = true;
      if (opt.future && !after) {
        rebaseAbs(lines.abs.full, 0, nAbs);
        lines.abs.full.geometry.setDrawRange(idxAbs, Math.max(0, nAbs - idxAbs));
        lines.abs.full.material.opacity = 0.38 * absDim * tfade;
        lines.abs.full.visible = true;
      } else lines.abs.full.visible = false;
    } else {
      lines.abs.flown.visible = false;
      lines.abs.full.visible = false;
    }

    // ---- 一级（土星）二级（Titan）相对轨迹：锚定母星当前模型位置 ----
    // 同样使用共享浮动原点（顶点缓冲相对 o，位置补偿 o − cam）。
    const anchor = (line, trk, world, from, count) => {
      const arr = line.geometry.attributes.position.array;
      for (let i = from; i < from + count; i++) {
        arr[i * 3] = world[0] + trk.w[i * 3] - o.x;
        arr[i * 3 + 1] = world[1] + trk.w[i * 3 + 1] - o.y;
        arr[i * 3 + 2] = world[2] + trk.w[i * 3 + 2] - o.z;
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.position.set(lox, loy, loz);
    };
    const idxCoast = idxAt(coast.t, nC, t);
    const idxDesc = idxAt(desc.t, nD, t);
    if (showH && kSat > 0.001 && tfade > 0.01) {
      anchor(lines.sat.flown, coast, satW, 0, nC);
      lines.sat.flown.geometry.setDrawRange(0, idxCoast + 1);
      lines.sat.flown.material.opacity = 0.88 * satDim * tfade;
      lines.sat.flown.visible = true;
      if (opt.future && !after) {
        anchor(lines.sat.full, coast, satW, 0, nC);
        lines.sat.full.geometry.setDrawRange(idxCoast, nC - idxCoast);
        lines.sat.full.material.opacity = 0.30 * satDim * tfade;
        lines.sat.full.visible = true;
      } else lines.sat.full.visible = false;
    } else {
      lines.sat.flown.visible = false;
      lines.sat.full.visible = false;
    }
    if (showH && kTit > 0.001 && tfade > 0.01) {
      anchor(lines.tit.flown, desc, titW, 0, nD);
      lines.tit.flown.geometry.setDrawRange(0, idxDesc + 1);
      lines.tit.flown.material.opacity = 0.88 * kTit * tfade;
      lines.tit.flown.visible = true;
      if (opt.future && !after) {
        anchor(lines.tit.full, desc, titW, 0, nD);
        lines.tit.full.geometry.setDrawRange(idxDesc, nD - idxDesc);
        lines.tit.full.material.opacity = 0.30 * kTit * tfade;
        lines.tit.full.visible = true;
      } else lines.tit.full.visible = false;
    } else {
      lines.tit.flown.visible = false;
      lines.tit.full.visible = false;
    }

    /* ---- 模型/姿态 ----
     * 位置：分离前 = Cassini 位置 + R_cass·挂点（挂点实测在组合体原点，故即
     *   Cassini 位置，与组合体逐点重合；模型仍隐藏，但相机/标记/标签已就位）；
     *   分离后 = worldAt(t)（Cassini 模型锚定 + 真实 relCass 漂移，见 worldAt）。
     * 姿态（NASA 真实过程）：
     *   分离前组合体被 Cassini 定向到 Huygens 进入姿态——实测（真实姿态回放）
     *   分离时刻探测器自旋轴（body +Y = 防热大底法向）在场景系中为
     *   (0.3986, 0.3198, 0.8596)，与 Titan 进入走廊 RAM (0.3945, 0.3307, 0.8573)
     *   仅差 0.68°；即**分离时自旋轴已对准进入走廊**，正是「Cassini 先转好整机、
     *   SED 再弹射并赋予 7 rpm」的真实时序。
     *   因此分离后**不做任何重定向**：探测器保持分离瞬间的组合体姿态（自旋轴
     *   惯性系固定），只叠加绕 body +Y 的 7 rpm 自旋。若强行用「进入走廊」重算
     *   姿态，反会引入与挂载态的姿态跳变/穿模——保持挂载姿态既最真实又无穿模。
     * 自旋绕质心而非挂点：探针模型原点即挂点，质心偏在 centroidLocal，故自旋
     *   前把模型平移到质心、自旋后再按旋转量移回，使质心成为不动点。 */
    const preSep = t < SEP_ET;
    _v.set(pos[0] - camWorld.x, pos[1] - camWorld.y, pos[2] - camWorld.z);
    if (preSep && modelQuat && mountLocal) {
      const pm = _mountTmp.copy(mountLocal).applyQuaternion(modelQuat);
      _v.x += pm.x; _v.y += pm.y; _v.z += pm.z;
    }
    probe.position.copy(_v);
    const d = dProbe;   // modelPx 已在轨迹段前计算（与淡出共用）
    probe.visible = !gone && modelPx > 1.1;
    const spin = probe.userData.spin;
    if (spin) {
      if (!gone) {
        // 分离前与分离后都用同一姿态源：组合体姿态 modelQuat（分离后取分离瞬间的
        // 冻结值——自旋轴惯性系固定，见上）。分离瞬间因此无姿态跳变、无穿模。
        // sepQuat：分离瞬间姿态快照，在首个 t ≥ SEP_ET 的帧锁定，之后不再更新。
        if (!preSep && !sepQuat && modelQuat) sepQuat = modelQuat.clone();
        const baseQ = preSep ? modelQuat : (sepQuat || modelQuat);
        if (baseQ) probe.quaternion.copy(baseQ);
        // —— 自旋：绕 body +Y（回转对称轴），分离前为 0、分离后 7 rpm ——
        const ang = preSep
          ? 0
          : ((t - SEP_ET) * SPIN_RPM * 2 * Math.PI / 60) % (2 * Math.PI);
        if (!preSep && centroidLocal) {
          // 质心为不动点：模型原点（挂点）绕质心转，故把质心平移量按自旋角绕
          // —— 绕「真实回转轴」自旋，且以质心为不动点 ——
          // spin 是 wrap 的直接子级：p_wrap = spin.position + R_y(·)·p_child。
          // wrap 系内质心静止位置 C0 = centroidLocal（模型质心，实测与回转轴心
          // XZ 重合——φ2.615 大底圆心，见 cassini_model.js 的 probeRevolutionAxis）。
          // 要求质心在 wrap 系不动：C0 = spin.position + R_y(ang)·C0，故
          //   spin.position = C0 − R_y(ang)·C0。
          // 旧代码错误地用世界姿态 baseQ 把 C0 换到世界系再相减，得到的是世界系
          // 补偿向量却塞进 wrap 系 spin.position（坐标系不匹配），使实际旋转中心
          // 偏离大底圆心 ~0.84 mm、质心在自旋中漂移 ~1.7 mm——即「分离时旋转轴
          // 错误」。改为纯 wrap 系运算后，旋转中心严格 = 质心 = 回转轴心。
          _cenQ.setFromAxisAngle(_spinAxisTmp.set(0, 1, 0), ang);
          _cenOff.copy(centroidLocal).applyQuaternion(_cenQ);   // R_y(ang)·C0（wrap 系）
          spin.position.set(centroidLocal.x - _cenOff.x,
                            centroidLocal.y - _cenOff.y,
                            centroidLocal.z - _cenOff.z);
        } else {
          spin.position.set(0, 0, 0);
        }
        spin.rotation.set(0, ang, 0);                  // 绕本地 +Y（= 回转轴）自旋
      }
    }

    // ---- 标记点（模型不可读时接管）：屏占驱动收敛，仅模型过渡期用大标记，
    // 其余缩放级别均为 2.6px 行星档小亮点（与 Cassini 主标记同一曲线） ----
    if (marker) {
      let shrink = THREE.MathUtils.clamp((6 - modelPx) / 5.5, 0, 1);
      shrink = shrink * shrink * (3 - 2 * shrink);
      const markerPx = 10 - 7.4 * shrink;
      const op = gone ? 0 : Math.max(0, Math.min(1, (6 - modelPx) / 4)) * (1 - 0.1 * shrink);
      // 遮挡剔除（同 Cassini 标记）：探测器被行星盘面挡住时隐藏亮点
      marker.visible = op > 0.01 && !ctx.viewOccluded(pos[0], pos[1], pos[2], null);
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

  return {
    init, update, getWorld, tryWorldAt, SEP_ET, ENTRY_ET, TD_ET, LOS_ET,
    get modelFade() { return selfFade; },   // 本机模型级淡出因子（scene.js 联动读取）
  };
})();
