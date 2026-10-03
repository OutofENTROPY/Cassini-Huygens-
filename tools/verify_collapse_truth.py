"""verify_collapse_truth.py —— 用 SPICE 真值检验 collapseMicroSteps 是否降低误差。

复用 bake_spice 的 load_kernels() 装载内核池（含 -82 重构轨道），
对每个被塌缩顶点 i 求 SPICE 真值 P_true(t_i)，比较塌缩前后的误差。

输入：data/cassini_data.js
输出：统计（stdout）
"""
import os, sys, json, base64, math, importlib.util
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

# —— 加载 bake_spice 模块但阻止其 main() ——
spec = importlib.util.spec_from_file_location("bake_spice", os.path.join(ROOT, "tools", "bake_spice.py"))
BS = importlib.util.module_from_spec(spec)
sys.modules["bake_spice"] = BS
_src = open(os.path.join(ROOT, "tools", "bake_spice.py"), encoding="utf-8").read()
_src = _src.replace('if __name__ == "__main__":\n    main()', 'if False:\n    main()')
# 用 exec 以便替换 main 守卫
exec(compile(_src, os.path.join(ROOT, "tools", "bake_spice.py"), "exec"), BS.__dict__)

import spiceypy as sp

BS.load_kernels()
TM = BS.TM
print("kernels loaded; TM.ets span:", TM.ets[0], TM.ets[-1])
BS.furnsh_base()

txt = open(os.path.join(ROOT, "data", "cassini_data.js"), encoding="utf-8").read()
D = json.loads(txt[txt.index("{"):txt.rindex("}") + 1])
sc = D["spacecraft"]["cassini"]
T = np.frombuffer(base64.b64decode(sc["trailT"]), dtype="<f8")
X = np.frombuffer(base64.b64decode(sc["trail"]), dtype="<f4").reshape(-1, 3).astype(np.float64)
N = sc["trailN"]
three = np.stack([X[:, 0], X[:, 2], -X[:, 1]], axis=1)   # ecl→three

CE, SE = BS.CE, BS.SE
_sf = BS._state_fast

def true_three(u):
    """SPICE 真值 → 前端 three 场景系（与 JS: eclToThree(ecl) = [ex, ez, -ey] 一致）。"""
    x, y, z, _, _, _ = _sf("CASSINI", "SUN", TM.et(float(u)))
    ex, ey, ez = x, y * CE + z * SE, -y * SE + z * CE     # 黄道 km
    return np.array([ex, ez, -ey])                         # → three 系

MIN_DT = 5.0
idx = [i for i in range(1, N - 1)
       if (T[i] - T[i - 1] < MIN_DT) or (T[i + 1] - T[i] < MIN_DT)]
print(f"candidates (adjacent micro-step): {len(idx)}")

pr = np.zeros(N, dtype=np.int64); nx = np.zeros(N, dtype=np.int64)
last = 0
for i in range(N):
    if i > 0 and T[i] - T[i - 1] >= MIN_DT: last = i - 1
    pr[i] = last
last = N - 1
for i in range(N - 1, -1, -1):
    if i < N - 1 and T[i + 1] - T[i] >= MIN_DT: last = i + 1
    nx[i] = last

rows = []
for i in idx:
    L, R = int(pr[i]), int(nx[i])
    if L >= i or R <= i or R <= L: continue
    span = T[R] - T[L]
    if not span > 0: continue
    a = (T[i] - T[L]) / span
    newp = three[L] + (three[R] - three[L]) * a
    rows.append((i, float(T[i]), three[i].copy(), newp))

print(f"collapsed: {len(rows)}")
rows_sorted = sorted(rows, key=lambda r: -np.linalg.norm(r[2] - r[3]))
sample = rows_sorted[:250] + rows_sorted[::max(1, len(rows_sorted) // 150)]
be, ae, bad, moves = [], [], 0, []
for (i, ti, oldp, newp) in sample:
    tp = true_three(ti)
    eb = float(np.linalg.norm(oldp - tp)); ea = float(np.linalg.norm(newp - tp))
    be.append(eb); ae.append(ea); moves.append(float(np.linalg.norm(oldp - newp)))
    if ea > eb + 1e-6: bad += 1
be = np.array(be); ae = np.array(ae); moves = np.array(moves)
print(f"sample n={len(be)}  (sidereal baseline err ~ order: med={np.median(be):.1f} km)")
print(f"move     : med={np.median(moves):.2f} p90={np.percentile(moves,90):.2f} max={moves.max():.2f} km")
print(f"err_before: med={np.median(be):.2f} p90={np.percentile(be,90):.2f} max={be.max():.2f} km")
print(f"err_after : med={np.median(ae):.2f} p90={np.percentile(ae,90):.2f} max={ae.max():.2f} km")
print(f"变差的顶点数 = {bad} / {len(be)}  ({100*bad/len(be):.1f}%)")
print(f"改善的顶点数 = {(ae<be-1e-6).sum()}")
d = np.argsort(-(ae - be))[:8]
print("--- 变差最多的点 ---")
for j in d:
    print(f"  i={sample[j][0]} t={sample[j][1]:.1f} before={be[j]:.2f} after={ae[j]:.2f} move={moves[j]:.2f}")
print("--- 大搬移点（>30km）的真值误差 ---")
big = np.where(moves > 30)[0]
for j in big[:10]:
    print(f"  i={sample[j][0]} move={moves[j]:.2f} before={be[j]:.2f} after={ae[j]:.2f} delta={ae[j]-be[j]:+.2f}")
if len(big):
    print(f"  >30km: n={len(big)} 变差={np.sum(ae[big]>be[big]+1e-6)} delta_med={np.median(ae[big]-be[big]):+.2f} delta_max={np.max(ae[big]-be[big]):+.2f}")
