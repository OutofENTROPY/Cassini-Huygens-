# -*- coding: utf-8 -*-
"""prototype_smooth.py — 验证主轨迹 f32 量化噪声的加载时 SG 平滑方案。

用 data/cassini_data.js 的真实烘焙数据，评估不同 (M, order) 下：
  1. dt=60s 段二阶差分散布（纯噪声，目标 <10 km）
  2. dt=3600s 段二阶差分中位数（真实曲率信号，须保留）
  3. 平滑位移 |Δ| 分布（不能过大）
  4. 首末顶点保持
"""
import base64
import json
import re
import struct
import sys
import time

import numpy as np


def load_trail():
    src = open("data/cassini_data.js", encoding="utf-8").read()
    m = re.search(r"window\.CASSINI_DATA\s*=\s*(\{.*\});?\s*$", src, re.S)
    data = json.loads(m.group(1).rstrip(";\n"))
    sc = data["spacecraft"]["cassini"]
    tt = base64.b64decode(sc["trailT"])
    trailT = np.array(struct.unpack("<%dd" % (len(tt) // 8), tt))
    xyz = base64.b64decode(sc["trail"])
    v = np.array(struct.unpack("<%df" % (len(xyz) // 4), xyz), dtype=np.float64)
    n = sc["trailN"]
    return trailT[:n], v.reshape(n, 3).copy()  # copy: 可写（模拟 JS 端 f64 数组）


def sg_weights(M, order):
    """SG 系数表：halfWidth 1..M 各一套（边界收缩用）。返回 dict m -> w (2m+1,)"""
    out = {}
    for m in range(1, M + 1):
        n = 2 * m + 1
        j = np.arange(-m, m + 1, dtype=np.float64)
        deg = min(order, n - 1)
        A = np.vander(j, deg + 1, increasing=True)
        # 行 = 评估点，取常数额行 = 在 0 处求值
        pinv = np.linalg.pinv(A)
        out[m] = pinv[0]
    return out


def split_runs(trailT, ratio=3.0):
    """节拍突变处分段（段内网格近似均匀，SG uniform 权重才成立）"""
    n = len(trailT)
    dt = np.diff(trailT)
    cuts = [0]
    for i in range(1, n - 1):
        a, b = dt[i - 1], dt[i]
        if b > a * ratio or b < a / ratio:
            cuts.append(i + 1)
    cuts.append(n)
    return cuts


def smooth(trailT, V, M, order, runs=True):
    n = len(trailT)
    tables = sg_weights(M, order)
    out = V.copy()
    t0 = time.time()
    if runs:
        cuts = split_runs(trailT)
    else:
        cuts = [0, n]
    nseg = len(cuts) - 1
    for s in range(nseg):
        a, b = cuts[s], cuts[s + 1]  # [a, b)
        L = b - a
        for i in range(a, b):
            m = min(M, i - a, b - 1 - i)
            if m == 0:
                continue
            w = tables[m]
            out[i] = w @ V[i - m : i + m + 1]
    print(f"  smooth M={M} order={order} runs={nseg}: {time.time()-t0:.2f}s")
    return out


def second_diff_stats(trailT, V, t0, t1):
    lo = np.searchsorted(trailT, t0)
    hi = np.searchsorted(trailT, t1)
    seg = V[lo : hi + 1]
    sd = np.linalg.norm(seg[2:] - 2 * seg[1:-1] + seg[:-2], axis=1)
    return np.median(sd), np.percentile(sd, 90), sd.max()


def chord_dev(trailT, V, t0, t1):
    """内部顶点相对 10 顶点弦的横向残差（锯齿直观量）"""
    lo = np.searchsorted(trailT, t0)
    seg = V[lo : lo + 11]
    d = seg[-1] - seg[0]
    L = np.linalg.norm(d)
    lat = np.linalg.norm(np.cross(seg - seg[0], d), axis=1) / L
    return L, lat[1:-1].max()


def main():
    trailT, V = load_trail()
    n = len(trailT)
    print(f"n={n}  t=[{trailT[0]:.0f},{trailT[-1]:.0f}]")

    # 60s 段（2007-09，土星轨道，噪声主导）
    T60A = (trailT[92725], trailT[92725] + 3600)
    # 60s 段（Grand Finale 近土点）
    i_gf = np.searchsorted(trailT, 552000000)
    # 3600s 段（土星巡航轨道，曲率信号）
    T3600 = (trailT[142136], trailT[142136] + 6 * 3600)
    # 6h 段（行星际巡航）
    i_cr = np.searchsorted(trailT, 100e6)

    for M, order in [(0, 0), (8, 3), (12, 3), (16, 3), (8, 2)]:
        if M == 0:
            S = V
            label = "raw       "
        else:
            S = smooth(trailT, V, M, order)
            label = f"M={M:<2} o={order} "
        m60, p90_60, mx60 = second_diff_stats(trailT, S, *T60A)
        m36, p90_36, mx36 = second_diff_stats(trailT, S, *T3600)
        L1, dev1 = chord_dev(trailT, S, *T60A)
        L2, dev2 = chord_dev(trailT, S, *T3600)
        shift = np.linalg.norm(S - V, axis=1)
        print(
            f"{label} sd60 med/p90/max={m60:7.2f}/{p90_60:7.2f}/{mx60:8.2f}  "
            f"sd3600 med={m36:8.2f}  dev60={dev1:7.2f}km/{L1:.0f}km  dev3600={dev2:7.2f}km/{L2:.0f}km  "
            f"shift med/p99/max={np.median(shift):6.2f}/{np.percentile(shift,99):6.2f}/{shift.max():7.2f} km"
        )
    # Grand Finale 60s 段检查（近土点真实曲率 60s 下 ~14 km，应保留）
    print("GF window cadence:", np.median(np.diff(trailT[i_gf : i_gf + 50])))


if __name__ == "__main__":
    main()
