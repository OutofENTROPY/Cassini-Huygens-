"""Validate the Huygens Lambert-arc math against real baked ephemeris data
(mirrors js/huygens.js algorithms exactly).

Checks:
  1. Lambert convergence & arc endpoint = Titan entry point at ENTRY_ET
  2. Arrival velocity relative to Titan ~ 6 km/s (mission value)
  3. Periapsis radius of transfer stays outside Saturn's rings (~> 250,000 km)
  4. Entry altitude = R_TITAN + 1270 km
"""
import base64
import json
import math
import struct

DATA = r"D:\Programming\HTML\Cassini\data\cassini_data.js"

J2000_MS = 946728000000
GM_SATURN = 3.7931187e7
R_TITAN = 2574.7
ENTRY_ALT = 1270.0
SEP_ET = (1721875200000 - J2000_MS) / 1000 if False else None


def et(utc):
    import calendar
    # Date.parse compatible
    import datetime
    dt = datetime.datetime.strptime(utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    return dt.timestamp() * 1000 / 1000 - J2000_MS / 1000


def b64f(b, dtype):
    raw = base64.b64decode(b)
    n = len(raw) // struct.calcsize(dtype)
    return list(struct.unpack("<" + dtype[0] * n if False else "<" + {"f": "f", "d": "d"}[dtype[0]] * n, raw))


def ecl_to_three(v):
    return [v[0], v[2], -v[1]]


class Track:
    def __init__(self, segs):
        self.segs = sorted(
            [{"t0": s["t0"], "dt": s["dt"], "n": s["n"], "xyz": b64f(s["d"], "f")} for s in segs],
            key=lambda s: -s["dt"])

    def at(self, t):
        seg = None
        for s in self.segs:
            end = s["t0"] + s["dt"] * (s["n"] - 1)
            if s["t0"] <= t <= end:
                seg = s
                break
        if seg is None:
            seg = min(self.segs, key=lambda s: max(s["t0"] - t, t - (s["t0"] + s["dt"] * (s["n"] - 1)), 0))
        f = (t - seg["t0"]) / seg["dt"]
        f = max(0.0, min(f, seg["n"] - 1))
        i = min(seg["n"] - 2, int(f))
        a = f - i
        o, o2 = i * 3, (i + 1) * 3
        return [seg["xyz"][o] + (seg["xyz"][o2] - seg["xyz"][o]) * a,
                seg["xyz"][o + 1] + (seg["xyz"][o2 + 1] - seg["xyz"][o + 1]) * a,
                seg["xyz"][o + 2] + (seg["xyz"][o2 + 2] - seg["xyz"][o + 2]) * a]


# ---- vectors ----
def sub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def add(a, b): return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
def mul(a, k): return [a[0] * k, a[1] * k, a[2] * k]
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def nrm(a):
    l = math.sqrt(dot(a, a)) or 1
    return [a[0] / l, a[1] / l, a[2] / l]


def stumpff(z):
    if z > 1e-6:
        s = math.sqrt(z)
        return (1 - math.cos(s)) / z, (s - math.sin(s)) / s ** 3
    if z < -1e-6:
        s = math.sqrt(-z)
        return (math.cosh(s) - 1) / (-z), (math.sinh(s) - s) / s ** 3
    return 0.5 - z / 24 + z * z / 720, 1 / 6 - z / 120 + z * z / 5040


def lambert(r1v, r2v, dt, mu, A):
    r1, r2 = nrm(r1v) and math.sqrt(dot(r1v, r1v)), math.sqrt(dot(r2v, r2v))

    def yOf(z):
        C, S = stumpff(z)
        return r1 + r2 + A * (z * S - 1) / math.sqrt(C)

    def F(z):
        C, S = stumpff(z)
        y = max(yOf(z), 1e-9)
        return (y / C) ** 1.5 * S + A * math.sqrt(y) - math.sqrt(mu) * dt

    zLo, zHi = -4 * math.pi ** 2, 0.0
    for _ in range(64):
        if F(zHi) < 0:
            zHi += math.pi ** 2
        else:
            break
    for _ in range(64):
        if F(zLo) > 0:
            zLo -= math.pi ** 2
        else:
            break
    for _ in range(160):
        zm = 0.5 * (zLo + zHi)
        if F(zm) > 0:
            zHi = zm
        else:
            zLo = zm
    y = max(yOf(0.5 * (zLo + zHi)), 1e-9)
    f = 1 - y / r1
    g = A * math.sqrt(y / mu)
    gd = 1 - y / r2
    v1 = mul(sub(r2v, mul(r1v, f)), 1 / g)
    v2 = mul(sub(mul(r2v, gd), r1v), 1 / g)
    return v1, v2


def prop_kepler(r0v, v0v, dt, mu):
    r0 = math.sqrt(dot(r0v, r0v))
    v0 = math.sqrt(dot(v0v, v0v))
    rdotv = dot(r0v, v0v)
    alpha = 2 / r0 - v0 * v0 / mu
    sqmu = math.sqrt(mu)
    chi = sqmu * abs(alpha) * dt
    for _ in range(60):
        z = alpha * chi * chi
        C, S = stumpff(z)
        F = (rdotv / sqmu) * chi * chi * C + (1 - alpha * r0) * chi ** 3 * S + r0 * chi - sqmu * dt
        dF = (rdotv / sqmu) * chi * (1 - z * S) + (1 - alpha * r0) * chi * chi * C + r0
        d = F / dF
        chi -= d
        if abs(d) < 1e-8:
            break
    z = alpha * chi * chi
    C, S = stumpff(z)
    f = 1 - chi * chi / r0 * C
    g = dt - chi ** 3 / sqmu * S
    return add(mul(r0v, f), mul(v0v, g))


def transfer_A(r1v, r2v, hhat):
    r1, r2 = math.sqrt(dot(r1v, r1v)), math.sqrt(dot(r2v, r2v))
    cosd = max(-1, min(1, dot(r1v, r2v) / (r1 * r2)))
    dnu = math.acos(cosd)
    if dot(cross(r1v, r2v), hhat) < 0:
        dnu = 2 * math.pi - dnu
    return math.sin(dnu) * math.sqrt(r1 * r2 / (1 - cosd)), dnu


def main():
    js = open(DATA, encoding="utf-8").read()
    js = js[js.index("{"):]
    data = json.loads(js[: js.rindex("}") + 1])
    sc = data["spacecraft"]["cassini"]

    # Cassini trail (three-frame heliocentric)
    tT = b64f(sc["trailT"], "d")
    xyz = b64f(sc["trail"], "f")
    n = sc["trailN"]

    def cassini_at(t):
        lo, hi = 0, n - 1
        while hi - lo > 1:
            mid = (lo + hi) >> 1
            if tT[mid] <= t:
                lo = mid
            else:
                hi = mid
        a = (t - tT[lo]) / ((tT[hi] - tT[lo]) or 1)
        o, o2 = lo * 3, hi * 3
        return [xyz[o] + (xyz[o2] - xyz[o]) * a,
                xyz[o + 1] + (xyz[o2 + 1] - xyz[o + 1]) * a,
                xyz[o + 2] + (xyz[o2 + 2] - xyz[o + 2]) * a]

    saturn = Track(data["bodies"]["saturn"]["segs"])
    titan = Track(data["bodies"]["titan"]["segs"])

    SEP = et("2004-12-25T02:00:00Z")
    ENTRY = et("2005-01-14T09:06:00Z")
    print(f"SEP_ET={SEP:.0f}s ENTRY_ET={ENTRY:.0f}s coast={(ENTRY-SEP)/86400:.2f} d")

    dvs = 180
    # 统一 three 轴系：cassini trail 为黄道系，先转 three（与 js/huygens.js 一致）
    r1 = sub(ecl_to_three(cassini_at(SEP)), ecl_to_three(saturn.at(SEP)))
    v1 = mul(sub(sub(ecl_to_three(cassini_at(SEP + dvs)), ecl_to_three(saturn.at(SEP + dvs))),
                 sub(ecl_to_three(cassini_at(SEP - dvs)), ecl_to_three(saturn.at(SEP - dvs)))), 1 / (2 * dvs))
    print(f"P0 rel Saturn: |r|={math.sqrt(dot(r1,r1)):,.0f} km |v|={math.sqrt(dot(v1,v1)):.3f} km/s")

    hhat = nrm(cross(r1, v1))

    def tit3(t):
        return ecl_to_three(titan.at(t))

    uhat = None
    for it in range(4):
        off = (R_TITAN + ENTRY_ALT) if uhat else 0
        p1 = sub(tit3(ENTRY), mul(uhat or [0, 0, 0], off))
        A, dnu = transfer_A(r1, p1, hhat)
        vv1, vv2 = lambert(r1, p1, ENTRY - SEP, GM_SATURN, A)
        vtit = mul(sub(tit3(ENTRY + 60), tit3(ENTRY - 60)), 1 / 120)
        uhat = nrm(sub(vv2, vtit))
        print(f"  it{it}: dnu={math.degrees(dnu):7.2f}° A={A:,.3e} |v2|={math.sqrt(dot(vv2,vv2)):.3f} |vrelTitan|={math.sqrt(dot(sub(vv2,vtit),sub(vv2,vtit))):.3f} km/s")

    entry_rel = sub(tit3(ENTRY), mul(uhat, R_TITAN + ENTRY_ALT))
    A, dnu = transfer_A(r1, entry_rel, hhat)
    v1c, v2c = lambert(r1, entry_rel, ENTRY - SEP, GM_SATURN, A)
    vtit = mul(sub(tit3(ENTRY + 60), tit3(ENTRY - 60)), 1 / 120)
    vrel = sub(v2c, vtit)
    print(f"final: Δν={math.degrees(dnu):.2f}°  entry |v_rel|={math.sqrt(dot(vrel,vrel)):.3f} km/s (任务值 ~5.96)")
    print(f"entry point |r_Titan|={math.sqrt(dot(sub(entry_rel, tit3(ENTRY)), sub(entry_rel, tit3(ENTRY)))):,.1f} km (期望 {R_TITAN+ENTRY_ALT:,.1f})")

    # 采样巡航段：检查近土点
    rmin = 1e18
    N = 3000
    dtc = (ENTRY - SEP) / (N - 1)
    for i in range(N):
        p = prop_kepler(r1, v1c, i * dtc, GM_SATURN)
        rmin = min(rmin, math.sqrt(dot(p, p)))
    print(f"transfer periapsis radius: {rmin:,.0f} km (应远离土星本体/主环, > ~2.5e5)")

    # 终点对齐校验：propKepler 到 ENTRY 的位置 vs entry_rel
    p_end = prop_kepler(r1, v1c, ENTRY - SEP, GM_SATURN)
    err = math.sqrt(dot(sub(p_end, entry_rel), sub(p_end, entry_rel)))
    print(f"Lambert endpoint error: {err:,.3f} km")

    # 检查轨道根数（单位）
    a_t = 1 / (2 / math.sqrt(dot(entry_rel, entry_rel)) - dot(v2c, v2c) / GM_SATURN)
    print(f"transfer semi-major axis: {a_t:,.0f} km, period {2*math.pi*math.sqrt(a_t**3/GM_SATURN)/86400:.2f} d")


if __name__ == "__main__":
    main()
