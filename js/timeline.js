/* timeline.js — 时间轴：播放键行（日期 | 播放/暂停 | 时分秒）、对数速率滑块、总时间条（事件圆点叠加其上） */
(function () {
  'use strict';

  const state = {
    t: 0, tStart: 0, tEnd: 1,
    playing: false, ips: 1,       // ips 带符号：负 = 反向播放；默认 1 秒/秒（实时）
  };

  let el = {};
  let onChange = null;

  const RATE_MAX = 31536000;   // 1 年/秒
  const LOG_MAX = Math.log10(RATE_MAX);

  function init(opts) {
    onChange = opts.onChange;
    state.tStart = opts.tStart;
    state.tEnd = opts.tEnd;
    state.t = opts.tStart;

    el.play = document.getElementById('play-btn');
    el.rate = document.getElementById('rate-slider');
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

    // 双向对数速率滑块：中点 0 = HOLD，右侧正向，左侧反向；默认 1 秒/秒（滑块最小档，紧贴中点）
    el.rate.value = '1';
    el.rate.addEventListener('input', () => {
      state.ips = sliderToRate(parseFloat(el.rate.value));
      updateRateLabel();
    });
    state.ips = sliderToRate(1);
    updateRateLabel();

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

  function sliderToRate(s) {
    // 中点 0 = HOLD；|s| ∈ [1, 1000] 对数映射到 [1 秒/秒, 1 年/秒]；左半为负（反向）
    const a = Math.abs(s);
    if (a < 1) return 0;
    const v = Math.pow(10, LOG_MAX * ((a - 1) / 999));
    return s > 0 ? v : -v;
  }
  function rateToSlider(v) {
    // sliderToRate 的逆映射：1 秒/秒 → 1，1 年/秒 → 1000，|v| < 1 → HOLD(0)
    const m = Math.min(RATE_MAX, Math.abs(v));
    if (m < 1) return 0;
    const s = 1 + 999 * (Math.log10(m) / LOG_MAX);
    return Math.round(v < 0 ? -s : s);
  }

  function updateRateLabel() {
    const v = state.ips;
    if (Math.abs(v) < 1) { el.rateLabel.textContent = 'RATE HOLD'; return; }
    const sign = v < 0 ? '−' : '';
    el.rateLabel.textContent = 'RATE ' + sign + speedText(Math.abs(v));
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

  function setNow(t) { state.t = t; }
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
