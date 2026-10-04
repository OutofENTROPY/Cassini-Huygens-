/* main.js — 装配与主循环 */
(function () {
  'use strict';

  const loadingEl = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');

  function fatal(msg) {
    loadingEl.classList.remove('done');
    loadingText.textContent = '启动失败: ' + String(msg).split('\n')[0];
    loadingText.style.color = '#ff8f8f';
    console.error(msg);
    window.__bootError = String(msg).split('\n')[0];
    window.__bootStack = String(msg);   // 完整堆栈（调试用，控制台可见）
  }
  window.addEventListener('error', (e) => { fatal((e.error && e.error.stack) || e.message); });

  try {

  if (!window.CASSINI_DATA) {
    loadingText.textContent = '数据文件缺失：data/cassini_data.js 未找到';
    return;
  }

  const data = window.CASSINI_DATA;
  const T_START = data.meta.tStart;
  const T_END = data.meta.tEnd;
  const J2000Ms = data.meta.j2000Ms;
  const EVENTS = window.MISSION_EVENTS;

  const canvas = document.getElementById('scene');
  const labelsEl = document.createElement('div');
  labelsEl.id = 'labels';
  document.getElementById('app').appendChild(labelsEl);

  const scene = window.CassiniScene;
  const cam = window.CassiniCamera;
  const tl = window.CassiniTimeline;

  // ---------- 初始化 ----------
  scene.init(canvas, labelsEl, onBodyPicked);
  if (window.CassiniLoader) window.CassiniLoader.sceneBuilt();   // 加载页：场景构建完成，纹理/模型细条开跑
  cam.init(canvas);
  tl.init({ tStart: T_START, tEnd: T_END, onChange: onTimeChange });
  // 默认轨迹显示：未来轨迹关闭，历史轨迹仅近期
  scene.setTrailOptions({ future: false, mode: 'recent' });

  // Cassini 标签（置于标记点下侧，.sc 样式刻度线朝上）
  const scLabel = document.createElement('div');
  scLabel.className = 'label sc below';
  scLabel.textContent = 'Cassini';
  scLabel.addEventListener('click', (e) => { e.stopPropagation(); onBodyPicked('cassini'); });
  labelsEl.appendChild(scLabel);
  scene.setCassiniLabel(scLabel);

  // Huygens 标签点击 / 事件卡聚焦 → 视角跟随惠更斯（item 4）
  function pickHuygens() {
    setInfoBody(null);
    cam.flyTo('huygens', { dist: Math.max(cam.currentDist(), 30) });
  }
  window.addEventListener('cassini-pick-huygens', pickHuygens);

  // 事件列表
  const eventList = document.getElementById('event-list');
  const eventPanel = document.getElementById('event-panel');
  EVENTS.forEach(ev => {
    const item = document.createElement('div');
    item.className = 'ev-item';
    item.innerHTML = `<div class="ev-date">${ev.utc.slice(0, 10)}</div><div class="ev-title">${ev.title}</div>`;
    item.addEventListener('click', () => pickEvent(ev));
    eventList.appendChild(item);
    ev._item = item;
  });
  document.getElementById('event-panel-head').addEventListener('click', () => {
    eventPanel.classList.toggle('collapsed');
    if (!eventPanel.classList.contains('collapsed')) {
      if (mqMobile.matches) setHudOpen(false);
      scrollToCurrentEvent();
    }
  });
  tl.addEventMarks(EVENTS, pickEvent);

  // 事件卡：左上角通知按钮（◉ 右侧，手机 / 桌面一致）点按展开 / 再点收起（按钮不消失），
  // 事件卡右上角 ⌄ 亦可收起；点击任务事件时卡片默认收起、按钮呼吸闪烁提示
  const eventCard = document.getElementById('event-card');
  document.getElementById('event-fold').addEventListener('click', () => {
    document.body.classList.add('event-folded');
  });
  document.getElementById('event-fab').addEventListener('click', () => {
    document.body.classList.toggle('event-folded');
  });

  // 视图按钮（仅视角切换；真实光照是独立开关，不触发镜头移动）
  const viewBtns = document.querySelectorAll('.view-btn[data-view]');
  viewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      viewBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const v = btn.dataset.view;
      setInfoBody(null);   // 切换视角时收起星体状态卡（跟随 Cassini / 全局视角均不再指向某行星）
      if (v === 'follow') {
        cam.setMode('follow');
        cam.flyTo('cassini', { dist: Math.max(cam.currentDist(), 3e5) });
      } else {
        cam.setMode('free');
        cam.flyTo('sun', { dist: 6.5e9, theta: 0.7, phi: 1.0 });
      }
    });
  });

  // 帮助
  const helpModal = document.getElementById('help-modal');
  document.getElementById('btn-help').addEventListener('click', () => helpModal.classList.remove('hidden'));
  document.getElementById('help-close').addEventListener('click', () => helpModal.classList.add('hidden'));
  helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.classList.add('hidden'); });

  // 全屏显示按钮（⛶）
  const fsBtn = document.getElementById('btn-fullscreen');
  function syncFullscreenBtn() {
    const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    fsBtn.classList.toggle('active', fs);
    fsBtn.title = fs ? '退出全屏' : '全屏显示';
  }
  fsBtn.addEventListener('click', () => {
    const root = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) Promise.resolve(req.call(root)).catch(() => {});   // 拒绝全屏时静默（iframe / 无手势）
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  });
  document.addEventListener('fullscreenchange', syncFullscreenBtn);
  document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);

  // 状态卡片（HUD / 星体状态）折叠在左上角 ◉ 按钮：桌面默认展开，移动端默认收起；
  // 移动端展开状态卡时与任务事件面板互斥，避免小屏上互相遮挡
  const hudToggle = document.getElementById('hud-toggle');
  const mqMobile = window.matchMedia('(max-width: 900px)');
  function setHudOpen(open) {
    document.body.classList.toggle('hud-open', open);
    hudToggle.classList.toggle('active', open);
    if (open && mqMobile.matches) eventPanel.classList.add('collapsed');
  }
  hudToggle.addEventListener('click', () => setHudOpen(!document.body.classList.contains('hud-open')));
  // 初始与断点跨越（拖拽窗口 / 旋转屏幕跨 900px）时按当前端默认切换：桌面展开、移动端收起
  function applyHudDefault() { setHudOpen(!mqMobile.matches); }
  applyHudDefault();
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', applyHudDefault);
  else if (mqMobile.addListener) mqMobile.addListener(applyHudDefault);

  // 真实光照开关（阴影处完全不反光）
  const lightBtn = document.getElementById('lighting-btn');
  let realLight = false;
  lightBtn.addEventListener('click', () => {
    realLight = !realLight;
    scene.setRealisticLighting(realLight);
    lightBtn.classList.toggle('on', realLight);
    lightBtn.setAttribute('aria-checked', String(realLight));
  });

  // 天体标签显隐开关（行星 / 卫星 / Cassini 名称标签）
  const labelsBtn = document.getElementById('labels-toggle');
  labelsBtn.addEventListener('click', () => {
    const on = !labelsBtn.classList.contains('on');
    labelsBtn.classList.toggle('on', on);
    labelsBtn.setAttribute('aria-checked', String(on));
    scene.setLabelsVisible(on);
  });

  // 轨迹显示开关（item 2）：未来轨迹显隐 + 近期/全部历史轨迹切换 + 行星/卡西尼轨迹开关
  const trailFutureBtn = document.getElementById('trail-future');
  const trailRecentBtn = document.getElementById('trail-recent');
  const trailAllBtn = document.getElementById('trail-all');
  trailFutureBtn.addEventListener('click', () => {
    const on = !trailFutureBtn.classList.contains('on');
    trailFutureBtn.classList.toggle('on', on);
    trailFutureBtn.setAttribute('aria-checked', String(on));
    scene.setTrailOptions({ future: on });
  });
  const planetOrbitsBtn = document.getElementById('planet-orbits');
  planetOrbitsBtn.addEventListener('click', () => {
    const on = !planetOrbitsBtn.classList.contains('on');
    planetOrbitsBtn.classList.toggle('on', on);
    planetOrbitsBtn.setAttribute('aria-checked', String(on));
    scene.setTrailOptions({ planetOrbits: on });
  });
  const cassiniTrailBtn = document.getElementById('cassini-trail');
  cassiniTrailBtn.addEventListener('click', () => {
    const on = !cassiniTrailBtn.classList.contains('on');
    cassiniTrailBtn.classList.toggle('on', on);
    cassiniTrailBtn.setAttribute('aria-checked', String(on));
    scene.setTrailOptions({ cassini: on });
  });
  const huygensTrailBtn = document.getElementById('huygens-trail');
  huygensTrailBtn.addEventListener('click', () => {
    const on = !huygensTrailBtn.classList.contains('on');
    huygensTrailBtn.classList.toggle('on', on);
    huygensTrailBtn.setAttribute('aria-checked', String(on));
    scene.setTrailOptions({ huygens: on });
  });
  trailRecentBtn.addEventListener('click', () => {
    trailRecentBtn.classList.add('active');
    trailAllBtn.classList.remove('active');
    scene.setTrailOptions({ mode: 'recent' });
  });
  trailAllBtn.addEventListener('click', () => {
    trailAllBtn.classList.add('active');
    trailRecentBtn.classList.remove('active');
    scene.setTrailOptions({ mode: 'all' });
  });

  // 右上角设置菜单：点击齿轮开合，点击面板外收起，选择视角后自动收起
  const settingsBtn = document.getElementById('btn-settings');
  const settingsPanel = document.getElementById('settings-panel');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (settingsPanel.classList.contains('hidden')) return;
    if (settingsPanel.contains(e.target)) return;
    settingsPanel.classList.add('hidden');
  });
  settingsPanel.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.view-btn[data-view]')) {
      settingsPanel.classList.add('hidden');
    }
  });

  // HUD
  const hudDate = document.getElementById('hud-date');
  const hudPhase = document.getElementById('hud-phase');
  const hudAtt = document.getElementById('hud-att');
  const hudDist = document.getElementById('hud-dist');
  const hudVel = document.getElementById('hud-vel');

  // 天体朝向与自转状态面板（item 9）
  const bodyInfo = document.getElementById('body-info');
  const biName = document.getElementById('bi-name');
  const biRows = document.getElementById('bi-rows');
  let infoBody = null;
  let biSpinRow = null;

  function fmtPeriod(s) {
    const a = Math.abs(s);
    if (a >= 86400 * 365.25) return (a / (86400 * 365.25)).toFixed(2) + ' 年';
    if (a >= 86400) return (a / 86400).toFixed(2) + ' 天';
    if (a >= 3600) return (a / 3600).toFixed(2) + ' 小时';
    return (a / 60).toFixed(1) + ' 分钟';
  }
  function setInfoBody(name) {
    infoBody = name;
    biSpinRow = null;
    if (!name || name === 'cassini') { bodyInfo.classList.add('hidden'); return; }
    const sp = scene.SPIN[name];
    const reg = scene.registry.get(name);
    if (!sp || !reg) { bodyInfo.classList.add('hidden'); return; }
    biName.textContent = `${reg.label} · 朝向与自转状态`;
    const rows = [
      ['自转周期', fmtPeriod(sp.period) + (sp.retro ? '（逆行）' : '')],
      ['自转方向', sp.retro ? '逆行（东 → 西）' : '顺行（西 → 东）'],
      ['轴倾角', sp.tilt.toFixed(2) + '°'],
    ];
    if (sp.note) rows.push(['参考系', sp.note]);
    if (sp.lock) {
      const pl = scene.registry.get(sp.lock);
      rows.push(['潮汐锁定', '同面朝向 ' + (pl ? pl.label : sp.lock)]);
    }
    biRows.innerHTML = rows.map(r =>
      `<div class="bi-row"><span>${r[0]}</span><b>${r[1]}</b></div>`).join('');
    if (!sp.lock) {
      biSpinRow = document.createElement('div');
      biSpinRow.className = 'bi-row';
      biSpinRow.innerHTML = '<span>当前自转角</span><b>—</b>';
      biRows.appendChild(biSpinRow);
    }
    bodyInfo.classList.remove('hidden');
    // 状态卡片折叠时，点击星体自动展开 ◉ 按钮下的状态卡
    document.body.classList.add('hud-open');
    hudToggle.classList.add('active');
  }

  // 任务阶段（专业术语）
  function et(utc) { return (Date.parse(utc) - J2000Ms) / 1000; }
  const PHASES = [
    [et('1997-10-15T08:43:00Z'), '发射 · 地球逃逸轨道'],
    [et('1997-10-18T00:00:00Z'), '行星际巡航 · VVEJ 转移序列'],
    [et('1998-04-26T00:00:00Z'), '巡航 · 已完成第一次 Venus 引力弹弓'],
    [et('1998-12-03T00:00:00Z'), '巡航 · 深空机动 (DSM) 后'],
    [et('1999-06-24T00:00:00Z'), '巡航 · 已完成第二次 Venus 引力弹弓'],
    [et('1999-08-18T00:00:00Z'), '巡航 · 已完成 Earth 引力弹弓 · Jupiter 转移轨道'],
    [et('2000-12-30T00:00:00Z'), '巡航 · 已完成 Jupiter 引力弹弓 · Saturn 拦截轨道'],
    [et('2004-06-11T00:00:00Z'), 'Saturn 接近段 · Phoebe 近掠'],
    [et('2004-07-01T02:48:00Z'), 'Saturn 环绕 · 主任务 (Prime Mission)'],
    [et('2008-07-01T00:00:00Z'), 'Saturn 环绕 · 延展任务一 (Equinox)'],
    [et('2010-10-01T00:00:00Z'), 'Saturn 环绕 · 延展任务二 (Solstice)'],
    [et('2017-04-26T00:00:00Z'), 'Grand Finale · 22 次环缝俯冲'],
    [et('2017-09-15T10:40:00Z'), '任务终段 · 受控再入 Saturn 大气'],
  ];
  function phaseAt(t) {
    let label = PHASES[0][1];
    for (const p of PHASES) { if (t >= p[0]) label = p[1]; }
    return label;
  }

  /* 时间轴 t 域为 ET（TDB）秒；事件表 et / URL 深链为 UTC 秒。TDB−UTC ≈
   * 64.2~69.2 s（1997→2017），全站以 65 s 常数近似：显示（fmtDate/timeline
   * updateDate）做 t−65，UTC → t 跳转做 +65。事件跳转若不加此项会早落
   * ~1 min，且与深链路径（本就 +65）不一致 */
  const ET_UTC_OFF = 65;

  function fmtDate(t) {
    const d = new Date(J2000Ms + (t - ET_UTC_OFF) * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
  }
  function fmtDist(km) {
    if (km < 1) return (km * 1000).toFixed(0) + ' m';   // 贴图特写级视距（MIN_DIST 1 m）
    if (km < 1e5) return km.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km';
    if (km < 1e8) return (km / 1e4).toFixed(1) + ' 万 km';
    return (km / 1e8).toFixed(2) + ' 亿 km';
  }

  // ---------- 交互 ----------
  function onBodyPicked(name) {
    const reg = scene.registry;
    if (name === 'cassini') {
      setInfoBody(null);
      cam.flyTo('cassini', { dist: Math.max(cam.currentDist(), 3e5) });
      return;
    }
    if (name === 'huygens') {
      pickHuygens();
      return;
    }
    const b = reg.get(name);
    if (!b) return;
    setInfoBody(name);
    cam.flyTo(name, { dist: b.radius * 6 });
  }

  /* 点击事件卡 / 时间轴节点：跳转时刻并聚焦 Cassini 本体（不聚焦行星，
     事件天体仅作为镜头距离 zoom 的参考），同时收起星体状态卡 */
  function pickEvent(ev) {
    tl.setNow(ev.et + ET_UTC_OFF);
    tl.setPlaying(false);
    tl.refresh();
    showEventCard(ev);
    const dist = ev.zoom || (scene.registry.get(ev.body) ? scene.registry.get(ev.body).radius * 8 : 1e6);
    setInfoBody(null);
    cam.flyTo('cassini', { dist });
    highlightEvent(ev);
    scrollToCurrentEvent();
  }

  function showEventCard(ev) {
    document.getElementById('event-date').textContent = ev.utc.slice(0, 10).replace(/-/g, ' / ');
    document.getElementById('event-title').textContent = ev.title;
    document.getElementById('event-text').textContent = ev.text;
    eventCard.classList.remove('hidden');
    document.body.classList.add('event-open');
    // 每次点开任务事件：详情卡默认收起，左上角通知按钮（◉ 右侧）弹出呼吸提示，点按展开 / 再点收起
    document.body.classList.add('event-folded');
  }

  /* 展开事件列表 / 跳转事件时，让列表滚动定位到当前事件（即时定位，展开即到位） */
  function scrollToCurrentEvent() {
    if (eventPanel.classList.contains('collapsed')) return;
    const cur = eventList.querySelector('.ev-item.current');
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  function highlightEvent(ev) {
    EVENTS.forEach(x => {
      if (x._item) x._item.classList.toggle('current', x === ev);
    });
  }

  let lastEventIdx = -1;
  function autoEventHighlight(t) {
    let idx = -1;
    for (let i = 0; i < EVENTS.length; i++) {
      if (EVENTS[i].et <= t) idx = i;
    }
    if (idx !== lastEventIdx) {
      lastEventIdx = idx;
      EVENTS.forEach((x, i) => x._item && x._item.classList.toggle('current', i === idx));
      tl.markPast(EVENTS, t);
    }
  }

  function onTimeChange(t, why) {
    if (why === 'drag') tl.setPlaying(false);
  }

  // ---------- 主循环 ----------
  let lastT = performance.now();
  let frame = 0;
  const bodyWorldCache = {};
  const _pv = [0, 0, 0];

  function loop(now) {
    if (window.__pauseLoop) { requestAnimationFrame(loop); return; }
    const dt = Math.min(100, now - lastT);
    lastT = now;
    tl.tick(dt);
    const t = tl.state.t;

    // 聚焦 Huygens 时倒退时间至分离前（Huygens 尚未独立飞行）→ 自动切回聚焦 Cassini。
    // flyTo 将 focusName 立即改为 'cassini'，下一帧条件不再成立，只触发一次平滑过渡
    if (window.HuygensVis && cam.currentFocus() === 'huygens' && t < window.HuygensVis.SEP_ET) {
      setInfoBody(null);
      cam.flyTo('cassini', { dist: Math.max(cam.currentDist(), 3e5) });
    }

    // 1) 绝对位置 → 2) 相机 → 3) 相对渲染
    const reg2 = scene.registry;
    for (const [name, entry] of reg2) {
      if (name !== '__sunLight') bodyWorldCache[name] = entry.world;
    }
    const { cassWorld } = scene.updatePositions(t);
    bodyWorldCache.cassini = cassWorld;
    // Huygens 当前帧位置（分离前挂载于组合体，退回 Cassini 位置；视角跟随 item 4）
    bodyWorldCache.huygens = (window.HuygensVis && window.HuygensVis.tryWorldAt(t)) || cassWorld;
    cam.update(now, bodyWorldCache, cassWorld, scene);
    scene.updateRender(t);
    scene.updateLabels(cassWorld);
    scene.render();

    // HUD（每 4 帧）
    if ((frame++ & 3) === 0) {
      const ds = fmtDate(t);
      hudDate.textContent = ds;
      hudPhase.textContent = phaseAt(t);
      // Cassini 真实姿态状态（item 6：对地通信 / SOI 与环缝穿越防尘盾 / 惠更斯中继）
      hudAtt.textContent = '姿态 ' + (scene.attitudeState || '—');
      // 距离信息
      const sun = reg2.get('sun');
      const dSun = Math.hypot(cassWorld[0] - sun.world[0], cassWorld[1] - sun.world[1], cassWorld[2] - sun.world[2]);
      let nearest = null, nd = Infinity;
      for (const name of ['venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'titan', 'enceladus', 'iapetus', 'rhea', 'dione', 'tethys', 'mimas']) {
        const b = reg2.get(name);
        if (!b) continue;
        const dd = Math.hypot(cassWorld[0] - b.world[0], cassWorld[1] - b.world[1], cassWorld[2] - b.world[2]);
        if (dd < nd) { nd = dd; nearest = b; }
      }
      hudDist.textContent =
        `Cassini ↔ Sun ${fmtDist(dSun)}` +
        (nearest ? ` · ↔ ${nearest.label} ${fmtDist(nd)}` : '');
      // 速度（轨迹差分）；进入 SOI 时显示相对该行星的速度
      const dtV = 600;
      const a = [0, 0, 0], b = [0, 0, 0];
      scene.cassiniPosAt(Math.max(T_START, t - dtV), a);
      scene.cassiniPosAt(t + dtV, b);
      const v = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (2 * dtV);
      const soi = scene.soiState;
      if (soi.moon) {
        const p = reg2.get(soi.moon);
        if (p) {
          p.track.at(t - dtV, _pv);
          const pa = [ _pv[0], _pv[2], -_pv[1] ];
          p.track.at(t + dtV, _pv);
          const pb = [ _pv[0], _pv[2], -_pv[1] ];
          const vr = Math.hypot(
            (b[0] - a[0]) - (pb[0] - pa[0]),
            (b[1] - a[1]) - (pb[1] - pa[1]),
            (b[2] - a[2]) - (pb[2] - pa[2])) / (2 * dtV);
          hudVel.textContent = `速度 ${vr.toFixed(2)} km/s（相对 ${p.label}）`;
        } else {
          hudVel.textContent = `速度 ${v.toFixed(2)} km/s（相对 Sun）`;
        }
      } else if (soi.name) {
        const p = reg2.get(soi.name);
        if (p) {
          p.track.at(t - dtV, _pv);
          const pa = [ _pv[0], _pv[2], -_pv[1] ];
          p.track.at(t + dtV, _pv);
          const pb = [ _pv[0], _pv[2], -_pv[1] ];
          const vr = Math.hypot(
            (b[0] - a[0]) - (pb[0] - pa[0]),
            (b[1] - a[1]) - (pb[1] - pa[1]),
            (b[2] - a[2]) - (pb[2] - pa[2])) / (2 * dtV);
          hudVel.textContent = `速度 ${vr.toFixed(2)} km/s（相对 ${p.label}）`;
        } else {
          hudVel.textContent = `速度 ${v.toFixed(2)} km/s（相对 Sun）`;
        }
      } else {
        hudVel.textContent = `速度 ${v.toFixed(2)} km/s（相对 Sun）`;
      }
      autoEventHighlight(t);
      // 自转角实时更新（item 9）
      if (infoBody && biSpinRow) {
        const sp = scene.SPIN[infoBody];
        if (sp) {
          let ang = ((sp.w0 + 360 * t / sp.period) % 360 + 360) % 360;
          biSpinRow.lastElementChild.textContent = ang.toFixed(1) + '°（西经）';
        }
      }
    }
    requestAnimationFrame(loop);
  }

  // 启动：默认从黄道上方极远处推近（远 → 近）；带深链接时直达目标
  const hash = location.hash.replace(/^#/, '');
  const evHash = hash.startsWith('event=') ? EVENTS.find(x => x.id === hash.slice(6)) : null;
  const dateM = hash.match(/^date=(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/);

  if (evHash) {
    tl.setNow(evHash.et + ET_UTC_OFF);
    tl.refresh();
    const dist0 = evHash.zoom || (scene.registry.get(evHash.body) ? scene.registry.get(evHash.body).radius * 8 : 1e6);
    cam.focus('cassini', { dist: dist0, theta: 0.9, phi: 1.05, animate: false });
    setInfoBody(null);
    setTimeout(() => pickEvent(evHash), 400);
  } else if (dateM) {
    const tt = Date.parse(dateM[1] + 'T' + (dateM[2] || '00') + ':' + (dateM[3] || '00') + ':00Z');
    tl.setNow((tt - J2000Ms) / 1000 + ET_UTC_OFF);
    tl.refresh();
    cam.focus('cassini', { dist: 0.04, theta: 0.9, phi: 1.05, animate: false });
  } else {
    cam.intro(5.2);
  }
  requestAnimationFrame(loop);
  // 加载页收尾：等三条进度条全部 100%（下载/构建 + 纹理解码 + 模型解析）才淡出
  if (window.CassiniLoader) window.CassiniLoader.finish();
  } catch (e) {
    fatal(e && (e.stack || e.message) || String(e));
  }
})();
