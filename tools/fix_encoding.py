# -*- coding: utf-8 -*-
"""fix_encoding.py — 逆转 PowerShell GBK 误读造成的 UTF-8 双重编码损坏。"""
import sys

p = sys.argv[1] if len(sys.argv) > 1 else '../js/scene.js'
s = open(p, encoding='utf-8-sig').read()
s = s.lstrip('\ufeff')
try:
    b = s.encode('gb18030')
except UnicodeEncodeError as e:
    print('GBK encode failed (lossy roundtrip):', e)
    sys.exit(1)
try:
    orig = b.decode('utf-8')
except UnicodeDecodeError as e:
    print('UTF-8 decode failed:', e)
    sys.exit(1)
open(p, 'w', encoding='utf-8', newline='\n').write(orig)
print('recovered:', p, len(orig), 'chars')
print('sample:', orig[:100])
