#!/usr/bin/env node
/**
 * 各 fact の rawText を OCR テキストの原文に置き換える。
 *
 * ロジック:
 *  1. fact のキーフレーズ（年代・数値・固有名詞）を抽出
 *  2. OCRテキストを文単位に分割
 *  3. 元のrawTextと最も類似する OCR 文（複数文連結も許容）を見つけて採用
 *  4. 一致度が高い場合のみ自動修正、低い場合は要確認フラグ
 *
 * 入出力:
 *   in:  data/v3/raw_textbook_text.json, data/v3/textbook_content.json
 *   out: data/v3/textbook_content.json （上書き）
 *        data/v3/rawtext_fix_log.json （変更ログ）
 */

const fs = require('fs');
const path = require('path');

const RAW = path.resolve(__dirname, '../data/v3/raw_textbook_text.json');
const CONTENT = path.resolve(__dirname, '../data/v3/textbook_content.json');
const LOG = path.resolve(__dirname, '../data/v3/rawtext_fix_log.json');

function normalize(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[、,。．・]/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .toLowerCase();
}

// 文分割：「。」「！」「？」を区切りに
function splitSentences(text) {
  if (!text) return [];
  return text
    .replace(/\n+/g, '\n')
    .split(/(?<=[。．！？])/g)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// 2文字列のN-gram類似度（共通N-gramの数 / 平均N-gram数）
function ngramSimilarity(a, b, n = 3) {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < n || nb.length < n) return 0;
  const setA = new Set();
  for (let i = 0; i + n <= na.length; i++) setA.add(na.slice(i, i + n));
  const setB = new Set();
  for (let i = 0; i + n <= nb.length; i++) setB.add(nb.slice(i, i + n));
  let common = 0;
  for (const s of setA) if (setB.has(s)) common++;
  return common / Math.max(setA.size, setB.size, 1);
}

// 連続するN文を連結したものから rawText に最も近い窓を探す
function findBestMatch(rawText, sentences, maxJoin = 4) {
  let best = { score: 0, text: '', startIdx: -1, endIdx: -1 };
  for (let i = 0; i < sentences.length; i++) {
    let joined = '';
    for (let j = 0; j < maxJoin && i + j < sentences.length; j++) {
      joined += sentences[i + j];
      const score = ngramSimilarity(rawText, joined, 3);
      if (score > best.score) {
        best = { score, text: joined, startIdx: i, endIdx: i + j };
      }
    }
  }
  return best;
}

function main() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));

  const log = {
    generatedAt: new Date().toISOString(),
    fixes: [],
    skipped: [],
  };

  let totalFacts = 0, fixed = 0, alreadyOk = 0, lowConfidence = 0;

  for (const [pageStr, page] of Object.entries(content.pages)) {
    if (!page.facts || !page.facts.length) continue;
    const ocr = raw[pageStr];
    if (!ocr) continue;
    const sentences = splitSentences(ocr);

    for (const f of page.facts) {
      totalFacts++;
      const origRaw = f.rawText || '';
      // 既に OCR にそのまま含まれているなら OK（小幅な違いも許容）
      const directScore = ngramSimilarity(origRaw, ocr, 3);
      if (directScore >= 0.7) {
        alreadyOk++;
        continue;
      }
      // OCRから最良の候補を探索
      const best = findBestMatch(origRaw, sentences, 4);
      if (best.score >= 0.5) {
        // 高信頼で置き換え
        log.fixes.push({
          page: pageStr,
          fact: f.fact.slice(0, 60),
          before: origRaw,
          after: best.text,
          score: best.score.toFixed(3),
        });
        f.rawText = best.text;
        fixed++;
      } else {
        // 低信頼：そのまま残してログだけ
        lowConfidence++;
        log.skipped.push({
          page: pageStr,
          fact: f.fact.slice(0, 60),
          before: origRaw,
          bestCandidate: best.text.slice(0, 80),
          score: best.score.toFixed(3),
        });
      }
    }
  }

  log.summary = { totalFacts, fixed, alreadyOk, lowConfidence };
  fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  console.log('Summary:', log.summary);
  console.log('Updated:', CONTENT);
  console.log('Log:', LOG);
}

main();
