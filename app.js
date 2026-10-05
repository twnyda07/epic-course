/* EPIC 排課系統 — 前端 */
'use strict';

const CAT = { am:'上午課程', pm:'下午課程', night:'晚間課程', special:'特別活動', lecture:'假日講座', fahui:'祈福法會' };
const WD  = ['日','一','二','三','四','五','六'];
const $   = s => document.querySelector(s);
const $$  = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const S = {
  pw: '', role: 'none', offline: false,
  data: null,           // {場地,師資,固定週課,單次活動,異動,報名,待確認,課務提案}
  cursor: new Date(),   // 月曆游標
  view: 'cal'
};

/* ═══════════ 與後端溝通 ═══════════ */

/** Apps Script 的 302 轉址偶發會讓 CORS 失敗，所以重試 3 次。 */
async function api(action, payload = {}) {
  if (S.offline) throw new Error('離線預覽模式不能存取後端');
  const body = JSON.stringify(Object.assign({ action, password: S.pw }, payload));
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(window.CFG.API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // 用 text/plain 避開 CORS 預檢
        body, redirect: 'follow'
      });
      const out = await res.json();
      if (out.ok === false) throw new Error(out.error || '後端回報失敗');
      return out;
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

/* ═══════════ 進站 ═══════════ */

$('#pwGo').onclick = enter;
$('#pw').onkeydown = e => { if (e.key === 'Enter') enter(); };

async function enter() {
  const pw = $('#pw').value.trim();
  $('#pwErr').textContent = '';

  if (!window.CFG.API) {
    if (!confirm('後端還沒設定，要用離線預覽模式開啟嗎？（只能看，不能存）')) return;
    S.offline = true; S.role = 'view';
    await loadOffline();
    return showApp();
  }
  if (!pw) { $('#pwErr').textContent = '請輸入密碼'; return; }

  $('#pwGo').disabled = true; $('#pwGo').textContent = '驗證中…';
  try {
    S.pw = pw;
    const out = await api('bootstrap');
    S.role = out.role; S.data = out.data;
    if (out.settings && out.settings.系統名稱) window.CFG.標題 = out.settings.系統名稱;
    sessionStorage.setItem('epic_pw', pw);
    showApp();
  } catch (e) {
    S.pw = '';
    $('#pwErr').textContent = String(e.message || e).includes('密碼') ? '密碼不對' : ('連不上後端：' + e.message);
  } finally {
    $('#pwGo').disabled = false; $('#pwGo').textContent = '進入';
  }
}

/** 離線預覽：直接讀月曆轉錄出來的 seed.json。 */
async function loadOffline() {
  const p = await (await fetch('seed.json')).json();
  S.data = {
    場地: p.venues.map(v => ({ id:v.id, 名稱:v.name, 地址:v.address, 電話:v.phone, 容納人數:v.capacity, 備註:v.note })),
    師資: p.teachers.map(t => ({ id:t.id, 姓名:t.name, 職稱:t.title, 備註:t.note })),
    固定週課: p.recurring.map(r => ({ id:r.id, 課名:r.title, 星期:r.weekday, 開始:r.start, 結束:r.end,
                 師資id:r.teacherId, 場地id:r.venueId, 類別:r.category, 人數上限:r.capacity, 備註:r.note })),
    單次活動: p.events.map(e => ({ id:e.id, 標題:e.title, 開始日:e.dateStart, 結束日:e.dateEnd, 開始時間:e.start,
                 結束時間:e.end, 師資id:e.teacherId, 場地id:e.venueId, 類別:e.category, 人數上限:e.capacity, 備註:e.note })),
    異動: (p['停課']||[]).map(o => ({ id:'o-'+o.date+'-'+o.recurringId, 日期:o.date, 固定週課id:o.recurringId,
                 類型:'停課', 原因:o.reason, 來源:o['來源'] })),
    報名: [], 課務提案: [],
    待確認: p.issues.map(i => ({ id:i.id, 等級:i['等級'], 標題:i['標題'], 證據:(i['圖上證據']||[]).join('\n'),
                 狀態:i['狀態'], 要問誰:i['要問誰'], 備註:i['備註']||'' }))
  };
}

function showApp() {
  $('#gate').style.display = 'none';
  $('#app').style.display = 'block';
  $('#sysName').textContent = window.CFG.標題 + (S.offline ? '（離線預覽）' : '');
  const tag = $('#roleTag');
  tag.textContent = S.offline ? '離線' : (S.role === 'edit' ? '排課' : '檢視');
  tag.classList.toggle('edit', S.role === 'edit');
  $$('.need-edit').forEach(b => { b.disabled = S.role !== 'edit'; });
  const m = new Date();
  $('#cFrom').value = ymd(new Date(m.getFullYear(), m.getMonth(), 1));
  $('#cTo').value   = ymd(new Date(m.getFullYear(), m.getMonth() + 1, 0));
  renderAll();
}

$('#logout').onclick = () => { sessionStorage.removeItem('epic_pw'); location.reload(); };
$('#reload').onclick = async () => {
  if (S.offline) return location.reload();
  try { const o = await api('bootstrap'); S.data = o.data; renderAll(); toast('已更新'); }
  catch (e) { toast('更新失敗：' + e.message); }
};

/* ═══════════ 分頁切換 ═══════════ */

$('#tabs').onclick = e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  S.view = b.dataset.v;
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + S.view));
};

/* ═══════════ 展開課表（前端版，與後端 expand_ 同規則） ═══════════ */

function expand(from, to) {
  const d0 = new Date(from + 'T00:00:00'), d1 = new Date(to + 'T00:00:00');
  const ov = {};
  (S.data.異動 || []).forEach(o => { if (o['日期'] && o['固定週課id']) ov[ymd0(o['日期']) + '|' + o['固定週課id']] = o; });

  const out = [];
  for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
    const ds = ymd(d), wd = d.getDay();

    (S.data.固定週課 || []).forEach(r => {
      if (Number(r['星期']) !== wd) return;
      const o = ov[ds + '|' + r.id];
      out.push({
        date: ds, start: (o && o['新開始']) || hm(r['開始']), end: (o && o['新結束']) || hm(r['結束']),
        title: r['課名'], teacherId: (o && o['新師資id']) || r['師資id'], venueId: (o && o['新場地id']) || r['場地id'],
        category: r['類別'], capacity: r['人數上限'], source: 'recurring', refId: r.id,
        off: !!(o && o['類型'] === '停課'),
        note: o ? ('異動：' + o['類型'] + (o['原因'] ? '（' + o['原因'] + '）' : '')) : (r['備註'] || '')
      });
    });

    (S.data.單次活動 || []).forEach(ev => {
      const s = ymd0(ev['開始日']); if (!s) return;
      const e2 = ev['結束日'] ? ymd0(ev['結束日']) : s;
      if (ds < s || ds > e2) return;
      out.push({
        date: ds, start: hm(ev['開始時間']), end: hm(ev['結束時間']), title: ev['標題'],
        teacherId: ev['師資id'], venueId: ev['場地id'], category: ev['類別'], capacity: ev['人數上限'],
        source: 'event', refId: ev.id, multiDay: s !== e2, note: ev['備註'] || ''
      });
    });
  }
  out.sort((a, b) => a.date === b.date ? String(a.start || '').localeCompare(String(b.start || '')) : a.date.localeCompare(b.date));
  return out;
}

const ymd  = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const ymd0 = v => v ? String(v).slice(0, 10) : null;
function hm(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : String(v);
}
const nameOf = (list, id, key) => { const h = (S.data[list] || []).find(x => String(x.id) === String(id)); return h ? h[key] : (id || ''); };
const teacherName = id => id ? nameOf('師資', id, '姓名') : '';
const venueName   = id => id ? nameOf('場地', id, '名稱') : '';

/* ═══════════ 月曆 ═══════════ */

function renderCal() {
  const y = S.cursor.getFullYear(), m = S.cursor.getMonth();
  $('#monthTitle').textContent = y + '.' + String(m + 1).padStart(2, '0');

  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  const gridEnd = new Date(last); gridEnd.setDate(last.getDate() + (6 - last.getDay()));

  const items = expand(ymd(gridStart), ymd(gridEnd));

  // 長檔期（展覽之類，超過 7 天又沒有時段）不要每格都印一條，改成月曆上方的橫幅
  const longIds = new Set();
  (S.data.單次活動 || []).forEach(ev => {
    const s = ymd0(ev['開始日']), e2 = ev['結束日'] ? ymd0(ev['結束日']) : s;
    if (!s || !e2) return;
    const days = (new Date(e2 + 'T00:00:00') - new Date(s + 'T00:00:00')) / 86400000 + 1;
    if (days > 7 && !ev['開始時間']) longIds.add(String(ev.id));
  });

  const banners = [];
  const seen = new Set();
  const byDate = {};
  items.forEach(it => {
    if (it.source === 'event' && longIds.has(String(it.refId))) {
      if (!seen.has(String(it.refId))) { seen.add(String(it.refId)); banners.push(it); }
      return;
    }
    (byDate[it.date] = byDate[it.date] || []).push(it);
  });

  $('#calBanner').innerHTML = banners.map(b => {
    const ev = (S.data.單次活動 || []).find(x => String(x.id) === String(b.refId)) || {};
    return `<span class="chip c-${esc(b.category || '')} multi" data-ref="${esc(b.refId)}" data-src="event"
              style="display:inline-block;margin-right:.5rem">檔期 ${esc(ymd0(ev['開始日']))} – ${esc(ymd0(ev['結束日']))}　${esc(b.title)}</span>`;
  }).join('');

  const today = ymd(new Date());
  let html = '', d = new Date(gridStart);
  while (d <= gridEnd) {
    html += '<tr>';
    for (let i = 0; i < 7; i++) {
      const ds = ymd(d), out = d.getMonth() !== m;
      const list = byDate[ds] || [];
      html += `<td class="${out ? 'out' : ''} ${ds === today ? 'today' : ''}">`;
      html += `<div class="d">${d.getDate()}</div>`;
      list.forEach(it => {
        const t = it.start ? `<span class="t">${esc(it.start)}</span> ` : '';
        html += `<span class="chip c-${esc(it.category || '')} ${it.multiDay ? 'multi' : ''} ${it.off ? 'off' : ''}"
                   data-ref="${esc(it.refId)}" data-src="${esc(it.source)}" data-date="${ds}"
                   title="${esc((it.start || '') + (it.end ? '-' + it.end : '') + ' ' + it.title +
                     (it.teacherId ? '｜' + teacherName(it.teacherId) : '') +
                     (it.venueId ? '｜' + venueName(it.venueId) : '') + (it.note ? '\n' + it.note : ''))}">
                   ${t}${esc(it.title)}</span>`;
      });
      html += '</td>';
      d.setDate(d.getDate() + 1);
    }
    html += '</tr>';
  }
  $('#calBody').innerHTML = html;
}

$('#prevM').onclick  = () => { S.cursor.setMonth(S.cursor.getMonth() - 1); renderCal(); };
$('#nextM').onclick  = () => { S.cursor.setMonth(S.cursor.getMonth() + 1); renderCal(); };
$('#todayM').onclick = () => { S.cursor = new Date(); renderCal(); };
$('#printCal').onclick = () => window.print();

function onChipClick(e) {
  const c = e.target.closest('.chip'); if (!c) return;
  const entity = c.dataset.src === 'event' ? '單次活動' : '固定週課';
  const row = (S.data[entity] || []).find(x => String(x.id) === c.dataset.ref);
  if (row) openEditor(entity, row);
}
$('#calBody').onclick = onChipClick;
$('#calBanner').onclick = onChipClick;

/* ═══════════ 週課表 ═══════════ */

function renderWeek() {
  const rows = (S.data.固定週課 || []).slice().sort((a, b) => String(hm(a['開始'])).localeCompare(String(hm(b['開始']))));
  const slots = [...new Set(rows.map(r => hm(r['開始']) + '-' + hm(r['結束'])))].sort();

  let html = '<thead><tr><th class="hour">時段</th>' + WD.map(w => `<th>星期${w}</th>`).join('') + '</tr></thead><tbody>';
  slots.forEach(slot => {
    html += `<tr><td class="hour">${esc(slot)}</td>`;
    for (let w = 0; w < 7; w++) {
      const hit = rows.filter(r => Number(r['星期']) === w && (hm(r['開始']) + '-' + hm(r['結束'])) === slot);
      html += '<td>' + hit.map(r =>
        `<div><strong>${esc(r['課名'])}</strong>` +
        (r['師資id'] ? `<br><span style="color:var(--muted)">${esc(teacherName(r['師資id']))}</span>` : '') +
        (String(r['場地id']) === 'online' ? '<br><span class="pill">線上</span>' : '') +
        '</div>').join('<hr style="border:none;border-top:1px solid var(--line);margin:.3rem 0">') + '</td>';
    }
    html += '</tr>';
  });
  $('#weekTable').innerHTML = html + '</tbody>';
}

/* ═══════════ 表格 ═══════════ */

function table(el, cols, rows, onRow) {
  if (!rows.length) { el.outerHTML_empty = true; el.innerHTML = `<tbody><tr><td class="empty">沒有資料</td></tr></tbody>`; return; }
  let h = '<thead><tr>' + cols.map(c => `<th>${esc(c.h)}</th>`).join('') + '</tr></thead><tbody>';
  rows.forEach((r, i) => {
    h += `<tr data-i="${i}" style="cursor:pointer">` + cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.f(r)}</td>`).join('') + '</tr>';
  });
  el.innerHTML = h + '</tbody>';
  el.onclick = e => { const tr = e.target.closest('tr[data-i]'); if (tr && onRow) onRow(rows[+tr.dataset.i]); };
}

function renderCourses() {
  const q = ($('#qCourse').value || '').trim();
  const hit = r => !q || JSON.stringify(r).includes(q) || teacherName(r['師資id']).includes(q);

  table($('#tRecurring'), [
    { h:'星期', f:r => '星期' + WD[Number(r['星期'])] },
    { h:'時間', f:r => esc(hm(r['開始']) + '–' + hm(r['結束'])) },
    { h:'課名', f:r => `<strong>${esc(r['課名'])}</strong>` },
    { h:'講師', f:r => esc(teacherName(r['師資id'])) || '<span class="pill">未標示</span>' },
    { h:'場地', f:r => esc(venueName(r['場地id'])) },
    { h:'類別', f:r => esc(CAT[r['類別']] || r['類別'] || '') },
    { h:'人數上限', num:true, f:r => r['人數上限'] || '—' },
    { h:'備註', f:r => esc(r['備註'] || '') }
  ], (S.data.固定週課 || []).filter(hit).sort((a,b) => (a['星期']-b['星期']) || String(hm(a['開始'])).localeCompare(String(hm(b['開始'])))),
     r => openEditor('固定週課', r));

  table($('#tEvents'), [
    { h:'日期', f:r => esc(ymd0(r['開始日']) + (r['結束日'] && ymd0(r['結束日']) !== ymd0(r['開始日']) ? ' – ' + ymd0(r['結束日']) : '')) },
    { h:'時間', f:r => r['開始時間'] ? esc(hm(r['開始時間']) + (r['結束時間'] ? '–' + hm(r['結束時間']) : '')) : '<span class="pill">未定</span>' },
    { h:'標題', f:r => `<strong>${esc(r['標題'])}</strong>` },
    { h:'講師', f:r => esc(teacherName(r['師資id'])) },
    { h:'場地', f:r => esc(venueName(r['場地id'])) },
    { h:'類別', f:r => esc(CAT[r['類別']] || r['類別'] || '') },
    { h:'備註', f:r => esc(r['備註'] || '') }
  ], (S.data.單次活動 || []).filter(hit).sort((a,b) => String(ymd0(a['開始日'])).localeCompare(String(ymd0(b['開始日'])))),
     r => openEditor('單次活動', r));

  table($('#tOverrides'), [
    { h:'日期', f:r => esc(ymd0(r['日期'])) },
    { h:'課程', f:r => esc(nameOf('固定週課', r['固定週課id'], '課名')) },
    { h:'類型', f:r => `<span class="pill ${r['類型']==='停課'?'hi':''}">${esc(r['類型'])}</span>` },
    { h:'新時間', f:r => r['新開始'] ? esc(hm(r['新開始']) + '–' + hm(r['新結束'])) : '—' },
    { h:'原因', f:r => esc(r['原因'] || '') },
    { h:'來源', f:r => esc(r['來源'] || '') }
  ], (S.data.異動 || []).slice().sort((a,b) => String(ymd0(b['日期'])).localeCompare(String(ymd0(a['日期'])))),
     r => openEditor('異動', r));
}
$('#qCourse').oninput = renderCourses;

function renderPeople() {
  table($('#tTeachers'), [
    { h:'姓名', f:r => `<strong>${esc(r['姓名'])}</strong>` },
    { h:'職稱', f:r => esc(r['職稱'] || '') },
    { h:'電話', f:r => esc(r['電話'] || '') },
    { h:'Email', f:r => esc(r['Email'] || '') },
    { h:'開課數', num:true, f:r => (S.data.固定週課||[]).filter(c => String(c['師資id'])===String(r.id)).length
                                 + (S.data.單次活動||[]).filter(c => String(c['師資id'])===String(r.id)).length },
    { h:'備註', f:r => esc(r['備註'] || '') }
  ], S.data.師資 || [], r => openEditor('師資', r));

  table($('#tVenues'), [
    { h:'名稱', f:r => `<strong>${esc(r['名稱'])}</strong>` },
    { h:'地址', f:r => esc(r['地址'] || '') },
    { h:'電話', f:r => esc(r['電話'] || '') },
    { h:'容納人數', num:true, f:r => r['容納人數'] || '—' },
    { h:'備註', f:r => esc(r['備註'] || '') }
  ], S.data.場地 || [], r => openEditor('場地', r));
}

function renderEnroll() {
  const f = $('#enrollFilter').value;
  const rows = (S.data.報名 || []).filter(r => !f || r['狀態'] === f);
  table($('#tEnroll'), [
    { h:'日期', f:r => esc(ymd0(r['日期'])) },
    { h:'課程', f:r => esc(nameOf(r['課程類型']==='event'?'單次活動':'固定週課', r['課程id'], r['課程類型']==='event'?'標題':'課名')) },
    { h:'姓名', f:r => `<strong>${esc(r['姓名'])}</strong>` },
    { h:'電話', f:r => esc(r['電話'] || '') },
    { h:'人數', num:true, f:r => r['人數'] || 1 },
    { h:'狀態', f:r => `<span class="pill ${r['狀態']==='候補'?'mid':(r['狀態']==='取消'?'':'ok')}">${esc(r['狀態'])}</span>` },
    { h:'登記時間', f:r => esc(r['建立時間'] || '') }
  ], rows, r => openEditor('報名', r));
}
$('#enrollFilter').onchange = renderEnroll;
$('#newEnroll').onclick = () => openEditor('報名', {});

/* ═══════════ 衝突 ═══════════ */

/** 前端自行算，離線模式也能用；規則與後端 findConflicts_ 相同。 */
function conflicts(from, to) {
  const items = expand(from, to).filter(i => !i.off);
  const byDate = {};
  items.forEach(i => (byDate[i.date] = byDate[i.date] || []).push(i));
  const out = [];
  const mins = t => { const m = String(t).match(/(\d{1,2}):(\d{2})/); return m ? +m[1]*60 + +m[2] : 0; };
  const overlap = (a,b) => a.start && b.start && mins(a.start) < mins(b.end||b.start) && mins(b.start) < mins(a.end||a.start);

  Object.keys(byDate).sort().forEach(date => {
    const L = byDate[date];
    for (let i = 0; i < L.length; i++) for (let j = i+1; j < L.length; j++) {
      const a = L[i], b = L[j];
      if (a.multiDay || b.multiDay) {
        const fixed = a.multiDay ? b : a, big = a.multiDay ? a : b;
        if (fixed.source === 'recurring' && big.category === 'fahui')
          out.push({ lv:'提醒', date, type:'法會期間', msg:`「${fixed.title}」排在法會「${big.title}」期間，請確認是否停課` });
        continue;
      }
      if (!overlap(a,b)) continue;
      if (a.venueId && a.venueId === b.venueId && a.venueId !== 'online')
        out.push({ lv:'衝突', date, type:'場地重複', msg:`${venueName(a.venueId)}：「${a.title}」${a.start}–${a.end} 與「${b.title}」${b.start}–${b.end} 重疊` });
      if (a.teacherId && a.teacherId === b.teacherId)
        out.push({ lv:'衝突', date, type:'師資撞堂', msg:`${teacherName(a.teacherId)}：「${a.title}」與「${b.title}」同時段` });
    }
  });
  return out;
}

function renderConflicts() {
  const list = conflicts($('#cFrom').value, $('#cTo').value);
  $('#bConflict').hidden = !list.filter(c => c.lv === '衝突').length;
  $('#bConflict').textContent = list.filter(c => c.lv === '衝突').length;
  if (!list.length) { $('#conflictOut').innerHTML = '<div class="empty">這段期間沒有發現衝突</div>'; return; }
  $('#conflictOut').innerHTML = '<div class="wrap"><table class="grid"><thead><tr><th>日期</th><th>等級</th><th>類型</th><th>說明</th></tr></thead><tbody>' +
    list.map(c => `<tr><td>${esc(c.date)}（${WD[new Date(c.date+'T00:00:00').getDay()]}）</td>` +
      `<td><span class="pill ${c.lv==='衝突'?'hi':'mid'}">${esc(c.lv)}</span></td><td>${esc(c.type)}</td><td>${esc(c.msg)}</td></tr>`).join('') +
    '</tbody></table></div>';
}
$('#runConflict').onclick = renderConflicts;

/* ═══════════ LINE 提案 ═══════════ */

function renderProposals() {
  const f = $('#pFilter').value;
  const rows = (S.data.課務提案 || []).filter(r => !f || r['狀態'] === f);
  $('#bLine').hidden = !(S.data.課務提案 || []).filter(r => r['狀態'] === '待審').length;
  $('#bLine').textContent = (S.data.課務提案 || []).filter(r => r['狀態'] === '待審').length;

  if (!rows.length) { $('#tProposals').innerHTML = '<tbody><tr><td class="empty">沒有提案。把 LINE 聊天記錄匯入後，這裡會出現待審項目。</td></tr></tbody>'; return; }

  $('#tProposals').innerHTML = '<thead><tr><th>訊息時間</th><th>發話者</th><th>原文</th><th>猜測</th><th>信心</th><th>狀態</th><th></th></tr></thead><tbody>' +
    rows.map(r => `<tr>
      <td style="white-space:nowrap">${esc(r['訊息時間'] || '')}</td>
      <td>${esc(r['發話者'] || '')}</td>
      <td style="max-width:22rem">${esc(r['原文'] || '')}</td>
      <td><span class="pill">${esc(r['推測動作'] || '')}</span><br>${esc(String(r['推測課程'] || '').split('｜')[0])}<br>${esc(r['推測日期'] || '')}</td>
      <td><span class="pill ${r['信心']==='高'?'ok':(r['信心']==='中'?'mid':'hi')}">${esc(r['信心'] || '')}</span></td>
      <td>${esc(r['狀態'] || '')}</td>
      <td style="white-space:nowrap">${r['狀態'] === '待審' && S.role === 'edit'
        ? `<button class="btn" data-apply="${esc(r.id)}">套用</button> <button class="btn" data-reject="${esc(r.id)}">駁回</button>`
        : ''}</td></tr>`).join('') + '</tbody>';
}
$('#pFilter').onchange = renderProposals;

$('#tProposals').onclick = async e => {
  const ap = e.target.closest('[data-apply]'), rj = e.target.closest('[data-reject]');
  if (!ap && !rj) return;
  const id = (ap || rj).dataset.apply || (ap || rj).dataset.reject;
  const p = (S.data.課務提案 || []).find(x => String(x.id) === id);
  if (!p) return;

  if (rj) {
    if (!confirm('駁回這筆提案？')) return;
    try { await api('resolve', { id, 狀態: '已駁回' }); p['狀態'] = '已駁回'; renderProposals(); toast('已駁回'); }
    catch (err) { toast('失敗：' + err.message); }
    return;
  }

  // 套用＝幫你把表單預填好，但仍要你確認後才寫進課表
  const courseId = String(p['推測課程'] || '').split('｜')[1] || '';
  openEditor('異動', {
    日期: p['推測日期'] || '',
    固定週課id: courseId,
    類型: p['推測動作'] === '停課' ? '停課' : (p['推測動作'] === '代課' ? '代課' : '改時間'),
    原因: p['原文'] || '',
    來源: 'LINE 提案 ' + id
  }, async () => { try { await api('resolve', { id, 狀態: '已套用' }); p['狀態'] = '已套用'; } catch (e2) {} });
};

/* ═══════════ 待確認 ═══════════ */

function renderIssues() {
  const rows = S.data.待確認 || [];
  const open = rows.filter(r => r['狀態'] !== '已確認');
  $('#bIssue').hidden = !open.length; $('#bIssue').textContent = open.length;
  if (!rows.length) { $('#issueOut').innerHTML = '<div class="empty">沒有待確認事項</div>'; return; }
  $('#issueOut').innerHTML = rows.map(r => `
    <div class="note ${r['等級']==='高'?'warn':''}">
      <div><span class="pill ${r['等級']==='高'?'hi':'mid'}">${esc(r['等級'])}</span>
           <strong style="margin-left:.4rem">${esc(r['標題'])}</strong>
           <span class="pill" style="margin-left:.4rem">${esc(r['狀態'])}</span></div>
      <ul style="margin:.5rem 0 .3rem;padding-left:1.2rem">
        ${String(r['證據'] || '').split('\n').filter(Boolean).map(x => `<li>${esc(x)}</li>`).join('')}
      </ul>
      <div style="font-size:.8rem;color:var(--muted)">要問：${esc(r['要問誰'] || '')}${r['備註'] ? '　｜　' + esc(r['備註']) : ''}</div>
    </div>`).join('');
}

/* ═══════════ 編輯彈窗 ═══════════ */

const FORMS = {
  固定週課: [
    { k:'課名', req:true }, { k:'星期', type:'select', opts:() => WD.map((w,i) => ({v:i, t:'星期'+w})), req:true },
    { k:'開始', type:'time' }, { k:'結束', type:'time' },
    { k:'師資id', label:'講師', type:'select', opts:() => (S.data.師資||[]).map(t => ({v:t.id, t:t['姓名']})), blank:'（未標示）' },
    { k:'場地id', label:'場地', type:'select', opts:() => (S.data.場地||[]).map(v => ({v:v.id, t:v['名稱']})) },
    { k:'類別', type:'select', opts:() => Object.keys(CAT).map(k => ({v:k, t:CAT[k]})) },
    { k:'人數上限', type:'number' }, { k:'生效起', type:'date' }, { k:'生效迄', type:'date' },
    { k:'備註', type:'textarea' }
  ],
  單次活動: [
    { k:'標題', req:true }, { k:'開始日', type:'date', req:true }, { k:'結束日', type:'date' },
    { k:'開始時間', type:'time' }, { k:'結束時間', type:'time' },
    { k:'師資id', label:'講師', type:'select', opts:() => (S.data.師資||[]).map(t => ({v:t.id, t:t['姓名']})), blank:'（未標示）' },
    { k:'場地id', label:'場地', type:'select', opts:() => (S.data.場地||[]).map(v => ({v:v.id, t:v['名稱']})) },
    { k:'類別', type:'select', opts:() => Object.keys(CAT).map(k => ({v:k, t:CAT[k]})) },
    { k:'人數上限', type:'number' }, { k:'備註', type:'textarea' }
  ],
  異動: [
    { k:'日期', type:'date', req:true },
    { k:'固定週課id', label:'哪一門課', type:'select', opts:() => (S.data.固定週課||[]).map(r => ({v:r.id, t:'星期'+WD[Number(r['星期'])]+' '+hm(r['開始'])+' '+r['課名']})), req:true },
    { k:'類型', type:'select', opts:() => ['停課','改時間','換場地','代課'].map(x => ({v:x, t:x})), req:true },
    { k:'新開始', type:'time' }, { k:'新結束', type:'time' },
    { k:'新師資id', label:'代課老師', type:'select', opts:() => (S.data.師資||[]).map(t => ({v:t.id, t:t['姓名']})), blank:'（不變）' },
    { k:'新場地id', label:'改到哪個場地', type:'select', opts:() => (S.data.場地||[]).map(v => ({v:v.id, t:v['名稱']})), blank:'（不變）' },
    { k:'原因', type:'textarea' }, { k:'來源' }
  ],
  師資: [ { k:'姓名', req:true }, { k:'職稱' }, { k:'電話' }, { k:'Email' }, { k:'備註', type:'textarea' } ],
  場地: [ { k:'名稱', req:true }, { k:'地址' }, { k:'電話' }, { k:'容納人數', type:'number' }, { k:'備註', type:'textarea' } ],
  報名: [
    { k:'課程類型', type:'select', opts:() => [{v:'recurring',t:'固定週課'},{v:'event',t:'單次活動'}], req:true },
    { k:'課程id', label:'課程', type:'select', opts:() => [...(S.data.固定週課||[]).map(r => ({v:r.id, t:r['課名']})),
                                                            ...(S.data.單次活動||[]).map(e => ({v:e.id, t:e['標題']}))], req:true },
    { k:'日期', type:'date', req:true }, { k:'姓名', req:true }, { k:'電話' }, { k:'Email' },
    { k:'人數', type:'number' },
    { k:'狀態', type:'select', opts:() => ['已報名','候補','取消'].map(x => ({v:x,t:x})) },
    { k:'備註', type:'textarea' }
  ]
};

let MCTX = null;

function openEditor(entity, row, afterSave) {
  if (S.role !== 'edit') { toast('需要排課密碼才能編輯'); return; }
  MCTX = { entity, row: Object.assign({}, row), isNew: !row.id, afterSave };
  $('#mTitle').textContent = (row.id ? '編輯' : '新增') + entity;
  $('#mDelete').hidden = !row.id;

  $('#mBody').innerHTML = FORMS[entity].map(f => {
    const label = f.label || f.k, val = MCTX.row[f.k];
    if (f.type === 'select') {
      const opts = f.opts();
      return `<div class="field"><label>${esc(label)}${f.req ? ' *' : ''}</label><select data-k="${esc(f.k)}">
        <option value="">${esc(f.blank || '（請選）')}</option>
        ${opts.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(val) ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}
      </select></div>`;
    }
    if (f.type === 'textarea')
      return `<div class="field"><label>${esc(label)}</label><textarea data-k="${esc(f.k)}">${esc(val || '')}</textarea></div>`;
    const t = f.type === 'time' ? 'time' : f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text';
    const v = f.type === 'time' ? (hm(val) || '') : f.type === 'date' ? (ymd0(val) || '') : (val == null ? '' : val);
    return `<div class="field"><label>${esc(label)}${f.req ? ' *' : ''}</label><input type="${t}" data-k="${esc(f.k)}" value="${esc(v)}"></div>`;
  }).join('');
  $('#modal').classList.add('on');
}

$('#mCancel').onclick = () => { $('#modal').classList.remove('on'); MCTX = null; };
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#mCancel').click(); };

$('#mSave').onclick = async () => {
  if (!MCTX) return;
  const row = MCTX.row;
  $$('#mBody [data-k]').forEach(el => { row[el.dataset.k] = el.value === '' ? null : el.value; });

  const miss = FORMS[MCTX.entity].filter(f => f.req && !row[f.k]).map(f => f.label || f.k);
  if (miss.length) { toast('必填沒填：' + miss.join('、')); return; }

  $('#mSave').disabled = true;
  try {
    const action = MCTX.entity === '報名' && MCTX.isNew ? 'enroll' : 'save';
    const out = await api(action, action === 'enroll' ? { row } : { entity: MCTX.entity, row });
    if (out.id) row.id = out.id;
    const list = S.data[MCTX.entity] = S.data[MCTX.entity] || [];
    const i = list.findIndex(x => String(x.id) === String(row.id));
    if (i >= 0) list[i] = row; else list.push(row);
    if (MCTX.afterSave) await MCTX.afterSave();
    $('#modal').classList.remove('on');
    toast('已儲存');
    renderAll();
  } catch (e) {
    toast('儲存失敗：' + e.message);
  } finally { $('#mSave').disabled = false; }
};

$('#mDelete').onclick = async () => {
  if (!MCTX || !MCTX.row.id) return;
  if (!confirm('確定刪除？這個動作不會自動復原。')) return;
  try {
    await api('remove', { entity: MCTX.entity, id: MCTX.row.id });
    S.data[MCTX.entity] = (S.data[MCTX.entity] || []).filter(x => String(x.id) !== String(MCTX.row.id));
    $('#modal').classList.remove('on'); toast('已刪除'); renderAll();
  } catch (e) { toast('刪除失敗：' + e.message); }
};

$$('[data-new]').forEach(b => { b.onclick = () => openEditor(b.dataset.new, {}); });

/* ═══════════ 總繪製 ═══════════ */

function renderAll() {
  renderCal(); renderWeek(); renderCourses(); renderPeople();
  renderEnroll(); renderProposals(); renderIssues(); renderConflicts();
}

/* 記住本次工作階段的密碼，重新整理不用再打 */
const saved = sessionStorage.getItem('epic_pw');
if (saved && window.CFG.API) { $('#pw').value = saved; enter(); }
