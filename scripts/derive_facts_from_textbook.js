#!/usr/bin/env node
/**
 * textbook_content.json を上流ソースとして、知識ポイント（facts.json）を派生生成する。
 * これにより、ルール T-1〜T-5 を満たした教本ファクトを直接 facts.json に反映できる。
 *
 * 上流: data/v3/textbook_content.json
 * 下流: data/v3/facts.json
 */

const fs = require('fs');
const path = require('path');

const TEXTBOOK = path.resolve(__dirname, '../data/v3/textbook_content.json');
const OUT = path.resolve(__dirname, '../data/v3/facts.json');

// L-8: 不自然なスペース除去
//   OCR で漢字+改行+ひらがな のような空白挿入が頻出するため、文中の不自然な空白を除去
function cleanWhitespace(s) {
  if (!s) return s;
  let t = String(s);
  // 漢字+空白+ひらがな・カタカナ → 空白除去
  t = t.replace(/([一-鿿々])[ 　]+([ぁ-んァ-ヴー])/g, '$1$2');
  // ひらがな+空白+ひらがな → 空白除去
  t = t.replace(/([ぁ-ん])[ 　]+([ぁ-ん])/g, '$1$2');
  // カタカナ+空白+ひらがな → 空白除去
  t = t.replace(/([ァ-ヴー])[ 　]+([ぁ-ん])/g, '$1$2');
  // ひらがな+空白+漢字 → 空白除去
  t = t.replace(/([ぁ-ん])[ 　]+([一-鿿々])/g, '$1$2');
  // 漢字+空白+漢字 → 空白除去（保持例外: 引用直後の英数）
  t = t.replace(/([一-鿿々])[ 　]+([一-鿿々])/g, '$1$2');
  // 句読点・括弧前後の不要な空白
  t = t.replace(/[ 　]+([、。，．])/g, '$1');
  t = t.replace(/([「『（(])[ 　]+/g, '$1');
  t = t.replace(/[ 　]+([」』）)])/g, '$1');
  // 連続する空白を1つに
  t = t.replace(/[ 　]{2,}/g, ' ');
  return t.trim();
}

function detectFactType(value) {
  const v = String(value || '').trim();
  if (/^\d{3,4}年|\d{2,4}世紀/.test(v)) return 'year';
  if (/^[\d０-９,\.〜～\-]+\s*(?:%|％|kl|度|年|日|時間|分|m|cm|km|kg|g|℃|号|t|トン|ppm)?$/.test(v)) return 'number';
  if (/(氏|衛門|郎|介|蔵|親|甚造|金一郎|鹿又|岸本|嘉儀|山邑|太左衛門|三浦仙三郎|矢部|野白)$/.test(v) && v.length <= 12) return 'person';
  if (/(?:県|府|都|道|市|村|町|地方|地域|諸島|半島|島|国)$/.test(v) && v.length <= 12) return 'place';
  if (/(?:酒|焼酎|酵母|麹|米|蔵|樽|寺|神社)$/.test(v) && v.length <= 20) return 'name';
  return 'term';
}

// K-5: 試験対象外コンテンツの除外判定
function isExamRelevantPage(page) {
  const chapter = (page.chapter || '').trim();
  const section = (page.section || '').trim();
  const title = (page.title || '').trim();
  // 章ベースの除外: 前付・巻末
  if (/^(前付|巻末)/.test(chapter)) return false;
  // セクションベースの除外: 参考文献・索引・奥付・凡例・はじめに・序文
  if (/(参考文献|索引|奥付|凡例|はじめに|序文)/.test(section)) return false;
  // タイトルベースの除外
  if (/(参考文献|索引|奥付)/.test(title)) return false;
  return true;
}

function main() {
  const tb = JSON.parse(fs.readFileSync(TEXTBOOK, 'utf-8'));
  const facts = [];
  let counter = 0;

  let skippedDrafts = 0;
  let skippedExamIrrelevant = 0;
  let skippedExamIrrelevantPages = 0;
  for (const [pageStr, page] of Object.entries(tb.pages)) {
    const pageNum = parseInt(pageStr, 10);
    if (!page.facts || !page.facts.length) continue;
    if (page.draft) { skippedDrafts += page.facts.length; continue; } // 下書きページはスキップ
    // K-5: 試験対象外ページを除外
    if (!isExamRelevantPage(page)) {
      skippedExamIrrelevant += page.facts.length;
      skippedExamIrrelevantPages++;
      continue;
    }
    for (const f of page.facts) {
      if (f.draft) { skippedDrafts++; continue; }
      counter++;
      const cleanedValue = cleanWhitespace(f.fact);
      facts.push({
        id: 'f-tb-' + counter,
        category: page.chapter + ' ' + (page.section || ''),
        title: page.title || '',
        referencePage: pageNum,
        importance: 3,
        source: 'textbook',
        sourceRef: `p${pageNum}`,
        verified: true,
        fact: {
          value: cleanedValue,
          type: detectFactType(cleanedValue),
          rawText: cleanWhitespace(f.rawText || ''),
        },
      });
    }
  }
  console.log('Skipped draft facts:', skippedDrafts);
  console.log('Skipped exam-irrelevant facts (K-5):', skippedExamIrrelevant, '(' + skippedExamIrrelevantPages + ' pages)');

  console.log('Total facts derived:', facts.length);
  fs.writeFileSync(OUT, JSON.stringify(facts, null, 0));
  console.log('Written:', OUT);

  // L-7: 自動チェック実行
  console.log('\n--- 日本語品質チェック (L-1〜L-6) ---');
  try {
    require('child_process').execFileSync('node', [path.resolve(__dirname, 'check_japanese_quality.js')], { stdio: 'inherit' });
  } catch (e) {
    console.log('⚠️ 重大違反あり。修正してください。');
    process.exit(1);
  }
}

// 汎用語ブラックリスト（K-2 / L-4）
const GENERIC_SUBJECTS = [
  '日本酒', '清酒', '酒造り', '焼酎', '麹', '酵母', '歴史', '気候',
  '温度', '品種', '生産量', '産地', '微生物', '記述', '内容', 'もの',
  'こと', '酒', '水', '米', '工程',
  '近年', '現在', '当時', '将来', '過去', '通常', '一般', '結果',
  'pH',
];

// 候補が L-1/L-2/L-3/L-4 を満たすか判定
function isValidSubject(s) {
  if (!s) return false;
  if (s.length < 2 || s.length > 20) return false; // 2文字以上20文字以下
  if (GENERIC_SUBJECTS.includes(s)) return false;
  // 末尾助詞（固有名詞末尾を除外）
  if (/[がはをにでとへの]$/.test(s) && !/[氏県府都道社寺]$/.test(s.slice(0, -1))) return false;
  if (/(?:しかし|または|あるいは|ただし|なお|さらに)$/.test(s)) return false;
  if (/(?:について|に関する)$/.test(s)) return false;
  // 末尾が読点
  if (/[、，,]$/.test(s)) return false;
  // 鉤括弧の整合性
  const br = (open, close) => {
    let o = 0, c = 0;
    for (const ch of s) { if (ch === open) o++; if (ch === close) c++; }
    return o === c;
  };
  if (!br('「', '」')) return false;
  if (!br('『', '』')) return false;
  if (!br('（', '）')) return false;
  if (!br('(', ')')) return false;
  return true;
}

// L-1/L-2/L-3/L-4 を満たす形で主題を抽出
function extractSubject(factText) {
  const t = String(factText || '').trim();
  if (!t) return '';

  // 候補リスト（優先順位順）
  const candidates = [];

  // 候補S0: 「Xとは」パターン → 「Xの定義」
  const cS0 = t.match(/^([一-鿿ぁ-んァ-ヴー・]{1,15})とは/);
  if (cS0) candidates.push(`${cS0[1]}の定義`);

  // 候補A: 文頭固有名詞（鉤括弧で囲まれている）
  const cA = t.match(/^「([^」]{2,18})」/);
  if (cA) candidates.push(`「${cA[1]}」`);

  // 候補B: 「○○の○○」（属格2連）まで取る（より具体的）
  const cB = t.match(/^([一-鿿ぁ-んァ-ヴ]{2,8})の([一-鿿ぁ-んァ-ヴ・「」「」]{2,12})(?=は|が|を|に|で|と)/);
  if (cB) {
    const s = `${cB[1]}の${cB[2]}`;
    if (s.length <= 20) candidates.push(s);
  }

  // 候補C: 「○○の○○」属格1連（より短く）。長い助詞を先に試す
  const cC = t.match(/^([^。、]{3,18}?)(?:では|には|とは|は|が)/);
  if (cC) candidates.push(cC[1]);

  // 候補D: 文頭名詞句（カタカナ＋漢字のまとまり）
  const cD = t.match(/^([一-鿿ぁ-んァ-ヴー・]{3,18})/);
  if (cD) candidates.push(cD[1]);

  // 候補E: 「X時代」「X世紀」「X年」が含まれる場合は「Xの○○」を優先
  const cE = t.match(/^[^。、]{0,5}(?:は|が|では|とは)?[^。、]*?(弥生時代|奈良時代|平安時代|鎌倉時代|室町時代|江戸時代|明治時代|大正時代|昭和時代|平成時代|令和時代|\d{3,4}年|\d{1,2}世紀)/);
  if (cE) {
    // 文頭の主題と時代を組み合わせる
    const m = t.match(/^([一-鿿ぁ-んァ-ヴー・]{2,10})(?:は|が)/);
    if (m) {
      candidates.push(`${cE[1]}の${m[1]}`);
    }
  }

  // 各候補に対して、末尾の助詞や読点を取り除いた変形も試す
  const variants = [];
  for (const c of candidates) {
    variants.push(c);
    const clean1 = c.replace(/[、,。．\s]+$/, '');
    if (clean1 !== c) variants.push(clean1);
    // 複合助詞も剥がす（では/には/とは/への）
    const clean2 = clean1.replace(/(?:では|には|とは|への|から|まで)$/, '');
    if (clean2 !== clean1) variants.push(clean2);
    // 単独助詞
    const clean3 = clean2.replace(/[がはをにでとへの]+$/, '');
    if (clean3 !== clean2) variants.push(clean3);
    const clean4 = clean3.replace(/(?:について|に関する)$/, '');
    if (clean4 !== clean3) variants.push(clean4);
  }

  // 有効な候補を選ぶ
  for (const v of variants) {
    if (isValidSubject(v)) return v;
  }

  // フォールバック1: 主題が generic な場合、value 内の鍵語と組み合わせる
  const headSubjMatch = t.match(/^([一-鿿ぁ-んァ-ヴー・]{2,8}?)(?:では|には|とは|は|が|の)/);
  const headSubj = headSubjMatch ? headSubjMatch[1] : null;
  if (headSubj && (GENERIC_SUBJECTS.includes(headSubj) || /^(?:近年|現在|当時|通常|一般|結果)$/.test(headSubj))) {
    // value 内の鍵語（時代・場所・要素）を見つけて結合
    const eraMatch = t.match(/(弥生時代|奈良時代|平安時代|鎌倉時代|室町時代|江戸時代|明治時代|大正時代|昭和時代|平成時代|令和時代)/);
    const yearMatch = t.match(/(\d{3,4})\s*年/);
    const placeMatch = t.match(/([一-鿿]{2,4}(?:県|府|都|地方))/);
    const keyTerm = t.match(/「([^」]{2,12})」/);
    // 「一に X、二に Y、三に Z」パターン
    const tripleRanking = t.match(/一に([一-鿿]{1,5})、二に([一-鿿]{1,5})/);
    // 「3年未満」「5年未満」パターン
    const ageMatch = t.match(/(\d+年(?:未満|以上|前後))/);
    // 「Xを使用する」「Xに使用する」用途パターン
    const useMatch = t.match(/(?:を|に)([一-鿿ぁ-んァ-ヴ]{2,8})する/);

    let combined = null;
    if (tripleRanking) combined = `${headSubj}の三要素`;
    else if (eraMatch) combined = `${eraMatch[1]}の${headSubj}`;
    else if (yearMatch) combined = `${yearMatch[1]}年の${headSubj}`;
    else if (placeMatch) combined = `${placeMatch[1]}の${headSubj}`;
    else if (ageMatch) combined = `${ageMatch[1]}の${headSubj}`;
    else if (keyTerm && keyTerm[1].length <= 8) combined = `${headSubj}と${keyTerm[1]}`;
    else if (useMatch) combined = `${headSubj}と${useMatch[1]}`;
    // それでも候補なし → headSubj + "の特徴" のような汎用記述
    if (!combined) {
      // value から最長の漢字フレーズを抽出
      const longChunks = [...t.matchAll(/[一-鿿]{4,12}/g)].map(m => m[0]);
      const meaningful = longChunks.find(c => !GENERIC_SUBJECTS.includes(c));
      if (meaningful) combined = `${headSubj}と${meaningful}`;
    }
    if (combined && combined.length <= 25 && isValidSubject(combined)) return combined;
  }

  // フォールバック2: 先頭から名詞句を切り出して整形
  let fallback = t.slice(0, 25);
  const cutAt = fallback.search(/[、，,。．「]/);
  if (cutAt > 2) fallback = fallback.slice(0, cutAt);
  fallback = fallback
    .replace(/(?:について|に関する)$/, '')
    .replace(/(?:では|には|とは|への|から|まで)$/, '')
    .replace(/[がはをにでとへの]+$/, '')
    .replace(/[、,。．\s]+$/, '');

  // フォールバック3: それでも generic なら value から特徴的な語を選ぶ
  if (GENERIC_SUBJECTS.includes(fallback) || fallback.length < 2) {
    const keyTerm = t.match(/「([^」]{2,15})」/);
    if (keyTerm) return `「${keyTerm[1]}」`;
    const longest = t.match(/([一-鿿ぁ-んァ-ヴー・]{4,15})/);
    if (longest) return longest[1];
    return fallback || t.slice(0, 10);
  }

  if (fallback.length > 25) fallback = fallback.slice(0, 22) + '…';
  return fallback;
}

// L-1: 鉤括弧・丸括弧の整合性を保つ。
//   - 開きが余る → 該当開き位置で切り捨てる（先頭の「」は剥がす）
//   - 閉じが余る → その閉じ文字を削除する
function cleanSubject(subject) {
  let s = String(subject || '').trim();
  if (!s) return s;

  s = s.replace(/[、,。．]+$/, '');

  const fixBrackets = (openChars, closeChars) => {
    const openClass = '[' + openChars.split('').join('') + ']';
    const closeClass = '[' + closeChars.split('').join('') + ']';
    const openRe = new RegExp(openClass, 'g');
    const closeRe = new RegExp(closeClass, 'g');
    let opens = [...s.matchAll(openRe)].map(m => m.index);
    let closes = [...s.matchAll(closeRe)].map(m => m.index);

    if (opens.length > closes.length) {
      // 余分な開きを除去：先頭にあれば剥がす、中間以降にあれば末尾を切る
      const diff = opens.length - closes.length;
      for (let i = 0; i < diff; i++) {
        const updatedOpens = [...s.matchAll(openRe)].map(m => m.index);
        const updatedCloses = [...s.matchAll(closeRe)].map(m => m.index);
        if (updatedOpens.length === 0) break;
        // 「対応されていない開き」を見つける（閉じが対応していないもの）
        // 単純化: 開きを末尾から見て、それ以降に閉じがなければアンバランス
        let unbalanced = -1;
        for (let k = updatedOpens.length - 1; k >= 0; k--) {
          const oIdx = updatedOpens[k];
          if (!updatedCloses.some(cIdx => cIdx > oIdx)) {
            unbalanced = oIdx;
            break;
          }
        }
        if (unbalanced < 0) unbalanced = updatedOpens[updatedOpens.length - 1];

        if (unbalanced === 0) {
          // 先頭の余分な開き → 剥がす
          s = s.slice(1);
        } else {
          // 中間以降の余分な開き → そこで切り捨てる
          s = s.slice(0, unbalanced);
        }
      }
    } else if (closes.length > opens.length) {
      // 余分な閉じを削除（最も外側の余分なものを削る）
      const diff = closes.length - opens.length;
      for (let i = 0; i < diff; i++) {
        const updatedOpens = [...s.matchAll(openRe)].map(m => m.index);
        const updatedCloses = [...s.matchAll(closeRe)].map(m => m.index);
        if (updatedCloses.length === 0) break;
        // 「対応されていない閉じ」: 開きより前にある閉じ
        let unbalanced = -1;
        for (let k = 0; k < updatedCloses.length; k++) {
          const cIdx = updatedCloses[k];
          if (!updatedOpens.some(oIdx => oIdx < cIdx)) {
            unbalanced = cIdx;
            break;
          }
        }
        if (unbalanced < 0) unbalanced = updatedCloses[0];
        s = s.slice(0, unbalanced) + s.slice(unbalanced + 1);
      }
    }
  };
  fixBrackets('「『', '」』');
  fixBrackets('（(', '）)');

  s = s.replace(/[、,。．\s]+$/, '');
  return s;
}

if (require.main === module) main();
module.exports = { cleanSubject, extractSubject, cleanWhitespace };
