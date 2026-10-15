#!/usr/bin/env node
/*
 * build-demo.js — builds dist/demo.html: the interactive, self-contained demo of «نبض المدارس»
 * (Node built-ins only; deterministic: the same inputs always give the same bytes).
 *
 *   node tools/build-demo.js            → writes dist/demo.html (after a self-check)
 *   node tools/build-demo.js --check    → writes nothing; exit 1 when dist/demo.html is out of date
 *   node tools/build-demo.js --no-verify → skip the self-check (faster)
 *   node tools/build-demo.js --out FILE  → write somewhere else
 *
 *   const d = require('./tools/build-demo.js');
 *   d.build({ srcDir })      → { html, buildId, bytes }          (pure)
 *   d.compileCode(code)      → { factorySource, params, names }  (Code.gs wrapped for an eval-free page)
 *   d.demoSeed(ctx)          → Promise<{ token, today, schools }> (seeds an env through the real api_*)
 *
 * What the page is: the REAL src/Code.gs runs in the browser on top of the isomorphic Apps Script mock
 * (test/gas-mock.js + GasRuntime.loadAppPrecompiled from test/runtime.js). The real School / Admin pages
 * render inside srcdoc iframes; their google.script.run calls the parent page's in-memory backend with
 * a realistic delay. Code.gs is shipped as a real <script> (a factory function), so the page needs no
 * eval / new Function and works under a strict Content-Security-Policy.
 *
 * The page follows the claude.ai Artifact contract: no doctype/html/head/body tags (the host wraps the
 * file), <title> + viewport-fit meta first, scripts only from cdnjs (the app's QR library), styles only
 * from Google Fonts, everything else inline. The demo shell is theme-aware; the app keeps its own light
 * design inside the frames.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SRC = path.join(ROOT, 'src');
const DEFAULT_OUT = path.join(ROOT, 'dist', 'demo.html');
const MOCK_FILE = path.join(ROOT, 'test', 'gas-mock.js');
const RUNTIME_FILE = path.join(ROOT, 'test', 'runtime.js');
/** Bump when the page layout or the stored-state format changes (part of the build id). */
const DEMO_FORMAT = 2;
const PAGES = ['Styles', 'Common', 'School', 'Admin'];
/** A stand-in deployment URL: the app only builds links from real '/exec' URLs; the shell intercepts it. */
const DEMO_URL = 'https://script.google.com/macros/s/AKfycbNabdDemo_SampleDataOnly/exec';
const OWNER = 'ahmad.supervisor@gmail.com';
const SS_NAME = 'نبض المدارس — البيانات (تجريبي)';
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap';

class BuildError extends Error {}
function fail(msg) { throw new BuildError(msg); }

/* ================================================================== 1. seed (browser + Node) */
/**
 * Seeds a fresh env with a realistic supervisor: setup through the real OTP flow, 8 schools, about three
 * weeks of workdays (07:00–13:00 each day: submissions, late ones, missing ones, reviews, returns and
 * corrections, photos, the 10:00 digest), then today up to the current time, then a fresh login.
 * Everything goes through the real api_* functions with the mock clock moved; the clock is real again
 * at the end. ctx = { GasMock, env, app, now, photo(kind) → upload payload, step(frac, label) → Promise,
 * uaFirst, uaNow, seed }.
 */
async function demoSeed(ctx) {
  var GasMock = ctx.GasMock, env = ctx.env, app = ctx.app;
  var TZ = 'Asia/Riyadh';
  var step = ctx.step || function () { return Promise.resolve(); };
  var seedState = (ctx.seed || 14481) >>> 0;
  function R() {
    seedState = (seedState + 0x6D2B79F5) >>> 0;
    var t = seedState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rnd(a, b) { return a + (b - a) * R(); }
  function pick(list) { return list[Math.floor(R() * list.length)]; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(hours) { var m = Math.round(hours * 60); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function plusMin(t, n) { var p = t.split(':'); var m = +p[0] * 60 + +p[1] + n; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function addDays(iso, n) { var p = iso.split('-'); return GasMock.formatDate(Date.UTC(+p[0], +p[1] - 1, +p[2] + n, 12), 'UTC', 'yyyy-MM-dd'); }
  function weekday(iso) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); }
  function at(date, t) { env.clock.set(date + 'T' + t); }
  function call(fn) {
    var r = app.call.apply(app, arguments);
    if (r && r.ok === false) throw new Error('[demo seed] ' + fn + ': ' + (r.error || r.code));
    return r;
  }
  function lastCode() {
    var m = env.mailbox[env.mailbox.length - 1];
    var x = m && /(\d{6})/.exec(m.subject || '');
    if (!x) throw new Error('[demo seed] no login code was emailed');
    return x[1];
  }

  var SCHOOLS = [
    { name: 'ابتدائية الملك عبدالعزيز', stage: 'ابتدائي', ministryNo: '310245', principal: 'أ. عبدالله الحربي', phone: '0551234501', students: 420, teachers: 32, staff: 9, lessons: 112, abs: [2.2, 4.6], tAbs: [0, 1], early: [6.9, 7.5] },
    { name: 'متوسطة الإمام الشافعي', stage: 'متوسط', ministryNo: '310372', principal: 'أ. سعد القحطاني', phone: '0551234502', students: 315, teachers: 26, staff: 7, lessons: 84, abs: [3.5, 7.2], tAbs: [0, 2], early: [7.1, 8.1] },
    { name: 'ثانوية الأمير سلطان', stage: 'ثانوي', ministryNo: '310418', principal: 'أ. فهد الشمري', phone: '0551234503', students: 540, teachers: 41, staff: 11, lessons: 126, abs: [7.2, 11.8], tAbs: [1, 3], early: [7.6, 8.8], lateP: 0.3 },
    { name: 'ابتدائية حطين', stage: 'ابتدائي', ministryNo: '310527', principal: 'أ. ناصر الدوسري', phone: '0551234504', students: 380, teachers: 28, staff: 8, lessons: 98, abs: [3, 6], tAbs: [0, 2], early: [7.2, 8.4], missP: 0.15 },
    { name: 'متوسطة عمر بن الخطاب', stage: 'متوسط', ministryNo: '310633', principal: 'أ. ماجد العتيبي', phone: '0551234505', students: 290, teachers: 24, staff: 6, lessons: 78, abs: [4, 7], tAbs: [0, 2], early: [7.3, 8.3], act: [0.76, 0.9] },
    { name: 'ثانوية الملك فهد', stage: 'ثانوي', ministryNo: '310741', principal: 'أ. خالد الزهراني', phone: '0551234506', students: 610, teachers: 45, staff: 12, lessons: 140, abs: [5, 8.5], tAbs: [1, 4], early: [7.4, 8.6], lateP: 0.1 },
    { name: 'ابتدائية النرجس', stage: 'ابتدائي', ministryNo: '310856', principal: 'أ. محمد الغامدي', phone: '0551234507', students: 450, teachers: 34, staff: 9, lessons: 118, abs: [2, 4.8], tAbs: [0, 1], early: [6.95, 7.7] },
    { name: 'مجمع الفيصل التعليمي', stage: 'مجمع', ministryNo: '310962', principal: 'أ. تركي المطيري', phone: '0551234508', students: 720, teachers: 52, staff: 14, lessons: 168, abs: [5, 8.6], tAbs: [1, 4], early: [7.5, 8.7], missP: 0.12, lateP: 0.15 }
  ];
  var NOTES = [
    'سير اليوم الدراسي بشكل منتظم ولله الحمد.',
    'تنفيذ الطابور الصباحي وبرنامج الإذاعة المدرسية.',
    'متابعة المرشد الطلابي لحالات الغياب المتكرر والتواصل مع أولياء الأمور.',
    'تنفيذ اختبارات قصيرة في الرياضيات والعلوم للصفوف العليا.',
    'غياب معلم بعذر طبي، وتمت تغطية حصصه بحصص الانتظار.',
    'زيارة صفية من وكيل الشؤون التعليمية لعدد من المعلمين.',
    'برنامج توعوي عن السلامة المرورية بالتعاون مع رائد النشاط.',
    'تفعيل الخطة العلاجية للطلاب المتعثرين في القراءة والكتابة.',
    'اجتماع لجنة التميز المدرسي ومناقشة نتائج الاختبارات التشخيصية.',
    'تكريم الطلاب المتميزين في الانضباط المدرسي.'
  ];
  var REMOTE_NOTE = 'تحويل الدراسة إلى التعليم عن بُعد عبر منصة مدرستي بسبب التقلبات الجوية.';

  /* ---- the calendar: 15 workdays before today (Sunday–Thursday; on a weekend today is a workday too) */
  var today = GasMock.formatDate(ctx.now, TZ, 'yyyy-MM-dd');
  var nowHM = GasMock.formatDate(ctx.now, TZ, 'HH:mm');
  var workdays = [0, 1, 2, 3, 4];
  if (workdays.indexOf(weekday(today)) < 0) { workdays.push(weekday(today)); workdays.sort(); }
  var hist = [];
  for (var back = 1; hist.length < 15 && back < 60; back++) {
    var d0 = addDays(today, -back);
    if (workdays.indexOf(weekday(d0)) >= 0) hist.unshift(d0);
  }
  var n = hist.length;
  var holiday = addDays(today, 21);
  while (workdays.indexOf(weekday(holiday)) < 0) holiday = addDays(holiday, 1);

  /* ---- day 0: first visit, OTP login, setup wizard, schools, settings */
  await step(0.04, 'تجهيز ملف البيانات');
  at(hist[0], '06:20');
  app.doGet({});
  call('api_requestCode');
  var tok = call('api_verifyCode', lastCode(), ctx.uaFirst || 'Chrome — Windows').token;
  call('api_completeSetup', tok, {
    supervisor: { name: 'أ. أحمد المشرف', title: 'المشرف التربوي', office: 'مكتب التعليم (بيانات تجريبية)', phone: '0550000000' },
    systemTitle: '', schoolsText: '', preset: 'standard'
  });
  at(hist[0], '06:35');
  var sch = SCHOOLS.map(function (s) {
    var r = call('api_saveSchool', tok, { name: s.name, stage: s.stage, ministryNo: s.ministryNo, principal: s.principal,
      phone: s.phone, students: s.students, teachers: s.teachers, staff: s.staff });
    return Object.assign({}, s, { id: r.school.id, token: r.school.token, pin: r.school.pin });
  });
  call('api_saveSettings', tok, { schedule: { workdays: workdays }, digest: { enabled: true, time: '10:00' }, holidays: [holiday] });
  var fields = call('api_bootstrap', tok).fields;
  function fieldWhere(pred) { return fields.filter(pred)[0] || null; }
  var F = {
    mode: fieldWhere(function (f) { return f.kpi === 'mode'; }),
    att: fieldWhere(function (f) { return f.type === 'attendance'; }),
    planned: fieldWhere(function (f) { return f.kpi === 'lessons_planned'; }),
    done: fieldWhere(function (f) { return f.kpi === 'lessons_done'; }),
    note: fieldWhere(function (f) { return f.type === 'textarea'; }),
    photos: fieldWhere(function (f) { return f.type === 'photos'; })
  };

  /* ---- one school's report for one day */
  function makePlan(i, date, r) {
    var s = sch[i], wd = weekday(date), remote = r === 7;
    var late = !!(s.lateP && R() < s.lateP);
    var t = late ? rnd(9.1, 10.25) : Math.min(8.9, rnd(s.early[0], s.early[1]));
    var absPct = rnd(s.abs[0], s.abs[1]) + (wd === 4 ? 1.6 : 0) + (remote ? 3.2 : 0);
    var act = s.act ? rnd(s.act[0], s.act[1]) : rnd(0.955, 1);
    if (remote) act = Math.min(act, rnd(0.86, 0.94));
    return {
      i: i, date: date, time: hm(t), missing: false,
      sa: Math.round(s.students * absPct / 100),
      ta: Math.max(0, Math.min(s.teachers, Math.round(rnd(s.tAbs[0] - 0.49, s.tAbs[1] + 0.49)))),
      fa: R() < 0.25 ? 1 : 0,
      planned: s.lessons,
      done: Math.min(s.lessons, Math.round(s.lessons * act)),
      mode: remote || (i === 1 && r === 11) ? 'عن بُعد' : 'حضوري',
      note: remote ? REMOTE_NOTE : (R() < 0.55 ? pick(NOTES) : ''),
      photos: [], review: 'approve', reviewAt: null, returnNote: '', fix: null
    };
  }
  function answersOf(p, photos) {
    var s = sch[p.i], a = {};
    if (F.mode) a[F.mode.id] = F.mode.options.indexOf(p.mode) >= 0 ? p.mode : F.mode.options[0];
    if (F.att) {
      var att = {}, rows = F.att.rows || ['students', 'teachers', 'staff'];
      if (rows.indexOf('students') >= 0) att.students = { present: s.students - p.sa, absent: p.sa };
      if (rows.indexOf('teachers') >= 0) att.teachers = { present: s.teachers - p.ta, absent: p.ta };
      if (rows.indexOf('staff') >= 0) att.staff = { present: s.staff - p.fa, absent: p.fa };
      a[F.att.id] = att;
    }
    if (F.planned) a[F.planned.id] = p.planned;
    if (F.done) a[F.done.id] = p.done;
    if (F.note && p.note) a[F.note.id] = p.note;
    if (F.photos && photos && photos.length) a[F.photos.id] = photos;
    return a;
  }
  function submit(p, forDate) {
    var s = sch[p.i];
    if (!p.uploaded) {
      p.uploaded = (p.photos || []).map(function (k) { return call('api_uploadPhoto', s.token, ctx.photo(k)).photo; });
    }
    var payload = { answers: answersOf(p, p.uploaded), filledBy: s.principal };
    if (forDate) payload.date = forDate;
    call('api_submitReport', s.token, payload);
  }
  function review(p, action, note) { call('api_review', tok, p.date, sch[p.i].id, action, note || ''); }

  /* ---- history plans (r = workdays back: 0 = the last workday before today) */
  var plans = hist.map(function (date, idx) {
    var r = n - 1 - idx;
    return sch.map(function (s, i) {
      var p = makePlan(i, date, r);
      if (s.missP && r >= 3 && R() < s.missP) p.missing = true;
      return p;
    });
  });
  function plan(r, i) { var row = plans[n - 1 - r]; return row ? row[i] : null; }
  function force(r, i, o) { var p = plan(r, i); if (p) { Object.assign(p, o); if (!('missing' in o)) p.missing = false; } return p; }
  // The story the dashboard tells (r = workdays back).
  force(0, 3, { missing: true });                       // no report yesterday → may still send it late
  force(0, 7, { missing: true });
  force(1, 7, { missing: true });                       // two days in a row, and nothing today
  force(0, 2, { sa: Math.round(540 * 0.198), review: 'return', reviewAt: '11:40',
    returnNote: 'عدد الغائبين من الطلاب أعلى بكثير من المعتاد. نأمل مطابقته مع كشف الحضور في نظام نور.',
    fix: { day: 'today', t: '07:15', sa: Math.round(540 * 0.104), note: 'تم تصحيح عدد الغائبين بعد مطابقته مع نظام نور.' } });
  force(0, 4, { review: 'none' });
  force(0, 5, { review: 'none' });
  force(0, 1, { photos: [4], note: 'تنفيذ تجارب عملية في مختبر العلوم لطلاب الصف الثالث المتوسط.' });
  force(1, 6, { review: 'return', reviewAt: '11:30',
    returnNote: 'نأمل إرفاق صور الشواهد لبرنامج الإذاعة المدرسية، وتحديث عدد الحاضرين من الإداريين.' });
  force(1, 5, { ta: 5, photos: [3, 0], note: 'تنفيذ تدريب الإخلاء الوهمي بنجاح خلال 4 دقائق بإشراف الدفاع المدني.' });
  force(1, 2, { time: '09:34' });
  force(2, 6, { photos: [2], note: 'تقديم الإذاعة المدرسية عن قيمة الأمانة بمشاركة طلاب الصف الخامس.' });
  force(4, 3, { review: 'return', reviewAt: '11:10', returnNote: 'مجموع الحصص المفعّلة لا يتطابق مع جدول الحصص. نأمل المراجعة.',
    fix: { day: 3, t: '07:40', done: 96, approveAt: '10:45' } });
  force(5, 7, { photos: [5], note: 'انطلاق دوري كرة القدم بين الفصول ضمن برنامج النشاط.' });
  force(8, 4, { done: 58, review: 'return', reviewAt: '11:20', returnNote: 'نسبة تفعيل الحصص منخفضة. نأمل توضيح السبب في الملاحظة.',
    fix: { day: 8, t: '12:20', note: 'انشغال 4 معلمين بالتدريب في مركز التدريب التربوي، وتمت تغطية بعض الحصص بالانتظار.', approveAt: '13:05' } });

  /* ---- events, day by day */
  var extra = {};   // date → corrections and approvals that happen on a later day
  function later(date, t, run) { (extra[date] = extra[date] || []).push({ t: t, run: run }); }
  function scheduleFix(p) {
    var f = p.fix;
    var date = f.day === 'today' ? today : hist[n - 1 - f.day];
    var forDate = date === p.date ? null : p.date;
    later(date, f.t, function () {
      if (f.sa !== undefined) p.sa = f.sa;
      if (f.done !== undefined) p.done = f.done;
      if (f.note) p.note = f.note;
      submit(p, forDate);
    });
    if (f.approveAt) later(date, f.approveAt, function () { review(p, 'approve'); });
  }
  function runDay(date, list) {
    list.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
    list.forEach(function (ev) { at(date, ev.t); ev.run(); });
  }
  plans.forEach(function (row) { row.forEach(function (p) { if (!p.missing && p.review === 'return' && p.fix) scheduleFix(p); }); });
  for (var idx = 0; idx < n; idx++) {
    var date = hist[idx], r = n - 1 - idx, events = (extra[date] || []).slice();
    var sent = plans[idx].filter(function (p) { return !p.missing; }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
    var slot = '10:32';
    sent.forEach(function (p) {
      events.push({ t: p.time, run: function () { submit(p, null); } });
      if (p.review === 'approve') {
        var due = plusMin(p.time, 25);
        p.reviewAt = due > slot ? due : slot;
        slot = plusMin(p.reviewAt, 3 + Math.floor(R() * 4));
        events.push({ t: p.reviewAt, run: function () { review(p, 'approve'); } });
      } else if (p.review === 'return') {
        events.push({ t: p.reviewAt, run: function () { review(p, 'return', p.returnNote); } });
      }
    });
    if (r <= 2) events.push({ t: '10:00', run: function () { app.runTrigger('dailyDigest'); } });
    runDay(date, events);
    await step(0.08 + 0.8 * (idx + 1) / n, 'تقارير ' + (idx + 1) + ' من ' + n + ' يوم دراسي');
  }

  /* ---- today, up to the current minute */
  var todayPlans = [
    { i: 0, time: '07:06', absPct: 8.3, photos: [0], approveAt: '09:38', note: 'ارتفاع الغياب بسبب موجة الزكام الموسمية بين طلاب الصفوف الأولية.' },
    { i: 1, time: '07:24', photos: [1, 2], approveAt: '09:39', note: 'تقديم الإذاعة المدرسية عن قيمة الأمانة، وتنفيذ حصص الرياضيات وفق الخطة.' },
    { i: 4, time: '07:41', act: 0.74, note: 'انشغال 3 معلمين ببرنامج تدريبي في مركز التدريب التربوي.' },
    { i: 6, time: '07:58' },
    { i: 2, time: '08:14', absPct: 12.6 },
    { i: 5, time: '08:39', ta: 5, approveAt: '09:40', note: 'غياب 5 معلمين بإجازات مرضية واضطرارية، وتمت تغطية حصصهم بالانتظار.' },
    { i: 3, time: '09:21' }
  ];
  var todayEvents = (extra[today] || []).slice();
  todayPlans.forEach(function (o) {
    var p = makePlan(o.i, today, -1), s = sch[o.i];
    p.time = o.time;
    if (o.absPct !== undefined) p.sa = Math.round(s.students * o.absPct / 100);
    if (o.act !== undefined) p.done = Math.round(s.lessons * o.act);
    if (o.ta !== undefined) p.ta = o.ta;
    if (o.note !== undefined) p.note = o.note;
    p.photos = o.photos || [];
    todayEvents.push({ t: p.time, run: function () { submit(p, null); } });
    if (o.approveAt) todayEvents.push({ t: o.approveAt, run: function () { review(p, 'approve'); } });
  });
  todayEvents.push({ t: '10:00', run: function () { app.runTrigger('dailyDigest'); } });
  runDay(today, todayEvents.filter(function (ev) { return ev.t < nowHM; }));
  await step(0.94, 'تسجيل دخول المشرف');

  /* ---- back to real time; this device signs in with a fresh one-time code */
  env.clock.real();
  call('api_requestCode');
  var session = call('api_verifyCode', lastCode(), ctx.uaNow || 'Chrome — Android').token;
  await step(1, 'جاهز');
  return {
    token: session,
    today: today,
    schools: sch.map(function (s) { return { id: s.id, name: s.name, token: s.token, pin: s.pin, filledBy: s.principal }; })
  };
}

/* ================================================================== 2. evidence photos (browser) */
/** Draws a small sample "evidence photo" (flat illustration + caption) and returns an upload payload. */
function makeDemoPhoto(kind) {
  var W = 640, H = 480, TITLES = ['الطابور الصباحي', 'حصة دراسية', 'الإذاعة المدرسية', 'تدريب الإخلاء', 'حصة المختبر', 'النشاط الرياضي'];
  var k = ((kind | 0) % TITLES.length + TITLES.length) % TITLES.length;
  var c = document.createElement('canvas');
  c.width = W; c.height = H;
  var g = c.getContext('2d');
  var FONT = '"IBM Plex Sans Arabic", Tahoma, "Segoe UI", Arial, sans-serif';
  function rect(x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }
  function circle(x, y, r, col) { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
  function round(x, y, w, h, r, col) {
    g.fillStyle = col; g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.fill();
  }
  function grad(top, bottom, y0, y1) { var gr = g.createLinearGradient(0, y0 || 0, 0, y1 || H); gr.addColorStop(0, top); gr.addColorStop(1, bottom); return gr; }
  function text(s, x, y, size, col, weight) {
    g.fillStyle = col; g.font = (weight || 600) + ' ' + size + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    try { g.direction = 'rtl'; } catch (e) { /* older canvas */ }
    g.fillText(s, x, y);
  }
  var SKIN = ['#C68B59', '#B97A4C', '#D4A373', '#A86B42'];
  function student(x, y, s, i, cap) {
    round(x - 9 * s, y, 18 * s, 34 * s, 6 * s, '#FFFFFF');
    g.strokeStyle = 'rgba(16,34,43,.18)'; g.lineWidth = 1; g.strokeRect(x - 9 * s + 0.5, y + 0.5, 18 * s - 1, 34 * s - 1);
    circle(x, y - 7 * s, 7.5 * s, SKIN[i % SKIN.length]);
    if (cap) { g.fillStyle = (i % 3) ? '#D83A3A' : '#FFFFFF'; g.beginPath(); g.moveTo(x - 9 * s, y - 6 * s); g.lineTo(x, y - 17 * s); g.lineTo(x + 9 * s, y - 6 * s); g.fill(); }
  }
  function building(x, y, w, h) {
    rect(x, y, w, h, '#E9DCC0');
    rect(x, y, w, 10, '#CDBB95');
    for (var r = 0; r < 3; r++) for (var cc = 0; cc < Math.floor(w / 56); cc++) rect(x + 18 + cc * 56, y + 26 + r * 46, 30, 26, '#9CC7DD');
  }
  var scenes = [
    function assembly() {
      rect(0, 0, W, H, grad('#BEE3F3', '#EAF6FB', 0, 260));
      circle(90, 70, 34, '#FFE08A');
      building(40, 110, 560, 170);
      rect(0, 280, W, H, '#DCCBA6');
      rect(560, 70, 5, 210, '#7D8B92');
      rect(565, 72, 62, 40, '#0E7C66'); rect(575, 98, 40, 3, '#FFFFFF');
      for (var row = 0; row < 4; row++) for (var col = 0; col < 11; col++) student(70 + col * 46 + (row % 2) * 12, 300 + row * 34, 0.8 + row * 0.08, row * 11 + col, true);
    },
    function classroom() {
      rect(0, 0, W, H, '#F2ECE0');
      rect(70, 40, 500, 180, '#8A6A45'); rect(80, 50, 480, 160, '#2F5D50');
      text('العلوم', 320, 98, 38, '#F4F1E8', 700);
      g.strokeStyle = '#F4F1E8'; g.lineWidth = 3; g.beginPath(); g.moveTo(200, 160); g.lineTo(440, 160); g.stroke();
      student(560, 230, 1.3, 2, true);
      rect(0, 300, W, H, '#E2D5BC');
      for (var row = 0; row < 3; row++) for (var col = 0; col < 5; col++) {
        var x = 80 + col * 112, y = 290 + row * 52;
        circle(x + 30, y - 6, 11, SKIN[(row + col) % 4]);
        rect(x, y, 64, 18, '#A8743F');
      }
    },
    function radio() {
      rect(0, 0, W, H, grad('#CFE8E1', '#F3F8F6', 0, H));
      rect(80, 40, 480, 70, '#0E7C66');
      text('الإذاعة المدرسية', 320, 76, 36, '#FFFFFF', 700);
      rect(60, 250, 520, 40, '#8C5A3C');
      rect(316, 170, 6, 80, '#56636A'); circle(319, 166, 10, '#2F3A40');
      student(250, 196, 1.3, 1, true); student(390, 196, 1.3, 3, true); student(460, 200, 1.2, 2, false);
      for (var i = 0; i < 12; i++) circle(40 + i * 52, 380 + (i % 2) * 14, 18, SKIN[i % 4]);
      rect(0, 400, W, H, '#E7DCC6');
    },
    function drill() {
      rect(0, 0, W, H, grad('#BFE0F0', '#EEF7FB', 0, 240));
      building(30, 90, 340, 190);
      rect(0, 280, W, H, '#D9CBA9');
      rect(470, 150, 130, 80, '#1E8A4C'); text('نقطة التجمع', 535, 190, 22, '#FFFFFF', 700);
      rect(532, 230, 6, 70, '#56636A');
      for (var i = 0; i < 9; i++) student(140 + i * 40, 320 + (i % 2) * 8, 0.95, i, true);
      round(500, 330, 22, 40, 6, '#F28C28'); circle(511, 322, 9, SKIN[1]);
    },
    function lab() {
      rect(0, 0, W, H, '#EEF2F4');
      rect(420, 40, 170, 120, '#9CC7DD'); rect(503, 40, 4, 120, '#FFFFFF'); rect(420, 98, 170, 4, '#FFFFFF');
      rect(40, 260, 560, 30, '#55666F'); rect(60, 290, 20, 120, '#55666F'); rect(560, 290, 20, 120, '#55666F');
      var cols = ['#2D9CDB', '#27AE60', '#EB5757', '#F2C94C', '#9B51E0'];
      for (var i = 0; i < 5; i++) { var x = 110 + i * 95; circle(x, 236, 22, cols[i]); rect(x - 6, 190, 12, 30, '#DDE6EA'); }
      student(150, 330, 1.2, 0, true); student(320, 330, 1.2, 2, true); student(480, 330, 1.2, 3, true);
      text('مختبر العلوم', 200, 90, 30, '#0A6453', 700);
    },
    function sports() {
      rect(0, 0, W, H, grad('#BFE3F3', '#E9F6FB', 0, 160));
      rect(0, 160, W, H, '#3E9B57');
      for (var i = 0; i < 8; i++) rect(i * 80, 160, 40, H, 'rgba(255,255,255,.06)');
      g.strokeStyle = '#FFFFFF'; g.lineWidth = 4; g.strokeRect(40, 190, 560, 230);
      g.beginPath(); g.arc(320, 305, 46, 0, Math.PI * 2); g.stroke();
      rect(36, 260, 8, 90, '#FFFFFF'); rect(596, 260, 8, 90, '#FFFFFF');
      circle(360, 330, 11, '#FFFFFF');
      student(250, 280, 1.1, 0, false); student(420, 300, 1.1, 1, false); student(180, 340, 1.1, 2, false); student(500, 250, 1.1, 3, false);
    }
  ];
  scenes[k]();
  rect(0, H - 54, W, 54, 'rgba(8,79,66,.88)');
  text('صورة تجريبية • ' + TITLES[k], W / 2, H - 27, 22, '#FFFFFF', 600);
  var url = c.toDataURL('image/jpeg', 0.74);
  return { base64: url.slice(url.indexOf(',') + 1), mime: 'image/jpeg', name: TITLES[k] + '.jpg', w: W, h: H };
}

/* ================================================================== 3. the app frame shim (inside each iframe) */
/**
 * Runs first in every app page (a srcdoc iframe): google.script.run on top of the shell's in-memory
 * backend, and the viewer-frame limits handled the way the real app would want: print → a note, file
 * downloads → the app's copy fallback, WhatsApp / Google links → shell dialogs, links to the demo
 * deployment → the matching shell view.
 * Bridge: direct calls when the frame shares the shell's origin (the normal case); postMessage when the
 * host sandboxes the page without allow-same-origin (every frame then gets its own opaque origin).
 * CFG = { frameId, fns, parameter, parameters, demoUrl, channel, storage }.
 */
function frameShim(CFG) {
  'use strict';
  var W = window, D = document, P = null;
  try { P = W.parent && W.parent !== W ? (W.parent.NabdDemo || null) : null; } catch (e) { P = null; }
  W.__nabdDemoFrame = CFG.frameId;
  W.__nabdDemoBridge = P ? 'direct' : 'message';

  var seq = 0, waiting = {};
  function post(msg) {
    msg.nabdDemo = CFG.channel; msg.frameId = CFG.frameId;
    try { W.parent.postMessage(msg, '*'); } catch (e) { /* no parent */ }
  }
  var bridge = P ? {
    exec: function (name, json, done) {
      var wait = 250;
      try { wait = P.latency(name, json.length); } catch (e) { wait = 250; }
      setTimeout(function () { var out = null; try { out = P.exec(CFG.frameId, name, json); } catch (e) { out = null; } done(out); }, wait);
    },
    send: function (kind, value) { try { P[kind](value); } catch (e) { /* ignore */ } }
  } : {
    exec: function (name, json, done) { var id = ++seq; waiting[id] = done; post({ kind: 'rpc', id: id, fn: name, json: json }); },
    send: function (kind, value) { post({ kind: kind, value: value }); }
  };
  W.addEventListener('message', function (ev) {
    var d = ev.data;
    if (ev.source !== W.parent || !d || d.nabdDemo !== CFG.channel) return;
    if (d.kind === 'rpc-result') { var cb = waiting[d.id]; delete waiting[d.id]; if (cb) cb(d); }
    else if (d.kind === 'refresh') {
      var b = D.querySelector('[data-action="day-refresh"]');
      if (b && b.getClientRects().length) b.click();
    }
  });

  // Storage: when the browser blocks it, the app pages share the shell's in-memory store.
  try { W.localStorage.getItem('nabd:probe'); } catch (e) {
    var mem = P && P.memStorage ? P.memStorage : (function (seed) {
      var data = Object.create(null);
      Object.keys(seed || {}).forEach(function (k) { data[k] = String(seed[k]); });
      var api = {
        getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function (k, v) { data[String(k)] = String(v); post({ kind: 'store', op: 'set', k: String(k), v: String(v) }); },
        removeItem: function (k) { delete data[String(k)]; post({ kind: 'store', op: 'del', k: String(k) }); },
        clear: function () { Object.keys(data).forEach(function (k) { api.removeItem(k); }); },
        key: function (i) { var ks = Object.keys(data); return i >= 0 && i < ks.length ? ks[i] : null; }
      };
      Object.defineProperty(api, 'length', { get: function () { return Object.keys(data).length; } });
      return api;
    }(CFG.storage));
    try { Object.defineProperty(W, 'localStorage', { configurable: true, enumerable: true, get: function () { return mem; } }); } catch (e2) { /* App.store keeps a per-page copy */ }
  }
  // The viewer frame shows no native dialogs (the app never uses them).
  W.alert = function () {};
  W.confirm = function () { return false; };
  W.prompt = function () { return null; };

  function note(msg) {
    try { if (W.App && typeof W.App.toast === 'function') { W.App.toast(msg, 'info', 4500); return; } } catch (e) { /* fall through */ }
    bridge.send('toast', msg);
  }
  var PRINT_NOTE = 'الطباعة متاحة في النسخة الحقيقية — هنا معاينة فقط';
  var DOWNLOAD_NOTE = 'التنزيل متاح في النسخة الحقيقية — هنا معاينة فقط';
  W.print = function () {
    note(PRINT_NOTE);
    setTimeout(function () { try { W.dispatchEvent(new Event('afterprint')); } catch (e) { /* ignore */ } }, 120);
  };
  // Files the page would save (Excel/CSV) cannot leave the viewer: the app then offers its copy dialog.
  if (W.URL && typeof W.URL.createObjectURL === 'function') {
    var createUrl = W.URL.createObjectURL;
    W.URL.createObjectURL = function (obj) {
      if (obj && typeof obj.type === 'string' && /^(text\/|application\/(vnd|octet|pdf|json|zip))/i.test(obj.type)) {
        throw new Error('Saving files is not available in the demo');
      }
      return createUrl.apply(W.URL, arguments);
    };
  }

  /* ---- google.script.* */
  var pending = 0;
  W.__gasPending = 0;
  function scriptError(msg) { var e = new Error(msg); e.name = 'ScriptError'; return e; }
  function illegal(v, key, seen) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'function' || t === 'symbol') return key;
    if (t !== 'object') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return key;
    if (typeof Node !== 'undefined' && v instanceof Node) return key;
    if (seen.indexOf(v) >= 0) return key;
    seen.push(v);
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) { var r = illegal(v[keys[i]], keys[i], seen); if (r !== null) return r; }
    seen.pop();
    return null;
  }
  function invoke(st, name, argsLike) {
    var args = Array.prototype.slice.call(argsLike);
    for (var i = 0; i < args.length; i++) {
      var bad = illegal(args[i], String(i), []);
      if (bad !== null) throw new Error('Failed due to illegal value in property: ' + bad);
    }
    while (args.length && args[args.length - 1] === undefined) args.pop();
    var json = JSON.stringify(args.map(function (a) { return a === undefined ? null : a; }));
    pending++; W.__gasPending = pending;
    bridge.exec(name, json, function (out) {
      pending = Math.max(0, pending - 1); W.__gasPending = pending;
      var ok = !!(out && out.ok), value, err = null;
      if (ok) {
        try { value = out.json === undefined || out.json === null ? undefined : JSON.parse(out.json); }
        catch (e) { ok = false; err = scriptError('Unknown server error'); }
      } else {
        err = scriptError(out ? String(out.error || 'Unknown server error') : 'NetworkError: Connection failure due to HTTP 0');
      }
      if (ok) { if (typeof st.s === 'function') st.s(value, st.u); }
      else if (typeof st.f === 'function') st.f(err, st.u);
      else throw err;
    });
  }
  function makeRunner(s, f, u) {
    var st = { s: s || null, f: f || null, u: u };
    var r = {
      withSuccessHandler: function (fn) { return makeRunner(fn, st.f, st.u); },
      withFailureHandler: function (fn) { return makeRunner(st.s, fn, st.u); },
      withUserObject: function (o) { return makeRunner(st.s, st.f, o); }
    };
    (CFG.fns || []).forEach(function (name) {
      if (name in r) return;
      r[name] = function () { invoke(st, name, arguments); };
    });
    return r;
  }
  W.google = W.google || {};
  W.google.script = {
    run: makeRunner(),
    url: { getLocation: function (cb) { setTimeout(function () { cb({ hash: '', parameter: CFG.parameter || {}, parameters: CFG.parameters || {} }); }, 0); } },
    history: { push: function () {}, replace: function () {}, setChangeHandler: function () {} },
    host: { origin: W.location.origin, close: function () {}, setHeight: function () {}, setWidth: function () {}, editor: { focus: function () {} } }
  };

  /* ---- links and new windows */
  var openWindow = W.open;
  function fakeWindow() {
    return { closed: false, opener: null, focus: function () {}, blur: function () {}, close: function () {}, postMessage: function () {}, location: { href: 'about:blank' }, document: null };
  }
  function route(href) {
    href = String(href || '');
    if (!href) return false;
    if (CFG.demoUrl && href.indexOf(CFG.demoUrl) === 0) { bridge.send('navigate', href); return true; }
    if (/^(https?:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\/|whatsapp:)/i.test(href)) { bridge.send('whatsapp', href); return true; }
    if (/^https?:\/\/(docs|drive|script)\.google\.com\//i.test(href)) { bridge.send('external', href); return true; }
    return false;
  }
  W.open = function (url) {
    if (route(url)) return fakeWindow();
    try { return openWindow ? openWindow.apply(W, arguments) : null; } catch (e) { return null; }
  };
  D.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (a.hasAttribute('download')) { ev.preventDefault(); note(DOWNLOAD_NOTE); return; }
    if (route(href)) { ev.preventDefault(); return; }
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel|sms|blob|data):/i.test(href)) return;
    if ((a.getAttribute('target') || '').toLowerCase() === '_blank') return;
    ev.preventDefault();   // would replace the app inside its frame
    if (/^https?:/i.test(href)) { try { if (openWindow) openWindow.call(W, href, '_blank', 'noopener'); } catch (e) { /* ignore */ } }
  }, true);
}

/* ================================================================== 4. the shell (browser) */
function shellMain(B) {
  'use strict';
  var doc = document, W = window;
  var GasMock = W.GasMock, GasRuntime = W.GasRuntime;
  var TZ = 'Asia/Riyadh';
  var KEY_STATE = 'nabd-demo:state', KEY_UI = 'nabd-demo:ui', KEY_WELCOME = 'nabd-demo:welcomed';
  var READ_FNS = { api_schoolForm: 1, api_schoolPhoto: 1, api_bootstrap: 1, api_day: 1, api_report: 1, api_photo: 1,
    api_range: 1, api_schools: 1, api_getSettings: 1 };
  var SCHOOL_FNS = { api_completeSetup: 1, api_saveSchool: 1, api_bulkAddSchools: 1, api_setSchoolActive: 1,
    api_regenerateLink: 1, api_regeneratePin: 1, api_deleteSchool: 1 };
  var VIEW_LABELS = { admin: 'لوحة المشرف', school: 'صفحة المدرسة', general: 'الرابط العام' };
  var SHIM_SRC = frameShim.toString();
  var CHANNEL = 'nabd-demo-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var S = { env: null, app: null, fns: [], meta: null, version: 0, frames: {}, view: 'admin', schoolId: null,
    override: null, schoolDate: null, schools: [], mailSeen: 0, unread: 0, saveFailed: false, saveNoticeShown: false,
    persistTimer: null, recent: {}, latencyScale: 1, ready: false, drawerPage: null, mailId: null, digestTried: '' };

  /* ---------------------------------------------------------------- small helpers */
  function $(id) { return doc.getElementById(id); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayRiyadh() { return GasMock.formatDate(Date.now(), TZ, 'yyyy-MM-dd'); }
  function icon(name) { return B.icons[name] || ''; }
  function safeJson(v) { return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
  function dedupe(key) { var now = Date.now(); if (S.recent[key] && now - S.recent[key] < 800) return true; S.recent[key] = now; return false; }
  var DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  var MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  function time12(hhmm) { var p = hhmm.split(':'), h = +p[0]; return (h % 12 || 12) + ':' + p[1] + (h < 12 ? ' ص' : ' م'); }
  function whenLabel(local) {   // 'yyyy-MM-dd HH:mm:ss' (Riyadh)
    var d = String(local || '').slice(0, 10), t = String(local || '').slice(11, 16);
    if (!d) return '';
    var today = todayRiyadh(), p = d.split('-');
    var yest = GasMock.formatDate(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) - 1, 12), 'UTC', 'yyyy-MM-dd');
    var day = d === today ? 'اليوم' : d === yest ? 'أمس' : DAYS[new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()] + ' ' + (+p[2]) + ' ' + MONTHS[+p[1] - 1];
    return day + ' ' + time12(t);
  }
  function uaLabel() {
    var ua = navigator.userAgent || '';
    var os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'Mac' : /CrOS/i.test(ua) ? 'ChromeOS' : /Linux/i.test(ua) ? 'Linux' : 'جهاز';
    var br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/i.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'متصفح';
    return br + ' — ' + os;
  }

  /* ---------------------------------------------------------------- storage */
  var LS = (function () { try { var s = W.localStorage; s.getItem('nabd-demo:probe'); return s; } catch (e) { return null; } }());
  var memData = Object.create(null);
  var memStorage = {
    getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(memData, k) ? memData[k] : null; },
    setItem: function (k, v) { memData[String(k)] = String(v); },
    removeItem: function (k) { delete memData[String(k)]; },
    clear: function () { Object.keys(memData).forEach(function (k) { delete memData[k]; }); },
    key: function (i) { var ks = Object.keys(memData); return i >= 0 && i < ks.length ? ks[i] : null; }
  };
  Object.defineProperty(memStorage, 'length', { get: function () { return Object.keys(memData).length; } });
  var store = LS || memStorage;   // what the app pages see as localStorage when the browser blocks it
  function sGet(k) { try { return store.getItem(k); } catch (e) { return null; } }
  function sSet(k, v) { try { store.setItem(k, v); return true; } catch (e) { return false; } }
  function sDel(k) { try { store.removeItem(k); } catch (e) { /* ignore */ } }
  function appKeys() {
    var out = {};
    try { for (var i = 0; i < store.length; i++) { var k = store.key(i); if (k && k.indexOf('nabd:') === 0) out[k] = store.getItem(k); } } catch (e) { /* ignore */ }
    return out;
  }
  function clearAppKeys() {
    var keys = [];
    try { for (var i = 0; i < store.length; i++) { var k = store.key(i); if (k && k.indexOf('nabd:') === 0) keys.push(k); } } catch (e) { /* ignore */ }
    keys.forEach(sDel);
  }

  /* ---------------------------------------------------------------- backend */
  function fileResolver(name) {
    var n = String(name).replace(/\.html$/, '');
    return Object.prototype.hasOwnProperty.call(B.files, n) ? B.files[n] : null;
  }
  function newBackend(state) {
    var env = GasMock.createGasEnv({ ownerEmail: B.owner, scriptUrl: B.demoUrl, spreadsheetName: B.ssName });
    if (state) env.restore(state);
    env.setManifest(B.manifest);
    var app = GasRuntime.loadAppPrecompiled({ factory: W.__nabdCodeFactory, params: B.params, names: B.names }, env, { files: fileResolver });
    return { env: env, app: app };
  }
  function install(be, meta) {
    destroyFrames();
    S.env = be.env; S.app = be.app; S.meta = meta; S.version = 0;
    S.fns = S.app.publicFunctions();
    S.mailSeen = S.env.mailbox.length; S.unread = 0;
    S.override = null; S.schoolDate = null;
    refreshSchools();
    updateMailBadge();
  }
  function refreshSchools() {
    var list = [];
    try { list = S.app.invoke('readSchools_') || []; } catch (e) { list = []; }
    S.schools = list.map(function (s) {
      return { id: String(s.id), name: String(s.name), token: String(s.token), pin: String(s.pin || ''), active: !!s.active };
    });
    if (!S.schools.some(function (x) { return x.id === S.schoolId; })) {
      // Start with a school that has not sent today's report yet: the form is the principal's experience.
      var sent = todayStatuses(), active = S.schools.filter(function (x) { return x.active; });
      var first = active.filter(function (x) { return !sent[x.id]; })[0] || active[0] || S.schools[0];
      S.schoolId = first ? first.id : null;
    }
    if (S.ready) renderCtx();
  }
  /** schoolId → status label of today's report (read from the «التقارير» sheet). */
  function todayStatuses() {
    var out = {};
    try {
      var sh = S.env.inspect.sheet('التقارير');
      if (!sh || !sh.values.length) return out;
      var h = sh.values[0], cd = h.indexOf('التاريخ'), ci = h.indexOf('معرّف المدرسة'), cs = h.indexOf('الحالة'), today = todayRiyadh();
      if (cd < 0 || ci < 0 || cs < 0) return out;
      sh.values.slice(1).forEach(function (r) { if (String(r[cd]) === today) out[String(r[ci])] = String(r[cs]); });
    } catch (e) { /* the selector simply shows names */ }
    return out;
  }
  function school(id) { return S.schools.filter(function (x) { return x.id === id; })[0] || null; }

  /* ---------------------------------------------------------------- bridge used by the app frames */
  function exec(frameId, fn, json) {
    var out;
    try {
      var args = JSON.parse(json);
      var r = S.app.call.apply(null, [fn].concat(args));
      out = { ok: true, json: r === undefined ? undefined : JSON.stringify(r) };
    } catch (e) {
      out = { ok: false, error: String(e && e.message !== undefined ? e.message : e) };
      if (e && (e.code === 'ILLEGAL_RESULT' || e.code === 'NOT_CALLABLE' || e.code === 'ILLEGAL_ARG' || (e.serverName && e.serverName !== 'Error'))) {
        try { console.warn('[demo] ' + fn + ': ' + out.error); } catch (x) { /* ignore */ }
      }
    }
    try { afterCall(frameId, fn); } catch (e) { /* ignore */ }
    return out;
  }
  function afterCall(frameId, fn) {
    if (!READ_FNS[fn]) {
      var f = S.frames[frameId], current = !f || f.seen >= S.version;
      S.version++;
      if (f && current) f.seen = S.version;
      persistSoon();
    }
    if (SCHOOL_FNS[fn]) refreshSchools();
    else if (!READ_FNS[fn] && S.view === 'school' && S.ready) renderCtx();
    checkMail();
  }
  function latency(fn, size) {
    var base = 170 + Math.random() * 150 + Math.min(1400, (size || 0) / 900);
    return Math.round(base * S.latencyScale);
  }
  function parseQuery(qs) {
    var out = {};
    String(qs || '').replace(/^[^?]*\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('='), k = i < 0 ? pair : pair.slice(0, i), v = i < 0 ? '' : pair.slice(i + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
      if (!(k in out)) out[k] = v;
    });
    return out;
  }
  function navigate(href) {
    if (dedupe('nav:' + href)) return;
    var q = parseQuery(String(href).slice(B.demoUrl.length));
    if (q.f === 'all') { show('general', { reload: true }); return; }
    if (q.s) {
      var tok = q.s.replace(/[^A-Za-z0-9_]/g, '');
      var sc = S.schools.filter(function (x) { return x.token === tok; })[0];
      if (sc) { S.schoolId = sc.id; S.override = null; }
      else S.override = { token: tok, label: tok === '__preview' ? 'معاينة النموذج' : 'رابط قديم أو غير صحيح' };
      S.schoolDate = /^\d{4}-\d{2}-\d{2}$/.test(q.d || '') ? q.d : null;
      show('school', { reload: true });
      return;
    }
    show('admin');
  }

  /* ---------------------------------------------------------------- frames */
  function ensureFrame(view) {
    var f = S.frames[view];
    if (f) return f;
    var box = doc.createElement('div');
    box.className = 'nd-frame is-hidden';
    box.setAttribute('data-frame', view);
    var ifr = doc.createElement('iframe');
    ifr.title = VIEW_LABELS[view];
    ifr.setAttribute('allow', 'clipboard-write');
    box.appendChild(ifr);
    $('nd-screen').appendChild(box);
    f = S.frames[view] = { view: view, box: box, iframe: ifr, seen: -1, n: 0 };
    return f;
  }
  function destroyFrames() {
    Object.keys(S.frames).forEach(function (k) { var f = S.frames[k]; if (f.box.parentNode) f.box.parentNode.removeChild(f.box); });
    S.frames = {};
  }
  function paramsFor(view) {
    if (view === 'admin') return {};
    if (view === 'general') return { f: 'all' };
    var tok = S.override ? S.override.token : (school(S.schoolId) || {}).token;
    if (!tok) return null;
    var p = { s: tok };
    if (S.schoolDate) p.d = S.schoolDate;
    return p;
  }
  function placeholderHtml() {
    return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>' +
      'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F5F7F8;color:#10222B;' +
      'font:15px/1.8 "IBM Plex Sans Arabic",Tahoma,sans-serif;padding:24px;box-sizing:border-box}' +
      '.c{max-width:420px;background:#fff;border:1px solid #E2E8EA;border-radius:18px;padding:28px 24px;text-align:center}' +
      'h1{font-size:19px;margin:0 0 8px;color:#084F42}p{margin:0;color:#3E5360}</style></head><body><div class="c">' +
      '<h1>لا توجد مدارس بعد</h1><p>أضف المدارس من «لوحة المشرف» ← «المدارس»، ثم ارجع إلى هنا لتجرّب صفحة المدرسة.</p>' +
      '</div></body></html>';
  }
  function errorHtml(e) {
    return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body style="font-family:Tahoma,sans-serif;padding:24px">' +
      '<h1 style="color:#C0392B;font-size:18px">تعذّر فتح الصفحة</h1><p>' + esc(e && e.message || e) + '</p></body></html>';
  }
  function injectShim(html, cfg) {
    var tag = '<script>(' + SHIM_SRC + ')(' + safeJson(cfg) + ');<\/script>';
    var m = /<head\b[^>]*>/i.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
    return tag + html;
  }
  function renderFrame(view) {
    var f = ensureFrame(view);
    var params = paramsFor(view);
    f.seen = S.version; f.n++;
    if (!params) { f.iframe.srcdoc = placeholderHtml(); return; }
    var out;
    try { out = S.app.doGetOutput(params); } catch (e) { out = { html: errorHtml(e), title: VIEW_LABELS[view] }; }
    var parameters = {};
    Object.keys(params).forEach(function (k) { parameters[k] = [params[k]]; });
    f.iframe.title = out.title || VIEW_LABELS[view];
    f.iframe.srcdoc = injectShim(out.html, { frameId: view, fns: S.fns, parameter: params, parameters: parameters, demoUrl: B.demoUrl,
      channel: CHANNEL, storage: LS ? null : appKeys(), n: f.n });
  }
  function refreshFrame(view) {
    var f = S.frames[view];
    if (view === 'admin') {   // the dashboard reloads «today» itself (other admin pages load fresh data when opened)
      f.seen = S.version;
      try { f.iframe.contentWindow.postMessage({ nabdDemo: CHANNEL, kind: 'refresh' }, '*'); } catch (e) { /* ignore */ }
      return;
    }
    renderFrame(view);
  }
  function frameForSource(src) {
    var keys = Object.keys(S.frames);
    for (var i = 0; i < keys.length; i++) if (S.frames[keys[i]].iframe.contentWindow === src) return S.frames[keys[i]];
    return null;
  }
  /** postMessage bridge (used when the host sandboxes the page without allow-same-origin). */
  function onMessage(ev) {
    var d = ev.data;
    if (!d || d.nabdDemo !== CHANNEL || !S.app) return;
    var f = frameForSource(ev.source);
    if (!f) return;
    var src = ev.source;
    if (d.kind === 'rpc') {
      var fn = String(d.fn), json = String(d.json);
      setTimeout(function () {
        var out = exec(f.view, fn, json);
        try { src.postMessage({ nabdDemo: CHANNEL, kind: 'rpc-result', id: d.id, ok: out.ok, json: out.json, error: out.error }, '*'); } catch (e) { /* frame gone */ }
      }, latency(fn, json.length));
    } else if (d.kind === 'navigate') navigate(String(d.value));
    else if (d.kind === 'whatsapp') whatsapp(String(d.value));
    else if (d.kind === 'external') external(String(d.value));
    else if (d.kind === 'toast') toast({ title: String(d.value) });
    else if (d.kind === 'store' && /^nabd:/.test(String(d.k))) {
      if (d.op === 'set') memStorage.setItem(String(d.k), String(d.v)); else if (d.op === 'del') memStorage.removeItem(String(d.k));
    }
  }
  function show(view, o) {
    o = o || {};
    if (!VIEW_LABELS[view]) view = 'admin';
    S.view = view;
    Array.prototype.forEach.call(doc.querySelectorAll('.nd-seg [data-view]'), function (b) {
      var on = b.getAttribute('data-view') === view;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    renderCtx();
    var f = S.frames[view];
    if (!f || o.reload) renderFrame(view);
    else if (f.seen < S.version) refreshFrame(view);
    Object.keys(S.frames).forEach(function (k) {
      var fr = S.frames[k], on = k === view;
      fr.box.classList.toggle('is-hidden', !on);
      if (on) fr.box.removeAttribute('inert'); else fr.box.setAttribute('inert', '');
    });
    saveUi();
  }
  function saveUi() { sSet(KEY_UI, JSON.stringify({ view: S.view, schoolId: S.schoolId })); }

  /* ---------------------------------------------------------------- context row (school picker / hints) */
  function renderCtx() {
    var ctx = $('nd-ctx'), bar = $('nd-bar');
    var html = '';
    if (S.view === 'school') {
      var opts = '', sent = todayStatuses();
      if (S.override) opts += '<option value="__override" selected>' + esc(S.override.label) + '</option>';
      S.schools.forEach(function (s) {
        var note = !s.active ? 'موقوفة' : (sent[s.id] || 'لم ترسل اليوم');
        opts += '<option value="' + esc(s.id) + '"' + (!S.override && s.id === S.schoolId ? ' selected' : '') + '>' + esc(s.name) + ' — ' + esc(note) + '</option>';
      });
      var cur = S.override ? null : school(S.schoolId);
      html = S.schools.length || S.override
        ? '<label class="nd-pick"><span class="nd-sr">اختر المدرسة</span><span class="nd-pick__icon">' + icon('school') + '</span>' +
          '<select id="nd-school" class="nd-pick__select">' + opts + '</select><span class="nd-pick__chev">' + icon('chevron') + '</span></label>' +
          (cur && cur.pin ? '<button type="button" class="nd-chip" data-act="copy-pin" data-pin="' + esc(cur.pin) + '" title="رمز المدرسة للرابط العام — اضغط للنسخ" aria-label="رمز المدرسة ' + esc(cur.pin) + '، اضغط للنسخ">' +
            '<span class="nd-chip__long">رمز المدرسة</span><span class="nd-chip__short">الرمز</span><b dir="ltr">' + esc(cur.pin) + '</b></button>' : '')
        : '<p class="nd-hint">لا توجد مدارس بعد. أضفها من «لوحة المشرف» ← «المدارس».</p>';
    } else if (S.view === 'general') {
      html = '<p class="nd-hint" title="رابط واحد لكل المدارس: يختار المدير مدرسته ثم يكتب رمزها."><span class="nd-hint__long">رابط واحد لكل المدارس: </span>يختار المدير مدرسته ثم يكتب رمزها.</p>' +
        '<button type="button" class="nd-chip nd-chip--btn" data-act="codes">' + icon('hash') + '<span>رموز المدارس</span></button>';
    }
    ctx.innerHTML = html;
    ctx.hidden = !html;
    bar.classList.toggle('has-ctx', !!html);
    var sel = $('nd-school');
    if (sel) sel.addEventListener('change', function () {
      if (sel.value === '__override') return;
      S.schoolId = sel.value; S.override = null; S.schoolDate = null;
      show('school', { reload: true });
    });
  }

  /* ---------------------------------------------------------------- toasts */
  function toast(o) {
    if (typeof o === 'string') o = { title: o };
    var box = $('nd-toasts');
    var el = doc.createElement('div');
    el.className = 'nd-toast' + (o.kind ? ' nd-toast--' + o.kind : '');
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="nd-toast__icon">' + icon(o.icon || 'info') + '</span><div class="nd-toast__body"><div class="nd-toast__title"></div>' +
      (o.text ? '<div class="nd-toast__text"></div>' : '') + '</div><div class="nd-toast__actions"></div>' +
      '<button type="button" class="nd-toast__close" aria-label="إغلاق">' + icon('close') + '</button>';
    if (o.onClick) {
      var body = el.querySelector('.nd-toast__body');
      body.classList.add('is-link');
      body.addEventListener('click', function () { o.onClick(); remove(); });
    }
    el.querySelector('.nd-toast__title').textContent = o.title;
    if (o.text) el.querySelector('.nd-toast__text').textContent = o.text;
    var acts = el.querySelector('.nd-toast__actions');
    (o.actions || []).forEach(function (a) {
      var b = doc.createElement('button');
      b.type = 'button'; b.className = 'nd-toast__btn'; b.textContent = a.label;
      b.addEventListener('click', function () { a.run(); remove(); });
      acts.appendChild(b);
    });
    if (!acts.children.length) acts.parentNode.removeChild(acts);
    var timer = null;
    function remove() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); }
    el.querySelector('.nd-toast__close').addEventListener('click', remove);
    box.appendChild(el);
    while (box.children.length > 2) box.removeChild(box.firstChild);
    timer = setTimeout(remove, o.ms || 4200);
    return remove;
  }

  /* ---------------------------------------------------------------- copy */
  function copyText(text) {
    return new Promise(function (resolve) {
      function fallback() {
        var ta = doc.createElement('textarea'), ok = false;
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0;font-size:16px';
        doc.body.appendChild(ta);
        try { ta.select(); ta.setSelectionRange(0, text.length); ok = !!doc.execCommand('copy'); } catch (e) { ok = false; }
        doc.body.removeChild(ta);
        resolve(ok);
      }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () { resolve(true); }, fallback);
          return;
        }
      } catch (e) { /* fall back */ }
      fallback();
    });
  }
  function copyWithToast(text, okMsg) {
    copyText(text).then(function (ok) { toast(ok ? { title: okMsg, icon: 'check' } : { title: 'تعذّر النسخ تلقائيًا', text: 'حدّد النص وانسخه يدويًا.', icon: 'info' }); });
  }

  /* ---------------------------------------------------------------- modal */
  var modalStack = [];
  function openModal(o) {
    var root = $('nd-modals');
    var wrap = doc.createElement('div');
    wrap.className = 'nd-modal';
    wrap.innerHTML = '<div class="nd-modal__scrim"></div><div class="nd-modal__dialog' + (o.wide ? ' nd-modal__dialog--wide' : '') + '" role="dialog" aria-modal="true">' +
      '<div class="nd-modal__head"><h2 class="nd-modal__title"></h2><button type="button" class="nd-iconbtn nd-iconbtn--ghost" data-close aria-label="إغلاق">' + icon('close') + '</button></div>' +
      '<div class="nd-modal__body"></div><div class="nd-modal__foot"></div></div>';
    var dlg = wrap.querySelector('.nd-modal__dialog');
    var titleId = 'nd-mt-' + Date.now() + '-' + modalStack.length;
    var titleEl = wrap.querySelector('.nd-modal__title');
    titleEl.id = titleId; titleEl.textContent = o.title;
    dlg.setAttribute('aria-labelledby', titleId);
    var body = wrap.querySelector('.nd-modal__body');
    if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
    var foot = wrap.querySelector('.nd-modal__foot');
    var api = { el: wrap, body: body, close: close };
    (o.actions || []).forEach(function (a) {
      var el;
      if (a.href) {
        el = doc.createElement('a');
        el.href = a.href; el.target = '_blank'; el.rel = 'noopener noreferrer';
      } else { el = doc.createElement('button'); el.type = 'button'; }
      el.className = 'nd-btn nd-btn--' + (a.kind || 'secondary');
      el.innerHTML = (a.icon ? icon(a.icon) : '') + '<span></span>';
      el.querySelector('span').textContent = a.label;
      el.addEventListener('click', function () { var keep = a.onClick ? a.onClick(api) === false : false; if (a.href && !a.keepOpen) keep = true; if (!keep) close(); });
      foot.appendChild(el);
    });
    if (!foot.children.length) foot.parentNode.removeChild(foot);
    var prevFocus = doc.activeElement;
    function close() {
      var i = modalStack.indexOf(api);
      if (i >= 0) modalStack.splice(i, 1);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (o.onClose) o.onClose();
      try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    wrap.querySelector('.nd-modal__scrim').addEventListener('click', close);
    wrap.querySelector('[data-close]').addEventListener('click', close);
    root.appendChild(wrap);
    modalStack.push(api);
    dlg.tabIndex = -1;
    setTimeout(function () { try { dlg.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30);
    return api;
  }
  function confirmBox(o) {
    return new Promise(function (resolve) {
      var done = false;
      openModal({
        title: o.title,
        body: '<p class="nd-text">' + esc(o.text) + '</p>',
        actions: [
          { label: o.ok, kind: o.danger ? 'danger' : 'primary', onClick: function () { done = true; resolve(true); } },
          { label: 'إلغاء', kind: 'secondary' }
        ],
        onClose: function () { if (!done) resolve(false); }
      });
    });
  }

  /* ---------------------------------------------------------------- WhatsApp & external links */
  function whatsapp(href) {
    if (dedupe('wa:' + href)) return;
    var phone = '', text = '';
    try {
      var u = new URL(href);
      if (/wa\.me$/i.test(u.hostname)) phone = u.pathname.replace(/\D/g, '');
      else phone = (u.searchParams.get('phone') || '').replace(/\D/g, '');
      text = u.searchParams.get('text') || '';
    } catch (e) { /* show what we can */ }
    var shown = phone ? '+' + phone.replace(/^(966)(\d{2})(\d{3})(\d{4})$/, '$1 $2 $3 $4') : '';
    var body = '<div class="nd-stack">' +
      '<p class="nd-text">في النسخة الحقيقية يفتح واتساب مباشرة وفيه هذه الرسالة جاهزة للإرسال.</p>' +
      '<div class="nd-wa"><div class="nd-wa__to">' + icon('whatsapp') + '<span>' + (shown ? 'إلى: <bdi dir="ltr">' + esc(shown) + '</bdi> (رقم تجريبي)' : 'رسالة لمجموعة أو محادثة تختارها') + '</span></div>' +
      '<div class="nd-wa__bubble" dir="auto">' + esc(text || '—') + '</div></div>' +
      '<p class="nd-hint">الأرقام والروابط هنا تجريبية: يفتح الزر واتساب لتختار المحادثة بنفسك، ورابط المدرسة في الرسالة لا يعمل خارج هذه الصفحة.</p></div>';
    openModal({
      title: 'رسالة واتساب جاهزة',
      body: body,
      actions: [
        { label: 'فتح واتساب', kind: 'wa', icon: 'whatsapp', href: 'https://wa.me/?text=' + encodeURIComponent(text) },
        { label: 'نسخ الرسالة', kind: 'secondary', icon: 'copy', onClick: function () { copyWithToast(text, 'تم نسخ الرسالة'); return false; } }
      ]
    });
  }
  function sheetTable(name) {
    var sh = null;
    try { sh = S.env.inspect.sheet(name); } catch (e) { sh = null; }
    if (!sh || !sh.values.length) return '<p class="nd-hint">الورقة فارغة.</p>';
    var HIDE = ['المفتاح', 'معرّف المدرسة', 'البيانات', 'المعرّف', 'رمز الرابط'];
    var keep = [];
    sh.values[0].forEach(function (h, i) { if (HIDE.indexOf(String(h)) < 0) keep.push(i); });
    var pickCols = function (r) { return keep.map(function (i) { return r[i]; }); };
    var head = pickCols(sh.values[0]), rows = sh.values.slice(1).map(pickCols);
    var total = rows.length, LIMIT = 30;
    if (name === 'التقارير' || name === 'السجل') rows = rows.slice(-LIMIT).reverse(); else rows = rows.slice(0, LIMIT);
    function cell(v) {
      var s = v === null || v === undefined ? '' : String(v);
      if (s.length > 48) s = s.slice(0, 46) + '…';
      return esc(s);
    }
    return '<p class="nd-hint">' + (total > LIMIT ? (name === 'المدارس' ? 'أول ' : 'أحدث ') + LIMIT + ' من ' + total + ' صفًا' : total + ' صفًا') +
      (keep.length < sh.values[0].length ? ' • أخفينا هنا الأعمدة التقنية (المعرّفات وبيانات التقرير الكاملة).' : '') + '</p>' +
      '<div class="nd-tablewrap"><table class="nd-table"><thead><tr>' + head.map(function (h) { return '<th>' + cell(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (v) { return '<td>' + cell(v) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table></div>';
  }
  function openSheetPreview() {
    var names = [];
    try { names = S.env.inspect.sheetNames(); } catch (e) { names = []; }
    var tabs = ['التقارير', 'المدارس', 'السجل'].filter(function (n) { return names.indexOf(n) >= 0; });
    var holder = doc.createElement('div');
    holder.className = 'nd-stack';
    holder.innerHTML = '<p class="nd-text">في النسخة الحقيقية يفتح هذا ملف Google Sheets في حسابك أنت، وفيه كل التقارير والمدارس. هذه معاينة لما فيه الآن:</p>' +
      '<div class="nd-tabs" role="tablist">' + tabs.map(function (t, i) { return '<button type="button" role="tab" data-sheet="' + esc(t) + '" aria-selected="' + (i === 0) + '">' + esc(t) + '</button>'; }).join('') + '</div>' +
      '<div class="nd-sheet"></div>';
    function paint(name) {
      Array.prototype.forEach.call(holder.querySelectorAll('[data-sheet]'), function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-sheet') === name)); });
      holder.querySelector('.nd-sheet').innerHTML = sheetTable(name);
    }
    holder.addEventListener('click', function (ev) { var b = ev.target.closest('[data-sheet]'); if (b) paint(b.getAttribute('data-sheet')); });
    if (tabs.length) paint(tabs[0]); else holder.querySelector('.nd-sheet').innerHTML = '<p class="nd-hint">لم يُنشأ ملف البيانات بعد.</p>';
    openModal({ title: 'ملف البيانات (Google Sheets)', body: holder, wide: true });
  }
  function photosHtml(onlyId) {
    var files = [];
    try { files = S.env.drive.files.filter(function (f) { return !f.trashed && /^image\//.test(f.mimeType) && (!onlyId || f.id === onlyId); }); } catch (e) { files = []; }
    files = files.reverse().slice(0, 24);
    if (!files.length) return '<p class="nd-hint">لا توجد صور بعد. ترفع المدارس صور الشواهد مع التقرير.</p>';
    return '<div class="nd-photos">' + files.map(function (f) {
      var bytes = S.env.drive.file(f.id);
      return '<figure class="nd-photo"><img alt="" src="data:' + esc(f.mimeType) + ';base64,' + esc(bytes ? bytes.data : '') + '"><figcaption>' + esc(f.description || f.name) + '</figcaption></figure>';
    }).join('') + '</div>';
  }
  function external(href) {
    if (dedupe('ext:' + href)) return;
    if (/docs\.google\.com\/spreadsheets/i.test(href)) { openSheetPreview(); return; }
    if (/drive\.google\.com\/drive\/folders/i.test(href)) {
      openModal({ title: 'مجلد صور الشواهد (Google Drive)', wide: true,
        body: '<div class="nd-stack"><p class="nd-text">في النسخة الحقيقية تُحفظ صور الشواهد في مجلد داخل Google Drive الخاص بك. هذه الصور الموجودة فيه الآن:</p>' + photosHtml(null) + '</div>' });
      return;
    }
    var fm = /drive\.google\.com\/file\/d\/([^/?#]+)/i.exec(href);
    if (fm) { openModal({ title: 'صورة في Google Drive', body: '<div class="nd-stack">' + photosHtml(fm[1]) + '</div>' }); return; }
    openModal({ title: 'رابط خارجي', body: '<div class="nd-stack"><p class="nd-text">في النسخة الحقيقية يفتح هذا الرابط صفحة في حسابك على Google. هنا نسخة تجريبية تعمل داخل المتصفح فقط.</p><p class="nd-code" dir="ltr">' + esc(href) + '</p></div>' });
  }

  /* ---------------------------------------------------------------- mail */
  function otpOf(m) { var x = /(\d{6})/.exec(m.subject || ''); return x && /رمز/.test(m.subject) ? x[1] : null; }
  function checkMail() {
    if (!S.env) return;
    var box = S.env.mailbox;
    if (S.mailSeen > box.length) S.mailSeen = box.length;
    while (S.mailSeen < box.length) {
      var m = box[S.mailSeen++];
      S.unread++;
      announce(m);
    }
    updateMailBadge();
    if (S.drawerPage === 'mail') renderDrawer();
  }
  function announce(m) {
    var code = otpOf(m);
    if (code) {
      toast({ title: 'وصل رمز الدخول: ' + code, icon: 'key', kind: 'mail', ms: 15000, onClick: function () { openDrawer('mail', m.id); },
        actions: [{ label: 'نسخ', run: function () { copyWithToast(code, 'تم نسخ الرمز'); } }] });
    } else {
      toast({ title: 'وصل الملخص اليومي إلى بريد المشرف', icon: 'mail', kind: 'mail', ms: 8000, onClick: function () { openDrawer('mail', m.id); },
        actions: [{ label: 'فتح', run: function () { openDrawer('mail', m.id); } }] });
    }
  }
  function updateMailBadge() {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-mail-badge]'), function (b) {
      b.textContent = S.unread > 9 ? '9+' : String(S.unread);
      b.hidden = !S.unread;
    });
  }
  function mailById(id) { var box = S.env ? S.env.mailbox : []; for (var i = 0; i < box.length; i++) if (String(box[i].id) === String(id)) return box[i]; return null; }
  function mailListHtml() {
    var box = S.env ? S.env.mailbox.slice().reverse() : [];
    if (!box.length) return '<div class="nd-empty">' + icon('mail') + '<p>لا توجد رسائل بعد. سيصل هنا رمز الدخول والملخص اليومي.</p></div>';
    return '<ul class="nd-mails">' + box.slice(0, 40).map(function (m) {
      var code = otpOf(m);
      var snippet = code ? 'رمز الدخول ' + code + ' — صالح لمدة 10 دقائق' : String(m.body || '').split('\n').slice(0, 2).join(' — ');
      return '<li><button type="button" class="nd-mail" data-mail="' + esc(m.id) + '">' +
        '<span class="nd-mail__icon' + (code ? ' nd-mail__icon--key' : '') + '">' + icon(code ? 'key' : 'chart') + '</span>' +
        '<span class="nd-mail__main"><span class="nd-mail__top"><span class="nd-mail__from">' + esc(m.name || 'نبض المدارس') + '</span>' +
        '<span class="nd-mail__time">' + esc(whenLabel(m.atLocal)) + '</span></span>' +
        '<span class="nd-mail__subject">' + esc(m.subject) + '</span><span class="nd-mail__snippet">' + esc(snippet) + '</span></span></button></li>';
    }).join('') + '</ul>';
  }
  function mailDetailHtml(m) {
    var code = otpOf(m);
    return '<div class="nd-stack">' +
      '<div class="nd-maildetail"><div class="nd-maildetail__subject">' + esc(m.subject) + '</div>' +
      '<div class="nd-maildetail__meta">من: ' + esc(m.name || 'نبض المدارس') + ' • إلى: <bdi dir="ltr">' + esc(m.to) + '</bdi></div>' +
      '<div class="nd-maildetail__meta">' + esc(whenLabel(m.atLocal)) + '</div></div>' +
      (code ? '<div class="nd-otp"><span class="nd-otp__label">رمز الدخول</span><span class="nd-otp__code" dir="ltr">' + esc(code.slice(0, 3) + ' ' + code.slice(3)) + '</span>' +
        '<button type="button" class="nd-btn nd-btn--primary" data-act="copy-code" data-code="' + esc(code) + '">' + icon('copy') + '<span>نسخ الرمز</span></button>' +
        '<span class="nd-hint">اكتب هذا الرمز في صفحة الدخول. صالح لمدة 10 دقائق، ويُستخدم مرة واحدة.</span></div>' : '') +
      '<div class="nd-mailframe-wrap"><span class="nd-hint">الرسالة كما تصل إلى Gmail:</span><iframe class="nd-mailframe" sandbox="" title="نص الرسالة"></iframe></div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------- drawer */
  function openDrawer(page, arg) {
    var d = $('nd-drawer'), scrim = $('nd-scrim');
    S.drawerPage = page || 'menu';
    S.mailId = arg === undefined ? null : arg;
    if (S.drawerPage === 'mail') {
      S.unread = 0; updateMailBadge();
      // The mailbox is what every pending toast pointed at (a code arrived, «بدأت نسخة جديدة»): clear them so none
      // sits on top of the message being read.
      Array.prototype.forEach.call(doc.querySelectorAll('#nd-toasts .nd-toast'), function (t) { t.parentNode.removeChild(t); });
    }
    renderDrawer();
    if (d.hidden) {
      S.drawerFocus = doc.activeElement;
      d.hidden = false; scrim.hidden = false;
      requestAnimationFrame(function () { d.classList.add('is-open'); scrim.classList.add('is-open'); });
    }
    d.tabIndex = -1;
    setTimeout(function () { try { if (!d.contains(doc.activeElement)) d.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeDrawer() {
    var d = $('nd-drawer'), scrim = $('nd-scrim');
    if (d.hidden) return;
    d.classList.remove('is-open'); scrim.classList.remove('is-open');
    S.drawerPage = null;
    setTimeout(function () { if (!S.drawerPage) { d.hidden = true; scrim.hidden = true; } }, 220);
    try { if (S.drawerFocus && S.drawerFocus.focus) S.drawerFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function drawerHead(title, back) {
    return '<div class="nd-drawer__head">' +
      (back ? '<button type="button" class="nd-iconbtn nd-iconbtn--ghost" data-act="drawer-back" aria-label="رجوع">' + icon('back') + '</button>' : '') +
      '<h2 class="nd-drawer__title">' + title + '</h2>' +
      '<button type="button" class="nd-iconbtn nd-iconbtn--ghost" data-act="drawer-close" aria-label="إغلاق">' + icon('close') + '</button></div>';
  }
  function menuItem(act, ic, title, sub, extra) {
    return '<button type="button" class="nd-item" data-act="' + act + '"><span class="nd-item__icon">' + icon(ic) + '</span>' +
      '<span class="nd-item__main"><span class="nd-item__title">' + title + '</span><span class="nd-item__sub">' + sub + '</span></span>' + (extra || '') + '</button>';
  }
  function renderDrawer() {
    var d = $('nd-drawer'), page = S.drawerPage, html = '';
    if (page === 'mail' && S.mailId !== null && S.mailId !== undefined) {
      var m = mailById(S.mailId);
      if (m) {
        html = drawerHead('رسالة', true) + '<div class="nd-drawer__body">' + mailDetailHtml(m) + '</div>';
        d.innerHTML = html;
        var fr = d.querySelector('.nd-mailframe');
        if (fr) fr.srcdoc = m.htmlBody || ('<pre style="white-space:pre-wrap;font-family:Tahoma,sans-serif;direction:rtl">' + esc(m.body) + '</pre>');
        return;
      }
      S.mailId = null;
    }
    if (page === 'mail') {
      html = drawerHead('بريد المشرف (تجريبي)', true) + '<div class="nd-drawer__body"><p class="nd-hint nd-hint--box">' +
        'هنا ما يصل إلى بريد صاحب النسخة <bdi dir="ltr">' + esc(B.owner) + '</bdi>: رموز الدخول والملخص اليومي. في النسخة الحقيقية تصل إلى Gmail.</p>' +
        mailListHtml() + '</div>';
    } else if (page === 'codes') {
      var list = S.schools.filter(function (s) { return s.active; });
      html = drawerHead('رموز المدارس', true) + '<div class="nd-drawer__body"><p class="nd-hint nd-hint--box">' +
        'يدخل المدير من «الرابط العام» باختيار مدرسته ثم كتابة رمزها (4 أرقام). يرسل المشرف الرمز لكل مدرسة مرة واحدة.</p>' +
        (list.length ? '<ul class="nd-codes">' + list.map(function (s) {
          return '<li><span class="nd-codes__name">' + esc(s.name) + '</span><b class="nd-codes__pin" dir="ltr">' + esc(s.pin) + '</b>' +
            '<button type="button" class="nd-iconbtn nd-iconbtn--ghost" data-act="copy-pin" data-pin="' + esc(s.pin) + '" aria-label="نسخ رمز ' + esc(s.name) + '">' + icon('copy') + '</button></li>';
        }).join('') + '</ul>' : '<div class="nd-empty">' + icon('school') + '<p>لا توجد مدارس بعد.</p></div>') + '</div>';
    } else {
      html = drawerHead('النسخة التجريبية', false) + '<div class="nd-drawer__body">' +
        '<div class="nd-menu">' +
        menuItem('mail', 'mail', 'بريد المشرف (تجريبي)', 'رموز الدخول والملخص اليومي', '<span class="nd-badge nd-badge--inline" data-mail-badge hidden></span>') +
        menuItem('codes', 'hash', 'رموز المدارس', 'للدخول من الرابط العام') +
        menuItem('sheet', 'sheet', 'ملف البيانات', 'ما يحفظه البرنامج في Google Sheets') +
        '</div><div class="nd-menu">' +
        menuItem('fresh', 'sparkle', 'البدء من الصفر', 'تثبيت جديد: معالج التجهيز ورمز الدخول من البريد') +
        menuItem('reseed', 'refresh', 'إعادة البيانات التجريبية', 'ثماني مدارس وتقارير ثلاثة أسابيع حتى اليوم') +
        '</div>' +
        '<section class="nd-about"><h3>عن النسخة التجريبية</h3><p>هذا هو برنامج «نبض المدارس» نفسه يعمل داخل متصفحك. ' +
        'المدارس والأسماء والأرقام كلها تجريبية، وتبقى في هذا المتصفح فقط، ولا يُرسل منها شيء إلى أي جهة؛ حتى الرسائل تصل إلى «بريد المشرف (تجريبي)» هنا. ' +
        'أما النسخة الحقيقية فيعمل كل مشرف بنسخته الخاصة في حسابه على Google: البيانات في ملف Google Sheets، والصور في مجلد على Google Drive، ولا يطّلع عليها غيره.</p>' +
        '<p class="nd-about__meta">إصدار البرنامج <bdi dir="ltr">' + esc(B.version) + '</bdi>' + (S.meta && S.meta.mode === 'fresh' ? ' • تثبيت جديد' : ' • بيانات تجريبية') + '</p></section>' +
        '</div>';
    }
    d.innerHTML = html;
    updateMailBadge();
  }

  /* ---------------------------------------------------------------- welcome */
  function welcome() {
    if (sGet(KEY_WELCOME)) return;
    openModal({
      title: 'جرّب نبض المدارس',
      body: '<div class="nd-stack"><p class="nd-text">هذا هو البرنامج الحقيقي يعمل داخل متصفحك، ومعه بيانات تجريبية لثماني مدارس وثلاثة أسابيع من التقارير.</p>' +
        '<ol class="nd-steps">' +
        '<li><b>صفحة المدرسة:</b> عبّئ تقرير اليوم كما يفعل المدير من جواله، وأرفق صورة.</li>' +
        '<li><b>لوحة المشرف:</b> ستجد التقرير «بانتظار المراجعة»، فاعتمده أو أعده للتصحيح.</li>' +
        '<li><b>الرابط العام:</b> اختر مدرسة واكتب رمزها من «رموز المدارس» في القائمة.</li></ol>' +
        '<p class="nd-hint">رمز دخول المشرف والملخص اليومي يصلان إلى «بريد المشرف (تجريبي)» في القائمة. لا يُرسل شيء خارج هذا المتصفح.</p></div>',
      actions: [{ label: 'ابدأ التجربة', kind: 'primary' }],
      onClose: function () { sSet(KEY_WELCOME, '1'); }
    });
  }

  /* ---------------------------------------------------------------- persistence */
  function snapshotForSave() {
    var s = S.env.snapshot();
    s.logs = []; s.warnings = []; s.formulaWrites = [];
    s.ui = { menus: [], alerts: [], dialogs: [], promptQueue: [], alertQueue: [] };
    if (s.mail.length > 40) s.mail = s.mail.slice(-40);
    return s;
  }
  function persistSoon() { clearTimeout(S.persistTimer); S.persistTimer = setTimeout(persistNow, 600); }
  function persistNow() {
    clearTimeout(S.persistTimer); S.persistTimer = null;
    if (!LS || !S.env) return false;
    var payload;
    try { payload = JSON.stringify({ v: 1, meta: S.meta, state: snapshotForSave() }); } catch (e) { return false; }
    try { LS.setItem(KEY_STATE, payload); S.saveFailed = false; return true; }
    catch (e) {
      S.saveFailed = true;
      if (!S.saveNoticeShown) {
        S.saveNoticeShown = true;
        toast({ title: 'امتلأت مساحة الحفظ في المتصفح', text: 'التجربة مستمرة، لكن آخر التغييرات لن تبقى بعد إعادة تحميل الصفحة.', ms: 9000 });
      }
      return false;
    }
  }
  function tryRestore() {
    var raw = null;
    try { raw = LS ? LS.getItem(KEY_STATE) : null; } catch (e) { raw = null; }
    if (!raw) return 'none';
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { o = null; }
    if (!o || o.v !== 1 || !o.meta || !o.state) return 'none';
    if (o.meta.buildId !== B.buildId) return 'build';
    if (o.meta.mode !== 'fresh' && o.meta.seedDay !== todayRiyadh()) return 'stale';
    try { install(newBackend(o.state), o.meta); } catch (e) { return 'none'; }
    return 'ok';
  }

  /* ---------------------------------------------------------------- daily digest (the real trigger, on time) */
  function digestTick() {
    if (!S.env || !S.app || !S.ready) return;
    var trig = (S.env.triggers || []).filter(function (t) { return t.handler === 'dailyDigest' && t.atHour !== undefined; })[0];
    if (!trig) return;
    var now = Date.now(), today = GasMock.formatDate(now, TZ, 'yyyy-MM-dd'), hhmm = GasMock.formatDate(now, TZ, 'HH:mm');
    var mins = trig.atHour * 60 + (trig.nearMinute || 0), cur = +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
    if (cur < mins || cur > mins + 120 || S.digestTried === today) return;
    var props = {};
    try { props = S.env.properties('script'); } catch (e) { props = {}; }
    if (props.digestSent === today) return;
    S.digestTried = today;
    try { S.app.runTrigger('dailyDigest'); } catch (e) { /* the trigger logs its own errors */ }
    S.version++;
    checkMail();
    persistSoon();
  }

  /* ---------------------------------------------------------------- loading / seeding */
  function loading(on, frac, label) {
    var el = $('nd-loading');
    el.hidden = !on;
    if (frac !== undefined) {
      var bar = el.querySelector('.nd-progress__bar');
      bar.style.width = Math.round(Math.max(0.03, Math.min(1, frac)) * 100) + '%';
      el.querySelector('.nd-progress').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    }
    if (label) $('nd-loading-step').textContent = label;
  }
  function seedFailed(e) {
    try { console.error(e); } catch (x) { /* ignore */ }
    loading(true, 1, 'تعذّر تجهيز النسخة التجريبية: ' + (e && e.message || e));
    var retry = $('nd-loading-retry');
    retry.hidden = false;
  }
  function runSeed(reason) {
    S.ready = false;
    closeDrawer();
    modalStack.slice().forEach(function (m) { m.close(); });
    loading(true, 0.02, 'تجهيز ملف البيانات');
    $('nd-loading-retry').hidden = true;
    var be;
    try { be = newBackend(null); } catch (e) { seedFailed(e); return; }
    var cache = {};
    setTimeout(function () {
      W.demoSeed({
        GasMock: GasMock, env: be.env, app: be.app, now: Date.now(), uaFirst: 'Chrome — Windows', uaNow: uaLabel(),
        photo: function (k) { return cache[k] || (cache[k] = W.makeDemoPhoto(k)); },
        step: function (frac, label) { loading(true, frac, label); return new Promise(function (r) { setTimeout(r, 0); }); }
      }).then(function (res) {
        install(be, { buildId: B.buildId, mode: 'sample', seedDay: res.today });
        clearAppKeys();
        sSet('nabd:session', JSON.stringify(res.token));
        res.schools.forEach(function (s) { sSet('nabd:filledBy:' + s.token, JSON.stringify(s.filledBy)); });
        persistNow();
        loading(false);
        start(reason);
      }, seedFailed);
    }, 30);
  }
  function freshInstall() {
    var be = newBackend(null);
    install(be, { buildId: B.buildId, mode: 'fresh', seedDay: todayRiyadh() });
    clearAppKeys();
    persistNow();
    start('fresh');
  }
  function start(reason) {
    S.ready = true;
    var ui = null;
    try { ui = JSON.parse(sGet(KEY_UI) || 'null'); } catch (e) { ui = null; }
    var view = 'admin';
    if (reason === 'restored' && ui && VIEW_LABELS[ui.view]) {
      view = ui.view;
      if (ui.schoolId && school(ui.schoolId)) S.schoolId = ui.schoolId;
    }
    show(view, { reload: true });
    if (reason === 'stale') toast({ title: 'حُدّثت البيانات التجريبية', text: 'التقارير الآن حتى اليوم.', icon: 'refresh' });
    else if (reason === 'build') toast({ title: 'تم تحديث النسخة التجريبية', text: 'بدأت ببيانات تجريبية جديدة.', icon: 'refresh' });
    else if (reason === 'reseed') toast({ title: 'عادت البيانات التجريبية', icon: 'check' });
    else if (reason === 'fresh') toast({ title: 'بدأت نسخة جديدة', text: 'رمز الدخول سيصل إلى «بريد المشرف (تجريبي)».', icon: 'sparkle', ms: 6000 });
    if (reason !== 'fresh' && reason !== 'reseed') welcome();
    digestTick();
  }

  /* ---------------------------------------------------------------- UI events */
  function onAction(act, el) {
    switch (act) {
      case 'menu': openDrawer('menu'); break;
      case 'mail': openDrawer('mail'); break;
      case 'codes': openDrawer('codes'); break;
      case 'sheet': closeDrawer(); openSheetPreview(); break;
      case 'drawer-close': closeDrawer(); break;
      case 'drawer-back':
        if (S.drawerPage === 'mail' && S.mailId !== null) { S.mailId = null; renderDrawer(); }
        else { S.drawerPage = 'menu'; S.mailId = null; renderDrawer(); }
        break;
      case 'copy-pin': copyWithToast(el.getAttribute('data-pin'), 'تم نسخ رمز المدرسة'); break;
      case 'copy-code': copyWithToast(el.getAttribute('data-code'), 'تم نسخ الرمز'); break;
      case 'fresh':
        confirmBox({ title: 'البدء من الصفر؟', ok: 'ابدأ من الصفر', danger: true,
          text: 'ستُحذف كل بيانات هذه النسخة التجريبية، وتبدأ كما يبدأ مشرف جديد: معالج التجهيز، ثم رمز الدخول الذي يصل إلى «بريد المشرف (تجريبي)».' })
          .then(function (ok) { if (ok) { closeDrawer(); freshInstall(); } });
        break;
      case 'reseed':
        confirmBox({ title: 'إعادة البيانات التجريبية؟', ok: 'إعادة البيانات', danger: true,
          text: 'ستُستبدل البيانات الحالية بثماني مدارس وتقارير ثلاثة أسابيع تنتهي اليوم. ما أضفته أنت سيُحذف.' })
          .then(function (ok) { if (ok) runSeed('reseed'); });
        break;
      default: break;
    }
  }
  function bindUi() {
    doc.addEventListener('click', function (ev) {
      var seg = ev.target.closest && ev.target.closest('.nd-seg [data-view]');
      if (seg) { if (S.ready) show(seg.getAttribute('data-view')); return; }
      var m = ev.target.closest && ev.target.closest('[data-mail]');
      if (m) { S.mailId = m.getAttribute('data-mail'); renderDrawer(); return; }
      var a = ev.target.closest && ev.target.closest('[data-act]');
      if (a) onAction(a.getAttribute('data-act'), a);
    });
    $('nd-seg').addEventListener('keydown', function (ev) {
      var keys = ['admin', 'school', 'general'], i = keys.indexOf(S.view);
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        var dir = ev.key === 'ArrowLeft' ? 1 : -1;   // RTL: left moves forward
        var next = keys[(i + dir + keys.length) % keys.length];
        show(next);
        var b = doc.querySelector('.nd-seg [data-view="' + next + '"]'); if (b) b.focus();
      }
    });
    $('nd-scrim').addEventListener('click', closeDrawer);
    doc.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (modalStack.length) { modalStack[modalStack.length - 1].close(); return; }
      closeDrawer();
    });
    $('nd-loading-retry').addEventListener('click', function () { runSeed(null); });
    W.addEventListener('message', onMessage);
    W.addEventListener('pagehide', function () { if (S.persistTimer) persistNow(); });
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden' && S.persistTimer) persistNow(); });
    setInterval(digestTick, 30000);
  }

  /* ---------------------------------------------------------------- boot */
  W.NabdDemo = {
    exec: exec, latency: latency, navigate: navigate, whatsapp: whatsapp, external: external,
    toast: function (msg) { toast({ title: String(msg) }); },
    memStorage: memStorage,
    // for automated checks of the demo itself
    get env() { return S.env; }, get app() { return S.app; }, get view() { return S.view; },
    get schools() { return S.schools.slice(); }, get ready() { return S.ready; },
    setLatencyScale: function (x) { S.latencyScale = Math.max(0, +x || 0); },
    show: function (v) { show(v); }, persistNow: persistNow, storageAvailable: !!LS, buildId: B.buildId
  };
  bindUi();
  var restored = tryRestore();
  if (restored === 'ok') { loading(false); start('restored'); }
  else runSeed(restored === 'none' ? null : restored);
}

/* ================================================================== 5. markup + styles */
const ICON_PATHS = {
  pulse: '<path d="M3 12h4l2.2-5.5L13 18l2.4-6H21"/>',
  admin: '<rect x="3.5" y="3.5" width="7" height="8.5" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.6"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.6"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.6"/>',
  school: '<path d="M3 10 12 4.8 21 10"/><path d="M5 9.2V20h14V9.2"/><path d="M10 20v-5h4v5"/><path d="M3 20h18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.1 1.1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.1-1.1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.6"/><path d="m4 7.2 8 5.8 8-5.8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  back: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  chevron: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6.2C5 5 6 4 7.2 4H15"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5V9H15"/>',
  sparkle: '<path d="M12 3.5 13.8 9 19.5 10.8 13.8 12.6 12 18.5 10.2 12.6 4.5 10.8 10.2 9Z"/><path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.2 6.8l2.3 2.3M13.9 9.1l2 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  hash: '<path d="M5 9h14M5 15h14M10.5 4 8.5 20M15.5 4l-2 16"/>',
  sheet: '<rect x="4" y="3.5" width="16" height="17" rx="2.2"/><path d="M4 9h16M4 14.5h16M10 9v11.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  whatsapp: '<path d="M12 3.2a8.8 8.8 0 0 0-7.6 13.2L3.2 20.8l4.5-1.2A8.8 8.8 0 1 0 12 3.2Z"/><path d="M8.9 8.6c.2-.5.5-.7.9-.7h.5l1 2.1-.7 1a5.4 5.4 0 0 0 2.5 2.5l1-.7 2.1 1v.5c0 .4-.2.7-.7.9-.9.4-2.3.2-4.1-1.4s-2.8-3.6-2.5-5.2Z"/>'
};
function svgIcon(name) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON_PATHS[name] + '</svg>';
}

const CSS = `
/* Layout: a slim control bar (brand · page switch · context) over a full-height stage where the real
   app runs in a white, framed "screen". The shell takes the app's own teal brand and IBM Plex Sans Arabic;
   a warm sand pill marks everything as sample data. */
:root {
  --nd-bg: #E6EEEC;
  --nd-bar: #F7FAF9;
  --nd-surface: #FFFFFF;
  --nd-surface-2: #EEF3F2;
  --nd-line: #D3DFDC;
  --nd-text: #10222B;
  --nd-text-2: #3B5260;
  --nd-muted: #5F737D;
  --nd-brand: #0E7C66;
  --nd-brand-strong: #084F42;
  --nd-brand-soft: #DCEFEA;
  --nd-on-brand: #FFFFFF;
  --nd-seg-on: #FFFFFF;
  --nd-sand: #B8892B;
  --nd-sand-soft: #F7ECD3;
  --nd-sand-text: #6E500F;
  --nd-danger: #B93A2C;
  --nd-danger-soft: #FAE7E3;
  --nd-on-danger: #FFFFFF;
  --nd-on-wa: #FFFFFF;
  --nd-wa: #178A47;
  --nd-wa-ground: #ECE5DD;
  --nd-wa-bubble: #DCF8C6;
  --nd-frame: #FFFFFF;
  --nd-shadow: 0 1px 2px rgba(16, 34, 43, .06), 0 10px 30px rgba(16, 34, 43, .10);
  --nd-shadow-lg: 0 18px 50px rgba(16, 34, 43, .22);
  --nd-scrim: rgba(9, 22, 27, .46);
  --nd-toast: #12262E;
  --nd-toast-text: #F1F6F5;
  --nd-toast-muted: #B9CBC8;
  --nd-toast-accent: #7FE0C4;
  --nd-focus: #0E7C66;
  --nd-font: 'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, 'Noto Sans Arabic', 'DejaVu Sans', sans-serif;
  --nd-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --nd-r: 12px;
  --nd-r-lg: 18px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --nd-bg: #0B1517; --nd-bar: #101D20; --nd-surface: #14242A; --nd-surface-2: #1A2D33; --nd-line: #284046;
    --nd-text: #E3EDEB; --nd-text-2: #B7C9C6; --nd-muted: #8EA4A2; --nd-brand: #3FC3A0; --nd-brand-strong: #93E4CD;
    --nd-brand-soft: #173B36; --nd-on-brand: #05271F; --nd-seg-on: #26403F; --nd-sand: #E0B65C; --nd-sand-soft: #3A2F17;
    --nd-sand-text: #F1D28E; --nd-danger: #F08374; --nd-danger-soft: #3B1F1C; --nd-on-danger: #2A0D09; --nd-on-wa: #052414; --nd-wa: #47D383; --nd-wa-ground: #0E1A1C;
    --nd-wa-bubble: #1D4A33; --nd-frame: #FFFFFF; --nd-shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 10px 30px rgba(0, 0, 0, .35);
    --nd-shadow-lg: 0 18px 50px rgba(0, 0, 0, .55); --nd-scrim: rgba(0, 0, 0, .6); --nd-toast: #E3EDEB;
    --nd-toast-text: #0B1517; --nd-toast-muted: #3B5260; --nd-toast-accent: #0A6453; --nd-focus: #3FC3A0;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --nd-bg: #0B1517; --nd-bar: #101D20; --nd-surface: #14242A; --nd-surface-2: #1A2D33; --nd-line: #284046;
  --nd-text: #E3EDEB; --nd-text-2: #B7C9C6; --nd-muted: #8EA4A2; --nd-brand: #3FC3A0; --nd-brand-strong: #93E4CD;
  --nd-brand-soft: #173B36; --nd-on-brand: #05271F; --nd-seg-on: #26403F; --nd-sand: #E0B65C; --nd-sand-soft: #3A2F17;
  --nd-sand-text: #F1D28E; --nd-danger: #F08374; --nd-danger-soft: #3B1F1C; --nd-on-danger: #2A0D09; --nd-on-wa: #052414; --nd-wa: #47D383; --nd-wa-ground: #0E1A1C;
  --nd-wa-bubble: #1D4A33; --nd-frame: #FFFFFF; --nd-shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 10px 30px rgba(0, 0, 0, .35);
  --nd-shadow-lg: 0 18px 50px rgba(0, 0, 0, .55); --nd-scrim: rgba(0, 0, 0, .6); --nd-toast: #E3EDEB;
  --nd-toast-text: #0B1517; --nd-toast-muted: #3B5260; --nd-toast-accent: #0A6453; --nd-focus: #3FC3A0;
  color-scheme: dark;
}

html { height: 100%; box-sizing: border-box; }
*, *::before, *::after { box-sizing: border-box; }
body {
  height: 100%; margin: 0; overflow: hidden;
  background: var(--nd-bg); color: var(--nd-text);
  font: 400 14px/1.6 var(--nd-font);
  -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
}
button, select, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--nd-focus); outline-offset: 2px; }
[hidden] { display: none !important; }
.nd-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
svg { flex: none; }

/* ---------------------------------------------------------------- frame of the page */
.nd { height: 100%; display: flex; flex-direction: column; min-width: 0; }
.nd-bar {
  flex: none; position: relative; z-index: 3;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "brand actions" "seg seg";
  align-items: center; gap: 10px 12px;
  padding-block: 10px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  background: var(--nd-bar); border-bottom: 1px solid var(--nd-line);
}
.nd-bar.has-ctx { grid-template-areas: "brand actions" "seg seg" "ctx ctx"; }

.nd-brand { grid-area: brand; display: flex; align-items: center; gap: 10px; min-width: 0; overflow: hidden; }
.nd-brand__mark {
  width: 34px; height: 34px; border-radius: 10px; flex: none;
  display: grid; place-items: center; background: var(--nd-brand); color: var(--nd-on-brand);
}
.nd-brand__mark svg { width: 20px; height: 20px; stroke-width: 2.2; }
.nd-brand__name { font-size: 16px; font-weight: 700; white-space: nowrap; letter-spacing: 0; }
.nd-pill {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  background: var(--nd-sand-soft); color: var(--nd-sand-text); border: 1px solid var(--nd-sand);
}
.nd-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--nd-sand); }

.nd-actions { grid-area: actions; display: flex; gap: 6px; }
.nd-iconbtn {
  position: relative; width: 40px; height: 40px; flex: none; border-radius: var(--nd-r);
  display: grid; place-items: center; cursor: pointer;
  background: var(--nd-surface); color: var(--nd-text-2); border: 1px solid var(--nd-line);
  transition: background-color .15s ease, color .15s ease;
}
.nd-iconbtn:hover { background: var(--nd-surface-2); color: var(--nd-text); }
.nd-iconbtn--ghost { background: transparent; border-color: transparent; }
.nd-badge {
  position: absolute; top: -5px; left: -5px; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 999px; background: var(--nd-danger); color: var(--nd-on-danger); font-size: 11px; font-weight: 700;
  display: grid; place-items: center; line-height: 1; border: 2px solid var(--nd-bar);
}
.nd-badge--inline { position: static; border: 0; margin-inline-start: auto; }

.nd-seg {
  grid-area: seg; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px;
  padding: 3px; border-radius: 13px; background: var(--nd-surface-2); border: 1px solid var(--nd-line);
}
.nd-seg button {
  min-height: 40px; min-width: 0; padding: 6px 6px; border: 0; border-radius: 10px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: transparent; color: var(--nd-text-2); font-size: 13.5px; font-weight: 600; white-space: nowrap;
  transition: background-color .15s ease, color .15s ease, box-shadow .15s ease;
}
.nd-seg button svg { width: 18px; height: 18px; }
.nd-seg button:hover { color: var(--nd-text); }
.nd-seg button[aria-selected="true"] {
  background: var(--nd-seg-on); color: var(--nd-brand-strong);
  box-shadow: 0 1px 2px rgba(16, 34, 43, .10), 0 0 0 1px var(--nd-line);
}
.nd-seg span { overflow: hidden; text-overflow: ellipsis; }

.nd-ctx { grid-area: ctx; display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.nd-pick { position: relative; flex: 1 1 0; min-width: 0; display: block; }
.nd-pick__select {
  width: 100%; min-height: 42px; appearance: none; -webkit-appearance: none; cursor: pointer;
  padding: 8px 40px 8px 38px; border-radius: var(--nd-r);
  background: var(--nd-surface); border: 1px solid var(--nd-line); color: var(--nd-text);
  font-weight: 600; font-size: 14.5px; text-overflow: ellipsis;
}
.nd-pick__icon, .nd-pick__chev { position: absolute; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--nd-muted); display: grid; }
.nd-pick__icon { right: 12px; color: var(--nd-brand); }
.nd-pick__chev { left: 12px; }
.nd-chip {
  display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 6px 12px; flex: none;
  border-radius: var(--nd-r); border: 1px dashed var(--nd-sand); background: var(--nd-sand-soft); color: var(--nd-sand-text);
  font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.nd-chip b { font-family: var(--nd-mono); font-size: 16px; letter-spacing: 2px; color: var(--nd-text); font-variant-numeric: tabular-nums; }
.nd-chip--btn { border-style: solid; }
.nd-chip__short { display: none; }
.nd-chip svg { width: 18px; height: 18px; }
.nd-hint { margin: 0; color: var(--nd-muted); font-size: 13px; line-height: 1.7; }
.nd-ctx .nd-hint { flex: 1 1 180px; min-width: 0; }
.nd-hint--box { padding: 10px 12px; border-radius: var(--nd-r); background: var(--nd-surface-2); color: var(--nd-text-2); }

@media (max-width: 519px) {
  .nd-seg button { font-size: 13px; padding: 6px 4px; }
  .nd-seg button svg { display: none; }
  .nd-chip { padding: 6px 10px; gap: 6px; }
  .nd-chip__long { display: none; }
  .nd-chip__short { display: inline; }
  .nd-ctx .nd-hint { font-size: 12.5px; line-height: 1.6; }
  .nd-hint__long { display: none; }
}
@media (max-width: 419px) {
  .nd-brand { gap: 8px; }
  .nd-brand__mark { width: 32px; height: 32px; }
  .nd-brand__name { font-size: 15px; }
  .nd-pill { padding: 2px 8px; font-size: 11.5px; }
  .nd-pill::before { display: none; }
  .nd-actions { gap: 4px; }
  .nd-iconbtn { width: 38px; height: 38px; }
}
@media (max-width: 379px) {
  .nd-pill__more { display: none; }
}
@media (max-width: 339px) {
  .nd-brand__name { display: none; }
}
@media (min-width: 760px) {
  .nd-bar { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "brand seg actions"; }
  .nd-bar.has-ctx { grid-template-areas: "brand seg actions" "ctx ctx ctx"; }
  .nd-seg { justify-self: center; width: min(100%, 480px); }
}
@media (min-width: 1200px) {
  .nd-bar, .nd-bar.has-ctx { grid-template-columns: auto auto minmax(0, 1fr) auto; grid-template-areas: "brand seg ctx actions"; gap: 12px 20px; }
  .nd-seg { justify-self: start; width: 430px; }
  .nd-ctx { flex-wrap: nowrap; }
  .nd-ctx .nd-hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nd-pick { flex: 0 1 340px; min-width: 220px; }
}

/* ---------------------------------------------------------------- stage + app frames */
.nd-stage {
  flex: 1 1 auto; min-height: 0; position: relative;
  padding-block: 12px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.nd-screen { position: relative; height: 100%; max-width: 1480px; margin: 0 auto; }
.nd-frame {
  position: absolute; inset: 0; overflow: hidden;
  border-radius: var(--nd-r-lg); background: var(--nd-frame);
  border: 1px solid var(--nd-line); box-shadow: var(--nd-shadow);
}
.nd-frame iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--nd-frame); }
.nd-frame.is-hidden { visibility: hidden; pointer-events: none; }
@media (max-width: 599px) {
  /* Phones: the app gets the whole width (it keeps its own 16px gutters); only the safe areas stay clear. */
  .nd-stage { padding-block: 0; padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }
  .nd-frame { border: 0; border-radius: 0; box-shadow: none; }
}

/* ---------------------------------------------------------------- toasts */
.nd-toasts {
  position: absolute; z-index: 60; top: 18px; left: 0; right: 0;
  padding-left: max(24px, calc(env(safe-area-inset-left, 0px) + 8px));
  padding-right: max(24px, calc(env(safe-area-inset-right, 0px) + 8px));
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
}
.nd-toast {
  pointer-events: auto; width: min(100%, 460px);
  display: flex; align-items: center; gap: 10px;
  padding: 8px 6px 8px 14px; min-height: 52px; border-radius: 14px;
  background: var(--nd-toast); color: var(--nd-toast-text); box-shadow: var(--nd-shadow-lg);
  animation: nd-in .2s ease-out;
}
.nd-toast__icon { display: grid; color: var(--nd-toast-accent); padding-right: 6px; }
.nd-toast__body { flex: 1 1 0; min-width: 0; }
.nd-toast__body.is-link { cursor: pointer; }
.nd-toast__title { font-weight: 700; font-size: 14.5px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.nd-toast__text { font-size: 13px; line-height: 1.6; color: var(--nd-toast-muted); overflow-wrap: anywhere; }
.nd-toast__actions { display: flex; gap: 6px; flex: none; }
.nd-toast__btn {
  border: 1px solid var(--nd-toast-accent); background: transparent; color: var(--nd-toast-accent);
  border-radius: 10px; padding: 4px 12px; min-height: 36px; font-weight: 700; font-size: 13.5px; cursor: pointer;
}
.nd-toast__close { flex: none; border: 0; background: transparent; color: var(--nd-toast-muted); cursor: pointer; width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; }
@keyframes nd-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@media (max-width: 519px) {
  .nd-toasts { top: 10px; padding-left: max(10px, env(safe-area-inset-left, 0px)); padding-right: max(10px, env(safe-area-inset-right, 0px)); }
  .nd-toast { gap: 8px; padding: 6px 4px 6px 10px; }
  .nd-toast__icon { padding-right: 4px; }
  .nd-toast__title { font-size: 14px; }
}

/* ---------------------------------------------------------------- drawer */
.nd-scrim { position: fixed; inset: 0; z-index: 40; background: var(--nd-scrim); opacity: 0; transition: opacity .2s ease; }
.nd-scrim.is-open { opacity: 1; }
.nd-drawer {
  position: fixed; z-index: 41; top: 0; bottom: 0; left: 0; width: min(400px, calc(100% - 36px));
  display: flex; flex-direction: column; background: var(--nd-surface); color: var(--nd-text);
  box-shadow: var(--nd-shadow-lg); transform: translateX(-104%); transition: transform .22s ease;
  padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
}
.nd-drawer.is-open { transform: none; }
.nd-drawer:focus { outline: none; }
.nd-drawer__head { display: flex; align-items: center; gap: 6px; padding: 12px 12px 10px 10px; border-bottom: 1px solid var(--nd-line); }
.nd-drawer__title { flex: 1; margin: 0; font-size: 17px; font-weight: 700; padding-right: 6px; }
.nd-drawer__body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 14px 16px 22px; display: flex; flex-direction: column; gap: 16px; }
.nd-menu { display: flex; flex-direction: column; border: 1px solid var(--nd-line); border-radius: 14px; overflow: hidden; }
.nd-item {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: right; cursor: pointer;
  padding: 12px 14px; min-height: 60px; background: var(--nd-surface); border: 0; border-bottom: 1px solid var(--nd-line);
}
.nd-item:last-child { border-bottom: 0; }
.nd-item:hover { background: var(--nd-surface-2); }
.nd-item__icon { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: var(--nd-brand-soft); color: var(--nd-brand-strong); flex: none; }
.nd-item__main { display: flex; flex-direction: column; min-width: 0; }
.nd-item__title { font-weight: 700; font-size: 15px; }
.nd-item__sub { color: var(--nd-muted); font-size: 12.5px; line-height: 1.5; }
.nd-about { padding: 14px 16px; border-radius: 14px; background: var(--nd-surface-2); }
.nd-about h3 { margin: 0 0 6px; font-size: 15px; }
.nd-about p { margin: 0; color: var(--nd-text-2); font-size: 13.5px; line-height: 1.85; }
.nd-about .nd-about__meta { margin-top: 10px; color: var(--nd-muted); font-size: 12.5px; }

.nd-mails { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.nd-mail {
  width: 100%; display: flex; gap: 12px; align-items: flex-start; text-align: right; cursor: pointer;
  padding: 12px; border-radius: 14px; border: 1px solid var(--nd-line); background: var(--nd-surface);
}
.nd-mail:hover { background: var(--nd-surface-2); }
.nd-mail__icon { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--nd-brand-soft); color: var(--nd-brand-strong); }
.nd-mail__icon--key { background: var(--nd-sand-soft); color: var(--nd-sand-text); }
.nd-mail__main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.nd-mail__top { display: flex; justify-content: space-between; gap: 8px; }
.nd-mail__from { font-weight: 700; font-size: 13.5px; }
.nd-mail__time { color: var(--nd-muted); font-size: 12px; white-space: nowrap; }
.nd-mail__subject { font-size: 13.5px; font-weight: 600; color: var(--nd-text); overflow-wrap: anywhere; }
.nd-mail__snippet { font-size: 12.5px; color: var(--nd-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.nd-maildetail__subject { font-weight: 700; font-size: 16px; line-height: 1.6; }
.nd-maildetail__meta { color: var(--nd-muted); font-size: 12.5px; overflow-wrap: anywhere; }
.nd-otp {
  display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
  padding: 16px; border-radius: 16px; background: var(--nd-sand-soft); border: 1px solid var(--nd-sand);
}
.nd-otp__label { font-size: 13px; font-weight: 600; color: var(--nd-sand-text); }
.nd-otp__code { font-family: var(--nd-mono); font-size: 34px; font-weight: 700; letter-spacing: 4px; color: var(--nd-text); font-variant-numeric: tabular-nums; }
.nd-mailframe-wrap { display: flex; flex-direction: column; gap: 6px; }
.nd-mailframe { width: 100%; height: 520px; border: 1px solid var(--nd-line); border-radius: 14px; background: var(--nd-frame); }
.nd-codes { list-style: none; margin: 0; padding: 0; border: 1px solid var(--nd-line); border-radius: 14px; overflow: hidden; }
.nd-codes li { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 6px; padding-right: 14px; border-bottom: 1px solid var(--nd-line); }
.nd-codes li:last-child { border-bottom: 0; }
.nd-codes__name { flex: 1; min-width: 0; font-weight: 600; font-size: 14px; }
.nd-codes__pin { font-family: var(--nd-mono); font-size: 18px; letter-spacing: 2px; font-variant-numeric: tabular-nums; }
.nd-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--nd-muted); padding: 28px 12px; }
.nd-empty svg { width: 32px; height: 32px; }
.nd-empty p { margin: 0; }

/* ---------------------------------------------------------------- modal */
.nd-modal {
  position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
  padding-block: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-bottom, 0px));
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.nd-modal__scrim { position: absolute; inset: 0; background: var(--nd-scrim); }
.nd-modal__dialog {
  position: relative; width: min(100%, 480px); max-height: 100%; min-height: 0; display: flex; flex-direction: column;
  background: var(--nd-surface); color: var(--nd-text); border-radius: 20px; box-shadow: var(--nd-shadow-lg);
  animation: nd-pop .18s ease-out;
}
.nd-modal__dialog:focus { outline: none; }
.nd-modal__dialog--wide { width: min(100%, 860px); }
@keyframes nd-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
.nd-modal__head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 4px 10px; }
.nd-modal__title { flex: 1; margin: 0; padding-right: 8px; font-size: 18px; font-weight: 700; text-wrap: balance; }
.nd-modal__body { padding: 6px 20px 16px; overflow-y: auto; min-height: 0; }
.nd-modal__foot { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 20px 18px; border-top: 1px solid var(--nd-line); }
.nd-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.nd-text { margin: 0; color: var(--nd-text-2); line-height: 1.85; font-size: 14.5px; }
.nd-steps { margin: 0; padding-right: 22px; display: flex; flex-direction: column; gap: 8px; color: var(--nd-text-2); line-height: 1.8; }
.nd-steps b { color: var(--nd-text); }
.nd-code { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--nd-surface-2); font-family: var(--nd-mono); font-size: 12.5px; overflow-wrap: anywhere; text-align: left; }
.nd-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 9px 18px;
  border-radius: var(--nd-r); border: 1px solid transparent; font-weight: 700; font-size: 14.5px; cursor: pointer; text-decoration: none;
}
.nd-btn--primary { background: var(--nd-brand); color: var(--nd-on-brand); }
.nd-btn--secondary { background: var(--nd-surface); color: var(--nd-text); border-color: var(--nd-line); }
.nd-btn--danger { background: var(--nd-danger); color: var(--nd-on-danger); }
.nd-btn--wa { background: var(--nd-wa); color: var(--nd-on-wa); }
.nd-btn svg { width: 19px; height: 19px; }
.nd-wa { border-radius: 16px; padding: 12px; background: var(--nd-wa-ground); display: flex; flex-direction: column; gap: 8px; }
.nd-wa__to { display: flex; align-items: center; gap: 8px; color: var(--nd-text-2); font-size: 13px; font-weight: 600; }
.nd-wa__to svg { color: var(--nd-wa); }
.nd-wa__bubble {
  align-self: flex-start; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere;
  padding: 10px 12px; border-radius: 12px 4px 12px 12px; background: var(--nd-wa-bubble); color: var(--nd-text);
  font-size: 14px; line-height: 1.75; box-shadow: 0 1px 1px rgba(0, 0, 0, .08);
}
.nd-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.nd-tabs button { border: 1px solid var(--nd-line); background: var(--nd-surface); border-radius: 999px; padding: 6px 14px; cursor: pointer; font-weight: 600; font-size: 13px; color: var(--nd-text-2); min-height: 36px; }
.nd-tabs button[aria-selected="true"] { background: var(--nd-brand-soft); color: var(--nd-brand-strong); border-color: var(--nd-brand); }
.nd-sheet { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.nd-tablewrap { overflow: auto; max-height: min(52vh, 460px); border: 1px solid var(--nd-line); border-radius: 12px; }
.nd-table { border-collapse: collapse; font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.nd-table th, .nd-table td { padding: 6px 10px; border-bottom: 1px solid var(--nd-line); border-left: 1px solid var(--nd-line); text-align: right; }
.nd-table th { position: sticky; top: 0; background: var(--nd-surface-2); font-weight: 700; color: var(--nd-text); }
.nd-table td { color: var(--nd-text-2); }
.nd-photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.nd-photo { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.nd-photo img { width: 100%; max-width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 10px; border: 1px solid var(--nd-line); background: var(--nd-surface-2); }
.nd-photo figcaption { font-size: 12px; color: var(--nd-muted); overflow-wrap: anywhere; }

/* ---------------------------------------------------------------- loading */
.nd-loading {
  position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; background: var(--nd-bg);
  padding-block: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-bottom, 0px));
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.nd-loading__card {
  width: min(100%, 380px); display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
  padding: 28px 24px; border-radius: 22px; background: var(--nd-surface); border: 1px solid var(--nd-line); box-shadow: var(--nd-shadow);
}
.nd-loading .nd-brand__mark { width: 56px; height: 56px; border-radius: 16px; }
.nd-loading .nd-brand__mark svg { width: 32px; height: 32px; animation: nd-beat 1.4s ease-in-out infinite; }
@keyframes nd-beat { 0%, 100% { transform: scale(1); } 30% { transform: scale(1.12); } 60% { transform: scale(.96); } }
.nd-loading__title { margin: 4px 0 0; font-size: 21px; font-weight: 700; }
.nd-loading__sub { margin: 0; color: var(--nd-muted); }
.nd-progress { width: 100%; height: 8px; border-radius: 999px; background: var(--nd-surface-2); overflow: hidden; margin-top: 8px; }
.nd-progress__bar { display: block; height: 100%; width: 3%; border-radius: inherit; background: var(--nd-brand); transition: width .25s ease; }
.nd-loading__step { margin: 0; min-height: 1.6em; color: var(--nd-text-2); font-size: 13.5px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

function markup() {
  const seg = [['admin', 'admin', 'لوحة المشرف'], ['school', 'school', 'صفحة المدرسة'], ['general', 'link', 'الرابط العام']]
    .map(([v, ic, label], i) => '<button type="button" role="tab" data-view="' + v + '" aria-selected="' + (i === 0) + '" tabindex="' + (i === 0 ? 0 : -1) + '">' + svgIcon(ic) + '<span>' + label + '</span></button>').join('');
  return [
    '<div class="nd" id="nd" dir="rtl" lang="ar">',
    '<header class="nd-bar" id="nd-bar">',
    '<div class="nd-brand"><span class="nd-brand__mark">' + svgIcon('pulse') + '</span><span class="nd-brand__name">نبض المدارس</span><span class="nd-pill"><span class="nd-pill__more">نسخة </span>تجريبية</span></div>',
    '<div class="nd-seg" id="nd-seg" role="tablist" aria-label="الصفحة المعروضة">' + seg + '</div>',
    '<div class="nd-ctx" id="nd-ctx" hidden></div>',
    '<div class="nd-actions"><button type="button" class="nd-iconbtn" data-act="mail" aria-label="بريد المشرف (تجريبي)" title="بريد المشرف (تجريبي)">' + svgIcon('mail') + '<span class="nd-badge" data-mail-badge hidden></span></button>' +
      '<button type="button" class="nd-iconbtn" data-act="menu" aria-label="القائمة" title="القائمة">' + svgIcon('menu') + '</button></div>',
    '</header>',
    '<main class="nd-stage" id="nd-stage"><div class="nd-screen" id="nd-screen"></div><div class="nd-toasts" id="nd-toasts" aria-live="polite"></div></main>',
    '</div>',
    '<div class="nd-scrim" id="nd-scrim" hidden></div>',
    '<aside class="nd-drawer" id="nd-drawer" dir="rtl" lang="ar" role="dialog" aria-modal="true" aria-label="القائمة" hidden></aside>',
    '<div id="nd-modals" dir="rtl" lang="ar"></div>',
    '<div class="nd-loading" id="nd-loading" dir="rtl" lang="ar"><div class="nd-loading__card">',
    '<span class="nd-brand__mark">' + svgIcon('pulse') + '</span>',
    '<h1 class="nd-loading__title">نبض المدارس</h1>',
    '<p class="nd-loading__sub">نسخة تجريبية تعمل داخل متصفحك</p>',
    '<div class="nd-progress" role="progressbar" aria-label="تجهيز النسخة التجريبية" aria-valuemin="0" aria-valuemax="100" aria-valuenow="3"><span class="nd-progress__bar"></span></div>',
    '<p class="nd-loading__step" id="nd-loading-step" aria-live="polite">تجهيز النسخة التجريبية</p>',
    '<button type="button" class="nd-btn nd-btn--primary" id="nd-loading-retry" hidden>إعادة المحاولة</button>',
    '</div></div>'
  ].join('\n');
}

/* ================================================================== 6. build */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function readText(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { fail('Missing input file: ' + file); }
  try { return UTF8.decode(bytes); } catch (e) { fail(file + ' is not valid UTF-8.'); }
  return '';
}
/** JSON for inside a <script>: no '<' (no </script>, no <!--), no raw U+2028/U+2029. */
function scriptJson(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
/**
 * Inline scripts hold whole HTML documents as JS strings (Code.gs's error page, email shell and sheet dialogs; the
 * shell's placeholder frame). They are inert inside <script>, but the Artifact host wraps this file in its own
 * document skeleton, so no `<!doctype`, `<html`, `<head` or `<body` text (opening or closing) may appear anywhere.
 * They are spelled with JS escapes that evaluate to the same characters in strings, templates and regexes.
 */
const DOC_TAG_RE = /<(!doctype|\/?(?:html|head|body))(?![\w-])/gi;
function quietDocTags(js) {
  return js.replace(DOC_TAG_RE, (m, t) => {
    if (t[0] === '!') return '<\\x21' + t.slice(1);
    if (t[0] === '/') return '<\\/' + t.slice(1);
    return '<\\x' + t.charCodeAt(0).toString(16) + t.slice(1);
  });
}
function assertScriptSafe(label, text) {
  if (/<\/script/i.test(text)) fail(label + ' contains "</script" — it cannot be inlined in a <script> element.');
  if (/<!--/.test(text)) fail(label + ' contains "<!--" — it cannot be inlined in a <script> element.');
}

/** Wraps Code.gs in a factory for GasRuntime.loadAppPrecompiled (no eval needed in the page). */
function compileCode(code) {
  const GasMock = require(MOCK_FILE);
  const GasRuntime = require(RUNTIME_FILE);
  const params = GasRuntime.engineParams(GasMock.createGasEnv({})).all;
  // The name scan also sees nested helpers (e.g. a local `const alert = …`); a name that is also an engine
  // parameter can only be a nested one (a top-level redeclaration would not compile), so it is not looked up.
  const names = GasRuntime.topLevelFunctionNames([{ code }]).filter((n) => params.indexOf(n) < 0);
  const lookup = 'function (__n) {\n  switch (__n) {\n' +
    names.map((n) => '    case ' + JSON.stringify(n) + ': return typeof ' + n + ' === "function" ? ' + n + ' : undefined;').join('\n') +
    '\n    default: return undefined;\n  }\n}';
  const factorySource = 'function (' + params.join(', ') + ') {\n' + quietDocTags(code) + '\n;\nreturn ' + lookup + ';\n}';
  return { factorySource, params, names };
}

function readInputs(srcDir) {
  const dir = path.resolve(srcDir || DEFAULT_SRC);
  const code = readText(path.join(dir, 'Code.gs'));
  const manifest = JSON.parse(readText(path.join(dir, 'appsscript.json')));
  const files = {};
  for (const n of PAGES) files[n] = readText(path.join(dir, n + '.html'));
  // The demo renders templates without eval: only <?!= name ?> / <?!= fn('literal') ?> scriptlets.
  for (const n of ['School', 'Admin']) {
    const bad = (files[n].match(/<\?[\s\S]*?\?>/g) || []).filter((s) => !/^<\?!?=\s*(?:[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\(\s*'[^'\\]*'\s*\))\s*\?>$/.test(s));
    if (bad.length) fail('src/' + n + '.html: scriptlet not supported by the demo renderer: ' + bad[0].slice(0, 80));
  }
  const vm1 = /^const APP_VERSION = '([^'\n]*)';$/m.exec(code);
  if (!vm1) fail("src/Code.gs: no line `const APP_VERSION = '…';`");
  return { dir, code, manifest, files, version: vm1[1], mock: readText(MOCK_FILE), runtime: readText(RUNTIME_FILE) };
}

/** Builds the page (pure). */
function build(o) {
  o = o || {};
  const inp = readInputs(o.srcDir);
  const compiled = compileCode(inp.code);
  assertScriptSafe('src/Code.gs', inp.code);
  assertScriptSafe('test/gas-mock.js', inp.mock);
  assertScriptSafe('test/runtime.js', inp.runtime);
  const pieces = [demoSeed, makeDemoPhoto, frameShim, shellMain].map((f) => quietDocTags(f.toString()));
  pieces.forEach((p, i) => assertScriptSafe('build-demo piece ' + i, p));

  const buildId = crypto.createHash('sha256')
    .update(JSON.stringify([DEMO_FORMAT, inp.code, inp.files, inp.manifest, inp.mock, inp.runtime, pieces, CSS]))
    .digest('hex').slice(0, 16);
  const icons = {};
  Object.keys(ICON_PATHS).forEach((k) => { icons[k] = svgIcon(k); });
  const B = {
    buildId, version: inp.version, demoUrl: DEMO_URL, owner: OWNER, ssName: SS_NAME,
    manifest: inp.manifest, params: compiled.params, names: compiled.names, files: inp.files, icons
  };

  const html = [
    '<title>نبض المدارس</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    '<meta name="description" content="نسخة تجريبية تفاعلية من نبض المدارس: لوحة المشرف وصفحة المدرسة والرابط العام ببيانات تجريبية.">',
    '<style>' + CSS + '</style>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="' + FONT_CSS.replace(/&/g, '&amp;') + '">',
    markup(),
    '<!-- نبض المدارس — نسخة تجريبية. Generated by tools/build-demo.js from src/ (build ' + buildId + '); do not edit by hand. -->',
    '<script>document.documentElement.lang = "ar"; document.documentElement.dir = "rtl";</script>',
    '<script>\n' + quietDocTags(inp.mock) + '\n</script>',
    '<script>\n' + quietDocTags(inp.runtime) + '\n</script>',
    '<script>\nwindow.__nabdCodeFactory = ' + compiled.factorySource + ';\n</script>',
    '<script>\nwindow.demoSeed = ' + pieces[0] + ';\nwindow.makeDemoPhoto = ' + pieces[1] + ';\n' + pieces[2] + '\n' +
      '(' + pieces[3] + ')(' + scriptJson(B) + ');\n</script>',
    ''
  ].join('\n');
  DOC_TAG_RE.lastIndex = 0;
  const docTag = DOC_TAG_RE.exec(html);
  if (docTag) {
    fail('demo.html must not contain document-level tag text such as "' + docTag[0] + '", not even inside a script ' +
      '(the Artifact host wraps the file in its own skeleton).');
  }
  return { html, buildId, bytes: Buffer.byteLength(html, 'utf8'), compiled, inputs: inp };
}

/* ------------------------------------------------------------------ self-check (Node) */
/** Loads the page's own Code.gs factory in a context that forbids eval and seeds a full demo through it. */
async function verify(result) {
  const GasMock = require(MOCK_FILE);
  const GasRuntime = require(RUNTIME_FILE);
  const ctx = vm.createContext({}, { codeGeneration: { strings: false } });
  const factory = vm.runInContext('(' + result.compiled.factorySource + ')', ctx, { filename: 'Code.gs (demo factory)' });
  const files = result.inputs.files;
  const resolver = (name) => files[String(name).replace(/\.html$/, '')] || null;
  const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082', 'hex').toString('base64');
  const photo = () => ({ base64: PNG_B64, mime: 'image/png', name: 'صورة.png', w: 1, h: 1 });
  const out = [];
  // A weekday morning, a weekday evening and a Friday (today becomes a workday for the demo).
  for (const iso of ['2026-10-14T05:40:00Z', '2026-10-14T16:30:00Z', '2026-10-16T09:00:00Z']) {
    const env = GasMock.createGasEnv({ ownerEmail: OWNER, scriptUrl: DEMO_URL, spreadsheetName: SS_NAME, clock: { iso, running: true } });
    env.setManifest(result.inputs.manifest);
    const app = GasRuntime.loadAppPrecompiled({ factory, params: result.compiled.params, names: result.compiled.names }, env, { files: resolver });
    const now = Date.parse(iso);
    const res = await demoSeed({ GasMock, env, app, now, photo });
    // the seed returns the clock to real time; the check pins it back to the seed's "now"
    env.clock.set(now, { running: true });
    const day = app.call('api_day', res.token);
    if (!day || !day.rows || day.rows.length !== 8) fail('self-check: dashboard does not show 8 schools (' + iso + ')');
    if (env.formulaWrites.length) fail('self-check: user text reached Sheets as a formula during seeding');
    const html = app.doGet({ s: res.schools[0].token });
    if (!/window\.BOOT/.test(html)) fail('self-check: school page did not render');
    const range = app.call('api_range', res.token, GasMock.formatDate(now - 30 * 864e5, 'Asia/Riyadh', 'yyyy-MM-dd'), day.date);
    out.push({ at: iso, submittedToday: day.totals.submitted, pending: day.totals.pending, pendingOther: day.pendingOther.length,
      returnedOther: (day.returnedOther || []).length, reports: range.totals.reports, mails: env.mailbox.length,
      photos: env.drive.files.length, alerts: day.alerts.map((a) => a.type).join(',') });
  }
  return out;
}

function writeIfChanged(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (e) { old = null; }
  if (old === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

module.exports = { build, verify, compileCode, demoSeed, frameShim, shellMain, makeDemoPhoto, DEMO_URL, OWNER, BuildError };

/* ------------------------------------------------------------------ CLI */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
  const flag = (name) => argv.includes('--' + name);
  (async () => {
    const out = path.resolve(arg('out') || DEFAULT_OUT);
    const r = build({ srcDir: arg('src') });
    if (flag('check')) {
      let cur = null;
      try { cur = fs.readFileSync(out, 'utf8'); } catch (e) { cur = null; }
      if (cur !== r.html) { process.stderr.write(path.relative(ROOT, out) + ' is out of date — run: node tools/build-demo.js\n'); process.exit(1); }
      process.stdout.write(path.relative(ROOT, out) + ' is up to date (build ' + r.buildId + ')\n');
      return;
    }
    if (!flag('no-verify')) {
      const rows = await verify(r);
      if (!flag('quiet')) rows.forEach((x) => process.stdout.write('  self-check ' + JSON.stringify(x) + '\n'));
    }
    const changed = writeIfChanged(out, r.html);
    if (!flag('quiet')) {
      process.stdout.write((changed ? 'wrote ' : 'unchanged ') + path.relative(ROOT, out) + ' — ' + (r.bytes / 1024).toFixed(0) + ' KB, build ' + r.buildId + '\n');
    }
  })().catch((e) => {
    process.stderr.write((e instanceof BuildError ? 'build-demo: ' + e.message : (e && e.stack) || String(e)) + '\n');
    process.exit(1);
  });
}
