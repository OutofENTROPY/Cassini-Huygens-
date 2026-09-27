# -*- coding: utf-8 -*-
"""生成占位数据（简单圆轨道）用于前端调试；正式数据由 bake_data.py 生成。"""
import base64, math, struct, os, json

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
os.makedirs(OUT, exist_ok=True)
J2000_S = 946728000

def et(y, m, d):
    import calendar
    return calendar.timegm((y, m, d, 0, 0, 0)) - J2000_S

def seg(t0, t1, dt, radius_km, period_days, incl=0.0, phase=0.0, center=[0,0,0]):
    n = int((t1-t0)/dt)+1
    pts = []
    om = 2*math.pi/(period_days*86400)
    for i in range(n):
        t = t0 + i*dt
        a = phase + om*(t-t0)
        p = (radius_km*math.cos(a), radius_km*math.sin(a)*math.cos(incl), radius_km*math.sin(a)*math.sin(incl))
        pts.append((p[0]+center[0], p[1]+center[1], p[2]+center[2]))
    return (t0, dt, pts)

def pack(segs):
    out = []
    for (t0, dt, pts) in segs:
        arr = struct.pack(f"<{len(pts)*3}f", *[v for p in pts for v in p])
        out.append({"t0": t0, "dt": dt, "n": len(pts), "d": base64.b64encode(arr).decode()})
    return out

t0, t1 = et(1997,6,1), et(2018,1,1)
AU = 1.496e8
bodies = {}
specs = {
    "sun": (0, 1), "mercury": (0.387*AU, 88), "venus": (0.723*AU, 224.7),
    "earth": (1.0*AU, 365.25), "mars": (1.524*AU, 687), "jupiter": (5.203*AU, 4331),
    "saturn": (9.537*AU, 10747), "uranus": (19.19*AU, 30589), "neptune": (30.07*AU, 59800),
    "moon": (384400, 27.3), "titan": (1.22187e6, 15.945), "enceladus": (237948, 1.37),
    "iapetus": (3.56082e6, 79.32), "rhea": (527108, 4.518), "dione": (377396, 2.737),
    "tethys": (294619, 1.888), "mimas": (185539, 0.942),
}
RADII = {"sun":696000,"mercury":2439.7,"venus":6051.8,"earth":6371,"moon":1737.4,"mars":3389.5,
 "jupiter":69911,"saturn":58232,"uranus":25362,"neptune":24622,"titan":2574.7,"enceladus":252.1,
 "iapetus":734.5,"rhea":763.8,"dione":561.4,"tethys":531.1,"mimas":198.2}
PARENT = {"moon":"earth","titan":"saturn","enceladus":"saturn","iapetus":"saturn","rhea":"saturn","dione":"saturn","tethys":"saturn","mimas":"saturn"}

centers = {k:[0,0,0] for k in specs}
# 一阶近似：先算行星（相对太阳），再算卫星（相对行星）
for name,(r,pd) in specs.items():
    if name in PARENT: continue
    segs = [seg(t0,t1,86400.0,r,pd)] if r>0 else []
    bodies[name] = {"radiusKm":RADII[name],"segs":pack(segs),"parent":None}
    centers[name] = [0,0,0]
for name,(r,pd) in specs.items():
    if name not in PARENT: continue
    par = PARENT[name]
    segs = [seg(t0,t1,86400.0/2,r,pd,center=[0,0,0])]
    bodies[name] = {"radiusKm":RADII[name],"segs":pack(segs),"parent":par}

# 卡西尼：从地球圈出发生成螺旋到土星圈
segs = []
# 巡航段：缓慢外扩的近似轨迹（视觉占位）
n_c = 3000
cpts = []
t_c0, t_c1 = et(1997,10,15), et(2004,7,1)
for i in range(n_c):
    t = t_c0 + (t_c1-t_c0)*i/(n_c-1)
    k = i/(n_c-1)
    r = 1.0*AU + (9.54-1.0)*AU*(k*k)
    a = k*math.pi*2*1.7  # 约 1.7 圈
    cpts.append((r*math.cos(a), r*math.sin(a)*0.98, r*math.sin(a)*0.02))
segs.append((t_c0, (t_c1-t_c0)/(n_c-1), cpts))
# 土星轨道段：绕土星
n_s = 4000
spts = []
t_s0, t_s1 = et(2004,7,1), et(2017,9,15)
import calendar
sat_pos_at = {}
# 用土星圆轨道近似求各时刻土星位置
om_s = 2*math.pi/(10747*86400)
for i in range(n_s):
    t = t_s0 + (t_s1-t_s0)*i/(n_s-1)
    k = i/(n_s-1)
    r = 1.5e6 + 0.4e6*math.sin(k*math.pi*2*40)
    a = k*math.pi*2*90
    sp = (9.537*AU*math.cos(om_s*(t-t0)), 9.537*AU*math.sin(om_s*(t-t0)), 0)
    spts.append((sp[0]+r*math.cos(a), sp[1]+r*math.sin(a)*0.95, sp[2]+r*math.sin(a)*0.2))
segs.append((t_s0, (t_s1-t_s0)/(n_s-1), spts))
allpts = cpts + spts
tt = [t_c0 + (t_s1-t_c0)*i/(len(allpts)-1) for i in range(len(allpts))]
cass = {"segs": pack(segs),
        "trailT": base64.b64encode(struct.pack(f"<{len(tt)}d", *tt)).decode(),
        "trail": base64.b64encode(struct.pack(f"<{len(allpts)*3}f", *[v for p in allpts for v in p])).decode(),
        "trailN": len(allpts)}

data = {"meta": {"j2000Ms": J2000_S*1000, "tStart": et(1997,10,15), "tEnd": et(2017,9,15),
                 "generated": "placeholder", "frame": "ecliptic J2000, km"},
        "bodies": bodies, "spacecraft": {"cassini": cass}}
with open(os.path.join(OUT, "cassini_data.js"), "w", encoding="utf-8") as f:
    f.write("window.CASSINI_DATA = ")
    f.write(json.dumps(data, separators=(",", ":")))
    f.write(";\n")
print("placeholder written")
