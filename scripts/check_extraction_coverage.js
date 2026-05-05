#!/usr/bin/env node
/**
 * 教本OCR生文章 (raw_textbook_text.json) と精読データ (textbook_content.json) を
 * ページごとに照らし合わせ、抽出漏れ・誤りを検出する。
 *
 * 検出項目:
 *  1. 既精読ページで OCR には存在するが factに反映されていない可能性のある重要記述
 *     （年代・人名・数値・専門用語などの固有表現）
 *  2. factの rawText が OCR テキストに含まれていない（誤読・記憶違いの疑い）
 *  3. 未精読ページのうち OCRテキストが存在し、本文ページと判定されるもの
 *
 * 出力: data/v3/extraction_coverage_report.json
 */

const fs = require('fs');
const path = require('path');

const RAW = path.resolve(__dirname, '../data/v3/raw_textbook_text.json');
const CONTENT = path.resolve(__dirname, '../data/v3/textbook_content.json');
const OUT = path.resolve(__dirname, '../data/v3/extraction_coverage_report.json');

function normalize(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[、,。．・]/g, '')
    .toLowerCase();
}

// rawTextがocrテキストに「実質的に」含まれるか（部分一致＋ノイズ吸収）
function rawTextSupported(rawText, ocr) {
  if (!rawText) return true;
  const a = normalize(rawText);
  const b = normalize(ocr);
  if (a.length < 8) return true; // 短すぎは判定スキップ
  // 先頭8文字 or 末尾8文字 の連続一致でヒット
  const head = a.slice(0, 12);
  const tail = a.slice(-12);
  if (b.includes(head)) return true;
  if (b.includes(tail)) return true;
  // 中間でも部分一致を1回以上見つけられればOK
  for (let i = 0; i + 12 <= a.length; i += 6) {
    if (b.includes(a.slice(i, i + 12))) return true;
  }
  return false;
}

// 固有表現（年代・数値・人名）を OCR から抽出
function extractEntities(ocr) {
  const ent = { years: new Set(), people: new Set(), numbers: new Set() };
  if (!ocr) return ent;
  // 年代：1234年 など
  const yrRe = /\d{3,4}\s*[（(]?(?:平成|昭和|令和|大正|明治|天保|寛永|貞観|天明|安政)?\d*[)）]?年/g;
  let m;
  while ((m = yrRe.exec(ocr)) !== null) ent.years.add(m[0].trim());
  // 数値（％・kl・度・℃・ppmなど単位付き）
  const numRe = /[\d０-９,．\.]+\s*(?:%|％|kl|度|時間|分|m|cm|kg|g|℃|号|ppm|t|トン)/g;
  while ((m = numRe.exec(ocr)) !== null) ent.numbers.add(m[0].trim());
  // 人名候補（漢字名末尾「氏」「衛門」「郎」「介」「蔵」など）
  const personRe = /[一-鿿々]{2,5}(?:氏|衛門|太郎|次郎|三郎|金一郎|甚造|親|博士|仙三郎|金一)/g;
  while ((m = personRe.exec(ocr)) !== null) ent.people.add(m[0].trim());
  return ent;
}

function main() {
  if (!fs.existsSync(RAW)) {
    console.error('raw_textbook_text.json not found. Run OCR first.');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));

  const report = {
    generatedAt: new Date().toISOString(),
    totalRawPages: Object.keys(raw).length,
    totalCuratedPages: Object.keys(content.pages).length,
    perPage: {},
  };

  // 全 OCR ページについて：精読済みかどうか・問題があるか
  for (const [pageKey, ocrText] of Object.entries(raw)) {
    if (pageKey === 'cover') continue;
    const pageInfo = content.pages[pageKey];
    const entry = {
      page: parseInt(pageKey, 10),
      ocrLength: ocrText.length,
      curated: !!pageInfo,
      issues: [],
    };
    if (!pageInfo) {
      // 未精読ページ：本文判定（テキスト200文字以上を目安に）
      if (ocrText.length > 200) {
        entry.issues.push({
          type: 'unread-content-page',
          severity: 'medium',
          note: `本文ページ（${ocrText.length}文字）だが精読データなし`,
        });
      }
    } else {
      // 精読済みページ：rawText の OCR への含まれ具合をチェック
      for (const f of (pageInfo.facts || [])) {
        if (!rawTextSupported(f.rawText, ocrText)) {
          entry.issues.push({
            type: 'rawText-not-found-in-ocr',
            severity: 'high',
            fact: f.fact.slice(0, 50),
            rawText: (f.rawText || '').slice(0, 50),
            note: 'rawTextが教本ページに見当たらない（誤った情報の疑い）',
          });
        }
      }
      // OCR から抽出した固有表現が fact 群に反映されているかざっくり確認
      const ent = extractEntities(ocrText);
      const factsBlob = (pageInfo.facts || []).map(f => f.fact + ' ' + (f.rawText || '')).join(' ');
      const missingYears = [];
      for (const y of ent.years) {
        if (!factsBlob.includes(y) && !normalize(factsBlob).includes(normalize(y))) {
          missingYears.push(y);
        }
      }
      if (missingYears.length > 0) {
        entry.issues.push({
          type: 'years-missing',
          severity: 'medium',
          examples: missingYears.slice(0, 5),
          count: missingYears.length,
          note: 'OCRに登場するが factsに含まれない年代',
        });
      }
      const missingPeople = [];
      for (const p of ent.people) {
        if (!factsBlob.includes(p)) missingPeople.push(p);
      }
      if (missingPeople.length > 0) {
        entry.issues.push({
          type: 'people-missing',
          severity: 'medium',
          examples: missingPeople.slice(0, 5),
          count: missingPeople.length,
          note: 'OCRに登場するが factsに含まれない人名候補',
        });
      }
    }
    if (entry.issues.length > 0 || !pageInfo) {
      report.perPage[pageKey] = entry;
    }
  }

  // サマリ
  let unread = 0, rawNotFound = 0, missingYrs = 0, missingPpl = 0;
  for (const e of Object.values(report.perPage)) {
    for (const i of e.issues) {
      if (i.type === 'unread-content-page') unread++;
      else if (i.type === 'rawText-not-found-in-ocr') rawNotFound++;
      else if (i.type === 'years-missing') missingYrs++;
      else if (i.type === 'people-missing') missingPpl++;
    }
  }
  report.summary = {
    unreadContentPages: unread,
    factsWithRawTextNotInOcr: rawNotFound,
    pagesWithMissingYears: missingYrs,
    pagesWithMissingPeople: missingPpl,
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('Report written:', OUT);
  console.log('Summary:', report.summary);
}

main();
