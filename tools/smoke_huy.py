# -*- coding: utf-8 -*-
"""smoke_huy.py — 惠更斯链路冒烟测试（仅用本地已有 SCPSE 内核覆盖分离→进入窗口）。
验证：v_rel0 差分、网格预计算、RK4 相对积分、打靶收敛、relCass/relSat/relTit 打包。"""
import os
import sys
import calendar
import base64

import numpy as np
import spiceypy as sp

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_spice as B  # noqa: E402  （导入即装载 LSK/PCK + TimeMap/SaturnBody）

COSP = B.COSP
sp.furnsh(os.path.join(COSP, "naif0012.tls"))
sp.furnsh(os.path.join(COSP, "pck00010.tpc"))
sp.furnsh(os.path.join(COSP, "cpck31Oct2017.tpc"))
HAVE = []
for name in ("050105R_SCPSE_04247_04336.bsp", "050214R_SCPSE_04336_05015.bsp"):
    p = os.path.join(COSP, name)
    if os.path.exists(p):
        sp.furnsh(p)
        HAVE.append(name)
    else:
        print("MISSING", name)
if len(HAVE) < 2:
    raise SystemExit("缺少覆盖分离→进入窗口的 SCPSE 内核")

# 数据域（窗口）
u0 = calendar.timegm((2004, 12, 20, 0, 0, 0)) - B.J2000_UNIX
u1 = calendar.timegm((2005, 1, 15, 0, 0, 0)) - B.J2000_UNIX
print(f"smoke window: {u0:.0f}..{u1:.0f}")

B.SB.build_grid(u0, u1)
moons, moons_raw = B.bake_moons(u0, u1)
huy = B.bake_huygens(moons_raw)

# 打包行数与时间域
for k in ("relCass", "relSat", "relTit"):
    t = np.frombuffer(base64.b64decode(huy[k]["t"]), "<f8")
    d = np.frombuffer(base64.b64decode(huy[k]["d"]), "<f4")
    print(f"  {k}: {huy[k]['n']} rows, t {t[0]:.0f}..{t[-1]:.0f}, dbytes {d.size * 4}")
print("SMOKE OK")
