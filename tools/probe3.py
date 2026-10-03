# -*- coding: utf-8 -*-
"""probe3.py — Miriade 关键能力快测（Huygens 目标 / 卫星 type / nbd 行数），
无缓冲输出 + 25s 超时，避免整体卡死。"""
import sys
import time
import urllib.parse
import urllib.request

API = "https://vo.imcce.fr/webservices/miriade/ephemcc.php?"
TIMEOUT = 25


def get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.read().decode("utf-8", "replace")
    except Exception as e:
        return f"FETCH_FAIL: {e}"


def test(tag, params):
    url = API + urllib.parse.urlencode(params)
    t0 = time.time()
    txt = get(url)
    dt = time.time() - t0
    lines = [l for l in txt.splitlines() if l.strip()]
    flag = next((l for l in lines if l.startswith("# Flag")), "")
    nrow = sum(1 for l in lines if l and l[0].isdigit())
    head = " | ".join(l[:60] for l in lines[2:5])
    print(f"{tag}  [{dt:.1f}s]  {flag}  rows~{nrow}", flush=True)
    if nrow == 0:
        print(f"    head: {head[:200]}", flush=True)
    time.sleep(0.4)


P = {"-tcoor": "2", "-mime": "text"}
print("== Huygens 目标 ==")
for name, typ in [("huygens", "s"), ("huygens", "planet"), ("huygens", ""),
                  ("-150", "s")]:
    p = dict(P, **{"-name": name, "-ep": "2005-01-14 09:00:00", "-nbd": "1",
                   "-step": "1m", "-observer": "cassini"})
    if typ:
        p["-type"] = typ
    test(f"huygens type={typ!r}", p)

print("== 卫星 type（titan @699）==")
for typ in ["satellite", "planet"]:
    p = dict(P, **{"-name": "titan", "-type": typ, "-ep": "2005-01-14 09:00:00",
                   "-nbd": "1", "-step": "1m", "-observer": "@699"})
    test(f"titan type={typ!r} obs=@699", p)

print("== nbd 行数（cassini 2004-12-20 起 10m 步）==")
for nbd in [100, 2000, 10000]:
    p = dict(P, **{"-name": "saturn", "-type": "planet", "-ep": "2004-12-20 00:00:00",
                   "-nbd": str(nbd), "-step": "10m", "-observer": "cassini"})
    test(f"nbd={nbd}", p)

print("DONE", flush=True)
