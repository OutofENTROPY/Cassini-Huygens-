# -*- coding: utf-8 -*-
"""check_launch_mirror.py — 检验发射逃逸腿（sc_cassini/earth/launch/orb，地球中心双曲线）
是否与飞掠腿同源镜像：其行星系速度方向 vs 真实日心腿 sun/1 推出的行星系速度方向。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_data as B
from bake_data import load_points, pos_at, orb_pos, conic_peri_kf

J = B.J2000_S


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J))


def sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def n3(v):
    return math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2])


def ang(a, b):
    d = sum(a[k]*b[k] for k in range(3))/(n3(a)*n3(b))
    return math.degrees(math.acos(max(-1.0, min(1.0, d))))


def vel(leg, t, dt=600.0):
    p0, p1 = pos_at(leg, t-dt), pos_at(leg, t+dt)
    return tuple((p1[k]-p0[k])/(2*dt) for k in range(3))


pts = load_points("sc_cassini/earth/launch/orb")["points"]
print(f"launch leg: {len(pts)} kfs, {iso(pts[0][0])} .. {iso(pts[-1][0])}")
for p in pts[:6]:
    print(f"  kf t={iso(p[0])} a={p[1]:,.1f} e={p[2]:.4f} M0={p[4]:+.3f}")
kf = min(pts, key=lambda p: abs(p[4]))
t_peri = kf[0] - kf[4]/kf[3]
print(f"  perigee: {iso(t_peri)}  rp={n3(orb_pos(kf, t_peri)):,.0f} km")

s1 = load_points("sc_cassini/sun/1/orb")["points"]
print(f"sun/1 leg: {len(s1)} kfs, {iso(s1[0][0])} .. {iso(s1[-1][0])}")

print(f"\n{'t':17s} {'|r| launch(km)':>14s} {'|r| sun1(km)':>14s} {'夹角 v_rel':>10s}  {'|v|launch':>9s} {'|v|sun1':>8s}")
for hh in range(0, 96, 6):
    t = et(1997, 10, 15, 9) + hh * 3600.0
    pl = pos_at("sc_cassini/earth/launch/orb", t)
    ps = pos_at("sc_cassini/sun/1/orb", t)
    pe = pos_at("earth/sun/orb", t)
    rl = pl                      # launch 腿为地球中心，位置即地球系相对位置
    rs = sub(ps, pe)
    vl = vel("sc_cassini/earth/launch/orb", t)   # 已是地球系速度，不再减地球
    vs = sub(vel("sc_cassini/sun/1/orb", t), vel("earth/sun/orb", t))
    print(f"{iso(t):17s} {n3(rl):14,.0f} {n3(rs):14,.0f} {ang(vl, vs):10.2f}  {n3(vl):9.3f} {n3(vs):8.3f}")
