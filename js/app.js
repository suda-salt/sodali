/* ============================================================
 *  bill-analyzer · 主逻辑
 *  视图：总览 / 待归类 / 退款冲销
 * ============================================================ */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const C = window.Classifier;
  const P = window.BillParser;
  const CH = window.Charts;
  const F = window.Fmt;
  const R = window.Reconcile;
  const txKey = R.txKey;

  const DATA_KEY = 'bill_analyzer_data_v1';
  const THEME_KEY = 'bill_analyzer_theme';
  const NICK_KEY = 'bill_analyzer_nick';

  const state = {
    items: [], files: [],
    view: 'overview',                      // overview | pending | refund
    period: { kind: 'range', r: 'month' }, // | {kind:'month',y,m} | {kind:'year',y} | {kind:'custom'} | {kind:'all'}
    from: '', to: '',
    sources: new Set(['alipay', 'wechat', 'other']),
    flow: 'all', cat: '', q: '',
    gran: 'day',
    includeTransfer: false,
    refundOffset: true,
    autoExclude: true,
    manualExclude: new Set(),
    keepIn: new Set(),
    links: [],
    nickname: '',
    sortKey: 'ts', sortDir: -1,
    page: 1, perPage: 50,
    pendingQ: ''
  };

  /* ================= 工具 ================= */
  function toast(msg, err) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast'; }, 2600);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function cleanName(s) {
    let n = String(s || '').replace(/[*#]/g, '').trim();
    n = n.replace(/[(（][^)）]*[)）]$/, '').trim();
    return n.slice(0, 18) || '';
  }
  function sum(arr) { return arr.reduce((s, v) => s + v, 0); }

  /* ================= 周期与范围 ================= */
  function setPeriod(p) {
    state.period = p;
    state.page = 1;
    renderAll();
  }

  function rangeBounds() {
    const now = Date.now();
    const p = state.period;
    if (p.kind === 'all') return [0, now];
    if (p.kind === 'month') {
      const s = new Date(p.y, p.m - 1, 1).getTime();
      const e = new Date(p.y, p.m, 1).getTime() - 1;
      return [s, Math.min(e, now)];
    }
    if (p.kind === 'year') {
      const s = new Date(p.y, 0, 1).getTime();
      const e = new Date(p.y + 1, 0, 1).getTime() - 1;
      return [s, Math.min(e, now)];
    }
    if (p.kind === 'custom') {
      const a = state.from ? new Date(state.from + 'T00:00:00').getTime() : 0;
      const b = state.to ? new Date(state.to + 'T23:59:59').getTime() : now;
      return [a, b];
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();
    switch (p.r) {
      case 'today': return [t0, now];
      case 'week': {
        const d = new Date(today);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return [d.getTime(), now];
      }
      case 'month': {
        const d = new Date(today); d.setDate(1);
        return [d.getTime(), now];
      }
      case 'last30': {
        const d = new Date(today); d.setDate(d.getDate() - 29);
        return [d.getTime(), now];
      }
      case 'year': {
        const d = new Date(today); d.setMonth(0, 1);
        return [d.getTime(), now];
      }
      default: return [0, now];
    }
  }

  function periodLabel() {
    const p = state.period;
    if (p.kind === 'all') return '总览（全部）';
    if (p.kind === 'year') return p.y + '年';
    if (p.kind === 'month') return p.y + '年' + p.m + '月';
    if (p.kind === 'custom') return (state.from || '开始') + ' 至 ' + (state.to || '今天');
    return { today: '今日', week: '本周', month: '本月', last30: '近30天', year: '今年', all: '全部' }[p.r] || '';
  }

  function periodSub() {
    const [a, b] = rangeBounds();
    if (!state.items.length) return '';
    return F.date(a) + ' ~ ' + F.date(Math.min(b, Date.now()));
  }

  /* ================= 上传 ================= */
  let pendingFiles = null;

  function requestUpload(files) {
    pendingFiles = files;
    if (!state.items.length) { doUpload('append'); return; }
    $('#uploadModalMsg').textContent =
      '当前本机已保存 ' + state.items.length + ' 条记录（来自 ' + state.files.length +
      ' 个文件）。这次导入 ' + files.length + ' 个文件，要怎么处理旧数据？';
    $('#uploadModal').hidden = false;
  }

  async function doUpload(mode) {
    const files = pendingFiles || [];
    pendingFiles = null;
    $('#uploadModal').hidden = true;
    if (!files.length) return;
    if (mode === 'replace') {
      state.items = []; state.files = []; state.links = [];
      state.manualExclude.clear(); state.keepIn.clear();
    }
    const had = new Set(state.items.map(txKey));
    $('#loader').hidden = false;
    const added = [];
    const infos = [];
    for (const f of files) {
      $('#loadMsg').textContent = '正在解析 ' + f.name + ' …';
      await new Promise(r => setTimeout(r, 12));
      try {
        const res = await P.parseFile(f);
        res.items.forEach(t => { if (!had.has(txKey(t))) { had.add(txKey(t)); added.push(t); } });
        const src = Object.keys(res.sources).sort((a, b) => res.sources[b] - res.sources[a])[0] || 'other';
        infos.push({ name: f.name, source: src, count: res.items.length, tz: res.duplicate });
      } catch (e) {
        console.error(e);
        toast(f.name + ' 解析失败：' + e.message, true);
      }
    }
    added.forEach(t => { t.cat = C.classify(t); t.memo = t.memo || ''; state.items.push(t); });
    // 记录已导入的文件（同名同条数视为同一个文件，避免重复罗列）
    infos.forEach(info => {
      const i = state.files.findIndex(f => f.name === info.name && f.count === info.count);
      if (i >= 0) state.files[i] = info; else state.files.push(info);
    });
    $('#loader').hidden = true;
    finalize(true);
    if (added.length) toast((mode === 'replace' ? '已覆盖导入 ' : '已追加 ') + added.length + ' 条记录，共 ' + state.items.length + ' 条');
    else toast('这些账单已经在数据里了，没有新增记录');
  }

  /* 数据变更后统一收口 */
  function finalize(rebuildLinks) {
    state.items.sort((a, b) => b.ts - a.ts);
    if (rebuildLinks) state.links = R.build(state.items, state.links);
    persist();
    renderFiles();
    buildCategoryOptions();
    renderSidebar();
    renderAll();
  }

  /* ================= 持久化 ================= */
  function persist() {
    try {
      const lean = state.items.map(t => [
        t.source, t.ts, t.amount, t.flow, t.kind, t.cat,
        t.counterparty || '', t.product || '', t.method || '', t.status || '', t.memo || ''
      ]);
      localStorage.setItem(DATA_KEY, JSON.stringify({
        files: state.files,
        items: lean,
        links: state.links.map(l => ({ rkey: l.rkey, chosen: l.chosen, enabled: l.enabled, amount: l.amount })),
        manualExclude: Array.from(state.manualExclude),
        keepIn: Array.from(state.keepIn),
        nickname: state.nickname,
        gran: state.gran,
        includeTransfer: state.includeTransfer,
        refundOffset: state.refundOffset,
        autoExclude: state.autoExclude
      }));
    } catch (e) {
      console.warn('本地缓存失败（数据量过大或隐私模式）：', e);
    }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.items) || !d.items.length) return false;
      state.items = d.items.map(a => ({
        source: a[0], ts: a[1], amount: a[2], flow: a[3], kind: a[4], cat: a[5],
        counterparty: a[6], product: a[7], method: a[8], status: a[9], memo: a[10] || '',
        orderId: ''
      }));
      state.files = d.files || [];
      state.manualExclude = new Set(d.manualExclude || []);
      state.keepIn = new Set(d.keepIn || []);
      state.nickname = d.nickname || '';
      state.gran = d.gran || 'day';
      state.includeTransfer = !!d.includeTransfer;
      state.refundOffset = d.refundOffset !== false;
      state.autoExclude = d.autoExclude !== false;
      const prevLinks = d.links || [];
      state.links = R.build(state.items, prevLinks);
      return true;
    } catch (e) { return false; }
  }

  /* ================= 判定 ================= */
  function isRealExpense(t) {
    if (t.flow !== 'expense') return false;
    if (state.includeTransfer) return true;
    return !(t.kind === 'transfer' || C.FLOW_CATS.has(t.cat));
  }
  function isRealIncome(t) {
    if (t.flow !== 'income') return false;
    if (t.kind === 'refund' && state.refundOffset) return false;
    return true;
  }
  function isPending(t) {
    return t.flow === 'expense' && t.cat === '其他支出' && !t.confirmed;
  }
  function netAmount(t, applied) {
    const off = applied ? (applied.get(txKey(t)) || 0) : 0;
    return Math.max(0, t.amount - off);
  }

  function filtered() {
    const [a, b] = rangeBounds();
    const q = state.q.trim().toLowerCase();
    return state.items.filter(t => {
      if (t.ts < a || t.ts > b) return false;
      if (!state.sources.has(t.source)) return false;
      if (state.flow === 'expense' && !isRealExpense(t)) return false;
      if (state.flow === 'income' && !isRealIncome(t)) return false;
      if (state.flow === 'transfer' && (isRealExpense(t) || isRealIncome(t))) return false;
      if (state.cat && t.cat !== state.cat) return false;
      if (q) {
        const hay = [t.counterparty, t.product, t.note, t.memo, t.method].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /* ================= 统计 ================= */
  function stats(list) {
    const applied = state.refundOffset ? R.appliedMap(state.links) : new Map();
    const exps = list.filter(isRealExpense);
    const amounts = exps.map(t => netAmount(t, applied)).sort((a, b) => a - b);

    let expense = 0, income = 0, refund = 0, transfer = 0, max = null;
    const daily = new Map(), catMap = new Map(), partyMap = new Map();

    exps.forEach(t => {
      const v = netAmount(t, applied);
      expense += v;
      const k = F.date(t.ts);
      daily.set(k, (daily.get(k) || 0) + v);
      catMap.set(t.cat, (catMap.get(t.cat) || 0) + v);
      const pn = cleanName(t.counterparty) || cleanName(t.product) || '未知';
      const cur = partyMap.get(pn) || { value: 0, count: 0 };
      cur.value += v; cur.count++;
      partyMap.set(pn, cur);
      if (!max || v > max.v) max = { v, t };
    });

    list.forEach(t => {
      if (isRealExpense(t)) return;
      if (isRealIncome(t)) income += t.amount;
      else if (t.kind === 'refund') refund += t.amount;
      else transfer += t.amount;
    });

    // 特大支出识别（四分位距法）
    let threshold = Infinity;
    const autoKeys = new Set();
    if (amounts.length >= 8) {
      const q = p => amounts[Math.min(amounts.length - 1, Math.floor(amounts.length * p))];
      const q1 = q(0.25), q3 = q(0.75);
      // 门槛取 300 元，避免把日常稍大额的开销误判为特大支出
      threshold = Math.max(300, q3 + 1.5 * (q3 - q1));
      exps.forEach(t => { if (netAmount(t, applied) >= threshold) autoKeys.add(txKey(t)); });
    }
    const effAuto = new Set(Array.from(autoKeys).filter(k => !state.keepIn.has(k)));
    const excludedKeys = state.autoExclude
      ? new Set(Array.from(effAuto).concat(Array.from(state.manualExclude)))
      : new Set(state.manualExclude);
    let excludedSum = 0;
    exps.forEach(t => { if (excludedKeys.has(txKey(t))) excludedSum += netAmount(t, applied); });

    let days = 1;
    if (list.length) {
      let mn = Infinity, mx = 0;
      list.forEach(t => { if (t.ts < mn) mn = t.ts; if (t.ts > mx) mx = t.ts; });
      days = Math.max(1, Math.round((mx - mn) / 86400000) + 1);
    }

    return {
      expense, income, refund, transfer, count: list.length, daily, catMap, partyMap,
      max: max ? { amount: max.v, t: max.t } : null,
      avg: expense / days, days, threshold, excludedKeys, excludedSum,
      avgEx: (expense - excludedSum) / days,
      pendingCount: state.items.filter(isPending).length,
      refundLinks: state.links,
      refundTotal: sum(state.links.map(l => l.amount)),
      refundApplied: sum(state.links.filter(l => l.enabled && l.chosen).map(l => l.amount))
    };
  }

  /* ================= 渲染入口 ================= */
  function renderAll() {
    if (!state.items.length) {
      $('#dash').hidden = true;
      $('#uploader').hidden = false;
      return;
    }
    $('#dash').hidden = false;
    $('#uploader').hidden = true;

    $$('#viewTabs button').forEach(b => b.classList.toggle('on', b.dataset.v === state.view));
    $('#viewOverview').hidden = state.view !== 'overview';
    $('#viewPending').hidden = state.view !== 'pending';
    $('#viewRefund').hidden = state.view !== 'refund';

    refreshUI();

    const list = filtered();
    const st = stats(list);
    currentExcluded = st.excludedKeys;
    updateCounts(st);

    if (state.view === 'pending') { renderPending(); return; }
    if (state.view === 'refund') { renderRefund(st); return; }

    renderGreet(st, list);
    renderKPI(st);
    renderInsight(st);
    renderTrend(list);
    renderCat(st);
    renderRank(st);
    renderHeat(st);
    renderFlow(st);
    renderTable(list);
  }

  function updateCounts(st) {
    const p = st.pendingCount, r = state.links.length;
    const set = (sel, v) => { const e = $(sel); if (e) e.textContent = v; };
    set('#tabPending', p); set('#sbPending', p);
    set('#tabRefund', r); set('#sbRefund', r);
  }

  function refreshUI() {
    const p = state.period;
    $$('#rangeSeg button').forEach(b => b.classList.toggle('on', p.kind === 'range' && p.r === b.dataset.r));
    $$('#granSeg button').forEach(b => b.classList.toggle('on', b.dataset.g === state.gran));
    $('#fromDate').value = state.from || '';
    $('#toDate').value = state.to || '';
    $('#swTrans').checked = state.includeTransfer;
    $('#swRefund').checked = state.refundOffset;
    $('#swExclude').checked = state.autoExclude;
    $('#tbTitle').textContent = periodLabel();
    $('#statBadge').textContent = '共 ' + state.items.length + ' 条记录 · ' +
      state.files.length + ' 个文件 · 数据仅保存在本机';
  }

  /* ---------- 左侧栏 ---------- */
  function renderSidebar() {
    const tree = new Map();
    state.items.forEach(t => {
      const d = new Date(t.ts);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      if (!tree.has(y)) tree.set(y, new Map());
      const mm = tree.get(y);
      if (!mm.has(m)) mm.set(m, { count: 0, expense: 0 });
      const rec = mm.get(m);
      rec.count++;
      if (isRealExpense(t)) rec.expense += t.amount;
    });
    $('#cntAll').textContent = state.items.length;

    const years = Array.from(tree.keys()).sort((a, b) => b - a);
    const curY = new Date().getFullYear();
    const p = state.period;

    $('#sbTree').innerHTML = years.map(y => {
      const months = Array.from(tree.get(y).entries()).sort((a, b) => b[0] - a[0]);
      const ySum = sum(months.map(m => m[1].expense));
      const isYear = p.kind === 'year' && p.y === y;
      const open = isYear || (p.kind === 'month' && p.y === y) || (y === curY && p.kind !== 'year');
      return '<div class="sb-year' + (open ? ' open' : '') + '">' +
        '<button class="sb-tree-item' + (isYear ? ' on' : '') + '" data-t="year" data-y="' + y + '">' +
        '<span class="tw">' + (open ? '▾' : '▸') + '</span><b>' + y + '年</b><em>' + F.shortMoney(ySum) + '</em></button>' +
        '<div class="sb-months">' + months.map(([m, rec]) =>
          '<button class="sb-tree-item sub' + (p.kind === 'month' && p.y === y && p.m === m ? ' on' : '') +
          '" data-t="month" data-y="' + y + '" data-m="' + m + '">' +
          '<span>' + m + '月</span><em>' + rec.count + '笔</em></button>'
        ).join('') + '</div></div>';
    }).join('');
  }

  function renderFiles() {
    const box = $('#fileList');
    if (!state.files.length) { box.innerHTML = ''; return; }
    const names = { alipay: '支付宝', wechat: '微信支付', other: '其他' };
    box.innerHTML = state.files.map(f =>
      '<div class="file-item"><span class="tag ' + f.source + '">' + (names[f.source] || '账单') + '</span>' +
      '<span>' + esc(f.name) + '</span>' +
      '<span class="meta">' + f.count + ' 条' + (f.tz ? ' · 去重 ' + f.tz : '') + '</span></div>'
    ).join('');
  }

  function renderSourceChips() {
    const defs = [['alipay', '支付宝'], ['wechat', '微信支付'], ['other', '其他']];
    const present = {};
    state.items.forEach(t => present[t.source] = (present[t.source] || 0) + 1);
    $('#sourceChips').innerHTML = defs.filter(d => present[d[0]]).map(d =>
      '<button class="chip' + (state.sources.has(d[0]) ? ' on' : '') + '" data-src="' + d[0] + '">' + d[1] + '</button>'
    ).join('');
  }

  function renderFlowChips() {
    const defs = [['all', '全部'], ['expense', '支出'], ['income', '收入'], ['transfer', '转账/退款']];
    $('#flowChips').innerHTML = defs.map(d =>
      '<button class="chip' + (state.flow === d[0] ? ' on' : '') + '" data-flow="' + d[0] + '">' + d[1] + '</button>'
    ).join('');
  }

  function buildCategoryOptions() {
    const cats = new Set(state.items.map(t => t.cat));
    const sel = $('#catSelect');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部分类</option>' + Array.from(cats).sort().map(c =>
      '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
    sel.value = (cur && cats.has(cur)) ? cur : (state.cat || '');
    renderSourceChips();
    renderFlowChips();
  }

  /* ---------- 问候 / 温馨话语 ---------- */
  function greetPrefix() {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function warmWords(st, list) {
    const nick = state.nickname || '你';
    const cands = [];

    const [a, b] = rangeBounds();
    const len = b - a;
    let prevExp = 0;
    const prevCat = new Map();
    if (a > 0 && len && len < 200 * 86400000) {
      state.items.filter(t => t.ts >= a - len && t.ts < a).forEach(t => {
        if (isRealExpense(t)) { prevExp += t.amount; prevCat.set(t.cat, (prevCat.get(t.cat) || 0) + t.amount); }
        else if (t.kind === 'refund' && state.refundOffset) prevExp -= t.amount;
      });
    }
    if (prevExp > 0 && st.expense > 0) {
      const d = st.expense - prevExp;
      const pct = Math.abs(d) / prevExp * 100;
      if (pct >= 15) {
        let top = null;
        st.catMap.forEach((v, k) => {
          const diff = v - (prevCat.get(k) || 0);
          if (!top || Math.abs(diff) > Math.abs(top.diff)) top = { cat: k, diff };
        });
        if (top && Math.abs(top.diff) > 0.01) {
          cands.push(d > 0
            ? nick + '，这期在「' + top.cat + '」上多花了 ' + F.shortMoney(Math.abs(top.diff)) +
              '，比上期高出 ' + pct.toFixed(0) + '%，要不要看看是哪些开销在悄悄变多？'
            : nick + '，这期比上期少花了 ' + F.shortMoney(Math.abs(d)) + '（降幅 ' + pct.toFixed(0) +
              '%），「' + top.cat + '」省得最多，这个节奏很好呀。');
        }
      }
    }

    const night = list.filter(t => {
      if (!isRealExpense(t)) return false;
      const h = new Date(t.ts).getHours();
      return h >= 23 || h < 5;
    });
    if (night.length >= 3) {
      cands.push(nick + '，有 ' + night.length + ' 笔消费发生在深夜 11 点后（合计 ' +
        F.shortMoney(sum(night.map(t => t.amount))) + '），账单可以明天看，觉还是要早点睡。');
    }

    let topDay = null;
    st.daily.forEach((v, k) => { if (!topDay || v > topDay.v) topDay = { k, v }; });
    if (topDay && st.avg > 0 && topDay.v > st.avg * 2.5) {
      cands.push(nick + '，' + topDay.k + ' 那天花了 ' + F.shortMoney(topDay.v) + '，是日均的 ' +
        (topDay.v / st.avg).toFixed(1) + ' 倍——那天是不是有什么特别的安排？');
    }

    const drink = list.filter(t => isRealExpense(t) &&
      /瑞幸|星巴克|喜茶|奈雪|蜜雪|奶茶|咖啡/.test((t.counterparty || '') + (t.product || '')));
    if (drink.length >= 8) {
      cands.push(nick + '，这段时间买了 ' + drink.length + ' 次咖啡奶茶（约 ' +
        F.shortMoney(sum(drink.map(t => t.amount))) + '），偶尔换成白开水，身体也会开心的。');
    }

    if (st.income > 0) {
      const rate = (st.income - st.expense) / st.income * 100;
      if (rate < 0) cands.push(nick + '，这期支出比收入多出 ' + F.shortMoney(st.expense - st.income) +
        '，先别急，我们一起看看哪类开销可以先缓一缓。');
      else if (rate >= 30) cands.push(nick + '，这期结余率 ' + rate.toFixed(0) +
        '%，钱包很健康，给自己一点小奖励吧。');
    }

    if (st.max) {
      cands.push(nick + '，最大的一笔是 ' + cleanName(st.max.t.counterparty) + ' 的 ' +
        F.shortMoney(st.max.amount) + '，占这期支出 ' + (st.max.amount / (st.expense || 1) * 100).toFixed(0) + '%。');
    }

    if (!cands.length) return nick + '，这期暂时没有支出记录，先上传账单看看钱都花在哪儿了。';
    const now = new Date();
    const seed = now.getFullYear() * 400 + now.getMonth() * 31 + now.getDate();
    return cands[seed % cands.length];
  }

  function renderGreet(st, list) {
    const nick = state.nickname || '';
    $('#greet').innerHTML =
      '<div class="greet-card">' +
      '<div class="greet-emoji">🌱</div>' +
      '<div class="greet-text">' +
      '<div class="greet-hi">' + esc(greetPrefix()) + (nick ? '，' + esc(nick) : '') + '</div>' +
      '<div class="greet-msg">' + esc(warmWords(st, list)) + '</div>' +
      '</div>' +
      '<div class="greet-meta">' +
      '<span>' + esc(periodLabel()) + '</span>' +
      '<span>' + esc(periodSub()) + '</span>' +
      '<span>' + st.count + ' 笔记录</span>' +
      '</div></div>';
  }

  /* ---------- KPI ---------- */
  function renderKPI(st) {
    const cfg = [
      { cls: 'k-expense', label: '总支出', value: F.money(st.expense, 0), vcls: 'exp',
        sub: state.refundOffset && st.refundApplied ? '已冲销退款 ' + F.shortMoney(st.refundApplied) : '' },
      { cls: 'k-income', label: '总收入', value: F.money(st.income, 0), vcls: 'inc',
        sub: !state.refundOffset && st.refund ? '含退款 ' + F.shortMoney(st.refund) : '' },
      { cls: 'k-balance', label: '结余', value: F.money(st.income - st.expense, 0),
        vcls: (st.income - st.expense) >= 0 ? 'inc' : 'exp',
        sub: st.income ? '储蓄率 ' + (((st.income - st.expense) / st.income) * 100).toFixed(1) + '%' : '' },
      { cls: 'k-count', label: '交易笔数', value: st.count.toLocaleString(), vcls: '',
        sub: '日均 ' + (st.count / st.days).toFixed(1) + ' 笔' },
      { cls: 'k-avg', label: '日均支出', value: F.money(st.avg, 0), vcls: 'exp',
        sub: '统计区间 ' + st.days + ' 天' },
      { cls: 'k-avg-ex', label: '日均支出（剔大额）', value: F.money(st.avgEx, 0), vcls: 'exp',
        sub: st.excludedKeys.size ? '已剔除 ' + st.excludedKeys.size + ' 笔 · ' + F.shortMoney(st.excludedSum) : '本期无特大支出',
        info: true },
      { cls: 'k-max', label: '最大单笔支出', value: st.max ? F.money(st.max.amount, 0) : F.money(0, 0), vcls: 'exp',
        sub: st.max ? cleanName(st.max.t.counterparty) + ' · ' + F.date(st.max.t.ts).slice(5) : '' }
    ];
    $('#kpis').innerHTML = cfg.map(c =>
      '<div class="kpi ' + c.cls + '"><div class="k-label">' + c.label +
      (c.info ? '<button class="info-btn" data-info="exclude" title="查看剔除了哪些支出">ⓘ</button>' : '') +
      '</div><div class="k-value ' + c.vcls + '">' + c.value + '</div>' +
      (c.sub ? '<div class="k-sub">' + esc(c.sub) + '</div>' : '') + '</div>'
    ).join('');
  }

  /* ---------- 洞察 ---------- */
  function renderInsight(st) {
    const items = [];
    const [a, b] = rangeBounds();
    const len = b - a;
    let prevExp = 0;
    const prevCat = new Map();
    if (a > 0 && len && len < 200 * 86400000) {
      state.items.filter(t => t.ts >= a - len && t.ts < a).forEach(t => {
        if (isRealExpense(t)) { prevExp += t.amount; prevCat.set(t.cat, (prevCat.get(t.cat) || 0) + t.amount); }
        else if (t.kind === 'refund' && state.refundOffset) prevExp -= t.amount;
      });
    }

    if (prevExp > 0 && st.expense > 0) {
      const d = st.expense - prevExp;
      const pct = (Math.abs(d) / prevExp * 100).toFixed(1);
      items.push({
        icon: d > 0 ? '▲' : '▼', tone: d > 0 ? 'up' : 'down',
        title: '环比' + (d > 0 ? '增加' : '减少') + ' ' + pct + '%',
        text: '上一周期支出 ' + F.shortMoney(prevExp) + '，本期 ' + F.shortMoney(st.expense) +
          '，' + (d > 0 ? '多花' : '少花') + ' ' + F.shortMoney(Math.abs(d))
      });
      let top = null;
      st.catMap.forEach((v, k) => {
        const diff = v - (prevCat.get(k) || 0);
        if (!top || Math.abs(diff) > Math.abs(top.diff)) top = { cat: k, diff, prev: prevCat.get(k) || 0, cur: v };
      });
      if (top && Math.abs(top.diff) > 0.01) {
        items.push({
          icon: top.diff > 0 ? '▲' : '▼', tone: top.diff > 0 ? 'up' : 'down',
          title: top.cat + (top.diff > 0 ? ' 增加最多' : ' 降幅最大'),
          text: (top.prev ? '上一周期 ' + F.shortMoney(top.prev) + ' → ' : '新增 ') +
            '本期 ' + F.shortMoney(top.cur) + '（' + (top.diff > 0 ? '+' : '-') + F.shortMoney(Math.abs(top.diff)) + '）'
        });
      }
    }

    const parties = Array.from(st.partyMap.entries()).sort((x, y) => y[1].value - x[1].value);
    if (parties.length) {
      const [name, v] = parties[0];
      items.push({
        icon: '★', tone: 'flat', title: '最大支出对象：' + name,
        text: '共 ' + v.count + ' 笔，合计 ' + F.shortMoney(v.value) + '，占本期支出 ' +
          (v.value / (st.expense || 1) * 100).toFixed(1) + '%'
      });
    }

    let topDay = null;
    st.daily.forEach((v, k) => { if (!topDay || v > topDay.v) topDay = { k, v }; });
    if (topDay && topDay.v > 0) {
      items.push({
        icon: '⛰', tone: 'flat', title: '单日峰值：' + topDay.k,
      text: '当天支出 ' + F.shortMoney(topDay.v) + '，是日均的 ' +
          (topDay.v / (st.avg || 1)).toFixed(1) + ' 倍'
      });
    }

    if (st.pendingCount) {
      items.push({
        icon: '◇', tone: 'flat', title: '待归类 ' + st.pendingCount + ' 笔',
        text: '有些支出暂时归到了「其他支出」，去待归类里确认一下，统计会更准确'
      });
    }

    if (st.income > 0) {
      const rate = ((st.income - st.expense) / st.income * 100);
      items.push({
        icon: rate >= 0 ? '◑' : '⚠', tone: rate >= 30 ? 'down' : (rate >= 0 ? 'flat' : 'up'),
        title: '结余率 ' + rate.toFixed(1) + '%',
        text: rate >= 0
          ? '本期收入 ' + F.shortMoney(st.income) + '，结余 ' + F.shortMoney(st.income - st.expense)
          : '支出已超过收入 ' + F.shortMoney(st.expense - st.income) + '，注意控制'
      });
    }

    const box = $('#insight');
    if (!items.length) {
      box.innerHTML = '<div class="insight-empty">切换更长的时间范围，可以看到环比变化与消费洞察</div>';
      return;
    }
    box.innerHTML = '<div class="card-head"><h3>消费洞察</h3><span class="hint">与上一个等长周期对比</span></div>' +
      '<div class="insight-list">' + items.map(i =>
        '<div class="insight-item"><span class="ins-icon ' + i.tone + '">' + i.icon + '</span>' +
        '<div><div class="ins-title">' + esc(i.title) + '</div>' +
        '<div class="ins-text">' + esc(i.text) + '</div></div></div>'
      ).join('') + '</div>';
  }

  /* ---------- 图表 ---------- */
  function granLabel(ts, g) {
    const d = new Date(ts);
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    if (g === 'month') return { key: y + '-' + pad2(m), label: y + '年' + m + '月', short: m + '月' };
    if (g === 'week') {
      const w = (d.getDay() + 6) % 7;
      const s = new Date(d); s.setDate(d.getDate() - w);
      return { key: F.date(s.getTime()), label: F.date(s.getTime()), short: (s.getMonth() + 1) + '/' + s.getDate() };
    }
    return { key: F.date(ts), label: F.date(ts), short: m + '/' + day };
  }

  function renderTrend(list) {
    const g = state.gran;
    const applied = state.refundOffset ? R.appliedMap(state.links) : new Map();
    const buckets = new Map();
    list.forEach(t => {
      const gl = granLabel(t.ts, g);
      let b = buckets.get(gl.key);
      if (!b) { b = { key: gl.key, label: gl.label, shortLabel: gl.short, expense: 0, income: 0 }; buckets.set(gl.key, b); }
      if (isRealExpense(t)) b.expense += netAmount(t, applied);
      else if (isRealIncome(t)) b.income += t.amount;
      else if (t.kind === 'refund' && state.refundOffset) b.expense -= t.amount;
      else if (t.kind === 'transfer' && state.includeTransfer) b.expense += t.amount;
    });
    const data = Array.from(buckets.values()).sort((a, b) => a.key < b.key ? -1 : 1);
    CH.trend($('#chartTrend'), { data, height: 288 });
  }

  function renderCat(st) {
    const items = Array.from(st.catMap.entries()).map(([name, value]) => ({
      name, value, color: C.color(name)
    }));
    CH.donut($('#chartCat'), {
      items, title: '支出合计', size: 210,
      onSelect: name => openCategory(name)
    });
  }

  function renderRank(st) {
    const items = Array.from(st.partyMap.entries()).map(([name, v]) => ({
      name, value: v.value, count: v.count, color: '#6366f1'
    })).sort((a, b) => b.value - a.value).slice(0, 10);
    CH.rankBar($('#chartRank'), {
      items,
      onSelect: name => {
        state.q = name; $('#searchInput').value = name; state.page = 1; renderAll();
        toast('已筛选：' + name);
      }
    });
  }

  function renderHeat(st) {
    CH.heatmap($('#chartHeat'), { map: Object.fromEntries(st.daily), days: 182 });
  }

  function renderFlow(st) {
    const items = [];
    if (st.expense) items.push({ name: '消费支出', value: st.expense, color: '#f43f5e' });
    if (st.income) items.push({ name: '收入', value: st.income, color: '#22c55e' });
    if (st.transfer) items.push({ name: '转账/提现/还款', value: st.transfer, color: '#94a3b8' });
    if (st.refundApplied) items.push({ name: '已冲销退款', value: st.refundApplied, color: '#a78bfa' });
    CH.donut($('#chartFlow'), { items, title: '资金去向', size: 190, thickness: 26 });
  }

  /* ---------- 明细表 ---------- */
  function sortList(list) {
    const k = state.sortKey, dir = state.sortDir;
    return list.slice().sort((a, b) => {
      let av, bv;
      if (k === 'ts') { av = a.ts; bv = b.ts; }
      else if (k === 'amount') { av = a.amount; bv = b.amount; }
      else if (k === 'cat') { av = a.cat; bv = b.cat; }
      else { av = a.source; bv = b.source; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function renderTable(list) {
    const applied = state.refundOffset ? R.appliedMap(state.links) : new Map();
    const sorted = sortList(list);
    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / state.perPage));
    if (state.page > pages) state.page = pages;
    const slice = sorted.slice((state.page - 1) * state.perPage, state.page * state.perPage);
    const names = { alipay: '支付宝', wechat: '微信', other: '其他' };

    const rows = slice.map(t => {
      const isExp = isRealExpense(t);
      const isInc = isRealIncome(t);
      const off = isExp ? (applied.get(txKey(t)) || 0) : 0;
      let cls = 'mut', sign = '';
      if (isExp) { cls = 'exp'; sign = '-'; }
      else if (isInc) { cls = 'inc'; sign = '+'; }
      else if (t.kind === 'refund') { cls = 'inc'; sign = '+'; }
      const d = new Date(t.ts);
      const excluded = st_excluded(t);
      return '<tr data-id="' + esc(txKey(t)) + '">' +
        '<td class="num" style="text-align:left">' + esc(d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())) + '</td>' +
        '<td><span class="src-badge ' + t.source + '">' + (names[t.source] || '其他') + '</span></td>' +
        '<td><div class="cell-main" title="' + esc(t.counterparty) + '">' + esc(t.counterparty || '—') + '</div></td>' +
        '<td><div class="cell-sub" title="' + esc((t.product || '') + ' ' + (t.memo || '')) + '">' + esc(t.product || '—') +
        (t.memo ? ' <span class="memo">· ' + esc(t.memo) + '</span>' : '') + '</div></td>' +
        '<td><span class="cat-tag" data-cat="' + esc(t.cat) + '" data-kw="' + esc(cleanName(t.counterparty) || cleanName(t.product)) + '" style="background:' + C.color(t.cat) + '1f;color:' + C.color(t.cat) + '">' + esc(t.cat) + '</span>' +
        (excluded ? ' <span class="mini-tag">剔</span>' : '') + '</td>' +
        '<td class="num ' + cls + '">' + sign + esc(F.money(t.amount)) +
        (off ? '<div class="cell-sub">冲销 -' + esc(F.money(off)) + '</div>' : '') + '</td>' +
        '<td><div class="cell-sub">' + esc(t.method || '') + '</div></td>' +
        '</tr>';
    }).join('');

    $('#detailTable tbody').innerHTML = rows ||
      '<tr><td colspan="7" style="text-align:center;color:var(--text-3);padding:26px">没有符合条件的记录</td></tr>';
    $('#tableInfo').textContent = '共 ' + total + ' 条 · 第 ' + state.page + '/' + pages + ' 页';

    const btns = [];
    const mk = (label, p, cls) => '<button data-p="' + p + '" class="' + (cls || '') + '"' +
      (p === null ? ' disabled' : '') + '>' + label + '</button>';
    btns.push(mk('上一页', state.page > 1 ? state.page - 1 : null));
    const near = [];
    for (let i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - state.page) <= 2) near.push(i);
    }
    let last = 0;
    near.forEach(i => {
      if (last && i - last > 1) btns.push('<span class="gap">…</span>');
      btns.push(mk(i, i, i === state.page ? 'on' : ''));
      last = i;
    });
    btns.push(mk('下一页', state.page < pages ? state.page + 1 : null));
    $('#pager').innerHTML = btns.join('');
  }

  let currentExcluded = new Set();
  function st_excluded(t) { return currentExcluded.has(txKey(t)); }

  /* ---------- 待归类 ---------- */
  function pendingGroups() {
    const g = new Map();
    state.items.forEach(t => {
      if (!isPending(t)) return;
      const k = cleanName(t.counterparty) || cleanName(t.product) || '未知商户';
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(t);
    });
    let arr = Array.from(g.entries()).map(([name, list]) => ({
      name, list, total: sum(list.map(t => t.amount))
    })).sort((a, b) => b.total - a.total);
    const q = state.pendingQ.trim().toLowerCase();
    if (q) arr = arr.filter(x => x.name.toLowerCase().includes(q) ||
      x.list.some(t => ((t.product || '') + (t.memo || '')).toLowerCase().includes(q)));
    return arr;
  }

  function renderPending() {
    const groups = pendingGroups();
    const total = groups.reduce((s, g) => s + g.list.length, 0);
    $('#pendingHint').textContent = total
      ? groups.length + ' 个待确认商户 · 共 ' + total + ' 笔 · 合计 ' +
        F.shortMoney(groups.reduce((s, g) => s + g.total, 0))
      : '';

    const opts = C.CATS.filter(c => c.kind !== 'neutral')
      .map(c => '<option value="' + c.name + '">' + c.name + '</option>').join('');

    const box = $('#pendingList');
    if (!groups.length) {
      box.innerHTML = '<div class="task-empty">🎉 没有待归类的支出了，每一笔都找到了自己的分类</div>';
      return;
    }
    box.innerHTML = groups.slice(0, 80).map(g => {
      const d = new Date(g.list[0].ts);
      const sample = (g.list[0].product || '—');
      return '<div class="task-item" data-kw="' + esc(g.name) + '">' +
        '<div class="task-main">' +
        '<div class="task-name">' + esc(g.name) + '</div>' +
        '<div class="task-desc">' + g.list.length + ' 笔 · 合计 ' + F.money(g.total) +
        ' · 最近 ' + esc(F.date(d.getTime())) + ' · ' + esc(sample) + '</div>' +
        '</div>' +
        '<div class="task-form">' +
        '<select class="select task-cat">' + opts + '</select>' +
        '<input type="text" class="search task-memo" placeholder="备注（选填）" maxlength="40">' +
        '<button class="btn primary sm task-ok">确认归类</button>' +
        '<button class="btn sm ghost task-skip">保留其他</button>' +
        '</div></div>';
    }).join('');
  }

  function applyPending(kw, cat, memo) {
    const hit = state.items.filter(t =>
      (cleanName(t.counterparty) || cleanName(t.product) || '未知商户') === kw && isPending(t));
    hit.forEach(t => {
      t.cat = cat;
      t.confirmed = true;
      if (memo) t.memo = memo;
    });
    if (cat !== '其他支出' && kw && kw !== '未知商户') C.addRule(kw, cat);
    finalize(false);
    if (hit.length) toast('已归类 ' + hit.length + ' 笔 → ' + cat);
  }

  /* ---------- 退款冲销 ---------- */
  function renderRefund(st) {
    const links = state.links;
    const on = links.filter(l => l.enabled && l.chosen);
    let hint = '';
    if (links.length) {
      hint = '共 ' + links.length + ' 笔退款 · ' + F.shortMoney(st.refundTotal);
      if (state.refundOffset) {
        hint += '，已冲销 ' + on.length + ' 笔 · ' + F.shortMoney(st.refundApplied);
      } else {
        hint += '（全局冲销已关闭，退款将计入收入）';
      }
    }
    $('#refundHint').textContent = hint;

    const box = $('#refundList');
    if (!links.length) {
      box.innerHTML = '<div class="task-empty">这段时间没有检测到退款记录</div>';
      return;
    }

    box.innerHTML = links.map((l, i) => {
      const r = l.refund || {};
      const d = new Date(r.ts || Date.now());
      const cands = l.cands || [];
      const sel = cands.find(c => c.key === l.chosen);
      const opts = ['<option value="">不匹配任何支出</option>'].concat(
        cands.map(c => {
          const cd = new Date(c.tx.ts);
          return '<option value="' + esc(c.key) + '"' + (c.key === l.chosen ? ' selected' : '') + '>' +
            esc(F.date(cd.getTime()) + ' ' + pad2(cd.getHours()) + ':' + pad2(cd.getMinutes()) +
              ' · ' + cleanName(c.tx.counterparty) + ' · ¥' + c.tx.amount.toFixed(2)) +
            '</option>';
        })
      ).join('');

      const score = sel ? Math.min(99, sel.score) : 0;
      return '<div class="recon-item' + (l.enabled && l.chosen ? ' on' : '') + '" data-i="' + i + '">' +
        '<div class="recon-head">' +
        '<div class="recon-l">' +
        '<div class="recon-title">退款 · ' +
          esc(F.date(d.getTime()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())) + '</div>' +
        '<div class="recon-desc">' + esc(cleanName(r.counterparty) || '未知') +
          ' · ' + esc(r.product || '') + ' · ' + esc(r.method || '') + '</div>' +
        '</div>' +
        '<div class="recon-r">' +
        '<span class="recon-amt">+' + esc(F.money(l.amount)) + '</span>' +
        '<label class="switch sm"><input type="checkbox" class="recon-sw"' +
          (l.enabled ? ' checked' : '') + '><span></span>冲销</label>' +
        '</div></div>' +
        '<div class="recon-body">' +
        '<div class="recon-match">' +
        '<label>对应的原始支出</label>' +
        '<select class="select recon-sel">' + opts + '</select>' +
        (sel ? '<span class="match-score">匹配度 ' + score + '%</span>'
             : '<span class="match-score warn">未匹配，退款将作为收入显示</span>') +
        '</div>' +
        '<button class="btn sm ghost recon-detail">查看冲销详情</button>' +
        '</div></div>';
    }).join('');
  }

  function renderRefundDetail(i) {
    const l = state.links[i];
    if (!l) return;
    const r = l.refund || {};
    const hit = l.chosen ? (l.cands || []).find(c => c.key === l.chosen) : null;
    const rd = new Date(r.ts || Date.now());
    const row = (k, v, cls) => '<div class="kv"><span>' + esc(k) + '</span><b class="' +
      (cls || '') + '">' + esc(v) + '</b></div>';

    let html = '<div class="rd-detail"><div class="rd-col"><h5>退款</h5>' +
      row('时间', F.date(r.ts) + ' ' + pad2(rd.getHours()) + ':' + pad2(rd.getMinutes())) +
      row('对方', cleanName(r.counterparty) || '—') +
      row('说明', r.product || '—') +
      row('金额', '+' + F.money(l.amount), 'inc') +
      row('来源', r.source === 'wechat' ? '微信支付' : '支付宝') +
      '</div>';

    if (hit) {
      const ed = new Date(hit.tx.ts);
      const net = Math.max(0, hit.tx.amount - l.amount);
      html += '<div class="rd-col"><h5>原始支出</h5>' +
        row('时间', F.date(hit.tx.ts) + ' ' + pad2(ed.getHours()) + ':' + pad2(ed.getMinutes())) +
        row('对方', cleanName(hit.tx.counterparty) || '—') +
        row('说明', hit.tx.product || '—') +
        row('金额', '-' + F.money(hit.tx.amount), 'exp') +
        row('分类', hit.tx.cat || '—') +
        '</div>' +
        '<div class="rd-result"><span>冲销后净额</span>' +
        '<b class="' + (l.enabled ? 'exp' : 'inc') + '">' +
        (l.enabled ? F.money(net) : F.money(hit.tx.amount)) + '</b>' +
        '<em>' + (l.enabled ? '已冲销 ' + F.money(l.amount) : '未冲销，退款计入收入') + '</em>' +
        '</div>';
    } else {
      html += '<div class="rd-col muted"><h5>原始支出</h5>' +
        '<div class="drawer-tip">未匹配到原始支出，这笔退款按收入计入统计。</div></div>';
    }
    html += '</div>';
    $('#rdBody').innerHTML = html;
  }

  /* ---------- 右侧抽屉 ---------- */
  let rdMode = null;

  function openDrawer(mode, payload) {
    rdMode = mode;
    $('#mask').hidden = false;
    $('#rdrawer').hidden = false;
    if (mode === 'report') renderReport();
    else if (mode === 'category') renderCategoryDetail(payload);
    else if (mode === 'rules') renderRules();
    else if (mode === 'quickcat') renderQuickCat(payload);
    else if (mode === 'exclude') renderExcludePanel();
  }
  function closeDrawer() {
    $('#mask').hidden = true;
    $('#rdrawer').hidden = true;
    rdMode = null;
  }

  function openCategory(name) {
    state._fromReport = (rdMode === 'report');
    openDrawer('category', name);
  }

  function renderCategoryDetail(name) {
    const applied = state.refundOffset ? R.appliedMap(state.links) : new Map();
    const list = filtered().filter(t => isRealExpense(t) && t.cat === name);
    const total = sum(list.map(t => netAmount(t, applied)));
    const partyMap = new Map();
    list.forEach(t => {
      const pn = cleanName(t.counterparty) || cleanName(t.product) || '未知';
      const cur = partyMap.get(pn) || { value: 0, count: 0 };
      cur.value += netAmount(t, applied); cur.count++;
      partyMap.set(pn, cur);
    });
    const parties = Array.from(partyMap.entries()).sort((a, b) => b[1].value - a[1].value);

    $('#rdTitle').textContent = name;
    let html = state._fromReport
      ? '<button class="btn sm ghost" id="rdBack" style="margin-bottom:10px">← 返回分析报告</button>' : '';
    html += '<div class="rd-stats">' +
      '<div><b>' + esc(F.money(total, 0)) + '</b><span>合计支出</span></div>' +
      '<div><b>' + list.length + '</b><span>笔数</span></div>' +
      '<div><b>' + esc(F.money(list.length ? total / list.length : 0, 0)) + '</b><span>笔均</span></div>' +
      '</div>';

    if (parties.length) {
      html += '<h4 class="rd-h4">构成明细</h4><div class="party-list">' +
        parties.slice(0, 30).map(([pn, v]) =>
          '<div class="party-row"><span class="pn">' + esc(pn) + '</span>' +
          '<span class="pc">' + v.count + ' 笔</span>' +
          '<span class="pv">' + esc(F.shortMoney(v.value)) + '</span>' +
          '<span class="pp">' + (v.value / (total || 1) * 100).toFixed(1) + '%</span></div>'
        ).join('') + '</div>';
    }

    html += '<h4 class="rd-h4">逐笔支出</h4><div class="rd-table">' +
      list.slice(0, 200).map(t => {
        const d = new Date(t.ts);
        return '<div class="rd-row"><span class="rd-time">' +
          esc(pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())) + '</span>' +
          '<span class="rd-name">' + esc(cleanName(t.counterparty) || '—') +
          (t.memo ? ' <em>· ' + esc(t.memo) + '</em>' : '') + '</span>' +
          '<span class="rd-amt">-' + esc(F.money(netAmount(t, applied))) + '</span></div>';
      }).join('') + '</div>';
    if (list.length > 200) html += '<div class="rd-more">仅显示前 200 笔，共 ' + list.length + ' 笔</div>';

    $('#rdBody').innerHTML = html;
    const back = $('#rdBack');
    if (back) back.onclick = () => { rdMode = 'report'; renderReport(); };
  }

  function renderExcludePanel() {
    const list = filtered();
    const st = stats(list);
    const applied = state.refundOffset ? R.appliedMap(state.links) : new Map();
    const rows = list.filter(t => isRealExpense(t) && st.excludedKeys.has(txKey(t)))
      .sort((a, b) => netAmount(b, applied) - netAmount(a, applied));

    let html = '<div class="rd-note"><b>剔除口径</b>：按四分位距（IQR）法识别特大支出，超过 ' +
      '<b>Q3 + 1.5 × IQR</b> 且不低于 <b>¥200</b> 的交易，会被排除在「日均支出（剔大额）」之外。' +
      '<br>当前阈值：<b>' + (isFinite(st.threshold) ? F.money(st.threshold, 0) : '本期样本不足，未识别') + '</b>' +
      '，共剔除 <b>' + rows.length + '</b> 笔 · <b>' + F.shortMoney(st.excludedSum) + '</b>。</div>';

    html += '<h4 class="rd-h4">已剔除的支出</h4>';
    if (!rows.length) {
      html += '<div class="task-empty">还没有剔除项，可在下方手动加入。</div>';
    } else {
      html += '<div class="ex-list">' + rows.map(t => {
        const d = new Date(t.ts);
        const auto = !state.manualExclude.has(txKey(t));
        return '<div class="ex-row"><div class="ex-main">' +
          '<div class="ex-name">' + esc(cleanName(t.counterparty) || cleanName(t.product) || '—') + '</div>' +
          '<div class="ex-sub">' + esc(F.date(t.ts) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())) +
          ' · ' + esc(t.source === 'wechat' ? '微信' : '支付宝') + ' · ' +
          (auto ? '自动识别为特大支出' : '手动剔除') + '</div></div>' +
          '<div class="ex-r"><span class="ex-amt">-' + esc(F.money(netAmount(t, applied))) + '</span>' +
          '<button class="btn sm ghost ex-del" data-key="' + esc(txKey(t)) + '">' +
          (auto ? '恢复计入' : '移除') + '</button></div></div>';
      }).join('') + '</div>';
    }

    const usedKeys = st.excludedKeys;
    const cands = list.filter(t => isRealExpense(t) && !usedKeys.has(txKey(t)))
      .sort((a, b) => netAmount(b, applied) - netAmount(a, applied)).slice(0, 12);
    html += '<h4 class="rd-h4">手动加入剔除</h4>';
    if (!cands.length) {
      html += '<div class="task-empty">当前区间没有其他支出可剔除</div>';
    } else {
      html += '<div class="ex-list">' + cands.map(t => {
        const d = new Date(t.ts);
        return '<div class="ex-row"><div class="ex-main">' +
          '<div class="ex-name">' + esc(cleanName(t.counterparty) || cleanName(t.product) || '—') + '</div>' +
          '<div class="ex-sub">' + esc(F.date(t.ts) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())) +
          ' · ' + esc(t.source === 'wechat' ? '微信' : '支付宝') + '</div></div>' +
          '<div class="ex-r"><span class="ex-amt">-' + esc(F.money(netAmount(t, applied))) + '</span>' +
          '<button class="btn sm ghost ex-add" data-key="' + esc(txKey(t)) + '">剔除</button></div></div>';
      }).join('') + '</div>';
    }
    $('#rdTitle').textContent = '大额剔除明细';
    $('#rdBody').innerHTML = html;
  }

  /* 快速归类（含备注） */
  function renderQuickCat(kw) {
    $('#rdTitle').textContent = '归类「' + kw + '」';
    const opts = C.CATS.filter(c => c.kind !== 'neutral')
      .map(c => '<option value="' + c.name + '">' + c.name + '</option>').join('');
    const same = state.items.filter(t =>
      (cleanName(t.counterparty) || cleanName(t.product) || '未知商户') === kw);
    $('#rdBody').innerHTML =
      '<div class="rd-form">' +
      '<label>把「' + esc(kw) + '」归到</label>' +
      '<select class="select" id="qcCat">' + opts + '</select>' +
      '<label>备注（选填，会记在交易上）</label>' +
      '<input type="text" class="search" id="qcMemo" placeholder="例如：和朋友聚餐 AA" maxlength="40">' +
      '<button class="btn primary" id="qcOk">保存归类</button>' +
      '</div>' +
      '<h4 class="rd-h4">相关交易（' + same.length + ' 笔）</h4><div class="rd-table">' +
      same.slice(0, 20).map(t =>
        '<div class="rd-row"><span class="rd-time">' + esc(F.date(t.ts)) + '</span>' +
        '<span class="rd-name">' + esc(t.product || '—') +
        (t.memo ? ' <em>· ' + esc(t.memo) + '</em>' : '') + '</span>' +
        '<span class="rd-amt">-' + esc(F.money(t.amount)) + '</span></div>'
      ).join('') + '</div>';

    $('#qcOk').onclick = () => {
      const cat = $('#qcCat').value;
      const memo = $('#qcMemo').value.trim();
      applyPending(kw, cat, memo);
      closeDrawer();
    };
  }

  /* ---------- 规则管理 ---------- */
  function renderRules() {
    const rules = C.getCustomRules();
    $('#rdTitle').textContent = '分类规则';
    let html = '<div class="rd-note">命中关键词的交易会优先归入你指定的分类，规则保存在本机浏览器。' +
      '在明细表里点击分类标签，也能快速给某个商户建立规则。</div>' +
      '<div class="rule-form">' +
      '<input type="text" id="ruleKw" placeholder="关键词，如：瑞幸" maxlength="24">' +
      '<select id="ruleCat" class="select">' + C.CATS.filter(c => c.kind !== 'neutral')
        .map(c => '<option value="' + c.name + '">' + c.name + '</option>').join('') + '</select>' +
      '<button class="btn primary sm" id="btnAddRule">添加</button>' +
      '</div><div class="rule-list">';
    if (!rules.length) {
      html += '<div class="drawer-tip">暂无自定义规则。内置规则已覆盖常见商户，你可以补充自己的消费习惯。</div>';
    } else {
      html += rules.map(r =>
        '<div class="rule-item"><span class="kw">' + esc(r.kw) + '</span><span class="arrow">→</span>' +
        '<span class="cat-tag" style="background:' + C.color(r.cat) + '1f;color:' + C.color(r.cat) + '">' +
        esc(r.cat) + '</span>' +
        '<button class="del" data-kw="' + esc(r.kw) + '" title="删除">✕</button></div>'
      ).join('');
    }
    html += '</div>';
    if (rules.length) {
      html += '<button class="btn sm danger ghost" id="btnClearRules" style="margin-top:14px">清空自定义规则</button>';
    }
    $('#rdBody').innerHTML = html;

    $('#btnAddRule').onclick = () => {
      const kw = $('#ruleKw').value.trim();
      const cat = $('#ruleCat').value;
      if (!kw) { toast('请输入关键词', true); return; }
      C.addRule(kw, cat);
      reclassify();
      renderRules();
      toast('规则已添加');
    };
    const list = $('#rdBody').querySelector('.rule-list');
    if (list) list.onclick = e => {
      const b = e.target.closest('.del');
      if (!b) return;
      C.removeRule(b.dataset.kw);
      reclassify();
      renderRules();
    };
    const clr = $('#btnClearRules');
    if (clr) clr.onclick = () => {
      if (!confirm('清空所有自定义分类规则？')) return;
      C.clearRules();
      reclassify();
      renderRules();
      toast('已清空自定义规则');
    };
  }

  function reclassify() {
    state.items.forEach(t => { if (!t.confirmed) t.cat = C.classify(t); });
    finalize(false);
  }

  /* ---------- 导出 ---------- */
  function exportCSV(list, name) {
    if (!list.length) { toast('当前没有可导出的数据', true); return; }
    const names = { alipay: '支付宝', wechat: '微信支付', other: '其他' };
    const applied = state.refundOffset ? R.appliedMap(state.links) : new Map();
    const head = ['时间', '来源', '交易对方', '商品说明', '分类', '收支', '金额(元)', '冲销(元)', '计入支出(元)', '支付方式', '状态', '备注'];
    const lines = [head.join(',')];
    list.forEach(t => {
      const d = new Date(t.ts);
      const ts = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
        pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      let io = '不计收支';
      if (isRealExpense(t)) io = '支出';
      else if (isRealIncome(t)) io = '收入';
      else if (t.kind === 'refund') io = '退款';
      const off = isRealExpense(t) ? (applied.get(txKey(t)) || 0) : 0;
      const net = isRealExpense(t) ? netAmount(t, applied) : '';
      lines.push([
        ts, names[t.source] || t.source, t.counterparty, t.product, t.cat, io,
        t.amount.toFixed(2), off ? off.toFixed(2) : '', net === '' ? '' : net.toFixed(2),
        t.method, t.status, t.memo || t.note || ''
      ].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || ('账单明细_' + F.date(Date.now()) + '.csv'); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('已导出 ' + list.length + ' 条记录');
  }

  /* ================= 事件 ================= */
  function bind() {
    const fi = $('#fileInput');
    const pick = () => fi.click();
    $('#btnPick').onclick = $('#btnPick2').onclick = $('#btnAdd').onclick = pick;
    fi.onchange = e => { requestUpload(Array.from(e.target.files)); fi.value = ''; };

    const dz = $('#dropZone');
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
      if (dz) { e.preventDefault(); dz.classList.add('over'); }
    }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
      if (dz) { e.preventDefault(); dz.classList.remove('over'); }
    }));
    document.addEventListener('drop', e => {
      if (e.dataTransfer && e.dataTransfer.files.length) requestUpload(Array.from(e.dataTransfer.files));
    });

    $('#optAppend').onclick = () => doUpload('append');
    $('#optReplace').onclick = () => doUpload('replace');
    $('#optCancel').onclick = () => { pendingFiles = null; $('#uploadModal').hidden = true; };
    // 点击遮罩空白处等同于取消
    $('#uploadModal').onclick = e => { if (e.target === $('#uploadModal')) $('#optCancel').click(); };

    $('#viewTabs').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      state.view = b.dataset.v; state.page = 1; renderAll();
    };

    $('#rangeSeg').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      setPeriod({ kind: 'range', r: b.dataset.r });
    };
    $('#granSeg').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      state.gran = b.dataset.g; persist(); renderAll();
    };
    $('#fromDate').onchange = () => {
      state.from = $('#fromDate').value;
      if (state.from) { state.period = { kind: 'custom' }; state.page = 1; renderAll(); }
    };
    $('#toDate').onchange = () => {
      state.to = $('#toDate').value;
      if (state.to || state.from) { state.period = { kind: 'custom' }; state.page = 1; renderAll(); }
    };

    $('#swTrans').onchange = e => { state.includeTransfer = e.target.checked; persist(); renderAll(); };
    $('#swRefund').onchange = e => { state.refundOffset = e.target.checked; persist(); renderAll(); };
    $('#swExclude').onchange = e => { state.autoExclude = e.target.checked; persist(); renderAll(); };

    $('#sourceChips').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const s = b.dataset.src;
      if (state.sources.has(s)) state.sources.delete(s); else state.sources.add(s);
      if (!state.sources.size) state.sources.add(s);
      state.page = 1; renderSourceChips(); renderAll();
    };
    $('#flowChips').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      state.flow = b.dataset.flow; state.page = 1; renderFlowChips(); renderAll();
    };
    $('#catSelect').onchange = e => { state.cat = e.target.value; state.page = 1; renderAll(); };
    let qt;
    $('#searchInput').oninput = e => {
      clearTimeout(qt);
      qt = setTimeout(() => { state.q = e.target.value; state.page = 1; renderAll(); }, 220);
    };

    $('#btnRefundAllOn').onclick = () => {
      state.links.forEach(l => { if (l.chosen) l.enabled = true; });
      finalize(false);
      toast('已开启全部匹配到的冲销');
    };
    $('#btnRefundAllOff').onclick = () => {
      state.links.forEach(l => { l.enabled = false; });
      finalize(false);
      toast('已取消全部冲销，退款将计入收入');
    };

    $('#btnExport').onclick = () => exportCSV(filtered());
    $('#btnExportCur').onclick = () => exportCSV(filtered());
    $('#btnReport').onclick = () => openDrawer('report');
    $('#btnRules').onclick = () => openDrawer('rules');
    $('#rdClose').onclick = closeDrawer;
    $('#mask').onclick = closeDrawer;

    $('#btnClear').onclick = () => {
      if (!confirm('确定清空全部账单数据吗？分类规则会保留，本机缓存的账单会被删除。')) return;
      state.items = []; state.files = []; state.links = [];
      state.manualExclude.clear(); state.keepIn.clear();
      localStorage.removeItem(DATA_KEY);
      finalize(false);
      toast('已清空数据');
    };

    $('#detailTable').addEventListener('click', e => {
      const tag = e.target.closest('.cat-tag');
      if (!tag) return;
      const kw = tag.dataset.kw;
      if (!kw) { toast('该交易没有可用于建立规则的关键词'); return; }
      openDrawer('quickcat', kw);
    });
    $$('#detailTable th.sortable').forEach(th => {
      th.onclick = () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir *= -1;
        else { state.sortKey = k; state.sortDir = -1; }
        renderAll();
      };
    });
    $('#pager').onclick = e => {
      const b = e.target.closest('button[data-p]'); if (!b || b.disabled) return;
      state.page = +b.dataset.p; renderAll();
    };

    $('#kpis').addEventListener('click', e => {
      const b = e.target.closest('[data-info]');
      if (!b) return;
      openDrawer(b.dataset.info);
    });

    $('#sbTree').addEventListener('click', e => {
      const b = e.target.closest('.sb-tree-item'); if (!b) return;
      const t = b.dataset.t;
      if (t === 'year') {
        const wrap = b.parentElement;
        const open = !wrap.classList.contains('open');
        wrap.classList.toggle('open', open);
        const tw = b.querySelector('.tw');
        if (tw) tw.textContent = open ? '▾' : '▸';
        return;
      }
      setPeriod({ kind: 'month', y: +b.dataset.y, m: +b.dataset.m });
    });
    const allBtn = document.querySelector('.sb-tree-item[data-t="all"]');
    if (allBtn) allBtn.onclick = () => setPeriod({ kind: 'all' });

    $('#sbToggle').onclick = () => $('#sidebar').classList.add('mini');
    $('#sbShow').onclick = () => $('#sidebar').classList.remove('mini');

    const nick = $('#nickInput');
    nick.value = state.nickname || '';
    nick.addEventListener('input', () => {
      state.nickname = nick.value.trim();
      try { localStorage.setItem(NICK_KEY, state.nickname); } catch (e) { }
      persist();
      renderGreet(stats(filtered()), filtered());
    });

    $('#btnTheme').onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
      setTimeout(renderAll, 60);
    };

    let rz;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => { if (state.items.length) renderAll(); }, 200);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

    // 抽屉内交互
    $('#rdBody').addEventListener('click', e => {
      const ok = e.target.closest('.task-ok');
      if (ok) {
        const item = ok.closest('.task-item');
        applyPending(item.dataset.kw, item.querySelector('.task-cat').value,
          item.querySelector('.task-memo').value.trim());
        return;
      }
      const skip = e.target.closest('.task-skip');
      if (skip) {
        const item = skip.closest('.task-item');
        applyPending(item.dataset.kw, '其他支出', item.querySelector('.task-memo').value.trim());
        return;
      }
      const del = e.target.closest('.ex-del');
      if (del) {
        const key = del.dataset.key;
        if (state.manualExclude.has(key)) state.manualExclude.delete(key);
        else state.keepIn.add(key);
        finalize(false);
        if (rdMode === 'exclude') renderExcludePanel();
        return;
      }
      const add = e.target.closest('.ex-add');
      if (add) {
        state.manualExclude.add(add.dataset.key);
        state.keepIn.delete(add.dataset.key);
        finalize(false);
        if (rdMode === 'exclude') renderExcludePanel();
        return;
      }
      const det = e.target.closest('.recon-detail');
      if (det) {
        state._rdIdx = +det.closest('.recon-item').dataset.i;
        rdMode = 'refund-detail';
        $('#rdTitle').textContent = '冲销详情';
        renderRefundDetail(state._rdIdx);
        return;
      }
      const crow = e.target.closest('[data-catrow]');
      if (crow) {
        rdMode = 'category';
        $('#rdTitle').textContent = crow.dataset.catrow;
        renderCategoryDetail(crow.dataset.catrow);
      }
    });
    $('#rdBody').addEventListener('change', e => {
      const sel = e.target.closest('.recon-sel');
      if (sel) {
        const i = +sel.closest('.recon-item').dataset.i;
        state.links[i].chosen = sel.value || null;
        state.links[i].enabled = !!sel.value;
        finalize(false);
      }
    });

    // 冲销开关 + 匹配切换（tab 内）
    $('#refundList').addEventListener('click', e => {
      const sw = e.target.closest('.recon-sw');
      if (sw) {
        const i = +sw.closest('.recon-item').dataset.i;
        state.links[i].enabled = sw.checked;
        finalize(false);
        return;
      }
      const det = e.target.closest('.recon-detail');
      if (det) {
        state._rdIdx = +det.closest('.recon-item').dataset.i;
        rdMode = 'refund-detail';
        $('#rdTitle').textContent = '冲销详情';
        renderRefundDetail(state._rdIdx);
      }
    });
    $('#refundList').addEventListener('change', e => {
      const sel = e.target.closest('.recon-sel');
      if (sel) {
        const i = +sel.closest('.recon-item').dataset.i;
        state.links[i].chosen = sel.value || null;
        state.links[i].enabled = !!sel.value;
        finalize(false);
      }
    });

    let pq;
    $('#pendingSearch').oninput = e => {
      clearTimeout(pq);
      pq = setTimeout(() => { state.pendingQ = e.target.value; renderPending(); }, 200);
    };
  }

  /* ================= 报告 ================= */
  function renderReport() {
    const list = filtered();
    const st = stats(list);
    const totalExp = st.expense || 1;
    const cats = Array.from(st.catMap.entries()).sort((a, b) => b[1] - a[1]);
    const parties = Array.from(st.partyMap.entries()).sort((a, b) => b[1].value - a[1].value);

    const [a, b] = rangeBounds();
    const len = b - a;
    let prevExp = 0, prevCount = 0;
    if (a > 0 && len && len < 200 * 86400000) {
      const prev = state.items.filter(t => t.ts >= a - len && t.ts < a);
      prevCount = prev.length;
      prev.forEach(t => {
        if (isRealExpense(t)) prevExp += t.amount;
        else if (t.kind === 'refund' && state.refundOffset) prevExp -= t.amount;
      });
    }

    const dowNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const dowMap = new Map();
    list.filter(isRealExpense).forEach(t => {
      const k = new Date(t.ts).getDay();
      dowMap.set(k, (dowMap.get(k) || 0) + t.amount);
    });
    let topDow = null;
    dowMap.forEach((v, k) => { if (!topDow || v > topDow.v) topDow = { k, v }; });
    const night = list.filter(t => isRealExpense(t) &&
      (new Date(t.ts).getHours() >= 23 || new Date(t.ts).getHours() < 5));

    let html = '<div class="rd-range">' + esc(periodLabel()) +
      '<span>' + esc(periodSub()) + '</span></div>';

    html += '<div class="rd-stats">' +
      '<div><b>' + esc(F.money(st.expense, 0)) + '</b><span>总支出</span></div>' +
      '<div><b>' + esc(F.money(st.income, 0)) + '</b><span>总收入</span></div>' +
      '<div><b>' + esc(F.money(st.income - st.expense, 0)) + '</b><span>结余</span></div>' +
      '<div><b>' + esc(F.money(st.avg, 0)) + '</b><span>日均支出</span></div>' +
      '<div><b>' + esc(F.money(st.avgEx, 0)) + '</b><span>日均(剔大额)</span></div>' +
      '</div>';

    if (prevExp > 0) {
      const d = st.expense - prevExp;
      const pct = (Math.abs(d) / prevExp * 100).toFixed(1);
      html += '<div class="rd-sec"><h4 class="rd-h4">环比</h4><div class="rd-cmp ' +
        (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '▲' : '▼') + ' 本期比上一周期' +
        (d > 0 ? '多花' : '少花') + ' <b>' + F.money(Math.abs(d)) + '</b>（' + pct + '%），上一周期 ' +
        F.shortMoney(prevExp) + ' / ' + prevCount + ' 笔</div></div>';
    }

    if (cats.length) {
      html += '<div class="rd-sec"><h4 class="rd-h4">支出分类</h4>' +
        '<table class="table mini"><thead><tr><th>分类</th><th class="num">金额</th><th class="num">占比</th><th class="num">笔数</th></tr></thead><tbody>' +
        cats.map(([name, v]) => {
          const cnt = list.filter(t => isRealExpense(t) && t.cat === name).length;
          return '<tr data-catrow="' + esc(name) + '"><td><span class="dot" style="background:' +
            C.color(name) + '"></span> ' + esc(name) + '</td><td class="num">' + esc(F.money(v)) +
            '</td><td class="num">' + (v / totalExp * 100).toFixed(1) + '%</td><td class="num">' + cnt + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    if (parties.length) {
      html += '<div class="rd-sec"><h4 class="rd-h4">主要商户</h4><div class="party-list">' +
        parties.slice(0, 12).map(([pn, v]) =>
          '<div class="party-row"><span class="pn">' + esc(pn) + '</span><span class="pc">' + v.count + ' 笔</span>' +
          '<span class="pv">' + esc(F.shortMoney(v.value)) + '</span><span class="pp">' +
          (v.value / totalExp * 100).toFixed(1) + '%</span></div>').join('') + '</div></div>';
    }

    html += '<div class="rd-sec"><h4 class="rd-h4">消费节奏</h4><div class="rd-kv">' +
      kv('有支出的天数', st.daily.size + ' 天') +
      kv('花钱最多的星期', topDow ? dowNames[topDow.k] + '（' + F.shortMoney(topDow.v) + '）' : '—') +
      kv('深夜消费', night.length + ' 笔 · ' + F.shortMoney(sum(night.map(t => t.amount)))) +
      kv('最大单笔', st.max ? F.shortMoney(st.max.amount) + '（' + cleanName(st.max.t.counterparty) + '）' : '—') +
      '</div></div>';

    const tips = [];
    if (st.income > 0 && st.income - st.expense < 0) tips.push('支出已超过收入，建议先从占比最高的分类入手压缩。');
    if (prevExp > 0 && st.expense > prevExp * 1.15) tips.push('本期支出明显高于上一周期，确认一下是否包含一次性大额开销。');
    if (night.length >= 3) tips.push('深夜消费偏多，把购物车留到第二天再决定，能省下不少冲动消费。');
    if (cats.length && (cats[0][1] / totalExp) > 0.4) tips.push('「' + cats[0][0] + '」占了四成以上支出，集中度偏高。');
    if (st.pendingCount) tips.push('还有 ' + st.pendingCount + ' 笔支出没归类，处理完统计会更准确。');
    if (!tips.length) tips.push('各项支出分布均衡，保持现在的节奏就好。');
    html += '<div class="rd-sec"><h4 class="rd-h4">小建议</h4><ul class="rd-tips">' +
      tips.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div>';

    $('#rdBody').innerHTML = html;
  }
  function kv(k, v) { return '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; }

  /* ================= 示例数据 ================= */
  function loadDemo() {
    const recs = window.DemoGen.makeRecords({ days: 180 });
    state.items = [];
    recs.forEach((r, i) => {
      if (/交易关闭|已关闭/.test(r.status)) return;
      let flow = 'neutral';
      if (r.io === '支出') flow = 'expense';
      else if (r.io === '收入') flow = 'income';
      const kind = flow === 'neutral' ? 'transfer' : (/退款/.test(r.status) ? 'refund' : 'normal');
      const t = {
        source: r.source === 'wechat' ? 'wechat' : 'alipay',
        ts: r.ts.getTime(), counterparty: r.counterparty, product: r.product,
        note: '', method: r.pay, status: r.status, rawCategory: r.type || '',
        orderId: 'demo-' + i, amount: r.amount, flow, kind, memo: ''
      };
      t.cat = C.classify(t);
      state.items.push(t);
    });
    state.files = [{ name: '示例数据（随机生成）', source: 'other', count: state.items.length, tz: 0 }];
    finalize(true);
  }

  /* ================= 启动 ================= */
  function init() {
    const qs = new URLSearchParams(location.search);
    const urlTheme = qs.get('theme');
    const savedTheme = urlTheme || localStorage.getItem(THEME_KEY);
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    state.nickname = localStorage.getItem(NICK_KEY) || '';
    bind();
    if (qs.has('demo')) loadDemo();
    else if (restore()) {
      renderFiles(); buildCategoryOptions(); renderSidebar(); renderAll();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
