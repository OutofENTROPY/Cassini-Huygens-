# -*- coding: utf-8 -*-
"""check_flyby_mirror.py — 检验飞掠重构的双曲线是否与真实任务几何一致（未镜像）。

物理判据：真实飞掠前后，探测器相对行星的速度方向从 v_in 连续转动到 v_out
（转动轴 = 轨道面法向 h = r×v）。用巡航腿（sun/N，远离行星处真实）在 SOI
边界处的日心速度求出真实的 v_in / v_out（行星系），与烘焙双曲线在入臂/出臂
SOI 穿越时刻的速度逐一对比：
  - 入臂夹角应 ≈ 0°（双曲线与巡航入射弧相切衔接）
  - 出臂夹角应 ≈ 0°
  - h_conic 与 v_in × v_out 的夹角 ≈ 0°（同向）而非 180°（镜像）
另打印 dynamo 飞掠腿自身关键帧在近拱点前后 ±SOI 穿越时刻的位置速度，
判断"出射臂为镜像假数据"波及哪一侧。
"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_data as B
from bake_data import load_points, pos_at, orb_pos, conic_peri_kf, conic_r, conic_cross

J2000_S = B.J2000_S


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000_S


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000_S))


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def norm(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(v):
    n = norm(v) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def ang_deg(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, dot(unit(a), unit(b))))))


def helio_vel(leg, t, dt=3600.0):
    """巡航腿日心速度（数值微分；leg 为日心根数腿）"""
    p0 = pos_at(leg, t - dt)
    p1 = pos_at(leg, t + dt)
    return tuple((p1[k] - p0[k]) / (2 * dt) for k in range(3))


def planet_vel(name, t, dt=600.0):
    p0 = pos_at(name + "/sun/orb", t - dt)
    p1 = pos_at(name + "/sun/orb", t + dt)
    return tuple((p1[k] - p0[k]) / (2 * dt) for k in range(3))


def cruise_helio_vel(cruise_a, cruise_b, t_peri, t, dt=3600.0):
    leg = cruise_a if t <= t_peri else cruise_b
    return helio_vel(leg, t, dt)


def conic_state(kf, t, dt=60.0):
    """行星中心双曲线在 t 的位置/速度（数值微分）"""
    p0 = orb_pos(kf, t - dt)
    p1 = orb_pos(kf, t + dt)
    v = tuple((p1[k] - p0[k]) / (2 * dt) for k in range(3))
    return orb_pos(kf, t), v


SOI = {"venus": 6.169e5, "earth": 9.247e5, "jupiter": 4.82e7}
MU = {"venus": 324858.592, "earth": 398600.435436, "jupiter": 1.26686534e8}  # km^3/s^2

FLYBYS = [
    ("Venus-1", "sc_cassini/venus/flyby1/orb", "sc_cassini/sun/1/orb", "sc_cassini/sun/2/orb",
     "venus", et(1998, 3, 1), et(1998, 6, 1)),
    ("Venus-2", "sc_cassini/venus/flyby2/orb", "sc_cassini/sun/2/orb", "sc_cassini/sun/3/orb",
     "venus", et(1999, 5, 1), et(1999, 8, 1)),
    ("Earth", "sc_cassini/earth/flyby/orb", "sc_cassini/sun/3/orb", "sc_cassini/sun/4/orb",
     "earth", et(1999, 7, 15), et(1999, 10, 1)),
]

for label, leg, cruise_a, cruise_b, planet, t_lo, t_hi in FLYBYS:
    print("=" * 100)
    r_soi = SOI[planet]
    mu = MU[planet]
    pts = load_points(leg)["points"]
    print(f"[{label}] flyby leg keyframes: n={len(pts)}, span "
          f"{iso(pts[0][0])} .. {iso(pts[-1][0])} ({(pts[-1][0]-pts[0][0])/3600:.1f} h)")
    for p in pts:
        print(f"   kf t={iso(p[0])}  a={p[1]:,.1f} e={p[2]:.4f} n={p[3]:.6f} M0={p[4]:+.4f} rad")

    kf = conic_peri_kf(leg)
    t_peri = kf[0] - kf[4] / kf[3]
    rp = conic_r(kf, t_peri)
    print(f"  conic peri keyframe: t_kf={iso(kf[0])} M0={kf[4]:+.5f} -> t_peri={iso(t_peri)}  rp={rp:,.0f} km")
    tin = conic_cross(kf, t_peri, r_soi, False)
    tout = conic_cross(kf, t_peri, r_soi, True)
    print(f"  conic SOI crossings: in={iso(tin)} out={iso(tout)}")

    # 双曲线在入/出 SOI 穿越时刻的行星中心速度
    r_c_in, v_c_in = conic_state(kf, tin)
    r_c_out, v_c_out = conic_state(kf, tout)
    h_conic = cross(r_c_in, v_c_in)
    print(f"  conic @in : |r|={norm(r_c_in):,.0f} |v|={norm(v_c_in):.3f} km/s")
    print(f"  conic @out: |r|={norm(r_c_out):,.0f} |v|={norm(v_c_out):.3f} km/s")

    # 真实入射速度：巡航腿 A 在 tin 的日心速度 − 行星速度（行星系 v_in）
    # 注：巡航腿 A 在行星近旁为两体外推，取 SOI 边界处（外推漂移最小）
    v_sc_in = cruise_helio_vel(cruise_a, cruise_b, t_peri, tin)
    vp_in = planet_vel(planet, tin)
    v_in = sub(v_sc_in, vp_in)
    r_sc_in = sub(pos_at(cruise_a, tin), pos_at(planet + "/sun/orb", tin))
    # 真实出射速度：巡航腿 B 在 tout
    v_sc_out = cruise_helio_vel(cruise_a, cruise_b, t_peri, tout)
    vp_out = planet_vel(planet, tout)
    v_out = sub(v_sc_out, vp_out)
    r_sc_out = sub(pos_at(cruise_b, tout), pos_at(planet + "/sun/orb", tout))
    print(f"  cruise @in : |v_rel|={norm(v_in):.3f} km/s  |r_rel|={norm(r_sc_in):,.0f} km")
    print(f"  cruise @out: |v_rel|={norm(v_out):.3f} km/s  |r_rel|={norm(r_sc_out):,.0f} km")

    ang_in = ang_deg(v_c_in, v_in)
    ang_out = ang_deg(v_c_out, v_out)
    h_true = cross(r_sc_in, v_in)
    ang_h = ang_deg(h_conic, h_true)
    ang_inout = ang_deg(v_in, v_out)
    print(f"  ★ angle(conic_v_in , cruise_v_in ) = {ang_in:7.2f}°")
    print(f"  ★ angle(conic_v_out, cruise_v_out) = {ang_out:7.2f}°")
    print(f"  ★ angle(h_conic, h_cruise_in)      = {ang_h:7.2f}°   (≈0 正确 / ≈180 镜像)")
    print(f"  angle(v_in, v_out) 真实转弯角        = {ang_inout:7.2f}°   (双曲线应转 {2*math.degrees(math.asin(min(1,1/kf[2]))):.2f}°)")
    # 双曲线自身从入臂到出臂的转角
    print(f"  angle(conic_v_in, conic_v_out)      = {ang_deg(v_c_in, v_c_out):7.2f}°")
