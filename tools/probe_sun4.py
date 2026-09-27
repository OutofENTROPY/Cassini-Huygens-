# -*- coding: utf-8 -*-
import os, struct, time
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data_raw", "sc_cassini_sun_4_orb", "def.dyn")
sz = os.path.getsize(p)
data = open(p, "rb").read()
ver = struct.unpack_from("<h", data, 0)[0]
o = 2
b = bytearray()
while data[o]:
    b.append(data[o]); o += 1
o += 1
digits = data[o]; o += 1
mu1, mu2 = struct.unpack_from("<dd", data, o); o += 16
flag = data[o]; o += 1
cnt = struct.unpack_from("<i", data, o)[0]; o += 4
print("size:", sz, "ver:", ver, "type:", b.decode(), "digits:", digits)
print("mu1:", mu1, "mu2:", mu2, "flag:", flag, "count:", cnt)
print("expected size if inline:", o + cnt * 72)
J = 946728000
for i in range(min(cnt, 20)):
    t = struct.unpack_from("<d", data, o + i * 72)[0]
    a, e, n, M = struct.unpack_from("<dddd", data, o + i * 72 + 8)
    print(f"  epoch {time.strftime('%Y-%m-%d', time.gmtime(t+J))}  a={a:,.0f} e={e:.4f}")
