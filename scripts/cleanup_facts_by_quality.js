#!/usr/bin/env node
/**
 * facts.json の重大違反ファクトを textbook_content.json から削除する。
 *
 * 使い方:
 *   1. node scripts/derive_facts_from_textbook.js   # facts.json 生成（チェックも自動実行）
 *   2. このスクリプトで違反 fact を textbook_content.json から削除
 *   3. 再度 derive_facts_from_textbook.js を実行 → 違反ゼロを確認
 */

const fs = require('fs');
const path = require('path');

const CONTENT = path.resolve(__dirname, '../data/v3/textbook_content.json');
const REPORT = path.resolve(__dirname, '../data/v3/japanese_quality_report.json');
const FACTS = path.resolve(__dirname, '../data/v3/facts.json');

if (!fs.existsSync(REPORT)) {
  console.error('品質レポートがありません。まず derive_facts_from_textbook.js を実行してください。');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(REPORT, 'utf-8'));
const facts = JSON.parse(fs.readFileSync(FACTS, 'utf-8'));
const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));

// 重大違反: value の L-1, L-3, L-5（rawText の L-1 は教本由来なので警告扱い）
function isCritical(v) {
  return v.issues.some(i => {
    if (i.severity === 'warning') return false;
    if (i.target !== 'value') return false;
    if (i.rule === 'L-1' || i.rule === 'L-3' || i.rule === 'L-5') return true;
    return false;
  });
}

const criticalIds = new Set(report.violations.filter(isCritical).map(v => v.id));
console.log('重大違反 facts:', criticalIds.size);

// id → fact 逆引き
const idToFact = new Map(facts.map(f => [f.id, f]));

// 各違反 fact の value（オリジナル文）と referencePage を抽出し、
// textbook_content.json で該当する fact を削除する
let removed = 0;
const removalLog = [];

for (const id of criticalIds) {
  const f = idToFact.get(id);
  if (!f) continue;
  const targetPage = String(f.referencePage);
  const targetValue = f.fact.value;
  const page = content.pages[targetPage];
  if (!page || !page.facts) continue;

  // value が一致する fact を削除
  const before = page.facts.length;
  page.facts = page.facts.filter(pf => pf.fact !== targetValue);
  const after = page.facts.length;
  if (before > after) {
    removed += (before - after);
    removalLog.push({
      id, page: targetPage, valueSnippet: targetValue.slice(0, 80),
    });
  }
}

fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
console.log('削除した textbook_content の facts:', removed);
console.log('対象ページ数:', new Set(removalLog.map(r => r.page)).size);
console.log('\nサンプル（先頭10件）:');
removalLog.slice(0, 10).forEach(r => console.log(' [' + r.id + ' p' + r.page + '] ' + r.valueSnippet));

const logPath = path.resolve(__dirname, '../data/v3/cleanup_facts_log.json');
fs.writeFileSync(logPath, JSON.stringify({ removed, removalLog }, null, 2));
console.log('\nログ:', logPath);
