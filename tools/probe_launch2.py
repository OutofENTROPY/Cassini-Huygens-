# -*- coding: utf-8 -*-
"""probe_launch2.py —— 直接查 SPICE：发射时刻 Cassini 相对地球的位置，
验证 trail[0] 相对地球的偏差（前端表现为"轨迹起点远离地球"）。"""
import sys, os, time, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import spiceypy as sp
import bake_spice as B

J2000_UNIX = 946728000
B.load_kernels()

u0 = -69820431.6100098
print('u0 =', u0)
print(f'{"u":>14} {"UTC":>20} {"helio|r|":>14} {"|cass-earth|":>12} {"|cass-sun-ecl|":>14}')
for du in [0, 60, 3600, 86400, 86400*2, 86400*3, 86400*7]:
    u = u0 + du
    st, _ = sp.spkezr('CASSINI', u, 'J2000', 'NONE', 'SUN')
    ps = np.array(st[:3])
    st2, _ = sp.spkezr('EARTH', u, 'J2000', 'NONE', 'SUN')
    pe = np.array(st2[:3])
    st3, _ = sp.spkezr('CASSINI', u, 'J2000', 'NONE', 'EARTH')
    dge = float(np.linalg.norm(np.array(st3[:3])))
    ymd = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(u + J2000_UNIX))
    print(f'{u:14.0f} {ymd:>20} {np.linalg.norm(ps):14.0f} {dge:12.0f} {np.linalg.norm(ps-pe):14.0f}')

# 对比烘焙 trail 首点
import json, base64, struct
raw = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'cassini_data.js'), 'r', encoding='utf-8').read()
js = json.loads(raw[raw.index('=') + 1:].rstrip().rstrip(';'))
cass = js['spacecraft']['cassini']
buf = base64.b64decode(cass['trailT']); tt = struct.unpack('<d', buf[:8])[0]
bufp = base64.b64decode(cass['trail']); xyz = struct.unpack('<3f', bufp[:12])
print('\nbaked trail[0]: t =', tt, ' ecl-xyz =', tuple(round(v) for v in xyz))
print('baked trail[1]: t =', struct.unpack('<d', buf[8:16])[0],
      ' ecl-xyz =', tuple(round(v) for v in struct.unpack('<3f', bufp[12:24])))
print('baked trail[-1]: t =', struct.unpack('<d', buf[-8:])[0])

# SPICE 在 t0 的真值（黄道）
st, _ = sp.spkezr('CASSINI', tt, 'J2000', 'NONE', 'SUN')
true_ecl = B.eq_to_ecl((st[0], st[1], st[2]))
print('SPICE  trail[0] truth ecl =', tuple(round(v) for v in true_ecl))
st2, _ = sp.spkezr('EARTH', tt, 'J2000', 'NONE', 'SUN')
earth_ecl = B.eq_to_ecl((st2[0], st2[1], st2[2]))
print('SPICE  earth  ecl =', tuple(round(v) for v in earth_ecl))
print('SPICE  delta (cass-earth) ecl =', tuple(round(a-b) for a, b in zip(true_ecl, earth_ecl)))
print('baked  delta (cass-earth) ecl =', tuple(round(a-b) for a, b in zip(xyz, earth_ecl)))
print('delta |cass-earth| SPICE =', round(math.dist(true_ecl, earth_ecl)))
print('delta |cass-earth| baked =', round(math.dist(xyz, earth_ecl)))
