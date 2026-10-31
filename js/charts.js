/* ============================================================
 *  bill-analyzer · 无依赖 SVG 图表
 *  提供：趋势图 / 环形图 / 横向排行 / 日历热力图
 * ============================================================ */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /* XML 转义（HTML 内容与属性共用） */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function escapeXML(s) { return esc(s); }

  if (!global.Fmt) {
    global.Fmt = {
      money(v, dec) {
        const n = Number(v) || 0;
        const d = dec == null ? 2 : dec;
        return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
      },
      shortMoney(v) {
        const n = Math.abs(Number(v) || 0);
        if (n >= 100000000) return '¥' + (n / 100000000).toFixed(2) + '亿';
        if (n >= 10000) return '¥' + (n / 10000).toFixed(n >= 100000 ? 1 : 2) + '万';
        return this.money(n, n < 100 ? 2 : 0);
      },
      date(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      },
      month(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1);
      },
      pad
    };
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---------- tooltip ---------- */
  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, x, y) {
    const el = tip();
    el.innerHTML = html;
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%, -100%)';
    const rect = el.getBoundingClientRect();
    let left = x;
    if (left < rect.width / 2 + 6) left = rect.width / 2 + 6;
    if (left > window.innerWidth - rect.width / 2 - 6) left = window.innerWidth - rect.width / 2 - 6;
    el.style.left = left + 'px';
    el.style.top = Math.max(y - 10, rect.height + 8) + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.opacity = '0'; }

  function bindTip(root) {
    root.addEventListener('mouseover', e => {
      const t = e.target.closest('[data-tip]');
      if (!t) return;
      showTip(t.getAttribute('data-tip'), e.clientX, e.clientY);
    });
    root.addEventListener('mousemove', e => {
      const t = e.target.closest('[data-tip]');
      if (t) showTip(t.getAttribute('data-tip'), e.clientX, e.clientY);
    });
    root.addEventListener('mouseleave', hideTip);
  }

  /* ---------- 通用工具 ---------- */
  function empty(el, msg) {
    el.innerHTML = '<div class="chart-empty">' + msg + '</div>';
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const n = v / base;
    let m;
    if (n <= 1) m = 1; else if (n <= 2) m = 2; else if (n <= 2.5) m = 2.5;
    else if (n <= 5) m = 5; else m = 10;
    return m * base;
  }
  function axisTicks(max, h) {
    // 高度不足时减少刻度，避免文字挤在一起
    const segs = h && h < 170 ? 2 : (h && h < 240 ? 3 : 4);
    const ticks = [];
    for (let i = 0; i <= segs; i++) ticks.push(max * i / segs);
    return ticks;
  }

  /* ============================================================
   *  1. 趋势图：柱状（支出）+ 折线（收入）
   * ============================================================ */
  function trend(el, opts) {
    const data = (opts.data || []).filter(d => d.expense || d.income);
    el.classList.remove('bound');
    if (!data.length) { empty(el, '当前筛选条件下没有数据'); return; }

    const W = Math.max(el.clientWidth || 600, 320);
    const H = opts.height || 300;
    const pad = { l: 58, r: 16, t: 18, b: 34 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;

    const maxVal = Math.max(...data.map(d => Math.max(d.expense, d.income)));
    const max = niceMax(maxVal);
    const ticks = axisTicks(max, ih);

    const step = iw / data.length;
    const bw = Math.max(3, Math.min(26, step * 0.56));
    const x = i => pad.l + step * i + step / 2;
    const y = v => pad.t + ih - (v / max) * ih;

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" preserveAspectRatio="xMidYMid meet">';
    // 网格线
    ticks.forEach(t => {
      svg += '<line x1="' + pad.l + '" y1="' + y(t) + '" x2="' + (W - pad.r) + '" y2="' + y(t) +
        '" stroke="var(--grid)" stroke-width="1" stroke-dasharray="3 4"/>';
      svg += '<text x="' + (pad.l - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end" class="axis-text">' + tickLabel(t, max) + '</text>';
    });

    // 柱子（支出）：退款抵扣后可能为负，负值按 0 高度绘制
    data.forEach((d, i) => {
      const vv = Math.max(0, d.expense);
      const hgt = Math.max(1, ih - (ih - y(vv)));
      const yy = y(vv);
      svg += '<rect class="bar" x="' + (x(i) - bw / 2) + '" y="' + yy + '" width="' + bw + '" height="' + hgt +
        '" rx="3" fill="url(#gradExp)" data-tip="' +
        escapeAttr(d.label + '<br/>支出 ' + global.Fmt.money(d.expense) +
          (d.expense < 0 ? '（含退款抵扣）' : '')) + '"/>';
    });

    // 折线（收入）
    const pts = data.map((d, i) => x(i) + ',' + y(d.income)).join(' ');
    if (data.some(d => d.income > 0)) {
      svg += '<polyline points="' + pts + '" fill="none" stroke="#22c55e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      data.forEach((d, i) => {
        svg += '<circle cx="' + x(i) + '" cy="' + y(d.income) + '" r="3.2" fill="#22c55e" stroke="var(--surface)" stroke-width="1.5" data-tip="' +
          escapeAttr(d.label + '<br/>收入 ' + global.Fmt.money(d.income)) + '"/>';
      });
    }

    // x 轴标签
    const labelStep = Math.max(1, Math.ceil(data.length / Math.max(3, Math.floor(iw / 78))));
    data.forEach((d, i) => {
      if (i % labelStep !== 0 && i !== data.length - 1) return;
      svg += '<text x="' + x(i) + '" y="' + (H - pad.b + 18) + '" text-anchor="middle" class="axis-text">' + escapeXML(d.shortLabel || d.label) + '</text>';
    });

    svg += '<defs><linearGradient id="gradExp" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient></defs>';
    svg += '</svg>';

    el.innerHTML = svg;
    bindTip(el);
  }

  /* ============================================================
   *  2. 环形图
   * ============================================================ */
  function donut(el, opts) {
    const items = (opts.items || []).filter(i => i.value > 0).sort((a, b) => b.value - a.value);
    if (!items.length) { empty(el, '暂无分类数据'); return; }
    const size = opts.size || 220, thickness = opts.thickness || 30;
    const r = (size - thickness) / 2, cx = size / 2, cy = size / 2;
    const total = items.reduce((s, i) => s + i.value, 0);
    const top = items.slice(0, 9);
    const rest = items.slice(9);
    if (rest.length) {
      const sum = rest.reduce((s, i) => s + i.value, 0);
      top.push({ name: '其他', value: sum, color: '#9ca3af' });
    }

    let angle = -Math.PI / 2;
    let paths = '';
    top.forEach(it => {
      const frac = it.value / total;
      const a2 = angle + frac * Math.PI * 2;
      const large = a2 - angle > Math.PI ? 1 : 0;
      const p = [
        'M', cx + r * Math.cos(angle), cy + r * Math.sin(angle),
        'A', r, r, 0, large, 1, cx + r * Math.cos(a2), cy + r * Math.sin(a2)
      ].join(' ');
      paths += '<path d="' + p + '" fill="none" stroke="' + it.color + '" stroke-width="' + thickness + '" stroke-linecap="butt" class="arc" ' +
        'data-cat="' + escapeAttr(it.name) + '" ' +
        'data-tip="' + escapeAttr(it.name + '<br/>' + global.Fmt.money(it.value) + '　' + (frac * 100).toFixed(1) + '%' +
          (opts.onSelect ? '<br/><span style=\"opacity:.6\">点击查看具体支出</span>' : '')) + '"/>';
      angle = a2;
    });

    const pct = (n) => (n / total * 100).toFixed(1);
    let legend = '<div class="donut-legend">';
    items.slice(0, 8).forEach(it => {
      legend += '<div class="legend-row" data-cat="' + esc(it.name) + '">' +
        '<span class="dot" style="background:' + it.color + '"></span>' +
        '<span class="lg-name" title="' + escapeAttr(it.name) + '">' + escapeXML(it.name) + '</span>' +
        '<span class="lg-val">' + global.Fmt.shortMoney(it.value) + '</span>' +
        '<span class="lg-pct">' + pct(it.value) + '%</span>' +
        '</div>';
    });
    legend += '</div>';

    el.innerHTML =
      '<div class="donut-wrap">' +
      '<div class="donut-svg"><svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--grid)" stroke-width="' + thickness + '"/>' +
      paths +
      '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" class="donut-title">' + escapeXML(opts.title || '') + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 20) + '" text-anchor="middle" class="donut-value">' + global.Fmt.shortMoney(total) + '</text>' +
      '</svg></div>' + legend + '</div>';
    bindTip(el);

    if (opts.onSelect) {
      el.addEventListener('click', e => {
        const t = e.target.closest('[data-cat]');
        if (t) opts.onSelect(t.getAttribute('data-cat'));
      });
    }
  }

  /* ============================================================
   *  3. 横向排行条
   * ============================================================ */
  function rankBar(el, opts) {
    const items = (opts.items || []).filter(i => i.value > 0).slice(0, opts.limit || 10);
    if (!items.length) { empty(el, '暂无排行数据'); return; }
    const max = Math.max(...items.map(i => i.value));
    let html = '<div class="rank-list">';
    items.forEach((it, idx) => {
      const pctV = (it.value / max * 100).toFixed(1);
      html += '<div class="rank-row" data-pname="' + esc(it.name) + '" data-tip="' +
        escapeAttr(escapeXML(it.name) + '<br/>' + global.Fmt.money(it.value) + '　' + it.count + ' 笔' +
          (opts.onSelect ? '<br/><span style=\"opacity:.6\">点击只看这家</span>' : '')) + '">' +
        '<span class="rank-no">' + (idx + 1) + '</span>' +
        '<span class="rank-name" title="' + escapeAttr(it.name) + '">' + escapeXML(it.name) + '</span>' +
        '<span class="rank-bar"><i style="width:' + pctV + '%;background:' + (it.color || '#6366f1') + '"></i></span>' +
        '<span class="rank-val">' + global.Fmt.shortMoney(it.value) + '</span>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
    bindTip(el);

    if (opts.onSelect) {
      el.addEventListener('click', e => {
        const t = e.target.closest('[data-pname]');
        if (t) opts.onSelect(t.getAttribute('data-pname'));
      });
    }
  }

  /* ============================================================
   *  4. 日历热力图
   * ============================================================ */
  function heatmap(el, opts) {
    const map = opts.map || {};
    const keys = Object.keys(map);
    if (!keys.length) { empty(el, '暂无数据'); return; }
    const days = opts.days || 183;
    const cell = 13, gap = 3;
    const values = keys.map(k => map[k]);
    const maxV = Math.max(...values);

    // 以今天为终点向前推 days 天，按周对齐
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    const start = new Date(today); start.setDate(start.getDate() - days);
    start.setDate(start.getDate() - start.getDay()); // 对齐周日

    const weeks = [];
    let cur = new Date(start);
    while (cur <= end) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const key = keyOf(cur);
        week.push({ date: new Date(cur), value: cur > end ? -1 : (map[key] || 0) });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(week);
    }

    const W = weeks.length * (cell + gap) + 34;
    const H = 7 * (cell + gap) + 24;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px">';
    ['周一', '周三', '周五'].forEach((t, i) => {
      svg += '<text x="0" y="' + (13 + [1, 3, 5][i] * (cell + gap) + cell - 2) + '" class="axis-text">' + t + '</text>';
    });
    weeks.forEach((week, wi) => {
      week.forEach((d, di) => {
        if (d.value < 0) return;
        const x = 34 + wi * (cell + gap);
        const y = di * (cell + gap);
        const color = heatColor(d.value, maxV);
        const meta = d.value > 0
          ? escapeAttr(global.Fmt.date(d.date.getTime()) + '<br/>支出 ' + global.Fmt.money(d.value))
          : escapeAttr(global.Fmt.date(d.date.getTime()) + '<br/>无支出记录');
        svg += '<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell + '" rx="3" fill="' + color + '" data-tip="' + meta + '"/>';
      });
    });
    // 月份標
    let lastMonth = -1;
    weeks.forEach((week, wi) => {
      const m = week[0].date.getMonth();
      if (m !== lastMonth && week[0].date <= end) {
        lastMonth = m;
        svg += '<text x="' + (34 + wi * (cell + gap)) + '" y="' + (H - 6) + '" class="axis-text">' + (m + 1) + '月</text>';
      }
    });
    svg += '</svg>';
    el.innerHTML = '<div class="heat-wrap">' + svg + '<div class="heat-legend">少 <i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i> 多</div></div>';
    bindTip(el);
  }

  function keyOf(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function heatColor(v, max) {
    if (v <= 0) return 'var(--heat0)';
    const r = Math.min(1, v / (max || 1));
    if (r < 0.15) return 'var(--heat1)';
    if (r < 0.35) return 'var(--heat2)';
    if (r < 0.65) return 'var(--heat3)';
    return 'var(--heat4)';
  }

  /* 刻度文案：同一张图内统一量纲，避免「万」与完整数字混排 */
  function tickLabel(v, max) {
    const n = Number(v) || 0;
    if (max >= 10000) return '¥' + (n / 10000).toFixed(max >= 100000 ? 1 : 2) + '万';
    return '¥' + Math.round(n).toLocaleString('zh-CN');
  }

  function escapeAttr(s) { return esc(s); }

  global.Charts = { trend, donut, rankBar, heatmap };
})(window);
