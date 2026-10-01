/* Cassini–Huygens 飞船模型装载器 —— NASA 官方 GLB 模型
 *
 * 模型来源：github.com/nasa/NASA-3D-Resources · 3D Models/Cassini-Huygens (A)
 *   full    = Cassini-Huygens (A).glb                 完整组合体（含 Huygens，分离前）
 *   orbiter = Cassini-Huygens (A) (without Hyugens).glb  Cassini 轨道器（分离后）
 *   probe   = Cassini-Huygens (A) (without Cassini).glb  Huygens 探测器（分离后独立飞行）
 * 三个 GLB 以 base64 内嵌于 data/models.js（tools/build_models.py 生成），站点保持完全离线。
 *
 * 离线 Draco：GLB 使用 KHR_draco_mesh_compression，DRACOLoader 默认经 FileLoader 获取
 * 解码器（file:// 下被浏览器禁止），此处预置 wrapper/wasm（见 patchFileLoaderOffline）。
 *
 * GLB 校准（实测包围盒，模型单位 = 米）：
 *   HGA φ4.01 m 抛物面，轴向 GLB +Y（开口朝 +Y）；RTG 桁架沿 GLB −Z 伸至 −10.9 m；
 *   磁强计双杆沿 GLB ±X；Huygens φ2.62 m 侧挂于 GLB +X 侧、其防热大底朝 GLB +X。
 * 体轴映射（场景约定与旧程序化模型一致）：
 *   GLB +Y → 场景 +Z（HGA 指向轴，由 scene.js 姿态控制实时指向 Earth）
 *   GLB −Z → 场景 +X（RTG 桁架方向）
 *   GLB +X → 场景 −Y
 * 单位换算：米 → km，整体 ×0.001（场景单位 = km）。
 *
 * 对外接口：window.CassiniModel.load(cb) → cb({ stack, orbiter, probe })（异步，仅一次）
 */
window.CassiniModel = (function () {
  'use strict';

  /* base64 → ArrayBuffer */
  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return buf;
  }

  /* 预置 Draco 解码器：拦截 FileLoader 对 draco_wasm_wrapper.js / draco_decoder.wasm 的
   * 请求（DRACOLoader 以 setPath('draco/') + 文件名调用 load，按后缀匹配），file:// 下零网络。 */
  function patchFileLoaderOffline(data) {
    if (!THREE.FileLoader || data.__patched) return;
    data.__patched = true;
    const pre = [
      { suffix: 'draco_wasm_wrapper.js', resp: data.dracoWrapper },
      { suffix: 'draco_decoder.wasm', resp: b64ToBuffer(data.dracoWasm) },
    ];
    const orig = THREE.FileLoader.prototype.load;
    THREE.FileLoader.prototype.load = function (url, onLoad, onProgress, onError) {
      const p = String(url).split('\\').join('/');
      for (let i = 0; i < pre.length; i++) {
        if (p.indexOf(pre[i].suffix) === p.length - pre[i].suffix.length) {
          if (onLoad) setTimeout(() => onLoad(pre[i].resp), 0);
          return { onProgress() {}, onError() {}, abort() {} };
        }
      }
      return orig.call(this, url, onLoad, onProgress, onError);
    };
  }

  /* GLB → 场景体轴映射四元数（行主序 Matrix4；见文件头注释） */
  const Q_GLB = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
    0, 0, -1, 0,
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1));

  /* —— 材质增强（item 5）：法线贴图分离 + PBR 金属度/粗糙度 + 环境反射 ——
   * NASA GLB 材质全部 metallic=0、无 normalMap；按材质名设定真实 PBR：
   * 金箔多层隔热毯为强反射金属，铝件次之，白/黑塑料近电介质。
   * 法线贴图由 albedo 亮度图分离（Sobel 梯度），envMap 为程序化深空
   * 立方体贴图（直射阳光高光来自场景太阳点光，环境只补星空/冷色反射）。 */
  const MAT_PBR = {
    aluminum:      { metal: 0.90, rough: 0.34, env: 0.85 },
    black_krinkle: { metal: 0.25, rough: 0.66, env: 0.30 },
    dish_AO:       { metal: 0.80, rough: 0.42, env: 0.70 },
    foil_gold:     { metal: 1.00, rough: 0.44, env: 0.90 },
    foil_gold_2:   { metal: 1.00, rough: 0.50, env: 0.90 },
    plastic_dark:  { metal: 0.10, rough: 0.70, env: 0.25 },
    plastic_white: { metal: 0.08, rough: 0.66, env: 0.30 },
    tex_01:        { metal: 0.55, rough: 0.55, env: 0.60 },
  };
  const eclipseMats = [];          // { mat, baseColor, baseMetal, baseEnv, tag }
  const eclipseSeen = new Set();
  let envTex = null;

  function envCubeTexture() {
    if (envTex) return envTex;
    const faces = [];
    for (let f = 0; f < 6; f++) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#04050a';
      ctx.fillRect(0, 0, 64, 64);
      const g = ctx.createLinearGradient(0, 0, 64, 64);
      g.addColorStop(0, 'rgba(40,48,70,0.28)');
      g.addColorStop(0.5, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(26,32,50,0.20)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      let s = 12345 + f * 7717;    // 星点（每面确定性伪随机）
      const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 26; i++) {
        ctx.globalAlpha = 0.15 + rnd() * 0.55;
        ctx.fillRect((rnd() * 64) | 0, (rnd() * 64) | 0, 1, 1);
      }
      ctx.globalAlpha = 1;
      faces.push(c);
    }
    envTex = new THREE.CubeTexture(faces);
    envTex.encoding = THREE.sRGBEncoding;
    envTex.needsUpdate = true;
    return envTex;
  }

  /* albedo 亮度图 → 切线空间法线贴图（Sobel）。GLTF 纹理 flipY=false
   * （v=0 在图顶），法线 G 分量随之取 up−down，与 albedo 采样方向一致 */
  function normalMapFromTexture(tex) {
    const img = tex && tex.image;
    if (!img || !img.width) return null;
    const w = Math.min(512, img.width), h = Math.min(512, img.height);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    let data;
    try { data = ctx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
    }
    const out = ctx.createImageData(w, h);
    const S = 2.2;
    for (let y = 0; y < h; y++) {
      const yU = Math.max(0, y - 1), yD = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const xL = Math.max(0, x - 1), xR = Math.min(w - 1, x + 1);
        const gx = (lum[y * w + xL] - lum[y * w + xR]) * S;   // left − right
        const gy = (lum[yU * w + x] - lum[yD * w + x]) * S;   // up − down（flipY=false）
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const o = (y * w + x) * 4;
        out.data[o]     = (gx * inv * 0.5 + 0.5) * 255;
        out.data[o + 1] = (gy * inv * 0.5 + 0.5) * 255;
        out.data[o + 2] = (inv * 0.5 + 0.5) * 255;
        out.data[o + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    const nt = new THREE.CanvasTexture(cv);
    nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    nt.flipY = tex.flipY;
    return nt;
  }

  function enhanceMaterials(root, tag) {
    const env = envCubeTexture();
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (eclipseSeen.has(mat)) continue;
        eclipseSeen.add(mat);
        const p = MAT_PBR[mat.name] || { metal: 0.35, rough: 0.6, env: 0.4 };
        if (mat.map) {
          const nm = normalMapFromTexture(mat.map);
          if (nm) { mat.normalMap = nm; mat.normalScale = new THREE.Vector2(0.75, 0.75); }
        }
        mat.metalness = p.metal;
        mat.roughness = p.rough;
        mat.envMap = env;
        mat.envMapIntensity = p.env;
        mat.needsUpdate = true;
        eclipseMats.push({ mat, baseColor: mat.color.clone(), baseMetal: p.metal, baseEnv: p.env, tag });
      }
    });
  }

  /* 行星本影掩食调制（item 6，scene.js 真实光照模式下逐帧调用）：
   * f→0 时 color/env 随 f 归零，金属度→1 使介质部件 F0 随 color 归零，
   * 消除塑料/白漆上残余的镜面高光 → 阴影内完全不反光 */
  let eclipseLast = [-1, -1];
  function setEclipse(fSC, fProbe) {
    const a = THREE.MathUtils.clamp(fSC === undefined ? 1 : fSC, 0, 1);
    const b = THREE.MathUtils.clamp(fProbe === undefined ? a : fProbe, 0, 1);
    if (Math.abs(a - eclipseLast[0]) < 0.004 && Math.abs(b - eclipseLast[1]) < 0.004) return;
    eclipseLast[0] = a; eclipseLast[1] = b;
    for (const e of eclipseMats) {
      const f = e.tag === 'probe' ? b : a;
      e.mat.color.copy(e.baseColor).multiplyScalar(f);
      e.mat.envMapIntensity = e.baseEnv * f;
      e.mat.metalness = e.baseMetal + (1 - e.baseMetal) * (1 - f);
    }
  }

  /* 模型级微弱半球补光：HemisphereLight 全局生效（会泄漏到行星暗面），
   * 真实光照模式下须熄灭（暗面亮度 0），普通模式保留。fillOn 记录状态，
   * 模型异步装载完成后再创建补光时按当前状态取值。 */
  const FILL_INTENSITY = 0.32;
  const fillLights = [];
  let fillOn = true;

  /* 装载单个 GLB → { wrap, span }：wrap 内为体轴校准 + 米→km 的模型 */
  function loadGLB(loader, b64) {
    return new Promise((resolve, reject) => {
      loader.parse(b64ToBuffer(b64), '', (gltf) => resolve(gltf.scene), reject);
    });
  }

  function addFillLight(asm) {
    const fill = new THREE.HemisphereLight(0x46506a, 0x1a1d26, fillOn ? FILL_INTENSITY : 0);
    asm.add(fill);
    fillLights.push(fill);
  }

  function setFillLight(on) {
    fillOn = on;
    for (const f of fillLights) f.intensity = on ? FILL_INTENSITY : 0;
  }

  /* 包一层：体轴旋转 + 缩放 + 模型级微弱补光（背光面保留结构可读性） */
  function wrapModel(scene3, spanKm, name) {
    const wrap = new THREE.Group();
    wrap.name = name;
    const asm = new THREE.Group();
    asm.quaternion.copy(Q_GLB);
    asm.scale.setScalar(0.001);           // 米 → km
    asm.add(scene3);
    // 模型级微弱半球补光（与旧程序化模型一致，不影响行星光照；
    // item 2：0.5→0.32 —— 泄漏到全场景的补光随阴影环境光一并压暗）
    addFillLight(asm);
    enhanceMaterials(scene3, 'sc');
    wrap.add(asm);
    wrap.userData.span = spanKm;          // 最大可视尺度（km），供像素级显隐判定
    return wrap;
  }

  /* Huygens 独立探测器：wrap(速度方向) → spin(自旋稳定) → 防热大底对准 +Z */
  function wrapProbe(scene3) {
    const wrap = new THREE.Group();
    wrap.name = 'huygensProbe';
    const spin = new THREE.Group();       // 分离后自旋稳定（约 7 rpm，绕大底轴）
    const pre = new THREE.Group();        // GLB +X（防热大底法向）→ wrap +Z
    pre.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const asm = new THREE.Group();
    asm.scale.setScalar(0.001);
    asm.add(scene3);
    addFillLight(asm);
    enhanceMaterials(scene3, 'probe');
    pre.add(asm); spin.add(pre); wrap.add(spin);
    wrap.userData.spin = spin;
    wrap.userData.span = 0.00262;         // φ2.7 m 防热大底
    return wrap;
  }

  let pending = null;

  function load(cb) {
    const data = window.CassiniGLBData;
    if (!data || !THREE.GLTFLoader) { console.error('CassiniModel: data/models.js 或 GLTFLoader 未就绪'); return; }

    const done = (parts) => { if (cb) cb(parts); };

    if (pending) { pending.then(done); return; }
    patchFileLoaderOffline(data);

    const loader = new THREE.GLTFLoader();
    const draco = new THREE.DRACOLoader();
    draco.setDecoderPath('draco/');
    loader.setDRACOLoader(draco);

    pending = Promise.all([
      loadGLB(loader, data.full), loadGLB(loader, data.orbiter), loadGLB(loader, data.probe),
    ]).then((scenes) => ({
      stack: wrapModel(scenes[0], 0.0180, 'cassiniStack'),    // 全长（磁强计双杆跨距 17.98 m）
      orbiter: wrapModel(scenes[1], 0.0180, 'cassiniOrbiter'),
      probe: wrapProbe(scenes[2]),
    })).catch((err) => {
      console.error('CassiniModel: GLB 装载失败', err);
      return { stack: null, orbiter: null, probe: null };
    });
    pending.then(done);
  }

  return { load, Q_GLB, setEclipse, setFillLight };
})();
