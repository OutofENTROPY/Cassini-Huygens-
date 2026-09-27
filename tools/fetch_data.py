# -*- coding: utf-8 -*-
"""fetch_data.py — 从 NASA Eyes (eyes.nasa.gov) 下载卡西尼任务与太阳系天体的
dynamo 历表文件（def.dyn + 分块 .dyn），存入 data_raw/ 供烘焙脚本使用。

数据格式（由 NASA Eyes pioneer 框架逆向确认，little-endian）:
  def.dyn:  int16 version(1|2) | cstring type("orb") | [v2: uint8 digits]
            | orb头: f64 mu1, f64 mu2
            | v2: uint8 flag (1=内联点集, 0=分块) ; v1 def 同样有 flag 字节
            | 内联: int32 count + count×点
            | 分块: int32 n + n×(f64 chunk_min [, v1 还有 f64 chunk_max])，
              v2 时最后一项只是结束标记（真实分块 = n-1 个）
  chunk .dyn: uint8 flag(=1) | int32 count | count×点
  orb 点: f64 time(ET秒, J2000) | f64 a | f64 e | f64 n | f64 M | f64 qx,qy,qz,qw
"""
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://eyes.nasa.gov/assets/dynamic/dynamo/"
RAW = os.path.join(os.path.dirname(__file__), "..", "data_raw")

PLANETS = [
    "mercury/sun/orb", "venus/sun/orb", "earth/sun/orb", "mars/sun/orb",
    "jupiter/sun/orb", "saturn/sun/orb", "uranus/sun/orb", "neptune/sun/orb",
]
MOONS = ["moon/earth/orb"] + [m + "/saturn/orb" for m in
         ["titan", "enceladus", "iapetus", "rhea", "dione", "tethys", "mimas"]]
CASSINI_LEGS = [
    "sc_cassini/earth/launch/orb", "sc_cassini/sun/1/orb",
    "sc_cassini/venus/flyby1/orb", "sc_cassini/sun/2/orb",
    "sc_cassini/venus/flyby2/orb", "sc_cassini/sun/3/orb",
    "sc_cassini/earth/flyby/orb", "sc_cassini/sun/4/orb",
    "sc_cassini/saturn/orb",
]
# Huygens 独立腿（真实分离后轨迹：土星中心巡航 + Titan 中心进入双曲线）
HUYGENS_LEGS = ["sc_huygens/saturn/orb", "sc_huygens/titan/orb"]
ALL = PLANETS + MOONS + CASSINI_LEGS + HUYGENS_LEGS

# 只需要这个时间窗内的分块（ET 秒，相对 J2000）
J2000_S = 946728000  # 2000-01-01T12:00Z 的 Unix 秒


def et_range():
    import calendar
    def et(y, m, d):
        unix = calendar.timegm((y, m, d, 0, 0, 0))
        return unix - J2000_S
    return et(1996, 1, 1), et(2018, 6, 1)


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.o = 0

    def i16(self):
        v = struct.unpack_from("<h", self.d, self.o)[0]; self.o += 2; return v

    def i32(self):
        v = struct.unpack_from("<i", self.d, self.o)[0]; self.o += 4; return v

    def u8(self):
        v = self.d[self.o]; self.o += 1; return v

    def f64(self):
        v = struct.unpack_from("<d", self.d, self.o)[0]; self.o += 8; return v

    def cstr(self):
        b = bytearray()
        while True:
            c = self.u8()
            if c == 0:
                break
            b.append(c)
        return b.decode("ascii")


def parse_points(r: Reader):
    n = r.i32()
    pts = []
    for _ in range(n):
        t = r.f64()
        a, e, nn, M = r.f64(), r.f64(), r.f64(), r.f64()
        qx, qy, qz, qw = r.f64(), r.f64(), r.f64(), r.f64()
        pts.append((t, a, e, nn, M, qx, qy, qz, qw))
    return pts


def parse_def(data: bytes):
    r = Reader(data)
    version = r.i16()
    typ = r.cstr()
    digits = 0
    if version == 2:
        digits = r.u8()
    mu1 = r.f64() if typ == "orb" else 0.0
    mu2 = r.f64() if typ == "orb" else 0.0
    flag = r.u8()  # v2 一律有; v1 仅 def 有（def 才调用 load 的 def 分支）
    if flag == 1:
        return {"version": version, "type": typ, "mu1": mu1, "mu2": mu2,
                "points": parse_points(r), "chunks": None}
    n = r.i32()
    chunks = []
    if version == 2:
        for _ in range(n):
            name = str(len(chunks)).zfill(digits)
            mn = r.f64()
            chunks.append((name, mn))
        chunks.pop()  # v2 最后一项是结束标记
    else:
        digits = max(1, -(-len(str(n)) // 1)) if False else len(str(n - 1)) if n > 1 else 1
        # pioneer: Math.ceil(Math.log10(n))
        import math
        digits = math.ceil(math.log10(n)) if n > 1 else 1
        for _ in range(n):
            name = str(len(chunks)).zfill(digits)
            mn = r.f64()
            r.f64()  # v1 max
            chunks.append((name, mn))
    return {"version": version, "type": typ, "mu1": mu1, "mu2": mu2,
            "points": None, "chunks": chunks}


def parse_chunk(data: bytes):
    r = Reader(data)
    flag = r.u8()
    if flag != 1:
        raise ValueError("chunk flag != 1")
    return parse_points(r)


def fetch(url, tries=4):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except Exception as e:  # noqa
            last = e
            time.sleep(0.8 * (a + 1))
    raise RuntimeError(f"failed {url}: {last}")


def download_all(tmin, tmax):
    os.makedirs(RAW, exist_ok=True)
    jobs = []  # (url, savepath)

    for p in ALL:
        ddir = os.path.join(RAW, p.replace("/", "_"))
        os.makedirs(ddir, exist_ok=True)
        defp = os.path.join(ddir, "def.dyn")
        if not os.path.exists(defp):
            jobs.append((BASE + p + "/def.dyn", defp))

    # 先并行下 def
    run_jobs(jobs)
    jobs = []

    for p in MOONS + ["sc_cassini/saturn/orb"]:
        ddir = os.path.join(RAW, p.replace("/", "_"))
        defp = os.path.join(ddir, "def.dyn")
        with open(defp, "rb") as f:
            d = parse_def(f.read())
        if d["chunks"] is None:
            print("  (inline)", p, len(d["points"]), "pts")
            continue
        # 选时间窗内的分块
        picked = []
        for i, (name, mn) in enumerate(d["chunks"]):
            nxt = d["chunks"][i + 1][1] if i + 1 < len(d["chunks"]) else float("inf")
            if nxt >= tmin and mn <= tmax:
                picked.append(name)
        for name in picked:
            cp = os.path.join(ddir, name + ".dyn")
            if not os.path.exists(cp):
                jobs.append((BASE + p + "/" + name + ".dyn", cp))
        print(f"  {p}: {len(picked)}/{len(d['chunks'])} chunks in window")
    run_jobs(jobs)


def run_jobs(jobs):
    if not jobs:
        return
    print(f"  downloading {len(jobs)} files ...")
    t0 = time.time()
    done = 0

    def work(job):
        url, path = job
        data = fetch(url)
        with open(path, "wb") as f:
            f.write(data)
        return path

    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(work, j): j for j in jobs}
        for fu in as_completed(futs):
            fu.result()
            done += 1
            if done % 50 == 0:
                print(f"    {done}/{len(jobs)} ({time.time()-t0:.0f}s)")
    print(f"  done {len(jobs)} files in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    tmin, tmax = et_range()
    print(f"time window ET: {tmin:.0f} .. {tmax:.0f}")
    download_all(tmin, tmax)
    print("ALL FILES READY")
