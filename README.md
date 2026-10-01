# Cassini–Huygens 历史飞行数据 — 3D 轨迹可视化 (1997–2017)

一个**完全离线**的静态网页：以 NASA Eyes on the Solar System 同源的真实历表数据，重现 Cassini–Huygens 探测器 1997–2017 年的完整飞行轨迹（VVEJ 引力弹弓 + 13 年土星环绕）。

在线版：[cassini.otep.dpdns.org](https://cassini.otep.dpdns.org)

## 使用

双击 `index.html` 即可（无需服务器、无需网络），也可部署到任意静态托管。

- 左键拖动旋转，滚轮缩放，右键平移；点击天体标签平滑聚焦
- 底部时间轴播放/暂停（空格）、对数速率滑块（左倒放、右正放）
- 顶栏轨迹开关（未来轨迹显隐、近期/全部历史轨迹）；26 个任务事件节点点击跳转
- 深链接：`index.html#event=soi`、`index.html#date=2017-09-15`
- 移动端 UI 已完成初步适配

## 主要特性

- **参考系切换**：进入行星/卫星引力影响球（SOI）时自动切换显示相对轨迹（NASA Eyes 同样行为），Saturn 系统内支持两级参考系（土星 → 卫星）
- **飞掠段重构**：dynamo 历表的飞掠/发射逃逸/土星入臂双曲线为镜像伪造，烘焙时以真实边界状态 + 真实近拱点重构（`tools/bake_data.py`），与 SPICE 真值偏差 ≤2.2 万 km，详见 `tools/FLYBY_FIX_REPORT.md`
- **飞船模型与姿态**：NASA 官方 Cassini–Huygens GLB 模型（base64 内嵌），2004-12-25 Huygens 分离后自动切换；高增益天线按真实通信姿态实时指向 Earth
- **渲染**：真实星表天空球与银河带、地球大气与云层、土星卫星程序化贴图、真实比例渲染（浮动原点 + 对数深度缓冲）

## 已知问题

- **木星飞掠深度偏差**：sun/4 腿在木星近旁仅有 3 个根数关键帧，插值近掠"削角"——轨迹最近距离 ~1,066 万 km，任务实录为 ~979 万 km（2000-12-30）。转弯角/轨道面/出入 SOI 状态均正确，属源数据插值精度限制，与 NASA Eyes 自身渲染一致。

## 目录结构

```
index.html            入口
css/  js/             界面样式与逻辑
lib/                  Three.js r147 及加载器
data/                 烘焙生成产物（历表、模型、贴图、星表，可直接入库/部署）
tools/                数据管线（Python + PowerShell，可复现全部 data/）
```

## 数据管线

```bash
python tools/fetch_data.py         # 从 eyes.nasa.gov 下载历表（需网络）
python tools/bake_data.py          # 解析/重构/加密/校验 → data/cassini_data.js + data/moons_data.js
python tools/build_stars.py        # 星表 + 银河带 → data/stars.js
python tools/build_textures.py     # 行星贴图 → data/textures.js
powershell tools/fetch_models.ps1  # 下载 NASA 官方 GLB
python tools/build_models.py       # GLB + Draco wasm base64 → data/models.js
```
