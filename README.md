# Cassini–Huygens 历史飞行数据 · 3D 轨迹可视化（1997–2017）

重现 Cassini–Huygens 的完整飞行历程——VVEJ 引力弹弓到 13 年土星环绕，直至 2017 年坠入土星大气。纯静态网页，完全离线可运行。

**在线版**：<https://cassini.otep.dpdns.org>

## 使用

双击 `index.html` 即可，无需服务器与网络。

| 操作 | 说明 |
|---|---|
| 左键拖动 / 滚轮 / 右键拖动 | 旋转 / 缩放 / 平移 |
| 点击行星、卫星标签 | 平滑聚焦该天体 |
| 空格 | 播放 / 暂停 |
| 时间条拖动、速率滑块 | 任意时刻回放，中点两侧分别为倒放与正放 |
| 左上角 ◉ / 右上角 ⚙ | 状态卡、真实光照、轨迹与标签开关、视角切换 |
| 深链接 | `index.html#event=soi`　`index.html#date=2017-09-15` |

移动端（单指旋转、双指缩放）已适配。

## 特性

- **真实数据**：基于 NAIF SPICE 内核（Cassini -82 轨道重构 + DE 行星历表 + 土卫系统）直接采样烘焙，模型定位精度 ≤1 km；飞掠、发射逃逸与土星入轨的双曲线段按真实边界状态重构，与 SPICE 真值偏差 ≤2.2 万 km。
- **真实姿态**：来自 NASA Eyes / NAIF CK 的全程姿态四元数驱动模型定向（含滚动自由度）。HGA 对地通信、SOI 防尘盾点火、惠更斯 Titan 中继、Grand Finale 环缝防护等机动按实测序列呈现。
- **多层参考系**：进入行星引力影响球时自动叠加相对该天体的轨迹；土星系统内支持「日心 → 土星 → 卫星」三级切换，交点即飞船实际位置。
- **惠更斯探测器**：分离、Titan 进入、降落伞下降与着陆全程回放，含真实 7 rpm 自旋与挂点几何；失联后自动移除。
- **渲染**：真实星表天空球与银河带、真实行星/卫星贴图、大气与云层、四颗气态行星星环、行星本影熄光、真实比例。

## 已修复问题

- **行星轨迹与飞船轨迹错位 136.4 天（2026-10 修复）**：行星历表网格的实际起点被内核可用域钳制到 `1997-10-15`（Cassini -82 重构轨道起点），但段头时间标签写的是名义起点 `1997-06-01`，使整条行星轨迹相对飞船轨迹整体偏移 136.4 天。表现为金星/地球飞掠时刻行星不在飞船位置（视最近距约 6,300–7,600 km，真值 284–1,171 km）。修正时间标签后，木星飞掠最近距由旧 dynamo 链路的约 1,066 万 km 收敛到 **9,794,447 km**（实录 9,794,457 km，2000-12-30 10:05 UTC），金星×2、地球飞掠同步回到真值。
- **木星飞掠深度偏差（2026-10 根治）**：旧主链路以 NASA Eyes dynamo 圆锥曲线重构历表，木星附近仅 3 个关键帧（约 13–16 天间隔），插值最近距约 1,066 万 km，与任务实录 979 万 km 相差约 9%。已改为**全量基于 NAIF SPICE 内核**直采（Cassini -82 全任务重构轨道 + 行星历表 + 土卫/木卫系统），飞掠深度、转弯角、轨道面与出入 SOI 状态全部与 SPICE 真值一致。
- **重复的地球 SOI 相对轨迹窗口（2026-10 修复）**：发射逃逸段（1997-10-15 起，飞船入轨即在 SOI 内）被 SOI 扫描器与显式补建各生成一次，得到两个几乎重合的地球窗口（仅末尾相差 180 s），会额外构建一份行星锚定的相对轨迹顶点缓冲。已在烘焙端去重（同天体相邻窗口重叠 ≥ 较短者 90% 时保留更长者），地球窗口由 3 个归并为 2 个（发射逃逸 + 1999 飞掠）。
- **launch 附近轨道折线（2026-10 修复）**：发射逃逸段轨迹在特写下呈多段折线，三个根因：① 行星历表 6h/24h **线性**插值的弧高差（地球 ~355 km）使锚定轨道（earthLin + rel cheb）相对渲染折线持续漂移，且在锚定窗口进入时刻（t=起+60 s）产生 ~30 km 横向阶跃——行星插值改为 Catmull-Rom（端点区间镜像切线 `crp`，卫星 `cr` 与烘焙端逐位一致的约定不变）；② 锚定路径与 f32 渲染折线残余 ±10~20 km 量化层差在窗口边界形成残折——`cassiniPosAt` 在锚定窗口边缘 1800 s 内按 smoothstep 混回主轨迹折线（边缘处逐位贴合，中段保持亚顶点平滑）；③ **日心轨迹与行星锚定相对轨迹两套参考系叠加**（相对轨迹随行星当前位置剪切，地球窗口 58.5 h 内剪切偏移达数千 km 且随回放增长），两条「已飞轨迹」在飞船处大角相交并各自伸向不同方向——窗口激活（k>0）时日心轨迹已飞/未来段在窗口时间域内让位（k→0 出离时按比例回补、日心尾迹按 (1−k) 交叉淡出），窗口内由相对轨迹独家呈现，与 NASA Eyes 语义一致。

## 目录结构

```
index.html        入口
css/  js/         界面样式与逻辑
lib/              Three.js r147 及加载器（GLTF / Draco）
data/             烘焙产物（历表、姿态、模型、贴图、星表）
textures/         源贴图（打包进 data/textures.js）
tools/            数据管线（Python / PowerShell，可复现全部 data/）
```

## 数据管线

主要数据由 SPICE 内核烘焙（精度最高），其余资源由各专用脚本生成：

```bash
# ① 历表与姿态（主链路）
python tools/bake_spice.py         # SPICE 内核 → data/cassini_data.js + moons_data.js
python tools/fetch_attitude.py     # 下载真实姿态四元数（eyes.nasa.gov dynamo）
python tools/bake_attitude.py      # 抽稀+校验 → data/attitude_data.js

# ② 模型 / 贴图 / 星表
powershell tools/fetch_models.ps1  # 下载 NASA Eyes 官方 Cassini 模型
python tools/build_models.py       # 打包为自包含 GLB → data/models.js
python tools/build_textures.py     # 行星贴图 → data/textures.js
python tools/build_stars.py        # 星表 + 银河带 → data/stars.js

# ③ 备用链路（dynamo 历表，未走 SPICE 时使用）
python tools/fetch_data.py         # 下载 eyes.nasa.gov dynamo 历表
python tools/bake_data.py          # 圆锥曲线重构 → data/cassini_data.js
```

校验脚本：`tools/smoke_huy.py`、`tools/xcheck_*.py`、`tools/verify_huygens_*.js`、
`tools/verify_frontend_data.js`（Node，复刻前端解码/映射/插值/锚定轨道，34 项断言）、
`tools/repro_traj_bug.js`（任意时刻的 marker/轨迹/天体几何复现）。
相关报告见 `tools/XCHECK_REPORT.md`、`tools/FLYBY_FIX_REPORT.md`。
