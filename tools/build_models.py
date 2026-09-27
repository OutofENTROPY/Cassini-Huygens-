"""Build data/models.js — NASA official Cassini-Huygens GLB models embedded as base64
plus the Draco WASM decoder preseed (the site must run fully offline from file://,
where DRACOLoader cannot fetch its decoder).

Input  (data_raw/models/): the three NASA-3D-Resources GLBs (kept out of git)
         lib/draco_wasm_wrapper.js, lib/draco_decoder.wasm
Output (data/models.js):   window.CassiniGLBData = { full, orbiter, probe, dracoWrapper, dracoWasm }
"""
import base64
import json
import os

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
MODELS = os.path.join(ROOT, "data_raw", "models")
LIB = os.path.join(ROOT, "lib")
OUT = os.path.join(ROOT, "data", "models.js")

FILES = {
    "full": "Cassini-Huygens (A).glb",
    "orbiter": "Cassini-Huygens (A) (without Hyugens).glb",
    "probe": "Cassini-Huygens (A) (without Cassini).glb",
}


def js_str(s):
    """JSON string literal valid as a JS string (escape U+2028/2029 for JS)."""
    out = json.dumps(s)
    return out.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def main():
    parts = ["/* 自动生成：tools/build_models.py — NASA 官方 Cassini-Huygens GLB (base64 内嵌, 离线可用)\n"
             " * 来源: github.com/nasa/NASA-3D-Resources · 3D Models/Cassini-Huygens (A)\n"
             " * 另含 Draco WASM 解码器预置（file:// 下 DRACOLoader 无法自行获取解码器） */\n"
             "window.CassiniGLBData = {"]
    total = 0
    for key, fn in FILES.items():
        raw = open(os.path.join(MODELS, fn), "rb").read()
        total += len(raw)
        b64 = base64.b64encode(raw).decode("ascii")
        parts.append(f"  {key}: {js_str(b64)},")
        print(f"{key:8s} {fn}  {len(raw):,} B -> base64 {len(b64):,} B")
    wrapper = open(os.path.join(LIB, "draco_wasm_wrapper.js"), encoding="utf-8").read()
    wasm = open(os.path.join(LIB, "draco_decoder.wasm"), "rb").read()
    parts.append(f"  dracoWrapper: {js_str(wrapper)},")
    parts.append(f"  dracoWasm: {js_str(base64.b64encode(wasm).decode('ascii'))},")
    parts.append("};\n")
    js = "\n".join(parts)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)
    print(f"draco_wasm_wrapper {len(wrapper):,} B, draco_decoder.wasm {len(wasm):,} B")
    print(f"wrote {OUT}  ({os.path.getsize(OUT):,} B; GLB raw total {total:,} B)")


if __name__ == "__main__":
    main()
