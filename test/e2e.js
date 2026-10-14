/*
 * e2e.js — Playwright end-to-end scenarios for «نبض المدارس» (spec §10), run with node:test.
 *
 *   npm run test:e2e
 *   NODE_PATH=/opt/node-tools/node_modules node --test --test-name-pattern="general link" test/e2e.js
 *   E2E_HEADED=1 E2E_SLOWMO=200 …           (watch it)
 *   E2E_SHOTS=0 …                           (skip writing docs/screenshots)
 *
 * The UI is driven through visible Arabic text, roles and the class vocabulary of spec §7.1.
 * EVERY selector and UI string lives in the UI / T objects right below — adapt them there only.
 * Each scenario starts from a fresh server state (POST /__reset), seeds what it needs through the
 * test API (fast) and then exercises the real pages in Chromium. A scenario fails on any page error,
 * console error, unexpected native dialog, or request to an unexpected external host.
 */
'use strict';
process.env.TZ = process.env.NABD_TEST_TZ || 'America/Los_Angeles';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright-core');
const { startServer } = require('./server.js');

const SRC = path.resolve(process.env.NABD_SRC || path.join(__dirname, '..', 'src'));
const SHOTS_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const WRITE_SHOTS = process.env.E2E_SHOTS !== '0';
const CLOCK0 = '2026-10-14T07:30';          // Wednesday, before the 09:00 deadline (Asia/Riyadh wall time)
const OWNER = 'supervisor@gmail.com';
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 };
const STEP_TIMEOUT = Number(process.env.E2E_TIMEOUT || 10000);

/* =====================================================================================
 * UI strings (spec §7.3 / §7.4) — adjust here if the pages word things differently
 * =================================================================================== */
const T = {
  // admin: wizard + login
  startSetup: 'ابدأ التجهيز',
  sendCode: /^أرسل الرمز$|^إرسال الرمز$/,
  loginTitle: 'دخول المشرف',
  loginSend: /أرسل رمز الدخول/,
  next: /^(التالي|متابعة|حفظ ومتابعة|التالي ←|← التالي)$/,
  skip: /^(تخطي|تخطٍّ|لاحقًا)$/,
  goDashboard: 'انتقل إلى لوحة التحكم',
  supervisorName: /^(الاسم|اسمك|اسم المشرف|الاسم الكامل)/,
  schoolsPlaceholder: /اسم كل مدرسة في سطر/,
  // admin: navigation
  nav: { today: 'اليوم', schools: 'المدارس', stats: 'الإحصاءات', form: 'النموذج', settings: 'الإعدادات' },
  // admin: today
  kpiSubmission: 'التسليم', kpiPending: 'بانتظار المراجعة', kpiStudents: 'غياب الطلاب', kpiTeachers: 'غياب المعلمين', kpiLessons: 'تفعيل الحصص',
  approveAll: 'اعتماد الكل',
  approve: /^(✓ )?اعتماد$/,
  returnForCorrection: /إعادة للتصحيح/,
  reopen: /إلغاء الاعتماد/,
  printDay: /طباعة تقرير اليوم/,
  printReport: /طباعة التقرير/,
  pendingOther: 'بانتظار المراجعة من أيام سابقة',
  notSubmitted: 'لم تُرسل بعد',
  correctedBadge: 'مصحّح',
  lateBadge: 'متأخر',
  statusPending: 'بانتظار المراجعة', statusApproved: 'معتمد', statusReturned: 'معاد للتصحيح', statusMissing: 'لم يُرسل',
  confirm: /^(تأكيد|نعم|اعتماد الكل|اعتماد|إعادة|إعادة للتصحيح|إرسال|حذف|حفظ)$/,
  sessionExpired: 'انتهت الجلسة، سجّل الدخول مرة أخرى',
  // admin: schools
  addSchool: /^(\+ )?إضافة مدرسة$/,
  bulkAdd: /إضافة عدة مدارس/,
  save: /^(حفظ|حفظ المدرسة|إضافة|إضافة المدرسة|إضافة المدارس|حفظ التغييرات|إضافة السؤال|حفظ السؤال)$/,
  schoolName: /اسم المدرسة/,
  principal: /المدير/,
  duplicate: 'مكررة',
  // admin: form builder
  addQuestion: /إضافة سؤال/,
  questionLabel: /نص السؤال|عنوان السؤال|السؤال/,
  typeNumber: /^رقم$/,
  saveForm: /حفظ النموذج/,
  // school page
  modeInPerson: 'حضوري', modeRemote: 'عن بُعد',
  rowStudents: 'الطلاب', rowTeachers: 'المعلمون', rowStaff: 'الإداريون',
  present: 'الحاضرون', absent: 'الغائبون',
  lessonsPlanned: 'الحصص المخطط لها', lessonsDone: 'الحصص المفعّلة', note: 'ملاحظة عامة',
  filledBy: 'اسم من يعبّئ التقرير',
  submit: /^إرسال التقرير$/,
  submitCorrection: /^إرسال التصحيح$/,
  sentPending: 'تم إرسال التقرير',
  sentApproved: 'تم اعتماد التقرير',
  editReport: /تعديل التقرير/,
  correctReport: /تصحيح التقرير/,
  deadlineChip: 'آخر موعد للإرسال',
  lateChip: 'تجاوزت الموعد',
  pickerTitle: 'اختر مدرستك',
  pin: 'رمز المدرسة',
  enter: /^دخول$/,
  continueAs: 'متابعة باسم',
  pinWrong: 'رمز المدرسة غير صحيح',
  badLink: 'الرابط غير صحيح أو تم تغييره',
  badLinkHint: 'تأكد أنك فتحت آخر رابط أرسله لك المشرف',
  previewBanner: 'وضع المعاينة',
  closed: 'انتهى وقت الإرسال',
  // added by integration
  menuNewLink: /^إنشاء رابط جديد/, confirmNewLink: /^إنشاء رابط جديد$/, newLinkDone: 'تم إنشاء الرابط الجديد',
  menuNewPin: /^إنشاء رمز جديد للمدرسة/, confirmNewPin: /^إنشاء رمز جديد$/,
  menuDeactivate: /^إيقاف المدرسة مؤقتًا/, confirmDeactivate: /^إيقاف المدرسة$/, inactiveBadge: 'موقوفة مؤقتًا',
  reactivate: /^إعادة التفعيل$/,
  menuDelete: /^حذف المدرسة/, confirmDelete: /^حذف المدرسة$/,
  inactive: 'هذه المدرسة موقوفة مؤقتًا من قبل المشرف',
  pendingNote: 'سيصل التقرير للمشرف بحالة',
  autoApprovedSub: 'وصل التقرير إلى المشرف',
  submitEdit: /^إرسال التعديل$/,
  editedOnce: /عُدِّل مرة/,
  kpiAutoApprove: 'الاعتماد',
  closedTitle: 'انتهى وقت الإرسال لهذا اليوم',
  dayOff: 'يوم إجازة',
  holidayTitle: 'اليوم إجازة',
  sendAnyway: /إرسال تقرير على أي حال/,
  storedLinkGone: 'لم يعد رابط مدرستك المحفوظ صالحًا',
  generalOff: 'الرابط العام غير مفعّل',
  returnedNoticeTitle: 'تمت إعادة التقرير للتصحيح',
  deleteReport: /^حذف التقرير$/,
  typeYesNo: /^نعم \/ لا$/,
  typeSelect: /^اختيار$/
};

/* =====================================================================================
 * Selectors — every DOM assumption is here
 * =================================================================================== */
const UI = {
  /** Value stored in localStorage to be "logged in" (App.store prefix 'nabd:', JSON values — spec §7.2/§7.4). */
  sessionKey: 'nabd:session',
  sessionValue: (token) => JSON.stringify(token),
  schoolStoreKey: 'nabd:school',

  button: (p, name) => p.getByRole('button', { name }).filter({ visible: true }).first(),
  link: (p, name) => p.getByRole('link', { name }).filter({ visible: true }).first(),
  text: (p, s) => p.getByText(s).filter({ visible: true }).first(),
  modal: (p) => p.locator('.modal').filter({ visible: true }).last(),
  toast: (p) => p.locator('.toast-host .toast, .toast').filter({ visible: true }).last(),
  field: (scope, label) => scope.locator('.field').filter({ hasText: label }).first(),
  input: (scope, label) => UI.field(scope, label).locator('input, textarea, select').first(),
  otpInputs: (p) => p.locator('input.otp-input, .otp-input input'),
  nav: (p, label) => p.locator('.bottom-nav__item, .tabs .tab').filter({ visible: true }).filter({ hasText: label }).first(),
  appShell: (p) => p.locator('.appbar').first(),
  kpi: (p, label) => p.locator('.kpi').filter({ visible: true }).filter({ hasText: label }).first(),
  kpiValue: (p, label) => UI.kpi(p, label).locator('.kpi__value').first(),
  /** A report row (desktop table row or mobile card) for a school on the Today page. */
  reportItem: (p, schoolName) => p.locator('table tbody tr, .ad-report, .ad-report-card, .list__item, .ad-row').filter({ visible: true }).filter({ hasText: schoolName }).first(),
  schoolCard: (p, schoolName) => p.locator('.ad-school, .ad-school-card, .card, .list__item').filter({ visible: true }).filter({ hasText: schoolName }).first(),
  alertsCard: (p) => p.locator('.card, section').filter({ visible: true }).filter({ has: p.locator('.alert') }).first(),
  badge: (scope, text) => scope.locator('.badge').filter({ hasText: text }).first(),
  choice: (p, text) => p.locator('.choice').filter({ visible: true }).filter({ hasText: text }).first(),
  attTable: (p) => p.locator('.att-table').first(),
  /** The two number inputs (present, absent) of an attendance row. */
  attInputs: (p, rowLabel) => p.locator('.att-table tr, .att-table [role="row"], .att-table .att-row, .att-table .sc-att-row').filter({ hasText: rowLabel }).first().locator('input'),
  numberInput: (p, label) => UI.field(p, label).locator('input').first(),
  stepperPlus: (p, label) => UI.field(p, label).locator('.stepper__btn').last(),
  uploaderInput: (p) => p.locator('.uploader input[type="file"]').first(),
  thumbs: (p) => p.locator('.uploader .thumb'),
  uploadingThumbs: (p) => p.locator('.uploader .thumb.is-uploading'),
  correctionBanner: (p) => p.locator('.alert--danger').filter({ visible: true }).first(),
  pickerSelect: (p) => p.locator('select').filter({ visible: true }).first(),
  pickerSearch: (p) => p.locator('input[type="search"], input[placeholder*="ابحث"]').filter({ visible: true }).first(),
  pinInput: (p) => p.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"], input[maxlength="4"]').filter({ visible: true }).first(),
  doc: (p) => p.locator('.doc').filter({ visible: true }).first(),
  charts: (p) => p.locator('svg[role="img"]').filter({ visible: true }),
  emptyCard: (p) => p.locator('.empty').filter({ visible: true }).first()
};

/* =====================================================================================
 * Minimal PNG encoder (RGB, zlib) for upload fixtures
 * =================================================================================== */
function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r & 255; raw[o + 1] = g & 255; raw[o + 2] = b & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/* =====================================================================================
 * Harness: server, browser, contexts, seeding
 * =================================================================================== */
let srv = null;
let browser = null;
const MISSING_UI = ['Admin.html', 'School.html', 'Styles.html', 'Common.html'].filter((f) => !fs.existsSync(path.join(SRC, f)));
// Upload fixtures are generated PNGs passed as in-memory payloads: Chromium silently drops files whose
// *path* is non-ASCII, while payload names may be Arabic (like real phone photos).
let PNG1 = null, PNG2 = null;

before(async () => {
  PNG1 = { name: 'شاهد-1.png', mimeType: 'image/png', buffer: makePng(160, 120, (x, y) => [14 + x, 124 + (y % 60), 102 + (x ^ y) % 80]) };
  PNG2 = { name: 'شاهد-2.png', mimeType: 'image/png', buffer: makePng(120, 160, (x, y) => [184 + (y % 50), 137, 43 + (x % 90)]) };
  if (WRITE_SHOTS) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  srv = await startServer({ port: 0, srcDir: SRC, latency: Number(process.env.E2E_LATENCY || 60), clock: CLOCK0, quiet: !process.env.E2E_VERBOSE });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    headless: !process.env.E2E_HEADED,
    slowMo: Number(process.env.E2E_SLOWMO || 0),
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync', '--disable-default-apps', '--font-render-hinting=none']
  });
});
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

async function api(p, body, method) {
  const r = await fetch(srv.url + p.replace(/^\//, ''), { method: method || (body === undefined ? 'GET' : 'POST'), body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
}
/** Strict google.script.run call without latency (POST /__call). Throws the server's message. */
async function rpc(fn, ...args) {
  const r = await api('__call', { fn, args });
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.result;
}
async function setClock(iso) { return api('__clock', { iso }); }
async function lastCode() { const r = await api('__mail/last-code'); assert.ok(r.code, 'an OTP email was sent'); return r.code; }
async function state() { return api('__state'); }

const ATT_OK = { students: { present: 380, absent: 20 }, teachers: { present: 29, absent: 1 }, staff: { present: 8, absent: 0 } };
function answersFor(fields, o = {}) {
  const a = {};
  for (const f of fields) {
    if (f.type === 'select') a[f.id] = f.kpi === 'mode' ? (o.mode || f.options[0]) : f.options[0];
    else if (f.type === 'attendance') { a[f.id] = {}; for (const r of f.rows) a[f.id][r] = Object.assign({}, (o.att && o.att[r]) || ATT_OK[r]); }
    else if (f.type === 'number') { if (f.kpi === 'lessons_planned') a[f.id] = o.planned === undefined ? 40 : o.planned; else if (f.kpi === 'lessons_done') a[f.id] = o.done === undefined ? 36 : o.done; else if (f.required) a[f.id] = Math.max(1, f.min || 0); }
    else if (f.type === 'textarea') { if (o.note !== undefined) a[f.id] = o.note; else if (f.required) a[f.id] = 'ملاحظة'; }
    else if (f.type === 'text') { if (f.required) a[f.id] = 'نص'; }
    else if (f.type === 'yesno') a[f.id] = false;
  }
  return a;
}

const SCHOOLS = [
  { name: 'مدرسة النور الابتدائية', principal: 'أ. خالد العتيبي', phone: '0501234567', students: 400, teachers: 30, staff: 8, stage: 'ابتدائي' },
  { name: 'مدرسة الفجر المتوسطة', principal: 'أ. سعد القحطاني', phone: '0559876543', students: 300, teachers: 25, staff: 6, stage: 'متوسط' },
  { name: 'ثانوية الأمل', principal: 'أ. فهد الشمري', phone: '0533332211', students: 500, teachers: 40, staff: 10, stage: 'ثانوي' }
];
const seed = {
  async login() {
    await api('__clock', { advanceMs: 61000 });
    await rpc('api_requestCode');
    return (await rpc('api_verifyCode', await lastCode(), 'e2e')).token;
  },
  async setup(o = {}) {
    const token = await seed.login();
    await rpc('api_completeSetup', token, Object.assign({ supervisor: { name: 'أحمد المشرف', title: 'المشرف التربوي', office: 'مكتب التعليم بالشمال' }, systemTitle: 'متابعة سير العملية التعليمية', schoolsText: '', preset: 'standard' }, o));
    return token;
  },
  async ready(o = {}) {
    const token = await seed.setup(o.setup);
    const schools = [];
    for (const s of (o.schools || SCHOOLS)) schools.push((await rpc('api_saveSchool', token, Object.assign({}, s))).school);
    const fields = (await rpc('api_bootstrap', token)).fields;
    return { token, schools, fields };
  },
  async submit(fields, school, o = {}) {
    const payload = { answers: answersFor(fields, o), filledBy: o.filledBy || 'أ. خالد' };
    if (o.date) payload.date = o.date;
    return (await rpc('api_submitReport', school.token, payload)).receipt;
  },
  /**
   * A realistic history: every Sun–Thu from `from` to `to` (inclusive) each school reports (with a few
   * gaps and late reports), absence and activation vary smoothly; past days are approved.
   * The schools must already exist on `from` (seed them with the clock set before it).
   */
  async history(token, fields, schools, from, to) {
    const dates = [];
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
      const d = new Date(t);
      if (d.getUTCDay() <= 4) dates.push(d.toISOString().slice(0, 10));
    }
    for (const [i, date] of dates.entries()) {
      for (const [k, s] of schools.entries()) {
        if ((i * 7 + k * 3) % 11 === 5) continue;                         // a missed day now and then
        const late = (i + k) % 6 === 4;
        await setClock(date + (late ? 'T09:25' : 'T07:' + String(10 + ((i + k * 7) % 40)).padStart(2, '0')));
        const ref = SCHOOLS[k] || { students: 300, teachers: 25, staff: 6 };
        const sa = Math.round(ref.students * (0.035 + 0.025 * k + 0.02 * Math.sin(i / 2 + k)));
        const ta = Math.max(0, Math.round(ref.teachers * (0.03 + 0.03 * Math.cos(i / 3 + k))));
        const planned = 30 + 5 * k;
        const done = Math.round(planned * (0.92 - 0.06 * k + 0.05 * Math.sin(i + k)));
        await seed.submit(fields, s, {
          att: { students: { present: ref.students - sa, absent: sa }, teachers: { present: ref.teachers - ta, absent: ta }, staff: { present: ref.staff, absent: 0 } },
          planned, done: Math.min(done, planned), mode: (i + k) % 5 === 0 ? 'عن بُعد' : 'حضوري'
        });
      }
      if (date < to) await rpc('api_approveAll', token, date);
    }
  }
};

/**
 * Fresh context with: Riyadh time zone + server clock, external requests stubbed, error collection.
 * kind: 'mobile' | 'desktop'.  o: { token (logged-in admin), timezoneId, clearStorage }
 */
async function open(kind, o = {}) {
  const ctx = await browser.newContext(Object.assign({}, kind === 'mobile' ? MOBILE : DESKTOP, {
    locale: 'ar-SA', timezoneId: o.timezoneId || 'Asia/Riyadh', permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true
  }));
  ctx.setDefaultTimeout(STEP_TIMEOUT);
  const errors = [], dialogs = [], external = [];
  await ctx.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (route) => {
    const url = route.request().url();
    if (/fonts\.googleapis\.com/.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts stubbed in tests */' });
    if (/fonts\.gstatic\.com/.test(url)) return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' });
    if (/qrcode/.test(url)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.qrcode=function(){return{addData:function(){},make:function(){},createSvgTag:function(){return \'<svg data-stub="qr" viewBox="0 0 10 10"></svg>\';}}};' });
    external.push(url);
    return route.abort('blockedbyclient');
  });
  const nowMs = (await api('__clock')).ms;
  await ctx.clock.setSystemTime(nowMs);
  await ctx.addInitScript(() => { window.__printCount = 0; window.print = () => { window.__printCount++; }; });
  // Seed the admin session once per tab (a reload after AUTH_REQUIRED must not bring a dead token back).
  if (o.token) await ctx.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('__e2eSeeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__e2eSeeded', '1'); } } catch (e) { /* ignore */ } }, [UI.sessionKey, UI.sessionValue(o.token)]);
  let page = null;
  ctx.on('page', (pg) => { if (page && pg !== page) pg.close().catch(() => {}); });   // WhatsApp / Drive popups
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource/.test(text) && external.some((u) => (m.location().url || '').startsWith(u.slice(0, 40)) || text.includes('ERR_BLOCKED_BY_CLIENT'))) return;
    errors.push('console.error: ' + text);
  });
  page.on('dialog', (d) => { dialogs.push(d.type() + ': ' + d.message()); d.dismiss().catch(() => {}); });
  return { ctx, page, errors, dialogs, external };
}
/** Assert a page stayed clean and close its context. */
async function closeClean(h, o = {}) {
  try {
    assert.deepEqual(h.errors, [], 'page errors / console errors');
    if (!o.allowDialogs) assert.deepEqual(h.dialogs, [], 'native alert/confirm/prompt dialogs must not be used (App.modal/App.confirm instead)');
    const unexpected = h.external.filter((u) => !/^https:\/\/(wa\.me|api\.whatsapp\.com|docs\.google\.com|drive\.google\.com|script\.google\.com)\//.test(u));
    assert.deepEqual(unexpected, [], 'requests to unexpected external hosts');
  } finally {
    await h.ctx.close();
  }
}
async function idle(page) {
  await page.waitForFunction(() => (window.__gasPending || 0) === 0, null, { timeout: STEP_TIMEOUT });
  await page.waitForTimeout(80);
}
async function goto(page, query) { await page.goto(srv.url + (query ? '?' + query : '')); await idle(page); }
async function shot(page, name, o = {}) {
  if (!WRITE_SHOTS) return;
  await idle(page).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  // Let smooth scrolling settle (a capture mid-scroll shows un-rasterised blank tiles).
  await page.waitForFunction(() => new Promise((res) => {
    let last = window.scrollY, still = 0;
    const tick = () => { if (window.scrollY === last) still++; else { still = 0; last = window.scrollY; } if (still >= 8) res(true); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), null, { timeout: 3000 }).catch(() => {});
  // Transient toasts are hidden unless the shot is about them.
  const hide = o.toasts ? null : await page.addStyleTag({ content: '.toast-host{visibility:hidden!important}' }).catch(() => null);
  try { await capture(page, path.join(SHOTS_DIR, name + '.png'), o); }
  finally { if (hide) await hide.evaluate((el) => el.remove()).catch(() => {}); }
}
async function capture(page, file, o) {
  if (!o.fullPage) { await page.screenshot({ path: file, animations: 'disabled' }); return; }
  // Full page: grow the viewport to the document height so fixed bars (submit bar, bottom nav)
  // sit at the real bottom of the page instead of floating over the middle of a stitched capture.
  const vp = page.viewportSize();
  const scrollY = await page.evaluate(() => window.scrollY);
  const height = await page.evaluate(() => Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)));
  await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(height, vp.height), 12000) });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  try { await page.screenshot({ path: file, animations: 'disabled' }); }
  finally { await page.setViewportSize(vp); await page.evaluate((y) => window.scrollTo(0, y), scrollY); }
}
async function fillOtp(page, code) {
  const inputs = UI.otpInputs(page);
  await inputs.first().waitFor({ state: 'visible' });
  if ((await inputs.count()) <= 1) await inputs.first().fill(code);
  else { await inputs.first().click(); await page.keyboard.type(code, { delay: 25 }); }
  await idle(page);
}
async function fillNumber(locator, value) { await locator.click(); await locator.fill(String(value)); await locator.blur(); }
async function confirmModal(page) { await UI.button(UI.modal(page), T.confirm).click(); await idle(page); }
function num(text) { const m = /-?\d+(?:\.\d+)?/.exec(String(text).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))); return m ? Number(m[0]) : NaN; }

/** Wraps a scenario: fresh server state, UI presence check, generous timeout. */
function scenario(name, fn) {
  it(name, { timeout: 120000 }, async () => {
    if (MISSING_UI.length) throw new Error('UI files not in src/ yet: ' + MISSING_UI.join(', '));
    await api('__reset', { clock: CLOCK0 });
    await fn();
    const info = await api('__info');
    assert.deepEqual(info.formulaWrites, [], 'user text reached a sheet as a formula');
    assert.deepEqual(info.warnings.map((w) => w.message), [], 'server warnings (e.g. lock not released)');
  });
}

/* ---- the school form, filled through the UI ---- */
async function fillSchoolForm(page, o = {}) {
  await UI.choice(page, o.mode || T.modeInPerson).click();
  const att = o.att || { students: [null, 20], teachers: [null, 1], staff: [null, 0] };
  for (const [row, label] of [['students', T.rowStudents], ['teachers', T.rowTeachers], ['staff', T.rowStaff]]) {
    const inputs = UI.attInputs(page, label);
    const [present, absent] = att[row];
    if (absent !== null && absent !== undefined) await fillNumber(inputs.nth(1), absent);
    if (present !== null && present !== undefined) await fillNumber(inputs.nth(0), present);
  }
  await fillNumber(UI.numberInput(page, T.lessonsPlanned), o.planned === undefined ? 40 : o.planned);
  await fillNumber(UI.numberInput(page, T.lessonsDone), o.done === undefined ? 36 : o.done);
  if (o.note !== undefined) await UI.input(page, T.note).fill(o.note);
  if (o.photos) {
    await UI.uploaderInput(page).setInputFiles(o.photos);
    try {
      await page.waitForFunction((n) => document.querySelectorAll('.uploader .thumb:not(.is-uploading):not(.is-error)').length >= n, o.photos.length, { timeout: 20000 });
    } catch (e) {
      const thumbs = await page.$$eval('.uploader .thumb', (ts) => ts.map((t) => t.className + (t.title ? ' — ' + t.title : '') + ' ' + (t.textContent || '').trim()));
      throw new Error('photos did not finish uploading: ' + JSON.stringify(thumbs) + ' — ' + e.message.split('\n')[0]);
    }
  }
  await UI.input(page, T.filledBy).fill(o.filledBy || 'أ. خالد العتيبي');
}

/* =====================================================================================
 * Scenarios
 * =================================================================================== */
describe('e2e', () => {
  scenario('setup wizard: OTP from /__mail, supervisor info, schools list, then the dashboard', async () => {
    const h = await open('desktop');
    const { page } = h;
    await goto(page);
    await UI.button(page, T.startSetup).waitFor();
    await shot(page, 'admin-setup-welcome-desktop');
    await UI.button(page, T.startSetup).click();
    await UI.text(page, 'su••••••@gmail.com').waitFor();
    await UI.button(page, T.sendCode).click();
    await idle(page);
    await fillOtp(page, await lastCode());
    await page.getByLabel(T.supervisorName).first().fill('أحمد بن سعيد المشرف');
    await shot(page, 'admin-setup-info-desktop');
    await UI.button(page, T.next).click();
    await idle(page);
    await page.getByPlaceholder(T.schoolsPlaceholder).first().fill(SCHOOLS.map((s) => s.name).join('\n'));
    await shot(page, 'admin-setup-schools-desktop');
    await UI.button(page, T.next).click();
    await idle(page);
    await UI.button(page, T.goDashboard).click();
    await idle(page);
    await UI.appShell(page).waitFor();
    await UI.kpi(page, T.kpiSubmission).waitFor();
    const stored = await page.evaluate((k) => localStorage.getItem(k), UI.sessionKey);
    assert.ok(stored, 'the session token is stored in localStorage["' + UI.sessionKey + '"] (adjust UI.sessionKey/sessionValue)');
    const parsed = JSON.parse(stored);
    const token = typeof parsed === 'string' ? parsed : parsed && parsed.token;
    const list = await rpc('api_schools', token);
    assert.equal(list.schools.length, 3);
    const boot = await rpc('api_bootstrap', token);
    assert.equal(boot.supervisor.name, 'أحمد بن سعيد المشرف');
    await shot(page, 'admin-today-empty-desktop');
    await closeClean(h);
  });

  scenario('login after setup on a phone (OTP, resend countdown, app shell with bottom navigation)', async () => {
    await seed.setup();
    await api('__clock', { advanceMs: 61000 });
    const h = await open('mobile');
    const { page } = h;
    await goto(page);
    await UI.text(page, T.loginTitle).waitFor();
    await UI.text(page, 'su••••••@gmail.com').waitFor();
    await shot(page, 'admin-login-mobile');
    await UI.button(page, T.loginSend).click();
    await idle(page);
    await fillOtp(page, await lastCode());
    await UI.appShell(page).waitFor();
    await page.locator('.bottom-nav').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.bottom-nav__item').count(), 5);
    await closeClean(h);
  });

  scenario('schools: add one, bulk-add with a duplicate, school cards with pin and link actions', async () => {
    const token = await seed.setup();
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.schools).click();
    await idle(page);
    await UI.button(page, T.addSchool).click();
    const m = UI.modal(page);
    await UI.input(m, T.schoolName).fill(SCHOOLS[0].name);
    await UI.input(m, T.principal).fill(SCHOOLS[0].principal);
    await UI.button(m, T.save).click();
    await idle(page);
    await UI.schoolCard(page, SCHOOLS[0].name).waitFor();
    await UI.button(page, T.bulkAdd).click();
    const bm = UI.modal(page);
    await bm.locator('textarea').first().fill([SCHOOLS[1].name + '، ' + SCHOOLS[1].principal, SCHOOLS[2].name, SCHOOLS[0].name].join('\n'));
    await UI.button(bm, T.save).click();
    await idle(page);
    await UI.text(page, T.duplicate).waitFor();
    await page.keyboard.press('Escape');
    const list = await rpc('api_schools', token);
    assert.deepEqual(list.schools.map((s) => s.name).sort(), SCHOOLS.map((s) => s.name).sort());
    await UI.schoolCard(page, SCHOOLS[2].name).waitFor();
    await shot(page, 'admin-schools-desktop');
    await closeClean(h);
    const hm = await open('mobile', { token });
    await goto(hm.page);
    await UI.nav(hm.page, T.nav.schools).click();
    await idle(hm.page);
    await UI.schoolCard(hm.page, SCHOOLS[1].name).waitFor();
    await shot(hm.page, 'admin-schools-mobile');
    await closeClean(hm);
  });

  scenario('school private link on a phone: mode, attendance (auto-filled present), lessons, note, 2 photos → receipt', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('mobile');
    const { page } = h;
    await goto(page, 's=' + schools[0].token);
    await UI.text(page, SCHOOLS[0].name).waitFor();
    await UI.text(page, T.deadlineChip).waitFor();
    await UI.choice(page, T.modeInPerson).click();
    const stu = UI.attInputs(page, T.rowStudents);
    await fillNumber(stu.nth(1), 20);
    assert.equal(await stu.nth(0).inputValue(), '380', 'present auto-filled from the reference count (400 − 20)');
    await fillSchoolForm(page, { att: { students: [null, null], teachers: [null, 1], staff: [8, 0] }, note: 'سير العمل منتظم ولله الحمد', photos: [PNG1, PNG2] });
    await shot(page, 'school-form-mobile', { fullPage: true });
    await UI.button(page, T.submit).click();
    await idle(page);
    await UI.text(page, T.sentPending).waitFor();
    await shot(page, 'school-receipt-mobile', { fullPage: true });
    const d = await rpc('api_day', token, '2026-10-14');
    const row = d.rows.find((r) => r.school.id === schools[0].id);
    assert.equal(row.report.status, 'pending');
    assert.deepEqual(row.report.derived.attendance.students, { present: 380, absent: 20, total: 400, absencePct: 5 });
    assert.equal(row.report.derived.lessons.activationPct, 90);
    assert.equal(row.report.derived.photosCount, 2);
    assert.equal(row.report.derived.mode, 'حضوري');
    assert.equal(row.report.filledBy, 'أ. خالد العتيبي');
    // the draft is gone and a reload shows the receipt, not an empty form
    await page.reload(); await idle(page);
    await UI.text(page, T.sentPending).waitFor();
    await closeClean(h);
  });

  scenario('review loop: return with a note → correction banner next day → corrected → approved → locked', async () => {
    const { token, schools, fields } = await seed.ready();
    const A = schools[0];
    await seed.submit(fields, A, { att: { students: { present: 300, absent: 100 } } });
    // supervisor returns it
    const ha = await open('desktop', { token });
    await goto(ha.page);
    await UI.reportItem(ha.page, SCHOOLS[0].name).click();
    const m = UI.modal(ha.page);
    await m.waitFor();
    await shot(ha.page, 'admin-report-modal-desktop');
    await UI.button(m, T.returnForCorrection).click();
    const note = 'يرجى مراجعة عدد الغائبين من الطلاب';
    await UI.modal(ha.page).locator('textarea, input[type="text"]').first().fill(note);
    await confirmModal(ha.page);
    for (let i = 0; i < 5 && await page_hasModal(ha.page); i++) { await ha.page.keyboard.press('Escape'); await ha.page.waitForTimeout(150); }   // e.g. the «إبلاغ المدرسة عبر واتساب» offer
    let rep = (await rpc('api_report', token, '2026-10-14', A.id)).report;
    assert.equal(rep.status, 'returned'); assert.equal(rep.reviewNote, note);
    await closeClean(ha);
    // next morning the school sees the banner and corrects
    await setClock('2026-10-15T07:40');
    const hs = await open('mobile');
    await goto(hs.page, 's=' + A.token);
    await UI.correctionBanner(hs.page).waitFor();
    assert.ok((await UI.correctionBanner(hs.page).textContent()).includes(note));
    await shot(hs.page, 'school-correction-banner-mobile');
    await UI.button(hs.page, T.correctReport).click();
    await idle(hs.page);
    const stu = UI.attInputs(hs.page, T.rowStudents);
    await fillNumber(stu.nth(0), 380); await fillNumber(stu.nth(1), 20);
    await UI.button(hs.page, T.submitCorrection).click();
    await idle(hs.page);
    await UI.text(hs.page, T.sentPending).waitFor();
    rep = (await rpc('api_report', token, '2026-10-14', A.id)).report;
    assert.equal(rep.status, 'pending'); assert.equal(rep.derived.attendance.students.absent, 20);
    await closeClean(hs);
    // supervisor: «pending from previous days» → approve
    const hb = await open('desktop', { token });
    await goto(hb.page);
    await UI.text(hb.page, T.pendingOther).waitFor();
    await hb.page.locator('.card, section').filter({ hasText: T.pendingOther }).getByText(SCHOOLS[0].name).first().click();
    await idle(hb.page);
    await UI.badge(UI.reportItem(hb.page, SCHOOLS[0].name), T.correctedBadge).waitFor();
    await UI.reportItem(hb.page, SCHOOLS[0].name).click();
    await UI.button(UI.modal(hb.page), T.approve).click();
    await idle(hb.page);
    rep = (await rpc('api_report', token, '2026-10-14', A.id)).report;
    assert.equal(rep.status, 'approved');
    await closeClean(hb);
    // the school can no longer edit that day
    const r = await rpc('api_schoolForm', A.token, '2026-10-14');
    assert.equal(r.ok, false); assert.equal(r.code, 'NOT_EDITABLE');
    const hs2 = await open('mobile');
    await goto(hs2.page, 's=' + A.token);
    assert.equal(await UI.correctionBanner(hs2.page).count(), 0, 'no correction banner any more');
    await closeClean(hs2);
  });

  scenario('general link: pick the school, wrong then right pin, remembered next time', async () => {
    const { schools } = await seed.ready();
    const B = schools[1];
    const h = await open('mobile');
    const { page } = h;
    await goto(page, 'f=all');
    await UI.text(page, T.pickerTitle).waitFor();
    await shot(page, 'school-picker-mobile');
    if (await UI.pickerSelect(page).count()) await UI.pickerSelect(page).selectOption({ label: SCHOOLS[1].name });
    else { if (await UI.pickerSearch(page).count()) await UI.pickerSearch(page).fill('الفجر'); await UI.text(page, SCHOOLS[1].name).click(); }
    const wrong = B.pin === '0000' ? '1111' : '0000';
    await UI.pinInput(page).fill(wrong);
    await UI.button(page, T.enter).click();
    await idle(page);
    await UI.text(page, T.pinWrong).waitFor();
    await UI.pinInput(page).fill(B.pin);
    await UI.button(page, T.enter).click();
    await idle(page);
    await UI.choice(page, T.modeInPerson).waitFor();
    await UI.text(page, SCHOOLS[1].name).waitFor();
    await goto(page, 'f=all');
    await UI.text(page, T.continueAs).waitFor();
    assert.ok((await page.locator('body').textContent()).includes(SCHOOLS[1].name));
    await closeClean(h);
  });

  scenario('late submission after the deadline (browser in another time zone still shows Riyadh dates)', async () => {
    const { token, schools } = await seed.ready();
    await setClock('2026-10-14T09:30');
    const h = await open('mobile', { timezoneId: 'America/Los_Angeles' });
    const { page } = h;
    await goto(page, 's=' + schools[2].token);
    await UI.text(page, T.lateChip).waitFor();
    const body = await page.locator('body').textContent();
    assert.ok(body.includes('الأربعاء'), 'day name of the Riyadh date');
    assert.ok(/14\s*أكتوبر\s*2026/.test(body), 'Gregorian date of the Riyadh day (not the browser\'s local date)');
    await shot(page, 'school-late-mobile');
    await fillSchoolForm(page, {});
    await UI.button(page, T.submit).click();
    await idle(page);
    await UI.text(page, T.sentPending).waitFor();
    await UI.text(page, T.lateBadge).waitFor();
    const rep = (await rpc('api_report', token, '2026-10-14', schools[2].id)).report;
    assert.equal(rep.late, true);
    await closeClean(h);
  });

  scenario('dashboard numbers and smart alerts (desktop + mobile)', async () => {
    const { token, schools, fields } = await seed.ready();
    await seed.submit(fields, schools[0], { att: { students: { present: 380, absent: 20 }, teachers: { present: 29, absent: 1 } }, planned: 40, done: 36 });
    await seed.submit(fields, schools[1], { att: { students: { present: 255, absent: 45 }, teachers: { present: 22, absent: 3 }, staff: { present: 5, absent: 1 } }, planned: 30, done: 20, mode: 'عن بُعد' });
    const day = await rpc('api_day', token, '2026-10-14');
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    const sub = await UI.kpi(page, T.kpiSubmission).textContent();   // ring «2/3» or «2 من 3»
    assert.match(sub, /2\s*(\/|من)\s*3|3\s*(\/|من)\s*2/, 'submission KPI shows 2 of 3: ' + sub);
    assert.equal(num(await UI.kpiValue(page, T.kpiStudents).textContent()), day.totals.students.absencePct);
    assert.equal(num(await UI.kpiValue(page, T.kpiTeachers).textContent()), day.totals.teachers.absencePct);
    assert.equal(num(await UI.kpiValue(page, T.kpiLessons).textContent()), day.totals.lessons.activationPct);
    const alerts = page.locator('.alert').filter({ visible: true }).filter({ hasText: SCHOOLS[1].name });
    assert.ok(await alerts.count() >= 2, 'high absence + teacher absence / low activation alerts for ' + SCHOOLS[1].name);
    await UI.text(page, T.notSubmitted).waitFor();
    await UI.badge(UI.reportItem(page, SCHOOLS[0].name), T.statusPending).waitFor();
    await shot(page, 'admin-today-desktop');
    await closeClean(h);
    const hm = await open('mobile', { token });
    await goto(hm.page);
    await UI.kpi(hm.page, T.kpiSubmission).waitFor();
    await hm.page.locator('.bottom-nav__badge').filter({ hasText: '2' }).first().waitFor();
    await shot(hm.page, 'admin-today-mobile');
    await shot(hm.page, 'admin-today-mobile-full', { fullPage: true });
    await closeClean(hm);
  });

  scenario('approve-all approves every pending report of the day', async () => {
    const { token, schools, fields } = await seed.ready();
    for (const s of schools) await seed.submit(fields, s);
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.button(page, T.approveAll).click();
    await confirmModal(page);
    const d = await rpc('api_day', token, '2026-10-14');
    assert.equal(d.totals.approved, 3); assert.equal(d.totals.pending, 0);
    await UI.badge(UI.reportItem(page, SCHOOLS[2].name), T.statusApproved).waitFor();
    await closeClean(h);
  });

  scenario('form builder: add a number question → the school form shows it', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.form).click();
    await idle(page);
    await UI.button(page, T.addQuestion).click();
    const m = UI.modal(page);
    await UI.input(m, T.questionLabel).fill('عدد الزوار اليوم');
    await UI.button(m, T.typeNumber).click();
    await UI.button(m, T.save).click();
    await UI.button(page, T.saveForm).click();
    await idle(page);
    const fields = (await rpc('api_bootstrap', token)).fields;
    assert.ok(fields.some((f) => f.label === 'عدد الزوار اليوم' && f.type === 'number'));
    await closeClean(h);
    const hs = await open('mobile');
    await goto(hs.page, 's=' + schools[0].token);
    await UI.text(hs.page, 'عدد الزوار اليوم').waitFor();
    await closeClean(hs);
  });

  scenario('statistics: charts render as inline SVG', async () => {
    await setClock('2026-09-20T06:00');
    const { token, schools, fields } = await seed.ready();
    await seed.history(token, fields, schools, '2026-09-20', '2026-10-14');
    await setClock('2026-10-14T10:00');
    const range = await rpc('api_range', token, '2026-09-15', '2026-10-14');
    assert.ok(range.days.filter((d) => d.expected > 0).length >= 15, 'about three weeks of workdays with expected reports');
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.stats).click();
    await idle(page);
    await page.waitForFunction(() => document.querySelectorAll('svg[role="img"]').length >= 2);
    assert.ok(await UI.charts(page).count() >= 2, 'line + bar (+ donut) charts');
    await shot(page, 'admin-stats-desktop');
    await closeClean(h);
    const hm = await open('mobile', { token });
    await goto(hm.page);
    await UI.nav(hm.page, T.nav.stats).click();
    await idle(hm.page);
    await hm.page.waitForFunction(() => document.querySelectorAll('svg[role="img"]').length >= 2);
    await shot(hm.page, 'admin-stats-mobile');
    await closeClean(hm);
  });

  scenario('printable reports: the day report and a single-school report open as .doc', async () => {
    const { token, schools, fields } = await seed.ready();
    await seed.submit(fields, schools[0]);
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.button(page, T.printDay).click();
    await idle(page);
    await UI.doc(page).waitFor();
    assert.ok((await UI.doc(page).textContent()).includes(SCHOOLS[0].name));
    await page.waitForFunction(() => window.__printCount >= 1).catch(() => {});
    await shot(page, 'admin-print-day-desktop');
    // What the printer gets (Ctrl+P while the report dialog is open → only the report is printed)
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    assert.ok(await page.evaluate(() => document.body.classList.contains('is-printing-doc')), 'print mode prints only the open report');
    await shot(page, 'admin-print-day-printed', { fullPage: true });
    if (WRITE_SHOTS) await page.pdf({ path: path.join(SHOTS_DIR, 'admin-print-day.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    await closeClean(h);
  });

  scenario('invalid link and preview pages', async () => {
    await seed.ready();
    const h = await open('mobile');
    const { page } = h;
    await goto(page, 's=ThisLinkIsWrong123456');
    await UI.text(page, T.badLink).waitFor();
    await UI.text(page, T.badLinkHint).waitFor();
    await UI.emptyCard(page).waitFor();
    await shot(page, 'school-invalid-link-mobile');
    await goto(page, 's=__preview');
    await UI.text(page, T.previewBanner).waitFor();
    assert.ok(await UI.button(page, T.submit).isDisabled(), 'submit disabled in preview');
    await shot(page, 'school-preview-mobile');
    await closeClean(h);
  });

  scenario('XSS: a hostile school name and note render as text; no script runs, no dialog opens', async () => {
    const evil = '<img src=x onerror="window.__xss=1;alert(1)">مدرسة "الاختبار" <script>window.__xss=2</script>';
    const { token, fields } = await seed.ready();
    const s = (await rpc('api_saveSchool', token, { name: evil, principal: '<b onmouseover=alert(1)>مدير</b>' })).school;
    await seed.submit(fields, s, { note: '<svg onload=alert(1)>ملاحظة' });
    for (const [kind, q] of [['desktop', ''], ['mobile', 's=' + s.token]]) {
      const h = await open(kind, kind === 'desktop' ? { token } : {});
      await goto(h.page, q);
      await h.page.getByText('مدرسة "الاختبار"', { exact: false }).first().waitFor();
      assert.equal(await h.page.evaluate(() => window.__xss), undefined, 'injected script executed');
      assert.ok((await h.page.locator('body').textContent()).includes('<img src=x'), 'name shown literally as text');
      assert.equal(await h.page.locator('img[src="x"]').count(), 0);
      if (kind === 'desktop') {
        await UI.reportItem(h.page, 'مدرسة "الاختبار"').click();
        await UI.modal(h.page).waitFor();
        assert.equal(await h.page.evaluate(() => window.__xss), undefined);
        assert.equal(await h.page.locator('svg[onload]').count(), 0);
        await h.page.keyboard.press('Escape');
        // the hostile name also reaches the school cards and the statistics charts (bar labels, tooltips, data table)
        await UI.nav(h.page, T.nav.schools).click();
        await idle(h.page);
        await UI.schoolCard(h.page, 'مدرسة "الاختبار"').waitFor();
        await UI.nav(h.page, T.nav.stats).click();
        await idle(h.page);
        await h.page.waitForFunction(() => document.querySelectorAll('svg[role="img"]').length >= 2);
        await h.page.locator('.chart__svg').first().hover();
        assert.equal(await h.page.evaluate(() => window.__xss), undefined, 'no script ran on the schools / stats pages');
        assert.equal(await h.page.locator('img[src="x"], svg[onload], b[onmouseover]').count(), 0);
      }
      await closeClean(h);
    }
  });

  scenario('formula-like text typed in the UI is stored safely (no Sheets formulas)', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('mobile');
    await goto(h.page, 's=' + schools[0].token);
    await fillSchoolForm(h.page, { note: '=HYPERLINK("http://evil.example","انقر")', filledBy: '+أحمد' });
    await UI.button(h.page, T.submit).click();
    await idle(h.page);
    await UI.text(h.page, T.sentPending).waitFor();
    await closeClean(h);
    const st = await state();
    assert.deepEqual(st.formulaWrites, [], 'user text reached a sheet as a formula');
    const rep = (await rpc('api_report', token, '2026-10-14', schools[0].id)).report;
    assert.equal(rep.filledBy, '+أحمد');
    assert.ok(Object.values(rep.answers).includes('=HYPERLINK("http://evil.example","انقر")'));
  });

  scenario('expired session: AUTH_REQUIRED brings back the login screen with a toast', async () => {
    const token = await seed.setup();
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.appShell(page).waitFor();
    await rpc('api_logoutAll', token);
    await UI.nav(page, T.nav.schools).click();
    await idle(page);
    await UI.text(page, T.loginTitle).waitFor();
    await UI.text(page, T.sessionExpired).waitFor();
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), UI.sessionKey), null, 'stored session cleared');
    await closeClean(h);
  });

  scenario('settings page renders every group', async () => {
    const token = await seed.setup();
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.settings).click();
    await idle(page);
    for (const s of ['المراجعة والاعتماد', 'مواعيد التسليم', 'التنبيهات الذكية', 'الإجازات', 'الأمان']) await UI.text(page, s).waitFor();
    await shot(page, 'admin-settings-desktop');
    await closeClean(h);
  });

  /* ---------------------------------------------------------------- coverage added by integration */

  scenario('school actions: new link (old link → BAD_LINK), new code, deactivate (→ INACTIVE) and reactivate, delete', async () => {
    const { token, schools } = await seed.ready();
    const [A, B, C] = schools;
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.schools).click();
    await idle(page);
    // new private link
    await schoolMenu(page, SCHOOLS[0].name, T.menuNewLink);
    await UI.button(UI.modal(page), T.confirmNewLink).click();
    await idle(page);
    await UI.text(page, T.newLinkDone).waitFor();
    await shot(page, 'admin-school-new-link-desktop');
    await page.keyboard.press('Escape');
    let list = (await rpc('api_schools', token)).schools;
    const A2 = list.find((s) => s.id === A.id);
    assert.notEqual(A2.token, A.token, 'a new token was issued');
    assert.equal((await rpc('api_schoolForm', A.token)).code, 'BAD_LINK', 'the old link stops working at once');
    assert.equal((await rpc('api_schoolForm', A2.token)).ok, true, 'the new link works');
    // new school code (pin) — the toast shows it and the card reveals it
    await schoolMenu(page, SCHOOLS[1].name, T.menuNewPin);
    await UI.button(UI.modal(page), T.confirmNewPin).click();
    await idle(page);
    list = (await rpc('api_schools', token)).schools;
    const B2 = list.find((s) => s.id === B.id);
    assert.notEqual(B2.pin, B.pin);
    await UI.text(page, 'رمز المدرسة الجديد: ' + B2.pin).waitFor();
    assert.ok((await UI.schoolCard(page, SCHOOLS[1].name).textContent()).includes(B2.pin), 'the new code is revealed on the card');
    // deactivate
    await schoolMenu(page, SCHOOLS[1].name, T.menuDeactivate);
    await UI.button(UI.modal(page), T.confirmDeactivate).click();
    await idle(page);
    await UI.badge(UI.schoolCard(page, SCHOOLS[1].name), T.inactiveBadge).waitFor();
    await shot(page, 'admin-schools-inactive-desktop');
    const hs = await open('mobile');
    await goto(hs.page, 's=' + B.token);
    await UI.text(hs.page, T.inactive).waitFor();
    await UI.emptyCard(hs.page).waitFor();
    await shot(hs.page, 'school-inactive-mobile');
    const day = await rpc('api_day', token, '2026-10-14');
    assert.ok(!day.rows.some((r) => r.school.id === B.id), 'an inactive school is not expected on the dashboard');
    // reactivate from the card
    await UI.button(UI.schoolCard(page, SCHOOLS[1].name), T.reactivate).click();
    await idle(page);
    await UI.text(page, 'أُعيد تفعيل').waitFor();
    assert.equal((await rpc('api_schoolForm', B.token)).ok, true, 'the school can send again');
    await goto(hs.page, 's=' + B.token);
    await UI.choice(hs.page, T.modeInPerson).waitFor();
    await closeClean(hs);
    // delete
    await schoolMenu(page, SCHOOLS[2].name, T.menuDelete);
    await UI.button(UI.modal(page), T.confirmDelete).click();
    await idle(page);
    await page.locator('.ad-school').filter({ hasText: SCHOOLS[2].name }).waitFor({ state: 'detached' });
    list = (await rpc('api_schools', token)).schools;
    assert.deepEqual(list.map((s) => s.id).sort(), [A.id, B.id].sort());
    assert.equal((await rpc('api_schoolForm', C.token)).code, 'BAD_LINK', 'a deleted school\'s link stops working');
    await closeClean(h);
  });

  scenario('settings → earlier deadline and review off: the school is late, its report is auto-approved and stays editable', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.settings).click();
    await idle(page);
    // deadline 07:00 (clock is 07:30)
    await page.locator('#st-deadline').fill('07:00');
    await saveSettingsCard(page, 'schedule');
    // review off
    await page.locator('#set-review label.switch').click();
    await saveSettingsCard(page, 'review');
    const st = await rpc('api_getSettings', token);
    assert.equal(st.schedule.deadline, '07:00');
    assert.equal(st.review.enabled, false);
    // the school sees the late chip, sends, and gets an auto-approved, still editable receipt
    const hs = await open('mobile');
    await goto(hs.page, 's=' + schools[0].token);
    await UI.text(hs.page, T.lateChip).waitFor();
    await fillSchoolForm(hs.page, {});
    assert.equal(await hs.page.getByText(T.pendingNote).filter({ visible: true }).count(), 0, 'no «بانتظار المراجعة» note while review is off');
    await UI.button(hs.page, T.submit).click();
    await idle(hs.page);
    await UI.text(hs.page, T.sentPending).waitFor();
    await UI.text(hs.page, T.autoApprovedSub).waitFor();
    await UI.text(hs.page, T.lateBadge).waitFor();
    await UI.button(hs.page, T.editReport).waitFor();
    await shot(hs.page, 'school-receipt-auto-approved-mobile', { fullPage: true });
    const rep = (await rpc('api_report', token, '2026-10-14', schools[0].id)).report;
    assert.equal(rep.status, 'approved'); assert.equal(rep.late, true); assert.equal(rep.reviewedAt, '');
    // edit after sending (allowed: auto-approved, never reviewed)
    await UI.button(hs.page, T.editReport).click();
    await UI.input(hs.page, T.note).fill('تم التعديل بعد الإرسال');
    await UI.button(hs.page, T.submitEdit).click();
    await idle(hs.page);
    await UI.text(hs.page, T.sentPending).waitFor();
    await UI.text(hs.page, T.editedOnce).waitFor();
    assert.equal((await rpc('api_report', token, '2026-10-14', schools[0].id)).report.edits, 1);
    await closeClean(hs);
    // the dashboard: automatic approval KPI, approved + late badges on the row
    await UI.nav(page, T.nav.today).click();
    await idle(page);
    await UI.button(page, /تحديث الآن/).click();
    await idle(page);
    assert.ok((await UI.kpi(page, T.kpiAutoApprove).textContent()).includes('تلقائي'));
    const row = UI.reportItem(page, SCHOOLS[0].name);
    await UI.badge(row, T.statusApproved).waitFor();
    await UI.badge(row, T.lateBadge).waitFor();
    await closeClean(h);
  });

  scenario('late submissions off: after the deadline a school without a report sees the closed screen', async () => {
    const { token, schools } = await seed.ready();
    await rpc('api_saveSettings', token, { schedule: { allowLate: false } });
    await setClock('2026-10-14T09:20');
    const h = await open('mobile');
    await goto(h.page, 's=' + schools[0].token);
    await UI.text(h.page, T.closedTitle).waitFor();
    assert.equal(await h.page.getByRole('button', { name: T.submit }).count(), 0, 'no submit button on the closed screen');
    await shot(h.page, 'school-closed-mobile');
    await closeClean(h);
    const r = await rpc('api_schoolForm', schools[0].token);
    assert.equal(r.state, 'closed'); assert.equal(r.canEdit, false);
  });

  scenario('holiday added in settings: the school sees a day off, the dashboard expects nobody', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.settings).click();
    await idle(page);
    await page.locator('#st-h-from').fill('2026-10-14');
    await UI.button(page.locator('#set-holidays'), /^إضافة$/).click();
    await page.locator('#set-holidays .ad-hday').filter({ hasText: '14 أكتوبر 2026' }).waitFor();
    await saveSettingsCard(page, 'holidays');
    assert.deepEqual((await rpc('api_getSettings', token)).holidays, ['2026-10-14']);
    await UI.nav(page, T.nav.today).click();
    await idle(page);
    await UI.text(page, T.dayOff).waitFor();
    await shot(page, 'admin-today-holiday-desktop');
    const day = await rpc('api_day', token, '2026-10-14');
    assert.equal(day.isHoliday, true); assert.equal(day.totals.missing, 0);
    const hs = await open('mobile');
    await goto(hs.page, 's=' + schools[0].token);
    await UI.text(hs.page, T.holidayTitle).waitFor();
    await shot(hs.page, 'school-holiday-mobile');
    // sending anyway still works
    await UI.button(hs.page, T.sendAnyway).click();
    await fillSchoolForm(hs.page, {});
    await UI.button(hs.page, T.submit).click();
    await idle(hs.page);
    await UI.text(hs.page, T.sentPending).waitFor();
    await closeClean(hs);
    await closeClean(h);
  });

  scenario('photos: remove one before sending → only the kept photo is saved and the removed file is trashed', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('mobile');
    const { page } = h;
    await goto(page, 's=' + schools[0].token);
    await fillSchoolForm(page, { photos: [PNG1, PNG2] });
    const before = Object.values((await state()).drive.files).filter((f) => !f.trashed).map((f) => f.id);
    assert.equal(before.length, 2);
    await page.locator('.uploader .thumb .thumb__remove').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.uploader .thumb').length === 1);
    await idle(page);
    await UI.button(page, T.submit).click();
    await idle(page);
    await UI.text(page, T.sentPending).waitFor();
    await page.locator('.gallery img[src]').first().waitFor();
    const rep = (await rpc('api_report', token, '2026-10-14', schools[0].id)).report;
    assert.equal(rep.derived.photosCount, 1);
    const files = (await state()).drive.files;
    const kept = rep.answers[Object.keys(rep.answers).find((k) => Array.isArray(rep.answers[k]))][0].id;
    const removed = before.find((id) => id !== kept);
    assert.equal(files[removed].trashed, true, 'the removed photo was moved to the Drive trash');
    assert.equal(files[kept].trashed, false);
    await assert.rejects(rpc('api_photo', token, removed), /محذوفة|غير موجودة/);
    await closeClean(h);
  });

  scenario('general link: remembered school continues without the code; a changed link sends it back to the picker; switch off', async () => {
    const { token, schools } = await seed.ready();
    const B = schools[1];
    const h = await open('mobile');
    const { page } = h;
    await goto(page, 'f=all');
    await pickSchool(page, SCHOOLS[1].name, B.pin);
    await UI.choice(page, T.modeInPerson).waitFor();
    // next visit: «متابعة باسم» → straight to the form, no code
    await goto(page, 'f=all');
    await UI.text(page, T.continueAs).waitFor();
    await shot(page, 'school-picker-remembered-mobile');
    await UI.button(page, /^متابعة$/).click();
    await idle(page);
    await UI.choice(page, T.modeInPerson).waitFor();
    assert.ok((await page.locator('body').textContent()).includes(SCHOOLS[1].name));
    // the supervisor issues a new private link → the remembered one is dropped with a notice
    await rpc('api_regenerateLink', token, B.id);
    await goto(page, 'f=all');
    await UI.button(page, /^متابعة$/).click();
    await idle(page);
    await UI.text(page, T.storedLinkGone).waitFor();
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), UI.schoolStoreKey), null, 'the stale remembered school is cleared');
    await pickSchool(page, SCHOOLS[1].name, B.pin);
    await UI.choice(page, T.modeInPerson).waitFor();
    const stored = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), UI.schoolStoreKey));
    const B2 = (await rpc('api_schools', token)).schools.find((s) => s.id === B.id);
    assert.equal(stored.token, B2.token, 'the new private token is remembered');
    // general link switched off
    await rpc('api_saveSettings', token, { links: { generalEnabled: false } });
    await goto(page, 'f=all');
    await UI.text(page, T.generalOff).waitFor();
    await closeClean(h);
  });

  scenario('report details: quick return from the list, approve, reopen, print one school, delete the report', async () => {
    const { token, schools, fields } = await seed.ready();
    await seed.submit(fields, schools[0]);
    await seed.submit(fields, schools[1], { mode: 'عن بُعد' });
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    // quick return from the table row
    await UI.reportItem(page, SCHOOLS[1].name).getByRole('button', { name: T.returnForCorrection }).click();
    await UI.modal(page).locator('textarea').first().fill('يرجى إرفاق شواهد المتابعة');
    await confirmModal(page);
    await UI.text(page, T.returnedNoticeTitle).waitFor();
    await shot(page, 'admin-return-notice-desktop');
    await UI.button(UI.modal(page), /^لاحقًا$/).click();
    assert.equal((await rpc('api_report', token, '2026-10-14', schools[1].id)).report.status, 'returned');
    await UI.badge(UI.reportItem(page, SCHOOLS[1].name), T.statusReturned).waitFor();
    // approve in the details modal, then reopen
    await UI.reportItem(page, SCHOOLS[0].name).click();
    await UI.button(UI.modal(page), T.approve).click();
    await idle(page);
    assert.equal((await rpc('api_report', token, '2026-10-14', schools[0].id)).report.status, 'approved');
    await UI.reportItem(page, SCHOOLS[0].name).click();
    await UI.button(UI.modal(page), T.reopen).click();
    await idle(page);
    assert.equal((await rpc('api_report', token, '2026-10-14', schools[0].id)).report.status, 'pending');
    // the printable single-school report
    await UI.button(UI.modal(page), T.printReport).click();
    await idle(page);
    await UI.doc(page).waitFor();
    assert.ok((await UI.doc(page).textContent()).includes(SCHOOLS[0].name));
    await shot(page, 'admin-print-school-desktop');
    await UI.button(UI.modal(page), /^طباعة$/).click();
    await page.waitForFunction(() => window.__printCount >= 1);
    for (let i = 0; i < 3 && await page_hasModal(page); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
    // delete
    await UI.reportItem(page, SCHOOLS[0].name).click();
    await UI.button(UI.modal(page), T.deleteReport).click();
    await UI.button(UI.modal(page), T.deleteReport).click();
    await idle(page);
    await assert.rejects(rpc('api_report', token, '2026-10-14', schools[0].id), /لا يوجد تقرير/);
    await UI.badge(UI.reportItem(page, SCHOOLS[0].name), T.statusMissing).waitFor();
    // the school may send again from scratch
    const f = await rpc('api_schoolForm', schools[0].token);
    assert.equal(f.existing, null); assert.equal(f.canEdit, true);
    await closeClean(h);
  });

  scenario('today: WhatsApp reminder for a missing school carries its private link; share summary', async () => {
    const { token, schools, fields } = await seed.ready();
    await seed.submit(fields, schools[0]);
    const h = await open('mobile', { token });
    const { page } = h;
    await goto(page);
    await UI.text(page, T.notSubmitted).waitFor();
    const popup = h.ctx.waitForEvent('request', (r) => /wa\.me|api\.whatsapp\.com/.test(r.url()));
    await page.locator('.ad-miss').filter({ hasText: SCHOOLS[1].name }).getByRole('button', { name: /تذكير/ }).click();
    const url = decodeURIComponent((await popup).url());
    assert.ok(url.includes('966559876543'), 'sent to the principal\'s number: ' + url);
    assert.ok(url.includes('?s=' + schools[1].token), 'the message carries the school\'s private link');
    assert.ok(url.includes(SCHOOLS[1].name));
    await UI.button(page, /مشاركة/).click();
    const m = UI.modal(page);
    await m.waitFor();
    const text = await m.textContent();
    assert.ok(/التسليم: 1 من 3/.test(text), 'summary has the submission count: ' + text.slice(0, 200));
    await shot(page, 'admin-share-summary-mobile');
    await closeClean(h);
  });

  scenario('form builder: yes/no + choice questions (moved to the top) → the school answers → the supervisor sees them', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.form).click();
    await idle(page);
    // yes/no, required
    await UI.button(page, T.addQuestion).click();
    let m = UI.modal(page);
    await UI.input(m, T.questionLabel).fill('هل نُفّذ الطابور الصباحي؟');
    await UI.button(m, T.typeYesNo).click();
    await m.locator('#fm-req').check();
    await UI.button(m, T.save).click();
    // choice with options
    await UI.button(page, T.addQuestion).click();
    m = UI.modal(page);
    await UI.input(m, T.questionLabel).fill('حالة المبنى المدرسي');
    await UI.button(m, T.typeSelect).click();
    await m.locator('#fm-options').fill('ممتازة\nتحتاج صيانة\nمتوقفة');
    await UI.button(m, T.save).click();
    // move the yes/no question to the top
    for (let i = 0; i < 6; i++) {
      const up = page.getByRole('button', { name: 'تحريك «هل نُفّذ الطابور الصباحي؟» للأعلى' });
      if (await up.isDisabled()) break;
      await up.click();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'admin-form-builder-desktop');
    await UI.button(page, T.saveForm).click();
    await idle(page);
    const fields = (await rpc('api_bootstrap', token)).fields;
    assert.equal(fields[0].label, 'هل نُفّذ الطابور الصباحي؟'); assert.equal(fields[0].type, 'yesno'); assert.equal(fields[0].required, true);
    const sel = fields.find((f) => f.label === 'حالة المبنى المدرسي');
    assert.deepEqual(sel.options, ['ممتازة', 'تحتاج صيانة', 'متوقفة']);
    await closeClean(h);
    // the school must answer the yes/no question
    const hs = await open('mobile');
    await goto(hs.page, 's=' + schools[0].token);
    await fillSchoolForm(hs.page, {});
    await UI.button(hs.page, T.submit).click();
    await hs.page.locator('.field.has-error').filter({ hasText: 'هل نُفّذ الطابور الصباحي؟' }).first().waitFor();
    await UI.field(hs.page, 'هل نُفّذ الطابور الصباحي؟').locator('.choice').filter({ hasText: 'نعم' }).click();
    await UI.field(hs.page, 'حالة المبنى المدرسي').locator('.choice').filter({ hasText: 'تحتاج صيانة' }).click();
    await UI.button(hs.page, T.submit).click();
    await idle(hs.page);
    await UI.text(hs.page, T.sentPending).waitFor();
    await closeClean(hs);
    const rep = (await rpc('api_report', token, '2026-10-14', schools[0].id)).report;
    assert.equal(rep.answers[fields[0].id], true);
    assert.equal(rep.answers[sel.id], 'تحتاج صيانة');
    // the supervisor sees both answers in the details modal
    const hd = await open('desktop', { token });
    await goto(hd.page);
    await UI.reportItem(hd.page, SCHOOLS[0].name).click();
    const md = UI.modal(hd.page);
    await md.getByText('تحتاج صيانة').first().waitFor();
    assert.ok((await md.textContent()).includes('هل نُفّذ الطابور الصباحي؟'));
    await closeClean(hd);
  });

  scenario('statistics: CSV download (UTF-8 with BOM) and the copy-to-Excel fallback', async () => {
    const { token, schools, fields } = await seed.ready();
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-14']) {
      await setClock(d + 'T07:30');
      for (const s of schools) await seed.submit(fields, s);
    }
    const h = await open('desktop', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.stats).click();
    await idle(page);
    await page.waitForFunction(() => document.querySelectorAll('svg[role="img"]').length >= 2);
    const dl = page.waitForEvent('download');
    await UI.button(page, /تنزيل Excel/).click();
    const download = await dl;
    assert.match(download.suggestedFilename(), /^nabd-stats_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    const buf = fs.readFileSync(await download.path());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel shows Arabic correctly');
    const csv = buf.toString('utf8');
    for (const s of SCHOOLS) assert.ok(csv.includes(s.name), 'CSV lists ' + s.name);
    assert.ok(csv.includes('المدرسة') && csv.includes('الالتزام بالتسليم'));
    await page.locator('.toast').getByRole('button', { name: 'اضغط هنا' }).click();
    const m = UI.modal(page);
    await m.waitFor();
    const tsv = await m.locator('textarea').inputValue();
    assert.ok(tsv.includes('\t') && tsv.includes(SCHOOLS[0].name), 'tab-separated copy fallback');
    await closeClean(h);
  });

  scenario('security: «sign out of all devices» ends every session', async () => {
    const token = await seed.setup();
    const other = await seed.login();
    assert.equal((await rpc('api_bootstrap', other)).ok, true);
    const h = await open('mobile', { token });
    const { page } = h;
    await goto(page);
    await UI.nav(page, T.nav.settings).click();
    await idle(page);
    await UI.button(page, /تسجيل الخروج من كل الأجهزة/).click();
    await UI.button(UI.modal(page), /^الخروج من كل الأجهزة$/).click();
    await idle(page);
    await UI.text(page, T.loginTitle).waitFor();
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), UI.sessionKey), null);
    await assert.rejects(rpc('api_bootstrap', token), /AUTH_REQUIRED/);
    await assert.rejects(rpc('api_bootstrap', other), /AUTH_REQUIRED/, 'the other device is signed out too');
    await closeClean(h);
  });

  scenario('school: a network failure on submit keeps the draft (even after a reload) and «إعادة المحاولة» sends it', async () => {
    const { token, schools } = await seed.ready();
    const h = await open('mobile');
    const { page } = h;
    await goto(page, 's=' + schools[0].token);
    await fillSchoolForm(page, { note: 'مسودة لا يجب أن تضيع' });
    await api('__fail', { fn: 'api_submitReport', network: true });
    await UI.button(page, T.submit).click();
    await idle(page);
    const err = page.locator('#sc-server-error');
    await err.waitFor();
    assert.ok((await err.textContent()).includes('ما كتبته محفوظ'), 'tells the principal nothing is lost');
    await shot(page, 'school-network-error-mobile');
    // the draft survives a reload
    await page.reload(); await idle(page);
    await UI.text(page, 'استعدنا ما كتبته سابقًا').waitFor();
    assert.equal(await UI.input(page, T.note).inputValue(), 'مسودة لا يجب أن تضيع');
    assert.equal(await UI.attInputs(page, T.rowStudents).nth(0).inputValue(), '380');
    await api('__fail', { fn: 'api_submitReport', network: true });
    await UI.button(page, T.submit).click();
    await idle(page);
    await UI.button(page.locator('#sc-server-error'), /إعادة المحاولة/).click();
    await idle(page);
    await UI.text(page, T.sentPending).waitFor();
    const rep = (await rpc('api_report', token, '2026-10-14', schools[0].id)).report;
    assert.ok(Object.values(rep.answers).includes('مسودة لا يجب أن تضيع'));
    // the draft is cleared after success
    const drafts = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('nabd:draft:') === 0));
    assert.deepEqual(drafts, []);
    await closeClean(h);
  });

  scenario('mobile admin tour: report details sheet, schools, form, settings (screenshots)', async () => {
    const { token, schools, fields } = await seed.ready();
    await seed.submit(fields, schools[0], { note: 'سير العمل منتظم، وتم تفعيل الإذاعة المدرسية.' });
    await seed.submit(fields, schools[1], { att: { students: { present: 255, absent: 45 } }, planned: 30, done: 21, mode: 'عن بُعد' });
    const h = await open('mobile', { token });
    const { page } = h;
    await goto(page);
    await UI.reportItem(page, SCHOOLS[1].name).locator('.ad-report-card__name').click();
    await UI.modal(page).waitFor();
    await idle(page);
    await shot(page, 'admin-report-details-mobile');
    await page.keyboard.press('Escape');
    await UI.nav(page, T.nav.schools).click();
    await idle(page);
    await schoolMenu(page, SCHOOLS[0].name, null);
    await shot(page, 'admin-school-actions-mobile');
    await page.keyboard.press('Escape');
    await UI.button(page, /إرسال الروابط/).click();
    await UI.modal(page).waitFor();
    await shot(page, 'admin-send-links-mobile');
    await page.keyboard.press('Escape');
    await UI.nav(page, T.nav.form).click();
    await idle(page);
    await shot(page, 'admin-form-mobile');
    await UI.nav(page, T.nav.settings).click();
    await idle(page);
    await shot(page, 'admin-settings-mobile');
    await closeClean(h);
  });
});

/** Opens a school's «…» actions sheet on the Schools page and (optionally) picks an action. */
async function schoolMenu(page, schoolName, actionLabel) {
  await page.getByRole('button', { name: 'خيارات «' + schoolName + '»' }).filter({ visible: true }).first().click();
  const m = UI.modal(page);
  await m.waitFor();
  if (actionLabel) await m.getByRole('button', { name: actionLabel }).first().click();
}
async function saveSettingsCard(page, group) {
  const btn = page.locator('#set-' + group + ' [data-action="save-settings"]');
  await btn.click();
  await idle(page);
  await page.locator('#set-' + group + ' [data-cleanmsg]').filter({ visible: true }).waitFor();
}
async function pickSchool(page, schoolName, pin) {
  await UI.text(page, T.pickerTitle).waitFor();
  if (await UI.pickerSelect(page).count()) await UI.pickerSelect(page).selectOption({ label: schoolName });
  else await UI.text(page, schoolName).click();
  await UI.pinInput(page).fill(pin);
  await UI.button(page, T.enter).click();
  await idle(page);
}

async function page_hasModal(page) { return (await page.locator('.modal').filter({ visible: true }).count()) > 0; }


