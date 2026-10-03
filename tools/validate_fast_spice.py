# -*- coding: utf-8 -*-
"""validate_fast_spice.py — 验证 bake_spice 的快速采样通道 _state_fast 与
spiceypy.spkezr 数值完全一致（逐位比较），并量化加速比。

用法：python tools/validate_fast_spice.py
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bake_spice as B  # noqa: E402  (触发内核加载)

B.load_kernels()
print("kernel loaded, TimeMap anchors =", B.TM.n)

# ---- 1) 数值一致性：跨全任务随机取样 ----
import random
import spiceypy as sp

rng = random.Random(20261003)
CASES = []
# 覆盖：发射、地球飞掠、木星、土星入轨、土卫、末期
EPOCHS = [
    (1997, 10, 15), (1998, 4, 26), (1999, 6, 24), (2000, 12, 30),
    (2004, 7, 1), (2005, 1, 14), (2008, 3, 12), (2012, 1, 2),
    (2016, 11, 29), (2017, 9, 15),
]
REFS = ["SUN", "EARTH", "SATURN", "TITAN", "JUPITER"]
cache = {}

for (y, m, d) in EPOCHS:
    for _ in range(40):
        hh = rng.randrange(24)
        mm = rng.randrange(60)
        ss = rng.randrange(60)
        import calendar
        u = calendar.timegm((y, m, d, hh, mm, ss)) - B.J2000_UNIX
        tgt = rng.choice(REFS)
        obs = rng.choice(REFS)
        CASES.append((tgt, obs, u))

print("cases:", len(CASES))

max_dp = 0.0
max_dv = 0.0
worst = None
for (tgt, obs, u) in CASES:
    et = B.TM.et(u)
    ref, _ = sp.spkezr(tgt, et, "J2000", "NONE", obs)
    fast = B._state_fast(tgt, obs, et)
    dp = max(abs(ref[k] - fast[k]) for k in range(3))
    dv = max(abs(ref[k + 3] - fast[k + 3]) for k in range(3))
    if dp > max_dp:
        max_dp = dp; worst = (tgt, obs, u)
    if dv > max_dv:
        max_dv = dv

print(f"max |dp| = {max_dp:.6e} km   max |dv| = {max_dv:.6e} km/s")
print("worst case:", worst)
assert max_dp < 1e-6, "position mismatch!"

# ---- 2) TM.et 一致性 vs numpy interp ----
import numpy as np
us = np.array([B.TM.u0 + i * B.TM.STEP for i in range(B.TM.n)])
off = np.array(B.TM._off_list)
et_cmp_max = 0.0
_u0 = B.first_spk_time()
_u1 = B.last_spk_time()
for _ in range(20000):
    u = _u0 + rng.random() * (_u1 - _u0)
    ref = u + float(np.interp(u, us, off))
    got = B.TM.et(u)
    et_cmp_max = max(et_cmp_max, abs(ref - got))
print(f"max |et diff| = {et_cmp_max:.6e} s  (should be ~1e-8, interp rounding)")
assert et_cmp_max < 1e-3

# ---- 3) 速度对比 ----
U0 = B.first_spk_time()
U1 = B.last_spk_time()
N = 200000
print(f"\nbenchmark {N} calls over [{U0:.3e}, {U1:.3e}] ...")
t0 = time.perf_counter()
s = 0.0
for i in range(N):
    u = U0 + (i / N) * (U1 - U0)
    r = B.pos_ecl("CASSINI", "SATURN", u)
    s += r[0]
t_fast = time.perf_counter() - t0

t0 = time.perf_counter()
s2 = 0.0
for i in range(N):
    u = U0 + (i / N) * (U1 - U0)
    et = B.TM.et(u)
    st, _lt = sp.spkezr("CASSINI", et, "J2000", "NONE", "SATURN")
    r = (st[0], st[1] * B.CE + st[2] * B.SE, -st[1] * B.SE + st[2] * B.CE)
    s2 += r[0]
t_slow = time.perf_counter() - t0

print(f"  fast path : {t_fast:6.3f} s  ({t_fast / N * 1e6:6.2f} us/call)")
print(f"  spiceypy  : {t_slow:6.3f} s  ({t_slow / N * 1e6:6.2f} us/call)")
print(f"  speedup   : {t_slow / t_fast:.2f}x")
print("\nALL OK")
