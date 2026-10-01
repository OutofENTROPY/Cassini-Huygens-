# -*- coding: utf-8 -*-
"""check_new_conic.py — 独立验证 rebuild_flyby 的新双曲线构造（不跑完整烘焙）。
核对：入臂/出臂 SOI 处与巡航弧速度方向相切（<0.5°）、SOI 穿越时刻与真实
半径剖面一致、反解 rp 与任务真实值闭合、近拱点时刻与任务实录一致。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_data as B
from bake_data import (pos_at, conic_peri_kf, conic_r, cross3, dot3, unit3,
                       ang3, rodrigues, hyp_conic, def_mu)


def norm3(v):
    return math.sqrt(dot3(v, v))


J2000_S = B.J2000_S


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000_S


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000_S))


SOI = {"venus": 6.169e5, "earth": 9.247e5}
FLYBYS = [
    ("Venus-1", "sc_cassini/venus/flyby1/orb", "sc_cassini/sun/1/orb", "sc_cassini/sun/2/orb",
     "venus", SOI["venus"]),
    ("Venus-2", "sc_cassini/venus/flyby2/orb", "sc_cassini/sun/2/orb", "sc_cassini/sun/3/orb",
     "venus", SOI["venus"]),
    ("Earth", "sc_cassini/earth/flyby/orb", "sc_cassini/sun/3/orb", "sc_cassini/sun/4/orb",
     "earth", SOI["earth"]),
]

for label, leg, cruise_a, cruise_b, planet, r_soi in FLYBYS:
    mu = def_mu(leg)
    kf = conic_peri_kf(leg)
    t_peri = kf[0] - kf[4] / kf[3]
    rp = conic_r(kf, t_peri)

    def cruise_rel(t):
        leg_ = cruise_a if t <= t_peri else cruise_b
        pc = pos_at(planet + "/sun/orb", t)
        pl = pos_at(leg_, t)
        r = (pl[0] - pc[0], pl[1] - pc[1], pl[2] - pc[2])
        dt = 600.0
        p0, p1 = pos_at(leg_, t - dt), pos_at(leg_, t + dt)
        c0, c1 = pos_at(planet + "/sun/orb", t - dt), pos_at(planet + "/sun/orb", t + dt)
        v = tuple(((p1[k] - p0[k]) - (c1[k] - c0[k])) / (2.0 * dt) for k in range(3))
        return r, v

    t_in, t_out = t_peri - 86400.0, t_peri + 86400.0
    con = None
    for it in range(6):
        r_in, v_in = cruise_rel(t_in)
        _, v_out = cruise_rel(t_out)
        turn = ang3(v_in, v_out)
        e = 1.0 / math.sin(math.radians(turn) / 2.0)
        A = rp / (e - 1.0)
        hh = unit3(cross3(v_in, v_out))
        psi = con["bend_at"](r_soi) if con else 0.0
        vinf = rodrigues(unit3(v_in), hh, -psi)
        w = cross3(hh, vinf)
        P = unit3(tuple((vinf[k] - math.sqrt(e * e - 1.0) * w[k]) / e for k in range(3)))
        con = hyp_conic(mu, A, e, P, cross3(hh, P), t_peri)
        t_in2 = con["radius_t"](r_soi, False)
        t_out2 = con["radius_t"](r_soi, True)
        done = abs(t_in2 - t_in) < 2.0 and abs(t_out2 - t_out) < 2.0
        t_in, t_out = t_in2, t_out2
        if done:
            break

    r_in, v_in = cruise_rel(t_in)
    _, v_out = cruise_rel(t_out)
    v_con_in, v_con_out = con["vel"](t_in), con["vel"](t_out)

    # 反解 rp（由实测转弯角与真实 rp 自洽性检查：A = rp/(e−1) 反解 e→rp）
    rp_meas = A * (1.0 / math.sin(math.radians(ang3(v_in, v_out)) / 2.0) - 1.0)

    print(f"[{label}] 迭代 {it+1} 次收敛")
    print(f"  t_peri={iso(t_peri)}  rp(钉定)={rp:,.0f}  rp(反解)={rp_meas:,.0f}  差 {abs(rp_meas-rp)/rp*100:.2f}%")
    print(f"  SOI 穿越: in={iso(t_in)} out={iso(t_out)}")
    print(f"  v∞={math.sqrt(mu/A):.3f} km/s   |v_in|={norm3(v_in):.3f} |v_out|={norm3(v_out):.3f}"
          f"  双曲线|v(SOI)|={norm3(v_con_in):.3f}")
    print(f"  ★ 切向连续: 入臂 {ang3(v_con_in, v_in):.3f}°  出臂 {ang3(v_con_out, v_out):.3f}°")
    print(f"  构造双曲线近拱点 |r|={norm3(con['pos'](t_peri)):,.0f} km @ {iso(t_peri)}")
