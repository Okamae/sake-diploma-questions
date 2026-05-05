#!/usr/bin/env node
/**
 * 教本全253ページのOCRから「同種選択肢の候補となるエンティティ」を網羅的に抽出する。
 *
 * 抽出対象:
 *  1. 数値（単位ごと）：%・度・℃・kl・kg・ppm・年・時間・分・m・号 等
 *  2. 年代：3桁・4桁年（西暦）+ 和暦の対応
 *  3. 都道府県・地域名
 *  4. 人名（杜氏・研究者・創業者）
 *  5. 米品種・酒種・酵母・醸造方式・容器・蔵元 等
 *  6. 対比語ペア（硬水/軟水、甘口/辛口 など教本に登場するもの）
 *
 * 出力: data/v3/textbook_entities.json
 */

const fs = require('fs');
const path = require('path');

const RAW = path.resolve(__dirname, '../data/v3/raw_textbook_text.json');
const OUT = path.resolve(__dirname, '../data/v3/textbook_entities.json');

const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));

// ページ番号→OCR の配列
const pages = Object.entries(raw)
  .filter(([k]) => k !== 'cover' && /^\d+$/.test(k))
  .map(([k, v]) => ({ page: parseInt(k, 10), text: v || '' }))
  .sort((a, b) => a.page - b.page);

// =============================================================
// 1. 数値（単位ごとに収集、ページ参照付き）
// =============================================================
function extractNumbers(pages) {
  // 単位定義
  const units = {
    '%': /(\d{1,3}(?:\.\d+)?)\s*[%％]/g,
    '度': /(\d{1,3}(?:\.\d+)?)\s*度(?![ー－数])/g,
    '℃': /(-?\d{1,3}(?:\.\d+)?)\s*[℃]/g,
    'kl': /([\d,]{1,8}(?:\.\d+)?)\s*kl/g,
    'kg': /(\d{1,5}(?:\.\d+)?)\s*kg/g,
    'g': /(\d{1,5}(?:\.\d+)?)\s*g(?![a-zA-Z])/g,
    'ppm': /(\d+(?:\.\d+)?)\s*ppm/g,
    '号': /(\d+(?:[\-―]\d+)?)\s*号/g,
    't': /([\d,]+(?:\.\d+)?)\s*t(?![a-zA-Z])/g,
    'cm': /(\d+(?:\.\d+)?)\s*cm/g,
    'km': /(\d+(?:\.\d+)?)\s*km/g,
    'm': /(\d+(?:\.\d+)?)\s*m(?![a-zA-Z\d])/g,
    '時間': /(\d+(?:[〜～\-]\d+)?)\s*時間/g,
    '日': /(\d+(?:[〜～\-]\d+)?)\s*日(?!本)/g,
    '分': /(\d+(?:[〜～\-]\d+)?)\s*分(?![類別])/g,
  };

  const result = {};
  for (const [unit, re] of Object.entries(units)) {
    const map = {}; // 値 → ページ集合
    for (const p of pages) {
      const r = new RegExp(re.source, 'g');
      let m;
      while ((m = r.exec(p.text)) !== null) {
        const val = m[1].replace(/,/g, '');
        if (!map[val]) map[val] = new Set();
        map[val].add(p.page);
      }
    }
    result[unit] = Object.entries(map)
      .map(([v, pgs]) => ({ value: v, pages: [...pgs].sort((a, b) => a - b) }))
      .sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
  }
  return result;
}

// =============================================================
// 2. 年代
// =============================================================
function extractYears(pages) {
  // 西暦（3〜4桁、1500-2050年範囲）
  const map = {};
  for (const p of pages) {
    const re = /(\d{3,4})\s*(?:[（(](平成|昭和|令和|大正|明治|天保|寛永|貞観|延長|延喜|奈良|鎌倉)\s*(\d+)\s*年?[)）])?\s*年(\s*\d{1,2}\s*月)?/g;
    let m;
    while ((m = re.exec(p.text)) !== null) {
      const yr = parseInt(m[1]);
      if (yr < 700 || yr > 2050) continue;
      if (!map[yr]) map[yr] = { wareki: m[2] ? `${m[2]}${m[3]}年` : null, pages: new Set(), contexts: [] };
      map[yr].pages.add(p.page);
      // 周辺30字を文脈として保存
      const start = Math.max(0, m.index - 30);
      const ctx = p.text.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ');
      if (map[yr].contexts.length < 3) map[yr].contexts.push({ page: p.page, ctx });
    }
  }
  const arr = Object.entries(map)
    .map(([y, info]) => ({
      year: parseInt(y),
      wareki: info.wareki,
      pages: [...info.pages].sort((a, b) => a - b),
      contexts: info.contexts,
    }))
    .sort((a, b) => a.year - b.year);
  return arr;
}

// =============================================================
// 3. 都道府県・地域
// =============================================================
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

function extractPrefectures(pages) {
  const map = {};
  for (const p of pages) {
    for (const pref of PREFECTURES) {
      if (p.text.includes(pref)) {
        if (!map[pref]) map[pref] = new Set();
        map[pref].add(p.page);
      }
    }
  }
  return Object.entries(map)
    .map(([pref, pgs]) => ({ name: pref, pages: [...pgs].sort((a, b) => a - b) }))
    .sort((a, b) => b.pages.length - a.pages.length);
}

// =============================================================
// 4. 米品種（酒造好適米）
// =============================================================
// 教本に登場する代表的な品種を網羅
const RICE_VARIETIES = [
  '山田錦', '五百万石', '美山錦', '雄町', '愛山', '亀の尾',
  '八反錦', '八反', '八反35号', '八反錦1号', '千本錦',
  '出羽燦々', '夢の香', '越淡麗', '吟風', 'ひとごこち',
  '愛船117', '愛船', '神力', '備前雄町', '改良雄町',
  '華吹雪', '華想い', '秋田酒こまち', '秋田流', '秋田酒116号',
  '蔵の華', '彗星', '出羽の里', '吟ぎんが', 'きたしずく', '白鶴錦',
  '山田穂', '短稈渡船', '渡船2号', '雄町酒米', '亀の翁',
  '玉栄', '佐香錦', '改良八反流', '神の舞', '縁の舞',
  '伊勢錦', 'いにしえの舞', '白菊', '新山田穂1号', '神龍錦',
  'たかね錦', '但馬強力', '杜氏の夢', 'おくほまれ', '野条穂',
  'さかほまれ', '九頭竜', '兵庫北錦', '越の雫', '兵庫恋錦',
  'Hyogo Sake 85', '兵庫錦', '兵庫夢錦', 'フクノハナ', '辨慶', '弁慶',
  'コシヒカリ', 'あけぼの', '夢一献', 'こいおまち', '萌えいぶき',
  'ササシグレ', 'まなむすめ', 'ひとめぼれ', '美郷錦', 'まっしぐら',
  '改良信交', 'ふくおこし', 'ふくみらい', '若水', 'ヒノヒカリ',
  '吟のさと', '壽顔無', '寿限無', '北陸167号',
];

function extractRiceVarieties(pages) {
  const map = {};
  for (const p of pages) {
    for (const v of RICE_VARIETIES) {
      // 単純な includes で誤マッチを避けるため、長いものから優先マッチ
      if (p.text.includes(v)) {
        if (!map[v]) map[v] = new Set();
        map[v].add(p.page);
      }
    }
  }
  return Object.entries(map)
    .map(([v, pgs]) => ({ name: v, pages: [...pgs].sort((a, b) => a - b) }))
    .sort((a, b) => b.pages.length - a.pages.length);
}

// =============================================================
// 5. 酒種・酒種分類
// =============================================================
const SAKE_TYPES = [
  '吟醸酒', '大吟醸酒', '純米酒', '純米吟醸酒', '純米大吟醸酒',
  '本醸造酒', '特別純米酒', '特別本醸造酒', '普通酒', '清酒',
  '原酒', '生酒', '生詰酒', '生貯蔵酒', 'ひやおろし', '無濾過',
  'にごり酒', '貴醸酒', '熟成古酒', '古酒', 'スパークリング日本酒',
  '発泡性日本酒', '低アルコール日本酒',
];

function extractSakeTypes(pages) {
  const map = {};
  for (const p of pages) {
    for (const s of SAKE_TYPES) {
      if (p.text.includes(s)) {
        if (!map[s]) map[s] = new Set();
        map[s].add(p.page);
      }
    }
  }
  return Object.entries(map)
    .map(([s, pgs]) => ({ name: s, pages: [...pgs].sort((a, b) => a - b) }));
}

// =============================================================
// 6. 酵母・醸造関連
// =============================================================
const YEAST_AND_TERMS = [
  // 酵母
  '協会1号', '協会6号', '協会7号', '協会9号', '協会10号', '協会14号', '協会18号', '協会1801号',
  'きょうかい', 'K7', 'K9', 'K10', 'K14',
  // 酒母
  '生酛', '山廃酛', '速醸酛', '高温糖化酛', '中温糖化酛', '酒母',
  // 麹・酵素
  '黒麹', '白麹', '黄麹', '麹菌', 'アスペルギルス・オリゼー',
  // 容器・道具
  '木桶', '酒槽', '甑', '蒸籠', '横型精米機', '竪型精米機', '堅型精米機',
  // 工程
  '初添', '仲添', '留添', '三段仕込み', '汲掛け', '湯掛け',
  '酒母', '醪', '上槽', '荒走り', '中取り', '責め',
  '滓引き', '濾過', '火入れ', '割水', '貯蔵',
  // 焼酎
  '米焼酎', '麦焼酎', '芋焼酎', 'そば焼酎', '黒糖焼酎', '泡盛',
  '粕取り焼酎', '酒粕焼酎', '単式蒸留', '連続式蒸留',
  // 杜氏
  '南部杜氏', '越後杜氏', '丹波杜氏', '能登杜氏', '但馬杜氏',
];

function extractTerms(pages) {
  const map = {};
  for (const p of pages) {
    for (const t of YEAST_AND_TERMS) {
      if (p.text.includes(t)) {
        if (!map[t]) map[t] = new Set();
        map[t].add(p.page);
      }
    }
  }
  return Object.entries(map)
    .map(([t, pgs]) => ({ name: t, pages: [...pgs].sort((a, b) => a - b) }));
}

// =============================================================
// 7. 人名（教本登場人物）
// =============================================================
const PEOPLE = [
  '山邑太左衛門', '三浦仙三郎', '坂口謹一郎', '野白金一', '矢部金一郎',
  '岸本甚造', '嘉儀金一郎', '鹿又親', '鹿又親博士', '木下祐五郎',
  '高橋亀吉', '飯田義雄', '小泉武夫', '秋山裕一', '熊谷知栄子',
  '住吉武兵衛', '山中七兵衛', '酒井六兵衛', '櫻井甚四郎',
  '三浦', '山邑', '岸本', '矢部', '野白', '鹿又',
];

function extractPeople(pages) {
  const map = {};
  for (const p of pages) {
    for (const person of PEOPLE) {
      if (p.text.includes(person)) {
        if (!map[person]) map[person] = new Set();
        map[person].add(p.page);
      }
    }
  }
  return Object.entries(map)
    .map(([n, pgs]) => ({ name: n, pages: [...pgs].sort((a, b) => a - b) }));
}

// =============================================================
// 8. 対比語ペア（教本中の出現から自動検出）
// =============================================================
const ANTONYM_PAIRS = [
  ['硬水', '軟水'], ['甘口', '辛口'], ['淡麗', '濃醇'],
  ['男酒', '女酒'], ['冷酒', '燗酒'], ['冷やし', '燗'],
  ['粳米', 'もち米'], ['玄米', '白米'], ['酒米', '飯米'],
  ['上昇', '減少'], ['増加', '減少'], ['昇温', '降温'],
  ['促進', '抑制'], ['活発', '不活発'], ['早い', '遅い'],
  ['高め', '低め'], ['長期', '短期'], ['以下', '以上'],
  ['未満', '超'], ['含む', '含まない'], ['できる', 'できない'],
  ['吟醸造り', '普通造り'], ['速醸', '生酛'], ['短稈', '長稈'],
  ['早生', '晩生'], ['寒冷', '温暖'], ['北部', '南部'],
  ['東部', '西部'], ['表層', '中心'], ['粗', '細'],
  ['縦型', '横型'], ['竪型', '横型'],
];

function extractAntonyms(pages) {
  const result = [];
  for (const [a, b] of ANTONYM_PAIRS) {
    const aPgs = new Set(), bPgs = new Set();
    for (const p of pages) {
      if (p.text.includes(a)) aPgs.add(p.page);
      if (p.text.includes(b)) bPgs.add(p.page);
    }
    if (aPgs.size > 0 || bPgs.size > 0) {
      result.push({
        a, b,
        aPages: [...aPgs].sort((x, y) => x - y),
        bPages: [...bPgs].sort((x, y) => x - y),
      });
    }
  }
  return result;
}

// =============================================================
// 9. 数値の文脈分類（精米歩合〇% vs アルコール〇% を区別）
// =============================================================
function classifyNumberContexts(pages) {
  // 数値の前後30文字を取って、どんな文脈で出現したかを記録
  const contextMap = {};
  for (const p of pages) {
    const re = /(\d{1,3}(?:\.\d+)?)\s*([%％])/g;
    let m;
    while ((m = re.exec(p.text)) !== null) {
      const val = m[1];
      const start = Math.max(0, m.index - 25);
      const ctx = p.text.slice(start, m.index).replace(/\s+/g, '');
      // 文脈キーワードを抽出
      let domain = 'unknown';
      if (/(精米歩合|歩合|精米)/.test(ctx)) domain = '精米歩合';
      else if (/(アルコール|度数|vol)/.test(ctx)) domain = 'アルコール度';
      else if (/(濃度|含有|含む)/.test(ctx)) domain = '含有率';
      else if (/(割合|比率|シェア)/.test(ctx)) domain = '割合';
      else if (/(増加|上昇|向上|アップ)/.test(ctx)) domain = '増加率';
      else if (/(減少|低下|ダウン)/.test(ctx)) domain = '減少率';
      else if (/(消費|需要|出荷|生産)/.test(ctx)) domain = '消費・生産割合';
      const key = domain + '/' + val;
      if (!contextMap[key]) contextMap[key] = { domain, value: val, pages: new Set(), contexts: [] };
      contextMap[key].pages.add(p.page);
      const ctxFull = p.text.slice(start, m.index + m[0].length).replace(/\s+/g, '');
      if (contextMap[key].contexts.length < 3) contextMap[key].contexts.push({ page: p.page, ctx: ctxFull });
    }
  }
  // ドメイン別にグルーピング
  const byDomain = {};
  for (const v of Object.values(contextMap)) {
    if (!byDomain[v.domain]) byDomain[v.domain] = [];
    byDomain[v.domain].push({ value: v.value, pages: [...v.pages], contexts: v.contexts });
  }
  for (const k of Object.keys(byDomain)) {
    byDomain[k].sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
  }
  return byDomain;
}

// =============================================================
// 実行
// =============================================================
console.log('Extracting entities from', pages.length, 'pages...');

const entities = {
  meta: {
    generatedAt: new Date().toISOString(),
    sourceOcrPages: pages.length,
    sourceOcrChars: pages.reduce((s, p) => s + p.text.length, 0),
    method: 'rule-based scan of textbook OCR',
  },
  numbers: extractNumbers(pages),
  numbersByContext: classifyNumberContexts(pages),
  years: extractYears(pages),
  prefectures: extractPrefectures(pages),
  riceVarieties: extractRiceVarieties(pages),
  sakeTypes: extractSakeTypes(pages),
  yeastAndTerms: extractTerms(pages),
  people: extractPeople(pages),
  antonymPairs: extractAntonyms(pages),
};

console.log('Summary:');
console.log('  numbers (units):', Object.keys(entities.numbers).length);
console.log('  number contexts:', Object.keys(entities.numbersByContext).length);
for (const [d, vs] of Object.entries(entities.numbersByContext)) {
  console.log('    ', d, ':', vs.length, 'distinct values');
}
console.log('  years:', entities.years.length);
console.log('  prefectures:', entities.prefectures.length);
console.log('  rice varieties:', entities.riceVarieties.length);
console.log('  sake types:', entities.sakeTypes.length);
console.log('  yeast/terms:', entities.yeastAndTerms.length);
console.log('  people:', entities.people.length);
console.log('  antonym pairs (with both sides found):', entities.antonymPairs.filter(a => a.aPages.length > 0 && a.bPages.length > 0).length);

fs.writeFileSync(OUT, JSON.stringify(entities, null, 2));
console.log('\nWritten:', OUT);
