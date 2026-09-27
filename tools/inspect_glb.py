"""Inspect NASA Cassini-Huygens GLB files: structure, bounds, orientation, textures."""
import json
import struct
import sys

MODELS_DIR = r"D:\Programming\HTML\Cassini\data_raw\models"
FILES = {
    "full": "Cassini-Huygens (A).glb",
    "probe": "Cassini-Huygens (A) (without Cassini).glb",
    "orbiter": "Cassini-Huygens (A) (without Hyugens).glb",
}


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not GLB"
    off = 12
    js_len, js_type = struct.unpack_from("<II", data, off)
    js = json.loads(data[off + 8 : off + 8 + js_len].decode("utf-8"))
    off += 8 + js_len
    bin_chunk = None
    if off < length:
        b_len, b_type = struct.unpack_from("<II", data, off)
        if b_type == 0x004E4942:
            bin_chunk = data[off + 8 : off + 8 + b_len]
    return js, bin_chunk


def accessor_bounds(js, bin_chunk):
    """Union of POSITION accessor min/max over all meshes (node transforms applied below)."""
    accs = js["accessors"]
    raw = []
    for mesh in js.get("meshes", []):
        for prim in mesh["primitives"]:
            pa = prim.get("attributes", {}).get("POSITION")
            if pa is None:
                continue
            a = accs[pa]
            raw.append((a["min"], a["max"]))
    return raw


def node_walk(js, node_idx, parent, out, depth=0):
    n = js["nodes"][node_idx]
    name = n.get("name", f"node{node_idx}")
    t = n.get("translation", [0, 0, 0])
    s = n.get("scale", [1, 1, 1])
    has_mesh = "mesh" in n
    out.append((depth, name, has_mesh, t, s))
    for c in n.get("children", []):
        node_walk(js, c, node_idx, out, depth + 1)


def combined_bounds(js, bin_chunk):
    """World-space AABB honoring node TRS transforms (assumes TRS, no inverse-bind skinning)."""
    import numpy as np

    accs = js["accessors"]
    bv = []
    bmax = None
    bmin = None

    def mat_from_node(n):
        if "matrix" in n:
            m = n["matrix"]
            return np.array(
                [
                    [m[0], m[4], m[8], m[12]],
                    [m[1], m[5], m[9], m[13]],
                    [m[2], m[6], m[10], m[14]],
                    [m[3], m[7], m[11], m[15]],
                ]
            )
        t = n.get("translation", [0, 0, 0])
        r = n.get("rotation", [0, 0, 0, 1])
        s = n.get("scale", [1, 1, 1])
        x, y, z, w = r
        R = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ]
        )
        M = np.eye(4)
        M[:3, :3] = R @ np.diag(s)
        M[:3, 3] = t
        return M

    def walk(idx, M):
        n = js["nodes"][idx]
        M2 = M @ mat_from_node(n)
        if "mesh" in n:
            mesh = js["meshes"][n["mesh"]]
            for prim in mesh["primitives"]:
                pa = prim.get("attributes", {}).get("POSITION")
                if pa is None:
                    continue
                a = accs[pa]
                lo = np.array(a["min"], dtype=float)
                hi = np.array(a["max"], dtype=float)
                # 8 corners
                for cx in (lo[0], hi[0]):
                    for cy in (lo[1], hi[1]):
                        for cz in (lo[2], hi[2]):
                            p = M2 @ np.array([cx, cy, cz, 1.0])
                            nonlocal bmin, bmax
                            bmin = p[:3] if bmin is None else np.minimum(bmin, p[:3])
                            bmax = p[:3] if bmax is None else np.maximum(bmax, p[:3])
        for c in n.get("children", []):
            walk(c, M2)

    scene = js.get("scenes", [{}])[js.get("scene", 0)]
    for root in scene["nodes"]:
        walk(root, np.eye(4))
    return bmin, bmax


def main():
    for key, fn in FILES.items():
        path = f"{MODELS_DIR}\\{fn}"
        js, bin_chunk = read_glb(path)
        print("=" * 70)
        print(f"[{key}] {fn}")
        print(
            "  asset:", json.dumps(js.get("asset", {})),
            " extensionsUsed:", js.get("extensionsUsed"),
        )
        print(
            "  buffers:", len(js.get("buffers", [])),
            " images:", len(js.get("images", [])),
            " textures:", len(js.get("textures", [])),
            " materials:", len(js.get("materials", [])),
            " meshes:", len(js.get("meshes", [])),
            " nodes:", len(js.get("nodes", [])),
            " animations:", len(js.get("animations", [])),
            " bin_chunk:", (len(bin_chunk) if bin_chunk else 0),
        )
        if js.get("images"):
            im0 = js["images"][0]
            print("  image[0]:", {k: v for k, v in im0.items() if k != "uri"})
            uris = [im.get("uri", "<embedded>") for im in js["images"]]
            ext = [u.split(".")[-1] for u in uris if u != "<embedded>"]
            print("  external image uris:", [u for u in uris if u != "<embedded>"][:4], "count_ext:", len(ext))
        # node tree (top levels)
        scene = js.get("scenes", [{}])[js.get("scene", 0)]
        out = []
        for root in scene["nodes"]:
            node_walk(js, root, -1, out)
        for depth, name, has_mesh, t, s in out[:40]:
            print(f"    {'  ' * depth}{name} mesh={has_mesh} t={[round(x, 3) for x in t]} s={[round(x, 3) for x in s]}")
        if len(out) > 40:
            print(f"    ... ({len(out) - 40} more nodes)")
        bmin, bmax = combined_bounds(js, bin_chunk)
        print("  world AABB min:", [round(v, 3) for v in bmin])
        print("  world AABB max:", [round(v, 3) for v in bmax])
        print("  size:", [round(bmax[i] - bmin[i], 3) for i in range(3)])


if __name__ == "__main__":
    main()
