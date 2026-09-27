import re

src = open(r"D:\Programming\HTML\Cassini\lib\three.min.js", encoding="utf-8").read()
i = src.find("Cache", 304000)
print(src[i - 400 : i + 900])
print("\n--- FileLoader fetch region ---")
j = src.find("fetch(")
print(src[j - 300 : j + 400] if j >= 0 else "no fetch()")
