"""Check draco pip package API + three.min.js FileLoader/Cache internals."""
import re
import subprocess
import sys

# 1) three.min.js cache logic
src = open(r"D:\Programming\HTML\Cassini\lib\three.min.js", encoding="utf-8").read()
print("len:", len(src))
for pat in [r"Cache", r"Cache\.enabled", r"draco", r"GLTFLoader"]:
    idxs = [m.start() for m in re.finditer(pat, src)]
    print(f"{pat}: {len(idxs)} hits", idxs[:5])
# context around Cache.enabled
m = re.search(r"Cache\.enabled", src)
if m:
    print("...", src[max(0, m.start() - 200): m.start() + 300].replace("\n", " "), "...")
# revision
m = re.search(r'REVISION="(\d+)"', src)
print("REVISION:", m.group(1) if m else "?")

# 2) draco pip package
r = subprocess.run([sys.executable, "-m", "pip", "install", "draco"], capture_output=True, text=True)
print("pip rc:", r.returncode)
print("\n".join(r.stdout.strip().splitlines()[-3:]))
if r.returncode != 0:
    print("\n".join(r.stderr.strip().splitlines()[-3:]))
else:
    r2 = subprocess.run([sys.executable, "-c", "import draco; print([x for x in dir(draco) if not x.startswith('_')])"],
                        capture_output=True, text=True)
    print("draco API:", r2.stdout.strip() or r2.stderr.strip()[-500:])
