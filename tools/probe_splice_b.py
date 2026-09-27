# -*- coding: utf-8 -*-
"""probe_splice_b.py — flyby→sun 边界的 B 侧混合探针：
窗口 (tb, tb+W)，P(t)=(1-h)·A_extrap(t)+h·B(t)，h=smoothstep。
A 段（真实飞掠弧）完全不动；度量拼接路径最大转角/最小速度。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, CASSINI_LEGS, LEG_CENTERS

J = 946728000


def composed(leg, t):
    c = LEG_CENTERS.get(leg)
    p = pos_at(leg, t)
    if c:
        cc = pos_at(c, t)
        return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
    return p


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def norm(a):
    return math.sqrt(sum(v * v for v in a))


legs = {}
for leg in CASSINI_LEGS:
    pts = load_points(leg)["points"]
    legs[leg] = (pts[0][0], pts[-1][0])


def probe_b(la, lb, tb, W_list, sample=240):
    print(f"\n== {la.split('/')[-2]}->{lb.split('/')[-2]}  tb={time.strftime('%Y-%m-%d %H:%M', time.gmtime(tb+J))}")
    for W in W_list:
        dt = W / sample
        pts = []
        for i in range(sample + 1):
            t = tb + i * dt
            h = (t - tb) / W
            h = h * h * (3 - 2 * h)
            A = composed(la, t)   # 飞掠根数向前外推
            B = composed(lb, t)
            pts.append((t,) + tuple(A[k] * (1 - h) + B[k] * h for k in range(3)))
        max_turn, min_sp, max_sp = 0.0, 1e18, 0.0
        for i in range(1, len(pts)):
            v = sub(pts[i][1:], pts[i - 1][1:])
            sp = norm(v) / dt
            min_sp = min(min_sp, sp)
            max_sp = max(max_sp, sp)
            if i >= 2:
                u = sub(pts[i - 1][1:], pts[i - 2][1:])
                nu, nv = norm(u), norm(v)
                if nu > 1 and nv > 1:
                    cosang = max(-1, min(1, sum(u[k] * v[k] for k in range(3)) / (nu * nv)))
                    max_turn = max(max_turn, math.degrees(math.acos(cosang)))
        print(f"   W={W/3600:8.1f} h: max_turn={max_turn:6.1f} deg  min_speed={min_sp:6.2f}  max_speed={max_sp:7.2f} km/s")


day = 86400.0
probe_b(CASSINI_LEGS[2], CASSINI_LEGS[3], legs[CASSINI_LEGS[3]][0],
        [12 * 3600, 24 * 3600, 48 * 3600, 96 * 3600, 240 * 3600])
probe_b(CASSINI_LEGS[4], CASSINI_LEGS[5], legs[CASSINI_LEGS[5]][0],
        [12 * 3600, 24 * 3600, 48 * 3600, 96 * 3600, 240 * 3600])
probe_b(CASSINI_LEGS[6], CASSINI_LEGS[7], legs[CASSINI_LEGS[7]][0],
        [12 * 3600, 24 * 3600, 48 * 3600, 96 * 3600, 240 * 3600, 480 * 3600])
