import * as echarts from 'echarts';
import klineCache from './kline_cache.js';

const chartModule = (() => {
  const RANGE_LABELS = { 0: '今日', 7: '近7日', 30: '近1月', 365: '近1年', 1095: '近3年', 1825: '近5年' };

  let _range = 0;
  let _currency = 'cny';
  let _type = 'line';
  let _rawData = [];
  let _chart = null;
  let _chartEl = null;
  let _initialized = false;
  let _cacheInitialized = false;
  let _resizeObserver = null;
  let _echartsPromise = null;
  let _activationSeq = 0;
  let _httpFetch = null;
  let _log = async () => {};
  const _livePrices = { cny: null, usd: null };
  const _cleanupFns = [];

  function registerCleanup(fn) {
    if (typeof fn === 'function') _cleanupFns.push(fn);
    return fn;
  }

  function cleanup() {
    while (_cleanupFns.length) {
      const fn = _cleanupFns.pop();
      try { fn(); } catch (_) {}
    }
    if (_chart) {
      _chart.dispose();
      _chart = null;
    }
  }

  function _sym() {
    return _currency === 'usd' ? '$' : '¥';
  }

  function _src() {
    return klineCache.getBucketData(_currency, 'full');
  }

  function _todaySrc() {
    return klineCache.getBucketData(_currency, 'today');
  }

  function _recentSrc() {
    return klineCache.getBucketData(_currency, 'recent');
  }

  function _dark() {
    return document.body.getAttribute('data-theme') === 'dark';
  }

  function _palette() {
    return _dark() ? {
      text: '#eef3fb',
      sub: '#9aa7bb',
      subStrong: '#c5cedd',
      grid: 'rgba(255,255,255,0.06)',
      axis: 'rgba(255,255,255,0.14)',
      crosshair: 'rgba(148, 163, 184, 0.22)',
      up: '#e84057',
      down: '#26a69a',
      line: '#7fb0ff',
      lineGlow: 'rgba(83, 145, 255, 0.28)',
      lineSoft: 'rgba(127, 176, 255, 0.22)',
      tipBg: 'rgba(17,22,31,0.96)',
      tipBorder: 'rgba(255,255,255,0.08)',
      plotBgTop: 'rgba(74, 120, 255, 0.08)',
      plotBgBottom: 'rgba(74, 120, 255, 0.01)',
      areaTop: 'rgba(96, 148, 255, 0.24)',
      areaBottom: 'rgba(96, 148, 255, 0.02)',
      pointFill: '#10151d',
      pointStroke: '#8db8ff',
    } : {
      text: '#1c2430',
      sub: '#7d8797',
      subStrong: '#5d6777',
      grid: 'rgba(15,23,42,0.06)',
      axis: 'rgba(15,23,42,0.10)',
      crosshair: 'rgba(90, 102, 121, 0.18)',
      up: '#e84057',
      down: '#26a69a',
      line: '#0052d9',
      lineGlow: 'rgba(0, 82, 217, 0.16)',
      lineSoft: 'rgba(0, 82, 217, 0.16)',
      tipBg: 'rgba(255,255,255,0.98)',
      tipBorder: 'rgba(15,23,42,0.08)',
      plotBgTop: 'rgba(0, 82, 217, 0.05)',
      plotBgBottom: 'rgba(0, 82, 217, 0.01)',
      areaTop: 'rgba(0, 82, 217, 0.18)',
      areaBottom: 'rgba(0, 82, 217, 0.01)',
      pointFill: '#ffffff',
      pointStroke: '#0052d9',
    };
  }

  function _formatValue(value, digits = 2) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return num.toLocaleString('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function _lineSmooth() {
    if (_range === 0) return 0.22;
    if (_range === 7) return 0.18;
    if (_range === 30) return 0.16;
    return 0.12;
  }

  function _renderLivePrice() {
    const nameEl = document.getElementById('chart-commodity-name');
    const priceEl = document.getElementById('chart-price-display');
    const price = _livePrices[_currency];
    if (nameEl) nameEl.textContent = _currency === 'usd' ? '伦敦金' : '黄金延期';
    if (priceEl) {
      if (Number.isFinite(price)) {
        priceEl.textContent = `${_sym()}${_formatValue(price, 2)}`;
      } else {
        priceEl.innerHTML = `<span class="number-loading-dots" role="status" aria-label="行情加载中">
          <span class="number-loading-dot"></span>
          <span class="number-loading-dot"></span>
          <span class="number-loading-dot"></span>
        </span>`;
      }
    }
  }

  function _aggMins(data, mins) {
    if (!data.length || mins <= 1) return data;
    const map = new Map();
    data.forEach((r) => {
      const sp = r[0].split(' ');
      const tp = (sp[1] || '00:00').split(':').map(Number);
      const key = `${sp[0]} ${String(tp[0]).padStart(2, '0')}:${String(Math.floor(tp[1] / mins) * mins).padStart(2, '0')}`;
      if (!map.has(key)) map.set(key, [key, r[1], r[2], r[3], r[4], r[5] || 0]);
      else {
        const cur = map.get(key);
        cur[2] = Math.max(cur[2], r[2]);
        cur[3] = Math.min(cur[3], r[3]);
        cur[4] = r[4];
        cur[5] = (cur[5] || 0) + (r[5] || 0);
      }
    });
    return Array.from(map.values());
  }

  function _aggDays(data, n) {
    if (!data.length || n <= 1) return data;
    const result = [];
    for (let i = 0; i < data.length; i += n) {
      const chunk = data.slice(i, i + n);
      result.push([
        chunk[0][0],
        chunk[0][1],
        Math.max(...chunk.map((r) => r[2])),
        Math.min(...chunk.map((r) => r[3])),
        chunk[chunk.length - 1][4],
        chunk.reduce((sum, r) => sum + (r[5] || 0), 0),
      ]);
    }
    return result;
  }

  function _aggMonthly(data) {
    if (!data.length) return data;
    const map = new Map();
    data.forEach((r) => {
      const key = r[0].slice(0, 7);
      if (!map.has(key)) map.set(key, [key, r[1], r[2], r[3], r[4], r[5] || 0]);
      else {
        const cur = map.get(key);
        cur[2] = Math.max(cur[2], r[2]);
        cur[3] = Math.min(cur[3], r[3]);
        cur[4] = r[4];
        cur[5] = (cur[5] || 0) + (r[5] || 0);
      }
    });
    return Array.from(map.values());
  }

  function _dailyRange(days) {
    const src = _src().filter(Boolean);
    if (!src.length) return [];
    const cut = Date.now() - days * 86400000;
    return src.filter((r) => new Date(r[0]).getTime() >= cut);
  }

  function _recentRange(days) {
    const src = _recentSrc().filter(Boolean);
    if (!src.length) return [];
    const cut = Date.now() - days * 86400000;
    return src.filter((r) => new Date(r[0]).getTime() >= cut);
  }

  function _monthRange() {
    const daily = _dailyRange(30);
    const recent = _recentRange(30);
    if (!recent.length) return daily;

    const recentDays = new Set(recent.map((row) => String(row[0]).slice(0, 10)));
    return [
      ...daily.filter((row) => !recentDays.has(String(row[0]).slice(0, 10))),
      ...recent,
    ].sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
  }

  function _tradingDayStart(now = new Date()) {
    const start = new Date(now);
    if (start.getHours() < 6) start.setDate(start.getDate() - 1);
    start.setHours(6, 0, 0, 0);
    return start;
  }

  function _fmtDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function _normalizeTodayBars(data) {
    const bars = data.filter(Boolean);
    if (bars.length < 2) return bars.slice();
    const secondClose = Number(bars[1]?.[4]);
    if (!Number.isFinite(secondClose)) return bars.slice();
    const cloned = bars.map((row) => row.slice());
    cloned[0][1] = secondClose;
    cloned[0][2] = secondClose;
    cloned[0][3] = secondClose;
    cloned[0][4] = secondClose;
    return cloned;
  }

  function _todayStatus() {
    const start = _tradingDayStart();
    const startKey = `${_fmtDateKey(start)} 06:00`;
    const source = _todaySrc().filter(Boolean);
    const bars = source.filter((r) => r && r[0] >= startKey);
    const lastSourceBar = source[source.length - 1] || null;
    return {
      label: _fmtDateKey(start),
      sourceCount: source.length,
      lastSourceTime: lastSourceBar?.[0] || '',
      bars: _normalizeTodayBars(bars),
    };
  }

  function _filter(days) {
    if (days === 0) {
      return _aggMins(_todayStatus().bars, 10);
    }
    if (days === 7) {
      const recent = _recentSrc().filter(Boolean);
      return recent.length ? recent : _dailyRange(days);
    }
    if (days === 30) return _monthRange();
    if (days === 365) return _aggDays(_dailyRange(days), 2);
    if (days === 1095) return _aggDays(_dailyRange(days), 10);
    return _aggDays(_dailyRange(days), 21);
  }

  function _labelForDate(dateStr) {
    if (_range === 0) return dateStr.slice(11, 16);
    if (_range === 7) return dateStr.slice(5, 13);
    if (_range <= 30) return dateStr.slice(5, 10);
    return dateStr.slice(0, 7);
  }

  function _seriesPayload(raw) {
    const colors = _palette();
    const values = raw.map((r) => r[4]);
    const lastIndex = Math.max(raw.length - 1, 0);
    return {
      category: raw.map((r) => _labelForDate(r[0])),
      fullLabel: raw.map((r) => r[0]),
      candle: raw.map((r) => [r[1], r[4], r[3], r[2]]),
      line: values,
      volume: raw.map((r) => r[5] || 0),
      volumeColor: raw.map((r) => r[4] >= r[1] ? colors.up : colors.down),
      last: raw[raw.length - 1],
      first: raw[0],
      high: Math.max(...raw.map((r) => r[2])),
      low: Math.min(...raw.map((r) => r[3])),
      maxVol: Math.max(...raw.map((r) => r[5] || 0), 0),
      lastIndex,
      lineMin: Math.min(...values),
      lineMax: Math.max(...values),
    };
  }

  function _updateStats(raw) {
    const changeEl = document.getElementById('chart-change-display');
    const statsEl = document.getElementById('chart-mini-stats');
    _renderLivePrice();
    if (!raw.length) {
      if (changeEl) changeEl.textContent = '';
      if (statsEl) statsEl.innerHTML = '';
      return;
    }

    const last = raw[raw.length - 1][4];
    const first = raw[0][4];
    const delta = last - first;
    const sign = delta >= 0 ? '+' : '';
    const pct = first ? ((delta / first) * 100).toFixed(2) : '0.00';
    const hi = Math.max(...raw.map((r) => r[2]));
    const lo = Math.min(...raw.map((r) => r[3]));
    if (changeEl) {
      changeEl.innerHTML = `
        <span class="chg-pill ${delta >= 0 ? 'up' : 'down'}">${sign}${delta.toFixed(2)}</span>
        <span class="chg-pct ${delta >= 0 ? 'up' : 'down'}">${sign}${pct}%</span>
        <span class="chg-period">${RANGE_LABELS[_range] || ''}</span>`;
    }
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="mini-stat"><span class="mini-label">区间最高</span><span class="mini-val" style="color:var(--chart-up,#e84057)">${_sym()}${hi.toFixed(2)}</span></div>
        <div class="mini-stat"><span class="mini-label">区间最低</span><span class="mini-val" style="color:var(--chart-dn,#26a69a)">${_sym()}${lo.toFixed(2)}</span></div>`;
    }
  }

  function _tooltipFormatter(params) {
    if (!params || !params.length) return '';
    const primary = params.find((item) => item.seriesType === 'candlestick' || item.seriesType === 'line') || params[0];
    const idx = primary?.dataIndex;
    const row = _rawData[idx];
    if (!row) return '';
    const [date, open, high, low, close, volume] = row;
    const prevClose = idx > 0 ? _rawData[idx - 1][4] : close;
    const delta = close - prevClose;
    const sign = delta >= 0 ? '+' : '';
    const pct = prevClose ? ((delta / prevClose) * 100).toFixed(2) : '0.00';
    const c = _palette();
    return `
      <div style="min-width:152px;padding:1px 2px">
        <div style="font-size:10px;color:${c.sub};margin-bottom:7px;letter-spacing:.2px">${date}</div>
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-bottom:8px">
          <div style="font-size:18px;font-weight:800;letter-spacing:-.02em;color:${c.text}">${_sym()}${_formatValue(close, 2)}</div>
          <div style="font-size:11px;font-weight:700;color:${delta >= 0 ? c.up : c.down};white-space:nowrap">${sign}${_formatValue(delta, 2)} ${sign}${pct}%</div>
        </div>
        <div style="display:grid;grid-template-columns:auto auto;gap:4px 12px;font-size:10px;line-height:1.45">
          <span style="color:${c.sub}">开盘</span><span style="text-align:right;color:${c.subStrong}">${_sym()}${_formatValue(open, 2)}</span>
          <span style="color:${c.sub}">最高</span><span style="text-align:right;color:${c.up}">${_sym()}${_formatValue(high, 2)}</span>
          <span style="color:${c.sub}">最低</span><span style="text-align:right;color:${c.down}">${_sym()}${_formatValue(low, 2)}</span>
        </div>
      </div>`;
  }

  function _option(raw) {
    const c = _palette();
    const payload = _seriesPayload(raw);
    const isLine = _type !== 'candle';
    const minPad = Math.max((payload.lineMax - payload.lineMin) * 0.12, 0.2);
    return {
      animation: false,
      backgroundColor: 'transparent',
      grid: {
        left: 14,
        right: 12,
        top: 18,
        bottom: 28,
        containLabel: true,
      },
      graphic: isLine ? [{
        type: 'rect',
        left: 14,
        right: 12,
        top: 14,
        bottom: 28,
        silent: true,
        shape: { r: 18 },
        style: {
          fill: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: c.plotBgTop },
            { offset: 1, color: c.plotBgBottom },
          ]),
        },
      }] : undefined,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        borderWidth: 1,
        padding: [8, 10],
        backgroundColor: c.tipBg,
        borderColor: c.tipBorder,
        textStyle: { color: c.text },
        extraCssText: `border-radius:14px;box-shadow:${_dark() ? '0 18px 42px rgba(0,0,0,.34)' : '0 16px 36px rgba(15,23,42,.12)'};`,
        formatter: _tooltipFormatter,
      },
      axisPointer: {
        snap: true,
        lineStyle: { color: c.crosshair, width: 1, type: 'dashed' },
        label: { show: false },
      },
      xAxis: {
        type: 'category',
        data: payload.category,
        boundaryGap: _type === 'candle' ? true : ['2%', '4%'],
        axisLine: { lineStyle: { color: c.axis } },
        axisLabel: {
          color: c.sub,
          hideOverlap: true,
          margin: 12,
          fontSize: 11,
        },
        axisTick: { show: false },
        splitLine: { show: false },
        axisPointer: {
          show: true,
          label: { show: false },
        },
      },
      yAxis: {
        scale: true,
        position: 'right',
        splitNumber: 5,
        axisLine: { show: false },
        min: isLine ? (value) => value.min - minPad : null,
        max: isLine ? (value) => value.max + minPad : null,
        axisLabel: {
          color: c.sub,
          margin: 10,
          fontSize: 11,
          formatter: (value) => _formatValue(value, _currency === 'usd' ? 2 : 2),
        },
        splitLine: { lineStyle: { color: c.grid } },
        axisPointer: { show: true, label: { show: false } },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'filter', zoomLock: true },
      ],
      series: _type === 'candle' ? [
        {
          type: 'candlestick',
          data: payload.candle,
          itemStyle: {
            color: c.up,
            color0: c.down,
            borderColor: c.up,
            borderColor0: c.down,
          },
          progressive: 400,
        },
      ] : [
        {
          type: 'line',
          data: payload.line,
          smooth: _lineSmooth(),
          symbol: 'none',
          sampling: raw.length > 240 ? 'lttb' : undefined,
          lineStyle: {
            color: c.line,
            width: _range === 0 ? 2.6 : 2.4,
            cap: 'round',
            join: 'round',
            shadowColor: c.lineGlow,
            shadowBlur: 10,
            shadowOffsetY: 4,
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: c.areaTop },
              { offset: 0.7, color: c.areaBottom },
              { offset: 1, color: 'rgba(0,0,0,0)' },
            ]),
          },
          emphasis: {
            focus: 'series',
          },
          markPoint: {
            silent: true,
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: {
              color: c.pointFill,
              borderColor: c.pointStroke,
              borderWidth: 3,
              shadowColor: c.lineSoft,
              shadowBlur: 12,
            },
            label: { show: false },
            data: [
              { coord: [payload.category[payload.lastIndex], payload.line[payload.lastIndex]] },
            ],
          },
          progressive: 600,
        },
      ],
    };
  }

  function _showEmpty(message, options = {}) {
    const changeEl = document.getElementById('chart-change-display');
    const statsEl = document.getElementById('chart-mini-stats');
    const c = _palette();
    const title = options.title || message;
    const detail = options.detail || '';
    const badge = options.badge || '暂无数据';
    _renderLivePrice();
    if (changeEl) changeEl.textContent = '';
    if (statsEl) statsEl.innerHTML = '';
    if (_chart) {
      _chart.dispose();
      _chart = null;
    }
    if (_chartEl) {
      _chartEl.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;padding:24px;">
          <div style="width:min(420px,100%);padding:24px 26px;border-radius:22px;background:${c.tipBg};border:1px solid ${c.tipBorder};box-shadow:0 18px 40px rgba(0,0,0,.08);text-align:center;">
            <div style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:${_dark() ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'};color:${c.sub};font-size:12px;font-weight:700;letter-spacing:.3px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${_dark() ? '#f5c518' : '#d4900a'};"></span>
              ${badge}
            </div>
            <div style="margin-top:16px;font-size:24px;font-weight:800;letter-spacing:-.4px;color:${c.text};">
              ${title}
            </div>
            <div style="margin-top:10px;font-size:14px;line-height:1.7;color:${c.sub};">
              ${message}
            </div>
            ${detail ? `
              <div style="margin-top:18px;padding-top:16px;border-top:1px dashed ${c.tipBorder};font-size:12px;line-height:1.7;color:${c.sub};opacity:.9;">
                ${detail}
              </div>` : ''}
          </div>
        </div>`;
    }
  }

  function _ensureChart() {
    if (!_chartEl) _chartEl = document.getElementById('gold-chart');
    if (!_chartEl) return null;
    if (!_chart) {
      _chartEl.innerHTML = '';
      _chart = echarts.init(_chartEl, null, { renderer: 'canvas' });
    }
    return _chart;
  }

  function _loadECharts() {
    if (_echartsPromise) return _echartsPromise;
    _echartsPromise = Promise.resolve(echarts);
    return _echartsPromise;
  }

  function _nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function _waitForChartLayout() {
    if (!_chartEl) _chartEl = document.getElementById('gold-chart');
    if (!_chartEl) return false;
    for (let i = 0; i < 12; i++) {
      const rect = _chartEl.getBoundingClientRect();
      if (rect.width >= 80 && rect.height >= 120) return true;
      await _nextFrame();
    }
    return false;
  }

  async function render(days, currency, type) {
    if (days !== undefined) _range = days;
    if (currency !== undefined) _currency = currency;
    if (type !== undefined) _type = type;
    await _waitForChartLayout();
    const todayStatus = _range === 0 ? _todayStatus() : null;
    _rawData = _filter(_range);
    _updateStats(_rawData);
    if (!_rawData.length) {
      if (todayStatus) {
        _showEmpty('当前交易日窗口内暂未收到有效行情数据', {
          title: '行情数据同步中',
          badge: '暂无今日数据',
          detail: todayStatus.sourceCount
            ? `已读取今日数据 ${todayStatus.sourceCount} 条，最新时间 ${todayStatus.lastSourceTime || '未知'}，但没有匹配到 ${todayStatus.label} 06:00 之后的有效 K 线。`
            : `尚未读取到 ${todayStatus.label} 的今日 K 线数据，请稍后刷新。`,
        });
      } else {
        _showEmpty('当前时段暂无行情数据');
      }
      return;
    }
    const chart = _ensureChart();
    if (!chart) return;
    chart.setOption(_option(_rawData), true, true);
    chart.resize();
  }

  function _bindControls() {
    document.querySelectorAll('.chart-range-btn').forEach((btn) => {
      const handler = async () => {
        const nextRange = parseInt(btn.dataset.range, 10);
        document.querySelectorAll('.chart-range-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        await refreshData({ range: nextRange });
      };
      btn.addEventListener('click', handler);
      registerCleanup(() => btn.removeEventListener('click', handler));
    });

    document.querySelectorAll('.chart-currency-btn').forEach((btn) => {
      const handler = async () => {
        document.querySelectorAll('.chart-currency-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        _currency = btn.dataset.currency;
        await refreshData({ range: _range });
      };
      btn.addEventListener('click', handler);
      registerCleanup(() => btn.removeEventListener('click', handler));
    });

    document.querySelectorAll('.chart-type-btn').forEach((btn) => {
      const handler = () => {
        document.querySelectorAll('.chart-type-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        render(undefined, undefined, btn.dataset.type);
      };
      btn.addEventListener('click', handler);
      registerCleanup(() => btn.removeEventListener('click', handler));
    });

    const refreshBtn = document.getElementById('chart-refresh-btn');
    if (refreshBtn) {
      const handler = async () => {
        refreshBtn.classList.add('spinning');
        await refreshData({ force: true, range: _range });
        setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
      };
      refreshBtn.addEventListener('click', handler);
      registerCleanup(() => refreshBtn.removeEventListener('click', handler));
    }
  }

  function _build() {
    _chartEl = document.getElementById('gold-chart');
    if (!_chartEl) return;
    _bindControls();
    _resizeObserver = new ResizeObserver(() => {
      if (_chart) _chart.resize();
    });
    _resizeObserver.observe(_chartEl);
    registerCleanup(() => {
      _resizeObserver?.disconnect();
      _resizeObserver = null;
    });
  }

  async function refreshData(options = {}) {
    try {
      const nextRange = options.range ?? _range;
      if (options.range !== undefined) _range = options.range;
      await _loadECharts();
      await klineCache.refreshOnView(_currency, {
        forceRefresh: !!(options.forceRefresh || options.force),
        range: nextRange,
      });
      await render(nextRange);
    } catch (_) {
      _showEmpty('图表加载失败，请稍后重试');
    }
  }

  function onThemeChange() {
    if (_initialized) render();
  }

  async function onViewActivated() {
    const seq = ++_activationSeq;
    await _nextFrame();
    if (seq !== _activationSeq) return;
    if (!_cacheInitialized) {
      _cacheInitialized = true;
      await klineCache.init({ httpFetch: _httpFetch });
    }
    if (seq !== _activationSeq) return;
    if (!_initialized) {
      _initialized = true;
      _build();
    }
    await _waitForChartLayout();
    if (seq !== _activationSeq) return;
    await refreshData({ range: _range });
  }

  function disposeData() {
    _rawData = [];
    if (_chart) {
      _chart.dispose();
      _chart = null;
    }
    klineCache.disposeView();
  }

  function onViewDeactivated() {
    _activationSeq += 1;
    disposeData();
  }

  function updateLivePrice(price, market) {
    if (market !== 'cny' && market !== 'usd') return;
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) return;
    _livePrices[market] = value;
    if (market === _currency) _renderLivePrice();
  }

  function configure(options = {}) {
    _httpFetch = options.httpFetch || null;
    if (typeof options.logger === 'function') {
      _log = options.logger;
      klineCache.setLogger(options.logger);
    }
    klineCache.setHttpFetch(_httpFetch);
  }

  window.addEventListener('beforeunload', cleanup, { once: true });
  return { configure, onViewActivated, onViewDeactivated, onThemeChange, updateLivePrice, refreshData, disposeData };
})();

export { chartModule };
