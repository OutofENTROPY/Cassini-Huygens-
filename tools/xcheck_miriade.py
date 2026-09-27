# -*- coding: utf-8 -*-
"""xcheck_miriade.py — 用 IMCCE Miriade（INPOP13C 行星历表 + NAIF 官方 Cassini
SPICE 核 -82，均与 eyes.nasa.gov dynamo/DE 独立）交叉验证本地烘焙轨道数据。

只读校验：读取 data/cassini_data.js，不修改任何现有数据/文件。

Miriade 用法（实测确认）：
  GET ephemcc.php?-name=<t>&-type=planet&-ep=<UTC>&-nbd=1&-step=1m
      &-observer=<@sun|cassini>&-tcoor=2&-mime=text
  observer=@sun    → 行星日心赤道直角坐标 (X,Y,Z,Dist, AU) + 速度 (Xp,Yp,Zp, AU/d)
  observer=cassini → 目标相对 Cassini 的赤道直角坐标 (X,Y,Z, AU)，
                     D_observer = |目标−Cassini|（NAIF SPICE 核，
                     有效期 2001-03-07T12:00 — 2006-10-19T12:00 UTC）

检查项：
  1) 行星位置：dynamo(eyes) vs INPOP13C，日心黄道 km（飞掠/入轨/终段历元）
  2) Cassini 日心位置：烘焙 trail vs NAIF SPICE（2001-03..2006-10）
  3) Cassini↔土星 相对向量：烘焙 (trail − saturn) vs SPICE（SOI 相对轨迹一致性）
  4) SOI 近拱：烘焙 min|trail−saturn| vs SPICE 扫描最小值
时间约定：dynamo t 为 ET(TDB) 秒自 J2000(TDB)；脚本同时用「 naive(≈UTC) 」与
「 TDB 严格换算（差 ~128s）」两种约定插值 trail，用残差自行消歧。
"""
import base64
import calendar
import json
import math
import os
import re
import struct
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://vo.imcce.fr/webservices/miriade/ephemcc.php?"
CACHE = os.path.join(HERE, "xcache_miriade.json")
J2000_UNIX = 946728000                # 2000-01-01T12:00:00 UTC 的 unix 秒
J2000_UNIX_TDB = J2000_UNIX - 64.184  # J2000(TDB) 对应 unix 秒（TAI-UTC=32 → TDB-UTC=64.184）
AU_KM = 1.495978707e8
LIGHT_S_PER_AU = 499.004784
OBLIQUITY = math.radians(23.4392911)  # 与 bake_data.py 一致


def eq_to_ecl(v):
    x, y, z = v
    ce, se = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
    return (x, y * ce + z * se, -y * se + z * ce)


# ---------------- 时间 ----------------

def leap_tdb_minus_utc(y, mo):
    """TDB−UTC 秒（1997-2017）= TT-TAI(32.184) + TAI-UTC(闰秒)"""
    n = 32
    for ly, lm in ((1999, 1), (2006, 1), (2009, 1), (2012, 7), (2015, 7), (2017, 1)):
        if (y, mo) >= (ly, lm):
            n += 1
    return n + 32.184


def utc_to_et(y, mo, d, h, mi, s=0.0):
    """UTC 日历 → dynamo ET 秒（TDB 自 J2000 TDB）严格换算"""
    u = calendar.timegm((y, mo, d, h, mi, int(s), 0, 0, 0))
    return u + leap_tdb_minus_utc(y, mo) - J2000_UNIX_TDB


def utc_to_et_naive(y, mo, d, h, mi, s=0.0):
    """naive：把 dynamo ET 直接当 UTC 秒自 2000-01-01T12:00Z（项目显示层用法）"""
    u = calendar.timegm((y, mo, d, h, mi, int(s), 0, 0, 0))
    return u - J2000_UNIX


def et_utc_label_naive(t_et):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t_et + J2000_UNIX))


# ---------------- Miriade 查询（带磁盘缓存）----------------

_cache = {}
_cache_dirty = False


def _load_cache():
    global _cache
    if os.path.exists(CACHE):
        try:
            _cache = json.load(open(CACHE, "r", encoding="utf-8"))
        except Exception:
            _cache = {}


def _save_cache():
    if _cache_dirty:
        json.dump(_cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)


def http_get(url, tries=3):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa
            last = e
            time.sleep(1.5 * (a + 1))
    raise RuntimeError(f"GET failed: {url[:120]}: {last}")


def mir_raw(name, typ, epoch, observer):
    key = f"{name}|{typ}|{epoch}|{observer}"
    if key in _cache:
        return _cache[key]
    params = {"-name": name, "-type": typ, "-ep": epoch, "-nbd": "1", "-step": "1m",
              "-observer": observer, "-tcoor": "2", "-mime": "text"}
    txt = http_get(API + urllib.parse.urlencode(params))
    time.sleep(0.25)
    if "# Flag: -1" in txt or "Bad request" in txt or "not found" in txt.lower():
        _cache[key] = {"error": txt.strip()[:200]}
        _cache_dirty = True
        return _cache[key]
    rows = []
    for line in txt.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = s.split()
        if re.match(r"^\d{4}-\d{2}-\d{2}T", parts[0]):
            parts = parts[1:]  # 丢弃日期列
        nums = []
        for p in parts:
            try:
                nums.append(float(p))
            except ValueError:
                break
        if len(nums) >= 7:
            rows.append(nums)
    if not rows:
        _cache[key] = {"error": "no data rows: " + txt.strip()[:160]}
        _cache_dirty = True
        return _cache[key]
    _cache[key] = {"rows": rows[0]}
    _cache_dirty = True
    return _cache[key]


def mir_sun_vec(body, y, mo, d, h, mi, s=0.0):
    """行星日心赤道直角坐标 (AU) + 速度 (AU/d)，observer=@sun
    列: [X, Y, Z, Dist, Xp, Yp, Zp]（日期列已丢弃）"""
    epoch = f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{int(s):02d}"
    r = mir_raw(body, "planet", epoch, "@sun")
    if "error" in r:
        return r
    row = r["rows"]
    return {"x": (row[0], row[1], row[2]), "v": (row[4], row[5], row[6]),
            "dist_au": row[3], "epoch": epoch}


def mir_sun_vec_km_ecl(body, y, mo, d, h, mi, s=0.0):
    r = mir_sun_vec(body, y, mo, d, h, mi, s)
    if "error" in r:
        return r
    x = tuple(c * AU_KM for c in r["x"])
    return {"km_ecl": eq_to_ecl(x), "epoch": r["epoch"], "dist_au": r["dist_au"]}


def mir_cassini_rel(y, mo, d, h, mi, s=0.0, target="saturn"):
    """target−Cassini 赤道直角坐标 (AU) → 黄道 km；observer=cassini（NAIF SPICE）
    列: [X, Y, Z, D_observer, D_helio, Phase, Elong, ...]"""
    epoch = f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{int(s):02d}"
    r = mir_raw(target, "planet", epoch, "cassini")
    if "error" in r:
        return r
    row = r["rows"]
    rel_au = (row[0], row[1], row[2])
    d_obs_au = row[3]
    return {"rel_km_ecl": eq_to_ecl(tuple(c * AU_KM for c in rel_au)),
            "d_obs_km": d_obs_au * AU_KM, "epoch": epoch}


# ---------------- 烘焙数据 ----------------

def load_baked():
    p = os.path.join(HERE, "..", "data", "cassini_data.js")
    raw = open(p, "r", encoding="utf-8").read()
    return json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))


class Baked:
    def __init__(self, js):
        self.js = js
        sc = js["spacecraft"]["cassini"]
        self.trailT = struct.unpack(f"<{sc['trailN']}d", base64.b64decode(sc["trailT"]))
        self.trail = struct.unpack(f"<{sc['trailN']*3}f", base64.b64decode(sc["trail"]))

    def trail_interp(self, t):
        tt, xyz, n = self.trailT, self.trail, len(self.trailT)
        if t < tt[0] or t > tt[-1]:
            return None
        lo, hi = 0, n - 1
        while hi - lo > 1:
            mid = (lo + hi) >> 1
            if tt[mid] <= t:
                lo = mid
            else:
                hi = mid
        al = (t - tt[lo]) / (tt[hi] - tt[lo])
        return tuple(xyz[lo*3+k] + (xyz[hi*3+k] - xyz[lo*3+k]) * al for k in range(3))

    def body_pos(self, name, t):
        for seg in self.js["bodies"][name]["segs"]:
            if "t0" in seg:
                t0, dt, n = seg["t0"], seg["dt"], seg["n"]
                if not (t0 <= t <= t0 + dt * (n - 1)):
                    continue
                vals = struct.unpack(f"<{n*3}f", base64.b64decode(seg["d"]))
                f = (t - t0) / dt
                i = max(0, min(n - 2, int(math.floor(f))))
                al = min(1.0, max(0.0, f - i))
                return tuple(vals[i*3+k] + (vals[(i+1)*3+k] - vals[i*3+k]) * al for k in range(3))
            tt = struct.unpack(f"<{seg['n']}d", base64.b64decode(seg["t"]))
            if not (tt[0] <= t <= tt[-1]):
                continue
            xx = struct.unpack(f"<{seg['n']*3}f", base64.b64decode(seg["x"]))
            lo, hi = 0, seg["n"] - 1
            while hi - lo > 1:
                mid = (lo + hi) >> 1
                if tt[mid] <= t:
                    lo = mid
                else:
                    hi = mid
            al = (t - tt[lo]) / (tt[hi] - tt[lo])
            return tuple(xx[lo*3+k] + (xx[hi*3+k] - xx[lo*3+k]) * al for k in range(3))
        return None

    def saturn_rel_min(self, lo_et, hi_et):
        """烘焙 trail−saturn 最小 |rel|（ET 秒窗口内，逐 trail 顶点扫描）"""
        best = None
        for i, t in enumerate(self.trailT):
            if not (lo_et <= t <= hi_et):
                continue
            p = (self.trail[i*3], self.trail[i*3+1], self.trail[i*3+2])
            sb = self.body_pos("saturn", t)
            if sb is None:
                continue
            d = math.sqrt(sum((p[k] - sb[k]) ** 2 for k in range(3)))
            if best is None or d < best[0]:
                best = (d, t)
        return best


# ---------------- 比对 ----------------

def diff(a, b):
    return math.sqrt(sum((a[k] - b[k]) ** 2 for k in range(3)))


def main():
    _load_cache()
    js = load_baked()
    bk = Baked(js)
    print("baked meta:", js["meta"])

    # ---------- 1) 行星位置：dynamo vs INPOP13C ----------
    print("\n== 1) 行星位置（日心黄道 km）: dynamo(eyes.nasa.gov) vs INPOP13C(IMCCE) ==")
    print("   raw=直接比对; lt-cor=Miriade 矩形坐标若含光行时, 光行时自洽修正后的比对")
    planet_checks = [
        ("venus",   1998, 4, 26, 13, 45, "Venus-1 飞掠"),
        ("venus",   1999, 6, 24, 20, 30, "Venus-2 飞掠"),
        ("earth",   1997, 10, 15, 9, 8,  "发射"),
        ("earth",   1999, 8, 18, 3, 30,  "Earth 飞掠"),
        ("jupiter", 2000, 12, 30, 10, 5, "Jupiter 飞掠"),
        ("saturn",  2004, 7, 1, 2, 39,   "Saturn SOI"),
        ("saturn",  2005, 1, 14, 10, 0,  "Huygens 着陆日"),
        ("saturn",  2017, 9, 15, 10, 0,  "任务终段"),
    ]
    for body, y, mo, d, h, mi, label in planet_checks:
        t_et = utc_to_et(y, mo, d, h, mi)
        pos = bk.body_pos(body, t_et)
        if pos is None:
            print(f"  {label:14s} {body:7s}: baked 未覆盖该时刻")
            continue
        raw = mir_sun_vec_km_ecl(body, y, mo, d, h, mi)
        if "error" in raw:
            print(f"  {label:14s} {body:7s}: miriade fail: {raw['error'][:80]}")
            continue
        d_raw = diff(pos, raw["km_ecl"])
        print(f"  {label:14s} {body:7s} raw={d_raw:>10,.0f} km"
              f"   (INPOP helio dist {raw['dist_au']:.3f} AU)")

    # ---------- 2) Cassini 日心位置 vs NAIF SPICE ----------
    print("\n== 2) Cassini 日心位置（km）: 烘焙 trail vs NAIF SPICE(-82 via Miriade) ==")
    print("   et-tdb=严格时间换算; et-naive=项目显示层换算（差~128s，用于消歧）")
    cassini_checks = [
        (2001, 4, 1, 0, 0, "cruise-4 早期"),
        (2001, 12, 30, 0, 0, "Jupiter 后"),
        (2002, 6, 1, 0, 0, "巡航"),
        (2003, 1, 1, 0, 0, "巡航"),
        (2003, 6, 1, 0, 0, "巡航"),
        (2003, 12, 1, 0, 0, "土星接近"),
        (2004, 6, 30, 12, 0, "SOI 前"),
        (2004, 7, 1, 2, 39, "SOI"),
        (2004, 7, 2, 0, 0, "SOI 后"),
        (2005, 1, 14, 10, 0, "Huygens"),
        (2005, 9, 1, 0, 0, "环绕"),
        (2006, 1, 1, 0, 0, "环绕"),
        (2006, 7, 1, 0, 0, "环绕"),
        (2006, 10, 15, 0, 0, "核末段"),
    ]
    sums = {"tdb": 0.0, "naive": 0.0, "rel": 0.0, "n": 0}
    worst = {"tdb": (0.0, ""), "naive": (0.0, "")}
    for y, mo, d, h, mi, label in cassini_checks:
        sat = mir_sun_vec_km_ecl("saturn", y, mo, d, h, mi)
        rel = mir_cassini_rel(y, mo, d, h, mi)
        if "error" in sat or "error" in rel:
            print(f"  {label}: miriade fail: {(sat.get('error') or rel.get('error') or '')[:80]}")
            continue
        # Cassini 日心 = 土星日心(Miriade 矩形坐标为几何位置，无需光行时修正) − (土星−Cassini)
        cas = tuple(sat["km_ecl"][k] - rel["rel_km_ecl"][k] for k in range(3))
        t_tdb = utc_to_et(y, mo, d, h, mi)
        t_nv = utc_to_et_naive(y, mo, d, h, mi)
        p_tdb, p_nv = bk.trail_interp(t_tdb), bk.trail_interp(t_nv)
        if p_tdb is None:
            print(f"  {label}: trail 未覆盖")
            continue
        d_tdb, d_nv = diff(p_tdb, cas), diff(p_nv, cas)
        sb = bk.body_pos("saturn", t_tdb)
        # rel = 土星−Cassini（SPICE），烘焙侧 = saturn−trail（同为土星−Cassini）
        d_rel = diff(tuple(sb[k] - p_tdb[k] for k in range(3)), rel["rel_km_ecl"]) if sb else float("nan")
        sums["tdb"] += d_tdb
        sums["naive"] += d_nv
        sums["rel"] += d_rel
        sums["n"] += 1
        if d_tdb > worst["tdb"][0]:
            worst["tdb"] = (d_tdb, label)
        if d_nv > worst["naive"][0]:
            worst["naive"] = (d_nv, label)
        print(f"  {label:10s} {y:04d}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}  "
              f"et-tdb={d_tdb:>10,.0f} km  et-naive={d_nv:>10,.0f} km  "
              f"|Cassini-土星| SPICE={rel['d_obs_km']:>10,.0f} km  相对向量差={d_rel:>8,.1f} km")
    if sums["n"]:
        n = sums["n"]
        print(f"  → 平均: et-tdb={sums['tdb']/n:,.0f} km, et-naive={sums['naive']/n:,.0f} km, "
              f"相对向量={sums['rel']/n:,.1f} km  (n={n})")
        print(f"  → 最差: et-tdb {worst['tdb'][1]} {worst['tdb'][0]:,.0f} km / "
              f"et-naive {worst['naive'][1]} {worst['naive'][0]:,.0f} km")

    # ---------- 3) SOI 近拱（时间约定无关）----------
    print("\n== 3) Saturn SOI 近拱距离 ==")
    lo_et = utc_to_et(2004, 6, 20, 0, 0)
    hi_et = utc_to_et(2004, 7, 10, 0, 0)
    dmin, tmin = bk.saturn_rel_min(lo_et, hi_et)
    print(f"  烘焙 min|trail−saturn| = {dmin:,.0f} km @ naive-UTC {et_utc_label_naive(tmin)}")
    # SPICE 扫描：30 分钟粗扫 + 近极小 ±35 分钟 2 分钟细扫
    lo_t = calendar.timegm((2004, 6, 30, 18, 0, 0, 0, 0, 0))
    hi_t = calendar.timegm((2004, 7, 1, 8, 0, 0, 0, 0, 0))
    best = (1e30, None)
    tt_ = lo_t
    while tt_ <= hi_t:
        g = time.gmtime(tt_)
        r = mir_cassini_rel(g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min)
        if "error" not in r and r["d_obs_km"] < best[0]:
            best = (r["d_obs_km"], tt_)
        tt_ += 1800
    if best[1] is not None:
        tt_ = best[1] - 2100
        while tt_ <= best[1] + 2100:
            g = time.gmtime(tt_)
            r = mir_cassini_rel(g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min)
            if "error" not in r and r["d_obs_km"] < best[0]:
                best = (r["d_obs_km"], tt_)
            tt_ += 120
        g = time.gmtime(best[1])
        print(f"  SPICE 扫描最小 |Saturn−Cassini| = {best[0]:,.0f} km @ UTC "
              f"{g.tm_year:04d}-{g.tm_mon:02d}-{g.tm_mday:02d} {g.tm_hour:02d}:{g.tm_min:02d}")
    _save_cache()
    print("\nDONE")


if __name__ == "__main__":
    main()
