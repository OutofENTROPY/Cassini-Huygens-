# -*- coding: utf-8 -*-
"""loadtree.py — 递归解析/按需下载 dynamo 点集树。

def.dyn     = 头(version+type+digits+mu)+flag+（内联点 | 顶层分块表）
<name>.dyn  = flag+（内联点 | 子分块表）   ← 不含头
子分块文件名 = 父名 + '_' + idx.zfill(digits)   （def 层为 idx.zfill(digits)）
v2 分块表: int32 n + n×f64 min，最后一项是结束标记（真实子块 = n-1）
v1 分块表: int32 n + n×(f64 min + f64 max)
flag=1 内联: int32 count + count×orb点
"""
import math
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://eyes.nasa.gov/assets/dynamic/dynamo/"
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data_raw")


class Reader:
    def __init__(self, data):
        self.d = data
        self.o = 0

    def i16(self):
        import struct
        v = struct.unpack_from("<h", self.d, self.o)[0]; self.o += 2; return v

    def i32(self):
        import struct
        v = struct.unpack_from("<i", self.d, self.o)[0]; self.o += 4; return v

    def u8(self):
        v = self.d[self.o]; self.o += 1; return v

    def f64(self):
        import struct
        v = struct.unpack_from("<d", self.d, self.o)[0]; self.o += 8; return v

    def cstr(self):
        b = bytearray()
        while True:
            c = self.u8()
            if c == 0:
                break
            b.append(c)
        return b.decode("ascii")


def parse_points(r):
    n = r.i32()
    pts = []
    for _ in range(n):
        t = r.f64()
        a, e, nn, M = r.f64(), r.f64(), r.f64(), r.f64()
        qx, qy, qz, qw = r.f64(), r.f64(), r.f64(), r.f64()
        pts.append((t, a, e, nn, M, qx, qy, qz, qw))
    return pts


def fetch(url, tries=3):
    import urllib.error
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise  # 明确不存在，不重试
            last = e
            time.sleep(0.5)
        except Exception as e:  # noqa
            last = e
            time.sleep(0.6 * (a + 1))
    raise RuntimeError(f"failed {url}: {last}")


def _fetch_local_or_remote(ddir, fname, path_for_url):
    """优先读本地缓存，否则下载并缓存。返回 bytes 或 None(不存在)。"""
    lp = os.path.join(ddir, fname)
    if os.path.exists(lp):
        with open(lp, "rb") as f:
            return f.read()
    url = BASE + path_for_url + "/" + fname
    try:
        data = fetch(url)
    except Exception:
        return None  # 懒加载分片可能不存在
    os.makedirs(ddir, exist_ok=True)
    with open(lp, "wb") as f:
        f.write(data)
    return data


def _walk(ddir, path_for_url, name, data, digits, version, tmin, tmax, depth, stats, pool_jobs):
    """data: 该层文件的字节（def.dyn 或 <name>.dyn）。返回 points 列表。"""
    r = Reader(data)
    if name == "def":
        r.i16()          # version
        r.cstr()         # type
        if version == 2:
            r.u8()       # digits
            r.f64(); r.f64()  # mu header
    flag = r.u8()
    if flag == 1:
        stats["inline"] += 1
        return parse_points(r)
    # 分块表
    n = r.i32()
    entries = []
    for _ in range(n):
        mn = r.f64()
        if version == 1:
            r.f64()
        entries.append(mn)
    if version == 2:
        entries.pop()  # 末项为结束标记
    if depth >= 6:
        raise RuntimeError("too deep")
    out = []
    pending = []
    for i, mn in enumerate(entries):
        nxt = entries[i + 1] if i + 1 < len(entries) else float("inf")
        if nxt < tmin or mn > tmax:
            continue
        child = name if name == "def" else name + "_"
        child = ("" if name == "def" else name + "_") + str(i).zfill(digits)
        stats["wanted"] += 1
        pending.append((child, mn, nxt))
    results = [None] * len(pending)

    def work(k):
        child, mn, nxt = pending[k]
        cdata = _fetch_local_or_remote(ddir, child + ".dyn", path_for_url)
        return cdata

    # 串行足够快（本地缓存为主），避免嵌套并发复杂度
    for k, (child, mn, nxt) in enumerate(pending):
        cdata = work(k)
        if cdata is None:
            stats["missing"] += 1
            continue
        cr = Reader(cdata)
        cflag = cr.u8()
        if cflag == 1:
            stats["inline"] += 1
            out.extend(parse_points(cr))
        else:
            # 嵌套分块：重新走一遍分块逻辑
            out.extend(_walk_nested(cr, ddir, path_for_url, child, digits, version, tmin, tmax, depth + 1, stats))
    return out


def _walk_nested(cr, ddir, path_for_url, name, digits, version, tmin, tmax, depth, stats):
    n = cr.i32()
    entries = []
    for _ in range(n):
        mn = cr.f64()
        if version == 1:
            cr.f64()
        entries.append(mn)
    if version == 2:
        entries.pop()
    out = []
    for i, mn in enumerate(entries):
        nxt = entries[i + 1] if i + 1 < len(entries) else float("inf")
        if nxt < tmin or mn > tmax:
            continue
        child = name + "_" + str(i).zfill(digits)
        stats["wanted"] += 1
        cdata = _fetch_local_or_remote(ddir, child + ".dyn", path_for_url)
        if cdata is None:
            stats["missing"] += 1
            continue
        cr2 = Reader(cdata)
        f2 = cr2.u8()
        if f2 == 1:
            stats["inline"] += 1
            out.extend(parse_points(cr2))
        else:
            out.extend(_walk_nested(cr2, ddir, path_for_url, child, digits, version, tmin, tmax, depth + 1, stats))
    return out


def load_entity(path, tmin, tmax, tmax_is_large=True):
    """加载一个实体（如 moon/earth/orb）在 [tmin,tmax] 窗口内的全部点。"""
    ddir = os.path.join(RAW, path.replace("/", "_"))
    defb = _fetch_local_or_remote(ddir, "def.dyn", path)
    if defb is None:
        raise RuntimeError("no def for " + path)
    r0 = Reader(defb)
    version = r0.i16()
    r0.cstr()
    digits = 0
    if version == 2:
        digits = r0.u8()
        r0.f64(); r0.f64()  # mu
    flag = r0.u8()
    stats = {"inline": 0, "wanted": 0, "missing": 0}
    if flag == 1:
        pts = parse_points(r0)
    else:
        # 回退指针：交给 _walk 从头解析（它知道如何跳过 def 头）
        pts = _walk(ddir, path, "def", defb, digits, version, tmin, tmax, 0, stats, None)
    pts.sort(key=lambda p: p[0])
    return pts, stats
