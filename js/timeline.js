/* timeline.js — 时间轴：播放键行（日期 | 播放/暂停 | 时分秒）、规则倍率阶梯速率滑块（中点 = 1 SEC/S 实时，两侧 «/» 降/升档按钮）、总时间条（事件圆点叠加其上） */
(function () {
  'use strict';

  const state = {
    t: 0, tStart: 0, tEnd: 1,
    playing: false, ips: 1,       // ips 带符号：负 = 反向播放；默认 1 秒/秒（实时）
  };

  let el = {};
  let onChange = null;

  /* 规则倍率阶梯（中点 = 1 SEC/S 实时正放）：右侧 23 档 =
     2,4,10,30 秒 | 1,2,4,10,30 分 | 1,2,4,10 时 | 1,2,4 天 | 1,2 周 | 1,2,5 月 | 1,2 年；
     左侧为同一序列的镜像，但去掉末档 2 年（最快倒放 1 YR/S）并补上首档 −1 SEC/S ——
     两侧各 23 档（共 47 档，奇数），1 SEC/S 恰为第 24 档 = 滑块正中；«/» 按钮在阶梯上移一档 */
  const UNIT_SEC = { SEC: 1, MIN: 60, HR: 3600, DAY: 86400, WK: 604800, MO: 2592000, YR: 31536000 };
  const LADDER = [
    [1, 'SEC'], [2, 'SEC'], [4, 'SEC'], [10, 'SEC'], [30, 'SEC'],
    [1, 'MIN'], [2, 'MIN'], [4, 'MIN'], [10, 'MIN'], [30, 'MIN'],
    [1, 'HR'], [2, 'HR'], [4, 'HR'], [10, 'HR'],
    [1, 'DAY'], [2, 'DAY'], [4, 'DAY'],
    [1, 'WK'], [2, 'WK'],
    [1, 'MO'], [2, 'MO'], [5, 'MO'],
    [1, 'YR'],
  ];
  const RATE_EDGE = LADDER.length;   // 滑块两端档位 = ±23（左 23 档含 −1 SEC/S，右 23 档到 2 YR/S）
  const LADDER_R = LADDER.slice(1).concat([[2, 'YR']]);   // 正放 23 档：2 SEC/S … 2 YR/S

  function init(opts) {
    onChange = opts.onChange;
    state.tStart = opts.tStart;
    state.tEnd = opts.tEnd;
    state.t = opts.tStart;

    el.play = document.getElementById('play-btn');
    el.rate = document.getElementById('rate-slider');
    el.rateDown = document.getElementById('rate-down');
    el.rateUp = document.getElementById('rate-up');
    el.rateLabel = document.getElementById('rate-label');
    el.slider = document.getElementById('slider-wrap');
    el.progressL = document.getElementById('progress-left');
    el.progressR = document.getElementById('progress-right');
    el.marks = document.getElementById('slider-marks');
    el.handle = document.getElementById('slider-handle');
    el.dateMain = document.getElementById('time-date');
    el.dateHm = document.getElementById('time-hm');

    el.play.addEventListener('click', togglePlay);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.target.closest('input,textarea')) {
        e.preventDefault(); togglePlay();
      }
    });

    // 规则倍率阶梯滑块：中点 0 = 1 秒/秒（实时正放）；左半倒放、右半正放，
    // 每格 = 阶梯上一档（1/2/4/10/30… 规则倍率，非等比）；« / » 按钮每按一次降 / 升一档
    el.rate.value = '0';
    el.rate.addEventListener('input', () => {
      setRateValue(parseInt(el.rate.value, 10) || 0);
    });
    el.rateDown.addEventListener('click', () => setRateValue((parseInt(el.rate.value, 10) || 0) - 1));
    el.rateUp.addEventListener('click', () => setRateValue((parseInt(el.rate.value, 10) || 0) + 1));
    setRateValue(0);

    let drag = false;
    const setFromEvent = (e) => {
      if (e.target && e.target.closest && e.target.closest('#play-btn')) return;
      const rect = el.slider.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      let k = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      state.t = state.tStart + k * (state.tEnd - state.tStart);
      if (onChange) onChange(state.t, 'drag');
    };
    el.slider.addEventListener('mousedown', (e) => { drag = true; setFromEvent(e); });
    window.addEventListener('mousemove', (e) => { if (drag) setFromEvent(e); });
    window.addEventListener('mouseup', () => { drag = false; });
    el.slider.addEventListener('touchstart', (e) => { drag = true; setFromEvent(e); }, { passive: true });
    el.slider.addEventListener('touchmove', (e) => { if (drag) setFromEvent(e); }, { passive: true });
    el.slider.addEventListener('touchend', () => { drag = false; });
  }

  function sliderToRate(v) {
    // 档位 v → 带符号速率（秒/秒）：0 = +1（实时正放）；v>0 查正放阶梯；v<0 查倒放镜像阶梯
    if (v > 0) { const e = LADDER_R[Math.min(v, LADDER_R.length) - 1]; return e[0] * UNIT_SEC[e[1]]; }
    if (v < 0) { const e = LADDER[Math.min(-v, LADDER.length) - 1]; return -e[0] * UNIT_SEC[e[1]]; }
    return 1;
  }
  function rateToSlider(r) {
    // sliderToRate 的逆映射：+1 → 0；正放查 LADDER_R、倒放查 LADDER 的精确档位（±23 处钳制）
    if (r === 1) return 0;
    const a = Math.abs(r);
    const idx = (arr) => {
      const i = arr.findIndex(e => e[0] * UNIT_SEC[e[1]] === a);
      return i >= 0 ? i : arr.length - 1;
    };
    return r > 1 ? idx(LADDER_R) + 1 : -(idx(LADDER) + 1);
  }
  function setRateValue(v) {
    v = Math.max(-RATE_EDGE, Math.min(RATE_EDGE, Math.round(v) || 0));
    el.rate.value = String(v);
    state.ips = sliderToRate(v);
    updateRateLabel();
  }

  function updateRateLabel() {
    const v = state.ips;
    // 始终显示真实速率（阶梯精确命中时用规则倍率文本，如 4 MIN/S、2 YR/S）
    const sign = v < 0 ? '−' : '';
    el.rateLabel.textContent = 'RATE ' + sign + rateText(Math.abs(v));
  }
  function rateText(a) {
    const hit = LADDER.concat(LADDER_R).find(e => e[0] * UNIT_SEC[e[1]] === a);
    if (hit) return hit[0] + ' ' + hit[1] + '/S';
    return speedText(a);   // 兜底：非阶梯值按量级格式化
  }
  function speedText(v) {
    if (v >= 31536000) return (v / 31536000).toFixed(v < 2 * 31536000 ? 1 : 0) + ' YR/S';
    if (v >= 2592000) return (v / 2592000).toFixed(v < 2 * 2592000 ? 1 : 0) + ' MO/S';
    if (v >= 604800) return (v / 604800).toFixed(v < 2 * 604800 ? 1 : 0) + ' WK/S';
    if (v >= 86400) return (v / 86400).toFixed(v < 2 * 86400 ? 1 : 0) + ' DAY/S';
    if (v >= 3600) return (v / 3600).toFixed(v < 2 * 3600 ? 1 : 0) + ' HR/S';
    if (v >= 60) return (v / 60).toFixed(v < 120 ? 1 : 0) + ' MIN/S';
    return Math.round(v) + ' SEC/S';
  }

  function togglePlay() {
    state.playing = !state.playing;
    el.play.classList.toggle('playing', state.playing);
  }
  function setPlaying(p) {
    state.playing = p;
    el.play.classList.toggle('playing', p);
  }

  function addEventMarks(events, onPick) {
    events.forEach(ev => {
      const m = document.createElement('div');
      m.className = 'mark';
      m.title = `${ev.title} · ${ev.utc.slice(0, 10)}`;
      const k = (ev.et - state.tStart) / (state.tEnd - state.tStart);
      m.style.left = (k * 100) + '%';
      m.addEventListener('click', (e) => { e.stopPropagation(); onPick(ev); });
      el.marks.appendChild(m);
      ev._mark = m;
    });
  }

  /* 跳转一律钳制到数据域 [tStart, tEnd]：事件表 et 为 UTC 秒且发射事件早于
   * 烘焙数据起点（~44 min），越域值会让 cassiniPosAt 沿首弦线性外推数万 km，
   * Cassini 脱离轨迹起点（即"后方时间点点击发射事件后位置偏移"） */
  function setNow(t) {
    state.t = Math.min(Math.max(t, state.tStart), state.tEnd);
  }
  function markPast(events, t) {
    events.forEach(ev => ev._mark && ev._mark.classList.toggle('past', ev.et <= t));
  }

  function tick(dtMs) {
    if (state.playing && state.ips !== 0) {
      state.t += state.ips * dtMs / 1000;
      if (state.t >= state.tEnd) { state.t = state.tEnd; setPlaying(false); }
      if (state.t <= state.tStart) { state.t = state.tStart; setPlaying(false); }
      if (onChange) onChange(state.t, 'play');
    }
    renderBar();
    updateDate();
  }

  function updateDate() {
    if (!el.dateMain) return;
    const d = new Date(946728000000 + (state.t - 65) * 1000);
    const p = (x, w = 2) => String(x).padStart(w, '0');
    el.dateMain.textContent = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    el.dateHm.textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  }

  /* 分段进度渲染：整条时间轴均分为左右两半，中央播放键为分界 */
  function renderBar() {
    const k = Math.max(0, Math.min(1, (state.t - state.tStart) / (state.tEnd - state.tStart)));
    el.progressL.style.width = (Math.min(1, k * 2) * 100) + '%';
    el.progressR.style.width = (Math.max(0, k * 2 - 1) * 100) + '%';
    el.handle.style.left = (k * 100) + '%';
  }

  function refresh() {
    renderBar();
    updateDate();
  }

  window.CassiniTimeline = {
    init, tick, refresh, addEventMarks, markPast, setNow, setPlaying,
    get state() { return state; },
  };
})();
