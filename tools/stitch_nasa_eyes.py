# -*- coding: utf-8 -*-
"""stitch_nasa_eyes.py — NASA Eyes on the Solar System 立方面贴图 → 等距圆柱投影。
stitch_nasa_eyes_earth.py 的通用版：任意天体、任意 LOD 面尺寸。

来源（公域，eyes.nasa.gov 官方资源）：
  https://eyes.nasa.gov/assets/static/maps/{body}/{kind}_{size}_{face}.{png|jpg}

映射关系逆向自 eyes.nasa.gov app.js（v70.1.0，SpheroidLODComponent）：
  - 面 frame = defaultCubeMapFaceFrames：[right, up, forward]（单位轴）
      face0: +X 面 (lon 0°)   right=+Y up=+Z
      face1: +Y 面 (lon 90°E) right=-X up=+Z
      face2: -X 面 (lon 180°) right=-Y up=+Z
      face3: -Y 面 (lon 90°W) right=+X up=+Z
      face4: +Z 北极面        right=+Y up=-X
      face5: -Z 南极面        right=+Y up=+X
  - gnomonic：dir(u,v) = normalize(forward + right*(2u-1) + up*(2v-1))，
    面归属按 xyzToUVFace 的顺序逐面测试 |主轴| 最大者（先到先得）
  - 经纬度约定 lon=atan2(y,x)、lat=asin(z/r)（X=本初子午线，Y=90°E，Z=北）
  - 贴图以 THREE flipY=true 语义加载 → 图像顶行对应 -up 方向
      （即赤道面图像南北倒置存储；重投影时 image row = (1-v)*S）

用法：
  python stitch_nasa_eyes.py <tiles_dir> <kind> <tilesize> <W> <H> <out>
  例：python stitch_nasa_eyes.py tiles/mercury color 4096 4096 2048 nasa_mercury_4k.jpg
tiles_dir 内需有 {kind}_{tilesize}_{0..5}.{png|jpg}（png 优先尝试，其次 jpg）。
kind=cloud 输出白色 RGB + alpha 云量密度；其余输出 RGB。
"""
import os
import sys
import numpy as np
from PIL import Image

X = np.array([1.0, 0, 0]); Y = np.array([0, 1.0, 0]); Z = np.array([0, 0, 1.0])
FRAMES = [(Y, Z, X), (-X, Z, Y), (-Y, Z, -X), (X, Z, -Y), (Y, -X, Z), (Y, X, -Z)]
TESTS = [(0, 1, 2, False), (1, 2, 0, False), (0, 1, 2, True), (1, 2, 0, True), (2, 0, 1, False), (2, 0, 1, True)]

def bilinear(img, xf, yf):
    S = img.shape[0]
    x0 = np.floor(xf).astype(np.int32); y0 = np.floor(yf).astype(np.int32)
    fx = np.clip(xf - x0, 0, 1)[..., None]; fy = np.clip(yf - y0, 0, 1)[..., None]
    x0c = np.clip(x0, 0, S - 1); x1c = np.clip(x0 + 1, 0, S - 1)
    y0c = np.clip(y0, 0, S - 1); y1c = np.clip(y0 + 1, 0, S - 1)
    top = img[y0c, x0c].astype(np.float32) * (1 - fx) + img[y0c, x1c].astype(np.float32) * fx
    bot = img[y1c, x0c].astype(np.float32) * (1 - fx) + img[y1c, x1c].astype(np.float32) * fx
    return top * (1 - fy) + bot * fy

def reproject(faces, W, H, band=256, ss=2):
    S = faces[0].shape[0]
    out = np.zeros((H, W, faces[0].shape[2]), np.float32)
    offs = [(o / ss, p / ss) for o in range(ss) for p in range(ss)]
    for r0 in range(0, H, band):
        r1 = min(r0 + band, H)
        acc = np.zeros((r1 - r0, W, out.shape[2]), np.float32)
        rows = np.arange(r0, r1)
        for ox, oy in offs:
            lon = ((np.arange(W) + 0.5 + ox) / W) * 2 * np.pi - np.pi
            lat = np.pi / 2 - ((rows + 0.5 + oy) / H) * np.pi
            lg = np.broadcast_to(lon, (r1 - r0, W))
            ag = np.broadcast_to(lat[:, None], (r1 - r0, W))
            d = np.stack([np.cos(ag) * np.cos(lg), np.cos(ag) * np.sin(lg), np.sin(ag)], -1)
            assigned = np.zeros((r1 - r0, W), bool)
            for fi in range(6):
                la, ca, ha, neg = TESTS[fi]
                l, c, h = d[..., la], d[..., ca], d[..., ha]
                m = (~assigned) & (np.abs(l) >= np.abs(c)) & (np.abs(l) >= np.abs(h)) & ((l >= 0) != neg)
                if not m.any():
                    continue
                assigned |= m
                r, u, f = FRAMES[fi]
                df = d[m]
                o_ = df @ f
                ut = (df @ r / o_ + 1) / 2
                vt = (df @ u / o_ + 1) / 2
                xf = np.clip(ut * S - 0.5, 0, S - 1e-6)
                yf = np.clip((1 - vt) * S - 0.5, 0, S - 1e-6)
                acc[m] += bilinear(faces[fi], xf, yf)
        out[r0:r1] = acc / (ss * ss)
        print(f"  rows {r0}-{r1}", flush=True)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)

def load_faces(tiles, kind, size, mode):
    faces = []
    for i in range(6):
        for ext in ("png", "jpg"):
            p = os.path.join(tiles, f"{kind}_{size}_{i}.{ext}")
            if os.path.exists(p):
                img = Image.open(p)
                img = img.convert("RGBA") if (mode == "cloud" or img.mode not in ("RGB", "L")) else img
                faces.append(np.asarray(img, np.uint8))
                break
        else:
            raise SystemExit(f"missing tile: {kind}_{size}_{i}.(png|jpg) in {tiles}")
    if mode == "cloud":
        # 归一为白色 RGB + alpha 云量密度（与本项目 2k_earth_clouds.png 格式一致）
        faces = [np.dstack([np.full(f.shape[:2], 255, np.uint8)] * 3 + [f[..., 3]]) for f in faces]
    else:
        faces = [f[..., :3] if f.ndim == 3 and f.shape[2] == 4 else f for f in faces]
    return faces

def main():
    tiles, kind, size, W, H, dst = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
    faces = load_faces(tiles, kind, size, kind)
    S = faces[0].shape[0]
    print(f"faces: {kind} {S}x{S} x6 → {W}x{H}")
    out = reproject(faces, W, H)
    if dst.lower().endswith((".jpg", ".jpeg")):
        Image.fromarray(out[..., :3], "RGB").save(dst, quality=95)
    else:
        Image.fromarray(out, "RGBA" if out.shape[2] == 4 else "RGB").save(dst)
    print("saved", dst)

if __name__ == "__main__":
    main()
