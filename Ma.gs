// IELTS Tracker v9 – backend Google Apps Script
// v9: XP do backend tính + chống ghi trùng (mỗi lượt có mã eid), sổ lỗi, viết lại sau chấm, thử thách trại,
//     sửa từ đã lưu, PIN bắt buộc, khoá audio trong thư mục English.
// Dữ liệu: Google Sheet "IELTS Tracker – dữ liệu"
//
// Cài đặt trong Project Settings (bánh răng) → Script Properties:
//   PIN               = mã mở web (BẮT BUỘC từ v9; chưa đặt thì web báo lỗi)
//   AUDIO_FOLDERS     = (tuỳ chọn) ID các thư mục audio nằm ngoài thư mục English, cách nhau bằng dấu phẩy
//   GOAL              = mục tiêu mét/ngày (web tự ghi khi đổi mục tiêu)
//
// NHIỀU NGƯỜI DÙNG (v9.1): mỗi người một PIN, mỗi PIN ghi vào một Sheet riêng, dùng chung kho đề trên Drive.
//   PIN               = PIN người dùng mặc định, ghi vào Sheet SHEET_ID bên dưới
//   NAME              = tên hiển thị của người dùng mặc định (vd: Minh)
//   PIN_TRUNG         = PIN của người thứ hai (TRUNG là mã người dùng, viết HOA, không dấu)
//   SHEET_TRUNG       = ID Sheet của người đó (đoạn giữa /d/ và /edit trong link Sheet)
//   NAME_TRUNG        = tên hiển thị (vd: Trung)
//   START_TRUNG       = (tuỳ chọn) ngày bắt đầu lộ trình của người đó, yyyy-MM-dd (nên là thứ Hai). Trống = 2026-11-02.
//   Thêm người mới nhanh: dán hàm taoSlotSanTenChou() (cuối file) hoặc viết hàm tương tự rồi chạy trong trình soạn thảo.
//   AI_USERS          = mã người được dùng API key, cách nhau dấu phẩy (vd: TRUNG). Người mặc định ghi là MACDINH.
//                       Bỏ trống = ai cũng dùng được.
//   CHAT_USER         = mã người có sổ từ do Claude đắp qua chat (thư mục notebook-in), vd: TRUNG. Bỏ trống = người mặc định.
//   BUDDY             = 0 để tắt ô "Bạn học" (xem mét của nhau) ở trang chủ
//   ANTHROPIC_API_KEY = key từ platform.claude.com (bỏ trống = tắt nút "Chấm ngay", vẫn chấm qua chat được)
//
// Định dạng cột `grading` (cột K, tab submissions) — Claude chấm qua chat cũng ghi theo đúng mẫu này:
// {"task":"task2","overall":5.5,
//  "criteria":{"TR":{"band":5,"comment":"..."},"CC":{...},"LR":{...},"GRA":{...}},
//  "strengths":["..."],
//  "fixes":[{"original":"...","better":"...","why":"..."}],
//  "vocab":[{"from":"good","to":"beneficial"}],
//  "next":"..."}

const SHEET_ID = '1HXwNbK8N4PinutivEJUz9P2yCkwSDuSQd94PZJVfUgI';
const TZ = 'Asia/Seoul';
const MODEL = 'claude-sonnet-5-5';      // chấm Writing, Speaking
const MODEL_FAST = 'claude-haiku-5-5';  // giám khảo Speaking hỏi đáp từng lượt (rẻ, nhanh)
const SRS = [0, 1, 3, 7, 14, 30, 60];
// số ngày tới lần ôn tiếp theo theo hộp 0–6 (SRS ở trên)
const XP_TICK = 20; // tick một ca học sách
// Mét leo do backend tính (v9). Trình duyệt chỉ gửi số câu đúng/sai, không gửi số mét.
const XPR = {
  correct: 10,   // câu đúng trong chặng chưa qua
  card: 2,       // thẻ lật nhớ được (chặng chưa qua)
  slide: 10,     // học xong phần lý thuyết ngữ pháp (chặng chưa qua)
  pass: 30,      // qua chặng lần đầu
  review: 10,    // ôn đúng 1 từ/câu ĐẾN HẠN (ôn sớm không tính)
  perfect: 10,   // ôn đúng hết (≥ 4 câu)
  readQ: 5, readFull: 20, readGroup: 5, // Reading/Listening lần đầu
  retryQ: 10,    // làm đúng lại câu sai sau 7 ngày
  bestUp: 20,    // làm lại cả bài và vượt điểm cũ
  dictBase: 10,
  write: 30, speak: 40,
  better: 50,    // band cao hơn lần trước
  rewrite: 30,   // tự sửa lỗi sau khi chấm
  errOk: 10, errMaster: 20, // sổ lỗi
  usage: 10,     // tự viết câu với từ đã quen
  flag: 150      // cắm cờ trại
};
const SOFT_TAIL = 0.25; // vượt 2× mục tiêu ngày thì phần dư chỉ tính 1/4

const HEADERS = {
  days: ['date', 'am', 'pm', 'note', 'updated'],
  units: ['book', 'unit', 'done', 'updated'],
  submissions: ['id', 'created', 'type', 'ref', 'prompt', 'answer', 'self_score', 'minutes', 'result', 'feedback', 'grading', 'rewrite'],
  vocab: ['id', 'word', 'meaning', 'example', 'source', 'box', 'due', 'created', 'updated', 'seen', 'lapses'],
  xp: ['date', 'xp', 'lessons', 'correct', 'answered', 'updated'],
  progress: ['key', 'status', 'best', 'attempts', 'wrong', 'updated'],
  reading: ['id', 'source', 'title', 'kinds', 'passage', 'questions', 'key', 'notes', 'syn', 'created', 'updated', 'best', 'attempts', 'last', 'pack'],
  rattempts: ['id', 'rid', 'created', 'score', 'total', 'minutes', 'detail'],
  rnotes: ['rid', 'notes', 'syn', 'updated'],
  sbank: ['id', 'kind', 'title', 'text', 'meta', 'created', 'updated'],
  notebook: ['id', 'created', 'word', 'meaning', 'source', 'note', 'card', 'updated'],
  wordlab: ['id', 'box', 'ok', 'bad', 'due', 'updated'],
  events: ['eid', 'created', 'date', 'kind', 'ref', 'xp', 'data'],
  errors: ['id', 'created', 'skill', 'type', 'src', 'ref', 'wrong', 'right', 'why', 'state', 'due', 'tries', 'updated'],
  flags: ['camp', 'date', 'note'],
  friction: ['created', 'where', 'reason', 'note'],
  usage: ['id', 'created', 'word', 'text', 'status', 'updated'],
  highlights: ['rid', 'words', 'updated']
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Climbing the Rock · IELTS')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    // cho phép trang khởi động (icon trên màn hình chính) nhúng web app này
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== API cho bản web đặt trên GitHub Pages (không dùng iframe) =====
// Chỉ cho gọi hàm công khai có tham số đầu là pin (giống google.script.run).
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const name = String(req.fn || '');
    const f = this[name];
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || name === 'doGet' || name === 'doPost' || typeof f !== 'function' ||
        !/^function\s*[\w$]*\s*\(\s*pin\b/.test(Function.prototype.toString.call(f))) throw new Error('HAM_KHONG_HOP_LE');
    out = { ok: f.apply(null, req.args || []) };
    if (out.ok === undefined) out.ok = null;
  } catch (err) { out = { err: String((err && err.message) || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ===== Tiện ích (hàm có dấu _ ở cuối không gọi được từ trình duyệt) =====
let CUR_ = null; // người dùng của lần gọi hiện tại (đặt trong checkPin_)
const SSO_ = {}; // v10: mở mỗi Sheet một lần cho cả lượt chạy (trước đây mỗi lần gọi sh_ lại mở lại, rất chậm)
function ss_() { const id = CUR_ ? CUR_.sheet : SHEET_ID; return SSO_[id] || (SSO_[id] = SpreadsheetApp.openById(id)); }
// danh sách người dùng từ Script Properties
function profiles_() {
  const all = PropertiesService.getScriptProperties().getProperties(), out = [];
  if (all.PIN) out.push({ key: '', pin: String(all.PIN).trim(), sheet: SHEET_ID, name: all.NAME || 'Bạn' });
  Object.keys(all).forEach(function (k) {
    const m = k.match(/^PIN_([A-Za-z0-9]{1,20})$/);
    if (!m || !all['SHEET_' + m[1]]) return;
    out.push({ key: m[1].toUpperCase(), pin: String(all[k]).trim(), sheet: String(all['SHEET_' + m[1]]).trim(), name: all['NAME_' + m[1]] || m[1] });
  });
  return out;
}
const userKey_ = function () { return CUR_ && CUR_.key ? CUR_.key : ''; };
const sfx_ = function () { return userKey_() ? '_' + userKey_() : ''; }; // hậu tố cho cài đặt riêng từng người
function aiAllowed_() {
  if (!prop_('ANTHROPIC_API_KEY')) return false;
  const list = String(prop_('AI_USERS') || '').toUpperCase().split(',').map(function (x) { return x.trim(); }).filter(String);
  return !list.length || list.indexOf(userKey_() || 'MACDINH') >= 0;
}

function sh_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  const h = HEADERS[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, h.length).setValues([h]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < h.length) {
    sh.getRange(1, 1, 1, h.length).setValues([h]); // thêm cột mới cho sheet cũ
  }
  return sh;
}

function rows_(sh, width) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, width).getValues();
}

function key_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v).trim();
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function addDays_(k, n) {
  const d = new Date(k + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function checkPin_(pin) {
  const ps = profiles_();
  if (!ps.length) throw new Error('CHUA_DAT_PIN: vào Project Settings → Script Properties, thêm dòng PIN rồi mở lại web');
  const hit = ps.filter(function (p) { return p.pin && p.pin === String(pin || '').trim(); })[0];
  if (!hit) throw new Error('PIN_SAI'); // không khóa khi nhập sai nhiều lần
  if (!CUR_ || CUR_.key !== hit.key) EV_ = null;
  CUR_ = hit;
}
// Ô "Bạn học": mét, mét hôm nay và chuỗi ngày của những người dùng khác (chỉ đọc, cache 10 phút)
function buddies_() {
  if (String(prop_('BUDDY')) === '0') return [];
  const c = CacheService.getScriptCache(), me = userKey_(), t = today_();
  return profiles_().filter(function (p) { return p.key !== me; }).map(function (p) {
    const ck = 'bd:' + (p.key || 'MACDINH') + ':' + t, hit = c.get(ck);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
    const r = { name: p.name, m: 0, today: 0, streak: 0 };
    try {
      const sh = SpreadsheetApp.openById(p.sheet).getSheetByName('xp');
      if (sh && sh.getLastRow() > 1) {
        const days = {};
        sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (x) {
          if (!x[0]) return;
          const k = key_(x[0]), xp = Number(x[1]) || 0;
          r.m += xp; if (xp > 0) days[k] = 1; if (k === t) r.today = xp;
        });
        let d = days[t] ? t : addDays_(t, -1);
        while (days[d]) { r.streak++; d = addDays_(d, -1); }
      }
    } catch (e) { r.err = 1; }
    c.put(ck, JSON.stringify(r), 600);
    return r;
  });
}

// ===== v9: mã lượt (chống ghi trùng) + mét do backend tính =====
function newId_(prefix) {
  return (prefix || '') + Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss') + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
}
function cleanEid_(e) { e = String(e || '').slice(0, 64); return /^[A-Za-z0-9_-]{8,64}$/.test(e) ? e : ''; }
function clamp_(v, a, b) { v = Math.round(Number(v) || 0); return Math.max(a, Math.min(b, v)); }
function goal_() { const g = Number(prop_('GOAL' + sfx_())); return g >= 150 && g <= 2000 ? g : 400; }

let EV_ = null; // bộ nhớ tạm trong một lần chạy
function events_() { if (!EV_) EV_ = rows_(sh_('events'), 7); return EV_; }
function eventOf_(eid) {
  if (!eid) return null;
  const v = events_();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]) === eid) return v[i];
  return null;
}
function evData_(r) { try { return JSON.parse(r[6] || '{}'); } catch (e) { return {}; } }
function todayXp_() {
  const t = today_(), xv = rows_(sh_('xp'), 2);
  for (let i = 0; i < xv.length; i++) if (key_(xv[i][0]) === t) return Number(xv[i][1]) || 0;
  return 0;
}
// Ghi một sự kiện học + cộng mét (gọi bên trong lock). base = số mét gốc; vượt 2× mục tiêu ngày thì phần dư tính 1/4.
function earn_(eid, kind, ref, base, data, cnt) {
  base = Math.max(0, Math.round(Number(base) || 0));
  let xp = base;
  if (xp > 0) {
    const soft = 2 * goal_(), before = todayXp_();
    if (before >= soft) xp = Math.round(xp * SOFT_TAIL);
    else if (before + xp > soft) xp = Math.round((soft - before) + (before + xp - soft) * SOFT_TAIL);
  }
  const sh = sh_('events'), r = sh.getLastRow() + 1;
  const row = [eid || ('s' + Utilities.getUuid().replace(/-/g, '').slice(0, 15)), new Date(), today_(), String(kind), String(ref || '').slice(0, 200), xp, JSON.stringify(data || {}).slice(0, 3000)];
  sh.getRange(r, 1).setNumberFormat('@'); sh.getRange(r, 3).setNumberFormat('@');
  sh.getRange(r, 1, 1, 7).setValues([row]);
  if (EV_) EV_.push(row);
  cnt = cnt || {};
  if (xp || cnt.l || cnt.c || cnt.a) addXp_(xp, cnt.l || 0, cnt.c || 0, cnt.a || 0);
  return xp;
}
// sự kiện gần đây cho giao diện (báo cáo tuần, gợi ý hôm nay)
function recentEvents_(days) {
  // v10: bảng events chỉ nối thêm theo thời gian → đọc từ cuối lên từng khối 300 dòng, dừng khi cả khối đã cũ hơn mốc.
  const lim = addDays_(today_(), -(days || 35)), out = [];
  if (EV_) {
    EV_.forEach(function (r) {
      if (!r[0] || String(r[2]) < lim) return;
      out.push({ d: String(r[2]), k: String(r[3]), r: String(r[4]), x: Number(r[5]) || 0, data: evData_(r) });
    });
    return out;
  }
  const sh = sh_('events'), last = sh.getLastRow();
  let end = last;
  const chunks = [];
  while (end >= 2) {
    const start = Math.max(2, end - 299), v = sh.getRange(start, 1, end - start + 1, 7).getValues();
    chunks.unshift(v);
    if (v.every(function (r) { return !r[0] || String(r[2]) < lim; })) break;
    end = start - 1;
  }
  chunks.forEach(function (v) {
    v.forEach(function (r) {
      if (!r[0] || String(r[2]) < lim) return;
      out.push({ d: String(r[2]), k: String(r[3]), r: String(r[4]), x: Number(r[5]) || 0, data: evData_(r) });
    });
  });
  return out;
}
// Ngày thứ Hai bắt đầu lộ trình của người dùng (Script Property START hoặc START_<MÃ>, dạng yyyy-MM-dd). Trống = mặc định của web (2026-11-02).
function planStart_() {
  const v = String(prop_('START' + sfx_()) || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}
function saveGoal(pin, g) {
  checkPin_(pin);
  g = Number(g);
  if ([250, 400, 600].indexOf(g) < 0) throw new Error('Mục tiêu không hợp lệ');
  PropertiesService.getScriptProperties().setProperty('GOAL' + sfx_(), String(g));
  return g;
}

// ===== Đọc toàn bộ =====
function getState(pin) {
  checkPin_(pin);
  try { applyChatGrades_(); } catch (e) {}
  let challenges = [];
  try { challenges = checkFlags_(); } catch (e) { Logger.log('Thử thách: ' + e); }
  const days = {};
  rows_(sh_('days'), 4).forEach(function (r) {
    if (r[0]) days[key_(r[0])] = { am: r[1] === true, pm: r[2] === true, note: String(r[3] || '') };
  });
  const units = { grammar: {}, listening: {}, reading: {} };
  rows_(sh_('units'), 3).forEach(function (r) {
    if (r[0] && units[r[0]]) units[r[0]][Number(r[1])] = r[2] === true;
  });
  return {
    days: days, units: units, subs: getSubmissions_(), vocab: getVocab_(), xp: getXp_(), progress: getProgress_(), readings: getReadings_(),
    rstats: getRStats_(), rnotes: getRNotes_(), bank: getBank_(), packVer: prop_('PACK_VER') || '1',
    today: today_(), aiEnabled: aiAllowed_(), planStart: planStart_(),
    errors: getErrors_(), events: recentEvents_(35), challenges: challenges, goal: goal_(),
    me: { name: CUR_ ? CUR_.name : '', key: userKey_() }, buddies: buddies_(), highlights: getHighlights_()
  };
}

// ===== Tick ngày / unit =====
function saveDay(pin, date, am, pm, note) {
  checkPin_(pin);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Ngày không hợp lệ');
  return withLock_(function () {
    const sh = sh_('days');
    const row = [date, !!am, !!pm, String(note || '').slice(0, 500), new Date()];
    const full = rows_(sh, 3);
    let before = 0, at = -1;
    for (let i = 0; i < full.length; i++) {
      if (key_(full[i][0]) === date) { at = i; before = (full[i][1] === true ? 1 : 0) + (full[i][2] === true ? 1 : 0); break; }
    }
    if (at >= 0) sh.getRange(at + 2, 1, 1, 5).setValues([row]);
    else { const r = sh.getLastRow() + 1; sh.getRange(r, 1).setNumberFormat('@'); sh.getRange(r, 1, 1, 5).setValues([row]); }
    const delta = ((am ? 1 : 0) + (pm ? 1 : 0)) - before;
    if (delta) addXp_(delta * XP_TICK, 0, 0, 0);   // tick ca học: +20 m mỗi ca, bỏ tick thì trừ lại
    return true;
  });
}

function saveUnit(pin, book, unit, done) {
  checkPin_(pin);
  if (['grammar', 'listening', 'reading'].indexOf(book) < 0) throw new Error('Sách không hợp lệ');
  unit = Number(unit);
  return withLock_(function () {
    const sh = sh_('units');
    const vals = rows_(sh, 2);
    for (let i = 0; i < vals.length; i++) {
      if (vals[i][0] === book && Number(vals[i][1]) === unit) {
        sh.getRange(i + 2, 3, 1, 2).setValues([[!!done, new Date()]]);
        return true;
      }
    }
    sh.appendRow([book, unit, !!done, new Date()]);
    return true;
  });
}

// ===== Nộp bài =====
function getSubmissions_() {
  const v = rows_(sh_('submissions'), 12);
  const out = [];
  for (let i = v.length - 1; i >= 0 && out.length < 60; i--) {
    const r = v[i];
    if (!r[0]) continue;
    out.push({
      id: String(r[0]),
      created: r[1] instanceof Date ? Utilities.formatDate(r[1], TZ, 'yyyy-MM-dd HH:mm') : String(r[1]),
      type: String(r[2]), ref: String(r[3]), prompt: String(r[4]), answer: String(r[5]),
      selfScore: String(r[6]), minutes: String(r[7]), result: String(r[8] || ''), feedback: String(r[9] || ''),
      grading: String(r[10] || ''), rewrite: String(r[11] || '')
    });
  }
  return out;
}

function saveSubmission(pin, s) {
  checkPin_(pin);
  const types = ['writing', 'grammar', 'listening', 'reading', 'speaking'];
  if (!s || types.indexOf(s.type) < 0) throw new Error('Loại bài không hợp lệ');
  const answer = String(s.answer || '').trim();
  if (!answer) throw new Error('Chưa có nội dung bài làm');
  const eid = cleanEid_(s.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { id: String(ev[4]), subs: getSubmissions_(), xp: getXp_(), earned: 0, dup: true };
    const id = newId_();
    const sh = sh_('submissions');
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setNumberFormat('@');
    sh.getRange(r, 1, 1, 12).setValues([[id, new Date(), s.type, String(s.ref || '').slice(0, 200),
      String(s.prompt || '').slice(0, 3000), answer.slice(0, 20000),
      String(s.selfScore || '').slice(0, 50), String(s.minutes || ''), '', '', '', '']]);
    const words = (answer.match(/\S+/g) || []).length;
    let base = 0;
    if (s.type === 'writing') base = words >= 40 ? XPR.write : 10;
    if (s.type === 'speaking') base = words >= 60 ? XPR.speak : 10;
    const earned = earn_(eid, 'sub:' + s.type, id, base, { w: words, min: Number(s.minutes) || 0 }, { l: 1 });
    return { id: id, subs: getSubmissions_(), xp: getXp_(), earned: earned };
  });
}

// ===== Chấm Writing bằng Claude API =====
const RUBRIC_PROMPT = [
  'You are a strict, experienced IELTS Writing examiner and a supportive teacher.',
  'Grade with the four official IELTS Writing criteria, whole or half bands:',
  '- TR: Task Response (Task 2) / Task Achievement (Task 1): every part of the question answered, clear position throughout, ideas extended and supported. Task 1: clear overview of the main trends/stages, key features selected and supported with accurate figures, no opinions or explanations beyond the data.',
  '- CC: Coherence and Cohesion: logical progression, one central idea per paragraph, linking and referencing that support meaning without drawing attention.',
  '- LR: Lexical Resource: range, precision and naturalness of vocabulary, collocation, spelling, word formation.',
  '- GRA: Grammatical Range and Accuracy: mix of simple and complex structures, proportion of error-free sentences, punctuation.',
  '',
  'Calibration rules taken from official examiner comments. Apply them strictly:',
  '1. Language copied from the question earns no credit. Ignore copied stretches when judging TR, LR and length, and note it if the introduction mostly repeats the question.',
  '2. Task 1 with no clear overview cannot score above 5 for TR. Task 1 with no figures from the data, or with personal opinion, letter format or speculation, is capped at TR 5-6.',
  '3. Task 2 with an unclear or inconsistent position: TR 5 or below. Ideas listed without explanation or example: TR 5.',
  '4. Under-length (Task 1 < 150, Task 2 < 250 words, excluding copied question text) lowers TR.',
  '5. Bullet points or note form anywhere: lower TR and CC.',
  '6. No paragraphing or illogical paragraphing: CC 5 at most. Linkers placed at the start of most sentences, overused or misused ("mechanical" cohesion): CC 6 at most even if the ideas are clear.',
  '7. Memorised template phrases (e.g. "This essay will discuss", "every coin has two sides", "in this day and age") and idioms are not credited and count as inappropriate style in LR.',
  '8. "Impressive" words used inaccurately (e.g. plethora, elucidate, paradigm) lower LR more than simple accurate words. Repeating key topic words is normal and is NOT penalised; penalise repetition only when it shows a lack of basic vocabulary.',
  '9. GRA: band 7 needs frequent error-free sentences; if roughly half or more of the sentences contain errors, GRA is 5.5 or lower; band 4 when errors are in nearly every sentence and complex structures are rare and inaccurate. Accuracy outweighs attempted complexity.',
  '10. Spelling and word-form errors that make the reader re-read keep LR at 5-5.5 even when the range is good.',
  '',
  'Reference profiles from official examiner comments:',
  'Band 4: position hard to find, ideas limited and unclear, little progression, basic vocabulary with frequent word-choice errors that strain the reader, very limited structures, high error density.',
  'Band 5: task addressed but key features or development missing (Task 1: no overview or no figures), mechanical linking, vocabulary minimally adequate, structures limited and complex attempts often fail, frequent errors.',
  'Band 5.5: relevant position but some ideas undeveloped, organised overall but paragraphs too short or mechanical linkers, adequate range but weak control and frequent spelling errors.',
  'Band 6: all parts covered but some information missing or overgeneralised, flows but connectives overused or inappropriate, some flexibility in vocabulary with imprecise choices, good control of simple structures but limited complexity, errors rarely impede meaning.',
  'Band 6.5: clear position and generally well-developed arguments, some generalisation, repeats wording from the question, varied vocabulary with less common phrases, regular grammar errors that do not reduce clarity.',
  'Band 7: clear position throughout, ideas extended and supported, clear progression with a range of cohesive devices, flexible and precise vocabulary with occasional awkwardness, varied complex structures and frequent error-free sentences.',
  '',
  'Typical problems of Vietnamese learners to check explicitly (from the learner\'s course notes): body paragraphs without a specific main idea or with ideas not explained (ask Why? How? Example?); one paragraph trying to cover several ideas; a linker at the start of every sentence while the logic between supporting sentences is weak; vague "it/this/they" instead of naming the noun ("this trend"); weak words (good, bad, big, a lot of, kids, shows); word-form errors (an improve, a success program); memorised long "fancy" phrases out of context; articles, plurals, subject-verb agreement and tense errors repeated across the essay; fragments and comma splices; Task 1 listing every number without an overview.',
  'Task types: "paragraph" is a single 150-word paragraph practice: grade it like a Task 2 body paragraph and do not penalise missing introduction or conclusion. "intro" is an introduction-only practice: judge how well it paraphrases the question in the writer\'s own words and states a clear position; grade all four criteria on that short text and do not penalise length.',
  'The writer is currently around band 4-5. Do not inflate.',
  '',
  'Feedback: write every comment, "why" and "next" field in Vietnamese, short and concrete. Keep "original" and "better" in English. "original" must be copied exactly from the essay. Give the 3-6 most useful fixes, prioritising repeated errors and the weakest criterion; tag each fix with the criterion it mainly improves in "k" (TR, CC, LR or GRA) and with the error type in "t", exactly one of: art (articles), tense (verb tense/form), agr (subject-verb agreement, singular/plural), wf (word form), prep (prepositions), word (word choice, collocation), link (linking and referencing between sentences/clauses), sent (sentence structure: fragments, run-ons, comma splices, word order), spell (spelling), idea (unclear, unsupported or undeveloped idea), style (informal or memorised style); keep "better" simple and natural, not fancy. Give up to 6 vocabulary upgrades the writer can actually reuse.',
  'Return ONLY valid JSON, no markdown, in this exact shape:',
  '{"criteria":{"TR":{"band":5,"comment":""},"CC":{"band":5,"comment":""},"LR":{"band":5,"comment":""},"GRA":{"band":5,"comment":""}},',
  '"strengths":[""],"fixes":[{"k":"GRA","t":"tense","original":"","better":"","why":""}],"vocab":[{"from":"","to":""}],"next":""}'
].join('\n');

function ieltsRound_(avg) {
  const q = Math.floor(avg * 4) / 4; // .125 → xuống, .25 → .5, .75 → lên số tròn
  return Math.ceil(q * 2) / 2;
}

// Gọi Claude API, trả về object JSON trong câu trả lời
function callClaude_(model, system, messages, maxTokens) {
  const key = prop_('ANTHROPIC_API_KEY');
  if (!key || !aiAllowed_()) throw new Error('NO_KEY');
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: maxTokens || 2000, system: system, messages: messages })
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('API lỗi ' + code + ': ' + res.getContentText().slice(0, 300));
  const body = JSON.parse(res.getContentText());
  const text = (body.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

function findSubRow_(sh, id) {
  const ids = rows_(sh, 1);
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  throw new Error('Không tìm thấy bài');
}

// band cao nhất trước đây của cùng loại bài (để thưởng khi tiến bộ)
function bestBand_(sh, type, exceptRow) {
  let best = 0;
  rows_(sh, 11).forEach(function (r, i) {
    if (i + 2 === exceptRow || String(r[2]) !== type || !r[10]) return;
    try { best = Math.max(best, Number(JSON.parse(r[10]).overall) || 0); } catch (e) {}
  });
  return best;
}

function gradeSubmission(pin, id, task) {
  checkPin_(pin);
  const sh = sh_('submissions');
  const row = findSubRow_(sh, id);
  const r = sh.getRange(row, 1, 1, 6).getValues()[0];
  if (r[2] !== 'writing') throw new Error('Chỉ chấm tự động được bài Writing');
  const answer = String(r[5]);
  const words = (answer.match(/\S+/g) || []).length;
  const taskName = { paragraph: 'paragraph (150-word paragraph practice)', intro: 'intro (introduction-only practice)', task1: 'IELTS Academic Writing Task 1', task2: 'IELTS Writing Task 2' }[task] || 'IELTS Writing Task 2';
  const g = callClaude_(MODEL, RUBRIC_PROMPT, [{ role: 'user', content:
    'Task type: ' + taskName + '\nQuestion: ' + (String(r[4]) || '(not given)') +
    '\nWord count: ' + words + '\n\nEssay:\n"""\n' + answer + '\n"""' }], 3000);
  const bands = ['TR', 'CC', 'LR', 'GRA'].map(function (k) { return Number(g.criteria && g.criteria[k] && g.criteria[k].band) || 0; });
  g.overall = ieltsRound_(bands.reduce(function (a, b) { return a + b; }, 0) / 4);
  g.task = task || 'task2'; g.words = words; g.by = 'api';
  const summary = 'Band ' + g.overall + ' (TR ' + bands[0] + ', CC ' + bands[1] + ', LR ' + bands[2] + ', GRA ' + bands[3] + ')\n' + (g.next || '');
  withLock_(function () {
    const prev = bestBand_(sh, 'writing', row);
    sh.getRange(row, 9, 1, 3).setValues([['Band ' + g.overall, summary, JSON.stringify(g)]]);
    if (prev && g.overall > prev) earn_('', 'better', id, XPR.better, { b: g.overall, p: prev });
    addErrorsFromGrade_(id, 'writing', g, String(r[3]));
  });
  return getSubmissions_();
}

// ===== Speaking: giám khảo AI =====
const SPEAK_TURN_PROMPT = [
  'You are a friendly but professional IELTS Speaking examiner talking to a Vietnamese candidate (about band 4.5-5).',
  'You receive the test part, the topic and the conversation so far. Produce ONLY the next examiner line.',
  'Part 1: short personal questions on the given topic; you may ask one natural follow-up based on what the candidate just said, otherwise move to the next prepared question.',
  'Part 3: abstract discussion linked to the Part 2 topic; ask why/how/compare/future questions, and push gently for reasons and examples if the last answer was short.',
  'Keep each question under 25 words, natural spoken British English, no feedback inside "say".',
  'If coach is true, also give "tip": 1-2 short Vietnamese sentences on the candidate\'s LAST answer (what to add or fix) plus "better": one improved version of their last answer in natural English at band 6.5, keeping their ideas, max 45 words. If coach is false, set tip and better to "".',
  'Return ONLY JSON: {"say":"","tip":"","better":""}'
].join('\n');

function speakTurn(pin, p) {
  checkPin_(pin);
  const hist = (p && p.history || []).slice(-12).map(function (t) { return (t.who === 'ex' ? 'Examiner: ' : 'Candidate: ') + String(t.text || '').slice(0, 1500); }).join('\n');
  const msg = 'Part: ' + (p.part || 1) + '\nTopic: ' + String(p.topic || '').slice(0, 300) +
    (p.prepared ? '\nPrepared questions you may use: ' + String(p.prepared).slice(0, 800) : '') +
    '\nCoach: ' + (p.coach ? 'true' : 'false') + '\n\nConversation so far:\n' + (hist || '(start)');
  return callClaude_(MODEL_FAST, SPEAK_TURN_PROMPT, [{ role: 'user', content: msg }], 600);
}

const SPEAK_GRADE_PROMPT = [
  'You are a strict, experienced IELTS Speaking examiner and a supportive teacher. You receive a transcript of a speaking practice made with phone dictation, so ignore punctuation, capitalisation and obvious dictation glitches.',
  'Grade three criteria with whole or half bands: FC (Fluency and Coherence: length of answers, extending with reasons and examples, logical linking, staying on topic; very short answers cap FC at 5), LR (Lexical Resource: range, collocation, idiomatic but natural language, paraphrase), GRA (Grammatical Range and Accuracy: mix of structures, tense control, error density).',
  'Pronunciation CANNOT be judged from text: do not grade it.',
  'Use the speaking rate if given (words per minute; below ~90 suggests hesitation). The candidate is currently around band 4.5-5: do not inflate.',
  'Write comments, "why" and "next" in Vietnamese, short and concrete. Keep English in "original", "better" and phrases.',
  'Return ONLY JSON: {"criteria":{"FC":{"band":5,"comment":""},"LR":{"band":5,"comment":""},"GRA":{"band":5,"comment":""}},',
  '"strengths":[""],"fixes":[{"t":"tense","original":"","better":"","why":""}],',
  '"answers":[{"q":"<examiner question>","better":"<band 6.5-7 version of the candidate answer keeping their ideas, 40-80 words>"}],',
  '"vocab":[{"from":"<simple word they used>","to":"<better natural phrase>"}],"next":""}',
  'Give 3-5 fixes (repeated errors first), up to 3 improved answers (choose their weakest), up to 6 vocab upgrades.',
  'Tag each fix with "t", exactly one of: art, tense, agr, wf, prep, word, link, sent, spell, idea, style (articles, tense, agreement/plural, word form, prepositions, word choice/collocation, linking, sentence structure, spelling, undeveloped idea, style).'
].join('\n');

function gradeSpeaking(pin, id) {
  checkPin_(pin);
  const sh = sh_('submissions');
  const row = findSubRow_(sh, id);
  const r = sh.getRange(row, 1, 1, 8).getValues()[0];
  if (r[2] !== 'speaking') throw new Error('Không phải bài Speaking');
  const g = callClaude_(MODEL, SPEAK_GRADE_PROMPT, [{ role: 'user', content:
    'Practice: ' + String(r[3]) + '\nSpeaking rate: ' + (String(r[6]) || 'unknown') + '\n\nTranscript:\n"""\n' + String(r[5]).slice(0, 15000) + '\n"""' }], 3500);
  const bands = ['FC', 'LR', 'GRA'].map(function (k) { return Number(g.criteria && g.criteria[k] && g.criteria[k].band) || 0; });
  g.overall = ieltsRound_(bands.reduce(function (a, b) { return a + b; }, 0) / 3);
  g.by = 'api'; g.kind = 'speaking';
  withLock_(function () {
    const prev = bestBand_(sh, 'speaking', row);
    sh.getRange(row, 9, 1, 3).setValues([['Band ' + g.overall, 'Speaking ước tính ' + g.overall + ' (FC ' + bands[0] + ', LR ' + bands[1] + ', GRA ' + bands[2] + ', chưa tính phát âm)\n' + (g.next || ''), JSON.stringify(g)]]);
    if (prev && g.overall > prev) earn_('', 'better', id, XPR.better, { b: g.overall, p: prev });
    addErrorsFromGrade_(id, 'speaking', g, String(r[3]));
  });
  return getSubmissions_();
}

// ===== Reading: thư viện bài, làm bài, ghi chú =====
function getReadings_() {
  // v10: chỉ đọc các cột cần (A–D và L–O), bỏ cột nội dung bài đọc/câu hỏi (rất nặng). Giao diện không dùng `size`.
  const sh = sh_('reading'), last = sh.getLastRow();
  if (last < 2) return [];
  const a = sh.getRange(2, 1, last - 1, 4).getValues(), b = sh.getRange(2, 12, last - 1, 4).getValues();
  const out = [];
  a.forEach(function (r, i) {
    if (!r[0]) return;
    const q = b[i];
    let kinds = [];
    try { kinds = JSON.parse(r[3] || '[]'); } catch (e) {}
    out.push({ id: String(r[0]), source: String(r[1]), title: String(r[2]), kinds: kinds,
      best: q[0] === '' ? null : Number(q[0]), attempts: Number(q[1]) || 0, last: q[2] ? key_(q[2]) : '',
      size: 0, ai: !!q[3] });
  });
  return out;
}

function getReading(pin, id) {
  checkPin_(pin);
  const sh = sh_('reading');
  const vals = rows_(sh, 15);
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (String(r[0]) !== String(id)) continue;
    let kinds = [], syn = [];
    try { kinds = JSON.parse(r[3] || '[]'); } catch (e) {}
    try { syn = JSON.parse(r[8] || '[]'); } catch (e) {}
    const attempts = rows_(sh_('rattempts'), 7).filter(function (a) { return String(a[1]) === String(id); }).map(function (a) {
      let d = {}; try { d = JSON.parse(a[6] || '{}'); } catch (e) {}
      return { id: String(a[0]), created: a[2] instanceof Date ? Utilities.formatDate(a[2], TZ, 'yyyy-MM-dd HH:mm') : String(a[2]), score: Number(a[3]) || 0, total: Number(a[4]) || 0, minutes: String(a[5] || ''), detail: d };
    }).reverse();
    return { id: String(r[0]), source: String(r[1]), title: String(r[2]), kinds: kinds, passage: String(r[4]), questions: String(r[5]),
      key: String(r[6]), notes: String(r[7]), syn: syn, attempts: attempts, pack: String(r[14] || '') };
  }
  throw new Error('Không tìm thấy bài Reading');
}

function saveReading(pin, x) {
  checkPin_(pin);
  if (!x || !String(x.title || '').trim()) throw new Error('Chưa có tiêu đề bài');
  if (!String(x.passage || '').trim()) throw new Error('Chưa dán đoạn văn');
  const lim = function (s, n) { return String(s || '').slice(0, n); };
  return withLock_(function () {
    const sh = sh_('reading');
    const vals = rows_(sh, 1);
    const now = new Date();
    const data = [lim(x.source, 200), lim(x.title, 200), JSON.stringify((x.kinds || []).slice(0, 11)), lim(x.passage, 45000), lim(x.questions, 30000), lim(x.key, 4000)];
    if (x.id) {
      for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(x.id)) {
        sh.getRange(i + 2, 2, 1, 6).setValues([data]);
        sh.getRange(i + 2, 11).setValue(now);
        if (x.pack !== undefined) sh.getRange(i + 2, 15).setValue(lim(x.pack, 49000));
        return { id: String(x.id), readings: getReadings_() };
      }
    }
    const id = newId_('R');
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setNumberFormat('@');
    sh.getRange(r, 1, 1, 15).setValues([[id].concat(data, ['', '[]', now, now, '', 0, '', lim(x.pack, 49000)])]);
    return { id: id, readings: getReadings_() };
  });
}

function deleteReading(pin, id) {
  checkPin_(pin);
  return withLock_(function () {
    const sh = sh_('reading');
    const vals = rows_(sh, 1);
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(id)) { sh.deleteRow(i + 2); break; }
    return getReadings_();
  });
}

function saveReadingNotes(pin, id, notes, syn) {
  checkPin_(pin);
  return withLock_(function () {
    const sh = sh_('reading');
    const vals = rows_(sh, 1);
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(id)) {
      sh.getRange(i + 2, 8, 1, 2).setValues([[String(notes || '').slice(0, 20000), JSON.stringify((syn || []).slice(0, 200))]]);
      sh.getRange(i + 2, 11).setValue(new Date());
      return true;
    }
    // bài trong bộ đề (gói nội dung trên Drive): ghi chú lưu ở tab rnotes
    const ns = sh_('rnotes');
    const nv = rows_(ns, 1);
    const rec = [String(id), String(notes || '').slice(0, 20000), JSON.stringify((syn || []).slice(0, 200)), new Date()];
    for (let i = 0; i < nv.length; i++) if (String(nv[i][0]) === String(id)) { ns.getRange(i + 2, 1, 1, 4).setValues([rec]); return true; }
    const r = ns.getLastRow() + 1;
    ns.getRange(r, 1).setNumberFormat('@');
    ns.getRange(r, 1, 1, 4).setValues([rec]);
    return true;
  });
}

function getRNotes_() {
  const out = {};
  rows_(sh_('rnotes'), 3).forEach(function (r) {
    if (!r[0]) return;
    let syn = [];
    try { syn = JSON.parse(r[2] || '[]'); } catch (e) {}
    out[String(r[0])] = { notes: String(r[1] || ''), syn: syn };
  });
  return out;
}

// Thống kê Reading cho giao diện: tỉ lệ đúng theo dạng câu hỏi + câu sai gần nhất của từng bài (để làm lại sau 7 ngày)
function getRStats_() {
  const byType = {}, latest = {}, done = {};
  rows_(sh_('rattempts'), 7).forEach(function (r) {
    if (!r[0]) return;
    let d = {};
    try { d = JSON.parse(r[6] || '{}'); } catch (e) {}
    const rid = String(r[1]), date = r[2] instanceof Date ? Utilities.formatDate(r[2], TZ, 'yyyy-MM-dd') : String(r[2]).slice(0, 10);
    Object.keys(d.bytype || {}).forEach(function (t) {
      const v = d.bytype[t];
      byType[t] = byType[t] || [0, 0];
      byType[t][0] += Number(v[0]) || 0; byType[t][1] += Number(v[1]) || 0;
    });
    (d.groups || []).forEach(function (g) { done[rid + ':' + g] = 1; });
    if (d.mode === 'retry') { if (latest[rid]) latest[rid].wrong = (d.wrong || []).slice(0, 40), latest[rid].date = date; return; }
    if (d.mode !== 'type') latest[rid] = { date: date, wrong: (d.wrong || []).slice(0, 40), score: Number(r[3]) || 0, total: Number(r[4]) || 0 };
  });
  return { byType: byType, latest: latest, groupsDone: Object.keys(done) };
}

// a = {eid, rid, score, total, minutes, detail:{mode, exam, kind, answers, wrong, bytype, groups}}
// Mét do backend tính: lần đầu làm cả bài = 5/câu đúng + 20; làm lại cả bài chỉ được thưởng khi vượt điểm cũ;
// luyện dạng: chỉ nhóm câu mới; làm lại câu sai sau 7 ngày = 10/câu đúng.
function saveReadingAttempt(pin, a) {
  checkPin_(pin);
  const eid = cleanEid_(a && a.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { id: String(ev[4]), readings: getReadings_(), xp: getXp_(), progress: getProgress_(), rstats: getRStats_(), earned: 0, dup: true };
    const now = new Date();
    const id = newId_('A');
    const d = a.detail || {}, mode = d.mode || 'full';
    const total = clamp_(a.total, 0, 60), score = clamp_(a.score, 0, total);
    const pct = total ? Math.round(score / total * 100) : 0;
    const at = sh_('rattempts');
    // các lần làm trước của bài này (để tính mét)
    let fullBefore = 0, bestPct = -1;
    const groupsBefore = {};
    rows_(at, 7).forEach(function (r) {
      if (String(r[1]) !== String(a.rid)) return;
      let x = {}; try { x = JSON.parse(r[6] || '{}'); } catch (e) {}
      const m = x.mode || 'full';
      if (m === 'full') { fullBefore++; const t = Number(r[4]) || 0; if (t) bestPct = Math.max(bestPct, Math.round((Number(r[3]) || 0) / t * 100)); }
      (x.groups || []).forEach(function (g) { groupsBefore[g] = 1; });
    });
    const r = at.getLastRow() + 1;
    at.getRange(r, 1, 1, 2).setNumberFormat('@');
    at.getRange(r, 1, 1, 7).setValues([[id, String(a.rid), now, score, total, String(a.minutes || ''), JSON.stringify(d).slice(0, 45000)]]);
    clearHighlights_(a.rid); // làm xong bài thì bỏ các chỗ tô của bài đó
    const sh = sh_('reading');
    const vals = rows_(sh, 14);
    let found = false;
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(a.rid)) {
      const best = vals[i][11] === '' ? pct : Math.max(Number(vals[i][11]) || 0, pct);
      sh.getRange(i + 2, 14).setNumberFormat('@');
      sh.getRange(i + 2, 12, 1, 3).setValues([[best, (Number(vals[i][12]) || 0) + 1, today_()]]);
      found = true;
      break;
    }
    // bài trong bộ đề: điểm tốt nhất lưu ở tab progress với khóa r:<id> (chỉ tính lần làm cả bài)
    if (!found && /^[a-z0-9-]{1,40}$/i.test(String(a.rid)) && mode === 'full') {
      const ps = sh_('progress');
      const pv = rows_(ps, 4), k = 'r:' + a.rid;
      let row = -1, prev = null;
      for (let i = 0; i < pv.length; i++) if (String(pv[i][0]) === k) { row = i + 2; prev = pv[i]; break; }
      const rec = [k, 'tried', Math.max(pct, prev ? Number(prev[2]) || 0 : 0), (prev ? Number(prev[3]) || 0 : 0) + 1, JSON.stringify((d.wrong || []).slice(0, 40)), new Date()];
      if (row > 0) ps.getRange(row, 1, 1, 6).setValues([rec]);
      else { const pr = ps.getLastRow() + 1; ps.getRange(pr, 1).setNumberFormat('@'); ps.getRange(pr, 1, 1, 6).setValues([rec]); }
    }
    let base = 0;
    if (mode === 'full') base = fullBefore ? (pct > bestPct ? XPR.bestUp : 0) : score * XPR.readQ + XPR.readFull;
    else if (mode === 'type') base = (d.groups || []).some(function (g) { return !groupsBefore[g]; }) ? score * XPR.readQ + XPR.readGroup : 0;
    else if (mode === 'retry') base = score * XPR.retryQ;
    const earned = earn_(eid, 'read', String(a.rid), base,
      { m: mode, s: score, t: total, x: d.exam ? 1 : 0, k: d.kind === 'listening' ? 'L' : 'R', min: Number(a.minutes) || 0 },
      { l: 1, c: score, a: total });
    return { id: id, readings: getReadings_(), xp: getXp_(), progress: getProgress_(), rstats: getRStats_(), earned: earned, highlights: getHighlights_() };
  });
}

// ===== v9.2: tô từ trong bài đọc (riêng từng người, nằm trong Sheet của người đó; xoá khi nộp bài) =====
function getHighlights_() {
  const out = {};
  rows_(sh_('highlights'), 2).forEach(function (r) {
    if (!r[0]) return;
    try { const w = JSON.parse(r[1] || '[]'); if (w.length) out[String(r[0])] = w; } catch (e) {}
  });
  return out;
}
function clearHighlights_(rid) {
  const sh = sh_('highlights'), v = rows_(sh, 1);
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]) === String(rid)) sh.deleteRow(i + 2);
}
function saveHighlights(pin, rid, words) {
  checkPin_(pin);
  rid = String(rid || '').slice(0, 80);
  if (!rid) throw new Error('Bài không hợp lệ');
  const list = (Array.isArray(words) ? words : []).map(function (w) { return String(w || '').trim().slice(0, 80); }).filter(String).slice(0, 200);
  return withLock_(function () {
    const sh = sh_('highlights'), v = rows_(sh, 1);
    let at = -1;
    for (let i = 0; i < v.length; i++) if (String(v[i][0]) === rid) { at = i + 2; break; }
    if (!list.length) { if (at > 0) sh.deleteRow(at); return true; }
    const row = [rid, JSON.stringify(list), new Date()];
    if (at > 0) sh.getRange(at, 1, 1, 3).setValues([row]);
    else { const r = sh.getLastRow() + 1; sh.getRange(r, 1).setNumberFormat('@'); sh.getRange(r, 1, 1, 3).setValues([row]); }
    return true;
  });
}

// cập nhật phân tích câu sai cho lần làm gần nhất
function saveAttemptDetail(pin, attemptId, detail) {
  checkPin_(pin);
  return withLock_(function () {
    const at = sh_('rattempts');
    const vals = rows_(at, 1);
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(attemptId)) {
      at.getRange(i + 2, 7).setValue(JSON.stringify(detail || {}).slice(0, 45000));
      return true;
    }
    throw new Error('Không tìm thấy lần làm bài');
  });
}

// ===== Từ vựng =====
function getVocab_() {
  const out = [];
  rows_(sh_('vocab'), 11).forEach(function (r) {
    if (!r[0]) return;
    out.push({ id: String(r[0]), word: String(r[1]), meaning: String(r[2]), example: String(r[3]),
      source: String(r[4]), box: Number(r[5]) || 0, due: key_(r[6]),
      seen: Number(r[9]) || 0, lapses: Number(r[10]) || 0 });
  });
  return out;
}

function addWords(pin, list) {
  checkPin_(pin);
  if (!Array.isArray(list) || !list.length) throw new Error('Chưa nhập từ');
  return withLock_(function () {
    const sh = sh_('vocab');
    const have = {};
    getVocab_().forEach(function (x) { have[x.word.toLowerCase()] = true; });
    const now = new Date(), t = today_(), stamp = Utilities.formatDate(now, TZ, 'yyMMddHHmmss') + Utilities.getUuid().slice(0, 4);
    const add = [];
    list.slice(0, 300).forEach(function (w, i) {
      const word = String((w && w.word) || '').trim();
      if (!word || have[word.toLowerCase()]) return;
      have[word.toLowerCase()] = true;
      add.push([stamp + String(i).padStart(3, '0'), word.slice(0, 200), String(w.meaning || '').slice(0, 500),
        String(w.example || '').slice(0, 500), String(w.source || '').slice(0, 100), 0, t, now, now, 0, 0]);
    });
    if (!add.length) throw new Error(list.length === 1 ? 'Từ này đã có trong sổ' : 'Các từ này đã có trong sổ');
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1, add.length, 1).setNumberFormat('@');
    sh.getRange(r, 7, add.length, 1).setNumberFormat('@');
    sh.getRange(r, 1, add.length, 11).setValues(add);
    return getVocab_();
  });
}

function deleteWord(pin, id) {
  checkPin_(pin);
  return withLock_(function () {
    const sh = sh_('vocab');
    const ids = rows_(sh, 1);
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 2); break; }
    }
    return getVocab_();
  });
}

// Sửa từ đã lưu: chỉ đổi chữ, nghĩa, câu ví dụ, nguồn. Giữ nguyên hộp ôn, ngày ôn, số lần ôn, số lần quên.
function updateWord(pin, id, w) {
  checkPin_(pin);
  const word = String((w && w.word) || '').trim();
  if (!word) throw new Error('Từ không được để trống');
  return withLock_(function () {
    const sh = sh_('vocab');
    const vals = rows_(sh, 5);
    let at = -1;
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === String(id)) at = i;
      else if (String(vals[i][1]).trim().toLowerCase() === word.toLowerCase()) throw new Error('Sổ đã có từ "' + word + '"');
    }
    if (at < 0) throw new Error('Không tìm thấy từ này (có thể đã bị xoá)');
    const old = vals[at];
    sh.getRange(at + 2, 2, 1, 4).setValues([[word.slice(0, 200), String(w.meaning == null ? old[2] : w.meaning).slice(0, 500),
      String(w.example == null ? old[3] : w.example).slice(0, 500), String(w.source == null ? old[4] : w.source).slice(0, 100)]]);
    sh.getRange(at + 2, 9).setValue(new Date());
    return getVocab_();
  });
}

// p = {eid, kind:'review'|'gwrong'|'shadow', results:[{id, ok}], correct, answered, avg}
// review: chỉ từ ĐẾN HẠN mới được mét (ôn sớm vẫn lưu tiến độ nhưng không cộng mét).
function saveLesson(pin, p) {
  checkPin_(pin);
  p = p || {};
  const results = (p.results || []).slice(0, 60);
  const kind = p.kind || (results.length ? 'review' : 'gwrong');
  const eid = cleanEid_(p.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { vocab: getVocab_(), xp: getXp_(), earned: 0, dup: true };
    const t = today_();
    let base = 0, data = {}, cnt = { l: 1, c: clamp_(p.correct, 0, 60), a: clamp_(p.answered, 0, 60) };
    if (kind === 'review') {
      const sh = sh_('vocab');
      const vals = rows_(sh, 11);
      const map = {};
      results.forEach(function (x) { map[String(x.id)] = !!x.ok; });
      let changed = false, okDue = 0, n = 0, allOk = true, mOk = 0, mTot = 0;
      vals.forEach(function (r) {
        const id = String(r[0]);
        if (!(id in map)) return;
        const ok = map[id], box = Number(r[5]) || 0, due = key_(r[6]), isDue = box === 0 || due <= t;
        n++; if (!ok) allOk = false;
        if (box >= 3) { mTot++; if (ok) mOk++; } // từ đã quen (khoảng ôn ≥ 7 ngày): đo trí nhớ dài hạn
        if (ok) {
          // từ khó (đã quên ít nhất 1 lần, còn ở hộp thấp): khoảng ôn rút một nửa để gặp lại sớm hơn
          const hard = (Number(r[10]) || 0) >= 1 && box <= 2;
          if (isDue) { const nb = Math.min(box + 1, SRS.length - 1); r[5] = nb; r[6] = addDays_(t, hard ? Math.max(1, Math.ceil(SRS[nb] / 2)) : SRS[nb]); okDue++; }
        } else {
          r[5] = 1; r[6] = addDays_(t, 1); r[10] = (Number(r[10]) || 0) + 1;
        }
        r[9] = (Number(r[9]) || 0) + 1;
        r[8] = new Date();
        changed = true;
      });
      if (changed) {
        sh.getRange(2, 7, vals.length, 1).setNumberFormat('@');
        sh.getRange(2, 1, vals.length, 11).setValues(vals.map(function (r) { r[6] = key_(r[6]); return r; }));
      }
      const left = vals.filter(function (r) { return r[0] && String(r[2]).trim() && ((Number(r[5]) || 0) === 0 || key_(r[6]) <= t); }).length;
      base = okDue * XPR.review + (n >= 4 && allOk ? XPR.perfect : 0);
      data = { n: n, ok: okDue, m: [mOk, mTot], clean: left === 0 };
    } else if (kind === 'shadow') {
      const done = events_().some(function (r) { return String(r[2]) === t && String(r[3]) === 'shadow'; });
      base = done ? 0 : 10 + Math.round(clamp_(p.avg, 0, 100) / 10);
      data = { avg: clamp_(p.avg, 0, 100) };
      cnt = { l: 1, c: 0, a: 0 };
    } else {
      base = Math.min(16, cnt.c) * XPR.correct; // làm đúng lại câu ngữ pháp đã sai
      data = { c: cnt.c, a: cnt.a };
    }
    const earned = earn_(eid, kind, '', base, data, cnt);
    return { vocab: getVocab_(), xp: getXp_(), earned: earned };
  });
}

function getXp_() {
  return rows_(sh_('xp'), 5).filter(function (r) { return r[0]; }).map(function (r) {
    return { date: key_(r[0]), xp: Number(r[1]) || 0, lessons: Number(r[2]) || 0, correct: Number(r[3]) || 0, answered: Number(r[4]) || 0 };
  });
}

// cộng XP vào ngày hôm nay (gọi bên trong lock)
function addXp_(xp, lessons, correct, answered) {
  const t = today_();
  const xs = sh_('xp');
  const xv = rows_(xs, 5);
  for (let i = 0; i < xv.length; i++) {
    if (key_(xv[i][0]) === t) {
      xs.getRange(i + 2, 2, 1, 5).setValues([[
        (Number(xv[i][1]) || 0) + xp, (Number(xv[i][2]) || 0) + lessons,
        (Number(xv[i][3]) || 0) + correct, (Number(xv[i][4]) || 0) + answered, new Date()]]);
      return;
    }
  }
  const r = xs.getLastRow() + 1;
  xs.getRange(r, 1).setNumberFormat('@');
  xs.getRange(r, 1, 1, 6).setValues([[t, xp, lessons, correct, answered, new Date()]]);
}

// ===== Lộ trình: tiến độ từng bài (từ vựng v01-1, ngữ pháp g3, ...) =====
function getProgress_() {
  const out = {};
  rows_(sh_('progress'), 6).forEach(function (r) {
    if (!r[0]) return;
    let wrong = [];
    try { wrong = JSON.parse(r[4] || '[]'); } catch (e) {}
    out[String(r[0])] = { status: String(r[1]), best: Number(r[2]) || 0, attempts: Number(r[3]) || 0, wrong: wrong, updated: r[5] ? key_(r[5]) : '' };
  });
  return out;
}

// p = {eid, key, pass, score (0-100), correct, answered, cards, slides, fix, wrong:[...], words:[{word, meaning, example, source, remember}]}
// Mét: chặng chưa qua = 10/câu đúng + 2/thẻ nhớ (+10 học lý thuyết) + 30 khi qua lần đầu; học lại chặng đã qua = 0.
// Chép chính tả: lần đầu = số từ đúng / 3 + 10; làm lại chỉ +10 khi điểm cao hơn lần trước.
// fix = true: chỉ cập nhật danh sách câu sai (sau khi ôn câu ngữ pháp sai), không tính lượt, không cộng mét.
function saveLessonResult(pin, p) {
  checkPin_(pin);
  if (!p || !/^[a-z0-9-]{1,40}$/i.test(String(p.key || ''))) throw new Error('Bài học không hợp lệ');
  const eid = cleanEid_(p.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { progress: getProgress_(), vocab: getVocab_(), xp: getXp_(), earned: 0, dup: true };
    const sh = sh_('progress');
    const vals = rows_(sh, 4);
    const score = clamp_(p.score, 0, 100);
    let row = -1, prev = null;
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === p.key) { row = i + 2; prev = vals[i]; break; }
    if (p.fix) {
      if (row > 0) { sh.getRange(row, 5).setValue(JSON.stringify((p.wrong || []).slice(0, 40))); sh.getRange(row, 6).setValue(new Date()); }
      return { progress: getProgress_(), vocab: getVocab_(), xp: getXp_(), earned: 0 };
    }
    const wasPassed = !!(prev && prev[1] === 'passed');
    const status = (p.pass || wasPassed) ? 'passed' : 'tried';
    const best = Math.max(score, prev ? Number(prev[2]) || 0 : 0);
    const attempts = (prev ? Number(prev[3]) || 0 : 0) + 1;
    const rec = [p.key, status, best, attempts, JSON.stringify((p.wrong || []).slice(0, 40)), new Date()];
    if (row > 0) sh.getRange(row, 1, 1, 6).setValues([rec]);
    else { const r = sh.getLastRow() + 1; sh.getRange(r, 1).setNumberFormat('@'); sh.getRange(r, 1, 1, 6).setValues([rec]); }

    // qua bài thì đưa từ vào sổ ôn tập (từ "Cần ôn" ôn ngay hôm nay, từ "Đã nhớ" ôn lại ngày mai)
    if (p.pass && Array.isArray(p.words) && p.words.length) {
      const vs = sh_('vocab');
      const have = {};
      getVocab_().forEach(function (x) { have[x.word.toLowerCase()] = true; });
      const now = new Date(), t = today_(), stamp = Utilities.formatDate(now, TZ, 'yyMMddHHmmss') + Utilities.getUuid().slice(0, 4);
      const add = [];
      p.words.slice(0, 40).forEach(function (w, i) {
        const word = String(w.word || '').trim();
        if (!word || have[word.toLowerCase()]) return;
        have[word.toLowerCase()] = true;
        add.push([stamp + 'L' + String(i).padStart(2, '0'), word.slice(0, 200), String(w.meaning || '').slice(0, 500),
          String(w.example || '').slice(0, 500), String(w.source || '').slice(0, 100),
          w.remember ? 1 : 0, w.remember ? addDays_(t, 1) : t, now, now, 1, w.remember ? 0 : 1]);
      });
      if (add.length) {
        const r = vs.getLastRow() + 1;
        vs.getRange(r, 1, add.length, 1).setNumberFormat('@');
        vs.getRange(r, 7, add.length, 1).setNumberFormat('@');
        vs.getRange(r, 1, add.length, 11).setValues(add);
      }
    }
    const dict = /^dict-/.test(p.key);
    const correct = clamp_(p.correct, 0, dict ? 3000 : 60), answered = clamp_(p.answered, 0, dict ? 3000 : 60);
    let base = 0;
    if (dict) base = !prev ? Math.round(Math.min(correct, 600) / 3) + XPR.dictBase : (score > (Number(prev[2]) || 0) ? XPR.dictBase : 0);
    else if (!wasPassed) {
      base = Math.min(correct, 30) * XPR.correct + clamp_(p.cards, 0, 40) * XPR.card + (p.slides ? XPR.slide : 0) + (p.pass ? XPR.pass : 0);
      if (prev && !p.pass) base = Math.round(base / 2); // làm lại nhiều lần mà chưa qua: nửa mét
    }
    const earned = earn_(eid, dict ? 'dict' : 'lesson', p.key, base, { s: score, pass: !!p.pass, again: wasPassed }, { l: 1, c: correct, a: answered });
    return { progress: getProgress_(), vocab: getVocab_(), xp: getXp_(), earned: earned };
  });
}

// ===================================================================
// v8: GÓI NỘI DUNG trên Drive (thư mục English/climb-data)
// Bộ đề Reading, Listening, Cẩm nang Speaking/Writing, bộ từ vựng... nằm ở đây dạng JSON.
// Web chỉ tải danh mục trước, mở bài nào tải bài đó (có cache 6 giờ).
// ===================================================================
const ENGLISH_FOLDER_ID = '1wKbw8hsbJQbCMN_RToQgFDqqSF6uZcU0';
const DATA_FOLDER_NAME = 'climb-data';

function dataRoot_() {
  const c = CacheService.getScriptCache();
  const id = c.get('dataRoot');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFolderById(ENGLISH_FOLDER_ID).getFoldersByName(DATA_FOLDER_NAME);
  if (!it.hasNext()) throw new Error('Chưa có thư mục climb-data trong English');
  const f = it.next();
  c.put('dataRoot', f.getId(), 21600);
  return f;
}

function packFile_(path) {
  if (!/^[a-z0-9_\-\/\.]{1,160}$/i.test(path) || path.indexOf('..') >= 0) throw new Error('Đường dẫn không hợp lệ');
  const c = CacheService.getScriptCache(), ck = 'pf:' + (prop_('PACK_VER') || '') + ':' + path;
  const id = c.get(ck);
  if (id) { try { const f0 = DriveApp.getFileById(id); if (!f0.isTrashed()) return f0; } catch (e) {} }
  const parts = path.split('/');
  let folder = dataRoot_();
  for (let i = 0; i < parts.length - 1; i++) {
    const it = folder.getFoldersByName(parts[i]);
    if (!it.hasNext()) throw new Error('Không tìm thấy ' + path);
    folder = it.next();
  }
  const it = folder.getFilesByName(parts[parts.length - 1]);
  let f = null;
  while (it.hasNext()) { const x = it.next(); if (!x.isTrashed() && (!f || x.getLastUpdated() > f.getLastUpdated())) f = x; }
  if (!f) throw new Error('Không tìm thấy ' + path);
  c.put(ck, f.getId(), 21600);
  return f;
}

// path ví dụ 'reading/at6-01.json' hoặc 'reading/_index.json'. Trả về chuỗi JSON.
function getPack(pin, path, ver) {
  checkPin_(pin);
  const c = CacheService.getScriptCache(), ck = 'pk:' + (ver || '') + ':' + path;
  const n = +(c.get(ck + ':n') || 0);
  if (n) {
    const keys = []; for (let i = 0; i < n; i++) keys.push(ck + ':' + i);
    const got = c.getAll(keys), parts = keys.map(function (k) { return got[k]; });
    if (parts.every(function (p) { return p != null; })) return parts.join('');
  }
  const s = packFile_(path).getBlob().getDataAsString('UTF-8');
  // danh mục (_index.json, guide.json…) cache ngắn để cập nhật nhanh; bài lẻ cache 6 giờ.
  // CacheService giới hạn 100KB/khóa → chia chuỗi thành nhiều mảnh 30.000 ký tự (tiếng Việt UTF-8 tối đa ~90KB)
  const ttl = /(^|\/)(_|guide)/.test(path) ? 1800 : 21600, CH = 30000;
  if (s.length < 3000000) {
    try {
      const m = {}, k = Math.ceil(s.length / CH) || 1;
      for (let i = 0; i < k; i++) m[ck + ':' + i] = s.slice(i * CH, (i + 1) * CH);
      c.putAll(m, ttl); c.put(ck + ':n', String(k), ttl);
    } catch (e) {}
  }
  return s;
}

function getPacks(pin, paths, ver) {
  checkPin_(pin);
  return (paths || []).slice(0, 12).map(function (p) { try { return getPack(pin, p, ver); } catch (e) { return ''; } });
}

// ===== Chấm bài qua Claude trong chat (không cần API key) =====
// Claude đọc bài chưa chấm trong Sheet, chấm theo đúng thang của app rồi đặt file
// climb-data/grades/<id bài>.json. Lần mở web tiếp theo, hàm này ghi điểm vào Sheet và bỏ file vào thùng rác.
function applyChatGrades_() {
  const it0 = dataRoot_().getFoldersByName('grades');
  if (!it0.hasNext()) return;
  const dir = it0.next(), files = dir.getFiles(), todo = [];
  while (files.hasNext()) { const f = files.next(); if (!f.isTrashed() && /\.json$/i.test(f.getName())) todo.push(f); }
  if (!todo.length) return;
  withLock_(function () {
    const sh = sh_('submissions');
    todo.forEach(function (f) {
      try {
        const g = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
        const id = String(g.id || f.getName().replace(/\.json$/i, ''));
        const row = findSubRow_(sh, id);
        const type = String(sh.getRange(row, 3).getValue());
        const keys = type === 'speaking' ? ['FC', 'LR', 'GRA'] : ['TR', 'CC', 'LR', 'GRA'];
        const bands = keys.map(function (k) { return Number(g.criteria && g.criteria[k] && g.criteria[k].band) || 0; });
        g.overall = ieltsRound_(bands.reduce(function (a, b) { return a + b; }, 0) / bands.length);
        g.by = 'claude-chat';
        if (type === 'speaking') g.kind = 'speaking';
        else {
          const ref = String(sh.getRange(row, 4).getValue());
          g.task = g.task || (/^Task 1/.test(ref) ? 'task1' : /^Mở bài/.test(ref) ? 'intro' : /^Đoạn văn/.test(ref) ? 'paragraph' : 'task2');
          g.words = (String(sh.getRange(row, 6).getValue()).match(/\S+/g) || []).length;
        }
        const summary = (type === 'speaking' ? 'Speaking ước tính ' : 'Band ') + g.overall + ' (' + keys.map(function (k, i) { return k + ' ' + bands[i]; }).join(', ') + (type === 'speaking' ? ', chưa tính phát âm' : '') + ')\n' + (g.next || '');
        const prev = bestBand_(sh, type, row);
        sh.getRange(row, 9, 1, 3).setValues([['Band ' + g.overall, summary, JSON.stringify(g)]]);
        if (prev && g.overall > prev) earn_('', 'better', id, XPR.better, { b: g.overall, p: prev });
        addErrorsFromGrade_(id, type === 'speaking' ? 'speaking' : 'writing', g, String(sh.getRange(row, 4).getValue()));
        f.setTrashed(true);
      } catch (e) { Logger.log('Không áp được điểm ' + f.getName() + ': ' + e); }
    });
  });
}


// ===== Xưởng từ: sổ từ phim/sách (tab notebook) + tiến độ luyện từng mục (tab wordlab) =====
function getNotebook_() {
  const out = [];
  rows_(sh_('notebook'), 8).forEach(function (r) {
    if (!r[0]) return;
    let card = null;
    try { card = r[6] ? JSON.parse(r[6]) : null; } catch (e) {}
    out.push({ id: String(r[0]), created: r[1] instanceof Date ? Utilities.formatDate(r[1], TZ, 'yyyy-MM-dd') : String(r[1]),
      w: String(r[2]), vi: String(r[3]), src: String(r[4]), note: String(r[5]), card: card });
  });
  return out;
}
function getNotebook(pin) {
  checkPin_(pin);
  try { applyNotebookIn_(); } catch (e) { Logger.log(e); }
  return getNotebook_();
}
// Thêm từ mới khi đang xem phim/đọc sách; phần "thẻ sâu" do Claude đắp sau (nhắn "làm sổ từ")
function addNote(pin, n) {
  checkPin_(pin);
  const w = String((n && n.w) || '').trim();
  if (!w) throw new Error('Chưa nhập từ');
  return withLock_(function () {
    const sh = sh_('notebook');
    const id = newId_('u');
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setNumberFormat('@');
    sh.getRange(r, 1, 1, 8).setValues([[id, new Date(), w.slice(0, 120), String(n.vi || '').slice(0, 300),
      String(n.src || '').slice(0, 120), String(n.note || '').slice(0, 1000), '', new Date()]]);
    return getNotebook_();
  });
}
function deleteNote(pin, id) {
  checkPin_(pin);
  return withLock_(function () {
    const sh = sh_('notebook'), ids = rows_(sh, 1);
    for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 2); break; }
    return getNotebook_();
  });
}
// File JSON trong climb-data/notebook-in: {"cards":[{id, w, vi, src:{k,n}, ...}]} → thêm mới hoặc cập nhật theo id
function applyNotebookIn_() {
  // sổ từ do Claude đắp qua chat chỉ thuộc về một người (CHAT_USER), để người khác mở web không "nuốt" mất file
  const owner = String(prop_('CHAT_USER') || '').trim().toUpperCase();
  if (owner !== (userKey_() || (owner === 'MACDINH' ? 'MACDINH' : ''))) return;
  const it0 = dataRoot_().getFoldersByName('notebook-in');
  if (!it0.hasNext()) return;
  const files = it0.next().getFiles(), todo = [];
  while (files.hasNext()) { const f = files.next(); if (!f.isTrashed() && /\.json$/i.test(f.getName())) todo.push(f); }
  if (!todo.length) return;
  withLock_(function () {
    const sh = sh_('notebook');
    todo.forEach(function (f) {
      try {
        const d = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
        const cards = Array.isArray(d) ? d : (d.cards || []);
        const vals = rows_(sh, 3), at = {};
        vals.forEach(function (r, i) { at[String(r[0])] = i + 2; at['w:' + String(r[2]).toLowerCase()] = at['w:' + String(r[2]).toLowerCase()] || i + 2; });
        const add = [];
        cards.forEach(function (c) {
          if (!c || !c.w) return;
          const src = c.src && c.src.n ? (c.src.k === 'book' ? 'Sách: ' : c.src.k === 'film' ? 'Phim: ' : '') + c.src.n : String(c.src || '');
          const row = at[String(c.id)] || 0;
          const json = JSON.stringify(c);
          if (row) sh.getRange(row, 3, 1, 6).setValues([[c.w, c.vi || '', src, c.note || '', json, new Date()]]);
          else add.push([String(c.id || ('n' + Date.now() + add.length)), new Date(), c.w, c.vi || '', src, c.note || '', json, new Date()]);
        });
        if (add.length) {
          const r = sh.getLastRow() + 1;
          sh.getRange(r, 1, add.length, 1).setNumberFormat('@');
          sh.getRange(r, 1, add.length, 8).setValues(add);
        }
        f.setTrashed(true);
      } catch (e) { Logger.log('Không nhập được sổ từ ' + f.getName() + ': ' + e); }
    });
  });
}
function getWordLab_() {
  const out = {};
  rows_(sh_('wordlab'), 5).forEach(function (r) {
    if (r[0]) out[String(r[0])] = { box: Number(r[1]) || 0, ok: Number(r[2]) || 0, bad: Number(r[3]) || 0, due: key_(r[4]) };
  });
  return out;
}
function getWordLab(pin) { checkPin_(pin); return getWordLab_(); }
// results: [{id, ok}] — đúng thì lên hộp (ôn giãn dần), sai thì về hộp 1 và ôn lại ngày mai
// Mét: 10 cho mỗi câu đúng mà câu đó mới hoặc đến hạn; +10 nếu đúng hết (≥ 5 câu).
function saveWordLab(pin, p) {
  checkPin_(pin);
  const results = ((p && p.results) || []).slice(0, 100);
  const eid = cleanEid_(p && p.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { lab: getWordLab_(), xp: getXp_(), earned: 0, dup: true };
    const sh = sh_('wordlab'), vals = rows_(sh, 5), at = {}, t = today_(), now = new Date();
    let okDue = 0, allOk = results.length > 0;
    vals.forEach(function (r, i) { at[String(r[0])] = i + 2; });
    const add = [];
    results.forEach(function (x) {
      const id = String(x.id || '').slice(0, 60);
      if (!id) return;
      const row = at[id], prev = row > 0 ? vals[row - 2] : null;
      if (row === -1) return; // trùng id trong cùng lượt
      if (!x.ok) allOk = false;
      if (x.ok && (!prev || key_(prev[4]) <= t)) okDue++;
      let box = prev ? Number(prev[1]) || 0 : 0;
      box = x.ok ? Math.min(6, box + 1) : 1;
      const rec = [id, box, (prev ? Number(prev[2]) || 0 : 0) + (x.ok ? 1 : 0), (prev ? Number(prev[3]) || 0 : 0) + (x.ok ? 0 : 1), addDays_(t, SRS[box] || 1), now];
      if (row) sh.getRange(row, 1, 1, 6).setValues([rec]);
      else { add.push(rec); at[id] = -1; }
    });
    if (add.length) {
      const r = sh.getLastRow() + 1;
      sh.getRange(r, 1, add.length, 1).setNumberFormat('@');
      sh.getRange(r, 5, add.length, 1).setNumberFormat('@');
      sh.getRange(r, 1, add.length, 6).setValues(add);
    }
    const base = okDue * XPR.review + (results.length >= 5 && allOk ? XPR.perfect : 0);
    const ref = /^wt:\d{4}-\d{2}-\d{2}(:[a-z]+)?$/.test(String((p && p.ref) || '')) ? String(p.ref) : '';   // nhiệm vụ tuần: đánh dấu ngày đã học (đồng bộ mọi thiết bị)
    const earned = earn_(eid, 'wordlab', ref, base, { n: results.length, ok: okDue }, { l: results.length ? 1 : 0, c: clamp_(p.correct, 0, 100), a: clamp_(p.answered, 0, 100) });
    return { lab: getWordLab_(), xp: getXp_(), earned: earned };
  });
}

// ===== Nạp gói nội dung: tải file climb-content*.zip vào thư mục climb-data rồi chạy hàm này =====
// Giải nén từng file vào đúng thư mục con (tự tạo), bản cũ cùng tên được chuyển vào thùng rác (khôi phục được).
// Nếu chạy quá ~4,5 phút, hàm tự hẹn chạy tiếp sau 1 phút cho đến khi xong.
function napNoiDung() {
  const root = dataRoot_(), props = PropertiesService.getScriptProperties();
  let zip = null;
  const it = root.getFiles();
  while (it.hasNext()) {
    const f = it.next(), n = f.getName();
    if (/^climb-content.*\.zip$/i.test(n) && !f.isTrashed() && (!zip || f.getLastUpdated() > zip.getLastUpdated())) zip = f;
  }
  if (!zip) { Logger.log('Không thấy file climb-content….zip trong thư mục climb-data.'); return; }
  const key = 'NAP_' + zip.getId();
  let i = +(props.getProperty(key) || 0);
  const blobs = Utilities.unzip(zip.getBlob().setContentType('application/zip'));
  const t0 = Date.now(), folders = {};
  const sub = function (path) {
    if (folders[path]) return folders[path];
    let f = root;
    path.split('/').forEach(function (p) { const x = f.getFoldersByName(p); f = x.hasNext() ? x.next() : f.createFolder(p); });
    return (folders[path] = f);
  };
  for (; i < blobs.length; i++) {
    if (Date.now() - t0 > 270000) {
      props.setProperty(key, String(i));
      ScriptApp.newTrigger('napNoiDung').timeBased().after(60 * 1000).create();
      Logger.log('Đã nạp ' + i + '/' + blobs.length + ' file, sẽ tự chạy tiếp sau 1 phút.');
      return;
    }
    const b = blobs[i], name = b.getName();
    if (!name || /\/$/.test(name) || name.indexOf('__MACOSX') === 0) continue;
    const parts = name.split('/'), fname = parts.pop();
    const dir = parts.length ? sub(parts.join('/')) : root;
    const old = dir.getFilesByName(fname);
    while (old.hasNext()) old.next().setTrashed(true);
    dir.createFile(Utilities.newBlob(b.getBytes(), 'application/json', fname));
  }
  props.deleteProperty(key);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'napNoiDung') ScriptApp.deleteTrigger(t); });
  lamMoiNoiDung();
  Logger.log('Xong: đã nạp ' + blobs.length + ' file từ ' + zip.getName() + '. Mở lại web là thấy nội dung mới.');
}

// Sau khi Claude cập nhật nội dung trên Drive: chạy hàm này trong trình soạn thảo để web tải bản mới
function lamMoiNoiDung() {
  PropertiesService.getScriptProperties().setProperty('PACK_VER', String(Date.now()));
  Logger.log('Đã đổi phiên bản nội dung, web sẽ tải lại.');
}

// ===== Listening: phát audio riêng tư từ Drive (cắt khúc gửi về trình duyệt) =====
const AUDIO_CHUNK = 1536 * 1024;
// Chỉ phát file nằm trong thư mục English (hoặc thư mục khai trong AUDIO_FOLDERS), để link web không đọc được file Drive khác.
function audioAllowed_(fileId) {
  const id = String(fileId || '');
  if (!/^[A-Za-z0-9_-]{10,120}$/.test(id)) throw new Error('Mã file audio không hợp lệ');
  const c = CacheService.getScriptCache(), ck = 'au:' + id;
  if (c.get(ck) === '1') return id;
  const allow = {};
  allow[ENGLISH_FOLDER_ID] = 1;
  String(prop_('AUDIO_FOLDERS') || '').split(',').forEach(function (x) { x = x.trim(); if (x) allow[x] = 1; });
  let q = [], ok = false;
  const ps = DriveApp.getFileById(id).getParents();
  while (ps.hasNext()) q.push(ps.next());
  for (let depth = 0; depth < 10 && q.length && !ok; depth++) {
    const nq = [];
    q.forEach(function (f) { if (allow[f.getId()]) ok = true; const pp = f.getParents(); while (pp.hasNext()) nq.push(pp.next()); });
    q = nq;
  }
  if (!ok) throw new Error('File audio nằm ngoài thư mục English. Thêm ID thư mục chứa nó vào Script Properties AUDIO_FOLDERS.');
  c.put(ck, '1', 21600);
  return id;
}
function getAudioInfo(pin, fileId) {
  checkPin_(pin);
  const f = DriveApp.getFileById(audioAllowed_(fileId));
  const size = f.getSize();
  return { id: f.getId(), size: size, parts: Math.ceil(size / AUDIO_CHUNK), mime: f.getMimeType() };
}
function getAudioPart(pin, fileId, part) {
  checkPin_(pin);
  fileId = audioAllowed_(fileId);
  part = clamp_(part, 0, 2000);
  const start = part * AUDIO_CHUNK;
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + start + '-' + (start + AUDIO_CHUNK - 1) },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 206 && code !== 200) throw new Error('Không tải được audio (' + code + ')');
  return Utilities.base64Encode(res.getContent());
}

// ===== Tra từ theo ngữ cảnh =====
const LOOKUP_PROMPT = [
  'You are a concise English–Vietnamese dictionary for an IELTS learner (band 5 aiming 7).',
  'Given a word or phrase and the sentence where it appears, explain its meaning IN THIS CONTEXT.',
  'Return ONLY JSON: {"w":"<lemma or phrase as it should be learned>","pos":"n/v/adj/adv/phr","ipa":"/.../ (British)","vi":"nghĩa tiếng Việt ngắn gọn đúng ngữ cảnh","en":"short English definition","syn":"1-3 synonyms useful for IELTS paraphrase","col":"1-2 common collocations","note":"ghi chú tiếng Việt ngắn nếu có bẫy nghĩa, else empty"}'
].join('\n');
function lookupWord(pin, word, sentence) {
  checkPin_(pin);
  const w = String(word || '').slice(0, 80), s = String(sentence || '').slice(0, 600);
  const c = CacheService.getScriptCache(), ck = 'lk:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, w + '|' + s));
  const hit = c.get(ck);
  if (hit) return JSON.parse(hit);
  const r = callClaude_(MODEL_FAST, LOOKUP_PROMPT, [{ role: 'user', content: 'Word: ' + w + '\nSentence: ' + s }], 400);
  try { c.put(ck, JSON.stringify(r), 21600); } catch (e) {}
  return r;
}

// ===== Lời giải AI cho bài tự dán (bài trong bộ đề đã có lời giải sẵn) =====
const EXPLAIN_PROMPT = [
  'You are an expert IELTS Reading teacher explaining answers to a Vietnamese learner (band 5).',
  'You get a passage (paragraphs labelled), the questions and the answer key. For EACH question number return an explanation.',
  'Rules: "quote" must be copied EXACTLY from the passage (shortest span that proves the answer, max 40 words; empty for NOT GIVEN if nothing relevant). "p" = paragraph label. "pair" = 0-3 paraphrase pairs [question words, passage words]. "why" = 1-3 câu tiếng Việt: vì sao đúng, vì sao phương án dễ nhầm sai. "trap" = bẫy ngắn tiếng Việt hoặc "".',
  'If you think the key is wrong, keep it but start "trap" with "Lưu ý:".',
  'Also return "vocab": 10-15 useful words/phrases from the passage for a band 5→7 learner: {"w","pos","vi","ex" (exact clause from passage),"syn"}.',
  'Return ONLY JSON: {"expl":{"1":{"p":"","quote":"","pair":[["",""]],"why":"","trap":""}},"vocab":[...]}'
].join('\n');
function explainReading(pin, p) {
  checkPin_(pin);
  const msg = 'PASSAGE:\n' + String(p.passage || '').slice(0, 20000) + '\n\nQUESTIONS:\n' + String(p.questions || '').slice(0, 12000) + '\n\nANSWER KEY:\n' + String(p.key || '').slice(0, 3000);
  return callClaude_(MODEL, EXPLAIN_PROMPT, [{ role: 'user', content: msg }], 8000);
}

// ===== AI soạn đề từ tài liệu gốc (paper, bài báo...) =====
const GEN_PROMPT = [
  'You are an IELTS Academic Reading test writer. From the source text, build ONE IELTS-style reading passage practice in strict JSON.',
  'Passage: use the source text itself (lightly trimmed to 600-950 words if longer; keep wording; split into paragraphs labelled A, B, C...).',
  'Write questions of the requested types, real-exam style, unambiguous, answerable only from the passage. Total 10-14 questions numbered from 1.',
  'Difficulty levels: "easy" ≈ band 5, "mid" ≈ band 6, "hard" ≈ band 7 (more paraphrase, subtle NOT GIVEN).',
  'Types: tfng, ynng (only for opinion texts), headings, paragraph, features, endings, mcq, summary, sentence, flow, short. Completion tasks: state the word limit in instr, gaps in "stem" as [n].',
  'Every answer needs an explanation in Vietnamese with an exact quote from the passage.',
  'Output schema: {"title":"","paras":[{"l":"A","t":""}],"groups":[{"type":"tfng","from":1,"to":5,"instr":"","stem":"","options":[{"k":"","t":""}],"multi":false,"items":[{"n":1,"q":"","opts":[{"k":"A","t":""}]}]}],',
  '"answers":{"1":["TRUE"]},"expl":{"1":{"p":"A","quote":"","pair":[["",""]],"why":"","trap":""}},"vocab":[{"w":"","pos":"","vi":"","ex":"","syn":""}]}',
  'Return ONLY the JSON.'
].join('\n');
function genReading(pin, p) {
  checkPin_(pin);
  const types = (p.types || []).join(', ') || 'tfng, mcq, summary';
  const r = callClaude_(MODEL, GEN_PROMPT, [{ role: 'user', content: 'Requested types: ' + types + '\nLevel: ' + (p.level || 'mid') + '\n\nSOURCE TEXT:\n' + String(p.text || '').slice(0, 24000) }], 12000);
  if (!r || !r.paras || !r.groups || !r.answers) throw new Error('AI trả về sai định dạng, thử lại');
  return r;
}

// ===== Speaking: kho câu trả lời của mày + bộ chuyện Part 2 =====
function getBank_() {
  return rows_(sh_('sbank'), 7).filter(function (r) { return r[0]; }).map(function (r) {
    let meta = {};
    try { meta = JSON.parse(r[4] || '{}'); } catch (e) {}
    return { id: String(r[0]), kind: String(r[1]), title: String(r[2]), text: String(r[3]), meta: meta, updated: r[6] ? key_(r[6]) : '' };
  });
}
// item = {id?, kind: 'answer'|'story', title, text, meta}
function saveBank(pin, item) {
  checkPin_(pin);
  if (!item || !String(item.text || '').trim()) throw new Error('Chưa có nội dung');
  return withLock_(function () {
    const sh = sh_('sbank');
    const vals = rows_(sh, 1), now = new Date();
    const rec = [String(item.kind || 'answer').slice(0, 20), String(item.title || '').slice(0, 500), String(item.text || '').slice(0, 20000), JSON.stringify(item.meta || {}).slice(0, 20000)];
    if (item.id) for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(item.id)) {
      sh.getRange(i + 2, 2, 1, 4).setValues([rec]); sh.getRange(i + 2, 7).setValue(now);
      return getBank_();
    }
    const id = newId_('B');
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setNumberFormat('@');
    sh.getRange(r, 1, 1, 7).setValues([[id].concat(rec, [now, now])]);
    return getBank_();
  });
}
function deleteBank(pin, id) {
  checkPin_(pin);
  return withLock_(function () {
    const sh = sh_('sbank');
    const vals = rows_(sh, 1);
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(id)) { sh.deleteRow(i + 2); break; }
    return getBank_();
  });
}
// Gợi ý một câu chuyện Part 2 dùng được cho những thẻ đề nào
const STORY_PROMPT = [
  'You help an IELTS candidate reuse a small set of personal stories across many Part 2 cue cards.',
  'Given one story and a list of cue cards (id + text), pick every card the story could answer naturally with small adaptations, and say in Vietnamese how to adapt it (one short sentence each).',
  'Return ONLY JSON: {"fits":[{"id":"","how":""}],"tip":"1-2 câu tiếng Việt: thêm chi tiết gì để chuyện dùng được cho nhiều thẻ hơn"}'
].join('\n');
function storyFit(pin, story, cards) {
  checkPin_(pin);
  const list = (cards || []).slice(0, 80).map(function (c) { return c.id + ': ' + String(c.card || '').slice(0, 160); }).join('\n');
  return callClaude_(MODEL_FAST, STORY_PROMPT, [{ role: 'user', content: 'STORY:\n' + String(story || '').slice(0, 4000) + '\n\nCUE CARDS:\n' + list }], 1500);
}

// ===================================================================
// v9: SỔ LỖI (Error-to-Mastery)
// Lỗi đi qua 4 trạng thái: new (Mới) → fixed (Đã tự sửa, ôn lại sau 3 ngày) → again (Đúng lại, ôn lại sau 7 ngày) → mastered (Thuộc).
// Sai ở bất kỳ bước nào thì về new, ôn lại ngày mai. Lỗi tự vào sổ từ kết quả chấm Writing/Speaking và chép chính tả.
// ===================================================================
const ERR_TYPES = { art: 'Mạo từ', tense: 'Thì động từ', agr: 'Số ít/nhiều, chủ–vị', wf: 'Dạng từ', prep: 'Giới từ',
  word: 'Chọn từ, collocation', link: 'Liên kết câu', sent: 'Cấu trúc câu', spell: 'Chính tả', idea: 'Phát triển ý',
  style: 'Văn phong', listen: 'Nghe sót' };
const ERR_FROM_K = { GRA: 'sent', LR: 'word', CC: 'link', TR: 'idea', FC: 'link' };

function getErrors_() {
  const lim = addDays_(today_(), -60), out = [];
  rows_(sh_('errors'), 13).forEach(function (r) {
    if (!r[0]) return;
    const st = String(r[9] || 'new'), upd = r[12] ? key_(r[12]) : '';
    if (st === 'mastered' && upd < lim) return;
    out.push({ id: String(r[0]), created: r[1] ? key_(r[1]) : '', skill: String(r[2]), type: String(r[3]), src: String(r[4]), ref: String(r[5]),
      wrong: String(r[6]), right: String(r[7]), why: String(r[8]), state: st, due: key_(r[10]), tries: Number(r[11]) || 0, updated: upd });
  });
  return out.slice(-600);
}
// list: [{skill, type, src, ref, wrong, right, why}] (gọi bên trong lock)
function addErrors_(list) {
  if (!list || !list.length) return 0;
  const sh = sh_('errors'), now = new Date(), t = today_();
  const have = {};
  rows_(sh, 10).forEach(function (r) { if (String(r[9]) !== 'mastered') have[String(r[2]) + '|' + String(r[6]).trim().toLowerCase()] = 1; });
  const add = [];
  list.slice(0, 40).forEach(function (e) {
    const wrong = String(e.wrong || '').trim();
    if (!wrong) return;
    const k = String(e.skill) + '|' + wrong.toLowerCase();
    if (have[k]) return; have[k] = 1;
    add.push(['E' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), now, String(e.skill || 'writing').slice(0, 20), ERR_TYPES[e.type] ? e.type : 'sent',
      String(e.src || '').slice(0, 60), String(e.ref || '').slice(0, 200), wrong.slice(0, 1000), String(e.right || '').slice(0, 1000),
      String(e.why || '').slice(0, 600), 'new', t, 0, now]);
  });
  if (!add.length) return 0;
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, add.length, 1).setNumberFormat('@');
  sh.getRange(r, 11, add.length, 1).setNumberFormat('@');
  sh.getRange(r, 1, add.length, 13).setValues(add);
  return add.length;
}
function addErrorsFromGrade_(subId, skill, g, ref) {
  if (!g || !g.fixes || !g.fixes.length) return;
  const exists = rows_(sh_('errors'), 5).some(function (r) { return String(r[4]) === String(subId); });
  if (exists) return; // chấm lại cùng bài: không thêm trùng
  addErrors_(g.fixes.filter(function (f) { return f && f.original; }).map(function (f) {
    return { skill: skill, type: ERR_TYPES[f.t] ? f.t : (ERR_FROM_K[f.k] || 'sent'), src: subId, ref: ref, wrong: f.original, right: f.better, why: f.why };
  }));
}
// Từ màn chép chính tả: câu nghe sót, từ "biết mà không nghe ra"
function addListenErrors(pin, p) {
  checkPin_(pin);
  const list = ((p && p.items) || []).slice(0, 30).map(function (x) {
    return { skill: 'listening', type: 'listen', src: String(p.src || '').slice(0, 60), ref: String(p.ref || '').slice(0, 200), wrong: x.text, right: x.text, why: x.why || '' };
  });
  return withLock_(function () { addErrors_(list); return getErrors_(); });
}
// p = {eid, results:[{id, ok}]}
function saveErrorReview(pin, p) {
  checkPin_(pin);
  const eid = cleanEid_(p && p.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { errors: getErrors_(), xp: getXp_(), earned: 0, dup: true };
    const sh = sh_('errors'), vals = rows_(sh, 13), t = today_(), now = new Date();
    const map = {};
    ((p && p.results) || []).slice(0, 40).forEach(function (x) { map[String(x.id)] = x; });
    let ok = 0, n = 0, mastered = 0;
    vals.forEach(function (r, i) {
      const x = map[String(r[0])];
      if (!x) return;
      n++;
      const st = String(r[9] || 'new'), isDue = key_(r[10]) <= t;
      let next = st, due = key_(r[10]), tries = Number(r[11]) || 0;
      if (x.ok) {
        if (!isDue || st === 'mastered') return; // ôn sớm: giữ nguyên
        next = st === 'new' ? 'fixed' : st === 'fixed' ? 'again' : 'mastered';
        due = addDays_(t, next === 'fixed' ? 3 : next === 'again' ? 7 : 60);
        ok++; if (next === 'mastered') mastered++;
      } else { next = 'new'; due = addDays_(t, 1); tries++; }
      sh.getRange(i + 2, 11).setNumberFormat('@');
      sh.getRange(i + 2, 10, 1, 4).setValues([[next, due, tries, now]]);
    });
    const earned = earn_(eid, 'err', '', ok * XPR.errOk + mastered * XPR.errMaster, { n: n, ok: ok, m: mastered }, { l: 1, c: ok, a: n });
    return { errors: getErrors_(), xp: getXp_(), earned: earned };
  });
}

// ===== Viết lại sau khi chấm: tự sửa 2–3 lỗi chính trong bài gốc =====
// p = {eid, id, items:[{o, mine}]}
function saveRewrite(pin, p) {
  checkPin_(pin);
  const eid = cleanEid_(p && p.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { subs: getSubmissions_(), errors: getErrors_(), xp: getXp_(), earned: 0, dup: true };
    const sh = sh_('submissions'), row = findSubRow_(sh, p.id);
    const prev = String(sh.getRange(row, 12).getValue() || '');
    const items = ((p && p.items) || []).slice(0, 6).map(function (x) { return { o: String(x.o || '').slice(0, 1000), mine: String(x.mine || '').slice(0, 1500) }; })
      .filter(function (x) { return x.mine.trim(); });
    if (!items.length) throw new Error('Chưa viết lại câu nào');
    sh.getRange(row, 12).setValue(JSON.stringify({ at: today_(), items: items }));
    const es = sh_('errors'), ev2 = rows_(es, 13), t = today_(), set = {};
    items.forEach(function (x) { set[x.o.trim()] = 1; });
    ev2.forEach(function (r, i) {
      if (String(r[4]) === String(p.id) && String(r[9]) === 'new' && set[String(r[6]).trim()]) {
        es.getRange(i + 2, 11).setNumberFormat('@');
        es.getRange(i + 2, 10, 1, 4).setValues([['fixed', addDays_(t, 3), r[11], new Date()]]);
      }
    });
    const earned = earn_(eid, 'rewrite', String(p.id), prev ? 0 : XPR.rewrite, { n: items.length }, { l: 1 });
    return { subs: getSubmissions_(), errors: getErrors_(), xp: getXp_(), earned: earned };
  });
}

// ===== Dùng từ: tự viết câu với từ đã quen (gom vào lượt chấm qua chat) =====
function saveUsage(pin, p) {
  checkPin_(pin);
  const text = String((p && p.text) || '').trim(), word = String((p && p.word) || '').trim();
  if (!text || !word) throw new Error('Chưa có câu');
  const eid = cleanEid_(p.eid);
  return withLock_(function () {
    const ev = eventOf_(eid);
    if (ev) return { xp: getXp_(), earned: 0, dup: true };
    const sh = sh_('usage'), r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setNumberFormat('@');
    sh.getRange(r, 1, 1, 6).setValues([[newId_('U'), new Date(), word.slice(0, 200), text.slice(0, 1000), 'pending', new Date()]]);
    const t = today_(), n = events_().filter(function (x) { return String(x[2]) === t && String(x[3]) === 'usage'; }).length;
    const earned = earn_(eid, 'usage', word, n < 3 ? XPR.usage : 0, { w: word }, {});
    return { xp: getXp_(), earned: earned };
  });
}

// ===== Nút "Chỗ nào khó chịu?" =====
function saveFriction(pin, f) {
  checkPin_(pin);
  return withLock_(function () {
    sh_('friction').appendRow([new Date(), String((f && f.where) || '').slice(0, 60), String((f && f.reason) || '').slice(0, 60), String((f && f.note) || '').slice(0, 500)]);
    return true;
  });
}

// ===================================================================
// v9: THỬ THÁCH TRẠI (Leo núi 2.0). Mét đưa tới trại, thử thách mới cắm cờ.
// Chỉ xét thử thách khi đã đủ mét tới trại đó. Điểm band là ước tính của AI, coi là thử thách tham khảo.
// ===================================================================
const CAMP_DEF = [
  { n: 1, m: 2000, name: 'Trại 1', task: 'Ôn sạch sổ từ đến hạn 3 ngày liền' },
  { n: 2, m: 5000, name: 'Trại 2', task: 'Một đề Listening đủ 40 câu ở chế độ Thi, đúng ≥ 25' },
  { n: 3, m: 9000, name: 'Trại 3', task: 'Một bài Reading cả bài ở chế độ Thi, và làm lại câu sai sau 7 ngày đúng ≥ 70%' },
  { n: 4, m: 15000, name: 'Trại 4', task: 'Speaking Part 2 nói ≥ 150 từ (khoảng 2 phút), được chấm, rồi viết lại câu theo bản sửa' },
  { n: 5, m: 25000, name: 'Đỉnh', task: 'Writing Task 2 và Speaking thi thử đủ 3 phần, mỗi bài cao hơn band đầu tiên ≥ 0.5 (ước tính AI)' }
];
function part2Words_(transcript) {
  const lines = String(transcript || '').split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^Examiner: Now please start talking/.test(lines[i]) && /^Candidate: /.test(lines[i + 1])) return (lines[i + 1].slice(11).match(/\S+/g) || []).length;
  }
  return 0;
}
function checkFlags_() {
  const total = getXp_().reduce(function (s, x) { return s + x.xp; }, 0);
  const fs = sh_('flags'), have = {};
  rows_(fs, 2).forEach(function (r) { if (r[0]) have[String(r[0])] = key_(r[1]); });
  const evs = events_();
  // c1: chuỗi ngày ôn sạch
  const clean = {}, t0 = today_();
  evs.forEach(function (r) { if (String(r[3]) === 'review' && evData_(r).clean) clean[String(r[2])] = 1; });
  // hôm nay có học mà sổ từ không còn từ nào đến hạn cũng tính là sạch
  if (!clean[t0] && evs.some(function (r) { return String(r[2]) === t0 && Number(r[5]) > 0; }) &&
      !getVocab_().some(function (v) { return v.meaning && (v.box === 0 || v.due <= t0); })) clean[t0] = 1;
  let run = 0, best1 = 0, cur = '';
  Object.keys(clean).sort().forEach(function (d) { run = cur && addDays_(cur, 1) === d ? run + 1 : 1; cur = d; best1 = Math.max(best1, run); });
  // c2, c3: từ sự kiện Reading/Listening
  let bestL = 0, rExam = false, retry70 = false;
  evs.forEach(function (r) {
    if (String(r[3]) !== 'read') return;
    const d = evData_(r);
    if (d.k === 'L' && d.x && d.t >= 40) bestL = Math.max(bestL, d.s || 0);
    if (d.k === 'R' && d.x && d.m === 'full') rExam = true;
    if (d.k === 'R' && d.m === 'retry' && d.t >= 3 && d.s / d.t >= 0.7) retry70 = true;
  });
  // c4, c5: từ bài nộp
  const subs = rows_(sh_('submissions'), 12).filter(function (r) { return r[0]; });
  const bandOf = function (r) { try { return Number(JSON.parse(r[10]).overall) || 0; } catch (e) { return 0; } };
  let c4 = false, p2best = 0;
  let wBase = 0, wBest = 0, sBase = 0, sFull = 0;
  subs.forEach(function (r) {
    const type = String(r[2]), ref = String(r[3]), b = r[10] ? bandOf(r) : 0;
    if (type === 'speaking') {
      const w = /Part 2|thi thử/.test(ref) ? part2Words_(r[5]) : 0;
      p2best = Math.max(p2best, w);
      if (w >= 150 && b && String(r[11] || '')) c4 = true;
      if (b) { if (!sBase) sBase = b; if (/thi thử/.test(ref)) sFull = Math.max(sFull, b); }
    }
    if (type === 'writing' && b && /^Task 2/.test(ref)) { if (!wBase) wBase = b; wBest = Math.max(wBest, b); }
  });
  const c5w = wBase && wBest >= wBase + 0.5, c5s = sBase && sFull >= sBase + 0.5;
  const st = {
    1: { done: best1 >= 3, prog: Math.min(best1, 3) + '/3 ngày liền' },
    2: { done: bestL >= 25, prog: bestL ? 'tốt nhất ' + bestL + '/40 (chế độ Thi)' : 'chưa có đề 40 câu ở chế độ Thi' },
    3: { done: rExam && retry70, prog: (rExam ? '✓' : '·') + ' Reading chế độ Thi · ' + (retry70 ? '✓' : '·') + ' làm lại câu sai ≥ 70%' },
    4: { done: c4, prog: p2best ? 'Part 2 dài nhất ' + p2best + ' từ' : 'chưa có Part 2' },
    5: { done: !!(c5w && c5s), prog: 'Writing ' + (wBase ? wBest + ' (đầu ' + wBase + ')' : 'chưa chấm') + ' · Speaking thi thử ' + (sBase ? (sFull || '–') + ' (đầu ' + sBase + ')' : 'chưa chấm') }
  };
  const fresh = [];
  CAMP_DEF.forEach(function (c) { if (!have['c' + c.n] && total >= c.m && st[c.n].done) fresh.push(c); });
  if (fresh.length) withLock_(function () {
    fresh.forEach(function (c) {
      const r = fs.getLastRow() + 1;
      fs.getRange(r, 1, 1, 2).setNumberFormat('@');
      fs.getRange(r, 1, 1, 3).setValues([['c' + c.n, today_(), c.task]]);
      have['c' + c.n] = today_();
      earn_('', 'flag', 'c' + c.n, XPR.flag, { n: c.n });
    });
  });
  return CAMP_DEF.map(function (c) {
    return { n: c.n, m: c.m, name: c.name, task: c.task, open: total >= c.m, done: !!have['c' + c.n], date: have['c' + c.n] || '', prog: st[c.n].prog };
  });
}


// ===== Thêm người dùng mới (chạy trong trình soạn thảo, không gọi được từ trình duyệt) =====
// Tạo Sheet riêng (mét = 0, chưa có bài nào), ghi PIN_/SHEET_/NAME_/START_ vào Script Properties. Chạy lại không tạo Sheet mới.
function themNguoiDung_(key, name, pin, start) {
  key = String(key).toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(key)) throw new Error('Mã người dùng chỉ gồm chữ HOA/số, tối đa 20 ký tự');
  if (!/^\d{4,12}$/.test(String(pin))) throw new Error('PIN nên là 4–12 chữ số');
  const props = PropertiesService.getScriptProperties();
  const clash = profiles_().filter(function (p) { return p.pin === String(pin) && p.key !== key; })[0];
  if (clash) throw new Error('PIN này đang dùng cho ' + clash.name + '. Chọn PIN khác.');
  let sheetId = props.getProperty('SHEET_' + key);
  if (!sheetId) {
    const ss = SpreadsheetApp.create('IELTS Tracker – ' + name);
    sheetId = ss.getId();
    try { DriveApp.getFileById(sheetId).moveTo(DriveApp.getFileById(SHEET_ID).getParents().next()); } catch (e) { Logger.log('Không chuyển được Sheet vào cùng thư mục: ' + e); }
  }
  const set = { ['PIN_' + key]: String(pin), ['SHEET_' + key]: sheetId, ['NAME_' + key]: String(name) };
  if (start) set['START_' + key] = String(start);
  props.setProperties(set);
  props.deleteProperty('GOAL_' + key);
  // tạo sẵn các tab để lần đăng nhập đầu tiên không phải chờ, rồi bỏ tab trống mặc định
  CUR_ = { key: key, pin: String(pin), sheet: sheetId, name: String(name) };
  try {
    Object.keys(HEADERS).forEach(function (n) { sh_(n); });
    const ss = ss_();
    ['Sheet1', 'Trang tính1', 'Trang tính 1'].forEach(function (n) { const d = ss.getSheetByName(n); if (d && ss.getSheets().length > 1) ss.deleteSheet(d); });
  } finally { CUR_ = null; }
  Logger.log('Đã tạo/cập nhật ' + name + ' (' + key + '). Sheet: https://docs.google.com/spreadsheets/d/' + sheetId + '/edit');
  return sheetId;
}
// Slot cho SanTenChou: lộ trình bắt đầu thứ Hai 16/11/2026, nhiệm vụ giống người dùng chính. Chạy xong có thể xoá hàm này.
function taoSlotSanTenChou() { themNguoiDung_('SANTENCHOU', 'SanTenChou', '141126', '2026-11-16'); }
// Đưa SanTenChou về 0 (xoá hết dữ liệu học trong Sheet của bạn này, giữ tiêu đề cột). Chỉ tác động Sheet của SANTENCHOU.
function datLaiSanTenChou() {
  const id = prop_('SHEET_SANTENCHOU');
  if (!id || id === SHEET_ID) throw new Error('Chưa có slot SANTENCHOU (chạy taoSlotSanTenChou trước)');
  const ss = SpreadsheetApp.openById(id);
  ss.getSheets().forEach(function (sh) {
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent();
  });
  PropertiesService.getScriptProperties().deleteProperty('GOAL_SANTENCHOU');
  CacheService.getScriptCache().remove('bd:SANTENCHOU:' + today_());
  Logger.log('Đã đặt lại SanTenChou về 0.');
}
