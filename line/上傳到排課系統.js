#!/usr/bin/env node
'use strict';
/**
 * 把 LINE 課務群的訊息送進排課系統，變成「待審的課務提案」。
 *
 *   LINE 匯出 .txt ──▶ LINE群組同步（解析＋去重倉庫） ──▶ 本檔 ──▶ 排課系統後端
 *                                                                   │
 *                                                        萃取成待審提案（Extract.gs）
 *
 * 用法：
 *   node 上傳到排課系統.js              把還沒上傳過的訊息送上去
 *   node 上傳到排課系統.js --all        整份重送（後端會自己去重）
 *   node 上傳到排課系統.js --dry        只看會送什麼，不真的送
 *
 * ⚠️ 隱私：群組對話含個資。訊息原文會寫進 Google 試算表（私有），
 *    但「絕不會」出現在 GitHub Pages 的公開網站原始碼裡。
 */

const fs = require('fs');
const path = require('path');

const 設定 = require('./設定.json');
const 倉庫根 = 設定.LINE群組同步目錄;
const 群組KEY = 設定.群組key;
const API = 設定.後端網址;
const 排課密碼 = 設定.排課密碼;

const 進度檔 = path.join(__dirname, '.已上傳.json');

function 讀倉庫() {
  const file = path.join(倉庫根, 'data', 群組KEY, 'messages.jsonl');
  if (!fs.existsSync(file)) {
    console.error(`
找不到訊息倉庫：${file}

請先把 LINE 聊天記錄匯入：
  1. 手機 LINE 開課務群 → 右上選單 → 聊天設定 → 傳送聊天記錄 → 存成 .txt
  2. 把 .txt 放進 ${path.join(倉庫根, '收件匣')}/
  3. 在 ${倉庫根} 雙擊「匯入LINE聊天記錄.command」
  4. 再跑一次本程式
`);
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function 讀進度() {
  try { return JSON.parse(fs.readFileSync(進度檔, 'utf8')); } catch { return { 已上傳keys: [] }; }
}

async function post(payload) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('後端回傳的不是 JSON：' + text.slice(0, 200)); }
}

(async function main() {
  const all = process.argv.includes('--all');
  const dry = process.argv.includes('--dry');

  if (!API) { console.error('請先在 line/設定.json 填入「後端網址」'); process.exit(1); }

  const msgs = 讀倉庫();
  const 進度 = 讀進度();
  const done = new Set(all ? [] : 進度.已上傳keys);
  const 待送 = msgs.filter(m => !done.has(m._key));

  console.log(`倉庫共 ${msgs.length} 則，這次要送 ${待送.length} 則`);
  if (!待送.length) { console.log('沒有新訊息。'); return; }

  const payload = 待送.map(m => ({
    ts: m.ts,
    groupId: m.groupId || '',
    groupName: 設定.群組顯示名稱 || '',
    userId: '',
    displayName: m.sender || '',
    type: 'text',
    text: m.text || '',
    messageId: m._key
  }));

  if (dry) {
    console.log('\n--dry 預覽前 10 則：');
    payload.slice(0, 10).forEach(p => console.log(`  ${p.ts}  ${p.displayName}：${p.text.slice(0, 60)}`));
    return;
  }

  // 一次 200 則，避免 Apps Script 執行逾時
  let 新訊息 = 0, 新提案 = 0;
  for (let i = 0; i < payload.length; i += 200) {
    const batch = payload.slice(i, i + 200);
    process.stdout.write(`  上傳 ${i + 1}–${i + batch.length} …`);
    const out = await post({ action: 'ingestLine', password: 排課密碼, source: 'LINE 匯出', messages: batch });
    if (out.ok === false) throw new Error(out.error);
    新訊息 += out.新訊息 || 0;
    新提案 += out.新提案 || 0;
    console.log(` 新訊息 ${out.新訊息}　新提案 ${out.新提案}`);
  }

  fs.writeFileSync(進度檔, JSON.stringify({
    已上傳keys: [...done, ...待送.map(m => m._key)],
    更新時間: new Date().toISOString()
  }, null, 0));

  console.log(`\n完成。新增訊息 ${新訊息} 則，產生待審提案 ${新提案} 筆。`);
  console.log('到排課系統網站的「LINE 提案」分頁審核。機器只負責猜，套用與否由人決定。');
})().catch(e => { console.error('\n失敗：', e.message); process.exit(1); });
