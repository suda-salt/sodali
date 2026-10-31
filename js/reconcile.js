/* ============================================================
 *  bill-analyzer · 退款冲销匹配
 *  把每一笔退款（收入且标记为 refund）与可能的原始支出配对，
 *  供用户决定是否冲销；冲销后该支出按净额计入统计。
 * ============================================================ */
(function (global) {
  'use strict';

  /* 交易的稳定标识（不依赖订单号，保证持久化前后一致） */
  function txKey(t) {
    return [t.source, t.ts, t.amount, t.counterparty || '', t.product || ''].join('|');
  }

  const DAY = 86400000;
  const WINDOW = 120; // 退款与原始支出的最大间隔（天）

  function norm(s) { return String(s || '').replace(/[\s*#]/g, ''); }

  function score(expense, refund) {
    let s = 0;
    const ec = norm(expense.counterparty), rc = norm(refund.counterparty);
    if (ec && rc) {
      if (ec === rc) s += 45;
      else if (ec.includes(rc) || rc.includes(ec)) s += 30;
    }
    const diff = expense.amount - refund.amount;
    if (Math.abs(diff) < 0.011) s += 40;
    else if (diff > 0 && diff <= expense.amount * 0.2) s += 22;
    else if (diff > 0) s += 10;
    else return -1; // 退款大于原支出，不配对

    const gap = (refund.ts - expense.ts) / DAY;
    if (gap < 0) return -1;
    if (gap <= 3) s += 25;
    else if (gap <= 7) s += 20;
    else if (gap <= 30) s += 12;
    else if (gap <= 60) s += 6;
    else if (gap <= WINDOW) s += 2;
    else return -1;

    const ep = norm(expense.product), rp = norm(refund.product);
    if (ep && rp && (ep === rp || ep.includes(rp) || rp.includes(ep))) s += 12;
    return s;
  }

  /* 返回：[{ rkey, refund, cands:[{key, tx, score}], chosen, enabled, amount }] */
  function build(items, prev) {
    const expenses = items.filter(t => t.flow === 'expense');
    const refunds = items.filter(t => t.kind === 'refund');
    const prevMap = new Map();
    (prev || []).forEach(p => prevMap.set(p.rkey, p));

    return refunds.map(r => {
      const rkey = txKey(r);
      const cands = [];
      expenses.forEach(e => {
        const sc = score(e, r);
        if (sc > 0) cands.push({ key: txKey(e), tx: e, score: sc });
      });
      cands.sort((a, b) => b.score - a.score);
      const top = cands.slice(0, 5);
      const old = prevMap.get(rkey);
      const auto = top.length && top[0].score >= 30 ? top[0].key : null;
      return {
        rkey,
        refund: r,
        cands: top,
        chosen: old ? old.chosen : auto,
        enabled: old ? old.enabled : !!auto,
        amount: r.amount
      };
    });
  }

  /* 支出 → 已冲销金额 */
  function appliedMap(links) {
    const m = new Map();
    (links || []).forEach(l => {
      if (!l.enabled || !l.chosen) return;
      m.set(l.chosen, (m.get(l.chosen) || 0) + l.amount);
    });
    return m;
  }

  global.Reconcile = { build, appliedMap, txKey };
})(window);
