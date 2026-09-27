# -*- coding: utf-8 -*-
import json
raw = open("../data/cassini_data.js", "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
print("top keys:", list(js.keys()))
for k, v in js.items():
    if isinstance(v, dict):
        print(k, "->", list(v.keys())[:14])
