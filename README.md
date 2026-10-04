# Cassini–Huygens 3D 轨迹可视化（1997–2017）

重现 Cassini–Huygens 的完整飞行历程——VVEJ 引力弹弓到 13 年土星环绕，直至 2017 年坠入土星大气。纯静态网页，完全离线可运行。

**在线版**：<https://cassini.otep.dpdns.org>

## 使用

双击 `index.html` 即可，无需服务器与网络。

| 操作 | 说明 |
|---|---|
| 左键拖动 / 滚轮 / 右键拖动 | 旋转 / 缩放 / 平移 |
| 点击行星、卫星标签 | 平滑聚焦该天体 |
| 空格 | 播放 / 暂停 |
| 时间条拖动、速率滑块 | 任意时刻回放 |
| 左上角 ◉ / 右上角 ⚙ | 状态卡、光照、轨迹与标签开关、视角切换 |
| 深链接 | `index.html#event=soi`　`index.html#date=2017-09-15` |

移动端（单指旋转、双指缩放）已适配。

## 特性

- **真实数据**：全部基于 NAIF SPICE 内核（Cassini -82 轨道重构 + 行星历表 + 卫星星历）直接采样烘焙，天体定位精度 ≤1 km，飞掠深度、转弯角等均与真值一致。
- **真实姿态**：来自 NASA Eyes / NAIF CK 的全程姿态四元数驱动模型定向，HGA 对地通信、SOI 点火、惠更斯中继、Grand Finale 等机动按实测序列呈现。
- **多层参考系**：进入行星或卫星引力影响球时，自动叠加相对该天体的轨迹，可按「日心 → 土星 → 卫星」切换视角。
- **惠更斯探测器**：分离、Titan 进入、降落伞下降与着陆全程回放，含真实自旋与挂点几何。
- **渲染**：真实星表天空球与银河带、真实行星/卫星贴图、大气与云层、行星环、行星本影熄光、真实比例。

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

```bash
# 历表与姿态
python tools/bake_spice.py         # SPICE 内核 → data/cassini_data.js + moons_data.js
python tools/fetch_attitude.py     # 下载真实姿态四元数（eyes.nasa.gov dynamo）
python tools/bake_attitude.py      # 抽稀+校验 → data/attitude_data.js

# 模型 / 贴图 / 星表
powershell tools/fetch_models.ps1  # 下载 NASA Eyes 官方 Cassini 模型
python tools/build_models.py       # 打包为自包含 GLB → data/models.js
python tools/build_textures.py     # 行星贴图 → data/textures.js
python tools/build_stars.py        # 星表 + 银河带 → data/stars.js
```

校验脚本见 `tools/`（含 `verify_frontend_data.js` 等），报告见 `tools/XCHECK_REPORT.md`、`tools/FLYBY_FIX_REPORT.md`。
