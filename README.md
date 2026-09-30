# Cassini–Huygens 历史飞行数据 — 3D 轨迹可视化 (1997–2017)

一个**完全离线**的静态网页：以 NASA Eyes on the Solar System 同源的真实历表数据，重现 Cassini–Huygens 探测器 1997–2017 年的完整飞行轨迹（VVEJ 引力弹弓 + 13 年土星环绕）。

在线版：[cassini.otep.dpdns.org](https://cassini.otep.dpdns.org)（Cloudflare Pages，与本仓库同步）。

## 使用

**双击 `index.html` 即可**（无需服务器、无需网络），也可直接部署到 Cloudflare Pages / GitHub Pages 等静态托管。

- 左键拖动旋转，滚轮缩放，右键平移；点击天体标签平滑过渡聚焦
- 底部时间轴播放/暂停（空格）、对数速率滑块（左倒放、右正放）
- 顶栏轨迹开关（未来轨迹显隐、近期/全部历史轨迹）；26 个任务事件节点点击跳转
- 深链接：`index.html#event=soi`、`index.html#date=2017-09-15`
- 移动端 UI 已完成初步适配

## 主要特性

- **引力影响球（SOI）参考系**：进入行星/卫星 SOI 时自动切换显示相对轨迹（NASA Eyes 同样行为），Saturn 系统内支持两级参考系（土星 → 卫星）
- **飞掠段数据重构**：引力弹弓段由双曲线权威窗口 + 外移漂移过渡重构，避免 SOI 边界锯齿（详见 `tools/bake_data.py` `rebuild_flyby`）
- **飞船模型与姿态**：NASA 官方 Cassini-Huygens GLB 模型（base64 内嵌），2004-12-25 Huygens 分离后自动切换模型；HGA 按真实通信姿态实时指向 Earth
- **渲染真实性**：真实星表天空球与银河带、地球大气与云层、土星卫星程序化贴图、标签自动避让、真实比例渲染（浮动原点 + 对数深度缓冲）

## 数据来源

- 轨道与天体位置取自 NASA Eyes 的 dynamo 历表（二进制格式逆向解析），烘焙时统一转换到黄道系
- 卫星位置：母星中心细网格 + 运行时 Catmull-Rom 插值；土星段近掠按距离分级重采样，近掠几何与任务实录一致
- 飞掠近掠距离、SOI 穿越次数等关键几何量均由 `tools/bake_data.py` 自动校验（输出与任务实录对照）

## 已知问题

- **部分轨迹段（尤其是飞掠段与 SOI 边界附近的衔接）的渲染/插值 bug 尚未修复**，将在将来版本处理；当前版本以整体几何校验为准。

## 目录结构

```
index.html            入口
css/  js/             界面样式与逻辑
lib/                  Three.js r147 及加载器
data/                 烘焙生成产物（历表、模型、贴图、星表，均可直接入库/部署）
data_raw/  textures/  原始素材（data_raw/ 不入库，可由工具链重新生成）
tools/                数据管线（Python + PowerShell，可复现全部 data/）
```

## 数据管线

```bash
python tools/fetch_data.py     # 从 eyes.nasa.gov 下载历表（需网络）
python tools/bake_data.py      # 解析/重构/加密/校验 → data/cassini_data.js + data/moons_data.js
python tools/build_stars.py    # 星表 + 银河带 → data/stars.js
python tools/build_textures.py # 行星贴图 → data/textures.js
powershell tools/fetch_models.ps1  # 下载 NASA 官方 GLB → data_raw/models/
python tools/build_models.py   # GLB + Draco wasm base64 → data/models.js
```
