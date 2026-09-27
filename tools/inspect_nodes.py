"""Per-node world AABB for the NASA Cassini GLBs — identifies part axes (HGA / RTG / mag boom / Huygens)."""
import json
import struct

import numpy as np

MODELS_DIR = r"D:\Programming\HTML\Cassini\data_raw\models"
FILES = {
    "full": "Cassini-Huygens (A).glb",
    "probe": "Cassini-Huygens (A) (without Cassini).glb",
}


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    off = 12
    js_len, js_type = struct.unpack_from("<II", data, off)
    js = json.loads(data[off + 8 : off + 8 + js_len].decode("utf-8"))
    return js


def mat_from_node(n):
    if "matrix" in n:
        m = n["matrix"]
        return np.array([[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]],
                         [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]])
    t = n.get("translation", [0, 0, 0])
    r = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    x, y, z, w = r
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R @ np.diag(s)
    M[:3, 3] = t
    return M


def main():
    for key, fn in FILES.items():
        js = read_glb(f"{MODELS_DIR}\\{fn}")
        accs = js["accessors"]
        print("=" * 74)
        print(f"[{key}] {fn}")
        scene = js.get("scenes", [{}])[js.get("scene", 0)]

        def walk(idx, M):
            n = js["nodes"][idx]
            M2 = M @ mat_from_node(n)
            if "mesh" in n:
                mesh = js["meshes"][n["mesh"]]
                bmin = bmax = None
                for prim in mesh["primitives"]:
                    pa = prim.get("attributes", {}).get("POSITION")
                    if pa is None:
                        continue
                    a = accs[pa]
                    lo, hi = np.array(a["min"], float), np.array(a["max"], float)
                    for cx in (lo[0], hi[0]):
                        for cy in (lo[1], hi[1]):
                            for cz in (lo[2], hi[2]):
                                p = (M2 @ np.array([cx, cy, cz, 1.0]))[:3]
                                bmin = p if bmin is None else np.minimum(bmin, p)
                                bmax = p if bmax is None else np.maximum(bmax, p)
                size = bmax - bmin
                ctr = (bmin + bmax) / 2
                print(f"  {n.get('name','?'):16s} size=({size[0]:7.2f},{size[1]:7.2f},{size[2]:7.2f})"
                      f" center=({ctr[0]:6.2f},{ctr[1]:6.2f},{ctr[2]:6.2f})")
            for c in n.get("children", []):
                walk(c, M2)

        for root in scene["nodes"]:
            walk(root, np.eye(4))


if __name__ == "__main__":
    main()
