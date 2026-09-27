# -*- coding: utf-8 -*-
"""diag_soi_jump.py — 定位 SOI 相对轨迹 / 引力弹弓段的"轨迹突变"来源。

直接解码 data/cassini_data.js（前端所见即所测），按前端 makeTrack/cassiniPosAt
语义重建行星位置与轨迹，检查:
  1) 窗口覆盖: Cassini 在 SOI_SHOW 显示半径内的时间区间 vs 烘焙窗口时间域
     → 窗口边缘"突然出现/消失"(突变) 的时间点与当时距离/不透明度 k
  2) 一致性: anchor(行星运行时位置)+rel 顶点 与 日心轨迹同时刻位置的偏差
     (f32 量化) → "交点≠实际位置" 的公里数
  3) 相对弧形态: 每窗口近掠距离、相邻段转角(拐点)、弦差(采样是否够密)
  4) 日心轨迹速度/方向突变: 转角>阈值 或 |Δv|/Δv 阶跃 的位置(飞掠段重点)
"""
import base64
import json
import math
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data", "cassini_data.js")
J2000_S = 946728000

SOI_SHOW = {"venus": 6.169e5, "earth": 9.247e5, "jupiter": 4.82e7, "saturn": 5.45e7}
SOI_REAL = SOI_SHOW


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000_S))


def b64f32(s):
    raw = base64.b64decode(s)
    n = len(raw) // 4
    return struct.unpack(f"<{n}f", raw[:n * 4])


def b64f64(s):
    raw = base64.b64decode(s)
    n = len(raw) // 8
    return struct.unpack(f"<{n}d", raw[:n * 8])


def load():
    with open(DATA, "r", encoding="utf-8") as f:
        txt = f.read()
    txt = txt[txt.index("=") + 1:].strip().rstrip(";")
    return json.loads(txt)


def main():
    d = load()
    bodies = d["bodies"]
    sc = d["spacecraft"]["cassini"]

    # ---- 前端语义: makeTrack = f32 网格线性插值 ----
    planet_track = {}
    for name in SOI_SHOW:
        seg = bodies[name]["segs"][0]
        xyz = b64f32(seg["d"])
        planet_track[name] = (seg["t0"], seg["dt"], seg["n"], xyz)

    def planet_at(name, t):
        t0, dt, n, xyz = planet_track[name]
        f = (t - t0) / dt
        f = 0.0 if f < 0 else (float(n - 1) if f > n - 1 else f)
        i = min(n - 2, int(f))
        a = f - i
        o, o2 = i * 3, (i + 1) * 3
        return (xyz[o] + (xyz[o2] - xyz[o]) * a,
                xyz[o + 1] + (xyz[o2 + 1] - xyz[o + 1]) * a,
                xyz[o + 2] + (xyz[o2 + 2] - xyz[o + 2]) * a)

    trailT = b64f64(sc["trailT"])
    trail = b64f32(sc["trail"])
    nT = sc["trailN"]

    def trail_at(t):
        lo, hi = 0, nT - 1
        if t <= trailT[0]:
            lo, hi = 0, 1
        elif t >= trailT[nT - 1]:
            lo, hi = nT - 2, nT - 1
        else:
            while hi - lo > 1:
                mid = (lo + hi) >> 1
                if trailT[mid] <= t:
                    lo = mid
                else:
                    hi = mid
        a = (t - trailT[lo]) / (trailT[hi] - trailT[lo] or 1)
        o, o2 = lo * 3, hi * 3
        return (trail[o] + (trail[o2] - trail[o]) * a,
                trail[o + 1] + (trail[o2 + 1] - trail[o + 1]) * a,
                trail[o + 2] + (trail[o2 + 2] - trail[o + 2]) * a)

    def d3(p, q):
        return math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2)

    # ---------- 1) 距离剖面: 在 showR / 真实 SOI 内的时间区间 vs 窗口覆盖 ----------
    print("=" * 96)
    print("1) 显示半径内时间区间 vs 烘焙窗口覆盖（前端 updateSoiTrails 语义）")
    print("=" * 96)
    for name in ("venus", "earth", "jupiter", "saturn"):
        wins = sc["soi"][name]
        spans = []
        for w in wins:
            t = b64f64(w["t"])
            spans.append((t[0], t[-1]))
        # 逐 trail 点算距离，标出 <showR 的区间
        inR = []
        cur = None
        for i in range(nT):
            t = trailT[i]
            c = (trail[i * 3], trail[i * 3 + 1], trail[i * 3 + 2])
            p = planet_at(name, t)
            dd = d3(c, p)
            if dd < SOI_SHOW[name]:
                if cur is None:
                    cur = [t, t, dd]
                else:
                    cur[1] = t
                    cur[2] = min(cur[2], dd)
            else:
                if cur is not None and cur[1] - cur[0] > 600:
                    inR.append(cur)
                cur = None
        if cur is not None and cur[1] - cur[0] > 600:
            inR.append(cur)
        print(f"\n[{name}] showR={SOI_SHOW[name]:.3e}  烘焙窗口: " +
              ", ".join(f"{iso(a)} .. {iso(b)}" for a, b in spans))
        for a, b, dmin in inR:
            # 该区间是否被任一窗口完整覆盖
            cov = any(wa <= a + 1 and b <= wb + 1 for wa, wb in spans)
            # 区间端点处的 k（前端: k=clamp((showR-d)/(0.65*showR)) 再 smoothstep）
            def kfun(tt):
                c = trail_at(tt)
                dd = d3(c, planet_at(name, tt))
                x = max(0.0, min(1.0, (SOI_SHOW[name] - dd) / (SOI_SHOW[name] * 0.65)))
                return x * x * (3 - 2 * x)
            ka, kb = kfun(a), kfun(b)
            inside = [(wa, wb) for wa, wb in spans if wb > a and wa < b]
            flag = "OK 完整覆盖" if cov else ("!! 部分覆盖 " + "; ".join(f"{iso(x)}..{iso(y)}" for x, y in inside) if inside else "!! 完全无窗口")
            print(f"   距离<{SOI_SHOW[name]:.1e}: {iso(a)} .. {iso(b)}  (min d={dmin:,.0f} km, k_end={ka:.2f}/{kb:.2f})  {flag}")

    # ---------- 2) 一致性: 锚定相对顶点 vs 日心轨迹 ----------
    print("\n" + "=" * 96)
    print("2) 交点一致性: anchor(运行时行星位置)+rel 顶点 vs 日心轨迹同点（f32 量化偏差）")
    print("=" * 96)
    for name in ("venus", "earth", "jupiter", "saturn"):
        worst = 0.0
        worst_t = None
        samples = 0
        for w in sc["soi"][name]:
            t = b64f64(w["t"])
            xyz = b64f32(w["d"])
            for i in range(0, w["n"], max(1, w["n"] // 400)):
                # 锚点 = makeTrack(行星) 在该时刻（与前端一致）
                c = planet_at(name, t[i])
                anchored = (c[0] + xyz[i * 3], c[1] + xyz[i * 3 + 1], c[2] + xyz[i * 3 + 2])
                tr = trail_at(t[i])
                dev = d3(anchored, tr)
                samples += 1
                if dev > worst:
                    worst, worst_t = dev, t[i]
        print(f"[{name}] 采样 {samples} 点: 最大偏差 {worst:,.1f} km @ {iso(worst_t) if worst_t else '-'}")

    # ---------- 3) 相对弧形态: 近掠距离 / 转角 / 弦差 ----------
    print("\n" + "=" * 96)
    print("3) 相对弧形态（近掠 / 拐点 / 弦差）")
    print("=" * 96)
    for name in ("venus", "earth", "jupiter", "saturn"):
        for wi, w in enumerate(sc["soi"][name]):
            t = b64f64(w["t"])
            xyz = b64f32(w["d"])
            n = w["n"]
            rmin, rmin_t = 1e18, None
            for i in range(n):
                r = math.sqrt(xyz[i * 3] ** 2 + xyz[i * 3 + 1] ** 2 + xyz[i * 3 + 2] ** 2)
                if r < rmin:
                    rmin, rmin_t = r, t[i]
            # 转角（跳过太短的段）与弦差
            max_turn, turn_t = 0.0, None
            max_chord, chord_t = 0.0, None
            for i in range(1, n - 1):
                a = (xyz[i * 3] - xyz[(i - 1) * 3], xyz[i * 3 + 1] - xyz[(i - 1) * 3 + 1],
                     xyz[i * 3 + 2] - xyz[(i - 1) * 3 + 2])
                b = (xyz[(i + 1) * 3] - xyz[i * 3], xyz[(i + 1) * 3 + 1] - xyz[i * 3 + 1],
                     xyz[(i + 1) * 3 + 2] - xyz[i * 3 + 2])
                la = math.sqrt(sum(v * v for v in a))
                lb = math.sqrt(sum(v * v for v in b))
                if la < 1 or lb < 1:
                    continue
                dot = sum(a[k] * b[k] for k in range(3)) / (la * lb)
                turn = math.degrees(math.acos(max(-1, min(1, dot))))
                if turn > max_turn:
                    max_turn, turn_t = turn, t[i]
                c = (xyz[(i + 1) * 3] - xyz[(i - 1) * 3], xyz[(i + 1) * 3 + 1] - xyz[(i - 1) * 3 + 1],
                     xyz[(i + 1) * 3 + 2] - xyz[(i - 1) * 3 + 2])
                lc = math.sqrt(sum(v * v for v in c))
                if lc > 1:
                    cr = (a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0])
                    dev = math.sqrt(sum(v * v for v in cr)) / lc
                    if dev > max_chord:
                        max_chord, chord_t = dev, t[i]
            print(f"[{name}#{wi}] {iso(t[0])} .. {iso(t[-1])}  n={n}  "
                  f"近掠 {rmin:,.0f} km @ {iso(rmin_t)}  最大转角 {max_turn:.1f}° @ {iso(turn_t)}  "
                  f"最大弦差 {max_chord:,.0f} km @ {iso(chord_t)}")

    # ---------- 4) 日心轨迹速度/方向突变 ----------
    print("\n" + "=" * 96)
    print("4) 日心轨迹速度剖面: 相邻点速度比 / 转角（飞掠 ±5 天）")
    print("=" * 96)
    flybys = [
        ("Venus-1", "1998-04-21", "1998-05-01"),
        ("Venus-2", "1999-06-19", "1999-06-29"),
        ("Earth", "1999-08-13", "1999-08-23"),
        ("Jupiter", "2000-12-10", "2001-01-15"),
        ("Saturn-SOI", "2004-06-25", "2004-07-06"),
    ]
    import calendar

    def et(s):
        y, m, dd = s.split("-")
        return calendar.timegm((int(y), int(m), int(dd), 0, 0, 0)) - J2000_S

    for tag, a, b in flybys:
        t0, t1 = et(a), et(b)
        print(f"\n  -- {tag} ({a} .. {b}) --")
        items = []
        for i in range(1, nT - 1):
            if not (t0 <= trailT[i] <= t1):
                continue
            dt1 = trailT[i] - trailT[i - 1]
            dt2 = trailT[i + 1] - trailT[i]
            if dt1 <= 0 or dt2 <= 0:
                continue
            p0 = (trail[(i - 1) * 3], trail[(i - 1) * 3 + 1], trail[(i - 1) * 3 + 2])
            p1 = (trail[i * 3], trail[i * 3 + 1], trail[i * 3 + 2])
            p2 = (trail[(i + 1) * 3], trail[(i + 1) * 3 + 1], trail[(i + 1) * 3 + 2])
            v1 = d3(p1, p0) / dt1
            v2 = d3(p2, p1) / dt2
            turn = 0.0
            if d3(p1, p0) > 1 and d3(p2, p1) > 1:
                dot = sum((p1[k] - p0[k]) * (p2[k] - p1[k]) for k in range(3)) / (d3(p1, p0) * d3(p2, p1))
                turn = math.degrees(math.acos(max(-1, min(1, dot))))
            items.append((turn, v1, v2, trailT[i], d3(p1, p0)))
        items.sort(key=lambda x: -x[0])
        for turn, v1, v2, t, chord in items[:8]:
            print(f"   转角 {turn:6.1f}°  v {v1:6.2f}→{v2:6.2f} km/s  @ {iso(t)}  步长 {chord:,.0f} km / dt")
        spd = sorted(items, key=lambda x: -(x[2] / max(x[1], 1e-9)))
        for turn, v1, v2, t, chord in spd[:4]:
            if abs(math.log(max(v2 / max(v1, 1e-9), 1e-9))) < 0.1:
                break
            print(f"   速度阶跃 {v1:6.2f}→{v2:6.2f} km/s (×{v2 / max(v1, 1e-9):.2f})  转角 {turn:.1f}°  @ {iso(t)}")


if __name__ == "__main__":
    main()
