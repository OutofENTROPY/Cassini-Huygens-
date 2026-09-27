import base64
import json
import math
import struct

DATA = r"D:\Programming\HTML\Cassini\data\cassini_data.js"
js = open(DATA, encoding="utf-8").read()
js = js[js.index("{"):]
data = json.loads(js[: js.rindex("}") + 1])

print("meta:", {k: v for k, v in data["meta"].items()})
print("top keys:", list(data.keys()))
print("spacecraft keys:", list(data["spacecraft"].keys()))
print("cassini keys:", list(data["spacecraft"]["cassini"].keys()))
for k, v in data["spacecraft"]["cassini"].items():
    if isinstance(v, list):
        print("  cassini." + k, "list len", len(v), "item0 keys:", list(v[0].keys()) if v and isinstance(v[0], dict) else type(v[0]))
    else:
        print("  cassini." + k, type(v))
print("bodies keys:", list(data["bodies"].keys()))
sat = data["bodies"]["saturn"]
print("saturn keys:", list(sat.keys()))
for k, v in sat.items():
    if isinstance(v, list):
        print("  saturn." + k, "len", len(v), "item0:", {kk: (vv if not isinstance(vv, str) or len(vv) < 40 else vv[:30] + "...") for kk, vv in v[0].items()} if isinstance(v[0], dict) else v[0])
    else:
        print("  saturn." + k, "=", v if not isinstance(v, str) else v[:40])
tit = data["bodies"]["titan"]
print("titan keys:", list(tit.keys()))
for k, v in tit.items():
    if isinstance(v, list):
        print("  titan." + k, "len", len(v), "item0:", {kk: (vv if not isinstance(vv, str) or len(vv) < 40 else vv[:30] + "...") for kk, vv in v[0].items()} if isinstance(v[0], dict) else v[0])
    else:
        print("  titan." + k, "=", v if not isinstance(v, str) else v[:40])
