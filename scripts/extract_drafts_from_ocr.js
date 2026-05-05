#!/usr/bin/env node
/**
 * 未精読ページの OCR テキストから draft fact を生成し、textbook_content.json へ追記する。
 *
 * - 章・節は近傍の既精読ページから推定
 * - OCR を文単位に分割し、"情報量のある" 文をファクト候補として抽出
 * - すべて `draft: true` を付与し、ページ自体にも `draft: true`
 * - 既存ページは触らない（safety）
 *
 * 使用後、index.html で確認しながら手作業でリファインする運用。
 */

const fs = require('fs');
const path = require('path');

const RAW = path.resolve(__dirname, '../data/v3/raw_textbook_text.json');
const CONTENT = path.resolve(__dirname, '../data/v3/textbook_content.json');

// 句点で文分割し、改行内のスペース・1行表組みを除去
function splitSentences(text) {
  if (!text) return [];
  // 改行を空白に変換して連結後、句点で分割
  const flat = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat
    .split(/(?<=[。．！？])/g)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// 文がファクト候補として有用か判定
function isInformative(sentence) {
  const len = sentence.length;
  if (len < 20 || len > 200) return false; // 長すぎ短すぎ除外
  if (!/[。．！？]$/.test(sentence)) return false; // 句点で終わるもの
  // ノイズパターン除外
  if (/^(注|＊|※|表|図|出典|参考)/.test(sentence)) return false;
  if (/^[０-９0-9]+\s*[）\)]/.test(sentence)) return false; // 番号箇条書き先頭
  // 漢字を一定数含む（情報密度の指標）
  const kanjiCount = (sentence.match(/[一-鿿]/g) || []).length;
  if (kanjiCount < 5) return false;
  // 年代・数値・専門用語のいずれかを含むのが望ましい
  const hasYear = /\d{3,4}\s*年/.test(sentence);
  const hasNumber = /\d+\s*(?:%|％|t|kl|kg|cm|m|度|℃|時間|分|号)/.test(sentence);
  const hasTerm = /(酒|米|麹|酵母|醸造|精米|発酵|蔵|杜氏|県|協会|品種|香|味)/.test(sentence);
  return hasYear || hasNumber || hasTerm;
}

// 章・節を近傍の既精読ページから推定
function inferChapterSection(content, page) {
  const curated = Object.entries(content.pages)
    .map(([k, v]) => ({ page: parseInt(k, 10), ch: v.chapter, sec: v.section }))
    .sort((a, b) => a.page - b.page);
  // 直前の curated ページの章・節を継承
  let best = null;
  for (const c of curated) {
    if (c.page <= page) best = c;
    else break;
  }
  if (!best) return { chapter: '前付', section: '不明' };
  return { chapter: best.ch, section: best.sec };
}

// ページ種別を OCR から推定
function inferPageType(ocr) {
  const len = ocr.length;
  if (len < 200) return '扉/図表';
  if (/^第[一二三四五六七八九十0-9]+章/.test(ocr.slice(0, 30))) return '扉';
  // 表の比率が高い（／/「：」が頻出）
  const tableMarks = (ocr.match(/[／:：]/g) || []).length;
  if (tableMarks > 20) return '表/データ';
  return '本文';
}

function main() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf-8'));

  let pagesAdded = 0;
  let factsAdded = 0;

  // 全 OCR ページを順番に処理
  const pageNums = Object.keys(raw)
    .filter(k => k !== 'cover' && /^\d+$/.test(k))
    .map(k => parseInt(k, 10))
    .sort((a, b) => a - b);

  for (const pageNum of pageNums) {
    const pageStr = String(pageNum);
    if (content.pages[pageStr]) continue; // 既精読は触らない

    const ocr = raw[pageStr];
    if (!ocr || ocr.length < 200) continue; // 本文なし

    const sentences = splitSentences(ocr);
    const candidates = sentences.filter(isInformative);
    if (candidates.length === 0) continue;

    const { chapter, section } = inferChapterSection(content, pageNum);
    const pageType = inferPageType(ocr);

    const facts = candidates.map(s => ({
      fact: s,
      rawText: s,
      draft: true,
    }));

    content.pages[pageStr] = {
      chapter,
      section,
      title: '',
      summary: '',
      facts,
      type: pageType,
      draft: true, // ページ全体が下書き
    };
    pagesAdded++;
    factsAdded += facts.length;
  }

  fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
  console.log(`Pages added (draft): ${pagesAdded}`);
  console.log(`Facts added (draft): ${factsAdded}`);
}

main();
