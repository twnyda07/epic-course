#!/usr/bin/env node
'use strict';
/**
 * 把 apps-script/Extract.gs 真的載進來跑，確認關鍵字與日期規則會如預期命中。
 * 不是另外寫一份模擬邏輯——測的就是上線那一份。
 *
 *   node 測試萃取規則.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ── 用假的課程表，模擬 Apps Script 的環境 ── */
const 固定週課 = [
  { id: 'r-mon-1215', 課名: '氣韻漫舞' },
  { id: 'r-wed-1930', 課名: '英文禪修' },
  { id: 'r-thu-1930', 課名: '華嚴經中的藝術禪觀' },
  { id: 'r-tue-1930', 課名: '瑜伽師地論' },
  { id: 'r-sun-0900', 課名: '兒童哲學與心力量' }
];
const 單次活動 = [{ id: 'e-1031-ai', 標題: '零基礎AI小白初學班' }];

const sandbox = {
  readSheet_: n => (n === '固定週課' ? 固定週課 : n === '單次活動' ? 單次活動 : []),
  sheet_: () => ({ getLastRow: () => 1, getRange: () => ({ setValues() {} }) }),
  addProposal_: () => ({ ok: true }),
  now_: () => '2026-10-05 12:00:00',
  Utilities: {
    formatDate(d, tz, fmt) {
      const p = n => String(n).padStart(2, '0');
      const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  },
  console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Extract.gs'), 'utf8'), sandbox);

/* ── 案例：[訊息, 訊息時間, 期望(null＝應該不成案)] ── */
const 週一 = '2026-10-05 10:00:00';   // 2026-10-05 是星期一

const 案例 = [
  ['10/14 氣韻漫舞老師有事，那天停課', 週一, { 動作:'停課', 課程:'氣韻漫舞', 日期:'2026-10-14', 信心:'高' }],
  ['這週三英文禪修改到 20:00',          週一, { 動作:'改期', 課程:'英文禪修', 日期:'2026-10-07', 信心:'高' }],
  ['下週四華嚴經請假，找人代課',        週一, { 動作:'代課', 課程:'華嚴經中的藝術禪觀', 日期:'2026-10-15', 信心:'高' }],
  ['明天的瑜伽師地論取消',              週一, { 動作:'停課', 課程:'瑜伽師地論', 日期:'2026-10-06', 信心:'高' }],
  ['11/8 加開一堂兒童哲學',             週一, { 動作:'加開', 課程:'兒童哲學與心力量', 日期:'2026-11-08', 信心:'高' }],
  ['零基礎AI小白初學班額滿了',          週一, { 動作:'人數', 課程:'零基礎AI小白初學班', 日期:'',           信心:'中' }],
  ['10/21 改線上上課',                  週一, { 動作:'換場地', 課程:'',             日期:'2026-10-21', 信心:'中' }],

  // 這些應該被擋掉，不成案
  ['大家早安 🙏',                       週一, null],
  ['[貼圖]',                            週一, null],
  ['王師姐已加入群組',                  週一, null],
  ['謝謝師兄',                          週一, null],
  ['今天天氣真好',                      週一, null]   // 有「今天」但沒有動作詞
];

let 過 = 0, 失敗 = [];
for (const [text, ts, 期望] of 案例) {
  const got = sandbox.extractProposal_(text, ts, '測試者', 'test');

  if (期望 === null) {
    if (got === null) { 過++; console.log(`  ✓ 正確略過　「${text}」`); }
    else { 失敗.push([text, '應該略過，卻成案了', got]); console.log(`  ✗ 不該成案　「${text}」→ ${got.推測動作}`); }
    continue;
  }
  if (!got) { 失敗.push([text, '應該成案，卻被略過', null]); console.log(`  ✗ 漏掉　　　「${text}」`); continue; }

  const 實際課程 = String(got.推測課程 || '').split('｜')[0];
  const 錯 = [];
  if (got.推測動作 !== 期望.動作)   錯.push(`動作 ${got.推測動作}≠${期望.動作}`);
  if (實際課程 !== 期望.課程)       錯.push(`課程 ${實際課程 || '(無)'}≠${期望.課程 || '(無)'}`);
  if (got.推測日期 !== 期望.日期)   錯.push(`日期 ${got.推測日期 || '(無)'}≠${期望.日期 || '(無)'}`);
  if (got.信心 !== 期望.信心)       錯.push(`信心 ${got.信心}≠${期望.信心}`);

  if (錯.length) { 失敗.push([text, 錯.join('、'), got]); console.log(`  ✗ ${text}\n      ${錯.join('　')}`); }
  else { 過++; console.log(`  ✓ ${got.推測動作}｜${實際課程 || '—'}｜${got.推測日期 || '—'}｜${got.信心}　「${text}」`); }
}

console.log(`\n${過}/${案例.length} 通過`);
if (失敗.length) { console.log('\n沒過的案例：'); 失敗.forEach(f => console.log(`  「${f[0]}」→ ${f[1]}`)); process.exit(1); }
