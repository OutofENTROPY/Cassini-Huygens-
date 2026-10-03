# -*- coding: utf-8 -*-
"""profile_bake.py —— 分阶段计时 bake_spice.py 的各部分，定位性能热点。
不写任何输出文件（避免污染 data）。"""
import sys, os, time, cProfile, pstats, io
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def t(label, fn, *a, **kw):
    t0 = time.perf_counter()
    r = fn(*a, **kw)
    dt = time.perf_counter() - t0
    print(f"  [{dt:8.2f}s] {label}")
    return r, dt

import bake_spice as B
import numpy as np

print("=== 载入内核 ===")
_, _ = t("load_kernels", B.load_kernels)

print("=== 数据域 ===")
ts0, _ = t("first_spk_time (40 次二分)", B.first_spk_time)
te0, _ = t("last_spk_time (40 次二分)", B.last_spk_time)
print(f"  ts0={ts0:.1f} te0={te0:.1f}")
d0, d1 = ts0 - 300.0, te0 + 300.0

print("=== SB 偏移网格 ===")
_, _ = t("build_grid", B.SB.build_grid, d0, d1)

print("=== 卫星网格 ===")
(moons, moons_raw), _ = t("bake_moons", B.bake_moons, d0, d1)

print("=== 行星网格 ===")
bodies, _ = t("bake_planets2", B.bake_planets2, d0, d1)

print("=== SOI 粗扫 + 细化 ===")
soi_wins = {}
for name in ("venus", "earth", "jupiter"):
    t0 = time.perf_counter()
    spans = B.coarse_soi_spans(name, B.SOI_RADII[name], ts0, te0)
    wins = []
    for sp_ in spans:
        r = B.scan_planet_soi([sp_], name, B.SOI_RADII[name])
        if r: wins.append(r)
    soi_wins[name] = wins
    print(f"  [{time.perf_counter()-t0:8.2f}s] SOI {name}: {len(wins)} wins")

_, _ = t("scan_moon_soi_windows", B.scan_moon_soi_windows, ts0, te0, moons_raw)

print("=== 主轨迹 ===")
_, _ = t("bake_cassini_trail", B.bake_cassini_trail, ts0, te0, moons_raw, soi_wins, [])

print("=== 锚定轨道 ===")
_, _ = t("bake_anchors", B.bake_anchors, ts0, te0)

print("=== Huygens ===")
_, _ = t("bake_huygens", B.bake_huygens, moons_raw)

print("=== cProfile（仅主轨迹+锚定）===")
pr = cProfile.Profile()
pr.enable()
B.bake_cassini_trail(ts0, te0, moons_raw, soi_wins, [])
B.bake_anchors(ts0, te0)
pr.disable()
s = io.StringIO()
ps = pstats.Stats(pr, stream=s).sort_stats('cumulative')
ps.print_stats(25)
print(s.getvalue()[:5000])
