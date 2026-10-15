/*
 * unit.js — server tests for «نبض المدارس» through the Apps Script mock (node:test).
 *
 *   npm run test:unit                       (or: node --test test/unit.js)
 *   NABD_SRC=/path/to/src node --test test/unit.js
 *   node --test --test-name-pattern="OTP" test/unit.js
 *
 * Every app.call() is a real google.script.run round-trip: public functions only, JSON-cloned
 * arguments/results, and a Date / function / undefined-in-array anywhere in a result fails the test.
 * The process runs in a time zone far from Riyadh (America/Los_Angeles by default) so any code that
 * uses local-time Date getters instead of Utilities.formatDate(…, TZ, …) / UTC math is caught.
 */
'use strict';
process.env.TZ = process.env.NABD_TEST_TZ || 'America/Los_Angeles';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const GasMock = require('./gas-mock.js');
const { loadApp, extractBoot } = require('./runtime.js');

const SRC = path.resolve(process.env.NABD_SRC || path.join(__dirname, '..', 'src'));
const OWNER = 'supervisor@gmail.com';
const BASE_URL = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const SH = { schools: 'المدارس', reports: 'التقارير', log: 'السجل', start: 'ابدأ هنا' };
const PHOTOS_FOLDER = 'نبض المدارس — شواهد المتابعة';
const ARABIC = /[؀-ۿ]/;
// 1×1 PNG (70 bytes)
const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082', 'hex').toString('base64');

const SCHOOLS = [
  { name: 'مدرسة النور الابتدائية', principal: 'أ. خالد العتيبي', phone: '0501234567', students: 400, teachers: 30, staff: 8, stage: 'ابتدائي', ministryNo: '0012345' },
  { name: 'مدرسة الفجر المتوسطة', principal: 'أ. سعد القحطاني', phone: '0559876543', students: 300, teachers: 25, staff: 6, stage: 'متوسط' },
  { name: 'ثانوية الأمل', principal: 'أ. فهد الشمري', phone: '', students: 500, teachers: 40, staff: 10, stage: 'ثانوي' }
];
// Minimal page templates used only when the UI files are not in src/ yet (doGet routing tests stay meaningful).
const STUB_HTML = {
  Admin: '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><?!= include(\'Styles\') ?></head><body><script>window.BOOT = <?!= bootJson ?>;</script><?!= include(\'Common\') ?></body></html>',
  School: '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><?!= include(\'Styles\') ?></head><body><script>window.BOOT = <?!= bootJson ?>;</script><?!= include(\'Common\') ?></body></html>',
  Styles: '<style></style>',
  Common: '<script></script>'
};
const ATT_OK = { students: { present: 380, absent: 20 }, teachers: { present: 29, absent: 1 }, staff: { present: 8, absent: 0 } };

/* ================================================================== helpers */
function sys(o = {}) {
  const env = GasMock.createGasEnv({
    ownerEmail: o.ownerEmail || OWNER,
    scriptUrl: o.notDeployed ? null : (o.scriptUrl || BASE_URL),
    clock: o.clock || '2026-10-14T07:30',
    newSheetRows: o.newSheetRows,
    seed: o.seed
  });
  const app = loadApp({ srcDir: SRC, env, code: o.code });   // o.code: a modified Code.gs (e.g. a smaller limit)
  env.setFiles((name) => {
    const n = String(name).replace(/\.html$/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(n)) return null;
    const p = path.join(SRC, n + '.html');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    return STUB_HTML[n] || null;
  });
  let lastOtpAt = -Infinity;
  const t = {
    env, app, clock: env.clock,
    call: (fn, ...args) => app.call(fn, ...args),
    at(iso) { env.clock.set(iso); return t; },
    /** Request + verify an OTP; returns the session token. */
    login(ua) {
      if (env.clock.now() - lastOtpAt < 61000) env.clock.advance(61000);
      const r = t.call('api_requestCode');
      lastOtpAt = env.clock.now();
      assert.equal(r.ok, true, 'api_requestCode ok');
      const code = lastCode(env);
      const v = t.call('api_verifyCode', r.cid, code, ua || 'Node test');
      assert.equal(v.ok, true);
      return v.token;
    },
    setup(data = {}) {
      const token = t.login();
      const r = t.call('api_completeSetup', token, Object.assign({
        supervisor: { name: 'أحمد المشرف', title: 'المشرف التربوي', office: 'مكتب التعليم بالشمال', phone: '0500000000' },
        systemTitle: 'متابعة سير العملية التعليمية',
        schoolsText: '',
        preset: 'standard'
      }, data));
      assert.equal(r.ok, true, 'api_completeSetup ok');
      t.token = token;
      return token;
    },
    /** Setup + schools (SCHOOLS by default). Returns {token, schools: [school objects with token/pin]}. */
    ready(o2 = {}) {
      const token = t.setup(o2.setup || {});
      const list = (o2.schools || SCHOOLS).map((s) => t.call('api_saveSchool', token, Object.assign({}, s)).school);
      t.schools = list;
      t.fields = t.call('api_bootstrap', token).fields;
      return { token, schools: list };
    },
    fieldsNow() { t.fields = t.call('api_bootstrap', t.token).fields; return t.fields; },
    answers(o2 = {}) { return answersFor(t.fields || t.fieldsNow(), o2); },
    submit(school, o2 = {}) {
      const tok = typeof school === 'string' ? school : school.token;
      const payload = { answers: o2.answers || t.answers(o2), filledBy: o2.filledBy === undefined ? 'أ. خالد' : o2.filledBy };
      if (o2.date) payload.date = o2.date;
      return t.call('api_submitReport', tok, payload);
    },
    upload(school, o2 = {}) {
      const tok = typeof school === 'string' ? school : school.token;
      return t.call('api_uploadPhoto', tok, Object.assign({ base64: PNG_B64, mime: 'image/png', name: 'صورة.png', w: 1, h: 1 }, o2));
    },
    day(date) { return t.call('api_day', t.token, date || env.clock.today()); },
    row(day, schoolId) { return day.rows.find((r) => r.school.id === schoolId); },
    form(school, date) { return t.call('api_schoolForm', typeof school === 'string' ? school : school.token, date); },
    sheet(name) { return env.inspect.sheet(name); },
    prop(key) { const p = env.properties('script'); return p[key] === undefined ? null : p[key]; },
    cfg() { return JSON.parse(t.prop('cfg') || '{}'); },
    boot(params) { return extractBoot(app.doGet(params || {})); }
  };
  return t;
}
function lastCode(env) {
  const m = env.mailbox[env.mailbox.length - 1];
  assert.ok(m, 'an OTP email was sent');
  const code = /(\d{6})/.exec(m.subject);
  assert.ok(code, 'subject carries the 6-digit code: ' + m.subject);
  return code[1];
}
function fieldBy(fields, pred) { return fields.find(pred); }
function answersFor(fields, o = {}) {
  const a = {};
  for (const f of fields) {
    switch (f.type) {
      case 'select': a[f.id] = f.kpi === 'mode' ? (o.mode || f.options[0]) : ((o.select && o.select[f.id]) || f.options[0]); break;
      case 'attendance': a[f.id] = {}; for (const r of f.rows) a[f.id][r] = Object.assign({}, (o.att && o.att[r]) || ATT_OK[r]); break;
      case 'number':
        if (f.kpi === 'lessons_planned') a[f.id] = o.planned === undefined ? 40 : o.planned;
        else if (f.kpi === 'lessons_done') a[f.id] = o.done === undefined ? 36 : o.done;
        else if (f.kpi === 'late_students') a[f.id] = o.lateStudents === undefined ? 3 : o.lateStudents;
        else if (f.required || (o.numbers && o.numbers[f.id] !== undefined)) a[f.id] = o.numbers && o.numbers[f.id] !== undefined ? o.numbers[f.id] : Math.max(1, f.min || 0);
        break;
      case 'textarea': if (o.note !== undefined) a[f.id] = o.note; else if (f.required) a[f.id] = 'ملاحظة'; break;
      case 'text': if (f.required) a[f.id] = 'نص'; break;
      case 'yesno': a[f.id] = o.yesno === undefined ? false : o.yesno; break;
      case 'photos': if (o.photos) a[f.id] = o.photos; break;
    }
  }
  return a;
}
/** Passes when fn throws (message matching re) OR returns {ok:false, error matching re}. User-facing errors must be clear Arabic. */
function expectError(fn, re, label) {
  let r;
  try { r = fn(); } catch (e) {
    if (re) assert.match(e.message, re, (label || '') + ' — got: ' + e.message);
    if (!/AUTH_REQUIRED|NOT_SETUP/.test(e.message)) assertUserMessage(e.message, label);
    return e;
  }
  assert.ok(r && r.ok === false, (label || 'expected an error') + ' — but got: ' + JSON.stringify(r).slice(0, 400));
  if (re) assert.match(String(r.error || r.code || ''), re, label);
  return r;
}
function assertUserMessage(msg, label) {
  assert.match(msg, ARABIC, (label || '') + ' — error should be a clear Arabic sentence, got: ' + msg);
  assert.doesNotMatch(msg, /^(Exception|TypeError|ReferenceError|RangeError|SyntaxError|\[gas-)/, (label || '') + ' — raw platform/JS error leaked to the user: ' + msg);
}
function expectAuth(fn, label) {
  assert.throws(fn, (e) => /AUTH_REQUIRED/.test(e.message), label || 'AUTH_REQUIRED expected');
}
function bigBase64(bytes) { const n = Math.ceil(bytes / 3) * 4; return 'A'.repeat(n); }
function noDateCells(env) {
  const bad = env.inspect.allCells().filter((c) => c.type === 'date');
  assert.deepEqual(bad.map((c) => c.sheet + '!' + c.a1 + '=' + c.value), [], 'Sheets auto-converted values into Dates (cells must be text-formatted "@")');
}
function noFormulas(env) {
  assert.deepEqual(env.formulaWrites.map((w) => w.sheet + '!' + w.a1 + ' ← ' + w.value + ' (' + w.kind + ')'), [], 'user text reached Sheets as a formula (safeCell_ missing)');
}
function headerRow(t) { const s = t.sheet(SH.reports); return s ? s.headers.map(String) : []; }
function reportRows(t) { const s = t.sheet(SH.reports); return s ? s.values.slice(1).filter((r) => r[0] !== '') : []; }

/* ================================================================== 0. harness fidelity (no Code.gs needed) */
describe('harness: gas-mock fidelity', () => {
  it('auto-converts like Sheets unless the cell is plain text', () => {
    const env = GasMock.createGasEnv({ clock: '2026-10-14T07:30' });
    const sh = env.spreadsheet.insertSheet('x');
    sh.getRange(1, 1, 1, 5).setValues([['2026-10-14', '09:00', '0123', 'TRUE', '=1+1']]);
    const v = sh.getRange(1, 1, 1, 5).getValues()[0];
    assert.ok(GasMock.isDate(v[0]) && GasMock.isDate(v[1]));
    assert.equal(v[2], 123); assert.equal(v[3], true); assert.equal(env.formulaWrites.length, 1);
    sh.getRange(2, 1, 1, 3).setNumberFormat('@').setValues([['2026-10-14', '0123', 'TRUE']]);
    assert.deepEqual(sh.getRange(2, 1, 1, 3).getValues()[0], ['2026-10-14', '0123', 'TRUE']);
  });
  it('throws Apps Script errors for empty ranges and out-of-bounds coordinates', () => {
    const env = GasMock.createGasEnv({});
    const sh = env.spreadsheet.insertSheet('x');
    assert.throws(() => sh.getRange(2, 1, 0, 3), /number of rows in the range must be at least 1/);
    assert.throws(() => sh.getRange(1, 27), /outside the dimensions of the sheet/);
    assert.throws(() => env.globals.SpreadsheetApp.getUi(), /Cannot call SpreadsheetApp.getUi\(\) from this context/);
    assert.throws(() => env.globals.DriveApp.getFileById('1doesnotexist'), /No item with the given ID/);
  });
  it('enforces Properties/Cache limits and Cache TTL on the controllable clock', () => {
    const env = GasMock.createGasEnv({ clock: '2026-10-14T07:30' });
    const p = env.globals.PropertiesService.getScriptProperties();
    assert.throws(() => p.setProperty('k', 'x'.repeat(9300)), /Argument too large/);
    const c = env.globals.CacheService.getScriptCache();
    c.put('a', 1, 60); assert.equal(c.get('a'), '1');
    env.clock.advance(60000); assert.equal(c.get('a'), null);
    assert.throws(() => c.put('a', 'v', 21601), /Argument too large/);
  });
  it('honours the clock in Date and Utilities.formatDate', () => {
    const env = GasMock.createGasEnv({ clock: '2026-10-14T07:30' });
    const d = new env.Date();
    assert.equal(env.globals.Utilities.formatDate(d, 'Asia/Riyadh', 'yyyy-MM-dd HH:mm EEE'), '2026-10-14 07:30 Wed');
    assert.equal(env.Date.now(), env.clock.now());
    assert.throws(() => env.globals.Utilities.formatDate('2026-10-14', 'Asia/Riyadh', 'yyyy'), /don't match the method signature/);
  });
  it('snapshot()/restore() round-trips the whole state as JSON', () => {
    const env = GasMock.createGasEnv({ clock: '2026-10-14T07:30' });
    env.spreadsheet.insertSheet('x').appendRow(['a', 1]);
    env.globals.PropertiesService.getScriptProperties().setProperty('k', 'v');
    const env2 = GasMock.createGasEnv({ state: JSON.parse(JSON.stringify(env.snapshot())) });
    assert.equal(env2.spreadsheet.getSheetByName('x').getRange(1, 2).getValue(), 1);
    assert.equal(env2.globals.PropertiesService.getScriptProperties().getProperty('k'), 'v');
  });
});

if (!fs.existsSync(path.join(SRC, 'Code.gs'))) {
  describe('server', () => { it('src/Code.gs exists', () => assert.fail('src/Code.gs not found in ' + SRC)); });
  return;
}

/* ================================================================== 1. platform contract */
describe('platform contract', () => {
  it('exposes only doGet/include/onOpen/menu*/dailyDigest/api_* to google.script.run (helpers end with "_")', () => {
    const t = sys();
    const pub = t.app.publicFunctions();
    const unexpected = pub.filter((n) => !/^(doGet|include|onOpen|dailyDigest|menu[A-Z]\w*|api_\w+)$/.test(n));
    assert.deepEqual(unexpected, [], 'functions callable from the browser that should be private (end with "_")');
  });
  it('implements every API function in spec §6', () => {
    const t = sys();
    const pub = new Set(t.app.publicFunctions());
    const required = ['doGet', 'include', 'onOpen', 'dailyDigest', 'menuShowLink', 'menuShowGuide', 'menuReset',
      'api_schoolForm', 'api_resolveSchool', 'api_uploadPhoto', 'api_discardPhoto', 'api_schoolPhoto', 'api_submitReport',
      'api_requestCode', 'api_verifyCode', 'api_logout', 'api_logoutAll', 'api_completeSetup', 'api_bootstrap', 'api_day',
      'api_review', 'api_approveAll', 'api_report', 'api_photo', 'api_range', 'api_deleteReport', 'api_schools', 'api_saveSchool',
      'api_bulkAddSchools', 'api_setSchoolActive', 'api_regenerateLink', 'api_regeneratePin', 'api_deleteSchool', 'api_saveFields',
      'api_applyPreset', 'api_getSettings', 'api_saveSettings'];
    assert.deepEqual(required.filter((n) => !pub.has(n)), []);
  });
  it('exposes the spec constants', () => {
    const t = sys();
    assert.equal(t.app.evaluate('APP_NAME'), 'نبض المدارس');
    assert.equal(t.app.evaluate('DEFAULT_SYSTEM_TITLE'), 'متابعة سير العملية التعليمية');
    assert.equal(t.app.evaluate('APP_VERSION'), '1.2.1');
    assert.equal(t.app.evaluate('TZ'), 'Asia/Riyadh');
  });
  it('does not use services outside the declared scopes', () => {
    const code = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
    for (const bad of [/\bUrlFetchApp\b/, /\bGmailApp\b/, /DriveApp\.(getFiles|searchFiles|getFolders|searchFolders|getFoldersByName)\b/, /(^|[^\w$.])eval\s*\(/m, /new Function\s*\(/]) {
      assert.ok(!bad.test(code), 'Code.gs must not use ' + bad);
    }
  });
  it('every authenticated API rejects a missing/invalid session with AUTH_REQUIRED before doing anything', () => {
    const t = sys();
    t.ready();
    const fns = ['api_bootstrap', 'api_day', 'api_review', 'api_approveAll', 'api_report', 'api_photo', 'api_range', 'api_deleteReport',
      'api_schools', 'api_saveSchool', 'api_bulkAddSchools', 'api_setSchoolActive', 'api_regenerateLink', 'api_regeneratePin',
      'api_deleteSchool', 'api_saveFields', 'api_applyPreset', 'api_getSettings', 'api_saveSettings', 'api_logoutAll', 'api_completeSetup'];
    for (const fn of fns) {
      for (const bad of ['', 'x'.repeat(64), null, 12345]) expectAuth(() => t.call(fn, bad), fn + '(' + JSON.stringify(bad) + ')');
    }
  });
  it('web-app entry points never call SpreadsheetApp.getUi() and work when getActiveSpreadsheet() is null (openById fallback)', () => {
    const t = sys();
    const { token } = t.ready();
    t.env.activeSpreadsheetAvailable = false;
    const b = t.call('api_bootstrap', token);
    assert.equal(b.ok, true);
    assert.equal(t.call('api_schools', token).schools.length, 3);
    t.env.activeSpreadsheetAvailable = true;
  });
});

/* ================================================================== 2. doGet routing & pages */
describe('doGet routing', () => {
  it('admin page before setup: only publicStatus leaks, masked email, title and meta tags', () => {
    const t = sys();
    const out = t.app.doGetOutput({});
    const boot = extractBoot(out.html);
    assert.equal(boot.page, 'admin');
    assert.equal(boot.appName, 'نبض المدارس');
    assert.equal(boot.version, '1.2.1');
    assert.equal(boot.status.setupDone, false);
    assert.equal(boot.status.ownerEmailMasked, 'su••••••@gmail.com');
    assert.equal(boot.status.deployed, true);
    assert.ok(!out.html.includes(OWNER), 'full owner email must not appear in the admin page');
    assert.match(out.title, /— لوحة المشرف$/);
    assert.equal(out.xFrameOptionsMode, 'ALLOWALL');
    const vp = out.metaTags.find((m) => m.name === 'viewport');
    assert.ok(vp && /width=device-width/.test(vp.content), 'viewport meta via addMetaTag');
  });
  it('school page: title, BOOT.form, and BAD_LINK / NOT_SETUP / preview tokens', () => {
    const t = sys();
    let boot = t.boot({ s: 'AnyTokenBeforeSetup1' });
    assert.equal(boot.page, 'school'); assert.equal(boot.mode, 'form');
    assert.equal(boot.form.ok, false); assert.equal(boot.form.code, 'NOT_SETUP');
    const { schools } = t.ready();
    const out = t.app.doGetOutput({ s: schools[0].token });
    boot = extractBoot(out.html);
    assert.equal(boot.form.ok, true);
    assert.equal(boot.token, schools[0].token);
    assert.equal(boot.form.school.name, SCHOOLS[0].name);
    assert.equal(out.title, SCHOOLS[0].name + ' — متابعة سير العملية التعليمية');
    boot = t.boot({ s: 'Zz' + schools[0].token.slice(2) });
    assert.equal(boot.form.ok, false); assert.equal(boot.form.code, 'BAD_LINK');
    assert.equal(boot.form.error, 'الرابط غير صحيح أو تم تغييره. تواصل مع المشرف للحصول على الرابط الجديد.');
    boot = t.boot({ s: '__preview' });
    assert.equal(boot.form.ok, true); assert.equal(boot.form.preview, true);
    assert.equal(boot.form.school.name, 'مدرسة تجريبية (معاينة)');
  });
  it('picker page (?f=all) lists active school ids+names only — never tokens or pins', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.call('api_setSchoolActive', token, schools[2].id, false);
    const out = t.app.doGetOutput({ f: 'all' });
    const boot = extractBoot(out.html);
    assert.equal(boot.mode, 'picker');
    assert.equal(boot.picker.ok, true);
    assert.equal(boot.picker.supervisor.name, 'أحمد المشرف');
    assert.deepEqual(boot.picker.schools.map((s) => s.id).sort(), [schools[0].id, schools[1].id].sort());
    for (const s of boot.picker.schools) assert.deepEqual(Object.keys(s).sort(), ['id', 'name']);
    for (const s of schools) {
      assert.ok(!out.html.includes(s.token), 'school token leaked into the picker page');
    }
  });
  it('BOOT JSON is script-safe: a school name with </script> cannot break out', () => {
    const t = sys();
    const { token } = t.ready();
    const evil = 'مدرسة </script><script>alert(1)</script><!-- x';
    const s = t.call('api_saveSchool', token, { name: evil }).school;
    const html = t.app.doGet({ s: s.token });
    assert.ok(!html.includes('</script><script>alert(1)'), 'raw </script> inside BOOT');
    assert.equal(extractBoot(html).form.school.name, evil);
  });
  it('not deployed (ScriptApp.getService().getUrl() is null): links are null, nothing crashes', () => {
    const t = sys({ notDeployed: true });
    const { token } = t.ready();
    assert.equal(t.boot({}).status.deployed, false);
    const r = t.call('api_schools', token);
    assert.equal(r.baseUrl, null);
    assert.equal(r.generalLink, null);
    assert.ok(r.schools.every((s) => s.link === null));
    assert.equal(t.call('api_bootstrap', token).baseUrl, null);
  });
});

/* ================================================================== 3. OTP & setup */
describe('OTP login', () => {
  it('sends a 6-digit code to the owner in an RTL email; stores only a hash', () => {
    const t = sys();
    const r = t.call('api_requestCode');
    assert.match(r.cid, /^[0-9a-f]{64}$/, 'the challenge id the code belongs to');
    assert.deepEqual(r, { ok: true, cid: r.cid, emailMasked: 'su••••••@gmail.com' });
    assert.ok(!JSON.stringify(t.env.cacheEntries()).includes(r.cid), 'only a hash of the challenge id is stored');
    const m = t.env.mailbox[0];
    const code = lastCode(t.env);
    assert.equal(m.to, OWNER);
    assert.equal(m.subject, 'رمز الدخول إلى نبض المدارس: ' + code);
    assert.equal(m.name, 'نبض المدارس');
    assert.match(m.htmlBody, /dir=["']?rtl/i);
    assert.ok(m.htmlBody.includes(code));
    assert.match(m.htmlBody, /10 دقائق/);
    const stored = JSON.stringify(t.env.cacheEntries()) + JSON.stringify(t.env.properties());
    assert.ok(!stored.includes(code), 'the plain OTP code must never be stored');
  });
  it('enforces the 60 s cooldown and the 6-per-hour cap', () => {
    const t = sys();
    t.call('api_requestCode');
    expectError(() => t.call('api_requestCode'), /انتظر دقيقة قبل طلب رمز جديد/);
    for (let i = 0; i < 5; i++) { t.clock.advance(61000); assert.equal(t.call('api_requestCode').ok, true); }
    t.clock.advance(61000);
    expectError(() => t.call('api_requestCode'), null, '7th code within an hour');
    assert.equal(t.env.mailbox.length, 6);
  });
  it('rejects wrong codes and deletes the code after 5 wrong tries', () => {
    const t = sys();
    const { cid } = t.call('api_requestCode');
    const code = lastCode(t.env);
    const wrong = code === '000000' ? '111111' : '000000';
    const msgs = [];
    for (let i = 0; i < 5; i++) msgs.push(expectError(() => t.call('api_verifyCode', cid, wrong, 'ua')).message || '');
    const after = expectError(() => t.call('api_verifyCode', cid, code, 'ua'), null, 'correct code after 5 wrong tries must not work');
    assert.ok(msgs.concat(after.message || after.error).some((m) => /تجاوزت عدد المحاولات، اطلب رمزًا جديدًا/.test(m)), msgs.join(' | '));
  });
  it('expires the code after 10 minutes and accepts it once only', () => {
    const t = sys();
    let { cid } = t.call('api_requestCode');
    let code = lastCode(t.env);
    t.clock.advance(10 * 60000 + 1000);
    expectError(() => t.call('api_verifyCode', cid, code, 'ua'), /انتهت صلاحية الرمز|اطلب رمزًا جديدًا/);
    cid = t.call('api_requestCode').cid;
    code = lastCode(t.env);
    const v = t.call('api_verifyCode', cid, code, 'ua');
    assert.match(v.token, /^[0-9a-f]{64}$/);
    expectError(() => t.call('api_verifyCode', cid, code, 'ua'), null, 'OTP reuse');
  });
  it('rejects malformed codes and challenge ids without crashing', () => {
    const t = sys();
    const { cid } = t.call('api_requestCode');
    for (const bad of ['', 'abcdef', '12345', '1234567', null, { x: 1 }]) expectError(() => t.call('api_verifyCode', cid, bad, 'ua'), null, JSON.stringify(bad));
    const code = lastCode(t.env);
    for (const bad of ['', null, 'x'.repeat(64), cid.toUpperCase(), cid.slice(1), { cid }]) {
      expectError(() => t.call('api_verifyCode', bad, code, 'ua'), /انتهت صلاحية الرمز/, 'cid ' + JSON.stringify(bad));
    }
    assert.equal(t.call('api_verifyCode', cid, code, 'ua').ok, true, 'malformed ids never touched the real challenge');
  });
  it('[security] wrong codes sent by another visitor never burn the code the owner was just sent', () => {
    const t = sys();
    const owner = t.call('api_requestCode');
    const code = lastCode(t.env);
    t.clock.advance(61000);
    const other = t.call('api_requestCode');   // an anonymous visitor's own challenge
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expectError(() => t.call('api_verifyCode', other.cid, wrong, 'x'));
    for (let i = 0; i < 20; i++) expectError(() => t.call('api_verifyCode', GasMock.sha256Hex('guess' + i), wrong, 'x'), /انتهت صلاحية الرمز/);
    const v = t.call('api_verifyCode', owner.cid, code, 'Owner phone');
    assert.match(v.token, /^[0-9a-f]{64}$/, 'the owner signs in with the code from the email');
    expectError(() => t.call('api_verifyCode', other.cid, code, 'x'), null, "a code works only with the challenge it was sent for");
  });
  it('[security] visitors who use up the code limits cannot lock the owner out: the menu link signs in without email', () => {
    const t = sys();
    const { token } = t.ready();
    t.boot({});   // the dashboard was opened once from the deployment (saves its /exec URL)
    for (let i = 0; i < 12; i++) { t.clock.advance(61000); try { t.call('api_requestCode'); } catch (e) { /* capped */ } }
    const capped = expectError(() => t.call('api_requestCode'), /رموز كثيرة/);
    assert.match(capped.message, /📋 نبض المدارس.*رابط لوحة التحكم.*فتح لوحة التحكم/, 'the message names the way in that cannot be blocked');
    const mails = t.env.mailbox.length;
    // google.script.run cannot reach the menu: it fails before any sign-in link exists
    assert.throws(() => t.call('menuShowLink'), /getUi/);
    assert.equal(t.env.ui.dialogs.length, 0);
    t.app.runMenu('menuShowLink');
    const dlg = t.env.ui.dialogs[0].html;
    const m = /href="([^"]*\?login=([0-9a-f]{64}))"/.exec(dlg);
    assert.ok(m, 'the dialog button opens a one-time sign-in link');
    assert.ok(m[1].startsWith(BASE_URL + '?login='), m[1]);
    assert.ok(dlg.includes('value="' + BASE_URL + '"'), 'the link to copy / bookmark carries no ticket');
    assert.ok(!JSON.stringify(t.env.cacheEntries()).includes(m[2]), 'only a hash of the ticket is stored');
    const boot = t.boot({ login: m[2] });
    assert.match(boot.session, /^[0-9a-f]{64}$/, 'BOOT carries a new session');
    assert.equal(t.call('api_bootstrap', boot.session).ok, true, 'a working supervisor session');
    assert.notEqual(boot.session, token);
    assert.equal(t.env.mailbox.length, mails, 'no email was needed');
    assert.equal(t.boot({ login: m[2] }).session, undefined, 'the link works once');
    assert.equal(t.boot({ login: GasMock.sha256Hex('forged') }).session, undefined, 'a forged ticket gives nothing');
    t.app.runMenu('menuShowLink');
    const late = /\?login=([0-9a-f]{64})"/.exec(t.env.ui.dialogs[1].html)[1];
    t.clock.advance(11 * 60000);
    assert.equal(t.boot({ login: late }).session, undefined, 'tickets expire after 10 minutes');
    assert.ok(t.sheet(SH.log).values.some((r) => r.join(' ').includes('رابط الدخول من ملف Google Sheets')), 'the sign-in is logged');
  });
  it('stores sessions hashed (sess:<sha256(token)>) with a 30-day expiry and logs the login', () => {
    const t = sys();
    const token = t.login();
    const key = 'sess:' + GasMock.sha256Hex(token);
    const raw = t.prop(key);
    assert.ok(raw, 'session property ' + key);
    const sess = JSON.parse(raw);
    assert.ok(Math.abs(sess.exp - (t.clock.now() + 30 * 86400000)) < 5 * 60000, 'exp ≈ now + 30 days');
    assert.ok(!JSON.stringify(t.env.properties()).includes(token), 'raw session token stored');
    const log = t.sheet(SH.log);
    assert.ok(log && log.values.some((r) => r.join(' ').includes('تسجيل دخول')), 'السجل has «تسجيل دخول»');
  });
});

describe('setup wizard (api_completeSetup)', () => {
  it('creates the sheets with the exact headers, formats and layout', () => {
    const t = sys();
    t.setup();
    const sc = t.sheet(SH.schools);
    assert.deepEqual(sc.headers, ['المعرّف', 'اسم المدرسة', 'الرقم الوزاري', 'المرحلة', 'المدير/ة', 'الجوال', 'عدد الطلاب', 'عدد المعلمين', 'عدد الإداريين', 'رمز الرابط', 'رمز المدرسة', 'نشطة', 'تاريخ الإضافة']);
    const rp = t.sheet(SH.reports);
    assert.deepEqual(rp.headers.slice(0, 13), ['المفتاح', 'التاريخ', 'معرّف المدرسة', 'المدرسة', 'الحالة', 'وقت الإرسال', 'آخر تعديل', 'اسم المعبّئ', 'متأخر', 'مرات التعديل', 'ملاحظة المراجعة', 'وقت المراجعة', 'البيانات']);
    assert.deepEqual(t.sheet(SH.log).headers, ['الوقت', 'العملية', 'التفاصيل']);
    for (const name of [SH.schools, SH.reports, SH.log]) {
      const s = t.sheet(name);
      assert.equal(s.frozenRows, 1, name + ' frozen header');
      assert.equal(s.rtl, true, name + ' RTL');
      assert.equal(s.styleAt(1, 1, 'fontWeight'), 'bold', name + ' bold header');
      assert.match(String(s.styleAt(1, 1, 'background')), /^#0e7c66$/i, name + ' header background');
    }
    for (const c of [1, 2, 3, 4, 5, 6, 10, 11, 12, 13]) assert.equal(sc.numberFormatAt(2, c), '@', 'schools column ' + c + ' must be plain text');
    for (const c of [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13]) assert.equal(rp.numberFormatAt(2, c), '@', 'reports column ' + c + ' must be plain text');
  });
  it('saves supervisor info, defaults, preset fields and bulk schools; refuses a second setup', () => {
    const t = sys();
    const token = t.login();
    expectError(() => t.call('api_completeSetup', token, { supervisor: { name: 'أ' }, preset: 'standard' }), null, 'name too short');
    const r = t.call('api_completeSetup', token, { supervisor: { name: 'أحمد المشرف', title: '' }, systemTitle: '', schoolsText: 'مدرسة أ\nمدرسة ب\n', preset: 'standard' });
    assert.equal(r.ok, true); assert.equal(r.added, 2);
    const b = t.call('api_bootstrap', token);
    assert.equal(b.supervisor.name, 'أحمد المشرف');
    assert.equal(b.supervisor.title, 'المشرف التربوي');
    assert.equal(b.systemTitle, 'متابعة سير العملية التعليمية');
    assert.equal(b.schoolsCount, 2);
    assert.equal(b.ownerEmail, OWNER);
    assert.equal(b.version, '1.2.1');
    assert.equal(b.today, '2026-10-14');
    assert.equal(b.now, '07:30');
    assert.equal(b.baseUrl, BASE_URL);
    assert.equal(b.generalLink, BASE_URL + '?f=all');
    assert.equal(b.schedule.deadline, '09:00');
    assert.deepEqual(b.schedule.workdays, [0, 1, 2, 3, 4]);
    assert.equal(b.schedule.allowLate, true);
    assert.equal(b.review.enabled, true);
    assert.equal(b.links.generalEnabled, true);
    assert.deepEqual(b.alerts, { studentAbsencePct: 10, teacherAbsencePct: 10, activationPct: 80, jumpPct: 50 });
    assert.equal(b.digest.enabled, false);
    assert.equal(t.boot({}).status.setupDone, true);
    expectError(() => t.call('api_completeSetup', token, { supervisor: { name: 'أحمد' }, preset: 'standard' }), /تم تجهيز النظام مسبقًا/);
  });
  it('standard preset mirrors the colleague form (6 fields, kpis, options)', () => {
    const t = sys();
    t.setup({ preset: 'standard' });
    const f = t.call('api_bootstrap', t.token).fields;
    assert.deepEqual(f.map((x) => x.label), ['نمط المتابعة', 'الحضور والغياب', 'الحصص المخطط لها', 'الحصص المفعّلة', 'ملاحظة عامة', 'شواهد المتابعة']);
    assert.deepEqual(f.map((x) => x.type), ['select', 'attendance', 'number', 'number', 'textarea', 'photos']);
    assert.deepEqual(f.map((x) => x.kpi || null), ['mode', null, 'lessons_planned', 'lessons_done', null, null]);
    assert.deepEqual(f[0].options, ['حضوري', 'عن بُعد']);
    assert.deepEqual(f[1].rows, ['students', 'teachers', 'staff']);
    assert.equal(f[5].maxCount, 6);
    assert.deepEqual(f.map((x) => !!x.required), [true, true, true, true, false, false]);
    for (const x of f) assert.match(x.id, /^f_[A-Za-z0-9]{6}$/);
    assert.equal(new Set(f.map((x) => x.id)).size, 6);
  });
  it('basic and extended presets', () => {
    const t = sys();
    t.setup({ preset: 'basic' });
    let f = t.call('api_bootstrap', t.token).fields;
    assert.deepEqual(f.map((x) => x.type), ['attendance', 'textarea']);
    f = t.call('api_applyPreset', t.token, 'extended').fields;
    assert.equal(f.length, 10);
    assert.ok(f.some((x) => x.kpi === 'late_students'));
    assert.ok(f.some((x) => x.type === 'yesno' && x.label === 'هل توجد حالة طارئة اليوم؟'));
    expectError(() => t.call('api_applyPreset', t.token, 'nope'));
  });
  it('the school side reports NOT_SETUP before setup', () => {
    const t = sys();
    const r = t.call('api_schoolForm', 'AbcdefghijKLMNOPQRST');
    assert.equal(r.ok, false); assert.equal(r.code, 'NOT_SETUP');
  });
});

/* ================================================================== 4. sessions */
describe('sessions', () => {
  it('expire after 30 days of inactivity', () => {
    const t = sys();
    const token = t.setup();
    t.clock.advance(31 * 86400000);
    expectAuth(() => t.call('api_bootstrap', token));
  });
  it('slide: activity after 12 h extends the expiry to now + 30 days; earlier activity writes nothing', () => {
    const t = sys();
    const token = t.setup();
    const key = 'sess:' + GasMock.sha256Hex(token);
    const s0 = JSON.parse(t.prop(key));
    t.clock.advance(3600000);
    t.call('api_bootstrap', token);
    assert.equal(JSON.parse(t.prop(key)).exp, s0.exp, 'no extension within 12 h');
    t.clock.advance(12 * 3600000);
    t.call('api_bootstrap', token);
    const s1 = JSON.parse(t.prop(key));
    assert.ok(s1.exp > s0.exp + 12 * 3600000 - 60000, 'expiry extended');
    assert.notEqual(s1.last, s0.last);
    t.clock.advance(29 * 86400000);
    assert.equal(t.call('api_bootstrap', token).ok, true, 'still valid thanks to the sliding window');
  });
  it('logout ends this session; logoutAll ends every session', () => {
    const t = sys();
    const a = t.setup();
    const b = t.login();
    const c = t.login();
    assert.equal(t.call('api_logout', a).ok, true);
    expectAuth(() => t.call('api_bootstrap', a));
    assert.equal(t.call('api_bootstrap', b).ok, true);
    assert.equal(t.call('api_logoutAll', b).ok, true);
    expectAuth(() => t.call('api_bootstrap', b));
    expectAuth(() => t.call('api_bootstrap', c));
    assert.equal(Object.keys(t.env.properties()).filter((k) => k.startsWith('sess:')).length, 0);
  });
  it('keeps at most 15 sessions (oldest dropped)', () => {
    const t = sys();
    const tokens = [];
    for (let i = 0; i < 16; i++) { tokens.push(t.login()); t.clock.advance(61 * 60000); }
    expectAuth(() => t.call('api_bootstrap', tokens[0]));
    assert.ok(Object.keys(t.env.properties()).filter((k) => k.startsWith('sess:')).length <= 15);
    t.call('api_completeSetup', tokens[15], { supervisor: { name: 'أحمد المشرف' }, preset: 'standard' });
    assert.equal(t.call('api_bootstrap', tokens[15]).ok, true);
  });
});

/* ================================================================== 5. schools */
describe('schools CRUD, links and pins', () => {
  it('creates schools with id/token/pin formats and private links', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const s = schools[0];
    assert.match(s.id, /^S[a-z0-9]{7}$/);
    assert.match(s.token, /^[A-Za-z][A-Za-z0-9]{19}$/);
    assert.match(s.pin, /^\d{4}$/);
    assert.equal(s.active, true);
    assert.equal(s.phone, '0501234567');
    assert.equal(s.ministryNo, '0012345');
    assert.equal(s.students, 400);
    const list = t.call('api_schools', token);
    assert.equal(list.baseUrl, BASE_URL);
    assert.equal(list.generalLink, BASE_URL + '?f=all');
    const one = list.schools.find((x) => x.id === s.id);
    assert.equal(one.link, BASE_URL + '?s=' + s.token);
    assert.equal(new Set(list.schools.map((x) => x.token)).size, 3);
    assert.equal(list.schools.length, 3);
  });
  it('stores phone, pin, token, ministry number and dates as text (no auto-conversion)', () => {
    const t = sys();
    t.ready();
    const sh = t.sheet(SH.schools);
    const row = sh.values.find((r) => r[1] === SCHOOLS[0].name);
    const types = sh.types[sh.values.indexOf(row)];
    assert.equal(row[5], '0501234567'); assert.equal(types[5], 'string');
    assert.equal(row[2], '0012345');
    assert.equal(types[9], 'string'); assert.equal(types[10], 'string');
    assert.equal(typeof row[12], 'string'); assert.match(row[12], /^2026-10-14/);
    noDateCells(t.env);
  });
  it('keeps leading zeros of school pins', () => {
    const t = sys();
    const { token, schools } = t.ready();
    let pin = schools[0].pin;
    for (let i = 0; i < 200 && pin[0] !== '0'; i++) pin = t.call('api_regeneratePin', token, schools[0].id).school.pin;
    assert.equal(pin[0], '0', 'could not get a pin starting with 0');
    const listed = t.call('api_schools', token).schools.find((x) => x.id === schools[0].id);
    assert.equal(listed.pin, pin);
    assert.equal(t.form(t.call('api_resolveSchool', schools[0].id, pin).token).school.name, schools[0].name);
  });
  it('validates names (2–120, unique ignoring case/spaces), phone, counts and stage', () => {
    const t = sys();
    const { token } = t.ready();
    expectError(() => t.call('api_saveSchool', token, { name: 'م' }));
    expectError(() => t.call('api_saveSchool', token, { name: 'م'.repeat(121) }));
    expectError(() => t.call('api_saveSchool', token, { name: '  مدرسة   النور  الابتدائية ' }), null, 'duplicate with extra spaces');
    t.call('api_saveSchool', token, { name: 'Al Noor School' });
    expectError(() => t.call('api_saveSchool', token, { name: 'al noor  SCHOOL' }), null, 'duplicate ignoring case');
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', phone: '05abc' }));
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', phone: '9'.repeat(16) }));
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', students: -1 }));
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', students: 1.5 }));
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', teachers: 100001 }));
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', stage: 'جامعة' }));
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', ministryNo: '1'.repeat(21) }));
    expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة جديدة', principal: 'م'.repeat(61) }));
    const s = t.call('api_saveSchool', token, { name: 'مدرسة جديدة', phone: '050-123 4567', stage: 'رياض أطفال' }).school;
    assert.equal(s.phone, '0501234567');
    // phones are stored as digits only: '+' / '00' international prefixes become plain digits
    assert.equal(t.call('api_saveSchool', token, { name: 'مدرسة دولية', phone: '+966 50 123 4567' }).school.phone, '966501234567');
    assert.equal(t.call('api_saveSchool', token, { name: 'مدرسة دولية 2', phone: '00966-50-123-4568' }).school.phone, '966501234568');
  });
  it('edits keep id, token and pin', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const s = schools[1];
    const e = t.call('api_saveSchool', token, Object.assign({}, s, { principal: 'أ. ماجد', students: 310 })).school;
    assert.equal(e.id, s.id); assert.equal(e.token, s.token); assert.equal(e.pin, s.pin);
    assert.equal(e.principal, 'أ. ماجد'); assert.equal(e.students, 310);
    assert.equal(t.call('api_schools', token).schools.length, 3);
    expectError(() => t.call('api_saveSchool', token, Object.assign({}, s, { name: SCHOOLS[0].name })), null, 'rename onto an existing name');
  });
  it('regenerating a link invalidates the old one immediately', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const n = t.call('api_regenerateLink', token, schools[0].id).school;
    assert.notEqual(n.token, schools[0].token);
    assert.match(n.token, /^[A-Za-z][A-Za-z0-9]{19}$/);
    const old = t.form(schools[0].token);
    assert.equal(old.ok, false); assert.equal(old.code, 'BAD_LINK');
    assert.equal(t.form(n.token).ok, true);
  });
  it('deactivated schools are rejected and hidden; reactivation restores them', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.call('api_setSchoolActive', token, schools[0].id, false);
    const f = t.form(schools[0]);
    assert.equal(f.ok, false); assert.equal(f.code, 'INACTIVE');
    assert.equal(f.error, 'هذه المدرسة موقوفة مؤقتًا من قبل المشرف.');
    expectError(() => t.submit(schools[0]));
    assert.ok(!t.day().rows.some((r) => r.school.id === schools[0].id), 'inactive school not in the day rows');
    assert.equal(t.day().totals.schools, 2);
    t.call('api_setSchoolActive', token, schools[0].id, true);
    assert.equal(t.form(schools[0]).ok, true);
  });
  it('deleting a school removes it but keeps its reports with the snapshot name', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.submit(schools[0]);
    assert.equal(t.call('api_deleteSchool', token, schools[0].id).ok, true);
    assert.equal(t.call('api_schools', token).schools.length, 2);
    assert.equal(t.form(schools[0]).code, 'BAD_LINK');
    const rows = reportRows(t);
    assert.equal(rows.length, 1);
    assert.equal(rows[0][3], SCHOOLS[0].name);
    expectError(() => t.call('api_deleteSchool', token, 'Snotthere'));
  });
});

describe('bulk school text (§6.5)', () => {
  it('parses tabs, commas, Arabic commas and pipes; skips blanks, duplicates and short names', () => {
    const t = sys();
    const { token } = t.ready();
    const text = [
      'مدرسة الرواد\tأ. محمد\t0501111111\t300\t20\t5',
      'مدرسة الإبداع، أ. علي، 0502222222',
      'مدرسة التميز | أ. سالم',
      '',
      '   ',
      'مدرسة الريادة,أ. فهد,0503333333,100,10,3',
      'م',
      'مدرسة الرواد',
      SCHOOLS[0].name
    ].join('\n');
    const r = t.call('api_bulkAddSchools', token, text);
    assert.equal(r.ok, true);
    assert.equal(r.added, 4);
    const reasons = r.skipped.map((s) => s.reason).sort();
    assert.deepEqual(reasons, ['اسم غير صالح', 'مكررة', 'مكررة'].sort());
    const list = t.call('api_schools', token).schools;
    const a = list.find((s) => s.name === 'مدرسة الرواد');
    assert.equal(a.principal, 'أ. محمد'); assert.equal(a.phone, '0501111111');
    assert.equal(a.students, 300); assert.equal(a.teachers, 20); assert.equal(a.staff, 5);
    assert.equal(list.find((s) => s.name === 'مدرسة الإبداع').phone, '0502222222');
    assert.equal(list.find((s) => s.name === 'مدرسة التميز').principal, 'أ. سالم');
    assert.equal(list.find((s) => s.name === 'مدرسة الريادة').staff, 3);
    assert.equal(list.length, 7);
    noDateCells(t.env);
  });
  it('refuses more than 200 lines', () => {
    const t = sys();
    const { token } = t.ready();
    const lines = Array.from({ length: 201 }, (_, i) => 'مدرسة رقم ' + (i + 1));
    expectError(() => t.call('api_bulkAddSchools', token, lines.join('\n')));
    assert.equal(t.call('api_bulkAddSchools', token, lines.slice(0, 200).join('\n')).added, 200);
  });
});

/* ================================================================== 6. general link */
describe('general link (school picker + pin)', () => {
  it('resolves a school by id + pin, rate-limits wrong pins per school for 15 minutes', () => {
    const t = sys();
    const { schools } = t.ready();
    const [a, b] = schools;
    const r = t.call('api_resolveSchool', a.id, a.pin);
    assert.equal(r.ok, true);
    assert.equal(t.form(r.token).school.name, a.name, 'the credential opens that school');
    const wrong = a.pin === '0000' ? '1111' : '0000';
    for (let i = 0; i < 5; i++) expectError(() => t.call('api_resolveSchool', a.id, wrong), /رمز المدرسة غير صحيح|محاولات كثيرة/);
    expectError(() => t.call('api_resolveSchool', a.id, a.pin), /محاولات كثيرة، حاول بعد ربع ساعة/, 'locked even with the right pin');
    assert.equal(t.form(t.call('api_resolveSchool', b.id, b.pin).token).school.name, b.name, 'other schools are not locked');
    t.clock.advance(16 * 60000);
    assert.equal(t.call('api_resolveSchool', a.id, a.pin).token, r.token, 'same school + same code → same credential');
  });
  it('[security] wrong codes are capped over ALL schools per 15 minutes and per day; the supervisor log shows it', () => {
    const t = sys({ clock: '2026-10-14T00:05' });
    const token = t.setup();
    const names = Array.from({ length: 40 }, (_, i) => 'مدرسة الاختبار رقم ' + (i + 1));
    assert.equal(t.call('api_bulkAddSchools', token, names.join('\n')).added, 40);
    const schools = t.call('api_schools', token).schools;
    const picker = t.boot({ f: 'all' }).picker.schools;   // what an anonymous visitor sees
    assert.equal(picker.length, 40);
    const pinOf = {};
    schools.forEach((s) => { pinOf[s.id] = s.pin; });
    // The reported attack: 4 guesses per school per window (never trips the per-school lock), every 15 minutes.
    // Before the fix every window checked 4 × 40 = 160 codes; the attacker stops a window at the first refusal.
    const checked = [];
    for (let w = 0; w < 6; w++) {
      let n = 0, paused = false;
      for (const s of picker) {
        for (let g = 0; g < 4 && !paused; g++) {
          let guess = String(1000 + w * 4 + g);
          if (guess === pinOf[s.id]) guess = String(9000 + g);
          try { t.call('api_resolveSchool', s.id, guess); assert.fail('a wrong code was accepted'); } catch (e) {
            if (/غير صحيح/.test(e.message)) n++;
            else if (/متوقف مؤقتًا/.test(e.message)) paused = true;
            else throw e;
          }
        }
        if (paused) break;
      }
      checked.push(n);
      t.clock.advance(15 * 60000);
    }
    assert.deepEqual(checked, [20, 20, 20, 0, 0, 0], 'codes checked per 15-minute window: 20, and 60 per day over all schools');
    const real = schools[7];
    t.at('2026-10-14T23:50');
    expectError(() => t.call('api_resolveSchool', real.id, real.pin), /متوقف مؤقتًا/, 'paused even with the right code (no oracle while paused)');
    assert.equal(t.form(real.token).ok, true, 'private links keep working');
    const log = t.sheet(SH.log).values.map((r) => r.join(' '));
    assert.ok(log.some((l) => l.includes('رمز مدرسة غير صحيح')), 'the first wrong code is logged');
    assert.ok(log.some((l) => l.includes('إيقاف مؤقت للدخول برمز المدرسة')), 'the pause is logged');
    assert.ok(log.filter((l) => l.includes('رمز مدرسة غير صحيح')).length <= 4, 'one line per window, not per guess');
    t.at('2026-10-15T07:00');
    assert.equal(t.form(t.call('api_resolveSchool', real.id, real.pin).token).school.name, real.name, 'the next day works again');
  });
  it('[security] the general link never hands out the private link; a new code signs out devices that used the old one', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const [a, b] = schools;
    const cred = t.call('api_resolveSchool', a.id, a.pin).token;
    assert.match(cred, /^g[0-9a-f]{32}$/);
    assert.ok(!cred.includes(a.token) && cred !== a.token, 'the private token is not revealed');
    assert.equal(t.boot({ s: cred }).form.school.name, a.name, '?s=<credential> opens the form');
    assert.equal(t.submit(cred).ok, true, 'and the device can submit');
    // the supervisor suspects the code leaked → «إنشاء رمز جديد»
    const fresh = t.call('api_regeneratePin', token, a.id).school;
    assert.equal(t.form(cred).code, 'BAD_LINK', 'the device that used the old code is signed out');
    expectError(() => t.submit(cred), /الرابط غير صحيح/);
    expectError(() => t.upload(cred), /الرابط غير صحيح/);
    assert.equal(t.form(a.token).ok, true, 'the private link is not affected');
    const cred2 = t.call('api_resolveSchool', a.id, fresh.pin).token;
    assert.notEqual(cred2, cred);
    assert.equal(t.form(cred2).school.name, a.name, 'the new code works');
    t.call('api_regenerateLink', token, a.id);
    assert.equal(t.form(cred2).code, 'BAD_LINK', 'a new private link also signs general-link devices out');
    const credB = t.call('api_resolveSchool', b.id, b.pin).token;
    t.call('api_setSchoolActive', token, b.id, false);
    assert.equal(t.form(credB).code, 'INACTIVE');
    assert.equal(t.form('g' + '0'.repeat(32)).code, 'BAD_LINK', 'a made-up credential opens nothing');
  });
  it('rejects unknown/inactive schools and malformed input', () => {
    const t = sys();
    const { token, schools } = t.ready();
    expectError(() => t.call('api_resolveSchool', 'Sxxxxxxx', '1234'));
    expectError(() => t.call('api_resolveSchool', schools[0].id, '12'));
    expectError(() => t.call('api_resolveSchool', null, null));
    t.call('api_setSchoolActive', token, schools[1].id, false);
    expectError(() => t.call('api_resolveSchool', schools[1].id, schools[1].pin));
  });
  it('can be disabled by the supervisor', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.call('api_saveSettings', token, { links: { generalEnabled: false } });
    expectError(() => t.call('api_resolveSchool', schools[0].id, schools[0].pin), /الرابط العام غير مفعّل/);
    const boot = t.boot({ f: 'all' });
    assert.equal(boot.picker.ok, false);
    assert.match(boot.picker.error, /الرابط العام غير مفعّل/);
    assert.ok(!JSON.stringify(boot).includes(schools[0].name), 'disabled picker must not list schools');
  });
});

/* ================================================================== 7. school form states */
describe('school form (api_schoolForm) states', () => {
  it('open before the deadline, with everything the page needs', () => {
    const t = sys();
    const { schools } = t.ready();
    const f = t.form(schools[0]);
    assert.equal(f.ok, true);
    assert.equal(f.preview, false);
    assert.equal(f.state, 'open');
    assert.equal(f.canEdit, true);
    assert.equal(f.existing, null);
    assert.equal(f.today, '2026-10-14'); assert.equal(f.date, '2026-10-14');
    assert.equal(f.now, '07:30'); assert.equal(f.deadline, '09:00');
    assert.equal(f.isWorkday, true); assert.equal(f.isHoliday, false);
    assert.equal(f.reviewEnabled, true);
    assert.deepEqual(f.returned, []);
    assert.equal(f.school.name, SCHOOLS[0].name);
    assert.equal(f.school.students, 400);
    assert.equal(f.supervisor.name, 'أحمد المشرف');
    assert.equal(f.systemTitle, 'متابعة سير العملية التعليمية');
    assert.equal(f.fields.length, 6);
    assert.ok(!('token' in f.school) && !('pin' in f.school), 'school form must not echo token/pin');
    t.at('2026-10-14T09:00');
    assert.equal(t.form(schools[0]).state, 'open', 'exactly at the deadline is still on time');
  });
  it('late after the deadline when late submissions are allowed', () => {
    const t = sys();
    const { schools } = t.ready();
    t.at('2026-10-14T09:30');
    const f = t.form(schools[0]);
    assert.equal(f.state, 'late'); assert.equal(f.canEdit, true);
    const r = t.submit(schools[0]);
    assert.equal(r.receipt.late, true);
  });
  it('closed after the deadline when allowLate=false (no existing report)', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.call('api_saveSettings', token, { schedule: { allowLate: false } });
    t.submit(schools[1]);
    t.at('2026-10-14T09:30');
    const f = t.form(schools[0]);
    assert.equal(f.state, 'closed'); assert.equal(f.canEdit, false);
    expectError(() => t.submit(schools[0]), /انتهى وقت الإرسال لهذا اليوم/);
    const g = t.form(schools[1]);
    assert.equal(g.canEdit, false, 'pending report cannot be edited after the deadline when late is not allowed');
    expectError(() => t.submit(schools[1]));
  });
  it('workday, weekend and holiday flags use Riyadh dates (UTC weekday math)', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.at('2026-10-16T08:00');   // Friday
    assert.equal(t.form(schools[0]).isWorkday, false);
    t.at('2026-10-17T08:00');   // Saturday
    assert.equal(t.form(schools[0]).isWorkday, false);
    t.at('2026-10-18T00:30');   // Sunday just after midnight in Riyadh (still Saturday in UTC and in Los Angeles)
    const f = t.form(schools[0]);
    assert.equal(f.today, '2026-10-18'); assert.equal(f.isWorkday, true);
    t.call('api_saveSettings', token, { holidays: ['2026-10-18'] });
    assert.equal(t.form(schools[0]).isHoliday, true);
  });
  it('past dates open only when that report was returned (correction); otherwise NOT_EDITABLE', () => {
    const t = sys();
    const { schools } = t.ready();
    t.submit(schools[0]);
    t.at('2026-10-15T08:00');
    for (const d of ['2026-10-14', '2026-10-13', '2026-10-20', 'not-a-date', '2026-02-30']) {
      const f = t.form(schools[0], d);
      assert.equal(f.ok, false, d); assert.equal(f.code, 'NOT_EDITABLE', d);
      assert.equal(f.error, 'لا يمكن فتح تقرير هذا اليوم.');
    }
    assert.equal(t.form(schools[0], '2026-10-15').state, 'open', 'date = today behaves like no date');
  });
  it('preview token: form only; uploads and submissions are refused', () => {
    const t = sys();
    t.ready();
    const f = t.form('__preview');
    assert.equal(f.ok, true); assert.equal(f.preview, true);
    assert.deepEqual([f.school.students, f.school.teachers, f.school.staff], [400, 30, 8]);
    expectError(() => t.upload('__preview'));
    expectError(() => t.call('api_submitReport', '__preview', { answers: t.answers(), filledBy: 'أ. خالد' }));
  });
});

/* ================================================================== 8. answer validation */
describe('answer validation (§5)', () => {
  function withCustomFields() {
    const t = sys();
    const r = t.ready();
    const base = t.fields.map((f) => Object.assign({}, f));
    const fields = t.call('api_saveFields', r.token, base.concat([
      { label: 'عدد الزوار', type: 'number', required: false, min: 5, max: 10, help: '' },
      { label: 'نص قصير', type: 'text', required: false },
      { label: 'نوع النشاط', type: 'select', required: false, options: ['رياضي', 'ثقافي', 'علمي'] },
      { label: 'هل يوجد نشاط؟', type: 'yesno', required: false },
      { label: 'ملاحظة إلزامية', type: 'text', required: true }
    ])).fields;
    t.fields = fields;
    const by = (label) => fields.find((f) => f.label === label);
    return Object.assign(r, { t, fields, by });
  }
  const ok = (t, s, answers, filledBy) => t.call('api_submitReport', s.token, { answers, filledBy: filledBy || 'أ. خالد' });
  it('accepts a complete valid report and returns the receipt', () => {
    const { t, schools, by } = withCustomFields();
    const a = t.answers();
    a[by('ملاحظة إلزامية').id] = 'تمام';
    a[by('عدد الزوار').id] = 7;
    a[by('نوع النشاط').id] = 'ثقافي';
    a[by('هل يوجد نشاط؟').id] = true;
    const r = ok(t, schools[0], a);
    assert.equal(r.ok, true);
    assert.equal(r.receipt.schoolName, SCHOOLS[0].name);
    assert.equal(r.receipt.date, '2026-10-14');
    assert.equal(r.receipt.status, 'pending');
    assert.equal(r.receipt.filledBy, 'أ. خالد');
    assert.equal(r.receipt.answers[by('عدد الزوار').id], 7);
    assert.equal(r.receipt.answers[by('هل يوجد نشاط؟').id], true);
  });
  it('rejects every kind of invalid value', () => {
    const { t, schools, by, fields } = withCustomFields();
    const mode = fields.find((f) => f.kpi === 'mode');
    const att = fields.find((f) => f.type === 'attendance');
    const planned = fields.find((f) => f.kpi === 'lessons_planned');
    const done = fields.find((f) => f.kpi === 'lessons_done');
    const note = fields.find((f) => f.type === 'textarea');
    const valid = () => { const a = t.answers(); a[by('ملاحظة إلزامية').id] = 'تمام'; return a; };
    const cases = {
      'missing required select': (a) => { delete a[mode.id]; },
      'select value not in options': (a) => { a[mode.id] = 'هجين'; },
      'attendance row missing': (a) => { delete a[att.id].teachers; },
      'attendance zero total': (a) => { a[att.id].students = { present: 0, absent: 0 }; },
      'attendance negative': (a) => { a[att.id].students.absent = -1; },
      'attendance fraction': (a) => { a[att.id].students.absent = 1.5; },
      'attendance too large': (a) => { a[att.id].students.present = 100001; },
      'attendance not a number': (a) => { a[att.id].staff.present = 'abc'; },
      'attendance missing absent number': (a) => { delete a[att.id].staff.absent; },
      'required number missing': (a) => { delete a[planned.id]; },
      'number negative': (a) => { a[planned.id] = -3; },
      'number below min': (a) => { a[by('عدد الزوار').id] = 4; },
      'number above max': (a) => { a[by('عدد الزوار').id] = 11; },
      'number not integer': (a) => { a[by('عدد الزوار').id] = 7.5; },
      'text too long': (a) => { a[by('نص قصير').id] = 'ن'.repeat(301); },
      'textarea too long': (a) => { a[note.id] = 'ن'.repeat(1001); },
      'required text empty': (a) => { a[by('ملاحظة إلزامية').id] = '   '; },
      'optional select invalid': (a) => { a[by('نوع النشاط').id] = 'غير موجود'; },
      'answers not an object': (a) => 'replace'
    };
    for (const [label, mut] of Object.entries(cases)) {
      const a = valid();
      const r = mut(a);
      expectError(() => ok(t, schools[0], r === 'replace' ? 'x' : a), null, label);
    }
    const a = valid(); a[planned.id] = 30; a[done.id] = 31;
    expectError(() => ok(t, schools[0], a), /عدد الحصص المفعّلة لا يمكن أن يتجاوز عدد الحصص المخطط لها/);
    for (const filledBy of [undefined, '', 'أ', 'م'.repeat(81), { x: 1 }]) {
      expectError(() => t.call('api_submitReport', schools[0].token, { answers: valid(), filledBy }), null, 'filledBy ' + JSON.stringify(filledBy));
    }
    assert.equal(reportRows(t).length, 0, 'nothing was stored by invalid submissions');
  });
  it('yes/no answers are stored as booleans', () => {
    const { t, schools, by } = withCustomFields();
    const a = t.answers(); a[by('ملاحظة إلزامية').id] = 'تمام';
    a[by('هل يوجد نشاط؟').id] = 'maybe';
    let stored;
    try { stored = ok(t, schools[0], a).receipt.answers[by('هل يوجد نشاط؟').id]; } catch (e) { assertUserMessage(e.message); return; }
    assert.equal(typeof stored, 'boolean', 'yes/no must be stored as true/false');
  });
  it('ignores unknown field ids and trims text', () => {
    const { t, schools, by } = withCustomFields();
    const a = t.answers(); a[by('ملاحظة إلزامية').id] = '  تمام  ';
    a.f_unknown = 'x'; a.__proto__x = 'y';
    const r = ok(t, schools[0], a);
    assert.ok(!('f_unknown' in r.receipt.answers));
    assert.ok(!('__proto__x' in r.receipt.answers));
    assert.equal(r.receipt.answers[by('ملاحظة إلزامية').id], 'تمام');
  });
  it('lessons: notActivated and activationPct are derived; planned 0 gives null pct', () => {
    const t = sys();
    const { schools } = t.ready();
    let r = t.submit(schools[0], { planned: 40, done: 36 }).receipt;
    assert.deepEqual(r.derived.lessons, { planned: 40, done: 36, notActivated: 4, activationPct: 90 });
    r = t.submit(schools[1], { planned: 0, done: 0 }).receipt;
    assert.equal(r.derived.lessons.activationPct, null);
  });
});

/* ================================================================== 9. photos */
describe('evidence photos', () => {
  it('uploads into the app folder with a school-scoped name and returns photo meta', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const r = t.upload(schools[0], { w: 640, h: 480 });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.photo).sort(), ['h', 'id', 'name', 'size', 'w']);
    assert.equal(r.photo.size, 70); assert.equal(r.photo.w, 640); assert.equal(r.photo.h, 480);
    const file = t.env.drive.file(r.photo.id);
    assert.ok(file.name.startsWith('2026-10-14_' + schools[0].id + '_'), file.name);
    assert.match(file.name, /^2026-10-14_S[a-z0-9]{7}_[A-Za-z0-9]{6}\.\w+$/);
    assert.ok(String(file.description).includes(SCHOOLS[0].name) && String(file.description).includes('2026-10-14'));
    const folder = t.env.drive.folders.find((f) => f.id === file.parents[0]);
    assert.equal(folder.name, PHOTOS_FOLDER);
    assert.equal(t.call('api_schoolPhoto', schools[0].token, r.photo.id).dataUrl, 'data:image/png;base64,' + PNG_B64);
    assert.equal(t.call('api_photo', token, r.photo.id).dataUrl, 'data:image/png;base64,' + PNG_B64);
    expectError(() => t.call('api_schoolPhoto', schools[1].token, r.photo.id), null, 'another school cannot read it');
    expectError(() => t.call('api_photo', token, '1DoesNotExistInDrive'));
    const b = t.call('api_bootstrap', token);
    assert.match(String(b.photosFolderUrl), /^https:\/\/drive\.google\.com\/drive\/folders\//);
  });
  it('rejects bad mime types, oversize files (before decoding), invalid base64, preview and inactive schools', () => {
    const t = sys();
    const { token, schools } = t.ready();
    for (const mime of ['image/gif', 'text/html', 'application/pdf', '', null]) expectError(() => t.upload(schools[0], { mime }), null, 'mime ' + mime);
    const before = t.env.counters['Utilities.base64Decode'] || 0;
    expectError(() => t.upload(schools[0], { base64: bigBase64(3 * 1024 * 1024 + 256 * 1024), mime: 'image/jpeg' }), null, 'far over 3 MB');
    assert.equal(t.env.counters['Utilities.base64Decode'] || 0, before, 'size must be checked before base64Decode (§8: length × 3/4 ≤ 3 MB + slack)');
    expectError(() => t.upload(schools[0], { base64: bigBase64(3 * 1024 * 1024 + 3), mime: 'image/jpeg' }), null, 'just over 3 MB (decoded size)');
    expectError(() => t.upload(schools[0], { base64: 'iVBORw0KGgo' + '!'.repeat(20) }), null, 'invalid base64 characters');
    expectError(() => t.upload(schools[0], { base64: Buffer.from('<html>not an image</html>').toString('base64') }), null, 'bytes are not an image');
    expectError(() => t.upload(schools[0], { base64: '%%%notbase64%%%' }));
    expectError(() => t.upload(schools[0], { base64: '' }));
    expectError(() => t.upload('BadTokenBadTokenBad1'));
    t.call('api_setSchoolActive', token, schools[1].id, false);
    expectError(() => t.upload(schools[1]));
    assert.equal(t.env.drive.files.length, 0, 'nothing written to Drive');
  });
  it('limits uploads to 40 per school per day', () => {
    const t = sys();
    const { schools } = t.ready();
    for (let i = 0; i < 40; i++) assert.equal(t.upload(schools[0]).ok, true);
    expectError(() => t.upload(schools[0]), null, '41st upload');
    assert.equal(t.upload(schools[1]).ok, true, 'other schools unaffected');
    t.at('2026-10-15T07:00');
    assert.equal(t.upload(schools[0]).ok, true, 'resets the next day');
  });
  it('[security] the daily upload and submit caps hold all day (not per 6-hour cache entry) and survive cache eviction', () => {
    const t = sys({ clock: '2026-10-14T00:05' });
    const { schools } = t.ready();
    const a = schools[0];
    for (let i = 0; i < 40; i++) assert.equal(t.upload(a).ok, true);
    for (const at of ['2026-10-14T06:10', '2026-10-14T12:15', '2026-10-14T18:20', '2026-10-14T23:59']) {
      t.at(at);
      t.env.evictCache();
      expectError(() => t.upload(a), /الحد اليومي لرفع الصور/, 'still capped at ' + at);
    }
    assert.equal(t.env.drive.files.length, 40, 'one school: 40 photos per day, not 160');
    t.at('2026-10-14T08:00');
    for (let i = 0; i < 30; i++) assert.equal(t.submit(schools[1]).ok, true);
    t.at('2026-10-14T08:59');
    t.env.evictCache();
    expectError(() => t.submit(schools[1]), /الحد اليومي لمرات الإرسال/);
    t.at('2026-10-15T00:01');
    assert.equal(t.upload(a).ok, true, 'a new day starts a new count');
  });
  it('[security] a daily byte budget over all schools caps Drive growth; uploads stop when Drive is 90 % full', () => {
    const real = sys();
    assert.equal(real.app.evaluate('LIMITS_.uploadBytesPerDay'), 300 * 1024 * 1024, 'the real budget is 300 MB a day');
    const code = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8').replace('uploadBytesPerDay: 300 * 1024 * 1024,', 'uploadBytesPerDay: 500,');
    assert.notEqual(code, fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8'));
    const t = sys({ code });
    const { schools } = t.ready();
    const png = Buffer.from(PNG_B64, 'base64').length;   // 70 bytes
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const s = schools[i % 3];
      try { t.upload(s); ok++; } catch (e) { assert.match(e.message, /بلغت الحد اليومي للنظام/); }
    }
    assert.equal(ok, Math.floor(500 / png), 'stops at the budget, whichever schools upload');
    assert.equal(t.sheet(SH.log).values.filter((r) => r.join(' ').includes('إيقاف رفع الصور لبقية اليوم')).length, 1, 'logged once');
    t.at('2026-10-15T07:00');
    assert.equal(t.upload(schools[0]).ok, true, 'the budget is per day');
    // the storage guard (real limits): no new file once the owner's storage is 90 % used
    const { schools: s2 } = real.ready();
    real.env.storageUsed = Math.ceil(0.9 * 15 * 1024 * 1024 * 1024);
    real.env.evictCache();
    const before = real.env.drive.files.length;
    expectError(() => real.upload(s2[0]), /ممتلئة/);
    assert.equal(real.env.drive.files.length, before, 'nothing was written');
  });
  it('[security] uploads that no report uses are trashed after 3 days; used, kept and recent photos stay', () => {
    const t = sys({ clock: '2026-10-11T07:00' });   // Sunday
    const { token, schools } = t.ready();
    const [a, b, c] = schools;
    const used = t.upload(a).photo, orphan = t.upload(a).photo;
    t.submit(a, { photos: [used] });
    const kept = t.upload(b).photo;
    t.submit(b, { photos: [kept] });
    t.call('api_deleteReport', token, '2026-10-11', b.id);   // deleting a report never deletes its photos
    const later = t.upload(c).photo;                          // uploaded today, sent with tomorrow's report
    const outside = t.env.drive.DriveApp.createFile('2026-10-11_' + a.id + '_abcdef.png', 'x', 'image/png');
    t.at('2026-10-12T07:10');
    t.submit(c, { photos: [later] });
    const recent = t.upload(a).photo;                         // Monday's unused upload
    t.at('2026-10-13T08:00');
    t.call('api_bootstrap', token);
    assert.equal(t.env.drive.file(orphan.id).trashed, false, 'not before 3 days');
    t.at('2026-10-14T08:00');
    t.call('api_bootstrap', token);
    const trashed = (p) => t.env.drive.file(p.id).trashed;
    assert.equal(trashed(orphan), true, 'the unused upload is trashed');
    assert.deepEqual([used, kept, later, recent].map(trashed), [false, false, false, false], 'used / kept / too recent stay');
    assert.equal(t.env.drive.file(outside.getId()).trashed, false, 'files outside the app folder are never touched');
    t.call('api_bootstrap', token);
    assert.equal(t.app.lastCall.ops['Drive.Folder.searchFiles'] || 0, 0, 'once a day');
    t.at('2026-10-15T08:00');
    t.call('api_bootstrap', token);
    assert.equal(trashed(recent), true, "Monday's unused upload goes three days later");
    assert.equal(t.call('api_report', token, '2026-10-11', a.id).ok, true);
    assert.equal(t.call('api_photo', token, used.id).ok, true, 'evidence still opens');
  });
  it('photo answers must belong to this school, exist, not be trashed, and respect maxCount', () => {
    const t = sys();
    const { schools } = t.ready();
    const mine = [t.upload(schools[0]).photo, t.upload(schools[0]).photo];
    const theirs = t.upload(schools[1]).photo;
    const r = t.submit(schools[0], { photos: mine });
    assert.equal(r.receipt.derived.photosCount, 2);
    expectError(() => t.submit(schools[0], { photos: [theirs] }), null, 'photo of another school');
    expectError(() => t.submit(schools[0], { photos: [{ id: '1NoSuchFileAnywhere', name: 'x', w: 1, h: 1, size: 1 }] }), null, 'unknown id');
    expectError(() => t.submit(schools[0], { photos: [{ id: t.env.drive.folders[0].id, name: 'x', w: 1, h: 1, size: 1 }] }), null, 'folder id');
    const seven = Array.from({ length: 7 }, () => t.upload(schools[0]).photo);
    expectError(() => t.submit(schools[0], { photos: seven }), null, 'more than maxCount (6)');
    const extra = t.upload(schools[0]).photo;
    assert.equal(t.call('api_discardPhoto', schools[0].token, extra.id).ok, true);
    assert.equal(t.env.drive.file(extra.id).trashed, true);
    expectError(() => t.submit(schools[0], { photos: [extra] }), null, 'trashed photo');
    expectError(() => t.call('api_discardPhoto', schools[1].token, mine[0].id), null, 'cannot discard another school photo');
    assert.equal(t.env.drive.file(mine[0].id).trashed, false);
  });
  it('photos of an approved report cannot be discarded', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const p = t.upload(schools[0]).photo;
    t.submit(schools[0], { photos: [p] });
    t.call('api_review', token, '2026-10-14', schools[0].id, 'approve', '');
    try { t.call('api_discardPhoto', schools[0].token, p.id); } catch (e) { assertUserMessage(e.message); }   // refusing or a no-op are both fine
    assert.equal(t.env.drive.file(p.id).trashed, false, 'evidence of an approved report must stay in Drive');
    assert.equal(t.call('api_photo', token, p.id).dataUrl.slice(0, 22), 'data:image/png;base64,');
  });
  it('re-creates the photos folder when it was trashed', () => {
    const t = sys();
    const { schools } = t.ready();
    const first = t.upload(schools[0]).photo;
    const oldFolder = t.env.drive.file(first.id).parents[0];
    t.env.drive.trash(oldFolder);
    const second = t.upload(schools[0]).photo;
    const newFolder = t.env.drive.file(second.id).parents[0];
    assert.notEqual(newFolder, oldFolder);
    assert.equal(t.env.drive.folders.find((f) => f.id === newFolder).trashed, false);
  });
});

/* ================================================================== 10. submission upsert */
describe('report submission (upsert)', () => {
  it('first submit, edits keep submittedAt, bump edits and update updatedAt', () => {
    const t = sys();
    const { schools } = t.ready();
    let r = t.submit(schools[0]).receipt;
    assert.equal(r.status, 'pending');
    assert.equal(r.submittedAt, '2026-10-14 07:30:00');
    assert.equal(r.updatedAt, '2026-10-14 07:30:00');
    assert.equal(r.late, false); assert.equal(r.edits, 0);
    assert.equal(r.reviewNote, ''); assert.equal(r.reviewedAt, '');
    t.at('2026-10-14T08:10');
    r = t.submit(schools[0], { att: { students: { present: 370, absent: 30 } } }).receipt;
    assert.equal(r.edits, 1);
    assert.equal(r.submittedAt, '2026-10-14 07:30:00');
    assert.equal(r.updatedAt, '2026-10-14 08:10:00');
    assert.equal(r.derived.attendance.students.absent, 30);
    t.at('2026-10-14T09:40');
    r = t.submit(schools[0]).receipt;
    assert.equal(r.late, false, 'an on-time report stays on time when edited later');
    assert.equal(r.edits, 2);
    const rows = reportRows(t);
    assert.equal(rows.length, 1, 'one row per (date, school)');
    assert.equal(rows[0][0], '2026-10-14|' + schools[0].id);
    assert.equal(rows[0][1], '2026-10-14');
    assert.equal(rows[0][4], 'بانتظار المراجعة');
  });
  it('a late report stays late after edits', () => {
    const t = sys();
    const { schools } = t.ready();
    t.at('2026-10-14T09:30');
    assert.equal(t.submit(schools[1]).receipt.late, true);
    t.at('2026-10-14T10:00');
    const r = t.submit(schools[1]).receipt;
    assert.equal(r.late, true); assert.equal(r.submittedAt, '2026-10-14 09:30:00'); assert.equal(r.edits, 1);
  });
  it('derived attendance per row', () => {
    const t = sys();
    const { schools } = t.ready();
    const d = t.submit(schools[0], { att: { students: { present: 390, absent: 30 }, teachers: { present: 30, absent: 0 }, staff: { present: 7, absent: 1 } } }).receipt.derived;
    assert.deepEqual(d.attendance.students, { present: 390, absent: 30, total: 420, absencePct: 7.1 });
    assert.deepEqual(d.attendance.teachers, { present: 30, absent: 0, total: 30, absencePct: 0 });
    assert.deepEqual(d.attendance.staff, { present: 7, absent: 1, total: 8, absencePct: 12.5 });
    assert.equal(d.mode, 'حضوري');
    assert.equal(d.photosCount, 0);
  });
  it('limits submissions to 30 per school per day', () => {
    const t = sys();
    const { schools } = t.ready();
    for (let i = 0; i < 30; i++) assert.equal(t.submit(schools[0]).ok, true);
    expectError(() => t.submit(schools[0]), null, '31st submission');
  });
  it('wraps the write in a script lock and releases it', () => {
    const t = sys();
    const { schools } = t.ready();
    const before = Object.assign({}, t.env.lockStats);
    t.submit(schools[0]);
    assert.ok(t.env.lockStats.acquired > before.acquired, 'LockService used');
    assert.equal(t.env.lockStats.acquired - before.acquired, t.env.lockStats.released - before.released, 'every lock released');
    assert.ok(!t.env.warnings.some((w) => /still holding a lock/.test(w.message)), 'no lock leak');
  });
  it('a busy lock gives a friendly Arabic error, not a raw exception', () => {
    const t = sys();
    const { schools } = t.ready();
    t.env.contendLock(1);
    expectError(() => t.submit(schools[0]));
  });
  it('submissions are not written to the log sheet', () => {
    const t = sys();
    const { schools } = t.ready();
    const n = t.sheet(SH.log).lastRow;
    t.submit(schools[0]); t.submit(schools[1]);
    assert.equal(t.sheet(SH.log).lastRow, n);
  });
  it('review disabled → reports are auto-approved', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.call('api_saveSettings', token, { review: { enabled: false } });
    assert.equal(t.form(schools[0]).reviewEnabled, false);
    const r = t.submit(schools[0]).receipt;
    assert.equal(r.status, 'approved');
    assert.equal(t.day().totals.approved, 1);
    assert.equal(t.day().totals.pending, 0);
    assert.equal(t.form(schools[0]).existing.status, 'approved');
  });
});

/* ================================================================== 11. review workflow */
describe('review workflow', () => {
  it('pending → returned (note) → school corrects a past date → pending → approved → locked; reopen; delete', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const A = schools[0];
    t.submit(A, { att: { students: { present: 300, absent: 100 } } });
    expectError(() => t.call('api_review', token, '2026-10-14', A.id, 'return', 'ab'), null, 'note too short');
    expectError(() => t.call('api_review', token, '2026-10-14', A.id, 'return', 'م'.repeat(301)), null, 'note too long');
    expectError(() => t.call('api_review', token, '2026-10-14', A.id, 'destroy', 'x'), null, 'bad action');
    expectError(() => t.call('api_review', token, '2026-10-14', schools[1].id, 'approve', ''), null, 'no such report');
    t.at('2026-10-14T11:00');
    const note = 'يرجى مراجعة عدد الغائبين من الطلاب';
    let rep = t.call('api_review', token, '2026-10-14', A.id, 'return', note).report;
    assert.equal(rep.status, 'returned'); assert.equal(rep.reviewNote, note); assert.equal(rep.reviewedAt, '2026-10-14 11:00:00');
    assert.equal(reportRows(t)[0][4], 'معاد للتصحيح');
    // next day: the school sees the banner data and opens the correction
    t.at('2026-10-15T07:45');
    let f = t.form(A);
    assert.equal(f.state, 'open');
    assert.deepEqual(f.returned.map((x) => [x.date, x.reviewNote]), [['2026-10-14', note]]);
    f = t.form(A, '2026-10-14');
    assert.equal(f.ok, true); assert.equal(f.state, 'correction'); assert.equal(f.canEdit, true);
    assert.equal(f.date, '2026-10-14'); assert.equal(f.existing.status, 'returned');
    rep = t.submit(A, { date: '2026-10-14', att: { students: { present: 380, absent: 20 } } }).receipt;
    assert.equal(rep.date, '2026-10-14');
    assert.equal(rep.status, 'pending');
    assert.equal(rep.reviewNote, note, 'note kept so the supervisor sees «تم التصحيح بعد ملاحظة»');
    assert.equal(rep.edits, 1);
    assert.equal(rep.submittedAt, '2026-10-14 07:30:00');
    // today's own report is a different row
    assert.equal(t.form(A).existing, null);
    // supervisor: corrected flag + info alert; pendingOther on today's dashboard
    const d14 = t.day('2026-10-14');
    assert.ok(t.row(d14, A.id).flags.includes('corrected'));
    assert.ok(d14.alerts.some((a) => a.type === 'corrected' && a.level === 'info' && a.schoolId === A.id));
    const d15 = t.day('2026-10-15');
    assert.deepEqual(d15.pendingOther.map((p) => [p.date, p.schoolId, p.schoolName]), [['2026-10-14', A.id, SCHOOLS[0].name]]);
    // approve → locked
    rep = t.call('api_review', token, '2026-10-14', A.id, 'approve', '').report;
    assert.equal(rep.status, 'approved');
    assert.equal(t.form(A, '2026-10-14').code, 'NOT_EDITABLE');
    expectError(() => t.submit(A, { date: '2026-10-14' }));
    assert.deepEqual(t.form(A).returned, []);
    assert.deepEqual(t.day('2026-10-15').pendingOther, []);
    // reopen → pending again
    rep = t.call('api_review', token, '2026-10-14', A.id, 'reopen', '').report;
    assert.equal(rep.status, 'pending');
    // printable single report
    const pr = t.call('api_report', token, '2026-10-14', A.id);
    assert.equal(pr.ok, true); assert.equal(pr.school.name, SCHOOLS[0].name); assert.equal(pr.report.status, 'pending');
    assert.equal(pr.supervisor.name, 'أحمد المشرف'); assert.ok(Array.isArray(pr.fields));
    // delete → the school may submit from scratch
    assert.equal(t.call('api_deleteReport', token, '2026-10-14', A.id).ok, true);
    assert.equal(reportRows(t).length, 0);
    expectError(() => t.call('api_report', token, '2026-10-14', A.id));
  });
  it('approved today → the school cannot edit; returned today → editable even after the deadline', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.call('api_saveSettings', token, { schedule: { allowLate: false } });
    t.submit(schools[0]); t.submit(schools[1]);
    t.call('api_review', token, '2026-10-14', schools[0].id, 'approve', '');
    t.call('api_review', token, '2026-10-14', schools[1].id, 'return', 'أكمل البيانات');
    t.at('2026-10-14T10:00');
    assert.equal(t.form(schools[0]).canEdit, false);
    expectError(() => t.submit(schools[0]), /تم اعتماد هذا التقرير ولا يمكن تعديله/);
    assert.equal(t.form(schools[1]).canEdit, true);
    assert.equal(t.submit(schools[1]).receipt.status, 'pending');
  });
  it('approve-all approves only the pending reports of that date', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.submit(schools[0]); t.submit(schools[1]); t.submit(schools[2]);
    t.call('api_review', token, '2026-10-14', schools[2].id, 'return', 'أكمل البيانات');
    const r = t.call('api_approveAll', token, '2026-10-14');
    assert.deepEqual(r, { ok: true, count: 2 });
    const d = t.day();
    assert.equal(d.totals.approved, 2); assert.equal(d.totals.returned, 1); assert.equal(d.totals.pending, 0);
    assert.equal(t.call('api_approveAll', token, '2026-10-14').count, 0);
  });
  it('review actions are logged', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.submit(schools[0]);
    const n = t.sheet(SH.log).lastRow;
    t.call('api_review', token, '2026-10-14', schools[0].id, 'approve', '');
    assert.ok(t.sheet(SH.log).lastRow > n);
  });
});

describe('correction banner data', () => {
  it('lists returned reports newest first, at most 10', () => {
    const t = sys({ clock: '2026-09-27T07:00' });
    const { token, schools } = t.ready();
    const A = schools[0];
    const days = [];
    for (let d = new Date(Date.UTC(2026, 8, 27)); days.length < 12; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 5 || d.getUTCDay() === 6) continue;
      const iso = d.toISOString().slice(0, 10);
      days.push(iso);
      t.at(iso + 'T07:30');
      t.submit(A);
      t.call('api_review', token, iso, A.id, 'return', 'ملاحظة يوم ' + iso);
    }
    t.at('2026-10-14T07:30');
    const f = t.form(A);
    assert.equal(f.returned.length, 10);
    assert.deepEqual(f.returned.map((r) => r.date), days.slice(-10).reverse());
    assert.equal(f.returned[0].reviewNote, 'ملاحظة يوم ' + days[11]);
    assert.ok(f.returned.every((r) => typeof r.reviewedAt === 'string' && r.reviewedAt.length >= 16));
  });
});

describe('robustness', () => {
  it('doGet never throws: a broken template yields a friendly Arabic page', () => {
    const t = sys();
    t.env.setFiles(() => null);
    const html = t.app.doGet({});
    assert.match(html, ARABIC);
    assert.match(html, /dir=["']?rtl/i);
    const html2 = t.app.doGet({ s: 'whatever' });
    assert.match(html2, ARABIC);
  });
  it('the log sheet is trimmed to the newest 2000 rows once it passes 2200', () => {
    const t = sys();
    const { token } = t.ready();
    const sh = t.env.spreadsheet.getSheetByName(SH.log);
    const n = 2205;
    if (sh.getMaxRows() < n + 10) sh.insertRowsAfter(sh.getMaxRows(), n + 10 - sh.getMaxRows());
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, n, 3).setNumberFormat('@').setValues(Array.from({ length: n }, (_, i) => ['2026-10-01 00:00:00', 'قديم', 'سطر ' + i]));
    t.call('api_saveSettings', token, { schedule: { deadline: '09:15' } });
    const log = t.sheet(SH.log);
    assert.ok(log.lastRow <= 2001 && log.lastRow >= 1900, 'log rows after trim: ' + log.lastRow);
    assert.equal(log.headers[0], 'الوقت', 'header kept');
    assert.ok(!log.values.slice(1).some((r) => r[2] === 'سطر 0'), 'oldest rows removed');
    assert.ok(log.values[log.values.length - 1][0] >= '2026-10-14', 'newest row kept');
  });
  it('rejects more than 200 holidays', () => {
    const t = sys();
    const { token } = t.ready();
    const days = Array.from({ length: 201 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10));
    expectError(() => t.call('api_saveSettings', token, { holidays: days }));
    assert.equal(t.call('api_saveSettings', token, { holidays: days.slice(0, 200) }).ok, true);
    assert.equal(t.call('api_getSettings', token).holidays.length, 200);
  });
  it('deletes the only report / school even in a sheet trimmed to header + 1 row', () => {
    // Real Sheets refuses to delete the last non-frozen row ("not possible to delete all non-frozen rows").
    const t = sys({ newSheetRows: 2 });
    const { token, schools } = t.ready({ schools: [SCHOOLS[0]] });
    assert.equal(t.submit(schools[0]).ok, true);
    assert.equal(t.call('api_deleteReport', token, '2026-10-14', schools[0].id).ok, true);
    assert.equal(reportRows(t).length, 0);
    assert.equal(t.call('api_deleteSchool', token, schools[0].id).ok, true);
    assert.equal(t.call('api_schools', token).schools.length, 0);
    // and the sheets still work afterwards
    const s2 = t.call('api_saveSchool', token, { name: 'مدرسة جديدة', students: 100 }).school;
    assert.equal(t.submit(s2).ok, true);
    assert.equal(reportRows(t).length, 1);
    noFormulas(t.env);
  });
  it('stores a short user-agent label with the session', () => {
    const t = sys();
    const token = t.login('Chrome على Android');
    const sess = JSON.parse(t.prop('sess:' + GasMock.sha256Hex(token)));
    assert.equal(typeof sess.ua, 'string');
    assert.ok(sess.ua.length <= 80);
    assert.match(sess.created, /^2026-10-14 \d{2}:\d{2}:\d{2}$/);
  });
});

/* ================================================================== 12. day dashboard */
describe('day dashboard: totals, flags, alerts, ordering', () => {
  function scenario() {
    const t = sys({ clock: '2026-10-11T07:00' });
    const r = t.ready();
    t.at('2026-10-14T07:30');
    return Object.assign(r, { t });
  }
  it('computes totals from submitted reports with 1-decimal percentages', () => {
    const { t, schools } = scenario();
    const [A, B] = schools;
    t.submit(A, { att: { students: { present: 380, absent: 20 }, teachers: { present: 29, absent: 1 }, staff: { present: 8, absent: 0 } }, planned: 40, done: 36, mode: 'حضوري' });
    t.submit(B, { att: { students: { present: 255, absent: 45 }, teachers: { present: 22, absent: 3 }, staff: { present: 5, absent: 1 } }, planned: 30, done: 20, mode: 'عن بُعد' });
    const d = t.day();
    assert.equal(d.date, '2026-10-14'); assert.equal(d.isToday, true); assert.equal(d.isWorkday, true);
    assert.equal(d.now, '07:30'); assert.equal(d.deadline, '09:00'); assert.equal(d.reviewEnabled, true);
    const T = d.totals;
    assert.deepEqual([T.schools, T.submitted, T.missing, T.pending, T.approved, T.returned, T.late], [3, 2, 1, 2, 0, 0, 0]);
    assert.deepEqual(T.students, { present: 635, absent: 65, total: 700, absencePct: 9.3 });
    assert.deepEqual(T.teachers, { present: 51, absent: 4, total: 55, absencePct: 7.3 });
    assert.deepEqual(T.staff, { present: 13, absent: 1, total: 14, absencePct: 7.1 });
    assert.deepEqual(T.lessons, { planned: 70, done: 56, notActivated: 14, activationPct: 80 });
    assert.equal(T.modes['حضوري'], 1); assert.equal(T.modes['عن بُعد'], 1);
    const rb = t.row(d, B.id);
    for (const f of ['high_absence', 'teacher_absence', 'low_activation']) assert.ok(rb.flags.includes(f), f);
    const ra = t.row(d, A.id);
    for (const f of ['high_absence', 'teacher_absence', 'low_activation', 'missing']) assert.ok(!ra.flags.includes(f), f);
    assert.equal(ra.report.status, 'pending');
    const types = d.alerts.filter((a) => a.schoolId === B.id).map((a) => a.type + ':' + a.level).sort();
    assert.deepEqual(types, ['high_absence:danger', 'low_activation:warn', 'teacher_absence:warn']);
    for (const a of d.alerts) { assert.match(a.text, ARABIC); }
    assert.ok(d.alerts.find((a) => a.type === 'high_absence').text.includes(SCHOOLS[1].name));
    assert.ok(t.row(d, schools[2].id).flags.includes('missing'));
    assert.equal(t.row(d, schools[2].id).report, null);
  });
  it('orders rows: missing, returned, pending, approved (then by name)', () => {
    const { t, token, schools } = scenario();
    const extra = t.call('api_saveSchool', token, { name: 'مدرسة الياسمين' }).school;
    t.submit(schools[0]); t.submit(schools[1]); t.submit(schools[2]);
    t.call('api_review', token, '2026-10-14', schools[0].id, 'approve', '');
    t.call('api_review', token, '2026-10-14', schools[1].id, 'return', 'أكمل البيانات');
    const ids = t.day().rows.map((r) => r.school.id);
    assert.deepEqual(ids, [extra.id, schools[1].id, schools[2].id, schools[0].id]);
  });
  it('missing_streak only after the deadline has passed; late flag + info alert', () => {
    const { t, schools } = scenario();
    const C = schools[2];
    let d = t.day();
    assert.ok(!t.row(d, C.id).flags.includes('missing_streak'), 'before today\'s deadline');
    t.at('2026-10-14T09:30');
    t.submit(schools[1]);
    d = t.day();
    assert.ok(t.row(d, C.id).flags.includes('missing_streak'));
    assert.ok(d.alerts.some((a) => a.type === 'missing_streak' && a.level === 'danger' && a.schoolId === C.id));
    assert.ok(t.row(d, schools[1].id).flags.includes('late'));
    assert.ok(d.alerts.some((a) => a.type === 'late' && a.level === 'info' && a.schoolId === schools[1].id));
    assert.equal(d.totals.late, 1);
    const past = t.day('2026-10-13');
    assert.ok(t.row(past, C.id).flags.includes('missing_streak'), 'past dates count (12th and 13th missing)');
  });
  it('jump alert: today\'s student absence well above the recent average', () => {
    const { t, schools } = scenario();
    const A = schools[0];
    for (const day of ['2026-10-11', '2026-10-12', '2026-10-13']) {
      t.at(day + 'T07:30');
      t.submit(A, { att: { students: { present: 392, absent: 8 } } });
    }
    t.at('2026-10-14T07:30');
    t.submit(A, { att: { students: { present: 376, absent: 24 } } });
    let d = t.day();
    assert.ok(t.row(d, A.id).flags.includes('jump'), JSON.stringify(t.row(d, A.id).flags));
    assert.ok(d.alerts.some((a) => a.type === 'jump' && a.level === 'warn' && a.schoolId === A.id));
    assert.ok(!t.row(d, A.id).flags.includes('high_absence'));
    // with only two previous values there is no jump
    const t2 = scenario().t;
    const A2 = t2.schools[0];
    for (const day of ['2026-10-12', '2026-10-13']) { t2.at(day + 'T07:30'); t2.submit(A2, { att: { students: { present: 392, absent: 8 } } }); }
    t2.at('2026-10-14T07:30');
    t2.submit(A2, { att: { students: { present: 376, absent: 24 } } });
    d = t2.day();
    assert.ok(!t2.row(d, A2.id).flags.includes('jump'));
  });
  it('thresholds follow the settings', () => {
    const { t, token, schools } = scenario();
    t.call('api_saveSettings', token, { alerts: { studentAbsencePct: 20, teacherAbsencePct: 50, activationPct: 50, jumpPct: 50 } });
    t.submit(schools[1], { att: { students: { present: 255, absent: 45 }, teachers: { present: 22, absent: 3 } }, planned: 30, done: 20 });
    const flags = t.row(t.day(), schools[1].id).flags;
    for (const f of ['high_absence', 'teacher_absence', 'low_activation']) assert.ok(!flags.includes(f), f);
  });
  it('non-workdays and empty days: null percentages, no missing alerts', () => {
    const { t } = scenario();
    const d = t.day('2026-10-16');
    assert.equal(d.isWorkday, false); assert.equal(d.isToday, false);
    assert.equal(d.totals.submitted, 0);
    assert.equal(d.totals.students.absencePct, null);
    assert.equal(d.totals.lessons.activationPct, null);
    assert.ok(!d.alerts.some((a) => a.type === 'missing_streak'));
    expectError(() => t.call('api_day', t.token, 'yesterday'));
  });
  it('holidays are not workdays', () => {
    const { t, token } = scenario();
    t.call('api_saveSettings', token, { holidays: ['2026-10-15'] });
    const d = t.day('2026-10-15');
    assert.equal(d.isHoliday, true);
  });
  it('stays fast: no per-school or per-row sheet reads (20 schools × 5 days)', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const token = t.setup();
    t.call('api_bulkAddSchools', token, Array.from({ length: 20 }, (_, i) => 'مدرسة رقم ' + (i + 1) + ',مدير ' + (i + 1) + ',,400,30,8').join('\n'));
    const list = t.call('api_schools', token).schools;
    t.fieldsNow();
    for (const day of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']) {
      t.at(day + 'T07:30');
      for (const s of list) t.submit(s);
    }
    t.at('2026-10-15T10:00');
    t.day();
    const ops = t.app.lastCall.ops;
    const reads = (ops['Range.getValues'] || 0) + (ops['Range.getValue'] || 0) + (ops['Range.getDisplayValues'] || 0);
    assert.ok(reads <= 25, 'api_day made ' + reads + ' sheet reads: ' + JSON.stringify(ops));
    t.at('2026-10-15T10:05');
    t.submit(list[0]);
    const ops2 = t.app.lastCall.ops;
    const reads2 = (ops2['Range.getValues'] || 0) + (ops2['Range.getValue'] || 0);
    assert.ok(reads2 <= 25, 'api_submitReport made ' + reads2 + ' sheet reads: ' + JSON.stringify(ops2));
  });
});

/* ================================================================== 13. range statistics */
describe('range statistics (api_range)', () => {
  it('computes days, schools and totals from sums (not averages of averages)', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    const [A, B] = schools;
    t.at('2026-10-12T07:30');
    t.submit(A, { att: { students: { present: 90, absent: 10 } } });
    t.submit(B, { att: { students: { present: 380, absent: 20 } }, mode: 'عن بُعد' });
    t.at('2026-10-13T07:30');
    t.submit(A, { att: { students: { present: 95, absent: 5 } } });
    t.at('2026-10-13T09:45');
    t.submit(B, { att: { students: { present: 188, absent: 12 } } });
    t.call('api_review', token, '2026-10-13', B.id, 'return', 'أكمل البيانات');
    t.at('2026-10-14T10:00');
    const r = t.call('api_range', token, '2026-10-11', '2026-10-17');
    assert.equal(r.from, '2026-10-11'); assert.equal(r.to, '2026-10-17');
    assert.equal(r.days.length, 7);
    const day = (d) => r.days.find((x) => x.date === d);
    assert.equal(day('2026-10-12').expected, 3);
    assert.equal(day('2026-10-12').submitted, 2);
    assert.equal(day('2026-10-12').compliancePct, 66.7);
    assert.equal(day('2026-10-12').studentAbsencePct, 6);
    assert.equal(day('2026-10-13').late, 1);
    assert.equal(day('2026-10-15').expected, 0, 'future dates are not expected');
    assert.equal(day('2026-10-16').expected, 0, 'Friday'); assert.equal(day('2026-10-16').isWorkday, false);
    assert.equal(r.totals.reports, 4);
    assert.equal(r.totals.avgStudentAbsencePct, 5.9);
    const sa = r.schools.find((s) => s.id === A.id), sb = r.schools.find((s) => s.id === B.id), sc = r.schools.find((s) => s.id === schools[2].id);
    assert.equal(sa.avgStudentAbsencePct, 7.5);
    assert.equal(sb.avgStudentAbsencePct, 5.3);
    assert.equal(sa.submittedDays, 2);
    assert.equal(sb.lateCount, 1); assert.equal(sb.returnedCount, 1);
    assert.equal(sb.modes['عن بُعد'], 1);
    assert.equal(sc.submittedDays, 0);
    assert.equal(sc.avgStudentAbsencePct, null);
    assert.ok(r.totals.compliancePct > 0 && r.totals.compliancePct < 100);
    assert.equal(r.totals.modes['حضوري'], 3);
  });
  it('validates the range', () => {
    const t = sys();
    const { token } = t.ready();
    expectError(() => t.call('api_range', token, '2026-10-14', '2026-10-01'));
    expectError(() => t.call('api_range', token, '2026-01-01', '2026-07-31'), null, '> 190 days');
    expectError(() => t.call('api_range', token, 'x', '2026-10-01'));
    assert.equal(t.call('api_range', token, '2026-04-08', '2026-10-14').days.length, 190);
  });
});

/* ================================================================== 14. form fields & dynamic columns */
describe('form fields (api_saveFields) & dynamic report columns', () => {
  const F = (o) => Object.assign({ type: 'text', required: false }, o);
  it('validates the field list', () => {
    const t = sys();
    const { token } = t.ready();
    const base = t.fields;
    const bad = {
      'more than 25': Array.from({ length: 26 }, (_, i) => F({ label: 'سؤال ' + i })),
      'duplicate label': [F({ label: 'سؤال' }), F({ label: 'سؤال' })],
      'empty label': [F({ label: '' })],
      'label too long': [F({ label: 'س'.repeat(81) })],
      'two attendance': [F({ label: 'أ', type: 'attendance', rows: ['students'] }), F({ label: 'ب', type: 'attendance', rows: ['teachers'] })],
      'two photos': [F({ label: 'أ', type: 'photos', maxCount: 2 }), F({ label: 'ب', type: 'photos', maxCount: 2 })],
      'kpi used twice': [F({ label: 'أ', type: 'select', options: ['1', '2'], kpi: 'mode' }), F({ label: 'ب', type: 'select', options: ['1', '2'], kpi: 'mode' })],
      'kpi wrong type': [F({ label: 'أ', type: 'number', kpi: 'mode' })],
      'one option': [F({ label: 'أ', type: 'select', options: ['1'] })],
      '21 options': [F({ label: 'أ', type: 'select', options: Array.from({ length: 21 }, (_, i) => 'خيار ' + i) })],
      'option too long': [F({ label: 'أ', type: 'select', options: ['1', 'خ'.repeat(41)] })],
      'help too long': [F({ label: 'أ', help: 'م'.repeat(141) })],
      'attendance no rows': [F({ label: 'أ', type: 'attendance', rows: [] })],
      'photos maxCount 11': [F({ label: 'أ', type: 'photos', maxCount: 11 })],
      'unknown type': [F({ label: 'أ', type: 'date' })],
      'not an array': 'x'
    };
    for (const [label, fields] of Object.entries(bad)) expectError(() => t.call('api_saveFields', token, fields), null, label);
    assert.deepEqual(t.call('api_bootstrap', token).fields, base, 'invalid saves change nothing');
    // unknown attendance rows are either refused or dropped — never stored
    let r = null;
    try { r = t.call('api_saveFields', token, [F({ label: 'أ', type: 'attendance', rows: ['students', 'parents'] })]); } catch (e) { assertUserMessage(e.message); }
    if (r) assert.deepEqual(r.fields[0].rows, ['students']);
  });
  it('assigns ids to new fields and preserves existing ones', () => {
    const t = sys();
    const { token } = t.ready();
    const base = t.fields;
    const r = t.call('api_saveFields', token, base.concat([F({ label: 'عدد الزوار', type: 'number', min: 0, max: 50 })]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.fields.slice(0, base.length).map((f) => f.id), base.map((f) => f.id));
    assert.match(r.fields[base.length].id, /^f_[A-Za-z0-9]{6}$/);
    assert.ok(!base.some((f) => f.id === r.fields[base.length].id));
    assert.equal(t.form(t.schools[0]).fields.length, base.length + 1, 'the school form shows the new field');
  });
  it('mirrors answers into dynamic columns (attendance expanded, numbers as numbers, photo URLs)', () => {
    const t = sys();
    const { schools } = t.ready();
    const p = t.upload(schools[0]).photo;
    t.submit(schools[0], { note: 'ملاحظة اليوم', photos: [p, t.upload(schools[0]).photo] });
    const h = headerRow(t);
    const dyn = ['نمط المتابعة', 'الطلاب - الحاضرون', 'الطلاب - الغائبون', 'المعلمون - الحاضرون', 'المعلمون - الغائبون',
      'الإداريون - الحاضرون', 'الإداريون - الغائبون', 'الحصص المخطط لها', 'الحصص المفعّلة', 'ملاحظة عامة', 'شواهد المتابعة'];
    assert.deepEqual(h.slice(13, 13 + dyn.length), dyn);
    const row = reportRows(t)[0];
    const col = (label) => row[h.indexOf(label)];
    assert.equal(col('نمط المتابعة'), 'حضوري');
    assert.equal(col('الطلاب - الحاضرون'), 380);
    assert.equal(col('الطلاب - الغائبون'), 20);
    assert.equal(col('الحصص المفعّلة'), 36);
    assert.equal(col('ملاحظة عامة'), 'ملاحظة اليوم');
    const urls = String(col('شواهد المتابعة')).split('\n');
    assert.equal(urls.length, 2);
    assert.ok(urls.every((u) => /^https:\/\/drive\.google\.com\//.test(u)));
    const answers = JSON.parse(row[12]);
    assert.ok(answers && typeof answers === 'object', 'answersJson is the source of truth');
    const map = JSON.parse(t.prop('fieldCols'));
    const att = t.fields.find((f) => f.type === 'attendance');
    assert.equal(map[att.id + '.students.present'], h.indexOf('الطلاب - الحاضرون') + 1);
  });
  it('rename updates the header, add appends a column, remove keeps the column', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.submit(schools[0], { note: 'أولى' });
    const fields = t.fields.map((f) => Object.assign({}, f));
    const note = fields.find((f) => f.type === 'textarea');
    note.label = 'ملاحظات اليوم';
    const saved = t.call('api_saveFields', token, fields.concat([F({ label: 'سؤال جديد' })])).fields;
    t.fields = saved;
    t.at('2026-10-14T08:00');
    const extra = saved.find((f) => f.label === 'سؤال جديد');
    const a = t.answers({ note: 'ثانية' }); a[extra.id] = 'إجابة';
    t.call('api_submitReport', schools[1].token, { answers: a, filledBy: 'أ. سعد' });
    let h = headerRow(t);
    assert.ok(h.includes('ملاحظات اليوم') && !h.includes('ملاحظة عامة'), 'renamed header: ' + h.join(' | '));
    assert.equal(h[h.length - 1], 'سؤال جديد', 'new column appended at the end');
    const width = h.length;
    t.call('api_saveFields', token, saved.filter((f) => f.label !== 'سؤال جديد'));
    t.submit(schools[2]);
    h = headerRow(t);
    assert.equal(h.length, width, 'removed field keeps its column');
    assert.ok(h.includes('سؤال جديد'));
  });
  it('extended preset grows the sheet beyond 26 columns safely; yes/no mirrored as نعم/لا', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.fields = t.call('api_applyPreset', token, 'extended').fields;
    t.submit(schools[0], { yesno: true });
    const h = headerRow(t);
    assert.ok(h.length >= 28, 'expected ≥ 28 columns, got ' + h.length);
    for (const label of ['عدد الطلاب المتأخرين', 'عدد الطلاب المستأذنين (خروج مبكر)', 'أسماء المعلمين الغائبين', 'هل توجد حالة طارئة اليوم؟']) assert.ok(h.includes(label), label);
    const row = reportRows(t)[0];
    assert.equal(row[h.indexOf('هل توجد حالة طارئة اليوم؟')], 'نعم');
    const r = t.day();
    assert.equal(r.totals.lateStudents, 3);
    assert.equal(t.row(r, schools[0].id).report.derived.lateStudents, 3);
  });
  it('very large field definitions never hit the raw 9 KB Properties limit', () => {
    const t = sys();
    const { token } = t.ready();
    const fields = Array.from({ length: 25 }, (_, i) => F({ label: 'سؤال اختيار رقم ' + (i + 1) + ' ' + 'ط'.repeat(50), type: 'select', help: 'م'.repeat(140), options: Array.from({ length: 20 }, (_, k) => 'خيار ' + k + ' ' + 'ع'.repeat(32)) }));
    let saved = null;
    try { saved = t.call('api_saveFields', token, fields); } catch (e) { assertUserMessage(e.message, 'large fields'); return; }
    assert.equal(saved.ok, true);
    assert.equal(t.call('api_bootstrap', token).fields.length, 25, 'fields readable after save');
  });
  it('field labels with formula characters are written to the header safely', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.fields = t.call('api_saveFields', token, t.fields.concat([F({ label: '=IMPORTXML("http://evil","//a")' }), F({ label: '+SUM(1,2)' })])).fields;
    t.submit(schools[0]);
    noFormulas(t.env);
  });
});

/* ================================================================== 15. settings */
describe('settings (api_getSettings / api_saveSettings)', () => {
  it('returns everything the settings page needs', () => {
    const t = sys();
    const { token } = t.ready();
    const s = t.call('api_getSettings', token);
    assert.deepEqual(s.presets.map((p) => p.key).sort(), ['basic', 'extended', 'standard']);
    assert.ok(s.presets.every((p) => ARABIC.test(p.label)));
    assert.match(s.messageTemplate, /\{المدرسة\}/); assert.match(s.messageTemplate, /\{الرابط\}/); assert.match(s.messageTemplate, /\{المشرف\}/);
    assert.match(s.returnTemplate, /\{الملاحظة\}/); assert.match(s.returnTemplate, /\{التاريخ\}/);
    assert.deepEqual(s.holidays, []);
    assert.equal(s.ownerEmail, OWNER);
    assert.match(s.spreadsheetUrl, /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
    assert.equal(s.generalLink, BASE_URL + '?f=all');
  });
  it('validates every setting', () => {
    const t = sys();
    const { token } = t.ready();
    const bad = [
      { systemTitle: 'م' }, { systemTitle: 'م'.repeat(61) },
      { schedule: { deadline: '25:00' } }, { schedule: { deadline: '9am' } },
      { schedule: { workdays: [] } }, { schedule: { workdays: [7] } }, { schedule: { workdays: ['x'] } },
      { review: { enabled: 'yes' } }, { links: { generalEnabled: 1 } },
      { alerts: { studentAbsencePct: 0 } }, { alerts: { teacherAbsencePct: 101 } }, { alerts: { activationPct: 50.5 } }, { alerts: { jumpPct: 5 } }, { alerts: { jumpPct: 501 } },
      { digest: { time: 'abc' } }, { holidays: ['2026-13-01'] }, { holidays: 'x' },
      { messageTemplate: 'م'.repeat(601) }, { returnTemplate: 'م'.repeat(601) }
    ];
    for (const s of bad) expectError(() => t.call('api_saveSettings', token, s), null, JSON.stringify(s).slice(0, 60));
  });
  it('partial updates keep the other values; holidays sorted and deduplicated', () => {
    const t = sys();
    const { token } = t.ready();
    assert.equal(t.call('api_saveSettings', token, { schedule: { deadline: '10:15' } }).ok, true);
    let s = t.call('api_getSettings', token);
    assert.equal(s.schedule.deadline, '10:15');
    assert.deepEqual(s.schedule.workdays, [0, 1, 2, 3, 4]);
    assert.equal(s.schedule.allowLate, true);
    t.call('api_saveSettings', token, { holidays: ['2026-10-20', '2026-10-15', '2026-10-15'], systemTitle: 'متابعة المدارس اليومية', supervisor: { name: 'سارة المشرفة', title: 'المشرفة التربوية' } });
    s = t.call('api_getSettings', token);
    assert.deepEqual(s.holidays, ['2026-10-15', '2026-10-20']);
    assert.equal(s.systemTitle, 'متابعة المدارس اليومية');
    assert.equal(s.supervisor.name, 'سارة المشرفة');
    assert.equal(s.schedule.deadline, '10:15');
    assert.equal(t.form(t.schools[0]).deadline, '10:15');
    assert.match(t.app.doGetOutput({}).title, /^متابعة المدارس اليومية — لوحة المشرف$/);
  });
  it('digest: one dailyDigest trigger at the chosen time in Asia/Riyadh; replaced on change; removed when disabled', () => {
    const t = sys();
    const { token } = t.ready();
    t.env.globals.ScriptApp.newTrigger('someOtherHandler').timeBased().everyHours(1).create();
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '10:00' } });
    let dig = t.env.triggers.filter((x) => x.handler === 'dailyDigest');
    assert.equal(dig.length, 1);
    assert.equal(dig[0].everyDays, 1); assert.equal(dig[0].atHour, 10); assert.equal(dig[0].nearMinute, 0); assert.equal(dig[0].timezone, 'Asia/Riyadh');
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '07:45' } });
    dig = t.env.triggers.filter((x) => x.handler === 'dailyDigest');
    assert.equal(dig.length, 1); assert.equal(dig[0].atHour, 7); assert.equal(dig[0].nearMinute, 45);
    t.call('api_saveSettings', token, { systemTitle: 'عنوان آخر للنظام' });
    assert.equal(t.env.triggers.filter((x) => x.handler === 'dailyDigest').length, 1, 'unrelated save keeps the trigger');
    t.call('api_saveSettings', token, { digest: { enabled: false } });
    assert.equal(t.env.triggers.filter((x) => x.handler === 'dailyDigest').length, 0);
    assert.equal(t.env.triggers.filter((x) => x.handler === 'someOtherHandler').length, 1, 'other triggers untouched');
  });
  it('settings changes are logged', () => {
    const t = sys();
    const { token } = t.ready();
    const n = t.sheet(SH.log).lastRow;
    t.call('api_saveSettings', token, { schedule: { deadline: '09:30' } });
    assert.ok(t.sheet(SH.log).lastRow > n);
  });
});

/* ================================================================== 16. daily digest */
describe('dailyDigest trigger', () => {
  it('emails an escaped RTL summary on workdays when enabled', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const evil = t.call('api_saveSchool', token, { name: '<img src=x onerror=alert(1)> مدرسة' }).school;
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '10:00' } });
    t.boot({});   // opening the dashboard from the deployment saves its URL (the digest never calls getUrl())
    t.submit(schools[0]);
    t.at('2026-10-14T10:00');
    const n = t.env.mailbox.length;
    t.app.runTrigger('dailyDigest');
    assert.equal(t.env.mailbox.length, n + 1);
    const m = t.env.mailbox[n];
    assert.equal(m.to, OWNER);
    assert.match(m.htmlBody, /dir=["']?rtl/i);
    assert.ok(m.htmlBody.includes(SCHOOLS[1].name), 'missing schools are listed');
    assert.ok(!m.htmlBody.includes('<img src=x'), 'school names are HTML-escaped');
    assert.ok(m.htmlBody.includes(BASE_URL), 'button-link to the dashboard');
    assert.ok(evil.id);
  });
  it('sends nothing on non-workdays, when disabled, or before setup', () => {
    let t = sys({ clock: '2026-10-16T10:00' });
    let r = t.ready();
    t.call('api_saveSettings', r.token, { digest: { enabled: true, time: '10:00' } });
    let n = t.env.mailbox.length;
    t.app.runTrigger('dailyDigest');
    assert.equal(t.env.mailbox.length, n, 'Friday');
    t = sys();
    r = t.ready();
    n = t.env.mailbox.length;
    t.app.runTrigger('dailyDigest');
    assert.equal(t.env.mailbox.length, n, 'disabled');
    t = sys();
    t.app.runTrigger('dailyDigest');
    assert.equal(t.env.mailbox.length, 0, 'not set up');
  });
});

/* ================================================================== 17. copy detection */
describe('copy detection («إنشاء نسخة»)', () => {
  it('a copy made by another account starts as a fresh, independent install', () => {
    const t = sys();
    const { token } = t.ready();
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '10:00' } });
    t.env.simulateCopy({ ownerEmail: 'new.owner@gmail.com', scriptUrl: 'https://script.google.com/macros/s/COPY/exec' });
    const boot = t.boot({});
    assert.equal(boot.status.setupDone, false);
    assert.equal(boot.status.ownerEmailMasked, 'ne••••••@gmail.com');
    expectAuth(() => t.call('api_bootstrap', token));
    assert.ok(!Object.keys(t.env.properties()).some((k) => k.startsWith('sess:')), 'old sessions wiped');
    t.clock.advance(61000);
    t.call('api_requestCode');
    assert.equal(t.env.mailbox[t.env.mailbox.length - 1].to, 'new.owner@gmail.com');
    const cfg = t.cfg();
    assert.equal(cfg.ownerEmail, 'new.owner@gmail.com');
    assert.equal(cfg.ssId, t.env.spreadsheet.getId());
  });
});

/* ================================================================== 18. menu & simple triggers */
describe('spreadsheet menu (onOpen / menu*)', () => {
  it('onOpen builds the menu and the «ابدأ هنا» sheet even with limited authorization', () => {
    const t = sys();
    t.app.onOpen({ authMode: 'LIMITED' });
    const menu = t.env.ui.menus.find((m) => m.caption === '📋 نبض المدارس');
    assert.ok(menu, 'menu created');
    const items = menu.items.map((i) => i.separator ? '---' : i.caption + '→' + i.fn);
    assert.deepEqual(items, ['🔗 رابط لوحة التحكم→menuShowLink', '📖 خطوات التشغيل→menuShowGuide', '---', '🧹 تصفير النظام…→menuReset']);
    t.app.onOpen({ authMode: 'FULL' });
    const start = t.sheet(SH.start);
    assert.ok(start, '«ابدأ هنا» exists');
    assert.equal(t.env.inspect.sheetNames()[0], SH.start, 'first tab');
    assert.equal(start.rtl, true);
    assert.equal(start.hiddenGridlines, true);
    assert.ok(start.values.flat().join(' ').includes('بياناتك محفوظة في هذا الملف وفي مجلد الشواهد داخل حسابك فقط'));
    // the owner set later from the web app still receives the OTP
    t.call('api_requestCode');
    assert.equal(t.env.mailbox[t.env.mailbox.length - 1].to, OWNER, 'onOpen in LIMITED mode must not store an empty owner email');
  });
  it('menuShowLink shows the dashboard link (or deployment help when not deployed)', () => {
    let t = sys();
    t.boot({});   // the saved deployment URL (captured when the dashboard is opened) — never getUrl() in a menu
    t.app.runMenu('menuShowLink');
    assert.ok(t.env.ui.dialogs.some((d) => d.html.includes(BASE_URL)));
    t = sys({ notDeployed: true });
    t.app.runMenu('menuShowLink');
    assert.ok(t.env.ui.dialogs.length === 1 && /نشر/.test(t.env.ui.dialogs[0].html));
    t.app.runMenu('menuShowGuide');
    assert.ok(t.env.ui.dialogs[1].html.includes('تطبيق ويب'));
  });
  it('menuReset wipes the system only after typing «تصفير»', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.submit(schools[0]);
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '10:00' } });
    t.app.runMenu('menuReset', { prompts: [{ text: 'لا', button: 'OK' }] });
    assert.equal(t.call('api_bootstrap', token).ok, true, 'wrong word → nothing deleted');
    t.app.runMenu('menuReset', { prompts: [{ text: 'تصفير', button: 'OK' }] });
    assert.deepEqual(Object.keys(t.env.properties()).filter((k) => k !== 'cfg' || JSON.parse(t.prop('cfg')).setupDone), [], 'properties deleted');
    assert.ok(t.sheet(SH.schools).lastRow <= 1 && t.sheet(SH.reports).lastRow <= 1, 'data rows cleared');
    assert.equal(t.env.triggers.length, 0, 'triggers deleted');
    assert.ok(t.env.toasts.length >= 1, 'toast shown');
    assert.equal(t.boot({}).status.setupDone, false);
  });
});

/* ================================================================== 19. security & storage invariants */
describe('storage invariants: formula injection & auto-conversion', () => {
  it('user text that looks like a formula is stored as text and round-trips unchanged', () => {
    const t = sys();
    const { token } = t.ready();
    const name = '=HYPERLINK("http://evil.example","انقر هنا")';
    const s = t.call('api_saveSchool', token, { name, principal: '+966 مدير', phone: '' }).school;
    t.call('api_bulkAddSchools', token, '=1+1 مدرسة\n@SUM(A1) مدرسة\n+مدرسة الشرطة');
    t.fieldsNow();
    const r = t.call('api_submitReport', s.token, { answers: t.answers({ note: '=cmd|" /C calc"!A0' }), filledBy: '-أحمد' }).receipt;
    t.call('api_review', token, '2026-10-14', s.id, 'return', '=1+1 يرجى التصحيح');
    t.call('api_saveSettings', token, { systemTitle: '=نظام المتابعة', messageTemplate: '=رسالة {الرابط}' });
    noFormulas(t.env);
    const listed = t.call('api_schools', token).schools;
    assert.equal(listed.find((x) => x.id === s.id).name, name, 'school name round-trips exactly');
    assert.equal(listed.find((x) => x.id === s.id).principal, '+966 مدير');
    assert.ok(listed.some((x) => x.name === '=1+1 مدرسة') && listed.some((x) => x.name === '@SUM(A1) مدرسة') && listed.some((x) => x.name === '+مدرسة الشرطة'));
    assert.equal(r.filledBy, '-أحمد');
    const f = t.form(s);
    assert.equal(f.school.name, name);
    assert.equal(f.existing.filledBy, '-أحمد');
    assert.equal(f.existing.reviewNote, '=1+1 يرجى التصحيح');
    assert.equal(t.row(t.day(), s.id).report.reviewNote, '=1+1 يرجى التصحيح');
  });
  it('after a full workflow no sheet cell was auto-converted into a Date', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    t.call('api_bulkAddSchools', token, 'مدرسة الأرقام,أ. سامي,0501112223,0,0,0');
    for (const d of ['2026-10-11', '2026-10-12']) { t.at(d + 'T08:00'); for (const s of schools) t.submit(s, { note: '2026-10-14' }); }
    t.call('api_review', token, '2026-10-12', schools[0].id, 'return', '09:00 تأخر');
    t.call('api_review', token, '2026-10-12', schools[1].id, 'approve', '');
    t.call('api_regeneratePin', token, schools[2].id);
    noDateCells(t.env);
    noFormulas(t.env);
    const rp = t.sheet(SH.reports);
    for (const row of rp.values.slice(1)) {
      assert.match(String(row[1]), /^\d{4}-\d{2}-\d{2}$/, 'date stored as yyyy-MM-dd text');
      assert.match(String(row[5]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'submittedAt stored as text');
    }
    const sc = t.sheet(SH.schools);
    for (let i = 1; i < sc.values.length; i++) {
      assert.equal(sc.types[i][10], 'string', 'pin is text');
      assert.equal(sc.types[i][9], 'string', 'token is text');
    }
  });
  it('API results never contain Dates (checked on every call) — sweep of read endpoints', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const p = t.upload(schools[0]).photo;
    t.submit(schools[0], { photos: [p] });
    for (const [fn, ...args] of [['api_bootstrap', token], ['api_day', token, '2026-10-14'], ['api_range', token, '2026-10-01', '2026-10-14'],
      ['api_schools', token], ['api_getSettings', token], ['api_report', token, '2026-10-14', schools[0].id]]) {
      const r = t.call(fn, ...args);
      assert.ok(r && typeof r === 'object', fn);
    }
    assert.ok(t.form(schools[0]).existing);
  });
});

/* ================================================================== 19. hardening: platform (scopes, URLs, permissions) */
const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEV_URL = 'https://script.google.com/macros/s/HEADDEPLOYMENTID/dev';
describe('OAuth scopes & permissions', () => {
  it('the manifest grants the full Drive scope whenever DriveApp is used (DriveApp ignores drive.file)', () => {
    const code = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
    if (/\bDriveApp\./.test(code)) assert.ok(manifest.oauthScopes.includes(DRIVE_FULL_SCOPE), 'oauthScopes must include ' + DRIVE_FULL_SCOPE);
    for (const sc of ['spreadsheets', 'script.send_mail', 'script.scriptapp', 'userinfo.email']) {
      assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/' + sc), sc);
    }
  });
  it('with only drive.file (the old manifest) photos fail with a clear permission message, not «خطأ غير متوقع»', () => {
    const t = sys();
    const { schools } = t.ready();
    const m = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
    t.env.setManifest({ oauthScopes: m.oauthScopes.map((x) => (x === DRIVE_FULL_SCOPE ? x + '.file' : x)) });
    const e = expectError(() => t.upload(schools[0]), /Google Drive/);
    assert.doesNotMatch(e.message, /غير متوقع/);
  });
  it('a skipped «send email» permission says how to grant it (no endless «try later» lock-out)', () => {
    const t = sys();
    t.env.revokeScope('script.send_mail');
    const e = expectError(() => t.call('api_requestCode'), /تحديد الكل/);
    assert.doesNotMatch(e.message, /بعد قليل/);
  });
  it('a skipped spreadsheets permission shows a permission page, not the generic error page', () => {
    const t = sys();
    t.ready();
    t.env.revokeScope('spreadsheets');
    const html = t.app.doGet({});
    assert.match(html, /تحديد الكل/);
    assert.doesNotMatch(html, /خطأ غير متوقع/);
  });
  it('the deploy steps ask to tick «تحديد الكل»; menu items re-request permissions that were skipped', () => {
    const t = sys();
    assert.match(t.app.evaluate('DEPLOY_STEPS_[4]'), /تحديد الكل/);
    assert.match(t.app.evaluate('DEPLOY_STEPS_[5]'), /exec/);
    t.env.revokeScope('drive');
    assert.throws(() => t.app.runMenu('menuShowGuide'), /Authorization is required/);
    t.env.grantScopes(null);
    t.app.runMenu('menuShowGuide');
    assert.ok(t.env.ui.dialogs.length === 1);
  });
});

describe('evidence photos: app folder only, folder history, full Drive', () => {
  it('a Drive file outside the app folder is never treated as a school photo (even with a school-like name)', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.upload(schools[0]);
    const stray = t.env.drive.DriveApp.createFile('2026-10-14_' + schools[0].id + '_zzzzzz.png', 'x', 'image/png');
    const id = stray.getId();
    expectError(() => t.submit(schools[0], { photos: [{ id: id, name: 'x', w: 1, h: 1, size: 1 }] }), /غير متاحة/);
    expectError(() => t.call('api_schoolPhoto', schools[0].token, id), /لم يُعثر/);
    expectError(() => t.call('api_photo', token, id), /لم يُعثر/);
    expectError(() => t.call('api_discardPhoto', schools[0].token, id));
    assert.equal(t.env.drive.file(id).trashed, false, 'a file outside the app folder is never trashed');
  });
  it('photos stay viewable after their trashed folder was replaced and then restored', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const first = t.upload(schools[0]).photo;
    t.submit(schools[0], { photos: [first] });
    const oldFolder = t.env.drive.file(first.id).parents[0];
    t.env.drive.trash(oldFolder);
    const second = t.upload(schools[1]).photo;
    assert.notEqual(t.env.drive.file(second.id).parents[0], oldFolder);
    t.env.drive.DriveApp.getFolderById(oldFolder).setTrashed(false);
    assert.match(t.call('api_photo', token, first.id).dataUrl, /^data:image\/png;base64,/);
    assert.match(t.call('api_photo', token, second.id).dataUrl, /^data:image\/png;base64,/);
    assert.ok(t.cfg().photosFolderIdsOld.includes(oldFolder));
  });
  it('a photo still used by a saved report is kept when discarded (found by a TextFinder, not a full-sheet read)', () => {
    const t = sys();
    const { schools } = t.ready();
    const p = t.upload(schools[0]).photo;
    t.submit(schools[0], { photos: [p] });
    for (const s of schools.slice(1)) t.submit(s);
    assert.equal(t.call('api_discardPhoto', schools[0].token, p.id).ok, true);
    assert.equal(t.env.drive.file(p.id).trashed, false);
    assert.ok((t.app.lastCall.ops['TextFinder.findAll'] || 0) >= 1, 'uses a TextFinder');
    const loose = t.upload(schools[0]).photo;
    assert.equal(t.call('api_discardPhoto', schools[0].token, loose.id).ok, true);
    assert.equal(t.env.drive.file(loose.id).trashed, true, 'an unused upload is trashed');
  });
  it('a full Drive gives a clear message; the dashboard reports Drive storage use', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.env.storageUsed = 14 * 1024 * 1024 * 1024;
    t.env.evictCache();   // the figure is cached for 6 h
    const st = t.call('api_bootstrap', token).storage;
    assert.equal(st.used, 14 * 1024 * 1024 * 1024);
    assert.equal(st.limit, 15 * 1024 * 1024 * 1024);
    t.env.driveFull = true;
    expectError(() => t.upload(schools[0]), /ممتلئة/);
  });
});

describe('web-app URL: links come from the saved deployment URL', () => {
  it('the validator accepts only deployment (/exec) URLs; query and hash are stripped', () => {
    const t = sys();
    const v = (u) => t.app.invoke('cleanWebAppUrl_', u);
    assert.equal(v(BASE_URL), BASE_URL);
    assert.equal(v(' ' + BASE_URL + '?s=abc#x '), BASE_URL);
    assert.equal(v('https://script.google.com/a/macros/school.edu.sa/s/AKfy-1_2/exec'), 'https://script.google.com/a/macros/school.edu.sa/s/AKfy-1_2/exec');
    for (const bad of [DEV_URL, 'https://evil.example.com/macros/s/AKfycbTEST/exec', 'http://script.google.com/macros/s/X/exec',
      'https://script.google.com/macros/s/X/exec/extra', '', null]) assert.equal(v(bad), '', String(bad));
    assert.equal(t.app.evaluate('WEBAPP_URL_RE_.test(' + JSON.stringify(BASE_URL + '?x=1') + ')'), false, 'the pattern itself refuses a query string');
  });
  it('opening the dashboard saves its /exec URL once; a /dev session keeps using it and is flagged', () => {
    const t = sys();
    const { token } = t.ready();
    assert.ok(!t.cfg().webAppUrl);
    t.boot({});
    assert.equal(t.cfg().webAppUrl, BASE_URL);
    t.env.setScriptUrl(DEV_URL);
    assert.equal(t.boot({}).status.devMode, true);
    const b = t.call('api_bootstrap', token);
    assert.equal(b.devMode, true);
    assert.equal(b.baseUrl, BASE_URL);
    const r = t.call('api_schools', token);
    assert.equal(r.devMode, true);
    assert.ok(r.schools.every((s) => s.link.startsWith(BASE_URL + '?s=')));
    assert.ok(!JSON.stringify(r).includes('HEADDEPLOYMENTID'), 'the /dev id never reaches a link');
  });
  it('without a saved URL a /dev URL gives no links at all — never a rewritten, dead /exec link', () => {
    const t = sys({ scriptUrl: DEV_URL });
    const { token } = t.ready();
    const boot = t.boot({});
    assert.equal(boot.status.deployed, false);
    assert.equal(boot.status.devMode, true);
    assert.ok(!t.cfg().webAppUrl, 'a /dev URL is never saved');
    const r = t.call('api_schools', token);
    assert.equal(r.baseUrl, null);
    assert.ok(r.schools.every((s) => s.link === null));
    assert.ok(!JSON.stringify(r).includes('/exec'));
  });
  it('the menu dialog and the digest use only the saved URL (getUrl() is unreliable there)', () => {
    const t = sys();
    const { token } = t.ready();
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '10:00' } });
    t.env.setScriptUrl('https://script.google.com/macros/s/UNRELATEDID/exec');   // what getUrl() may say in a menu / trigger
    t.app.runMenu('menuShowLink');
    let dlg = t.env.ui.dialogs[t.env.ui.dialogs.length - 1].html;
    assert.ok(!dlg.includes('UNRELATEDID'));
    assert.match(dlg, /غير محفوظ|نشر/);
    t.at('2026-10-14T10:00');
    t.app.runTrigger('dailyDigest');
    let mail = t.env.mailbox[t.env.mailbox.length - 1];
    assert.match(mail.subject, /ملخص اليوم/);
    assert.ok(!mail.htmlBody.includes('UNRELATEDID') && !mail.htmlBody.includes('فتح لوحة المتابعة'), 'no button without a saved URL');
    t.call('api_saveSettings', token, { webAppUrl: BASE_URL });
    t.app.runMenu('menuShowLink');
    dlg = t.env.ui.dialogs[t.env.ui.dialogs.length - 1].html;
    assert.ok(dlg.includes(BASE_URL) && !dlg.includes('UNRELATEDID'));
    t.at('2026-10-15T10:00');
    t.app.runTrigger('dailyDigest');
    mail = t.env.mailbox[t.env.mailbox.length - 1];
    assert.ok(mail.htmlBody.includes(BASE_URL) && !mail.htmlBody.includes('UNRELATEDID'));
  });
  it('settings and the wizard validate the URL with clear Arabic messages', () => {
    const t = sys();
    const token = t.login();
    expectError(() => t.call('api_completeSetup', token, { supervisor: { name: 'أحمد' }, webAppUrl: 'https://example.com/x' }), /رابط تطبيق الويب/);
    assert.equal(t.call('api_completeSetup', token, { supervisor: { name: 'أحمد' }, webAppUrl: BASE_URL + '?usp=sharing' }).ok, true);
    assert.equal(t.cfg().webAppUrl, BASE_URL);
    expectError(() => t.call('api_saveSettings', token, { webAppUrl: DEV_URL }), /التجريبية/);
    expectError(() => t.call('api_saveSettings', token, { webAppUrl: 'script.google.com/macros/s/X' }), /غير صحيح/);
    t.call('api_saveSettings', token, { webAppUrl: '' });
    assert.equal(t.cfg().webAppUrl, '');
    const st = t.call('api_getSettings', token);
    assert.equal(st.webAppUrl, '');
    assert.equal(st.detectedUrl, BASE_URL);
    assert.equal(st.baseUrl, BASE_URL, 'falls back to a live /exec URL');
  });
});

/* ================================================================== 20. hardening: hand-edited sheets */
describe('hand-edited sheets', () => {
  const sheetApi = (t, name) => t.env.spreadsheet.getSheetByName(name);
  it('a column inserted / deleted in «المدارس» (or a title row) never rewrites links, pins or «نشطة»', () => {
    const t = sys();
    const { token, schools } = t.ready();
    const edits = { 'insert column': (s) => s.insertColumnAfter(2), 'delete column': (s) => s.deleteColumn(3), 'title row': (s) => s.insertRowBefore(1) };
    for (const [label, edit] of Object.entries(edits)) {
      const snap = t.env.snapshot();
      edit(sheetApi(t, SH.schools));
      const before = JSON.stringify(t.sheet(SH.schools).values);
      const f = t.form(schools[0]);
      assert.equal(f.ok, false, label);
      assert.equal(f.error, 'النظام غير متاح مؤقتًا. تواصل مع المشرف.', label);
      assert.equal(t.boot({ s: schools[1].token }).form.error, 'النظام غير متاح مؤقتًا. تواصل مع المشرف.', label);
      assert.equal(t.boot({ f: 'all' }).picker.ok, false, label);
      expectError(() => t.call('api_resolveSchool', schools[0].id, schools[0].pin), /غير متاح مؤقتًا/, label);
      expectError(() => t.call('api_schools', token), /تم تعديل أعمدة الورقة «المدارس»/, label);
      expectError(() => t.call('api_saveSchool', token, { name: 'مدرسة أخرى' }), /«المدارس»/, label);
      assert.equal(JSON.stringify(t.sheet(SH.schools).values), before, label + ': nothing was written');
      t.env.restore(snap);
    }
    assert.equal(t.form(schools[0]).ok, true);
    assert.deepEqual(t.call('api_schools', token).schools.map((s) => s.token).sort(), schools.map((s) => s.token).sort());
  });
  it('hand-typed rows still get an id, link and pin (logged); an unknown «نشطة» value is not read as inactive', () => {
    const t = sys();
    const { token } = t.ready();
    const sh = sheetApi(t, SH.schools);
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 2).setValue('مدرسة مكتوبة يدويًا');
    sh.getRange(2, 12).setValue('مفعّلة');
    const list = t.call('api_schools', token).schools;
    const typed = list.find((x) => x.name === 'مدرسة مكتوبة يدويًا');
    assert.ok(typed && /^[A-Za-z0-9]{20}$/.test(typed.token) && /^\d{4}$/.test(typed.pin) && typed.active);
    assert.ok(list.every((x) => x.active), 'an unknown «نشطة» value keeps the school active');
    assert.ok(t.sheet(SH.log).values.some((r) => /إكمال بيانات صفوف المدارس/.test(r[1])), 'the repair is logged');
  });
  it('a column inserted inside the fixed columns of «التقارير» stops reads and writes with a clear message', () => {
    const t = sys();
    const { token, schools } = t.ready();
    t.submit(schools[0]);
    const snapRows = JSON.stringify(reportRows(t));
    sheetApi(t, SH.reports).insertColumnAfter(4);
    expectError(() => t.call('api_day', token), /«التقارير»/);
    expectError(() => t.call('api_review', token, '2026-10-14', schools[0].id, 'approve', ''), /«التقارير»/);
    expectError(() => t.submit(schools[1]), /غير متاح مؤقتًا/);
    sheetApi(t, SH.reports).deleteColumn(5);
    assert.equal(JSON.stringify(reportRows(t)), snapRows, 'nothing was written while the layout was wrong');
    assert.equal(t.row(t.day(), schools[0].id).report.status, 'pending');
  });
  it('a column inserted among the readable columns: later reports still land under the right headings', () => {
    const t = sys();
    const { schools } = t.ready();
    t.submit(schools[0], { att: { students: { present: 380, absent: 20 } } });
    const sh = sheetApi(t, SH.reports);
    const hdr0 = headerRow(t);
    const presentCol = hdr0.indexOf('الطلاب - الحاضرون') + 1;
    sh.insertColumnBefore(presentCol);
    sh.getRange(1, presentCol).setValue('تعليق المشرف');
    sh.getRange(2, presentCol).setValue('ملاحظتي');
    t.submit(schools[1], { att: { students: { present: 290, absent: 10 } } });
    const hdr = headerRow(t), rows = reportRows(t);
    const rowB = rows.find((r) => r[2] === schools[1].id), rowA = rows.find((r) => r[2] === schools[0].id);
    assert.equal(rowB[hdr.indexOf('الطلاب - الحاضرون')], 290);
    assert.equal(rowB[hdr.indexOf('الطلاب - الغائبون')], 10);
    assert.equal(rowB[hdr.indexOf('تعليق المشرف')], '', 'the supervisor column is never overwritten');
    assert.equal(rowA[hdr.indexOf('تعليق المشرف')], 'ملاحظتي');
    assert.equal(hdr.filter((h) => h === 'الطلاب - الحاضرون').length, 1, 'no duplicate columns');
  });
  it('deleting a readable column when the sheet has no spare columns does not break submissions', () => {
    const t = sys();
    const { token, schools } = t.ready({ setup: { preset: 'extended' } });
    const sh = sheetApi(t, SH.reports);
    assert.equal(sh.getMaxColumns(), sh.getLastColumn(), 'precondition: no spare columns');
    const del = headerRow(t).indexOf('ملاحظة عامة') + 1;
    sh.deleteColumn(del);
    assert.equal(t.submit(schools[0], { note: 'نص' }).ok, true);
    assert.equal(t.submit(schools[1]).ok, true);
    assert.equal(t.call('api_saveFields', token, t.fieldsNow()).ok, true);
    assert.equal(t.submit(schools[2]).ok, true);
    const hdr = headerRow(t), rows = reportRows(t);
    assert.equal(hdr.filter((h) => h === 'ملاحظة عامة').length, 1, 'the deleted column was added back once');
    assert.equal(rows.find((r) => r[2] === schools[0].id)[hdr.indexOf('ملاحظة عامة')], 'نص');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r[8] === 'لا' && Number(r[9]) === 0), 'no half-saved retries (edits stay 0)');
  });
  it('a renamed data sheet is renamed back instead of being replaced by an empty one', () => {
    const t = sys();
    const { token, schools } = t.ready();
    sheetApi(t, SH.schools).setName('المدارس 1447');
    sheetApi(t, SH.reports).setName('التقارير القديمة');
    assert.equal(t.form(schools[0]).ok, true, 'school links keep working');
    const names = t.env.inspect.sheetNames();
    assert.ok(names.includes(SH.schools) && names.includes(SH.reports));
    assert.ok(!names.includes('المدارس 1447') && !names.includes('التقارير القديمة'));
    assert.equal(t.call('api_schools', token).schools.length, 3);
    assert.ok(t.sheet(SH.log).values.some((r) => /استعادة اسم ورقة/.test(r[1])));
  });
});

/* ================================================================== 21. hardening: dashboard & statistics logic */
describe('dashboard and statistics logic', () => {
  it('schools added after the deadline are first due the next day (no false missing / streak alerts)', () => {
    const t = sys({ clock: '2026-10-14T20:00' });
    const { token, schools } = t.ready();
    assert.equal(t.day('2026-10-14').rows.length, 0, 'setup evening: nobody is expected yet');
    t.at('2026-10-15T09:30');
    t.submit(schools[0]);
    const d = t.day();
    assert.ok(!d.alerts.some((a) => a.type === 'missing_streak'));
    assert.equal(d.totals.missing, 2);
    const r = t.call('api_range', token, '2026-10-14', '2026-10-15');
    assert.equal(r.days.find((x) => x.date === '2026-10-14').expected, 0);
    const a = r.schools.find((s) => s.id === schools[0].id);
    assert.deepEqual([a.onTimeDays, a.expectedDays, a.compliancePct], [1, 1, 100]);
    t.at('2026-10-15T13:00');
    const late = t.call('api_saveSchool', token, { name: 'مدرسة أُضيفت ظهرًا' }).school;
    assert.ok(!t.day().rows.some((x) => x.school.id === late.id), 'not expected on the day it was added after the deadline');
    assert.equal(t.submit(late).receipt.late, true, 'a report sent after the deadline is still late');
  });
  it('range statistics count today only after the deadline (or once a school reported)', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    for (const d of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) { t.at(d + 'T07:30'); for (const s of schools) t.submit(s); }
    t.at('2026-10-15T07:15');
    let r = t.call('api_range', token, '2026-10-11', '2026-10-15');
    let today = r.days.find((x) => x.date === '2026-10-15');
    assert.equal(r.totals.compliancePct, 100);
    assert.equal(today.expected, 0); assert.equal(today.compliancePct, null);
    assert.ok(r.schools.every((s) => s.compliancePct === 100 && s.expectedDays === 4));
    assert.equal(r.workdays, 5, 'today is still a workday of the range');
    t.submit(schools[0]);
    r = t.call('api_range', token, '2026-10-11', '2026-10-15');
    today = r.days.find((x) => x.date === '2026-10-15');
    assert.deepEqual([today.onTime, today.expected, today.compliancePct], [1, 1, 100]);
    t.at('2026-10-15T09:30');
    r = t.call('api_range', token, '2026-10-11', '2026-10-15');
    today = r.days.find((x) => x.date === '2026-10-15');
    assert.deepEqual([today.onTime, today.expected], [1, 3]);
    assert.equal(r.totals.compliancePct, 86.7);
    const only = sys({ clock: '2026-10-11T07:30' });
    const o = only.ready();
    const r2 = only.call('api_range', o.token, '2026-10-11', '2026-10-11');
    assert.equal(r2.totals.compliancePct, null);
    assert.equal(r2.days[0].expected, 0);
  });
  it('«X من Y» never shows X > Y: onTime counts exclude off-day and inactive-school reports', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    const [A, B, C] = schools;
    for (const d of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']) { t.at(d + 'T07:30'); for (const s of schools) t.submit(s); }
    t.at('2026-10-16T10:00');
    t.submit(A);
    t.call('api_setSchoolActive', token, C.id, false);
    t.at('2026-10-18T10:00');
    const r = t.call('api_range', token, '2026-10-11', '2026-10-16');
    for (const d of r.days) assert.ok(d.onTime <= d.expected, d.date + ': ' + d.onTime + ' of ' + d.expected);
    const sa = r.schools.find((s) => s.id === A.id), sc = r.schools.find((s) => s.id === C.id);
    assert.deepEqual([sa.onTimeDays, sa.expectedDays, sa.extraDays, sa.submittedDays], [5, 5, 1, 6]);
    assert.deepEqual([sc.onTimeDays, sc.expectedDays, sc.extraDays], [0, 0, 5]);
    assert.ok(r.schools.every((s) => s.onTimeDays <= s.expectedDays));
    assert.equal(r.schools.find((s) => s.id === B.id).compliancePct, 100);
  });
  it('the deadline applies only on workdays (holiday / weekend after it, late submissions off)', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    t.call('api_saveSettings', token, { schedule: { allowLate: false }, holidays: ['2026-10-15'] });
    t.at('2026-10-15T10:00');
    const f = t.form(schools[0]);
    assert.deepEqual([f.state, f.canEdit, f.isHoliday, f.allowLate], ['open', true, true, false]);
    assert.equal(t.submit(schools[0]).receipt.late, false);
    t.at('2026-10-16T10:00');
    assert.equal(t.form(schools[1]).state, 'open');
    assert.equal(t.submit(schools[1]).receipt.late, false);
    assert.equal(t.day('2026-10-15').totals.late, 0);
    t.at('2026-10-18T10:00');
    assert.equal(t.form(schools[2]).state, 'closed', 'a workday after the deadline stays closed');
  });
  it('the form tells the page whether late submissions are allowed', () => {
    const t = sys();
    const { token, schools } = t.ready();
    assert.equal(t.form(schools[0]).allowLate, true);
    assert.equal(t.form('__preview').allowLate, true);
    t.call('api_saveSettings', token, { schedule: { allowLate: false } });
    assert.equal(t.form(schools[0]).allowLate, false);
  });
  it('reports returned on earlier days stay visible (returnedOther), separate from pendingOther', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    t.submit(schools[0]); t.submit(schools[1]);
    t.call('api_review', token, '2026-10-11', schools[0].id, 'return', 'أكمل البيانات');
    t.at('2026-10-14T08:00');
    const d = t.day();
    assert.deepEqual(d.returnedOther.map((x) => [x.date, x.schoolId, x.schoolName]), [['2026-10-11', schools[0].id, SCHOOLS[0].name]]);
    assert.ok(!d.pendingOther.some((x) => x.schoolId === schools[0].id));
    assert.ok(d.pendingOther.some((x) => x.schoolId === schools[1].id));
  });
  it('the day says whether a school without a report can still send it (today, late window, closed)', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token } = t.ready();
    t.at('2026-10-14T10:00');
    let d = t.day();
    assert.deepEqual([d.today, d.canSubmit, d.allowLate], ['2026-10-14', true, true]);
    assert.equal(t.day('2026-10-13').canSubmit, true);
    assert.equal(t.day('2026-10-12').canSubmit, true);
    assert.equal(t.day('2026-10-11').canSubmit, false, 'outside the 2-workday window');
    t.call('api_saveSettings', token, { schedule: { allowLate: false, backfillDays: 0 } });
    d = t.day();
    assert.deepEqual([d.canSubmit, d.allowLate], [false, false]);
    assert.equal(t.day('2026-10-13').canSubmit, false);
    assert.equal(t.day('2026-10-13').today, '2026-10-14', 'a past day carries the server\'s today (rollover)');
  });
  it('deleting and re-adding attendance / lessons questions keeps past metrics; mirror columns are reused', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    t.at('2026-10-12T07:30');
    t.submit(schools[0], { att: { students: { present: 90, absent: 10 } }, planned: 40, done: 36 });
    t.at('2026-10-13T07:30');
    const f0 = t.fieldsNow();
    t.call('api_saveFields', token, f0.filter((f) => f.type !== 'attendance' && f.kpi !== 'lessons_planned'));
    t.at('2026-10-14T07:30');
    const f1 = t.fieldsNow();
    const att = { label: 'الحضور والغياب', type: 'attendance', required: true, rows: ['students', 'teachers', 'staff'] };
    const planned = { label: 'الحصص المخطط لها', type: 'number', required: true, kpi: 'lessons_planned', min: 0 };
    const saved = t.call('api_saveFields', token, [f1[0], att, planned].concat(f1.slice(1))).fields;
    assert.ok(!saved.some((f) => f.id === 'f_atten1' || f.id === 'f_lplan1'), 'new ids');
    t.fields = saved;
    const rep = t.row(t.day('2026-10-12'), schools[0].id).report;
    assert.equal(rep.derived.attendance.students.absencePct, 10);
    assert.equal(rep.derived.lessons.activationPct, 90);
    const r = t.call('api_range', token, '2026-10-12', '2026-10-12');
    assert.equal(r.days[0].studentAbsencePct, 10);
    assert.equal(r.days[0].activationPct, 90);
    t.submit(schools[1], { att: { students: { present: 50, absent: 50 } }, planned: 10, done: 5 });
    const today = t.row(t.day(), schools[1].id).report.derived;
    assert.equal(today.attendance.students.absencePct, 50);
    assert.equal(today.lessons.activationPct, 50);
    const hdr = headerRow(t);
    assert.equal(hdr.filter((h) => h === 'الطلاب - الحاضرون').length, 1, 're-added questions write under their old columns');
    assert.equal(hdr.filter((h) => h === 'الحصص المخطط لها').length, 1);
  });
});

describe('bulk paste from Excel', () => {
  it('a serial «م» column or a ministry-number column is skipped, not taken as the school name', () => {
    const t = sys();
    const text = 'م\tاسم المدرسة\tالمدير\tالجوال\n' + Array.from({ length: 12 }, (_, i) =>
      (i + 1) + '\tمدرسة رقم ' + (i + 1) + '\tأ. مدير ' + (i + 1) + '\t05000000' + String(i + 1).padStart(2, '0')).join('\n');
    const parse = (x) => JSON.parse(JSON.stringify(t.app.invoke('parseBulkSchools_', x, [])));   // plain objects of this realm
    const r = parse(text);
    assert.equal(r.items.length, 12);
    assert.deepEqual([r.items[0].name, r.items[0].principal, r.items[0].phone], ['مدرسة رقم 1', 'أ. مدير 1', '0500000001']);
    assert.deepEqual(r.items.map((x) => x.name).slice(9), ['مدرسة رقم 10', 'مدرسة رقم 11', 'مدرسة رقم 12']);
    assert.deepEqual(r.skipped, [{ line: 1, reason: 'سطر عناوين' }]);
    const m = parse('1234567\tمدرسة النور\tأ. خالد\n٧٦٥٤٣٢١,متوسطة الفجر');
    assert.deepEqual(m.items.map((x) => [x.name, x.principal]), [['مدرسة النور', 'أ. خالد'], ['متوسطة الفجر', '']]);
    const plain = parse('1- مدرسة الأمل\n2) مدرسة الهدى، أ. سعد');
    assert.deepEqual(plain.items.map((x) => x.name), ['مدرسة الأمل', 'مدرسة الهدى']);
  });
});

describe('dailyDigest hardening', () => {
  it('an anonymous google.script.run call sends nothing and never suppresses the real trigger run', () => {
    const t = sys();
    const { token } = t.ready();
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '10:00' } });
    t.at('2026-10-14T06:05');
    const n = t.env.mailbox.length;
    t.call('dailyDigest');
    t.call('dailyDigest', { triggerUid: '123' });
    assert.equal(t.env.mailbox.length, n, 'no mail from an anonymous / forged call');
    t.at('2026-10-14T10:00');
    t.app.runTrigger('dailyDigest');
    assert.equal(t.env.mailbox.length, n + 1, 'the real run still sends');
    t.app.runTrigger('dailyDigest');
    assert.equal(t.env.mailbox.length, n + 1, 'once per day');
  });
  it('a digest that fires before the deadline (nearMinute ±15) says so', () => {
    const t = sys();
    const { token } = t.ready();
    t.call('api_saveSettings', token, { digest: { enabled: true, time: '09:05' } });
    t.at('2026-10-14T08:52');
    t.app.runTrigger('dailyDigest');
    const m = t.env.mailbox[t.env.mailbox.length - 1];
    assert.match(m.htmlBody, /لم يحن بعد/);
    assert.match(m.body, /قبل الموعد النهائي/);
  });
});

/* ================================================================== 22. Part B */
describe('single-file bundle (NABD_EMBEDDED_FILES_)', () => {
  it('doGet renders identically from embedded HTML when no .html files exist', () => {
    const files = {};
    for (const n of ['Admin', 'School', 'Styles', 'Common']) files[n] = fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
    const bundled = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8') + '\nvar NABD_EMBEDDED_FILES_ = ' + JSON.stringify(files) + ';\n';
    const make = (embedded) => {
      const env = GasMock.createGasEnv({ ownerEmail: OWNER, scriptUrl: BASE_URL, clock: '2026-10-14T07:30', seed: 7 });
      const app = loadApp({ srcDir: SRC, env, code: embedded ? bundled : undefined });
      if (embedded) env.setFiles(() => null);   // nothing on "disk": every page must come from the bundle
      return app;
    };
    const plain = make(false), bundle = make(true);
    for (const params of [{}, { f: 'all' }, { s: '__preview' }]) {
      const a = plain.doGetOutput(params), b = bundle.doGetOutput(params);
      assert.equal(b.html, a.html, JSON.stringify(params));
      assert.equal(b.title, a.title);
      assert.ok(!b.html.includes('<?') && b.html.includes('window.BOOT'), 'scriptlets were evaluated');
    }
    assert.match(bundle.call('include', 'Styles'), /<style/);
  });
});

describe('spreadsheet resolution (bound, stored id, standalone)', () => {
  it('a standalone install with nothing stored creates «نبض المدارس — البيانات» once and keeps using it', () => {
    const t = sys();
    t.env.activeSpreadsheetAvailable = false;
    const before = t.env.spreadsheet.getId();
    assert.equal(t.boot({}).status.setupDone, false);
    const id = t.env.spreadsheet.getId();
    assert.notEqual(id, before);
    assert.equal(t.env.spreadsheet.getName(), 'نبض المدارس — البيانات');
    assert.equal(t.cfg().ssId, id);
    for (const n of [SH.schools, SH.reports, SH.log]) assert.ok(t.env.inspect.sheetNames().includes(n), n);
    const { schools } = t.ready();
    assert.equal(t.env.spreadsheet.getId(), id, 'no second spreadsheet');
    assert.equal(t.sheet(SH.schools).values.length, 4);
    assert.equal(t.form(schools[0]).ok, true);
  });
  it('a copied standalone script (properties came along, another owner) starts fresh instead of using the original data', () => {
    const t = sys();
    t.env.activeSpreadsheetAvailable = false;
    t.ready();
    const oldId = t.cfg().ssId;
    t.env.setOwnerEmail('other.supervisor@gmail.com');
    const boot = t.boot({});
    assert.equal(boot.status.setupDone, false);
    assert.equal(boot.status.ownerEmailMasked, 'ot••••••@gmail.com');
    assert.notEqual(t.cfg().ssId, oldId);
    assert.equal(t.cfg().ownerEmail, 'other.supervisor@gmail.com');
    assert.equal(t.sheet(SH.schools).values.length, 1, 'the new data file has no schools');
  });
  it('a bound spreadsheet is never reset by an editor using the menu', () => {
    const t = sys();
    t.ready();
    t.env.setOwnerEmail('editor@gmail.com');
    t.app.runMenu('menuShowLink');
    t.env.setOwnerEmail(OWNER);
    assert.equal(t.boot({}).status.setupDone, true);
  });
});

describe('late reports for missed days (schedule.backfillDays)', () => {
  it('a school can send a missed workday inside the window; it is marked late and shows on that day', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    const [A, B] = schools;
    t.at('2026-10-12T08:00');
    t.submit(B);
    t.at('2026-10-14T08:00');
    assert.deepEqual(t.form(A).missingDays, ['2026-10-13', '2026-10-12']);
    assert.deepEqual(t.form(B).missingDays, ['2026-10-13']);
    const f = t.form(A, '2026-10-13');
    assert.deepEqual([f.ok, f.state, f.date, f.existing, f.canEdit], [true, 'backfill', '2026-10-13', null, true]);
    const r = t.submit(A, { date: '2026-10-13' });
    assert.deepEqual([r.receipt.date, r.receipt.late], ['2026-10-13', true]);
    assert.deepEqual(t.form(A).missingDays, ['2026-10-12']);
    expectError(() => t.submit(A, { date: '2026-10-13' }), /لا يمكن فتح تقرير هذا اليوم/, 'no edits of a past report');
    expectError(() => t.submit(A, { date: '2026-10-11' }), /لا يمكن فتح تقرير هذا اليوم/, 'outside the window');
    assert.equal(t.form(A, '2026-10-11').code, 'NOT_EDITABLE');
    expectError(() => t.submit(A, { date: '2026-10-15' }), /لا يمكن فتح تقرير هذا اليوم/, 'future');
    const d = t.day('2026-10-13');
    assert.ok(t.row(d, A.id).report.late);
    assert.ok(t.row(d, A.id).flags.includes('late'));
    assert.equal(t.day().rows.find((x) => x.school.id === A.id).report, null, 'today is untouched');
  });
  it('the window skips off days, respects 0 (off) and the day a school was added', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { token, schools } = t.ready();
    t.call('api_saveSettings', token, { holidays: ['2026-10-13'] });
    t.at('2026-10-14T08:00');
    assert.deepEqual(t.form(schools[0]).missingDays, ['2026-10-12', '2026-10-11']);
    t.at('2026-10-18T08:00');
    assert.deepEqual(t.form(schools[0]).missingDays, ['2026-10-15', '2026-10-14'], 'Friday/Saturday skipped');
    t.call('api_saveSettings', token, { schedule: { backfillDays: 0 } });
    assert.deepEqual(t.form(schools[0]).missingDays, []);
    expectError(() => t.submit(schools[0], { date: '2026-10-15' }), /لا يمكن فتح تقرير هذا اليوم/);
    t.call('api_saveSettings', token, { schedule: { backfillDays: 7 } });
    const fresh = t.call('api_saveSchool', token, { name: 'مدرسة جديدة' }).school;
    assert.deepEqual(t.form(fresh).missingDays, [], 'nothing is owed before a school was added');
    expectError(() => t.call('api_saveSettings', token, { schedule: { backfillDays: 8 } }), /من 0 إلى 7/);
    expectError(() => t.call('api_saveSettings', token, { schedule: { backfillDays: -1 } }), /من 0 إلى 7/);
    assert.equal(t.call('api_getSettings', token).schedule.backfillDays, 7);
  });
  it('a deleted past report can be sent again inside the window', () => {
    const t = sys({ clock: '2026-10-13T08:00' });
    const { token, schools } = t.ready();
    t.submit(schools[0]);
    t.at('2026-10-14T08:00');
    t.call('api_deleteReport', token, '2026-10-13', schools[0].id);
    assert.ok(t.form(schools[0]).missingDays.includes('2026-10-13'));
    assert.equal(t.submit(schools[0], { date: '2026-10-13' }).receipt.late, true);
  });
  it('doGet ?s=…&d=… opens that day when allowed, otherwise today', () => {
    const t = sys({ clock: '2026-10-11T07:00' });
    const { schools } = t.ready();
    t.at('2026-10-14T08:00');
    assert.equal(t.boot({ s: schools[0].token, d: '2026-10-13' }).form.state, 'backfill');
    const f = t.boot({ s: schools[0].token, d: '2026-10-01' }).form;
    assert.deepEqual([f.ok, f.date, f.state], [true, '2026-10-14', 'open']);
  });
});

describe('phone numbers are stored as digits only', () => {
  it('no apostrophe-prefixed phone in the sheet; legacy "+" rows read back as digits', () => {
    const t = sys();
    const { token } = t.ready();
    const s = t.call('api_saveSchool', token, { name: 'مدرسة دولية', phone: '+966 55 111 2233' }).school;
    assert.equal(s.phone, '966551112233');
    const sc = t.sheet(SH.schools);
    const row = sc.values.find((r) => r[0] === s.id);
    assert.equal(row[5], '966551112233');
    assert.ok(t.env.inspect.allCells().every((c) => !/^'/.test(String(c.value))), 'no apostrophe-prefixed cell');
    const sh = t.env.spreadsheet.getSheetByName(SH.schools);
    sh.getRange(sc.values.indexOf(row) + 1, 6).setValue("'+966551112244");
    assert.equal(t.call('api_schools', token).schools.find((x) => x.id === s.id).phone, '966551112244');
    const bulk = t.call('api_bulkAddSchools', token, 'مدرسة الواحة، أ. سالم، +966 50 000 0001');
    assert.equal(bulk.added, 1);
    assert.equal(t.call('api_schools', token).schools.find((x) => x.name === 'مدرسة الواحة').phone, '966500000001');
    t.call('api_saveSettings', token, { supervisor: { phone: '+966 50 999 0000' } });
    assert.equal(t.call('api_getSettings', token).supervisor.phone, '966509990000');
  });
});

describe('[security] pages load no third-party script; QR codes are drawn inline', () => {
  const pages = ['Admin', 'School', 'Common', 'Styles'].map((n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8'));
  it('no page loads a script from another origin (the supervisor session lives in this origin)', () => {
    for (const html of pages) {
      assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=/i, 'no <script src>');
      assert.doesNotMatch(html, /createElement\(\s*['"]script['"]\s*\)/, 'no injected <script>');
      assert.doesNotMatch(html, /https?:\/\/(?:cdnjs\.|cdn\.jsdelivr\.|unpkg\.)/i, 'no CDN script');
    }
  });
  it('the inline QR encoder (Admin.html) produces codes an independent reader decodes, for every size the links need', () => {
    const { qrDecode, svgToMatrix } = require('./qr-decode.js');
    const admin = pages[0];
    const at = admin.indexOf('/* <qr>'), end = admin.indexOf('/* </qr> */');
    assert.ok(at > 0 && end > at, 'the QR block is marked');
    const ctx = vm.createContext({});
    vm.runInContext(admin.slice(at, end) + '\nthis.QR = QR;', ctx);
    const QR = ctx.QR;
    const links = [BASE_URL + '?f=all', BASE_URL + '?s=Abcdefghij0123456789',
      'https://script.google.com/a/macros/schools.example.edu.sa/s/AKfycbz' + 'x'.repeat(60) + '/exec?s=g' + 'f'.repeat(32), 'نبض المدارس ✓ 📋'];
    for (let n = 1; n <= 2331; n += n < 160 ? 1 : 37) links.push(Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 31 + n) % 94))).join(''));
    const versions = new Set();
    for (const text of links) {
      const svg = QR.svg(text);
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" shape-rendering="crispEdges"><rect [^<>]*\/><path fill="#000" d="[Mhvz0-9 -]*"\/><\/svg>$/,
        'numbers only — the encoded text never reaches the markup');
      const d = qrDecode(svgToMatrix(svg));
      assert.equal(d.text, text);
      versions.add(d.version);
    }
    assert.equal(versions.size, 40, 'versions 1–40');
    const m = QR.matrix(BASE_URL + '?f=all');
    m[m.length - 1][m.length - 3] = !m[m.length - 1][m.length - 3];
    assert.throws(() => qrDecode(m), /syndrome/, 'sanity: the reader rejects a damaged code');
    assert.throws(() => QR.matrix('x'.repeat(2332)), /too long/);
  });
});
