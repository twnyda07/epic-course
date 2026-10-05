/**
 * LINE 訊息 → 課務異動提案（萃取器）
 * ────────────────────────────────────────────────────────
 * 這是整個系統唯一一份萃取規則。兩條 LINE 路徑都走這裡：
 *   路徑 A bot webhook   → LineWebhook.gs 收到即時訊息 → ingestMessages_()
 *   路徑 B 匯出 .txt     → 本機解析後 POST action=ingestLine → ingestMessages_()
 *
 * ⚠️ 鐵律：萃取結果一律只寫進「課務提案」分頁，狀態＝待審。
 *    系統永遠不會因為 LINE 上一句話就自動改課表。要改，必須有人在後台按下套用。
 *    群組裡的閒聊、語氣、玩笑話，機器分不出來，所以不給它權限。
 */

var ACTIONS = [
  { 動作: '停課',   詞: ['停課', '取消', '不上課', '不上了', '暫停', '停一次', '這次休息', '本週休息', '停一堂'] },
  { 動作: '改期',   詞: ['改期', '延期', '順延', '改到', '挪到', '移到', '調到'] },
  { 動作: '改時間', 詞: ['改時間', '提前', '延後', '時間改'] },
  { 動作: '加開',   詞: ['加開', '增開', '加課', '補課', '新增一堂', '多開'] },
  { 動作: '代課',   詞: ['代課', '代一堂', '找人代', '請假'] },
  { 動作: '換場地', 詞: ['換教室', '改教室', '換場地', '改場地', '改線上', '改實體', '改到線上'] },
  { 動作: '人數',   詞: ['額滿', '人數', '報名人數', '還有名額', '補位'] }
];

var 雜訊 = ['[貼圖]', '[照片]', '[圖片]', '[影片]', '[檔案]', '[語音訊息]', '[禮物]', '收回了訊息',
            '已加入群組', '已離開群組', '邀請', '已讀'];

/**
 * 吃一批訊息，存原文 ＋ 產生待審提案。
 * msgs: [{ts, groupId, groupName, userId, displayName, type, text, messageId}]
 */
function ingestMessages_(msgs, source) {
  var shMsg = sheet_('LINE訊息');
  var 已存 = {};
  readSheet_('LINE訊息').forEach(function (r) {
    已存[String(r['訊息id'] || '') || (String(r['收到時間']) + '|' + String(r['內容']))] = true;
  });

  var rows = [];
  var proposals = 0;
  var skipped = 0;

  (msgs || []).forEach(function (m) {
    var text = String(m.text || '').trim();
    var key = String(m.messageId || '') || (String(m.ts || '') + '|' + text);
    if (已存[key]) { skipped++; return; }
    已存[key] = true;

    rows.push([m.ts || now_(), m.groupId || '', m.groupName || '', m.userId || '',
               m.displayName || '', m.type || 'text', text, m.messageId || '']);

    var p = extractProposal_(text, m.ts, m.displayName, source);
    if (p) {
      var r = addProposal_({ row: p });
      if (r.ok && !r.skipped) proposals++;
    }
  });

  if (rows.length) {
    shMsg.getRange(shMsg.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return { ok: true, 收到: (msgs || []).length, 新訊息: rows.length, 已存在: skipped, 新提案: proposals };
}

/**
 * 單則訊息 → 提案（或 null）。
 * 只有「動作詞」命中，而且另外抓得到課名或日期，才會成案；
 * 否則回 null，不拿閒聊灌爆後台。
 */
function extractProposal_(text, ts, speaker, source) {
  if (!text || text.length < 4) return null;
  for (var i = 0; i < 雜訊.length; i++) if (text.indexOf(雜訊[i]) >= 0) return null;

  var 動作 = matchAction_(text);
  if (!動作) return null;

  var 課程 = matchCourse_(text);
  var 日期 = matchDate_(text, ts);
  var 新時間 = matchTime_(text);

  if (!課程 && !日期) return null;

  var 分 = 0;
  if (課程) 分++;
  if (日期) 分++;
  if (動作) 分++;
  var 信心 = 分 >= 3 ? '高' : (分 === 2 ? '中' : '低');

  return {
    來源: source || 'LINE',
    原文: text,
    發話者: speaker || '',
    訊息時間: ts || now_(),
    推測動作: 動作,
    推測課程: 課程 ? (課程.名稱 + '｜' + 課程.id) : '',
    推測日期: 日期 || '',
    信心: 信心,
    狀態: '待審',
    備註: 新時間 ? ('訊息裡提到時間：' + 新時間) : ''
  };
}

function matchAction_(text) {
  for (var i = 0; i < ACTIONS.length; i++) {
    for (var j = 0; j < ACTIONS[i].詞.length; j++) {
      if (text.indexOf(ACTIONS[i].詞[j]) >= 0) return ACTIONS[i].動作;
    }
  }
  return null;
}

/** 比對課名：先找完整包含，再找連續 3 字以上的共通片段。 */
function matchCourse_(text) {
  var list = [];
  readSheet_('固定週課').forEach(function (r) { if (r['課名']) list.push({ id: r.id, 名稱: String(r['課名']) }); });
  readSheet_('單次活動').forEach(function (r) { if (r['標題']) list.push({ id: r.id, 名稱: String(r['標題']) }); });

  for (var i = 0; i < list.length; i++) {
    if (text.indexOf(list[i].名稱) >= 0) return list[i];
  }
  var best = null, bestLen = 0;
  for (var k = 0; k < list.length; k++) {
    var name = list[k].名稱;
    for (var a = 0; a < name.length; a++) {
      for (var b = a + 3; b <= name.length; b++) {
        var frag = name.slice(a, b);
        if (frag.length > bestLen && text.indexOf(frag) >= 0) { best = list[k]; bestLen = frag.length; }
      }
    }
  }
  return bestLen >= 3 ? best : null;
}

var 週字 = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

/** 抓日期。相對日期（這週三／下週一／明天）以訊息時間為基準。 */
function matchDate_(text, ts) {
  var base = ts ? new Date(String(ts).replace(' ', 'T') + '+08:00') : new Date();
  if (isNaN(base.getTime())) base = new Date();

  var m = text.match(/(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return pad4_(m[1], m[2], m[3]);

  m = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
  if (m) {
    var mm = Number(m[1]), dd = Number(m[2]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      var y = base.getFullYear();
      // 月份比現在小很多 → 多半是指明年
      if (mm < base.getMonth() + 1 - 6) y++;
      return pad4_(y, mm, dd);
    }
  }

  if (/今天|今日/.test(text)) return shift_(base, 0);
  if (/明天|明日/.test(text)) return shift_(base, 1);
  if (/後天/.test(text)) return shift_(base, 2);

  m = text.match(/(這|本|下|下下)?\s*(週|周|禮拜|星期)\s*([日天一二三四五六])/);
  if (m) {
    var target = 週字[m[3]];
    var offsetWeek = m[1] === '下' ? 1 : (m[1] === '下下' ? 2 : 0);
    var cur = base.getDay();
    var diff = target - cur + offsetWeek * 7;
    if (!m[1] && diff < 0) diff += 7;      // 沒寫「這／下」且已過 → 當成下一個
    return shift_(base, diff);
  }
  return null;
}

function matchTime_(text) {
  var m = text.match(/(\d{1,2})\s*[:：點]\s*(\d{2})?/);
  if (!m) return null;
  return ('0' + m[1]).slice(-2) + ':' + (m[2] || '00');
}

function pad4_(y, m, d) {
  return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
}

function shift_(base, days) {
  var d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}
