# -*- coding: utf-8 -*-
"""build_stars.py — d3-celestial 真实星表 → data/stars.js
坐标: ICRF 赤道 → 黄道（与历表数据同一旋转），单位球方向向量。
输出: xyz/mag/bv (真实恒星) + band (按真实银道几何生成的银河带弥散光点)。
银北极 (ICRF): RA 192.85948°, Dec +27.12825°; 银心: RA 266.405°, Dec -28.936°。
"""
import base64, json, math, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OBL = math.radians(23.4392911)
GPOLE_RA, GPOLE_DEC = 192.85948, 27.12825
GC_RA, GC_DEC = 266.405, -28.936

def eq_to_ecl_unit(x, y, z):
    ce, se = math.cos(OBL), math.sin(OBL)
    return (x, y * ce + z * se, -y * se + z * ce)

def sph(ra_deg, dec_deg):
    ra, dec = math.radians(ra_deg), math.radians(dec_deg)
    return (math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec))

def main():
    src = os.path.join(HERE, "..", "textures", "stars.6.json")
    with open(src, "r", encoding="utf-8") as f:
        data = json.load(f)
    xyz, mags, bvs = [], [], []
    for feat in data["features"]:
        try:
            ra, dec = feat["geometry"]["coordinates"]
            mag = float(feat["properties"].get("mag", 6.5))
            bv = feat["properties"].get("bv")
            bv = float(bv) if bv not in (None, "", " ") else 0.6
        except Exception:
            continue
        x, y, z = eq_to_ecl_unit(*sph(ra, dec))
        xyz.extend((x, y, z))
        mags.append(mag)
        bvs.append(max(-0.4, min(2.0, bv)))
    n = len(mags)

    # ---- 银河带：沿真实银道圈生成弥散光点 ----
    P = eq_to_ecl_unit(*sph(GPOLE_RA, GPOLE_DEC))          # 银北极（黄道系）
    C = eq_to_ecl_unit(*sph(GC_RA, GC_DEC))                # 银心方向
    B = (P[1] * C[2] - P[2] * C[1], P[2] * C[0] - P[0] * C[2], P[0] * C[1] - P[1] * C[0])
    bl = math.sqrt(B[0] ** 2 + B[1] ** 2 + B[2] ** 2)
    B = (B[0] / bl, B[1] / bl, B[2] / bl)
    rnd = 1234567
    def rand():
        nonlocal rnd
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        return rnd / 0x7FFFFFFF
    def gauss():
        return (rand() + rand() + rand() + rand() - 2) / 2
    band_xyz, band_b = [], []
    NB = 30000
    for i in range(NB):
        l = rand() * math.pi * 2
        w = 1.0 + 2.2 * math.exp(-(min(abs(l), 2 * math.pi - abs(l))) ** 2 / 0.9)
        if rand() > w / 3.2:
            continue
        lat = gauss() * math.radians(9.0) * (1.0 if rand() > 0.12 else 2.6)
        d = (C[0] * math.cos(l) + B[0] * math.sin(l),
             C[1] * math.cos(l) + B[1] * math.sin(l),
             C[2] * math.cos(l) + B[2] * math.sin(l))
        up = (P[0] * math.sin(lat), P[1] * math.sin(lat), P[2] * math.sin(lat))
        v = (d[0] * math.cos(lat) + up[0], d[1] * math.cos(lat) + up[1], d[2] * math.cos(lat) + up[2])
        band_xyz.extend(v)
        band_b.append(0.35 + rand() * 0.65)
    nb = len(band_b)

    out = {
        "n": n,
        "xyz": base64.b64encode(struct.pack(f"<{n*3}f", *xyz)).decode("ascii"),
        "mag": base64.b64encode(struct.pack(f"<{n}f", *mags)).decode("ascii"),
        "bv": base64.b64encode(struct.pack(f"<{n}f", *bvs)).decode("ascii"),
        "bandN": nb,
        "bandXyz": base64.b64encode(struct.pack(f"<{nb*3}f", *band_xyz)).decode("ascii"),
        "bandB": base64.b64encode(struct.pack(f"<{nb}f", *band_b)).decode("ascii"),
    }
    dst = os.path.join(HERE, "..", "data", "stars.js")
    with open(dst, "w", encoding="utf-8") as f:
        f.write("/* 真实亮星表 (d3-celestial/BSC, mag<6.5) + 真实银道几何银河带 — 黄道单位向量 */\n")
        f.write("window.STAR_CATALOG = ")
        f.write(json.dumps(out, separators=(",", ":")))
        f.write(";\n")
    print(f"stars: {n}, band: {nb} → {os.path.getsize(dst)/1024:.0f} KB")

if __name__ == "__main__":
    main()
