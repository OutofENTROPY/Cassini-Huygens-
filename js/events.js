/* events.js — Cassini–Huygens 任务事件时间线（专业术语 · 26 个节点）
 * utc 均为 UTC；et = ET 秒（相对 J2000，TDB≈UTC 差 <90s，对可视化无影响）
 * focus: 事件聚焦天体；zoom: 建议镜头距离 (km)
 */
(function () {
  'use strict';

  function et(utc) {
    return (Date.parse(utc) - 946728000000) / 1000;
  }

  const EVENTS = [
    { id: 'launch', utc: '1997-10-15T08:43:00Z', title: '发射 (Launch)', body: 'earth', zoom: 42000,
      text: 'Cassini–Huygens 由 Titan IVB/半人马座运载火箭自 Florida 卡纳维拉尔角 LC-40 发射入轨。探测器由轨道器 Cassini 与 Huygens 着陆器组成，进入 6.8 年的地—金—木—土 (VVEJ) 转移序列。' },
    { id: 'venus1', utc: '1998-04-26T13:45:00Z', title: '第一次 Venus 引力弹弓飞掠', body: 'venus', zoom: 30000,
      text: 'Cassini 以约 286 km 高度掠过 Venus，借助行星引力获得约 4 km/s 的速度增量并改变轨道面。此为 VVEJ 转移序列的第一次行星近掠 (Venus-1)。' },
    { id: 'dsm', utc: '1998-12-03T04:00:00Z', title: '深空机动 (DSM)', body: 'cassini', zoom: 8000,
      text: '两次 Venus 近掠之间，主发动机点火约 85 分钟，实施 Δv≈450 m/s 的深空机动 (Deep Space Maneuver)，将近日点压低，使第二次 Venus 近掠能够将探测器轨道指向 Earth——该机动是后续 Earth 引力弹弓的先决条件。' },
    { id: 'venus2', utc: '1999-06-24T20:30:00Z', title: '第二次 Venus 引力弹弓飞掠', body: 'venus', zoom: 30000,
      text: 'Cassini 以约 620 km 高度第二次近掠 Venus (Venus-2)。此前多次轨道修正机动 (TCM) 将瞄准点控制在公里级，使探测器得以返回 Earth 引力影响球。' },
    { id: 'earth', utc: '1999-08-18T03:28:00Z', title: 'Earth 引力弹弓飞掠', body: 'earth', zoom: 26000,
      text: 'Cassini 以 1,171 km 高度飞掠 Earth 南太平洋上空，获得约 5.5 km/s 引力增速，达到抵达外太阳系所需能量。此为最后一次内太阳系近掠，此后进入外行星转移轨道。' },
    { id: 'asteroid', utc: '2000-01-23T10:00:00Z', title: '远距观测小行星 2685 Masursky', body: 'cassini', zoom: 3000000,
      text: '转移途中 Cassini 于约 160 万公里距离对主带小行星 2685 Masursky 成像，通过光变曲线间接估算了其尺寸与质量。' },
    { id: 'jupiter', utc: '2000-12-30T15:05:00Z', title: 'Jupiter 引力弹弓飞掠', body: 'jupiter', zoom: 15000000,
      text: 'Cassini 以约 972 万 km 距离飞掠 Jupiter（2000-12-30 15:05 UTC 最近），获得进入 Saturn 拦截轨道所需的最后一段能量与轨道面调整。近掠期间与 Galileo 号实施磁层联合观测，并完成了当时分辨率最高的 Jupiter 大气全球成像。' },
    { id: 'phoebe', utc: '2004-06-11T19:33:00Z', title: 'Phoebe 近掠', body: 'saturn', zoom: 500000,
      text: '抵达 Saturn 前，Cassini 以 2,068 km 距离飞掠不规则卫星 Phoebe（土卫九），确认其为被捕获的半人马型天体，并完成冰质表面与陨击地貌的全球测绘。' },
    { id: 'soi', utc: '2004-07-01T02:48:00Z', title: '土星轨道切入点火 (SOI)', body: 'saturn', zoom: 700000,
      text: '主发动机点火 96 分钟，Δv≈626 m/s，Cassini 自土星主环 F 环与 G 环之间的间隙穿越环面，被 Saturn 引力捕获成为人造卫星。此次捕获点火 (Saturn Orbit Insertion) 是任务最关键的轨道机动。' },
    { id: 'titan_ta', utc: '2004-10-26T15:30:00Z', title: '第一次 Titan 近掠 (Ta)', body: 'titan', zoom: 120000,
      text: 'Cassini 首次以 1,174 km 距离近掠 Titan（土卫六）。雷达与成像科学子系统 (ISS) 穿透其浓密氮—甲烷大气，首次揭示比水星更大的卫星表面。' },
    { id: 'titan_tb', utc: '2004-12-13T11:38:00Z', title: '第二次 Titan 近掠 (T-B)', body: 'titan', zoom: 120000,
      text: '以 1,200 km 距离近掠 Titan (T-B)，一方面为 Huygens 分离与进入轨道做最后的轨道调整（瞄准机动），同时对 Titan 高纬湖面疑似特征进行雷达成像。' },
    { id: 'huygens_sep', utc: '2004-12-25T02:00:00Z', title: 'Huygens 探测器分离', body: 'huygens', zoom: 30,
      text: 'Huygens 着陆器由弹簧分离机构（Spin Eject Device）以约 0.35 m/s 的相对速度弹射分离，并被赋予 7 rpm 自旋稳定，进入 20 天的被动巡航，弹道对准 Titan 大气进入走廊。分离漂移按 NAIF 重构星历实时渲染：sep+1h 相距约 1.4 km、约 7 小时后相距 10 km，此后两器沿各自真实轨迹独立飞行（可分别聚焦跟随）。' },
    { id: 'iapetus', utc: '2004-12-31T18:45:00Z', title: 'Iapetus 近掠', body: 'iapetus', zoom: 80000,
      text: 'Cassini 以约 122,940 km 距离飞掠 Iapetus（土卫八），确认其全球亮度二分性与赤道山脊的构造成因。' },
    { id: 'huygens_entry', utc: '2005-01-14T09:06:00Z', title: 'Huygens 进入并着陆 Titan', body: 'huygens', zoom: 120000,
      text: 'Huygens 以约 1,270 km 高度进入 Titan 大气（09:06 UTC），历经 2 小时 27 分钟的气动减速—降落伞下降，于约 11:30 UTC 着陆于一片含液态烃的湿沙平原，着陆后继续工作 72 分钟直至失联，返回了人类探测器在外太阳系唯一一次着陆的 350 余幅影像与大气剖面。' },
    { id: 'enceladus_e1', utc: '2005-02-17T19:48:00Z', title: 'Enceladus 首次近掠 (E-1)', body: 'enceladus', zoom: 60000,
      text: 'Cassini 以 1,167 km 距离首次近掠 Enceladus（土卫二）。磁强计探测到异常的磁层扰动，指示该卫星存在大气——后续观测将确认其来源为南极冰羽流。' },
    { id: 'enceladus1', utc: '2005-07-14T19:30:00Z', title: 'Enceladus 南极近掠 (E-4)', body: 'enceladus', zoom: 60000,
      text: '以 173 km 距离飞掠 Enceladus 南极，红外与紫外谱仪直接记录了喷发的冰晶羽流，离子与中性粒子质谱仪 (INMS) 首次采样其成分——一颗存在冰下海洋与低温喷口活动的活动卫星由此确认。' },
    { id: 'rhea', utc: '2005-11-26T22:46:00Z', title: 'Rhea 近掠', body: 'rhea', zoom: 80000,
      text: 'Cassini 以约 500 km 距离近掠 Rhea（土卫五），获得其高分辨率全球地质图与大气搜索数据，并检验其可能存在的稀疏环带迹象。' },
    { id: 'enceladus_e3', utc: '2008-03-12T19:06:00Z', title: 'Enceladus 羽流近掠 (E-3)', body: 'enceladus', zoom: 60000,
      text: '延展任务期间以约 52 km 超低高度穿越 Enceladus 南极羽流区，宇宙尘分析仪 (CDA) 与 INMS 联合测量羽流中冰粒与有机分子的丰度剖面，约束冰下海洋的化学环境。' },
    { id: 'equinox_mission', utc: '2008-07-01T00:00:00Z', title: '延展任务一：Equinox 分点任务开始', body: 'saturn', zoom: 900000,
      text: '主任务 (Prime Mission) 四年结束，任务延长为 Equinox 分点任务 (2008–2010)，目标转向季节演化、Saturn 磁层与土卫系统随太阳经度的变化。' },
    { id: 'equinox_passage', utc: '2009-08-11T00:00:00Z', title: 'Saturn 春分点 (Equinox)', body: 'saturn', zoom: 900000,
      text: '太阳过 Saturn 赤道面，环平面正对太阳、环粒投影阴影消失。Cassini 借此照明几何发现了环内垂直起伏数公里的结构、卫星 Daphnis 引发的环缘波，以及季节性大气环流突变。' },
    { id: 'solstice_mission', utc: '2010-10-01T00:00:00Z', title: '延展任务二：Solstice 至日任务开始', body: 'saturn', zoom: 900000,
      text: 'Equinox 任务结束，任务再度延长至北半球夏至 (Solstice, 2017 年 5 月)，覆盖半个 Saturn 年的季节演化观测，并规划了任务终段的 Grand Finale 轨道。' },
    { id: 'day_earth_smiled', utc: '2013-07-19T21:27:00Z', title: '"The Day the Earth Smiled" 日蚀成像', body: 'saturn', zoom: 900000,
      text: 'Cassini 转入 Saturn 阴影内，利用行星遮挡太阳的几何条件对背光环系超广角成像，并拍下从土星系统回望的 Earth 与 Moon——这次全环马赛克成像是任务最具标志性的科学影像之一。' },
    { id: 'enceladus_plume', utc: '2015-10-28T15:22:00Z', title: 'Enceladus 羽流深穿 (E-21)', body: 'enceladus', zoom: 60000,
      text: 'Cassini 以 49 km 距离直接穿越 Enceladus 南极羽流。INMS 检出 H₂ 分子丰度异常，表明冰下深海存在活跃的水热化学过程——这是天体生物学意义上最关键的单一测量之一。' },
    { id: 'titan_last', utc: '2017-04-22T08:55:00Z', title: '最后一次 Titan 近掠 (T-126)', body: 'titan', zoom: 120000,
      text: '第 127 次也是最后一次 Titan 近掠。此次引力弹弓将轨道近地点压入土星主环内侧，把 Cassini 送入 Grand Finale 轨道——Titan 以最后一次近掠完成了对任务终段的轨道接力。' },
    { id: 'grand_finale', utc: '2017-04-26T09:22:00Z', title: 'Grand Finale：首次环缝俯冲', body: 'saturn', zoom: 1400000,
      text: 'Cassini 首次穿越 Saturn 与主环之间约 2,000 km 宽的环缝（共 22 次），以原位测量获取行星重力场、磁场、大气成分与环粒子环境，刷新了 Saturn 系统的内域认知。' },
    // 终段时刻取烘焙轨迹的末段（数据止于 10:40 UTC，Cassini 贴着大气顶 ~3,300 km
    // 俯冲）：事件卡跳转后放大到模型大小即可看到土星大气散射的真实观感；
    // 真实 entry interface 为 11:54 UTC，数据不含该时刻，沿用会落到外推直线段
    { id: 'final', utc: '2017-09-15T10:40:00Z', title: '受控再入 Saturn 大气 (Final Entry)', body: 'saturn', zoom: 900000,
      text: '为满足行星保护要求（避免污染可能宜居的 Enceladus 与 Titan），Cassini 以约 122,000 km/h 受控再入 Saturn 大气，天线保持对地直至烧毁。13 年环绕、294 次绕飞、约 49.2 万幅影像，任务终段结束。' },
  ];

  for (const ev of EVENTS) ev.et = et(ev.utc);
  EVENTS.sort((a, b) => a.et - b.et);

  window.MISSION_EVENTS = EVENTS;
})();
