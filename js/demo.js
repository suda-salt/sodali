/* ============================================================
 *  bill-analyzer · 示例账单生成器
 *  用途：① 首屏 demo（?demo=1）② 自动化测试构造样本
 * ============================================================ */
(function (global) {
  'use strict';

  const TEMPLATES = [
    { n: '瑞幸咖啡', p: '美式咖啡', min: 12, max: 32, w: 6, src: 'wechat', ttype: '商户消费', pays: ['零钱', '招商银行(1234)'] },
    { n: '美团外卖', p: '午餐订单', min: 18, max: 58, w: 7, src: 'wechat', ttype: '商户消费', pays: ['零钱', '工商银行(5678)'] },
    { n: '肯德基', p: '炸鸡套餐', min: 25, max: 65, w: 3, src: 'alipay', ttype: '餐饮美食', pays: ['花呗', '余额宝'] },
    { n: '海底捞火锅', p: '堂食消费', min: 120, max: 320, w: 1, src: 'alipay', ttype: '餐饮美食', pays: ['余额宝'] },
    { n: '滴滴出行', p: '快车行程', min: 12, max: 68, w: 5, src: 'alipay', ttype: '交通出行', pays: ['余额宝'] },
    { n: '深圳地铁', p: '乘车码扣款', min: 3, max: 12, w: 6, src: 'wechat', ttype: '商户消费', pays: ['零钱'] },
    { n: '中石化加油站', p: '92号汽油', min: 120, max: 400, w: 1, src: 'alipay', ttype: '交通出行', pays: ['招商银行(1234)'] },
    { n: '12306', p: '高铁票', min: 80, max: 550, w: 1, src: 'alipay', ttype: '交通出行', pays: ['招商银行(1234)'] },
    { n: '淘宝网', p: '商品订单', min: 25, max: 480, w: 8, src: 'alipay', ttype: '购物消费', pays: ['花呗', '余额宝'] },
    { n: '京东商城', p: '数码配件', min: 39, max: 1200, w: 3, src: 'wechat', ttype: '商户消费', pays: ['零钱', '工商银行(5678)'] },
    { n: '拼多多', p: '日常用品', min: 9, max: 130, w: 4, src: 'wechat', ttype: '商户消费', pays: ['零钱'] },
    { n: '沃尔玛超市', p: '购物结算', min: 45, max: 320, w: 3, src: 'alipay', ttype: '购物消费', pays: ['余额宝'] },
    { n: '优衣库', p: '服饰', min: 99, max: 599, w: 1, src: 'alipay', ttype: '美容服饰', pays: ['花呗'] },
    { n: '万达影城', p: '电影票 x2', min: 60, max: 130, w: 2, src: 'wechat', ttype: '商户消费', pays: ['零钱'] },
    { n: '腾讯视频', p: '会员自动续费', min: 25, max: 30, w: 2, src: 'wechat', ttype: '商户消费', pays: ['零钱'] },
    { n: '健身房年卡', p: '私教课程', min: 200, max: 1200, w: 1, src: 'alipay', ttype: '休闲娱乐', pays: ['余额宝'] },
    { n: '屈臣氏', p: '护肤品', min: 60, max: 380, w: 2, src: 'wechat', ttype: '商户消费', pays: ['零钱'] },
    { n: '老百姓大药房', p: '感冒药', min: 20, max: 180, w: 2, src: 'alipay', ttype: '医疗健康', pays: ['余额宝'] },
    { n: '中国移动', p: '手机话费充值', min: 50, max: 200, w: 2, src: 'alipay', ttype: '生活服务', pays: ['余额宝'] },
    { n: '顺丰速运', p: '寄付月结', min: 12, max: 45, w: 3, src: 'wechat', ttype: '商户消费', pays: ['零钱'] },
    { n: '物业管理处', p: '物业费代扣', min: 180, max: 320, w: 1, src: 'alipay', ttype: '居住物业', pays: ['招商银行(1234)'] },
    { n: '国家电网', p: '电费缴费', min: 60, max: 260, w: 1, src: 'alipay', ttype: '居住物业', pays: ['余额宝'] },
    { n: '房东张女士', p: '房租', min: 2800, max: 2800, w: 1, src: 'alipay', ttype: '转账红包', pays: ['招商银行(1234)'] },
    { n: '得到 APP', p: '课程购买', min: 99, max: 399, w: 1, src: 'alipay', ttype: '教育培训', pays: ['余额宝'] },
    { n: '携程旅行网', p: '酒店预订', min: 300, max: 1600, w: 1, src: 'wechat', ttype: '商户消费', pays: ['工商银行(5678)'] },
    // 以下为「无法自动归类」的样本，用于演示待归类任务
    { n: '刘先生', p: '往来款', min: 50, max: 600, w: 2, src: 'wechat', ttype: '转账', pays: ['零钱'] },
    { n: '便民服务部', p: '服务费', min: 15, max: 180, w: 2, src: 'alipay', ttype: '其他', pays: ['余额宝'] }
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ts(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* 生成伪账单记录 */
  function makeRecords(opts) {
    opts = opts || {};
    const days = opts.days || 180;
    const seed = opts.seed || 20261031;
    const rnd = mulberry32(seed);
    const recs = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const pool = [];
    TEMPLATES.forEach(t => { for (let i = 0; i < (t.w || 1); i++) pool.push(t); });

    for (let d = days; d >= 0; d--) {
      const base = new Date(today); base.setDate(base.getDate() - d);
      const dow = base.getDay();
      const factor = (dow === 0 || dow === 6) ? 1.4 : 1.0;
      const cnt = Math.round(rnd() * 3.4 * factor);
      for (let i = 0; i < cnt; i++) {
        const t = pool[Math.floor(rnd() * pool.length)];
        const dt = new Date(base);
        dt.setHours(7 + Math.floor(rnd() * 15), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
        if (t.ttype === '交通出行') dt.setHours(7 + Math.floor(rnd() * 3));
        const amount = +(t.min + rnd() * (t.max - t.min)).toFixed(2);
        recs.push({
          ts: dt, date: ts(dt), source: t.src || 'alipay',
          counterparty: t.n, product: t.p, amount,
          io: '支出', type: t.ttype, pay: t.pays[Math.floor(rnd() * t.pays.length)],
          status: '交易成功'
        });
      }
      // 每月 10 号发工资
      if (base.getDate() === 10) {
        const dt = new Date(base); dt.setHours(10, 30, 0);
        recs.push({
          ts: dt, date: ts(dt), source: 'alipay', counterparty: '某某科技有限公司',
          product: '工资代发', amount: +(12000 + rnd() * 2500).toFixed(2),
          io: '收入', type: '转账', pay: '招商银行(1234)', status: '交易成功'
        });
      }
      // 偶发红包收入
      if (rnd() < 0.04) {
        const dt = new Date(base); dt.setHours(12, 0, 0);
        recs.push({
          ts: dt, date: ts(dt), source: 'wechat', counterparty: '家人',
          product: '微信红包', amount: +(20 + rnd() * 180).toFixed(2),
          io: '收入', type: '微信红包', pay: '零钱', status: '已存入零钱'
        });
      }
      // 偶发退款
      if (rnd() < 0.03) {
        const dt = new Date(base); dt.setHours(16, 0, 0);
        recs.push({
          ts: dt, date: ts(dt), source: 'alipay', counterparty: '淘宝卖家',
          product: '退款成功', amount: +(30 + rnd() * 200).toFixed(2),
          io: '收入', type: '退款', pay: '余额宝', status: '退款成功'
        });
      }
      // 不计收支：余额宝转入 / 信用卡还款
      if (rnd() < 0.05) {
        const dt = new Date(base); dt.setHours(9, 0, 0);
        recs.push({
          ts: dt, date: ts(dt), source: 'alipay', counterparty: '天弘基金管理有限公司',
          product: '转入余额宝', amount: +(500 + rnd() * 3000).toFixed(2),
          io: '不计收支', type: '投资理财', pay: '余额宝', status: '交易成功'
        });
      }
      if (base.getDate() === 5) {
        const dt = new Date(base); dt.setHours(8, 0, 0);
        recs.push({
          ts: dt, date: ts(dt), source: 'alipay', counterparty: '招商银行信用卡',
          product: '信用卡还款', amount: +(800 + rnd() * 3200).toFixed(2),
          io: '不计收支', type: '信用借还', pay: '招商银行(1234)', status: '还款成功'
        });
      }
      // 应被过滤掉的记录：交易关闭
      if (rnd() < 0.02) {
        const dt = new Date(base); dt.setHours(14, 0, 0);
        recs.push({
          ts: dt, date: ts(dt), source: 'alipay', counterparty: '某商家',
          product: '订单取消', amount: +(50 + rnd() * 100).toFixed(2),
          io: '支出', type: '购物消费', pay: '余额宝', status: '交易关闭'
        });
      }
    }
    recs.sort((a, b) => a.ts - b.ts);
    return recs;
  }

  /* ---------- 导出为各家 CSV 文本 ---------- */
  function q(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }

  function toAlipayNewCSV(recs) {
    const lines = [
      q('支付宝交易记录明细查询'),
      '',
      q('账号:[demo@example.com]'),
      q('起始日期:[2026-05-01]     终止日期:[2026-10-31]'),
      q('导出时间:[2026-10-31 10:00:00]'),
      q('共' + recs.length + '笔记录'),
      q('------------------------交易记录明细列表------------------------'),
      ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注'].map(q).join(',')
    ];
    recs.forEach((r, i) => {
      lines.push([
        r.date, r.type || '其他', r.counterparty, '', r.product, r.io, r.amount.toFixed(2),
        r.pay, r.status, '2026' + (100000 + i) + '', 'MU' + (200000 + i), ''
      ].map(q).join(','));
    });
    lines.push(q('------------------------导出结束------------------------'));
    return lines.join('\r\n');
  }

  function toAlipayOldCSV(recs) {
    const lines = [
      q('支付宝'),
      q('账务明细查询'),
      q('账号:[demo@example.com]'),
      q('起始日期:[2026-05-01]     终止日期:[2026-10-31]'),
      q('---------------------------------交易记录明细列表----------------------------------'),
      ['交易号', '商家订单号', '交易创建时间', '付款时间', '最近修改时间', '交易来源地', '类型', '交易对方', '商品名称', '金额（元）', '收/支', '交易状态', '服务费（元）', '成功退款（元）', '备注', '资金状态'].map(q).join(',')
    ];
    recs.forEach((r, i) => {
      lines.push([
        '2026' + (100000 + i), 'MU' + (200000 + i), r.date, r.date, r.date, '支付宝网站',
        r.type || '即时到账交易', r.counterparty, r.product, r.amount.toFixed(2), r.io, r.status,
        '0.00', '0.00', '', r.io === '不计收支' ? '' : (r.io === '收入' ? '已收入' : '已支出')
      ].map(q).join(','));
    });
    lines.push(q('-----------------------------------导出结束---------------------------------------'));
    return lines.join('\r\n');
  }

  function toWechatCSV(recs) {
    const lines = [
      q('微信支付账单明细'),
      q('导出时间：2026-10-31 10:00:00'),
      q('微信昵称：[demo]'),
      q('----------------------微信支付账单明细列表--------------------'),
      ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'].map(q).join(',')
    ];
    recs.forEach((r, i) => {
      lines.push([
        r.date, r.type || '商户消费', r.counterparty, r.product, r.io, '¥' + r.amount.toFixed(2),
        r.pay, r.status, '42000' + (300000 + i), '1900' + (400000 + i), ''
      ].map(q).join(','));
    });
    lines.push(q('导出方式：邮箱下载'));
    return lines.join('\r\n');
  }

  global.DemoGen = { makeRecords, toAlipayNewCSV, toAlipayOldCSV, toWechatCSV, TEMPLATES };
})(typeof window !== 'undefined' ? window : globalThis);
