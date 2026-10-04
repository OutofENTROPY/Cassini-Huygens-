#!/usr/bin/env python3
"""split_data.py — 把 bake 产物中的巨型单文件数据脚本切成多个小片。

背景：加载页需要实时下载进度，而 cassini_data.js / moons_data.js 单片 20+ MB，
file:// 回退路径下（<script> 标签无进度事件）里程碑粒度过粗。本工具把
`window.NAME = <json>;` 形式的数据文件拆为多个 ~4MB 小片 + 一个装配脚本：

  小片:  window.__DP=window.__DP||{};window.__DP["id"]=<json片段>;
  装配:  window.NAME=(function(D){return <重组表达式>;})(window.__DP);

字符串值按码点切块（JS 侧 + 拼接）、数组按元素分组（[].concat 拼接）、
数组/字典中的大值递归切块、字典按键拆分——重组后与原 JSON 深度相等
（数值经 JSON round-trip，与原文本可能有等值的最短表示差异）。
写盘前先在 Python 侧重建整棵值树并 assert 校验。

用法（在 bake_spice.py / patch_moon_orbits.py 之后运行）:
    python tools/split_data.py                 # 拆分默认两个文件
    python tools/split_data.py a.js b.js ...   # 指定文件
输出: <name>.p00.js ... <name>.pNN.js, <name>.asm.js（原文件删除，git 可恢复）
"""
import json
import os
import sys

TARGET = 4_000_000   # 单片目标字节数
DEFAULT_FILES = ['data/cassini_data.js', 'data/moons_data.js']


def js_str(s):
    return json.dumps(s, ensure_ascii=False)


def dump(v):
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


def chunk_value(v, path, parts):
    """切块登记进 parts（pid → Python 片值），返回 (JS重组表达式, Python重组值)。"""
    s = dump(v)
    if len(s) <= TARGET:
        return s, v
    if isinstance(v, str):
        exprs, rebuilt = [], []
        for i in range(0, len(v), TARGET):
            pid = '%s.%d' % (path, len(exprs))
            piece = v[i:i + TARGET]
            parts.append((pid, piece))
            exprs.append('D[%s]' % js_str(pid))
            rebuilt.append(piece)
        return ' + '.join(exprs), ''.join(rebuilt)
    if isinstance(v, list):
        # 逐元素：小元素攒成字面量数组片，大元素递归切块后以表达式参与 concat
        group, group_size, exprs, rebuilt = [], 0, [], []
        for idx, el in enumerate(v):
            es = dump(el)
            if len(es) > TARGET:
                if group:
                    exprs.append('[' + ','.join(dump(x) for x in group) + ']')
                    rebuilt.extend(group)
                    group, group_size = [], 0
                sub_expr, sub_val = chunk_value(el, '%s.i%d' % (path, idx), parts)
                exprs.append(sub_expr)
                rebuilt.append(sub_val)
            else:
                if group and group_size + len(es) > TARGET:
                    exprs.append('[' + ','.join(dump(x) for x in group) + ']')
                    rebuilt.extend(group)
                    group, group_size = [], 0
                group.append(el)
                group_size += len(es)
        if group:
            exprs.append('[' + ','.join(dump(x) for x in group) + ']')
            rebuilt.extend(group)
        if len(exprs) == 1 and exprs[0].startswith('['):
            return exprs[0], rebuilt
        return '[].concat(%s)' % ','.join(exprs), rebuilt
    if isinstance(v, dict):
        exprs, rebuilt = [], {}
        for k, x in v.items():
            e, rv = chunk_value(x, '%s.%s' % (path, k), parts)
            exprs.append('%s: %s' % (js_str(k), e))
            rebuilt[k] = rv
        return '({%s})' % ','.join(exprs), rebuilt
    return s, v


def split_file(path):
    src = open(path, encoding='utf-8').read()
    head_end = src.index('=')
    head = src[:head_end].rstrip()
    var = head[head.rindex('window.'):]     # window.NAME
    name = var[len('window.'):]

    val = json.loads(src[head_end + 1:].strip().rstrip(';'))
    parts = []
    expr, rebuilt = chunk_value(val, name, parts)
    assert rebuilt == val, '%s: 重组校验失败' % path

    base = path[:-3] if path.endswith('.js') else path
    files = []
    for i, (pid, piece) in enumerate(parts):
        out = '%s.p%02d.js' % (base, i)
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            f.write('/* 由 tools/split_data.py 生成 — %s 分片 %d/%d */\n'
                    'window.__DP=window.__DP||{};window.__DP[%s]=%s;'
                    % (os.path.basename(path), i + 1, len(parts), js_str(pid), dump(piece)))
        files.append(out)
    out = '%s.asm.js' % base
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('%s=\n' % var)
        f.write('(function(D){return %s;})(window.__DP);' % expr)
    files.append(out)
    os.remove(path)
    return files


def main(argv):
    files = argv[1:] or DEFAULT_FILES
    for path in files:
        out = split_file(path)
        total = sum(os.path.getsize(f) for f in out)
        print('%s -> %d 片, 共 %.1f MB（重组校验通过）' % (path, len(out), total / 1e6))
        for f in out:
            print('   %-40s %7.2f MB' % (f, os.path.getsize(f) / 1e6))


if __name__ == '__main__':
    main(sys.argv)
