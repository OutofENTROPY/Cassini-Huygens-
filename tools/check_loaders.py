import re

s = open(r"D:\Programming\HTML\Cassini\lib\DRACOLoader.js", encoding="utf-8").read()
print("THREE.DRACOLoader:", "THREE.DRACOLoader" in s)
for m in set(re.findall(r"draco_\w+\.(?:wasm|js)", s)):
    print("requests:", m)
i = s.find("_loadLibrary")
print("---loadLibrary---")
print(s[i : i + 420])

g = open(r"D:\Programming\HTML\Cassini\lib\GLTFLoader.js", encoding="utf-8").read()
print("EXT_texture_webp:", "EXT_texture_webp" in g)
print("KHR_draco_mesh_compression:", "KHR_draco_mesh_compression" in g)
print("setDRACOLoader:", "setDRACOLoader" in g)
print("createImageBitmap:", "createImageBitmap" in g)
print("parse(", "parse(" in g)
