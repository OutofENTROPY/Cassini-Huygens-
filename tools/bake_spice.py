# -*- coding: utf-8 -*-
"""bake_spice.py — 用 NAIF SPICE 重构历表直接采样烘焙前端数据（替代 dynamo 圆锥
曲线拟合方案），精度目标：任意时刻与 SPICE 真值偏差 ≤1 km（存储/插值自误差含入）。

数据源（data_raw/spice_kernels/extracted，由 analysis_kernels_small.tar.gz 解包）：
  lsk/naif0012.tls        闰秒
  pck/*.tpc               行星/卫星 GM、体参数
  spk/de4xx.bsp           行星历表（含 199/299/301/399 体中心）
  spk/sat4xx.bsp          土卫历表（相对土星系统质心）
  spk/cas*.bsp            卡西尼 -82 全任务重构轨道

输出（schema v2，前端 scene.js/huygens.js 配套更新）：
  data/cassini_data.js  bodies(行星+轨道线+密切根数) + spacecraft.cassini{
    trailT/trail   日心主轨迹（自适应弦差采样，f32）
    tracks         锚定体相对切比雪夫轨道（模型定位精度 ≤1 km）
    anchors        模型定位窗口表 [t0,t1,track]
    soi            SOI 相对轨迹窗口 {a,b}（前端由主轨迹顶点−历表求 rel）
    huygens        分离/进入/下降数据 + relCass 相对行 }
  data/moons_data.js    月球与土卫（母星体中心相对，细网格 CR）
"""
import base64
import bisect
import calendar
import ctypes
import glob
import json
import math
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
import spiceypy as sp

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data_raw", "spice_kernels", "extracted")
OUT = os.path.join(HERE, "..", "data")

J2000_UNIX = 946728000          # 2000-01-01T12:00:00 UTC 的 unix 秒（app 纪元）
T_START = calendar.timegm((1997, 10, 1, 0, 0, 0)) - J2000_UNIX
T_END = calendar.timegm((2017, 10, 1, 0, 0, 0)) - J2000_UNIX

RADII = {
    "sun": 696000.0, "mercury": 2439.7, "venus": 6051.8, "earth": 6371.0,
    "moon": 1737.4, "mars": 3389.5, "jupiter": 69911.0, "saturn": 58232.0,
    "uranus": 25362.0, "neptune": 24622.0,
    "titan": 2574.7, "enceladus": 252.1, "iapetus": 734.5, "rhea": 763.8,
    "dione": 561.4, "tethys": 531.1, "mimas": 198.2,
}
SOI_RADII = {"venus": 6.169e5, "earth": 9.247e5, "jupiter": 4.82e7, "saturn": 5.45e7}
MOON_SOI = {
    "titan": 4.33e4, "enceladus": 4.9e2, "rhea": 3.68e3, "dione": 1.95e3,
    "tethys": 1.21e3, "iapetus": 2.25e4, "mimas": 2.49e2,
}
# 前端 BODIES 顺序里的行星 / 卫星
PLANETS = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]
SAT_MOONS = ["titan", "enceladus", "iapetus", "rhea", "dione", "tethys", "mimas"]
PLANET_TARGET = {
    "mercury": "MERCURY BARYCENTER", "venus": "VENUS BARYCENTER",
    "earth": "EARTH", "mars": "MARS BARYCENTER",
    "jupiter": "JUPITER BARYCENTER", "saturn": "SATURN BARYCENTER",
    "uranus": "URANUS BARYCENTER", "neptune": "NEPTUNE BARYCENTER",
}
SAT_MOON_TARGET = {m: m.upper() for m in SAT_MOONS}
# 说明：全任务重构轨道中「体中心」的覆盖不完整（MARS/499 止于 1999-09-02、
# JUPITER/599 仅 1999-12-31..2001-03-23、SATURN/699 自 2004 起），而各「质心」
# （1..8）均为全任务覆盖（1997-10-15 .. 2017-09-16）。水星/金星/火星的卫星质量
# 可忽略，质心与体中心逐点相同；仅地球-月球质心差 ~4,400 km，故 earth 仍取体
# 中心 399（全任务覆盖）。

OBL = math.radians(23.4392911)
CE, SE = math.cos(OBL), math.sin(OBL)
F32 = struct.Struct("<f")

CHEB_DEG = 12
CHEB_TOL = 0.4          # km，切比雪夫拟合目标误差（前端求值误差同量级）
TRAIL_TOL = 30.0        # km，主轨迹弦差容限（线渲染精度；模型定位不走主轨迹）


def f32(v):
    return F32.unpack(F32.pack(v))[0]


def rss_mb():
    """进程工作集 + 系统可用内存（MB）。烘焙长跑的内存泄漏探针。"""
    try:
        import ctypes
        import ctypes.wintypes as wt

        class _PMC(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]
        if not hasattr(rss_mb, "_ready"):
            # 伪句柄 -1 必须以 64 位 HANDLE 传递：restype/argtypes 未声明时
            # 32 位 c_int 会被零扩展 → ERROR_INVALID_HANDLE（静默返回 0）
            ctypes.windll.kernel32.GetCurrentProcess.restype = wt.HANDLE
            ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [
                wt.HANDLE, ctypes.POINTER(_PMC), wt.DWORD]
            ctypes.windll.psapi.GetProcessMemoryInfo.restype = wt.BOOL
            rss_mb._ready = True
        pmc = _PMC()
        pmc.cb = ctypes.sizeof(pmc)
        h = ctypes.windll.kernel32.GetCurrentProcess()
        if not ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
            return -1.0
        return pmc.WorkingSetSize / 2 ** 20
    except Exception:
        return -1.0


def eq_to_ecl(v):
    return (v[0], v[1] * CE + v[2] * SE, -v[1] * SE + v[2] * CE)


def b64f64(arr):
    return base64.b64encode(np.asarray(arr, "<f8").tobytes()).decode("ascii")


def b64f32(arr):
    return base64.b64encode(np.asarray(arr, "<f4").tobytes()).decode("ascii")


# ---------- SPICE 装载 ----------

COSP = os.path.join(HERE, "..", "data_raw", "spice_kernels", "cosp")


def load_kernels():
    """COSP_1000 卷内核池：LSK → PCK×2 → SPK（co_* 巡航 → sat359 → R_SCPSE 链，
    后加载者优先）。返回已加载 SPK 路径清单。

    另纳入 analysis_kernels_small.tar.gz 解包出的补充内核（ops 目录）：
      spk/171215R_SCPSEops_97288_17258.bsp  Cassini -82 全任务重构轨道
          （覆盖 1997-10-15 .. 2017-09-15，无内部缺口）——单文件即完整覆盖
          发射→金星×2→地球→木星→土星→Grand Finale 全程，使 COSP 卷缺失
          co_* 巡航内核（1997–2001，见 missing_bsp.txt）时仍能通过
          verify_coverage。这是木星飞掠深度偏差（dynamo 根数不含真实近掠
          深度，实测加密采样到 10 s 仍为 1065.8 万 km）的根治手段。
      spk/sat215.bsp     土卫系统历表（601–614/699，Titan 覆盖 1990–2019）
      spk/jup310.bsp     木卫系统历表（501–516/599）
    归档目录中其余 SPK（vgr1/vgr2、其他航天器的 *_SCPSE_/*_RE_ 段）与本
    项目无关，显式排除以免污染内核池。
    """
    if not os.path.isdir(COSP):
        raise RuntimeError(f"cosp 内核目录不存在: {COSP}")
    for name in ("naif0012.tls", "pck00010.tpc", "cpck31Oct2017.tpc"):
        p = os.path.join(COSP, name)
        if os.path.exists(p):
            sp.furnsh(p)
            print(f"  furnsh {name}")
    co = sorted(glob.glob(os.path.join(COSP, "co_*.bsp")))
    sat = sorted(glob.glob(os.path.join(COSP, "sat*.bsp")))
    scpse = sorted(glob.glob(os.path.join(COSP, "*SCPSE*.bsp")))
    # 归档解包的补充内核（白名单）
    OPS_SPK = os.path.join(HERE, "..", "data_raw", "spice_kernels",
                           "analysis_kernels_small", "spk")
    ops = []
    for _n in ("171215R_SCPSEops_97288_17258.bsp", "sat215.bsp", "jup310.bsp"):
        _p = os.path.join(OPS_SPK, _n)
        if os.path.exists(_p):
            ops.append(_p)
    spks = co + sat + scpse + ops
    n_ok = 0
    for p in spks:
        try:
            sp.furnsh(p)
            n_ok += 1
        except Exception as ex:
            print(f"  SKIP {os.path.basename(p)}: {ex}")
    print(f"  SPK: co={len(co)} sat={len(sat)} scpse={len(scpse)} ops={len(ops)} loaded={n_ok}")
    if n_ok < 3:
        raise RuntimeError("SPK 内核不足（cosp 卷未就绪？）")
    return spks


def verify_coverage(spks):
    """spkcov 汇总 -82 覆盖域（合并区间），报告总覆盖与内部缺口。"""
    ivs = []
    for p in spks:
        try:
            if -82 not in sp.spkobj(p):
                continue
        except Exception:
            continue
        try:
            # spkcov 的 SpiceCell 迭代产出平铺标量 [a0,b0,a1,b1,...]，非 (a,b) 对
            cov = sp.spkcov(p, -82)
            vals = [float(x) for x in cov]
            for i in range(0, len(vals) - 1, 2):
                ivs.append((vals[i], vals[i + 1]))
        except Exception:
            continue
    if not ivs:
        raise RuntimeError("SPK 内核不含 -82（Cassini）数据！")
    ivs.sort()
    merged = [list(ivs[0])]
    for a, b in ivs[1:]:
        if a <= merged[-1][1] + 1.0:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    span_days = (merged[-1][1] - merged[0][0]) / 86400.0
    gap_s = sum(merged[i + 1][0] - merged[i][1] for i in range(len(merged) - 1))
    print(f"  -82 coverage: {len(merged)} 段, 总跨度 {span_days:.1f} d, "
          f"内部缺口合计 {gap_s / 86400:.2f} d")
    for a, b in merged:
        print(f"    {time.strftime('%Y-%m-%d', time.gmtime(a - 64.184 + J2000_UNIX))} .. "
              f"{time.strftime('%Y-%m-%d', time.gmtime(b - 64.184 + J2000_UNIX))}")
    if gap_s > 60.0:
        raise RuntimeError(f"-82 覆盖存在缺口（合计 {gap_s:.0f} s）——SPK 链不完整，"
                           f"中止烘焙（补齐缺失文件后重跑）")
    return merged


def gm(name):
    try:
        return float(sp.bodvrd(name.split()[0], "GM", 1)[1][0])
    except Exception:
        return None


# ---------- 时间（app 秒 = UTC 秒自 J2000 Unix；SPICE ET 严格换算） ----------

def furnsh_base():
    """导入期最小内核（LSK+PCK）：TimeMap/SaturnBody 模块级实例化所需。
    SPK 由 main() 的 load_kernels() 装载。"""
    for name in ("naif0012.tls", "pck00010.tpc", "cpck31Oct2017.tpc"):
        p = os.path.join(COSP, name)
        if os.path.exists(p):
            try:
                sp.furnsh(p)
            except Exception:
                pass
    if not os.path.exists(os.path.join(COSP, "naif0012.tls")):
        raise RuntimeError(f"缺少 LSK/PCK 内核（{COSP}）——先完成 COSP 内核下载")


furnsh_base()


class TimeMap:
    """u（app 秒）→ ET。锚点每 15 天一次 str2et，线性内插（TDB 周期项 <1.7 ms，
    15 天线性化误差 <0.1 ms → 轨迹影响 <3 m）。

    et() 是逐样本热点（主轨迹/卫星网格/行星网格合计 ~5e6 次调用）：np.interp
    每次建数组 + 通用分支开销大，改为 bisect + 纯 Python 线性内插（锚点等距，
    步长固定，直接整除得索引，省掉查找）。"""

    STEP = 15 * 86400

    def __init__(self):
        ets, us = [], []
        u = T_START - 40 * 86400
        while u <= T_END + 40 * 86400:
            ymd = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(u + J2000_UNIX))
            ets.append(sp.str2et(ymd + " UTC"))
            us.append(float(u))
            u += self.STEP
        self.us = np.array(us)
        self.ets = np.array(ets)
        self.off = self.ets - self.us
        self.u0 = float(us[0])
        self.n = len(us)
        self._off_list = [float(x) for x in self.off]

    def et(self, u):
        # 锚点等距 → 索引 = (u - u0) / STEP，取相邻两点线性内插
        u = float(u)
        x = (u - self.u0) / self.STEP
        i = int(x)
        if i < 0:
            return u + self._off_list[0]
        if i >= self.n - 1:
            return u + self._off_list[self.n - 1]
        f = x - i
        o = self._off_list
        return u + (o[i] + (o[i + 1] - o[i]) * f)


TM = TimeMap()


# ---------- 采样器（黄道系 km） ----------

_cache_spk = {}

# —— 快速采样通道 ——
# spiceypy.spkezr 每次调用都做：字符串 → c_char_p（3 次）、empty_double_vector、
# c_vector_to_python、装饰器 error-check —— 合计 ~24 µs/次，全流程 5e6 次调用
# 即 ~2 分钟。这里绕过封装直接调 libspice.spkezr_c，把 body 名的 c_char_p 与
# 输出缓冲缓存复用，单次降到 ~3 µs。语义与 spkezr(...,'J2000',abcorr,...) 完全
# 一致（同一 C 函数）；SPICE 错误仍由 check_for_spice_error 转异常。
_sp_lib = sp.libspice
_sp_ctypes = ctypes
_sp_check = sp.check_for_spice_error
_SP_FRAME = _sp_ctypes.c_char_p(b"J2000")
_SP_ABCORR = _sp_ctypes.c_char_p(b"NONE")
_SP_STARG = _sp_ctypes.c_double * 6
_SP_LT = _sp_ctypes.c_double
_sp_name_cache = {}
_sp_cd_cache = {}


def _sp_name(s):
    c = _sp_name_cache.get(s)
    if c is None:
        c = _sp_ctypes.c_char_p(s.encode("ascii"))
        _sp_name_cache[s] = c
    return c


def _SP_CD(et):
    """缓存 c_double(et)：采样点高度重复（自适应细分 + SOI 扫描），命中率很高。"""
    c = _sp_cd_cache.get(et)
    if c is None:
        c = _sp_ctypes.c_double(et)
        _sp_cd_cache[et] = c
    return c


def _state_fast(target, observer, et, out=None):
    """调 libspice.spkezr_c 取 target 相对 observer 的状态（J2000, NONE）。
    out: 可选长度 6 的可复用 list；返回新建 tuple(x,y,z, vx,vy,vz)。

    性能要点：spkezr_c 的签名是 const 入参（name/et/frame/abcorr），ctypes 会对
    python float 每次构造 c_double；这里把 et 用缓存 c_double 复用，输出缓冲
    每次新建（spkezr_c 会写 6 个 double，复用会踩并发/别名风险，但烘焙是单线程，
    仍持保守：新建）。实测占总时长约 25%，是最大单项。"""
    st = _SP_STARG()
    lt = _SP_LT()
    _sp_lib.spkezr_c(_sp_name(target), _SP_CD(et), _SP_FRAME,
                     _SP_ABCORR, _sp_name(observer), st, _sp_ctypes.byref(lt))
    if _sp_lib.failed_c():
        _sp_check(None)
    return (st[0], st[1], st[2], st[3], st[4], st[5])


def state(target, observer, u, abcorr="NONE"):
    if abcorr == "NONE":
        return _state_fast(target, observer, TM.et(u))
    et = TM.et(u)
    st, _lt = sp.spkezr(target, et, "J2000", abcorr, observer)
    return st


def state_pos_ecl(target, observer, u):
    """state + eq_to_ecl，省去中间 list（热点路径）。"""
    x, y, z, _, _, _ = _state_fast(target, observer, TM.et(u))
    return (x, y * CE + z * SE, -y * SE + z * CE)


def pos_ecl(target, observer, u):
    x, y, z, _, _, _ = _state_fast(target, observer, TM.et(u))
    return (x, y * CE + z * SE, -y * SE + z * CE)


def vel_ecl(target, observer, u, dt=30.0):
    p0 = pos_ecl(target, observer, u - dt)
    p1 = pos_ecl(target, observer, u + dt)
    return tuple((p1[k] - p0[k]) / (2 * dt) for k in range(3))


def sun_gm():
    return float(sp.bodvrd("SUN", "GM", 1)[1][0])


# ---------- 土星体中心（卫星质量修正：r_body = r_bary − Σ m_i r_i / M） ----------

class SaturnBody:
    def __init__(self):
        self.gm_planet = gm("SATURN") or 37931207.7
        self.gm_moons = {}
        for m in SAT_MOONS:
            g = gm(m)
            if g:
                self.gm_moons[m] = g
        print(f"  Saturn GM={self.gm_planet:,.1f}  moons GM={sum(self.gm_moons.values()):,.1f} "
              f"({len(self.gm_moons)} 颗，环质量忽略 ~2.6e-8 M)")
        # 质心→体中心偏移量网格（变化慢：Titan 主导 16 天周期，±350 km，30 min 网格）
        self._t0 = None
        self._t1 = None

    def build_grid(self, t0, t1, step=1800.0):
        n = int(round((t1 - t0) / step)) + 1
        self._t0, self._t1, self._step = t0, t1, step
        self._grid = np.empty((n, 3))
        # 内联展开 offset_at：省去每点 7 次函数调用 + 7 次 np.asarray 包装。
        gm = self.gm_moons
        names = list(gm)
        gms = [gm[m] for m in names]
        inv = -1.0 / self.gm_planet
        _et = TM.et
        _sf = _state_fast
        for i in range(n):
            u = t0 + i * step
            et = _et(u)
            ox = oy = oz = 0.0
            for k in range(len(names)):
                x, y, z, _, _, _ = _sf(names[k], "SATURN BARYCENTER", et)
                g = gms[k]
                ox += g * x
                oy += g * (y * CE + z * SE)
                oz += g * (-y * SE + z * CE)
            self._grid[i, 0] = ox * inv
            self._grid[i, 1] = oy * inv
            self._grid[i, 2] = oz * inv
        print(f"  Saturn body-offset grid: {n} pts @ {step:.0f}s")

    def offset_at(self, u):
        off = np.zeros(3)
        for m, g in self.gm_moons.items():
            r = pos_ecl(m, "SATURN BARYCENTER", u)
            off += g * np.asarray(r)
        return -off / self.gm_planet

    def offset(self, u):
        """体中心 − 系统质心（黄道系 km）；网格线性内插，覆盖域外钳制"""
        f = (u - self._t0) / self._step
        n = len(self._grid)
        if f <= 0:
            return self._grid[0]
        if f >= n - 1:
            return self._grid[n - 1]
        i = min(n - 2, int(math.floor(f)))
        a = f - i
        return self._grid[i] + (self._grid[i + 1] - self._grid[i]) * a

    def offset_arr(self, us):
        """offset 的向量化版：us (n,) → (n,3)。与 offset 同式（f64）。"""
        us = np.asarray(us, dtype=np.float64)
        f = (us - self._t0) / self._step
        n = len(self._grid)
        f = np.clip(f, 0.0, float(n - 1))
        i = np.minimum(n - 2, np.floor(f).astype(np.int64))
        i = np.maximum(i, 0)
        a = (f - i)[:, None]
        return self._grid[i] + (self._grid[i + 1] - self._grid[i]) * a


SB = SaturnBody()


# ---------- 切比雪夫自适应拟合 ----------

def cheb_fit_track(sampler, t0, t1, w0, tol=CHEB_TOL, deg=CHEB_DEG,
                   wmin=300.0, wmax=8 * 86400.0, grow=True):
    """[t0,t1] 上自适应窗口切比雪夫拟合。sampler(u)→np.array[3]（km）。
    返回 recs: [(t0, W, coef(3,deg+1) f64)]，窗口内最大偏差 ≤ tol。"""
    recs = []
    t = t0
    w = w0
    dense = 2 * deg + 3
    while t < t1 - 1.0:
        w = min(w, wmax, t1 - t)
        ok = False
        while True:
            ts = np.linspace(t, t + w, dense)
            ps = np.array([sampler(u) for u in ts])
            x = np.linspace(-1.0, 1.0, dense)
            coef = np.array([np.polynomial.chebyshev.chebfit(x, ps[:, k], deg)
                             for k in range(3)])
            xchk = np.linspace(-1.0, 1.0, 65)
            # 逐分量求值：chebval(xchk, coef) 在 coef.shape=(3,deg+1) 时把首轴当
            # 系数轴，返回 (deg+1,65)，与逐分量语义不符（deg>3 即触发）。
            # 显式按 k 求值，与 cheb_at 一致。
            app = np.array([np.polynomial.chebyshev.chebval(xchk, coef[k])
                            for k in range(3)])
            ts_chk = t + (xchk + 1) * 0.5 * w
            err = 0.0
            for i in range(0, 65, 4):
                p = np.asarray(sampler(float(ts_chk[i])), dtype=float)
                err = max(err, float(np.linalg.norm(app[:, i] - p)))
            if err <= tol:
                ok = True
                break
            w *= 0.5
            if w < wmin:
                break
        if ok:
            recs.append((float(t), float(w), coef.astype(np.float64)))
            # 关键：先用【已接受】的窗口宽度推进 t，再放大宽度供下一窗口试探。
            # 若先放大再推进（旧写法 w *= 1.7 后 t += w），t 会越过本窗口实际
            # 覆盖区，records 之间出现空洞 → 前端 cheb_at 把空洞内时刻归到前一
            # 窗口并在窗口外求值，误差可达 10^5～10^6 km。
            t += w
            if grow:
                w = min(w * 1.7, wmax)
        else:
            # 低于窗口下限仍超差（突变段）：退化线性微段，误差由调用端兜底
            u0, u1 = t, min(t + wmin, t1)
            recs.append((float(u0), float(u1 - u0), None))
            t = u1
            w = wmin
    return recs


def pack_track(recs):
    ts = np.array([r[0] for r in recs])
    ws = np.array([r[1] for r in recs])
    deg = CHEB_DEG
    cs = []
    for _t, _w, c in recs:
        if c is None:
            cs.append(np.zeros((3, deg + 1)))
        else:
            cs.append(c)
    return {"deg": deg, "n": len(recs),
            "t": b64f64(ts), "w": b64f64(ws), "c": b64f64(np.array(cs).ravel())}


def cheb_at(track, u):
    """切比雪夫轨道求值（端点外钳制）。返回 np.array[3] ecl km"""
    ts = track["_ts"]
    ws = track["_ws"]
    cs = track["_cs"]
    deg = track["deg"]
    i = min(max(bisect.bisect_right(ts, u) - 1, 0), len(ts) - 1)
    t0, w = ts[i], ws[i]
    x = 2.0 * (u - t0) / w - 1.0
    x = max(-1.0, min(1.0, x))
    c = cs[i]
    out = np.empty(3)
    for k in range(3):
        out[k] = np.polynomial.chebyshev.chebval(x, c[k])
    return out


def prep_track(packed):
    return {
        "deg": packed["deg"],
        "_ts": np.frombuffer(base64.b64decode(packed["t"]), "<f8"),
        "_ws": np.frombuffer(base64.b64decode(packed["w"]), "<f8"),
        "_cs": np.frombuffer(base64.b64decode(packed["c"]), "<f8").reshape(-1, 3, packed["deg"] + 1),
    }


# ---------- 卫星网格烘焙（母星体中心相对，f32 网格 + CR） ----------

MOON_STEPS = {
    "titan": 10800.0, "moon": 21600.0, "enceladus": 2400.0, "mimas": 1800.0,
    "tethys": 3600.0, "dione": 3600.0, "rhea": 7200.0, "iapetus": 43200.0,
}


def cr_error_scale(name):
    return None


def bake_moons(t0u, t1u):
    moons = {}
    raw = {}
    for m in SAT_MOONS:
        step = MOON_STEPS[m]
        n = int(round((t1u - t0u) / step)) + 1
        us = t0u + step * np.arange(n)
        pts = np.empty((n, 3))
        for i in range(n):
            u = float(us[i])
            r = pos_ecl(m, "SATURN BARYCENTER", u)
            o = SB.offset(u)
            pts[i, 0] = r[0] - o[0]
            pts[i, 1] = r[1] - o[1]
            pts[i, 2] = r[2] - o[2]
        pts32 = np.asarray(pts, dtype=np.float32)
        raw[m] = (t0u, step, pts32)
        moons[m] = {"radiusKm": RADII[m], "segs": pack([(t0u, step, pts32)]),
                    "parent": "saturn", "interp": "cr"}
        print(f"moon {m}: {n} pts @ {step:.0f}s")
    # 月球（地心）
    m = "moon"
    step = MOON_STEPS[m]
    n = int(round((t1u - t0u) / step)) + 1
    pts = np.empty((n, 3))
    for i in range(n):
        u = t0u + i * step
        pts[i] = pos_ecl("MOON", "EARTH", float(u))
    pts32 = np.asarray(pts, dtype=np.float32)
    raw[m] = (t0u, step, pts32)
    moons[m] = {"radiusKm": RADII[m], "segs": pack([(t0u, step, pts32)]),
                "parent": "earth", "interp": "cr"}
    print(f"moon {m}: {n} pts @ {step:.0f}s")
    return moons, raw


def moon_at(raw_m, t):
    """与前端 makeTrack CR 逐位一致（f32 顶点 + f64 算术）"""
    t0, step, pts = raw_m
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
    return np.array(out)


def grid_at(raw_m, t):
    t0, step, pts = raw_m
    n = len(pts)
    f = (t - t0) / step
    f = max(0.0, min(float(n - 1), f))
    i = min(n - 2, int(math.floor(f)))
    a = f - i
    return pts[i] + (pts[i + 1] - pts[i]) * a


def pack(segs):
    packed = []
    for (t0, dt, pts) in segs:
        arr = np.asarray(pts, "<f4").tobytes()
        packed.append({"t0": round(t0, 1), "dt": round(dt, 1), "n": len(pts),
                       "d": base64.b64encode(arr).decode("ascii")})
    return packed


# ---------- 密切根数 + 轨道线（行星/卫星，黄道系） ----------

def quat_from_basis(P, Q, H):
    """R = [P Q H]（列）→ 四元数 (w,x,y,z)，主动旋转 q v q*"""
    m = np.column_stack([P, Q, H])
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        qw = 0.25 * s
        qx = (m[2, 1] - m[1, 2]) / s
        qy = (m[0, 2] - m[2, 0]) / s
        qz = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        qw = (m[2, 1] - m[1, 2]) / s
        qx = 0.25 * s
        qy = (m[0, 1] + m[1, 0]) / s
        qz = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        qw = (m[0, 2] - m[2, 0]) / s
        qx = (m[0, 1] + m[1, 0]) / s
        qy = 0.25 * s
        qz = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        qw = (m[1, 0] - m[0, 1]) / s
        qx = (m[0, 2] + m[2, 0]) / s
        qy = (m[1, 2] + m[2, 1]) / s
        qz = 0.25 * s
    n = math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
    return (qw / n, qx / n, qy / n, qz / n)


def osc_elements(target, center, u, mu):
    st = state(target, center, u)
    r = np.array(st[:3])
    v = np.array(st[3:6])
    rn = float(np.linalg.norm(r))
    vn2 = float(np.dot(v, v))
    rv = float(np.dot(r, v))
    h = np.cross(r, v)
    hn = float(np.linalg.norm(h))
    H = h / hn
    evec = ((vn2 - mu / rn) * r - rv * v) / mu
    e = float(np.linalg.norm(evec))
    a = 1.0 / (2.0 / rn - vn2 / mu)
    if e >= 1.0 or a <= 0:
        return None
    P = evec / e if e > 1e-9 else r / rn
    P = P - H * float(np.dot(P, H))
    P = P / float(np.linalg.norm(P))
    Q = np.cross(H, P)
    E = math.atan2(float(np.dot(r, Q)) / (a * math.sqrt(1 - e * e)),
                   (float(np.dot(r, P)) + a * e) / a)
    M = E - e * math.sin(E)
    n = math.sqrt(mu / (a ** 3))
    qw, qx, qy, qz = quat_from_basis(P, Q, H)
    return (float(a), e, n, M, qw, qx, qy, qz)


def elem_pos_ecl(el, M):
    a, e, n, M0, qw, qx, qy, qz = el
    E = solve_e(M, e)
    b = a * math.sqrt(1 - e * e)
    px = a * (math.cos(E) - e)
    py = b * math.sin(E)
    tx = 2 * (qy * 0 - qz * py)
    ty = 2 * (qz * px - qx * 0)
    tz = 2 * (qx * py - qy * px)
    v = (px + qw * tx + (qy * tz - qz * ty),
         py + qw * ty + (qz * tx - qx * tz),
         0 + qw * tz + (qx * ty - qy * tx))
    return eq_to_ecl(v)   # 根数在 ICRF 赤道系，输出转黄道（与前端 elemPosEcl 一致）


def solve_e(M, e):
    if e > 0.8:
        M = (M + math.pi) % (2 * math.pi)
        if M < 0:
            M += 2 * math.pi
        M -= math.pi
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
    for _ in range(50):
        f = E - e * math.sin(E) - M
        E -= f / (1 - e * math.cos(E))
        if abs(f) < 1e-12:
            break
    return E


def elements_keyframes(target, center, mu, t0, t1, step, cap):
    us = []
    u = t0
    while u <= t1:
        us.append(u)
        u += step
    els = []
    for u in us:
        el = osc_elements(target, center, float(u), mu)
        if el:
            els.append((float(u), el))
    stride = max(1, math.ceil(len(els) / cap))
    sel = els[::stride]
    if sel[-1][0] != els[-1][0]:
        sel.append(els[-1])
    eT = np.array([s[0] for s in sel])
    eV = np.array([v for s in sel for v in s[1]], dtype="<f4")
    return {"eT": b64f64(eT), "eV": b64f32(eV), "n": len(sel)}


def orbit_line(target, center, mu, t0):
    el = osc_elements(target, center, t0, mu)
    a, e, n = el[0], el[1], el[2]
    T = 2 * math.pi / n
    N = 256
    pts = []
    for i in range(N):
        M = el[3] + n * (T * i / N)
        pts.append(elem_pos_ecl(el, M))
    arr = np.asarray(pts, "<f4")
    return base64.b64encode(arr.tobytes()).decode("ascii")


# ---------- 卡西尼主轨迹（日心，自适应弦差采样） ----------

def detect_soi_crossings(rprof, times, r_soi, lo=None, hi=None):
    """从距离剖面取首次进入/末次离开 r_soi 的时间（区间内二分细化）"""
    spans = []
    cur = None
    for i, (t, d) in enumerate(zip(times, rprof)):
        if d < r_soi:
            if cur is None:
                cur = [t, t]
            else:
                cur[1] = t
        elif cur is not None:
            spans.append(cur)
            cur = None
    if cur is not None:
        spans.append(cur)
    return spans


def bake_planets():
    bodies = {}
    t0p = calendar.timegm((1997, 6, 1, 0, 0, 0)) - J2000_UNIX
    t1p = calendar.timegm((2017, 12, 31, 0, 0, 0)) - J2000_UNIX
    mu_sun = sun_gm()
    for name in PLANETS:
        target = PLANET_TARGET[name]
        step = 21600.0 if name in ("mercury", "venus", "earth", "mars") else 86400.0
        n = int(round((t1p - t0p) / step)) + 1
        pts = np.empty((n, 3))
        for i in range(n):
            u = t0p + i * step
            pts[i] = pos_ecl(target, "SUN", u)
            if name == "saturn":
                pts[i] += SB.offset(u)          # 体中心（对准全球与环面）
        pts32 = np.asarray([[f32(v) for v in p] for p in pts])
        bodies[name] = {
            "radiusKm": RADII[name],
            "segs": pack([(t0p, step, pts32)]),   # 注意：本函数为旧版，实际使用 bake_planets2
            "o": orbit_line(target if name != "saturn" else "SATURN BARYCENTER",
                            "SUN", mu_sun, t0p),
            "elems": elements_keyframes(target, "SUN", mu_sun, t0p, t1p, 30 * 86400.0, 320),
        }
        print(f"planet {name}: {n} pts")
    return bodies


def bake_cassini_trail(ts, te, moons_raw, soi_wins, enc_windows):
    """主轨迹：自适应弦差 ≤ TRAIL_TOL + 天体近掠/SOI 细化。返回 (times f64[], pts f32[])"""
    base_step = 3600.0
    n = int((te - ts) / base_step) + 1
    base_t = ts + base_step * np.arange(n)
    base_p = np.empty((n, 3))
    base_rs = np.empty(n)
    _et = TM.et
    _sf = _state_fast
    for i in range(n):
        u = float(base_t[i])
        x, y, z, _, _, _ = _sf("CASSINI", "SUN", _et(u))
        px = x; py = y * CE + z * SE; pz = -y * SE + z * CE
        base_p[i, 0] = px; base_p[i, 1] = py; base_p[i, 2] = pz
        sx, sy, sz, _, _, _ = _sf("SATURN BARYCENTER", "SUN", _et(u))
        ey = sy * CE + sz * SE
        ez = -sy * SE + sz * CE
        sx = sx
        o = SB.offset(u)
        ddx = px - sx - o[0]; ddy = py - ey - o[1]; ddz = pz - ez - o[2]
        base_rs[i] = math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
    print(f"  base profile {n} pts")

    # 每基步的横向加速度（曲率驱动步长）
    h2 = 2 * base_step
    acc = (base_p[2:] - 2 * base_p[1:-1] + base_p[:-2]) / (base_step * base_step)
    vv = (base_p[2:] - base_p[:-2]) / h2
    vn = np.linalg.norm(vv, axis=1)
    aperp = np.linalg.norm(acc - vv * (np.sum(acc * vv, axis=1) / np.maximum(vn * vn, 1e-12))[:, None], axis=1)
    aperp = np.concatenate([[aperp[0]], aperp, [aperp[-1]]])

    def base_at(u):
        i = min(max(int((u - ts) / base_step), 0), n - 1)
        return aperp[i]

    # —— 细化时间集合 ——
    fine = []   # (t0, t1, dt)

    def addfine(a, b, dt):
        if b > a:
            fine.append((max(a, ts), min(b, te), dt))

    # 行星 SOI 窗口（内行星 60 s / 木星 600 s；土星段由自适应+近拱细化负责）
    for name, wins in soi_wins.items():
        if name == "saturn":
            continue
        dt = 600.0 if name == "jupiter" else 60.0
        for (a, b) in wins:
            addfine(a - 3600, b + 3600, dt)
    # 土卫 SOI 窗口（60 s）
    for (a, b, _m) in enc_windows:
        addfine(a - 1200, b + 1200, 60.0)
    # Titan 近掠窗（300 s）：Cassini 在土星段的 Titan 飞掠极频（2004–2017 逾百次），
    # 近掠时相对速度可达 ~6 km/s，1 h 基步的横向加速度不足以触发自适应细化，
    # 线性弦差会到 ~1e3 km（实测 2005-01-15 Titan 进入后 960 km）。以基剖面
    # 相对 Titan 的距离 < 6e5 km（约 14 倍 Titan SOI）为界加密，覆盖进入/掠过。
    if "titan" in moons_raw:
        _raw_t = moons_raw["titan"]
        # base_p 已是黄道系；pos_ecl 亦返回黄道系，故此处不可再 eq_to_ecl。
        _sat_b = np.array([pos_ecl("SATURN BARYCENTER", "SUN", float(base_t[i]))
                           for i in range(n)])
        _d_t = np.linalg.norm(base_p - _sat_b - SB.offset_arr(base_t)
                              - moon_at_vec(_raw_t, base_t), axis=1)
        _i = 0
        while _i < n:
            if _d_t[_i] < 6e5:
                _j = _i
                while _j < n and _d_t[_j] < 6e5:
                    _j += 1
                addfine(base_t[max(0, _i - 2)] - 1800, base_t[min(n - 1, _j + 1)] + 1800, 300.0)
                _i = _j
            else:
                _i += 1
    # 惠更斯分离（±1d）与 Titan 进入（±12h）窗口（60 s：模型分离几何关键域）
    sep_u = TM.et(calendar.timegm(time.strptime(SEP_UTC, "%Y-%m-%d %H:%M:%S")) - J2000_UNIX)
    entry_u = TM.et(calendar.timegm(time.strptime(ENTRY_UTC, "%Y-%m-%d %H:%M:%S")) - J2000_UNIX)
    addfine(sep_u - 86400, sep_u + 86400, 60.0)
    addfine(entry_u - 43200, entry_u + 43200, 60.0)
    # 土星近拱（240 s；finale 内 60 s）
    i = 1
    while i < n - 1:
        if base_rs[i] < base_rs[i - 1] and base_rs[i] <= base_rs[i + 1] and base_rs[i] < 3.5e6:
            r0 = base_rs[i]
            dt = 60.0 if r0 < 1.5e5 else 240.0
            addfine(base_t[i] - 6 * 3600, base_t[i] + 6 * 3600, dt)
            i += 12
        else:
            i += 1
    # 任务终段末端
    addfine(te - 6 * 3600, te, 60.0)

    fine_t = []
    for (a, b, dt) in fine:
        m = int((b - a) / dt) + 1
        fine_t.append(a + dt * np.arange(m))
    fine_t = np.unique(np.concatenate(fine_t)) if fine_t else np.empty(0)
    print(f"  fine vertices {len(fine_t)}")

    # —— 自适应主采样（弦差驱动 + 迭代中点细分兜底）——
    # 曲率项（aperp，1 h 基剖面）只能给出量级合理的初值，对快速掠过的强
    # 非线性段（土星环形轨道、近掠、深空高速段）会系统性低估 → 弦差可达
    # 1e2–1e3 km。因此初值生成后，用【中点实测】迭代细分：凡线性插值中点与
    # SPICE 真值偏差 > TRAIL_TOL 的区间一律二分，直至满足或到最小步长。
    # 这是与分辨率无关的兜底，保证全任务弦差 ≤ TRAIL_TOL。
    coarse = []
    u = ts
    while u < te:
        ap = max(base_at(u), 1e-12)
        dt = math.sqrt(8 * TRAIL_TOL / ap)
        dt = min(max(dt, 60.0), 6 * 3600.0)
        coarse.append(u)
        u += dt
    coarse.append(te)
    coarse_t = list(coarse)

    def _ecl(u_):
        x, y, z, _, _, _ = _state_fast("CASSINI", "SUN", TM.et(u_))
        return (x, y * CE + z * SE, -y * SE + z * CE)

    # 迭代细分：多轮（每轮对超差区间插入中点），带缓存避免重复求值
    _cache = {}

    def _p(u_):
        v = _cache.get(u_)
        if v is None:
            v = _ecl(u_)
            _cache[u_] = v
        return v

    # 先并入 fine 网格再统一细分：fine_t 与 coarse_t 重叠但不同点，union 后
    # 会出现「细网格点 + 远处粗网格点」构成的大间隔，只在 coarse 上细分会漏。
    coarse_t = sorted(set(coarse).union(float(x) for x in fine_t))
    # —— 网格相位对齐（消除近重复顶点）——
    # fine 网格起点 = 窗口边界 − 余量（任意相位），与 coarse（3600 s，ts 相位）
    # 及 600/240/60 s 各细网格互不对齐。union 后会出现「两顶点时间几乎重合
    # （Δt 0.002–0.9 s）但空间位于邻段外数 km~130 km」的病态顶点：连线后是一
    # 段近零长度、近零时间的横移短线，光栅化即肉眼可见的「折线 / 台阶」
    # （实测发射段 i=432/433 Δt=0.21 s、侧偏 1.17 km → 16.5° 折角；土星段最
    # 大侧偏 134 km）。这里在 union 后做一次「近邻吸附」：凡与前一保留顶点
    # 时间差 < MERGE_DT 的顶点，直接吸附到前一点（不新增顶点），从而在源头
    # 消除病态短线。MERGE_DT 取得远小于任何真实网格步长（最大 3600 s），故
    # 不损失任何真实采样。
    MERGE_DT = 5.0

    def _merge_grid(ts_list, tag):
        out = []
        for u in ts_list:
            if out and (u - out[-1]) < MERGE_DT:
                continue
            out.append(u)
        rm = len(ts_list) - len(out)
        if rm:
            print(f"  merge near-duplicate grid times [{tag}]: {rm} removed "
                  f"({len(ts_list)} → {len(out)})")
        return out

    coarse_t = _merge_grid(coarse_t, "union")

    for _pass in range(20):
        out = [coarse_t[0]]
        n_split = 0
        for i in range(len(coarse_t) - 1):
            a, b = coarse_t[i], coarse_t[i + 1]
            if b - a > 60.0:
                mid = 0.5 * (a + b)
                pa, pb, pm = _p(a), _p(b), _p(mid)
                # 线性中点 vs 真值：内联 3 分量（省去 np.linalg.norm 的 ~2.6 us/次）
                dx = 0.5 * (pa[0] + pb[0]) - pm[0]
                dy = 0.5 * (pa[1] + pb[1]) - pm[1]
                dz = 0.5 * (pa[2] + pb[2]) - pm[2]
                if dx * dx + dy * dy + dz * dz > TRAIL_TOL * TRAIL_TOL:
                    out.append(mid)
                    n_split += 1
            out.append(b)
        # 每轮细分后重新吸附：中点 (a+b)/2 可能落在既有顶点 ~0.001 s 处
        coarse_t = _merge_grid(sorted(set(out)), f"pass{_pass}")
        print(f"  refine pass {_pass}: split {n_split}, total {len(coarse_t)}")
        if n_split == 0:
            break

    all_t = np.array(coarse_t)
    m = len(all_t)
    print(f"  trail total {m} vertices")
    pts = np.empty((m, 3))
    sat_bary = np.empty((m, 3))
    for i in range(m):
        u = float(all_t[i])
        x, y, z, _, _, _ = _sf("CASSINI", "SUN", _et(u))
        pts[i, 0] = x; pts[i, 1] = y * CE + z * SE; pts[i, 2] = -y * SE + z * CE
        x2, y2, z2, _, _, _ = _sf("SATURN BARYCENTER", "SUN", _et(u))
        sat_bary[i, 0] = x2
        sat_bary[i, 1] = y2 * CE + z2 * SE
        sat_bary[i, 2] = -y2 * SE + z2 * CE
    trail32 = pts.astype(np.float32)
    return all_t, trail32, pts, sat_bary, SB


# ---------- 土卫 SOI 穿越窗口（二级相对轨迹显示窗） ----------

def moon_at_vec(raw_m, ts_arr):
    """moon_at 的向量化版：ts_arr (n,) → (n,3)。与前端 makeTrack CR 逐位同式。"""
    t0, step, pts = raw_m
    n = len(pts)
    f = (ts_arr - t0) / step
    f = np.clip(f, 0.0, float(n - 1))
    i = np.minimum(n - 2, np.floor(f).astype(np.int64))
    s = f - i
    i0 = np.maximum(i - 1, 0)
    i3 = np.minimum(i + 2, n - 1)
    p0, p1, p2, p3 = pts[i0], pts[i], pts[i + 1], pts[i3]
    s2 = s * s
    s3 = s2 * s
    # 0.5*((2a1) + (a2-a0)s + (2a0-5a1+4a2-a3)s^2 + (3a1-a0-3a2+a3)s^3)
    return 0.5 * ((2.0 * p1) + (p2 - p0) * s[:, None]
                  + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * s2[:, None]
                  + (3.0 * p1 - p0 - 3.0 * p2 + p3) * s3[:, None])


def scan_moon_soi_windows(ts, te, moons_raw):
    """两级扫描：2h 基网格找 d < 阈值候选域 → 60s 细扫定位 SOI 穿越。
    返回 [(a, b, moon)]（±45 min 余量含在 a/b）。

    性能：卫星位置用 moon_at_vec 批量向量化（原逐点 moon_at 是纯 Python 循环，
    占本函数 ~90% 时长）；SPICE 采样仍逐点（无批量接口）。"""
    wins = []
    step = 3600.0
    n = int((te - ts) / step) + 1
    tsamp = ts + step * np.arange(n)
    cass = np.empty((n, 3))
    for i, u in enumerate(tsamp):
        st = state("CASSINI", "SATURN BARYCENTER", float(u))
        cass[i] = np.array(st[:3]) - SB.offset(float(u))     # 相对体中心

    def _cass_rel(u):
        st = state("CASSINI", "SATURN BARYCENTER", float(u))
        return np.array(st[:3]) - SB.offset(float(u))

    for m in SAT_MOONS:
        raw = moons_raw[m]
        thr = max(30 * MOON_SOI[m], 2e5 if m == "titan" else 6e4)
        mpos = moon_at_vec(raw, tsamp)                        # (n,3) 一次向量化
        dist = np.linalg.norm(cass - mpos, axis=1)
        i = 0
        while i < n:
            if dist[i] < thr:
                j = i
                while j < n and dist[j] < thr:
                    j += 1
                a0, b0 = tsamp[max(0, i - 2)], tsamp[min(n - 1, j + 1)]
                # 60s 细扫（moon_at_vec 批量）
                mm = int((b0 - a0) / 60.0) + 1
                t2 = a0 + 60.0 * np.arange(mm)
                d2 = np.array([np.linalg.norm(
                    _cass_rel(float(u)) - mv)
                    for u, mv in zip(t2, moon_at_vec(raw, t2))])
                k = 0
                while k < mm:
                    if d2[k] < MOON_SOI[m]:
                        k2 = k
                        while k2 < mm and d2[k2] < MOON_SOI[m]:
                            k2 += 1
                        wins.append((float(t2[max(0, k - 2)]), float(t2[min(mm - 1, k2 + 1)]), m))
                        k = k2 + 1
                    else:
                        k += 1
                i = j
            else:
                i += 1
        wins_m = [w for w in wins if w[2] == m]
        print(f"  moon SOI {m}: {len(wins_m)} windows")
    return wins


def scan_planet_soi(spans, name, r_soi):
    """给定粗窗口列表 → 精确进入/离开时刻（30 min 网格包络）。返回合并后的 [tin, tout]"""
    best = None
    for (a, b) in spans:
        # 细化半径剖面
        mm = int((b - a) / 1800.0) + 1
        for i in range(mm):
            u = a + 1800.0 * i
            d = float(np.linalg.norm(cassini_rel_planet(name, float(u))))
            if d < r_soi:
                if best is None:
                    best = [u, u]
                else:
                    best[0] = min(best[0], u)
                    best[1] = max(best[1], u)
    if best is None:
        return None
    return (best[0] - 900.0, best[1] + 900.0)


def refine_crossing(f, a, b, want_inside=True):
    """f: u→bool(d<r)；把 [a,b] 内首个进入/离开边界二分到 1 s"""
    fa = f(a)
    for _ in range(24):
        mid = 0.5 * (a + b)
        if f(mid) == fa:
            a = mid
        else:
            b = mid
    return 0.5 * (a + b)


# ---------- 锚定轨道（切比雪夫；模型定位精度） ----------

def make_sampler(target, center, body_rel):
    _et = TM.et
    _sf = _state_fast

    def sampler(u):
        u = float(u)
        x, y, z, _, _, _ = _sf(target, center, _et(u))
        ex = x
        ey = y * CE + z * SE
        ez = -y * SE + z * CE
        if body_rel:
            o = SB.offset(u)          # SB.offset 为黄道系 → 先转黄道再相减
            return np.array((ex - o[0], ey - o[1], ez - o[2]))
        return np.array((ex, ey, ez))
    return sampler


def bake_anchor_track(name, anchor_body, sampler, a, b, w0, wmax):
    recs = cheb_fit_track(sampler, a, b, w0, wmax=wmax)
    packed = pack_track(recs)
    packed["anchor"] = anchor_body
    pt = prep_track(packed)
    rng = np.random.default_rng(42)
    errs = []
    for u in rng.uniform(a, b, 80):
        errs.append(float(np.linalg.norm(cheb_at(pt, float(u)) - sampler(float(u)))))
    print(f"  track {name}: {len(recs)} recs, span {a:.0f}..{b:.0f}, "
          f"max_err={max(errs):.4f} km  ({(b - a) / 86400:.2f} d)")
    return packed


def first_spk_time():
    lo = T_START - 30 * 86400
    hi = T_START + 60 * 86400
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        try:
            state("CASSINI", "SUN", float(mid))
            hi = mid
        except Exception:
            lo = mid
    return hi


def last_spk_time():
    """内核池中 -82 数据的最后可用时刻（二分）。"""
    lo = T_END - 120 * 86400
    hi = T_END + 90 * 86400
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        try:
            state("CASSINI", "SUN", float(mid))
            lo = mid
        except Exception:
            hi = mid
    return lo


def soi_span(target, center, a, b, r_soi, body_rel=False, step=1800.0):
    """[a,b] 内 |cassini−target| < r_soi 的首个进入/末次离开"""
    tin = tout = None
    n = int((b - a) / step) + 1

    def d_at(u):
        r = make_sampler("CASSINI", center, body_rel)(u)
        c = make_sampler(target, center if center != "SUN" else "SUN", body_rel and center == "SATURN BARYCENTER")(u) \
            if center != "SUN" else eq_to_ecl(np.asarray(state(target, "SUN", u)[:3]))
        return float(np.linalg.norm(r - c))

    u = a
    prev = None
    while u <= b:
        d = d_at(u)
        if prev is not None and prev >= r_soi > d and tin is None:
            tin = refine_crossing(lambda x: d_at(x) < r_soi, u - step, u)
        if prev is not None and prev < r_soi <= d:
            tout = refine_crossing(lambda x: d_at(x) >= r_soi, u - step, u)
        prev = d
        u += step
    if tin is None:
        # 窗口起点已在 SOI 内（发射段）
        if d_at(a) < r_soi:
            tin = a
    return tin, tout


# ---------- Miriade 行星网格（水星/金星/火星/天王星/海王星：内核不含 199/299/499/7/8） ----------
# INPOP13C 与 NAIF SPK 的框架差在土星段 ≤ 数十 km，仅作背景天体；地球/月球/木星/
# 土星走 SPICE（与 Cassini 同内核池，相对几何精确）。网格 CR 插值误差 ≤0.02 km。

MIR_CACHE = os.path.join(RAW, "miriade_cache")


def mir_fetch(name, t0u, t1u, step):
    """Miriade ephemcc 日心 ICRF 赤道直角坐标 (km/s)，分段拉取 + 磁盘缓存。
    返回 (us f64[n], pos f64[n,3] 黄道, vel f64[n,3] 黄道)。"""
    os.makedirs(MIR_CACHE, exist_ok=True)
    key = f"{name}_{int(t0u)}_{int(t1u)}_{int(step)}.npz"
    p = os.path.join(MIR_CACHE, key)
    if os.path.exists(p):
        z = np.load(p)
        return z["us"], z["pos"], z["vel"]
    api = "https://vo.imcce.fr/webservices/miriade/ephemcc.php?"
    us_all, pos_all, vel_all = [], [], []
    u = t0u
    CH = 2000
    while u <= t1u + 1.0:
        n = min(CH, int((t1u - u) / step) + 1)
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(u + J2000_UNIX))
        params = {"-name": name, "-type": "Planet", "-ep": ts,
                  "-nbd": str(n), "-step": f"{int(step)}s",
                  "-observer": "@sun", "-tcoor": "2", "-mime": "text"}
        req = urllib.request.Request(api + urllib.parse.urlencode(params),
                                     headers={"User-Agent": "Mozilla/5.0"})
        txt = None
        for a in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    txt = r.read().decode("utf-8", "replace")
                break
            except Exception:
                time.sleep(2 * (a + 1))
        if txt is None or "# Flag: 1" not in txt and "# Flag: 0" not in txt:
            raise RuntimeError(f"miriade fetch fail {name} @{ts}")
        rows = 0
        for line in txt.splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = s.split()
            if re.match(r"^\d{4}-\d{2}-\d{2}", parts[0]):
                parts = parts[1:]
            try:
                # tcoor=2 矩形坐标: X Y Z Dist (AU) + Vx Vy Vz (AU/d)
                x, y, z = (float(parts[0]), float(parts[1]), float(parts[2]))
                vx, vy, vz = (float(parts[4]), float(parts[5]), float(parts[6]))
            except (ValueError, IndexError):
                continue
            AU = 1.495978707e8
            AUD = AU / 86400.0
            us_all.append(u + rows * step)
            pos_all.append(eq_to_ecl((x * AU, y * AU, z * AU)))
            vel_all.append(eq_to_ecl((vx * AUD, vy * AUD, vz * AUD)))
            rows += 1
        if rows == 0:
            raise RuntimeError(f"miriade no rows {name} @{ts}")
        u += rows * step
        print(f"    miriade {name}: +{rows} rows ({u - t0u:.0f}/{t1u - t0u:.0f}s)", flush=True)
        time.sleep(0.8)
    us = np.array(us_all)
    pos = np.array(pos_all)
    vel = np.array(vel_all)
    np.savez_compressed(p, us=us, pos=pos, vel=vel)
    return us, pos, vel


class MiriadeBody:
    """Miriade 网格 CR 采样器（日心黄道 km）。CR 四阶插值对近圆轨道误差可忽略：
    金星 6h 网格 ~2e-6 km，外行星 1d 网格更小。"""

    def __init__(self, name, t0u, t1u, step):
        self.name = name
        self.us, self.pos, self.vel = mir_fetch(name, t0u, t1u, step)
        self.step = step

    def _seg(self, u):
        n = len(self.us)
        f = (u - self.us[0]) / self.step
        f = max(0.0, min(float(n - 1), f))
        i = min(n - 2, int(math.floor(f)))
        return i, f - i

    def _cr(self, arr, u):
        n = len(self.us)
        i, s = self._seg(u)
        i0 = i - 1 if i > 0 else 0
        i3 = i + 2 if i + 2 <= n - 1 else n - 1
        p0, p1, p2, p3 = arr[i0], arr[i], arr[i + 1], arr[i3]
        out = np.empty(3)
        for k in range(3):
            a0, a1, a2, a3 = p0[k], p1[k], p2[k], p3[k]
            out[k] = 0.5 * ((2.0 * a1) + (a2 - a0) * s
                            + (2.0 * a0 - 5.0 * a1 + 4.0 * a2 - a3) * s * s
                            + (3.0 * a1 - a0 - 3.0 * a2 + a3) * s * s * s)
        return out

    def pos(self, u):
        return self._cr(self.pos, float(u))

    def vel(self, u):
        return self._cr(self.vel, float(u))


# SPICE 直供的行星（内核池含其体中心/质心）。全任务重构轨道
# （171215R_SCPSEops_97288_17258.bsp）内含 1..10/199/299/301/399/499/599 全部
# 行星与质心，故八颗行星均可直接走 SPICE，无需联网取 Miriade 网格。
PLANET_SPICE = {"mercury", "venus", "earth", "mars",
                "jupiter", "saturn", "uranus", "neptune"}
MIR_PLANET_NAME = {
    "mercury": "Mercury", "venus": "Venus", "mars": "Mars",
    "uranus": "Uranus", "neptune": "Neptune",
}

# 行星位置统一分发：SPICE 优先；SPK 缺体中心（299 等）的行星走 Miriade。
_MIR = {}                # name → MiriadeBody（惰性共享缓存）
_SPICE_VENUS = None      # None=未探测；main() 加载内核后探测 co_* 是否含 299


def _mir_body(name):
    if name not in _MIR:
        step = 21600.0 if name in ("mercury", "venus", "earth", "mars") else 86400.0
        print(f"  miriade fetch {name} ...", flush=True)
        _MIR[name] = MiriadeBody(MIR_PLANET_NAME[name],
                                 T_START - 40 * 86400, T_END + 40 * 86400, step)
    return _MIR[name]


def detect_spice_planets():
    """探测内核池中可用的行星体中心（决定金星锚定/SOI 扫描走 SPICE 还是 Miriade）。"""
    global _SPICE_VENUS
    probe = {
        "venus": ("VENUS", "SUN"), "earth": ("EARTH", "SUN"),
        "jupiter": ("JUPITER BARYCENTER", "SUN"), "saturn": ("SATURN BARYCENTER", "SUN"),
    }
    ok = {}
    for name, (tgt, ctr) in probe.items():
        try:
            state("CASSINI", tgt, float(T_START + 400 * 86400))
            ok[name] = True
        except Exception:
            ok[name] = False
    _SPICE_VENUS = ok["venus"]
    print(f"  SPICE planet check: " +
          ", ".join(f"{k}={'Y' if v else 'N(miriade)'}" for k, v in ok.items()))
    return ok


def cassini_rel_planet(name, u):
    """CASSINI 相对行星的位置（黄道 km）。金星 SPK 缺失时 SPICE+Miriade 合成。"""
    if name == "venus" and _SPICE_VENUS is False:
        return np.asarray(pos_ecl("CASSINI", "SUN", u)) - _mir_body("venus").pos(u)
    p = np.asarray(pos_ecl("CASSINI", PLANET_TARGET[name], u))
    if name == "saturn":
        p = p - SB.offset(u)     # 相对体中心（与 soi/trail 相对几何一致）
    return p


def coarse_soi_spans(name, r_soi, a, b, step=86400.0):
    """日心粗扫 |C−P| < r_soi 的候选时间域（1d 网格，用于逐段细化）。"""
    spans, cur = [], None
    n = int((b - a) / step) + 1
    for i in range(n):
        u = a + i * step
        # cassini_rel_planet 返回的已是 CASSINI 相对该行星的矢量，
        # 距离即其模（旧写法再减一次日心位置，等于拿行星日心坐标当距差，
        # 恒 > r_soi → 所有候选域都为空）。
        d = float(np.linalg.norm(cassini_rel_planet(name, float(u))))
        inside = d < r_soi
        if inside and cur is None:
            cur = float(u)
        elif not inside and cur is not None:
            spans.append((cur, float(u)))
            cur = None
    if cur is not None:
        spans.append((cur, float(b)))
    return spans


def bake_planets2(t0s=None, t1s=None):
    """行星网格（SPICE / Miriade 混合）+ 轨道线 + 密切根数关键帧。
    t0s/t1s：SPICE 行星的可用数据域（Miriade 行星不受限）。"""
    bodies = {}
    t0p = calendar.timegm((1997, 6, 1, 0, 0, 0)) - J2000_UNIX
    t1p = calendar.timegm((2017, 12, 31, 0, 0, 0)) - J2000_UNIX
    mu_sun = sun_gm()
    for name in PLANETS:
        t0e, t1e = t0p, t1p
        if name in PLANET_SPICE and t0s is not None:
            t0e, t1e = max(t0p, t0s), min(t1p, t1s)
        step = 21600.0 if name in ("mercury", "venus", "earth", "mars") else 86400.0
        n = int(round((t1e - t0e) / step)) + 1
        pts = np.empty((n, 3))
        vels = np.empty((n, 3))
        if name in PLANET_SPICE:
            tgt = PLANET_TARGET[name]
            for i in range(n):
                u = t0e + i * step
                st = state(tgt, "SUN", float(u))
                pts[i] = eq_to_ecl((st[0], st[1], st[2]))
                vels[i] = eq_to_ecl((st[3], st[4], st[5]))
                if name == "saturn":
                    pts[i] += SB.offset(float(u))   # 体中心（对准全球与环面）
        else:
            mb = _mir_body(name)
            for i in range(n):
                u = t0e + i * step
                pts[i] = mb.pos(float(u))
                vels[i] = mb.vel(float(u))
        pts32 = np.asarray([[f32(v) for v in p] for p in pts])
        # 密切根数关键帧：SPICE 直算或由 r,v 数值代入
        if name in PLANET_SPICE:
            tgt = PLANET_TARGET[name]
            elems = elements_keyframes(tgt, "SUN", mu_sun, t0e, t1e, 30 * 86400.0, 320)
            orb = orbit_line(tgt if name != "saturn" else "SATURN BARYCENTER",
                             "SUN", mu_sun, t0e)
        else:
            mb = _mir_body(name)
            sel_us = np.linspace(t0e, t1e, 320)
            els = []
            for su in sel_us:
                r = mb.pos(float(su))
                v = mb.vel(float(su))
                el = osc_elements_rv(r, v, mu_sun)
                if el:
                    els.append((float(su), el))
            eT = np.array([s[0] for s in els])
            eV = np.array([v for s in els for v in s[1]], dtype="<f4")
            elems = {"eT": b64f64(eT), "eV": b64f32(eV), "n": len(els)}
            orb = orbit_line_rv(els[0][1])
        # 时间标签必须是【实际网格起点 t0e】而非名义起点 t0p：
        # SPICE 行星的网格域被钳到内核可用域 [t0s, t1s]，t0e = max(t0p, t0s)。
        # 本项目行星历表仅由 Cassini -82 ops 内核（1997-10-15 起）提供，
        # t0e 比 t0p（1997-06-01）晚 136.4 天——若写 t0p 会使整条行星轨迹
        # 相对飞船轨迹错位 136.4 天（飞掠时刻行星不在飞船处）。
        bodies[name] = {
            "radiusKm": RADII[name],
            "segs": pack([(t0e, step, pts32)]),
            "o": orb,
            "elems": elems,
        }
        print(f"planet {name}: {n} pts ({'spice' if name in PLANET_SPICE else 'miriade'})")
    return bodies


def osc_elements_rv(r, v, mu):
    """由状态向量 (r, v, 黄道系 km, km/s) 求密切根数（根数在 ICRF 赤道系）。"""
    ce, se = math.cos(OBL), math.sin(OBL)
    r_eq = (r[0], r[1] * ce - r[2] * se, r[1] * se + r[2] * ce)
    v_eq = (v[0], v[1] * ce - v[2] * se, v[1] * se + v[2] * ce)
    r = np.asarray(r_eq, dtype=float)
    v = np.asarray(v_eq, dtype=float)
    rn = float(np.linalg.norm(r))
    vn2 = float(np.dot(v, v))
    rv = float(np.dot(r, v))
    h = np.cross(r, v)
    hn = float(np.linalg.norm(h))
    H = h / hn
    evec = ((vn2 - mu / rn) * r - rv * v) / mu
    e = float(np.linalg.norm(evec))
    a = 1.0 / (2.0 / rn - vn2 / mu)
    if e >= 1.0 or a <= 0:
        return None
    P = evec / e if e > 1e-9 else r / rn
    P = P - H * float(np.dot(P, H))
    P = P / float(np.linalg.norm(P))
    Q = np.cross(H, P)
    E = math.atan2(float(np.dot(r, Q)) / (a * math.sqrt(1 - e * e)),
                   (float(np.dot(r, P)) + a * e) / a)
    M = E - e * math.sin(E)
    n = math.sqrt(mu / (a ** 3))
    qw, qx, qy, qz = quat_from_basis(P, Q, H)
    return (float(a), e, n, M, qw, qx, qy, qz)


def orbit_line_rv(el):
    """由根数元组生成一圈轨道线（与 orbit_line 相同输出格式）"""
    a, e, n, M0, qw, qx, qy, qz = el
    T = 2 * math.pi / n
    N = 256
    pts = []
    for i in range(N):
        M = M0 + n * (T * i / N)
        pts.append(elem_pos_ecl(el, M))
    arr = np.asarray(pts, "<f4")
    return base64.b64encode(arr.tobytes()).decode("ascii")


# ---------- 锚定轨道（切比雪夫，模型定位 ≤1 km） ----------
# 前端模型定位：anchors 窗口表 → 对应 track（相对锚定体）→ anchor 世界位置 +
# track 求值。窗口覆盖发射/飞掠/土星段；窗口外模型走主轨迹插值（线渲染精度）。

ANCHOR_WINS = [
    # (anchor, t0, t1, 标签)
    ("earth", calendar.timegm((1997, 10, 14, 0, 0, 0)) - J2000_UNIX,
     calendar.timegm((1997, 10, 26, 0, 0, 0)) - J2000_UNIX, "launch"),
    ("venus", calendar.timegm((1998, 4, 20, 0, 0, 0)) - J2000_UNIX,
     calendar.timegm((1998, 5, 2, 0, 0, 0)) - J2000_UNIX, "venus1"),
    ("venus", calendar.timegm((1999, 6, 19, 0, 0, 0)) - J2000_UNIX,
     calendar.timegm((1999, 7, 1, 0, 0, 0)) - J2000_UNIX, "venus2"),
    ("earth", calendar.timegm((1999, 8, 13, 0, 0, 0)) - J2000_UNIX,
     calendar.timegm((1999, 8, 24, 0, 0, 0)) - J2000_UNIX, "earthflyby"),
    ("jupiter", calendar.timegm((2000, 11, 20, 0, 0, 0)) - J2000_UNIX,
     calendar.timegm((2001, 1, 20, 0, 0, 0)) - J2000_UNIX, "jupiterflyby"),
]

SOI_ENTER_SATURN = calendar.timegm((2004, 5, 10, 0, 0, 0)) - J2000_UNIX  # 土星锚定起点（SOI 前 52d）

ANCHOR_BODY = {
    "earth": ("EARTH", False),
    "venus": ("VENUS", False),
    "jupiter": ("JUPITER BARYCENTER", False),
    "saturn": ("SATURN BARYCENTER", True),   # body_rel：减 SB.offset → 体中心
}


def anchor_sampler(name):
    """CASSINI 相对锚定体的采样器（黄道 km）。金星 SPK 缺 299 时回退
    cassini(SPICE) − venus(Miriade)：INPOP vs DE 框架差在内行星 <1 km 量级，
    且窗口内作为整体偏移被切比雪夫继承，不影响分离/接近几何的相对平滑度。"""
    if name == "venus" and _SPICE_VENUS is False:
        def s(u):
            return np.asarray(pos_ecl("CASSINI", "SUN", u)) - _mir_body("venus").pos(u)
        print("  venus anchor: SPK 无 299 → Miriade 回退采样器")
        return s
    body, body_rel = ANCHOR_BODY[name]
    return make_sampler("CASSINI", body, body_rel)


def bake_anchors(ts=None, te=None):
    """烘焙锚定轨道与窗口表。ts/te = 内核数据域（窗口钳制到域内）。
    返回 (tracks dict, anchors windows list)。"""
    tracks = {}
    wins_out = []
    plan = list(ANCHOR_WINS) + [
        ("saturn", SOI_ENTER_SATURN, te or T_END, "saturn"),
    ]
    for anchor, a, b, tag in plan:
        a = max(a, (ts + 60.0) if ts is not None else a)
        b = min(b, (te - 60.0) if te is not None else b)
        if b - a < 600.0:
            print(f"  anchor {tag}: 窗口在数据域外，跳过")
            continue
        # 土星段窗口极大（13 年），w0 从 2d 起自适应收缩；wmax 16d
        if anchor == "saturn":
            w0 = 2 * 86400.0
        else:
            w0 = 0.5 * 86400.0
        sampler = anchor_sampler(anchor)
        try:
            sampler(0.5 * (a + b))
        except Exception as ex:
            raise RuntimeError(f"anchor {tag}: 锚定体内核在窗口内不可用: {ex}")
        recs = cheb_fit_track(sampler, a, b, w0,
                              wmax=(16 * 86400.0 if anchor == "saturn" else 4 * 86400.0))
        packed = pack_track(recs)
        packed["anchor"] = anchor
        # 验证
        pt = prep_track(packed)
        rng = np.random.default_rng(1234)
        errs = []
        for u in rng.uniform(a, b, 60):
            errs.append(float(np.linalg.norm(cheb_at(pt, float(u)) - sampler(float(u)))))
        tkey = f"{anchor}"
        # 同锚定体多窗口合并进同一 track（cheb 窗口本就按时间排序、互不重叠）
        if tkey in tracks:
            old = tracks[tkey]
            ot = np.frombuffer(base64.b64decode(old["t"]), "<f8")
            ow = np.frombuffer(base64.b64decode(old["w"]), "<f8")
            oc = np.frombuffer(base64.b64decode(old["c"]), "<f8").reshape(-1, 3, CHEB_DEG + 1)
            nt = np.frombuffer(base64.b64decode(packed["t"]), "<f8")
            nw = np.frombuffer(base64.b64decode(packed["w"]), "<f8")
            nc = np.frombuffer(base64.b64decode(packed["c"]), "<f8").reshape(-1, 3, CHEB_DEG + 1)
            allt = np.concatenate([ot, nt])
            allw = np.concatenate([ow, nw])
            allc = np.concatenate([oc, nc], axis=0)
            order = np.argsort(allt)
            tracks[tkey] = {
                "deg": CHEB_DEG, "n": len(allt), "anchor": anchor,
                "t": b64f64(allt[order]), "w": b64f64(allw[order]),
                "c": b64f64(allc[order].ravel()),
            }
        else:
            tracks[tkey] = packed
        wins_out.append([a, b, tkey])
        print(f"  anchor {tag} ({anchor}): {len(recs)} recs, "
              f"span {(b - a) / 86400:.1f}d, max_err={max(errs):.4f} km")
    return tracks, wins_out


# ---------- 惠更斯（NAIF SPICE -150 CASP 重构星历直采） ----------
# 内核池 050214R_SCPSE_04336_05015.bsp 含 -150 (CASP, Huygens probe) 重构段：
# 2004-11-23 .. 2005-01-14 09:05:52.5 UTC（进入界面）。分离前 -150 与 -82
# 严格同点；2004-12-25 02:00:00 UTC 弹射分离（NASA/ESA：弹簧分离机构，相对
# 速度 ~0.3 m/s + 7 rpm 自旋稳定；SPICE 真值 ~0.39 m/s），sep+7.1h 相距
# 10 km，sep+20d（2005-01-14）以 1270 km / 6.03 km/s / 路径角 -65.55° 进入
# Titan 大气（与 NASA 公布进入条件一致）。进入后的下降无 SPICE 覆盖：由真实
# 进入状态在 Titan 点质量下弹道外推至 ~160 km 气动截断，接贝塞尔下降（旧管
# 线同式）。旧「dynamo 相对动力学积分 + 打靶锚定」方案废弃——真值直采不再
# 依赖 dynamo 巡航腿的 v_rel 初值与 31.9 天转移周期近似。


SEP_UTC = "2004-12-25 02:00:00"      # Huygens 分离（NASA 实录）
ENTRY_UTC = "2005-01-14 09:06:00"    # 进入界面（NASA science.nasa.gov）
SEP_ET = None                          # main() 里由 TM 装载
ENTRY_ET = None


def pack_huy(rows):
    tt = [r[0] for r in rows]
    flat = [v for r in rows for v in r[1:]]
    return {
        "t": base64.b64encode(struct.pack(f"<{len(tt)}d", *tt)).decode("ascii"),
        "d": base64.b64encode(struct.pack(f"<{len(flat)}f", *flat)).decode("ascii"),
        "n": len(rows),
    }


def u_from_et(et):
    """TM 逆映射：ET(TDB) → u（app 秒）。off 随 u 变化 <0.1 s/月，两步收敛。"""
    u = et - float(np.interp(et, TM.ets, TM.off))
    for _ in range(2):
        u = et - float(np.interp(u, TM.us, TM.off))
    return u


def probe_last_epoch():
    """-150 段实际末元：spkcov 端点与段内末细分点略有出入（~0.02 s），
    从 2005-01-14 09:06:00 UTC 起按 0.25 s 步回探首个可求值时刻。
    该时刻即真实进入界面（1270 km，与 NASA 公布的 09:06 UTC 进入一致）。"""
    et_hi = TM.et(calendar.timegm((2005, 1, 14, 9, 6, 0)) - J2000_UNIX)
    et = et_hi
    while et > et_hi - 300.0:
        try:
            sp.spkezr("-150", et, "J2000", "NONE", "-82")
            return et
        except Exception:
            et -= 0.25
    raise RuntimeError("-150 (CASP) 在进入界面附近不可求值——COSP 卷缺 050214R_SCPSE？")


def bake_huygens(moons_raw=None):
    """惠更斯真实轨迹（-150 CASP 真值直采）。moons_raw 参数保留兼容旧签名，
    真实星历不再需要卫星网格。输出行（黄道系 km，t 为 app 秒；pack_huy 格式）：
      relCass = -150 相对 -82       —— 前端分离近场渲染（Cassini 模型锚定 + 真实 ρ）
      relSat  = -150 相对土星体中心 —— 一级轨迹线锚（前端 saturn.world 锚定）
      relTit  = -150 相对 Titan     —— 进入/下降段（前端 titan.world 锚定）"""
    global SEP_ET, ENTRY_ET
    SEP_ET = TM.et(calendar.timegm((2004, 12, 25, 2, 0, 0)) - J2000_UNIX)
    ENTRY_ET = probe_last_epoch()
    TD_ET = ENTRY_ET + 2 * 3600 + 27 * 60
    LOS_ET = TD_ET + 72 * 60
    sep_u = calendar.timegm((2004, 12, 25, 2, 0, 0)) - J2000_UNIX
    entry_u = u_from_et(ENTRY_ET)
    td_u = u_from_et(TD_ET)

    def rel_ecl(target, etv):
        st, _lt = sp.spkezr("-150", etv, "J2000", "NONE", target)
        return eq_to_ecl((st[0], st[1], st[2]))

    def rel_satbody(u):
        r = rel_ecl("SATURN BARYCENTER", TM.et(u))
        o = SB.offset(u)
        return (r[0] - o[0], r[1] - o[1], r[2] - o[2])

    # ---- relCass / relSat（sep → entry）----
    # cadence：分离近场 30 s（模型实时漂移）→ 2 d 内 300 s → 巡航中段 1800 s
    # → 进入前 2 d 60 s（相对弧加速弯曲）。relSat 与 relCass 同网格行。
    def cass_cadence(t):
        dt = t - sep_u
        if dt < 3 * 3600:
            return 30.0
        if dt < 2 * 86400:
            return 300.0
        if t < entry_u - 2 * 86400:
            return 1800.0
        return 60.0

    rows_cass = []
    rows_sat = []
    t = sep_u
    while True:
        rho = rel_ecl("-82", TM.et(t))
        rows_cass.append((t, f32(rho[0]), f32(rho[1]), f32(rho[2])))
        p = rel_satbody(t)
        rows_sat.append((t, f32(p[0]), f32(p[1]), f32(p[2])))
        if t >= entry_u:
            break
        t = min(t + cass_cadence(t), entry_u)

    # ---- relTit（真实进入状态 → 弹道外推 → 贝塞尔下降）----
    st_e, _lt = sp.spkezr("-150", ENTRY_ET, "J2000", "NONE", "TITAN")
    r_entry = np.array(eq_to_ecl((st_e[0], st_e[1], st_e[2])))
    v_entry = np.array(eq_to_ecl((st_e[3], st_e[4], st_e[5])))
    alt_e = float(np.linalg.norm(r_entry)) - RADII["titan"]
    v_n = float(np.linalg.norm(v_entry))
    fpa = math.degrees(math.asin(max(-1.0, min(1.0, float(np.dot(r_entry, v_entry))
                                                     / (np.linalg.norm(r_entry) * v_n)))))
    print(f"  -150 entry state: alt={alt_e:,.1f} km  speed={v_n:.3f} km/s  "
          f"fpa={fpa:.2f} deg")

    MU_T = gm("TITAN") or 8978.139
    R_T = RADII["titan"]

    def acc_t(r):
        rn = float(np.linalg.norm(r))
        return -MU_T * r / rn ** 3

    # 弹道外推至 ~160 km 气动截断（RK4 @1s；Titan 点质量，3-6 min 弧误差 << 1 km）
    h = 1.0
    b_rows = []                      # (ET, np[3]) 每 10 s
    r = r_entry.copy()
    v = v_entry.copy()
    aero_et = ENTRY_ET
    aero_r = r.copy()
    aero_v = v.copy()
    for i in range(1800):
        k1r, k1v = v, acc_t(r)
        k2r, k2v = v + 0.5 * h * k1v, acc_t(r + 0.5 * h * k1r)
        k3r, k3v = v + 0.5 * h * k2v, acc_t(r + 0.5 * h * k2r)
        k4r, k4v = v + h * k3v, acc_t(r + h * k3r)
        r = r + h / 6.0 * (k1r + 2 * k2r + 2 * k3r + k4r)
        v = v + h / 6.0 * (k1v + 2 * k2v + 2 * k3v + k4v)
        if (i + 1) % 10 == 0:
            b_rows.append((ENTRY_ET + (i + 1) * h, r.copy()))
        if float(np.linalg.norm(r)) < R_T + 160.0:
            aero_et = ENTRY_ET + (i + 1) * h
            aero_r = r.copy()
            aero_v = v.copy()
            break

    # 贝塞尔下降：S = 气动截断点（速度向切向连续），E = 真实进入点方向径向投影
    # 到表面，C = S + 切向×0.45×drop + 侧向×0.12×drop（风漂移），ease-out 先快后慢
    S3 = aero_r
    tan3 = aero_v / float(np.linalg.norm(aero_v))
    E3 = r_entry / float(np.linalg.norm(r_entry)) * R_T
    side3 = np.cross(tan3, np.array([0.0, 1.0, 0.0]))
    sn = float(np.linalg.norm(side3))
    side3 = side3 / (sn or 1.0)
    drop = float(np.linalg.norm(S3 - E3))
    C3 = S3 + tan3 * 0.45 * drop + side3 * 0.12 * drop
    print(f"  ballistic entry→aero {(aero_et - ENTRY_ET):.0f} s "
          f"(alt {float(np.linalg.norm(aero_r)) - R_T:,.0f} km), drop {drop:,.0f} km")

    ti_rows = []
    t = entry_u - 3600.0
    while True:
        p = rel_ecl("TITAN", TM.et(t))
        ti_rows.append((t, f32(p[0]), f32(p[1]), f32(p[2])))
        if t >= entry_u:
            break
        t = min(t + 30.0, entry_u)
    for (bet, br) in b_rows:
        if bet <= ENTRY_ET + 0.5:
            continue
        ti_rows.append((u_from_et(bet), f32(br[0]), f32(br[1]), f32(br[2])))
    t_a_u = u_from_et(aero_et)
    t = max(t_a_u, ti_rows[-1][0] + 1.0)
    while True:
        s = (t - t_a_u) / max(1.0, td_u - t_a_u)
        uu = 1.0 - math.pow(1.0 - min(1.0, s), 1.8)
        p = (1.0 - uu) ** 2 * S3 + 2.0 * (1.0 - uu) * uu * C3 + uu * uu * E3
        ti_rows.append((t, f32(p[0]), f32(p[1]), f32(p[2])))
        if t >= td_u:
            break
        t = min(t + 120.0, td_u)
    ti_rows[-1] = (td_u, f32(E3[0]), f32(E3[1]), f32(E3[2]))

    # et 常量导出为 u 域（UTC 秒自 J2000 unix）——与 trail/moons 行、scene.js
    # HUYGENS_SEP_ET、事件表同域：前端 timeline t（TDB）统一求值，分离瞬间
    # relCass 首行 ρ=0 与挂载态严格连续（TDB 域会引入 64.2 s 相位差 → 跳变）。
    huy = {"sepEt": sep_u, "entryEt": entry_u, "tdEt": td_u, "losEt": u_from_et(LOS_ET)}
    huy["relCass"] = pack_huy(rows_cass)
    huy["relSat"] = pack_huy(rows_sat)
    huy["relTit"] = pack_huy(ti_rows)

    # ---- 校验（分离漂移 / 10 km 时刻 / 进入几何，与 NASA 公布值对照）----
    rc_t = np.frombuffer(base64.b64decode(huy["relCass"]["t"]), "<f8")
    rc_d = np.frombuffer(base64.b64decode(huy["relCass"]["d"]), "<f4").reshape(-1, 3)
    rc_n = np.linalg.norm(rc_d, axis=1)

    def dist_at(dt):
        return float(np.interp(sep_u + dt, rc_t, rc_n))

    for (lbl, dt) in (("sep+1min", 60.0), ("sep+1h", 3600.0), ("sep+24h", 86400.0)):
        print(f"  huygens {lbl}: |ρ| = {dist_at(dt):,.2f} km")
    lo, hi = 0.0, 20 * 86400.0
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if dist_at(mid) < 10.0:
            lo = mid
        else:
            hi = mid
    print(f"  10 km @ sep+{lo / 3600:.2f} h | rows: relCass {len(rows_cass)}, "
          f"relSat {len(rows_sat)}, relTit {len(ti_rows)}")
    return huy


def patch_huygens_only():
    """--huygens 模式：只重烘焙惠更斯段并就地修补 data/cassini_data.js。
    现有 COSP 卷缺 1997-2001 巡航 SPK（co_*，见 missing_bsp.txt），全量
    verify_coverage 无法通过；惠更斯段只需 2004-12 .. 2005-01 的 -82 / -150
    SCPSE 覆盖。其余数据（行星/卫星/Cassini 主轨迹）保持不动——惠更斯以
    relCass（真实相对行）锚定前端 Cassini 模型位置，绝对框架入差被前端
    HUY_BLEND 缓慢插值机制吸收。"""
    print("=== bake_spice.py --huygens（惠更斯段定点重烘焙，NAIF -150 真值）===")
    for name in ("naif0012.tls", "pck00010.tpc", "cpck31Oct2017.tpc"):
        p = os.path.join(COSP, name)
        if os.path.exists(p):
            sp.furnsh(p)
    need = [
        "050105RB_SCPSE_04247_04336.bsp",   # -82: 2004-12-13 .. 2005-01-01
        "050214R_SCPSE_04336_05015.bsp",    # -82 + -150 (CASP): .. 2005-01-15
    ]
    for n in need:
        p = os.path.join(COSP, n)
        if not os.path.exists(p):
            raise RuntimeError(f"缺 SPK 内核 {n}（COSP 卷不完整）")
        sp.furnsh(p)
        print(f"  furnsh {n}")
    # 土星质心→体中心偏移网格（relSat 体中心口径；惠更斯窗口 ±2 d）
    SB.build_grid(calendar.timegm((2004, 12, 23, 0, 0, 0)) - J2000_UNIX,
                  calendar.timegm((2005, 1, 14, 12, 0, 0)) - J2000_UNIX)
    huy = bake_huygens(None)
    out_path = os.path.join(OUT, "cassini_data.js")
    with open(out_path, encoding="utf-8") as f:
        src = f.read()
    i0 = src.index("{")
    i_end = src.rindex(";")
    data = json.loads(src[i0:i_end])
    data["spacecraft"]["cassini"]["huygens"] = huy
    out = src[:i0] + json.dumps(data, separators=(",", ":")) + src[i_end:]
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"\npatched {out_path} huygens section "
          f"(relCass {huy['relCass']['n']} rows, relSat {huy['relSat']['n']}, "
          f"relTit {huy['relTit']['n']})")



# ---------- main ----------

MARGIN = 45 * 60.0


def main():
    print("=== Cassini SPICE bake（COSP_1000 内核池）===")
    spks = load_kernels()
    verify_coverage(spks)
    detect_spice_planets()

    ts0 = first_spk_time()
    te0 = last_spk_time()
    print(f"  -82 数据域: {time.strftime('%Y-%m-%d %H:%M', time.gmtime(ts0 + J2000_UNIX))} .. "
          f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(te0 + J2000_UNIX))}")

    # 烘焙数据域（卫星网格 / SB 偏移网格 / SPICE 行星）= 内核域 ± 小余量
    d0, d1 = ts0 - 300.0, te0 + 300.0
    SB.build_grid(d0, d1)

    print("\n--- moons（CR 细网格）---")
    moons, moons_raw = bake_moons(d0, d1)

    print("\n--- planets（SPICE/Miriade 混合）---")
    bodies = bake_planets2(d0, d1)

    print("\n--- planet SOI 窗口 ---")
    soi_wins = {}
    for name in ("venus", "earth", "jupiter"):
        # 扫描域钳在内核实际数据域内（T_START=1997-10-01 早于 -82 起点 1997-10-15，
        # 此处若用常量会把扫描起点落到无历表区）
        spans = coarse_soi_spans(name, SOI_RADII[name], ts0, te0)
        wins = []
        for sp_ in spans:
            r = scan_planet_soi([sp_], name, SOI_RADII[name])
            if r:
                wins.append(r)
        soi_wins[name] = wins
        print(f"  {name}: {len(wins)} wins: " +
              "; ".join(f"{(b - a) / 86400:.2f}d" for (a, b) in wins))

    print("\n--- moon SOI 窗口 ---")
    enc_windows = scan_moon_soi_windows(ts0, te0, moons_raw)

    print("\n--- cassini 主轨迹（自适应弦差）---")
    all_t, trail32, pts, _sat_bary, _ = bake_cassini_trail(
        ts0, te0, moons_raw, soi_wins, enc_windows)

    print("\n--- 锚定轨道（切比雪夫，模型定位）---")
    tracks, anchors = bake_anchors(ts0, te0)

    print("\n--- huygens（相对动力学 + 入射锚定）---")
    huy = bake_huygens(moons_raw)

    # ---------- SOI 窗口表（前端 {name: [{a,b}]}，吸附到主轨迹顶点域） ----------
    def soi_window(t_from, t_to):
        k0 = int(np.searchsorted(all_t, t_from))
        k1 = int(np.searchsorted(all_t, t_to, side="right")) - 1
        if k0 >= len(all_t) or k1 < 0 or k1 - k0 < 1:
            return None
        return {"a": float(all_t[k0]), "b": float(all_t[k1])}

    soi = {}
    for name in ("venus", "earth", "jupiter"):
        rows = []
        for (a, b) in soi_wins[name]:
            w = soi_window(a - MARGIN, b + MARGIN)
            if w:
                rows.append(w)
        if rows:
            soi[name] = rows
    # earth：发射逃逸段（发射即在地球 SOI 内 → 穿出时刻）。
    # 注意：coarse_soi_spans 的扫描起点被钳到内核起点（= 发射时刻）后，飞船
    # 【一开始就在地球 SOI 内】，扫描器可能已自行捕获该段 → 直接 prepend 会得到
    # 两个几乎重合的窗口（前端 soiWindowAt 只会选其一绘制，但白建一份顶点缓冲）。
    # 故仅当现有 earth 窗口都未覆盖发射历元时才补建逃逸窗。
    l_out = soi_span("EARTH", "SUN", ts0,
                     calendar.timegm((1997, 11, 15, 0, 0, 0)) - J2000_UNIX,
                     SOI_RADII["earth"], step=3600.0)[1]
    if l_out:
        launch_covers = any(
            w["a"] <= all_t[0] + 1.0 and w["b"] >= all_t[0] for w in soi.get("earth", []))
        if not launch_covers:
            w = soi_window(all_t[0], l_out + MARGIN)
            if w:
                soi["earth"] = [w] + soi.get("earth", [])
    # saturn：进入 SOI 起至数据末尾（接近段 + 环轨道 13 年）
    s_in = soi_span("SATURN BARYCENTER", "SUN",
                    calendar.timegm((2004, 1, 1, 0, 0, 0)) - J2000_UNIX,
                    calendar.timegm((2004, 7, 1, 0, 0, 0)) - J2000_UNIX,
                    SOI_RADII["saturn"], step=3600.0)[0]
    if s_in:
        w = soi_window(s_in - MARGIN, all_t[-1])
        if w:
            soi["saturn"] = [w]
    # moons：卫星 SOI 穿越窗（二级相对轨迹）
    for (a, b, m) in enc_windows:
        w = soi_window(a - MARGIN, b + MARGIN)
        if w:
            soi.setdefault(m, []).append(w)

    # ---------- SOI 窗口相对几何（f64，源头消除精度损失） ----------
    # 相对轨迹 = 飞船 − 锚定体。若前端用「f32 日心飞船坐标 − 锚定体日心坐标」相减，
    # 会继承 f32 日心坐标的量化误差：土星段 |r|~1.5e9 km → ULP 128 km，即相对轨迹
    # 每顶点带 ±111 km（3 轴合成）误差，在近土星特写下约 17 px 的错位——正是用户
    # 反馈的「相对行星轨迹精度严重不足」。
    # 这里在烘焙端用 f64 的 pts（bake_cassini_trail 返回的第 3 项）减去锚定体 f64
    # 位置，得到小量 rel（窗口内 ~km..1e6 km），f32 存储时 ULP 仅 ~0.06 km 量级，
    # 前端直接用即可。relative 坐标同时给出 three 场景系（ecl→three: x, z, -y）。
    def _anchor_pos_ecl(name, u):
        """锚定体在 ecl km 的位置（与前端 entry.track + parent 的合成口径一致）。
        - saturn：体中心（质心 + SB.offset），与 trails 的土星口径逐位一致；
        - 行星：SPICE 质心/体中心（PLANET_TARGET）；
        - 卫星：母星（土星体中心）+ moons_raw[name] 的 CR 网格（母星相对，f32）。
        """
        if name in ("venus", "earth", "jupiter"):
            tgt = PLANET_TARGET.get(name)
            st = state(tgt, "SUN", float(u))
            return np.asarray(eq_to_ecl((st[0], st[1], st[2])))
        if name == "saturn":
            st = state("SATURN BARYCENTER", "SUN", float(u))
            return np.asarray(eq_to_ecl((st[0], st[1], st[2]))) + SB.offset(float(u))
        raw = moons_raw.get(name)
        if raw is None:
            return None
        st = state("SATURN BARYCENTER", "SUN", float(u))
        sat = np.asarray(eq_to_ecl((st[0], st[1], st[2]))) + SB.offset(float(u))
        return sat + np.asarray(moon_at(raw, float(u)))

    def attach_rel(w):
        """给窗口 w 附加 rel（f32 相对几何，three 系）+ rel0（f64 窗口锚点）。

        rel_i = 飞船(three) − 锚定体(three)（黄道 km，f64 相减后的小量）。
        **再减去窗口锚点 rel0**（rel 各轴中位数），使存储量 |rel_i − rel0| 远小于
        |rel_i|（土星窗口 |rel|max 5.45e7 km 但 p99 仅 3.5e6 km，去中位数后
        f32 ULP 由 ~4 km 降到 ~0.4 km，飞行段近场达 1e-3 km 级）。

        前端渲染语义（float-origin，与主轨迹同构）：
            buf_i        = rel_i − rel0            （f32，与相机/行星无关 → 永不需重建）
            line.position = 锚定体当前位置 + rel0 − camWorld   （f64 逐帧精确）
        渲染世界坐标 ≡ 锚定体当前 + rel_i（NASA Eyes 相对系语义）与缩放级别无关。
        """
        name = w.get("_name")
        i0 = int(np.searchsorted(all_t, w["a"]))
        i1 = int(np.searchsorted(all_t, w["b"], side="right")) - 1
        if i1 <= i0:
            return
        n = i1 - i0 + 1
        rel = np.empty((n, 3), dtype="<f8")
        for k in range(n):
            u = float(all_t[i0 + k])
            ap = _anchor_pos_ecl(name, u)
            if ap is None:
                return
            # pts（bake_cassini_trail 已内联赤道→黄道）与 ap（_anchor_pos_ecl 已
            # eq_to_ecl）均为黄道 km f64 —— 此处不可再 eq_to_ecl（曾双重旋转
            # 2ε≈46.9°：|rel| 模长不变但方向整体转错，相对轨迹几何错误）。
            px, py, pz = (float(pts[i0 + k, 0]), float(pts[i0 + k, 1]), float(pts[i0 + k, 2]))
            ax, ay, az = (float(ap[0]), float(ap[1]), float(ap[2]))
            rel[k, 0] = px - ax
            rel[k, 1] = pz - az               # three: y = ecl_z
            rel[k, 2] = -(py - ay)            # three: z = -ecl_y
        rel0 = np.median(rel, axis=0)         # 窗口锚点（各轴中位数，使 |rel−rel0| 最小化）
        w["i0"] = int(i0)
        w["n"] = int(n)
        w["rel0"] = b64f64(rel0)              # 锚点（f64，3 个数）
        w["rel"] = b64f32((rel - rel0).ravel())   # 去锚后小量，f32 ULP ≤ ~0.4 km
        w["relF64"] = True

    for name, rows in soi.items():
        for w in rows:
            w["_name"] = name
            attach_rel(w)
    for name, rows in soi.items():
        for w in rows:
            w.pop("_name", None)

    # 全局去重：同一锚定体的窗口按时间排序后，若相邻两窗重叠超过较短者时长的
    # 90%（典型来源：发射逃逸段被 SOI 扫描器与显式补建各生成一次），保留时间域
    # 更长的那个。前端 soiWindowAt 本就按窗口选一绘制，但重复窗会白建顶点缓冲。
    for name in list(soi):
        rows = sorted(soi[name], key=lambda w: (w["a"], -w["b"]))
        merged = []
        for w in rows:
            if merged:
                p = merged[-1]
                ov = min(p["b"], w["b"]) - max(p["a"], w["a"])
                if ov > 0:
                    short = min(p["b"] - p["a"], w["b"] - w["a"])
                    if ov >= 0.9 * short:
                        # 保留更长者（并列取 b 更大者）
                        if (w["b"] - w["a"]) > (p["b"] - p["a"]):
                            merged[-1] = w
                        continue
            merged.append(w)
        soi[name] = merged

    for m in list(soi):
        if m not in ("venus", "earth", "jupiter", "saturn"):
            soi[m].sort(key=lambda x: x["a"])
    print(f"\n  soi windows: " + ", ".join(f"{k}×{len(v)}" for k, v in soi.items()))

    # ---------- 校验 ----------
    print("\n=== 校验 ===")
    # 1) 主轨迹弦差：逐【相邻顶点对】取中点与 SPICE 真值比对（这才是渲染
    #    实际使用的线段精度，也与 TRAIL_TOL 同口径）。
    #    注意不能用三点跨段（i-1,i+1）比对：那等价于两倍时间跨度、二次误差
    #    放大 4 倍（30 km 容限会读出 ~120 km），并非线段真实偏差。
    rng = np.random.default_rng(7)
    idx = rng.integers(0, len(all_t) - 1, 4000)
    max_dev = 0.0
    for i in idx:
        t0, t1 = float(all_t[i]), float(all_t[i + 1])
        tm = 0.5 * (t0 + t1)
        pl = 0.5 * (pts[i] + pts[i + 1])
        pt = eq_to_ecl(state("CASSINI", "SUN", tm)[:3])
        max_dev = max(max_dev, float(np.linalg.norm(pl - np.asarray(pt))))
    print(f"  trail 逐段弦差（4000 样本）: {max_dev:.1f} km（目标 ≤{TRAIL_TOL:.0f}）")
    # 1b) f32 存储量化下限（随日心距线性放大：内行星 ~16 km，土星 ~128 km）
    _qf = max(float(np.spacing(np.float32(np.linalg.norm(p)))) for p in pts[::max(1, len(pts) // 2000)])
    print(f"  trail f32 存储量化间距（最大）：{_qf:.1f} km（渲染顶点精度下限，非插值误差）")
    # 2) 关键飞掠最近距离（SPICE 真值直算；对照任务实录）
    _flyby_ref = {
        "venus": [(1998, 4, 20, 1998, 5, 2, 284.0), (1999, 6, 18, 1999, 7, 1, 598.0)],
        "earth": [(1999, 8, 12, 1999, 8, 24, 1171.0)],
        "jupiter": [(2000, 12, 20, 2001, 1, 10, None)],
    }
    for _name, _wins in _flyby_ref.items():
        for (y0, m0, d0_, y1, m1, d1_, alt_ref) in _wins:
            a_ = calendar.timegm((y0, m0, d0_, 0, 0, 0)) - J2000_UNIX
            b_ = calendar.timegm((y1, m1, d1_, 0, 0, 0)) - J2000_UNIX
            rmin, rmin_u = 1e18, None
            u = a_
            while u <= b_:
                r = float(np.linalg.norm(np.asarray(pos_ecl("CASSINI", PLANET_TARGET[_name], float(u)))))
                if r < rmin:
                    rmin, rmin_u = r, u
                u += 60.0
            _rad = RADII.get(_name, 0.0)
            _alt = rmin - _rad
            _s = f"  flyby {_name}: |r|min={rmin:,.0f} km (高度 {_alt:,.0f} km) @ "
            _s += time.strftime("%Y-%m-%d %H:%M", time.gmtime(rmin_u + J2000_UNIX))
            if alt_ref:
                _s += f"（实录 {alt_ref:,.0f} km，偏差 {_alt - alt_ref:+,.0f} km）"
            print(_s)
    # 3) 惠更斯分离距离增长（relCass 行插值；分离后应近似匀速漂移）
    rc_t = np.frombuffer(base64.b64decode(huy["relCass"]["t"]), "<f8")
    rc_d = np.frombuffer(base64.b64decode(huy["relCass"]["d"]), "<f4").reshape(-1, 3)
    for (lbl, dt) in (("sep+1min", 60.0), ("sep+1h", 3600.0), ("sep+24h", 86400.0)):
        t = huy["sepEt"] + dt
        rho = np.array([float(np.interp(t, rc_t, rc_d[:, k])) for k in range(3)])
        print(f"  huygens {lbl}: |ρ| = {float(np.linalg.norm(rho)):,.1f} km")

    # ---------- 输出 ----------
    meta = {
        "j2000Ms": J2000_UNIX * 1000,
        "tStart": float(all_t[0]),
        "tEnd": float(all_t[-1]),
        "generated": time.strftime("%Y-%m-%d"),
        "frame": "ecliptic J2000, km, heliocentric",
        "source": "NAIF SPICE：Cassini -82 全任务重构轨道 "
                  "171215R_SCPSEops_97288_17258.bsp（1997-10-15..2017-09-15，无缺口）"
                  " + 土卫 sat215 + 木卫 jup310；行星全部 SPICE 质心/体中心直采",
    }
    cassini = {
        "trailT": b64f64(all_t),
        "trail": b64f32(trail32.ravel()),
        "trailN": int(len(all_t)),
        "tracks": tracks,
        "anchors": anchors,
        "soi": soi,
        "huygens": huy,
    }
    data = {"meta": meta, "bodies": bodies, "spacecraft": {"cassini": cassini}}
    out_path = os.path.join(OUT, "cassini_data.js")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("/* 由 tools/bake_spice.py 生成 — 来源: NAIF SPICE COSP_1000 内核池 */\n")
        f.write("window.CASSINI_DATA = ")
        f.write(json.dumps(data, separators=(",", ":")))
        f.write(";\n")
    print(f"\nwrote {out_path} ({os.path.getsize(out_path) / 1e6:.2f} MB)")

    mdata = {"meta": dict(meta), "bodies": moons}
    mout = os.path.join(OUT, "moons_data.js")
    with open(mout, "w", encoding="utf-8") as f:
        f.write("/* 由 tools/bake_spice.py 生成 — 卫星细网格（运行时 Catmull-Rom 插值）*/\n")
        f.write("window.MOONS_DATA = ")
        f.write(json.dumps(mdata, separators=(",", ":")))
        f.write(";\n")
    print(f"wrote {mout} ({os.path.getsize(mout) / 1e6:.2f} MB)")
    print(f"mission span: {all_t[0]:.0f} .. {all_t[-1]:.0f} app-s")


if __name__ == "__main__":
    if "--huygens" in sys.argv:
        # 定点重烘焙惠更斯段（就地修补 data/cassini_data.js；全量烘焙需补齐
        # 1997-2001 巡航 SPK 后跑 main()）
        patch_huygens_only()
    else:
        main()
