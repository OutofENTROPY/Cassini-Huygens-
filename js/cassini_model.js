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

  /* 装载单个 GLB → { wrap, span }：wrap 内为体轴校准 + 米→km 的模型 */
  function loadGLB(loader, b64) {
    return new Promise((resolve, reject) => {
      loader.parse(b64ToBuffer(b64), '', (gltf) => resolve(gltf.scene), reject);
    });
  }

  /* 包一层：体轴旋转 + 缩放 + 模型级微弱补光（背光面保留结构可读性） */
  function wrapModel(scene3, spanKm, name) {
    const wrap = new THREE.Group();
    wrap.name = name;
    const asm = new THREE.Group();
    asm.quaternion.copy(Q_GLB);
    asm.scale.setScalar(0.001);           // 米 → km
    asm.add(scene3);
    // 模型级微弱半球补光（与旧程序化模型一致，不影响行星光照）
    asm.add(new THREE.HemisphereLight(0x46506a, 0x1a1d26, 0.5));
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
    asm.add(new THREE.HemisphereLight(0x46506a, 0x1a1d26, 0.5));
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

  return { load, Q_GLB };
})();
