# -*- coding: utf-8 -*-
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_data import parse_def

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data_raw")
ddir = os.path.join(RAW, "mimas_saturn_orb")
with open(os.path.join(ddir, "def.dyn"), "rb") as f:
    d = parse_def(f.read())
have = set(x[:-4] for x in os.listdir(ddir) if x.endswith(".dyn") and x != "def.dyn")
J2000 = 946728000
times = sorted(mn for (name, mn) in d["chunks"] if name in have)
print("chunks downloaded:", len(have), "/", len(d["chunks"]))
if times:
    print("span:", time.strftime("%Y-%m-%d", time.gmtime(times[0] + J2000)), "->",
          time.strftime("%Y-%m-%d", time.gmtime(times[-1] + J2000)))
