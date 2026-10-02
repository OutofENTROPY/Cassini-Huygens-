/* Cassini–Huygens 飞船模型装载器 —— NASA Eyes on the Solar System 官方模型
 *
 * 模型来源：eyes.nasa.gov/apps/solar-system · assets/static/models/sc_cassini/
 *   Cassini.gltf + cassini.bin + 5 张官方贴图，经 tools/build_models.py 打包为
 *   单个自包含 GLB（几何与贴图全部内嵌），base64 存于 data/models.js，完全离线。
 *
 * 相比旧 NASA-3D-Resources 版（同一 Blender 源的早期导出）的优势：
 *   1. 自带命名节点 huygens_probe —— 完整组合体 / 轨道器 / 独立探测器三实体
 *      由同一 GLB 派生（分离 = 摘除该节点），不再需要三套 GLB；
 *   2. 自带真实 PBR 数据 —— foil_normal（金箔/黑毯共用）、cassini_normal 法线
 *      贴图与 cassini_pbr 金属度/粗糙度贴图，旧版缺失法线贴图只能由照片 Sobel
 *      反推，现仅 dish_AO（无官方法线）仍走该还原路径。
 *
 * GLB 校准（实测包围盒，模型单位 = 米，与旧版体轴一致）：
 *   HGA φ4.0 m 抛物面 @ +Y（开口朝 +Y，馈源塔至 +3.4 m）；RTG 桁架沿 GLB −Z
 *   伸至 −10.9 m；磁强计双杆沿 GLB ±X（跨距 17.98 m）；Huygens φ2.62 m 侧挂于
 *   GLB +X 侧、其防热大底朝 GLB +X。
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

  /* GLB → 场景体轴映射四元数（行主序 Matrix4；见文件头注释） */
  const Q_GLB = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
    0, 0, -1, 0,
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1));

  /* Huygens 分离节点名（NASA Eyes 模型的命名节点） */
  const PROBE_NODE = 'huygens_probe';

  /* —— 材质增强：官方 GLB 数据优先，项目调优参数补足 ——
   * Eyes 版 GLB 材质自带：foil_gold / black_krinkle / tex_01 的法线贴图与
   * tex_01 的金属度粗糙度贴图（metalnessMap/roughnessMap，factor=1 为乘数），
   * 照单全收；dish_AO 无官方法线 —— 其 albedo 即 AO 烘焙，亮度图经 Sobel
   * 还原为切线空间法线（全分辨率 ≤1024）并挂 aoMap（r147 采样 uv2，几何缺
   * uv2 时以 uv 顶替）。envMap 换成场景真实星空烘焙（scene.js buildSky 的
   * equirect，PMREM 粗糙度过滤），金箔/铝件反射真实银河带；备用程序化立方体
   * 贴图仅在天空未就绪时使用。金属度/粗糙度取旧版对同源材质的调优值。 */
  const MAT_PBR = {
    aluminum:      { metal: 0.90, rough: 0.34, env: 0.85 },
    nozzles:       { metal: 0.90, rough: 0.42, env: 0.55 },
    black_krinkle: { metal: 0.25, rough: 0.66, env: 0.30, nmScale: 0.8 },
    dish_AO:       { metal: 0.80, rough: 0.42, env: 0.70, ao: 0.9, nmFromAlbedo: true, nmScale: 0.55 },
    foil_gold:     { metal: 1.00, rough: 0.40, env: 0.90, nmScale: 1.0 },
    'plasic white': { metal: 0.05, rough: 0.45, env: 0.35 },
    'plastic black': { metal: 0.08, rough: 0.60, env: 0.25 },
    tex_01:        { metal: 1.00, rough: 1.00, env: 0.60, nmScale: 1.0 },
  };
  const eclipseMats = [];          // { mat, baseColor, baseMetal, baseEnv, tag }
  const eclipseSeen = new Set();
  let envTex = null;

  /* —— 环境反射：场景真实星空烘焙（scene.js buildSky 经 setEnvironment 传入，
   * 时序：init 内 buildSky 先于 buildCassini 的 GLB 异步解析，材质增强必在其后）。
   * 天空烘焙仅银河带微光（恒星光是独立点云不进画布），×2 提亮使金属反射中
   * 银河带可见；equirect 直挂 envMap（r147 WebGLCubeUVMaps 自动 PMREM，
   * 粗糙度按 mip 过滤），方向近似（attitude 旋转不带动 env）对深空反射无感。 */
  let envSkyCanvas = null;
  let envSkyTex = null;

  function setEnvironment(canvas) {
    envSkyCanvas = canvas;
    envSkyTex = null;
  }

  function skyEnvTexture() {
    if (!envSkyCanvas) return null;
    if (envSkyTex) return envSkyTex;
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#010208';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(envSkyCanvas, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(envSkyCanvas, 0, 0, c.width, c.height);   // ×2 提亮银河带
    ctx.globalCompositeOperation = 'source-over';
    envSkyTex = new THREE.CanvasTexture(c);
    envSkyTex.mapping = THREE.EquirectangularReflectionMapping;
    envSkyTex.encoding = THREE.sRGBEncoding;
    return envSkyTex;
  }

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
   * （v=0 在图顶），法线 G 分量随之取 up−down，与 albedo 采样方向一致。
   * 全分辨率（≤1024，原 512 丢失金箔褶皱细节）。
   * 同源图 + 同参数共享缓存。 */
  const nmCache = new Map();       // image -> Map("scale" -> CanvasTexture)
  function normalMapFromTexture(tex, nmScale) {
    const img = tex && tex.image;
    if (!img || !img.width) return null;
    const key = String(nmScale);
    let byTex = nmCache.get(img);
    if (!byTex) { byTex = new Map(); nmCache.set(img, byTex); }
    if (byTex.has(key)) return byTex.get(key);
    const w = Math.min(1024, img.width), h = Math.min(1024, img.height);
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
    nt.anisotropy = 8;
    byTex.set(key, nt);
    return nt;
  }

  function enhanceMaterials(root, tag) {
    const env = skyEnvTexture() || envCubeTexture();
    const mats = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      // 自阴影（真实光照模式）：机体网格互相投射/接收阴影；
      // 普通模式无可见阴影光源（阴影贴图不重绘），此标记零开销
      o.castShadow = true;
      o.receiveShadow = true;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of ms) {
        if (!eclipseSeen.has(mat)) { eclipseSeen.add(mat); mats.push(mat); }
      }
      // aoMap 采样 uv2（r147）：单套 UV 的网格以 uv 顶替（dish_AO 烘焙同理）
      if (o.geometry && o.geometry.attributes.uv && !o.geometry.attributes.uv2) {
        o.geometry.setAttribute('uv2', o.geometry.attributes.uv);
      }
    });
    for (const mat of mats) {
      const p = MAT_PBR[mat.name] || { metal: 0.35, rough: 0.6, env: 0.4 };
      if (mat.map) {
        mat.map.anisotropy = 8;
        mat.map.needsUpdate = true;
      }
      // 官方 metalnessMap/roughnessMap（tex_01）：factor=1 已是乘数，勿覆盖
      const hasMRMap = !!(mat.metalnessMap || mat.roughnessMap);
      if (!hasMRMap) {
        mat.metalness = p.metal;
        mat.roughness = p.rough;
      }
      if (mat.normalMap) {                       // 官方法线贴图：只调强度
        if (p.nmScale !== undefined) {
          mat.normalScale = new THREE.Vector2(p.nmScale, p.nmScale);
        }
      } else if (mat.map && p.nmFromAlbedo) {    // dish_AO：AO 亮度图 Sobel 还原
        const nm = normalMapFromTexture(mat.map, 1);
        if (nm) {
          mat.normalMap = nm;
          const s = p.nmScale !== undefined ? p.nmScale : 1;
          mat.normalScale = new THREE.Vector2(s, s);
        }
      }
      if (p.ao && mat.map) { mat.aoMap = mat.map; mat.aoMapIntensity = p.ao; }
      mat.envMap = env;
      mat.envMapIntensity = p.env;
      injectFill(mat);
      mat.needsUpdate = true;
      eclipseMats.push({ mat, baseColor: mat.color.clone(), baseMetal: hasMRMap ? 1 : p.metal, baseEnv: p.env, tag });
    }
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

  /* 模型级微弱补光（背光面保留结构可读性）——注入飞船自身材质的视线前向
   * 半球项，复刻原 HemisphereLight 的逐像素光照：
   *   irradiance = mix(groundColor, skyColor, 0.5·dot(N,dir)+0.5)·I，dir ≈ 视线前向
   *   （原光源位于模型内、相机注视模型，方向恒 ≈ 视图空间 (0,0,-1)）。
   * 不再用场景级 HemisphereLight 的原因：它全局生效（泄漏到行星暗面/环影），
   * 且渲染器只收集可见子树内的光源——cassiniModel.visible = modelPx > 1.1，
   * 放大到模型出现时补光突然加入渲染状态，行星阴影面（平时仅 0.05 环境光）
   * 跳亮 3~4 倍，即"放大到一定程度行星阴影突然变亮"的根源。注入式补光只进
   * 飞船材质、任意缩放恒定；真实光照模式经 setFillLight 置零（暗面严格全黑）。
   * 颜色常量 = 0x46506a / 0x1a1d26（r147 legacy 色彩管理下按原始 sRGB 数值参与光照，
   * 与原 HemisphereLight 逐位一致）。uniform 对象全材质共享，setFillLight 只改 value。
   * 同时注入 uPointOff：真实光照模式下飞船直射光由场景平行光（带自阴影）承担，
   * 点光贡献经此归零（两光同向等强，外观无缝）；普通模式为 0，点光照常照明。 */
  const FILL_INTENSITY = 0.32;
  const fillUniform = { value: FILL_INTENSITY };
  const pointOffUniform = { value: 0 };

  /* 同 scene.js excludeDirLight：onBeforeCompile 拿到的是未展开 #include 的
   * 原始模板，光循环体在 lights_fragment_begin chunk 内部——直接替换
   * light-info 语句是静默 no-op；须取 chunk 全文注入归零语句后整体替换
   * include 指令（lib vendored r147，锚点串唯一）。 */
  const LF_BEGIN_NOPOINT = (() => {
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    const out = chunk.replace(
      'getPointLightInfo( pointLight, geometry, directLight );',
      'getPointLightInfo( pointLight, geometry, directLight );\n\t\t\tdirectLight.color *= ( 1.0 - uPointOff );');
    if (out === chunk) console.warn('uPointOff: lights_fragment_begin 锚点未命中');
    return out;
  })();

  function injectFill(mat) {
    // 非 lit 材质（MeshBasicMaterial 等）无 aomap_fragment/lighting，replace 为空操作；
    // uniform 声明须注入全局作用域（aomap_fragment / lights_fragment_begin 位于 main() 内）
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFillI = fillUniform;
      shader.uniforms.uPointOff = pointOffUniform;
      shader.uniforms.uShineDir = shineDirUniform;
      shader.uniforms.uShineCol = shineColUniform;
      shader.uniforms.uShineW = shineWUniform;
      shader.fragmentShader = 'uniform float uFillI;\nuniform float uPointOff;\n' +
        'uniform vec3 uShineDir;\nuniform vec3 uShineCol;\nuniform float uShineW;\n' + shader.fragmentShader
        .replace('#include <aomap_fragment>',
        `#include <aomap_fragment>
        {
          float fillW = 0.5 * dot(normal, vec3(0.0, 0.0, -1.0)) + 0.5;
          vec3 fillIrr = mix(vec3(0.102, 0.114, 0.149), vec3(0.275, 0.314, 0.416), fillW) * uFillI;
          reflectedLight.indirectDiffuse += fillIrr * RECIPROCAL_PI * diffuseColor.rgb;
        }
        {
          float shineNL = dot(normal, uShineDir);
          float shineD = clamp((shineNL + uShineW) / (1.0 + uShineW), 0.0, 1.0);
          reflectedLight.indirectDiffuse += uShineCol * (shineD * RECIPROCAL_PI) * diffuseColor.rgb;
          vec3 shineH = normalize(uShineDir + normalize(vViewPosition));
          float shineS = pow(clamp(dot(normal, shineH), 0.0, 1.0), mix(160.0, 8.0, uShineW));
          reflectedLight.indirectSpecular += uShineCol * (shineS * material.specularColor.rgb);
        }`)
        .replace('#include <lights_fragment_begin>', LF_BEGIN_NOPOINT);
    };
    mat.customProgramCacheKey = () => 'cassini-fill';
  }

  function setFillLight(on) {
    fillUniform.value = on ? FILL_INTENSITY : 0;
  }

  /* 真实光照模式切换：飞船直射光改由平行光承担时，点光贡献归零（uniform 切换） */
  function setSunMode(on) {
    pointOffUniform.value = on ? 1 : 0;
  }

  /* —— 行星反照光（真实光照模式，scene.js updatePlanetShine 逐帧解算）——
   * 近距行星反射的太阳光（土照/木照/月照）：飞船贴近行星时行星盘占据大半
   * 天空，背阳面的主导光源即此。与补光同惯例注入材质而非场景光源——场景级
   * 灯会泄漏到行星暗面。两项注入：
   *   漫射 = 包裹 Lambert（wrap width = uShineW）：行星是扩展光源，张角越大
   *     光越软——w = sin(行星角半径) = R/d，w→1（行星占满天空，Grand Finale
   *     近土点 ≈0.95）趋于半球环境光，w→0（远距）退化为硬平行光；包裹函数
   *     (nl+w)/(1+w) 在物理照明截止角 90°+γ（γ=行星角半径）处精确归零。
   *   镜面 = 半程向量 Blinn 项，幂随 uShineW 展宽：金属件（金箔 F0≈金色）
   *     映出整盘行星的暖色微光——扩展源的镜面像是行星盘的镜像，比太阳点源
   *     的锐高光宽得多。
   * uShineDir 为视图空间单位向量（scene.js 按相机四元数变换，同大气
   * uSunDirView 惯例）；uShineCol = 行星色调 × 强度（与平行光同量纲，强度
   * = SUN_INTENSITY × α_g(R/d)²k）。uniform 对象全材质共享，一次调用全船生效。 */
  const shineDirUniform = { value: new THREE.Vector3(0, 0, -1) };
  const shineColUniform = { value: new THREE.Vector3(0, 0, 0) };
  const shineWUniform = { value: 0 };

  function setShine(dirView, col, w) {
    if (dirView) shineDirUniform.value.copy(dirView);
    if (col) shineColUniform.value.copy(col);
    else shineColUniform.value.set(0, 0, 0);
    shineWUniform.value = w || 0;
  }

  /* 包一层：体轴旋转 + 缩放（补光由 enhanceMaterials 注入材质，见 injectFill） */
  function wrapModel(scene3, spanKm, name) {
    const wrap = new THREE.Group();
    wrap.name = name;
    const asm = new THREE.Group();
    asm.quaternion.copy(Q_GLB);
    asm.scale.setScalar(0.001);           // 米 → km
    asm.add(scene3);
    wrap.add(asm);
    wrap.userData.span = spanKm;          // 最大可视尺度（km），供像素级显隐判定
    return wrap;
  }

  /* Huygens 独立探测器：wrap(速度方向) → spin(自旋稳定) → 防热大底对准 +Z。
   * 从组合体摘出的 huygens_probe 子树自带侧挂偏置（GLB +X 侧），先按包围盒
   * 平移回原点使自旋轴（大底法向）过质心，再经 pre 旋转把 GLB +X → wrap +Z。 */
  function wrapProbe(scene3) {
    const box = new THREE.Box3().setFromObject(scene3);
    const c = box.getCenter(new THREE.Vector3());
    scene3.position.sub(c);               // 包围盒中心 → 原点（GLB 米制坐标系内）
    const wrap = new THREE.Group();
    wrap.name = 'huygensProbe';
    const spin = new THREE.Group();       // 分离后自旋稳定（约 7 rpm，绕大底轴）
    const pre = new THREE.Group();        // GLB +X（防热大底法向）→ wrap +Z
    pre.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const asm = new THREE.Group();
    asm.scale.setScalar(0.001);
    asm.add(scene3);
    pre.add(asm); spin.add(pre); wrap.add(spin);
    wrap.userData.spin = spin;
    wrap.userData.span = 0.00262;         // φ2.7 m 防热大底
    return wrap;
  }

  let pending = null;

  function load(cb) {
    const data = window.CassiniGLBData;
    if (!data || !data.eyes || !THREE.GLTFLoader) { console.error('CassiniModel: data/models.js 或 GLTFLoader 未就绪'); return; }

    const done = (parts) => { if (cb) cb(parts); };

    if (pending) { pending.then(done); return; }

    const loader = new THREE.GLTFLoader();

    pending = new Promise((resolve, reject) => {
      loader.parse(b64ToBuffer(data.eyes), '', (gltf) => resolve(gltf.scene), reject);
    }).then((src) => {
      enhanceMaterials(src, 'sc');
      const stack = wrapModel(src, 0.0180, 'cassiniStack');   // 全长（磁强计双杆跨距 17.98 m）

      // 轨道器 = 组合体克隆摘除 huygens_probe 节点（材质与组合体共享，掩食同 tag 'sc'）
      const orbScene = src.clone(true);
      const attached = orbScene.getObjectByName(PROBE_NODE);
      if (attached && attached.parent) attached.parent.remove(attached);
      const orbiter = wrapModel(orbScene, 0.0180, 'cassiniOrbiter');

      // 独立探测器 = huygens_probe 子树克隆；材质独立实例（掩食 tag 'probe'），
      // 使分离后轨道器/探测器可分别进入行星本影
      const probeNode = src.getObjectByName(PROBE_NODE);
      let probe = null;
      if (probeNode) {
        const pScene = probeNode.clone(true);
        pScene.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        });
        enhanceMaterials(pScene, 'probe');
        probe = wrapProbe(pScene);
      }
      return { stack, orbiter, probe };
    }).catch((err) => {
      console.error('CassiniModel: GLB 装载失败', err);
      return { stack: null, orbiter: null, probe: null };
    });
    pending.then(done);
  }

  return { load, Q_GLB, setEclipse, setFillLight, setSunMode, setShine, setEnvironment };
})();
