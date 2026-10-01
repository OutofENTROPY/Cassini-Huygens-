# Cassini–Huygens 任务轨迹 3D 可视化（1997–2017）

基于 NASA Eyes on the Solar System 同源历表数据，重现 Cassini–Huygens 探测器的完整飞行轨迹——VVEJ 引力弹弓与 13 年土星环绕。纯静态网页，完全离线可运行。

在线版：[cassini.otep.dpdns.org](https://cassini.otep.dpdns.org)

## 使用

双击 `index.html` 即可，无需服务器与网络，也可部署到任意静态托管。

- 鼠标：左键旋转 / 滚轮缩放 / 右键平移，点击天体标签平滑聚焦
- 时间轴：空格播放暂停，速率滑块（左倒放、右正放）
- 顶栏：未来轨迹与历史轨迹显隐，26 个任务事件节点点击跳转
- 深链接：`index.html#event=soi`、`index.html#date=2017-09-15`
- 移动端已适配

## 特性

- **真实数据**：NASA 历表烘焙；飞掠、发射逃逸与土星入轨的双曲线段以真实边界状态重构，与 SPICE 真值偏差 ≤2.2 万 km，任务终段延伸至 2017-09-15 坠入土星大气
- **参考系切换**：进入行星/卫星引力影响球（SOI）时自动叠加相对该天体的轨迹，Saturn 系统内支持土星 → 卫星两级参考系
- **飞船模型与姿态**：NASA 官方 Cassini–Huygens 模型，2004 年惠更斯分离后自动切换；高增益天线按任务阶段真实定向（默认对地通信、SOI 点火与 Grand Finale 防尘盾朝前、惠更斯下降期间指向 Titan 中继）
- **渲染**：真实星表天空球与银河带、行星大气与云层、真实行星/卫星贴图、四颗气态行星星环、行星本影熄光、真实比例

## 已知问题

- **木星飞掠深度偏差**：源数据在木星附近仅有 3 个关键帧，插值导致近掠"削角"——轨迹最近距离约 1,066 万 km，任务实录约 979 万 km（2000-12-30）。转弯角、轨道面与出入 SOI 状态均正确，属源数据精度限制。

## 目录结构

```
index.html        入口
css/  js/         界面样式与逻辑
lib/              Three.js r147 及加载器
data/             烘焙产物（历表、模型、贴图、星表）
tools/            数据管线（Python + PowerShell，可复现全部 data/）
```

## 数据管线

```bash
python tools/fetch_data.py         # 从 eyes.nasa.gov 下载历表（需网络）
python tools/bake_data.py          # 解析/重构 → data/cassini_data.js + data/moons_data.js
python tools/build_stars.py        # 星表 + 银河带 → data/stars.js
python tools/build_textures.py     # 行星贴图 → data/textures.js
powershell tools/fetch_models.ps1  # 下载 NASA 官方 GLB
python tools/build_models.py       # 打包模型 → data/models.js
```
