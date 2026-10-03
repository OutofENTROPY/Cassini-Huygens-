# -*- coding: utf-8 -*-
"""probe_miriade2.py — 实测 Miriade 能力边界（为 1km 烘焙选数据源）：
  1) Cassini(-82) 覆盖范围：多个历元 observer=cassini 试探
  2) Huygens 能否作为目标（-type=s / planet / 不带 type）
  3) 单请求行数上限（-nbd 大值 + -step）
  4) 卫星目标（titan 等, -type=satellite）
"""
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://vo.imcce.fr/webservices/miriade/ephemcc.php?"


def http_get(url, tries=3, timeout=90):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            last = e
            time.sleep(1.5 * (a + 1))
    return f"FETCH_FAIL: {last}"


def parse(txt):
    if "# Flag: -1" in txt:
        m = re.search(r"#! (.*)", txt)
        return {"error": (m.group(1) if m else txt.strip()[:150])}
    rows = []
    for line in txt.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = s.split()
        if re.match(r"^\d{4}-\d{2}-\d{2}T", parts[0]):
            parts = parts[1:]
        nums = []
        for p in parts:
            try:
                nums.append(float(p))
            except ValueError:
                break
        if len(nums) >= 3:
            rows.append(nums)
    return {"rows": rows}


def q(name, typ, ep, nbd, step, observer, extra=""):
    params = {"-name": name, "-ep": ep, "-nbd": str(nbd), "-step": step,
              "-observer": observer, "-tcoor": "2", "-mime": "text"}
    if typ:
        params["-type"] = typ
    if extra:
        params.update(extra)
    return parse(http_get(API + urllib.parse.urlencode(params)))


def show(tag, r, maxdist_col=3):
    if "error" in r:
        print(f"  {tag}: ERROR {r['error'][:100]}")
    elif not r["rows"]:
        print(f"  {tag}: EMPTY rows")
    else:
        row = r["rows"][0]
        d = row[maxdist_col] if len(row) > maxdist_col else float("nan")
        print(f"  {tag}: OK cols={len(row)} first={row[:3]} d={d}")


print("== 1) Cassini 覆盖试探 (target=saturn, observer=cassini, tcoor=2) ==")
for ep in ["1999-08-20T00:00:00", "2000-12-30T00:00:00", "2001-03-08T00:00:00",
           "2006-10-20T00:00:00", "2007-06-01T00:00:00", "2010-01-01T00:00:00",
           "2013-06-01T00:00:00", "2017-04-22T00:00:00", "2017-09-15T00:00:00"]:
    show(ep[:10], q("saturn", "planet", ep, 1, "1m", "cassini"))
    time.sleep(0.3)

print("\n== 2) Huygens 作为目标 ==")
for name, typ in [("huygens", "s"), ("huygens", "planet"), ("huygens", ""),
                  ("HUYGENS", "s"), ("-150", "s"), ("huygens probe", "s")]:
    params = {"-name": name, "-ep": "2005-01-14T09:00:00", "-nbd": "1", "-step": "1m",
              "-observer": "cassini", "-tcoor": "2", "-mime": "text"}
    if typ:
        params["-type"] = typ
    txt = http_get(API + urllib.parse.urlencode(params))
    r = parse(txt)
    tag = f"name={name!r} type={typ!r}"
    if "error" in r or not r.get("rows"):
        head = [l for l in txt.splitlines() if l.strip()][:6]
        print(f"  {tag}: FAIL  head={head}")
    else:
        show(tag, r)
    time.sleep(0.3)

print("\n== 3) 单请求行数上限（cassini, 2004-12-20 起, 10m 步长） ==")
for nbd in [100, 5000, 50000]:
    t0 = time.time()
    r = q("saturn", "planet", "2004-12-20T00:00:00", nbd, "10m", "cassini")
    dt = time.time() - t0
    if "error" in r:
        print(f"  nbd={nbd}: ERROR ({dt:.1f}s) {r['error'][:100]}")
    else:
        print(f"  nbd={nbd}: rows={len(r['rows'])} ({dt:.1f}s)  first={r['rows'][0][:3]}")
    time.sleep(0.5)

print("\n== 4) 卫星目标（-type=satellite, observer=@699） ==")
for name in ["titan", "enceladus"]:
    show(f"{name}", q(name, "satellite", "2005-01-14T09:00:00", 1, "1m", "@699"))
    time.sleep(0.3)

print("\nDONE")
