"""Build data/models.js — NASA Eyes Cassini model embedded as base64 (offline from file://).

Input  (data_raw/eyes_cassini/): NASA Eyes on the Solar System 官方资源
         https://eyes.nasa.gov/assets/static/models/sc_cassini/
         Cassini.gltf + cassini.bin + foil_normal.png + cassini_dish_ao.jpg
         + cassini_normal.png + cassini_albedo.jpg + cassini_pbr.jpg
Output (data/models.js):   window.CassiniGLBData = { eyes }

打包：glTF + bin + 5 张贴图合并为单个自包含 GLB（贴图转 bufferView 内嵌，
无外部 uri，file:// 零网络）。Blender 导出未压缩，无需 Draco 解码器。

模型结构（米制，体轴与旧 NASA-3D-Resources 版一致）：
  HGA 盘 φ4.0 m @ +Y（开口 +Y，馈源塔至 +3.4 m）；RTG 桁架沿 −Z 至 −10.9 m；
  磁强计双杆 ±X（跨距 17.98 m）；huygens_probe 命名节点挂于 +X 侧、
  防热大底朝 +X（φ2.62 m）—— 分离拆分经该节点完成，无需三套 GLB。
"""
import base64
import json
import os
import struct

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "data_raw", "eyes_cassini")
OUT = os.path.join(ROOT, "data", "models.js")

IMAGES = [
    "foil_normal.png",
    "cassini_dish_ao.jpg",
    "cassini_normal.png",
    "cassini_albedo.jpg",
    "cassini_pbr.jpg",
]


def align4(n):
    return (n + 3) & ~3


def build_glb():
    gltf = json.load(open(os.path.join(SRC, "Cassini.gltf"), encoding="utf-8"))
    bin_data = open(os.path.join(SRC, "cassini.bin"), "rb").read()

    # 贴图追加到 BIN 块，images[i] 改指 bufferView
    blob = bytearray(bin_data)
    buffer_views = gltf.setdefault("bufferViews", [])
    for i, name in enumerate(IMAGES):
        raw = open(os.path.join(SRC, name), "rb").read()
        off = align4(len(blob))
        blob.extend(b"\x00" * (off - len(blob)))
        blob.extend(raw)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": off,
            "byteLength": len(raw),
        })
        img = gltf["images"][i]
        img.pop("uri", None)
        img["mimeType"] = "image/png" if name.endswith(".png") else "image/jpeg"
        img["bufferView"] = len(buffer_views) - 1

    # BIN 块（GLB 内嵌 buffer：去掉 uri）
    gltf["buffers"][0].pop("uri", None)
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = b"\x20" * (align4(len(json_bytes)) - len(json_bytes))
    bin_pad = b"\x00" * (align4(len(blob)) - len(blob))

    header = struct.pack("<III", 0x46546C67, 2, 0)          # magic glTF, version 2
    json_chunk = struct.pack("<II", len(json_bytes) + len(json_pad), 0x4E4F534A) + json_bytes + json_pad
    bin_chunk = struct.pack("<II", len(blob) + len(bin_pad), 0x004E4942) + bytes(blob) + bin_pad
    total = 12 + len(json_chunk) + len(bin_chunk)
    return struct.pack("<III", 0x46546C67, 2, total) + json_chunk + bin_chunk


def js_str(s):
    out = json.dumps(s)
    return out.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def main():
    glb = build_glb()
    b64 = base64.b64encode(glb).decode("ascii")
    js = ("/* 自动生成：tools/build_models.py — NASA Eyes on the Solar System 官方 Cassini 模型\n"
          " * （base64 内嵌自包含 GLB：几何 bin + 5 张官方贴图全部内嵌，file:// 离线可用）\n"
          " * 来源: eyes.nasa.gov/apps/solar-system · assets/static/models/sc_cassini/ */\n"
          "window.CassiniGLBData = {\n"
          f"  eyes: {js_str(b64)},\n"
          "};\n")
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)
    print(f"GLB {len(glb):,} B -> base64 {len(b64):,} B")
    print(f"wrote {OUT}  ({os.path.getsize(OUT):,} B)")


if __name__ == "__main__":
    main()
