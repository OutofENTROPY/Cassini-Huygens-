# -*- coding: utf-8 -*-
"""probe_sat_approach.py — build_saturn_approach() 构造质量探针（只读）。

核对：边界残差/速度方向差；重构双曲线 vs SPICE 真值（xcache）逐日偏差；
近拱点附近重构双曲线 vs saturn/orb 真实捕获弧的发散速率（远端混合窗定宽）。
"""
import math, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake_data as B
import xcheck_miriade as X


def n3(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + B.J2000_S))


def main():
    sb = B.build_saturn_approach()
    if sb is None:
        print("build_saturn_approach() -> None")
        return
    con, t0, tps = sb["con"], sb["t0"], sb["t_peri"]
    print(f"t0={iso(t0)}  t_peri={iso(tps)}  rp={sb['rp']:,.0f} km  "
          f"v∞={sb['vinf']:.3f} km/s  gap@t0={sb['gap']:,.0f} km")
    print(f"conic |r(t_peri)|={n3(con['pos'](tps)):,.0f} km (应=rp)")

    # 重构双曲线 vs SPICE 真值（土心，xcache 已有 2004-03..07 每日）
    X._load_cache()
    import calendar
    print("\n== 重构双曲线 vs SPICE（土心位置偏差） ==")
    t = calendar.timegm((2004, 5, 31, 0, 0, 0, 0, 0, 0))
    while t <= calendar.timegm((2004, 7, 2, 0, 0, 0, 0, 0, 0)):
        g = time.gmtime(t)
        rel = X.mir_cassini_rel(g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min)
        if "error" not in rel:
            t_tdb = X.utc_to_et(g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min)
            cas_rel = tuple(-c for c in rel["rel_km_ecl"])   # cassini−saturn
            con_rel = con["pos"](t_tdb)
            leg_rel = B.pos_at("sc_cassini/saturn/orb", t_tdb) if t_tdb >= t0 else None
            row = (f"{time.strftime('%Y-%m-%d', g)}  |r|=SPICE {rel['d_obs_km']:>12,.0f}  "
                   f"conic误差 {n3(sub(con_rel, cas_rel)):>12,.0f}")
            if leg_rel is not None:
                row += f"  旧腿误差 {n3(sub(leg_rel, cas_rel)):>12,.0f}"
            print(row)
        t += 86400
    X._save_cache()

    # 近拱点后：重构双曲线 vs saturn/orb 真实捕获弧（点火后）发散
    print("\n== t_peri 后：重构双曲线 vs saturn/orb（日心，点火后为真实） ==")
    for h in (0.5, 1, 2, 4, 6, 8, 12, 24):
        t = tps + h * 3600.0
        rc = con["pos"](t)
        cs = B.pos_at("saturn/sun/orb", t)
        lp = B.pos_at("sc_cassini/saturn/orb", t)
        cp = B.pos_at("saturn/sun/orb", t)
        d = n3(sub((rc[0] + cs[0], rc[1] + cs[1], rc[2] + cs[2]),
                   (lp[0] + cp[0], lp[1] + cp[1], lp[2] + cp[2])))
        print(f"  +{h:>5.1f} h: |conic−leg| = {d:>10,.0f} km")


if __name__ == "__main__":
    main()
