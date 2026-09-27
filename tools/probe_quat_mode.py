# -*- coding: utf-8 -*-
"""probe_quat_mode.py — 穷举四元数顺序/旋转方向，找出使地球轨道回到黄道面的组合。"""
import math, os, sys, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, orb_pos, solve_e, J2000_S

pts = load_points("earth/sun/orb")["points"]

def quat_rot(qx, qy, qz, qw, vx, vy, vz):
    tx = 2 * (qy * vz - qz * vy)
    ty = 2 * (qz * vx - qx * vz)
    tz = 2 * (qx * vy - qy * vx)
    return [vx + qw * tx + (qy * tz - qz * ty),
            vy + qw * ty + (qz * tx - qx * tz),
            vz + qw * tz + (qx * ty - qy * tx)]

def project(p, t, order, passive):
    _, a, e, n, M0, q1, q2, q3, q4 = p
    if order == "xyzw":
        qx, qy, qz, qw = q1, q2, q3, q4
    else:
        qw, qx, qy, qz = q1, q2, q3, q4
    M = M0 + n * (t - p[0])
    E = solve_e(M, e)
    b = a * math.sqrt(max(0.0, 1 - e * e))
    px, py = a * (math.cos(E) - e), b * math.sin(E)
    if passive:
        # v' = q* v q
        qx, qy, qz, qw = -qx, -qy, -qz, qw
    return quat_rot(qx, qy, qz, qw, px, py, 0)

# 检查 2000-01-01 12:00 ET 附近地球位置: 黄经应 ~100°, z≈0
t0 = calendar.timegm((2000, 1, 1, 12, 0, 0)) - J2000_S
# 采样 1997-2004 每 60 天: 统计 max |z|/|r|
samples = [t0 + i * 86400 * 60 for i in range(50)]
for order in ("xyzw", "wxyz"):
    for passive in (False, True):
        maxzr = 0
        lons = []
        for t in samples:
            best = None
            for p in pts:  # 找包含 t 的相邻点对
                pass
            # 用最近历元点的元素直接投影
            p = min(pts, key=lambda q: abs(q[0] - t))
            v = project(p, t, order, passive)
            r = math.sqrt(sum(x * x for x in v))
            maxzr = max(maxzr, abs(v[2]) / r)
            lons.append(math.degrees(math.atan2(v[1], v[0])))
        v0 = project(min(pts, key=lambda q: abs(q[0] - t0)), t0, order, passive)
        lon0 = math.degrees(math.atan2(v0[1], v0[0])) % 360
        print(f"order={order} passive={passive}: max|z|/r={maxzr:.4f}  lon(2000-01-01)={lon0:7.2f}°  lon range=[{min(lons):.0f},{max(lons):.0f}]")
