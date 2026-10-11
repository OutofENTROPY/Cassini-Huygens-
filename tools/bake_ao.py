"""Bake per-vertex ambient occlusion for the NASA Eyes Cassini GLB.

管线：解析 Cassini.gltf（TRS 节点树 → 世界空间）→ 全模型合并网格挂 Embree
BVH → 每顶点确定性 Fibonacci 半球采样（cos 加权，K 条射线）→ 遮蔽计数
（仅计 MAX_DIST 内命中）→ u8 量化写 sidecar JSON（按 (mesh, prim) 键）。

输出：data_raw/eyes_cassini/ao_vertices.json
  {"version": ..., "rays": K, "max_dist": M, "prims": {"<mesh>_<prim>": [u8...]}}

消费：tools/build_models.py 检测到 sidecar 后为每个 primitive 注入自定义
属性 _AO（u8 SCALAR normalized，glTF 规范要求自定义属性下划线前缀），
GLTFLoader r147 落为 geometry.attributes._ao（自定义属性名被 toLowerCase）。

选型备忘（2026-10-11）：贴图 AO 路线被否——共享材质（foil_gold/aluminum/
nozzles/dish_AO）跨 prim 的 UV 岛重叠（foil_gold 实测 175 cell 冲突），
单一图集互相污染，拆材质则侵入 models.js 结构。模型仅 46,791 顶点 /
26,008 三角形（平均边长 ~4 cm），逐顶点 AO 分辨率足够覆盖接触尺度
（RTG 桁架根、HGA-机身交接、Huygens 挂点、磁强计杆座），且零 UV 依赖、
零材质拆分、体积仅 +~60 KB。
"""
import json
import os

import numpy as np
import trimesh

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "data_raw", "eyes_cassini")
OUT = os.path.join(SRC, "ao_vertices.json")

K = 64            # 每顶点射线数（Fibonacci 半球，确定性）
MAX_DIST = 2.5    # m：AO 作用半径（接触尺度；更长距离的遮蔽交给阴影/反弹光）
EPS = 5e-4        # m：沿法线的自相交偏移
GOLDEN = np.pi * (3.0 - np.sqrt(5.0))


def read_acc(js, bin_, ai):
    a = js["accessors"][ai]
    bv = js["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    ct = {5126: "f4", 5123: "u2", 5125: "u4", 5121: "u1"}[a["componentType"]]
    return np.frombuffer(bin_, dtype=ct, count=a["count"] * ncomp, offset=off).reshape(a["count"], ncomp).astype(np.float64)


def node_matrix(n):
    """glTF 节点局部矩阵（列主序 → 行主序 4x4）。"""
    if "matrix" in n:
        return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
    M = np.eye(4)
    q = n.get("rotation", [0, 0, 0, 1])
    x, y, z, w = q
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    s = n.get("scale", [1, 1, 1])
    M[:3, :3] = R @ np.diag(s)
    M[:3, 3] = n.get("translation", [0, 0, 0])
    return M


def collect_prims(js, bin_):
    """遍历场景节点树，返回 [(key, mesh_name, mat_name, verts_w, normals_w)]（世界空间，米）。"""
    prims = []

    def walk(ni, M):
        n = js["nodes"][ni]
        M2 = M @ node_matrix(n)
        if "mesh" in n:
            mesh = js["meshes"][n["mesh"]]
            for pi, p in enumerate(mesh["primitives"]):
                pos = read_acc(js, bin_, p["attributes"]["POSITION"])
                nrm = read_acc(js, bin_, p["attributes"]["NORMAL"])
                lin = M2[:3, :3]
                vw = pos @ lin.T + M2[:3, 3]
                nw = nrm @ lin.T
                nw /= np.linalg.norm(nw, axis=1, keepdims=True).clip(1e-12)
                prims.append({
                    "key": f"{n['mesh']}_{pi}",
                    "mesh": mesh.get("name", f"mesh{n['mesh']}"),
                    "mat": js["materials"][p["material"]].get("name", "?"),
                    "verts": vw, "normals": nw,
                })
        for c in n.get("children", []):
            walk(c, M2)

    scene = js["scenes"][js.get("scene", 0)]
    for r in scene["nodes"]:
        walk(r, np.eye(4))
    return prims


def fib_hemisphere(k_n):
    """均匀半球方向（z 轴向上，确定性）与 cos 权重。"""
    k = np.arange(k_n)
    z = (k + 0.5) / k_n
    r = np.sqrt(1.0 - z * z)
    phi = k * GOLDEN
    dirs = np.stack([r * np.cos(phi), r * np.sin(phi), z], axis=1)
    return dirs, z.copy()


def basis_from_normals(n):
    """每顶点正交基 (t, b, n)。n 近 ±Z 时换轴避免退化。"""
    up = np.where(np.abs(n[:, 2:3]) < 0.9, np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0]))
    t = np.cross(up, n)
    t /= np.linalg.norm(t, axis=1, keepdims=True).clip(1e-12)
    b = np.cross(n, t)
    return t, b


def main():
    js = json.load(open(os.path.join(SRC, "Cassini.gltf"), encoding="utf-8"))
    bin_ = open(os.path.join(SRC, "cassini.bin"), "rb").read()
    prims = collect_prims(js, bin_)
    print(f"prims: {len(prims)}  total verts: {sum(len(p['verts']) for p in prims)}")

    # 合并全部 prim 成一个大网格挂 Embree（process=False 保留顶点原样）
    all_v = []
    all_f = []
    off = 0
    for p in prims:
        idx = None
        # 重新取该 prim 的 indices（collect_prims 未存）
        all_v.append(p["verts"])
        off_v = len(p["verts"])
        # faces 暂缺：稍后统一补——先记录 prim 顶点区间
        all_f.append(None)  # placeholder
        p["_off"] = off
        off += off_v
    verts_all = np.concatenate(all_v, axis=0)

    # 第二遍取 indices 构面（世界空间顶点已合并，索引按 prim 顶点区间偏移）
    faces = []
    prim_i = 0

    def walk2(ni, M):
        nonlocal prim_i
        n = js["nodes"][ni]
        M2 = M @ node_matrix(n)
        if "mesh" in n:
            mesh = js["meshes"][n["mesh"]]
            for pi, p in enumerate(mesh["primitives"]):
                idx = read_acc(js, bin_, p["indices"]).ravel().astype(np.int64)
                faces.append(idx + prims[prim_i]["_off"])
                prim_i += 1
        for c in n.get("children", []):
            walk2(c, M2)

    scene = js["scenes"][js.get("scene", 0)]
    for r in scene["nodes"]:
        walk2(r, np.eye(4))
    faces_all = np.concatenate(faces, axis=0).reshape(-1, 3)

    tm = trimesh.Trimesh(vertices=verts_all, faces=faces_all, process=False)
    print(f"embree mesh: {len(tm.vertices)} verts, {len(tm.faces)} faces")
    try:
        from trimesh.ray.ray_pyembree import RayMeshIntersector
    except ImportError:
        raise SystemExit("embreex 不可用：pip install embreex")
    inter = RayMeshIntersector(tm)

    dirs_local, cosw = fib_hemisphere(K)
    wsum = cosw.sum()
    CHUNK = 400_000   # 每批射线数（控内存）

    out = {"version": 1, "rays": K, "max_dist": MAX_DIST, "eps": EPS, "prims": {}}
    for p in prims:
        V, N = p["verts"], p["normals"]
        n_v = len(V)
        t, b = basis_from_normals(N)
        origins = (V + N * EPS)
        # 方向：N×K×3 → (N*K)×3
        dirs = (t[:, None, :] * dirs_local[None, :, 0, None]
                + b[:, None, :] * dirs_local[None, :, 1, None]
                + N[:, None, :] * dirs_local[None, :, 2, None]).reshape(-1, 3)
        orgs = np.repeat(origins, K, axis=0)
        occl = np.zeros(n_v * K, dtype=bool)
        for s in range(0, len(orgs), CHUNK):
            e = min(s + CHUNK, len(orgs))
            loc, ray_i, _ = inter.intersects_location(orgs[s:e], dirs[s:e], multiple_hits=False)
            if len(ray_i):
                d = np.linalg.norm(loc - orgs[s:e][ray_i], axis=1)
                occl[s + ray_i[d < MAX_DIST]] = True
        occ = occl.reshape(n_v, K)
        ao = 1.0 - (occ * cosw[None, :]).sum(axis=1) / wsum
        ao = np.clip(ao, 0.05, 1.0)          # 防全黑地板（属性缺失时 vAO 默认 0 的对偶保险）
        u8 = np.round(ao * 255.0).astype(np.uint8)
        out["prims"][p["key"]] = u8.tolist()
        print(f"  {p['key']:8s} {p['mesh']:10s} {p['mat']:14s} n={n_v:6d}  "
              f"ao min={ao.min():.2f} mean={ao.mean():.2f} p5={np.percentile(ao, 5):.2f}")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT}  ({os.path.getsize(OUT):,} B)")


if __name__ == "__main__":
    main()
