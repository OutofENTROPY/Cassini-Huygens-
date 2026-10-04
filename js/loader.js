/* loader.js — 启动加载器：接管全部脚本装载并驱动三条实时进度条
 *
 * 主条（串行链，分段堆叠，颜色 = 资源组）：下载/eval → 场景构建
 *   橙 = 框架 + 业务脚本 · 青 = 贴图/星表数据 · 蓝 = 轨道数据 · 紫 = 模型数据 · 灰 = 场景构建
 * 细条 ×2（并行链，scene.init 发起后推进）：纹理解码 n/21 · GLB 模型解析
 *
 * 在线版：XHR 3 路并发下载真实字节进度，按 manifest 顺序经间接 eval 执行
 *（全局作用域语义与 <script> 一致）；file:// 或 XHR 失败：回退为 <script src>
 * 串行注入（onload 里程碑，条内爬行动画补位）。
 *
 * 死区策略：eval / 场景构建是主线程长任务，JS 无法逐帧更新——填充走
 * transform: scaleX 合成器动画，事件只更新目标值；执行大文件前先向目标
 * 之外做一次尺寸估算的缓动爬行（nudge），事件到来时校正到真实位置。
 *
 * 收尾：main.js 在首帧后调 finish()，三条全部 100% 后 overlay 淡出。
 */
(function () {
  'use strict';

  /* ---------- 资源清单（执行顺序 = 原index.html脚本顺序，勿乱） ---------- */
  var V = {
    three: '2026094', gltf: '2026103', tex: '2026401', stars: '2026094',
    cassini: '2026104', moons: '2026104', attitude: '2026301', models: '2026303',
    events: '2026404', jtex: '2026103', huygens: '20261003e', cmodel: '2026305',
    scene: '2026110', camera: '2026403', timeline: '2026125', main: '2026309',
  };
  var MANIFEST = [
    ['lib/three.min.js?v=' + V.three, 'lib', 607784],
    ['lib/GLTFLoader.js?v=' + V.gltf, 'lib', 103311],
    ['data/textures.js?v=' + V.tex, 'tex', 17882421],
    ['data/stars.js?v=' + V.stars, 'tex', 454907],
    ['data/cassini_data.p00.js?v=' + V.cassini + 'p0', 'orbit', 4000155],
    ['data/cassini_data.p01.js?v=' + V.cassini + 'p1', 'orbit', 957883],
    ['data/cassini_data.p02.js?v=' + V.cassini + 'p2', 'orbit', 4000154],
    ['data/cassini_data.p03.js?v=' + V.cassini + 'p3', 'orbit', 3436746],
    ['data/cassini_data.p04.js?v=' + V.cassini + 'p4', 'orbit', 4000166],
    ['data/cassini_data.p05.js?v=' + V.cassini + 'p5', 'orbit', 2606406],
    ['data/cassini_data.asm.js?v=' + V.cassini + 'a', 'orbit', 5733877],
    ['data/moons_data.p00.js?v=' + V.moons + 'm0', 'orbit', 4000152],
    ['data/moons_data.p01.js?v=' + V.moons + 'm1', 'orbit', 190600],
    ['data/moons_data.p02.js?v=' + V.moons + 'm2', 'orbit', 4000148],
    ['data/moons_data.p03.js?v=' + V.moons + 'm3', 'orbit', 1587412],
    ['data/moons_data.asm.js?v=' + V.moons + 'a', 'orbit', 9160446],
    ['data/models.js?v=' + V.models, 'model', 5756443],
    ['data/attitude_data.js?v=' + V.attitude, 'orbit', 8986981],
    ['js/events.js?v=' + V.events, 'lib', 10112],
    ['js/textures.js?v=' + V.jtex, 'lib', 28186],
    ['js/huygens.js?v=' + V.huygens, 'lib', 28151],
    ['js/cassini_model.js?v=' + V.cmodel, 'lib', 25827],
    ['js/scene.js?v=' + V.scene, 'lib', 169734],
    ['js/camera.js?v=' + V.camera, 'lib', 14458],
    ['js/timeline.js?v=' + V.timeline, 'lib', 6625],
    ['js/main.js?v=' + V.main, 'lib', 22826],
  ];

  /* ---------- 资源组（主条分段，槽宽 = 字节真实占比；场景构建固定小槽） ---------- */
  var GROUPS = {
    lib:   { label: '下载框架脚本', color: '#f0a13c' },   // 橙（原蓝，色相与轨道组互换）
    tex:   { label: '下载贴图数据', color: '#35c99a' },
    orbit: { label: '下载轨道数据', color: '#5c9dff' },   // 蓝（原橙）
    model: { label: '下载模型数据', color: '#b07ef0' },
    scene: { label: '构建场景',     color: '#8fa3bf' },
  };
  var ORDER = ['lib', 'tex', 'orbit', 'model', 'scene'];   // 段序不变；橙蓝色相互换（用户反馈）
  var totalBytes = 0;
  MANIFEST.forEach(function (f) { totalBytes += f[2]; });
  var SCENE_SLOT = 0.05;                       // 场景构建固定占 5%
  ORDER.forEach(function (k) {
    var g = GROUPS[k];
    g.files = [];
    g.bytes = 0;
    g.loaded = 0;                              // 已计字节累计
    g.real = 0;                                // 真实进度（字节/事件）
    g.disp = 0;                                // 显示进度（单调，可为爬行过冲值）
    if (k === 'scene') { g.slot = SCENE_SLOT; return; }
    MANIFEST.forEach(function (f) { if (f[1] === k) { g.files.push(f); g.bytes += f[2]; } });
  });
  // 槽宽分配：场景构建固定 5%；下载组按字节占比分剩余 95%，但设下限——
  // 框架脚本组仅 ~1.2%，不设下限则蓝段窄到不可见（用户反馈 #2）
  var MIN_SLOT = 0.04;
  var dlGroups = ['lib', 'tex', 'orbit', 'model'];
  var shares = {}, flexSum = 0, floorSum = 0;
  dlGroups.forEach(function (k) {
    var s = GROUPS[k].bytes / totalBytes;
    shares[k] = s;
    if (s < MIN_SLOT) floorSum += MIN_SLOT; else flexSum += s;
  });
  var flexAvail = 1 - SCENE_SLOT - floorSum;
  var acc = 0;
  dlGroups.forEach(function (k, i, arr) {
    var w = shares[k] < MIN_SLOT ? MIN_SLOT : shares[k] / flexSum * flexAvail;
    GROUPS[k].slot = w;
    acc += w;
    if (i === arr.length - 1) GROUPS[k].slot += (1 - SCENE_SLOT) - acc; // 尾组吸收舍入
  });

  /* ---------- DOM ---------- */
  var loadingEl = document.getElementById('loading');
  var textEl = document.getElementById('loading-text');
  var stageEl = document.getElementById('load-stage');
  var mainBarEl = document.getElementById('loadbar-main');
  var pctEl = document.getElementById('load-pct');
  var texFillEl = document.getElementById('loadbar-tex-fill');
  var texPctEl = document.getElementById('load-pct-tex');
  var modelFillEl = document.getElementById('loadbar-model-fill');
  var modelPctEl = document.getElementById('load-pct-model');
  var fills = {};

  ORDER.forEach(function (k) {
    var seg = document.createElement('div');
    seg.className = 'load-seg';
    // 段间 2px 间隙由 CSS gap 提供；每段扣除 1.6px（5 段共 8px = 4 道间隙），
    // 总宽恰好铺满且不溢出（此前 padding 方案曾把末段挤出裁剪区）
    seg.style.width = 'calc(' + (GROUPS[k].slot * 100).toFixed(2) + '% - 1.6px)';
    var fill = document.createElement('div');
    fill.className = 'load-fill';
    fill.style.background = GROUPS[k].color;
    fill.style.transform = 'scaleX(0)';
    seg.appendChild(fill);
    mainBarEl.appendChild(seg);
    fills[k] = fill;
  });

  function setReal(k, frac, ms) {
    var g = GROUPS[k];
    if (!isFinite(frac)) return;                 // 任何 NaN/∞ 都不许进入显示链
    g.real = Math.max(g.real, Math.min(1, frac));
    g.disp = Math.max(g.disp, g.real);         // 显示单调不减；真实进度追平过冲
    applyFill(k, ms);
  }
  /* 爬行补位：主线程即将被长任务占满，先向「真实进度 + 估计行程」缓动。
   * 目标锚定真实进度而非显示值——过冲不随文件累积，事件追上即校正。 */
  function nudge(k, fileBytes) {
    var g = GROUPS[k];
    if (!g.bytes) return;
    var target = Math.min(1, g.real + 0.6 * fileBytes / g.bytes);
    if (target <= g.disp) return;
    g.disp = target;
    applyFill(k, Math.min(2600, Math.max(400, fileBytes / 4000)));
  }
  function applyFill(k, ms) {
    fills[k].style.transitionDuration = (ms || 350) + 'ms';
    fills[k].style.transform = 'scaleX(' + GROUPS[k].disp.toFixed(4) + ')';
    updateOverall();
  }

  var overallPct = 0;
  function updateOverall() {
    var p = 0;
    ORDER.forEach(function (k) { p += GROUPS[k].slot * GROUPS[k].disp; });
    overallPct = Math.round(p * 100);
    pctEl.textContent = overallPct + '%';
  }
  function setStage(text) { stageEl.textContent = text; }
  /* 阶段文字稳定策略：显示 ORDER 中第一个未完成的下载组——3 路并发下载时
   * 各组字节交错到达，若跟随事件源文字会高频跳变（用户反馈 #5）；
   * 只在某个组整体完成时切换一次 */
  function updateStage() {
    if (dlDone) return;
    for (var i = 0; i < ORDER.length && ORDER[i] !== 'scene'; i++) {
      if (GROUPS[ORDER[i]].real < 1) { setStage(GROUPS[ORDER[i]].label); return; }
    }
  }

  /* ---------- 并行细条状态 ---------- */
  var texInitiated = {}, texDone = {}, texTotal = 0;
  function refreshTex() {
    if (!texTotal) { texPctEl.textContent = '准备中'; return; }
    var n = 0; for (var k in texDone) n++;
    texFillEl.style.transitionDuration = '300ms';
    texFillEl.style.transform = 'scaleX(' + (n / texTotal).toFixed(4) + ')';
    texPctEl.textContent = n + '/' + texTotal;
    texFillEl.classList.toggle('lit', n >= texTotal);   // 完成提亮（用户反馈 #4）
    check();
  }
  var modelFrac = 0;
  function refreshModel() {
    modelFillEl.style.transitionDuration = '400ms';
    modelFillEl.style.transform = 'scaleX(' + modelFrac.toFixed(4) + ')';
    modelPctEl.textContent = modelFrac >= 1 ? '完成' :
      (modelFrac > 0 ? '解析中' : '等待中');
    modelFillEl.classList.toggle('lit', modelFrac >= 1);
    check();
  }

  /* ---------- 完成判定 ---------- */
  var dlDone = false, sceneDone = false, finished = false;
  function check() {
    if (finished || !dlDone || !sceneDone || modelFrac < 1) return;
    if (!texTotal || (function () { var n = 0; for (var k in texDone) n++; return n; })() < texTotal) return;
    finished = true;
    setStage('完成');
    setTimeout(function () { loadingEl.classList.add('done'); }, 400);
    setTimeout(function () { loadingEl.style.display = 'none'; }, 1000);
  }

  /* ---------- 下载 + 按序执行 ---------- */
  var CONC = 3;
  var results = new Array(MANIFEST.length);
  var bytesSeen = MANIFEST.map(function () { return 0; });   // 每文件已计字节（NaN 防线：不可为 undefined）
  var nextDl = 0, nextExec = 0, inflight = 0;
  var failed = false;

  function fail(msg) {
    if (failed) return;
    failed = true;
    textEl.textContent = '启动失败: ' + msg;
    textEl.style.color = '#ff8f8f';
  }

  function addBytes(i, loaded) {
    var f = MANIFEST[i];
    loaded = +loaded || 0;                       // 进度事件异常时退化为文件完成里程碑
    var capped = Math.min(f[2], loaded);
    var g = GROUPS[f[1]];
    g.loaded += Math.max(0, capped - bytesSeen[i]);
    bytesSeen[i] = capped;
    setReal(f[1], g.loaded / g.bytes, 250);
    updateStage();
  }

  function execCode(code) { (0, eval)(code); }

  function tryExec() {
    while (nextExec < MANIFEST.length && results[nextExec] != null) {
      var i = nextExec, code = results[i];
      results[i] = null;
      var f = MANIFEST[i];
      if (code && f[2] > 1500000) nudge(f[1], f[2]);   // 大文件 eval 前先爬行
      if (code) execCode(code);
      nextExec++;
      if (i === MANIFEST.length - 1) {                 // 全部执行完，释放分片缓冲
        dlDone = true;
        window.__DP = undefined;
        setStage('构建场景');
        check();
      }
    }
  }
  function xhrGet(url, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onprogress = function (e) { onProgress(e.loaded); };
      xhr.onload = function () {
        if (xhr.status === 200 || xhr.status === 0) resolve(xhr.responseText);
        else reject(new Error('HTTP ' + xhr.status + ' ' + url));
      };
      xhr.onerror = function () { reject(new Error('网络错误 ' + url)); };
      xhr.send();
    });
  }

  function pump() {
    while (inflight < CONC && nextDl < MANIFEST.length) {
      (function (i) {
        inflight++;
        var f = MANIFEST[i];
        xhrGet(f[0], function (loaded) { if (!failed) addBytes(i, loaded); })
          .then(function (text) {
            inflight--;
            results[i] = text;
            addBytes(i, f[2]);
            pump();
            tryExec();
          })
          .catch(function (err) {
            inflight--;
            // 已执行的脚本无法安全重复执行：只在尚未执行任何脚本时允许整体回退
            if (!failed && nextExec === 0) {
              failed = true;
              fallbackToScriptTags(err);
            } else if (!failed) {
              fail(String(err && err.message || err));
            }
          });
      })(nextDl++);
    }
  }

  /* file:// 回退：XHR/Fetch 被禁，退回 <script src> 串行注入（onload 里程碑） */
  function fallbackToScriptTags(err) {
    if (location.protocol !== 'file:') console.warn('loader: 转回脚本注入模式', err);
    failed = false;
    nextDl = MANIFEST.length;                        // 停掉 XHR 泵的新任务
    results = new Array(MANIFEST.length);
    bytesSeen = MANIFEST.map(function () { return 0; });
    nextExec = 0;
    ORDER.forEach(function (k) {
      if (k === 'scene') return;
      var g = GROUPS[k];
      g.loaded = 0; g.real = 0; g.disp = 0;
      applyFill(k, 0);
    });

    var i = 0;
    function step() {
      if (failed) return;
      if (i >= MANIFEST.length) {
        dlDone = true;
        setStage('构建场景');
        check();
        return;
      }
      var f = MANIFEST[i];
      if (f[2] > 1500000) nudge(f[1], f[2]);
      var s = document.createElement('script');
      s.src = f[0];
      s.onload = function () {
        var g = GROUPS[f[1]];
        g.loaded += f[2];
        setReal(f[1], g.loaded / g.bytes, 250);
        updateStage();
        i++;
        step();
      };
      s.onerror = function () { fail('脚本加载失败 ' + f[0]); };
      document.head.appendChild(s);
    }
    step();
  }

  /* ---------- 对外接口（scene.js / cassini_model.js / main.js 使用） ---------- */
  var api = {};
  window.CassiniLoader = api;
  api.texStart = function (name) { if (!(name in texInitiated)) texInitiated[name] = 1; };
  api.texDone = function (name) {
    if (!(name in texDone)) { texDone[name] = 1; refreshTex(); }
  };
  /* 场景构建完成：锁定纹理总数，正式开始并行细条计程 */
  api.sceneBuilt = function () {
    if (sceneDone) return;
    sceneDone = true;
    texTotal = 0; for (var k in texInitiated) texTotal++;
    refreshTex();
    setReal('scene', 1, 200);
    setStage('解析资源');   // 并行细条收尾阶段；check() 完成时改为「完成」
    check();
  };
  api.modelStep = function (frac) {
    modelFrac = Math.max(modelFrac, frac);
    refreshModel();
  };
  api.finish = function () { api.sceneBuilt(); check(); };
  /* 调试：控制台 CassiniLoader._dbg() 查看各组真实/显示进度与加载模式 */
  api._dbg = function () {
    return ORDER.map(function (k) {
      var g = GROUPS[k];
      return { group: k, bytes: g.bytes, loaded: g.loaded, real: +g.real.toFixed(4), disp: +g.disp.toFixed(4), slot: +g.slot.toFixed(4) };
    }).concat([{ nextExec: nextExec, nextDl: nextDl, inflight: inflight, dlDone: dlDone, sceneDone: sceneDone, failed: failed }]);
  };

  refreshTex();
  refreshModel();
  updateOverall();

  /* ---------- 启动 ---------- */
  if (location.protocol === 'file:') {
    fallbackToScriptTags(null);
  } else {
    pump();
  }
})();
