# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_data import parse_def

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data_raw")
for name in ["enceladus_saturn_orb", "titan_saturn_orb", "mimas_saturn_orb", "moon_earth_orb", "sc_cassini_saturn_orb"]:
    ddir = os.path.join(RAW, name)
    with open(os.path.join(ddir, "def.dyn"), "rb") as f:
        d = parse_def(f.read())
    files = sorted(x for x in os.listdir(ddir) if x.endswith(".dyn") and x != "def.dyn")
    with open(os.path.join(ddir, files[0]), "rb") as f:
        head = list(f.read(8))
    print(name, "ver=", d["version"], "nchunks=", len(d["chunks"]) if d["chunks"] else 0, "chunk0bytes=", head)
