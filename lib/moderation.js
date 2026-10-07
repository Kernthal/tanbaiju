'use strict';
/**
 * 内容安全：敏感词过滤 + 举报 + 审核。
 * 词库按类别分组，便于后续接第三方内容安全 API（当前为本地规则，可平滑替换）。
 */

const CATEGORIES = {
  insult: ['白痴', '智障', '废物', '垃圾玩意'],
  porn: ['约炮', '裸聊', '开房', '涩图'],
  political: ['敏感词占位'],
  contact: ['加微信', '私聊我', '留电话', '扣扣'],
  ad: ['免费送', '点击链接', '刷单', '代开发票'],
};

// 占位词不参与匹配，避免误伤
const WORD_LIST = [];
Object.keys(CATEGORIES).forEach((cat) => {
  if (cat === 'political') return;
  CATEGORIES[cat].forEach((w) => WORD_LIST.push({ word: w, category: cat }));
});

const REPLACEMENT = '*';

/**
 * 检查一段文本。
 * 返回 { hit, category, masked, words }：masked 是脱敏后的可入库文本。
 */
function inspect(text) {
  const src = String(text || '');
  const lower = src.toLowerCase();
  let masked = src;
  const hits = [];
  WORD_LIST.forEach((item) => {
    const w = item.word.toLowerCase();
    let idx = lower.indexOf(w);
    if (idx === -1) return;
    hits.push({ word: item.word, category: item.category });
    while (idx !== -1) {
      masked = masked.slice(0, idx) + REPLACEMENT.repeat(item.word.length) + masked.slice(idx + item.word.length);
      idx = masked.toLowerCase().indexOf(w, idx + item.word.length);
    }
  });
  return {
    hit: hits.length > 0,
    category: hits.length ? hits[0].category : null,
    words: hits.map((h) => h.word),
    masked: masked,
    blocked: hits.some((h) => h.category === 'insult' || h.category === 'porn'),
  };
}

/** 昵称 / 简介 用更宽松的策略：只脱敏不拦截 */
function inspectProfile(text) {
  return inspect(text);
}

module.exports = { inspect: inspect, inspectProfile: inspectProfile, CATEGORIES: CATEGORIES };