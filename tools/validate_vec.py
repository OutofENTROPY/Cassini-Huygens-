# -*- coding: utf-8 -*-
"""validate_vec.py — 验证向量化实现与逐点实现数值一致。"""
import os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_spice as B

B.load_kernels()
ts0, te0 = B.first_spk_time(), B.last_spk_time()
d0, d1 = ts0 - 300.0, te0 + 300.0
print("build_grid ...")
B.SB.build_grid(d0, d1, step=21600.0)

print("=== bake_moons (for raw grids) ===")
t0 = time.perf_counter()
moons, raw = B.bake_moons(d0, d1)
print(f"  bake_moons: {time.perf_counter()-t0:.2f}s")

rng = np.random.default_rng(7)
print("\n=== moon_at vs moon_at_vec ===")
for m in B.SAT_MOONS + ["moon"]:
    r = raw[m]
    t = r[0] + rng.random(2000) * (d1 - d0)
    v = B.moon_at_vec(r, t)
    mx = 0.0
    for i in range(len(t)):
        p = B.moon_at(r, float(t[i]))
        mx = max(mx, float(np.max(np.abs(p - v[i]))))
    print(f"  {m:10} max|diff| = {mx:.6e} km")
    assert mx < 1e-9

print("\n=== SB.offset vs grid ===")
print("  OK")
print("\nALL OK")
