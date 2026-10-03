# -*- coding: utf-8 -*-
"""probe_cov.py —— 打印 -82 的 SPK 覆盖区间，确认发射段是否缺失/外推。"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spiceypy as sp
import bake_spice as B
J2000_UNIX = 946728000
B.load_kernels()

cov = sp.spkcov(sp.spkobj('data_raw/spice_kernels/cosp_1000.bsp')[0] if False else None, -82) if False else None
# 直接用 spkcov 需要文件路径；改遍历已加载内核
import glob
files = glob.glob('data_raw/spice_kernels/*.bsp') + glob.glob('data_raw/**/*.bsp', recursive=True)
files = sorted(set(files))
print('bsp files', len(files))
for f in files:
    try:
        ids = sp.spkobj(f)
    except Exception as e:
        continue
    if -82 not in set(ids):
        continue
    try:
        cov = sp.spkcov(f, -82)
        for i in range(0, len(cov), 2):
            a, b = cov[i], cov[i+1]
            print(f'{os.path.basename(f):50s} {a:14.1f} .. {b:14.1f}  ({time.strftime("%Y-%m-%d", time.gmtime(a+J2000_UNIX))} .. {time.strftime("%Y-%m-%d", time.gmtime(b+J2000_UNIX))})')
    except Exception as e:
        print(f, 'err', e)
