# -*- coding: utf-8 -*-
"""check_sat_approach.py — 土星 SOI 接近段（2004-03..07）真相仲裁。

独立真值：IMCCE Miriade NAIF SPICE Cassini 核(-82)（与 eyes dynamo 独立）。
比对三方：
  A) sc_cassini/sun/4/orb  日心巡航腿（dynamo）     vs SPICE Cassini 日心
  B) sc_cassini/saturn/orb 土心腿接近段（dynamo）    vs SPICE 土心相对向量
  C) data/cassini_data.js 烘焙 merged trail（页面实际渲染）vs SPICE
并比较角动量 h 与偏近点矢量 P（镜像判定：h 反向 / P 或 P(−y) 镜像）。
结果缓存至 tools/xcache_miriade.json。
"""
import math, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake_data as B
import xcheck_miriade as X


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + B.J2000_S))


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def neg(a):
    return (-a[0], -a[1], -a[2])


def n3(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def ang(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, dot(a, b) / (n3(a) * n3(b))))))


def ecc_vec(r, v, mu):
    rr = n3(r)
    return tuple(((dot(v, v) - mu / rr) * r[k] - dot(r, v) * v[k]) / mu for k in range(3))


MU_SAT = 3.7931187e7  # km^3/s^2


def main():
    X._load_cache()
    js = X.load_baked()
    bk = X.Baked(js)

    # 键帧覆盖
    s4 = B.load_points("sc_cassini/sun/4/orb")["points"]
    so = B.load_points("sc_cassini/saturn/orb")["points"]
    print(f"sun/4    kf span: {iso(s4[0][0])} .. {iso(s4[-1][0])}  (n={len(s4)})")
    print(f"saturn   kf span: {iso(so[0][0])} .. {iso(so[-1][0])}  (n={len(so)})")
    print(f"legs 边界 tb = {iso(B.legs_span('sc_cassini/saturn/orb')[0]) if hasattr(B,'legs_span') else 'n/a'}")

    # SPICE 真值：2004-03-12 .. 2004-07-08 每日 00:00 UTC
    days = []
    import calendar
    t = calendar.timegm((2004, 3, 12, 0, 0, 0, 0, 0, 0))
    while t <= calendar.timegm((2004, 7, 8, 0, 0, 0, 0, 0, 0)):
        days.append(t)
        t += 86400

    truth = {}  # utc_unix -> (rel_km_ecl[sat-cas], sat_helio_ecl)
    for u in days:
        g = time.gmtime(u)
        rel = X.mir_cassini_rel(g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min)
        sat = X.mir_sun_vec_km_ecl("saturn", g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min)
        if "error" in rel or "error" in sat:
            print(f"  {u}: fetch fail: {(rel.get('error') or sat.get('error'))[:60]}")
            continue
        truth[u] = (rel["rel_km_ecl"], sat["km_ecl"], rel["d_obs_km"])
    X._save_cache()
    print(f"SPICE truth days: {len(truth)}")

    def tdb_of(u):
        g = time.gmtime(u)
        return X.utc_to_et(g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min)

    print("\n== 每日误差（km）：leg=saturn/orb 土心 | sun4=日心 | trail=烘焙 trail 土心（页面渲染） ==")
    print(f"{'UTC':16s} {'|Cas-Sat|SPICE':>14s} {'leg误差':>12s} {'sun4误差':>12s} {'trail土心':>12s} {'trail日心':>12s}")
    for u in days:
        if u not in truth:
            continue
        rel, sath, d_obs = truth[u]
        cas_helio = sub(sath, rel)          # SPICE Cassini 日心
        cas_rel = neg(rel)                  # SPICE Cassini−Saturn（土心）
        t_tdb = tdb_of(u)
        row = f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(u)):16s} {d_obs:14,.0f}"
        # B) saturn/orb 腿（土心）
        if t_tdb >= so[0][0]:
            leg = B.pos_at("sc_cassini/saturn/orb", t_tdb)
            row += f" {n3(sub(leg, cas_rel)):12,.0f}"
        else:
            row += f" {'—':>12s}"
        # A) sun/4 日心
        if t_tdb <= s4[-1][0]:
            s4p = B.pos_at("sc_cassini/sun/4/orb", t_tdb)
            row += f" {n3(sub(s4p, cas_helio)):12,.0f}"
        else:
            row += f" {'—':>12s}"
        # C) 烘焙 trail
        p_t = bk.trail_interp(t_tdb)
        if p_t is None:
            p_t = bk.trail_interp(X.utc_to_et_naive(*(time.gmtime(u)[0:5])))
        if p_t is not None:
            sb = bk.body_pos("saturn", t_tdb)
            e_rel = n3(sub(sub(sb, p_t), rel)) if sb else float("nan")
            e_hel = n3(sub(p_t, cas_helio))
            row += f" {e_rel:12,.0f} {e_hel:12,.0f}"
        else:
            row += f" {'—':>12s} {'—':>12s}"
        print(row)

    # h / P 判定（6 月每日，腿键帧内）
    print("\n== h / P 方向判定（土心，腿 vs SPICE） ==")
    print(f"{'UTC':16s} {'∠(h_leg,h_true)':>16s} {'∠(P_leg,P_true)':>16s} {'∠(h_leg,−h_true)':>17s}")
    us = [u for u in days if u in truth and tdb_of(u) >= so[0][0] + 86400]
    for i in range(1, len(us) - 1):
        u = us[i]
        t0, t1, t2 = tdb_of(us[i - 1]), tdb_of(u), tdb_of(us[i + 1])
        if t1 < so[0][0]:
            continue
        r_leg = B.pos_at("sc_cassini/saturn/orb", t1)
        dt = t2 - t0
        v_leg = tuple((B.pos_at("sc_cassini/saturn/orb", t2)[k] -
                       B.pos_at("sc_cassini/saturn/orb", t0)[k]) / dt for k in range(3))
        r_t = [neg(truth[us[j]][0]) for j in (i - 1, i, i + 1)]
        v_t = tuple((r_t[2][k] - r_t[0][k]) / (us[i + 1] - us[i - 1]) for k in range(3))
        h_l, h_t = cross(r_leg, v_leg), cross(r_t[1], v_t)
        P_l, P_t = ecc_vec(r_leg, v_leg, MU_SAT), ecc_vec(r_t[1], v_t, MU_SAT)
        print(f"{time.strftime('%Y-%m-%d', time.gmtime(u)):16s} {ang(h_l, h_t):15.2f}° "
              f"{ang(P_l, P_t):15.2f}° {ang(h_l, neg(h_t)):16.2f}°")

    # tb 边界分解：12M km gap 归属
    print("\n== tb=2004-05-30 20:01 边界分解 ==")
    tb = so[0][0]
    u0 = calendar.timegm((2004, 5, 30, 20, 0, 0, 0, 0, 0))
    for u in (u0 - 3600, u0, u0 + 3600):
        if u not in truth:
            continue
        rel, sath, _ = truth[u]
        cas_helio = sub(sath, rel)
        cas_rel = neg(rel)
        t_tdb = tdb_of(u)
        A = B.pos_at("sc_cassini/sun/4/orb", t_tdb)
        Bs = B.pos_at("sc_cassini/saturn/orb", t_tdb)
        print(f"  {iso(t_tdb)}  A(sun/4)误差={n3(sub(A, cas_helio)):,.0f} km   "
              f"B(saturn/orb)误差={n3(sub(Bs, cas_rel)):,.0f} km   |A−B|={n3(sub(A, add(Bs, sath))):,.0f} km")


if __name__ == "__main__":
    main()
