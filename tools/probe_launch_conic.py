# -*- coding: utf-8 -*-
"""probe_launch_conic.py — 用 sun/1 腿起点（=launch 腿终点）的真实地球系状态向量
构造逃逸双曲线（离心率向量法），核对 launch 腿的 rp/t_peri/e 是否为真实任务值。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_data as B
from bake_data import load_points, pos_at, J2000_S

J = B.J2000_S


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t + J))


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def n3(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def cross3(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def ang(a, b):
    d = sum(a[k] * b[k] for k in range(3)) / (n3(a) * n3(b))
    return math.degrees(math.acos(max(-1.0, min(1.0, d))))


MU = B.def_mu("sc_cassini/earth/launch/orb")
print(f"MU(earth, from launch def) = {MU:,.3f} km^3/s^2")

s1 = load_points("sc_cassini/sun/1/orb")["points"]
tb = s1[0][0]
print(f"sun/1 starts {iso(tb)}")

# 真实地球系状态（sun/1 为日心腿，减去地球）
p_h = pos_at("sc_cassini/sun/1/orb", tb)
pe = pos_at("earth/sun/orb", tb)
r = sub(p_h, pe)
dt = 600.0
v_h = tuple((pos_at("sc_cassini/sun/1/orb", tb + dt)[k] - pos_at("sc_cassini/sun/1/orb", tb - dt)[k]) / (2 * dt) for k in range(3))
ve = tuple((pos_at("earth/sun/orb", tb + dt)[k] - pos_at("earth/sun/orb", tb - dt)[k]) / (2 * dt) for k in range(3))
v = sub(v_h, ve)
rr, vv = n3(r), n3(v)
print(f"r_rel = {rr:,.1f} km   v_rel = {vv:.4f} km/s")

# 单状态向量 → 圆锥曲线
h = cross3(r, v)
hh = tuple(x / n3(h) for x in h)
evec = tuple((cross3(v, h)[k] / MU - r[k] / rr) for k in range(3))
e = n3(evec)
A = n3(h) ** 2 / MU / (e * e - 1.0)     # r = A(e coshH - 1)
rp = A * (e - 1.0)
vinf = math.sqrt(max(0.0, vv * vv - 2 * MU / rr))
print(f"由状态向量反解: e={e:.5f}  A={A:,.1f} km  rp={rp:,.1f} km  v_inf={vinf:.4f} km/s (C3={vinf*vinf:.2f})")
print(f"真实发射 C3 ≈ 16.60 km^2/s^2")

# 近拱点时刻（双曲线开普勒，pioneer 约定 M = e sinhH - H）
coshH = (rr / A + 1.0) / e
H = math.acosh(coshH)
M = e * math.sinh(H) - H
nn = math.sqrt(MU / A ** 3)
t_peri = tb - M / nn
print(f"t_peri = {iso(t_peri)}   (M={M:.4f} rad, n={nn:.3e} rad/s)")

# 与 launch 腿根数对比
pts = load_points("sc_cassini/earth/launch/orb")["points"]
for p in pts[:2]:
    print(f"  launch kf t={iso(p[0])} a={p[1]:,.1f} e={p[2]:.5f} M0={p[4]:+.3f}")
kf0 = pts[0]
# 手动: n = sqrt(mu/a^3)
n_leg = math.sqrt(MU / abs(kf0[1]) ** 3)
print(f"launch 腿: t_peri(首帧 M0/n) = {iso(kf0[0] - kf0[4] / n_leg)}, e={kf0[2]:.5f}, a={kf0[1]:,.1f}")
print(f"  → rp(腿) = {abs(kf0[1]) * (kf0[2] - 1.0):,.1f} km")

# 近拱点方向 P 与重构位置核对
P = tuple(x / e for x in evec)
Q = cross3(hh, P)
print(f"\nP(近拱点方向) 与 r 方向夹角 @tb = {ang(P, r):.2f}° (应接近 ν∞≈{math.degrees(2*math.acos(-1/e)):.1f}°)")
