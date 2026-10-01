# -*- coding: utf-8 -*-
"""check_huygens_entry_dir.py — 检验 Huygens Titan 进入双曲线（sc_huygens/titan/orb
最接近进入界面的根数关键帧外推）是否与巡航段（sc_huygens/saturn/orb 相对 Titan）
的接近方向一致，或同样被镜像。
判据：进入界面前 ~1h，两条轨迹的位置/速度方向夹角应小（<10°）。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_data as B
from bake_data import load_points, pos_at, orb_pos

J2000_S = B.J2000_S


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000_S


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t + J2000_S))


def sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def norm(v):
    return math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2])


def dot(a, b):
    return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def ang(a, b):
    d = dot(a, b)/(norm(a)*norm(b))
    return math.degrees(math.acos(max(-1.0, min(1.0, d))))


ENTRY = et(2005, 1, 14, 9, 6)

huy_kfs = load_points("sc_huygens/titan/orb")["points"]
kf = min(huy_kfs, key=lambda p: abs(p[0] - (ENTRY - 600.0)))
t_peri = kf[0] - kf[4] / kf[3]
print(f"titan entry leg: {len(huy_kfs)} kfs, chosen kf t={iso(kf[0])} M0={kf[4]:+.3f}")
print(f"  conic t_peri={iso(t_peri)}  rp={norm(orb_pos(kf, t_peri)):,.0f} km")
for p in huy_kfs:
    print(f"    kf t={iso(p[0])} a={p[1]:,.1f} e={p[2]:.3f} M0={p[4]:+.2f}")

# 巡航段相对 Titan 的状态（土星中心系相减）
def coast_rel(t):
    return sub(pos_at("sc_huygens/saturn/orb", t), pos_at("titan/saturn/orb", t))


def entry_rel(t):
    return orb_pos(kf, t)


print("\n  t            |coast_rel|   |entry_rel|   pos_ang   vel_ang   |v_coast| |v_entry|")
for dt in (-7200, -5400, -3600, -1800, -600, 0, 600, 1800, 3600):
    t = ENTRY + dt
    rc, re = coast_rel(t), entry_rel(t)
    vc = sub(coast_rel(t + 30), coast_rel(t - 30))
    ve = sub(entry_rel(t + 30), entry_rel(t - 30))
    vc = tuple(v / 60 for v in vc)
    ve = tuple(v / 60 for v in ve)
    print(f"  {iso(t)}  {norm(rc):9,.0f}  {norm(re):9,.0f}  {ang(rc, re):7.2f}°  {ang(vc, ve):7.2f}°  "
          f"{norm(vc):7.3f}  {norm(ve):7.3f}")

# h 方向对比（进入界面附近）
t = ENTRY - 600
h_coast = cross(coast_rel(t), sub(coast_rel(t + 60), coast_rel(t - 60)))
h_entry = cross(entry_rel(t), sub(entry_rel(t + 60), entry_rel(t - 60)))
print(f"\n  ★ angle(h_coast, h_entry) = {ang(h_coast, h_entry):.1f}°  (≈0 一致 / ≈180 镜像)")
