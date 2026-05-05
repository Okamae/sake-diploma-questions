/**
 * 同フレーム不正答（distractor）生成エンジン v2 - 辞書ベース
 *
 * 設計方針（ユーザー指示）:
 *  - 教本由来の具体的辞書ルール（data/v3/distractor_rules.json）に従う
 *  - LLM・汎用変異は使わない（誤りが入るため）
 *  - 該当辞書がないファクトは生成を諦めて null を返す（無理に作らない）
 *
 * 適用優先順:
 *  1. tableRules（特定名称酒の表など、最も具体的）
 *  2. entityRules（米品種・県・酵母など、固有名詞置換）
 *  3. antonymRules（対比語反転）
 *  4. numericRules（数値置換）
 *  5. yearRules（年代置換）
 */

const fs = require('fs');
const path = require('path');

const RULES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../data/v3/distractor_rules.json'), 'utf-8')
);

// ============================================================
// 辞書アクセサ（高速化のためキャッシュ）
// ============================================================
const ALL_RICE_VARIETIES = (() => {
  const r = RULES.entityRules['酒造好適米'];
  return [...new Set([...r.tier1_全国流通, ...r.tier2_有名, ...r.tier3_地方])];
})();

const ALL_PREFECTURES = (() => {
  const r = RULES.entityRules['都道府県'];
  return [...new Set([
    ...r['東北'], ...r['北陸_甲信越'], ...r['関東'], ...r['東海'],
    ...r['近畿'], ...r['中国'], ...r['四国'], ...r['九州_沖縄'],
  ])];
})();

const SAKE_TYPES = RULES.entityRules['酒種_特定名称酒'].list;
const TOJI_LIST = RULES.entityRules['杜氏流派'].list;
const YEAST_LIST = RULES.entityRules['酵母'].list;
const SHUBO_LIST = RULES.entityRules['酒母'].list;
const SHOCHU_TYPES = RULES.entityRules['焼酎'].原料別;
const KYUBETSU_LIST = (RULES.entityRules['級別制度'] && RULES.entityRules['級別制度'].list) || [];
const TOJI_ROLE_LIST = (RULES.entityRules['杜氏の役割'] && RULES.entityRules['杜氏の役割'].list) || [];
const KANPYOKAI_LIST = (RULES.entityRules['鑑評会'] && RULES.entityRules['鑑評会'].list) || [];
const HYOJI_GIMU_LIST = (RULES.entityRules['酒の表示義務事項'] && RULES.entityRules['酒の表示義務事項'].list) || [];
const HYOJI_KINSHI_LIST = (RULES.entityRules['酒の表示禁止事項'] && RULES.entityRules['酒の表示禁止事項'].list) || [];
const SHUTSURO_LIST = (RULES.entityRules['焼酎の蒸留方式'] && RULES.entityRules['焼酎の蒸留方式'].list) || [];
const KOJIN_LIST = (() => {
  const r = RULES.entityRules['微生物'];
  if (!r) return [];
  return [...(r.list || []), ...(r.麹菌 || []), ...(r.酵母種 || [])];
})();
const KOJI_RAKU_LIST = (RULES.entityRules['微生物'] && RULES.entityRules['微生物'].麹菌) || [];

// 工程動作リスト
const KOTEI_GROUPS = (RULES.entityRules['酒造工程の動作']) || {};

// 火入れ_出荷形態
const HIRE_FORMS = (RULES.entityRules['火入れ_出荷形態'] && RULES.entityRules['火入れ_出荷形態'].list) || [];

// === 拡張辞書（用途特化）===
const KOJI_ENZYMES = (RULES.entityRules['麹菌酵素_4種'] && RULES.entityRules['麹菌酵素_4種'].list) || [];
const KOJI_TYPES = (RULES.entityRules['麹型'] && RULES.entityRules['麹型'].list) || [];
const KOJI_KOTEI = (RULES.entityRules['製麹工程'] && RULES.entityRules['製麹工程'].list) || [];
const FERMENT_TYPES = (RULES.entityRules['酒造発酵タイプ'] && RULES.entityRules['酒造発酵タイプ'].list) || [];
const RICE_VARIATION = RULES.entityRules['稲分類'] || {};
const RICE_COMPONENTS = (RULES.entityRules['米成分'] && RULES.entityRules['米成分'].でんぷん成分) || [];
const WATER_GOOD = (RULES.entityRules['醸造用水成分'] && RULES.entityRules['醸造用水成分'].有用成分) || [];
const WATER_BAD = (RULES.entityRules['醸造用水成分'] && RULES.entityRules['醸造用水成分'].望ましくない成分) || [];
const ERAS = (RULES.entityRules['時代区分']) || {};
const HISTORICAL_DOCS = (RULES.entityRules['歴史文献'] && RULES.entityRules['歴史文献'].list) || [];
const HISTORICAL_ORGS = (RULES.entityRules['歴史機関_組織'] && RULES.entityRules['歴史機関_組織'].list) || [];
const SHRINES_TEMPLES = RULES.entityRules['神社_寺院'] || {};
const HIST_PEOPLE = (RULES.entityRules['杜氏歴史人物'] && RULES.entityRules['杜氏歴史人物'].list) || [];
const COLOR_TONES = (RULES.entityRules['色調表現'] && RULES.entityRules['色調表現'].list) || [];
const APPEARANCE_TOOLS = (RULES.entityRules['外観チェック器具'] && RULES.entityRules['外観チェック器具'].list) || [];
const MAILLARD_RULES = RULES.entityRules['メイラード反応'] || {};
const SCENT_EXP = RULES.entityRules['香り表現'] || {};
const SAKE_TEMP = (RULES.entityRules['飲む温度区分'] && RULES.entityRules['飲む温度区分'].list) || [];
const SAKE_VESSELS = RULES.entityRules['酒器名称'] || {};
const PAIRING_PURPOSES = (RULES.entityRules['料理ペアリング目的'] && RULES.entityRules['料理ペアリング目的'].目的のみ) || [];
const SHOCHU_KANSO = (RULES.entityRules['焼酎甘藷品種'] && RULES.entityRules['焼酎甘藷品種'].list) || [];
const SHOCHU_OIL = RULES.entityRules['焼酎油臭関連'] || {};
const SHOCHU_PAIRING = RULES.entityRules['焼酎ペアリング'] || {};
const HISTORICAL_METHODS = (RULES.entityRules['歴史的酒製造法'] && RULES.entityRules['歴史的酒製造法'].list) || [];
const STEAMED_RICE_STATE = (RULES.entityRules['蒸米物性'] && RULES.entityRules['蒸米物性'].理想) || [];
const PH_OBJECTS = (RULES.entityRules['pH値'] && RULES.entityRules['pH値'].物質リスト) || [];
const PH_VALUES = (RULES.entityRules['pH値'] && RULES.entityRules['pH値'].値リスト) || [];
const SHINPAKU_SHAPES = (RULES.entityRules['心白関連'] && RULES.entityRules['心白関連'].形状種別) || [];
const KOJI_BWY = (RULES.entityRules['黒麹白麹黄麹'] && RULES.entityRules['黒麹白麹黄麹'].list) || [];

// ============================================================
// D-13/D-14/D-16: 置換の文法・トピック・熟語整合性検証
// ============================================================

// D-16: 熟語・複合語の保護リスト
//   「玄米」「酒米」のような確立した熟語の一部を置換すると不自然な造語になる
//   これらの熟語が value に含まれる場合、その内部の文字（米/麦/芋 等）を置換しない
const PROTECTED_COMPOUNDS = [
  // 米関連の熟語
  '玄米', '白米', '精米', '酒米', '飯米', '酒造米', '酒造好適米', '食用米',
  'うるち米', 'もち米', '米麹', '米こうじ', '米粉', '米飯', '米焼酎', '米味噌',
  '純米', '純米酒', '純米吟醸', '純米大吟醸', '米トレーサビリティ',
  '醸造用玄米', '農産物検査', '米の農産物', '産米',
  // 麦関連の熟語
  '大麦', '小麦', '麦芽', '麦茶', '麦焼酎', '麦麹', '麦味噌', '麦飯', '麦ご飯',
  // 芋・甘藷関連の熟語
  '芋焼酎', '甘藷焼酎', 'さつまいも', 'サツマイモ',
  // そば関連
  'そば焼酎',
];

// value 内で「保護対象の熟語」の一部に該当する文字位置を抽出
function getProtectedRanges(value) {
  const ranges = []; // [{start, end, compound}]
  for (const compound of PROTECTED_COMPOUNDS) {
    let idx = 0;
    while ((idx = value.indexOf(compound, idx)) !== -1) {
      ranges.push({ start: idx, end: idx + compound.length, compound });
      idx += compound.length;
    }
  }
  return ranges;
}

// 置換しようとしている original の位置が保護範囲内にあるかチェック
function isInProtectedRange(value, original) {
  if (original == null || original === '') return false;
  const origStr = String(original);
  const origLen = origStr.length;
  if (origLen === 0) return false; // ガード：無限ループ防止
  const ranges = getProtectedRanges(value);
  let idx = 0;
  while ((idx = value.indexOf(origStr, idx)) !== -1) {
    // この出現が保護範囲のいずれかに含まれているか
    for (const r of ranges) {
      if (idx >= r.start && idx + origLen <= r.end) {
        return true;
      }
    }
    idx += origLen;
  }
  return false;
}



// 置換後の文中で、置換位置の直後文脈と差替え語が文法的に成立するか
function isGrammaticalReplacement(value, original, replacement) {
  const idx = value.indexOf(original);
  if (idx < 0) return true;
  const after = value.slice(idx + original.length, idx + original.length + 3);
  const before = value.slice(Math.max(0, idx - 3), idx);

  // 直後が「性」「化」「的」「系」 → 置換語は名詞・形容動詞語幹のみ
  if (/^(?:性|化|的|系)/.test(after)) {
    if (/^[\d%％‰]+$/.test(replacement)) return false;
    if (/^[%％kg個本‰℃度tg]$/.test(replacement)) return false;
    if (/^(?:%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m|個|‰|本)$/.test(replacement)) return false;
  }

  // 直後が「年」「世紀」「時代」 → 数字や時代名のみ
  if (/^(?:年|世紀|時代)/.test(after)) {
    if (!/\d/.test(replacement) && !/(?:弥生|奈良|平安|鎌倉|室町|江戸|明治|大正|昭和|平成|令和)/.test(replacement)) {
      return false;
    }
  }

  // 直後が「県」「府」「都」「市」 → 地名語幹のみ
  if (/^[県府都市]/.test(after)) {
    if (/^[\d%％]+$/.test(replacement)) return false;
  }

  return true;
}

// 主体名の置換禁止：日本酒の話で「ワイン」「ビール」を入れない等
// 酒税法品目を含めて拡張（Q-10: 酒ディプロマ試験文脈で清酒↔他酒類の自明な選択を防ぐ）
const SUBJECT_KEYWORDS = [
  '日本酒', '清酒', 'ワイン', 'ビール', '焼酎', '泡盛',
  'ウイスキー', 'ウィスキー', '果実酒', '発泡酒', 'ブランデー',
  'リキュール', 'みりん', 'ジン', 'ウォッカ', 'シードル',
  '原料用アルコール', '雑酒', '甘味果実酒', 'スピリッツ'
];
function preservesSubject(value, original, replacement) {
  // value 内の主体キーワードと一致しない別主体に置換しない
  const valueSubjects = SUBJECT_KEYWORDS.filter(k => value.includes(k));
  if (valueSubjects.length === 0) return true;
  // 置換語が他主体を含まなければOK
  for (const k of SUBJECT_KEYWORDS) {
    if (replacement.includes(k) && !valueSubjects.includes(k)) return false;
  }
  return true;
}

// 置換時に避けるべき汎用語（短い単独漢字で文意が変わるもの）
// これらは「特定の文脈でのみ意味を持つ」ため、その文脈の有無を確認しない場合は置換禁止
const CONTEXT_SENSITIVE_WORDS = {
  '個': /(?:発現率|計算式|心白|単位)/,  // 個 = 計算単位として使う場合のみ
  '本': /(?:本数|本来|単位|本格)/,
  '点': /(?:時点|地点|得点|論点)/,
};
function passesContextCheck(value, original) {
  const ctxRe = CONTEXT_SENSITIVE_WORDS[original];
  if (!ctxRe) return true;
  return ctxRe.test(value);
}

// D-18/D-19: 造語ブラックリスト（生成結果が試験で出ない造語であれば拒否）
const FORBIDDEN_PATTERNS = [
  // 玄+米以外、飯+米以外、精+米以外、純+米以外
  /玄(?:麦|甘藷|そば|芋)/, /飯(?:麦|甘藷|そば|芋)/, /精(?:麦|甘藷|そば|芋)/,
  /純(?:麦|甘藷|そば)酒/,
  // 酒+米以外+品種/蔵/こうじ/麹
  /酒(?:麦|甘藷|そば)(?:品種|麹|こうじ|蔵)/,
  // 米以外+トレーサビリティ
  /(?:麦|甘藷|そば)トレーサビリティ/,
  // 化学元素prefix の造語
  /(?:カリウム|ナトリウム|カルシウム|マグネシウム)(?:ゴ|様)/,
  // 金属種誤置換: 金額→錫器額・銅器額、金賞→錫器賞・銅器賞
  /(?:錫|銅|銀)器(?:額|賞|数|割合|漬|焼)/,
  /(?:錫|銅|銀)(?:賞|金)受賞数/,
  // 味覚＋酵母（誤った合成）
  /(?:アルコール感|甘味|酸味|苦味|旨味|甘味と酸味、苦味|アミノ酸感)酵母/,
  // 果物様＋（甘味|酸味|苦味|アルコール感）
  /(?:リンゴ|バナナ|メロン|ブドウ|柑橘)様の(?:甘味|酸味|苦味|旨味|アルコール感)/,
  // 物質状態＋温度（ペアリング系）
  /(?:粒状|固形|粉末|気体|結晶状)(?:を|で)(?:燗|冷酒|常温|14°|45°)/,
  // 単位+性
  /[%％‰g個本]性/,
  // 数値+性
  /[%％‰][のな](?:純米|大吟醸|本醸造)/,
  // 時代錯誤
  /(?:弥生時代|古墳時代|奈良時代|平安時代|鎌倉時代|室町時代)に(?:本格的な酒屋|級別制度|地理的表示|GI制度|寒造り)/,
  // 「○○な酸性の性質」
  /(?:若々しい|華やかな|爽やかな|ふくよかな|豊かな|穏やかな)酸性の性質/,
  // 物理的にあり得ない数値
  /精米歩合\s*1[0-9]{2}\.?\d*\s*%/, /アルコール\s*分?\s*1[0-9]{2}\.?\d*\s*[度%]/,
  // 米以外の「玄麦」みたいな農産物検査
  /醸造用(?:麦|甘藷|そば)の検査結果/,
];

function isForbiddenCompound(text) {
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// D-18: 置換結果の不自然な造語チェック（生成段階で拒否）
function producesUnnaturalCompound(value, original, replacement) {
  // 置換後の文字列を作る
  const after = value.replace(original, replacement);
  // ブラックリストパターンと照合
  if (isForbiddenCompound(after)) return true;

  // 動的チェック: 隣接文字との合成チェック
  const idx = after.indexOf(replacement);
  if (idx < 0) return false;
  const beforeChar = idx > 0 ? after[idx - 1] : '';

  if (beforeChar === '玄' && /^[麦芋甘藷そばし]/.test(replacement)) return true;
  if (beforeChar === '飯' && /^[麦芋甘藷そばし]/.test(replacement)) return true;
  if (beforeChar === '精' && /^[麦芋甘藷そばし]/.test(replacement)) return true;
  if (beforeChar === '純' && /^[麦甘藷そば]/.test(replacement)) return true;

  return false;
}

// D-20: 短い単語の境界チェック
//   2-3文字のカタカナ/ひらがな単語は前後が同字種の場合、外来語1単語の一部の可能性が高い
//   漢字単語は複合熟語が多いため境界制限は緩く（合成パターンは D-18 で別途検出）
function passesWordBoundary(value, original) {
  if (!original) return false;
  const origStr = String(original);
  if (origStr.length > 3) return true;

  const idx = value.indexOf(origStr);
  if (idx < 0) return true;

  const charType = (ch) => {
    if (!ch) return 'edge';
    if (/[ァ-ヴー]/.test(ch)) return 'kata';
    if (/[ぁ-ん]/.test(ch)) return 'hira';
    if (/[一-鿿々]/.test(ch)) return 'kanji';
    if (/[a-zA-Z0-9]/.test(ch)) return 'alnum';
    return 'punct';
  };
  const origType = charType(origStr[0]);
  const before = idx > 0 ? value[idx - 1] : '';
  const after = idx + origStr.length < value.length ? value[idx + origStr.length] : '';

  // カタカナ/ひらがな は前後同字種なら外来語/連体形の一部 → 除外
  if (origType === 'kata' || origType === 'hira') {
    if (origType === charType(before) || origType === charType(after)) return false;
  }
  // 漢字単語は実在熟語の一部であることが多いので通常OK（D-16/D-18で個別対応）
  return true;
}

// 統合検証
function isValidSubstitution(value, original, replacement, strategyName) {
  // D-16: 保護熟語の一部を置換していないか
  if (isInProtectedRange(value, original)) return false;
  // D-20: 短い単語が合成語の一部になっていないか
  if (!passesWordBoundary(value, original)) return false;
  // D-18: 不自然な造語ができないか
  if (producesUnnaturalCompound(value, original, replacement)) return false;
  if (!isGrammaticalReplacement(value, original, replacement)) return false;
  if (!preservesSubject(value, original, replacement)) return false;
  if (!passesContextCheck(value, original)) return false;
  return true;
}

// シンプルな entity 置換用ヘルパー（フィルタ済み3つを返す）
function simpleEntitySubstitute(value, list, found, strategyName) {
  return list
    .filter(t => t !== found && isValidSubstitution(value, found, t, strategyName))
    .slice(0, 3)
    .map(c => ({
      text: value.replace(found, c),
      strategy: strategyName,
      diff: `${found} → ${c}`,
    }));
}

// ============================================================
// 戦略 1: tableRules - 特定名称酒の表
// ============================================================
function tryTable_特定名称酒(value) {
  const table = RULES.tableRules['特定名称酒_精米歩合'];
  // どの特定名称酒の言及か判定
  const mentioned = SAKE_TYPES.find(s => value.includes(s));
  if (!mentioned) return [];

  const target = table.find(r => r.name === mentioned);
  if (!target) return [];

  const distractors = [];

  // 「精米歩合60%以下」のような値を含む場合 → 他の名称酒の値で置換
  const precisionMatch = value.match(/精米歩合\s*(\d+%以下|規定なし|60%以下または特別な製造方法|50%以下|70%以下)/);
  if (precisionMatch) {
    const correct = precisionMatch[1];
    const others = table
      .filter(r => r.name !== mentioned && r['精米歩合'] !== correct)
      .map(r => ({
        text: value.replace(precisionMatch[0], `精米歩合${r['精米歩合']}`),
        strategy: 'table-精米歩合置換',
        diff: `精米歩合${correct} → 精米歩合${r['精米歩合']}（${r.name}の規定）`,
      }));
    distractors.push(...others.slice(0, 3));
  }

  // 「米・米こうじ」と「米・米こうじ・醸造アルコール」の置換
  if (value.includes('米・米こうじ・醸造アルコール') || value.includes('米、米こうじ、醸造アルコール')) {
    distractors.push({
      text: value
        .replace('米・米こうじ・醸造アルコール', '米・米こうじ')
        .replace('米、米こうじ、醸造アルコール', '米、米こうじ'),
      strategy: 'table-原料置換',
      diff: '醸造アルコールあり → なし（純米系）',
    });
  } else if (value.includes('米・米こうじ') || value.includes('米、米こうじ')) {
    distractors.push({
      text: value
        .replace('米・米こうじ', '米・米こうじ・醸造アルコール')
        .replace('米、米こうじ', '米、米こうじ、醸造アルコール'),
      strategy: 'table-原料置換',
      diff: '醸造アルコールなし → あり',
    });
  }

  return distractors;
}

// ============================================================
// 戦略 2: entityRules - 米品種・県・酵母など固有名詞置換
// ============================================================
function tryEntity_米品種(value) {
  const found = ALL_RICE_VARIETIES
    .filter(v => value.includes(v))
    .sort((a, b) => b.length - a.length); // 長い名前から優先（誤マッチ回避）
  if (!found.length) return [];

  const target = found[0];
  const r = RULES.entityRules['酒造好適米'];

  // 同じ tier の他品種を優先
  let candidates = [];
  if (r.tier1_全国流通.includes(target)) {
    candidates = r.tier1_全国流通.filter(x => x !== target);
  } else if (r.tier2_有名.includes(target)) {
    candidates = r.tier2_有名.filter(x => x !== target);
  } else if (r.tier3_地方.includes(target)) {
    candidates = r.tier3_地方.filter(x => x !== target);
  }
  // 不足分は tier1 から補充
  for (const c of r.tier1_全国流通) {
    if (c !== target && !candidates.includes(c)) candidates.push(c);
  }
  return candidates
    .filter(c => isValidSubstitution(value, target, c, 'entity-米品種置換'))
    .slice(0, 3)
    .map(c => ({
      text: value.replace(target, c),
      strategy: 'entity-米品種置換',
      diff: `${target} → ${c}`,
    }));
}

function tryEntity_都道府県(value) {
  const found = ALL_PREFECTURES.filter(p => value.includes(p));
  if (!found.length) return [];
  const target = found[0];
  const r = RULES.entityRules['都道府県'];

  // どの地域グループに属するか判定
  let regionList = null;
  for (const key of ['東北', '北陸_甲信越', '関東', '東海', '近畿', '中国', '四国', '九州_沖縄']) {
    if (r[key].includes(target)) { regionList = r[key]; break; }
  }
  if (!regionList) regionList = r['酒造主要県_順位'];

  const candidates = regionList.filter(x => x !== target).slice(0, 3);
  // 同地域内で3つ揃わない場合、酒造主要県から補充
  while (candidates.length < 3) {
    for (const c of r['酒造主要県_順位']) {
      if (c !== target && !candidates.includes(c)) {
        candidates.push(c);
        if (candidates.length >= 3) break;
      }
    }
    break;
  }
  return candidates
    .filter(c => isValidSubstitution(value, target, c, 'entity-県置換'))
    .slice(0, 3)
    .map(c => ({
      text: value.replace(target, c),
      strategy: 'entity-県置換',
      diff: `${target} → ${c}`,
    }));
}

function tryEntity_杜氏(value) {
  const found = TOJI_LIST.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, TOJI_LIST, found, 'entity-杜氏置換');
}

function tryEntity_酵母(value) {
  const found = YEAST_LIST.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, YEAST_LIST, found, 'entity-酵母置換');
}

function tryEntity_酒母(value) {
  const found = SHUBO_LIST.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, SHUBO_LIST, found, 'entity-酒母置換');
}

function tryEntity_焼酎(value) {
  const found = SHOCHU_TYPES.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, SHOCHU_TYPES, found, 'entity-焼酎置換');
}

function tryEntity_級別(value) {
  const found = KYUBETSU_LIST.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, KYUBETSU_LIST, found, 'entity-級別置換');
}

function tryEntity_工程動作(value) {
  for (const [groupName, list] of Object.entries(KOTEI_GROUPS)) {
    if (groupName.startsWith('_') || !Array.isArray(list)) continue;
    const sorted = list.slice().sort((a, b) => b.length - a.length);
    const found = sorted.find(t => value.includes(t));
    if (found) {
      const others = list
        .filter(t => t !== found && !value.includes(t)
          && isValidSubstitution(value, found, t, `entity-工程動作置換(${groupName})`));
      if (others.length === 0) continue;
      return others.slice(0, 3).map(c => ({
        text: value.replace(found, c),
        strategy: `entity-工程動作置換(${groupName})`,
        diff: `${found} → ${c}`,
      }));
    }
  }
  return [];
}

function tryEntity_鑑評会(value) {
  const sorted = KANPYOKAI_LIST.slice().sort((a, b) => b.length - a.length);
  const found = sorted.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, KANPYOKAI_LIST, found, 'entity-鑑評会置換');
}

function tryEntity_蒸留方式(value) {
  const sorted = SHUTSURO_LIST.slice().sort((a, b) => b.length - a.length);
  const found = sorted.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, SHUTSURO_LIST, found, 'entity-蒸留方式置換');
}

function tryEntity_麹菌(value) {
  const sorted = KOJI_RAKU_LIST.slice().sort((a, b) => b.length - a.length);
  const found = sorted.find(t => value.includes(t));
  if (!found) return [];
  return simpleEntitySubstitute(value, KOJI_RAKU_LIST, found, 'entity-麹菌置換');
}

// ===== 拡張辞書ベース戦略（用途特化）=====

// D-17: ドメインアンカー
//   特定の辞書は、value にドメインキーワードが含まれていない限り適用しない
//   例: 焼酎麹原料 (米/麦/甘藷/そば/黒糖) は、value に「焼酎」「麹」キーワードがある場合のみ適用
const DOMAIN_ANCHORS = {
  'entity-焼酎麹原料置換': ['焼酎', '麹'],
  'entity-焼酎置換': ['焼酎'],
  'entity-甘藷品種置換': ['甘藷', 'いも', '芋', 'さつまいも'],
  'entity-焼酎_本格焼酎要件詳細置換': ['焼酎', '泡盛'],
  'entity-焼酎ペアリング_詳細風味置換': ['焼酎', '泡盛'],
};

// 戦略名の前方一致でアンカーを判定
function getDomainAnchor(strategyName) {
  for (const [prefix, anchors] of Object.entries(DOMAIN_ANCHORS)) {
    if (strategyName && strategyName.startsWith(prefix.replace('置換', ''))) return anchors;
    if (strategyName === prefix) return anchors;
  }
  if (!strategyName) return null;

  // 食材辞書（短い単語を含むため、料理・ペアリング文脈に限定）
  if (/食材_魚介類|食材_肉類|食材_野菜果物/.test(strategyName)) {
    return ['料理', 'ペアリング', '相性', '味わう', '合わせる', '寿司', '刺身', '焼き', '煮', '鍋', '飲み', '燗', '冷酒', '°C', '℃'];
  }
  if (/料理_西洋|料理_和食/.test(strategyName)) {
    return ['料理', 'ペアリング', '相性', '味わう', '合わせる', '°C', '℃'];
  }
  // 焼酎関連
  if (/焼酎/.test(strategyName)) return ['焼酎', '泡盛'];
  if (/甘藷/.test(strategyName)) return ['甘藷', 'いも', '芋', 'さつまいも'];
  // 心白関連
  if (/心白/.test(strategyName)) return ['心白', '発現'];
  // 麹菌関連
  if (/麹菌/.test(strategyName)) return ['麹', '焼酎', '清酒', '日本酒', '泡盛'];
  // メイラード関連
  if (/メイラード/.test(strategyName)) return ['メイラード', 'メラノイジン'];
  // 物質状態
  if (/物質状態/.test(strategyName)) return ['液状', '固形', '粒状', '粉末'];
  // 杜氏組織役職: 杜氏文脈のみ
  if (/杜氏組織/.test(strategyName)) return ['杜氏', '蔵人', '蔵元'];
  // 都道府県気候: 気候・地理文脈
  if (/都道府県気候|農業用語|酒造好適米_特徴/.test(strategyName)) return ['気候', '気温', '稲', '米', '栽培', '産地', '都', '道', '府', '県'];
  // 外観評価
  if (/外観評価|香り評価|味わい成分/.test(strategyName)) return ['外観', '香り', '味わい', 'テイスティング', '色'];
  // 温度帯詳細：温度文脈のみ
  if (/温度帯/.test(strategyName)) return ['℃', '°C', '冷', '燗', '常温', '温度'];
  // 時代区分: 歴史文脈
  if (/時代区分|歴史/.test(strategyName)) return ['時代', '世紀', '年', '幕府', '王朝', '昭和', '明治', '平成', '令和', '大正', '江戸', '室町', '鎌倉', '平安', '奈良'];
  // 第3弾: 各ドメインアンカー
  if (/東北地方/.test(strategyName)) return ['東北', '青森', '岩手', '宮城', '秋田', '山形', '福島', '津軽', '南部', '奥羽', '北上'];
  if (/泡盛/.test(strategyName)) return ['泡盛', '沖縄', '琉球', '島'];
  if (/沖縄食材/.test(strategyName)) return ['沖縄', '泡盛', '島', '南国', '珊瑚'];
  if (/宮城/.test(strategyName)) return ['宮城', '伊達', '仙台'];
  if (/微生物増殖/.test(strategyName)) return ['細胞', '増殖', '出芽', '分裂', '微生物', '酵母', '菌'];
  if (/詳細科学用語/.test(strategyName)) return ['アントシアニン', 'カロテン', 'ジアセチル', 'リナロール', 'カプロン酸', '香り', '色素', '成分'];
  if (/杜氏起源|杜氏要件/.test(strategyName)) return ['杜氏', '蔵人', '醸造責任者'];
  if (/酒造工程|工程上槽|酒母_濾過|酒造り技術/.test(strategyName)) return ['工程', '醪', '酒母', '上槽', '搾る', '滓引き', '濾過', '火入れ'];
  if (/醸造アルコール/.test(strategyName)) return ['醸造アルコール', 'アルコール', '蒸留', '糖蜜'];
  if (/純米酒要件/.test(strategyName)) return ['純米酒', '要件', '原料', '米麹', '米のみ'];
  if (/酵母種類拡張/.test(strategyName)) return ['酵母', '出芽', 'きょうかい', '泡', '発酵', '蔵', '花'];
  if (/稲分類|酒造好適米_呼称/.test(strategyName)) return ['稲', '米', '品種', '酒米', 'うるち', 'もち'];
  if (/甘藷焼酎品種/.test(strategyName)) return ['甘藷', '焼酎', 'コガネセンガン', 'アヤムラサキ'];
  if (/焼酎麦原料/.test(strategyName)) return ['麦焼酎', '大麦', '小麦', '壱岐', '麦'];
  if (/焼酎主産県/.test(strategyName)) return ['焼酎', '泡盛', '鹿児島', '熊本', '大分', '宮崎', '長崎', '沖縄'];
  if (/酒器詳細/.test(strategyName)) return ['酒器', '盃', '徳利', '銚子', 'ちろり', '猪口'];
  if (/県別記述開発品種/.test(strategyName)) return ['代わる', 'として開発', '父', '母', '交配'];
  if (/県の特産酒米/.test(strategyName)) return ['交配', '父', '母', 'を父に', 'を母に'];
  if (/酒類定義系/.test(strategyName)) return ['とは', 'と呼ぶ', '定義', '称される'];
  if (/酒造工程_完全/.test(strategyName)) return ['工程', '酒造', '醪', '酒母'];
  if (/県別_気候詳細/.test(strategyName)) return ['気候', '気温', '降水量', '日照時間', '積雪'];
  if (/地形地理単位/.test(strategyName)) return ['平野', '山脈', '河川', '気候', '北部', '南部', '東部', '西部'];
  // 第4弾アンカー
  if (/県の酒の特徴/.test(strategyName)) return ['酒質', '味わい', '風味', '甘味', '辛味', '雑味', '渋み', '苦味', '酒風'];
  if (/杜氏流派/.test(strategyName)) return ['杜氏', '流派', '集団'];
  if (/酒造工程冒頭|麹役割|並行複発酵対比/.test(strategyName)) return ['工程', '玄米', '白米', '蒸し', '醸造', '麹', '発酵', 'ビール', 'ワイン'];
  if (/米の重さ|酒造好適米適性|もち米四段/.test(strategyName)) return ['米', '粒', 'g', '酒造', '玄米', '白米', '酒米'];
  if (/灘の歴史|歴史的酒推進主体/.test(strategyName)) return ['灘', '丹波', '幕府', '寒造り', '世紀', '杜氏'];
  if (/酒米県内比率/.test(strategyName)) return ['県内', '県外', '消費', '移出', '酒米'];
  return null;
}

// 汎用：与えられたリストから最長一致を見つけて他要素に置換
//   D-13/D-14/D-16/D-17 の検証を通った置換のみ返す
function listSubstitute(value, list, strategyName) {
  if (!list || list.length === 0) return [];

  // D-17: ドメインアンカーチェック
  const anchors = getDomainAnchor(strategyName);
  if (anchors && !anchors.some(a => value.includes(a))) return [];

  const sorted = list.slice().sort((a, b) => b.length - a.length);
  const found = sorted.find(t => value.includes(t));
  if (!found) return [];

  // 単一文字の汎用語は文脈チェックを通らないと置換しない
  if (found.length === 1 && !passesContextCheck(value, found)) return [];

  // D-16: 保護熟語に含まれる場合は置換しない
  if (isInProtectedRange(value, found)) return [];

  return list
    .filter(t => t !== found && isValidSubstitution(value, found, t, strategyName))
    .slice(0, 3)
    .map(c => ({
      text: value.replace(found, c),
      strategy: strategyName,
      diff: `${found} → ${c}`,
    }));
}

function tryEntity_麹菌酵素(value) {
  return listSubstitute(value, KOJI_ENZYMES, 'entity-麹酵素置換');
}

function tryEntity_麹型(value) {
  return listSubstitute(value, KOJI_TYPES, 'entity-麹型置換');
}

function tryEntity_製麹工程(value) {
  return listSubstitute(value, KOJI_KOTEI, 'entity-製麹工程置換');
}

function tryEntity_発酵タイプ(value) {
  return listSubstitute(value, FERMENT_TYPES, 'entity-発酵タイプ置換');
}

function tryEntity_米成分(value) {
  return listSubstitute(value, RICE_COMPONENTS, 'entity-米成分置換');
}

function tryEntity_水成分(value) {
  // 有用成分群の中での置換
  let out = listSubstitute(value, WATER_GOOD, 'entity-水有用成分置換');
  if (out.length === 0) {
    out = listSubstitute(value, WATER_BAD, 'entity-水悪成分置換');
  }
  return out;
}

function tryEntity_時代(value) {
  // 古代分類・明治分類・戦後分類・通常時代の順で試す
  for (const key of ['古代分類', '明治分類', '戦後分類', 'list']) {
    const list = ERAS[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-時代区分置換(${key})`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

function tryEntity_歴史文献(value) {
  return listSubstitute(value, HISTORICAL_DOCS, 'entity-歴史文献置換');
}

function tryEntity_歴史機関(value) {
  return listSubstitute(value, HISTORICAL_ORGS, 'entity-歴史機関置換');
}

function tryEntity_神社寺院(value) {
  for (const key of ['酒の神社', '京都神社', '酒造寺院']) {
    const list = SHRINES_TEMPLES[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-神社寺院置換(${key})`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

function tryEntity_歴史人物(value) {
  return listSubstitute(value, HIST_PEOPLE, 'entity-歴史人物置換');
}

function tryEntity_色調(value) {
  return listSubstitute(value, COLOR_TONES, 'entity-色調置換');
}

function tryEntity_外観器具(value) {
  return listSubstitute(value, APPEARANCE_TOOLS, 'entity-外観器具置換');
}

function tryEntity_メイラード(value) {
  for (const key of ['発見者', '発見国', '発見世紀', '反応物質', '生成物', '影響因子']) {
    const list = MAILLARD_RULES[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-メイラード(${key})置換`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

function tryEntity_香り表現(value) {
  for (const key of ['STEP1_全体像', 'STEP2_強弱', '香り種別']) {
    const list = SCENT_EXP[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-香り(${key})置換`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

function tryEntity_飲む温度(value) {
  return listSubstitute(value, SAKE_TEMP, 'entity-温度区分置換');
}

function tryEntity_酒器名称(value) {
  for (const key of ['盃類', '徳利類', '金属容器', 'ガラス器', '用途']) {
    const list = SAKE_VESSELS[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-酒器(${key})置換`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

function tryEntity_ペアリング目的(value) {
  return listSubstitute(value, PAIRING_PURPOSES, 'entity-ペアリング目的置換');
}

function tryEntity_甘藷品種(value) {
  return listSubstitute(value, SHOCHU_KANSO, 'entity-甘藷品種置換');
}

function tryEntity_焼酎油臭(value) {
  for (const key of ['原因', '予防方法']) {
    const list = SHOCHU_OIL[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-焼酎油臭(${key})置換`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

function tryEntity_焼酎ペアリング(value) {
  for (const key of ['泡盛_合う料理', '泡盛_合う調味料', '泡盛_飲み方', '薩摩焼酎_合う料理', '球磨焼酎_合う料理', '壱岐焼酎_合う料理', '黒糖焼酎_合う料理']) {
    const list = SHOCHU_PAIRING[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-焼酎ペアリング(${key})置換`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

function tryEntity_歴史的製法(value) {
  return listSubstitute(value, HISTORICAL_METHODS, 'entity-歴史的製法置換');
}

function tryEntity_蒸米物性(value) {
  return listSubstitute(value, STEAMED_RICE_STATE, 'entity-蒸米物性置換');
}

function tryEntity_pH値(value) {
  // まずpH値そのものを置換
  let r = listSubstitute(value, PH_VALUES, 'entity-pH値置換');
  if (r.length > 0) return r;
  // 次に物質名を置換
  return listSubstitute(value, PH_OBJECTS, 'entity-pH物質置換');
}

function tryEntity_心白(value) {
  return listSubstitute(value, SHINPAKU_SHAPES, 'entity-心白形状置換');
}

function tryEntity_麹菌3種(value) {
  return listSubstitute(value, KOJI_BWY, 'entity-黒白黄麹置換');
}

function tryEntity_稲分類(value) {
  for (const key of ['アジアイネ_種別', '栽培環境別', '用途別', '成熟期別', '粒形別']) {
    const list = RICE_VARIATION[key];
    if (list) {
      const r = listSubstitute(value, list, `entity-稲分類(${key})置換`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

// ===== さらに用途特化（fallback解消用）=====
function tryFromMultiAxisDict(value, dictKey) {
  const dict = RULES.entityRules[dictKey];
  if (!dict) return [];
  // すべての配列フィールドを順番に試す
  for (const [k, v] of Object.entries(dict)) {
    if (k.startsWith('_') || k === 'distractorPolicy') continue;
    if (Array.isArray(v)) {
      const r = listSubstitute(value, v, `entity-${dictKey}/${k}置換`);
      if (r.length > 0) return r;
    } else if (typeof v === 'object' && v !== null) {
      // 入れ子オブジェクトのキー集合も対象
      const keys = Object.keys(v);
      const r = listSubstitute(value, keys, `entity-${dictKey}/${k}キー置換`);
      if (r.length > 0) return r;
    }
  }
  return [];
}

// 用途特化マルチ軸辞書 wrapper（複数のキーから自動選択）
function tryEntity_公示権限者(value) { return tryFromMultiAxisDict(value, '公示権限者'); }
function tryEntity_比重単位(value) { return tryFromMultiAxisDict(value, '比重単位'); }
function tryEntity_麹を枯らす効果(value) { return tryFromMultiAxisDict(value, '麹を枯らす効果'); }
function tryEntity_蔵つき酵母(value) { return tryFromMultiAxisDict(value, '蔵つき酵母'); }
function tryEntity_花酵母(value) { return tryFromMultiAxisDict(value, '花酵母'); }
function tryEntity_酵母種_詳細(value) { return tryFromMultiAxisDict(value, '酵母種_詳細'); }
function tryEntity_清酒酵母_物理(value) { return tryFromMultiAxisDict(value, '清酒酵母_物理'); }
function tryEntity_杜氏定義(value) { return tryFromMultiAxisDict(value, '杜氏定義'); }
function tryEntity_蒸米使用比率(value) { return tryFromMultiAxisDict(value, '蒸米使用比率'); }
function tryEntity_麹の役割(value) { return tryFromMultiAxisDict(value, '麹の役割'); }
function tryEntity_限定吸水(value) { return tryFromMultiAxisDict(value, '限定吸水'); }
function tryEntity_麹の状態評価(value) { return tryFromMultiAxisDict(value, '麹の状態評価'); }
function tryEntity_純米系分類(value) { return tryFromMultiAxisDict(value, '純米系分類'); }
function tryEntity_米だけの酒(value) { return tryFromMultiAxisDict(value, '米だけの酒'); }
function tryEntity_産地品種銘柄(value) { return tryFromMultiAxisDict(value, '産地品種銘柄'); }
function tryEntity_稲の特性(value) { return tryFromMultiAxisDict(value, '稲の特性'); }
function tryEntity_登熟期影響(value) { return tryFromMultiAxisDict(value, '登熟期影響'); }
function tryEntity_宮水ミネラル(value) { return tryFromMultiAxisDict(value, '宮水ミネラル'); }
function tryEntity_ボーメ管理(value) { return tryFromMultiAxisDict(value, 'ボーメ管理'); }
function tryEntity_テイスティング姿勢(value) { return tryFromMultiAxisDict(value, 'テイスティング_姿勢'); }
function tryEntity_個人差ある表現(value) { return tryFromMultiAxisDict(value, '個人差ある表現'); }
function tryEntity_搾りたて熟成効果(value) { return tryFromMultiAxisDict(value, '搾りたて_熟成効果'); }
function tryEntity_泡盛特徴(value) { return tryFromMultiAxisDict(value, '泡盛特徴'); }
function tryEntity_焼酎甲乙混和詳細(value) { return tryFromMultiAxisDict(value, '焼酎甲乙混和_詳細'); }
function tryEntity_焼酎麹原料(value) { return tryFromMultiAxisDict(value, '焼酎麹_原料'); }
function tryEntity_甘藷焼酎特殊(value) { return tryFromMultiAxisDict(value, '甘藷焼酎_特殊地域'); }
function tryEntity_本格焼酎要件(value) { return tryFromMultiAxisDict(value, '本格焼酎要件_詳細'); }
function tryEntity_焼酎ペアリング詳細(value) { return tryFromMultiAxisDict(value, '焼酎ペアリング_詳細風味'); }
function tryEntity_総ハゼ突きハゼ(value) {
  // ネストされたオブジェクトのキー集合
  const dict = RULES.entityRules['総ハゼ_突きハゼ'];
  if (!dict) return [];
  const keys = Object.keys(dict).filter(k => !k.startsWith('_') && k !== 'distractorPolicy');
  return listSubstitute(value, keys, 'entity-総ハゼ突きハゼ置換');
}
function tryEntity_吟醸酒用語起源(value) { return tryFromMultiAxisDict(value, '吟醸酒_用語起源'); }
function tryEntity_もち米使用理由(value) { return tryFromMultiAxisDict(value, 'もち米使用_理由'); }
function tryEntity_心白発現率計算(value) { return tryFromMultiAxisDict(value, '心白発現率_計算'); }
function tryEntity_もろみ定義(value) { return tryFromMultiAxisDict(value, 'もろみ定義'); }
function tryEntity_GI要件詳細(value) { return tryFromMultiAxisDict(value, 'GI地理的表示要件_詳細'); }
function tryEntity_樽酒表示(value) { return tryFromMultiAxisDict(value, '樽酒表示'); }
function tryEntity_醸造アルコール詳細(value) { return tryFromMultiAxisDict(value, '醸造アルコール添加_効果_詳細'); }
function tryEntity_蒸米デンプン構造(value) { return tryFromMultiAxisDict(value, '蒸米デンプン構造'); }
function tryEntity_麹意義(value) { return tryFromMultiAxisDict(value, '麹意義'); }
function tryEntity_酒造工程複雑性(value) { return tryFromMultiAxisDict(value, '酒造工程の複雑性'); }
function tryEntity_麹の温度保持(value) { return tryFromMultiAxisDict(value, '麹の温度保持'); }
function tryEntity_並行複式発酵特徴(value) { return tryFromMultiAxisDict(value, '並行複式発酵_特徴'); }
// === 新規追加辞書のアクセサ ===
function tryEntity_酒類カテゴリー(value) { return tryFromMultiAxisDict(value, '酒類カテゴリー'); }
function tryEntity_米の部位(value) { return tryFromMultiAxisDict(value, '米の部位'); }
function tryEntity_発酵タイプ詳細(value) { return tryFromMultiAxisDict(value, '発酵タイプ_詳細'); }
function tryEntity_水質pH分類(value) { return tryFromMultiAxisDict(value, '水質pH分類'); }
function tryEntity_温度帯詳細(value) { return tryFromMultiAxisDict(value, '温度帯_詳細'); }
function tryEntity_食材魚介類(value) { return tryFromMultiAxisDict(value, '食材_魚介類'); }
function tryEntity_食材肉類(value) { return tryFromMultiAxisDict(value, '食材_肉類'); }
function tryEntity_食材野菜果物(value) { return tryFromMultiAxisDict(value, '食材_野菜果物'); }
function tryEntity_料理西洋(value) { return tryFromMultiAxisDict(value, '料理_西洋'); }
function tryEntity_料理和食(value) { return tryFromMultiAxisDict(value, '料理_和食'); }
function tryEntity_酒種特徴完全(value) { return tryFromMultiAxisDict(value, '酒種特徴_完全'); }
function tryEntity_時代区分細分(value) { return tryFromMultiAxisDict(value, '時代区分_細分'); }
function tryEntity_造り方の対比語(value) { return tryFromMultiAxisDict(value, '造り方の対比語'); }
function tryEntity_酒蔵の規模(value) { return tryFromMultiAxisDict(value, '酒蔵の規模'); }
function tryEntity_都道府県気候(value) { return tryFromMultiAxisDict(value, '都道府県_気候'); }
function tryEntity_農業用語(value) { return tryFromMultiAxisDict(value, '農業用語'); }
function tryEntity_杜氏組織役職(value) { return tryFromMultiAxisDict(value, '杜氏組織_役職'); }
function tryEntity_酒造好適米特徴(value) { return tryFromMultiAxisDict(value, '酒造好適米_特徴'); }
function tryEntity_原料処理工程(value) { return tryFromMultiAxisDict(value, '原料処理工程'); }
function tryEntity_外観評価(value) { return tryFromMultiAxisDict(value, '外観評価'); }
function tryEntity_香り評価第一段階(value) { return tryFromMultiAxisDict(value, '香り評価_第一段階'); }
function tryEntity_味わい成分(value) { return tryFromMultiAxisDict(value, '味わい成分'); }
function tryEntity_酒蔵関連道具(value) { return tryFromMultiAxisDict(value, '酒蔵関連道具'); }
function tryEntity_焼酎詳細(value) { return tryFromMultiAxisDict(value, '焼酎_詳細'); }
// === 第3弾の追加辞書 ===
function tryEntity_地形地理単位(value) { return tryFromMultiAxisDict(value, '地形地理単位'); }
function tryEntity_東北地方の地理(value) { return tryFromMultiAxisDict(value, '東北地方の地理'); }
function tryEntity_酒造工程完全(value) { return tryFromMultiAxisDict(value, '酒造工程_完全'); }
function tryEntity_純米酒要件(value) { return tryFromMultiAxisDict(value, '純米酒要件'); }
function tryEntity_酵母種類拡張(value) { return tryFromMultiAxisDict(value, '酵母種類_拡張'); }
function tryEntity_醸造アルコール詳細2(value) { return tryFromMultiAxisDict(value, '醸造アルコール詳細'); }
function tryEntity_杜氏起源(value) { return tryFromMultiAxisDict(value, '杜氏起源'); }
function tryEntity_杜氏要件(value) { return tryFromMultiAxisDict(value, '杜氏要件'); }
function tryEntity_稲分類完全(value) { return tryFromMultiAxisDict(value, '稲分類_完全'); }
function tryEntity_酒造好適米呼称(value) { return tryFromMultiAxisDict(value, '酒造好適米_呼称'); }
function tryEntity_甘藷焼酎品種詳細(value) { return tryFromMultiAxisDict(value, '甘藷焼酎品種_詳細'); }
function tryEntity_焼酎主産県(value) { return tryFromMultiAxisDict(value, '焼酎主産県'); }
function tryEntity_酒器詳細拡張(value) { return tryFromMultiAxisDict(value, '酒器詳細_拡張'); }
function tryEntity_泡盛伝統(value) { return tryFromMultiAxisDict(value, '泡盛伝統'); }
function tryEntity_沖縄食材(value) { return tryFromMultiAxisDict(value, '沖縄食材'); }
function tryEntity_微生物増殖(value) { return tryFromMultiAxisDict(value, '微生物_増殖'); }
function tryEntity_県の特産酒米県別(value) { return tryFromMultiAxisDict(value, '県の特産酒米_県別'); }
function tryEntity_工程上槽用語(value) { return tryFromMultiAxisDict(value, '工程上槽_用語'); }
function tryEntity_酒母濾過火入れ(value) { return tryFromMultiAxisDict(value, '酒母_濾過火入れ'); }
function tryEntity_県別気候詳細(value) { return tryFromMultiAxisDict(value, '県別_気候詳細'); }
function tryEntity_酒造り技術(value) { return tryFromMultiAxisDict(value, '酒造り技術'); }
function tryEntity_焼酎麦原料系(value) { return tryFromMultiAxisDict(value, '焼酎_麦原料系'); }
function tryEntity_宮城酒造年表(value) { return tryFromMultiAxisDict(value, '宮城_酒造年表'); }
function tryEntity_県別記述開発品種(value) { return tryFromMultiAxisDict(value, '県別記述_開発品種'); }
function tryEntity_詳細科学用語(value) { return tryFromMultiAxisDict(value, '詳細科学用語'); }
function tryEntity_酒類定義系(value) { return tryFromMultiAxisDict(value, '酒類定義系'); }
// === 第4弾の追加辞書 ===
function tryEntity_県の酒の特徴_形容(value) { return tryFromMultiAxisDict(value, '県の酒の特徴_形容'); }
function tryEntity_杜氏流派全国(value) { return tryFromMultiAxisDict(value, '杜氏流派_全国'); }
function tryEntity_酒造工程冒頭(value) { return tryFromMultiAxisDict(value, '酒造工程_冒頭'); }
function tryEntity_麹役割比較(value) { return tryFromMultiAxisDict(value, '麹役割比較'); }
function tryEntity_米の重さ粒数(value) { return tryFromMultiAxisDict(value, '米の重さ_粒数'); }
function tryEntity_もち米四段(value) { return tryFromMultiAxisDict(value, 'もち米四段'); }
function tryEntity_並行複発酵対比(value) { return tryFromMultiAxisDict(value, '並行複発酵_対比'); }
function tryEntity_酒米県内比率(value) { return tryFromMultiAxisDict(value, '酒米県内比率'); }
function tryEntity_酒造好適米適性(value) { return tryFromMultiAxisDict(value, '酒造好適米_適性'); }
function tryEntity_灘の歴史(value) { return tryFromMultiAxisDict(value, '灘の歴史'); }
function tryEntity_歴史的酒推進主体(value) { return tryFromMultiAxisDict(value, '歴史的酒推進主体'); }
function tryEntity_物質状態(value) {
  // 物質状態の置換は「醪を液状部分」「液状部分とかす部分」のような明示的物質状態文脈のみ適用
  // 文脈アンカー: 「液状」「固形」「粒状」を含み、かつ周辺に「部分」または「状態」がある
  const list = (RULES.entityRules['物質状態'] && RULES.entityRules['物質状態'].list) || [];
  return listSubstitute(value, list, 'entity-物質状態置換');
}
function tryEntity_特定名称酒分類数(value) { return tryFromMultiAxisDict(value, '特定名称酒_分類数'); }
function tryEntity_生酒注意事項(value) { return tryFromMultiAxisDict(value, '生酒注意事項'); }
function tryEntity_樽酒表示詳細(value) { return tryFromMultiAxisDict(value, '樽酒表示_詳細'); }
function tryEntity_宮水ミネラル詳細(value) { return tryFromMultiAxisDict(value, '宮水ミネラル_詳細'); }
function tryEntity_蒸米デンプン詳細(value) { return tryFromMultiAxisDict(value, '蒸米デンプン_詳細'); }

// ============================================================
// 戦略 3: antonymRules - 対比語反転
// ============================================================
function tryAntonym(value) {
  const distractors = [];
  for (const pair of RULES.antonymRules.pairs) {
    const { a, b } = pair;
    if (value.includes(a) && isValidSubstitution(value, a, b, 'antonym-反転')) {
      distractors.push({
        text: value.replace(a, b),
        strategy: 'antonym-反転',
        diff: `${a} → ${b}`,
      });
    } else if (value.includes(b) && isValidSubstitution(value, b, a, 'antonym-反転')) {
      distractors.push({
        text: value.replace(b, a),
        strategy: 'antonym-反転',
        diff: `${b} → ${a}`,
      });
    }
    if (distractors.length >= 3) break;
  }
  return distractors;
}

// ============================================================
// 戦略 4: numericRules - 数値置換
// ============================================================
function tryNumeric(value) {
  const distractors = [];

  // 4.1 精米歩合（特定名称酒規定）の3値が候補
  const seimaiMatch = value.match(/精米歩合\s*(\d+(?:\.\d+)?)\s*%/);
  if (seimaiMatch) {
    const correct = parseFloat(seimaiMatch[1]);
    const r = RULES.numericRules['精米歩合_実用範囲'];
    // 近接値を3つ
    const cands = r.values
      .filter(v => v !== correct && Math.abs(v - correct) <= 30)
      .sort((a, b) => Math.abs(a - correct) - Math.abs(b - correct))
      .slice(0, 3);
    for (const c of cands) {
      distractors.push({
        text: value.replace(seimaiMatch[0], `精米歩合${c}%`),
        strategy: 'numeric-精米歩合置換',
        diff: `${correct}% → ${c}%（教本登場の精米歩合値）`,
      });
    }
    if (distractors.length >= 3) return distractors;
  }

  // 4.2 アルコール度
  const alcMatch = value.match(/アルコール\s*(?:分|度数?)\s*(?:が|は)?\s*(\d+(?:\.\d+)?)\s*(?:度|%|％|vol)/);
  if (alcMatch) {
    const correct = parseFloat(alcMatch[1]);
    const r = correct >= 25
      ? RULES.numericRules['アルコール度_焼酎範囲']
      : RULES.numericRules['アルコール度_清酒範囲'];
    const cands = r.values
      .filter(v => v !== correct)
      .sort((a, b) => Math.abs(a - correct) - Math.abs(b - correct))
      .slice(0, 3);
    for (const c of cands) {
      distractors.push({
        text: value.replace(alcMatch[1], String(c)),
        strategy: 'numeric-アルコール度置換',
        diff: `${correct} → ${c}`,
      });
    }
    if (distractors.length >= 3) return distractors;
  }

  // 4.3 一般的な数値（単位付き）
  const numMatch = value.match(/(\d+(?:\.\d+)?)\s*(%|％|度|℃|kl|kg|ppm|号|t|cm|km|m)(?!\w)/);
  if (numMatch && !seimaiMatch && !alcMatch) {
    const correct = parseFloat(numMatch[1]);
    const unit = numMatch[2];
    // ±10%, ±25%, ±50% の値を候補に
    let cands = [];
    if (correct >= 1) {
      cands = [
        Math.round(correct * 0.5 * 10) / 10,
        Math.round(correct * 0.7 * 10) / 10,
        Math.round(correct * 1.3 * 10) / 10,
        Math.round(correct * 1.5 * 10) / 10,
        Math.round(correct * 2 * 10) / 10,
      ];
    } else {
      cands = [correct * 0.1, correct * 0.5, correct * 2, correct * 5, correct * 10];
    }
    cands = cands.filter(v => v !== correct && v > 0);
    cands = [...new Set(cands)].slice(0, 3);
    for (const c of cands) {
      const numStr = Number.isInteger(c) ? String(c) : String(c);
      distractors.push({
        text: value.replace(numMatch[0], `${numStr}${unit}`),
        strategy: 'numeric-一般数値置換',
        diff: `${correct}${unit} → ${numStr}${unit}`,
      });
    }
  }

  return distractors.slice(0, 3);
}

// ============================================================
// 戦略 5: yearRules - 年代置換
// ============================================================
function shiftWareki(year) {
  if (year >= 2019) return `令和${year - 2018}年`;
  if (year >= 1989) return `平成${year - 1988}年`;
  if (year >= 1926) return `昭和${year - 1925}年`;
  if (year >= 1912) return `大正${year - 1911}年`;
  if (year >= 1868) return `明治${year - 1867}年`;
  return null;
}

function tryYear(value) {
  const yrMatch = value.match(/(\d{3,4})\s*(?:[（(](?:平成|昭和|令和|大正|明治|天保|寛永|貞観)\s*\d+\s*年?[)）])?\s*年/);
  if (!yrMatch) return [];
  const correct = parseInt(yrMatch[1]);
  // 教本登場の年から近接値を選択
  const events = RULES.yearRules.events
    .map(e => e.year)
    .filter(y => y !== correct && Math.abs(y - correct) <= 50)
    .sort((a, b) => Math.abs(a - correct) - Math.abs(b - correct));
  let cands = events.slice(0, 5);
  // 不足する場合は人工生成（前後5/15/30年）
  if (cands.length < 3) {
    for (const off of [-30, -15, -5, 5, 15, 30]) {
      const y = correct + off;
      if (y > 700 && y < 2050 && !cands.includes(y) && y !== correct) cands.push(y);
    }
  }
  cands = cands.slice(0, 3);
  const distractors = [];
  for (const cand of cands) {
    const wareki = shiftWareki(cand);
    let mutated = value.replace(yrMatch[0], `${cand}年`);
    const warekiRe = /[（(]\s*(?:平成|昭和|令和|大正|明治|天保|寛永|貞観)\s*\d+\s*年?\s*[)）]/g;
    if (warekiRe.test(mutated) && wareki) {
      mutated = mutated.replace(warekiRe, `（${wareki}）`);
    }
    distractors.push({
      text: mutated,
      strategy: 'year-年代置換',
      diff: `${correct}年 → ${cand}年`,
    });
  }
  return distractors;
}

// ============================================================
// 戦略 6: sequenceRules - 順序ベース置換
// ============================================================
function trySequence(value) {
  for (const [name, list] of Object.entries(RULES.sequenceRules)) {
    if (name.startsWith('_') || !Array.isArray(list)) continue;
    const found = list.find(item => value.includes(item));
    if (found) {
      const others = list.filter(item => item !== found && value.indexOf(item) === -1);
      const distractors = others.slice(0, 3).map(other => ({
        text: value.replace(found, other),
        strategy: `sequence-${name}置換`,
        diff: `${found} → ${other}`,
      }));
      if (distractors.length >= 3) return distractors;
      return distractors;
    }
  }
  return [];
}

// ============================================================
// メインAPI
// ============================================================
function generateDistractors(fact, allFacts, _neighborIndex) {
  const value = fact.fact && fact.fact.value;
  if (!value) return [];

  // 優先順位順に試す（具体的→汎用へ）
  const strategies = [
    // === 表ルール（最も具体的） ===
    tryTable_特定名称酒,

    // === 第4弾の追加辞書（最も具体的、優先順位高） ===
    tryEntity_杜氏流派全国,
    tryEntity_県の酒の特徴_形容,
    tryEntity_米の重さ粒数,
    tryEntity_並行複発酵対比,
    tryEntity_麹役割比較,
    tryEntity_灘の歴史,
    tryEntity_歴史的酒推進主体,
    tryEntity_酒造工程冒頭,
    tryEntity_もち米四段,
    tryEntity_酒米県内比率,
    tryEntity_酒造好適米適性,

    // === 第3弾の追加辞書（最も具体的、優先順位高） ===
    tryEntity_県別記述開発品種,
    tryEntity_県の特産酒米県別,
    tryEntity_東北地方の地理,
    tryEntity_宮城酒造年表,
    tryEntity_純米酒要件,
    tryEntity_杜氏起源,
    tryEntity_杜氏要件,
    tryEntity_稲分類完全,
    tryEntity_酒造好適米呼称,
    tryEntity_甘藷焼酎品種詳細,
    tryEntity_泡盛伝統,
    tryEntity_沖縄食材,
    tryEntity_微生物増殖,
    tryEntity_工程上槽用語,
    tryEntity_酒母濾過火入れ,
    tryEntity_詳細科学用語,
    tryEntity_醸造アルコール詳細2,
    tryEntity_酵母種類拡張,
    tryEntity_酒造工程完全,
    tryEntity_酒造り技術,
    tryEntity_焼酎麦原料系,
    tryEntity_焼酎主産県,
    tryEntity_酒器詳細拡張,
    tryEntity_酒類定義系,
    tryEntity_県別気候詳細,
    tryEntity_地形地理単位,

    // === 新規追加辞書（最も具体的、優先順位高） ===
    tryEntity_米の部位,
    tryEntity_発酵タイプ詳細,
    tryEntity_水質pH分類,
    tryEntity_食材魚介類,
    tryEntity_食材肉類,
    tryEntity_食材野菜果物,
    tryEntity_料理西洋,
    tryEntity_料理和食,
    tryEntity_時代区分細分,
    tryEntity_造り方の対比語,
    tryEntity_都道府県気候,
    tryEntity_農業用語,
    tryEntity_杜氏組織役職,
    tryEntity_酒造好適米特徴,
    tryEntity_原料処理工程,
    tryEntity_外観評価,
    tryEntity_香り評価第一段階,
    tryEntity_味わい成分,
    tryEntity_酒蔵関連道具,
    tryEntity_焼酎詳細,
    tryEntity_酒類カテゴリー,
    tryEntity_温度帯詳細,
    tryEntity_酒種特徴完全,
    tryEntity_酒蔵の規模,

    // === 拡張用途特化（fallback解消用、最も具体的） ===
    tryEntity_特定名称酒分類数,
    tryEntity_生酒注意事項,
    tryEntity_樽酒表示詳細,
    tryEntity_宮水ミネラル詳細,
    tryEntity_物質状態,
    tryEntity_蒸米デンプン詳細,
    tryEntity_GI要件詳細,
    tryEntity_樽酒表示,
    tryEntity_もろみ定義,
    tryEntity_米だけの酒,
    tryEntity_醸造アルコール詳細,
    tryEntity_産地品種銘柄,
    tryEntity_公示権限者,
    tryEntity_泡盛特徴,
    tryEntity_甘藷焼酎特殊,
    tryEntity_焼酎甲乙混和詳細,
    tryEntity_焼酎麹原料,
    tryEntity_本格焼酎要件,
    tryEntity_焼酎ペアリング詳細,
    tryEntity_総ハゼ突きハゼ,
    tryEntity_吟醸酒用語起源,
    tryEntity_もち米使用理由,
    tryEntity_心白発現率計算,
    tryEntity_稲の特性,
    tryEntity_登熟期影響,
    tryEntity_宮水ミネラル,
    tryEntity_蒸米使用比率,
    tryEntity_麹の役割,
    tryEntity_麹意義,
    tryEntity_蒸米デンプン構造,
    tryEntity_並行複式発酵特徴,
    tryEntity_限定吸水,
    tryEntity_麹を枯らす効果,
    tryEntity_麹の状態評価,
    tryEntity_麹の温度保持,
    tryEntity_蔵つき酵母,
    tryEntity_花酵母,
    tryEntity_酵母種_詳細,
    tryEntity_清酒酵母_物理,
    tryEntity_杜氏定義,
    tryEntity_純米系分類,
    tryEntity_テイスティング姿勢,
    tryEntity_個人差ある表現,
    tryEntity_搾りたて熟成効果,
    tryEntity_ボーメ管理,
    tryEntity_比重単位,
    tryEntity_酒造工程複雑性,

    // === 既存用途特化エンティティ ===
    tryEntity_pH値,
    tryEntity_蒸米物性,
    tryEntity_麹菌3種,
    tryEntity_麹菌酵素,
    tryEntity_麹型,
    tryEntity_製麹工程,
    tryEntity_発酵タイプ,
    tryEntity_米成分,
    tryEntity_水成分,
    tryEntity_稲分類,
    tryEntity_心白,
    tryEntity_メイラード,
    tryEntity_色調,
    tryEntity_外観器具,
    tryEntity_香り表現,
    tryEntity_飲む温度,
    tryEntity_酒器名称,
    tryEntity_ペアリング目的,
    tryEntity_甘藷品種,
    tryEntity_焼酎油臭,
    tryEntity_焼酎ペアリング,
    tryEntity_歴史的製法,
    tryEntity_歴史文献,
    tryEntity_歴史機関,
    tryEntity_神社寺院,
    tryEntity_歴史人物,
    tryEntity_時代,

    // === 既存の固有名詞置換 ===
    tryEntity_麹菌,
    tryEntity_米品種,
    tryEntity_都道府県,
    tryEntity_杜氏,
    tryEntity_酵母,
    tryEntity_酒母,
    tryEntity_焼酎,
    tryEntity_級別,
    tryEntity_鑑評会,
    tryEntity_蒸留方式,
    tryEntity_工程動作,

    // === 汎用変異 ===
    tryAntonym,
    tryNumeric,
    tryYear,
    trySequence,
  ];

  // D-15: 同一戦略のみ採用するため、最初に成功した戦略から3つ採るまで他を呼ばない
  // ただし、3つ採れなかった場合は次戦略から補充（その時もベース長との差を制限）
  const all = [];
  const seen = new Set([normalize(value)]);
  let firstStrategyName = null;
  let baseDiffLen = null; // 最初に得た差分の長さ（D-15: 長さ比のチェック用）

  for (const strat of strategies) {
    const out = strat(value);
    for (const c of out) {
      if (!c.text || c.text === value) continue;
      const k = normalize(c.text);
      if (seen.has(k)) continue;

      // D-15: 同一戦略 + 差分長の同軸チェック
      // 候補の text 長と value 長の差を測る
      const diffLen = Math.abs(c.text.length - value.length);
      if (firstStrategyName === null) {
        firstStrategyName = c.strategy;
        baseDiffLen = diffLen;
      } else {
        // 既に何か拾っている場合: 差分長が大きく違うものは除外
        if (baseDiffLen !== null) {
          if (baseDiffLen === 0 && diffLen > 5) continue; // 同じ長さの置換が中心なら、長さが大きく変わるものは除外
          if (baseDiffLen > 0 && (diffLen / baseDiffLen > 3 || diffLen / baseDiffLen < 0.33)) continue;
        }
      }

      seen.add(k);
      all.push(c);
    }
    // 3つ揃ったら早期終了（後続戦略で更に増やさない）
    if (all.length >= 3) break;
  }
  return all;
}

function normalize(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

// 旧API互換用（generate_v3.js の呼び出し維持）
function buildNeighborIndex(_facts) {
  return { numbersByUnit: {}, years: [] }; // 辞書ベースに移行したため不要だが互換
}

module.exports = {
  generateDistractors,
  buildNeighborIndex,
  RULES,
};
