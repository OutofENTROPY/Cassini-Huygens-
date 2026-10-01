/* textures.js — 程序化天体贴图（离线，无外部资源）
 * 生成 equirectangular Canvas 纹理，仿 NASA Eyes 贴图特征：
 * 木星/土星条纹与大红斑、地球海陆、火星锈红、月面环形山；
 * 土星卫星按真实特征绘制：Titan 甲烷雾 + Xanadu 亮区 + 赤道暗沙海、
 * Enceladus 冰壳虎纹、Iapetus 明暗二分 + 赤道山脊、Rhea/Dione/Tethys/Mimas
 * 冰质陨击面 + 亮射线坑。 */
(function () {
  'use strict';

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // 简易可复现伪随机
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // value noise（双线性插值 + fbm）
  function valueNoise(seed) {
    const rnd = mulberry32(seed);
    const size = 256;
    const grid = new Float32Array(size * size);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    function at(x, y) {
      const xi = ((x % size) + size) % size, yi = ((y % size) + size) % size;
      return grid[yi * size + xi];
    }
    return function noise(x, y) {
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const v00 = at(x0, y0), v10 = at(x0 + 1, y0), v01 = at(x0, y0 + 1), v11 = at(x0 + 1, y0 + 1);
      return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v11 - v01 - v10 + v00) * sx * sy;
    };
  }

  function fbm(noise, x, y, oct, lac, gain) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp; amp *= gain; freq *= lac;
    }
    return sum / norm;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mixRGB(c1, c2, t) {
    return [lerp(c1[0], c2[0], t) | 0, lerp(c1[1], c2[1], t) | 0, lerp(c1[2], c2[2], t) | 0];
  }

  /* 通用气态行星条纹贴图 */
  function bandsTexture(opt) {
    const w = 512, h = 256;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const noise = valueNoise(opt.seed || 1);
    const noise2 = valueNoise((opt.seed || 1) + 77);
    const stops = opt.stops; // [{p:0..1, c:'#hex'}, ...]
    function bandColor(v) { // v: 0..1（纬度）
      for (let i = 1; i < stops.length; i++) {
        if (v <= stops[i].p) {
          const a = stops[i - 1], b = stops[i];
          const t = (v - a.p) / Math.max(1e-6, b.p - a.p);
          return mixRGB(hexToRgb(a.c), hexToRgb(b.c), t);
        }
      }
      return hexToRgb(stops[stops.length - 1].c);
    }
    for (let y = 0; y < h; y++) {
      const lat = y / h;
      for (let x = 0; x < w; x++) {
        const lon = x / w;
        const turb = (fbm(noise, lon * 8, lat * 8, 4, 2, 0.5) - 0.5) * (opt.turb || 0.06);
        const fine = (fbm(noise2, lon * 24, lat * 40, 3, 2, 0.5) - 0.5) * (opt.fine || 0.04);
        let c = bandColor(Math.min(1, Math.max(0, lat + turb + fine)));
        const shade = 1 + (fbm(noise, lon * 4 + 9, lat * 4, 3, 2, 0.5) - 0.5) * (opt.shade || 0.08);
        c = [c[0] * shade, c[1] * shade, c[2] * shade];
        const o = (y * w + x) * 4;
        img.data[o] = Math.max(0, Math.min(255, c[0]));
        img.data[o + 1] = Math.max(0, Math.min(255, c[1]));
        img.data[o + 2] = Math.max(0, Math.min(255, c[2]));
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    if (opt.spot) {
      const sc = opt.spot;
      const cx = sc.x * w, cy = sc.y * h, rx = sc.rx * w, ry = sc.ry * h;
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
      grd.addColorStop(0, sc.inner);
      grd.addColorStop(0.55, sc.mid);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(1, ry / rx); ctx.translate(-cx, -cy);
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(cx, cy, rx, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    return canvas;
  }

  /* 岩石/冰质天体贴图（域扭曲 fbm + 软缘陨石坑 + 亮射线坑） */
  function rockyTexture(opt) {
    const w = opt.w || 640, h = opt.h || 320;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const noise = valueNoise(opt.seed || 2);
    const noise2 = valueNoise((opt.seed || 2) + 401);
    const base = hexToRgb(opt.base);
    const dark = hexToRgb(opt.dark);
    const light = hexToRgb(opt.light);
    const contrast = opt.contrast || 1.0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x / w * 10, ny = y / h * 10;
        // 域扭曲：低频噪声扭曲采样坐标，制造真实的地貌团块
        const wx = (fbm(noise2, nx * 0.5 + 7.3, ny * 0.5, 3, 2, 0.5) - 0.5) * 1.4;
        const wy = (fbm(noise2, nx * 0.5, ny * 0.5 + 3.1, 3, 2, 0.5) - 0.5) * 1.4;
        const n = fbm(noise, nx + wx, ny + wy, 5, 2.15, 0.55);
        let t = Math.min(1, Math.max(0, (n - 0.5) * contrast + 0.5));
        let c = mixRGB(dark, base, t);
        c = mixRGB(c, light, Math.max(0, t - 0.68) * 1.8);
        const o = (y * w + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 陨石坑：暗底 + 亮缘 + 可选亮射线
    if (opt.craters) {
      const rnd = mulberry32((opt.seed || 2) * 31 + 7);
      const nC = opt.craters;
      for (let i = 0; i < nC; i++) {
        const cx = rnd() * w, cy = h * 0.06 + rnd() * h * 0.88;
        const r = 2 + Math.pow(rnd(), 2.2) * (opt.craterMax || 16);
        // 暗底
        let g = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
        g.addColorStop(0, 'rgba(0,0,0,' + (0.16 + rnd() * 0.12).toFixed(3) + ')');
        g.addColorStop(0.75, 'rgba(0,0,0,' + (0.06 + rnd() * 0.06).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        // 亮缘（太阳角下的环形山边缘）
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.10 + rnd() * 0.10).toFixed(3) + ')';
        ctx.lineWidth = Math.max(0.6, r * 0.12);
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.92, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        // 亮射线（大坑才有，冰质卫星显著）
        if (r > (opt.craterMax || 16) * 0.45 && opt.rays && rnd() < 0.5) {
          const nRay = 3 + (rnd() * 4) | 0;
          for (let k = 0; k < nRay; k++) {
            const a = rnd() * Math.PI * 2;
            const len = r * (2.5 + rnd() * 4);
            ctx.strokeStyle = 'rgba(255,255,255,' + (0.05 + rnd() * 0.07).toFixed(3) + ')';
            ctx.lineWidth = Math.max(0.5, r * 0.08);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
            ctx.stroke();
          }
        }
      }
    }
    // 极冠
    if (opt.polarCaps) {
      const g1 = ctx.createLinearGradient(0, 0, 0, h * 0.12);
      g1.addColorStop(0, 'rgba(255,255,255,0.85)');
      g1.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g1; ctx.fillRect(0, 0, w, h * 0.12);
      const g2 = ctx.createLinearGradient(0, h, 0, h * 0.88);
      g2.addColorStop(0, 'rgba(255,255,255,0.85)');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g2; ctx.fillRect(0, h * 0.88, w, h * 0.12);
    }
    return canvas;
  }

  /* 地球：海洋+大陆（真实 2k 昼图已内嵌，此处仅作兜底） */
  function earthTexture() {
    const w = 512, h = 256;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const noise = valueNoise(42);
    const deep = [12, 38, 92], sea = [24, 68, 132], shore = [46, 110, 150];
    const land = [64, 112, 58], land2 = [128, 122, 72], peak = [188, 182, 160];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x / w * 6, ny = y / h * 6;
        const wx = fbm(noise, nx + 13.7, ny + 7.1, 4, 2, 0.5);
        const n = fbm(noise, nx + (wx - 0.5) * 2.2, ny + (wx - 0.5) * 2.2, 6, 2, 0.52);
        let c;
        if (n < 0.47) c = mixRGB(deep, sea, n / 0.47);
        else if (n < 0.505) c = shore;
        else {
          const t = (n - 0.505) / 0.495;
          c = mixRGB(land, land2, Math.min(1, t * 1.4));
          if (t > 0.75) c = mixRGB(c, peak, (t - 0.75) / 0.25);
        }
        const o = (y * w + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const g1 = ctx.createLinearGradient(0, 0, 0, h * 0.09);
    g1.addColorStop(0, 'rgba(240,248,255,0.95)'); g1.addColorStop(1, 'rgba(240,248,255,0)');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, w, h * 0.09);
    const g2 = ctx.createLinearGradient(0, h, 0, h * 0.91);
    g2.addColorStop(0, 'rgba(240,248,255,0.95)'); g2.addColorStop(1, 'rgba(240,248,255,0)');
    ctx.fillStyle = g2; ctx.fillRect(0, h * 0.91, w, h * 0.09);
    return canvas;
  }

  /* 地球云层：多尺度气旋感（1024×512） */
  function earthClouds() {
    const w = 1024, h = 512;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const noise = valueNoise(1337);
    const noise2 = valueNoise(9241);
    for (let y = 0; y < h; y++) {
      const lat = y / h;
      // 纬向风带：赤道信风带/中纬西风带云量更高
      const zonal = 0.55 + 0.45 * Math.cos(lat * Math.PI * 5.2) * Math.exp(-Math.pow((lat - 0.5) * 3.6, 2));
      for (let x = 0; x < w; x++) {
        const lon = x / w;
        const wx = (fbm(noise2, lon * 6 + 3.7, lat * 6, 3, 2, 0.5) - 0.5) * 1.8;
        const n = fbm(noise, lon * 9 + wx, lat * 9 + wx * 0.6, 5, 2.3, 0.55);
        let a = Math.max(0, (n - 0.52) / 0.48);
        a = Math.min(1, a * (0.5 + zonal) * 1.35);
        const o = (y * w + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
        img.data[o + 3] = Math.min(255, a * 430);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* Titan：浓密橙色雾霾 + Xanadu 亮区 + 赤道暗沙海 */
  function titanTexture() {
    const w = 640, h = 320;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const noise = valueNoise(911);
    const base = [200, 152, 82], bright = [226, 186, 118], dark = [128, 92, 48];
    for (let y = 0; y < h; y++) {
      const lat = y / h;
      for (let x = 0; x < w; x++) {
        const lon = x / w;
        const n = fbm(noise, lon * 7, lat * 7, 5, 2.1, 0.55);
        // Xanadu：赤道附近 x≈0.2..0.45 的大亮区
        const dxl = (lon - 0.32) * 2.6, dyl = (lat - 0.5) * 3.2;
        const xan = Math.exp(-(dxl * dxl + dyl * dyl)) * 0.55;
        // 赤道暗沙海（低纬度条带）
        const dune = Math.exp(-Math.pow((lat - 0.5) * 7.5, 2)) * 0.30 * (0.5 + 0.5 * Math.sin(lon * 40 + n * 5));
        let v = 0.5 + (n - 0.5) * 0.7 + xan - dune;
        v = Math.max(0, Math.min(1, v));
        let c = mixRGB(dark, base, v);
        c = mixRGB(c, bright, Math.max(0, v - 0.72) * 1.5);
        const o = (y * w + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* 土星环径向贴图（u = 半径方向） */
  function ringTexture() {
    const w = 1024, h = 8;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const noise = valueNoise(555);
    // 归一化半径 0..1 对应 74,500 km(内) → 140,220 km(外)
    function bandTone(r) {
      const km = 74500 + r * (140220 - 74500);
      let tone = 0, alpha = 1;
      if (km < 92000) { tone = 0.28 + 0.10 * Math.sin(km / 900); alpha = 0.55; }
      else if (km < 117680) { tone = 0.85 + 0.10 * Math.sin(km / 1400); alpha = 0.97; }
      else if (km < 122170) { tone = 0.12; alpha = 0.35; } // 卡西尼缝
      else if (km < 133589) { tone = 0.66 + 0.09 * Math.sin(km / 1500); alpha = 0.92; }
      else if (km < 133900) { tone = 0.10; alpha = 0.30; } // 恩克缝
      else if (km < 136780) { tone = 0.60 + 0.08 * Math.sin(km / 1300); alpha = 0.88; }
      else if (km < 139900) { tone = 0.05; alpha = 0.12; }
      else { tone = 0.5; alpha = 0.5; } // F 环
      return [tone, alpha];
    }
    for (let x = 0; x < w; x++) {
      let [tone, alpha] = bandTone(x / w);
      const fine = fbm(noise, x / w * 160, 0.5, 3, 2, 0.5);
      tone = Math.max(0, Math.min(1, tone + (fine - 0.5) * 0.22));
      alpha = Math.max(0, Math.min(1, alpha + (fine - 0.5) * 0.10));
      const v = (tone * 255) | 0;
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        img.data[o] = Math.min(255, v + 26); img.data[o + 1] = (v * 0.97 + 20) | 0;
        img.data[o + 2] = (v * 0.86 + 12) | 0; img.data[o + 3] = (alpha * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* NASA Eyes 风格太阳：高饱和亮黄盘面 + 细腻米粒组织 + 大尺度亮斑，
   * 无黑子、无临边昏暗（参考真实 SDO/AIA 着色风格）。
   * 极区附近噪声衰减，避免 equirect 极点拉伸条纹。 */
  function sunTexture() {
    const w = 1024, h = 512;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const gran = valueNoise(99);    // 米粒组织
    const soft = valueNoise(177);   // 大尺度亮斑/活动区
    for (let y = 0; y < h; y++) {
      const v = y / h;
      const pole = Math.min(1, (1 - Math.abs(v * 2 - 1)) / 0.22);  // 两极 → 0
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const g = fbm(gran, u * 40, v * 40, 4, 2.3, 0.52);
        const s = fbm(soft, u * 6, v * 6, 3, 2.0, 0.55);
        const t = 0.90 + ((g - 0.5) * 0.16 + (s - 0.5) * 0.10) * pole;
        const o = (y * w + x) * 4;
        img.data[o]     = Math.min(255, 248 * t + 14);
        img.data[o + 1] = Math.min(255, 250 * t + 8);
        img.data[o + 2] = Math.min(255, 64 * t + 4);
        img.data[o + 3] = 255;
      }
    }
    // 横向接缝混合：噪声不循环，右缘 SW 列向左缘对应列渐变，
    // 使 col(w-1) ≈ col(0)，消除 u=0/1 竖缝（直接读 img 内存，无需画布往返）
    const SW = 24;
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < SW; i++) {
        const t = 1 - (i + 1) / SW;           // col(w-1):≈1（几乎取左缘色）→ col(w-SW):0
        const o = (y * w + (w - 1 - i)) * 4;
        const e = (y * w + i) * 4;
        img.data[o]     = img.data[o]     * (1 - t) + img.data[e]     * t;
        img.data[o + 1] = img.data[o + 1] * (1 - t) + img.data[e + 1] * t;
        img.data[o + 2] = img.data[o + 2] * (1 - t) + img.data[e + 2] * t;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* —— 气态行星环纹理（item 4）：u = 归一化半径，alpha/亮度按真实光深 —— */

  /* 木星环（92000–226000 km）：halo（向内衰减）+ 主环（122500–129000，最亮、
   * 外缘锐利）+ gossamer 双瓣（Amalthea 182000 / Thebe 226000 外缘）。
   * 真实木星环为暗红尘埃环、正照相几乎不可见 → alpha 峰值仅 ~0.28 */
  function jupiterRingTexture() {
    const w = 1024, h = 8;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const noise = valueNoise(333);
    const km0 = 92000, km1 = 226000;
    for (let x = 0; x < w; x++) {
      const km = km0 + (x / w) * (km1 - km0);
      let tone = 0, alpha = 0;
      if (km < 122500) {            // halo
        const t = (km - km0) / (122500 - km0);
        tone = 0.30; alpha = 0.015 + 0.065 * t * t;
      } else if (km < 129000) {     // main ring：内缘渐入、外缘锐利
        const t = (km - 122500) / 6500;
        tone = 0.38 + 0.20 * t;
        alpha = 0.28 * Math.min(1, t * 6) * (0.72 + 0.28 * t);
      } else {                      // gossamer：Amalthea 瓣 → Thebe 瓣（更弱）
        const g = Math.max(0, 1 - (km - 129000) / 97000);
        tone = 0.26;
        alpha = 0.045 * g * g * (km < 182000 ? 1 : 0.55);
      }
      const fine = fbm(noise, x / w * 90, 0.5, 3, 2, 0.5);
      alpha = Math.max(0, Math.min(1, alpha * (0.8 + 0.4 * fine)));
      const r = (tone * 232) | 0, g2 = (tone * 196) | 0, b = (tone * 158) | 0;
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        img.data[o] = r; img.data[o + 1] = g2; img.data[o + 2] = b; img.data[o + 3] = (alpha * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* 天王星环（37500–52500 km）：炭黑窄环（真实反照率 ~0.03）。
   * 窄环真实宽度 10–100 km 不可见，取 ~130–280 km 夸张以供辨认；
   * ε 环最宽最亮，λ 极暗。alpha 按真实相对亮度。 */
  function uranusRingTexture() {
    const w = 1024, h = 8;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const km0 = 37500, km1 = 52500;
    // [中心 km, 半宽 km, alpha]
    const BANDS = [
      [39500, 1550, 0.05],   // ζ / 1986U2R 宽弱尘环
      [41837, 65, 0.38], [42234, 65, 0.38], [42571, 65, 0.38],   // 6 / 5 / 4
      [44718, 90, 0.42], [45661, 90, 0.42],                      // α / β
      [47176, 75, 0.30], [47627, 65, 0.36], [48300, 75, 0.36],   // η / γ / δ
      [50024, 60, 0.14],                                         // λ（极暗）
      [51149, 140, 0.55],                                        // ε（最宽最亮）
    ];
    for (let x = 0; x < w; x++) {
      const km = km0 + (x / w) * (km1 - km0);
      let alpha = 0;
      for (const [c, hw, a] of BANDS) {
        const d = (km - c) / hw;
        if (d > -2.2 && d < 2.2) alpha += a * Math.exp(-0.5 * d * d);
      }
      alpha = Math.min(1, alpha);
      const v = 58;   // 炭黑（真实天王星环接近黑色）
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        img.data[o] = v; img.data[o + 1] = v - 2; img.data[o + 2] = v - 4; img.data[o + 3] = (alpha * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* 海王星环（40000–64000 km）：Galle 宽弱环 + Le Verrier + Lassell 高原 +
   * Arago + Adams（62930 km，含 5 条真实亮弧 Courage/Liberté/Égalité×2/Fraternité）。
   * v = 方位角（u = 半径），弧段按真实相对亮度。整体极淡（真实反照率 ~0.05）。 */
  function neptuneRingTexture() {
    const w = 1024, h = 256;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const km0 = 40000, km1 = 64000;
    const ADAMS = 62930, ADAMS_HW = 150;
    // Adams 亮弧 [方位角°, 半宽°, alpha]
    const ARCS = [
      [8, 1.5, 0.40], [44, 2.5, 0.45], [62, 1.8, 0.45], [69, 1.8, 0.45], [80, 3.5, 0.50],
    ];
    function baseProfile(km) {
      let alpha = 0, tone = 0.30;
      if (km > 40900 && km < 42900) {          // Galle：宽而弱
        const t = (km - 40900) / 2000;
        alpha += 0.05 * Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);
      }
      { const d = (km - 53200) / 110;          // Le Verrier 窄环
        if (d > -2.2 && d < 2.2) alpha += 0.22 * Math.exp(-0.5 * d * d); }
      if (km > 53200 && km < 57200) alpha += 0.028;   // Lassell 高原
      { const d = (km - 57200) / 90;           // Arago（极弱）
        if (d > -2.2 && d < 2.2) alpha += 0.05 * Math.exp(-0.5 * d * d); }
      { const d = (km - ADAMS) / ADAMS_HW;     // Adams：弥散基底环
        if (d > -2.5 && d < 2.5) { alpha += 0.10 * Math.exp(-0.5 * d * d); tone = 0.34; } }
      return [alpha, tone];
    }
    for (let x = 0; x < w; x++) {
      const km = km0 + (x / w) * (km1 - km0);
      const [bAlpha, tone] = baseProfile(km);
      const dAdams = (km - ADAMS) / ADAMS_HW;
      for (let y = 0; y < h; y++) {
        const deg = (y / h) * 360;
        let alpha = bAlpha;
        if (Math.abs(dAdams) < 1.4) {          // 弧段只出现在 Adams 环半径附近
          const radial = Math.exp(-0.5 * dAdams * dAdams);
          for (const [c, hwA, a] of ARCS) {
            let dd = deg - c; if (dd > 180) dd -= 360; if (dd < -180) dd += 360;
            dd /= hwA;
            if (dd > -2.5 && dd < 2.5) alpha += a * radial * Math.exp(-0.5 * dd * dd);
          }
        }
        alpha = Math.min(1, alpha);
        const o = (y * w + x) * 4;
        img.data[o] = (tone * 128) | 0; img.data[o + 1] = (tone * 108) | 0; img.data[o + 2] = (tone * 98) | 0;
        img.data[o + 3] = (alpha * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function canvasToTexture(THREE, canvas, opts) {
    const tex = new THREE.CanvasTexture(canvas);
    if (opts && opts.anisotropy) tex.anisotropy = opts.anisotropy;
    tex.wrapS = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  const BUILDERS = {
    sun: () => sunTexture(),
    mercury: () => rockyTexture({ seed: 11, base: '#9c9088', dark: '#5c5650', light: '#c8c2ba', craters: 160, rays: false }),
    venus: () => bandsTexture({
      seed: 21, turb: 0.10, fine: 0.05,
      stops: [{ p: 0, c: '#c8a86a' }, { p: 0.3, c: '#e0c288' }, { p: 0.5, c: '#d8b878' }, { p: 0.7, c: '#e8cc96' }, { p: 1, c: '#c8a86a' }]
    }),
    earth: () => earthTexture(),
    moon: () => rockyTexture({ seed: 31, base: '#a8a49e', dark: '#6c6a66', light: '#d4d2ce', craters: 260, craterMax: 20 }),
    mars: () => rockyTexture({ seed: 41, base: '#b56a45', dark: '#7a3f28', light: '#d8a074', craters: 110, polarCaps: true }),
    jupiter: () => bandsTexture({
      seed: 51, turb: 0.05, fine: 0.05, shade: 0.10,
      stops: [
        { p: 0, c: '#c2b298' }, { p: 0.12, c: '#a69074' }, { p: 0.22, c: '#d8c8ac' }, { p: 0.32, c: '#b89a76' },
        { p: 0.42, c: '#e2d2b4' }, { p: 0.5, c: '#c8a888' }, { p: 0.58, c: '#e6d8bc' }, { p: 0.68, c: '#b09470' },
        { p: 0.8, c: '#d2c2a4' }, { p: 0.92, c: '#b8a488' }, { p: 1, c: '#c2b298' }
      ],
      spot: { x: 0.68, y: 0.62, rx: 0.055, ry: 0.035, inner: 'rgba(196,110,74,0.95)', mid: 'rgba(178,96,66,0.6)' }
    }),
    saturn: () => bandsTexture({
      seed: 61, turb: 0.035, fine: 0.04, shade: 0.06,
      stops: [
        { p: 0, c: '#c8b488' }, { p: 0.15, c: '#d4c090' }, { p: 0.3, c: '#e2d0a2' }, { p: 0.45, c: '#d8c494' },
        { p: 0.6, c: '#e6d4a8' }, { p: 0.75, c: '#d2be8e' }, { p: 0.9, c: '#c4b084' }, { p: 1, c: '#c8b488' }
      ]
    }),
    uranus: () => bandsTexture({
      seed: 71, turb: 0.02, fine: 0.02,
      stops: [{ p: 0, c: '#8fd0dc' }, { p: 0.4, c: '#a8dde6' }, { p: 0.6, c: '#98d6e0' }, { p: 1, c: '#8fd0dc' }]
    }),
    neptune: () => bandsTexture({
      seed: 81, turb: 0.04, fine: 0.03,
      stops: [{ p: 0, c: '#3454b8' }, { p: 0.35, c: '#4468cc' }, { p: 0.55, c: '#3a5cc0' }, { p: 0.75, c: '#4a6ed0' }, { p: 1, c: '#3454b8' }]
    }),
    titan: () => titanTexture(),
    enceladus: () => {
      // 高反照率冰壳 + 南极"虎纹"平行裂缝（蓝绿色）
      const c = rockyTexture({ seed: 101, base: '#f2f5f8', dark: '#d4dee6', light: '#ffffff', craters: 30, craterMax: 9, rays: true });
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      for (let i = 0; i < 4; i++) {
        const y = h * (0.88 + i * 0.026);
        ctx.strokeStyle = 'rgba(110,165,200,' + (0.50 - i * 0.07) + ')';
        ctx.lineWidth = 3.5 - i * 0.5;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 16) {
          ctx.lineTo(x, y + Math.sin(x * 0.05 + i * 2) * 5);
        }
        ctx.stroke();
      }
      return c;
    },
    iapetus: () => {
      // 明暗二分（前导半球碳黑 / 后随半球冰白）+ 赤道山脊
      const c = makeCanvas(640, 320);
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      const bright = rockyTexture({ seed: 111, base: '#d8d2c4', dark: '#a8a294', light: '#f2efe6', craters: 120, rays: false });
      const dark = rockyTexture({ seed: 112, base: '#3a3026', dark: '#181410', light: '#5a4c3c', craters: 90, rays: false });
      ctx.drawImage(bright, 0, 0, w, h);
      const grd = ctx.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0.0, 'rgba(0,0,0,0)');
      grd.addColorStop(0.10, 'rgba(8,6,4,0.94)');
      grd.addColorStop(0.35, 'rgba(8,6,4,0.94)');
      grd.addColorStop(0.50, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(220,210,190,0.4)';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 16) ctx.lineTo(x, h * 0.5 + Math.sin(x * 0.09) * 3);
      ctx.stroke();
      return c;
    },
    rhea: () => rockyTexture({ seed: 121, base: '#c6c2bc', dark: '#8c8a82', light: '#eae8e4', craters: 190, rays: true }),
    dione: () => {
      // 冰质灰面 + 后随半球 wispy 亮纹峡谷
      const c = rockyTexture({ seed: 131, base: '#cac6c0', dark: '#94928c', light: '#eeece8', craters: 160, rays: true });
      const ctx = c.getContext('2d');
      const w = c.width;
      for (let i = 0; i < 16; i++) {
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.12 + (i % 3) * 0.06) + ')';
        ctx.lineWidth = 1 + (i % 2);
        const y0 = 40 + i * 16;
        ctx.beginPath();
        ctx.moveTo(w * 0.55, y0);
        for (let x = 0.55; x < 1.0; x += 0.03) {
          ctx.lineTo(x * w, y0 + Math.sin(x * 40 + i) * 7);
        }
        ctx.stroke();
      }
      return c;
    },
    tethys: () => {
      // 亮冰面 + Ithaca Chasma 峡谷（南北向长槽）
      const c = rockyTexture({ seed: 141, base: '#d0ccc6', dark: '#98968f', light: '#f0eeea', craters: 150, rays: true });
      const ctx = c.getContext('2d');
      ctx.strokeStyle = 'rgba(70,70,75,0.35)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let y = 0; y <= c.height; y += 12) {
        const x = c.width * (0.32 + Math.sin(y * 0.02) * 0.03);
        y === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      return c;
    },
    mimas: () => {
      // 灰色重陨击面 + Herschel 巨坑（直径 130 km）
      const c = rockyTexture({ seed: 151, base: '#b8b4ae', dark: '#828078', light: '#e0deda', craters: 200, rays: true });
      const ctx = c.getContext('2d');
      const cx = c.width * 0.3, cy = c.height * 0.45, r = 30;
      const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      g.addColorStop(0, 'rgba(40,40,44,0.55)');
      g.addColorStop(0.75, 'rgba(90,90,96,0.4)');
      g.addColorStop(1, 'rgba(255,255,255,0.15)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(230,228,222,0.5)';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2); ctx.fill();
      return c;
    },
    clouds: () => earthClouds(),
    ring: () => ringTexture(),
    ringJupiter: () => jupiterRingTexture(),
    ringUranus: () => uranusRingTexture(),
    ringNeptune: () => neptuneRingTexture()
  };

  const cache = new Map();

  window.ProcTextures = {
    get(THREE, name, opts) {
      if (cache.has(name)) return canvasToTexture(THREE, cache.get(name), opts);
      const b = BUILDERS[name];
      if (!b) return null;
      const canvas = b();
      cache.set(name, canvas);
      return canvasToTexture(THREE, canvas, opts);
    },
    _builders: BUILDERS
  };
})();
