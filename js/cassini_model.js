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
  /* 掩食因子 uniform 按实体分套（'sc' 轨道器/组合体、'probe' 探测器）：
   * 分离后两者可相距数万 km、本影独立解算，同一因子只对解算实体正确 */
  const eclSC = { value: 1 };
  const eclProbe = { value: 1 };
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
      injectFill(mat, tag === 'probe' ? shineProbe : shineSC,
        tag === 'probe' ? reflProbe : reflSC, tag);
      mat.needsUpdate = true;
    }
  }

  /* 行星本影掩食调制（真实光照模式下 scene.js 逐帧调用）：旧实现按因子改写
   * 材质 color/envMapIntensity/metalness——逐材质属性突变，且 metalness→1 的
   * 介质高光抑制只是近似。改为 uniforms 注入（同 uPointOff 机制，值写共享
   * uniform 对象、零重编译）：uEclipse 乘平行光 directLight.color —— 直射
   * 漫反射与镜面（含介质白漆高光，F0 白但辐度随光色归零）按同一因子衰减；
   * 天空 env 的间接镜面在 aomap 注入块开头乘 uEclipse（假 IBL，本影内应
   * 熄灭）；行星反照光在其后累加、不受调制（采样面元自带局地光照权重，
   * 飞船进入本影时看到的正是行星夜面，见 scene.js 调用处注释）。普通模式
   * uEclipse 恒 1（scene.js 切换时 setEclipse(1,1) 复位），点光照明不受影响 */
  function setEclipse(fSC, fProbe) {
    const a = THREE.MathUtils.clamp(fSC === undefined ? 1 : fSC, 0, 1);
    const b = THREE.MathUtils.clamp(fProbe === undefined ? a : fProbe, 0, 1);
    if (Math.abs(a - eclSC.value) < 0.004 && Math.abs(b - eclProbe.value) < 0.004) return;
    eclSC.value = a; eclProbe.value = b;
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
  /* 金属层太阳镜面开关（仅真实光照置 1）：见 LF_BEGIN_NOPOINT 内 glint 注入块 */
  const glintUniform = { value: 0 };
  /* 飞船→太阳 视图空间方向（scene.js updatePlanetShine 逐帧解算）：
   * env 间接光的暗面门禁用——实时 cube 含亮行星盘，背光面金属映亮盘是
   * 「真实光照暗面不黑」的根源，见 aomap 注入块 envGate */
  const sunDirUniform = { value: new THREE.Vector3(0, 0, -1) };

  function setSunDirView(v) { sunDirUniform.value.copy(v); }

  /* 同 scene.js excludeDirLight：onBeforeCompile 拿到的是未展开 #include 的
   * 原始模板，光循环体在 lights_fragment_begin chunk 内部——直接替换
   * light-info 语句是静默 no-op；须取 chunk 全文注入归零语句后整体替换
   * include 指令（lib vendored r147，锚点串唯一）。 */
  const LF_BEGIN_NOPOINT = (() => {
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    let out = chunk.replace(
      'getPointLightInfo( pointLight, geometry, directLight );',
      'getPointLightInfo( pointLight, geometry, directLight );\n\t\t\tdirectLight.color *= ( 1.0 - uPointOff );');
    if (out === chunk) console.warn('uPointOff: lights_fragment_begin 锚点未命中');
    // 掩食因子乘平行光：飞船真实模式直射光仅 shipSunLight 一条（sunLight 是
    // 点光，已由 uPointOff 归零），普通模式 uEclipse 恒 1 不参与。直射漫反射
    // 与镜面同随光色衰减，介质白漆高光无需再借 metalness 近似抑制
    let out2 = out.replace(
      'getDirectionalLightInfo( directionalLight, geometry, directLight );',
      'getDirectionalLightInfo( directionalLight, geometry, directLight );\n\t\t\tdirectLight.color *= uEclipse;');
    if (out2 === out) console.warn('uEclipse: lights_fragment_begin 锚点未命中');
    // 金属层太阳镜面（仅真实光照，uGlint 门禁）：物理 GGX 主瓣之外叠加按粗糙度
    // 展宽的 Blinn 高光——SUN_INTENSITY 下 GGX 峰值弱于真实照片中金箔/铝件的
    // 日光镜面反射。注入点取方向光循环内阴影乘法之后的 RE_Direct 之前
    // （chunk 内 RE_Direct 语句出现三次——点光/聚光/方向光循环各一，取
    // lastIndexOf 定位方向光循环），directLight.color 此处已含阴影与掩食因子：
    // 本影/自阴影内高光严格熄灭（真实光照「阴影处完全不反光」），metalness
    // 加权只进金属层、介质白漆不加；普通模式 uGlint=0 整体旁路，零额外开销
    const RE_DIRECT = 'RE_Direct( directLight, geometry, material, reflectedLight );';
    const iRE = out2.lastIndexOf(RE_DIRECT);
    if (iRE < 0) {
      console.warn('uGlint: lights_fragment_begin RE_Direct 锚点未命中');
    } else {
      const glint =
        '{\n' +
        '\t\t\tvec3 glintH = normalize( directLight.direction + geometry.viewDir );\n' +
        '\t\t\tfloat glintNL = clamp( dot( geometry.normal, glintH ), 0.0, 1.0 );\n' +
        '\t\t\tfloat glintP = mix( 160.0, 24.0, clamp( material.roughness, 0.0, 1.0 ) );\n' +
        '\t\t\treflectedLight.directSpecular += directLight.color * ( uGlint * metalnessFactor * pow( glintNL, glintP ) ) * material.specularColor.rgb;\n' +
        '\t\t}\n\t\t';
      out2 = out2.slice(0, iRE) + glint + out2.slice(iRE);
    }
    return out2;
  })();

  function injectFill(mat, shine, refl, tag) {
    // 非 lit 材质（MeshBasicMaterial 等）无 aomap_fragment/lighting，replace 为空操作；
    // uniform 声明须注入全局作用域（aomap_fragment / lights_fragment_begin 位于 main() 内）
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFillI = fillUniform;
      shader.uniforms.uPointOff = pointOffUniform;
      shader.uniforms.uGlint = glintUniform;
      shader.uniforms.uSunDirV = sunDirUniform;
      shader.uniforms.uEclipse = tag === 'probe' ? eclProbe : eclSC;
      shader.uniforms.uShineDir = shine.dir;
      shader.uniforms.uShineCol = shine.col;
      shader.uniforms.uShineW = shine.w;
      shader.uniforms.uShineRes = shine.res;
      shader.uniforms.uReflDir = refl.dirs;
      shader.uniforms.uReflCol = refl.cols;
      shader.uniforms.uReflRad = refl.rads;
      shader.fragmentShader = 'uniform float uFillI;\nuniform float uPointOff;\nuniform float uGlint;\nuniform vec3 uSunDirV;\nuniform float uEclipse;\n' +
        'uniform vec3 uShineDir;\nuniform vec3 uShineCol;\nuniform float uShineW;\nuniform float uShineRes;\n' +
        'uniform vec3 uReflDir[' + REFL_SLOTS + '];\nuniform vec3 uReflCol[' + REFL_SLOTS + '];\nuniform float uReflRad[' + REFL_SLOTS + '];\n' +
        (hdrURef ? 'uniform float uHdrOnM;\nuniform float uExposureM;\n' : '') + shader.fragmentShader
        .replace('#include <aomap_fragment>',
        `#include <aomap_fragment>
        {
          // env 间接光门禁：乘因子须在 shine 注入之前——本块后半累加的行星
          // 反照光不受调制（同 diffuse 项理由）。实时 env 含亮行星盘（假 IBL），
          // 按通道分治：①漫射（大范围泛光，暗面显亮的根源）硬门禁——本影
          // uEclipse 熄灭 + 真实光照下按日晒（N·sunDir 包裹，wrap 0.15）熄灭；
          // ②镜面（行星盘镜像 = 实时反射效果本身，2026-10-06 用户要求真实
          // 光照下全程启用）仅本影熄灭——镜像随视角滑动不受暗面限制
          float sunW = clamp( ( dot( normal, uSunDirV ) + 0.15 ) / 1.15, 0.0, 1.0 );
          reflectedLight.indirectSpecular *= uEclipse;
          reflectedLight.indirectDiffuse *= uEclipse * mix( 1.0, sunW, uGlint );
          float fillW = 0.5 * dot(normal, vec3(0.0, 0.0, -1.0)) + 0.5;
          vec3 fillIrr = mix(vec3(0.102, 0.114, 0.149), vec3(0.275, 0.314, 0.416), fillW) * uFillI;
          // 20261010d：补光按日照因子调制（sunW 同块上文已算出，wrap 0.15）。
          // 原实现补光为视空间恒定量——面向相机的背阳面与向阳面获得同等补光，
          // 过晨昏线部分被抬到与受照面几乎同亮（用户报「卡西尼没有被太阳
          // 直射的部分没有变暗」）。20261010e：背阳底光 25%→10%——深空巡航段
          // （附近无行星）用户明确要求阴影更暗，25% 底光经 sRGB 曲线抬升后
          // 背光面读数 ~46-60/255 观感仍亮；10% 使阴影降到 ~20-25（可辨结构
          // 但明显是暗面）。真实光照模式 uFillI=0，本调制无副作用
          fillIrr *= mix( 0.1, 1.0, sunW );
          reflectedLight.indirectDiffuse += fillIrr * RECIPROCAL_PI * diffuseColor.rgb;
        }
        {
          float shineNL = dot(normal, uShineDir);
          float shineD = clamp((shineNL + uShineW) / (1.0 + uShineW), 0.0, 1.0);
          // item 7 暗面土照：本影内环照/大气边缘残差补到背行星面
          //（0.5−0.5·nl 在背行星面=1、晨昏线=0.5，与 shineD 互补成半球）；
          // uShineRes=0（非掩食段）时逐位回退原包裹 Lambert，无额外开销
          float shineR = uShineRes * clamp(0.5 - 0.5 * shineNL, 0.0, 1.0);
          reflectedLight.indirectDiffuse += uShineCol * ((shineD + shineR) * RECIPROCAL_PI) * diffuseColor.rgb;
          vec3 shineH = normalize(uShineDir + normalize(vViewPosition));
          float shineS = pow(clamp(dot(normal, shineH), 0.0, 1.0), mix(160.0, 8.0, uShineW));
          reflectedLight.indirectSpecular += uShineCol * (shineS * material.specularColor.rgb);
        }
        {
          // 行星盘镜面反射（仅真实光照，scene.js 逐帧解算，见 setReflections 注释）：
          // 反射向量落入天体角盘 → 累加其反照色 × F0。视图空间逐像素解算，
          // 相机移动时反射像实时滑过金属面；盘缘 15% smoothstep 软化抗锯齿；
          // uReflRad=0 槽位旁路。非真实光照模式全槽为 0，块开销仅 3 次点积
          vec3 reflV = reflect(-normalize(vViewPosition), normal);
          vec3 reflAcc = vec3(0.0);
          for (int i = 0; i < ${REFL_SLOTS}; i++) {
            if (uReflRad[i] <= 0.0) continue;
            float reflAng = acos(clamp(dot(reflV, uReflDir[i]), -1.0, 1.0));
            reflAcc += uReflCol[i] * (1.0 - smoothstep(uReflRad[i] * 0.85, uReflRad[i] * 1.05, reflAng));
          }
          reflectedLight.indirectSpecular += reflAcc * material.specularColor.rgb;
        }`)
        .replace('#include <lights_fragment_begin>', LF_BEGIN_NOPOINT);
      // HDR 自适应曝光（scene.js setHdr 绑定同一组 uniform，见 setHdrUniforms）：
      // 显示空间（dithering 前）乘曝光 + ACES 拟合曲线，与行星/环材质同一变换
      if (hdrURef) {
        shader.uniforms.uHdrOnM = hdrURef.uHdrOn;
        shader.uniforms.uExposureM = hdrURef.uExposure;
        shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>',
          `#include <dithering_fragment>
          {
            if (uHdrOnM > 0.5) {
              vec3 _c = gl_FragColor.rgb * uExposureM;
              gl_FragColor.rgb = clamp((_c * (2.51 * _c + 0.03)) / (_c * (2.43 * _c + 0.59) + 0.14), 0.0, 1.0);
            }
          }`);
      }
    };
    mat.customProgramCacheKey = () => 'cassini-fill';
  }

  function setFillLight(on) {
    fillUniform.value = on ? FILL_INTENSITY : 0;
  }

  /* HDR 自适应曝光 uniform 绑定（scene.js hdrU，构建期调用一次，引用共享）：
   * 飞船材质与行星/环走同一曝光 + ACES 变换——掩食/夜面特写时曝光抬升，
   * 船体与 item 7 残差环照随之可辨（否则场景亮了船仍黑）。onBeforeCompile
   * 首跑时 hdrURef 可能尚未绑定（scene 构建晚于模型加载）——uniform 经引用
   * 共享，晚绑定的材质在首次编译时读取即可，无需重编译。 */
  let hdrURef = null;
  function setHdrUniforms(u) { hdrURef = u; }

  /* 真实光照模式切换：飞船直射光改由平行光承担时，点光贡献归零（uniform 切换）；
   * 同步开启金属层太阳镜面（glint 注入块仅真实光照可见，普通模式旁路） */
  function setSunMode(on) {
    pointOffUniform.value = on ? 1 : 0;
    glintUniform.value = on ? 1 : 0;
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
   * = SUN_INTENSITY × α_g(R/d)²k）。uniform 对象按实体分套、套内全材质
   * 共享：分离后轨道器与探测器相距可达数万 km（Titan 进入日 ~6×10⁴ km），
   * 同一解算结果只对解算位置正确——探测器由 scene.js 按自身位置独立解算
   * 并经 setProbeShine 写入另一套（分离前探测器挂于组合体走 'sc' 套，
   * 独立探测器模型彼时隐藏，其 uniforms 值不参与渲染）。 */
  function mkShineUniforms() {
    return {
      dir: { value: new THREE.Vector3(0, 0, -1) },
      col: { value: new THREE.Vector3(0, 0, 0) },
      w: { value: 0 },
      res: { value: 0 },   // item 7 暗面土照：本影残差补项开关（scene.js 按 (1−f) 解算强度）
    };
  }
  const shineSC = mkShineUniforms();
  const shineProbe = mkShineUniforms();

  function setShineUniforms(u, dirView, col, w, res) {
    if (dirView) u.dir.value.copy(dirView);
    if (col) u.col.value.copy(col);
    else u.col.value.set(0, 0, 0);
    u.w.value = w || 0;
    u.res.value = (dirView && res) || 0;
  }

  function setShine(dirView, col, w, res) { setShineUniforms(shineSC, dirView, col, w, res); }

  function setProbeShine(dirView, col, w, res) { setShineUniforms(shineProbe, dirView, col, w, res); }

  /* —— 行星盘镜面反射（真实光照，scene.js updatePlanetShine 逐帧解算）——
   * 金属面映出周围行星的真实镜像：CPU 侧按飞船位置挑出角半径最大的至多 3 个
   * 天体（行星/大卫星），着色端对每像素反射向量 reflect(−视线, 法线) 做角盘
   * 命中判定——命中即累加该天体的反照色 × 材质 F0。三项物理要点：
   *   1. 视角相关：vViewPosition 逐像素视线 + 视图空间盘心方向（scene.js 按
   *      相机四元数变换，同 uShineDir 惯例）→ 相机绕飞船移动时反射像实时
   *      滑过金属表面，与真实镜面行为一致；
   *   2. 辐亮度守恒：镜面里行星像的亮度 = 行星盘自身辐亮度，不随飞船-行星
     *    距离衰减（月球在镜中的像与抬头看一样亮）——亮度 = 反照色调 × 相位
   *      照度比 k × SUN_INTENSITY/π，全相反照光同理量级；
   *   3. F0 加权：× material.specularColor —— 白漆 F0≈0.04 反射自然微弱，
   *      金属件（金箔 F0 金色 / 铝件 F0 近白）映射行星色，金箔映地球呈暖绿、
   *      铝件映出真蓝色；漫反射/粗糙度不参与（盘像是纯镜面项）。
   * 角盘判定用 acos 与角半径直接比较，盘缘 15% 宽 smoothstep 软化抗锯齿；
   * uReflRad=0 槽位旁路（非真实光照模式 scene.js 全槽写 0）。uniform 按实体
   * 分套（'sc'/'probe'），分离后探测器由 scene.js 按自身位置独立解算并经
   * setProbeReflections 写入另一套（同 setProbeShine 惯例）。 */
  const REFL_SLOTS = 3;
  function mkReflUniforms() {
    return {
      dirs: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      cols: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      rads: { value: [0, 0, 0] },
    };
  }
  const reflSC = mkReflUniforms();
  const reflProbe = mkReflUniforms();

  function setReflUniforms(u, list) {
    for (let i = 0; i < REFL_SLOTS; i++) {
      const s = list && list[i];
      if (s) {
        u.dirs.value[i].copy(s.dir);
        u.cols.value[i].copy(s.col);
        u.rads.value[i] = s.rad;
      } else {
        u.rads.value[i] = 0;
      }
    }
  }

  function setReflections(list) { setReflUniforms(reflSC, list); }

  function setProbeReflections(list) { setReflUniforms(reflProbe, list); }

  /* —— 实时环境反射通道（真实光照，scene.js bakeLiveEnv 烘焙 CubeCamera 传入）——
   * 传入实时 cube RT 纹理（CubeReflectionMapping，needsPMREMUpdate 由
   * CubeCamera.update 自动置位，three 内部复用缓存 RT 重跑 PMREM）后，全部
   * 飞船材质 envMap 热切换到实时环境：金属映出带细节的真实画面（地球云形/
   * 大陆、土星环条纹），且粗糙度过滤物理正确。传 null 回退静态星空烘焙
   * （skyEnvTexture || envCubeTexture，原路径）。映射类型切换（equirect↔
   * cube）会变 programCacheKey 的 envMapMode 参数 → needsUpdate 重编译，
   * 仅发生在真实光照开关时刻（每次烘焙复用同一纹理对象，不重编译）。
   * 材质清单复用 eclipseSeen（enhanceMaterials 已收集全部飞船材质，含探测
   * 器克隆套）。 */
  let liveEnvTex = null;

  function applyEnvAll() {
    const fallback = skyEnvTexture() || envCubeTexture();
    const env = liveEnvTex || fallback;
    for (const mat of eclipseSeen) {
      mat.envMap = env;
      mat.needsUpdate = true;
    }
  }

  function setLiveEnv(tex) {
    if (liveEnvTex === tex) return;
    liveEnvTex = tex || null;
    applyEnvAll();
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

  /* Huygens 独立探测器：wrap → spin(自旋稳定) → asm(GLB 体轴映射 + 米→km)。
   * 只做纯旋转 + 均匀缩放，不引入任何平移/轴向预旋转，因此 wrap 原点严格落在
   * GLB 原点上——而 GLB 原点就是 huygens_probe 在组合体里的挂点（实测局部变换
   * 为单位阵）。于是：
   *   挂点坐标 = wrap 原点的父级位置，分离前按 Cassini 姿态摆位后与组合体
   *   （内部自带同一节点）逐点重合，分离后只需叠加真实相对漂移 relCass。
   * 自旋轴 = 探测器回转对称轴 = wrap-local +Y（由 GLB 顶点协方差实测：wrap 系
   * 包围盒 size=(2.615, 0.806, 2.615) m，X/Z 为 φ2.615 大底直径、Y 为轴向厚度
   * 0.806 m，σ_Y 最小且 X/Z 对称；见 tools/probe_huygens_axes.js）。**该轴并不
   * 过 wrap 原点**——wrap 原点即 GLB 挂点（探测器侧挂在母船边缘），实测偏离大底
   * 圆心 (x≈0, z≈−1.115 mm)，与探测器半径同量级（见 probeRevolutionAxis）。
   * 「body +Y 对准惯性系 RAM 方向」的姿态由 huygens.js 给出，7 rpm 自旋写在
   * spin 组的本地 Y 旋转上（huygens.js 先把旋转中心补偿到大底圆心、再补偿质心
   * 不动）。
   * 质心相对挂点的偏差记入 userData.centroid（asm 坐标系，km）：自旋须绕质心
   * 而非挂点，huygens.js 用它在自旋前把模型平移到质心、自旋后再移回。 */
  function wrapProbe(scene3) {
    const wrap = new THREE.Group();
    wrap.name = 'huygensProbe';
    const spin = new THREE.Group();       // 自旋稳定（约 7 rpm，绕大底轴，由 huygens.js 驱动）
    const asm = new THREE.Group();        // GLB 体轴映射 + 米→km（纯旋转，不含平移）
    asm.quaternion.copy(Q_GLB);
    asm.scale.setScalar(0.001);
    if (scene3) asm.add(scene3);
    spin.add(asm); wrap.add(spin);

    asm.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(asm);
    wrap.userData.centroid = box.getCenter(new THREE.Vector3());
    // —— 真实自旋轴 = 大底回转对称轴，未必过 wrap 原点（挂点）——
    // φ2.615 大底是一组圆盘。几何上「自旋」必须绕大底圆心那条轴转，否则会像偏心
    // 陀螺一样扭摆。实测：wrap 原点（= GLB 挂点，探测器侧挂在母船边缘）偏离大底
    // 圆心 (x≈0, z≈−1.115 mm)，与探测器半径同量级。这里用 Kasa 代数圆拟合把
    // XZ 平面上大底圆盘的圆心解出来，记入 spinAxisPt（wrap/挂点系，km）。
    // huygens.js 用它把自旋旋转中心平移到真实轴上（spin.position 补偿），
    // 再做质心不动补偿——两件事本质是同一个「旋转不动点」定位。
    wrap.userData.spinAxisPt = probeRevolutionAxis(asm, box);
    wrap.userData.spin = spin;            // 自旋组（huygens.js 绕真实轴 + 质心不动驱动）
    wrap.userData.span = 0.00262;         // φ2.7 m 防热大底
    return wrap;
  }

  /* 解算回转对称轴在 wrap 系中的「轴心」（仅 XZ 平面位置；轴方向 = wrap +Y）。
   * 方法：沿 wrap Y 把所有顶点分桶，取顶点最多的那一片（即大底圆盘所在片），
   * 对该片顶点做 Kasa 代数最小二乘圆拟合，圆心即轴心。返回 Vector3（y 置 0，
   * 表示轴心相对挂点的 XZ 偏移，km）。若无足够顶点则退回包围盒中心。 */
  function probeRevolutionAxis(asm, box) {
    const pts = [];
    asm.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes) return;
      const pa = o.geometry.attributes.position;
      if (!pa) return;
      for (let i = 0; i < pa.count; i++) {
        // 必须经 matrixWorld 变到 wrap 系（内含 Q_GLB 与 0.001），不能只乘 0.001
        pts.push(new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld));
      }
    });
    if (pts.length < 12) return new THREE.Vector3(0, 0, 0);
    // 沿 Y 分桶（片数 40），取顶点最多的一片
    const y0 = box.min.y, y1 = box.max.y, N = 40;
    const bins = Array.from({ length: N }, () => []);
    const span = y1 - y0 || 1;
    for (const p of pts) {
      let k = Math.floor((p.y - y0) / span * N);
      k = Math.max(0, Math.min(N - 1, k));
      bins[k].push(p);
    }
    let disk = null, best = 0;
    for (const b of bins) if (b.length > best) { best = b.length; disk = b; }
    if (!disk || disk.length < 6) return new THREE.Vector3(0, 0, 0);
    // Kasa 圆拟合（代数最小二乘，闭式解）
    let sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sxq = 0, szq = 0, sq = 0;
    const n = disk.length;
    for (const p of disk) {
      const x = p.x, z = p.z, q = x * x + z * z;
      sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z;
      sxq += x * q; szq += z * q; sq += q;
    }
    const a11 = sxx - sx * sx / n, a12 = sxz - sx * sz / n, a22 = szz - sz * sz / n;
    const b1 = (sxq - sx * sq / n) / 2, b2 = (szq - sz * sq / n) / 2;
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-18) return new THREE.Vector3(0, 0, 0);
    const cx = (b1 * a22 - a12 * b2) / det;
    const cz = (a11 * b2 - b1 * a12) / det;
    return new THREE.Vector3(cx, 0, cz);
  }

  let pending = null;

  function load(cb) {
    const data = window.CassiniGLBData;
    if (!data || !data.eyes || !THREE.GLTFLoader) { console.error('CassiniModel: data/models.js 或 GLTFLoader 未就绪'); return; }

    const L = window.CassiniLoader;   // 加载页进度（js/loader.js）：模型解析细条
    const done = (parts) => { if (cb) cb(parts); };

    if (pending) { pending.then(done); return; }

    const loader = new THREE.GLTFLoader();
    if (L) L.modelStep(0.08);

    pending = new Promise((resolve, reject) => {
      loader.parse(b64ToBuffer(data.eyes), '', (gltf) => resolve(gltf.scene), reject);
    }).then((src) => {
      if (L) L.modelStep(0.75);
      enhanceMaterials(src, 'sc');
      const stack = wrapModel(src, 0.0180, 'cassiniStack');   // 全长（磁强计双杆跨距 17.98 m）

      // 轨道器 = 组合体克隆摘除 huygens_probe 节点（材质与组合体共享，掩食同 tag 'sc'）
      const orbScene = src.clone(true);
      const attached = orbScene.getObjectByName(PROBE_NODE);
      if (attached && attached.parent) attached.parent.remove(attached);
      const orbiter = wrapModel(orbScene, 0.0180, 'cassiniOrbiter');

      // 独立探测器 = huygens_probe 子树克隆（结构与 stack 内的同一节点逐点重合）；
      // 材质独立实例（掩食 tag 'probe'），使分离后轨道器/探测器可分别进入行星本影
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
    }).then((parts) => {
      if (L) L.modelStep(1);   // 失败路径也放行，不阻塞加载页收尾
      return parts;
    });
    pending.then(done);
  }

  return { load, Q_GLB, setEclipse, setFillLight, setSunMode, setSunDirView, setShine, setProbeShine, setReflections, setProbeReflections, setLiveEnv, setEnvironment, setHdrUniforms };
})();
