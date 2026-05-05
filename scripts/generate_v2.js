#!/usr/bin/env node
/**
 * 酒ディプロマ 演習問題データベース（v2）生成スクリプト
 *
 * 入力: data/all_questions.jsonl
 * 出力: data/v2/all_questions_v2.jsonl, data/v2/all_questions_v2.csv, data/v2/transform_log.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.resolve(__dirname, '../data/all_questions.jsonl');
const OUT_DIR = path.resolve(__dirname, '../data/v2');
const OUT_JSONL = path.join(OUT_DIR, 'all_questions_v2.jsonl');
const OUT_CSV = path.join(OUT_DIR, 'all_questions_v2.csv');
const OUT_LOG = path.join(OUT_DIR, 'transform_log.json');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- 決定的乱数 ----------
function seededRand(seed) {
  // mulberry32（決定的疑似乱数）
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
function pickOne(arr, seed) {
  const r = seededRand(seed);
  return arr[Math.floor(r() * arr.length)];
}

// ---------- 言い換え（Type A） ----------
// 順序が重要：より具体的なパターンを先に
const QUESTION_REWRITES = [
  // 既存テキストの不自然な「正しいものをどれか。」を整える
  { re: /正しいものをどれか[。？]?$/, to: '正しいものを次から1つ選べ。' },
  { re: /誤っているものをどれか[。？]?$/, to: '誤っているものを次から1つ選べ。' },
  { re: /該当するものをどれか[。？]?$/, to: '該当するものを次から1つ選べ。' },
  // 「〜について正しいものを」型
  { re: /について正しいものを次から1つ選べ[。？]?$/, to: 'の説明として適切なものはどれか。' },
  { re: /について正しいものはどれか[。？]?$/, to: 'について妥当なものを選べ。' },
  { re: /について誤っているものはどれか[。？]?$/, to: 'について不適切なものを選べ。' },
  { re: /について述べたものとして正しいものはどれか[。？]?$/, to: 'の説明として妥当なものはどれか。' },
  // 「正しいものを選んでください」型
  { re: /正しいものを選んでください[。？]?$/, to: '正しいものを次から1つ選べ。' },
  { re: /正しい説明を選んでください[。？]?$/, to: '妥当な説明を次から1つ選べ。' },
  { re: /誤っているものを選んでください[。？]?$/, to: '誤っているものを次から1つ選べ。' },
  { re: /適切なものを選んでください[。？]?$/, to: '最も適切なものを選べ。' },
  { re: /不適切なものを選んでください[。？]?$/, to: '最も不適切なものを選べ。' },
  { re: /該当するものを選んでください[。？]?$/, to: '該当するものを選べ。' },
  // 「〜は？」「〜は何か？」
  { re: /は何ですか[。？]?$/, to: 'として最も適切なものはどれか。' },
  { re: /は何か[。？]?$/, to: 'は次のうちどれか。' },
  { re: /はどれか[。？]?$/, to: 'として正しいものを選べ。' },
  { re: /は\?$/, to: 'として正しいものはどれか。' },
  { re: /は？$/, to: 'として正しいものはどれか。' },
  // 「〜の理由は？」
  { re: /の理由は[？?]?$/, to: 'の理由として最も適切なものはどれか。' },
  { re: /理由として正しいものはどれか[。？]?$/, to: '主たる理由はどれか。' },
  // 「正解は？」「答えは？」
  { re: /正解は[？?。]?$/, to: '正解として正しいものを選べ。' },
];

const EXPLANATION_REWRITES = [
  // 文体統一（です・ます調 → である調）の主要ルール
  { re: /です。/g, to: 'である。' },
  { re: /ます。/g, to: 'る。' },
  { re: /ません。/g, to: 'ない。' },
  { re: /でした。/g, to: 'であった。' },
  { re: /ました。/g, to: 'た。' },
  { re: /います。/g, to: 'いる。' },
  { re: /できます。/g, to: 'できる。' },
  { re: /あります。/g, to: 'ある。' },
  { re: /なります。/g, to: 'なる。' },
  { re: /されます。/g, to: 'される。' },
  { re: /されています。/g, to: 'されている。' },
  { re: /行われます。/g, to: '行われる。' },
  { re: /用いられます。/g, to: '用いられる。' },
  { re: /含まれます。/g, to: '含まれる。' },
  // 接続の簡約
  { re: /そのため、/g, to: 'ゆえに、' },
  { re: /したがって、/g, to: 'よって、' },
  { re: /また、/g, to: 'さらに、' },
  // 軽微な語順調整
  { re: /〜について、/g, to: 'については、' },
];

// 末尾の定型句や助詞を全て剥がして「主題」だけ抽出
function extractCore(body) {
  let core = body.replace(/[。？?！]+$/, '');
  // 末尾定型句（複数回適用してネスト除去）
  const tailPatterns = [
    /として正しいものを次から1?つ?選べ$/,
    /として正しいものを選んでください$/,
    /として正しいものを選べ$/,
    /として正しいものはどれか$/,
    /として正しいものを次から選べ$/,
    /として最も適切なものはどれか$/,
    /として最も適切なものを選べ$/,
    /として適切なものはどれか$/,
    /として適切なものを選べ$/,
    /として誤っているものを次から1?つ?選べ$/,
    /として誤っているものを選べ$/,
    /として誤っているものはどれか$/,
    /として不適切なものはどれか$/,
    /として不適切なものを選べ$/,
    /として最も不適切なものを選べ$/,
    /として最も的確なものを選べ$/,
    /として妥当なものはどれか$/,
    /として妥当な記述を選び答えよ$/,
    /の説明として適切なものはどれか$/,
    /の説明として誤っているものはどれか$/,
    /の説明として妥当なものはどれか$/,
    /についての説明として妥当なものを次から選べ$/,
    /について妥当なものを選べ$/,
    /について不適切なものを選べ$/,
    /について妥当なものを次から選べ$/,
    /について妥当な記述はどれか$/,
    /について述べたものとして正しいものはどれか$/,
    /の理由として最も適切なものはどれか$/,
    /の理由はどれか$/,
    /の主たる理由はどれか$/,
    /主たる理由はどれか$/,
    /は次のうちどれか$/,
    /は何ですか$/,
    /は何か$/,
    /はどれか$/,
    /は次のうちどれですか$/,
    /正解は$/,
    /正解として正しいものを選べ$/,
    /正しいものを次から1?つ?選べ$/,
    /正しいものを選んでください$/,
    /正しいものはどれか$/,
    /正しいものを選べ$/,
    /正しいものをどれか$/,
    /正しいものはどれですか$/,
    /誤っているものを次から1?つ?選べ$/,
    /誤っているものはどれか$/,
    /誤っているものを選べ$/,
    /誤っているものを選んでください$/,
    /誤っているものをどれか$/,
    /適切なものはどれか$/,
    /適切なものを選べ$/,
    /適切でないものはどれか$/,
    /適切でないものを選べ$/,
    /該当するものはどれか$/,
    /該当しないものはどれか$/,
    /該当するものを選べ$/,
    /該当するものをどれか$/,
    /該当しないものを選べ$/,
    /含まれるものはどれか$/,
    /含まれないものはどれか$/,
    /合うものはどれか$/,
    /合わないものはどれか$/,
    /推奨されるものはどれか$/,
    /推奨されないものはどれか$/,
    /当てはまるものはどれか$/,
    /当てはまらないものはどれか$/,
    /妥当なものはどれか$/,
    /妥当でないものはどれか$/,
    /(?:選んでください|選びなさい|選べ)$/,
    /、?どれか$/,
    /の理由$/,
    // 「〜ますか」「〜ですか」末尾系
    /(?:に|へ)?(?:なり|あり|でき|分類され|表示でき|呼ばれ|含まれ|使われ|用いられ|認められ|され|され)?ますか$/,
    /(?:です|だ)か$/,
    /(?:でしょう|だろう)か$/,
    /ますか$/,
    /ですか$/,
    // 末尾「もの」系
    /ものとして$/, /ものに$/, /ものを$/, /ものは$/, /ものが$/, /もので$/, /もの$/,
    /記述として$/, /記述は$/, /記述で$/, /記述$/,
    // 「に関する記述」など重複防止
    /に関する記述で$/,
    /に関する記述として$/,
    /に関する記述$/,
    /の記述で$/,
    /の記述として$/,
    // 動詞連体形末尾
    /(?:分類|呼ば|表示|認め|使わ|含ま|定め|区分|表記)(?:され|れ)?(?:る|た|るか)?$/,
    /と(?:呼ばれる|される|表記する|分類される)(?:か)?$/,
    /(?:に該当する|となる|で(?:あ|す)る|と(?:なる|いう))(?:か)?$/,
    /(?:はどの|どちらに|どこに|どれに|何に)$/,
    /(?:はどの|はどちら|はどこ|はどれ|は何)$/,
    // 末尾の修飾語
    /(?:正しい|誤った|妥当な|適切な|不適切な|妥当でない)$/,
    /に関する$/,
    /について$/,
  ];
  let prev = '';
  while (prev !== core) {
    prev = core;
    for (const re of tailPatterns) core = core.replace(re, '');
  }
  // 末尾の助詞・記号を整理
  core = core.replace(/[、,。\s]+$/, '');
  core = core.replace(/(?:は|を|に|の|が|と|で|について|として|に関して)$/, '');
  core = core.replace(/[、,。\s？?]+$/, '');
  return core;
}

// 問題文を「より大胆に」書き換える。元の主語＋目的語を抽出して別構文に組み直す。
function rewriteQuestion(body, seed) {
  const core = extractCore(body);
  if (!core || core.length < 4) {
    if (!/[。？?！]$/.test(body)) return body + '。';
    return body;
  }
  const templates = [
    (k) => `次の選択肢のうち、${k}に該当するものを1つ選べ。`,
    (k) => `${k}に関する次の記述のうち、最も適切なものはどれか。`,
    (k) => `${k}についての説明として妥当なものを次から選べ。`,
    (k) => `次のうち、${k}に当てはまるものはどれか。`,
    (k) => `${k}を表す記述として最も的確なものを選べ。`,
    (k) => `次の中から、${k}に当てはまるものを1つ選び答えよ。`,
    (k) => `${k}にあたるものを次の選択肢から選びなさい。`,
    (k) => `${k}に該当する内容として妥当な記述を選び答えよ。`,
  ];
  const r = seededRand(seed + ':qtmpl');
  return templates[Math.floor(r() * templates.length)](core);
}
function rewriteExplanation(text) {
  let out = text || '';
  for (const { re, to } of EXPLANATION_REWRITES) out = out.replace(re, to);
  return out;
}

function rewriteChoiceBody(body) {
  // 末尾整形のみ（事実を変えない）
  return body
    .replace(/です。?$/, '')
    .replace(/。$/, '')
    .trim();
}

// ---------- 裏返し（Type B 強化版）：問題と正答を入れ替える ----------
// 例：「Aの〇〇は？ 答え：X」 → 「Xに該当する〇〇は？ 答え：A」
function trySwapAnswerSubject(q, seed) {
  const body = q.questionBody;
  const correctChoice = q.choices.find(c => c.isCorrect);
  if (!correctChoice) return null;

  // 主語（県名、品種名など）を問題文から抽出
  // 都道府県パターン
  const prefMatch = body.match(/([一-鿿]{1,4}(?:県|府|都|道))/);
  // 数値選択肢か（都道府県を答える問題のヒント）
  const isNumChoiceAll = q.choices.every(c => /^[\d０-９,\.]/.test(c.body.trim()) || /[\d０-９]+\s*(kl|％|%|度|年|m|cm|kg|g|t|時間|分|日|℃|号)/.test(c.body));

  if (prefMatch && isNumChoiceAll) {
    const pref = prefMatch[1];
    const value = correctChoice.body;
    // 「〇〇に該当する都道府県は？」型に変換
    // 不正答候補：他の3県をでっち上げると不正確になるため、解説中の他県を抽出する案も難。
    // ここでは安全策として変換せず null を返し、別ロジックに委ねる。
    return null;
  }

  // 「年」を問う問題：選択肢が全て「####年」
  const isYearAll = q.choices.every(c => /^\d{3,4}年/.test(c.body.trim()));
  if (isYearAll) {
    // 主語＝事象を抽出（〜の発見、〜の登場、〜が分離）
    const eventMatch = body.match(/(.+?)(?:が|の|を)(?:登場|分離|発見|発表|確立|開始|誕生|施行|制定|指定|廃止)/);
    if (eventMatch && correctChoice) {
      const event = eventMatch[0];
      const newBody = `${correctChoice.body}に起きた酒造関連の出来事として最も適切なものを選べ。`;
      // 不正答に他の正答候補が必要だが、安全のため null（fallback）
      return null;
    }
  }
  return null;
}

// ---------- 反転（Type B） ----------
function tryInvertCorrectness(q, seed) {
  const body = q.questionBody;
  const correctChoice = q.choices.find(c => c.isCorrect);
  const wrongs = q.choices.filter(c => !c.isCorrect);
  if (!correctChoice || wrongs.length < 1) return null;

  // 「正しい」「誤っている」「適切」「不適切」「該当する」「合う」の検出
  const patterns = [
    { match: /正しいものはどれか/, replace: '誤っているものはどれか' },
    { match: /正しいものを選んでください/, replace: '誤っているものを選んでください' },
    { match: /正しいものを次から選べ/, replace: '誤っているものを次から選べ' },
    { match: /正しいものを次から1つ選べ/, replace: '誤っているものを次から1つ選べ' },
    { match: /正しいものを1つ選べ/, replace: '誤っているものを1つ選べ' },
    { match: /正しいものを選べ/, replace: '誤っているものを選べ' },
    { match: /正しいものはどれですか/, replace: '誤っているものはどれですか' },
    { match: /適切なものはどれか/, replace: '適切でないものはどれか' },
    { match: /適切なものを選べ/, replace: '適切でないものを選べ' },
    { match: /妥当なものはどれか/, replace: '妥当でないものはどれか' },
    { match: /妥当なものを選べ/, replace: '妥当でないものを選べ' },
    { match: /誤っているものはどれか/, replace: '正しいものはどれか' },
    { match: /誤っているものを選んでください/, replace: '正しいものを選んでください' },
    { match: /誤っているものを選べ/, replace: '正しいものを選べ' },
    { match: /不適切なものはどれか/, replace: '適切なものはどれか' },
    { match: /該当するものはどれか/, replace: '該当しないものはどれか' },
    { match: /該当するものを選べ/, replace: '該当しないものを選べ' },
    { match: /含まれるものはどれか/, replace: '含まれないものはどれか' },
    { match: /含まれるものを選べ/, replace: '含まれないものを選べ' },
    { match: /合うものはどれか/, replace: '合わないものはどれか' },
    { match: /推奨されるものはどれか/, replace: '推奨されないものはどれか' },
    { match: /当てはまるものはどれか/, replace: '当てはまらないものはどれか' },
  ];
  for (const p of patterns) {
    if (p.match.test(body)) {
      const newBody = body.replace(p.match, p.replace);
      // 反転後の正答は元の不正答からランダムに1つ
      const newCorrect = pickOne(wrongs, seed + ':invert');
      return {
        body: newBody,
        choices: q.choices.map(c => ({ body: c.body, isCorrect: c.body === newCorrect.body })),
        flavor: 'inverted',
        explanationSuffix: `元問題は「${correctChoice.body}」が正答だが、本問は逆を問うている。`,
      };
    }
  }
  return null;
}

// ---------- 強制反転（Type B 汎用版）----------
// あらゆる問題に適用可能。元の正答→不正答、不正答の1つ→正答に転換。
// 問題文を「次の選択肢のうち、〇〇に関する記述として誤っているものを選べ」型に再編する。
function forceInvertGeneric(q, seed) {
  const correctChoice = q.choices.find(c => c.isCorrect);
  const wrongs = q.choices.filter(c => !c.isCorrect);
  if (!correctChoice || wrongs.length < 1) return null;

  // 主題抽出：共通ロジックを使用
  const core = extractCore(q.questionBody);
  if (!core || core.length < 4) return null; // 主題が短すぎる場合スキップ

  // 不正答の1つを「新たな正答」（=誤っている記述）として採用
  const newCorrect = pickOne(wrongs, seed + ':forceinv');
  const newChoices = q.choices.map(c => ({
    body: c.body,
    isCorrect: c.body === newCorrect.body,
  }));

  const tmpls = [
    (k) => `${k}に関する次の記述のうち、誤っているものはどれか。`,
    (k) => `次のうち、${k}についての記述として誤っているものを1つ選べ。`,
    (k) => `${k}に関する説明として、適切でないものを次から選べ。`,
    (k) => `${k}に関する次の選択肢のうち、不適切なものはどれか。`,
  ];
  const r = seededRand(seed + ':itmpl');
  const newBody = tmpls[Math.floor(r() * tmpls.length)](core);

  return {
    body: newBody,
    choices: newChoices,
    flavor: 'force-inverted',
    explanationSuffix: `（注）本問は元問題の正誤を反転させた演習。元の正答「${correctChoice.body}」は正しい記述（＝本問では不正答の選択肢）であり、本問の正答「${newCorrect.body}」が不適切な記述として正解に該当する。`,
  };
}

// ---------- 数値選択肢の刻み変更（Type B） ----------
function tryNumericReshuffle(q, seed) {
  // 全ての選択肢が数値含みなら、ダミーを生成する
  const numRe = /^[\d０-９,\.]+\s*(kl|％|%|度|年|m|cm|kg|g|t|時間|分|日|℃|号)?$/;
  const allNumeric = q.choices.every(c => numRe.test(c.body.trim()));
  if (!allNumeric) return null;
  // 正答は維持、不正答だけシャッフルして見栄えを変える程度（情報を変えない）
  // 厳密な刻み変更は元データに無い数値生成が必要となり、誤答のリスクがあるため
  // ここでは選択肢順だけを変えて「数値の予測しにくさ」を演出する。
  const shuffled = shuffleDeterministic(q.choices, seed + ':numshuf');
  return {
    body: q.questionBody,
    choices: shuffled.map(c => ({ body: c.body, isCorrect: c.isCorrect })),
    flavor: 'numeric-shuffled',
    explanationSuffix: '',
  };
}

// ---------- 新規問題テンプレ（Type C） ----------
// 既存解説から派生して新規問題を作る。安全のため適用範囲は限定的。
// 教本＋まとめノートから検証済みの事実のみ使用。
const FRESH_TEMPLATES = [
  // ===== 第1章 =====
  {
    detect: /精米歩合.*70%以下|本醸造酒.*70/,
    build: () => ({
      body: '本醸造酒に求められる精米歩合の基準として正しいものはどれか。',
      choices: [
        { body: '70%以下', isCorrect: true },
        { body: '60%以下', isCorrect: false },
        { body: '50%以下', isCorrect: false },
        { body: '規定なし', isCorrect: false },
      ],
      explanation: '本醸造酒は精米歩合70%以下、特別本醸造酒・吟醸酒は60%以下、大吟醸酒は50%以下と規定されている。純米酒には精米歩合の規定はない。',
    }),
  },
  {
    detect: /醸造アルコール.*10%以下|白米重量の10%/,
    build: () => ({
      body: '本醸造系（吟醸酒・大吟醸酒・本醸造酒）における醸造アルコール添加量の上限として正しいのはどれか。',
      choices: [
        { body: '白米重量の10%以下', isCorrect: true },
        { body: '白米重量の5%以下', isCorrect: false },
        { body: '白米重量の20%以下', isCorrect: false },
        { body: '白米重量の50%以下', isCorrect: false },
      ],
      explanation: '特定名称酒における醸造アルコール添加は白米重量の10%以下と定められている。普通酒では米重量の50%以下まで副原料が使用できる。',
    }),
  },
  {
    detect: /麹米使用割合|麹米.*15%/,
    build: () => ({
      body: '特定名称酒の要件として麹米の使用割合の下限はいくらか。',
      choices: [
        { body: '15%以上', isCorrect: true },
        { body: '10%以上', isCorrect: false },
        { body: '20%以上', isCorrect: false },
        { body: '25%以上', isCorrect: false },
      ],
      explanation: '特定名称酒は全ての種類で麹米使用割合が白米重量に対して15%以上と定められている。',
    }),
  },
  {
    detect: /地理的表示.*日本酒.*2015|2015.*日本酒.*指定/,
    build: () => ({
      body: '清酒に関する地理的表示「日本酒」が指定された年として正しいものはどれか。',
      choices: [
        { body: '2015年', isCorrect: true },
        { body: '2013年', isCorrect: false },
        { body: '1989年', isCorrect: false },
        { body: '1992年', isCorrect: false },
      ],
      explanation: '2015年に地理的表示「日本酒」が指定され、国内産米を原料に国内で醸造された清酒のみが「日本酒」の表示を使えるようになった。',
    }),
  },
  {
    detect: /YK35|山田錦.*熊本酵母.*精米歩合35/,
    build: () => ({
      body: '1990年代初頭まで全国新酒鑑評会の金賞酒に多く見られた「YK35」が示す組み合わせとして正しいのはどれか。',
      choices: [
        { body: '山田錦・熊本酵母・精米歩合35%', isCorrect: true },
        { body: '雄町・協会7号酵母・精米歩合35%', isCorrect: false },
        { body: '五百万石・きょうかい9号・精米歩合40%', isCorrect: false },
        { body: '美山錦・金沢酵母・精米歩合50%', isCorrect: false },
      ],
      explanation: 'YK35はY=山田錦、K=熊本酵母（協会9号）、35=精米歩合35%（前後）の頭文字をとった、当時の鑑評会金賞酒の典型的な組み合わせを示す。',
    }),
  },
  {
    detect: /山邑太左衛門|宮水を発見/,
    build: () => ({
      body: '1840年に灘の仕込み水「宮水」の優位性を見出した酒造家は誰か。',
      choices: [
        { body: '山邑太左衛門', isCorrect: true },
        { body: '鹿又親', isCorrect: false },
        { body: '岸本甚造', isCorrect: false },
        { body: '嘉儀金一郎', isCorrect: false },
      ],
      explanation: '山邑太左衛門は1840年、魚崎と西宮の蔵で同じ造りでも酒質に差が出る原因を仕込み水と突き止め、西宮の井戸水（宮水）を発見した。',
    }),
  },
  {
    detect: /竪型精米機|1933年.*精米/,
    build: () => ({
      body: '竪型精米機が登場し精米技術を革新したのは何年か。',
      choices: [
        { body: '1933年', isCorrect: true },
        { body: '1910年', isCorrect: false },
        { body: '1945年', isCorrect: false },
        { body: '1986年', isCorrect: false },
      ],
      explanation: '1933年に竪型（金剛ロール式）精米機が登場し、低精米歩合の米が安定的に得られるようになって吟醸酒造りが本格化した。',
    }),
  },
  {
    detect: /三倍増醸|戦後.*米不足/,
    build: () => ({
      body: '戦後の米不足期に普及し現在は廃止されている増量製法はどれか。',
      choices: [
        { body: '三倍増醸法', isCorrect: true },
        { body: '速醸酛', isCorrect: false },
        { body: '山廃酛', isCorrect: false },
        { body: '貴醸酒製法', isCorrect: false },
      ],
      explanation: '三倍増醸法（三増酒）は戦後の米不足期に普及した増量法で、醸造アルコールに糖類等を加えて増量する方法だったが、現在は廃止されている。',
    }),
  },
  {
    detect: /鹿又親|吟醸の経済化/,
    build: () => ({
      body: '1927年に「吟醸」を「吟味して醸造する」と定義し吟醸酒の概念を確立した人物は誰か。',
      choices: [
        { body: '鹿又親', isCorrect: true },
        { body: '山邑太左衛門', isCorrect: false },
        { body: '嘉儀金一郎', isCorrect: false },
        { body: '岸本甚造', isCorrect: false },
      ],
      explanation: '鹿又親が1927年「吟醸の経済化について」で吟醸酒の概念を確立した。山廃仕込みは嘉儀金一郎、雄町は岸本甚造による。',
    }),
  },
  {
    detect: /雄町.*岸本甚造|1859.*雄町/,
    build: () => ({
      body: '酒造好適米「雄町」を発見・育成したとされる人物と発見年として正しい組み合わせはどれか。',
      choices: [
        { body: '岸本甚造／1859年', isCorrect: true },
        { body: '山邑太左衛門／1840年', isCorrect: false },
        { body: '鹿又親／1927年', isCorrect: false },
        { body: '嘉儀金一郎／1909年', isCorrect: false },
      ],
      explanation: '雄町は1859年に岸本甚造が発見・育成を始めた酒造好適米で、現存品種の中で最も古く、山田錦・五百万石の祖先にあたる。',
    }),
  },
  {
    detect: /山田錦|山田穂.*短稈渡船/,
    build: () => ({
      body: '山田錦の交配親として正しい組み合わせはどれか。',
      choices: [
        { body: '山田穂 × 短稈渡船', isCorrect: true },
        { body: '雄町 × たかね錦', isCorrect: false },
        { body: '亀の尾 × 五百万石', isCorrect: false },
        { body: '愛山 × 出羽燦々', isCorrect: false },
      ],
      explanation: '山田錦は1923年に兵庫県立農事試験場で「山田穂」を母、「短稈渡船」を父として交配され、1936年に命名された。',
    }),
  },
  {
    detect: /アミロペクチン.*80|アミロース.*20/,
    build: () => ({
      body: '日本酒に用いられる粳米のでんぷんの構成比として正しいものはどれか。',
      choices: [
        { body: 'アミロペクチン約80%／アミロース約20%', isCorrect: true },
        { body: 'アミロペクチン約20%／アミロース約80%', isCorrect: false },
        { body: 'アミロペクチン100%', isCorrect: false },
        { body: 'アミロース100%', isCorrect: false },
      ],
      explanation: '粳米のでんぷんは枝分かれの多い「アミロペクチン」が約80%、直鎖状の「アミロース」が約20%。もち米はアミロペクチン100%。',
    }),
  },
  {
    detect: /農産物検査法|特上.*特等.*一等|三等以上/,
    build: () => ({
      body: '特定名称酒で使用が認められる原料米の等級基準として正しいものはどれか。',
      choices: [
        { body: '三等以上', isCorrect: true },
        { body: '特上のみ', isCorrect: false },
        { body: '特等以上', isCorrect: false },
        { body: '一等以上', isCorrect: false },
      ],
      explanation: '農産物検査法では米を6段階（特上・特等・一等・二等・三等・規格外）に分類し、特定名称酒には三等以上の米を使用する。',
    }),
  },
  // ===== 第2章 =====
  {
    detect: /三段仕込|初添.*仲添.*留添/,
    build: () => ({
      body: '日本酒の三段仕込みにおいて4日間の工程順序として正しいのはどれか。',
      choices: [
        { body: '初添 → 踊り → 仲添 → 留添', isCorrect: true },
        { body: '初添 → 仲添 → 踊り → 留添', isCorrect: false },
        { body: '踊り → 初添 → 仲添 → 留添', isCorrect: false },
        { body: '初添 → 仲添 → 留添 → 踊り', isCorrect: false },
      ],
      explanation: '1日目に初添、2日目は踊り（酵母増殖待ち）、3日目に仲添、4日目に留添と段階的に仕込み、酸と酵母が急激に薄まらないようにする。',
    }),
  },
  {
    detect: /速醸酛|1910年.*醸造試験所/,
    build: () => ({
      body: '速醸酛が大蔵省醸造試験所より発表された年として正しいものはどれか。',
      choices: [
        { body: '1910年', isCorrect: true },
        { body: '1895年', isCorrect: false },
        { body: '1933年', isCorrect: false },
        { body: '1946年', isCorrect: false },
      ],
      explanation: '速醸酛は1910年に大蔵省醸造試験所から発表された酒母製法で、醸造用乳酸を仕込み当初に添加し雑菌増殖を抑えるため、現在最も普及している。',
    }),
  },
  {
    detect: /きょうかい6号|協会6号|新政|6号酵母/,
    build: () => ({
      body: 'きょうかい6号酵母の分離元の蔵元として正しいものはどれか。',
      choices: [
        { body: '秋田・新政酒造', isCorrect: true },
        { body: '長野・宮坂醸造（真澄）', isCorrect: false },
        { body: '熊本県酒造研究所（香露）', isCorrect: false },
        { body: '灘・櫻正宗', isCorrect: false },
      ],
      explanation: 'きょうかい6号酵母は1935年に秋田・新政酒造の醪から分離。穏やかな香りで淡麗な酒質に向き、現在も頒布されている。',
    }),
  },
  {
    detect: /きょうかい7号|協会7号|真澄|7号酵母/,
    build: () => ({
      body: 'きょうかい7号酵母の分離元の蔵元として正しいのはどれか。',
      choices: [
        { body: '長野・宮坂醸造（真澄）', isCorrect: true },
        { body: '秋田・新政酒造', isCorrect: false },
        { body: '熊本県酒造研究所（香露）', isCorrect: false },
        { body: '灘・櫻正宗', isCorrect: false },
      ],
      explanation: 'きょうかい7号酵母は1946年に長野・宮坂醸造（真澄）の醪から分離。華やかな芳香と発酵力の強さで戦後の基調酵母となり、現在も最も販売数が多い。',
    }),
  },
  {
    detect: /きょうかい9号|協会9号|熊本酵母|香露/,
    build: () => ({
      body: 'きょうかい9号酵母の通称と分離元として正しい組み合わせはどれか。',
      choices: [
        { body: '熊本酵母／熊本県酒造研究所（香露）', isCorrect: true },
        { body: '真澄酵母／長野・宮坂醸造', isCorrect: false },
        { body: '小川酵母／茨城・明利酒類', isCorrect: false },
        { body: '金沢酵母／石川・金沢国税局', isCorrect: false },
      ],
      explanation: 'きょうかい9号は熊本県酒造研究所（香露）で1953年頃に分離された通称「熊本酵母」。低温長期発酵に向き、吟醸酵母の定番。',
    }),
  },
  {
    detect: /並行複式発酵|糖化と.*発酵.*同時/,
    build: () => ({
      body: '日本酒の発酵様式として正しいものはどれか。',
      choices: [
        { body: '並行複式発酵', isCorrect: true },
        { body: '単式発酵', isCorrect: false },
        { body: '単行複式発酵', isCorrect: false },
        { body: '連続発酵', isCorrect: false },
      ],
      explanation: '日本酒は醪中で麹の酵素による糖化と酵母によるアルコール発酵が同時進行する「並行複式発酵」で、高アルコール度数の酒を造りやすい。',
    }),
  },
  {
    detect: /火入れ|62.*65℃|加熱殺菌/,
    build: () => ({
      body: '日本酒の一般的な火入れの加熱温度帯として正しいものはどれか。',
      choices: [
        { body: '62〜65℃', isCorrect: true },
        { body: '40〜50℃', isCorrect: false },
        { body: '85〜90℃', isCorrect: false },
        { body: '100℃以上', isCorrect: false },
      ],
      explanation: '火入れは火落菌などの微生物を死滅させ酵素反応を止めるため、62〜65℃前後で加熱する。瓶燗火入れは香気成分が揮散しにくいとされる。',
    }),
  },
  {
    detect: /生酒.*火入れなし|火入れ.*0回|なまざけ/,
    build: () => ({
      body: '貯蔵前と瓶詰め時のいずれも火入れを行わない日本酒として正しいのはどれか。',
      choices: [
        { body: '生酒', isCorrect: true },
        { body: '生貯蔵酒', isCorrect: false },
        { body: '生詰め酒', isCorrect: false },
        { body: '一般的な日本酒', isCorrect: false },
      ],
      explanation: '生酒は火入れなし、生貯蔵酒は瓶詰め時に1回、生詰め酒は貯蔵前に1回、一般的な日本酒は2回火入れする。',
    }),
  },
  {
    detect: /菩提酛|室町時代.*正暦寺/,
    build: () => ({
      body: '菩提酛が確立されたとされる時代と寺院として正しい組み合わせはどれか。',
      choices: [
        { body: '室町時代／菩提山正暦寺（奈良）', isCorrect: true },
        { body: '江戸時代／延暦寺', isCorrect: false },
        { body: '鎌倉時代／東大寺', isCorrect: false },
        { body: '平安時代／清水寺', isCorrect: false },
      ],
      explanation: '菩提酛は15世紀（室町時代）に奈良の菩提山正暦寺で確立されたとされる古典的な酒母製法で、生米と炊いた米から得る「そやし水」を使う。',
    }),
  },
  {
    detect: /日本酒度.*ボーメ|ボーメ.*日本酒度/,
    build: () => ({
      body: '日本酒度とボーメの関係式として正しいものはどれか。',
      choices: [
        { body: '日本酒度 = -10 × ボーメ', isCorrect: true },
        { body: '日本酒度 = +10 × ボーメ', isCorrect: false },
        { body: '日本酒度 = ボーメ × 100', isCorrect: false },
        { body: '日本酒度 = ボーメ ÷ 10', isCorrect: false },
      ],
      explanation: '日本酒度はボーメ比重計の値の符号を反転させ10倍したもの。糖分が少なく軽い比重ほど＋（辛口）、重いほど−（甘口）に振れる。',
    }),
  },
  {
    detect: /α化|アルファ化|糊化/,
    build: () => ({
      body: '蒸きょうの主な目的として正しいものはどれか。',
      choices: [
        { body: 'でんぷんをα化して麹菌酵素の作用を受けやすくする', isCorrect: true },
        { body: '米のタンパク質を完全に除去する', isCorrect: false },
        { body: '米の水分を完全に蒸発させる', isCorrect: false },
        { body: '麹菌の胞子を散布する', isCorrect: false },
      ],
      explanation: '蒸きょうは浸漬米を蒸気で加熱しでんぷんをα化（糊化）させ、麹菌酵素の作用を受けやすく、米が溶けやすくする工程。理想は外硬内軟。',
    }),
  },
  {
    detect: /汲水歩合|130%/,
    build: () => ({
      body: '普通酒における汲水歩合の代表値として近いものはどれか。',
      choices: [
        { body: '約130%', isCorrect: true },
        { body: '約70%', isCorrect: false },
        { body: '約20%', isCorrect: false },
        { body: '約50%', isCorrect: false },
      ],
      explanation: '汲水歩合は総米に対する仕込み水の比率で、普通酒で約130%が代表値。歩合を上げると発酵速度が速くなり辛口になりやすい。',
    }),
  },
  // ===== 第3章 =====
  {
    detect: /兵庫県.*山田錦|山田錦.*兵庫/,
    build: () => ({
      body: '山田錦の主産地として最も生産量が多い都道府県はどれか。',
      choices: [
        { body: '兵庫県', isCorrect: true },
        { body: '岡山県', isCorrect: false },
        { body: '新潟県', isCorrect: false },
        { body: '広島県', isCorrect: false },
      ],
      explanation: '山田錦は兵庫県が約60%を占める。特A地区（吉川町、東条など）は最高品質とされ、村米制度という明治期からの契約栽培制度が品質を支える。',
    }),
  },
  {
    detect: /村米制度|特A地区/,
    build: () => ({
      body: '兵庫県で山田錦の品質を支える、明治期から続く契約栽培制度の名称はどれか。',
      choices: [
        { body: '村米制度', isCorrect: true },
        { body: '特A契約', isCorrect: false },
        { body: '杜氏制度', isCorrect: false },
        { body: '蔵元制度', isCorrect: false },
      ],
      explanation: '村米制度は明治時代に始まった、酒造家と特定の村が直接結ぶ山田錦の契約栽培制度。特A地区産の高品質米を支える仕組み。',
    }),
  },
  {
    detect: /丹波杜氏|越後杜氏|南部杜氏/,
    build: () => ({
      body: '日本三大杜氏に数えられる組み合わせとして正しいものはどれか。',
      choices: [
        { body: '南部杜氏・越後杜氏・丹波杜氏', isCorrect: true },
        { body: '南部杜氏・能登杜氏・但馬杜氏', isCorrect: false },
        { body: '越後杜氏・能登杜氏・三津杜氏', isCorrect: false },
        { body: '南部杜氏・越後杜氏・出雲杜氏', isCorrect: false },
      ],
      explanation: '日本三大杜氏は岩手の南部杜氏、新潟の越後杜氏、兵庫の丹波杜氏。丹波杜氏は18世紀中頃に灘へ来た記録が残る。',
    }),
  },
  {
    detect: /五百万石|新潟.*主要|新潟.*酒造好適米/,
    build: () => ({
      body: '五百万石の主産地として最も生産量が多い都道府県はどれか。',
      choices: [
        { body: '新潟県', isCorrect: true },
        { body: '兵庫県', isCorrect: false },
        { body: '長野県', isCorrect: false },
        { body: '福島県', isCorrect: false },
      ],
      explanation: '五百万石は新潟県を主産地とし、富山・福井・福島・石川などでも栽培される。淡麗ですっきりした酒質に向く。',
    }),
  },
  {
    detect: /美山錦|長野県.*酒造好適米/,
    build: () => ({
      body: '美山錦の特徴として正しいものはどれか。',
      choices: [
        { body: '「たかね錦」の突然変異から生まれた長野県の品種', isCorrect: true },
        { body: '「山田錦」と「五百万石」の交配種', isCorrect: false },
        { body: '兵庫県発祥の最古の酒造好適米', isCorrect: false },
        { body: '北海道で開発された短稈品種', isCorrect: false },
      ],
      explanation: '美山錦は1978年に長野県で誕生した、たかね錦の突然変異から生まれた品種。大粒で心白発現率が高く、長野・秋田・山形が主産地。',
    }),
  },
  // ===== 第4章 =====
  {
    detect: /メイラード反応|メラノイジン/,
    build: () => ({
      body: '日本酒の熟成中に色調が黄色～褐色に変化する主な要因として正しいものはどれか。',
      choices: [
        { body: 'メイラード反応によるメラノイジン生成', isCorrect: true },
        { body: '酵母の自己消化', isCorrect: false },
        { body: '空気中の窒素との反応', isCorrect: false },
        { body: '醸造アルコールの酸化', isCorrect: false },
      ],
      explanation: '日本酒の褐変化は糖とアミノ酸が反応するメイラード反応によるメラノイジン生成が主因で、保存温度が高いほど早く進行する。',
    }),
  },
  {
    detect: /蛇の目|きき猪口|ききちょこ/,
    build: () => ({
      body: '利き酒用の「蛇の目猪口」の模様として正しいものはどれか。',
      choices: [
        { body: '白地に藍色の同心円', isCorrect: true },
        { body: '黒地に金色の蛇模様', isCorrect: false },
        { body: '青磁に菊紋', isCorrect: false },
        { body: '赤絵の二重円', isCorrect: false },
      ],
      explanation: '蛇の目猪口は白地に藍色の同心円が描かれ、白い部分で日本酒の黄色みを、青い部分で白濁の度合いを確認できる。',
    }),
  },
  {
    detect: /カプロン酸エチル|リンゴ.*香|香り酵母/,
    build: () => ({
      body: '香り酵母（セルレニン耐性酵母）が高生産する、リンゴ様の吟醸香成分として正しいものはどれか。',
      choices: [
        { body: 'カプロン酸エチル', isCorrect: true },
        { body: '酢酸イソアミル', isCorrect: false },
        { body: 'リナロール', isCorrect: false },
        { body: 'ジアセチル', isCorrect: false },
      ],
      explanation: 'セルレニン耐性酵母（カプロン酸エチル高生産酵母）はリンゴ様の華やかな吟醸香を生み、1990年代中期から急速に普及した。',
    }),
  },
  // ===== 第5章 =====
  {
    detect: /冷酒.*5|花冷え.*10|涼冷え.*15/,
    build: () => ({
      body: '日本酒の温度表現として「花冷え」が指す温度帯はどれか。',
      choices: [
        { body: '10℃前後', isCorrect: true },
        { body: '5℃前後', isCorrect: false },
        { body: '15℃前後', isCorrect: false },
        { body: '20℃前後', isCorrect: false },
      ],
      explanation: '日本酒の温度表現は雪冷え（5℃）、花冷え（10℃）、涼冷え（15℃）、冷や（常温20℃前後）、日向燗（30℃）、人肌燗（35℃）、ぬる燗（40℃）、上燗（45℃）、熱燗（50℃）、飛切燗（55℃以上）。',
    }),
  },
  {
    detect: /熱燗.*50|上燗.*45|ぬる燗.*40/,
    build: () => ({
      body: '日本酒の温度表現として「ぬる燗」が指す温度はおよそ何℃か。',
      choices: [
        { body: '40℃前後', isCorrect: true },
        { body: '30℃前後', isCorrect: false },
        { body: '50℃前後', isCorrect: false },
        { body: '55℃以上', isCorrect: false },
      ],
      explanation: '日本酒の燗温度は日向燗（30℃）、人肌燗（35℃）、ぬる燗（40℃）、上燗（45℃）、熱燗（50℃）、飛切燗（55℃以上）と呼ばれる。',
    }),
  },
  // ===== 第6章 ペアリング =====
  {
    detect: /貴醸酒|フォアグラ|フォワグラ/,
    build: () => ({
      body: 'フォワグラのテリーヌに合わせる日本酒として推奨されるのはどれか。',
      choices: [
        { body: '貴醸酒', isCorrect: true },
        { body: '純米吟醸酒（軽快タイプ）', isCorrect: false },
        { body: '本醸造の燗', isCorrect: false },
        { body: 'にごり酒', isCorrect: false },
      ],
      explanation: 'フォワグラのテリーヌには蜂蜜のような甘さの貴醸酒が推奨され、濃厚な脂肪分とまろやかな甘味が調和する。',
    }),
  },
  // ===== 第7章 焼酎 =====
  {
    detect: /黒糖焼酎|奄美/,
    build: () => ({
      body: '黒糖焼酎の生産が法令上認められている地域として正しいものはどれか。',
      choices: [
        { body: '奄美群島のみ', isCorrect: true },
        { body: '沖縄全域', isCorrect: false },
        { body: '鹿児島県全域', isCorrect: false },
        { body: '九州全域', isCorrect: false },
      ],
      explanation: '黒糖焼酎は米麹で一次醪を造ったうえで黒糖を加えて二次醪を仕込む焼酎で、奄美群島のみで生産が認められている。',
    }),
  },
  {
    detect: /泡盛|黒麹|琉球|タイ米/,
    build: () => ({
      body: '泡盛の特徴として正しいものはどれか。',
      choices: [
        { body: '米全量を黒麹で仕込む', isCorrect: true },
        { body: '麦麹で仕込み黒糖を加える', isCorrect: false },
        { body: '芋麹のみを使用する', isCorrect: false },
        { body: '白麹で全量仕込む', isCorrect: false },
      ],
      explanation: '泡盛は米全量を黒麹菌で仕込む全麹仕込みが特徴で、原料米はインディカ種のタイ米が用いられることが多い。',
    }),
  },
  {
    detect: /地理的表示.*焼酎|GI.*壱岐.*球磨/,
    build: () => ({
      body: '焼酎の地理的表示（GI）として指定されている産地に該当しないものはどれか。',
      choices: [
        { body: '伊豆', isCorrect: true },
        { body: '壱岐', isCorrect: false },
        { body: '球磨', isCorrect: false },
        { body: '琉球', isCorrect: false },
      ],
      explanation: '焼酎の地理的表示には壱岐（麦）、球磨（米）、琉球（泡盛）、薩摩（甘藷）、東京島酒が指定されている。「伊豆」は単独のGIとしては指定されていない。',
    }),
  },
  {
    detect: /球磨焼酎|人吉/,
    build: () => ({
      body: '米焼酎「球磨焼酎」の主産地として正しいものはどれか。',
      choices: [
        { body: '熊本県人吉地方', isCorrect: true },
        { body: '宮崎県高千穂地方', isCorrect: false },
        { body: '鹿児島県奄美群島', isCorrect: false },
        { body: '長崎県壱岐島', isCorrect: false },
      ],
      explanation: '球磨焼酎は熊本県人吉地方を主産地とする米焼酎で、地理的表示「球磨」が指定されている。減圧蒸留のライトタイプが多い。',
    }),
  },
  {
    detect: /壱岐.*麦焼酎|麦焼酎.*壱岐/,
    build: () => ({
      body: '地理的表示「壱岐」の対象焼酎として正しいものはどれか。',
      choices: [
        { body: '麦焼酎（米麹仕込み）', isCorrect: true },
        { body: '甘藷焼酎', isCorrect: false },
        { body: '黒糖焼酎', isCorrect: false },
        { body: '泡盛', isCorrect: false },
      ],
      explanation: '長崎県壱岐島は麦焼酎発祥の地とされ、米麹を使用する点が特徴。地理的表示「壱岐」が指定されている。',
    }),
  },
  {
    detect: /常圧蒸留|減圧蒸留/,
    build: () => ({
      body: '減圧蒸留の特徴として正しいものはどれか。',
      choices: [
        { body: '低温（45〜55℃）で蒸留され軽快な香味になりやすい', isCorrect: true },
        { body: '高温（85〜95℃）で蒸留され香ばしい香味になる', isCorrect: false },
        { body: '蒸留器内を加圧することで香気成分を凝縮させる', isCorrect: false },
        { body: '蒸留せずに濾過のみ行う', isCorrect: false },
      ],
      explanation: '減圧蒸留は減圧下で沸点を下げて45〜55℃で蒸留する方式。果物様のフレッシュで軽快な香味になる。常圧蒸留は85〜95℃で香ばしさが強い。',
    }),
  },
  {
    detect: /クエン酸|焼酎麹|黒麹.*白麹/,
    build: () => ({
      body: '焼酎麹（黒麹・白麹）が多く生産する有機酸として正しいものはどれか。',
      choices: [
        { body: 'クエン酸', isCorrect: true },
        { body: '乳酸', isCorrect: false },
        { body: '酢酸', isCorrect: false },
        { body: 'リンゴ酸', isCorrect: false },
      ],
      explanation: '焼酎麹（黒麹・白麹）はクエン酸を多く生産することで雑菌汚染を防ぎ、温暖な九州・南西諸島での醸造を可能にしている。',
    }),
  },
  {
    detect: /一次醪|二次醪/,
    build: () => ({
      body: '焼酎造りで日本酒の「酒母」「醪」に相当する呼称として正しい組み合わせはどれか。',
      choices: [
        { body: '一次醪／二次醪', isCorrect: true },
        { body: '酒母／醪', isCorrect: false },
        { body: '前醪／後醪', isCorrect: false },
        { body: '初仕込／本仕込', isCorrect: false },
      ],
      explanation: '焼酎では酒母にあたる工程を「一次醪」、醪にあたる工程を「二次醪」と呼ぶ。麹は全量一次醪に投入し、主原料は二次醪で投入する。',
    }),
  },
  // ===== 第8章 =====
  {
    detect: /黒糖焼酎.*すき焼き|奄美黒糖.*割り下/,
    build: () => ({
      body: '黒糖焼酎とすき焼きの相性が良いとされる主な理由はどれか。',
      choices: [
        { body: '黒糖の香りが割り下の風味に広がりと深みを与えるため', isCorrect: true },
        { body: '酸味が肉の脂を切るため', isCorrect: false },
        { body: 'スモーキーな樽香が肉の旨味を増幅するため', isCorrect: false },
        { body: '高アルコールが肉の臭みを消すため', isCorrect: false },
      ],
      explanation: 'すき焼きの割り下は濃口醤油・味醂・砂糖を使うため、同じく甘い香りを持つ黒糖焼酎が風味を広げ深みを与える。お湯割りが推奨される。',
    }),
  },
];

function tryFreshFromExplanation(q, seed) {
  const text = (q.explanation || '') + ' ' + q.questionBody + ' ' + q.correctAnswer;
  for (const tpl of FRESH_TEMPLATES) {
    if (tpl.detect.test(text)) {
      const built = tpl.build();
      // 既存問題と問題文が完全一致する場合はスキップ
      if (built.body.trim() === q.questionBody.trim()) continue;
      return built;
    }
  }
  return null;
}

// ---------- タイプ割当 ----------
function pickTransformType(q) {
  // 決定的：questionId のハッシュからタイプを決める
  const r = seededRand(q.questionId);
  const v = r();
  // 配分目標：A=40%（構文書き換え）、B=45%（強制反転で正答が変わる）、C=15%（新規生成）
  const cat = q.category;
  let aP = 0.40, bP = 0.45;
  if (/第3章/.test(cat)) { aP = 0.30; bP = 0.55; }   // 数値・地域系は反転しやすい
  else if (/第2章/.test(cat)) { aP = 0.40; bP = 0.45; }
  else if (/第6章|第8章/.test(cat)) { aP = 0.50; bP = 0.40; } // ペアリングは事実型多い
  if (v < aP) return 'A';
  if (v < aP + bP) return 'B';
  return 'C';
}

// ---------- 主変換 ----------
function transform(q) {
  const type = pickTransformType(q);
  const seed = q.questionId;

  if (type === 'C') {
    const fresh = tryFreshFromExplanation(q, seed);
    if (fresh) {
      return buildOut(q, 'C', {
        body: fresh.body,
        choices: shuffleDeterministic(fresh.choices, seed + ':freshorder'),
        explanation: fresh.explanation,
      });
    }
    // フォールバック → B
  }

  if (type === 'B' || type === 'C') {
    // まず単純な「正しい→誤っている」反転（問題文に該当パターンがある場合）
    const inv = tryInvertCorrectness(q, seed);
    if (inv) {
      const exp = rewriteExplanation(q.explanation) + (inv.explanationSuffix ? ' ' + inv.explanationSuffix : '');
      return buildOut(q, 'B', {
        body: inv.body,
        choices: shuffleDeterministic(inv.choices, seed + ':invorder'),
        explanation: exp,
      });
    }
    // 強制反転：あらゆる問題で正答→不正答に変える
    const forced = forceInvertGeneric(q, seed);
    if (forced) {
      const exp = rewriteExplanation(q.explanation) + ' ' + forced.explanationSuffix;
      return buildOut(q, 'B', {
        body: forced.body,
        choices: shuffleDeterministic(forced.choices, seed + ':forceorder'),
        explanation: exp,
      });
    }
    // フォールバック → A
  }

  // Type A：問題文構文を完全に書き換え＋選択肢シャッフル＋解説リライト
  const newChoices = shuffleDeterministic(
    q.choices.map(c => ({ body: c.body, isCorrect: c.isCorrect })),
    seed + ':aorder'
  );
  return buildOut(q, 'A', {
    body: rewriteQuestion(q.questionBody, seed),
    choices: newChoices,
    explanation: rewriteExplanation(q.explanation),
  });
}

function buildOut(orig, transformType, repl) {
  const correct = repl.choices.find(c => c.isCorrect);
  return {
    questionId: 'v2-' + orig.questionId,
    originalQuestionId: orig.questionId,
    transform: transformType,
    category: orig.category,
    title: orig.title,
    questionBody: repl.body,
    difficulty: orig.difficulty,
    correctAnswer: correct ? correct.body : '',
    choices: repl.choices.map(c => ({ body: c.body, isCorrect: c.isCorrect })),
    explanation: repl.explanation,
    referencePage: orig.referencePage,
  };
}

// ---------- CSV ----------
function toCsvField(v) {
  if (v === null || v === undefined) return '""';
  const s = String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function buildCsv(rows) {
  const header = ['#','カテゴリ','タイトル','問題文','難易度','正答','選択肢1','選択肢2','選択肢3','選択肢4','解説','教本ページ','変換タイプ','元questionId','questionId'];
  const lines = [header.map(toCsvField).join(',')];
  rows.forEach((q, i) => {
    const cs = (q.choices || []).map(c => c.body);
    while (cs.length < 4) cs.push('');
    lines.push([
      i + 1,
      q.category,
      q.title,
      q.questionBody,
      q.difficulty,
      q.correctAnswer,
      cs[0], cs[1], cs[2], cs[3],
      q.explanation,
      q.referencePage,
      q.transform,
      q.originalQuestionId,
      q.questionId,
    ].map(toCsvField).join(','));
  });
  return lines.join('\n');
}

// ---------- Main ----------
function main() {
  const lines = fs.readFileSync(SRC, 'utf-8').trim().split('\n');
  const out = [];
  const log = { total: 0, byType: { A: 0, B: 0, C: 0 }, byCategory: {} };

  for (const line of lines) {
    const q = JSON.parse(line);
    const v2 = transform(q);

    // 整合性チェック
    if (!v2.choices.find(c => c.isCorrect)) {
      console.warn('No correct choice:', q.questionId);
      continue;
    }
    if (v2.choices.length !== 4) {
      console.warn('Choices count != 4:', q.questionId, v2.choices.length);
    }

    out.push(v2);
    log.total++;
    log.byType[v2.transform] = (log.byType[v2.transform] || 0) + 1;
    log.byCategory[v2.category] = log.byCategory[v2.category] || { A: 0, B: 0, C: 0 };
    log.byCategory[v2.category][v2.transform]++;
  }

  fs.writeFileSync(OUT_JSONL, out.map(o => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(OUT_CSV, buildCsv(out));
  fs.writeFileSync(OUT_LOG, JSON.stringify(log, null, 2));

  // 比較ページ用の JSON 配列も書き出し
  fs.writeFileSync(path.join(OUT_DIR, 'all_questions_v2.json'), JSON.stringify(out));

  // 元データも JSON 配列に変換（CORS対策の同梱用）
  const origPath = path.resolve(__dirname, '../data/all_questions.json');
  const orig = lines.map(l => JSON.parse(l));
  fs.writeFileSync(origPath, JSON.stringify(orig));

  console.log('Generated:', out.length, 'questions');
  console.log('By type:', log.byType);
  console.log('By category:');
  for (const [k, v] of Object.entries(log.byCategory).sort()) {
    console.log('  ' + k + ': A=' + v.A + ' B=' + v.B + ' C=' + v.C);
  }
}

main();
