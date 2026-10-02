# -*- coding: utf-8 -*-
"""probe_att_frame.py — 确定 Eyes dynamo quat 四元数的坐标系约定。

用"对地通信"保持段（姿态四元数几乎不变、HGA 必指地球）对照历表地球方向，
穷举: 参考系(赤道/黄道) × 存储顺序((x,y,z,w)/(w,x,y,z)) × 旋向(主动 q v q*/被动 q* v q)
      × 体轴(±X/±Y/±Z)，找 median 失准角 ≈ 0 的组合。
"""
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bake_data import load_points, pos_at, cassini_pos, OBLIQUITY  # noqa

RAW = os.path.join(HERE, "..", "data_raw", "sc_cassini_quat")


def load_att():
    pkl = os.path.join(RAW, "points.pkl")
    if os.path.exists(pkl):
        import pickle
        with open(pkl, "rb") as f:
            return pickle.load(f)
    # 回退：解析已下载的局部叶子块
    pts = []
    for name in sorted(os.listdir(RAW)):
        if not name.endswith(".dyn") or name == "def.dyn":
            continue
        d = open(os.path.join(RAW, name), "rb").read()
        if len(d) < 6 or d[0] != 1:
            continue
        n = struct.unpack_from("<i", d, 1)[0]
        o = 5
        for _ in range(n):
            t = struct.unpack_from("<d", d, o)[0]
            q = struct.unpack_from("<4d", d, o + 8)
            pts.append((t,) + q)
            o += 40
    pts.sort(key=lambda p: p[0])
    return pts


def ecl_to_eq(v):
    x, y, z = v
    ce, se = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
    return (x, y * ce - z * se, y * se + z * ce)


def quat_rot(q, v):
    """主动旋转 v' = q v q*，q=(x,y,z,w)"""
    qx, qy, qz, qw = q
    px, py, pz = v
    tx = 2 * (qy * pz - qz * py)
    ty = 2 * (qz * px - qx * pz)
    tz = 2 * (qx * py - qy * px)
    return (px + qw * tx + (qy * tz - qz * ty),
            py + qw * ty + (qz * tx - qx * tz),
            pz + qw * tz + (qx * ty - qy * tx))


def quat_conj(q):
    return (-q[0], -q[1], -q[2], q[3])


def ang(a, b):
    d = sum(x * y for x, y in zip(a, b))
    d = max(-1.0, min(1.0, d))
    return math.degrees(math.acos(d))


def unit(v):
    n = math.sqrt(sum(x * x for x in v))
    return (v[0] / n, v[1] / n, v[2] / n)


def main():
    pts = load_att()
    print(f"attitude samples: {len(pts)}  "
          f"ET {pts[0][0]:.0f}..{pts[-1][0]:.0f}")
    if len(pts) < 4:
        print("not enough data yet")
        return

    earth_pts = load_points("earth/sun/orb")["points"]

    # 保持段样本：与前后样本夹角都 < 0.3°（姿态不变 → 必为对地或其它固定指向）
    def qang(a, b):
        dot = abs(sum(x * y for x, y in zip(a[1:], b[1:])))
        return math.degrees(2 * math.acos(min(1.0, dot)))

    holds = []
    for i in range(1, len(pts) - 1):
        if qang(pts[i - 1], pts[i]) < 0.3 and qang(pts[i], pts[i + 1]) < 0.3:
            holds.append(pts[i])
    # 去重（相邻保持样本取一个）
    dedup = []
    for p in holds:
        if not dedup or p[0] - dedup[-1][0] > 86400:
            dedup.append(p)
    holds = dedup[:60]
    print(f"hold samples used: {len(holds)}")

    AXES = {"+X": (1, 0, 0), "-X": (-1, 0, 0), "+Y": (0, 1, 0),
            "-Y": (0, -1, 0), "+Z": (0, 0, 1), "-Z": (0, 0, -1)}

    results = {}
    for p in holds:
        t = p[0]
        q_raw = p[1:]
        q_xyz = q_raw                       # 读取顺序 (x,y,z,w)
        q_wxyz = (q_raw[1], q_raw[2], q_raw[3], q_raw[0])  # (w,x,y,z) 解释
        cass = cassini_pos(t)               # 黄道系
        earth = pos_at("earth/sun/orb", t)  # 黄道系
        d_ecl = unit((earth[0] - cass[0], earth[1] - cass[1], earth[2] - cass[2]))
        d_eq = ecl_to_eq(d_ecl)
        for fname, dvec in (("eq", d_eq), ("ecl", d_ecl)):
            for oname, q in (("xyzw", q_xyz), ("wxyz", q_wxyz)):
                for sname, qq in (("act", q), ("pas", quat_conj(q))):
                    for aname, ax in AXES.items():
                        v = quat_rot(qq, ax)
                        a = ang(v, dvec)
                        key = (fname, oname, sname, aname)
                        results.setdefault(key, []).append(a)

    rank = sorted(results.items(), key=lambda kv: sorted(kv[1])[len(kv[1]) // 2])
    print("\nbest 12 combos by median misalignment:")
    for key, arr in rank[:12]:
        arr2 = sorted(arr)
        med = arr2[len(arr2) // 2]
        p90 = arr2[int(len(arr2) * 0.9)]
        print(f"  frame={key[0]:3s} order={key[1]} sense={key[2]} axis={key[3]:2s}"
              f"  median={med:8.3f}°  p90={p90:8.3f}°  max={arr2[-1]:8.3f}°")


if __name__ == "__main__":
    main()
