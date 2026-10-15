/*
 * bundle.js — tests for the single-file install dist/Code.gs (tools/build-bundle.js), with node:test.
 *
 *   npm run test:bundle            (or: node --test test/bundle.js)
 *
 * The bundle is built from src/, then dist/Code.gs is loaded ALONE (with dist/appsscript.json) into a mock
 * project that has no .html files at all. Every scenario runs twice, side by side, with identical clocks and
 * random seeds: once on the multi-file project (src/Code.gs + the 4 .html files) and once on the bundle.
 * Pages, API results, emails and dialogs must be identical.
 */
'use strict';
process.env.TZ = process.env.NABD_TEST_TZ || 'America/Los_Angeles';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const GasMock = require('./gas-mock.js');
const { loadApp, extractBoot } = require('./runtime.js');
const builder = require('../tools/build-bundle.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const TOOL = path.join(ROOT, 'tools', 'build-bundle.js');
const BUNDLE = path.join(DIST, 'Code.gs');
const PAGES = ['Styles', 'Common', 'School', 'Admin'];
const OWNER = 'supervisor@gmail.com';
const BASE_URL = 'https://script.google.com/macros/s/AKfycbBUNDLE/exec';
const TODAY = '2026-10-14';
const MARKER = '\nvar NABD_EMBEDDED_FILES_ = ';
// 1×1 PNG
const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082', 'hex').toString('base64');
// Raw characters that must never appear inside the embedded literals (they are written as \uXXXX).
const RAW_SPECIAL = /[\u007f-\u00a0\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff\r]/;

let BUILT = null;
/** Builds dist/ once per run (from the current src/). */
function built() {
  if (!BUILT) BUILT = builder.build({ srcDir: SRC, outDir: DIST });
  return BUILT;
}
function srcPages() {
  const extra = fs.readdirSync(SRC).filter((f) => /\.html$/.test(f)).map((f) => f.slice(0, -5)).filter((n) => !PAGES.includes(n)).sort();
  return PAGES.concat(extra);
}
/**
 * The embedded map read back line by line: `{`, then per page `  "<name>": [`, one JSON string literal per line
 * (4-space indent, comma after all but the last), `  ].join('')` (comma after all but the last page), `}`.
 * map: name → the chunks (each JSON.parse'd) joined; chunks: name → the chunk strings.
 */
function embeddedJson(text) {
  assert.equal(text.split(MARKER).length, 2, 'exactly one `var NABD_EMBEDDED_FILES_ = …` declaration');
  let rhs = text.slice(text.indexOf(MARKER) + MARKER.length);
  assert.match(rhs, /\};\n$/, 'the embedded map is the last statement');
  rhs = rhs.slice(0, -2);
  const lines = rhs.split('\n');
  assert.equal(lines[0], '{');
  assert.equal(lines[lines.length - 1], '}');
  const map = {}, chunks = {};
  let name = null;
  lines.slice(1, -1).forEach((ln, i, all) => {
    let m;
    if (name === null) {
      m = /^  ("[^"]+"): \[$/.exec(ln);
      assert.ok(m, 'page header line: ' + ln.slice(0, 80));
      name = JSON.parse(m[1]);
      chunks[name] = [];
      return;
    }
    if ((m = /^  \]\.join\(''\)(,?)$/.exec(ln))) {
      assert.equal(m[1], i === all.length - 1 ? '' : ',', 'commas between pages only');
      assert.equal(/,$/.test(all[i - 1]), false, 'no comma after the last chunk');
      map[name] = chunks[name].join('');
      name = null;
      return;
    }
    m = /^ {4}(".*?")(,?)$/.exec(ln);
    assert.ok(m, 'chunk line: ' + ln.slice(0, 80));
    if (!m[2]) assert.match(all[i + 1], /^  \]\.join/, 'a chunk without a comma is the last of its page');
    chunks[name].push(JSON.parse(m[1]));
  });
  assert.equal(name, null, 'every page is closed');
  return { rhs, map, chunks };
}
function lastCode(env) {
  const m = env.mailbox[env.mailbox.length - 1];
  assert.ok(m, 'an email was sent');
  return /(\d{6})/.exec(m.subject)[1];
}
/** Equal strings, or a short report of where they first differ (pages are ~300 KB). */
function sameText(actual, expected, label) {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  assert.fail(label + ': differs at offset ' + i + ' (lengths ' + actual.length + ' vs ' + expected.length + ')\n' +
    '  bundle: ' + JSON.stringify(actual.slice(Math.max(0, i - 60), i + 80)) + '\n' +
    '  files:  ' + JSON.stringify(expected.slice(Math.max(0, i - 60), i + 80)));
}

/**
 * Code.gs mixes Math.random() into its random ids (with Utilities.getUuid, which the mock already seeds).
 * Both twins get the same seeded Math so codes, tokens and ids match and whole pages can be compared.
 */
function seededMath(seed) {
  let s = seed >>> 0;
  const m = Object.create(Math);
  m.random = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), s | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return m;
}

/** One mock project: 'files' = src/Code.gs + src/*.html; 'bundle' = dist/Code.gs alone, no .html files. */
function project(kind, o = {}) {
  const env = GasMock.createGasEnv({ ownerEmail: OWNER, scriptUrl: BASE_URL, clock: o.clock || TODAY + 'T07:30', seed: 20261014 });
  env.globals.Math = seededMath(1446);
  let app;
  if (kind === 'bundle') {
    built();
    app = loadApp({ srcDir: DIST, env, code: o.code });   // reads dist/Code.gs (+ dist/appsscript.json scopes)
    env.setFiles({});                                     // EMPTY: any project-file read throws "No HTML file named …"
  } else {
    app = loadApp({ srcDir: SRC, env });
  }
  return { kind, env, app };
}

/** The same steps on both projects; every result must match. */
function twins(o) {
  const A = project('files', o), B = project('bundle', o);
  const run = (fn, s) => { try { return { value: fn(s) }; } catch (e) { return { error: String(e && e.message) }; } };
  const both = (label, fn) => {
    const a = run(fn, A), b = run(fn, B);
    assert.deepEqual(b, a, label + ': the bundle behaves differently from the multi-file project');
    if (a.error) assert.fail(label + ' failed (in both projects): ' + a.error);
    return b.value;
  };
  const call = (fn, ...args) => both(fn, (s) => s.app.call(fn, ...args));
  const page = (params) => {
    const label = 'doGet(' + JSON.stringify(params) + ')';
    const a = A.app.doGetOutput(params), b = B.app.doGetOutput(params);
    sameText(b.html, a.html, label);
    assert.equal(b.title, a.title, label + ' title');
    assert.deepEqual(b.metaTags, a.metaTags, label + ' meta tags');
    assert.equal(b.xFrameOptionsMode, a.xFrameOptionsMode, label + ' X-Frame-Options');
    assert.ok(!b.html.includes('<?'), label + ': every scriptlet was evaluated');
    const boot = extractBoot(b.html);
    assert.ok(boot, label + ': a real page with window.BOOT (not the error page)');
    for (const n of ['Styles', 'Common']) {
      assert.ok(b.html.includes(fs.readFileSync(path.join(SRC, n + '.html'), 'utf8')), label + ': includes ' + n);
    }
    return { html: b.html, title: b.title, boot };
  };
  return { A, B, both, call, page };
}

function answersFor(fields, photos) {
  const a = {};
  for (const f of fields) {
    if (f.type === 'select') a[f.id] = f.options[0];
    else if (f.type === 'attendance') a[f.id] = { students: { present: 380, absent: 20 }, teachers: { present: 29, absent: 1 }, staff: { present: 8, absent: 0 } };
    else if (f.type === 'number') a[f.id] = f.kpi === 'lessons_planned' ? 40 : f.kpi === 'lessons_done' ? 36 : Math.max(1, f.min || 0);
    else if (f.type === 'textarea') a[f.id] = 'سير اليوم منتظم — تجربة الملف الموحّد';
    else if (f.type === 'text' && f.required) a[f.id] = 'نص';
    else if (f.type === 'yesno') a[f.id] = false;
    else if (f.type === 'photos' && photos) a[f.id] = photos;
  }
  return a;
}

/* ================================================================== build */
describe('build (tools/build-bundle.js)', () => {
  it('writes dist/Code.gs = header + src/Code.gs verbatim + the embedded pages, and dist/appsscript.json', () => {
    const b = built();
    assert.equal(b.codePath, BUNDLE);
    const text = fs.readFileSync(BUNDLE, 'utf8');
    const code = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8');
    const at = text.indexOf(code);
    assert.ok(at > 0 && text.indexOf(code, at + 1) < 0, 'src/Code.gs appears exactly once, after the header');
    const head = text.slice(0, at);
    assert.match(head, /^\/\*\*\n[\s\S]*\n \*\/\n\n$/, 'the header is one comment block');
    assert.equal(text.slice(at + code.length, text.indexOf(MARKER) + 1).split('\n').filter((l) => !/^(\/\/.*)?$/.test(l)).length, 0,
      'only comments between Code.gs and the embedded map');
    assert.ok(fs.readFileSync(path.join(DIST, 'appsscript.json')).equals(fs.readFileSync(path.join(SRC, 'appsscript.json'))), 'manifest copied byte for byte');
    assert.doesNotThrow(() => new vm.Script(text, { filename: 'dist/Code.gs' }), 'valid JavaScript');
  });

  it('the header says what it is, the version, the 4 install steps and «لا تعدّل هذا الملف» (Arabic + English)', () => {
    const text = fs.readFileSync(BUNDLE, 'utf8');
    const head = text.slice(0, text.indexOf('*/') + 2);
    const version = project('bundle').app.evaluate('APP_VERSION');
    assert.equal(version, /const APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8'))[1]);
    assert.ok(head.includes('version ' + version), 'version');
    assert.ok(head.includes('build ' + built().buildId + '\n'), 'content-derived build id');
    assert.match(built().buildId, /^[0-9a-f]{12}$/);
    assert.match(head, /نبض المدارس/);
    assert.match(head, /لا تعدّل هذا الملف/);
    assert.match(head, /Do not edit this file/);
    for (const n of [1, 2, 3, 4]) {
      assert.equal(head.split('\n').filter((l) => new RegExp('^ \\*   ' + n + '\\. ').test(l)).length, 2, 'step ' + n + ' in Arabic and English');
    }
    for (const s of ['Apps Script', 'Code.gs', 'تطبيق ويب', 'أي شخص', 'تحديد الكل', '/exec', 'إصدار جديد', 'Select all', 'New version']) assert.ok(head.includes(s), s);
    assert.doesNotMatch(head, /\b(19|20)\d\d-\d\d-\d\d\b|\b\d\d:\d\d(:\d\d)?\b/, 'no timestamps');
    assert.ok(!/\/(home|root|tmp|Users)\//.test(text.slice(0, text.indexOf(MARKER) + 400)), 'no machine paths');
    assert.ok(!RAW_SPECIAL.test(head), 'no invisible characters in the header');
    assert.ok(head.split('\n').length <= 40, 'short');
  });

  it('is deterministic: same bytes on every run, whatever the clock, time zone, locale or working folder', () => {
    const a = builder.bundle({ srcDir: SRC }).code;
    const RealDate = Date;
    const later = RealDate.UTC(2031, 6, 1, 12, 34, 56);
    global.Date = class extends RealDate {
      constructor(...x) { super(...(x.length ? x : [later])); }
      static now() { return later; }
    };
    let b;
    try { b = builder.bundle({ srcDir: SRC }).code; } finally { global.Date = RealDate; }
    assert.equal(b, a, 'another clock → same output');
    assert.ok(fs.readFileSync(BUNDLE).equals(Buffer.from(a, 'utf8')), 'dist/Code.gs is what the build returns');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nabd-bundle-'));
    try {
      const env = Object.assign({}, process.env, { TZ: 'Pacific/Kiritimati', LANG: 'ar_SA.UTF-8', LC_ALL: 'ar_SA.UTF-8' });
      const r = spawnSync(process.execPath, [TOOL, '--out', tmp, '--quiet'], { cwd: tmp, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(fs.readFileSync(path.join(tmp, 'Code.gs')).equals(fs.readFileSync(BUNDLE)), 'CLI from another folder/TZ/locale → same bytes');
      assert.ok(fs.readFileSync(path.join(tmp, 'appsscript.json')).equals(fs.readFileSync(path.join(DIST, 'appsscript.json'))));
      assert.deepEqual(fs.readdirSync(tmp).sort(), ['Code.gs', 'appsscript.json'], 'no temp files left behind');
      const again = spawnSync(process.execPath, [TOOL, '--out', tmp], { cwd: tmp, env, encoding: 'utf8' });
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /unchanged/);
      assert.equal(spawnSync(process.execPath, [TOOL, '--check', '--out', tmp, '--quiet']).status, 0, '--check: up to date');
      fs.appendFileSync(path.join(tmp, 'Code.gs'), '// hand edit\n');
      const stale = spawnSync(process.execPath, [TOOL, '--check', '--out', tmp], { encoding: 'utf8' });
      assert.equal(stale.status, 1, '--check: a hand-edited bundle is reported');
      assert.match(stale.stderr, /out of date: Code\.gs/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports the bundle size', (t) => {
    const b = built();
    const bytes = fs.statSync(BUNDLE).size;
    assert.equal(bytes, b.parts.total);
    assert.equal(b.parts.header + b.parts.code + b.parts.embedded, bytes);
    const kib = (n) => (n / 1024).toFixed(1) + ' KiB';
    const line = 'dist/Code.gs: ' + bytes.toLocaleString('en-US') + ' bytes (' + kib(bytes) + ', ' + (bytes / 1048576).toFixed(2) + ' MiB), ' +
      b.parts.lines.toLocaleString('en-US') + ' lines — header ' + kib(b.parts.header) + ' + Code.gs ' + kib(b.parts.code) +
      ' + embedded pages ' + kib(b.parts.embedded) + ' (' + b.files.map((f) => f.name + ' ' + kib(f.bytes)).join(', ') + ')';
    const longest = Math.max(...fs.readFileSync(BUNDLE, 'utf8').split('\n').map((l) => l.length));
    t.diagnostic(line);
    t.diagnostic('longest line: ' + longest.toLocaleString('en-US') + ' characters (pages are split into JSON string chunks of ≤ ' +
      builder.MAX_LINE.toLocaleString('en-US') + ')');
  });
});

/* ================================================================== round trip */
describe('embedded pages', () => {
  it('round-trip byte-exact (as JSON and as Apps Script evaluates them), in the documented order', () => {
    const text = fs.readFileSync(BUNDLE, 'utf8');
    const { rhs, map } = embeddedJson(text);
    assert.deepEqual(Object.keys(map), srcPages(), 'keys = file names without .html');
    const B = project('bundle');
    const live = B.app.evaluate('NABD_EMBEDDED_FILES_');
    assert.deepEqual(Object.keys(live), srcPages());
    for (const n of srcPages()) {
      const bytes = fs.readFileSync(path.join(SRC, n + '.html'));
      assert.ok(Buffer.from(map[n], 'utf8').equals(bytes), n + '.html (JSON.parse)');
      assert.ok(Buffer.from(live[n], 'utf8').equals(bytes), n + '.html (Apps Script runtime)');
      assert.equal(B.app.call('include', n), bytes.toString('utf8'), 'include(' + n + ') serves the embedded copy');
    }
    assert.ok(!RAW_SPECIAL.test(rhs), 'no raw invisible / bidi / line-separator / CR characters inside the literals');
    assert.ok(!/[^\S ]/.test(rhs.replace(/\n/g, '')), 'no raw whitespace other than spaces and the layout line breaks');
    const { chunks } = embeddedJson(text);
    for (const n of srcPages()) {
      assert.ok(chunks[n].length > 1, n + ' is split into chunks');
      chunks[n].slice(0, -1).forEach((c) => assert.ok(c.endsWith('\n'), n + ': chunks end at the page\'s own line breaks'));
    }
    const admin = fs.readFileSync(path.join(SRC, 'Admin.html'), 'utf8');
    if (admin.includes('\ufeff')) {
      assert.ok(rhs.includes('\\ufeff') && map.Admin.includes('\ufeff'), 'the CSV byte-order mark in Admin.html is kept, escaped');
    }
  });

  it('no line of dist/Code.gs is longer than 4,000 characters', () => {
    const text = fs.readFileSync(BUNDLE, 'utf8');
    assert.equal(builder.MAX_LINE, 4000);
    const long = text.split('\n').map((l, i) => ({ i: i + 1, n: l.length })).filter((x) => x.n > builder.MAX_LINE);
    assert.deepEqual(long, [], 'lines over 4,000 characters');
  });

  it('chunks never split a surrogate pair or an escape, even inside one very long line; deterministic', () => {
    const emoji = '\ud83d\udccb', mix = 'نبض \u200f' + emoji + '\u2028"\\</script>\ufeff\u0001';
    const longLine = Array.from({ length: 3000 }, (_, i) => (i % 7 === 0 ? emoji : i % 5 === 0 ? mix : 'س' + (i % 10))).join('') + '\n';
    const text = 'أول سطر\n' + longLine + emoji.repeat(2100) + '\n' + 'x'.repeat(3994) + '\n' + mix.repeat(500) + 'آخر بلا سطر جديد';
    const parts = builder.chunkText(text);
    assert.equal(parts.join(''), text, 'joins back to the exact text');
    assert.deepEqual(builder.chunkText(text), parts, 'deterministic');
    for (const c of parts) {
      const lit = builder.jsonLiteral(c);
      assert.ok(lit.length + 5 <= builder.MAX_LINE, 'fits on one line: ' + lit.length);
      assert.equal(JSON.parse(lit), c);
      assert.doesNotMatch(c, /^[\udc00-\udfff]|[\ud800-\udbff]$/, 'no surrogate pair cut in two');
    }
    assert.ok(parts.length >= 8);
    assert.deepEqual(builder.chunkText(''), [''], 'an empty page is one empty chunk');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nabd-chunks-'));
    try {
      for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, 'Extra.html'), text);
      const b = builder.bundle({ srcDir: dir });
      assert.ok(b.code.split('\n').every((l) => l.length <= builder.MAX_LINE));
      const { map } = embeddedJson(b.code);
      assert.equal(map.Extra, text);
      assert.equal(vm.runInNewContext(b.code + '\nNABD_EMBEDDED_FILES_.Extra', {}), text, 'what Apps Script evaluates');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('jsonLiteral escapes every risky character and parses back exactly', () => {
    const nasty = 'a"b\\c\n\r\t\u0000\u001f\u007f\u0085\u00a0\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202e\u2066\u2069\ufe0f\ufeff' +
      '\ue000\uffff \ud83d\udccb \ud800 \udc00 </script> <?!= include(\'x\') ?> نبض ⚙️ 👨‍👩‍👧 \u{e0041}\u{f0000}';
    const lit = builder.jsonLiteral(nasty);
    assert.equal(JSON.parse(lit), nasty);
    assert.equal(vm.runInNewContext('(' + lit + ')'), nasty);
    assert.ok(!RAW_SPECIAL.test(lit) && !/[\u0000-\u001f\u2028\u2029]/.test(lit), lit);
    assert.ok(lit.includes('نبض') && lit.includes('\ud83d\udccb'), 'ordinary Arabic text and emoji stay readable');
    assert.ok(!/[\ud800-\udfff]/.test(lit.replace(/\ud83d[\udc00-\udfff]/g, '')), 'only real emoji pairs stay raw');
  });

  it('survive CRLF line endings (a Windows download or editor) unchanged', () => {
    const crlf = fs.readFileSync(BUNDLE, 'utf8').replace(/\n/g, '\r\n');
    const W = project('bundle', { code: crlf });
    const L = project('bundle');
    const live = W.app.evaluate('NABD_EMBEDDED_FILES_');
    for (const n of srcPages()) assert.equal(live[n], fs.readFileSync(path.join(SRC, n + '.html'), 'utf8'), n);
    for (const params of [{}, { f: 'all' }, { s: '__preview' }]) sameText(W.app.doGet(params), L.app.doGet(params), 'CRLF doGet ' + JSON.stringify(params));
  });
});

/* ================================================================== same behaviour */
describe('dist/Code.gs alone behaves exactly like the multi-file project', () => {
  it('loads only dist/Code.gs, enforces dist/appsscript.json and exposes the same public functions', () => {
    const t = twins();
    assert.deepEqual(t.B.app.sources(), [BUNDLE]);
    assert.deepEqual(t.B.env.manifestScopes, JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8')).oauthScopes);
    t.both('publicFunctions', (s) => s.app.publicFunctions());
    assert.ok(!t.B.app.publicFunctions().includes('NABD_EMBEDDED_FILES_'));
    assert.throws(() => t.B.env.globals.HtmlService.createTemplateFromFile('Admin'), /No HTML file named Admin/, 'the bundle project really has no .html files');
  });

  it('doGet: admin, ?f=all, ?s=__preview and an unknown link render the same HTML before setup', () => {
    const t = twins();
    assert.equal(t.page({}).boot.page, 'admin');
    assert.equal(t.page({}).boot.status.setupDone, false);
    assert.equal(t.page({ f: 'all' }).boot.mode, 'picker');
    assert.equal(t.page({ s: '__preview' }).boot.form.preview, true);
    assert.equal(t.page({ s: 'NoSuchSchoolToken123' }).boot.page, 'school');
  });

  it('full flow: setup by emailed code → add a school → ?s=<token> → submit with a photo → approve → digest and menu', () => {
    const t = twins();
    t.page({});
    // 1. setup through the one-time code emailed to the owner
    const otp = t.call('api_requestCode');
    assert.equal(otp.ok, true);
    const code = t.both('code in the email', (s) => lastCode(s.env));
    assert.match(code, /^\d{6}$/);
    const v = t.call('api_verifyCode', otp.cid, code, 'Bundle test');
    assert.equal(v.ok, true);
    const token = v.token;
    const setup = t.call('api_completeSetup', token, {
      supervisor: { name: 'أحمد المشرف', title: 'المشرف التربوي', office: 'مكتب التعليم بالشمال', phone: '0500000000' },
      systemTitle: 'متابعة سير العملية التعليمية',
      schoolsText: '',
      preset: 'standard'
    });
    assert.equal(setup.ok, true);
    const admin = t.page({});
    assert.equal(admin.boot.status.setupDone, true);

    // 2. add a school
    const saved = t.call('api_saveSchool', token, { name: 'مدرسة النور الابتدائية', principal: 'أ. خالد العتيبي', phone: '0501234567',
      students: 400, teachers: 30, staff: 8, stage: 'ابتدائي' });
    assert.equal(saved.ok, true);
    const school = saved.school;
    assert.ok(school.token && school.id);
    assert.equal(t.call('api_schools', token).schools.length, 1);

    // 3. every page renders the same from the bundle
    const form = t.page({ s: school.token });
    assert.equal(form.boot.form.ok, true);
    assert.equal(form.boot.form.school.name, 'مدرسة النور الابتدائية');
    assert.equal(form.boot.form.existing, null);
    assert.match(form.title, /مدرسة النور الابتدائية/);
    const picker = t.page({ f: 'all' });
    assert.ok(JSON.stringify(picker.boot.picker).includes('مدرسة النور الابتدائية'));
    assert.equal(t.page({ s: '__preview' }).boot.form.preview, true);
    assert.equal(t.page({ s: school.token, d: '2026-10-13' }).boot.form.date, TODAY);

    // 4. the school submits today's report with an evidence photo
    const fields = t.call('api_bootstrap', token).fields;
    const up = t.call('api_uploadPhoto', school.token, { base64: PNG_B64, mime: 'image/png', name: 'شاهد.png', w: 1, h: 1 });
    assert.equal(up.ok, true);
    const sent = t.call('api_submitReport', school.token, { answers: answersFor(fields, [up.photo]), filledBy: 'أ. خالد' });
    assert.equal(sent.ok, true);
    assert.equal(sent.receipt.date, TODAY);
    assert.equal(t.call('api_schoolPhoto', school.token, up.photo.id).dataUrl, 'data:image/png;base64,' + PNG_B64);
    assert.equal(t.page({ s: school.token }).boot.form.existing.status, 'pending');

    // 5. the supervisor sees it and approves it
    let day = t.call('api_day', token, TODAY);
    let row = day.rows.find((r) => r.school.id === school.id);
    assert.equal(row.report.status, 'pending');
    const rev = t.call('api_review', token, TODAY, school.id, 'approve');
    assert.equal(rev.ok, true);
    assert.equal(rev.report.status, 'approved');
    day = t.call('api_day', token, TODAY);
    row = day.rows.find((r) => r.school.id === school.id);
    assert.equal(row.report.status, 'approved');
    assert.equal(t.page({ s: school.token }).boot.form.existing.status, 'approved');
    t.call('api_report', token, TODAY, school.id);
    t.call('api_range', token, '2026-10-01', TODAY);
    t.page({});

    // 6. the daily digest email and the spreadsheet menu
    assert.equal(t.call('api_saveSettings', token, { digest: { enabled: true, time: '10:00' } }).ok, true);
    const mail = t.both('dailyDigest', (s) => {
      s.env.clock.set(TODAY + 'T10:00');
      s.app.runTrigger('dailyDigest');
      const m = s.env.mailbox[s.env.mailbox.length - 1];
      return { to: m.to, subject: m.subject, body: m.body, htmlBody: m.htmlBody };
    });
    assert.equal(mail.to, OWNER);
    assert.ok(mail.htmlBody.includes(BASE_URL), 'the digest links to the saved deployment');
    const menu = t.both('menu', (s) => {
      s.app.onOpen();
      s.app.runMenu('menuShowLink');
      s.app.runMenu('menuShowGuide');
      return { menus: s.env.ui.menus, dialogs: s.env.ui.dialogs };
    });
    assert.equal(menu.dialogs.length, 2);
    assert.ok(menu.dialogs[0].html.includes(BASE_URL));

    // 7. nothing in the bundle project was ever read from an .html file
    const fileReads = (s) => (s.env.counters['HtmlService.createTemplateFromFile'] || 0) + (s.env.counters['HtmlService.createHtmlOutputFromFile'] || 0);
    assert.ok(fileReads(t.A) > 0, 'sanity: the multi-file project reads its .html files');
    assert.equal(fileReads(t.B), 0, 'the bundle never reads an .html file');
    assert.deepEqual(t.B.env.warnings, t.A.env.warnings);
  });
});

/* ================================================================== guard rails */
describe('build guard rails', () => {
  const copySrc = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nabd-src-'));
    for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
    return dir;
  };
  it('fails clearly on a missing page, an include() of a page that does not exist, or a hand-declared map', () => {
    const dir = copySrc();
    try {
      fs.renameSync(path.join(dir, 'Common.html'), path.join(dir, 'Common.bak'));
      assert.throws(() => builder.bundle({ srcDir: dir }), /Missing src\/Common\.html/);
      fs.renameSync(path.join(dir, 'Common.bak'), path.join(dir, 'Common.html'));

      const school = fs.readFileSync(path.join(dir, 'School.html'), 'utf8');
      fs.writeFileSync(path.join(dir, 'School.html'), school.replace("<?!= include('Common') ?>", "<?!= include('Common') ?><?!= include('Charts') ?>"));
      assert.throws(() => builder.bundle({ srcDir: dir }), /School\.html loads "Charts"/);
      fs.writeFileSync(path.join(dir, 'School.html'), school);

      const code = fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8');
      fs.writeFileSync(path.join(dir, 'Code.gs'), code + '\nvar NABD_EMBEDDED_FILES_ = {};\n');
      assert.throws(() => builder.bundle({ srcDir: dir }), /only the bundler may define it/);
      fs.writeFileSync(path.join(dir, 'Code.gs'), code.replace("const APP_VERSION = '", "const APP_VERSION_X = '"));
      assert.throws(() => builder.bundle({ srcDir: dir }), /APP_VERSION/);
      fs.writeFileSync(path.join(dir, 'Code.gs'), code + "\nfunction printPage_() { return HtmlService.createTemplateFromFile('Print').evaluate(); }\n");
      assert.throws(() => builder.bundle({ srcDir: dir }), /outside htmlTemplate_\/htmlFile_/);
      fs.writeFileSync(path.join(dir, 'Code.gs'), code);
      fs.writeFileSync(path.join(dir, 'Styles.html'), Buffer.from([0x3c, 0xff, 0xfe, 0x3e]));
      assert.throws(() => builder.bundle({ srcDir: dir }), /not valid UTF-8/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('embeds an extra src/*.html partial after the four pages, and the bundle serves it', () => {
    const dir = copySrc();
    try {
      fs.writeFileSync(path.join(dir, 'Extra.html'), '<p>إضافي\u2028\ufeff</p>\n');
      const b = builder.bundle({ srcDir: dir });
      const { map } = embeddedJson(b.code);
      assert.deepEqual(Object.keys(map), PAGES.concat('Extra'));
      assert.notEqual(b.buildId, built().buildId, 'another input → another build id');
      assert.ok(b.code.includes('build ' + b.buildId + '\n'), 'the header carries the build id');
      const env = GasMock.createGasEnv({ ownerEmail: OWNER, scriptUrl: BASE_URL, clock: TODAY + 'T07:30', seed: 1 });
      const app = loadApp({ srcDir: DIST, env, code: b.code });
      env.setFiles({});
      assert.equal(app.call('include', 'Extra'), '<p>إضافي\u2028\ufeff</p>\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
