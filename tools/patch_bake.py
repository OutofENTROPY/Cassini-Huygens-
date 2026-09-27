# -*- coding: utf-8 -*-
import io
p = 'bake_data.py'
s = io.open(p, encoding='utf-8').read()
a = '''        bodies[name] = {"radiusKm": RADII[name], "segs": pack([(t0p, step, pts)]),
                        "o": orbit_line(p)}'''
b = '''        bodies[name] = {"radiusKm": RADII[name], "segs": pack([(t0p, step, pts)]),
                        "o": orbit_line(p), "elems": elements_keyframes(p)}'''
c = '''    bodies["moon"] = {"radiusKm": RADII["moon"], "segs": pack([(t0p, day / 4, pts)]),
                      "o": orbit_line("moon/earth/orb"), "parent": "earth"}'''
d = '''    bodies["moon"] = {"radiusKm": RADII["moon"], "segs": pack([(t0p, day / 4, pts)]),
                      "o": orbit_line("moon/earth/orb"), "parent": "earth",
                      "elems": elements_keyframes("moon/earth/orb")}'''
e = '''        bodies[name] = {"radiusKm": RADII[name], "segs": pack([(t0m, step, pts)]),
                        "o": orbit_line(m), "parent": "saturn"}'''
f = '''        bodies[name] = {"radiusKm": RADII[name], "segs": pack([(t0m, step, pts)]),
                        "o": orbit_line(m), "parent": "saturn", "elems": elements_keyframes(m)}'''
assert a in s and c in s and e in s
s = s.replace(a, b).replace(c, d).replace(e, f)
io.open(p, 'w', encoding='utf-8').write(s)
print('patched')
