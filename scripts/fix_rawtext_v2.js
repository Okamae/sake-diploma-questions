#!/usr/bin/env node
/**
 * rawText を OCR の原文に近づけるが、元データが既に正確な場合は温存する改良版。
 *
 * 戦略:
 *  1. OCR テキストの改行を除いた "flat" 形を作る
 *  2. 元 rawText の正規化形が flat OCR の部分文字列なら → 元を保持（既に正確）
 *  3. そうでなければスライディング窓で最良一致を探し、その範囲のOCR原文を取得
 *  4. 取得したOCR原文から先頭/末尾の "見出しっぽい行" を除去
 *  5. 内部の不自然な改行を空白/削除で整形
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

// 改行を除去した「フラット」OCRを作る（句読点・空白以外をそのまま連結）
function flattenOcr(ocr) {
  return String(ocr || '').replace(/\n+/g, '');
}

// 改行を含む元 OCR から、normalize の文字位置に対応する元の文字位置を取得するため、
// マッピングテーブル（normalized index → original index）を作る
function buildIndexMap(ocr) {
  const orig = String(ocr || '');
  const norm = [];
  const map = []; // norm[i] は orig の何文字目に対応するか
  for (let i = 0; i < orig.length; i++) {
    const c = orig[i];
    if (/\s/.test(c)) continue;
    if (/[、,。．・]/.test(c)) continue;
    let nc = c.toLowerCase();
    if (nc === '（') nc = '(';
    else if (nc === '）') nc = ')';
    norm.push(nc);
    map.push(i);
  }
  return { normString: norm.join(''), map, orig };
}

// 連続するN文字の重複具合（N-gram類似度）
function ngramSim(a, b, n = 3) {
  if (!a || !b || a.length < n || b.length < n) return 0;
  const setA = new Set();
  for (let i = 0; i + n <= a.length; i++) setA.add(a.slice(i, i + n));
  const setB = new Set();
  for (let i = 0; i + n <= b.length; i++) setB.add(b.slice(i, i + n));
  let common = 0;
  for (const s of setA) if (setB.has(s)) common++;
  return common / Math.max(setA.size, setB.size, 1);
}

// 元 OCR テキストの先頭の「見出し行」を剥がす：
// 行が短く（〜15字）、句点を含まない、かつ後続行の方が長い場合に見出しと判定
function stripLeadingHeaders(ocrSpan) {
  const lines = ocrSpan.split('\n');
  while (lines.length >= 2) {
    const first = lines[0].trim();
    const second = lines[1].trim();
    if (!first) { lines.shift(); continue; }
    const isHeader =
      first.length <= 15 &&
      !/[。．！？]/.test(first) &&
      !first.includes('、') &&
      second.length > first.length;
    if (isHeader) lines.shift();
    else break;
  }
  // 末尾も空行は除く
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n').trim();
}

// 文中の不自然な改行を除去（句点で終わる前の改行は保持）
function tidyLineBreaks(text) {
  return text
    .replace(/([^。．！？])\n([^\n])/g, '$1$2') // 句点でない改行を結合
    .replace(/\n{2,}/g, '\n') // 連続改行を1つに
    .trim();
}

function main() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));

  const log = {
    generatedAt: new Date().toISOString(),
    fixes: [],
    skipped: [],
    kept: [],
  };

  let totalFacts = 0, fixed = 0, kept = 0, lowConfidence = 0;

  for (const [pageStr, page] of Object.entries(content.pages)) {
    if (!page.facts || !page.facts.length) continue;
    const ocr = raw[pageStr];
    if (!ocr) continue;

    const indexMap = buildIndexMap(ocr);
    const flatNorm = indexMap.normString;

    for (const f of page.facts) {
      totalFacts++;
      const origRaw = f.rawText || '';
      const origNorm = normalize(origRaw);

      if (origNorm.length < 8) {
        // 短すぎる：判定スキップしてそのまま
        kept++;
        continue;
      }

      // 1) 既に正確：normalize 同士の包含チェック
      if (flatNorm.includes(origNorm)) {
        log.kept.push({ page: pageStr, fact: f.fact.slice(0, 50), rawText: origRaw.slice(0, 60) });
        kept++;
        continue;
      }

      // 2) 部分一致：先頭〜末尾の主要部分が含まれていれば「ほぼ正確」と判定
      const headPart = origNorm.slice(0, Math.min(20, origNorm.length));
      const tailPart = origNorm.slice(-Math.min(20, origNorm.length));
      if (flatNorm.includes(headPart) && flatNorm.includes(tailPart)) {
        // 元 OCR 上での該当範囲を抽出して置換
        const startN = flatNorm.indexOf(headPart);
        const endN = flatNorm.indexOf(tailPart) + tailPart.length;
        if (startN >= 0 && endN > startN && endN <= indexMap.map.length) {
          const startO = indexMap.map[startN];
          const endO = indexMap.map[endN - 1] + 1;
          let span = ocr.slice(startO, endO);
          span = stripLeadingHeaders(span);
          span = tidyLineBreaks(span);
          if (span && ngramSim(normalize(span), origNorm, 3) >= 0.6) {
            log.fixes.push({
              page: pageStr,
              fact: f.fact.slice(0, 50),
              before: origRaw.slice(0, 80),
              after: span.slice(0, 100),
              method: 'span-by-head-tail',
            });
            f.rawText = span;
            fixed++;
            continue;
          }
        }
      }

      // 3) スライディング窓 N-gram で最良一致を探索
      const winSize = origNorm.length;
      let best = { score: 0, startN: -1, endN: -1 };
      const step = Math.max(3, Math.floor(winSize / 8));
      for (let i = 0; i + winSize <= flatNorm.length; i += step) {
        const window = flatNorm.slice(i, i + winSize);
        const score = ngramSim(window, origNorm, 3);
        if (score > best.score) {
          best = { score, startN: i, endN: i + winSize };
        }
      }
      if (best.score >= 0.6 && best.startN >= 0) {
        const startO = indexMap.map[best.startN];
        const endO = indexMap.map[Math.min(best.endN - 1, indexMap.map.length - 1)] + 1;
        let span = ocr.slice(startO, endO);
        span = stripLeadingHeaders(span);
        span = tidyLineBreaks(span);
        log.fixes.push({
          page: pageStr,
          fact: f.fact.slice(0, 50),
          before: origRaw.slice(0, 80),
          after: span.slice(0, 100),
          method: 'sliding-window',
          score: best.score.toFixed(3),
        });
        f.rawText = span;
        fixed++;
      } else {
        // 低信頼：そのまま残す（元データが構造化されていて OCR より正確な可能性が高い）
        lowConfidence++;
        log.skipped.push({
          page: pageStr,
          fact: f.fact.slice(0, 50),
          before: origRaw.slice(0, 80),
          bestScore: best.score.toFixed(3),
          note: '元データを温存（OCRよりも構造化された正確な記述の可能性）',
        });
      }
    }
  }

  log.summary = { totalFacts, fixed, kept, lowConfidence };
  fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  console.log('Summary:', log.summary);
}

main();
