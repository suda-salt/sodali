/* ============================================================
 *  bill-analyzer · 账单解析器
 *  支持：支付宝（新版 / 旧版表头）、微信支付账单
 *  产出统一的 transaction 结构
 * ============================================================ */
(function (global) {
  'use strict';

  const FE = global.FileEngine;

  /* 表头别名映射 */
  const ALIASES = {
    time: ['交易时间', '交易创建时间', '付款时间', '时间', '交易日'],
    rawCategory: ['交易分类', '类型', '交易类型'],
    counterparty: ['交易对方', '对方', '收款方', '商户名称'],
    account: ['对方账号', '对方户名'],
    product: ['商品说明', '商品名称', '商品', '说明', '备注说明'],
    io: ['收/支', '收支', '收入/支出', '收\/支'],
    amount: ['金额', '金额(元)', '金额（元）', '发生金额', '金额/元'],
    method: ['收/付款方式', '付款方式', '支付方式', '付款方法'],
    status: ['交易状态', '当前状态', '状态'],
    orderId: ['交易订单号', '交易单号', '交易号', '订单号', '流水号'],
    bizId: ['商家订单号', '商户单号', '业务订单号'],
    note: ['备注']
  };

  function buildMap(cells) {
    const map = {};
    const norm = cells.map(c => String(c).replace(/\s|　/g, '').replace(/[()（）]/g, m => m));
    Object.keys(ALIASES).forEach(key => {
      const list = ALIASES[key];
      for (let i = 0; i < list.length; i++) {
        const idx = norm.findIndex(c => c === list[i]);
        if (idx >= 0) { map[key] = idx; return; }
      }
    });
    return map;
  }

  function pick(row, idx) {
    if (idx == null || idx < 0) return '';
    return String(row[idx] == null ? '' : row[idx]).trim();
  }

  function parseDateTime(s) {
    if (!s) return null;
    const m = String(s).trim().match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    return new Date(
      +m[1], +m[2] - 1, +m[3],
      m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0
    ).getTime();
  }

  function parseAmount(s) {
    if (s == null) return 0;
    let t = String(s).replace(/[¥￥$,\s]/g, '').replace(/元/g, '');
    if (/^\(.*\)$/.test(t)) t = '-' + t.slice(1, -1);
    const v = parseFloat(t);
    return isNaN(v) ? 0 : v;
  }

  /* 判断来源 */
  function detectSource(cells, fileName) {
    const j = cells.join('|');
    if (j.includes('交易对方') && (j.includes('商家订单号') || j.includes('收/付款方式'))) return 'alipay';
    if (j.includes('交易对方') && j.includes('付款时间') && j.includes('资金状态')) return 'alipay';
    if (j.includes('支付方式') || (j.includes('当前状态') && j.includes('商户单号'))) return 'wechat';
    if (j.includes('支付金额') || j.includes('厦门银行')) return 'other';
    const n = (fileName || '').toLowerCase();
    if (n.includes('alipay')) return 'alipay';
    if (n.includes('wechat') || n.includes('wx')) return 'wechat';
    return 'unknown';
  }

  /* ---------- 主入口：把 CSV 文本解析为交易记录 ---------- */
  function parseText(text, fileName) {
    const rows = FE.parseCSV(text);
    const head = FE.locateHeader(rows);
    if (!head) {
      throw new Error('未在文件中找到账单表头，请确认上传的是支付宝 / 微信导出的原始账单');
    }
    const map = buildMap(head.cells);
    const source = detectSource(head.cells, fileName);
    if (map.time == null || map.amount == null) {
      throw new Error('账单缺少「交易时间」或「金额」列，无法解析');
    }

    const list = [];
    for (let i = head.index + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 3) continue;
      // 支付宝账单尾部有分隔说明
      const first = pick(row, 0);
      if (/^[-=———]+$/.test(first)) continue;

      const ts = parseDateTime(pick(row, map.time));
      if (!ts) continue;
      const amountRaw = Math.abs(parseAmount(pick(row, map.amount)));
      if (!amountRaw) continue;

      const ioRaw = pick(row, map.io);
      const status = pick(row, map.status);
      const rawCategory = map.rawCategory != null ? pick(row, map.rawCategory) : '';
      const counterparty = pick(row, map.counterparty);
      const product = pick(row, map.product);
      const note = pick(row, map.note);
      const method = pick(row, map.method);
      const orderId = pick(row, map.orderId) || pick(row, map.bizId);

      // 无效交易（取消 / 失败）直接丢弃
      if (/(交易关闭|已关闭|支付失败|交易失败|已撤销|已失效|对方已退)/.test(status)) continue;
      if (/^(交易关闭|退款关闭)/.test(rawCategory)) continue;

      let flow = 'neutral';
      if (/支出/.test(ioRaw)) flow = 'expense';
      else if (/收入/.test(ioRaw)) flow = 'income';
      else if (ioRaw === '' || ioRaw === '/' || /不计/.test(ioRaw)) flow = 'neutral';

      let kind = 'normal';
      if (/(退款|退票|返款)/.test(status + '|' + rawCategory + '|' + product)) kind = 'refund';
      if (flow === 'neutral') kind = 'transfer';

      list.push({
        source, ts,
        counterparty, product, note, method, status, rawCategory, orderId,
        amount: amountRaw,
        flow, kind
      });
    }
    return { source, list };
  }

  /* 解析单个文件的所有表（zip 内可能有多个 csv） */
  async function parseFile(file) {
    const parts = await FE.unpack(file);
    const all = [];
    const sources = {};
    for (const p of parts) {
      const r = parseText(p.text, p.name);
      sources[r.source] = (sources[r.source] || 0) + r.list.length;
      all.push(...r.list);
    }
    // 去重：优先按订单号，其次按 时间+金额+对方
    const seen = new Set();
    let dup = 0;
    const uniq = all.filter(t => {
      const k = (t.source + '|' + (t.orderId || '') + '|' + t.ts + '|' + t.amount + '|' + t.counterparty);
      if (seen.has(k)) { dup++; return false; }
      seen.add(k);
      return true;
    });
    return { items: uniq, sources, duplicate: dup, files: parts.length };
  }

  global.BillParser = { parseFile, parseText, parseDateTime, parseAmount };
})(window);
