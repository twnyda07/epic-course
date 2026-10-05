/**
 * 路徑 A：LINE 官方帳號 bot webhook
 * ────────────────────────────────────────────────────────
 * bot 被拉進課務群之後，群裡每一則新訊息都會即時 POST 到這支 Web App。
 *
 * 【Script Properties】
 *   LINE_SECRET            你自訂的一串亂碼，會放在 webhook 網址 ?k= 後面
 *   CHANNEL_ACCESS_TOKEN   LINE Developers → Messaging API → 長期存取權杖（用來查發話者暱稱）
 *
 * 【Webhook URL】  <Web App 網址>?k=<LINE_SECRET>
 *
 * ⚠️ 安全性限制，務必知道：
 *    Apps Script 讀不到 HTTP 標頭，因此無法驗證 LINE 的 X-Line-Signature。
 *    防線只有兩道：網址裡的 LINE_SECRET ＋ 試算表設定的「LINE群組白名單」。
 *    知道網址的人有可能灌假訊息進來，所以這支網址等同密碼，別外流。
 *    要真正的簽章驗證，得改用 Cloudflare Workers 或自架後端。
 */

function handleLineWebhook_(e, body) {
  var secret = PROPS.getProperty('LINE_SECRET');
  if (!secret || e.parameter.k !== secret) return json({ ok: false, error: 'bad key' });

  var events = (body && body.events) || [];
  var white = String(settings_()['LINE群組白名單'] || '').split(/[,，\s]+/).filter(String);
  var msgs = [];

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var src = ev.source || {};
    var groupId = src.groupId || src.roomId || null;

    // bot 被拉進新群：把 groupId 記下來，方便你複製貼進白名單
    if (ev.type === 'join' && groupId) {
      logJoin_(groupId);
      continue;
    }
    if (ev.type !== 'message') continue;
    if (!groupId) continue;                                   // 只收群組，不收一對一
    if (white.length && white.indexOf(groupId) < 0) continue; // 不在白名單就丟棄

    var msg = ev.message || {};
    msgs.push({
      ts: tsOf_(ev.timestamp),
      groupId: groupId,
      groupName: '',
      userId: src.userId || '',
      displayName: displayName_(groupId, src.userId),
      type: msg.type || 'text',
      text: msg.type === 'text' ? (msg.text || '') : ('[' + (msg.type || '非文字') + ']'),
      messageId: msg.id || ''
    });
  }

  if (!msgs.length) return json({ ok: true, note: '沒有要收的訊息' });
  return json(ingestMessages_(msgs, 'LINE bot'));
}

function tsOf_(ms) {
  return Utilities.formatDate(new Date(Number(ms) || Date.now()), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
}

/** 查群組成員暱稱；查不到就留空，不亂填。 */
function displayName_(groupId, userId) {
  if (!userId) return '';
  var token = PROPS.getProperty('CHANNEL_ACCESS_TOKEN');
  if (!token) return '';
  var cache = CacheService.getScriptCache();
  var key = 'ln:' + groupId + ':' + userId;
  var hit = cache.get(key);
  if (hit) return hit;
  try {
    var res = UrlFetchApp.fetch(
      'https://api.line.me/v2/bot/group/' + groupId + '/member/' + userId,
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    var name = JSON.parse(res.getContentText()).displayName || '';
    if (name) cache.put(key, name, 21600);
    return name;
  } catch (err) {
    return '';
  }
}

/** bot 剛被拉進群時，把 groupId 寫進設定分頁備註，方便填白名單。 */
function logJoin_(groupId) {
  setSetting_('最近加入的群組ID', groupId);
  var rows = readSheet_('設定');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === '最近加入的群組ID') {
      sheet_('設定').getRange(rows[i].__row, 3)
        .setValue('bot 於 ' + now_() + ' 被加入。確認是課務群後，把這串貼到「LINE群組白名單」');
      return;
    }
  }
}
