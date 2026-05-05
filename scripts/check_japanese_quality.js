#!/usr/bin/env node
/**
 * 日本語品質チェック（ルール L-1, L-3, L-5, L-6 の自動検証）
 *
 * 注: subject フィールドは廃止されたため、L-2 (subject長さ) と L-4 (汎用語subject)
 *     は対象外。チェックは value と rawText に絞る。
 *
 * 対象: data/v3/facts.json
 * 出力: data/v3/japanese_quality_report.json
 * 違反があれば exit 1 で終了
 */

const fs = require('fs');
const path = require('path');

const FACTS = path.resolve(__dirname, '../data/v3/facts.json');
const OUT = path.resolve(__dirname, '../data/v3/japanese_quality_report.json');

// L-1: 鉤括弧の整合性
function checkBrackets(s) {
  const issues = [];
  const pairs = [
    { open: '「', close: '」', label: '「」' },
    { open: '『', close: '』', label: '『』' },
    { open: '（', close: '）', label: '（）' },
    { open: '(', close: ')', label: '()' },
  ];
  for (const p of pairs) {
    let oo = 0, cc = 0;
    for (const ch of s) {
      if (ch === p.open) oo++;
      if (ch === p.close) cc++;
    }
    if (oo !== cc) {
      issues.push(`${p.label} 不整合（開${oo}/閉${cc}）`);
    }
  }
  return issues;
}

// L-3: 未完文の検出（value 末尾チェック）
function checkUnterminated(s) {
  const issues = [];
  const trimmed = s.replace(/[\s]+$/, '');
  // 読点で終わる
  if (/[、，,]$/.test(trimmed)) {
    issues.push(`末尾が読点で終わる`);
  }
  // 接続表現で終わる
  if (/(?:しかし|または|あるいは|ただし|なお|さらに)$/.test(trimmed)) {
    issues.push(`末尾が接続表現で終わる`);
  }
  // 助詞単体で終わる（value が独立した一文として体をなしていない）
  if (/[がはをにでとへ]$/.test(trimmed) && trimmed.length < 200) {
    if (!/[氏県府都道社寺]$/.test(trimmed.slice(0, -1))) {
      issues.push(`末尾が助詞単体で終わる: 「...${trimmed.slice(-3)}」`);
    }
  }
  return issues;
}

// L-5: 全角半角混在
function checkMixedHalfFull(s) {
  const issues = [];
  const hasHalfPercent = /%/.test(s);
  const hasFullPercent = /％/.test(s);
  if (hasHalfPercent && hasFullPercent) {
    issues.push(`% と ％ が混在`);
  }
  // 全角数字と半角数字の混在
  const hasHalfDigit = /\d/.test(s);
  const hasFullDigit = /[０-９]/.test(s);
  if (hasHalfDigit && hasFullDigit) {
    issues.push(`半角数字と全角数字が混在`);
  }
  return issues;
}

function main() {
  if (!fs.existsSync(FACTS)) {
    console.error('facts.json not found.');
    process.exit(1);
  }
  const facts = JSON.parse(fs.readFileSync(FACTS, 'utf-8'));

  const report = {
    generatedAt: new Date().toISOString(),
    totalFacts: facts.length,
    violations: [],
    summary: {
      'L-1_鉤括弧不整合_value': 0,
      'L-1_鉤括弧不整合_rawText': 0,
      'L-3_未完文_value': 0,
      'L-5_全角半角混在_value': 0,
    },
  };

  for (const f of facts) {
    const val = f.fact.value || '';
    const raw = f.fact.rawText || '';
    const factIssues = [];

    // L-1（value）
    const valBracket = checkBrackets(val);
    if (valBracket.length) {
      factIssues.push({ rule: 'L-1', target: 'value', detail: valBracket });
      report.summary['L-1_鉤括弧不整合_value']++;
    }
    // L-1（rawText）— 教本由来なので警告止まりにする（修正対象は value のみ）
    const rawBracket = checkBrackets(raw);
    if (rawBracket.length) {
      factIssues.push({ rule: 'L-1', target: 'rawText', detail: rawBracket, severity: 'warning' });
      report.summary['L-1_鉤括弧不整合_rawText']++;
    }

    // L-3（value 末尾）
    const valUnterm = checkUnterminated(val);
    if (valUnterm.length) {
      factIssues.push({ rule: 'L-3', target: 'value', detail: valUnterm });
      report.summary['L-3_未完文_value']++;
    }

    // L-5（value 全角半角）
    const mixIssues = checkMixedHalfFull(val);
    if (mixIssues.length) {
      factIssues.push({ rule: 'L-5', target: 'value', detail: mixIssues });
      report.summary['L-5_全角半角混在_value']++;
    }

    if (factIssues.length) {
      report.violations.push({
        id: f.id,
        page: f.referencePage,
        title: f.title || '',
        category: f.category || '',
        value: val.slice(0, 100),
        issues: factIssues,
      });
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log('=== 日本語品質チェック結果（subject廃止後・L-1/L-3/L-5）===');
  console.log('総ファクト数:', report.totalFacts);
  console.log('違反ファクト数:', report.violations.length);
  console.log('違反内訳:', report.summary);
  console.log('\nレポート:', OUT);

  // 重大違反: value の L-1, L-3, L-5 のみ
  // rawText の L-1 は教本由来なので警告扱い
  const critical =
    report.summary['L-1_鉤括弧不整合_value'] +
    report.summary['L-3_未完文_value'] +
    report.summary['L-5_全角半角混在_value'];
  if (critical > 0) {
    console.log('\n⚠️ 重大違反:', critical, '件 → 修正が必要');
    if (report.violations.length > 0) {
      console.log('\n違反サンプル（先頭5件）:');
      report.violations.slice(0, 5).forEach(v => {
        console.log(`  [${v.id} p${v.page}] ${v.title || v.category}`);
        console.log(`    value: ${v.value}`);
        v.issues.forEach(i => console.log(`    ${i.rule} (${i.target}): ${JSON.stringify(i.detail)}`));
      });
    }
    process.exit(1);
  }
  console.log('\n✓ 重大違反ゼロ');
}

if (require.main === module) main();
module.exports = { checkBrackets, checkUnterminated, checkMixedHalfFull };
