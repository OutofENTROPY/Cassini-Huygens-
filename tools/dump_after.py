# -*- coding: utf-8 -*-
import base64, json, math, struct, time, calendar
raw = open('../data/cassini_data.js', encoding='utf-8').read()
js = json.loads(raw[raw.index('=') + 1:].rstrip().rstrip(';'))
sc = js['spacecraft']['cassini']
tt = struct.unpack('<%dd' % sc['trailN'], base64.b64decode(sc['trailT']))
xyz = struct.unpack('<%df' % (sc['trailN'] * 3), base64.b64decode(sc['trail']))
J = 946728000
lo = calendar.timegm(time.strptime('1997-10-18 15:40:00', '%Y-%m-%d %H:%M:%S')) - J
hi = calendar.timegm(time.strptime('1997-10-18 22:30:00', '%Y-%m-%d %H:%M:%S')) - J
prev = None
for i in range(sc['trailN']):
    if lo <= tt[i] <= hi:
        d = 0 if prev is None else math.sqrt(sum((xyz[i * 3 + k] - xyz[prev * 3 + k]) ** 2 for k in range(3)))
        print(time.strftime('%H:%M:%S', time.gmtime(tt[i] + J)),
              'dt+%7.0f' % (tt[i] - tt[prev] if prev is not None else 0),
              'step=%12s' % format(d, ',.0f'),
              [round(v) for v in (xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2])])
        prev = i
