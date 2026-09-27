# -*- coding: utf-8 -*-
"""verify_splice.py — 拼接效果综合验证：
1) 各边界 ±5 天：top 台阶 + top 转角（step/turn 双排序）
2) 全轨迹扫描：转角 > 45° 且跨度 > 5 万 km 的事件（应只剩真实机动）
3) 合并轨迹上的飞掠近拱距离（确认真实飞掠弧未被拼接稀释）
"""
import base64, json, math, os, struct, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at

J = 946728000
LEG_BOUNDS = [
    ("launch->sun/1", "1997-10-18 16:01"),
    ("sun/1->flyby1", "1998-04-26 00:01"),
    ("flyby1->sun/2", "1998-04-27 00:01"),
    ("sun/2->flyby2", "1999-06-24 14:01"),
    ("flyby2->sun/3", "1999-06-25 02:01"),
    ("sun/3->flyby", "1999-08-16 04:01"),
    ("flyby->sun/4", "1999-08-19 13:01"),
    ("sun/4->saturn/orb", "2004-05-30 20:01"),
]


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t + J))


def et(utc):
    if len(utc) == 16:
        utc += ":00"
    return calendar.timegm(time.strptime(utc, "%Y-%m-%d %H:%M:%S")) - J


import calendar

raw = open(os.path.join("..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
n = sc["trailN"]
tt = struct.unpack(f"<{n}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{n*3}f", base64.b64decode(sc["trail"]))
print(f"trail: {n} pts, {iso(tt[0])} .. {iso(tt[-1])}")


def scan(t_lo, t_hi, label, top=5):
    ev = []
    for i in range(1, n - 1):
        if not (t_lo <= tt[i] <= t_hi):
            continue
        a = [xyz[i * 3 + k] - xyz[(i - 1) * 3 + k] for k in range(3)]
        b = [xyz[(i + 1) * 3 + k] - xyz[i * 3 + k] for k in range(3)]
        la_ = math.sqrt(sum(v * v for v in a))
        lb_ = math.sqrt(sum(v * v for v in b))
        turn = None
        if la_ > 1 and lb_ > 1:
            cosang = max(-1, min(1, sum(a[k] * b[k] for k in range(3)) / (la_ * lb_)))
            turn = math.degrees(math.acos(cosang))
        ev.append((la_, turn, i, tt[i + 1] - tt[i - 1]))
    by_step = sorted(ev, key=lambda e: -e[0])[:top]
    by_turn = sorted((e for e in ev if e[1] is not None), key=lambda e: -e[1])[:top]
    print(f"  [{label}]")
    for step, turn, i, dt in by_step:
        print(f"    step {iso(tt[i])}  dt={dt:7.0f}s  {step:>13,.0f} km  turn={turn if turn is None else f'{turn:5.1f}°'}")
    for step, turn, i, dt in by_turn:
        print(f"    turn {iso(tt[i])}  dt={dt:7.0f}s  {step:>13,.0f} km  turn={turn:5.1f}°")


print("\n== 1) boundary windows (±5 d) ==")
for name, utc in LEG_BOUNDS:
    tb = et(utc)
    scan(tb - 5 * 86400, tb + 5 * 86400, name)

print("\n== 2) global scan: turn>45deg && span>50,000 km ==")
cnt = 0
for i in range(1, n - 1):
    a = [xyz[i * 3 + k] - xyz[(i - 1) * 3 + k] for k in range(3)]
    b = [xyz[(i + 1) * 3 + k] - xyz[i * 3 + k] for k in range(3)]
    la_ = math.sqrt(sum(v * v for v in a))
    lb_ = math.sqrt(sum(v * v for v in b))
    if la_ <= 1 or lb_ <= 1:
        continue
    cosang = max(-1, min(1, sum(a[k] * b[k] for k in range(3)) / (la_ * lb_)))
    turn = math.degrees(math.acos(cosang))
    if turn > 45.0 and (la_ + lb_) > 50_000:
        cnt += 1
        if cnt <= 40:
            print(f"    {iso(tt[i])}  span={la_+lb_:>12,.0f} km  turn={turn:5.1f}°")
print(f"    total: {cnt}")

print("\n== 3) merged-trail flyby periapsis distances ==")
for name, body, t0, t1 in [
    ("venus1", "venus/sun/orb", "1998-04-26 06:00", "1998-04-26 20:00"),
    ("venus2", "venus/sun/orb", "1999-06-24 14:00", "1999-06-25 02:00"),
    ("earth", "earth/sun/orb", "1999-08-17 20:00", "1999-08-18 12:00"),
]:
    tc0, tc1 = et(t0), et(t1)
    c_pts = load_points(body)["points"]

    def body_pos(t):
        lo, hi = 0, len(c_pts) - 1
        if t <= c_pts[0][0]:
            return pos_at(body, t)
        if t >= c_pts[-1][0]:
            return pos_at(body, t)
        while hi - lo > 1:
            mid = (lo + hi) >> 1
            if c_pts[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        return pos_at(body, t)

    best, bt = 1e18, None
    for i in range(n):
        if not (tc0 <= tt[i] <= tc1):
            continue
        bp = body_pos(tt[i])
        d = math.sqrt(sum((xyz[i * 3 + k] - bp[k]) ** 2 for k in range(3)))
        if d < best:
            best, bt = d, tt[i]
    print(f"    min |trail-{name}| = {best:>10,.0f} km @ {iso(bt)}")
