# -*- coding: utf-8 -*-
"""xcheck_soi_anchor.py — 烘焙数据自身一致性检查（只读）：
  1) SOI 锚定：anchor(行星线性插值位置) + rel ≡ 日心 trail 顶点（"交点 = 实际位置"）
  2) 窗口边界：每个 SOI 窗口首/尾点的 |rel| 应 ≈ 对应行星 SOI 半径
     （进入显示 / 脱离自动隐藏的窗口覆盖性）
"""
import base64
import json
import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
J2000_UNIX = 946728000
SOI_RADII = {"venus": 6.169e5, "earth": 9.247e5, "jupiter": 4.82e7, "saturn": 5.45e7}


def utc_label(t_et):
    return __import__("time").strftime("%Y-%m-%d %H:%M", __import__("time").gmtime(t_et + J2000_UNIX))


def main():
    raw = open(os.path.join(HERE, "..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
    js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
    sc = js["spacecraft"]["cassini"]

    # 卫星细网格在 moons_data.js（运行时 Catmull-Rom 插值）——并入 bodies
    moons_path = os.path.join(HERE, "..", "data", "moons_data.js")
    if os.path.exists(moons_path):
        mraw = open(moons_path, "r", encoding="utf-8").read()
        mjs = json.loads(mraw[mraw.index("=") + 1:].rstrip().rstrip(";"))
        for name, bd in mjs["bodies"].items():
            js["bodies"].setdefault(name, bd)

    # trail
    trailN = sc["trailN"]
    trailT = struct.unpack(f"<{trailN}d", base64.b64decode(sc["trailT"]))
    trail = struct.unpack(f"<{trailN*3}f", base64.b64decode(sc["trail"]))

    def trail_at(t):
        lo, hi = 0, trailN - 1
        if t <= trailT[0]:
            lo, hi = 0, 1
        elif t >= trailT[-1]:
            lo, hi = trailN - 2, trailN - 1
        else:
            while hi - lo > 1:
                mid = (lo + hi) >> 1
                if trailT[mid] <= t:
                    lo = mid
                else:
                    hi = mid
        a = (t - trailT[lo]) / (trailT[hi] - trailT[lo] or 1)
        return [trail[lo*3+k] + (trail[hi*3+k] - trail[lo*3+k]) * a for k in range(3)]

    # body tracks（与 scene.js makeTrack 同样插值：行星线性，卫星 interp='cr' 走 Catmull-Rom）
    tracks = {}
    for name, bd in js["bodies"].items():
        segs = []
        for s in bd["segs"]:
            if "t0" not in s:
                continue
            segs.append((s["t0"], s["dt"], s["n"],
                         struct.unpack(f"<{s['n']*3}f", base64.b64decode(s["d"])),
                         bd.get("interp")))
        segs.sort(key=lambda x: -x[1])
        tracks[name] = segs

    def body_at(name, t):
        for (t0, dt, n, xyz, interp) in tracks[name]:
            f = (t - t0) / dt
            if 0 <= f <= n - 1:
                i = min(n - 2, int(math.floor(f)))
                if interp == "cr":
                    # 与 scene.js makeTrack(CR) / 烘焙端 moon_cr 逐位一致
                    s = f - i
                    i0 = i - 1 if i > 0 else 0
                    i3 = i + 2 if i + 2 <= n - 1 else n - 1
                    out = []
                    for k in range(3):
                        a0, a1, a2, a3 = xyz[i0*3+k], xyz[i*3+k], xyz[(i+1)*3+k], xyz[i3*3+k]
                        out.append(0.5 * ((2.0 * a1) + (a2 - a0) * s
                                          + (2.0 * a0 - 5.0 * a1 + 4.0 * a2 - a3) * s * s
                                          + (3.0 * a1 - a0 - 3.0 * a2 + a3) * s * s * s))
                    return out
                a = f - i
                return [xyz[i*3+k] + (xyz[(i+1)*3+k] - xyz[i*3+k]) * a for k in range(3)]
        return None

    print("== SOI 锚定一致性（anchor + rel vs trail, km）==")
    for name, wins in sc["soi"].items():
        r_soi = SOI_RADII.get(name, 0)
        # 卫星二级 SOI：前端锚定在母星世界位置 + 卫星本地位置，校验同式
        parent = js["bodies"].get(name, {}).get("parent")
        worst = 0.0
        worst_t = 0.0
        n_sum = 0
        for wi, w in enumerate(wins):
            n = w["n"]
            tt = struct.unpack(f"<{n}d", base64.b64decode(w["t"]))
            dd = struct.unpack(f"<{n*3}f", base64.b64decode(w["d"]))
            step = max(1, n // 4000)  # 最多抽 ~4000 点
            for i in range(0, n, step):
                t = tt[i]
                rel = (dd[i*3], dd[i*3+1], dd[i*3+2])
                p = body_at(name, t)
                if p is None:
                    continue
                if parent:
                    pp = body_at(parent, t)
                    if pp is None:
                        continue
                    p = [p[k] + pp[k] for k in range(3)]
                anchor = (p[0] + rel[0], p[1] + rel[1], p[2] + rel[2])
                tr = trail_at(t)
                d = math.sqrt(sum((anchor[k] - tr[k]) ** 2 for k in range(3)))
                if d > worst:
                    worst, worst_t = d, t
                n_sum += 1
        # 窗口边界 |rel|
        edges = []
        for wi, w in enumerate(wins):
            n = w["n"]
            tt = struct.unpack(f"<{n}d", base64.b64decode(w["t"]))
            dd = struct.unpack(f"<{n*3}f", base64.b64decode(w["d"]))
            for idx, tag in ((0, "in"), (n - 1, "out")):
                r = math.sqrt(dd[idx*3]**2 + dd[idx*3+1]**2 + dd[idx*3+2]**2)
                edges.append(f"win{wi}{tag}={r:,.0f}km@{utc_label(tt[idx])}")
        print(f"  {name:7s} 窗口数={len(wins)} 检查点={n_sum}  最大偏差={worst:8.3f} km"
              f" @ {utc_label(worst_t)}   SOI半径={r_soi:,.0f} km")
        for e in edges:
            print(f"      {e}")

    print("\n== trail 覆盖范围 ==")
    print(f"  trail: {utc_label(trailT[0])} .. {utc_label(trailT[-1])}  ({trailN} pts)")


if __name__ == "__main__":
    main()
