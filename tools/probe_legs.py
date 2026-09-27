# -*- coding: utf-8 -*-
import sys, time
sys.path.insert(0, 'tools')
from bake_data import load_points, J2000_S, CASSINI_LEGS

def iso(t):
    return time.strftime('%Y-%m-%d %H:%M', time.gmtime(t + J2000_S))

for leg in CASSINI_LEGS:
    pts = load_points(leg)['points']
    print(f'{leg}: {iso(pts[0][0])} .. {iso(pts[-1][0])}  ({len(pts)} kf)')
print('DONE')
