# -*- coding: utf-8 -*-
"""patch_moon_orbits.py — 给 data/moons_data.js 补回卫星/月球轨道线字段。

背景：moons_data.js 曾由 bake_data.py（dynamo 管线）生成，每颗卫星带
  'o'（首帧根数整圈 256 点折线，黄道系）+ 'elems'（密切根数关键帧），
前端据此绘制行星/卫星轨道线（trailOptions.planetOrbits）。改用 bake_spice.py
重烘焙后 bake_moons 只产 segs，两个字段丢失 → 全部卫星轨道线（含月球）
消失（用户反馈「月球轨迹消失」）。bake_spice.py 现已内置生成逻辑
（moon_elems_and_line），本脚本用同一实现直接修补现有数据文件，
避免整场重烘焙；字段约定与 bake_data.py / 前端 elemPosEcl 逐值一致。

用法:  python tools/patch_moon_orbits.py
输出:  data/moons_data.js（原文件备份为 moons_data.js.prevorbit）
"""
import base64
import json
import math
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
sys.path.insert(0, HERE)

import bake_spice as bs          # noqa: E402  导入期 furnsh LSK/PCK
bs.load_kernels()                # SPK 池（cosp 卷 + sat215/jup310/SCPSE ops）


def main():
    path = os.path.join(OUT, "moons_data.js")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    i = text.index("{")
    data = json.loads(text[i:text.rindex("}") + 1])
    t0, t1 = data["meta"]["tStart"], data["meta"]["tEnd"]
    bodies = data["bodies"]

    fix = bs._saturn_center_fix()
    for m, body in bodies.items():
        if m in bs.SAT_MOONS:
            mu = bs.SB.gm_planet + (bs.SB.gm_moons.get(m) or 0.0)
            o_b64, elems = bs.moon_elems_and_line(
                m, "SATURN BARYCENTER", mu, t0, t1, cap=1200, center_fix=fix)
        elif m == "moon":
            mu = (bs.gm("EARTH") or 398600.435436) + (bs.gm("MOON") or 4902.800066)
            o_b64, elems = bs.moon_elems_and_line("MOON", "EARTH", mu, t0, t1, cap=1200)
        else:
            continue
        body["o"] = o_b64
        body["elems"] = elems
        print(f"  {m}: elems {elems['n']} 帧, o 256 点")

    bak = os.path.join(OUT, "moons_data.js.prevorbit")
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print(f"  备份原文件 → {os.path.basename(bak)}")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* 由 tools/patch_moon_orbits.py 生成 — 卫星细网格（运行时 Catmull-Rom 插值）+ 密切根数轨道线*/\n")
        f.write("window.MOONS_DATA = ")
        f.write(payload)
        f.write(";\n")
    print(f"  写回 {path}（{os.path.getsize(path):,} bytes）")


if __name__ == "__main__":
    main()
