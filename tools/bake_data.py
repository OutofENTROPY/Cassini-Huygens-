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
    dynamo 飞掠腿时间域只有近掠前后数小时，且其圆锥曲线相对真实轨迹整体
    镜像（角动量反平行，实测三处飞掠 179–180°）——只有近掠距离 rp 与近拱点
    时刻 t_peri 是真实任务值（与任务实录逐一吻合），供 rebuild_flyby 构造
    正确双曲线时钉定近拱点；方向不可外推使用。"""
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


def cross3(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot3(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def unit3(v):
    n = math.sqrt(dot3(v, v)) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def ang3(a, b):
    """两向量夹角（度）"""
    return math.degrees(math.acos(max(-1.0, min(1.0, dot3(unit3(a), unit3(b))))))


def rodrigues(v, k, theta):
    """向量 v 绕单位轴 k 旋转 theta（右手）"""
    c, s = math.cos(theta), math.sin(theta)
    kv = cross3(k, v)
    kdv = dot3(k, v)
    return tuple(v[i] * c + kv[i] * s + k[i] * kdv * (1.0 - c) for i in range(3))


def solve_hyp(M, e):
    """双曲线开普勒方程 M = e·sinhH − H（dM/dH = e·coshH − 1 > 0 单调），牛顿法。
    H 可达 ±7（f32 网格窗口内 |M| ≤ ~10³），cosh 无溢出风险。"""
    H = math.asinh(M / e)
    for _ in range(60):
        f = e * math.sinh(H) - H - M
        d = f / (e * math.cosh(H) - 1.0)
        H -= d
        if abs(d) < 1e-12:
            break
    return H


def hyp_conic(mu, A, e, P, Q, t_peri):
    """行星中心双曲线求值器（黄道系，km/s）。
    P → 近拱点方向（单位），Q → 近拱点处运动方向（单位，P×Q=ĥ），
    A = −a > 0（半长轴绝对值），e > 1。
    r(H) = A(e−coshH)·P + A√(e²−1)·sinhH·Q；M = e·sinhH − H = n(t−t_peri)。"""
    n = math.sqrt(mu / (A ** 3))
    sq = math.sqrt(e * e - 1.0)

    def pos(t):
        H = solve_hyp(n * (t - t_peri), e)
        x = A * (e - math.cosh(H))
        y = A * sq * math.sinh(H)
        return (x * P[0] + y * Q[0], x * P[1] + y * Q[1], x * P[2] + y * Q[2])

    def vel(t, dt=30.0):
        p0, p1 = pos(t - dt), pos(t + dt)
        return tuple((p1[k] - p0[k]) / (2.0 * dt) for k in range(3))

    def radius_t(r_target, after):
        """|r| = r_target 的穿越时刻（after=False 入臂 / True 出臂）。
        r = A(e·coshH − 1) → H = arcosh((r/A + 1)/e)"""
        H = math.acosh((r_target / A + 1.0) / e)
        if not after:
            H = -H
        return t_peri + (e * math.sinh(H) - H) / n

    def bend_at(r_x):
        """入臂 |r|=r_x 处【速度方向】相对入射渐近线已累积的转弯角（弧度）。
        v̂(ν) ∝ −sinν·P + (e+cosν)·Q；渐近线在 ν=−ν∞。
        注意速度方向转弯 ≠ 真近点角差（ν∞−ν_x）：SOI 处前者 ~0.03°、后者 ~1.1°。"""
        p = A * (e * e - 1.0)
        nx = math.acos(max(-1.0, min(1.0, (p / r_x - 1.0) / e)))   # |ν_x|
        ni = math.acos(-1.0 / e)                                   # ν∞
        u1, u2 = math.sin(nx), e + math.cos(nx)                    # v̂(−ν_x) 沿 (P,Q)
        w1, w2 = math.sin(ni), e - 1.0 / e                         # v̂∞ 沿 (P,Q)
        cospsi = (u1 * w1 + u2 * w2) / (math.hypot(u1, u2) * math.hypot(w1, w2))
        return math.acos(max(-1.0, min(1.0, cospsi)))

    return {"pos": pos, "vel": vel, "radius_t": radius_t, "bend_at": bend_at,
            "A": A, "e": e, "t_peri": t_peri}


def def_mu(path):
    """def.dyn 头部的引力参数 μ（NASA Eyes 同源；行星中心腿 mu2 = 中心天体 GM，
    如 sc_cassini/venus/flyby1/orb mu2 = 324858.599 = Venus GM）"""
    from fetch_data import parse_def
    ddir = os.path.join(RAW, path.replace("/", "_"))
    with open(os.path.join(ddir, "def.dyn"), "rb") as f:
        return parse_def(f.read())["mu2"]
def build_launch_escape():
    """发射逃逸段重构（与飞掠腿同族的定向缺陷修复）。

    dynamo 的 launch 腿（地球中心双曲线）径向剖面、能量与近拱点均为真实任务值：
    v∞=4.09 km/s（C3≈16.7，实测 16.60）、rp=6,645 km≈入轨近地点、首帧
    r=8,284 km @ 1997-10-15 09:27 与根数自洽——但其速度方向相对真实出射方向
    偏 ~78–84°（与飞掠腿的镜像缺陷同族：直接渲染会把逃逸段画到错误一侧，
    并与 sun/1 真实弧形成倒钩）。正确出射几何由真实巡航腿 sun/1 在腿边界
    t_b（=launch 腿终点 1997-10-18 16:01，r_rel≈124 万 km）的地球系状态钉定：
      轨道面 ĥ = unit(r_rel × v_rel)（真实远场）；
      v∞² = |v_rel|² − 2μ/r_rel（能量）→ A = μ/v∞²，e = 1 + rp/A（rp 钉腿根数）；
      渐近线 = 实测 v̂(t_b) 沿 ĥ 前旋剩余转弯 ψ（出臂到无穷远尚差的 ~0.6°，
      与飞掠入臂的 −ψ 回退互为镜像；符号取与 sun/1 边界速度方向差最小者）；
      t_peri 钉腿根数（入轨近地点时刻）。
    t_b 在地球 SOI（92.5 万 km）之外，日心摄动使该处密切根数外推出的
    rp（7,868 km）偏离真实近地点，故 rp 不用状态向量反解值而钉腿根数；
    由此产生的边界处 ~数千 km 径向残差由烘焙端 36h 混合窗吸收。
    返回 {"con", "t0", "tb", "t_peri", "rp"}，数据缺失返回 None。"""
    leg = "sc_cassini/earth/launch/orb"
    pts = load_points(leg)["points"]
    if len(pts) < 2:
        return None
    mu = def_mu(leg)
    kf = min(pts, key=lambda p: abs(p[4]))
    t_peri = kf[0] - kf[4] / math.sqrt(mu / abs(kf[1]) ** 3)
    rp = abs(kf[1]) * (kf[2] - 1.0)
    t0, tb = pts[0][0], pts[-1][0]

    def rel_state(t, dt=600.0):
        pc0 = pos_at("earth/sun/orb", t - dt)
        pc1 = pos_at("earth/sun/orb", t + dt)
        pl0 = pos_at("sc_cassini/sun/1/orb", t - dt)
        pl1 = pos_at("sc_cassini/sun/1/orb", t + dt)
        pt = pos_at("sc_cassini/sun/1/orb", t)
        ce = pos_at("earth/sun/orb", t)
        r = (pt[0] - ce[0], pt[1] - ce[1], pt[2] - ce[2])
        v = tuple(((pl1[k] - pl0[k]) - (pc1[k] - pc0[k])) / (2.0 * dt) for k in range(3))
        return r, v

    r_rel, v_rel = rel_state(tb)
    rr = math.sqrt(dot3(r_rel, r_rel))
    vinf2 = dot3(v_rel, v_rel) - 2.0 * mu / rr
    A = mu / vinf2
    e = 1.0 + rp / A
    hh = unit3(cross3(r_rel, v_rel))
    # 剩余转弯 ψ（公式与 hyp_conic.bend_at 相同，A/e 已定，无需先建圆锥曲线）
    p_ = A * (e * e - 1.0)
    nx = math.acos(max(-1.0, min(1.0, (p_ / rr - 1.0) / e)))
    ni = math.acos(-1.0 / e)
    u1, u2 = math.sin(nx), e + math.cos(nx)
    w1, w2 = math.sin(ni), e - 1.0 / e
    psi = math.acos(max(-1.0, min(1.0, (u1 * w1 + u2 * w2) /
                                       (math.hypot(u1, u2) * math.hypot(w1, w2)))))
    sq = math.sqrt(e * e - 1.0)
    # 出臂反解 P（与飞掠入臂公式互为镜像）：v̂∞⁺ = (−P + √(e²−1)Q)/e
    #   → P = −(v̂∞⁺ + √(e²−1)·(ĥ×v̂∞⁺))/e（飞掠入臂为 P = (v̂∞⁻ − √(e²−1)·ĥ×v̂∞⁻)/e）
    best = None
    for sgn in (+1.0, -1.0):
        vinf = rodrigues(unit3(v_rel), hh, sgn * psi)
        w = cross3(hh, vinf)
        P = unit3(tuple(-(vinf[k] + sq * w[k]) / e for k in range(3)))
        con = hyp_conic(mu, A, e, P, cross3(hh, P), t_peri)
        a_j = ang3(con["vel"](tb), v_rel)
        if best is None or a_j < best[0]:
            best = (a_j, con)
    a_j, con = best
    gap = math.sqrt(sum((con["pos"](tb)[k] - r_rel[k]) ** 2 for k in range(3)))
    r0 = con["pos"](t0)
    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t_peri + J2000_S))
    print(f"  [Launch] rp={rp:,.0f} km（腿根数=入轨近地点）  t_peri={ts}  "
          f"v∞={math.sqrt(vinf2):.3f} km/s（C3={vinf2:.2f}，实测 16.60）")
    print(f"    边界 t_b 对比：位置差 {gap:,.0f} km  速度方向差 {a_j:.3f}°"
          f"（36h 混合窗吸收）；首帧 |r|={math.sqrt(dot3(r0, r0)):,.0f} km（腿实测 8,284）")
    if a_j > 2.0:
        print("    !! 警告：重构双曲线与 sun/1 边界速度方向差 >2°，请核查")
    return {"con": con, "t0": t0, "tb": tb, "t_peri": t_peri, "rp": rp}


def build_saturn_approach():
    """土星 SOI 接近段重构（与飞掠/发射腿同族的定向缺陷修复）。

    dynamo saturn/orb 腿（土心，2004-05-30 20:01 起）的入臂双曲线整体镜像：
    NAIF SPICE(-82) 仲裁实测 ∠(h_leg, h_true) 在 2004-06 全程 172°→180°
    （反平行），∠(P_leg, P_true) 仅 0.4°–7°（近拱点方向一致）——首键帧当日
    位置即差 11,947,264 km。与飞掠腿/发射腿同一伪造模式：只有 rp 与 t_peri
    是真实任务值（rp≈80,289 km、t_peri=2004-07-01 ≈02:37 UTC）。直接渲染会把
    接近段画到土星的错误一侧（与 NASA Eyes 对比可见的"镜像"缺陷）。

    正确入臂几何由「sun/4 真实边界状态 + 腿根数 rp/t_peri」构造（sun/4 为
    真实历表：SPICE 全段误差 ≤18 万 km；边界 t0 = 两腿交界 = saturn/orb
    首键帧）：
      轨道面 ĥ = unit(r_rel × v_rel)（真实远场）；
      v∞² = |v_rel|² − 2μ/r_rel → A 初值 = μ/v∞²，e = 1 + rp/A（rp 钉腿根数）；
      渐近线 = 实测 v̂(t0) 沿 ĥ 回退剩余转弯 ψ（入臂；符号自动试取）；
      A 反解：钉定 rp/t_peri 不动，沿迹相位差（太阳潮 ~31 天累积 11.4 万 km）
      由 A 吸收（SPICE 仲裁：中程误差 113k→12k 改善为 27k→11k km）；
      t_peri 钉腿根数（SOI 捕获近拱点）。
    返回 {"con", "t0", "t_peri", "rp", "gap", "vinf"}，数据缺失返回 None。"""
    leg = "sc_cassini/saturn/orb"
    pts = load_points(leg)["points"]
    if len(pts) < 2:
        return None
    mu = def_mu(leg)
    # SOI 捕获近拱点帧：入臂 90 天窗口内 e>1（双曲线）的根数帧中取 |M0| 最小
    # （saturn/orb 全腿 1570 帧，环绕段每个近拱后都有 M0≈0 的帧，不可全局取）
    hyp_kfs = [p for p in pts if p[2] > 1.0 and p[0] < pts[0][0] + 90 * 86400.0]
    kf = min(hyp_kfs, key=lambda p: abs(p[4]))
    t_peri = kf[0] - kf[4] / kf[3]
    rp = conic_r(kf, t_peri)
    t0 = pts[0][0]   # 两腿交界（= sun/4 终点 = saturn/orb 首键帧）

    def rel_state(t, dt=600.0):
        pl0 = pos_at("sc_cassini/sun/4/orb", t - dt)
        pl1 = pos_at("sc_cassini/sun/4/orb", t + dt)
        pt = pos_at("sc_cassini/sun/4/orb", t)
        c0 = pos_at("saturn/sun/orb", t - dt)
        c1 = pos_at("saturn/sun/orb", t + dt)
        cc = pos_at("saturn/sun/orb", t)
        r = (pt[0] - cc[0], pt[1] - cc[1], pt[2] - cc[2])
        v = tuple(((pl1[k] - pl0[k]) - (c1[k] - c0[k])) / (2.0 * dt) for k in range(3))
        return r, v

    r_rel, v_rel = rel_state(t0)
    rr = math.sqrt(dot3(r_rel, r_rel))
    vinf2 = dot3(v_rel, v_rel) - 2.0 * mu / rr
    A = mu / vinf2
    e = 1.0 + rp / A
    hh = unit3(cross3(r_rel, v_rel))
    # 剩余转弯 ψ（公式与 hyp_conic.bend_at 相同；A/e 已定无需先建圆锥曲线）
    p_ = A * (e * e - 1.0)
    nx = math.acos(max(-1.0, min(1.0, (p_ / rr - 1.0) / e)))
    ni = math.acos(-1.0 / e)
    u1, u2 = math.sin(nx), e + math.cos(nx)
    w1, w2 = math.sin(ni), e - 1.0 / e
    psi = math.acos(max(-1.0, min(1.0, (u1 * w1 + u2 * w2) /
                                       (math.hypot(u1, u2) * math.hypot(w1, w2)))))
    sq = math.sqrt(e * e - 1.0)
    # 入臂反解 P（rebuild_flyby 同式）：v̂∞⁻ = (−P − √(e²−1)Q)/e
    #   → P = (v̂∞⁻ − √(e²−1)·(ĥ×v̂∞⁻))/e；ψ 旋向符号自动试取
    best = None
    for sgn in (+1.0, -1.0):
        vinf = rodrigues(unit3(v_rel), hh, sgn * psi)
        w = cross3(hh, vinf)
        P = unit3(tuple((vinf[k] - sq * w[k]) / e for k in range(3)))
        con = hyp_conic(mu, A, e, P, cross3(hh, P), t_peri)
        a_j = ang3(con["vel"](t0), v_rel)
        if best is None or a_j < best[0]:
            best = (a_j, sgn, P)
    a_j, sgn, P = best

    # 反解半长轴 A：钉定 rp/t_peri 不动，沿迹相位由 A 吸收（太阳潮在 17.2M km
    # 处累积 ~31 天的相位差使位置残差达 11.4 万 km；A 增大 → 平均运动减小 →
    # t0 相位后移，单调）。解出后边界位置残差 <10 km，6 月中程误差（SPICE
    # 仲裁）由钉定版的 113k→12k km 改善为 ~27k→11k km，且无需宽混合窗。
    def gap_along(A_x):
        e_x = 1.0 + rp / A_x
        sq_x = math.sqrt(e_x * e_x - 1.0)
        p_x = A_x * (e_x * e_x - 1.0)
        nx_x = math.acos(max(-1.0, min(1.0, (p_x / rr - 1.0) / e_x)))
        ni_x = math.acos(-1.0 / e_x)
        u_x1, u_x2 = math.sin(nx_x), e_x + math.cos(nx_x)
        w_x1, w_x2 = math.sin(ni_x), e_x - 1.0 / e_x
        psi_x = math.acos(max(-1.0, min(1.0, (u_x1 * w_x1 + u_x2 * w_x2) /
                                             (math.hypot(u_x1, u_x2) * math.hypot(w_x1, w_x2)))))
        vinf_x = rodrigues(unit3(v_rel), hh, sgn * psi_x)
        w_x = cross3(hh, vinf_x)
        P_x = unit3(tuple((vinf_x[k] - sq_x * w_x[k]) / e_x for k in range(3)))
        con_x = hyp_conic(mu, A_x, e_x, P_x, cross3(hh, P_x), t_peri)
        d = tuple(con_x["pos"](t0)[k] - r_rel[k] for k in range(3))
        vhat = unit3(v_rel)
        return dot3(d, vhat), con_x

    lo_A, hi_A = 0.95 * A, 1.15 * A
    s_lo, con_lo = gap_along(lo_A)
    s_hi, _ = gap_along(hi_A)
    if s_lo * s_hi > 0:
        A = hi_A if abs(s_hi) < abs(s_lo) else lo_A
        _, con = gap_along(A)
    else:
        for _ in range(60):
            mid_A = 0.5 * (lo_A + hi_A)
            s_mid, con_mid = gap_along(mid_A)
            if abs(s_mid) < 10.0:
                break
            if (s_lo > 0) == (s_mid > 0):
                lo_A, s_lo = mid_A, s_mid
            else:
                hi_A, s_hi = mid_A, s_mid
        A = 0.5 * (lo_A + hi_A)
        _, con = gap_along(A)
    e = 1.0 + rp / A
    gap = math.sqrt(sum((con["pos"](t0)[k] - r_rel[k]) ** 2 for k in range(3)))
    a_j = ang3(con["vel"](t0), v_rel)
    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t_peri + J2000_S))
    print(f"  [Saturn-approach] rp={rp:,.0f} km（腿根数=SOI 近拱点）  t_peri={ts}  "
          f"v∞={math.sqrt(mu / A):.3f} km/s（实测 {math.sqrt(vinf2):.3f}，潮差被 A 吸收）  e={e:.4f}")
    print(f"    边界 t0（两腿交界）：位置残差 {gap:,.0f} km  速度方向差 {a_j:.3f}°"
          f"（混合窗吸收）；|r(t0)|={rr:,.0f} km")
    if a_j > 2.0:
        print("    !! 警告：重构双曲线与 sun/4 边界速度方向差 >2°，请核查")
    return {"con": con, "t0": t0, "t_peri": t_peri, "rp": rp,
            "gap": gap, "vinf": math.sqrt(mu / A)}


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
    # 时间域覆盖整个任务（1997-06 起）：此前只烘 2004 起，卡西尼到达前
    # （1997–2004）卫星位置钳制在首帧、密切根数外推的轨道线修正量 Δ 随时间
    # 线性放大——卫星冻结不动、轨道线远飘，即"到达前卫星轨道错乱"。
    # dynamo 卫星腿原始数据自 1995-12 起可用，直接扩展时间域即可。
    MOON_STEPS = {"titan": day / 4, "moon": day / 4, "enceladus": 7200.0,
                  "mimas": 5400.0, "tethys": 9600.0, "dione": 13500.0,
                  "rhea": 20500.0, "iapetus": day / 2}
    moons_bodies = {}
    moons_raw = {}   # name -> (t0, step, f32 pts)：供烘焙端 moon_cr 复刻运行时插值
    t0m, t1m = t0p, et(2017, 12, 31)
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
        # launch 腿 150s：逃逸近拱段速度 ~10 km/s，600s 弦差数千 km（模型位置网格）
        "sc_cassini/earth/launch/orb": ("earth/sun/orb", day / 576),
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

    # 发射逃逸腿重构：dynamo launch 腿方向被虚构（偏 ~80°），改用
    # 「sun/1 真实边界状态 + 腿根数 rp/t_peri」构造的地球中心双曲线（见下）。
    # 末端同样 36h 混入 sun/1 真实弧（与 merged 窗口一致，模型位置无跳变）。
    lbuild = build_launch_escape()
    sbuild = build_saturn_approach()
    if lbuild:
        lcon = lbuild["con"]
        t0l, t1l = legs["sc_cassini/earth/launch/orb"]
        step_l = leg_specs["sc_cassini/earth/launch/orb"][1]
        n = int(round((t1l - t0l) / step_l)) + 1
        pts_l = []
        for i in range(n):
            tt = t0l + i * step_l
            r = lcon["pos"](tt)
            c = pos_at("earth/sun/orb", tt)
            cr = (r[0] + c[0], r[1] + c[1], r[2] + c[2])
            if tt > t1l - 36 * 3600.0:
                s = smoothstep((tt - (t1l - 36 * 3600.0)) / (36 * 3600.0))
                sr = pos_at("sc_cassini/sun/1/orb", tt)
                cr = (cr[0] + (sr[0] - cr[0]) * s,
                      cr[1] + (sr[1] - cr[1]) * s,
                      cr[2] + (sr[2] - cr[2]) * s)
            pts_l.append(cr)
        leg_data["sc_cassini/earth/launch/orb"] = (t0l, step_l, pts_l)
        print(f"cassini launch leg REBUILT: {len(pts_l)} pts @150s（地球逃逸双曲线）")

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
    # 这里只保留一处巡航腿之间的衔接（launch→sun/1 已由逃逸段重构接管：
    # 重构双曲线钉定 sun/1 边界真实状态，边界处天然连续，无需交叉淡化）。
    # sun/4→saturn/orb 的 30 天交叉淡化已删除：该拼接曾把真实 sun/4 弧与
    # 镜像的 saturn/orb 入臂弧（边界 gap 11,998,793 km）强行混合，2004-04-30
    # ..05-30 的轨迹纯属捏造；接近段现由 build_saturn_approach 重构接管
    # （重构双曲线钉定 sun/4 边界真实状态，交界处天然连续，无需淡化）。
    SPLICE_W = {}
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
    #   相对行星的轨迹 = 「真实状态 + 真实近拱点」构造的行星中心双曲线
    #     （dynamo 飞掠腿圆锥曲线整体镜像、不可外推——详见 rebuild_flyby）；
    #   日心轨迹      = planet32(t) + rel(t) 重构，使前端锚定后
    #                   anchor(行星运行时位置) + rel ≡ 日心轨迹顶点，
    #                   "相对轨迹 ∩ 日心轨迹 = Cassini 实际位置"逐点零偏差成立。
    # 窗口边界（SOI 穿越时刻）与巡航腿之间平滑过渡：过渡半宽 Δb = δ/8 km/s
# （δ = 边界处两套数据主张差），人工横向速度 ≤8 km/s ≪ 真实 ~30 km/s，
# 观感为一次平滑的借力转弯而非折角。巡航腿之间的旧拼接仅保留
# sun/4→saturn/orb 一处（launch→sun/1 由发射逃逸段重构接管，见 build_launch_escape）。
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

    def rebuild_flyby(label, leg, cruise_a, cruise_b, planet, r_soi, mu):
        """飞掠段重构（真实双曲线权威窗口 + 外移漂移过渡），返回 SOI 穿越时刻 (tin, tout)。

        dynamo 飞掠腿的圆锥曲线相对真实轨迹整体镜像——角动量反平行（实测
        V1/V2/Earth 的 h 与巡航腿实测转弯平面法向夹角 179–180°），只有近掠
        距离与近拱点时刻是真实任务值（V1 284 km @ 1998-04-26 13:45 UTC、
        V2 598 km @ 1999-06-24 20:30 UTC、Earth 1171 km @ 1999-08-18 03:28
        UTC）。直接外推会把弹弓绕到行星错误的一侧（渲染 bug 的根源）。

        正确的行星中心双曲线由「真实状态 + 真实近拱点」构造：
          1. 轨道面 ĥ = unit(v_in × v_out)：v_in/v_out 取巡航腿（sun/N，远离
             行星处为真实历表）在 SOI 穿越时刻的行星系速度；
          2. 转弯角 δ = ∠(v_in, v_out)（方向测量，最稳）→ e = 1/sin(δ/2)；
             半长轴 A = rp/(e−1)——近拱点 rp 钉在腿根数的真实任务值；
          3. 入射渐近线 = 实测 v(SOI) 回退 bend(SOI)（双曲线到 SOI 边界已
             累积的速度方向转弯，~0.03°），使边界处与真实入射弧严格相切；
          4. 近拱点时刻 t_peri 取腿关键帧（与任务实录一致）。
        交叉验证：由实测转弯角反解的 rp 与任务值闭合到 0.1–1%，出臂渐近线
        与后继巡航腿速度方向一致（<0.5°）。
        巡航弧与真实双曲线在 2.5×SOI 处仅差数千 km（真实轨迹在该处尚未被
        明显弯曲），过渡区半宽 B = δ/2.5 km/s 的位置混合观感为平滑借力。"""
        kf = conic_peri_kf(leg)
        t_peri = kf[0] - kf[4] / kf[3]
        rp = conic_r(kf, t_peri)

        def cruise_rel(t):
            leg_ = cruise_a if t <= t_peri else cruise_b
            pc = pos_at(planet + "/sun/orb", t)
            pl = pos_at(leg_, t)
            r = (pl[0] - pc[0], pl[1] - pc[1], pl[2] - pc[2])
            dt = 600.0
            p0, p1 = pos_at(leg_, t - dt), pos_at(leg_, t + dt)
            c0 = pos_at(planet + "/sun/orb", t - dt)
            c1 = pos_at(planet + "/sun/orb", t + dt)
            v = tuple(((p1[k] - p0[k]) - (c1[k] - c0[k])) / (2.0 * dt) for k in range(3))
            return r, v

        t_in, t_out = t_peri - 86400.0, t_peri + 86400.0
        con = None
        for _ in range(5):
            r_in, v_in = cruise_rel(t_in)
            _, v_out = cruise_rel(t_out)
            turn = ang3(v_in, v_out)
            e = 1.0 / math.sin(math.radians(turn) / 2.0)   # 转弯角钉 e（方向测量最稳）
            A = rp / (e - 1.0)                             # 近拱点钉腿根数任务值
            hh = unit3(cross3(v_in, v_out))
            psi = con["bend_at"](r_soi) if con else 0.0
            vinf = rodrigues(unit3(v_in), hh, -psi)        # SOI 实测方向 → 渐近线方向
            w = cross3(hh, vinf)
            P = unit3(tuple((vinf[k] - math.sqrt(e * e - 1.0) * w[k]) / e for k in range(3)))
            con = hyp_conic(mu, A, e, P, cross3(hh, P), t_peri)
            t_in2 = con["radius_t"](r_soi, False)
            t_out2 = con["radius_t"](r_soi, True)
            done = abs(t_in2 - t_in) < 2.0 and abs(t_out2 - t_out) < 2.0
            t_in, t_out = t_in2, t_out2
            if done:
                break
        tin, tout = t_in, t_out

        # 核对：入臂/出臂边界速度连续性 + 能量一致性
        r_in, v_in = cruise_rel(tin)
        _, v_out = cruise_rel(tout)
        v_con_in, v_con_out = con["vel"](tin), con["vel"](tout)
        vinf = math.sqrt(mu / con["A"])
        print(f"  [{label}] rp={rp:,.0f} km（腿根数任务值）  转弯 {ang3(v_in, v_out):.2f}°"
              f"（=2 asin 1/e）  v∞={vinf:.3f} km/s")
        print(f"    切向连续：入臂 {ang3(v_con_in, v_in):.3f}°  出臂 {ang3(v_con_out, v_out):.3f}°"
              f"   能量：双曲线 |v(SOI)|={norm3(v_con_in):.3f} vs 巡航 {norm3(v_in):.3f} km/s")

        r_patch = 2.5 * r_soi
        t_p_in = con["radius_t"](r_patch, False)
        t_p_out = con["radius_t"](r_patch, True)

        def cruise_ref(t):
            # 巡航腿是日心根数；跨越飞掠间隙的区段由前后腿各自外推
            return pos_at(cruise_a if t <= t_peri else cruise_b, t)

        def rebuilt(t):
            rr = con["pos"](t)
            c = planet32(planet, t)
            return (rr[0] + c[0], rr[1] + c[1], rr[2] + c[2])

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
                            "venus", SOI_RADII["venus"], def_mu("sc_cassini/venus/flyby1/orb"))
    v2_span = rebuild_flyby("Venus-2", "sc_cassini/venus/flyby2/orb",
                            "sc_cassini/sun/2/orb", "sc_cassini/sun/3/orb",
                            "venus", SOI_RADII["venus"], def_mu("sc_cassini/venus/flyby2/orb"))
    ef_span = rebuild_flyby("Earth", "sc_cassini/earth/flyby/orb",
                            "sc_cassini/sun/3/orb", "sc_cassini/sun/4/orb",
                            "earth", SOI_RADII["earth"], def_mu("sc_cassini/earth/flyby/orb"))

    # ---------- 发射逃逸段重构（merged 窗口替换，同飞掠段方案） ----------
    # dynamo launch 腿（地球中心双曲线）方向被虚构（实测相对 sun/1 推出的真实
    # 出射方向偏 ~78–84°，与飞掠腿镜像缺陷同族），segment 由 build_launch_escape
    # 构造的「sun/1 真实边界状态 + 腿根数 rp/t_peri」双曲线替换：
    #   merged[t0l, t_bl] = planet32(earth) + rel_conic，密度 60s（近拱 +2h）
    #   /300s（+12h）/600s；末端 36h 混入 sun/1 真实弧（t_b 在 SOI 外，
    #   密切根数外推残差 ~数千 km，混合窗内平滑吸收，SOI 显示窗之外）。
    if lbuild:
        lcon = lbuild["con"]
        t0l, tbl = lbuild["t0"], lbuild["tb"]
        W_l = 36 * 3600.0
        tp_l = lbuild["t_peri"]
        times_l = []
        t = t0l
        while t <= tbl:
            times_l.append(t)
            dtp = t - tp_l
            t += (60.0 if dtp < 2 * 3600.0 else
                  (300.0 if dtp < 12 * 3600.0 else 600.0))
        if times_l[-1] < tbl:
            times_l.append(tbl)
        new_pts = []
        for t in times_l:
            s = smoothstep((t - (tbl - W_l)) / W_l) if t > tbl - W_l else 0.0
            e = planet32("earth", t)
            r = lcon["pos"](t)
            cr = (r[0] + e[0], r[1] + e[1], r[2] + e[2])
            if s > 0.0:
                sr = pos_at("sc_cassini/sun/1/orb", t)
                cr = (cr[0] + (sr[0] - cr[0]) * s,
                      cr[1] + (sr[1] - cr[1]) * s,
                      cr[2] + (sr[2] - cr[2]) * s)
            new_pts.append((t, f32(cr[0]), f32(cr[1]), f32(cr[2])))
        lo = bisect.bisect_left(merged_t, t0l)
        hi = bisect.bisect_right(merged_t, tbl)
        merged[lo:hi] = new_pts
        merged_t[lo:hi] = [p[0] for p in new_pts]
        print(f"  rebuild[Launch] merged {iso(t0l)} .. {iso(tbl)} 替换 {len(new_pts)} pts"
              f"（近拱+2h @60s / +12h @300s，末端 {W_l / 3600:.0f}h 混入 sun/1）")

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

    # ---------- 土星 SOI 接近段重构（merged 窗口替换，同发射段方案） ----------
    # dynamo saturn/orb 腿的入臂双曲线整体镜像（SPICE 仲裁：h 反平行
    # 172–180°、近拱点方向一致，首键帧当日位置即差 11.9M km；rp/t_peri 为
    # 真实任务值），由 build_saturn_approach 构造的「sun/4 真实边界状态 +
    # 腿根数 rp/t_peri」土心入臂双曲线替换 merged[t_w0, t_w1]：
    #   近端：交界 t0（=腿首键帧）两侧 W_in/2 内与 sun/4 真实弧平滑混合
    #         （A 反解后边界位置残差 ~10 km，混合窗仅作平滑衔接）；
    #   远端：t_peri+1h .. +6h 混入 saturn/orb 真实捕获弧（SOI 主发动机
    #         点火 2004-07-01 01:12–02:48 UTC 已完成，其后腿数据真实）。
    # 相对行星锚定语义与 rebuild_flyby 一致：日心 = rel + planet32(t)。
    if sbuild:
        scon = sbuild["con"]
        t0s, tps = sbuild["t0"], sbuild["t_peri"]
        W_in = max(6 * 3600.0, min(3 * 86400.0, sbuild["gap"] / 2.5))
        w0s = t0s - 0.5 * W_in
        t_bl0 = tps + 1 * 3600.0
        w1s = tps + 6 * 3600.0
        times_s = []
        t = w0s
        while t <= w1s:
            times_s.append(t)
            dtp = abs(t - tps)
            t += (60.0 if dtp < 2 * 3600.0 else
                  (300.0 if dtp < 12 * 3600.0 else
                   (900.0 if dtp < 3 * 86400.0 else 1800.0)))
        new_pts = []
        for t in times_s:
            rc = scon["pos"](t)
            cs = planet32("saturn", t)
            rb = (rc[0] + cs[0], rc[1] + cs[1], rc[2] + cs[2])
            cr = pos_at("sc_cassini/sun/4/orb", t)   # 日心近端混合基准
            s_in = smoothstep(min(1.0, max(0.0, (t - w0s) / W_in)))
            px = cr[0] + (rb[0] - cr[0]) * s_in
            py = cr[1] + (rb[1] - cr[1]) * s_in
            pz = cr[2] + (rb[2] - cr[2]) * s_in
            if t > t_bl0:
                lp = pos_at("sc_cassini/saturn/orb", t)
                cp = pos_at("saturn/sun/orb", t)
                s_out = smoothstep(min(1.0, max(0.0, (t - t_bl0) / (w1s - t_bl0))))
                px += (lp[0] + cp[0] - px) * s_out
                py += (lp[1] + cp[1] - py) * s_out
                pz += (lp[2] + cp[2] - pz) * s_out
            new_pts.append((t, f32(px), f32(py), f32(pz)))
        lo = bisect.bisect_left(merged_t, w0s)
        hi = bisect.bisect_right(merged_t, w1s)
        merged[lo:hi] = new_pts
        merged_t[lo:hi] = [p[0] for p in new_pts]
        print(f"  rebuild[Saturn-approach] merged {iso(w0s)} .. {iso(w1s)} 替换 "
              f"{len(new_pts)} pts（近拱 ±2h @60s；近端混合窗 {W_in / 3600:.1f}h，"
              f"t_peri+1h..+6h 混入捕获弧）")

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
    # 接近段重构窗口 [t0, t_peri+6h] 内 saturn/orb 腿为镜像假数据：
    # 卫星近掠扫描从重构结束之后开始（其后腿数据真实）
    if sbuild:
        ts0 = max(ts0, sbuild["t_peri"] + 6 * 3600.0)

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


    # ---------- 任务终段延伸（item 5） ----------
    # dynamo saturn/orb 腿止于 2017-09-15 10:34 ET（= 坠入事件的航天器时；
    # NASA 公布的 11:55 UTC 信号消失为地面接收时刻，减 ~83 min 光行时即此），
    # 但基础网格末端整数步长点落在 ~10:01（r≈11 万 km）——轨迹停在土星上空
    # 4 万公里、从未到达行星，即"最终坠入土星的轨迹错误"。腿最后根数关键帧
    # （r=61,174 km）的圆锥曲线在 pos_at 对 t>=末帧时自动外推，把轨迹延到
    # 土星大气界面（r ≤ 60,050 km，1-bar + ~1,800 km，接近真实进入高度）。
    R_ENTRY_SAT = 60050.0
    t_ext0 = merged_t[-1]
    t_ext_max = legs["sc_cassini/saturn/orb"][1] + 2 * 3600.0
    ext_pts = []
    t = t_ext0
    while True:
        lp = pos_at("sc_cassini/saturn/orb", t)
        cp = pos_at("saturn/sun/orb", t)
        r = math.sqrt(lp[0] * lp[0] + lp[1] * lp[1] + lp[2] * lp[2])
        ext_pts.append((t,) + tuple(f32(lp[k] + cp[k]) for k in range(3)))
        if r <= R_ENTRY_SAT:
            break
        t_next = min(t + (60.0 if r < 7.0e4 else 300.0), t_ext_max)
        if t_next <= t:
            break
        t = t_next
    if len(ext_pts) > 1 and ext_pts[-1][0] > t_ext0 + 1.0:
        merged.extend(ext_pts[1:])
        merged_t.extend(p[0] for p in ext_pts[1:])
        print(f"  final plunge extended: +{len(ext_pts) - 1} pts, "
              f"{iso(t_ext0)} -> {iso(merged_t[-1])} (atmosphere interface)")

    tt = [p[0] for p in merged]
    flat = [v for p in merged for v in p[1:]]
    cassini["trailT"] = base64.b64encode(struct.pack(f"<{len(tt)}d", *tt)).decode("ascii")
    cassini["trail"] = base64.b64encode(struct.pack(f"<{len(flat)}f", *flat)).decode("ascii")
    cassini["trailN"] = len(merged)
    print(f"cassini merged trail: {len(merged)} pts")

    # ---------- SOI（引力影响球）内相对行星的轨迹 ----------
    # 窗口 = Cassini 位于真实 SOI 半径内的时间区间（±45 min 余量）。
    # 窗口几何 = merged 主轨迹顶点的子区间：rel(t) = merged32(t) − planet32(t)
    # 由烘焙端保证，前端直接取主轨迹顶点渲染即得相对轨迹（免除旧版 f32 相对
    # 坐标在土星距离下 ~60 m 的量化偏差，且两轨迹交点恒精确重合）。
    # 因此数据只需窗口时间域端点 {a, b}（merged 点域），无需重复存顶点。
    #   venus  ×2：飞掠重构窗口（近拱点根数外推的双曲线）
    #   earth  ×2：1997 发射逃逸段（发射即在 SOI 内）+ 1999 回掠重构窗口
    #   jupiter   ：日心弧本身即真实借力路径
    #   saturn    ：进入 SOI（接近段）起至任务结束（坠入大气）
    #   moons  ×N：卫星 SOI 穿越窗口（二级相对轨迹）
    MARGIN = 45 * 60.0

    def soi_window(t_from, t_to):
        k0 = bisect.bisect_left(merged_t, t_from)
        k1 = bisect.bisect_right(merged_t, t_to) - 1
        if k1 - k0 < 1:
            return None
        return {"a": merged_t[k0], "b": merged_t[k1]}

    soi = {}
    soi["venus"] = [w for w in (
        soi_window(v1_win[0] - MARGIN, v1_win[1] + MARGIN),
        soi_window(v2_win[0] - MARGIN, v2_win[1] + MARGIN)) if w]
    # 发射逃逸段：发射时即位于地球 SOI 内，窗口终点为穿出 SOI 的时刻
    l_out = merged_soi_span("earth", merged_t[0], et(1997, 11, 15),
                            SOI_RADII["earth"], step=3600.0)[1]
    soi["earth"] = [w for w in (
        soi_window(merged_t[0], l_out + MARGIN),
        soi_window(ef_win[0] - MARGIN, ef_win[1] + MARGIN)) if w]
    j_in, j_out = merged_soi_span("jupiter", et(2000, 8, 1), et(2001, 5, 1),
                                  SOI_RADII["jupiter"])
    soi["jupiter"] = [w for w in (
        soi_window(j_in - MARGIN, j_out + MARGIN),) if w]

    # ---------- 卫星 SOI（二级相对轨迹，item 3）----------
    # 窗口来自卫星近掠段的腿评估细扫描（soi_wins_by_moon，粗网格会漏掉
    # Enceladus ~490 km 量级的百秒级穿越）。
    for mname, wins in soi_wins_by_moon.items():
        rows_packed = []
        for (wa, wb) in wins:
            w = soi_window(wa - MARGIN, wb + MARGIN)
            if w:
                rows_packed.append(w)
        if rows_packed:
            soi[mname] = rows_packed
            print(f"soi moon {mname}: {len(rows_packed)} windows, "
                  f"{sum(b['b'] - b['a'] for b in rows_packed) / 3600:.1f} h total")

    s_in, _ = merged_soi_span("saturn", et(2004, 1, 1), ts0,
                              SOI_RADII["saturn"], step=2 * 3600.0)
    soi["saturn"] = [w for w in (
        soi_window(s_in - MARGIN, merged_t[-1]),) if w]
    cassini["soi"] = soi
    for _tag in ("venus", "earth", "jupiter", "saturn"):
        _info = []
        for _w in soi[_tag]:
            _t0, _t1 = _w["a"], _w["b"]
            _p0 = merged_interp(_t0)
            _p1 = merged_interp(_t1)
            _c0 = planet32(_tag, _t0)
            _c1 = planet32(_tag, _t1)
            _r0 = math.sqrt((_p0[0] - _c0[0]) ** 2 + (_p0[1] - _c0[1]) ** 2 + (_p0[2] - _c0[2]) ** 2)
            _r1 = math.sqrt((_p1[0] - _c1[0]) ** 2 + (_p1[1] - _c1[1]) ** 2 + (_p1[2] - _c1[2]) ** 2)
            _info.append(f"{iso(_t0)}..{iso(_t1)} 边缘|rel|={_r0:,.0f}/{_r1:,.0f} km")
        print(f"soi {_tag}: " + "; ".join(_info))

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

    # ---------- Huygens 真实轨迹（dynamo sc_huygens 腿，item 4） ----------
    # 巡航段：sc_huygens/saturn/orb（土星中心，28 个真实根数关键帧，覆盖
    #   分离 → 进入，转移周期 31.9 天与真实 C 轨道一致）→ rel_saturn 行；
    # 进入段：sc_huygens/titan/orb（Titan 中心真实进入双曲线，近地点在
    #   Titan 内部——真空轨道被大气在 ~1,270 km 进入界面截断的物理形态）
    #   → rel_titan 行（纯 Titan 相对坐标：ENTRY 前取真实腿差 coast−titan，
    #   ENTRY 后取圆锥曲线 + Titan 系锚定 δ_t，详见下方拼接注释）；
    # 减速伞下降段：由进入段末端切向连续的贝塞尔弧接至着陆点（真实进入点
    #   方向径向投影到 Titan 表面）。
    # 时间基准（NASA science.nasa.gov Huygens Probe）：进入 09:06 UTC、下降
    #   2h27m（着陆 ~11:30 UTC）、着陆后表面工作 72 分钟后失联。
    SEP_ET_H = et(2004, 12, 25, 2, 0)
    ENTRY_ET_H = et(2005, 1, 14, 9, 6)
    DESCENT_S_H = 2 * 3600 + 27 * 60
    TD_ET_H = ENTRY_ET_H + DESCENT_S_H
    MU_TITAN = def_mu("sc_huygens/titan/orb")   # 8978.139 km³/s²（def.dyn 头）
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

    # Titan 进入段：dynamo 进入腿圆锥曲线相对真实接近方向整体镜像（h 与巡航
    # 接近方向反平行 179.9°，与飞掠腿同源），改用「真实近拱根数 + 巡航远场
    # 渐近线」构造：
    #   A/e/t_peri 取最接近进入界面的腿关键帧（真实：真空近掠 1445 km，进入
    #   界面 3845 km 穿越时刻与 09:06 UTC 实录一致）；
    #   ĥ/v̂∞ 取巡航腿（sc_huygens/saturn/orb，土星中心真实根数）在 Titan 远场
    #   （−48h，Titan SOI 外 ~22×，Titan 引力可忽略）的角动量/速度方向。
    huy_kfs = load_points("sc_huygens/titan/orb")["points"]
    kf_t = min(huy_kfs, key=lambda p: abs(p[0] - (ENTRY_ET_H - 600.0)))
    A_t = abs(kf_t[1])            # dynamo 双曲线腿存 |a|（正值）
    e_t = kf_t[2]
    sq_t = math.sqrt(e_t * e_t - 1.0)
    t_peri_t = kf_t[0] - kf_t[4] / kf_t[3]
    n_t = math.sqrt(MU_TITAN / (A_t ** 3))
    t_far = ENTRY_ET_H - 48 * 3600.0

    def titan_rel(t):
        tp = pos_at("titan/saturn/orb", t)
        hp = pos_at("sc_huygens/saturn/orb", t)
        return (hp[0] - tp[0], hp[1] - tp[1], hp[2] - tp[2])

    r_far = titan_rel(t_far)
    dtv = 1800.0
    v_far = tuple((titan_rel(t_far + dtv)[k] - titan_rel(t_far - dtv)[k]) / (2.0 * dtv)
                  for k in range(3))
    hh_t = unit3(cross3(r_far, v_far))
    vinf_t = unit3(v_far)
    w_t = cross3(hh_t, vinf_t)
    P_t = unit3(tuple((vinf_t[k] - sq_t * w_t[k]) / e_t for k in range(3)))
    Q_t = cross3(hh_t, P_t)

    def titan_entry_rel(t):
        H = solve_hyp(n_t * (t - t_peri_t), e_t)
        x = A_t * (e_t - math.cosh(H))
        y = A_t * sq_t * math.sinh(H)
        return (x * P_t[0] + y * Q_t[0], x * P_t[1] + y * Q_t[1], x * P_t[2] + y * Q_t[2])

    # 接近方向核对：−1h 处进入弧 vs 巡航弧的位置方向夹角（真实轨迹在该处已被
    # Titan 弯曲 ~4°；镜像 Bug 时为 ~154°）
    t_chk = ENTRY_ET_H - 3600.0
    print(f"  titan entry conic: rp={A_t * (e_t - 1.0):,.0f} km e={e_t:.3f} "
          f"t_peri={iso(t_peri_t)}  −1h 进入弧 vs 巡航弧方向夹角 "
          f"{ang3(titan_entry_rel(t_chk), titan_rel(t_chk)):.1f}°（物理弯曲 ~4°）")

    R_TITAN_H = RADII["titan"]

    # relTit 行 = 纯 Titan 中心相对坐标（前端直接锚定 Titan 实时位置，着陆点必须
    # 精确落在 r=R_TITAN 上）。拼接修复（惠更斯模型 bug）：
    #   ENTRY−1h..ENTRY：真实腿差 coast(t) − titan(t)（与巡航段/一级线天然连续）；
    #   ENTRY..T_AERO：进入圆锥曲线 + δ_t（Titan 系锚定 δ_t = 真实进入点 − 圆锥
    #   进入点，保证 ENTRY 处严格连续；不再把土星系拼接差混入 Titan 相对坐标，
    #   旧做法会使进入/下降段相对 Titan 整体偏移 ~|δ|，探测器落不到表面）。
    def coast_titan_rel(t):
        tp = moon_cr("titan", t)
        hp = pos_at("sc_huygens/saturn/orb", t)
        return tuple(hp[k] - tp[k] for k in range(3))

    p_entry = coast_titan_rel(ENTRY_ET_H)          # 真实进入点（Titan 相对）
    p_entry_conic = titan_entry_rel(ENTRY_ET_H)    # 圆锥曲线进入点
    r_entry = norm3(p_entry)
    d_tit = tuple(p_entry[k] - p_entry_conic[k] for k in range(3))
    print(f"  huygens entry: |rel(titan)| = {r_entry:,.0f} km"
          f"（R+1270 = {R_TITAN_H + 1270:,.0f}，conic {norm3(p_entry_conic):,.0f}）")
    print(f"  huygens coast↔entry 拼接差 |δ_t| = {norm3(d_tit):,.0f} km"
          f"（Titan 系锚定，仅作用于 ENTRY 之后的圆锥弧）")

    def titan_entry_anchored(t):
        p = titan_entry_rel(t)
        return (p[0] + d_tit[0], p[1] + d_tit[1], p[2] + d_tit[2])

    # 真空双曲线下潜到 ~160 km 高度处截断（此后大气/降落伞接管；按锚定后弧判定）
    T_AERO = ENTRY_ET_H
    for _i in range(240):
        _t = ENTRY_ET_H + _i * 10.0
        if norm3(titan_entry_anchored(_t)) < R_TITAN_H + 160.0:
            T_AERO = _t
            break

    ti_rows = []
    t = ENTRY_ET_H - 3600.0
    while t < ENTRY_ET_H:
        p = coast_titan_rel(t)
        ti_rows.append((t, f32(p[0]), f32(p[1]), f32(p[2])))
        t += 30.0
    while t <= T_AERO:
        p = titan_entry_anchored(t)
        ti_rows.append((t, f32(p[0]), f32(p[1]), f32(p[2])))
        t += 30.0
    if ti_rows[-1][0] < T_AERO:
        p = titan_entry_anchored(T_AERO)
        ti_rows.append((T_AERO, f32(p[0]), f32(p[1]), f32(p[2])))

    # 下降段贝塞尔：S = 气动截断点（切向连续），E = 真实进入点方向径向投影到表面，
    # C = S + 切向×0.45×drop + 侧向×0.12×drop（风漂移），ease-out 先快后慢。
    S3 = (ti_rows[-1][1], ti_rows[-1][2], ti_rows[-1][3])
    E3 = tuple(p_entry[k] / (r_entry + 1e-9) * R_TITAN_H for k in range(3))

    def V_norm3(v):
        n = norm3(v) or 1.0
        return (v[0] / n, v[1] / n, v[2] / n)

    def V_cross3(a, b):
        return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

    tan3 = V_norm3(tuple(S3[k] - titan_entry_anchored(T_AERO - 60.0)[k] for k in range(3)))
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
    # 任务终点 = 轨迹延伸后的大气进入时刻（≥ dynamo 腿末帧）
    t_end = merged_t[-1]
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
