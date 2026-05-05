#!/usr/bin/env node
/**
 * OCR 補正辞書を textbook_content.json に適用する。
 *
 * 入力:
 *   data/v3/textbook_content.json (in-place 更新)
 *   scripts/ocr_corrections.js  (補正辞書)
 * 出力:
 *   data/v3/ocr_correction_log.json  (適用ログ)
 */

const fs = require('fs');
const path = require('path');

const CONTENT = path.resolve(__dirname, '../data/v3/textbook_content.json');
const RAW = path.resolve(__dirname, '../data/v3/raw_textbook_text.json');
const LOG = path.resolve(__dirname, '../data/v3/ocr_correction_log.json');

const corrections = require('./ocr_corrections');

function applyOnce(text, c) {
  if (!text) return { out: text, hits: 0 };
  let out = text;
  let hits = 0;
  if (c.contextAfter) {
    // 前後文脈付きの補正
    const re = new RegExp(escapeRegExp(c.wrong) + '(?=' + c.contextAfter.source + ')', 'g');
    out = out.replace(re, () => { hits++; return c.right; });
  } else {
    // 単純置換
    while (out.includes(c.wrong)) {
      out = out.replace(c.wrong, c.right);
      hits++;
    }
  }
  return { out, hits };
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function main() {
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));
  const raw = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf-8')) : null;

  const log = {
    generatedAt: new Date().toISOString(),
    rules: corrections.map(c => ({ rule: c.rule, desc: c.desc, wrong: c.wrong, right: c.right })),
    appliedTo: [],
    summary: {},
  };

  let totalApplied = 0;

  // textbook_content.json の facts に適用
  for (const [pgKey, page] of Object.entries(content.pages)) {
    if (!page.facts) continue;
    for (let i = 0; i < page.facts.length; i++) {
      const f = page.facts[i];
      for (const c of corrections) {
        // fact フィールド
        const f1 = applyOnce(f.fact, c);
        if (f1.hits > 0) {
          log.appliedTo.push({
            page: pgKey, factIdx: i, field: 'fact', rule: c.rule,
            before: f.fact.slice(0, 60), after: f1.out.slice(0, 60),
          });
          f.fact = f1.out;
          totalApplied += f1.hits;
          log.summary[c.rule] = (log.summary[c.rule] || 0) + f1.hits;
        }
        // rawText フィールド
        const f2 = applyOnce(f.rawText, c);
        if (f2.hits > 0) {
          log.appliedTo.push({
            page: pgKey, factIdx: i, field: 'rawText', rule: c.rule,
            before: (f.rawText || '').slice(0, 60), after: f2.out.slice(0, 60),
          });
          f.rawText = f2.out;
          totalApplied += f2.hits;
          log.summary[c.rule] = (log.summary[c.rule] || 0) + f2.hits;
        }
      }
    }
  }

  // raw_textbook_text.json にも適用（OCR元テキストも補正しておくと将来の再導出で誤りが復活しない）
  if (raw) {
    let rawHits = 0;
    for (const [pgKey, text] of Object.entries(raw)) {
      if (typeof text !== 'string') continue;
      let updated = text;
      for (const c of corrections) {
        const r = applyOnce(updated, c);
        if (r.hits > 0) {
          updated = r.out;
          rawHits += r.hits;
          log.summary[c.rule + '_raw'] = (log.summary[c.rule + '_raw'] || 0) + r.hits;
        }
      }
      raw[pgKey] = updated;
    }
    fs.writeFileSync(RAW, JSON.stringify(raw, null, 2));
    log.summary._raw_total = rawHits;
  }

  fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));

  console.log('=== OCR 補正適用結果 ===');
  console.log('補正ルール数:', corrections.length);
  console.log('textbook_content.json 適用:', totalApplied, '箇所');
  console.log('raw_textbook_text.json 適用:', log.summary._raw_total || 0, '箇所');
  console.log('内訳:', log.summary);
  console.log('\nログ:', LOG);
}

if (require.main === module) main();
