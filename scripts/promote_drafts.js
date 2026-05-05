#!/usr/bin/env node
/**
 * ドラフトページ・ドラフトファクトを精読データへ昇格させる。
 *
 * 戦略:
 *   1. 各ドラフトページの facts を品質フィルタにかける
 *   2. 通過した facts は draft フラグを除去（精読昇格）
 *   3. 不通過の facts は除外
 *   4. 通過 facts が0なら、ページの draft フラグは残す（内容が無い）
 *   5. 通過 facts が1件以上なら、ページの draft フラグを除去
 *
 * 品質フィルタ:
 *   - 文字数 30〜250
 *   - 漢字を含む（>=4 個）
 *   - 目次・見出しっぽい先頭パターンを除外（目次、はじめに、第N章 のみ等）
 *   - 句点・体言止めで終わる
 *   - 重複（同ページ内）を排除
 *
 * 入出力: data/v3/textbook_content.json (上書き) + promote_drafts_log.json
 */

const fs = require('fs');
const path = require('path');

const CONTENT = path.resolve(__dirname, '../data/v3/textbook_content.json');
const LOG = path.resolve(__dirname, '../data/v3/promote_drafts_log.json');

function isBalanced(s) {
  let pairs = [['「', '」'], ['『', '』'], ['（', '）'], ['(', ')']];
  for (const [o, c] of pairs) {
    let oo = 0, cc = 0;
    for (const ch of s) { if (ch === o) oo++; if (ch === c) cc++; }
    if (oo !== cc) return false;
  }
  return true;
}

function isQualityDraftFact(text, seen) {
  if (!text || typeof text !== 'string') return { ok: false, reason: 'empty' };
  const t = text.trim();
  if (t.length < 30) return { ok: false, reason: 'too-short' };
  if (t.length > 250) return { ok: false, reason: 'too-long' };

  // 漢字数（情報密度の指標）
  const kanjiCount = (t.match(/[一-鿿]/g) || []).length;
  if (kanjiCount < 4) return { ok: false, reason: 'low-kanji' };

  // 目次・見出しっぽい先頭
  if (/^(目次|はじめに|概説|第[一二三四五六七八九十0-9０-９]+章|凡例|参考文献|出典|付録|奥付)/.test(t)) {
    return { ok: false, reason: 'toc-or-heading' };
  }

  // 接続詞で始まる：subject 抽出が「しかし」になりやすい
  if (/^(?:しかし|ただし|なお|また|さらに|一方|そして|つまり|なぜなら|したがって|そこで|ところで|さて|また、|しかし、|ただし、)/.test(t)) {
    return { ok: false, reason: 'starts-with-conj' };
  }

  // 末尾チェック
  if (/[、，,]$/.test(t)) return { ok: false, reason: 'ends-with-comma' };
  if (/(?:しかし|ただし|なお|また)$/.test(t)) return { ok: false, reason: 'ends-with-conj' };

  // 鉤括弧の整合性（OCR切り取りで不整合になっている文を除外）
  if (!isBalanced(t)) return { ok: false, reason: 'unbalanced-brackets' };

  // 数字・記号だけの文を除外
  if (/^[\d\s\.\,\(\)]+$/.test(t)) return { ok: false, reason: 'digits-only' };

  // 重複排除
  const key = t.replace(/\s+/g, '');
  if (seen.has(key)) return { ok: false, reason: 'duplicate' };
  seen.add(key);

  return { ok: true };
}

function main() {
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));
  const log = {
    generatedAt: new Date().toISOString(),
    totalPagesProcessed: 0,
    pagesPromoted: 0,
    pagesKeptAsDraft: 0,
    factsPromoted: 0,
    factsRejected: 0,
    rejectionReasons: {},
    perPageSummary: [],
  };

  for (const [pgKey, page] of Object.entries(content.pages)) {
    if (page.draft !== true) continue;
    log.totalPagesProcessed++;

    const seen = new Set();
    const accepted = [];
    const rejected = [];
    for (const f of page.facts || []) {
      const text = f.fact || '';
      const v = isQualityDraftFact(text, seen);
      if (v.ok) {
        // draft フラグを除去
        delete f.draft;
        accepted.push(f);
      } else {
        rejected.push({ text: text.slice(0, 60), reason: v.reason });
        log.rejectionReasons[v.reason] = (log.rejectionReasons[v.reason] || 0) + 1;
      }
    }

    log.factsPromoted += accepted.length;
    log.factsRejected += rejected.length;

    // ページ単位の処理
    page.facts = accepted;
    if (accepted.length > 0) {
      delete page.draft;
      log.pagesPromoted++;
      log.perPageSummary.push({ page: pgKey, accepted: accepted.length, rejected: rejected.length, status: 'promoted' });
    } else {
      // 通過ファクトなし → ページは draft のまま、空ページ扱い
      log.pagesKeptAsDraft++;
      log.perPageSummary.push({ page: pgKey, accepted: 0, rejected: rejected.length, status: 'kept-draft' });
    }
  }

  fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));

  console.log('=== ドラフト精読昇格結果 ===');
  console.log('処理ページ数:', log.totalPagesProcessed);
  console.log('  精読昇格:', log.pagesPromoted);
  console.log('  ドラフトのまま:', log.pagesKeptAsDraft);
  console.log('ファクト処理:');
  console.log('  精読昇格:', log.factsPromoted);
  console.log('  除外:', log.factsRejected);
  console.log('除外理由:', log.rejectionReasons);
  console.log('\nログ:', LOG);
}

if (require.main === module) main();
