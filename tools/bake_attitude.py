# -*- coding: utf-8 -*-
"""bake_attitude.py — 把 NASA Eyes dynamo sc_cassini/quat 姿态四元数烘焙成前端数据。

输入: data_raw/sc_cassini_quat/points.pkl（tools/fetch_attitude.py 下载合并，
      ET 秒(J2000) + 四元数 (w,x,y,z)，ICRF 赤道系，主动旋转 q·v·q*）
输出: data/attitude_data.js — window.CASSINI_ATT = { meta, n, t(b64 f64 ET秒), q(b64 f32 xyzw 场景系) }

坐标链（全部主动旋转；Hamilton 乘法 q1⊗q2 = 先作用 q2 再 q1）:
  GLB 模型体 v_glb --Q_GLB--> 场景体 S（+Z=HGA，+X=RTG，−Y=Huygens 侧，见 js/cassini_model.js）
  v_glb --M--> 姿态体 B（Eyes 官方校准 model.rotate=[{x:-90},{z:180}] → R_z180·R_x−90；
                实测: GLB+Y(HGA)→−Z_B、GLB−Z(RTG)→−Y_B、GLB+X(Huygens)→−X_B）
  v_B --q(t)--> ICRF 赤道系
  ICRF 赤道系 --A--> 场景 three 系（eq→ecl: R_x(−ε)；ecl→three: (x,y,z)→(x,z,−y)=R_x(−90°)）

  场景朝向: Q_scene(t) = A ⊗ q(t) ⊗ M ⊗ Q_GLB⁻¹

内建校验（打印统计）:
  1) 对地保持段: Q_scene·(+Z)（HGA）与场景系地球方向夹角 ~0°
  2) SOI 点火窗口: HGA 与速度方向夹角 ~0°
  3) 惠更斯中继窗口: HGA 与 Titan 方向夹角 ~0°
  4) Grand Finale 防护窗口: HGA 与速度方向夹角 ~0°
  5) 抽稀后 vs 原始数据最大角偏差
"""
import base64
import math
import os
import pickle
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bake_data import load_points, pos_at, cassini_pos, OBLIQUITY, J2000_S  # noqa

RAW = os.path.join(HERE, "..", "data_raw", "sc_cassini_quat")
OUT = os.path.join(HERE, "..", "data", "attitude_data.js")

# ---- 参数 ----
ANG_KEEP = 0.20     # 与上一保留样本角距阈值（°）——保持段抽稀（slerp 偏差 ≤0.05°，亚像素）
DT_KEEP = 12 * 3600  # 保持段最长插值间隔（s）
J2000_S_LOCAL = 946728000


def et_of(utc_str):
    import calendar
    t = time.strptime(utc_str, "%Y-%m-%dT%H:%M:%SZ")
    return calendar.timegm(t) - J2000_S_LOCAL


# ---- 常量四元数（(x,y,z,w) 内部表示，Hamilton 乘法）----
def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qconj(a):
    return (-a[0], -a[1], -a[2], a[3])


def qaxis(axis, deg):
    n = math.sqrt(sum(v * v for v in axis))
    x, y, z = [v / n for v in axis]
    h = math.radians(deg) / 2
    s = math.sin(h)
    return (x * s, y * s, z * s, math.cos(h))


def qrot(q, v):
    qx, qy, qz, qw = q
    px, py, pz = v
    tx = 2 * (qy * pz - qz * py)
    ty = 2 * (qz * px - qx * pz)
    tz = 2 * (qx * py - qy * px)
    return (px + qw * tx + (qy * tz - qz * ty),
            py + qw * ty + (qz * tx - qx * tz),
            pz + qw * tz + (qx * ty - qy * tx))


# Q_GLB（js/cassini_model.js 的行主序矩阵 → (x,y,z,w)）
#  [0 0 -1; -1 0 0; 0 1 0]
def mat_to_quat(m):
    """m: 3x3 行主序（active）→ (x,y,z,w)"""
    m00, m01, m02, m10, m11, m12, m20, m21, m22 = m
    tr = m00 + m11 + m22
    if tr > 0:
        s = math.sqrt(tr + 1) * 2
        w = 0.25 * s
        x = (m21 - m12) / s
        y = (m02 - m20) / s
        z = (m10 - m01) / s
    elif m00 > m11 and m00 > m22:
        s = math.sqrt(1 + m00 - m11 - m22) * 2
        w = (m21 - m12) / s
        x = 0.25 * s
        y = (m01 + m10) / s
        z = (m02 + m20) / s
    elif m11 > m22:
        s = math.sqrt(1 + m11 - m00 - m22) * 2
        w = (m02 - m20) / s
        x = (m01 + m10) / s
        y = 0.25 * s
        z = (m12 + m21) / s
    else:
        s = math.sqrt(1 + m22 - m00 - m11) * 2
        w = (m10 - m01) / s
        x = (m02 + m20) / s
        y = (m12 + m21) / s
        z = 0.25 * s
    return (x, y, z, w)


Q_GLB = mat_to_quat((0, 0, -1,
                     -1, 0, 0,
                     0, 1, 0))
# M = R_z(180°) ⊗ R_x(−90°)（GLB 模型体 → 姿态体 B）
M = qmul(qaxis((0, 0, 1), 180), qaxis((1, 0, 0), -90))
C = qmul(M, qconj(Q_GLB))                       # 场景体 S → 姿态体 B
EPS = math.degrees(OBLIQUITY)
A = qaxis((1, 0, 0), -90 - EPS)                 # ICRF 赤道系 → three 系


def ecl_to_three(v):
    return (v[0], v[2], -v[1])


def unit(v):
    n = math.sqrt(sum(x * x for x in v))
    return (v[0] / n, v[1] / n, v[2] / n)


def ang_deg(a, b):
    # abs: 四元数双覆盖（q 与 −q 同一旋转），符号翻转不算偏差
    d = abs(max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b)))))
    return math.degrees(math.acos(d))


def slerp(qa, qb, u):
    dot = sum(x * y for x, y in zip(qa, qb))
    b = list(qb)
    if dot < 0:
        b = [-v for v in b]
        dot = -dot
    if dot > 0.9995:
        r = [qa[i] + (b[i] - qa[i]) * u for i in range(4)]
    else:
        th = math.acos(min(1.0, dot))
        st = math.sin(th)
        wa = math.sin((1 - u) * th) / st
        wb = math.sin(u * th) / st
        r = [qa[i] * wa + b[i] * wb for i in range(4)]
    n = math.sqrt(sum(v * v for v in r))
    return [v / n for v in r]


def main():
    with open(os.path.join(RAW, "points.pkl"), "rb") as f:
        raw = pickle.load(f)
    raw.sort(key=lambda p: p[0])
    # 去重（分块边界可能重复同一时刻）
    pts = []
    for p in raw:
        if pts and p[0] == pts[-1][0]:
            continue
        pts.append(p)
    n_raw = len(pts)
    t0, t1 = pts[0][0], pts[-1][0]
    print(f"raw samples: {n_raw}  ET {t0:.0f}..{t1:.0f} "
          f"({time.strftime('%Y-%m-%d', time.gmtime(t0 + J2000_S))} .. "
          f"{time.strftime('%Y-%m-%d', time.gmtime(t1 + J2000_S))})")
    print(f"constants: Q_GLB={tuple(round(v,4) for v in Q_GLB)}")
    print(f"           M     ={tuple(round(v,4) for v in M)}")
    print(f"           C     ={tuple(round(v,4) for v in C)}")
    print(f"           A     ={tuple(round(v,4) for v in A)}")

    # 场景系四元数 Q_scene = A ⊗ q ⊗ C（three.js (x,y,z,w)）
    conv = []
    for p in pts:
        w, x, y, z = p[1], p[2], p[3], p[4]
        q = qmul(A, qmul((x, y, z, w), C))
        conv.append((p[0], q))

    # ---- 校验 1: 对地保持段 HGA vs Earth ----
    earth_err = []
    for i in range(1, n_raw - 1):
        ta, tb = conv[i - 1][0], conv[i + 1][0]
        qa, qb = conv[i - 1][1], conv[i + 1][1]
        if ang_deg(qa, qb) > 0.3:      # 只取姿态基本不变的样本
            continue
        t = conv[i][0]
        hga = qrot(conv[i][1], (0, 0, 1))
        e = pos_at("earth/sun/orb", t)
        c = cassini_pos(t)
        d = ecl_to_three((e[0] - c[0], e[1] - c[1], e[2] - c[2]))
        if sum(x * x for x in d) < 1:
            continue
        earth_err.append(ang_deg(hga, unit(d)))
    earth_err.sort()
    if earth_err:
        m = earth_err[len(earth_err) // 2]
        frac = sum(1 for a in earth_err if a < 5.0) / len(earth_err)
        print(f"check1 Earth-point holds: n={len(earth_err)}  "
              f"median={m:.3f}°  <5°: {frac*100:.0f}%  (其余为非对地保持段)")

    # ---- 校验 2/3/4: 关键事件窗口 ----
    def hga_err(t, target_fn):
        hga = qrot(qat(conv, t), (0, 0, 1))
        d = target_fn(t)
        return ang_deg(hga, unit(d)) if d else None

    def vel_dir(t):
        a = cassini_pos(t - 300)
        b = cassini_pos(t + 300)
        return ecl_to_three((b[0] - a[0], b[1] - a[1], b[2] - a[2]))

    def titan_dir(t):
        ti = pos_at("titan/saturn/orb", t)
        sa = pos_at("saturn/sun/orb", t)
        c = cassini_pos(t)
        return ecl_to_three((ti[0] + sa[0] - c[0], ti[1] + sa[1] - c[1], ti[2] + sa[2] - c[2]))

    for label, times, tfn in (
            ("SOI burn HGA vs velocity (01:30)", [et_of("2004-07-01T01:30:00Z")], vel_dir),
            ("SOI burn HGA vs velocity (02:20)", [et_of("2004-07-01T02:20:00Z")], vel_dir),
            ("relay HGA vs Titan (05:30)", [et_of("2005-01-14T05:30:00Z")], titan_dir),
            ("relay HGA vs Titan (12:00)", [et_of("2005-01-14T12:00:00Z")], titan_dir),
    ):
        for t in times:
            if not (t0 <= t <= t1):
                print(f"check {label}: ET {t:.0f} outside data coverage")
                continue
            e = hga_err(t, tfn)
            print(f"check {label}: {e:.2f}°")

    # Grand Finale 环缝穿越（与 scene.js scanRingCrossings 同判据）:
    # 轨迹相对土星在土星赤道面法向上的坐标过零，且穿越半径 < 主环内缘 74500 km
    def saturn_pole_ecl():
        ra, dec = math.radians(40.589), math.radians(83.537)   # ICRF 北极指向
        pe = (math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra),
              math.sin(dec))
        ce, se = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
        return (pe[0], pe[1] * ce + pe[2] * se, -pe[1] * se + pe[2] * ce)

    pole = saturn_pole_ecl()
    t_lo, t_hi = et_of("2017-04-22T00:00:00Z"), t1
    tc, crossings = t_lo, []
    step = 300.0
    prev_z = None
    while tc <= t_hi:
        c = cassini_pos(tc)
        s = pos_at("saturn/sun/orb", tc)
        z = (c[0] - s[0]) * pole[0] + (c[1] - s[1]) * pole[1] + (c[2] - s[2]) * pole[2]
        if prev_z is not None and (z < 0) != (prev_z < 0):
            tm = tc - step / 2
            c2 = cassini_pos(tm)
            s2 = pos_at("saturn/sun/orb", tm)
            r = math.sqrt((c2[0] - s2[0]) ** 2 + (c2[1] - s2[1]) ** 2 + (c2[2] - s2[2]) ** 2)
            if r < 74500:
                crossings.append(tm)
        prev_z = z
        tc += step
    print(f"finale ring-plane crossings found: {len(crossings)}")
    if crossings:
        tm0 = crossings[1] if len(crossings) > 1 else crossings[0]
        for off in (-60, -30, 0, 30, 60):
            e = hga_err(tm0 + off * 60, vel_dir)
            u = time.strftime('%m-%d %H:%M', time.gmtime(tm0 + off * 60 + J2000_S))
            print(f"  finale HGA vs velocity @{u}Z ({off:+d}min): {e:.2f}°")

    # ---- 抽稀 ----
    kept = [conv[0]]
    last_ang = conv[0]
    for t, q in conv[1:]:
        da = ang_deg(last_ang[1], q)
        dt = t - last_ang[0]
        if da > ANG_KEEP or dt > DT_KEEP:
            kept.append((t, q))
            last_ang = (t, q)
    # 截到场景时间域（cassini_data.js meta.tEnd ≈ 2017-09-15 任务终点）：
    # Eyes 数据在 2.6 年空档后还有 2020 年的延拓尾，场景不可达
    T_END_SCENE = 558744064.185
    while len(kept) > 1 and kept[-1][0] > T_END_SCENE:
        kept.pop()
    if kept[-1][0] < conv[-1][0] and conv[-1][0] <= T_END_SCENE:
        kept.append(conv[-1])
    n_kept = len(kept)
    # 抽稀误差: 原始样本相对 slerp(保留端点) 的最大角偏差
    max_err, err_sum, err_n = 0.0, 0.0, 0
    j = 0
    for t, q in conv:
        while j + 1 < len(kept) and kept[j + 1][0] < t:
            j += 1
        if j + 1 >= len(kept):
            break
        ta, qa = kept[j]
        tb, qb = kept[j + 1]
        if tb <= ta:
            continue
        u = (t - ta) / (tb - ta)
        qi = slerp(qa, qb, u)
        e = ang_deg(qi, q)
        err_sum += e
        err_n += 1
        if e > max_err:
            max_err = e
    print(f"decimation: {n_raw} -> {n_kept} ({100*n_kept/n_raw:.0f}%)  "
          f"interp err: max={max_err:.4f}° mean={err_sum/max(err_n,1):.4f}°")

    # ---- 输出 ----
    ts = struct.pack(f"<{n_kept}d", *[k[0] for k in kept])
    qs = b"".join(struct.pack("<4f", *k[1]) for k in kept)
    js = ("/* 由 tools/bake_attitude.py 生成 — 来源: NASA Eyes dynamo sc_cassini/quat"
          "（NAIF SPICE CK 烘焙）\n"
          " * 真实姿态四元数，场景系 (x,y,z,w)，t = ET 秒(J2000)。"
          "坐标链见 bake_attitude.py 头注释。 */\n"
          "window.CASSINI_ATT = {\n"
          f'  meta: {{ j2000Ms: {J2000_S * 1000}, tStart: {t0:.3f}, tEnd: {t1:.3f},'
          f' generated: "{time.strftime("%Y-%m-%d")}",'
          f' source: "NASA Eyes on the Solar System / NAIF SPICE CK" }},\n'
          f"  n: {n_kept},\n"
          f'  t: "{base64.b64encode(ts).decode("ascii")}",\n'
          f'  q: "{base64.b64encode(qs).decode("ascii")}",\n'
          "};\n")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    print(f"wrote {OUT}  ({os.path.getsize(OUT)/1e6:.2f} MB)")


def qat(conv, t):
    """conv 中时刻 t 的四元数（线性 slerp）"""
    lo, hi = 0, len(conv) - 1
    if t <= conv[0][0]:
        return conv[0][1]
    if t >= conv[-1][0]:
        return conv[-1][1]
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if conv[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    ta, qa = conv[lo]
    tb, qb = conv[hi]
    u = (t - ta) / (tb - ta)
    return slerp(qa, qb, u)


if __name__ == "__main__":
    main()
