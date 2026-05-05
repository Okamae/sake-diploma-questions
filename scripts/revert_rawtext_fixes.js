#!/usr/bin/env node
/**
 * rawtext_fix_log.json の fixes を逆適用して textbook_content.json を元の状態に戻す。
 * その後、改良版の修正ロジックを別スクリプトで再実行する。
 */

const fs = require('fs');
const path = require('path');

const CONTENT = path.resolve(__dirname, '../data/v3/textbook_content.json');
const LOG = path.resolve(__dirname, '../data/v3/rawtext_fix_log.json');

const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));
const log = JSON.parse(fs.readFileSync(LOG, 'utf-8'));

let reverted = 0, missing = 0;
for (const fix of log.fixes) {
  const page = content.pages[fix.page];
  if (!page || !page.facts) { missing++; continue; }
  const factPrefix = fix.fact;
  const target = page.facts.find(f => f.fact.startsWith(factPrefix));
  if (target && target.rawText === fix.after) {
    target.rawText = fix.before;
    reverted++;
  } else {
    missing++;
  }
}

fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
console.log(`Reverted: ${reverted}, missing: ${missing}`);
