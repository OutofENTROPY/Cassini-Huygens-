# -*- coding: utf-8 -*-
"""dbg_launch_detour.py — 发射腿本地坐标在尖峰时段的形状（30s 分辨率）"""
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake_data as B  # noqa

J = B.J2000_S


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t + J))


import calendar  # noqa

t0 = calendar.timegm((1997, 10, 16, 12, 0, 0)) - J
pts = []
for i in range(0, 121):
    t = t0 + i * 30.0
    p = B.pos_at("sc_cassini/earth/launch/orb", t)
    r = math.sqrt(sum(v * v for v in p))
    pts.append((t, p, r))

print("=== pos_at(launch) 本地坐标, 30s ===")
for i in range(1, len(pts) - 1):
    t, p, r = pts[i]
    a = tuple(p[k] - pts[i - 1][1][k] for k in range(3))
    b = tuple(pts[i + 1][1][k] - p[k] for k in range(3))
    la = math.sqrt(sum(v * v for v in a))
    lb = math.sqrt(sum(v * v for v in b))
    turn = 0.0
    if la > 0.1 and lb > 0.1:
        turn = math.degrees(math.acos(max(-1, min(1, sum(a[k] * b[k] for k in range(3)) / (la * lb)))))
    if turn > 5 or i % 4 == 0:
        print("%s r=%10.0f km  step30=%8.0f km turn=%6.1f" % (iso(t), r, la, turn))

# 相对弦差（300s 窗口内偏离弦的量）
print("\n=== 300s 弦差 ===")
for i in range(10, len(pts) - 10, 2):
    p = pts[i][1]
    A, C = pts[i - 10][1], pts[i + 10][1]
    a = tuple(p[k] - A[k] for k in range(3))
    c = tuple(C[k] - A[k] for k in range(3))
    lc = math.sqrt(sum(v * v for v in c))
    if lc > 1:
        cr = (a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0])
        dev = math.sqrt(sum(v * v for v in cr)) / lc
        if dev > 500:
            print("%s r=%10.0f  dev300s=%9.0f km" % (iso(pts[i][0]), pts[i][2], dev))
