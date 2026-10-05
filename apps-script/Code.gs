/**
 * EPIC 排課系統 — 後端 Web App
 * ────────────────────────────────────────────────────────
 * 資料庫＝同一份 Google 試算表的多個分頁。
 * 前端（GitHub Pages）用 POST（text/plain，避開 CORS 預檢）呼叫。
 *
 * 【必要的 Script Properties】（專案設定 → 指令碼屬性）
 *   SHEET_ID        試算表 ID（網址 /d/ 與 /edit 之間那一串）
 *
 * 【密碼】放在試算表「設定」分頁，隨時可改，不必重新部署：
 *   檢視密碼   能看課表、看衝突、看提案
 *   排課密碼   能新增／修改／刪除課程、師資、場地、處理提案
 *
 * 【部署】部署 → 新增部署作業 → 網頁應用程式
 *          執行身分：我　　誰可以存取：任何人
 *
 * ⚠️ 已知限制：Apps Script 讀不到 HTTP 標頭，驗不了 LINE 的 X-Line-Signature，
 *    webhook 的防線是網址裡的 SECRET ＋ 群組 ID 白名單。見 LineWebhook.gs。
 */

var PROPS = PropertiesService.getScriptProperties();

/**
 * 資料庫試算表 ID。
 *
 * 為什麼寫死在這裡而不是只靠指令碼屬性：少一個部署時會忘記的手動步驟。
 * 這不是機密——知道 ID 也打不開，試算表本身是私有的，只有擁有者看得到。
 * 要換資料庫時，設指令碼屬性 SHEET_ID 就會蓋過這個預設值。
 */
var SHEET_ID_DEFAULT = '1Xk_tzNZLK4Up84UsxXtj_4nM-FncI160Yrpq9bQDfFA';

var SHEETS = {
  設定:     ['key', 'value', '說明'],
  場地:     ['id', '名稱', '地址', '電話', '容納人數', '備註', '停用'],
  師資:     ['id', '姓名', '職稱', '電話', 'Email', '備註', '停用'],
  固定週課: ['id', '課名', '星期', '開始', '結束', '師資id', '場地id', '類別', '人數上限', '生效起', '生效迄', '備註', '停用'],
  單次活動: ['id', '標題', '開始日', '結束日', '開始時間', '結束時間', '師資id', '場地id', '類別', '人數上限', '備註', '停用'],
  異動:     ['id', '日期', '固定週課id', '類型', '新開始', '新結束', '新師資id', '新場地id', '原因', '來源', '建立時間'],
  報名:     ['id', '課程類型', '課程id', '日期', '姓名', '電話', 'Email', '人數', '狀態', '備註', '建立時間'],
  待確認:   ['id', '等級', '標題', '證據', '狀態', '要問誰', '備註'],
  課務提案: ['id', '來源', '原文', '發話者', '訊息時間', '推測動作', '推測課程', '推測日期', '信心', '狀態', '處理人', '處理時間', '備註'],
  LINE訊息: ['收到時間', '群組id', '群組名稱', '發話者id', '發話者', '型別', '內容', '訊息id']
};

var DEFAULT_SETTINGS = [
  ['檢視密碼', 'baoyan2026', '能看課表與提案'],
  ['排課密碼', 'admin2026', '能排課、改師資場地、處理提案'],
  ['系統名稱', 'EPIC 禪藝實相人文空間 排課系統', '顯示在網站標題'],
  ['LINE群組白名單', '', 'webhook 只收這些 groupId，逗號分隔；留空＝收全部（不建議）']
];

/* ═════════════════════════ 入口 ═════════════════════════ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ping') return json({ ok: true, ts: now_() });
  return html_('EPIC 排課系統後端已上線。請由前端網站操作。');
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    // LINE webhook 也打同一支網址，交給 LineWebhook.gs 處理
    return json({ ok: false, error: '無法解析請求內容' });
  }

  // 帶 ?k= 的 → 視為 LINE webhook
  if (e.parameter && e.parameter.k) return handleLineWebhook_(e, req);

  try {
    return json(route_(req));
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function route_(req) {
  var action = req.action || '';

  if (action === 'ping') return { ok: true, ts: now_() };
  if (action === 'auth') return { ok: true, role: roleOf_(req.password) };

  var role = roleOf_(req.password);
  if (role === 'none') return { ok: false, error: '密碼不對' };

  switch (action) {
    case 'bootstrap':   return { ok: true, role: role, data: readAll_(), settings: publicSettings_() };
    case 'schedule':    return { ok: true, items: expand_(req.from, req.to) };
    case 'conflicts':   return { ok: true, conflicts: findConflicts_(req.from, req.to) };
    case 'enroll':      return enroll_(req);
    case 'proposals':   return { ok: true, rows: readSheet_('課務提案') };
    case 'addProposal': return addProposal_(req);
    case 'ingestLine':  return ingestMessages_(req.messages, req.source || 'LINE 匯出');
  }

  // 以下需排課權限
  if (role !== 'edit') return { ok: false, error: '這個動作需要排課密碼' };

  switch (action) {
    case 'save':        return saveRow_(req.entity, req.row);
    case 'remove':      return removeRow_(req.entity, req.id);
    case 'resolve':     return resolveProposal_(req);
    case 'setSetting':  return setSetting_(req.key, req.value);
    case 'seed':        return seed_(req.payload);
    case 'setup':       return setup_();
  }
  return { ok: false, error: '不認得的動作：' + action };
}

/* ═════════════════════════ 試算表基礎 ═════════════════════════ */

/**
 * 本專案刻意做成**獨立指令碼**（不綁在試算表上），用 openById 連資料庫。
 *
 * ⚠️ 為什麼不綁：綁在試算表上的指令碼，它的 Web App 會繼承容器檔案的存取權。
 *    試算表是私有的 → 匿名請求一律被 Google 擋在「存取遭拒」頁，
 *    公開網站（GitHub Pages）就連不到後端。這點實測過才確定。
 *
 * ⚠️ 代價：openById 需要 .../auth/spreadsheets（帳號下所有試算表），
 *    沒辦法只要 spreadsheets.currentonly（只有這一本）。
 *    「公開網站連得到後端」與「最小權限」在 Apps Script 上不能兼得，
 *    這裡選了前者。資料本身仍受密碼保護，試算表也仍是私有的。
 */
function ss_() {
  return SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID') || SHEET_ID_DEFAULT);
}

function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 建立所有分頁與預設設定；重複執行安全。 */
function setup_() {
  Object.keys(SHEETS).forEach(function (n) { sheet_(n); });
  var sh = sheet_('設定');
  var existing = readSheet_('設定').reduce(function (m, r) { m[r.key] = true; return m; }, {});
  DEFAULT_SETTINGS.forEach(function (row) {
    if (!existing[row[0]]) sh.appendRow(row);
  });
  // 刪掉新試算表預設的空白「工作表1」
  var ss = ss_();
  ['工作表1', 'Sheet1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() <= 1) ss.deleteSheet(s);
  });
  return { ok: true, message: '分頁與預設設定已就緒' };
}

/**
 * 從編輯器手動跑的初始化。
 * （底線結尾的函式不會出現在執行選單，所以才另外包一層。
 *   獨立指令碼沒有 SpreadsheetApp.getUi()，結果印在執行記錄裡。）
 */
function 一鍵初始化() {
  var r = setup_();
  Logger.log(r.message);
  return r;
}

function readSheet_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var width = sh.getLastColumn();
  var values = sh.getRange(1, 1, last, width).getValues();
  var head = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var o = {};
    var blank = true;
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      var v = values[i][c];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
      o[head[c]] = v === '' ? null : v;
      if (v !== '') blank = false;
    }
    o.__row = i + 1;
    if (!blank) out.push(o);
  }
  return out;
}

function readAll_() {
  return {
    場地:     readSheet_('場地').filter(notDisabled_),
    師資:     readSheet_('師資').filter(notDisabled_),
    固定週課: readSheet_('固定週課').filter(notDisabled_),
    單次活動: readSheet_('單次活動').filter(notDisabled_),
    異動:     readSheet_('異動'),
    報名:     readSheet_('報名'),
    待確認:   readSheet_('待確認'),
    課務提案: readSheet_('課務提案')
  };
}

function notDisabled_(r) {
  return !(r['停用'] === true || r['停用'] === 'TRUE' || r['停用'] === '是' || r['停用'] === 1);
}

/** 新增或就地更新一列（以 id 為鍵）。 */
function saveRow_(entity, row) {
  if (!SHEETS[entity]) return { ok: false, error: '不認得的資料表：' + entity };
  var sh = sheet_(entity);
  var head = SHEETS[entity];
  if (!row.id) row.id = newId_(entity);

  var all = readSheet_(entity);
  var hit = null;
  for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(row.id)) { hit = all[i]; break; }

  var line = head.map(function (h) {
    var v = row[h];
    return v === undefined || v === null ? '' : v;
  });

  if (hit) sh.getRange(hit.__row, 1, 1, head.length).setValues([line]);
  else sh.appendRow(line);

  return { ok: true, id: row.id, mode: hit ? '更新' : '新增' };
}

function removeRow_(entity, id) {
  if (!SHEETS[entity]) return { ok: false, error: '不認得的資料表：' + entity };
  var all = readSheet_(entity);
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(id)) {
      sheet_(entity).deleteRow(all[i].__row);
      return { ok: true, id: id };
    }
  }
  return { ok: false, error: '找不到 id：' + id };
}

function newId_(entity) {
  var prefix = { 場地: 'v', 師資: 't', 固定週課: 'r', 單次活動: 'e', 異動: 'o', 報名: 'g', 待確認: 'i', 課務提案: 'p' }[entity] || 'x';
  return prefix + '-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 1000);
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
}

/* ═════════════════════════ 設定與密碼 ═════════════════════════ */

/**
 * 讀設定。
 *
 * 第一次部署時「設定」分頁是空的 → 裡面還沒有密碼 → 任何密碼都驗不過
 * → 連初始化都呼叫不了，變成先有雞先有蛋。所以這裡偵測到空表就自己初始化一次。
 * setup_() 只會補不存在的鍵，重跑安全。
 */
function settings_() {
  var rows = readSheet_('設定');
  if (!rows.length) {
    setup_();
    rows = readSheet_('設定');
  }
  return rows.reduce(function (m, r) { m[r.key] = r.value; return m; }, {});
}

function publicSettings_() {
  var s = settings_();
  return { 系統名稱: s['系統名稱'] || 'EPIC 排課系統' };   // 密碼絕不回傳前端
}

function setSetting_(key, value) {
  var all = readSheet_('設定');
  for (var i = 0; i < all.length; i++) {
    if (all[i].key === key) {
      sheet_('設定').getRange(all[i].__row, 2).setValue(value);
      return { ok: true };
    }
  }
  sheet_('設定').appendRow([key, value, '']);
  return { ok: true };
}

function roleOf_(password) {
  var s = settings_();
  var pw = String(password == null ? '' : password);
  if (pw && pw === String(s['排課密碼'] || '')) return 'edit';
  if (pw && pw === String(s['檢視密碼'] || '')) return 'view';
  return 'none';
}

/* ═════════════════════════ 展開課表 ═════════════════════════ */

/**
 * 把固定週課 ＋ 單次活動 ＋ 異動，展開成 from~to 之間每一天的實際堂次。
 * 回傳 [{date, start, end, title, teacherId, venueId, category, source, refId, note}]
 */
function expand_(from, to) {
  var data = readAll_();
  var out = [];
  var skip = {};     // "date|recurringId" → 異動列
  data.異動.forEach(function (o) {
    if (!o['日期'] || !o['固定週課id']) return;
    skip[ymd_(o['日期']) + '|' + o['固定週課id']] = o;
  });

  var d = new Date(from + 'T00:00:00+08:00');
  var end = new Date(to + 'T00:00:00+08:00');
  while (d <= end) {
    var ds = Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
    var wd = d.getDay();

    data.固定週課.forEach(function (r) {
      if (Number(r['星期']) !== wd) return;
      if (r['生效起'] && ymd_(r['生效起']) > ds) return;
      if (r['生效迄'] && ymd_(r['生效迄']) < ds) return;

      var ov = skip[ds + '|' + r.id];
      if (ov && ov['類型'] === '停課') return;

      out.push({
        date: ds,
        start: (ov && ov['新開始']) || hm_(r['開始']),
        end: (ov && ov['新結束']) || hm_(r['結束']),
        title: r['課名'],
        teacherId: (ov && ov['新師資id']) || r['師資id'] || null,
        venueId: (ov && ov['新場地id']) || r['場地id'] || null,
        category: r['類別'] || null,
        capacity: r['人數上限'] || null,
        source: 'recurring',
        refId: r.id,
        note: ov ? ('異動：' + ov['類型'] + (ov['原因'] ? '（' + ov['原因'] + '）' : '')) : (r['備註'] || null)
      });
    });

    data.單次活動.forEach(function (ev) {
      var s = ymd_(ev['開始日']);
      var e2 = ev['結束日'] ? ymd_(ev['結束日']) : s;
      if (!s || ds < s || ds > e2) return;
      out.push({
        date: ds,
        start: hm_(ev['開始時間']),
        end: hm_(ev['結束時間']),
        title: ev['標題'],
        teacherId: ev['師資id'] || null,
        venueId: ev['場地id'] || null,
        category: ev['類別'] || null,
        capacity: ev['人數上限'] || null,
        source: 'event',
        refId: ev.id,
        multiDay: s !== e2,
        note: ev['備註'] || null
      });
    });

    d.setDate(d.getDate() + 1);
  }

  out.sort(function (a, b) {
    return a.date === b.date ? String(a.start || '').localeCompare(String(b.start || '')) : a.date.localeCompare(b.date);
  });
  return out;
}

function ymd_(v) {
  if (!v) return null;
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

function hm_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'HH:mm');
  var s = String(v);
  var m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? (('0' + m[1]).slice(-2) + ':' + m[2]) : s;
}

/* ═════════════════════════ 衝突檢查 ═════════════════════════ */

/**
 * 三種衝突：
 *   場地 同一天同場地時段重疊（線上場地不算）
 *   師資 同一天同師資時段重疊
 *   法會 固定週課撞上多日法會／大型活動（提醒是否該停課）
 */
function findConflicts_(from, to) {
  var items = expand_(from, to);
  var byDate = {};
  items.forEach(function (it) { (byDate[it.date] = byDate[it.date] || []).push(it); });

  var out = [];
  Object.keys(byDate).forEach(function (date) {
    var list = byDate[date];
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = list[i], b = list[j];

        if (a.multiDay || b.multiDay) {
          var fixed = a.multiDay ? b : a;
          var big = a.multiDay ? a : b;
          if (fixed.source === 'recurring' && big.category === 'fahui') {
            out.push({ 等級: '提醒', 日期: date, 類型: '法會期間',
              說明: '「' + fixed.title + '」排在法會「' + big.title + '」期間，請確認是否停課',
              a: fixed, b: big });
          }
          continue;
        }

        if (!overlap_(a, b)) continue;

        if (a.venueId && a.venueId === b.venueId && a.venueId !== 'online') {
          out.push({ 等級: '衝突', 日期: date, 類型: '場地重複',
            說明: '同場地時段重疊：「' + a.title + '」與「' + b.title + '」', a: a, b: b });
        }
        if (a.teacherId && a.teacherId === b.teacherId) {
          out.push({ 等級: '衝突', 日期: date, 類型: '師資撞堂',
            說明: '同一位老師時段重疊：「' + a.title + '」與「' + b.title + '」', a: a, b: b });
        }
      }
    }
  });
  return out;
}

function overlap_(a, b) {
  if (!a.start || !b.start) return false;
  var as = min_(a.start), ae = min_(a.end || a.start), bs = min_(b.start), be = min_(b.end || b.start);
  return as < be && bs < ae;
}

function min_(hm) {
  var m = String(hm).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/* ═════════════════════════ 報名 ═════════════════════════ */

function enroll_(req) {
  var r = req.row || {};
  if (!r['姓名'] || !r['課程id'] || !r['日期']) return { ok: false, error: '姓名、課程、日期為必填' };

  var cap = capacityOf_(r['課程類型'], r['課程id']);
  if (cap) {
    var taken = readSheet_('報名').filter(function (x) {
      return String(x['課程id']) === String(r['課程id']) && ymd_(x['日期']) === ymd_(r['日期']) && x['狀態'] !== '取消';
    }).reduce(function (n, x) { return n + (Number(x['人數']) || 1); }, 0);
    if (taken + (Number(r['人數']) || 1) > Number(cap)) {
      r['狀態'] = '候補';
    }
  }
  if (!r['狀態']) r['狀態'] = '已報名';
  r['建立時間'] = now_();
  return saveRow_('報名', r);
}

function capacityOf_(type, id) {
  var sheet = type === 'event' ? '單次活動' : '固定週課';
  var rows = readSheet_(sheet);
  for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i]['人數上限'];
  return null;
}

/* ═════════════════════════ 課務提案 ═════════════════════════ */

function addProposal_(req) {
  var r = req.row || {};
  r['狀態'] = r['狀態'] || '待審';
  if (!r['id']) r['id'] = newId_('課務提案');

  // 以原文＋訊息時間去重，重複匯入不會灌成兩筆
  var key = String(r['原文'] || '') + '|' + String(r['訊息時間'] || '');
  var dup = readSheet_('課務提案').some(function (x) {
    return String(x['原文'] || '') + '|' + String(x['訊息時間'] || '') === key;
  });
  if (dup) return { ok: true, skipped: true, reason: '已存在相同提案' };

  return saveRow_('課務提案', r);
}

function resolveProposal_(req) {
  var rows = readSheet_('課務提案');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) !== String(req.id)) continue;
    var r = rows[i];
    r['狀態'] = req.狀態 || '已駁回';
    r['處理人'] = req.處理人 || '';
    r['處理時間'] = now_();
    delete r.__row;
    return saveRow_('課務提案', r);
  }
  return { ok: false, error: '找不到提案' };
}

/* ═════════════════════════ 種子資料匯入 ═════════════════════════ */

/** 一次把 seed JSON 灌進各分頁；只在空表時寫入，不覆蓋既有資料。 */
function seed_(p) {
  if (!p) return { ok: false, error: '沒有 payload' };
  setup_();
  var report = {};

  function fill(sheetName, rows, mapper) {
    if (readSheet_(sheetName).length > 0) { report[sheetName] = '已有資料，略過'; return; }
    var sh = sheet_(sheetName);
    var head = SHEETS[sheetName];
    var lines = (rows || []).map(function (r) {
      var o = mapper(r);
      return head.map(function (h) { return o[h] === undefined || o[h] === null ? '' : o[h]; });
    });
    if (lines.length) sh.getRange(sh.getLastRow() + 1, 1, lines.length, head.length).setValues(lines);
    report[sheetName] = lines.length + ' 筆';
  }

  fill('場地', p.venues, function (v) {
    return { id: v.id, 名稱: v.name, 地址: v.address, 電話: v.phone, 容納人數: v.capacity, 備註: v.note };
  });
  fill('師資', p.teachers, function (t) {
    return { id: t.id, 姓名: t.name, 職稱: t.title, 備註: t.note };
  });
  fill('固定週課', p.recurring, function (r) {
    return { id: r.id, 課名: r.title, 星期: r.weekday, 開始: r.start, 結束: r.end,
             師資id: r.teacherId, 場地id: r.venueId, 類別: r.category, 人數上限: r.capacity, 備註: r.note };
  });
  fill('單次活動', p.events, function (e) {
    return { id: e.id, 標題: e.title, 開始日: e.dateStart, 結束日: e.dateEnd, 開始時間: e.start, 結束時間: e.end,
             師資id: e.teacherId, 場地id: e.venueId, 類別: e.category, 人數上限: e.capacity, 備註: e.note };
  });
  fill('異動', p['停課'], function (o) {
    return { id: 'o-' + o.date + '-' + o.recurringId, 日期: o.date, 固定週課id: o.recurringId,
             類型: '停課', 原因: o.reason, 來源: o['來源'] || '月曆轉錄', 建立時間: now_() };
  });
  fill('待確認', p.issues, function (i) {
    return { id: i.id, 等級: i['等級'], 標題: i['標題'], 證據: (i['圖上證據'] || []).join('\n'),
             狀態: i['狀態'], 要問誰: i['要問誰'], 備註: i['備註'] || '' };
  });

  return { ok: true, report: report };
}

/* ═════════════════════════ 輸出 ═════════════════════════ */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function html_(msg) {
  return HtmlService.createHtmlOutput('<p style="font-family:system-ui;padding:2rem">' + msg + '</p>');
}
