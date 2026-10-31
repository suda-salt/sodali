/* ============================================================
 *  bill-analyzer · 分类引擎
 *  默认关键词规则 + 用户自定义规则（localStorage 持久化）
 * ============================================================ */
(function (global) {
  'use strict';

  const CATS = [
    // 支出类
    { name: '餐饮美食', kind: 'expense', color: '#f97316' },
    { name: '交通出行', kind: 'expense', color: '#38bdf8' },
    { name: '购物消费', kind: 'expense', color: '#f43f5e' },
    { name: '居住物业', kind: 'expense', color: '#8b5cf6' },
    { name: '生活服务', kind: 'expense', color: '#06b6d4' },
    { name: '休闲娱乐', kind: 'expense', color: '#ec4899' },
    { name: '医疗健康', kind: 'expense', color: '#ef4444' },
    { name: '教育培训', kind: 'expense', color: '#6366f1' },
    { name: '旅游出行', kind: 'expense', color: '#14b8a6' },
    { name: '数码家电', kind: 'expense', color: '#0ea5e9' },
    { name: '美容服饰', kind: 'expense', color: '#d946ef' },
    { name: '转账红包', kind: 'expense', color: '#a3a3a3' },
    { name: '信用还款', kind: 'expense', color: '#94a3b8' },
    { name: '储蓄提现', kind: 'expense', color: '#64748b' },
    { name: '人情往来', kind: 'expense', color: '#fb7185' },
    { name: '其他支出', kind: 'expense', color: '#9ca3af' },
    // 收入类
    { name: '工资薪酬', kind: 'income', color: '#22c55e' },
    { name: '经营收入', kind: 'income', color: '#10b981' },
    { name: '红包收款', kind: 'income', color: '#84cc16' },
    { name: '转账收入', kind: 'income', color: '#4ade80' },
    { name: '理财收益', kind: 'income', color: '#2dd4bf' },
    { name: '退款返还', kind: 'income', color: '#a78bfa' },
    { name: '其他收入', kind: 'income', color: '#34d399' },
    // 中性
    { name: '资金流转', kind: 'neutral', color: '#94a3b8' }
  ];

  const COLOR_MAP = {};
  CATS.forEach(c => { COLOR_MAP[c.name] = c.color; });

  /* 属于「资金流转」而非真实支出的类别：
     信用卡/花呗还款是负债清偿、提现与理财转入是账户间搬运，计入支出会造成重复统计 */
  const FLOW_CATS = new Set(['信用还款', '储蓄提现']);

  /* 支付宝自带的交易分类 → 本地分类 */
  const ALIPAY_MAP = {
    '餐饮美食': '餐饮美食', '美食': '餐饮美食', '餐饮': '餐饮美食',
    '交通出行': '交通出行', '出行': '交通出行', '打车': '交通出行',
    '购物消费': '购物消费', '购物': '购物消费',
    '居住物业': '居住物业', '住房物业': '居住物业', '物业': '居住物业',
    '生活服务': '生活服务',
    '休闲娱乐': '休闲娱乐', '文化休闲': '休闲娱乐', '运动户外': '休闲娱乐',
    '医疗健康': '医疗健康', '医美': '美容服饰',
    '教育培训': '教育培训',
    '旅游住宿': '旅游出行', '酒店旅游': '旅游出行', '旅行': '旅游出行',
    '数码家电': '数码家电', '数码电器': '数码家电',
    '美容美发': '美容服饰', '服饰装扮': '美容服饰', '美容': '美容服饰',
    '转账红包': '转账红包', '红包': '转账红包',
    '信用借还': '信用还款', '还款': '信用还款', '还贷助手': '信用还款',
    '充值提现': '储蓄提现', '提现': '储蓄提现',
    '投资理财': '储蓄提现', '理财': '储蓄提现',
    '人情往来': '人情往来', '亲友代付': '人情往来',
    '车辆服务': '交通出行', '母婴亲子': '生活服务', '宠物': '生活服务',
    '家居家装': '居住物业', '办公': '生活服务', '公益捐赠': '人情往来',
    '收入': '其他收入'
  };

  /* ---- 高优先级规则：命中后不再使用支付宝自带分类 ----
     典型场景：支付宝给个人的房租打标为「转账红包」，但关键词里明确写了房租 */
  const HIGH_RULES = [
    { cat: '居住物业', kws: ['房租', '租金', '物业费', '物业代扣', '住房'] },
    { cat: '人情往来', kws: ['礼金', '随礼', '份子钱'] },
    { cat: '医疗健康', kws: ['挂号', '门诊', '住院', '体检', '医药费'] }
  ];

  /* ---- 支出关键词规则（自上而下优先匹配） ---- */
  const EXPENSE_RULES = [
    { cat: '信用还款', kws: ['信用卡还款', '信用卡', '花呗', '借呗', '备用金', '京东金条', '招联', '房贷还款', '车贷还款', '房贷', '车贷', '蚂蚁貸', '还贷助手'] },
    { cat: '储蓄提现', kws: ['余额宝', '余利宝', '零钱通', '天弘基金', '零钱提现', '提现', '基金买入', '基金申购', '定期理财', '活期', '申购', '资金归集', '自动攒', '储蓄'] },
    { cat: '转账红包', kws: ['转账红包', '微信红包', '亲友卡', '亲属卡', '面对面转账', '转账到银行卡', '银行卡转账', '群收款', '扫码转账'] },
    { cat: '人情往来', kws: ['礼金', '随礼', '份子钱', '孝敬', '赡养', '捐赠', '公益捐赠'] },
    { cat: '餐饮美食', kws: ['餐饮美食', '餐饮', '美食', '餐厅', '饭店', '小吃', '外卖', '食堂', '咖啡', '奶茶', '火锅', '烧烤', '面馆', '汉堡', '面包', '烘焙', '甜品', '酒吧', '肯德基', '麦当劳', '星巴克', '瑞幸', '蜜雪冰城', '喜茶', '奈雪', '美团外卖', '饿了么', '电子饭卡', '饭'], },
    { cat: '交通出行', kws: ['滴滴', '网约车', '出租', '的士', '打车', '地铁', '轨道交通', '公交', '共享单车', '哈啰', '青桔', '高铁', '12306', '加油', '中石化', '中石油', '停车费', '车位', '路桥', 'ETC', '车费', '营运证', '货运'] },
    { cat: '旅游出行', kws: ['酒店', '民宿', '客栈', '门票', '景区', '度假', '携程', '去哪儿', '飞猪', '同程旅行', '旅行', '机票', '火车票', '航空', '东方航空', '南方航空', '国航', '旅游'] },
    { cat: '医疗健康', kws: ['医院', '卫生院', '挂号', '门诊', '急诊', '体检', '口腔', '眼科', '诊所', '大药房', '药店', '医药', '医疗', '保健'] },
    { cat: '教育培训', kws: ['学费', '培训', '课程', '教育', '学校', '图书', '书店', '考试', '考研', '英语', '学习', 'kindle'] },
    { cat: '居住物业', kws: ['房租', '租金', '物业费', '水费', '电费', '燃气费', '煤气', '燃气', '供暖', '宽带', '水电', '物业', '家装', '家居'] },
    { cat: '生活服务', kws: ['话费', '中国移动', '中国联通', '中国电信', '手机充值', '快递', '顺丰', '京东物流', '德邦', '菜鸟驿站', '邮政', '洗衣', '家政', '保洁', '维修', '搬家', '宠物', '打印', '充值中心'] },
    { cat: '休闲娱乐', kws: ['电影', '影院', 'KTV', '游戏', 'Steam', '腾讯视频', '爱奇艺', '优酷', '芒果', '哔哩哔哩', '会员', '演出', '演唱会', '剧场', '剧本杀', '密室', '健身', '门票【'] },
    { cat: '购物消费', kws: ['淘宝', '天猫', '京东', '拼多多', '唯品会', '苏宁', '得物', '超市', '便利店', '商场', '沃尔玛', '盒马', '山姆', '永辉', '屈臣氏', '宜家', '随手团'] },
    { cat: '数码家电', kws: ['数码', '手机', '电脑', 'Apple', '苹果', '华为', '小米', '联想', '家电', '冰箱', '空调', '洗衣机', '配件', '云服务', '云盘'] },
    { cat: '美容服饰', kws: ['美容', '美发', '理发', '护肤', '化妆', '医美', '美甲', '服饰', '服装', '衣', '鞋', 'Under Armour'] },
    { cat: '购物消费', kws: ['淘宝', '天猫', '京东', '拼多多', '唯品会', '苏宁', '得物', '超市', '便利店', '商场', '沃尔玛', '盒马', '山姆', '永辉', '屈臣氏', '宜家', '随手团'] }
  ];

  /* ---- 收入关键词规则 ---- */
  const INCOME_RULES = [
    { cat: '退款返还', kws: ['退款', '退货', '返款', '退款成功', '全额退款'] },
    { cat: '理财收益', kws: ['收益', '利息', '分红', '000937', '基金收益', '货币基金'] },
    { cat: '工资薪酬', kws: ['工资', '薪资', '薪酬', '劳务', '报酬', '奖金', '代发', '年终奖'] },
    { cat: '经营收入', kws: ['货款', '营业', '营收', '商户拍卖', '结算款', '商家收款', '经营所得'] },
    { cat: '红包收款', kws: ['红包', '抢红包'] },
    { cat: '转账收入', kws: ['转账', '收款', '亲属卡', '扫二维码付款'] }
  ];

  const STORE_KEY = 'bill_analyzer_rules_v1';

  /* ---------- 规则存储 ---------- */
  function loadRules() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveRules(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); }
    catch (e) { /* 超出配额忽略 */ }
  }

  let customRules = loadRules();

  function getCustomRules() { return customRules.slice(); }
  function addRule(kw, cat) {
    kw = String(kw || '').trim();
    if (!kw) return false;
    const exist = customRules.find(r => r.kw === kw);
    if (exist) exist.cat = cat;
    else customRules.push({ kw, cat });
    saveRules(customRules);
    return true;
  }
  function removeRule(kw) {
    customRules = customRules.filter(r => r.kw !== kw);
    saveRules(customRules);
  }
  function clearRules() { customRules = []; saveRules(customRules); }

  /* ---------- 单笔归类 ---------- */
  function classify(t) {
    const text = [t.counterparty, t.product, t.rawCategory, t.note].filter(Boolean).join(' ');

    // 不计收支（中性资金流转）
    if (t.flow === 'neutral') return '资金流转';

    if (t.flow === 'income') {
      if (t.kind === 'refund') return '退款返还';
      const c = matchRule(text, customRules);
      if (c) return catForFlow(c.cat, 'income');
      const r = matchKeyword(text, INCOME_RULES);
      if (r) return r.cat;
      return '转账收入';
    }

    // 支出
    const c = matchRule(text, customRules);
    if (c) return catForFlow(c.cat, 'expense');

    // 强特征词（房租 / 礼金 / 医疗）优先于平台自带分类
    const hp = matchKeyword(text, HIGH_RULES);
    if (hp) return hp.cat;

    // 支付宝自带分类
    if (t.source === 'alipay' && t.rawCategory) {
      const mapped = ALIPAY_MAP[t.rawCategory.trim()];
      if (mapped && mapped !== '其他支出') {
        return catForFlow(mapped, 'expense');
      }
    }

    const r = matchKeyword(text, EXPENSE_RULES);
    if (r) return catForFlow(r.cat, 'expense');

    // 微信交易类型兜底
    if (/扫二维码付款|商户消费|付款码/.test(t.rawCategory)) return '其他支出';
    return '其他支出';
  }

  function catForFlow(cat, flow) {
    if (flow === 'income') {
      const map = { '转账红包': '转账收入', '信用还款': '转账收入', '储蓄提现': '转账收入', '人情往来': '红包收款' };
      if (map[cat]) return map[cat];
      return INCOME_CATS.has(cat) ? cat : '转账收入';
    }
    if (flow === 'neutral') return '资金流转';
    if (flow === 'expense') {
      return OUT_CATS.has(cat) ? cat : '其他支出';
    }
    return cat;
  }

  const OUT_CATS = new Set(CATS.filter(c => c.kind === 'expense').map(c => c.name));
  const INCOME_CATS = new Set(CATS.filter(c => c.kind === 'income').map(c => c.name));

  function matchRule(text, rules) {
    const up = text.toUpperCase();
    for (const r of rules) {
      if (up.includes(r.kw.toUpperCase())) return r;
    }
    return null;
  }
  function matchKeyword(text, rules) {
    const up = text.toUpperCase();
    for (const r of rules) {
      for (const k of r.kws) {
        if (up.includes(k.toUpperCase())) return r;
      }
    }
    return null;
  }

  global.Classifier = {
    CATS, COLOR_MAP, FLOW_CATS,
    classify, catForFlow,
    getCustomRules, addRule, removeRule, clearRules,
    color(name) { return COLOR_MAP[name] || '#9ca3af'; }
  };
})(window);
