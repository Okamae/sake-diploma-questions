#!/usr/bin/env node
/**
 * canonical_lessons.json のページ→(章, レッスン)マッピングを facts.json に適用。
 *
 * - facts.json の各ファクトの category / title を canonical な値に上書き
 *   - category = "第N章 <章タイトル>"
 *   - title    = "<レッスン名>"
 * - マッピング外のページ（前付・巻末・図表のみのページ）はそのまま残す（K-5 で除外される）
 *
 * Usage: node scripts/apply_canonical_lessons.js
 * Output: data/v3/facts.json を上書き、変更レポートを stdout に表示
 */
const fs = require('fs');
const path = require('path');

const FACTS_PATH = path.resolve(__dirname, '../data/v3/facts.json');
const CANONICAL_PATH = path.resolve(__dirname, '../data/v3/canonical_lessons.json');

const canonical = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf-8'));
const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf-8'));

// page → { chapterTitle, lessonTitle } のマップを構築
const pageMap = new Map();
for (const ch of canonical.chapters) {
  for (const lesson of ch.lessons) {
    for (const p of lesson.pages) {
      pageMap.set(p, { chapterTitle: ch.title, lessonTitle: lesson.title });
    }
  }
}

// 適用
let updated = 0;
let unchanged = 0;
let outOfMap = 0;
const lessonCounts = new Map(); // lessonTitle → fact count
const oldCategories = new Set();
const oldTitles = new Set();

for (const f of facts) {
  const p = f.referencePage;
  oldCategories.add(f.category || '');
  oldTitles.add(f.title || '');
  const m = pageMap.get(p);
  if (!m) {
    outOfMap++;
    continue;
  }
  const oldCat = f.category || '';
  const oldTitle = f.title || '';
  f.category = m.chapterTitle;
  f.title = m.lessonTitle;
  if (oldCat !== f.category || oldTitle !== f.title) updated++;
  else unchanged++;
  const key = m.chapterTitle + ' / ' + m.lessonTitle;
  lessonCounts.set(key, (lessonCounts.get(key) || 0) + 1);
}

fs.writeFileSync(FACTS_PATH, JSON.stringify(facts, null, 2));

// レポート
console.log('=== Canonical lesson mapping applied ===');
console.log('Updated facts:    ', updated);
console.log('Unchanged facts:  ', unchanged);
console.log('Out-of-map facts: ', outOfMap, '(前付・巻末・図表のみ、後段の K-5 で除外される想定)');
console.log('Old categories:   ', oldCategories.size);
console.log('Old titles:       ', oldTitles.size);
console.log();
console.log('=== Fact count per canonical lesson ===');
const sorted = [...lessonCounts.entries()].sort();
for (const [k, v] of sorted) console.log('  ' + v.toString().padStart(4) + '  ' + k);
console.log();
console.log('Total canonical lessons:', lessonCounts.size);
const counts = [...lessonCounts.values()];
const min = Math.min(...counts), max = Math.max(...counts);
const median = counts.sort((a,b)=>a-b)[Math.floor(counts.length/2)];
console.log('Lesson size distribution: min=' + min + ', median=' + median + ', max=' + max);
