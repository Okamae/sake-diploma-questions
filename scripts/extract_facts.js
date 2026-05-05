#!/usr/bin/env node
/**
 * 知識ファクト抽出スクリプト（厳格版）
 *
 * 方針：
 *   1. 手書きの core_facts.json を最優先で土台に置く（verified=true）
 *   2. まとめノートHTMLからの自動抽出は「文脈を含む表抽出」のみ採用
 *      （表のh2/h3見出し + 行キー + 列ヘッダーで subject を構築）
 *   3. 既存問題集の解説文からの抽出は採用しない（subject不明瞭になりがちなため）
 *   4. 全ての自動抽出ファクトに「品質チェック」を通し、合格したものだけ採用
 *
 * 入力: data/v3/core_facts.json, /Users/ryosuke/Downloads/.../酒学道場のまとめノート (1)/*.html
 * 出力: data/v3/facts.json, data/v3/facts_log.md
 */

const fs = require('fs');
const path = require('path');

const CORE = path.resolve(__dirname, '../data/v3/core_facts.json');
const NOTES_DIR = '/Users/ryosuke/Downloads/Private & Shared 2/酒学道場のまとめノート (1)';
const OUT_DIR = path.resolve(__dirname, '../data/v3');
const OUT_FACTS = path.join(OUT_DIR, 'facts.json');
const OUT_LOG = path.join(OUT_DIR, 'facts_log.md');

// =============================================================================
// 検証ルール：subject／attribute／value の妥当性
// =============================================================================

// subject 単独で意味が通らない汎用語（NG）
const GENERIC_SUBJECTS = new Set([
  '微生物', '酒造り', '日本酒', '焼酎', '泡盛', '麹', '酵母', '蒸留',
  '製造', '原料', '主原料', '酒質', '気候', '温度', '時期', '時間',
  '品種', '生産量', '産地', '記述', '属性', '内容', '特徴', '効果',
  '工程', '製法', '使用', '配合', '比率', '割合', '頃', '当時', '近年',
  '今後', '将来', '現在', '過去', '一般細菌', '乳酸菌', 'カビ',
  '日本酒度', 'ボーメ', 'pH値', '醸造', '発酵', '糖化',
  '工程フロー', '主要', '代表', '主な', 'その他', '一般',
  '酒蔵', '蔵', '杜氏', '酒造家',
  '順位', '品種名', '生産量', '酒質', '備考', '出来事', '時代',
  '冷酒', '燗', '常温', '冷や',
]);

// attribute 単独で意味が通らない汎用語（NG）
const GENERIC_ATTRIBUTES = new Set([
  '記述', '属性', '年代', '時期', '数値', '状態', '内容', '特徴',
  '効果', '頃', '理由', '結果', '関係', '影響', '備考', '原料',
  '出来事', '対象', '名称', '時間', '日数',
]);

// 行キーが汎用的な場合、文脈で補強する必要がある
const GENERIC_ROW_KEYS = new Set([
  '順位', 'Type', 'タイプ', '項目', '時間', '時期', '段階', '日付', '日',
  '朝', '昼', '夜', '深夜', '夕方', '名称', '備考', '酒類',
  '時代', '年代', '記述',
]);

// テーブルの直前見出しが汎用的すぎるケース（subject に組み込まない）
const GENERIC_HEADINGS = new Set([
  '図表', '図表まとめ', '主要表', '一覧', '比較表', '一覧表',
  '章末問題', '問題', '解説', '注意',
]);

// value が汎用語のみで意味が通らない（NG）
const GENERIC_VALUES_PATTERN = /^(?:あり|なし|有|無|可|不可|要|不要|多い|少ない|高い|低い|長い|短い|強い|弱い|大きい|小さい|良い|悪い|普通|特殊|重要|主要|代表|一般|その他|その一|その他|備考)$/;

function isValidSubject(s) {
  if (!s || typeof s !== 'string') return false;
  s = s.trim();
  if (s.length < 4) return false;          // 短すぎ
  if (s.length > 80) return false;         // 長すぎ
  if (GENERIC_SUBJECTS.has(s)) return false;
  // 数字のみ
  if (/^[\d０-９,\.\s]+$/.test(s)) return false;
  // 句読点のみ
  if (/^[、。・,.\s]+$/.test(s)) return false;
  // 助詞で始まる
  if (/^[をはがにとでもの、,]/.test(s)) return false;
  // 動詞末尾（不完全な文の切れ端）
  if (/(?:を行った|が起きた|を開発した|に関連する|が分離された|を発見した)$/.test(s)) return false;
  // 「Xの○○」「○○における△△」型の複合主題は OK
  // 単独の固有名詞だけだと検証で弾かれるが、既知の重要トピックは通す
  return true;
}

function isValidAttribute(a) {
  if (!a || typeof a !== 'string') return true; // attribute は空でも一応OK（subjectで識別できる場合）
  a = a.trim();
  if (a.length < 2) return false;
  if (GENERIC_ATTRIBUTES.has(a)) return false;
  // ○記号や符号のみ
  if (/^[―\-=•・]+$/.test(a)) return false;
  return true;
}

function isValidValue(v) {
  if (!v || typeof v !== 'string') return false;
  v = v.trim();
  if (v.length < 1) return false;
  if (v.length > 200) return false;
  if (/^[、。・,.\s\-=]+$/.test(v)) return false;
  if (GENERIC_VALUES_PATTERN.test(v)) return false;
  // 助詞・接続詞で始まる断片
  if (/^[、，,。．をはがにとでものうえおから、]/.test(v)) return false;
  return true;
}

// 三組セットでの妥当性（subject + attribute + value で意味を成すか）
function isMeaningfulFact(subject, attribute, value) {
  // subject + attribute だけで「何を問う質問になるか」シミュレート
  // ex) subject="酵母", attribute="記述", value="30℃" → 何を問うのか不明
  // ex) subject="日本酒酵母の最適増殖温度", attribute="温度", value="8〜17℃" → OK

  // subject が単一固有名詞のみで attribute が汎用 or 空なら NG
  const subjectIsSimpleProperNoun = !/[のにおける関するでとして]/.test(subject) && subject.length < 10;
  if (subjectIsSimpleProperNoun) {
    if (!attribute || GENERIC_ATTRIBUTES.has(attribute)) return false;
  }
  // value が単位だけ（数字＋単位）の場合、subject に「何の値か」が含まれている必要がある
  const isNumericValue = /^[\d０-９,\.〜～\-]+\s*(?:%|％|kl|度|年|日|時間|分|m|cm|kg|g|℃|号|t|トン)$/.test(value);
  if (isNumericValue) {
    // subject か attribute の少なくとも一方に「何の数値か」が示されている必要
    const subjectHasContext = /[のにおける関するでとして]/.test(subject) || subject.length >= 10;
    const attrHasContext = attribute && !GENERIC_ATTRIBUTES.has(attribute) && attribute.length >= 3;
    if (!subjectHasContext && !attrHasContext) return false;
  }
  // value と subject が同じ
  if (value === subject) return false;
  return true;
}

// =============================================================================
// HTML パース ヘルパー
// =============================================================================
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gs, '')
    .replace(/<style[^>]*>.*?<\/style>/gs, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// HTMLから「heading事件 → table事件」の順序で拾い、各tableの直前H2/H3を取得
function extractTableEvents(html) {
  const events = [];
  const re = /<(h[1-4]|table)([^>]*)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === 'table') {
      events.push({ pos: m.index, type: 'table' });
    } else {
      const end = html.indexOf('</' + m[1] + '>', m.index);
      if (end < 0) continue;
      const text = stripHtml(html.slice(m.index + m[0].length, end));
      events.push({ pos: m.index, type: m[1], text });
    }
  }
  // 各 table の文脈（直前の h2/h3）
  const tableContexts = [];
  let h2 = '', h3 = '';
  for (const ev of events) {
    if (ev.type === 'h2') { h2 = ev.text; h3 = ''; }
    else if (ev.type === 'h3') { h3 = ev.text; }
    else if (ev.type === 'table') tableContexts.push({ h2, h3 });
  }
  return tableContexts;
}

// 各 <table> を行・セル配列にパース
function extractTables(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
  let tm;
  while ((tm = tableRe.exec(html)) !== null) {
    const tableHtml = tm[1];
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let rm;
    while ((rm = rowRe.exec(tableHtml)) !== null) {
      const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g;
      const cells = [];
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        cells.push(stripHtml(cm[1]));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 1) tables.push(rows);
  }
  return tables;
}

// 見出しから装飾（⭐️、（）、（マーク））を除去
function cleanHeading(s) {
  if (!s) return '';
  return s
    .replace(/[⭐️★☆✨🔍🍶🥃📝📚📊]/g, '')
    .replace(/[（(][⭐️★☆\s]*[）)]/g, '')
    .replace(/[（(][^）)]*[）)]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// table 文脈から subject を構築（attribute=列ヘッダーは別管理して subject には含めない）
// 例：
//   - h2="主要きょうかい酵母の特徴", h3="伝統的なきょうかい酵母", row="6号", col="分離元"
//     → subject="伝統的なきょうかい酵母における6号"、attribute="分離元"
//   - h2="特定名称酒の分類表", row="吟醸酒", col="精米歩合"
//     → subject="特定名称酒における吟醸酒"、attribute="精米歩合"
function buildSubjectFromTable(ctx, rowKey, colHeader) {
  const h2 = cleanHeading(ctx.h2 || '');
  const h3 = cleanHeading(ctx.h3 || '');
  const row = (rowKey || '').trim();
  const col = (colHeader || '').trim();

  if (GENERIC_HEADINGS.has(h2) && GENERIC_HEADINGS.has(h3)) return null;
  if (!h2 && !h3) return null;
  if (!row || !col) return null;

  const rowIsGeneric = GENERIC_ROW_KEYS.has(row);
  const rowIsShort = row.length < 3;

  let topic = h3 || h2;
  topic = topic.replace(/[（(].*?[）)]/g, '').replace(/^.*[：:]/, '').trim();
  // 末尾の「表」「一覧」「比較」を除く（自然な日本語にするため）
  topic = topic.replace(/(?:表|一覧|比較|まとめ)$/, '').trim();

  if (rowIsGeneric || rowIsShort) {
    if (!topic || topic.length < 4) return null;
    return `${topic}における${row}`;
  }
  // 行キーが具体名
  if (topic && topic.length >= 4) {
    // h2/h3 トピックが行キーと意味的に一致する場合（例：行キー「6号」、トピック「主要きょうかい酵母」）
    // 「{topic}における{row}」のような自然な subject にする
    return `${topic}における${row}`;
  }
  // トピックが取れない or 短い → 行キー単独
  return row;
}

// =============================================================================
// ノート → ファクト
// =============================================================================
const NOTE_MAP = [
  { file: '第１章 日本酒とは？', category: '第1章 日本酒とは？', page: 30 },
  { file: '第１章 図表まとめ', category: '第1章 日本酒とは？', page: 30 },
  { file: '日本酒の醸造方法と種類', category: '第2章 日本酒の醸造方法と種類', page: 78 },
  { file: '第２章 図表まとめ', category: '第2章 日本酒の醸造方法と種類', page: 78 },
  { file: '主要生産地のプロフィール', category: '第3章 主要生産地のプロフィール', page: 110 },
  { file: '第３章 図表まとめ', category: '第3章 主要生産地のプロフィール', page: 110 },
  { file: '日本酒のテイスティング', category: '第4章 日本酒のテイスティング', page: 150 },
  { file: '第４章 図表まとめ', category: '第4章 日本酒のテイスティング', page: 150 },
  { file: '日本酒のサービス', category: '第5章 日本酒のサービス', page: 165 },
  { file: '第５章 図表まとめ', category: '第5章 日本酒のサービス', page: 165 },
  { file: '日本酒と料理の相性', category: '第6章 日本酒と料理の相性', page: 180 },
  { file: '第６章 図表まとめ', category: '第6章 日本酒と料理の相性', page: 180 },
  { file: '焼酎 ', category: '第7章 焼酎', page: 220 },
  { file: '第７章 図表まとめ', category: '第7章 焼酎', page: 220 },
  { file: '焼酎・泡盛と料理の相性', category: '第8章 焼酎・泡盛と料理の相性', page: 245 },
  { file: '第８章 図表まとめ', category: '第8章 焼酎・泡盛と料理の相性', page: 245 },
  { file: '酒造好適米の一覧表', category: '第1章 日本酒とは？', page: 60 },
];

function detectFactType(value) {
  const v = String(value || '').trim();
  if (/^\d{3,4}年/.test(v) || /^\d{2,4}世紀/.test(v)) return 'year';
  if (/^[\d０-９,\.〜～\-]+\s*(?:%|％|kl|度|年|日|時間|分|m|cm|km|kg|g|℃|号|人|本|割合|歩合|t|トン)?$/.test(v)) return 'number';
  if (/(氏|衛門|郎|介|蔵|親|甚造|金一郎|鹿又|岸本|嘉儀|山邑|太左衛門)$/.test(v) && v.length <= 10) return 'person';
  if (/(?:県|府|都|道|市|村|町|地方|地域|諸島|半島|島|国)$/.test(v) && v.length <= 12) return 'place';
  if (/(?:酒|焼酎|酵母|麹|米|蔵|樽|寺|神社)$/.test(v) && v.length <= 15) return 'name';
  return 'term';
}

function extractFromNotes() {
  const facts = [];
  const rejectLog = [];
  if (!fs.existsSync(NOTES_DIR)) {
    console.warn('Notes dir not found:', NOTES_DIR);
    return { facts, rejectLog };
  }
  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.html'));
  let counter = 0;
  for (const file of files) {
    const map = NOTE_MAP.find(m => file.startsWith(m.file));
    if (!map) continue;
    const html = fs.readFileSync(path.join(NOTES_DIR, file), 'utf-8');

    const tables = extractTables(html);
    const tableContexts = extractTableEvents(html);

    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti];
      const ctx = tableContexts[ti] || { h2: '', h3: '' };
      if (table.length < 2) continue;
      const headers = table[0];

      // 各行 × 各列を fact 化
      for (let r = 1; r < table.length; r++) {
        const row = table[r];
        if (row.length < 2) continue;
        const rowKey = (row[0] || '').trim();
        if (!rowKey) continue;
        for (let c = 1; c < row.length; c++) {
          const value = (row[c] || '').trim();
          const colHeader = (headers[c] || '').trim();
          if (!value || !colHeader) continue;

          // subject の組み立て
          const subject = buildSubjectFromTable(ctx, rowKey, colHeader);
          if (!subject) {
            rejectLog.push({ file, ctx, rowKey, colHeader, value, reason: 'no-subject' });
            continue;
          }
          const attribute = colHeader;

          // 検証
          if (!isValidSubject(subject)) {
            rejectLog.push({ file, subject, attribute, value, reason: 'invalid-subject' });
            continue;
          }
          if (!isValidAttribute(attribute)) {
            rejectLog.push({ file, subject, attribute, value, reason: 'invalid-attribute' });
            continue;
          }
          if (!isValidValue(value)) {
            rejectLog.push({ file, subject, attribute, value, reason: 'invalid-value' });
            continue;
          }
          if (!isMeaningfulFact(subject, attribute, value)) {
            rejectLog.push({ file, subject, attribute, value, reason: 'not-meaningful' });
            continue;
          }

          facts.push({
            id: 'f-n' + (++counter),
            category: map.category,
            title: cleanHeading(ctx.h3 || ctx.h2 || '').slice(0, 30) || (rowKey.length < 20 ? rowKey : 'まとめ'),
            referencePage: map.page,
            importance: 2,
            source: 'notes',
            sourceRef: file,
            verified: false,
            fact: {
              subject,
              attribute,
              value,
              type: detectFactType(value),
              sourceTable: `${cleanHeading(ctx.h2)} / ${cleanHeading(ctx.h3)} / ${headers.join(' | ')}`,
            },
            distractorPool: [],
          });
        }
      }
    }
  }
  return { facts, rejectLog };
}

// =============================================================================
// 重複排除
// =============================================================================
function dedupe(facts) {
  const seen = new Map();
  const out = [];
  for (const f of facts) {
    const key = (f.category || '') + '||' + (f.fact.subject || '') + '||' + (f.fact.value || '');
    if (!seen.has(key)) {
      seen.set(key, f);
      out.push(f);
    } else {
      // verified=true を優先
      const cur = seen.get(key);
      if (f.verified && !cur.verified) {
        const idx = out.indexOf(cur);
        out[idx] = f;
        seen.set(key, f);
      }
    }
  }
  return out;
}

// 同カテゴリ・同型の他ファクト value から distractor pool を作る
function buildDistractorPools(facts) {
  const groups = {};
  for (const f of facts) {
    const k = f.category + '||' + f.fact.type + '||' + (f.fact.attribute || '');
    if (!groups[k]) groups[k] = new Set();
    groups[k].add(f.fact.value);
  }
  // 同 attribute の他 value を優先
  for (const f of facts) {
    const k = f.category + '||' + f.fact.type + '||' + (f.fact.attribute || '');
    const pool = Array.from(groups[k] || []).filter(v => v && v !== f.fact.value);
    f.distractorPool = pool.slice(0, 30);
  }
  // 不足するファクトには、同カテゴリ・同型の他 value で補充
  const groups2 = {};
  for (const f of facts) {
    const k = f.category + '||' + f.fact.type;
    if (!groups2[k]) groups2[k] = new Set();
    groups2[k].add(f.fact.value);
  }
  for (const f of facts) {
    if (f.distractorPool.length >= 6) continue;
    const k = f.category + '||' + f.fact.type;
    const have = new Set([...f.distractorPool, f.fact.value]);
    for (const v of (groups2[k] || [])) {
      if (have.has(v)) continue;
      f.distractorPool.push(v);
      have.add(v);
      if (f.distractorPool.length >= 8) break;
    }
  }
}

// =============================================================================
// Main
// =============================================================================
function main() {
  console.log('Loading core facts (verified=true)...');
  const coreRaw = JSON.parse(fs.readFileSync(CORE, 'utf-8'));
  const core = coreRaw.map((f, i) => ({
    id: 'f-c' + (i + 1),
    category: f.category,
    title: f.title,
    referencePage: f.page,
    importance: 3,
    source: 'core',
    sourceRef: 'core_facts.json',
    verified: true,
    fact: {
      subject: f.subject,
      attribute: f.attribute,
      value: f.value,
      type: detectFactType(f.value),
      tags: f.tags || [],
    },
    distractorPool: [],
  }));
  console.log('  ' + core.length + ' core facts loaded');

  console.log('Extracting from notes (strict)...');
  const { facts: noteFacts, rejectLog } = extractFromNotes();
  console.log('  ' + noteFacts.length + ' note facts accepted');
  console.log('  ' + rejectLog.length + ' note candidates rejected');

  console.log('Dedupe & build distractor pools...');
  const merged = dedupe([...core, ...noteFacts]);
  buildDistractorPools(merged);
  console.log('  ' + merged.length + ' unique facts');

  // 統計
  const byCat = {}, byType = {}, bySource = {};
  for (const f of merged) {
    byCat[f.category] = (byCat[f.category] || 0) + 1;
    byType[f.fact.type] = (byType[f.fact.type] || 0) + 1;
    bySource[f.source] = (bySource[f.source] || 0) + 1;
  }
  console.log('\n  By category:');
  for (const [k, v] of Object.entries(byCat).sort()) console.log('    ' + k + ': ' + v);
  console.log('\n  By type:');
  for (const [k, v] of Object.entries(byType).sort()) console.log('    ' + k + ': ' + v);
  console.log('\n  By source:');
  for (const [k, v] of Object.entries(bySource).sort()) console.log('    ' + k + ': ' + v);

  fs.writeFileSync(OUT_FACTS, JSON.stringify(merged, null, 0));
  console.log('\nWritten:', OUT_FACTS);

  // ログ
  let log = `# ファクト抽出ログ\n\n生成: ${new Date().toISOString()}\n\n`;
  log += `## 採用\n\n`;
  log += `- core (手書き検証済): ${bySource['core'] || 0}\n`;
  log += `- notes (まとめノート表): ${bySource['notes'] || 0}\n`;
  log += `- 合計: ${merged.length}\n\n`;
  log += `## 自動抽出で検証に通らなかったもの: ${rejectLog.length}\n\n`;
  const reasonCount = {};
  for (const r of rejectLog) reasonCount[r.reason] = (reasonCount[r.reason] || 0) + 1;
  for (const [k, v] of Object.entries(reasonCount).sort((a, b) => b[1] - a[1])) {
    log += `- ${k}: ${v}\n`;
  }
  log += `\n## 棄却サンプル（先頭30件）\n\n`;
  for (const r of rejectLog.slice(0, 30)) {
    log += `- [${r.reason}] subject=「${r.subject || '(none)'}」, attribute=「${r.attribute || '-'}」, value=「${(r.value || '').slice(0, 40)}」\n`;
  }
  fs.writeFileSync(OUT_LOG, log);
}

main();
