# -*- coding: utf-8 -*-
"""diff_bake.py — 比较新旧烘焙数据（.prev vs 当前），逐字段数值差异。

用法：python tools/diff_bake.py
对 cassini_data.js / moons_data.js 的 base64 段做数值 diff：max |Δ| / 相对差。
"""
import base64
import json
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")


def load_js(path):
    txt = open(path, "r", encoding="utf-8").read()
    m = re.search(r"window\.\w+\s*=\s*(\{.*\});?\s*$", txt.strip(), re.S)
    return json.loads(m.group(1))


def b64f64(s):
    return np.frombuffer(base64.b64decode(s), "<f8")


def b64f32(s):
    return np.frombuffer(base64.b64decode(s), "<f4")


def cmp_arr(a, b, label):
    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    if a.shape != b.shape:
        print(f"  {label:26} SHAPE DIFF {a.shape} vs {b.shape}")
        return False
    d = np.abs(a - b)
    mx = float(d.max()) if d.size else 0.0
    scale = max(float(np.abs(a).max()), 1e-30)
    print(f"  {label:26} n={a.size:8d}  max|Δ|={mx:.4e}  rel={mx/scale:.2e}")
    return True


def walk(old, new, path=""):
    ok = True
    if isinstance(old, dict):
        for k in sorted(set(old) | set(new)):
            if k not in old or k not in new:
                print(f"  MISSING {path}/{k}")
                ok = False
                continue
            ok &= walk(old[k], new[k], f"{path}/{k}")
    elif isinstance(old, list):
        if len(old) != len(new):
            print(f"  LEN DIFF {path}: {len(old)} vs {len(new)}")
            return False
        for i, (a, b) in enumerate(zip(old, new)):
            ok &= walk(a, b, f"{path}[{i}]")
    elif isinstance(old, str) and old and new and isinstance(new, str):
        # 尝试当 base64 浮点段比较
        if len(old) == len(new) and len(old) % 4 == 0:
            try:
                raw = base64.b64decode(old, validate=True)
                raw2 = base64.b64decode(new, validate=True)
            except Exception:
                return ok
            if len(raw) % 8 == 0 and len(raw) > 16:
                cmp_arr(b64f64(old), b64f64(new), path)
            elif len(raw) % 4 == 0 and len(raw) > 16:
                cmp_arr(b64f32(old), b64f32(new), path)
        elif old != new:
            print(f"  STR DIFF {path}: {old[:40]!r} vs {new[:40]!r}")
    elif isinstance(old, (int, float)) and isinstance(new, (int, float)):
        if abs(old - new) > 1e-9:
            print(f"  NUM DIFF {path}: {old} vs {new}")
            ok = False
    return ok


for name in ("cassini_data.js", "moons_data.js"):
    p_new = os.path.join(DATA, name)
    p_old = p_new + ".prev"
    if not os.path.exists(p_old):
        print(f"{name}: no .prev, skip")
        continue
    print(f"===== {name} =====")
    a = load_js(p_old)
    b = load_js(p_new)
    walk(a, b)
    print()
print("done")
