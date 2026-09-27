# -*- coding: utf-8 -*-
"""check_soi.py — SOI 前后 merged / saturnLocal 轨迹逐点速度与转角分析。"""
import base64, json, math, os, struct, time, sys

HERE = os.path.dirname(os.path.abspath(__file__))
raw = open(os.path.join(HERE, "..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
J = 946728000

def unpack(b64, n, fmt):
    return struct.unpack(f"<{n}{fmt}", base64.b64decode(b64))

def ang(a, b):
    la = math.sqrt(sum(v * v for v in a)); lb = math.sqrt(sum(v * v for v in b))
    if la < 1e-9 or lb < 1e-9: return 0.0
    d = sum(a[i] * b[i] for i in range(3)) / (la * lb)
    return math.degrees(math.acos(max(-1, min(1, d))))

def dump(name, tb64, xb64, n, t_lo, t_hi):
    tt = unpack(tb64, n, "d")
    xyz = unpack(xb64, n * 3, "f")
    idx = [i for i in range(n) if t_lo <= tt[i] <= t_hi]
    if not idx:
        print(f"== {name}: no points in window"); return
    print(f"== {name}: {len(idx)} pts, {time.strftime('%m-%d %H:%M:%S', time.gmtime(tt[idx[0]]+J))} .. {time.strftime('%m-%d %H:%M:%S', time.gmtime(tt[idx[-1]]+J))}")
    prev_t = prev_p = None
    for i in idx:
        p = (xyz[i*3], xyz[i*3+1], xyz[i*3+2])
        line = f"  {time.strftime('%m-%d %H:%M:%S', time.gmtime(tt[i]+J))}  r=({p[0]:>11,.0f},{p[1]:>11,.0f},{p[2]:>10,.0f})"
        if prev_p is not None:
            dt = tt[i] - prev_t
            d = math.sqrt(sum((p[k]-prev_p[k])**2 for k in range(3)))
            line += f"  dt={dt:>6.0f}s  v={d/max(dt,1e-9):>6.2f} km/s"
        print(line)
        prev_t, prev_p = tt[i], p
    # turn angles inside window (need neighbor outside window too)
    for i in idx[1:-1] if len(idx) > 2 else []:
        pass

# merged trail
tt = unpack(sc["trailT"], sc["trailN"], "d")
xyz = unpack(sc["trail"], sc["trailN"]*3, "f")
# window: 2004-06-30 20:00 .. 2004-07-01 12:00 UTC
t_lo = time.mktime((2004,6,30,20,0,0,0,0,0)) - time.timezone
t_hi = time.mktime((2004,7,1,12,0,0,0,0,0)) - time.timezone
dump("merged(sun)", sc["trailT"], sc["trail"], sc["trailN"], t_lo - J, t_hi - J)

# turn angles in merged near SOI
def turns(name, tt, xyz, n, t_lo, t_hi):
    worst = []
    for i in range(1, n-1):
        if not (t_lo <= tt[i] <= t_hi): continue
        d1 = [xyz[i*3+k]-xyz[(i-1)*3+k] for k in range(3)]
        d2 = [xyz[(i+1)*3+k]-xyz[i*3+k] for k in range(3)]
        a = ang(d1, d2)
        if a > 20:
            worst.append((a, i))
    worst.sort(reverse=True)
    print(f"-- {name} turns>20deg in window: {len(worst)}")
    for a, i in worst[:12]:
        d1 = math.sqrt(sum((xyz[i*3+k]-xyz[(i-1)*3+k])**2 for k in range(3)))
        d2 = math.sqrt(sum((xyz[(i+1)*3+k]-xyz[i*3+k])**2 for k in range(3)))
        print(f"   {a:6.1f}deg @ {time.strftime('%m-%d %H:%M:%S', time.gmtime(tt[i]+J))}  step={d1:,.0f}/{d2:,.0f} km")

turns("merged", tt, xyz, sc["trailN"], t_lo - J, t_hi - J)

# saturn-local trail（键名: saturnLocalT/saturnLocal/saturnLocalN）
sl = sc
stt = unpack(sl["saturnLocalT"], sl["saturnLocalN"], "d")
sxyz = unpack(sl["saturnLocal"], sl["saturnLocalN"] * 3, "f")
dump("saturnLocal", sl["saturnLocalT"], sl["saturnLocal"], sl["saturnLocalN"], t_lo - J, t_hi - J)
turns("saturnLocal", stt, sxyz, sl["saturnLocalN"], t_lo - J, t_hi - J)

# 交叉验证：同一数据文件里土星自己的日心轨迹 + Cassini-Saturn 距离
sb = js["bodies"]["saturn"]
print("== saturn body segs:", [(s_.get("t0"), s_.get("step"), s_.get("n")) for s_ in sb["segs"]][:6])
mtt = unpack(sc["trailT"], sc["trailN"], "d")
mxyz = unpack(sc["trail"], sc["trailN"] * 3, "f")

def saturn_pos(t):
    for s_ in sb["segs"]:
        tb = base64.b64decode(s_["t"]); xb = base64.b64decode(s_["x"])
        nt = struct.unpack(f"<{s_['n']}d", tb)
        if nt[0] <= t <= nt[-1]:
            xx = struct.unpack(f"<{s_['n']*3}f", xb)
            lo, hi = 0, s_["n"] - 1
            while hi - lo > 1:
                mid = (lo + hi) >> 1
                if nt[mid] <= t: lo = mid
                else: hi = mid
            al = (t - nt[lo]) / (nt[hi] - nt[lo])
            return tuple(xx[lo*3+k] + (xx[hi*3+k] - xx[lo*3+k]) * al for k in range(3))
    return None

# fine-window 网格上逐点检查
print("== cross-check on merged trail (Saturn dist + Saturn speed):")
import bisect
prev_sp = None
cnt = 0
for i in range(sc["trailN"]):
    t = mtt[i]
    if not (t_lo - J <= t <= t_hi - J): continue
    tt_h = time.strftime("%m-%d %H:%M:%S", time.gmtime(t + J))
    # 只打印 450s 精细网格点（跳过 :01:04 等 +64s 交错点）
    sec = (t + J) % 3600
    if sec % 450 != 0: continue
    p = (mxyz[i*3], mxyz[i*3+1], mxyz[i*3+2])
    sp = saturn_pos(t)
    if sp is None: continue
    d = math.sqrt(sum((p[k]-sp[k])**2 for k in range(3)))
    line = f"  {tt_h}  cassini-saturn dist={d:>12,.0f} km"
    if prev_sp is not None:
        vs = math.sqrt(sum((sp[k]-prev_sp[0][k])**2 for k in range(3))) / max(t - prev_sp[1], 1e-9)
        line += f"  (saturn v={vs:.2f} km/s)"
    prev_sp = (sp, t)
    print(line)
    cnt += 1
    if cnt > 40: break
