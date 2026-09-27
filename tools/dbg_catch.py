# -*- coding: utf-8 -*-
"""dbg_catch.py — 运行真实 main()，捕捉 00:01:04 rogue 的来源段。"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

J = B.J2000_S
import calendar
T_ROGUE = calendar.timegm((2004, 7, 1, 0, 1, 4, 0, 0, 0)) - J

_orig_cat = B.catmull_resample
_orig_rs = B.remove_spikes


def cat_probe(pts, factor=2):
    out = _orig_cat(pts, factor)
    for q in out:
        if abs(q[0] - T_ROGUE) < 2:
            print(f"[catmull] input n={len(pts)} t_range={time.strftime('%m-%d %H:%M', time.gmtime(pts[0][0]+J))}..{time.strftime('%m-%d %H:%M', time.gmtime(pts[-1][0]+J))}")
            for p in pts[:3]:
                print(f"    in: {time.strftime('%m-%d %H:%M:%S', time.gmtime(p[0]+J))} ({p[1]:,.0f},{p[2]:,.0f},{p[3]:,.0f})")
            for q2 in out:
                if abs(q2[0] - T_ROGUE) < 120:
                    print(f"    OUT: {time.strftime('%m-%d %H:%M:%S', time.gmtime(q2[0]+J))} ({q2[1]:,.0f},{q2[2]:,.0f},{q2[3]:,.0f})")
            break
    return out


def rs_probe(pts, **kw):
    out = _orig_rs(pts, **kw)
    for q in out:
        if abs(q[0] - T_ROGUE) < 2:
            print(f"[remove_spikes] n_in={len(pts)} n_out={len(out)} t0={time.strftime('%m-%d %H:%M', time.gmtime(pts[0][0]+J))}")
            i = next(k for k, q2 in enumerate(out) if abs(q2[0] - T_ROGUE) < 2)
            for k in range(max(0, i - 2), min(len(out), i + 3)):
                q2 = out[k]
                mark = " >>>" if k == i else "    "
                print(f"  {mark} {time.strftime('%m-%d %H:%M:%S', time.gmtime(q2[0]+J))} ({q2[1]:,.0f},{q2[2]:,.0f},{q2[3]:,.0f})")
            break
    return out


B.catmull_resample = cat_probe
B.remove_spikes = rs_probe
B.main()
