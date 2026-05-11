#!/usr/bin/env node
/**
 * 演習問題（v3）生成スクリプト：ファクト駆動
 *
 * 入力: data/v3/facts.json
 * 出力:
 *   data/v3/all_questions_v3.jsonl
 *   data/v3/all_questions_v3.json
 *   data/v3/all_questions_v3.csv
 *   data/v3/coverage_report.md
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateDistractors, buildNeighborIndex } = require('./distractor_engine');

const FACTS = path.resolve(__dirname, '../data/v3/facts.json');
const ELABORATIONS_PATH = path.resolve(__dirname, '../data/v3/elaborations.json');
const OUT_DIR = path.resolve(__dirname, '../data/v3');
const OUT_JSONL = path.join(OUT_DIR, 'all_questions_v3.jsonl');
const OUT_JSON = path.join(OUT_DIR, 'all_questions_v3.json');
const OUT_CSV = path.join(OUT_DIR, 'all_questions_v3.csv');
const OUT_COVERAGE = path.join(OUT_DIR, 'coverage_report.md');

// 解説の追加情報（一歩踏み込んだ知識）
let ELABORATIONS = { elaborations: [] };
try {
  ELABORATIONS = JSON.parse(fs.readFileSync(ELABORATIONS_PATH, 'utf-8'));
} catch (e) {
  // ファイル未存在は許容（解説の補強なしで動作）
}

// ===========================================================================
// 決定的乱数
// ===========================================================================
function seededRand(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  let a = h.readUInt32LE(0);
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleDeterministic(arr, seed) {
  const r = seededRand(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===========================================================================
// ファクト主題のクリーンアップ
// ===========================================================================
function cleanSubject(s) {
  if (!s) return '';
  let v = String(s).trim();
  // 末尾の余計な定型句を除去
  const tails = [
    /として正しいものを選$/, /として正しいものを次から1?つ?選べ$/,
    /として正しいものはどれか$/, /として正しいものを選んで$/,
    /の説明として/, /について正しいものは/, /はどれか$/,
    /は何ですか$/, /は何か$/, /は\?$/, /は？$/,
    /の理由は$/, /として正$/,
    /、?$/, /。$/, /？$/, /\?$/,
    /^.{0,4}$/,  // あまりに短い
  ];
  // 質問文末尾の動詞・助詞パターンを除去
  v = v.replace(/[、,。\s]+$/, '');
  for (const re of [
    /として正しいものを選んでください$/,
    /として正しいものを選べ$/,
    /として正しいものはどれか$/,
    /の説明として正しいものはどれか$/,
    /は何ですか$/,
    /は何か$/,
    /の理由は$/,
    /として正$/,
  ]) v = v.replace(re, '');
  v = v.replace(/[、,。\s]+$/, '');
  if (v.length > 60) v = v.slice(0, 60) + '…';
  return v;
}
function cleanValue(s) {
  if (!s) return '';
  return String(s).trim().replace(/\s+/g, ' ');
}

// 問題文に含める「文脈ヒント」を選ぶ
//  - title が具体的にあればそれを優先（例: 「日本酒の定義、分類」）
//  - title が空なら category（章＋セクション）を使う
//  - 末尾の不要な「、不明」「/ 不明」を除去
function pickTopicHint(fact) {
  const title = (fact.title || '').trim();
  const cat = (fact.category || '').trim();
  let hint = '';
  if (title && title.length >= 3 && !title.includes('不明')) {
    hint = title;
  } else if (cat && cat.length >= 3) {
    // category は「第1章 日本酒の定義、分類」のような形式 → セクション部分を優先
    const secMatch = cat.match(/^第[一二三四五六七八九十0-9０-９]+章\s+(.+)$/);
    hint = secMatch ? secMatch[1] : cat;
  } else {
    hint = '本問';
  }
  // 末尾整形
  hint = hint.replace(/[、,／]?\s*不明.*$/, '').replace(/[、,。．\s]+$/, '').trim();
  if (!hint) hint = '本問';
  return `「${hint}」`;
}

// Q-8: 重複・近似問題の排除
//   問題文 + 正答 で類似度を計算し、閾値超は重複扱い
function ngramSet(s, n = 3) {
  const t = String(s || '').replace(/\s+/g, '');
  if (t.length < n) return new Set([t]);
  const set = new Set();
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
  return set;
}
function jaccardSim(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const x of setA) if (setB.has(x)) common++;
  return common / (setA.size + setB.size - common);
}
function questionPriorityScore(q) {
  // 残す優先度: stem 抽出済み > frame-mutation > value 短め
  let s = 0;
  if (q.stemApplied) s += 100;
  if (q.distractorMethod === 'frame-mutation') s += 50;
  if (q.distractorMethod === 'mixed') s += 30;
  // value 短い方が読みやすい
  s -= Math.min(50, (q.correctAnswerFull || q.correctAnswer || '').length / 4);
  return s;
}
function deduplicateQuestions(questions) {
  const sigs = questions.map((q, idx) => ({
    idx,
    q,
    answerSig: ngramSet((q.correctAnswerFull || q.correctAnswer || ''), 3),
    bodySig: ngramSet(q.questionBody || '', 3),
    score: questionPriorityScore(q),
  }));

  // 章+タイトルでバケット化（O(N^2) 削減）
  const buckets = {};
  sigs.forEach(x => {
    const k = (x.q.category || '') + '|' + (x.q.title || '');
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(x);
  });

  const removed = new Set();
  for (const [bucketKey, items] of Object.entries(buckets)) {
    for (let i = 0; i < items.length; i++) {
      if (removed.has(items[i].idx)) continue;
      for (let j = i + 1; j < items.length; j++) {
        if (removed.has(items[j].idx)) continue;
        const ansSim = jaccardSim(items[i].answerSig, items[j].answerSig);
        const bodySim = jaccardSim(items[i].bodySig, items[j].bodySig);
        // 重複判定（Q-8）:
        //   (a) 正答が極めて高類似（>=0.85）→ 文言のみ違う同一事実
        //   (b) 正答が部分一致(>=0.6)+問題文がほぼ同じ(>=0.9) → 同主題で同方向の問題
        const isDup = (ansSim >= 0.85) || (ansSim >= 0.6 && bodySim >= 0.9);
        if (isDup) {
          const loser = items[i].score >= items[j].score ? j : i;
          removed.add(items[loser].idx);
        }
      }
    }
  }

  return sigs.filter(x => !removed.has(x.idx)).map(x => x.q);
}

// Q-7: 問題品質スコアリング
//   生成された問題の質を評価し、明らかに常識で解ける問題は除外する
function isQualityQuestion(correctValue, choices) {
  if (!choices || choices.length < 4) return false;
  const wrong = choices.filter(c => !c.isCorrect).map(c => c.body);
  const correct = choices.find(c => c.isCorrect)?.body || '';

  // 不自然な造語パターン（誤答に含まれてはいけない）
  const unnaturalCompounds = [
    /玄(?:麦|甘藷|そば|芋)/, /飯(?:麦|甘藷|そば|芋)/, /精(?:麦|甘藷|そば|芋)/,
    /酒(?:麦|甘藷|そば)品種/, /酒(?:麦|甘藷|そば)蔵/, /酒(?:麦|甘藷|そば)こうじ/,
    /(?:麦|甘藷|そば)トレーサビリティ/,
    // 元素・化学名の prefix を残した造語
    /カリウムゴ/, /ナトリウムゴ/, /カルシウムゴ/, /マグネシウムゴ/,
    // 金/銅/錫の混在置換による造語（金額→銅器額/錫器額、金賞→錫器賞/銅器賞 等）
    /(?:錫|銅|銀)器(?:額|賞|数|割合)/, /(?:錫|銅|銀)器(?:漬|焼)/,
    /(?:錫|銅|銀)賞受賞数/, /(?:錫器|銅器|銀器)賞/,
    // 「○○酵母」変形
    /(?:アルコール感|甘味|酸味|苦味|旨味)酵母/,
    /(?:甘味と酸味、苦味|アミノ酸感)酵母/,
    // 「○○の甘味と酸味、苦味」のような味覚と香りの混同
    /(?:リンゴ|バナナ|メロン|ブドウ|柑橘)様の(?:甘味|酸味|苦味|旨味|アルコール感)/,
    /熟成により(?:アルコール感|苦味|甘味と酸味、苦味)を含/,
    // 容器・温度の混同（液体種類と非液体）
    /(?:粒状|固形|粉末|気体|結晶状)を(?:燗|冷酒|常温)で味わう/,
    // 「単位+性」
    /[%％‰g個本]性/,
    // 数値+性 / 単位+酒類
    /[%％‰]の(?:純米酒|大吟醸|本醸造)/,
    // 時代錯誤: 古代に近代的概念
    /(?:弥生時代|奈良時代|平安時代|鎌倉時代|室町時代)に(?:本格的な酒屋|級別制度|地理的表示|GI制度)/,
    // 「若々しい酸性の性質」「華やかな酸性」など味わいと化学性質の混同
    /(?:若々しい|華やかな|爽やかな|ふくよかな|豊かな)酸性の性質/,
    // 物理的にあり得ない数値: %が100超
    /(?:精米歩合|アルコール).{0,5}1[0-9]{2}\.\d%/, /精米歩合\s*1[0-9]{2}%/,
  ];
  let unnaturalCount = 0;
  let unnaturalDetails = [];
  for (const w of wrong) {
    for (const re of unnaturalCompounds) {
      if (re.test(w)) {
        unnaturalCount++;
        unnaturalDetails.push({ choice: w, pattern: re.toString() });
        break;
      }
    }
  }
  // 1つでも不自然な造語があれば除外
  if (unnaturalCount >= 1) return false;

  // 4選択肢の文字種が大きく違う（明らかな1つだけ正解の常識問題）
  const lengths = choices.map(c => (c.body || '').length);
  const maxLen = Math.max(...lengths);
  const minLen = Math.min(...lengths);
  if (minLen > 0 && maxLen / minLen > 8) return false;

  // 4選択肢に重複（同じ文）があれば除外
  const bodySet = new Set(choices.map(c => normalizeText(c.body || '')));
  if (bodySet.size < 4) return false;

  return true;
}

// Q-6: 自明問題のパターン（教本知識を問わず常識で解ける）
const TRIVIAL_PATTERNS = [
  // 主体名と原料の自明な結びつき
  { regex: /日本酒(?:は|の主?原料は|を構成する|の)?[^。]*?米/, reason: '日本酒の原料=米 は定義的に自明' },
  { regex: /ワイン(?:は|の主?原料は|を構成する|の)?[^。]*?ぶどう|ワイン.*?ブドウ/, reason: 'ワインの原料=ブドウ は定義的に自明' },
  { regex: /ビール(?:は|の主?原料は)?[^。]*?麦芽/, reason: 'ビールの原料=麦芽 は定義的に自明' },
  // 米を主原料 / ぶどうを主原料
  { regex: /日本酒.*?(?:を主原料|を原料とする|を使用する)/, reason: '日本酒の原料は米と定義的に自明' },
];

// Q-10: 酒ディプロマ試験文脈で『清酒/日本酒/もろみ』が一択になる問題を検出
//   正答が日本酒主題で、誤答に他の酒税法品目が混入している場合は試験前提から自明
const SAKE_SUBJECT_KEYWORDS = ['日本酒', '清酒', 'もろみ'];
const FOREIGN_LIQUOR_KEYWORDS = [
  'ウイスキー', 'ウィスキー', '果実酒', '発泡酒', 'ブランデー',
  'リキュール', 'みりん', 'ジン', 'ウォッカ', 'シードル',
  '原料用アルコール', '雑酒', '甘味果実酒', 'スピリッツ',
  'ワイン', 'ビール', '焼酎', '泡盛',
];
function isExamTriviallyDecidable(correctText, distractorTexts) {
  const correctHasSake = SAKE_SUBJECT_KEYWORDS.some(k => correctText.includes(k));
  if (!correctHasSake) return false;
  // 誤答のうち1つでも他の酒税法品目を含んでいれば、酒ディプロマ前提で正答が一択
  for (const d of distractorTexts) {
    if (!d) continue;
    if (SAKE_SUBJECT_KEYWORDS.some(k => d.includes(k))) continue; // 同一主題の誤答はOK
    if (FOREIGN_LIQUOR_KEYWORDS.some(k => d.includes(k))) return true;
  }
  return false;
}

function isTrivialFact(value) {
  for (const p of TRIVIAL_PATTERNS) {
    if (p.regex.test(value)) {
      // ただし、「米焼酎」「米麹」のような複合語が原因のときは除外しない
      // value 内の「米」が単純な原料指示かを判定: 「米焼酎」「米こうじ」を含めば false
      if (/米[こ酒|焼酎|麹]/.test(value)) continue;
      // 自明と判定
      return { trivial: true, reason: p.reason };
    }
  }
  return { trivial: false };
}

// ファクトの品質チェック（value 中心。subject は廃止済み）
function isQualityFact(f, value) {
  // value に変な文字（中点だけ、句読点だけ）が含まれる
  if (/^[、。・,\.\s]+$/.test(value)) return false;
  // value が極端に短い
  if (value.length < 8) return false;
  // value が文章途中の切れ端（「、で〜」「、原料〜」）
  if (/^[、，,。．]/.test(value)) return false;
  // value が体言止めや句点で終わる完結文に限る
  if (/[、，,]$/.test(value)) return false;
  if (/(?:しかし|または|あるいは|ただし|なお|さらに)$/.test(value)) return false;
  // 図表キャプション・出典フラグメント混入は除外（OCR で本文と混ざるケース）
  if (/より作図|より引用|より作成|出典[:：]|\([12][0-9]{3}\)より|図[0-9０-９]+[：:　]?[ぁ-ヶ一-鿿]|表[0-9０-９]+[：:　]?[ぁ-ヶ一-鿿]/.test(value)) return false;
  // Q-6: 自明問題（常識で解ける）は除外
  const trivial = isTrivialFact(value);
  if (trivial.trivial) return false;
  return true;
}

// ===========================================================================
// 変異の「変更範囲」計算（Q-5/Q-12: 同じ箇所だけ違う選択肢を優先するため）
// ===========================================================================
//   original と mutated の最長共通前置・後置から、変更された範囲 [start, end) を求める。
//   start = end の場合（差が無い）は { start: 0, end: 0 } を返す。
function changeRegion(original, mutated) {
  if (original === mutated) return { start: 0, end: 0 };
  const oLen = original.length, mLen = mutated.length;
  const minL = Math.min(oLen, mLen);
  let p = 0;
  while (p < minL && original[p] === mutated[p]) p++;
  let s = 0;
  while (s < minL - p && original[oLen - 1 - s] === mutated[mLen - 1 - s]) s++;
  return { start: p, end: oLen - s };
}
function regionsOverlap(a, b) {
  // 点（start===end）同士は「同じ位置」を同一視するため、点は幅1とみなす
  const aStart = a.start, aEnd = Math.max(a.end, a.start + 1);
  const bStart = b.start, bEnd = Math.max(b.end, b.start + 1);
  return aStart < bEnd && bStart < aEnd;
}

// ===========================================================================
// Q-11: 問題文テンプレート（多様化）
// ===========================================================================
// 設計：
//   STEM_ENDINGS : クローズ問題の終端句（fact.type別、4-6種類）
//   GENERAL_*    : 完全文比較問題の汎用テンプレ（fact.type別、4-6種類）
//   TOPIC_*      : 文脈特化テンプレ（米品種/GI/料理相性/杜氏/酵母/都道府県）
//
// プレースホルダ：
//   {title}  : fact.title（レッスン名）
//   {topic}  : 検出された具体トピック（"雄町", "灘五郷", "南部杜氏" 等）
//   {cloze}  : STEM のクローズ文（"...の○○である。"）
const STEM_ENDINGS = {
  year: [
    '○○ に入る年代として正しいものはどれか。',
    '○○ に当てはまる年代を次の中から1つ選んでください。',
    '次の中から○○ に入る年代として正しいものを1つ選んでください。',
    '○○ に入る年（または年月）として最も適切なものを次から選択してください。',
  ],
  number: [
    '○○ に入る数値として正しいものはどれか。',
    '○○ に当てはまる数値を次の中から1つ選んでください。',
    '次の中から○○ に入る数値として正しいものを1つ選んでください。',
    '○○ に入る値として最も適切なものを次から選択してください。',
  ],
  person: [
    '○○ に入る人物として正しいものはどれか。',
    '○○ に当てはまる人物を次の中から1つ選んでください。',
    '次の中から○○ に入る人物として正しいものを1つ選んでください。',
  ],
  place: [
    '○○ に入る地域・産地として正しいものはどれか。',
    '○○ に当てはまる地域を次の中から1つ選んでください。',
    '次の中から○○ に入る地域・産地として正しいものを1つ選んでください。',
  ],
  name: [
    '○○ に入る名称として正しいものはどれか。',
    '○○ に当てはまる名称を次の中から1つ選んでください。',
    '次の中から○○ に入る名称として正しいものを1つ選んでください。',
  ],
  term: [
    '○○ に入る語句として正しいものはどれか。',
    '○○ に当てはまる語句を次の中から1つ選んでください。',
    '次の中から○○ に入る適切な語句を1つ選んでください。',
    '○○ に入る適切な語句を次から選択してください。',
  ],
};

const GENERAL_TEMPLATES = {
  year: [
    '「{title}」に関する年代として正しいものを次から選んでください。',
    '次の中から「{title}」の年代として正しいものを1つ選んでください。',
    '「{title}」が起こった年として最も適切なものを次から選択してください。',
    '次の中から「{title}」に関する年代を選んでください。',
  ],
  number: [
    '「{title}」に関する数値として正しいものを次から選んでください。',
    '次の中から「{title}」の値として最も適切なものを1つ選んでください。',
    '次の中から「{title}」に該当する数値を選択してください。',
  ],
  person: [
    '「{title}」に関わった人物として正しいものを次から選んでください。',
    '次の中から「{title}」に該当する人物を1つ選んでください。',
    '次の中から「{title}」に関わった人物として正しいものを選択してください。',
  ],
  place: [
    '「{title}」に該当する地域・産地として正しいものを次から選んでください。',
    '次の中から「{title}」に関連する地域を1つ選んでください。',
    '次の中から「{title}」に該当する産地を選択してください。',
  ],
  name: [
    '「{title}」に該当する名称として正しいものを次から選んでください。',
    '次の中から「{title}」に該当する名称を1つ選んでください。',
  ],
  term: [
    '「{title}」に関する記述として正しいものを次から選んでください。',
    '次の中から「{title}」について正しい記述を1つ選んでください。',
    '次の中から「{title}」に該当する内容として最もふさわしいものを1つ選んでください。',
    '次の中から「{title}」について正しい説明を選択してください。',
    '「{title}」について最も適切な説明を次から選んでください。',
  ],
};

// 文脈特化テンプレート（topic 検出時に優先）
const TOPIC_TEMPLATES = {
  rice_variety: [
    '次の中から「{topic}」の特徴として最もふさわしいものを選択してください。',
    '次の中から米の品種「{topic}」について正しい記述を1つ選んでください。',
    '「{topic}」に関する記述として正しいものを次の中から選んでください。',
    '次の中から酒造好適米「{topic}」の特徴を1つ選んでください。',
  ],
  rice_variety_crossbreed: [
    '次の中から米の品種「{topic}」の交配（親品種）として正しいものを選択してください。',
    '次の中から「{topic}」の交配親として正しいものを1つ選んでください。',
    '「{topic}」の交配について次の中から正しいものを選択してください。',
  ],
  rice_variety_origin: [
    '次の中から米の品種「{topic}」が誕生した年を選択してください。',
    '次の中から「{topic}」の発祥地として正しいものを1つ選んでください。',
  ],
  prefecture: [
    '次の中から「{topic}」の日本酒の特徴として最もふさわしいものを1つ選んでください。',
    '次の中から「{topic}」の酒造りに関する記述として正しいものを選択してください。',
    '次の中から「{topic}」産の日本酒について正しい記述を1つ選んでください。',
  ],
  gi: [
    '次の中から地理的表示「{topic}」について正しい記述を選択してください。',
    '次の中から「{topic}」が地理的表示として指定された年月を選択してください。',
    '次の中から地理的表示「{topic}」の要件として正しいものを1つ選んでください。',
  ],
  pairing: [
    '次の中から「{topic}」と最も相性がよいと思われる日本酒のタイプを1つ選んでください。',
    '次の中から「{topic}」に合う日本酒として最も適切なものを1つ選んでください。',
    '次の中から「{topic}」と日本酒の組み合わせとして正しいものを1つ選んでください。',
  ],
  pairing_general: [
    '次の中から日本酒と料理の相性に関する記述として正しいものを1つ選んでください。',
    '次の中から料理と日本酒のペアリングについて正しい説明を選択してください。',
  ],
  toji_school: [
    '次の中から「{topic}」について正しい記述を1つ選んでください。',
    '「{topic}」の特徴として最もふさわしいものを次から選んでください。',
    '次の中から「{topic}」の活躍地として正しいものを1つ選んでください。',
  ],
  yeast: [
    '次の中から「{topic}」の特徴として正しいものを1つ選んでください。',
    '次の中から協会酵母「{topic}」に関する記述として正しいものを選択してください。',
    '「{topic}」について最も適切な説明を次から選んでください。',
  ],
  specific_meisho: [
    '次の中から特定名称酒「{topic}」の規定として正しいものを1つ選んでください。',
    '次の中から「{topic}」の要件として最もふさわしいものを選択してください。',
  ],
  temperature: [
    '次の中から日本酒の温度区分「{topic}」について正しい記述を1つ選んでください。',
    '次の中から「{topic}」（飲用温度）として正しい温度を選択してください。',
  ],
  shochu_type: [
    '次の中から焼酎「{topic}」について正しい記述を1つ選んでください。',
    '次の中から「{topic}」の特徴として最もふさわしいものを選択してください。',
  ],
};

// value から topic を検出（最初にヒットしたもの一つを返す）
const RICE_VARIETIES = [
  '山田錦', '五百万石', '美山錦', '雄町', '愛山', '八反錦2号', '八反錦', '秋田酒こまち',
  '出羽燦々', '越淡麗', '玉栄', '彗星', '吟風', 'きたしずく', '短稈渡船', '山田穂',
  '千本錦', '楽風舞', '華吹雪', '華想い', '華さやか', '百万石乃白', '酒未来',
  '改良信交', '改良八反流', 'たかね錦', '金紋錦', '北錦', 'ひだほまれ',
  'ササシグレ', 'フクノハナ', 'ひとごこち', 'たまさかえ', '若水', '夢山水', 'こいおまち',
];
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府',
  '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
const TOJI_SCHOOLS = ['南部杜氏', '越後杜氏', '丹波杜氏', '能登杜氏', '但馬杜氏', '出雲杜氏', '備中杜氏', '三津杜氏', '津軽杜氏', '山内杜氏'];
const FOOD_NAMES = [
  // 和食料理ジャンル
  '刺身', 'お造り', '寿司', '寿し', 'すし', '天ぷら', 'すき焼き', 'しゃぶしゃぶ',
  '焼鳥', '焼き鳥', 'なます', '酢の物', '煮物', '焼魚', '焼き魚', '焼き物',
  '揚げ物', '蒸し物', '鍋', '鍋料理', 'おでん', '湯豆腐', '茶碗蒸し', '卵焼き',
  '和食', '前菜', '出汁', '味噌汁', 'お吸い物', '漬物', '納豆', '蕎麦', 'うどん',
  '丼', 'とんかつ', '牛丼', '親子丼', '冷奴', '冷ややっこ',
  // 魚介類
  'マグロ大トロ', 'マグロ', 'カツオ', 'ブリ', 'ヒラメ', 'マダイ', 'タイ', 'サバ',
  'イワシ', 'サワラ', 'アマダイ', 'アナゴ', 'ホッキ', 'スズキ', 'サーモン',
  'うなぎ', '鰻', 'うに', 'ウニ', 'タコ', 'イカ', 'イセエビ', 'エビ', '海老',
  'ホタテ', 'カニ', 'サザエ', 'アワビ', '貝',
  // 肉類
  '鴨', '鶏', '豚', '牛', 'ハム', 'ステーキ', 'ロースト', '生ハム',
  // 西洋料理・海外
  'チーズ', 'フォアグラ', 'フォワグラ', 'キャビア', 'パテ', 'スモークサーモン',
  'カルパッチョ', 'カレー', 'パスタ', 'ピザ', 'リゾット', 'グラタン', 'カツレツ',
  '餃子', 'ラーメン', 'エスカルゴ', 'ジャンボン', '中華', 'フレンチ', '韓国料理',
  // 調理ベース
  'ポン酢', '塩レモン', 'クリームソース', 'ワサビ',
];
const SPECIFIC_MEISHO = [
  '純米大吟醸酒', '大吟醸酒', '純米吟醸酒', '吟醸酒',
  '特別純米酒', '純米酒', '特別本醸造酒', '本醸造酒',
];
const TEMPERATURE_NAMES = [
  '雪冷え', '花冷え', '涼冷え', '冷や', '日向燗', '人肌燗', 'ぬる燗', '上燗', '熱燗', '飛び切り燗',
];

function detectTopic(fact, value) {
  // 1. 米品種（最優先・最長一致）
  const riceSort = RICE_VARIETIES.slice().sort((a, b) => b.length - a.length);
  for (const name of riceSort) {
    if (value.includes(name)) {
      if (/(?:交配|親品種|配合|×|を交配)/.test(value)) {
        return { type: 'rice_variety_crossbreed', topic: name };
      }
      if (/(?:誕生|命名された|発祥|起源|品種登録|年に開発)/.test(value)) {
        return { type: 'rice_variety_origin', topic: name };
      }
      return { type: 'rice_variety', topic: name };
    }
  }

  // 2. 地理的表示
  const giMatch = value.match(/地理的表示「([^」]+)」/) || value.match(/地理的表示\s*(灘五郷|伏見|山形|萩|はりま|白山|日本酒)/);
  if (giMatch) {
    return { type: 'gi', topic: giMatch[1] };
  }

  // 3. 杜氏流派
  const tojiSort = TOJI_SCHOOLS.slice().sort((a, b) => b.length - a.length);
  for (const name of tojiSort) {
    if (value.includes(name)) return { type: 'toji_school', topic: name };
  }

  // 4. 協会酵母
  const yeastMatch = value.match(/協会\s*(\d+)\s*号|きょうかい\s*(\d+)\s*号|\b(\d+)\s*号酵母/);
  if (yeastMatch) {
    const num = yeastMatch[1] || yeastMatch[2] || yeastMatch[3];
    return { type: 'yeast', topic: `協会${num}号` };
  }

  // 5. 特定名称酒
  for (const name of SPECIFIC_MEISHO) {
    if (value.includes(`「${name}」`) || value.includes(`特定名称酒${name}`)) {
      return { type: 'specific_meisho', topic: name };
    }
  }

  // 6. 温度区分
  for (const name of TEMPERATURE_NAMES) {
    if (value.includes(`「${name}」`) || value.includes(`${name}（`)) {
      return { type: 'temperature', topic: name };
    }
  }

  // 7. 料理ペアリング（カテゴリで判定 + value から食材検出）
  const isPairing = /料理の相性/.test(fact.category || '') || /料理の相性/.test(fact.title || '');
  if (isPairing) {
    const foodSort = FOOD_NAMES.slice().sort((a, b) => b.length - a.length);
    for (const f of foodSort) {
      if (value.includes(f)) return { type: 'pairing', topic: f };
    }
    return { type: 'pairing_general', topic: '' };
  }

  // 8. 都道府県（第3章のみ）
  if (/第3章/.test(fact.category || '')) {
    const prefSort = PREFECTURES.slice().sort((a, b) => b.length - a.length);
    for (const name of prefSort) {
      if (value.includes(name)) {
        return { type: 'prefecture', topic: name.replace(/[県府都道]$/, '') };
      }
    }
  }

  return null;
}

function fillTemplate(tpl, replacements) {
  let out = tpl;
  for (const [k, v] of Object.entries(replacements)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

// Q-11: 完全文比較問題の body を多様化
function pickGeneralBody(fact, value, r) {
  const topic = detectTopic(fact, value);
  if (topic && TOPIC_TEMPLATES[topic.type]) {
    const tpl = pickFromR(r, TOPIC_TEMPLATES[topic.type]);
    return fillTemplate(tpl, { topic: topic.topic, title: fact.title || '' });
  }
  const type = fact.fact.type || 'term';
  const templates = GENERAL_TEMPLATES[type] || GENERAL_TEMPLATES.term;
  const tpl = pickFromR(r, templates);
  return fillTemplate(tpl, { title: fact.title || '' });
}

// Q-11: STEM 問題の終端句を多様化
function pickStemEnding(fact, value, factType, r) {
  // topic 検出によって終端句に「topic」情報を含めることもできるが、
  // STEM では既に値が文の中に出ているので、まずは終端句のバリエーションだけ。
  const arr = STEM_ENDINGS[factType] || STEM_ENDINGS.term;
  return pickFromR(r, arr);
}

// ===========================================================================
// ファクトを問題化（タイプ別テンプレ）
// ===========================================================================
function buildQuestion(fact, idx, valueToFact, neighborIndex, allFacts, fallbackMap) {
  const f = fact.fact;
  const value = cleanValue(f.value);
  if (!value || value.length < 1) return null;
  if (value.length > 200) return null;
  // ★ 品質フィルタ ★
  if (!isQualityFact(f, value)) return null;

  // 問題文の文脈ヒント（ページタイトル → セクション → カテゴリ）
  // 教本のどこの話かを明示する
  const topicHint = pickTopicHint(fact);

  // 問題文テンプレ（Q-11: 多様化）
  //   - topic 検出（米品種/GI/料理相性/杜氏/酵母/都道府県等）で文脈特化テンプレを優先
  //   - 該当なしならファクトタイプ別の汎用テンプレ（3-5種類）から seeded random で選択
  const seed = fact.id + ':' + idx;
  const r = seededRand(seed + ':qtmpl');
  let body = pickGeneralBody(fact, value, r);

  // ★★ 同フレーム不正答生成 (D-1〜D-9) ★★
  // まず変異エンジンで「正答と同じ文型・核心点だけ違う」候補を全部生成
  // 合成された誤答（教本に存在しない）は isSynthesized=true で区別
  const valNorm = normalizeText(value);
  const seen = new Set([valNorm]);
  // 全候補を収集（最初の3つで止めず、同じ箇所だけ変える3つを優先選択するため）
  let allCandidates = [];
  if (neighborIndex && allFacts) {
    const muts = generateDistractors(fact, allFacts, neighborIndex);
    for (const m of muts) {
      if (!m.text || m.text.length < 1 || m.text.length > 250) continue;
      const n = normalizeText(m.text);
      if (seen.has(n)) continue;
      seen.add(n);
      allCandidates.push({
        text: m.text, strategy: m.strategy, diff: m.diff, isSynthesized: true,
        region: changeRegion(value, m.text),
      });
    }
  }

  // Q-9: 合成誤答3つで揃わない問題は生成しない（真事実誤答の流用禁止）
  if (allCandidates.length < 3) return null;

  // Q-5/Q-12 強化：選択肢を短くするため「value の同じ範囲を変える候補」を優先。
  //   変更範囲が重なる候補をグループ化し、3つ以上揃うグループのうち
  //   変更範囲が最も狭い（=選択肢が最も短くなる）ものを採用する。
  //   3つ揃うグループが無ければ従来通り先頭3つ（変異エンジンの優先順）を使う。
  let mutationCandidates;
  {
    const groups = [];
    for (const c of allCandidates) {
      let placed = false;
      for (const g of groups) {
        if (g.some(x => regionsOverlap(x.region, c.region))) { g.push(c); placed = true; break; }
      }
      if (!placed) groups.push([c]);
    }
    const widthOf = g => Math.max(...g.map(x => Math.max(1, x.region.end - x.region.start)));
    const validGroups = groups.filter(g => g.length >= 3).sort((a, b) => widthOf(a) - widthOf(b));
    if (validGroups.length > 0) {
      mutationCandidates = validGroups[0];
    } else {
      mutationCandidates = allCandidates.slice(0, 3);
    }
  }

  // 同フレーム変異3つを採用（すべて合成誤答）
  const pickedObjs = shuffleDeterministic(mutationCandidates, seed + ':d').slice(0, 3);

  // Q-10: 酒ディプロマ試験文脈で正答が一択になる問題は破棄
  //   正答が清酒/日本酒/もろみを含み、誤答に他酒類が混入している場合
  if (isExamTriviallyDecidable(value, pickedObjs.map(o => o.text))) return null;
  const distractorMethod = 'frame-mutation';
  const picked = pickedObjs.map(o => o.text);

  // 各選択肢の解説情報を構築（E-1, E-2, E-5, E-9）
  const correctReason = buildCorrectReason(fact);
  const wrongInfo = (obj) => {
    const r = buildWrongReason(obj.text, fact, valueToFact, obj);
    return { reason: r.text, reasonTag: r.tag, isSynthesized: obj.isSynthesized, diff: obj.diff };
  };

  const choices = shuffleDeterministic([
    { body: value, isCorrect: true, reason: correctReason, reasonTag: '正答' },
    { body: pickedObjs[0].text, isCorrect: false, ...wrongInfo(pickedObjs[0]) },
    { body: pickedObjs[1].text, isCorrect: false, ...wrongInfo(pickedObjs[1]) },
    { body: pickedObjs[2].text, isCorrect: false, ...wrongInfo(pickedObjs[2]) },
  ], seed + ':order');

  // L-8: 選択肢の不自然スペース除去
  for (const c of choices) {
    if (c.body) c.body = cleanWS(c.body);
    if (c.fullBody) c.fullBody = cleanWS(c.fullBody);
  }

  // Q-7: 問題品質スコアリング
  //   選択肢のうち1つだけが文法的・常識的に自然で、残り3つが造語・誤った文脈なら品質低
  //   そういう問題は学習効果がないため生成しない
  if (!isQualityQuestion(value, choices)) return null;

  // Q-5: 共通部分抽出による選択肢短縮
  let stemApplied = false;
  let finalBody = body;
  const stem = extractCommonStem(choices, value);
  if (stem) {
    finalBody = buildStemmedQuestionBody(body, stem.prefix, stem.suffix, f.type, fact);
    // 各選択肢の body を差分部分のみに短縮（fullBody は保持）
    choices.forEach((c, i) => {
      c.fullBody = c.body;       // 元の完全な文を保持（解説などで使用）
      c.body = stem.differents[i]; // 表示用は差分のみ
    });
    stemApplied = true;

    // Q-5 後処理：各選択肢の reason を「表示される短い差分」に合わせて再生成
    //   E-1: 受験者が選択肢の文字列と理由文のキーワードを照合できるよう揃える
    const correctC = choices.find(c => c.isCorrect);
    const correctVisible = correctC ? correctC.body : '';
    // 正解の根拠は value（教本由来の整形済み事実文）を直接示す
    const correctReasonText = buildCorrectReason(fact);
    choices.forEach(c => {
      if (c.isCorrect) {
        c.reason = correctReasonText;
        return;
      }
      const wrongVisible = c.body;
      let txt = `「${wrongVisible}」は誤り。正しくは「${correctVisible}」です。`;
      if (c.reasonTag === '数値違い') txt += ' 数値はうっかり混同しやすいので注意しましょう。';
      else if (c.reasonTag === '年代違い') txt += ' 年代は西暦・和暦をセットで覚えると間違えにくくなります。';
      c.reason = txt;
    });
  }

  // 解説生成（E-3, E-4, E-6, E-7, E-8）— 解説では fullBody を使う
  const explanation = buildExplanation(fact, choices);

  // 難易度引継ぎ
  const difficulty = fact.importance === 3 ? 'HARD' : fact.importance === 1 ? 'EASY' : 'NORMAL';

  return {
    questionId: 'v3-' + fact.id,
    factId: fact.id,
    factType: f.type,
    factSource: fact.source,
    category: fact.category,
    title: fact.title,
    questionBody: cleanWS(finalBody),
    difficulty,
    correctAnswer: cleanWS(stemApplied ? stem.differents[choices.findIndex(c => c.isCorrect)] : value),
    correctAnswerFull: cleanWS(value),
    choices,
    explanation: cleanWS(explanation),
    referencePage: fact.referencePage,
    distractorMethod,
    stemApplied,
  };
}

function pickFromR(r, arr) {
  return arr[Math.floor(r() * arr.length)];
}

// L-8: 不自然なスペース除去（generate_v3 でも同期適用）
function cleanWS(s) {
  if (!s) return s;
  let t = String(s);
  t = t.replace(/([一-鿿々])[ 　]+([ぁ-んァ-ヴー])/g, '$1$2');
  t = t.replace(/([ぁ-ん])[ 　]+([ぁ-ん])/g, '$1$2');
  t = t.replace(/([ァ-ヴー])[ 　]+([ぁ-ん])/g, '$1$2');
  t = t.replace(/([ぁ-ん])[ 　]+([一-鿿々])/g, '$1$2');
  t = t.replace(/([一-鿿々])[ 　]+([一-鿿々])/g, '$1$2');
  t = t.replace(/[ 　]+([、。，．])/g, '$1');
  t = t.replace(/([「『（(])[ 　]+/g, '$1');
  t = t.replace(/[ 　]+([」』）)])/g, '$1');
  t = t.replace(/[ 　]{2,}/g, ' ');
  return t.trim();
}

// Q-5: 4選択肢の共通部分を抽出して、問題文に組み込み・選択肢を差分のみに短縮
//   入力: 4 choices （正答を含む）
//   出力: { applied, prefix, suffix, differents } または null（適用不可）

// 文字種カテゴリの判定（Q-5 / D-15）
function classifyCharType(s) {
  if (!s) return 'empty';
  const t = s.trim();
  if (/^[\d\s\.\-,]+$/.test(t)) return 'number';
  if (/^[\d\s\.\-,]+\s*(?:%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m|分|時間|日|年|個|本)\s*$/.test(t)) return 'numberWithUnit';
  if (/^[%％kl\s\.\-]+$|^(?:%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m|個|‰|本)$/.test(t)) return 'unitOnly';
  if (/^[一-鿿々]+$/.test(t)) return 'kanji';
  if (/^[ぁ-ん]+$/.test(t)) return 'hiragana';
  if (/^[ァ-ヴー]+$/.test(t)) return 'katakana';
  if (/^[一-鿿ぁ-ん]+$/.test(t)) return 'kanjiHiragana';
  if (/^[一-鿿ァ-ヴー]+$/.test(t)) return 'kanjiKatakana';
  if (/年$/.test(t) && /\d/.test(t)) return 'year';
  if (/[県府都道市]$/.test(t)) return 'place';
  return 'mixed';
}

// D-13: 接尾辞文脈との文法整合性チェック
//   差分の直後の文脈（suffix の先頭）を見て、その差分が文法的に成立するか
function isGrammaticallyValid(diff, suffix) {
  if (!suffix || suffix.length === 0) return true; // 後置詞なしは無条件OK
  const head = suffix.slice(0, 2);

  // 「○○性」「○○化」「○○的」「○○系」 → 名詞・形容動詞語幹のみ
  if (/^性/.test(head) || /^化/.test(head) || /^的/.test(head) || /^系/.test(head)) {
    // 数値・単位記号・1文字の数字単位はNG
    if (/^[\d%％kg個本‰℃度]+$/.test(diff)) return false;
    if (classifyCharType(diff) === 'unitOnly' || classifyCharType(diff) === 'numberWithUnit') return false;
    return true;
  }

  // 「○○年」「○○世紀」「○○時代」 → 数字 or 時代名のみ
  if (/^年/.test(head) || /^世紀/.test(head) || /^時代/.test(head)) {
    if (!/\d/.test(diff) && !/(?:弥生|奈良|平安|鎌倉|室町|江戸|明治|大正|昭和|平成|令和)/.test(diff)) return false;
    return true;
  }

  // 「○○県」「○○府」「○○都」「○○市」 → 地名語幹のみ
  if (/^[県府都市]/.test(head)) {
    // 数字や単位記号はNG
    if (/^[\d%％]+$/.test(diff)) return false;
    return true;
  }

  return true;
}

// D-14: トピック逸脱チェック
//   差分内に他主題の固有名詞が混入していないか
function isTopicConsistent(diff, allDiffs, originalValue) {
  // 差分が他選択肢と文字種カテゴリが異なる固有名詞を含む場合
  // ここでは簡易：他選択肢の主体と一致しないドメイン語は除外
  // 例: 全部「日本酒」を含むなら、「ビール」「ワイン」「焼酎」を含む差分は除外
  const subjectKeywords = ['日本酒', 'ビール', 'ワイン', '焼酎', '泡盛', '清酒'];
  const inOriginal = subjectKeywords.find(k => originalValue.includes(k));
  if (!inOriginal) return true;
  // 元 value の主体名と異なる主体名を含む差分は除外
  for (const k of subjectKeywords) {
    if (k === inOriginal) continue;
    if (diff.includes(k)) return false;
  }
  return true;
}

function extractCommonStem(choices, originalValue) {
  if (!choices || choices.length < 2) return null;
  const bodies = choices.map(c => c.body || '');
  if (bodies.some(b => !b)) return null;

  // 最長共通前置詞
  let prefix = '';
  const minLen = Math.min(...bodies.map(b => b.length));
  for (let i = 0; i < minLen; i++) {
    const ch = bodies[0][i];
    if (bodies.every(b => b[i] === ch)) prefix += ch;
    else break;
  }

  // 最長共通後置詞（前置詞と重ならない範囲）
  let suffix = '';
  for (let i = 0; i < minLen - prefix.length; i++) {
    const ch = bodies[0][bodies[0].length - 1 - i];
    if (bodies.every(b => b[b.length - 1 - i] === ch)) {
      suffix = ch + suffix;
    } else break;
  }

  // 差分が空になる選択肢がある場合（例：正答「1%」が誤答「15%」のプレフィックスで、
  //   共通prefixが "1" を吸収して正答の差分が空になる）→ prefix を1文字ずつ短くして回避
  while (prefix.length > 0 && bodies.some(b => b.length <= prefix.length + suffix.length)) {
    prefix = prefix.slice(0, -1);
  }
  // それでも空がある場合は suffix も短くする
  while (suffix.length > 0 && bodies.some(b => b.length <= prefix.length + suffix.length)) {
    suffix = suffix.slice(0, -1);
  }

  // 差分部分
  const differents = bodies.map(b => b.slice(prefix.length, b.length - suffix.length));

  // 適用条件チェック
  const avgLen = bodies.reduce((s, b) => s + b.length, 0) / bodies.length;
  const commonLen = prefix.length + suffix.length;
  if (commonLen < avgLen * 0.5) return null;
  if (commonLen < 20) return null;
  const maxDiffLen = Math.max(...differents.map(d => d.length));
  const minDiffLen = Math.min(...differents.map(d => d.length));
  if (maxDiffLen > 30) return null;
  if (differents.some(d => d.length === 0)) return null;

  const uniqueDiff = new Set(differents);
  if (uniqueDiff.size < bodies.length) return null;

  // 差分が括弧で囲まれているか（prefix末尾が開き括弧、suffix先頭が閉じ括弧）
  //   → 引用語句が選択肢になっているケース（「○○」とは…）。文字種チェックを緩和。
  const diffIsQuoted = /[「『]$/.test(prefix) && /^[」』]/.test(suffix);
  // 差分がすべて「単語/語句」レベル（読点・句点を含まず短く、文末表現でない）か
  //   → 全て単語なら長さ比の制限を緩和（"米"(1字) と "醸造アルコール"(6字) のような自然な語長差を許容）
  const allDiffsAreWordLike = differents.every(d =>
    d.length <= 14 && !/[、，。．]/.test(d) && !/(?:である|します|となる|と呼ばれる|を指す|に限られる|と規定される|と定められ)/.test(d));

  // Q-5 強化: 差分の長さの最大/最小比制限（引用語句または全単語なら緩和）
  const ratioLimit = (diffIsQuoted || allDiffsAreWordLike) ? 8 : 4;
  if (maxDiffLen > 0 && minDiffLen > 0 && maxDiffLen / minDiffLen > ratioLimit) return null;

  // Q-5 強化: 差分の文字種チェック（artifact 防止）
  const types = differents.map(classifyCharType);
  const uniqueTypes = new Set(types);
  const numberLike = new Set(['number', 'numberWithUnit', 'unitOnly', 'year']);
  const allNumberLike = types.every(t => numberLike.has(t));
  // (a) 1文字のひらがな差分が混在し、文字種も混在 → 活用語尾等の artifact の可能性 → 拒否
  //     （『搾り/圧搾/上槽/こす』のような2文字以上の意味語の組み合わせは許容する）
  const hasSingleHiragana = differents.some(d => d.length === 1 && /^[ぁ-ん]$/.test(d));
  if (hasSingleHiragana && uniqueTypes.size > 1 && !allNumberLike) return null;
  // (b) 数値・単位系と純粋な語句系が混在 → 曖昧（"50%" と "麹米使用割合" 等）→ 拒否
  //     ただし「規定なし/なし/不要」等の特殊語のみが非数値の場合は許容
  const numLikeCount = types.filter(t => numberLike.has(t)).length;
  if (numLikeCount > 0 && numLikeCount < types.length) {
    const allNumOrSpecial = differents.every(d =>
      numberLike.has(classifyCharType(d)) || /^(?:規定なし|なし|無し?|不要|該当なし|特になし)/.test(d));
    if (!allNumOrSpecial) return null;
  }
  // (c) kanji と unitOnly の混在は依然NG（"米" と "%" 等）
  if (uniqueTypes.has('kanji') && uniqueTypes.has('unitOnly')) return null;
  if (uniqueTypes.has('hiragana') && uniqueTypes.has('numberWithUnit')) return null;

  // D-13: 接尾辞文脈との文法整合性
  for (const d of differents) {
    if (!isGrammaticallyValid(d, suffix)) return null;
  }

  // D-14: トピック逸脱チェック
  for (const d of differents) {
    if (!isTopicConsistent(d, differents, originalValue)) return null;
  }

  // 年代パターンの特殊処理: prefix が "20" などで終わり、差分が年と和暦を含む混合の場合
  if (/(?:20|19|18|17)$/.test(prefix)) {
    if (differents.some(d => /\d{1,4}年/.test(d) && /[（）]/.test(d))) return null;
  }

  // L-1強化: 鉤括弧の整合性
  //   従来は prefix・suffix が各々独立にバランスしている必要があったが、
  //   「…のものを「○○」と呼ぶ」のように差分が括弧の中身になるケース
  //   （prefix が「で終わり suffix が」で始まる）を許容するため、
  //   「prefix+suffix の連結がバランス（深さが負にならず最終0）」かつ
  //   「各差分が単体でバランス（深さが負にならず最終0）」を条件とする。
  //   差分が括弧の中身になる場合、prefix の開き括弧と suffix の閉じ括弧は補完関係にあるのでOK。
  function depthOk(s, open, close, startDepth) {
    let d = startDepth;
    for (const ch of s) {
      if (ch === open) d++;
      else if (ch === close) { d--; if (d < 0) return null; }
    }
    return d;
  }
  const checkPairs = [['「', '」'], ['『', '』'], ['（', '）'], ['(', ')']];
  for (const [op, cl] of checkPairs) {
    const afterPrefix = depthOk(prefix, op, cl, 0);
    if (afterPrefix === null) return null;          // prefix 内で閉じが先行 → NG
    const afterSuffix = depthOk(suffix, op, cl, afterPrefix);
    if (afterSuffix === null || afterSuffix !== 0) return null;  // 連結で負 or 最終非0 → NG
    for (const d of differents) {
      // 差分は単体でバランスしていること（括弧をまたがない）
      if (depthOk(d, op, cl, 0) !== 0) return null;
    }
  }

  // L-10: 言葉の単位を保つよう境界調整
  //   ① 差分が数字で始まる場合、prefix末尾の修飾名詞（精米歩合・度・率・量等）を差分側に移す
  //   ② 差分が漢字で終わり、suffix が漢字で始まる場合、複合熟語（麹+米=麹米）の可能性 → suffix先頭漢字を差分に移す
  let p = prefix, s = suffix, ds = differents.slice();

  // ①: 差分が数値・規定なし系で始まり、prefix末尾が修飾名詞なら移動
  const startsWithNumOrSpec = ds.every(d => /^(?:[\d０-９]|規定なし|なし)/.test(d));
  if (startsWithNumOrSpec) {
    // prefix 末尾の修飾名詞パターン（...歩合 / ...度 / ...率 / ...量 / ...割合 / ...時間）
    const m = p.match(/([一-鿿]{1,8}(?:歩合|度数|度|率|量|分|時間|割合|含有量|濃度|比率))$/);
    if (m) {
      const qualifier = m[1];
      p = p.slice(0, -qualifier.length);
      ds = ds.map(d => qualifier + d);
    }
  }

  // ②: 差分が漢字で終わり suffix 先頭が漢字 → 複合熟語の可能性
  //   L-10 強化（修飾子＋単位終端）：差分の末尾が「修飾子」（低/中/高/単/連 等）かつ
  //   suffix 先頭が「単位終端」漢字の場合、複合熟語化するため取り込む
  //   例：「○○温で...」○○=低/中/高 → 「低温/中温/高温」を1単位として差分に取り込む
  //       「○○温長期仕込み」のように s[1] が漢字でも、温/式/段 等は確実な単位終端なので取り込む
  const QUALIFIER_TRAILING_KANJI = '低中高大小強弱単複連続上下左右内外前後浅深軟硬純本生原無有初終始末速遅長短太細広狭良悪新古甘辛濃薄少多全半粗混白玄黒赤青緑黄正負主副表裏精軟硬温熱冷暖乾湿酸塩苦渋早晩';
  // 修飾子と組み合わせて常に2字熟語を成す確実な単位終端漢字
  const UNIT_FINAL_KANJI = '温式段型性級位値層圧速度期粒形量';
  if (ds.every(d => /[一-鿿]$/.test(d)) && /^[一-鿿]/.test(s)) {
    const leadingChar = s[0];
    const secondChar = s.length >= 2 ? s[1] : '';
    const secondIsKanji = secondChar && /[一-鿿]/.test(secondChar);
    const isUnitFinal = !secondIsKanji;
    const isWellKnownUnitFinal = UNIT_FINAL_KANJI.includes(leadingChar);
    const allDiffsAreQualifierEnd = ds.every(d => QUALIFIER_TRAILING_KANJI.includes(d[d.length - 1]));
    const isCommonUnitNoun = /^[米麦芋酒]/.test(leadingChar);
    // 取り込み条件:
    //   (a) 全差分が修飾子末尾 AND suffix先頭が既知の単位終端漢字 → s[1]問わず取り込み（例：温長期）
    //   (b) 全差分が修飾子末尾 AND suffix単位終端（s[1]非漢字）→ 取り込み
    //   (c) suffix先頭が原料系（米/麦/芋/酒）AND 単位終端 → 取り込み（既存）
    if ((allDiffsAreQualifierEnd && isWellKnownUnitFinal)
        || (allDiffsAreQualifierEnd && isUnitFinal)
        || (isCommonUnitNoun && isUnitFinal)) {
      s = s.slice(1);
      ds = ds.map(d => d + leadingChar);
    }
  }

  // ③: 差分1文字で漢字、prefix末尾が漢字 → 複合熟語の可能性 prefix側
  if (ds.every(d => /^[一-鿿]$/.test(d) && d.length === 1) && /[一-鿿]$/.test(p)) {
    // prefix 末尾の漢字1文字を差分先頭に移す
    const lastChar = p[p.length - 1];
    if (/^[米麦芋酒精玄白]/.test(lastChar)) {
      p = p.slice(0, -1);
      ds = ds.map(d => lastChar + d);
    }
  }

  // ④: 「以X」家族の境界保護 — prefix末尾が「以」で差分先頭が「上下内外前後降来」なら、
  //   「[N]等以」「[N]級以」のような評価尺度の単位ごと差分に取り込む。
  //   例：prefix=「3等以」, diff=「上に格付け…」→ prefix=「」, diff=「3等以上に格付け…」
  if (/以$/.test(p) && ds.every(d => /^[上下内外前後降来]/.test(d))) {
    const m = p.match(/(\d+\s*[等級点位号段]\s*以)$/);
    if (m) {
      p = p.slice(0, -m[1].length);
      ds = ds.map(d => m[1] + d);
    } else {
      p = p.slice(0, -1);
      ds = ds.map(d => '以' + d);
    }
  }

  // 境界調整後の再検証
  // 共通部分が短すぎたら諦める
  const adjAvgLen = (p.length + s.length + ds.reduce((sum, d) => sum + d.length, 0) / ds.length);
  if (p.length + s.length < 15) {
    // 共通部分があまりに短くなった → Q-5諦め
    return null;
  }

  return {
    applied: true,
    prefix: p,
    suffix: s,
    differents: ds,
  };
}

// Q-5: 共通部分抽出後の問題文を組み立てる
//   元の問題文 + 共通部分（穴埋め記号付き） + 「○○ に入る...」
function buildStemmedQuestionBody(originalBody, prefix, suffix, factType, fact) {
  const blank = '○○';
  let stemQuote = '';
  if (prefix && suffix) {
    stemQuote = prefix + blank + suffix;
  } else if (prefix) {
    stemQuote = prefix + blank;
  } else if (suffix) {
    stemQuote = blank + suffix;
  }
  stemQuote = stemQuote.trim();

  // L-9: 句点で終わるよう保証（読点・接続表現で終わる場合は補正）
  if (stemQuote && !/[。！？]$/.test(stemQuote)) {
    // 末尾の不要な読点・空白を除去してから句点を付ける
    stemQuote = stemQuote.replace(/[、，,\s]+$/, '') + '。';
  }

  // Q-11: STEM 終端句のバリエーション（fact.type 別に4種類前後から seeded random で選択）
  const r = seededRand(fact.id + ':stem-ending');
  const ending = pickStemEnding(fact, '', factType, r);

  // Q-5適用時は冗長なプレフィックスは省略。
  // 引用文（穴埋め部分を含む）と問いだけで自己完結させる。
  return [stemQuote, ending].filter(Boolean).join('\n');
}

// 表記揺れ吸収用の正規化
function normalizeText(s) {
  return String(s || '')
    .replace(/[〜～]/g, '〜')   // チルダを統一
    .replace(/[～]/g, '〜')
    .replace(/[　\s]+/g, '') // 全角半角スペースを削除
    .replace(/[，,]/g, ',')
    .replace(/[．\.]/g, '.')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .toLowerCase()
    .trim();
}

// 正答に対する不正答の「紛らわしさ」スコア
function distractorScore(d, correct, type) {
  let score = 0;
  // 長さの近さ
  const dl = d.length, cl = correct.length;
  const lenRatio = Math.min(dl, cl) / Math.max(dl, cl, 1);
  score += lenRatio * 5;
  // 数値タイプ：単位が一致するか
  if (type === 'number') {
    const cu = (correct.match(/(%|％|kl|度|年|日|時間|分|m|cm|kg|g|℃|号|t|トン)$/) || [])[0];
    const du = (d.match(/(%|％|kl|度|年|日|時間|分|m|cm|kg|g|℃|号|t|トン)$/) || [])[0];
    if (cu && du && cu === du) score += 10;
    else if (cu !== du) score -= 3;
  }
  // 年代タイプ：年で終わるか
  if (type === 'year') {
    if (/年$/.test(d) && /年$/.test(correct)) score += 10;
    else if (/年$/.test(correct)) score -= 5;
  }
  // 地名タイプ：県/地域名らしいか
  if (type === 'place') {
    if (/(?:県|府|都|道|地方|諸島|島)$/.test(d) && /(?:県|府|都|道|地方|諸島|島)$/.test(correct)) score += 8;
  }
  return score;
}

// 値文から「核心点（年・数値・特定の専門用語など）」を抽出
function extractKeyPoint(value) {
  if (!value) return '';
  const points = [];
  // 年代（西暦と和暦の括弧表記、月付きまで取りに行く）
  const yr = value.match(/\d{3,4}\s*(?:[（(](?:平成|昭和|令和|大正|明治|天保|寛永|貞観)\s*\d+\s*年?[)）])?\s*年(?:\s*\d{1,2}\s*月)?/);
  if (yr) points.push(yr[0].trim());
  // パーセント・単位付き数値
  const num = value.match(/[\d０-９,．\.〜～]+\s*(?:%|％|kl|kg|g|度|℃|時間|分|号|t|トン|ppm|cm|km|m)/);
  if (num && !points.includes(num[0])) points.push(num[0]);
  // 「○○として」「○○である」の predicate
  return points.join('・');
}

// 教本引用文の整形：OCR途切れ末尾の不完全字を補正、長すぎなら短縮
function formatTextbookQuote(rawText, maxLen = 220) {
  if (!rawText) return '';
  let t = rawText.replace(/\s+/g, ' ').trim();
  // 文末が句点・閉じ括弧で終わっていれば完結文とみなす
  const endsCleanly = /[。．」』）)]$/.test(t);
  // 末尾が中途半端な動詞語幹（する／ある／いる／なる の活用形が途切れたもの）
  const endsTruncated = /(?:^|[ぁ-んァ-ヶー一-鿿])(?:するこ|あるこ|いるこ|なるこ|であ|でき|であり|について|に関し)$/.test(t);
  if (t.length > maxLen) {
    t = t.slice(0, maxLen).trim() + '…';
  } else if (!endsCleanly || endsTruncated) {
    // 末尾の不完全な助詞・語幹を削って … で閉じる
    t = t.replace(/(?:するこ|あるこ|いるこ|なるこ|であ|でき|であり|について|に関し|の|を|で|に|は|が|と|から|まで)$/, '');
    t = t.trim() + '…';
  }
  return t;
}

// 短い答え（diff の置換後 or 値の核心点）を抽出
function extractAnswerKey(fact, correctChoice) {
  // stem 適用済みなら correctChoice.body が差分そのもの
  if (correctChoice && correctChoice.body && correctChoice.fullBody && correctChoice.body !== correctChoice.fullBody) {
    return correctChoice.body;
  }
  // diff があれば置換後を答えとする
  if (correctChoice && correctChoice.diff) {
    const m = correctChoice.diff.match(/^(.+?)\s*→\s*(.+)$/);
    if (m) return m[2].trim();
  }
  // それ以外はファクトの核心点
  return extractKeyPoint(fact.fact.value) || cleanValue(fact.fact.value);
}

function buildCorrectReason(fact) {
  // 受験者目線：教本に記載のある事実文をそのまま根拠として示す
  const value = cleanValue(fact.fact.value);
  if (value) {
    return `教本 p${fact.referencePage}：${value}`;
  }
  return `教本 p${fact.referencePage} の記述に基づきます。`;
}

// 主題同士の関連度を判定（部分一致・共通文字列）
function subjectRelation(a, b) {
  if (!a || !b) return 'unrelated';
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 'same';
  if (na.length >= 4 && nb.length >= 4) {
    if (na.includes(nb) || nb.includes(na)) return 'overlap';
    for (let i = 0; i + 4 <= na.length; i++) {
      if (nb.includes(na.slice(i, i + 4))) return 'overlap';
    }
  }
  return 'unrelated';
}

// E-2: 誤答パターンの分類
// returns: { tag, label } - tag は短い識別子、label は人間可読な短文
function classifyWrongPattern(correctValue, distractorValue, currentFact, srcFact) {
  // 数値違い：両方に同じ単位の数値が含まれており、値が違う
  const correctNums = (correctValue.match(/\d+(?:\.\d+)?\s*(?:%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m)/g) || []);
  const distractorNums = (distractorValue.match(/\d+(?:\.\d+)?\s*(?:%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m)/g) || []);
  if (correctNums.length && distractorNums.length) {
    const cUnit = (correctNums[0].match(/(?:%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m)/) || [])[0];
    const dUnit = (distractorNums[0].match(/(?:%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m)/) || [])[0];
    if (cUnit && dUnit && cUnit === dUnit && correctNums[0] !== distractorNums[0]) {
      return { tag: '数値違い', label: `数値違い（${distractorNums[0]} と ${correctNums[0]} の混同）` };
    }
  }
  // 年代違い：両方に年が含まれている
  const correctYr = (correctValue.match(/\d{3,4}\s*年/) || [])[0];
  const distractorYr = (distractorValue.match(/\d{3,4}\s*年/) || [])[0];
  if (correctYr && distractorYr && correctYr !== distractorYr) {
    return { tag: '年代違い', label: `年代違い（${distractorYr} と ${correctYr} の混同）` };
  }
  // 主題関連性は title・カテゴリで判定（subject廃止）
  if (srcFact) {
    const srcTitle = (srcFact.title || '') + '|' + (srcFact.category || '');
    const currTitle = (currentFact.title || '') + '|' + (currentFact.category || '');
    if (srcTitle === currTitle) {
      return { tag: '同主題の別側面', label: `同じセクション「${currentFact.title || currentFact.category}」の別ファクト` };
    }
    return { tag: '別主題', label: `別セクション「${srcFact.title || srcFact.category}」の記述` };
  }
  return { tag: '別主題', label: '別の事項に関する記述' };
}

// E-1, E-2, E-5, E-9: 誤答ごとの個別解説（受験者目線・短文）
//   distractorObj には { text, strategy, diff, isSynthesized } が入る
function buildWrongReason(distractorText, currentFact, valueToFact, distractorObj) {
  if (!distractorText) {
    return { tag: '誤り', text: '本問の主題に対して誤った記述です。' };
  }
  const diffStr = (distractorObj && distractorObj.diff) ? distractorObj.diff : '';
  let m = diffStr ? diffStr.match(/^(.+?)\s*→\s*(.+)$/) : null;

  // 合成誤答（教本に存在しない／辞書置換で作られた誤答）
  const src = valueToFact && (valueToFact.get(distractorText) || valueToFact.get('__n__' + normalizeText(distractorText)));
  const isSynthesized = (distractorObj && distractorObj.isSynthesized === true) || !src;

  if (isSynthesized && m) {
    const orig = m[1].trim();
    const replaced = m[2].trim();
    // 数値・年代違いは混同への注意を促す短文を添える
    const correctValue = cleanValue(currentFact.fact.value);
    const pattern = classifyWrongPattern(correctValue, distractorText, currentFact, src);
    if (pattern.tag === '数値違い') {
      return {
        tag: '数値違い',
        text: `「${replaced}」は誤り。正しくは「${orig}」です。数値はうっかり混同しやすいので注意しましょう。`,
      };
    }
    if (pattern.tag === '年代違い') {
      return {
        tag: '年代違い',
        text: `「${replaced}」は誤り。正しくは「${orig}」です。年代は西暦・和暦をセットで覚えると間違えにくくなります。`,
      };
    }
    return {
      tag: '記述違い',
      text: `「${replaced}」は誤り。正しくは「${orig}」です。`,
    };
  }
  if (isSynthesized) {
    return { tag: '記述違い', text: '教本の記述とは異なる内容です。' };
  }

  // 教本由来の真事実誤答（同じ教本の別箇所から流用）— Q-9 厳守なので通常発生しないが念のため
  const pageRef = `p${src.referencePage}`;
  const srcTopic = (src.title || '').trim() || (src.category || '').trim();
  const correctValue = cleanValue(currentFact.fact.value);
  const pattern = classifyWrongPattern(correctValue, distractorText, currentFact, src);

  if (pattern.tag === '同主題の別側面') {
    return {
      tag: '別側面',
      text: `この内容自体は教本 ${pageRef} に書かれていますが、本問の答えとしては当てはまりません。`,
    };
  }
  return {
    tag: '別主題',
    text: `これは教本 ${pageRef}「${srcTopic}」に関する記述で、本問の答えとしては不適切です。`,
  };
}

// E-6: ひっかけポイント（受験者目線・混同しやすい論点を指摘）
function buildPitfalls(currentFact, choices) {
  const pitfalls = [];
  const wrongs = choices.filter(c => !c.isCorrect);

  const hasNumDiff = wrongs.some(c => c.reasonTag === '数値違い');
  const hasYearDiff = wrongs.some(c => c.reasonTag === '年代違い');
  if (hasNumDiff && hasYearDiff) {
    pitfalls.push('数値・年代がともに紛らわしい問題です。正答の数値と年代を単位までセットで覚えましょう。');
  } else if (hasNumDiff) {
    pitfalls.push('数値が似た選択肢が並んでいます。正答の数値を単位まで正確に押さえましょう。');
  } else if (hasYearDiff) {
    pitfalls.push('年代を取り違えやすい問題です。西暦と和暦をセットで覚えると混同しにくくなります。');
  }

  const sameSubjectWrongs = wrongs.filter(c => c.reasonTag === '別側面');
  if (sameSubjectWrongs.length >= 2) {
    pitfalls.push('同じテーマ内で似た記述が並んでいます。問題文が問うているのは「どの側面か」を正確に読み取りましょう。');
  }
  return pitfalls;
}

// E-7: 学習価値のある追加情報（教本範囲内）
function buildLearningTip(fact) {
  const f = fact.fact;
  const value = cleanValue(f.value);
  const key = extractKeyPoint(value);
  if (!key) return '';
  // 核心点が年代の場合：和暦・西暦のセット記憶を促す
  const yrMatch = key.match(/(\d{3,4})\s*年/);
  if (yrMatch) {
    const wareki = value.match(/(平成|昭和|令和|大正|明治)\s*\d+\s*年/);
    if (wareki) {
      return `覚え方：西暦${yrMatch[1]}年と和暦「${wareki[0]}」をセットで覚える。`;
    }
    return `覚え方：${yrMatch[1]}年という年代をキーにして関連事項と紐付けて覚える。`;
  }
  // 数値の場合：単位ごと正確に覚える
  const numMatch = key.match(/([\d．\.〜～\-]+)\s*(%|％|kl|kg|g|度|℃|号|t|ppm|cm|km|m)/);
  if (numMatch) {
    return `覚え方：「${numMatch[1]}${numMatch[2]}」を単位まで正確に覚える。`;
  }
  return '';
}

// E-10: 一歩踏み込んだ解説（elaborations.json から該当ファクトに紐づく補強知識を抽出）
function findElaborations(fact, value) {
  const out = [];
  const seenIds = new Set();
  const list = (ELABORATIONS && ELABORATIONS.elaborations) || [];
  const valueText = value || '';
  const titleText = (fact.title || '') + ' ' + (fact.category || '');
  for (const e of list) {
    if (seenIds.has(e.id)) continue;
    const patterns = Array.isArray(e.match) ? e.match : [e.match].filter(Boolean);
    let matched = false;
    for (const p of patterns) {
      try {
        const re = new RegExp(p);
        if (re.test(valueText)) { matched = true; break; }
      } catch (err) {
        // 不正な正規表現は無視
      }
    }
    if (!matched) continue;
    if (e.categoryIncludes && !titleText.includes(e.categoryIncludes)) continue;
    if (e.titleIncludes && !titleText.includes(e.titleIncludes)) continue;
    seenIds.add(e.id);
    out.push(e);
  }
  return out;
}

// E-8: 解説の構造（受験者目線：答え → 教本記述 → 各誤答の見分け方 → 覚え方）
function buildExplanation(fact, choices) {
  const f = fact.fact;
  const correctChoice = choices && choices.find(c => c.isCorrect);
  const wrongs = choices ? choices.filter(c => !c.isCorrect) : [];

  let parts = [];

  // 答え（短いキーワードで先に提示）
  const answerKey = extractAnswerKey(fact, correctChoice);
  if (answerKey) {
    parts.push(`▼ 答え：${answerKey}`);
  }

  // 教本の記述（fact.value は答えのキーワードを含む整形済み事実文。
  //   rawText は OCR 由来で誤読・途切れがあるため、value を一次根拠として使う）
  const valueText = cleanValue(f.value);
  if (valueText) {
    parts.push('');
    parts.push(`▼ 教本 p${fact.referencePage} の内容`);
    parts.push(valueText);
  }

  // E-10: 一歩踏み込んだ解説（教本知識を補強するキュレーション）
  const elabs = findElaborations(fact, valueText);
  if (elabs.length) {
    parts.push('');
    parts.push('▼ もう一歩深く');
    for (const e of elabs) {
      parts.push(`【${e.title}】`);
      parts.push(e.body);
    }
  }

  // ひっかけポイント（混同に注意）
  const pitfalls = buildPitfalls(fact, choices);
  if (pitfalls.length) {
    parts.push('');
    parts.push('▼ 注意点');
    for (const p of pitfalls) parts.push(p);
  }

  // 覚え方
  const tip = buildLearningTip(fact);
  if (tip) {
    parts.push('');
    parts.push(`▼ 覚え方：${tip.replace(/^覚え方：/, '')}`);
  }

  return parts.join('\n');
}

// ===========================================================================
// CSV
// ===========================================================================
function toCsvField(v) {
  if (v == null) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}
// 問題を解くアプリ向け CSV import スキーマ（名前指定方式）
//   lessonTitle: 教本セクション名 / chapterTitle: 章名（同名 lesson が複数章にある場合の絞込み用）
//   questionSentence, questionType, options.0..N, correctAnswers.0, explanation, referencedPage
function buildCsv(rows) {
  const header = [
    'lessonTitle', 'chapterTitle', 'questionSentence', 'questionType',
    'options.0', 'options.1', 'options.2', 'options.3',
    'correctAnswers.0', 'explanation', 'referencedPage',
  ];
  const lines = [header.map(toCsvField).join(',')];
  for (const q of rows) {
    const choices = q.choices || [];
    const correct = choices.find(c => c.isCorrect);
    const correctText = (correct && correct.body) || q.correctAnswer || '';
    const opt = (i) => (choices[i] && choices[i].body) || '';
    lines.push([
      q.title || '',
      q.category || '',
      q.questionBody || '',
      'SINGLE_CHOICE',
      opt(0), opt(1), opt(2), opt(3),
      correctText,
      q.explanation || '',
      q.referencePage != null && q.referencePage !== '' ? 'P' + q.referencePage : '',
    ].map(toCsvField).join(','));
  }
  return lines.join('\n');
}

// ===========================================================================
// カバレッジレポート
// ===========================================================================
function buildCoverageReport(facts, questions) {
  const factById = new Map(facts.map(f => [f.id, f]));
  const covered = new Set(questions.map(q => q.factId));
  const totalFacts = facts.length;
  const coveredCount = covered.size;
  const uncovered = facts.filter(f => !covered.has(f.id));

  // カテゴリ別カバレッジ
  const byCat = {};
  for (const f of facts) {
    if (!byCat[f.category]) byCat[f.category] = { total: 0, covered: 0 };
    byCat[f.category].total++;
    if (covered.has(f.id)) byCat[f.category].covered++;
  }

  // 未カバーの理由分析
  const uncoveredReasons = {
    'value短すぎ': 0,
    'value異常': 0,
    '辞書未対応': 0,
    'その他': 0,
  };
  for (const f of uncovered) {
    const v = f.fact.value || '';
    if (v.length < 8) uncoveredReasons['value短すぎ']++;
    else if (v.length > 200) uncoveredReasons['value異常']++;
    else uncoveredReasons['辞書未対応']++;
  }

  let md = `# v3 カバレッジレポート\n\n`;
  md += `生成: ${new Date().toISOString()}\n\n`;
  md += `## 総計\n\n`;
  md += `- ファクト総数: ${totalFacts}\n`;
  md += `- 問題化済み: ${coveredCount} (${(coveredCount/totalFacts*100).toFixed(1)}%)\n`;
  md += `- 生成問題数: ${questions.length}\n`;
  md += `- 未カバーファクト: ${uncovered.length}\n\n`;

  md += `## カテゴリ別\n\n`;
  md += `| カテゴリ | ファクト総数 | カバー数 | カバー率 |\n`;
  md += `|---|---:|---:|---:|\n`;
  for (const [k, v] of Object.entries(byCat).sort()) {
    const pct = (v.covered/v.total*100).toFixed(1);
    md += `| ${k} | ${v.total} | ${v.covered} | ${pct}% |\n`;
  }

  md += `\n## 未カバー理由\n\n`;
  for (const [k, v] of Object.entries(uncoveredReasons)) {
    md += `- ${k}: ${v}\n`;
  }

  md += `\n## 未カバーファクトのサンプル（先頭30件）\n\n`;
  for (const f of uncovered.slice(0, 30)) {
    md += `- [${f.category}/${f.title}] ${f.fact.value}\n`;
  }
  return md;
}

// ===========================================================================
// 不正答プールが不足するファクトに、同カテゴリ・同タイプから補充
// ===========================================================================
// 実行時の同カテゴリ・同型 fallback マップを構築
// （旧 fillDistractors の代替。distractorPool フィールドを使わずメモリ上で値リストを持つ）
function buildFallbackMap(facts) {
  const map = new Map();
  for (const f of facts) {
    const k = f.category + '||' + f.fact.type;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(f.fact.value);
  }
  // カテゴリ全体での fallback も用意（同カテゴリ内・型問わず）
  for (const f of facts) {
    const k = f.category + '||*';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(f.fact.value);
  }
  return map;
}

// ===========================================================================
// Main
// ===========================================================================
function main() {
  console.log('Reading facts...');
  const facts = JSON.parse(fs.readFileSync(FACTS, 'utf-8'));
  console.log('  ' + facts.length + ' facts loaded');

  // 実行時の fallback マップを構築（旧 distractorPool の代替・メモリ上保持）
  console.log('Building runtime fallback map...');
  const fallbackMap = buildFallbackMap(facts);
  console.log('  ' + fallbackMap.size + ' (category||type) buckets indexed');

  // 値→ファクト 逆引きマップを構築（同一値が複数ある場合は最初のものを採用）
  const valueToFact = new Map();
  for (const f of facts) {
    const v = (f.fact && f.fact.value) || '';
    if (v && !valueToFact.has(v)) valueToFact.set(v, f);
    // 表記揺れ対応
    const vNorm = normalizeText(v);
    if (vNorm && !valueToFact.has('__n__' + vNorm)) valueToFact.set('__n__' + vNorm, f);
  }

  // 教本由来の数値・年代インデックス構築 (D-5)
  console.log('Building neighbor index (textbook-derived numbers/years)...');
  const neighborIndex = buildNeighborIndex(facts);
  console.log('  units indexed:', Object.keys(neighborIndex.numbersByUnit).length, 'years indexed:', neighborIndex.years.length);

  console.log('Generating questions...');
  const rawQuestions = [];
  let i = 0;
  for (const f of facts) {
    const q = buildQuestion(f, i++, valueToFact, neighborIndex, facts, fallbackMap);
    if (q) rawQuestions.push(q);
  }

  // Q-8: 重複・近似問題の排除
  console.log('Deduplicating near-identical questions (Q-8)...');
  const questions = deduplicateQuestions(rawQuestions);
  console.log('  ' + (rawQuestions.length - questions.length) + ' duplicates removed');

  // 生成方式の統計
  const methodStats = {};
  for (const q of questions) methodStats[q.distractorMethod] = (methodStats[q.distractorMethod] || 0) + 1;
  console.log('  Distractor method:', methodStats);
  console.log('  ' + questions.length + ' questions generated (from ' + facts.length + ' facts)');

  // 統計
  const byCat = {}, byType = {};
  for (const q of questions) {
    byCat[q.category] = (byCat[q.category] || 0) + 1;
    byType[q.factType] = (byType[q.factType] || 0) + 1;
  }
  console.log('\n  By category:');
  for (const [k, v] of Object.entries(byCat).sort()) console.log('    ' + k + ': ' + v);
  console.log('\n  By fact type:');
  for (const [k, v] of Object.entries(byType).sort()) console.log('    ' + k + ': ' + v);

  // 出力
  fs.writeFileSync(OUT_JSONL, questions.map(q => JSON.stringify(q)).join('\n') + '\n');
  fs.writeFileSync(OUT_JSON, JSON.stringify(questions));
  fs.writeFileSync(OUT_CSV, buildCsv(questions));

  // カバレッジ
  console.log('\nGenerating coverage report...');
  const report = buildCoverageReport(facts, questions);
  fs.writeFileSync(OUT_COVERAGE, report);
  console.log('  Written:', OUT_COVERAGE);
}

main();
