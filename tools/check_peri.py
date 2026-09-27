# -*- coding: utf-8 -*-
"""check_peri.py — 检查 saturn/orb 腿在 SOI 近拱点附近的原始插值（未去尖峰）。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import pos_at, load_points

leg = "sc_cassini/saturn/orb"
pts = load_points(leg)["points"]
print(f"leg keyframes: {len(pts)}, first t={pts[0][0]:.0f} last t={pts[-1][0]:.0f}")
# SOI 附近关键帧密度
J = 946728000
t_lo = time.mktime((2004, 6, 30, 0, 0, 0, 0, 0, 0)) - time.timezone - J
t_hi = time.mktime((2004, 7, 2, 0, 0, 0, 0, 0, 0)) - time.timezone - J
kf = [p for p in pts if t_lo <= p[0] <= t_hi]
print(f"keyframes 06-30..07-02: {len(kf)}")
prev_t = None
for p in kf:
    gap = 0 if prev_t is None else p[0] - prev_t
    print(f"  kf @ {time.strftime('%m-%d %H:%M:%S', time.gmtime(p[0]+J))}  gap={gap:.0f}s  a={p[1]:,.0f} e={p[2]:.6f}")
    prev_t = p[0]

print("\n== pos_at 1800s grid 00:30..05:00 (raw, before remove_spikes):")
t0 = time.mktime((2004, 7, 1, 0, 30, 0, 0, 0, 0)) - time.timezone - J
prev = None
for i in range(10):
    t = t0 + i * 1800
    p = pos_at(leg, t)
    r = math.sqrt(sum(v * v for v in p))
    line = f"  {time.strftime('%H:%M:%S', time.gmtime(t+J))}  r_sat={r:>10,.0f} km  pos=({p[0]:>9,.0f},{p[1]:>9,.0f},{p[2]:>9,.0f})"
    if prev is not None:
        d = math.sqrt(sum((p[k]-prev[0][k])**2 for k in range(3)))
        line += f"  v={d/1800:6.2f} km/s"
        # 转角
        d1 = [p[k]-prev[0][k] for k in range(3)]
        if prev[1] is not None:
            d0 = prev[1]
            la = math.sqrt(sum(v*v for v in d0)); lb = math.sqrt(sum(v*v for v in d1))
            cosang = sum(d0[k]*d1[k] for k in range(3))/(la*lb)
            line += f"  turn={math.degrees(math.acos(max(-1,min(1,cosang)))):6.1f}deg"
    print(line)
    d1 = [p[k]-prev[0][k] for k in range(3)] if prev else None
    prev = (p, d1)

print("\n== pos_at 900s fine grid 01:00..04:30:")
t0 = time.mktime((2004, 7, 1, 1, 0, 0, 0, 0, 0)) - time.timezone - J
prev = None; prevd = None
for i in range(15):
    t = t0 + i * 900
    p = pos_at(leg, t)
    r = math.sqrt(sum(v * v for v in p))
    d1 = None
    line = f"  {time.strftime('%H:%M:%S', time.gmtime(t+J))}  r_sat={r:>10,.0f} km"
    if prev is not None:
        d1 = [p[k]-prev[k] for k in range(3)]
        d = math.sqrt(sum(v*v for v in d1))
        line += f"  v={d/900:6.2f} km/s"
        if prevd is not None:
            la = math.sqrt(sum(v*v for v in prevd)); lb = math.sqrt(sum(v*v for v in d1))
            cosang = sum(prevd[k]*d1[k] for k in range(3))/(la*lb)
            line += f"  turn={math.degrees(math.acos(max(-1,min(1,cosang)))):6.1f}deg"
    print(line)
    prev, prevd = p, d1
