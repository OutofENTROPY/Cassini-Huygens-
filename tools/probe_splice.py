# -*- coding: utf-8 -*-
"""probe_splice.py — 数值试验：对每个腿边界尝试不同混合窗口，
度量拼接路径 P(t)=(1-h)A+hB 的最大转角/最小速度，选出无回折的最窄窗口。"""
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


def probe(la, lb, tb, W_list, tstar_search=(-1e18, 1e18), sample=200):
    print(f"\n== {la.split('/')[-2]}->{lb.split('/')[-2]}  tb={time.strftime('%Y-%m-%d %H:%M', time.gmtime(tb+J))}")
    # 找 |A-B| 最小点（若开启搜索）
    t_star, d_min = tb, None
    if tstar_search[1] > tstar_search[0]:
        n = 400
        for i in range(n + 1):
            t = tstar_search[0] + (tstar_search[1] - tstar_search[0]) * i / n
            d = norm(sub(composed(lb, t), composed(la, t)))
            if d_min is None or d < d_min:
                d_min, t_star = d, t
        print(f"   min |A-B| = {d_min:,.0f} km @ {time.strftime('%Y-%m-%d %H:%M', time.gmtime(t_star+J))} "
              f"({(t_star-tb)/86400:+.2f} d from tb)")
    for W in W_list:
        for label, t_end in (("end@tb", tb), ("end@t*", t_star)):
            t_s = t_end - W
            dt = W / sample
            pts = []
            for i in range(sample + 1):
                t = t_s + i * dt
                h = (t - t_s) / W
                h = h * h * (3 - 2 * h)
                A = composed(la, t)
                B = composed(lb, t)
                pts.append((t,) + tuple(A[k] * (1 - h) + B[k] * h for k in range(3)))
            max_turn, min_sp = 0.0, 1e18
            for i in range(1, len(pts)):
                v = sub(pts[i][1:], pts[i - 1][1:])
                sp = norm(v) / dt
                min_sp = min(min_sp, sp)
                if i >= 2:
                    u = sub(pts[i - 1][1:], pts[i - 2][1:])
                    nu, nv = norm(u), norm(v)
                    if nu > 1 and nv > 1:
                        cosang = max(-1, min(1, sum(u[k] * v[k] for k in range(3)) / (nu * nv)))
                        max_turn = max(max_turn, math.degrees(math.acos(cosang)))
            print(f"   W={W/3600:8.1f} h {label}: max_turn={max_turn:6.1f} deg  min_speed={min_sp:6.2f} km/s")


day = 86400.0
probe(CASSINI_LEGS[0], CASSINI_LEGS[1], legs[CASSINI_LEGS[1]][0],
      [12 * 3600, 24 * 3600, 36 * 3600, 48 * 3600, 60 * 3600, 66 * 3600])
probe(CASSINI_LEGS[1], CASSINI_LEGS[2], legs[CASSINI_LEGS[2]][0],
      [12 * 3600, 24 * 3600, 48 * 3600, 96 * 3600])
probe(CASSINI_LEGS[3], CASSINI_LEGS[4], legs[CASSINI_LEGS[4]][0],
      [12 * 3600, 24 * 3600, 48 * 3600, 96 * 3600])
probe(CASSINI_LEGS[5], CASSINI_LEGS[6], legs[CASSINI_LEGS[6]][0],
      [24 * 3600, 48 * 3600, 5 * day, 10 * day, 20 * day],
      tstar_search=(-20 * day, 2 * day))
probe(CASSINI_LEGS[6], CASSINI_LEGS[7], legs[CASSINI_LEGS[7]][0],
      [24 * 3600, 48 * 3600, 5 * day, 10 * day, 20 * day],
      tstar_search=(-20 * day, 2 * day))
probe(CASSINI_LEGS[7], CASSINI_LEGS[8], legs[CASSINI_LEGS[8]][0],
      [30 * day, 60 * day, 90 * day, 120 * day, 180 * day, 240 * day],
      tstar_search=(-240 * day, 30 * day), sample=240)
