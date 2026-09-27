# -*- coding: utf-8 -*-
"""diag_legs.py — 检查各腿源文件时间域 / SOI 边界处两腿分歧 / 发射段脱离 SOI 时刻"""
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake_data as B  # noqa

J2000_S = B.J2000_S


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000_S))


def main():
    print("=== 腿文件时间域 ===")
    for leg, center, t0, t1 in B.cassini_legs():
        pts = B.load_points(leg)["points"]
        print(f"{leg:36s} {iso(t0)} .. {iso(t1)}  ({(t1-t0)/86400:.2f} d, {len(pts)} keyframes, center={center})")

    print("\n=== SOI 边界处: 巡航腿复合 vs 飞掠腿复合 的分歧 ===")
    legs = {leg: (t0, t1) for leg, _, t0, t1 in B.cassini_legs()}

    def composed(leg, t):
        center = B.LEG_CENTERS.get(leg)
        p = B.pos_at(leg, t)
        if center:
            c = B.pos_at(center, t)
            return (p[0] + c[0], p[1] + c[1], p[2] + c[2])
        return p

    cases = [
        ("V1", "sc_cassini/sun/1/orb", "sc_cassini/venus/flyby1/orb", "venus/sun/orb", 6.2e5),
        ("V2", "sc_cassini/sun/3/orb", "sc_cassini/venus/flyby2/orb", "venus/sun/orb", 6.2e5),
        ("Earth", "sc_cassini/sun/3/orb", "sc_cassini/earth/flyby/orb", "earth/sun/orb", 9.25e5),
    ]
    for tag, cruise, fly, center, soi_r in cases:
        t0, t1 = legs[fly]
        # 巡航腿在飞掠腿时间域内与飞掠腿的分歧随时间变化
        print(f"\n[{tag}] flyby 腿域 {iso(t0)}..{iso(t1)} (SOI r={soi_r:.2e})")
        n = 12
        for i in range(n + 1):
            t = t0 + (t1 - t0) * i / n
            A = composed(cruise, t)
            Bc = composed(fly, t)
            div = math.sqrt(sum((A[k] - Bc[k]) ** 2 for k in range(3)))
            dr = math.sqrt(sum(v * v for v in Bc))  # 飞掠腿相对行星距离
            print(f"   {iso(t)}  |cruise-fly|={div:>12,.0f} km   flyby 行星距={dr:>12,.0f} km")

    print("\n=== 发射段: 相对地球距离 / 腿末时刻 ===")
    lt0, lt1 = legs["sc_cassini/earth/launch/orb"]
    t = lt0
    prev = None
    while t <= lt1 + 4 * 86400:
        p = B.pos_at("sc_cassini/earth/launch/orb", t)
        r = math.sqrt(sum(v * v for v in p))
        mark = ""
        if prev is not None and prev < 9.25e5 <= r:
            mark = "  <-- 越过 9.25e5 (地球 SOI)"
        if abs(t - lt0) < 60 or abs(t - lt1) < 60 or mark or int(t) % 86400 < 7200:
            print(f"   {iso(t)}  r_earth={r:>13,.0f} km{mark}")
        prev = r
        t += 3600
    print(f"   launch 腿结束: {iso(lt1)}")


if __name__ == "__main__":
    main()
