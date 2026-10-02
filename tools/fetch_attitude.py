# -*- coding: utf-8 -*-
"""fetch_attitude.py — 从 NASA Eyes 下载卡西尼真实姿态四元数数据集
(dynamo/sc_cassini/quat，源自 NAIF SPICE CK 的烘焙产物)。

dynamo v2 格式（递归，little-endian；由 eyes pioneer 框架逆向确认）:
  def.dyn:  int16 version(2) | cstring type("quat") | uint8 digits
            | uint8 flag (1=内联点集, 0=分块)
            | flag=0: int32 n + n×f64 chunk_min（最后一项是结束标记，真实分块 = n-1 个）
            | flag=1: int32 n + n×点
  分块文件 <name>.dyn（无头）: uint8 flag
            | flag=0: int32 n + n×f64 subchunk_min（同上，子分块名 = <name>_<i.zfill(digits)>）
            | flag=1: int32 n + n×点
  quat 点: f64 time(ET秒, J2000) | f64 qx | f64 qy | f64 qz | f64 qw   (单位四元数)

下载结果存 data_raw/sc_cassini_quat/，合并为 points.pkl（按 ET 时间排序）。
"""
import os
import pickle
import struct
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://eyes.nasa.gov/assets/dynamic/dynamo/sc_cassini/quat"
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data_raw", "sc_cassini_quat")


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


def parse_points(r):
    n = r.i32()
    pts = []
    for _ in range(n):
        t = r.f64()
        q = (r.f64(), r.f64(), r.f64(), r.f64())
        pts.append((t,) + q)
    return pts


def parse_def(data):
    """def.dyn（带头）→ ('chunks', [(name,min)...]) | ('inline', points)"""
    r = Reader(data)
    version = r.i16()
    if version != 2:
        raise ValueError("expect v2, got %d" % version)
    typ = r.cstr()
    if typ != "quat":
        raise ValueError("expect quat, got %s" % typ)
    digits = r.u8()
    flag = r.u8()
    if flag == 1:
        return digits, "inline", parse_points(r)
    n = r.i32()
    chunks = [(str(i).zfill(digits), r.f64()) for i in range(n)]
    return digits, "chunks", chunks


def parse_chunk(data):
    """分块文件（无头）→ ('chunks', [(idx,min)...]) | ('inline', points)"""
    r = Reader(data)
    flag = r.u8()
    if flag == 1:
        return "inline", parse_points(r)
    n = r.i32()
    return "chunks", [(i, r.f64()) for i in range(n)]


def fetch(url, tries=5):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except Exception as e:  # noqa
            last = e
            time.sleep(1.0 * (a + 1))
    raise RuntimeError(f"failed {url}: {last}")


def get(name):
    path = os.path.join(RAW, name + ".dyn")
    if os.path.exists(path) and os.path.getsize(path) > 6:
        with open(path, "rb") as f:
            return f.read()
    data = fetch(f"{BASE}/{name}.dyn")
    with open(path, "wb") as f:
        f.write(data)
    return data


def walk_chunk(name, digits):
    """下载一个分块并递归展开。返回点列表。"""
    kind, payload = parse_chunk(get(name))
    if kind == "inline":
        return payload
    subs = payload[:-1]                       # 最后一项是结束标记
    results = [None] * len(subs)
    t0 = time.time()

    def work(i):
        sub = f"{name}_{str(subs[i][0]).zfill(digits)}"
        return i, walk_chunk(sub, digits)

    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(work, i) for i in range(len(subs))]
        for fu in as_completed(futs):
            i, pts = fu.result()
            results[i] = pts
            if len(results) >= 100 and (i + 1) % 100 == 0:
                print(f"    {name}: ~{i+1}/{len(subs)} ({time.time()-t0:.0f}s)")
    out = []
    for pts in results:
        if pts:
            out.extend(pts)
    return out


def main():
    os.makedirs(RAW, exist_ok=True)
    digits, kind, payload = parse_def(get("def"))
    print(f"digits={digits} def: {kind}")
    if kind == "inline":
        all_pts = payload
    else:
        chunks = payload[:-1]                 # 最后一项是结束标记
        print(f"top-level chunks: {len(chunks)}")
        all_pts = []
        for i, (name, mn) in enumerate(chunks):
            pts = walk_chunk(name, digits)
            all_pts.extend(pts)
            t0, t1 = (pts[0][0], pts[-1][0]) if pts else (0, 0)
            print(f"  [{i+1}/{len(chunks)}] {name}: {len(pts)} pts  "
                  f"ET {t0:.0f}..{t1:.0f}")
    all_pts.sort(key=lambda p: p[0])
    print(f"total {len(all_pts)} attitude samples")
    with open(os.path.join(RAW, "points.pkl"), "wb") as f:
        pickle.dump(all_pts, f, protocol=4)
    print("saved points.pkl")


if __name__ == "__main__":
    main()
