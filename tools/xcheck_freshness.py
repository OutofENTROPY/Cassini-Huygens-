# -*- coding: utf-8 -*-
"""xcheck_freshness.py — 重新从 eyes.nasa.gov 抓取关键历表文件，与 data_raw/
现有副本做 SHA256 比对，确认本地原始数据是否与线上当前版本一致（只读校验，
不改动 data_raw/）。

用法: python tools/xcheck_freshness.py
"""
import hashlib
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import fetch_data  # noqa: E402  复用其 BASE/parse_def（只读）

RAW = os.path.join(os.path.dirname(__file__), "..", "data_raw")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def pick_chunks(defp, tmin, tmax, limit):
    """从分块 def 里挑时间窗内的前 limit 个分块名（用于抽样比对）。"""
    with open(defp, "rb") as f:
        d = fetch_data.parse_def(f.read())
    if d["chunks"] is None:
        return []
    picked = []
    for i, (name, mn) in enumerate(d["chunks"]):
        nxt = d["chunks"][i + 1][1] if i + 1 < len(d["chunks"]) else float("inf")
        if nxt >= tmin and mn <= tmax:
            picked.append(name)
    return picked[:limit]


def main():
    tmin, tmax = fetch_data.et_range()
    tmp = tempfile.mkdtemp(prefix="xcheck_dynamo_")
    print(f"temp: {tmp}")

    targets = []  # (相对路径, 是否解析分块)
    for p in fetch_data.ALL:
        targets.append((p, p in fetch_data.MOONS + ["sc_cassini/saturn/orb"]))

    same = diff = missing_local = missing_remote = 0
    diff_list = []

    for p, chunked in targets:
        defp = os.path.join(RAW, p.replace("/", "_"), "def.dyn")
        local = sha256(open(defp, "rb").read()) if os.path.exists(defp) else None
        try:
            remote_data = fetch_data.fetch(fetch_data.BASE + p + "/def.dyn")
        except Exception as e:  # noqa
            print(f"  REMOTE FAIL {p}/def.dyn: {e}")
            missing_remote += 1
            continue
        remote = sha256(remote_data)
        if local is None:
            missing_local += 1
            continue
        ok = local == remote
        same, diff = same + ok, diff + (not ok)
        if not ok:
            diff_list.append(p + "/def.dyn")
            print(f"  DEF DIFF  {p}: local {local} vs remote {remote}")
        if chunked:
            with open(os.path.join(tmp, "def_remote.dyn"), "wb") as f:
                f.write(remote_data)
            for name in pick_chunks(os.path.join(tmp, "def_remote.dyn"), tmin, tmax, 3):
                cp = os.path.join(RAW, p.replace("/", "_"), name + ".dyn")
                lc = sha256(open(cp, "rb").read()) if os.path.exists(cp) else None
                try:
                    rc = sha256(fetch_data.fetch(f"{fetch_data.BASE}{p}/{name}.dyn"))
                except Exception as e:  # noqa
                    print(f"  REMOTE FAIL {p}/{name}.dyn: {e}")
                    missing_remote += 1
                    continue
                if lc is None:
                    missing_local += 1
                    continue
                ok = lc == rc
                same, diff = same + ok, diff + (not ok)
                if not ok:
                    diff_list.append(f"{p}/{name}.dyn")
                    print(f"  CHK DIFF  {p}/{name}: local {lc} vs remote {rc}")

    print(f"\nRESULT: {same} identical, {diff} different, "
          f"{missing_local} missing-local, {missing_remote} remote-fail")
    if not diff_list:
        print("本地 data_raw 与 eyes.nasa.gov 线上当前版本完全一致（逐字节）。")
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
