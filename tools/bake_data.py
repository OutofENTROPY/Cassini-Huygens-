# -*- coding: utf-8 -*-
"""bake_data.py — 把 data_raw/ 里的 dynamo 历表烘焙成前端可直接使用的
日心坐标位置序列（data/cassini_data.js），并做几何校验（飞掠近距离、连续性）。

输出格式:
window.CASSINI_DATA = {
  meta: { j2000Ms, tStart, tEnd, generated },
  bodies: { <name>: { radiusKm, segs: [{t0, dt, n, d(base64 float32 xyz)}] } },
  spacecraft: { cassini: { segs: [...] } }
}
坐标: 黄道系 km（前端映射到 three.js: x=x, y=z, z=-y）
"""
import base64
import bisect
import heapq
import math
import os
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data_raw")
OUT = os.path.join(HERE, "..", "data")
sys.path.insert(0, HERE)
from loadtree import load_entity  # noqa
from fetch_data import ALL, PLANETS, MOONS, CASSINI_LEGS  # noqa

J2000_S = 946728000
TMIN, TMAX = -1.263e8, 5.81e8  # 1996-01-01 .. 2018-06-01 (ET 秒)

RADII = {
    "sun": 696000.0, "mercury": 2439.7, "venus": 6051.8, "earth": 6371.0,
    "moon": 1737.4, "mars": 3389.5, "jupiter": 69911.0, "saturn": 58232.0,
    "uranus": 25362.0, "neptune": 24622.0,
    "titan": 2574.7, "enceladus": 252.1, "iapetus": 734.5, "rhea": 763.8,
    "dione": 561.4, "tethys": 531.1, "mimas": 198.2,
}

_cache = {}


def load_points(path):
    if path in _cache:
        return _cache[path]
    pts, stats = load_entity(path, TMIN, TMAX)
    if not pts:
        raise RuntimeError("no points for " + path)
    if stats["missing"]:
        print(f"  [warn] {path}: {stats['missing']} missing chunks (outside window or 404)")
    out = {"points": pts}
    _cache[path] = out
    return out


def solve_e(M, e):
    """稳健开普勒方程求解：e→1（近抛物线）时 Newton 的 1−e·cosE 分母趋零会发散，
    改用二分法（f(E)=E−e·sinE−M 在 [-π,π] 单调，必有唯一根）。"""
    if e < 1:
        M = (M + math.pi) % (2 * math.pi)
        if M < 0:
            M += 2 * math.pi
        M -= math.pi
        if e > 0.8:
            lo, hi = -math.pi, math.pi
            flo = lo - e * math.sin(lo) - M
            for _ in range(64):
                mid = 0.5 * (lo + hi)
                f = mid - e * math.sin(mid) - M
                if (f > 0) == (flo > 0):
                    lo, flo = mid, f
                else:
                    hi = mid
            return 0.5 * (lo + hi)
        E = M
        for _ in range(40):
            f = E - e * math.sin(E) - M
            E -= f / (1 - e * math.cos(E))
            if abs(f) < 1e-12:
                break
        return E
    # 双曲线（pioneer 约定 f = E − e·sinhE − M；f'(E)=1−e·coshE<0 单调递减）。
    # M<0 → 根在 E>0；M≥0 → 根在 E≤0。先指数扩展括根，再二分（绝对收敛）。
    if M < 0:
        lo, hi = 0.0, 1.0
        while hi - e * math.sinh(hi) - M > 0:
            hi *= 2
        for _ in range(80):
            mid = 0.5 * (lo + hi)
            if mid - e * math.sinh(mid) - M > 0:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)
    lo, hi = -1.0, 0.0
    while lo - e * math.sinh(lo) - M < 0:
        lo *= 2
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if mid - e * math.sinh(mid) - M > 0:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


OBLIQUITY = math.radians(23.4392911)  # 黄赤交角：数据为 ICRF 赤道系，需转到黄道系


def eq_to_ecl(v):
    """ICRF 赤道系 → 黄道系（绕 X 轴旋转 -ε）"""
    x, y, z = v
    ce, se = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
    return (x, y * ce + z * se, -y * se + z * ce)


def orb_pos(p, t):
    """单轨道根数点在时刻 t 的位置（ICRF 赤道系相对其中心天体，km）。
    注意：dynamo 文件中四元数存储顺序为 (w, x, y, z)，主动旋转 q v q*。
    e>=1（双曲线，a<0）按 pioneer 约定: x=a(e−coshE), y=a√(e²−1)·sinhE。"""
    _, a, e, n, M0, qw, qx, qy, qz = p
    M = M0 + n * (t - p[0])
    E = solve_e(M, e)
    if e < 1:
        b = a * math.sqrt(1 - e * e)
        px = a * (math.cos(E) - e)
        py = b * math.sin(E)
    else:
        px = a * (e - math.cosh(E))
        py = a * math.sqrt(e * e - 1) * math.sinh(E)
    tx = 2 * (qy * 0 - qz * py)
    ty = 2 * (qz * px - qx * 0)
    tz = 2 * (qx * py - qy * px)
    v = (px + qw * tx + (qy * tz - qz * ty),
         py + qw * ty + (qz * tx - qx * tz),
         0 + qw * tz + (qx * ty - qy * tx))
    return eq_to_ecl(v)


_join_cache = {}


def _join_epoch(p0, p1, pts_id, lo):
    """机动/飞掠区间内两条传播解的拼接时刻（区间 [t_real, t1] 上 |A-B| 最小处）
    与该处分歧。t_real = r_B 最后一个极值时刻：B = kf1 根数向后外推，其轨道
    r(t) 极值之前的半侧是探测器从未走过的虚构路径（真实路径当时在 A 上），
    拼过去会先俯冲再折返（SOI 近拱点即此情形）。"""
    key = (pts_id, lo)
    if key in _join_cache:
        return _join_cache[key]
    t0, t1 = p0[0], p1[0]
    n = 64
    rt = [sum(v * v for v in orb_pos(p1, t0 + (t1 - t0) * i / n)) for i in range(n + 1)]
    t_real = t0
    for i in range(1, n):
        if (rt[i] - rt[i - 1]) * (rt[i + 1] - rt[i]) < 0:
            t_real = t0 + (t1 - t0) * i / n
    best_t, best_d = t_real, None
    n2 = 40
    for i in range(n2 + 1):
        t = t_real + (t1 - t_real) * i / n2
        A = orb_pos(p0, t)
        Bp = orb_pos(p1, t)
        d = sum((A[k] - Bp[k]) ** 2 for k in range(3))
        if best_d is None or d < best_d:
            best_d, best_t = d, t
    lo_t = max(t_real, best_t - (t1 - t_real) / n2)
    hi_t = min(t1, best_t + (t1 - t_real) / n2)
    gr = 0.6180339887
    a_, b_ = lo_t, hi_t
    c_ = b_ - (b_ - a_) * gr
    d_ = a_ + (b_ - a_) * gr
    fc = sum((orb_pos(p0, c_)[k] - orb_pos(p1, c_)[k]) ** 2 for k in range(3))
    fd = sum((orb_pos(p0, d_)[k] - orb_pos(p1, d_)[k]) ** 2 for k in range(3))
    for _ in range(40):
        if fc < fd:
            b_, d_, fd = d_, c_, fc
            c_ = b_ - (b_ - a_) * gr
            fc = sum((orb_pos(p0, c_)[k] - orb_pos(p1, c_)[k]) ** 2 for k in range(3))
        else:
            a_, c_, fc = c_, d_, fd
            d_ = a_ + (b_ - a_) * gr
            fd = sum((orb_pos(p0, d_)[k] - orb_pos(p1, d_)[k]) ** 2 for k in range(3))
    best_t = 0.5 * (a_ + b_)
    best_d = math.sqrt(sum((orb_pos(p0, best_t)[k] - orb_pos(p1, best_t)[k]) ** 2 for k in range(3)))
    _join_cache[key] = (best_t, best_d, t_real)
    return _join_cache[key]


_interval_div_cache = {}

# 发射腿：相邻关键帧（~1 天）的传播解分歧是定轨更新而非机动（探测器和地球
# 都在加速运动中），join 桥接会以 ~40 km/s 在 10 分钟内冲过分歧点、并经
# Catmull 重采样放大成 85° 过冲拐点。整段线性混合的附加速度仅 ~0.35 km/s。
NO_JOIN_LEGS = {"sc_cassini/earth/launch/orb"}


def _interval_max_div(p0, p1, key):
    """区间内 5 个采样点（含两端与中点）的最大传播解分歧（缓存）。
    必须按区间分类而非逐点判断：两解在交叉点附近天然接近（|A-B|→min），
    逐点阈值恰好在最需要拼接的地方失效、落回线性混合产生折叠。"""
    if key in _interval_div_cache:
        return _interval_div_cache[key]
    t0, t1 = p0[0], p1[0]
    m = 0.0
    for i in range(5):
        t = t0 + (t1 - t0) * i / 4.0
        A = orb_pos(p0, t)
        Bp = orb_pos(p1, t)
        d = sum((A[k] - Bp[k]) ** 2 for k in range(3))
        if d > m:
            m = d
    m = math.sqrt(m)
    _interval_div_cache[key] = m
    return m


def pos_at(path, t):
    d = load_points(path)
    pts = d["points"]
    if len(pts) == 1:
        return orb_pos(pts[0], t)
    lo, hi = 0, len(pts) - 1
    if t <= pts[0][0]:
        return orb_pos(pts[0], t)
    if t >= pts[-1][0]:
        return orb_pos(pts[-1], t)
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    p0, p1 = pts[lo], pts[hi]
    al = (t - p0[0]) / (p1[0] - p0[0])
    A = orb_pos(p0, t)
    B = orb_pos(p1, t)
    # 密集关键帧区间（间隔 < 7 天）若两条传播解大幅分歧，说明区间跨机动/飞掠
    # 不连续（如 SOI 点火前后根数从双曲线跳到椭圆）：线性混合会把两条反向扫描
    # 的解插出锯齿假轨迹。改为在两解最接近处拼接（位置连续、速度折角 = 脉冲
    # 机动的正确形态）。稀疏区间（行星间隔数月）的分歧是正常漂移，保持混合。
    if path not in NO_JOIN_LEGS and (p1[0] - p0[0]) < 7 * 86400.0 and \
            _interval_max_div(p0, p1, (id(pts), lo)) > 2500.0:
        tj, dmin, t_real = _join_epoch(p0, p1, id(pts), lo)
        if dmin <= 25000.0:
            # 两支在真实半侧足够接近：拼接 + 短桥接（位置连续、速度折角 =
            # 脉冲机动的正确形态）。dmin 过大说明是定轨拟合更新而非机动，
            # 拼接会产生方向反转，退回线性混合。
            W = min(600.0, max(30.0, dmin / 40.0))
            b0, b1 = max(tj - W, t_real), tj + W
            if b1 <= b0:
                b1 = b0 + 30.0
            if t < b0:
                return A
            if t > b1:
                return B
            s = (t - b0) / (b1 - b0)
            s = s * s * (3 - 2 * s)  # smoothstep
            return (A[0] + (B[0] - A[0]) * s,
                    A[1] + (B[1] - A[1]) * s,
                    A[2] + (B[2] - A[2]) * s)
    return (A[0] + (B[0] - A[0]) * al,
            A[1] + (B[1] - A[1]) * al,
            A[2] + (B[2] - A[2]) * al)


# ---------- 卡西尼分腿（模块级，供验证脚本复用） ----------
CASSINI_LEGS = [
    "sc_cassini/earth/launch/orb", "sc_cassini/sun/1/orb",
    "sc_cassini/venus/flyby1/orb", "sc_cassini/sun/2/orb",
    "sc_cassini/venus/flyby2/orb", "sc_cassini/sun/3/orb",
    "sc_cassini/earth/flyby/orb", "sc_cassini/sun/4/orb",
    "sc_cassini/saturn/orb",
]
LEG_CENTERS = {
    "sc_cassini/earth/launch/orb": "earth/sun/orb",
    "sc_cassini/venus/flyby1/orb": "venus/sun/orb",
    "sc_cassini/venus/flyby2/orb": "venus/sun/orb",
    "sc_cassini/earth/flyby/orb": "earth/sun/orb",
    "sc_cassini/saturn/orb": "saturn/sun/orb",
}

# 真实引力影响球（SOI）半径 km —— 前端 scene.js 的 SOI_SHOW 与此逐值一致。
# 显示/隐藏相对轨迹、烘焙窗口边界均以进入/离开该范围为唯一判据。
SOI_RADII = {
    "venus": 6.169e5, "earth": 9.247e5, "jupiter": 4.82e7, "saturn": 5.45e7,
}

F32 = struct.Struct("<f")


def f32(v):
    """量化到 float32（与前端 b64ToFloat32 解码后的网格逐位一致）"""
    return F32.unpack(F32.pack(v))[0]


def smoothstep(x):
    x = 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)
    return x * x * (3 - 2 * x)


def conic_peri_kf(leg):
    """飞掠腿中最接近近拱点的根数关键帧（|M| 最小）。
    dynamo 飞掠腿时间域只有近掠前后数小时且出射臂为镜像假数据，
    但其根数本身就是一条完整的行星中心双曲线（近掠距离真实），
    按二体问题外推即可覆盖整个 SOI 穿越段。"""
    pts = load_points(leg)["points"]
    return min(pts, key=lambda p: abs(p[4]))


def conic_r(kf, t):
    v = orb_pos(kf, t)
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def conic_cross(kf, t_peri, r_soi, after):
    """双曲线 |r|=r_soi 的穿越时刻（after=False 入臂 / True 出臂，二分求解）"""
    span = 20 * 86400.0
    lo = t_peri if after else t_peri - span
    hi = t_peri + span if after else t_peri

    def f(t):
        return conic_r(kf, t) - r_soi

    # 端点同号说明 v_inf 极小、窗口比预估宽，逐倍加宽
    while (f(lo) > 0) == (f(hi) > 0):
        span *= 2
        lo = t_peri if after else t_peri - span
        hi = t_peri + span if after else t_peri
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if (f(mid) > 0) == (f(lo) > 0):
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)
_legs_cache = None


def cassini_legs():
    global _legs_cache
    if _legs_cache is None:
        _legs_cache = []
        for leg in CASSINI_LEGS:
            pts = load_points(leg)["points"]
            _legs_cache.append((leg, LEG_CENTERS.get(leg), pts[0][0], pts[-1][0]))
    return _legs_cache


def cassini_pos(t):
    for leg, center, t0, t1 in cassini_legs():
        if t0 <= t <= t1:
            c = pos_at(center, t) if center else (0.0, 0.0, 0.0)
            p = pos_at(leg, t)
            return (p[0] + c[0], p[1] + c[1], p[2] + c[2])
    best = None
    for leg, center, t0, t1 in cassini_legs():
        d = min(abs(t - t0), abs(t - t1))
        if best is None or d < best[0]:
            best = (d, leg, center, t0 if abs(t - t0) < abs(t - t1) else t1)
    _, leg, center, tt = best
    c = pos_at(center, tt) if center else (0.0, 0.0, 0.0)
    p = pos_at(leg, tt)
    return (p[0] + c[0], p[1] + c[1], p[2] + c[2])


def bake_segment(spec_path, center_path, t0, t1, dt):
    """把 spec_path 的本地位置加上 center_path 的位置，得到日心坐标序列"""
    out = []
    t = t0
    n = int(round((t1 - t0) / dt)) + 1
    for i in range(n):
        t = t0 + i * dt
        if center_path is None:
            c = (0.0, 0.0, 0.0)
        else:
            c = pos_at(center_path, t)
        p = pos_at(spec_path, t)
        out.append((p[0] + c[0], p[1] + c[1], p[2] + c[2]))
    return out


def elements_keyframes(path, cap=320):
    """导出降采样的轨道根数关键帧 (t, a, e, n, M, qw, qx, qy, qz)
    供前端按当前历元重建密切轨道椭圆（与 NASA Eyes 轨道线语义一致）。"""
    pts = load_points(path)["points"]
    stride = max(1, math.ceil(len(pts) / cap))
    sel = pts[::stride]
    if sel[-1][0] != pts[-1][0]:
        sel.append(pts[-1])
    eT = [p[0] for p in sel]
    eV = []
    for p in sel:
        eV.extend((p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]))
    return {
        "eT": base64.b64encode(struct.pack(f"<{len(eT)}d", *eT)).decode("ascii"),
        "eV": base64.b64encode(struct.pack(f"<{len(eV)}f", *eV)).decode("ascii"),
        "n": len(eT),
    }


def orbit_line(path, n=256):
    """由第一个轨道根数点生成一圈闭合轨道折线（局部坐标），Float32 base64"""
    p = load_points(path)["points"][0]
    _, a, e, nn, M0, qx, qy, qz, qw = p
    period = 2 * math.pi / nn
    pts = []
    for i in range(n):
        t = p[0] + period * i / n
        pts.append(orb_pos(p, t))
    return base64.b64encode(struct.pack(f"<{n*3}f", *[v for q in pts for v in q])).decode("ascii")


def catmull_resample(pts, factor=2):
    """Catmull-Rom 重采样：消除折线拐点（4D：时间+位置，保持时间映射）。
    首尾区间及空洞边界用线性/反射端点（复制端点的样条会扭曲时间网格）。
    去重产生的空洞（Δt 远超典型步长，其内有更细段填点）必须断开：
    样条跨越空洞会凭空制造空洞内的时间戳和横跨数百万公里的弦。"""
    if len(pts) < 3:
        return pts
    n = len(pts)
    dts = sorted(pts[i + 1][0] - pts[i][0] for i in range(n - 1))
    dt_med = dts[(n - 1) // 2]
    out = [pts[0]]
    prev_gap = True  # 首点视为边界
    for i in range(n - 1):
        gap = pts[i + 1][0] - pts[i][0] > 1.5 * dt_med
        if gap:
            out.append(pts[i + 1])
            prev_gap = True
            continue
        p1, p2 = pts[i], pts[i + 1]
        if i == 0 or prev_gap or i == n - 2:
            # 首段/末段/空洞后首段：线性，避免边界切线失真
            for k in range(1, factor):
                s = k / factor
                out.append(tuple(p1[d] + (p2[d] - p1[d]) * s for d in range(4)))
        else:
            p0 = pts[i - 1]
            p3 = pts[i + 2] if (i + 2 < n and pts[i + 2][0] - p2[0] <= 1.5 * dt_med) else None
            for k in range(factor):
                s = k / factor
                s2, s3 = s * s, s * s * s
                q = []
                for d in range(4):
                    a0 = -0.5 * s3 + s2 - 0.5 * s
                    a1 = 1.5 * s3 - 2.5 * s2 + 1.0
                    a2 = -1.5 * s3 + 2.0 * s2 + 0.5 * s
                    a3 = 0.5 * s3 - 0.5 * s2
                    v0 = p0[d]
                    v3 = p3[d] if p3 is not None else 2 * p2[d] - p1[d]
                    q.append(v0 * a0 + p1[d] * a1 + p2[d] * a2 + v3 * a3)
                out.append(tuple(q))
        prev_gap = False
    if out[-1][0] != pts[-1][0]:
        out.append(pts[-1])
    return out


def remove_spikes(pts, max_turn_deg=60.0, chord_ratio=0.30, passes=4):
    """剔除锯齿尖峰：turn 大 且 中间点 B 偏离 A–C 弦超过行程的 chord_ratio。
    真实弧线（含飞掠/SOI 近拱点急弯，曲率半径数万公里）在采样步长内的弦偏离
    只有 ~2%，而"冲出去再折回"的尖峰偏离接近半程长度（~0.5），判据可分。
    注意不能用 A→C/(A→B+B→C) 绕行比：真实弧线的绕行比 = cos(turn/2)，
    转角 >90° 时同样 <0.7，会误删真实弯曲（曾吃掉 SOI 近拱点 2.5 小时）。"""
    pts = list(pts)
    for _ in range(passes):
        changed = False
        out = [pts[0]]
        i = 1
        while i < len(pts) - 1:
            a = [pts[i][k] - pts[i - 1][k] for k in range(1, 4)]
            b = [pts[i + 1][k] - pts[i][k] for k in range(1, 4)]
            c = [pts[i + 1][k] - pts[i - 1][k] for k in range(1, 4)]
            la = math.sqrt(sum(v * v for v in a))
            lb = math.sqrt(sum(v * v for v in b))
            lc = math.sqrt(sum(v * v for v in c))
            if la > 1 and lb > 1 and lc > 1:
                d1 = sum(a[k] * b[k] for k in range(3)) / (la * lb)
                turn = math.degrees(math.acos(max(-1, min(1, d1))))
                if turn > max_turn_deg:
                    # B 到 A–C 弦的距离 = |a × c| / |c|
                    cr = (a[1] * c[2] - a[2] * c[1],
                          a[2] * c[0] - a[0] * c[2],
                          a[0] * c[1] - a[1] * c[0])
                    dev = math.sqrt(sum(v * v for v in cr)) / lc
                    if dev > chord_ratio * (la + lb):
                        i += 1  # 丢弃中间点（冲出去再折回的尖峰）
                        changed = True
                        continue
                    if turn > 150.0 and lb > 2.0 * la:
                        # 假起点折返：B 在 A–C 段外（A 位于 B、C 之间），
                        # 路径先冲出 |a| 再原路折回。真实动力学单步转角
                        # ≤15°，不会出现此形态（SOI 换支相位滞后产生）。
                        i += 1
                        changed = True
                        continue
            out.append(pts[i])
            i += 1
        out.append(pts[-1])
        pts = out
        if not changed:
            break
    return pts


def pack(segs):
    packed = []
    for (t0, dt, pts) in segs:
        arr = struct.pack(f"<{len(pts)*3}f",
                          *[v for p in pts for v in p])
        packed.append({
            "t0": round(t0, 1),
            "dt": round(dt, 1),
            "n": len(pts),
            "d": base64.b64encode(arr).decode("ascii"),
        })
    return packed


def main():
    import calendar

    def et(y, m, d, hh=0, mm=0):
        return calendar.timegm((y, m, d, hh, mm, 0)) - J2000_S

    def iso(t):
        return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000_S))

    os.makedirs(OUT, exist_ok=True)
    bodies = {}

    # ---------- 行星 ----------
    t0p, t1p = et(1997, 6, 1), et(2017, 12, 31)
    day = 86400.0
    INNER = {"mercury", "venus", "earth", "mars"}
    planet_raw = {}  # name -> (t0, dt, pts)：供 SOI 轨迹复刻运行时线性插值
    for p in PLANETS:
        name = p.split("/")[0]
        step = day / 6 if name in INNER else day
        pts = bake_segment(p, None, t0p, t1p, step)
        # 先量化到 f32 再存 planet_raw：planet_runtime 与前端 makeTrack（f32 网格
        # 线性插值）逐位一致，是"anchor + rel ≡ 日心轨迹"零偏差的前提
        pts = [(f32(x), f32(y), f32(z)) for (x, y, z) in pts]
        planet_raw[name] = (t0p, step, pts)
        bodies[name] = {"radiusKm": RADII[name], "segs": pack([(t0p, step, pts)]),
                        "o": orbit_line(p), "elems": elements_keyframes(p)}
        print(f"planet {name}: {len(pts)} pts")

    # ---------- 月球与土卫（母星中心合成；运行时 Catmull-Rom 三次插值） ----------
    # 步长按 "CR 弦差 ≤ ~15 km" 选取（h = 2π·dt/T，err ≈ r·h⁴/384）：
    #   Mimas(T=22.6h) 5400s / Enceladus(33h) 7200s / Tethys(45h) 9600s /
    #   Dione(66h) 13500s / Rhea(108h) 20500s；Titan/Iapetus/Moon 原步长已足够。
    # 旧 12h 网格 + 线性插值对 Mimas 的位置误差高达 ~20 万 km（低于奈奎斯特频率，
    # 视觉上沿弦穿过轨道——"Mimas 轨迹错误"的根源），现由细网格 + CR 插值修复。
    # 卫星数据拆分输出到 data/moons_data.js（控制单文件体积）。
    MOON_STEPS = {"titan": day / 4, "moon": day / 4, "enceladus": 7200.0,
                  "mimas": 5400.0, "tethys": 9600.0, "dione": 13500.0,
                  "rhea": 20500.0, "iapetus": day / 2}
    moons_bodies = {}
    moons_raw = {}   # name -> (t0, step, f32 pts)：供烘焙端 moon_cr 复刻运行时插值
    t0m, t1m = et(2004, 1, 1), et(2017, 12, 31)
    for m in MOONS:
        name = m.split("/")[0]
        step = MOON_STEPS.get(name, day / 2)
        t0u, t1u = (t0p, t1p) if name == "moon" else (t0m, t1m)
        try:
            pts = bake_segment(m, None, t0u, t1u, step)
        except Exception as ex:  # 个别卫星分片不全时跳过（前端用平均轨道兜底）
            print(f"moon {name}: SKIPPED ({ex})")
            continue
        pts = [(f32(x), f32(y), f32(z)) for (x, y, z) in pts]
        parent = "earth" if name == "moon" else "saturn"
        moons_raw[name] = (t0u, step, pts)
        moons_bodies[name] = {"radiusKm": RADII[name], "segs": pack([(t0u, step, pts)]),
                              "o": orbit_line(m), "parent": parent, "interp": "cr",
                              "elems": elements_keyframes(m, cap=1200)}
        print(f"moon {name}: {len(pts)} pts @ {step:.0f}s")

    # ---------- 卡西尼（分腿合成） ----------
    leg_specs = {
        "sc_cassini/earth/launch/orb": ("earth/sun/orb", day / 144),
        "sc_cassini/sun/1/orb": (None, day / 4),
        "sc_cassini/venus/flyby1/orb": ("venus/sun/orb", day / 288),
        "sc_cassini/sun/2/orb": (None, day / 4),
        "sc_cassini/venus/flyby2/orb": ("venus/sun/orb", day / 288),
        "sc_cassini/sun/3/orb": (None, day / 4),
        "sc_cassini/earth/flyby/orb": ("earth/sun/orb", day / 288),
        "sc_cassini/sun/4/orb": (None, day / 4),
        "sc_cassini/saturn/orb": ("saturn/sun/orb", day / 12),
    }
    legs = {}
    for leg in CASSINI_LEGS:
        d = load_points(leg)
        legs[leg] = (d["points"][0][0], d["points"][-1][0])
    # 覆盖范围采用腿文件的实际首末点
    leg_data = {}
    for leg, (center, step) in leg_specs.items():
        t0, t1 = legs[leg]
        n = int(round((t1 - t0) / step)) + 1
        pts = []
        for i in range(n):
            tt = t0 + i * step
            c = pos_at(center, tt) if center else (0.0, 0.0, 0.0)
            p = pos_at(leg, tt)
            pts.append((p[0] + c[0], p[1] + c[1], p[2] + c[2]))
        leg_data[leg] = (t0, step, pts)
        print(f"cassini {leg}: {len(pts)} pts  ({t0:.0f}..{t1:.0f})")

    ordered = CASSINI_LEGS
    segs = []
    for leg in ordered:
        t0, step, pts = leg_data[leg]
        segs.append((t0, step, pts))
    # 附加精细窗口：木星飞掠 & SOI 入轨
    j0, j1 = et(2000, 12, 27), et(2001, 1, 2)
    pts = bake_segment("sc_cassini/sun/4/orb", None, j0, j1, day / 48)
    segs.append((j0, day / 48, pts))
    # 木星 SOI 展示窗：按真实 SOI 半径扫描进入/离开时刻，前后各加 4 天余量
    # （1 h 步长，保证相对木星的弧线在窗口全程平滑）
    def leg_soi_span(leg, center, t_lo, t_hi, r_soi, step=6 * 3600.0):
        def d(t):
            p = pos_at(leg, t)
            if center:
                c = pos_at(center, t)
                p = (p[0] - c[0], p[1] - c[1], p[2] - c[2])
            return math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2])
        tin = tout = None
        t = t_lo
        prev = d(t) - r_soi
        while t < t_hi:
            t2 = min(t + step, t_hi)
            cur = d(t2) - r_soi
            if prev > 0 >= cur and tin is None:
                lo, hi = t, t2
                for _ in range(40):
                    mid = 0.5 * (lo + hi)
                    if d(mid) > r_soi:
                        lo = mid
                    else:
                        hi = mid
                tin = 0.5 * (lo + hi)
            if prev <= 0 < cur:
                lo, hi = t, t2
                for _ in range(40):
                    mid = 0.5 * (lo + hi)
                    if d(mid) <= r_soi:
                        lo = mid
                    else:
                        hi = mid
                tout = 0.5 * (lo + hi)
            prev, t = cur, t2
        return tin, tout

    jt_in, jt_out = leg_soi_span("sc_cassini/sun/4/orb", "jupiter/sun/orb",
                                 et(2000, 8, 1), et(2001, 5, 1), SOI_RADII["jupiter"])
    jj0, jj1 = jt_in - 4 * day, jt_out + 4 * day
    pts = bake_segment("sc_cassini/sun/4/orb", None, jj0, jj1, day / 24)
    segs.append((jj0, day / 24, pts))
    s0, s1 = et(2004, 6, 29), et(2004, 7, 3)
    pts = bake_segment("sc_cassini/saturn/orb", "saturn/sun/orb", s0, s1, day / 96)
    segs.append((s0, day / 96, pts))
    segs.sort(key=lambda s: -s[1])  # 粗段在前、精段在后；运行时取【最细】的命中段
    cassini = {"segs": pack(segs)}

    # ---------- 卡西尼合并轨迹（运行时插值 + 拖尾渲染共用，Catmull-Rom 平滑 + 尖峰剔除） ----------
    # 细段优先合并：时间上重叠的两条腿（如 sun/4 与 saturn/orb 在到达土星前后重叠，
    # 且各自网格锚点相差 ~64s 的 TT-UTC）若交错拼接会产生之字形假轨迹。先收最细段，
    # 粗段仅补空洞——落在已接受时间 ±0.55×本段步长内的点视为重复丢弃。
    all_pts = []  # (t, x, y, z)
    acc_t = []    # 已接受时间（有序），细段的时间不得被粗段重复覆盖
    for (t0, step, pts) in sorted(segs, key=lambda s: s[1]):
        tol = 0.55 * step
        tt_ = t0
        seg4 = []
        new_t = []
        for (x, y, z) in pts:
            i = bisect.bisect_left(acc_t, tt_ - tol)
            if not (i < len(acc_t) and acc_t[i] <= tt_ + tol):
                seg4.append((tt_, x, y, z))
                new_t.append(tt_)
            tt_ += step
        if new_t:
            acc_t = list(heapq.merge(acc_t, new_t))
        seg4 = remove_spikes(seg4)
        all_pts.extend(catmull_resample(seg4, 2))
    all_pts.sort(key=lambda p: p[0])
    merged = [all_pts[0]]
    for p in all_pts[1:]:
        if p[0] - merged[-1][0] > 20.0:  # 20 秒内视为重复
            merged.append(p)

    # ---------- 腿边界拼接（合并轨迹域，时间域交叉淡化） ----------
    # 飞掠相关的腿边界（sun/N ↔ flyby）不再在此拼接：dynamo 的巡航腿与飞掠腿
    # 只在近拱点附近相切（|A-B| 1.2~36k km），稍远即按 ~12-30 km/s 互为镜像分离，
    # 任何在行星邻域内的交叉淡化都会产生粗化折线/切角（V1 入臂曾达 31,127 km 弦差）。
    # 飞掠段整体由下方 SOI 窗口重构接管（行星中心双曲线 + SOI 边界平滑过渡）。
    # 这里只保留两处巡航腿之间的衔接：
    SPLICE_W = {
        ("sc_cassini/earth/launch/orb", "sc_cassini/sun/1/orb"): 48 * 3600.0,
        ("sc_cassini/sun/4/orb", "sc_cassini/saturn/orb"): 30 * 86400.0,
    }
    PERI_SPLICE = set()
    center_of_leg = {leg: leg_specs[leg][0] for leg in leg_specs}

    def composed_leg(leg, t):
        c = center_of_leg[leg]
        p = pos_at(leg, t)
        if c:
            cc = pos_at(c, t)
            return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
        return p

    def gap_ab(leg_a, leg_b, t):
        A = composed_leg(leg_a, t)
        B = composed_leg(leg_b, t)
        return sum((A[k] - B[k]) ** 2 for k in range(3))

    merged_t = [p[0] for p in merged]
    for i in range(len(CASSINI_LEGS) - 1):
        leg_a, leg_b = CASSINI_LEGS[i], CASSINI_LEGS[i + 1]
        if (leg_a, leg_b) not in SPLICE_W and (leg_a, leg_b) not in PERI_SPLICE:
            continue
        tb = legs[leg_b][0]
        d_end = math.sqrt(gap_ab(leg_a, leg_b, tb))
        if d_end < 5000.0:
            continue
        new_pts = []
        if (leg_a, leg_b) in PERI_SPLICE:
            # tp = 两腿切点（|A-B| 最小处，60s 粗扫飞掠腿全程 + 5s 细化）。
            # 两腿的出射臂互为镜像（同等地心距、反向，以 ~12-30 km/s 分离），
            # 位置线性混合的弦会从两臂之间切进行星内侧（实测可到行星半径以内！），
            # 故必须在与 B 弧近似相切处（|A-B| 仅 1.2-2.7k km）切换到 B，
            # 且窗口单侧 (tp, tp+W)：P(tp)=A(tp)=B(tp) 平凡连续、A'≈B' 近 C1。
            # 代价：金星两腿的切点在 A 近拱点之前（入射侧），轨迹在切点即换到
            # B 弧，渲染的近掠距离比 A 腿自身近拱点浅 ~4k km（V1 10.8k vs
            # 真实 6.6k）——dynamo 镜像腿数据的固有限制，已无法更优。
            fa0, fa1 = legs[leg_a]
            tp, gmin = fa0, gap_ab(leg_a, leg_b, fa0)
            t = fa0 + 60.0
            while t <= fa1:
                d = gap_ab(leg_a, leg_b, t)
                if d < gmin:
                    gmin, tp = d, t
                t += 60.0
            for t in [tp + k * 5.0 for k in range(-12, 13)]:
                if fa0 <= t <= fa1:
                    d = gap_ab(leg_a, leg_b, t)
                    if d < gmin:
                        gmin, tp = d, t
            # 半宽 W：|A-B| 从切点向外涨到 2 万 km 处（镜像分离二次增长）
            W = 1800.0
            for dtt in range(60, 3601, 30):
                if gap_ab(leg_a, leg_b, tp + dtt) > 20000.0 ** 2:
                    W = float(dtt)
                    break
            W = max(240.0, min(1800.0, W))
            dt_f = leg_specs[leg_a][1] / 2.0   # 飞掠段 150s 密度
            # 单侧窗口 (tp, tp+W)：P(tp)=A(tp) 精确保留飞掠腿自己的近拱点
            # （切点处 A'∥B' 天然 C1），仅出射侧过渡到 B 的真实弧
            k = int(math.ceil(W / dt_f))
            for j in range(k + 1):
                t = tp + j * dt_f
                if t <= tp or t >= tp + W:
                    continue
                h = (t - tp) / W
                h = h * h * (3 - 2 * h)
                A = composed_leg(leg_a, t)
                B = composed_leg(leg_b, t)
                new_pts.append((t,) + tuple(A[j2] + (B[j2] - A[j2]) * h for j2 in range(3)))
            # (tp+W, tb] 整段替换为 B（sun 腿向后外推的真实出射弧）
            # 300s 密度：相对行星弧线在近拱点外侧保持平滑（SOI 展示需要）
            dt_b = min(300.0, leg_specs[leg_b][1] / 2.0)
            k = int(math.floor((tb - tp - W) / dt_b))
            for j in range(k, 0, -1):
                t = tb - j * dt_b
                if t <= tp + W:
                    continue
                new_pts.append((t,) + tuple(composed_leg(leg_b, t)))
            new_pts.append((tb,) + tuple(composed_leg(leg_b, tb)))
            lo = bisect.bisect_right(merged_t, tp)
            hi = bisect.bisect_right(merged_t, tb)
            print(f"  splice[P] {leg_a.split('/')[-2]}->{leg_b.split('/')[-2]}: "
                  f"peri-gap {math.sqrt(gmin):,.0f} km @ tp, W={W:.0f}s, {len(new_pts)} pts")
        else:
            W = SPLICE_W[(leg_a, leg_b)]
            # 窗口不得早于 A 段起点（保留发射近地段的原始形态），至少 6h
            W = min(W, max(6 * 3600.0, tb - legs[leg_a][0] - 6 * 3600.0))
            t_s = tb - W
            dt_sp = leg_specs[leg_a][1] / 2.0  # 与 A 段 catmull 加密后密度一致
            k = int(math.floor(W / dt_sp))
            while k >= 1:
                t = tb - k * dt_sp
                k -= 1
                if t <= t_s:
                    continue
                h = (t - t_s) / W
                h = h * h * (3 - 2 * h)
                A = composed_leg(leg_a, t)
                B = composed_leg(leg_b, t)
                new_pts.append((t,) + tuple(A[j] + (B[j] - A[j]) * h for j in range(3)))
            new_pts.append((tb,) + tuple(composed_leg(leg_b, tb)))  # tb 处 P=B
            lo = bisect.bisect_right(merged_t, t_s)
            hi = bisect.bisect_right(merged_t, tb)
            print(f"  splice[A] {leg_a.split('/')[-2]}->{leg_b.split('/')[-2]}: "
                  f"gap {d_end:,.0f} km, W={W/3600:.0f} h, {len(new_pts)} pts")
        merged[lo:hi] = new_pts
        merged_t[lo:hi] = [p[0] for p in new_pts]

    # ---------- 引力弹弓段轨道数据重构（SOI 窗口方案） ----------
    # 进入行星真实引力影响球（SOI_RADII）后：
    #   相对行星的轨迹 = 飞掠腿近拱点根数外推的完整双曲线（近掠距离恢复真实值）；
    #   日心轨迹      = planet32(t) + rel(t) 重构，使前端锚定后
    #                   anchor(行星运行时位置) + rel ≡ 日心轨迹顶点，
    #                   "相对轨迹 ∩ 日心轨迹 = Cassini 实际位置"逐点零偏差成立。
    # 窗口边界（SOI 穿越时刻）与巡航腿之间平滑过渡：过渡半宽 Δb = δ/8 km/s
    # （δ = 边界处两套数据主张差），人工横向速度 ≤8 km/s ≪ 真实 ~30 km/s，
    # 观感为一次平滑的借力转弯而非折角。dynamo 飞掠腿出射臂为镜像假数据，
    # 重构区整体替换后不再进入轨迹；巡航腿之间的旧拼接仅保留 launch→sun/1、
    # sun/4→saturn/orb 两处（见上）。
    merged = [(p[0], f32(p[1]), f32(p[2]), f32(p[3])) for p in merged]
    merged_t = [p[0] for p in merged]

    def norm3(v):
        return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])

    def planet32(name, t):
        """与前端 makeTrack 逐位一致（f32 网格线性插值）的行星位置"""
        t0, step, pts = planet_raw[name]
        n = len(pts)
        f = (t - t0) / step
        if f < 0.0:
            f = 0.0
        if f > n - 1:
            f = float(n - 1)
        i = min(n - 2, int(math.floor(f)))
        a = f - i
        p0, p1 = pts[i], pts[i + 1]
        return (p0[0] + (p1[0] - p0[0]) * a,
                p0[1] + (p1[1] - p0[1]) * a,
                p0[2] + (p1[2] - p0[2]) * a)

    def merged_interp(t):
        i = bisect.bisect_right(merged_t, t)
        if i <= 0:
            return merged[0][1:]
        if i >= len(merged):
            return merged[-1][1:]
        p0, p1 = merged[i - 1], merged[i]
        a = (t - p0[0]) / (p1[0] - p0[0])
        return tuple(p0[1 + k] + (p1[1 + k] - p0[1 + k]) * a for k in range(3))

    def merged_dist(planet, t):
        c = planet32(planet, t)
        p = merged_interp(t)
        return norm3((p[0] - c[0], p[1] - c[1], p[2] - c[2]))

    def merged_soi_span(planet, t_lo, t_hi, r_soi, step=6 * 3600.0):
        """最终 merged 距离剖面与 r_soi 的首末穿越（窗口边界与前端显示判据同源）。
        多次进出时取【首次进入 + 末次离开】的外包络。"""
        tin = tout = None
        t = t_lo
        prev = merged_dist(planet, t) - r_soi
        while t < t_hi:
            t2 = min(t + step, t_hi)
            cur = merged_dist(planet, t2) - r_soi
            if prev > 0 >= cur and tin is None:
                lo, hi = t, t2
                for _ in range(40):
                    mid = 0.5 * (lo + hi)
                    if merged_dist(planet, mid) > r_soi:
                        lo = mid
                    else:
                        hi = mid
                tin = 0.5 * (lo + hi)
            if prev <= 0 < cur:
                lo, hi = t, t2
                for _ in range(40):
                    mid = 0.5 * (lo + hi)
                    if merged_dist(planet, mid) <= r_soi:
                        lo = mid
                    else:
                        hi = mid
                tout = 0.5 * (lo + hi)
            prev, t = cur, t2
        return tin, tout

    def rebuild_flyby(label, leg, cruise_a, cruise_b, planet, r_soi):
        """飞掠段重构（双曲线权威窗口 + 外移漂移过渡），返回 SOI 穿越时刻 (tin, tout)。

        dynamo 巡航腿（sun/N）与飞掠双曲线在行星近旁互为镜像：距离剖面几乎相同
        （半径差 <1%）但方位相反，位置以 ~32 km/s 线性分离（实测 V1 ±6h 处
        d ≈ 两侧半径之和）。因此在 SOI 边界做位置混合必然产生数十万公里级的
        侧向摆动，且巡航弧自身会深入 SOI（V1 570k km < SOI 616.9k），造成
        "进入→弹出→再进入"的锯齿（旧方案的弹弓轨迹异常根源）。

        新方案：
          1. 双曲线权威窗口取 |conic| < 2.5×SOI（窗口内轨迹 = planet + conic，
             近掠几何真实、SOI 穿越单一干净；巡航弧在窗口外半径 ≥ ~2.4×SOI，
             不再进入 SOI）。
          2. 过渡区放在 2.5×SOI 之外：半宽 B = δ/2.5 km/s（δ = 窗口边界处
             巡航与双曲线的日心距离差，钳制 2–10 天）。两弧半径几乎相等，
             混合表现为沿近圆弧的缓慢侧向漂移（≤ ~5 km/s ≪ 真实 ~30 km/s），
             观感为平滑的借力离场而非折角/摆动。"""
        kf = conic_peri_kf(leg)
        t_peri = kf[0] - kf[4] / kf[3]
        rp = conic_r(kf, t_peri)
        r_patch = 2.5 * r_soi
        t_p_in = conic_cross(kf, t_peri, r_patch, False)
        t_p_out = conic_cross(kf, t_peri, r_patch, True)
        tin = conic_cross(kf, t_peri, r_soi, False)
        tout = conic_cross(kf, t_peri, r_soi, True)

        def cruise_ref(t):
            # 巡航腿是日心根数；跨越飞掠间隙的区段由前后腿各自外推
            return pos_at(cruise_a if t <= t_peri else cruise_b, t)

        def rebuilt(t):
            con = orb_pos(kf, t)
            c = planet32(planet, t)
            return (con[0] + c[0], con[1] + c[1], con[2] + c[2])

        d_in = norm3(tuple(cruise_ref(t_p_in)[k] - rebuilt(t_p_in)[k] for k in range(3)))
        d_out = norm3(tuple(cruise_ref(t_p_out)[k] - rebuilt(t_p_out)[k] for k in range(3)))
        V_DRIFT = 2.5e3  # 过渡区侧向漂移速度上限 km/s→m/s：δ/2.5，钳制 2–10 天
        B_in = max(2 * 86400.0, min(10 * 86400.0, d_in / V_DRIFT * 1000.0))
        B_out = max(2 * 86400.0, min(10 * 86400.0, d_out / V_DRIFT * 1000.0))
        w0, w1 = t_p_in - B_in, t_p_out + B_out
        times = []
        t = w0
        while t <= w1:
            times.append(t)
            dt = 60.0 if abs(t - t_peri) <= 6 * 3600.0 else (
                300.0 if abs(t - t_peri) <= 24 * 3600.0 else (
                    900.0 if abs(t - t_peri) <= 3 * 86400.0 else 1800.0))
            t += dt
        new_pts = []
        for t in times:
            if t < t_p_in:
                s = smoothstep((t - w0) / B_in)
            elif t > t_p_out:
                s = 1.0 - smoothstep((t - t_p_out) / B_out)
            else:
                s = 1.0
            cr = cruise_ref(t)
            rb = rebuilt(t)
            new_pts.append((t,) + tuple(f32(cr[k] + (rb[k] - cr[k]) * s) for k in range(3)))
        lo = bisect.bisect_left(merged_t, w0)
        hi = bisect.bisect_right(merged_t, w1)
        merged[lo:hi] = new_pts
        merged_t[lo:hi] = [p[0] for p in new_pts]
        # 渲染近掠核对（重构后窗口内最小行星距）
        rmin, rmin_t = 1e18, None
        for p in merged:
            if p[0] < tin:
                continue
            if p[0] > tout:
                break
            c = planet32(planet, p[0])
            r = norm3((p[1] - c[0], p[2] - c[1], p[3] - c[2]))
            if r < rmin:
                rmin, rmin_t = r, p[0]
        print(f"  rebuild[{label}] 近掠 {rmin:,.0f} km @ {iso(rmin_t)}（根数 r_p={rp:,.0f} km）")
        print(f"    patch 窗口 {iso(t_p_in)} .. {iso(t_p_out)}（2.5×SOI）"
              f"  δ={d_in:,.0f}/{d_out:,.0f} km  B={B_in / 86400:.1f}/{B_out / 86400:.1f} d")
        return tin, tout

    v1_span = rebuild_flyby("Venus-1", "sc_cassini/venus/flyby1/orb",
                            "sc_cassini/sun/1/orb", "sc_cassini/sun/2/orb",
                            "venus", SOI_RADII["venus"])
    v2_span = rebuild_flyby("Venus-2", "sc_cassini/venus/flyby2/orb",
                            "sc_cassini/sun/2/orb", "sc_cassini/sun/3/orb",
                            "venus", SOI_RADII["venus"])
    ef_span = rebuild_flyby("Earth", "sc_cassini/earth/flyby/orb",
                            "sc_cassini/sun/3/orb", "sc_cassini/sun/4/orb",
                            "earth", SOI_RADII["earth"])

    # 窗口边界改用【最终轨迹】的距离剖面：过渡区内巡航弧可能比双曲线更贴近
    # 行星（V1 568k / Earth 443k km，均低于 SOI 半径），若窗口只按圆锥曲线
    # 穿越时刻截取，这些时段会"应显示而无窗口"。取剖面首次进入/末次离开。
    def final_span(planet, span, r_soi):
        return merged_soi_span(planet, span[0] - 6 * 86400.0, span[1] + 6 * 86400.0,
                               r_soi, step=1800.0)

    v1_win = final_span("venus", v1_span, SOI_RADII["venus"])
    v2_win = final_span("venus", v2_span, SOI_RADII["venus"])
    ef_win = final_span("earth", ef_span, SOI_RADII["earth"])
    for _lbl, _s in [("V1", v1_win), ("V2", v2_win), ("Earth", ef_win)]:
        print(f"  window[{_lbl}] {iso(_s[0])} .. {iso(_s[1])}")

    # ---------- 土星轨道段近拱点加密 ----------
    # 2h 网格在近拱点的弦差可达数千公里（交点偏差同量级），对每次近拱
    # （d_min < 3.5e6 km）前后 16h 加密到 12 min。
    ts0, ts1 = legs["sc_cassini/saturn/orb"]
    dprof = []
    for p in merged:
        if p[0] < ts0 - 30 * 86400.0:
            continue
        c = planet32("saturn", p[0])
        dprof.append((p[0], norm3((p[1] - c[0], p[2] - c[1], p[3] - c[2]))))
    spans = []
    for i in range(1, len(dprof) - 1):
        t, d = dprof[i]
        if d < dprof[i - 1][1] and d <= dprof[i + 1][1] and d < 3.5e6:
            w0, w1 = t - 16 * 3600.0, t + 16 * 3600.0
            if spans and w0 <= spans[-1][1]:
                spans[-1][1] = max(spans[-1][1], w1)
            else:
                spans.append([w0, w1])
    # 任务终段（2017-09-15 受控再入）距离持续下降、无局部极小，末端按近拱点处理
    if len(dprof) >= 2 and dprof[-1][1] < dprof[-2][1] and dprof[-1][1] < 3.5e6:
        w0 = merged_t[-1] - 16 * 3600.0
        if spans and w0 <= spans[-1][1]:
            spans[-1][1] = merged_t[-1]
        else:
            spans.append([w0, merged_t[-1]])
    added = 0
    for w0, w1 in spans:
        w1 = min(w1, ts1)
        new_pts = []
        t = w0
        while True:
            lp = pos_at("sc_cassini/saturn/orb", t)
            cp = pos_at("saturn/sun/orb", t)
            new_pts.append((t,) + tuple(f32(lp[k] + cp[k]) for k in range(3)))
            if t >= w1:
                break
            c = planet32("saturn", t)
            dx, dy, dz = lp[0] + cp[0] - c[0], lp[1] + cp[1] - c[1], lp[2] + cp[2] - c[2]
            d = math.sqrt(dx * dx + dy * dy + dz * dz)
            # 近掠段曲率大（Grand Finale 环缝近掠 r~6-9 万 km），加密到 4 min
            t = min(t + (240.0 if d < 5e5 else 720.0), w1)
        lo = bisect.bisect_left(merged_t, w0)
        hi = bisect.bisect_right(merged_t, w1)
        merged[lo:hi] = new_pts
        merged_t[lo:hi] = [p[0] for p in new_pts]
        added += len(new_pts)
    print(f"  saturn orbit: {len(spans)} 个近拱点窗口加密（+{added} pts @12min）")

    # ---------- Huygens 分离窗口加密（item 5） ----------
    # 分离（2004-12-25 02:00 UTC）前后 ±1 天加密到 5 min：组合体与 Huygens
    # 轨迹需在分离近旁以模型尺度平滑衔接（saturn/orb 腿该处无近掠加密）。
    h0s, h1s = et(2004, 12, 24), et(2004, 12, 26)
    new_pts = []
    t = h0s
    while t <= h1s:
        lp = pos_at("sc_cassini/saturn/orb", t)
        cp = pos_at("saturn/sun/orb", t)
        new_pts.append((t,) + tuple(f32(lp[k] + cp[k]) for k in range(3)))
        t += 300.0
    lo = bisect.bisect_left(merged_t, h0s)
    hi = bisect.bisect_right(merged_t, h1s)
    merged[lo:hi] = new_pts
    merged_t[lo:hi] = [p[0] for p in new_pts]
    print(f"  huygens separation window: {len(new_pts)} pts @5min")

    # ---------- 卫星近掠加密（二级 SOI / 近掠几何，item 3/5/6） ----------
    # 土星段 2h 基础采样在卫星近掠处完全失真（Enceladus E-21 真实 49 km 被采成
    # ~1,500 km）：dynamo 的 saturn/orb 腿在近掠附近自带 ~16 min 密度的根数
    # 关键帧，按"距卫星距离"分级重采样即可恢复真实近掠几何。扫描用腿评估
    # （不受 merged 网格掩蔽），加密窗口整体替换 merged 对应区间。
    # Laplace SOI 半径 km：a·(μ_m/μ_sat)^(2/5)，与前端 SOI_SHOW 逐值一致。
    MOON_SOI = {
        "titan": 4.33e4, "enceladus": 4.9e2, "rhea": 3.68e3, "dione": 1.95e3,
        "tethys": 1.21e3, "iapetus": 2.25e4, "mimas": 2.49e2, "moon": 6.61e4,
    }
    ENC_TIER = {  # (dmax, ·)：d<4e4 → 60s，d<1.5e5 → 240s，d<dmax → 900s
        "titan": (6e5, 4.5e5), "iapetus": (4e5, 3e5), "rhea": (2.5e5, 2e5),
        "dione": (2.5e5, 2e5), "tethys": (2e5, 1.5e5), "enceladus": (2e5, 1.5e5),
        "mimas": (1.2e5, 1e5), "moon": (2e5, 1.5e5),
    }
    ts0, ts1 = legs["sc_cassini/saturn/orb"]

    def leg_sat_rel(t):
        return pos_at("sc_cassini/saturn/orb", t)

    SCAN = 1800.0
    sc_rel = []
    t = ts0
    while t <= ts1:
        sc_rel.append((t, leg_sat_rel(t)))
        t += SCAN
    print(f"  encounter scan: {len(sc_rel)} base samples (saturn/orb leg)")
    soi_wins_by_moon = {}   # moon -> [(t_in, t_out)]：腿评估细扫描的 SOI 穿越窗口
    for mname in [m.split("/")[0] for m in MOONS]:
        if mname == "moon" or mname not in moons_raw:
            continue
        dmax, _d_mid = ENC_TIER[mname]
        r_soi_m = MOON_SOI[mname]

        def moon_dist(tq, _m=mname):
            lp = leg_sat_rel(tq)
            ml = pos_at(_m + "/saturn/orb", tq)
            return norm3((lp[0] - ml[0], lp[1] - ml[1], lp[2] - ml[2]))

        mp = [pos_at(mname + "/saturn/orb", tt0) for (tt0, _) in sc_rel]
        spans2 = []
        cur = None
        for i, (tt0, sp) in enumerate(sc_rel):
            d = norm3((sp[0] - mp[i][0], sp[1] - mp[i][1], sp[2] - mp[i][2]))
            if d < dmax:
                if cur is None:
                    cur = [tt0, tt0]
                else:
                    cur[1] = tt0
            elif cur is not None:
                spans2.append(cur)
                cur = None
        if cur is not None:
            spans2.append(cur)
        for w in spans2:      # 外扩 SCAN 后合并搭接窗口
            w[0] -= SCAN
            w[1] += SCAN
        spans2.sort()
        merged_spans = []
        for w in spans2:
            if merged_spans and w[0] <= merged_spans[-1][1]:
                merged_spans[-1][1] = max(merged_spans[-1][1], w[1])
            else:
                merged_spans.append(w)
        n_new = 0
        for w0e, w1e in merged_spans:
            new_pts = []
            t = w0e
            while t <= w1e:
                lp = leg_sat_rel(t)
                ml = pos_at(mname + "/saturn/orb", t)
                d = norm3((lp[0] - ml[0], lp[1] - ml[1], lp[2] - ml[2]))
                cp = pos_at("saturn/sun/orb", t)
                new_pts.append((t,) + tuple(f32(lp[k] + cp[k]) for k in range(3)))
                t += (60.0 if d < 4.0e4 else 240.0 if d < 1.5e5 else 900.0)
            lo = bisect.bisect_left(merged_t, w0e)
            hi = bisect.bisect_right(merged_t, w1e)
            merged[lo:hi] = new_pts
            merged_t[lo:hi] = [p[0] for p in new_pts]
            n_new += len(new_pts)
        # SOI 穿越窗口：先 300s 找 d<10×SOI 候选区，再 5s 细扫（SOI 小的卫星
        # 穿越仅 ~100s，粗网格会漏）——近掠加密后 merged 网格在这些窗口内
        # 为 60s 密度，相对轨迹行可从 merged 直接提取。
        wins_m = []
        for w0e, w1e in merged_spans:
            t = w0e
            cand = None
            while t <= w1e:
                if moon_dist(t) < 10.0 * r_soi_m:
                    if cand is None:
                        cand = t
                elif cand is not None:
                    a, b = max(w0e, cand - 600.0), min(w1e, t + 600.0)
                    ti = tb = None
                    tq = a
                    while tq <= b:
                        if moon_dist(tq) < r_soi_m:
                            if ti is None:
                                ti = tq
                            tb = tq
                        tq += 5.0
                    if ti is not None:
                        wins_m.append((ti, tb))
                    cand = None
                t += 300.0
        if wins_m:
            soi_wins_by_moon[mname] = wins_m
        if n_new:
            print(f"  encounter {mname}: {len(merged_spans)} windows, +{n_new} pts, "
                  f"{len(wins_m)} SOI crossings")


    tt = [p[0] for p in merged]
    flat = [v for p in merged for v in p[1:]]
    cassini["trailT"] = base64.b64encode(struct.pack(f"<{len(tt)}d", *tt)).decode("ascii")
    cassini["trail"] = base64.b64encode(struct.pack(f"<{len(flat)}f", *flat)).decode("ascii")
    cassini["trailN"] = len(merged)
    print(f"cassini merged trail: {len(merged)} pts")

    # ---------- SOI（引力影响球）内相对行星的轨迹 ----------
    # rel(t) = merged32(t) − planet32(t)：减去与前端 makeTrack 逐位一致的
    # f32 运行时行星位置，前端把相对轨迹锚定在行星模型位置后
    # anchor + rel ≡ 日心轨迹顶点（f64 精度），"相对轨迹 ∩ 日心轨迹 =
    # Cassini 实际位置"零偏差成立。
    # 窗口时间域 = Cassini 位于真实 SOI 半径内的时间区间（±45 min 余量，
    # 前端按距离的淡入/淡出在窗口内完成，不会突然出现/消失）。
    #   venus  ×2：飞掠重构窗口（近拱点根数外推的双曲线）
    #   earth  ×2：1997 发射逃逸段（发射即在 SOI 内）+ 1999 回掠重构窗口
    #   jupiter   ：日心弧本身即真实借力路径，rel = merged − planet
    #   saturn    ：进入 SOI（接近段）起至任务结束（环绕段全程位于 SOI 内）
    def pack_soi_rows(rows):
        tt = [r[0] for r in rows]
        flat = [v for r in rows for v in r[1:]]
        return {
            "t": base64.b64encode(struct.pack(f"<{len(tt)}d", *tt)).decode("ascii"),
            "d": base64.b64encode(struct.pack(f"<{len(flat)}f", *flat)).decode("ascii"),
            "n": len(rows),
        }

    def soi_rows(planet, t_from, t_to):
        rows = []
        k = bisect.bisect_left(merged_t, t_from)
        while k < len(merged_t) and merged_t[k] <= t_to:
            p = merged[k]
            c = planet32(planet, p[0])
            rows.append((p[0], p[1] - c[0], p[2] - c[1], p[3] - c[2]))
            k += 1
        return rows

    def moon_cr(name, t):
        """与前端 makeTrack(Catmull-Rom) 逐位一致的卫星本地位置（母星中心系）。
        公式与 js/scene.js 的 crAt 完全相同（f32 顶点 + f64 算术）。"""
        t0, step, pts = moons_raw[name]
        n = len(pts)
        f = (t - t0) / step
        if f < 0.0:
            f = 0.0
        if f > n - 1:
            f = float(n - 1)
        i = min(n - 2, int(math.floor(f)))
        s = f - i
        i0 = i - 1 if i > 0 else 0
        i3 = i + 2 if i + 2 <= n - 1 else n - 1
        p0, p1, p2, p3 = pts[i0], pts[i], pts[i + 1], pts[i3]
        out = []
        for k in range(3):
            a0, a1, a2, a3 = p0[k], p1[k], p2[k], p3[k]
            out.append(0.5 * ((2.0 * a1) + (a2 - a0) * s
                              + (2.0 * a0 - 5.0 * a1 + 4.0 * a2 - a3) * s * s
                              + (3.0 * a1 - a0 - 3.0 * a2 + a3) * s * s * s))
        return tuple(out)

    def moon32(name, t):
        """卫星世界坐标（日心）= 母星网格位置 + 本地 CR —— 与前端 anchor 完全一致"""
        base = planet32("earth" if name == "moon" else "saturn", t)
        l = moon_cr(name, t)
        return (base[0] + l[0], base[1] + l[1], base[2] + l[2])

    def soi_rows_moon(name, t_from, t_to):
        rows = []
        k = bisect.bisect_left(merged_t, t_from)
        while k < len(merged_t) and merged_t[k] <= t_to:
            p = merged[k]
            c = moon32(name, p[0])
            rows.append((p[0], p[1] - c[0], p[2] - c[1], p[3] - c[2]))
            k += 1
        return rows

    MARGIN = 45 * 60.0
    soi = {}
    soi["venus"] = [
        pack_soi_rows(soi_rows("venus", v1_win[0] - MARGIN, v1_win[1] + MARGIN)),
        pack_soi_rows(soi_rows("venus", v2_win[0] - MARGIN, v2_win[1] + MARGIN)),
    ]
    # 发射逃逸段：发射时即位于地球 SOI 内，窗口终点为穿出 SOI 的时刻
    l_out = merged_soi_span("earth", merged_t[0], et(1997, 11, 15),
                            SOI_RADII["earth"], step=3600.0)[1]
    soi["earth"] = [
        pack_soi_rows(soi_rows("earth", merged_t[0], l_out + MARGIN)),
        pack_soi_rows(soi_rows("earth", ef_win[0] - MARGIN, ef_win[1] + MARGIN)),
    ]
    j_in, j_out = merged_soi_span("jupiter", et(2000, 8, 1), et(2001, 5, 1),
                                  SOI_RADII["jupiter"])
    soi["jupiter"] = [pack_soi_rows(soi_rows("jupiter", j_in - MARGIN, j_out + MARGIN))]

    # ---------- 卫星 SOI（二级相对轨迹，item 3）----------
    # 窗口来自卫星近掠段的腿评估细扫描（soi_wins_by_moon，粗网格会漏掉
    # Enceladus ~490 km 量级的百秒级穿越）；相对轨迹行从 merged 提取
    # （近掠加密后窗口内为 60s 密度）。此处另扫 merged 收集"近卫星"区段
    # （d < 6e4 km），供土星 SOI 行保密度用。
    near_ranges = []   # merged 索引区段 [i0, i1]（任一卫星 6e4 km 内）
    for mname in MOON_SOI:
        if mname not in moons_raw:
            continue
        t_grid0 = moons_raw[mname][0]
        k0 = bisect.bisect_left(merged_t, t_grid0)
        cur_nr = None
        for i in range(k0, len(merged)):
            p = merged[i]
            c = moon32(mname, p[0])
            d = norm3((p[1] - c[0], p[2] - c[1], p[3] - c[2]))
            if d < 6.0e4:
                if cur_nr is None:
                    cur_nr = [i, i]
                else:
                    cur_nr[1] = i
            elif cur_nr is not None:
                near_ranges.append(cur_nr)
                cur_nr = None
        if cur_nr is not None:
            near_ranges.append(cur_nr)
    near_ranges.sort()
    merged_nr = []
    for r in near_ranges:
        if merged_nr and r[0] <= merged_nr[-1][1] + 1:
            merged_nr[-1][1] = max(merged_nr[-1][1], r[1])
        else:
            merged_nr.append(r)

    for mname, wins in soi_wins_by_moon.items():
        rows_packed = []
        for (wa, wb) in wins:
            rows = soi_rows_moon(mname, wa - MARGIN, wb + MARGIN)
            if len(rows) >= 2:
                rows_packed.append(pack_soi_rows(rows))
        if rows_packed:
            soi[mname] = rows_packed
            print(f"soi moon {mname}: {len(rows_packed)} windows, "
                  f"{sum(w['n'] for w in rows_packed)} rows")

    s_in, _ = merged_soi_span("saturn", et(2004, 1, 1), ts0,
                              SOI_RADII["saturn"], step=2 * 3600.0)
    # 土星 SOI 行降采样：基础 ≤900s 间距；近卫星区段（近掠几何，item 3/5）
    # 保留 merged 全密度。行星际行星窗口行数少，维持原样。
    rows = []
    last_t = None
    nri = 0
    k = bisect.bisect_left(merged_t, s_in - MARGIN)
    while k < len(merged_t):
        in_near = nri < len(merged_nr) and merged_nr[nri][0] <= k
        if in_near and k > merged_nr[nri][1]:
            nri += 1
            in_near = nri < len(merged_nr) and merged_nr[nri][0] <= k
        p = merged[k]
        if last_t is None or in_near or p[0] - last_t >= 900.0:
            c = planet32("saturn", p[0])
            rows.append((p[0], p[1] - c[0], p[2] - c[1], p[3] - c[2]))
            last_t = p[0]
        k += 1
    soi["saturn"] = [pack_soi_rows(rows)]
    cassini["soi"] = soi
    for _tag in ("venus", "earth", "jupiter", "saturn"):
        _ws = soi[_tag]
        _info = []
        for _w in _ws:
            _t = struct.unpack(f"<{_w['n']}d", base64.b64decode(_w["t"]))
            _d = struct.unpack(f"<{_w['n'] * 3}f", base64.b64decode(_w["d"]))
            _r0 = math.sqrt(_d[0] ** 2 + _d[1] ** 2 + _d[2] ** 2)
            _r1 = math.sqrt(_d[-3] ** 2 + _d[-2] ** 2 + _d[-1] ** 2)
            _info.append(f"{iso(_t[0])}..{iso(_t[-1])} n={_w['n']} 边缘|rel|={_r0:,.0f}/{_r1:,.0f} km")
        print(f"soi {_tag}: " + "; ".join(_info))

    # ---------- Huygens 真实轨迹（dynamo sc_huygens 腿，item 4） ----------
    # 巡航段：sc_huygens/saturn/orb（土星中心，28 个真实根数关键帧，覆盖
    #   分离 → 进入，转移周期 31.9 天与真实 C 轨道一致）→ rel_saturn 行；
    # 进入段：sc_huygens/titan/orb（Titan 中心真实进入双曲线，近地点在
    #   Titan 内部——真空轨道被大气在 ~1,270 km 进入界面截断的物理形态）
    #   → rel_titan 行；减速伞下降段：由进入段末端切向连续的贝塞尔弧接至
    #   着陆点（进入点径向投影到 Titan 表面）。
    # 时间基准（NASA science.nasa.gov Huygens Probe）：进入 09:06 UTC、下降
    #   2h27m（着陆 ~11:30 UTC）、着陆后表面工作 72 分钟后失联。
    SEP_ET_H = et(2004, 12, 25, 2, 0)
    ENTRY_ET_H = et(2005, 1, 14, 9, 6)
    DESCENT_S_H = 2 * 3600 + 27 * 60
    TD_ET_H = ENTRY_ET_H + DESCENT_S_H
    huy = {"sepEt": SEP_ET_H, "entryEt": ENTRY_ET_H, "tdEt": TD_ET_H,
           "losEt": TD_ET_H + 72 * 60}
    co = []
    t = SEP_ET_H
    while t <= ENTRY_ET_H:
        p = pos_at("sc_huygens/saturn/orb", t)
        co.append((t, f32(p[0]), f32(p[1]), f32(p[2])))
        t += 1200.0
    if co[-1][0] < ENTRY_ET_H:
        p = pos_at("sc_huygens/saturn/orb", ENTRY_ET_H)
        co.append((ENTRY_ET_H, f32(p[0]), f32(p[1]), f32(p[2])))

    # Titan 进入段：取最接近 ENTRY−600s 的根数关键帧做纯两体外推（干净双曲线）
    huy_kfs = load_points("sc_huygens/titan/orb")["points"]
    kf_t = min(huy_kfs, key=lambda p: abs(p[0] - (ENTRY_ET_H - 600.0)))

    def titan_entry_rel(t):
        return orb_pos(kf_t, t)

    R_TITAN_H = RADII["titan"]
    p_entry = titan_entry_rel(ENTRY_ET_H)
    r_entry = norm3(p_entry)
    print(f"  huygens entry: |rel(titan)| = {r_entry:,.0f} km"
          f"（R+1270 = {R_TITAN_H + 1270:,.0f}）")
    # 真空双曲线下潜到 ~160 km 高度处截断（此后大气/降落伞接管）
    T_AERO = ENTRY_ET_H
    for _i in range(240):
        _t = ENTRY_ET_H + _i * 10.0
        if norm3(titan_entry_rel(_t)) < R_TITAN_H + 160.0:
            T_AERO = _t
            break

    # 巡航段(Titan-rel 参考) 与 进入段 的拼接差：δ = coast(ENTRY) − (titan本地 + entryRel)
    # （两者都是土星中心系：coast 行与 titan 本地+进入双曲线同框）。将 Titan-rel
    # 行整体平移 δ 使 ENTRY 处严格连续（保留真实弧形，仅重锚定消除拟合差）。
    tit_e = moon_cr("titan", ENTRY_ET_H)
    coast_end = (co[-1][1], co[-1][2], co[-1][3])
    delta = tuple(coast_end[k] - (tit_e[k] + p_entry[k]) for k in range(3))
    print(f"  huygens coast↔entry 拼接差 |δ| = {norm3(delta):,.0f} km（重锚定消除）")

    ti_rows = []
    t = ENTRY_ET_H - 3600.0
    while t <= T_AERO:
        p = titan_entry_rel(t)
        ti_rows.append((t, f32(p[0] + delta[0]), f32(p[1] + delta[1]), f32(p[2] + delta[2])))
        t += 30.0
    if ti_rows[-1][0] < T_AERO:
        p = titan_entry_rel(T_AERO)
        ti_rows.append((T_AERO, f32(p[0] + delta[0]), f32(p[1] + delta[1]), f32(p[2] + delta[2])))

    # 下降段贝塞尔：S = 气动截断点（切向连续），E = 进入点径向投影到表面，
    # C = S + 切向×0.45×drop + 侧向×0.12×drop（风漂移），ease-out 先快后慢。
    S3 = (ti_rows[-1][1], ti_rows[-1][2], ti_rows[-1][3])
    E3 = tuple((p_entry[k] + delta[k]) / (norm3(p_entry) + 1e-9) * R_TITAN_H for k in range(3))

    def V_norm3(v):
        n = norm3(v) or 1.0
        return (v[0] / n, v[1] / n, v[2] / n)

    def V_cross3(a, b):
        return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

    tan3 = V_norm3(tuple(S3[k] - (titan_entry_rel(T_AERO - 60.0)[k] + delta[k]) for k in range(3)))
    side3 = V_norm3(V_cross3(tan3, (0.0, 1.0, 0.0)))
    drop = norm3(tuple(S3[k] - E3[k] for k in range(3)))
    C3 = tuple(S3[k] + tan3[k] * 0.45 * drop + side3[k] * 0.12 * drop for k in range(3))
    t = T_AERO
    while True:
        s = (t - T_AERO) / max(1.0, TD_ET_H - T_AERO)
        u = 1.0 - math.pow(1.0 - min(1.0, s), 1.8)
        p = tuple((1 - u) * (1 - u) * S3[k] + 2 * (1 - u) * u * C3[k] + u * u * E3[k]
                  for k in range(3))
        ti_rows.append((t, f32(p[0]), f32(p[1]), f32(p[2])))
        if t >= TD_ET_H:
            break
        t = min(t + 120.0, TD_ET_H)
    # 末端时间戳对齐 TD（保证着陆点精确）
    ti_rows[-1] = (TD_ET_H, f32(E3[0]), f32(E3[1]), f32(E3[2]))

    def pack_huy(rows):
        tt = [r[0] for r in rows]
        flat = [v for r in rows for v in r[1:]]
        return {
            "t": base64.b64encode(struct.pack(f"<{len(tt)}d", *tt)).decode("ascii"),
            "d": base64.b64encode(struct.pack(f"<{len(flat)}f", *flat)).decode("ascii"),
            "n": len(rows),
        }

    huy["relSat"] = pack_huy(co)
    huy["relTit"] = pack_huy(ti_rows)
    cassini["huygens"] = huy
    _d0 = math.sqrt(co[0][1] ** 2 + co[0][2] ** 2 + co[0][3] ** 2)
    _sep_c = pos_at("sc_cassini/saturn/orb", SEP_ET_H)
    _sep_gap = norm3(tuple(co[0][j + 1] - _sep_c[j] for j in range(3)))
    print(f"  huygens: coast {len(co)} rows（分离点距 Cassini 腿 {_sep_gap:,.0f} km）, "
          f"titan {len(ti_rows)} rows, drop {drop:,.0f} km, "
          f"TD={iso(TD_ET_H)}, LOS=TD+72min")


    # ---------- 校验 ----------
    print("\n=== 校验 ===")

    def dist(path_a, path_b_center, t):
        a = pos_at(path_a, t)
        if path_b_center is None:
            return math.sqrt(sum(v * v for v in a))
        c = pos_at(path_b_center, t)
        return math.sqrt(sum((a[i] - c[i]) ** 2 for i in range(3)))

    def min_dist_cassini(body, t_center, half_window):
        best = 1e18
        bt = t_center
        t = t_center - half_window
        while t <= t_center + half_window:
            dd = dist("sc_cassini/_", None, 0)  # placeholder
            t += 60
            break
        # 直接用合成轨迹: 找 leg
        for leg, (center) in leg_specs.items():
            pass
        return best

    # 简化：直接逐时刻计算卡西尼-目标距离
    def cassini_pos(t):
        # 找对应腿
        for leg in CASSINI_LEGS:
            t0, t1 = legs[leg]
            if t0 <= t <= t1:
                center, _ = leg_specs[leg]
                c = pos_at(center, t) if center else (0, 0, 0)
                p = pos_at(leg, t)
                return (p[0] + c[0], p[1] + c[1], p[2] + c[2])
        return None

    def min_dist(target, t0, t1, step=60.0):
        best, bt = 1e18, None
        t = t0
        while t <= t1:
            cp = cassini_pos(t)
            tp = pos_at(target, t)
            dd = math.sqrt(sum((cp[i] - tp[i]) ** 2 for i in range(3)))
            if dd < best:
                best, bt = dd, t
            t += step
        return best, bt

    for name, leg, t0, t1, step in [
        ("venus1", "venus/sun/orb", et(1998, 4, 25), et(1998, 4, 28), 30.0),
        ("venus2", "venus/sun/orb", et(1999, 6, 23), et(1999, 6, 26), 30.0),
        ("earth", "earth/sun/orb", et(1999, 8, 17), et(1999, 8, 20), 30.0),
        ("jupiter", "jupiter/sun/orb", et(2000, 12, 28), et(2001, 1, 2), 60.0),
        ("phoebe?", "saturn/sun/orb", et(2004, 6, 10), et(2004, 6, 12), 10.0),
        ("saturn_SOI", "saturn/sun/orb", et(2004, 6, 30), et(2004, 7, 2), 30.0),
    ]:
        best, bt = min_dist(leg, t0, t1, step)
        iso = time.strftime("%Y-%m-%d %H:%M", time.gmtime(bt + J2000_S))
        print(f"  min |cassini-{name}| = {best:,.0f} km @ {iso}")

    # 月球距离范围
    dmin, dmax = 1e18, 0
    t = t0p
    while t <= t1p:
        m = pos_at("moon/earth/orb", t)
        dd = math.sqrt(sum(v * v for v in m))
        dmin, dmax = min(dmin, dd), max(dmax, dd)
        t += 6 * 3600
    print(f"  moon geocentric distance: {dmin:,.0f} .. {dmax:,.0f} km")

    # 腿边界连续性
    order = CASSINI_LEGS
    for i in range(len(order) - 1):
        la, lb = order[i], order[i + 1]
        tb = legs[lb][0]
        ta_end = legs[la][1]
        pa = cassini_pos(ta_end)
        pb = cassini_pos(tb)
        if pa and pb:
            dd = math.sqrt(sum((pa[k] - pb[k]) ** 2 for k in range(3)))
            flag = "OK" if dd < 5000 else "!!"
            print(f"  boundary {la.split('/')[-2]}/{la.split('/')[-1]} -> {lb.split('/')[-2]}: gap {dd:,.0f} km {flag}")

    t_start = legs["sc_cassini/earth/launch/orb"][0]
    t_end = legs["sc_cassini/saturn/orb"][1]
    meta = {
        "j2000Ms": J2000_S * 1000,
        "tStart": t_start,
        "tEnd": t_end,
        "generated": time.strftime("%Y-%m-%d"),
        "frame": "ecliptic J2000, km, heliocentric",
    }
    # 拆分输出：行星 + 卡西尼 → cassini_data.js；卫星（细网格 CR）→ moons_data.js
    data = {"meta": meta, "bodies": bodies, "spacecraft": {"cassini": cassini}}
    out_path = os.path.join(OUT, "cassini_data.js")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("/* 由 tools/bake_data.py 生成 — 来源: NASA Eyes dynamo 历表 */\n")
        f.write("window.CASSINI_DATA = ")
        f.write(__import__("json").dumps(data, separators=(",", ":")))
        f.write(";\n")
    sz = os.path.getsize(out_path)
    print(f"\nwrote {out_path} ({sz/1e6:.2f} MB)")

    mdata = {"meta": dict(meta), "bodies": moons_bodies}
    mout = os.path.join(OUT, "moons_data.js")
    with open(mout, "w", encoding="utf-8") as f:
        f.write("/* 由 tools/bake_data.py 生成 — 卫星细网格（运行时 Catmull-Rom 插值）*/\n")
        f.write("window.MOONS_DATA = ")
        f.write(__import__("json").dumps(mdata, separators=(",", ":")))
        f.write(";\n")
    msz = os.path.getsize(mout)
    print(f"wrote {mout} ({msz/1e6:.2f} MB)")
    print(f"mission span: {t_start:.0f} .. {t_end:.0f} ET")


if __name__ == "__main__":
    main()
