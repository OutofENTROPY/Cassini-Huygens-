# -*- coding: utf-8 -*-
"""check_soi_baked.py — 解码 data/cassini_data.js 中已烘焙的轨迹与 SOI 相对轨迹，
对每个行星 SOI 窗口核验相对轨迹的物理正确性：
  - h_rel = r_rel × v_rel 的方向在穿越期间应近似恒定（平面飞掠）且与真实
    转弯方向一致（h_true = v_in × v_out，由巡航腿在 SOI 边界外的速度给出）；
  - 相对速度从 v_in 转到 v_out 的转角应 ≈ 真实转角（能量守恒 |v_in|≈|v_out|）；
  - 镜像（完全相反）表现为 h_rel 与 h_true 反平行。
不依赖 bake_data.py，直接解码前端数据（用户实际所见）。"""
import base64
import bisect
import json
import math
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "data", "cassini_data.js"), encoding="utf-8") as f:
    txt = f.read()
txt = txt[txt.index("=", txt.index("CASSINI_DATA")) + 1:].rstrip().rstrip(";")
DATA = json.loads(txt)
J2000_S = DATA["meta"]["j2000Ms"] / 1000.0

BODIES = {}
for name, b in DATA["bodies"].items():
    segs = []
    for s in b["segs"]:
        segs.append((s["t0"], s["dt"], struct.unpack(f"<{s['n']*3}f", base64.b64decode(s["d"]))))
    BODIES[name] = segs


def body_pos(name, t):
    for (t0, dt, xyz) in BODIES[name]:
        n = len(xyz) // 3
        f = (t - t0) / dt
        if 0 <= f <= n - 1:
            i = min(n - 2, int(math.floor(f)))
            a = f - i
            return tuple(xyz[i*3+k] + (xyz[(i+1)*3+k] - xyz[i*3+k]) * a for k in range(3))
    seg = min(BODIES[name], key=lambda s: abs(t - (s[0] if t < s[0] else s[0] + s["dt"]*(len(s[2])//3 - 1))))
    return None


TRAIL_T = struct.unpack(f"<{DATA['spacecraft']['cassini']['trailN']}d",
                        base64.b64decode(DATA["spacecraft"]["cassini"]["trailT"]))
TRAIL = struct.unpack(f"<{DATA['spacecraft']['cassini']['trailN']*3}f",
                      base64.b64decode(DATA["spacecraft"]["cassini"]["trail"]))


def trail_pos(t):
    i = bisect.bisect_right(TRAIL_T, t)
    if i <= 0:
        i = 1
    if i >= len(TRAIL_T):
        i = len(TRAIL_T) - 1
    a = (t - TRAIL_T[i-1]) / (TRAIL_T[i] - TRAIL_T[i-1])
    return tuple(TRAIL[(i-1)*3+k] + (TRAIL[i*3+k] - TRAIL[(i-1)*3+k]) * a for k in range(3))


def sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def norm(v):
    return math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2])


def dot(a, b):
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def unit(v):
    n = norm(v) or 1.0
    return (v[0]/n, v[1]/n, v[2]/n)


def ang(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, dot(unit(a), unit(b))))))


def vel(fn, t, dt=600.0):
    p0, p1 = fn(t-dt), fn(t+dt)
    return tuple((p1[k]-p0[k])/(2*dt) for k in range(3))


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000_S))


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000_S


SOI = {"venus": 6.169e5, "earth": 9.247e5, "jupiter": 4.82e7, "saturn": 5.45e7}

WINDOWS = [
    ("Venus-1", "venus", et(1998, 4, 20), et(1998, 5, 3), "sc_cassini/sun/1/orb", "sc_cassini/sun/2/orb"),
    ("Venus-2", "venus", et(1999, 6, 18), et(1999, 7, 1), "sc_cassini/sun/2/orb", "sc_cassini/sun/3/orb"),
    ("Earth", "earth", et(1999, 8, 12), et(1999, 8, 25), "sc_cassini/sun/3/orb", "sc_cassini/sun/4/orb"),
    ("Jupiter", "jupiter", et(2000, 8, 1), et(2001, 7, 1), "sc_cassini/sun/4/orb", "sc_cassini/sun/4/orb"),
    ("Saturn-SOI", "saturn", et(2004, 1, 1), et(2004, 7, 10), None, None),
]

for label, planet, t_lo, t_hi, leg_a, leg_b in WINDOWS:
    print("=" * 100)
    r_soi = SOI[planet]
    # 从烘焙轨迹找 SOI 穿越
    tin = tout = None
    t = t_lo
    prev = norm(sub(trail_pos(t), body_pos(planet, t))) - r_soi
    while t < t_hi:
        t2 = t + 900.0
        cur = norm(sub(trail_pos(t2), body_pos(planet, t2))) - r_soi
        if prev > 0 >= cur and tin is None:
            tin = t2
        if prev <= 0 < cur:
            tout = t2
        prev, t = cur, t2
    print(f"[{label}] baked trail SOI crossings: in={iso(tin) if tin else '-'}  out={iso(tout) if tout else '-'}")
    if not tin or not tout:
        continue

    # 相对轨迹几何：h_rel 方向漂移 + 转角
    def rrel(tt):
        return sub(trail_pos(tt), body_pos(planet, tt))

    v_in_tr = vel(rrel, tin + 1800.0, 1800.0)
    v_out_tr = vel(rrel, tout - 1800.0, 1800.0)
    h_samples = []
    t = tin
    while t <= tout:
        rr = rrel(t)
        vv = vel(rrel, t, 600.0)
        h_samples.append((t, cross(rr, vv)))
        t += (tout - tin) / 24.0
    h0 = h_samples[0][1]
    h_end = h_samples[-1][1]
    hmid = unit(h_samples[len(h_samples)//2][1])
    flip = ang(h0, h_end)
    print(f"  trail |v_in|={norm(v_in_tr):.3f} |v_out|={norm(v_out_tr):.3f} km/s  转角={ang(v_in_tr, v_out_tr):.2f}°")
    print(f"  h_rel 方向漂移 (入 vs 出) = {flip:.1f}°   (平面飞掠应 <10°；漂移~180° = S形镜像)")
    # 与巡航腿真实 v_in/v_out 对比
    if leg_a and leg_b:
        def leg_vel(leg, tt, dt=3600.0):
            import bake_data as B
            p0 = B.pos_at(leg, tt-dt)
            p1 = B.pos_at(leg, tt+dt)
            return tuple((p1[k]-p0[k])/(2*dt) for k in range(3))
        import bake_data as B
        vp_in = vel(lambda tt: B.pos_at(planet + "/sun/orb", tt), tin, 600.0)
        vp_out = vel(lambda tt: B.pos_at(planet + "/sun/orb", tt), tout, 600.0)
        v_in_true = sub(leg_vel(leg_a, tin), vp_in)
        v_out_true = sub(leg_vel(leg_b, tout), vp_out)
        h_true = cross(v_in_true, v_out_true)
        print(f"  cruise |v_in|={norm(v_in_true):.3f} |v_out|={norm(v_out_true):.3f}  真实转角={ang(v_in_true, v_out_true):.2f}°")
        print(f"  ★ angle(h_trail, h_true) = {ang(h0, h_true):.1f}°  (≈0 正确 / ≈180 镜像)")
        print(f"  ★ angle(v_trail_in , v_true_in ) = {ang(v_in_tr, v_in_true):.1f}°")
        print(f"  ★ angle(v_trail_out, v_true_out) = {ang(v_out_tr, v_out_true):.1f}°")
