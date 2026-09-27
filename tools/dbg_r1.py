import base64
import json
import math
import struct

DATA = r"D:\Programming\HTML\Cassini\data\cassini_data.js"
js = open(DATA, encoding="utf-8").read()
js = js[js.index("{"):]
data = json.loads(js[: js.rindex("}") + 1])

J2000_MS = 946728000000
def et(utc):
    import datetime
    dt = datetime.datetime.strptime(utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    return dt.timestamp() - J2000_MS / 1000

def b64f(b, t):
    raw = base64.b64decode(b)
    c = {"f": "f", "d": "d"}[t]
    n = len(raw) // struct.calcsize(c)
    return list(struct.unpack("<" + c * n, raw))

def ecl3(v): return [v[0], v[2], -v[1]]

SEP = et("2004-12-25T02:00:00Z")
print("SEP_ET =", SEP)

sc = data["spacecraft"]["cassini"]
tT = b64f(sc["trailT"], "d")
xyz = b64f(sc["trail"], "f")
n = sc["trailN"]
print("trailN:", n, "trailT range:", tT[0], "->", tT[-1], "SEP in range:", tT[0] <= SEP <= tT[-1])
# trail spacing near SEP
import bisect
i = bisect.bisect_left(tT, SEP)
print("trail idx at SEP:", i, "dt neighbors:", tT[i] - tT[i-1], tT[i+1] - tT[i])
c = [xyz[i*3], xyz[i*3+1], xyz[i*3+2]]
print("cassini trail @SEP (ecl):", [f"{v:,.0f}" for v in c], "|r| = {:,}".format(math.sqrt(c[0]**2+c[1]**2+c[2]**2)))

sat = data["bodies"]["saturn"]["segs"][0]
sxyz = b64f(sat["d"], "f")
si = int((SEP - sat["t0"]) / sat["dt"])
a = (SEP - sat["t0"]) / sat["dt"] - si
o, o2 = si*3, (si+1)*3
s = [sxyz[o]+(sxyz[o2]-sxyz[o])*a, sxyz[o+1]+(sxyz[o2+1]-sxyz[o+1])*a, sxyz[o+2]+(sxyz[o2+2]-sxyz[o+2])*a]
print("saturn @SEP (ecl):", [f"{v:,.0f}" for v in s], "|r| = {:,}".format(math.sqrt(s[0]**2+s[1]**2+s[2]**2)))
rel = [c[0]-s[0], c[1]-s[1], c[2]-s[2]]
print("cassini-saturn @SEP |r| = {:,}".format(math.sqrt(rel[0]**2+rel[1]**2+rel[2]**2)))

# 也检查 trail 段在 SEP 附近是否为土星中心数据
print()
print("trail 与 (saturn+1.22e6) 的差 vs trail 原值：")
print("trail - saturn =", [f"{v:,.0f}" for v in rel])
