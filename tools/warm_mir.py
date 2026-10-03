# -*- coding: utf-8 -*-
"""warm_mir.py — 预热 Miriade 行星缓存（与 bake_planets2 相同参数，落盘 miriade_cache）。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_spice as B  # noqa: E402

for name in ("mercury", "venus", "mars", "earth", "uranus", "neptune"):
    try:
        B._mir_body(name)
        print(f"  warm {name}: OK", flush=True)
    except Exception as e:
        print(f"  warm {name}: FAIL {e}", flush=True)
print("WARM DONE")
