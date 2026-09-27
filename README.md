# Cassini–Huygens 历史飞行数据 — 3D 轨迹可视化 (1997–2017)

一个**完全离线**的静态网页：以 NASA Eyes on the Solar System 同源的**真实历表数据**，重现 Cassini–Huygens 探测器 1997–2017 年的完整飞行轨迹（VVEJ 引力弹弓序列 + 13 年真实土星环绕）。

**在线版已部署于 [cassini.otep.dpdns.org](https://cassini.otep.dpdns.org)**（Cloudflare Pages，与本仓库同步）。

## 使用

**双击 `index.html` 即可**（无需服务器、无需网络），也可直接部署到 Cloudflare Pages /
GitHub Pages 等静态托管（最大单文件 19.6 MB < 25 MiB 限制；data_raw/ 已被 .gitignore 排除）。

- 左键拖动旋转，滚轮缩放（从 130 亿公里全局视角到 20 米级飞船特写）
- 右键拖动平移；点击行星/卫星标签**平滑过渡**聚焦
- 底部时间轴（上行：播放 / 日期 / 速率 / 时间条；下行：任务事件刻度）；空格播放/暂停
- 速率滑块：中点保持，**左=倒放、右=正放**（对数刻度，实时 → 1 年/秒，中间有分割线）
- 顶栏轨迹开关：**未来轨迹**显隐、**近期 / 全部历史轨迹**切换
- 时间轴菱形与右侧"任务事件"面板提供 **26 个任务节点**（发射、Venus/Earth/Jupiter 引力弹弓、
  深空机动、SOI 捕获点火、Titan 近掠序列、Huygens 分离/着陆、Enceladus 羽流穿越、
  Grand Finale 环缝俯冲、受控再入……），点击跳转并展示说明
- 深链接：`index.html#event=soi`、`index.html#date=2017-09-15` 可直达任意事件/日期

## 引力影响球（SOI）参考系

Cassini 进入行星**真实**引力影响球（SOI 半径：Venus 61.9 万 km / Earth 92.5 万 km /
Jupiter 4,820 万 km / Saturn 5,450 万 km）时，自动淡入显示**相对该行星的轨迹**
（NASA Eyes 同样行为），日心轨迹**同步降低亮度**；日心轨迹与相对轨迹的**交点即
Cassini 实际位置**（逐点零偏差：烘焙端 rel = 最终日心轨迹 − 运行时插值行星位置，
前端把相对轨迹锚定在行星模型位置上，anchor + rel ≡ 日心轨迹顶点）；离开影响球后
相对轨迹按距离淡出自动隐藏、日心轨迹恢复亮度，全程无突变。土星环绕段全程位于
SOI 内，相对轨迹持续显示；1997 发射段提供相对 Earth 的轨迹。

**两级参考系**（Saturn 系统内）：Cassini 进一步进入卫星 Laplace SOI
（Titan 4.33 万 km / Iapetus 2.25 万 km / Rhea 3,675 km / Dione 1,953 km /
Enceladus 490 km 等）时，日心轨迹**再次**降亮、一级（土星）相对轨迹降亮，
**二级（卫星）相对轨迹淡入**——覆盖任务全程 126 次 Titan、14 次 Enceladus、
4 次 Rhea、5 次 Dione SOI 穿越与 2007 Iapetus 近掠；离开后逐级恢复亮度。

## 引力弹弓段轨道数据重构（patch 窗口方案）

dynamo 巡航腿（sun/N）与飞掠双曲线在行星近旁**互为镜像**：距离剖面几乎相同
（半径差 <1%）但方位相反，位置以 ~32 km/s 线性分离。因此旧方案在 SOI 边界做
位置混合会产生数十万公里级的侧向摆动，且巡航弧自身深入 SOI（V1 570k km），
造成"进入→弹出→再进入"的锯齿。现行方案（bake_data.py `rebuild_flyby`）：

1. **双曲线权威窗口** |conic| < 2.5×SOI：窗口内日心轨迹 = planet + 飞掠腿近拱点
   根数外推的双曲线（近掠距离恢复真实值），SOI 穿越单一干净；
2. **外移漂移过渡**：2.5×SOI 之外按 δ/2.5 km/s 半宽（钳制 2–10 天）混合回巡航腿
   ——两弧半径几乎相等，混合表现为沿近圆弧的缓慢侧向漂移（≤ ~5 km/s ≪ 真实
   ~30 km/s），观感为平滑的借力离场而非折角/摆动。

dynamo 中没有木星飞掠腿，木星近掠沿用 sun/4 巡航腿（与 NASA Eyes 同源同表现，
最近点 ~1,066 万 km，较实录 972 万 km 偏 ~10%，无锯齿）。

## 飞船模型与姿态

- **NASA 官方 3D 模型**（[NASA-3D-Resources · Cassini-Huygens (A)](https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/Cassini-Huygens%20(A))，
  GLB 经 base64 内嵌于 `data/models.js`，Draco 解码器预置离线加载，装载逻辑在 `js/cassini_model.js`）：
  - `Cassini-Huygens (A).glb` — 完整组合体（分离前）：4 m HGA 抛物面天线、金箔设备舱、
    RTG 桁架（3 台 GPHS-RTG）、磁强计双杆（跨距 17.98 m）、侧挂 Huygens 探测器
  - `Cassini-Huygens (A) (without Hyugens).glb` — **2004-12-25 分离后**自动切换的 Cassini 轨道器
  - `Cassini-Huygens (A) (without Cassini).glb` — 分离后独立飞行的 Huygens（φ2.7 m）
  - 体轴校准：GLB +Y(HGA) → 场景 +Z、GLB −Z(RTG) → +X；米制模型 1/1000 并入场景（km）
- **模型级微弱半球补光**：背光面保留结构可读性（暗部提亮，不影响行星光照）
- **始终真实尺寸**（全长 ~18 m）：缩小视角时模型随之缩小至真实大小，远距离由标记点接管
- **真实姿态**：高增益天线 (+Z) 按任务实际通信姿态由历表实时指向 Earth

## Huygens 分离与独立轨迹（真实 NASA 腿数据）

- 2004-12-25 02:00 UTC 分离：组合体模型切换为轨道器，Huygens 转入**独立轨迹**飞行
  （模型、三级轨迹线、标记与标签见 `js/huygens.js`；标签/事件卡点击可**视角跟随**）
- 轨迹为 **dynamo 真实腿数据**（`tools/bake_data.py` 烘焙自 `sc_huygens/saturn/orb`
  土星中心巡航腿——28 个根数关键帧、转移周期 31.9 天与真实 C 轨道一致——与
  `sc_huygens/titan/orb` Titan 中心进入双曲线）：
  - 巡航段（土星中心，20 天）→ 一级相对轨迹（Saturn SOI 内显示）
  - 进入段（Titan 中心真空双曲线，1,270 km 进入界面）+ 降落伞下降段
    （气动截断点切向连续的贝塞尔弧，ease-out 先快后慢）→ 二级相对轨迹
    （Titan SOI 内淡入；进入时绝对/一级轨迹同步降亮）
- 时间基准（NASA science.nasa.gov · Huygens Probe）：进入 09:06 UTC、下降 2h27m
  （约 11:30 UTC 着陆）、着陆后表面工作 72 分钟——**失联（LOS）后自动移除**
  探测器模型/标记/标签，轨迹保留为已飞历史

## 行星朝向与自转

- 真实自转速率（IAU 恒星自转周期，含 Venus/Uranus 逆行）与潮汐锁定（月球、土星卫星同面朝向母星）
- 点击聚焦行星/卫星时左上角显示**朝向与自转状态面板**：自转周期、方向、轴倾角、
  当前自转角（西经，实时刷新）

## 渲染真实性

- **天空球**：真实星表（mag<6.5）渲染为圆滑星点云（点大小/亮度随星等、色温随 B-V 色指数），另铺一层固定种子的均匀暗星尘保证全天分布均匀；真实银道几何银河带烘焙为低亮度 equirect 背景球
- 太阳增亮（白核过曝观感）；地球**大气边缘光泽 + 云层**，Venus/Titan/Mars 大气边缘光
- 土星卫星程序化贴图按真实特征绘制（Titan 甲烷雾/Xanadu/暗沙海、Enceladus 虎纹、
  Iapetus 明暗二分 + 赤道山脊、亮射线坑等）
- 行星轨道线与行星模型**严格重合**（相位中心化椭圆 + 逐帧平移修正）
- 标签自动避让：大天体标签锚定在盘面上缘，被行星遮挡的标签自动隐藏
- 真实光照开关：开启后阴影处完全不反光；关闭模式环影保持余亮（不全黑），无过曝

## 数据来源与真实性

- 轨道与天体位置取自 **NASA Eyes on the Solar System** 的 dynamo 历表
  （`eyes.nasa.gov/assets/dynamic/dynamo/`），二进制格式（小端、轨道根数点集 +
  四元数定向）由其 pioneer 框架逆向解析。数据坐标系为 ICRF 赤道系（四元数存储顺序 (w,x,y,z)），
  烘焙时统一转换到黄道系。
- Cassini 轨迹按任务阶段分 9 段（地心发射段、4 段日心巡航、Venus×2/Earth 飞掠段、
  土星轨道段），与 NASA Eyes 完全同源；段边界 0 km 间隙。腿边界处两腿数据存在
  固有分歧（巡航腿与飞掠腿互为镜像，见上节）：飞掠段整体由 patch 窗口重构接管，
  仅保留 launch→sun/1、sun/4→saturn/orb 两处巡航腿交叉淡化。
- **卫星位置**：母星中心细网格 + 运行时 **Catmull-Rom 三次插值**（步长按
  "CR 弦差 ≤ ~15 km"选取：Mimas 1.5h / Enceladus 2h / Tethys 2.7h / Dione 3.75h /
  Rhea 5.7h，Titan/Iapetus/Moon 网格已足够），拆分输出 `data/moons_data.js`；
  烘焙端以逐位一致的 CR 复刻保证卫星 SOI 锚定零偏差。旧 12h 线性网格对 Mimas
  （周期 22.6h，低于奈奎斯特）的位置误差高达 ~20 万 km，为"Mimas 轨迹错误"根源。
- **卫星近掠加密**：土星段 2h 基础采样按"距卫星距离"分级重采样
  （<4 万 km→60s、<15 万 km→240s、窗口上限 900s）——dynamo 的 saturn/orb 腿在
  近掠处自带 ~16 min 根数密度，重采样后近掠几何恢复真实值（Ta 1,169 km、
  E-21 58 km 高度等，均与实录一致）；加密窗口整体替换 merged 对应区间。
- 土星轨道段对每次近拱点（含 Grand Finale 环缝俯冲与任务终段再入）按距离自适应
  加密到 4–12 分钟步长；2004-12-25 Huygens 分离前后加密到 5 分钟。
- 渲染严格真实比例：浮动原点 + 对数深度缓冲；轨迹线每帧按相机重定基准。

## 几何校验（bake_data.py 自动输出）

| 校验项 | 烘焙数据（渲染轨迹） | 任务实录 |
|---|---|---|
| 发射时 Cassini—Earth 距离 | 50,360 km | 停泊轨道 ✓ |
| 月地距离范围 | 356,224 — 406,542 km | 356,500 — 406,700 km ✓ |
| Venus-1 近掠 | 6,334 km @ 1998-04-26 13:45 | 6,337 km（286 km 高度）✓ |
| Venus-2 近掠 | 6,652 km @ 1999-06-24 20:30 | 6,656 km（620 km 高度）✓ |
| Earth 近掠 | 7,552 km @ 1999-08-18 03:29 | 7,550 km（1,171 km 高度）✓ |
| Saturn SOI 近拱 | 80,284 km @ 2004-07-01 02:39 | ~80,000 km ✓ |
| Titan Ta 近掠（加密后） | 1,169 km 高度 @ 2004-10-26 15:30 | 1,174 km ✓ |
| Enceladus E-21（加密后） | 58 km 高度 @ 2015-10-28 15:24 | 49 km @ 15:22 ✓ |
| 飞掠 SOI 穿越剖面 | 单一进出（V1/V2/Earth 各 2 次穿越） | 无锯齿 ✓ |
| SOI 相对轨迹 ∩ 日心轨迹 | 行星 ≤2 km；卫星 ≤0.004 km（f32 量化级） | 交点 = 实际位置 ✓ |

渲染轨迹的飞掠近掠距离来自飞掠腿近拱点根数（与任务实录一致）；事件卡中的精确
数字以任务实录为准。卫星 SOI 穿越次数（Titan 126 / Enceladus 14 / Rhea 4 /
Dione 5 / Iapetus 1；Tethys/Mimas 无 SOI 进入）与任务史一致。

## 已知问题

- 部分轨迹段（尤其是飞掠段与 SOI 边界附近的衔接）存在已知的渲染/插值 bug，
  将在将来版本修复；当前版本以整体几何校验（上表）为准。

## 目录结构与发布范围

```
index.html            入口
css/style.css         界面样式（NASA Eyes 风格底栏）
js/main.js            装配与主循环（含深链接解析、轨迹开关、天体数据面板）
js/scene.js           三维场景（浮动原点、两级 SOI 参考系切换、卫星 CR 轨迹、天空球、大气、环阴影、标签遮挡）
js/camera.js          镜头（单位球坐标偏移、平滑过渡聚焦、启动推近）
js/timeline.js        时间轴（对数速率滑块）
js/events.js          26 个任务事件（专业术语）
js/textures.js        小卫星程序化贴图（仿 NASA Eyes 特征）
js/cassini_model.js   NASA 官方 GLB 模型装载（base64 解析、Draco 离线预置、体轴校准）
js/huygens.js         Huygens 分离后独立轨迹（真实 dynamo 腿数据 + 三级轨迹 + LOS 移除 + 视角跟随）
lib/three.min.js      Three.js r147
lib/GLTFLoader.js     glTF 装载器（r147 examples 版）
lib/DRACOLoader.js    Draco 解码装载器（解码器经 data/models.js 离线预置）
data/cassini_data.js  烘焙历表（19.6 MB：行星 + 卡西尼轨迹 + SOI 相对轨迹 + Huygens 腿）
data/moons_data.js    卫星细网格（5.2 MB：Catmull-Rom 插值 + 密集根数关键帧）
data/models.js        NASA 官方 Cassini-Huygens GLB ×3 + Draco wasm（base64，6.2 MB）
data/textures.js      行星贴图 base64
data/stars.js         真实星表 + 银河带
data_raw/  textures/  原始历表与贴图素材（不入库/工具链输入；含 data_raw/models/ 原始 GLB）
tools/                数据管线（可复现）
```

### 上传 GitHub 的部分

仓库中包含（除 .gitignore 排除项外的全部内容）：

- **站点本体**：`index.html`、`css/`、`js/`、`lib/`、`data/`（所有 `data/*.js`
  均为 < 25 MB 的生成产物，直接入库保证 clone 即可用、GitHub Pages/Cloudflare
  Pages 可直接从仓库部署）
- **数据管线**：`tools/`（Python 脚本 + PowerShell 下载器，可从 NASA Eyes 重新生成全部数据）
- **工具链素材**：`textures/`（原始贴图与星表，供 `tools/build_textures.py` 等使用）

不入库（.gitignore 排除）：

- `data_raw/` — 原始历表（5733 个文件、12 MB，由 `tools/fetch_data.py` 重新下载）
- `__pycache__/`、`*.pyc`、`server.log` 等本地运行产物

### 部署到 Cloudflare Pages 的部分

Cloudflare Pages 按**静态站点**直接部署仓库根目录（无需构建）：

- **构建命令**：留空；**输出目录**：`/`（仓库根）
- 部署内容即站点本体：`index.html` + `css/` + `js/` + `lib/` + `data/`，
  其中 `data/`（约 42 MB 的历表、模型、贴图 base64）是页面运行所必需
- `tools/`、`textures/` 仅是数据管线输入，对线上站点无影响（可随仓库一起部署，也可
  在 Pages 项目中忽略）；`data_raw/` 不在仓库中，天然不会部署
- 自定义域：`cassini.otep.dpdns.org` 已绑定到该项目

## 数据管线（tools/）

```bash
python tools/fetch_data.py     # 从 eyes.nasa.gov 下载历表（需网络；含 sc_huygens 腿）
python tools/bake_data.py      # 解析/合成/重构/加密/校验 → data/cassini_data.js + data/moons_data.js
python tools/build_stars.py    # 真实星表 + 银河带 → data/stars.js
python tools/build_textures.py # 行星贴图 → data/textures.js
powershell tools/fetch_models.ps1                  # 下载 NASA 官方 GLB（需网络）→ data_raw/models/
python tools/build_models.py   # GLB + Draco wasm base64 → data/models.js
```

烘焙校验输出（bake_data.py 自动打印）：飞掠近掠距离、patch 窗口与过渡半宽、
卫星 SOI 穿越窗口统计、Huygens 巡航/进入段拼接差、腿边界连续性（全部 0 km 间隙）。
