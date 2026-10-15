#!/usr/bin/env node
/*
 * build-bundle.js — builds the single-file install of «نبض المدارس» (Node built-ins only).
 *
 *   node tools/build-bundle.js              → writes dist/Code.gs and dist/appsscript.json
 *   node tools/build-bundle.js --check      → writes nothing; exit 1 when dist/ is not what src/ builds
 *   node tools/build-bundle.js --out DIR    → writes into DIR instead of dist/   (--src DIR reads another src/)
 *   node tools/build-bundle.js --quiet      → no summary
 *
 *   const b = require('./tools/build-bundle.js');
 *   b.bundle({ srcDir })        → { code, manifest, version, buildId, parts, files }   (pure: reads, never writes)
 *   b.build({ srcDir, outDir }) → same + { codePath, manifestPath, changed }            (writes the two files)
 *
 * dist/Code.gs = a short Arabic/English header (what it is, version, the 4 install steps, «لا تعدّل هذا الملف»)
 *              + src/Code.gs byte for byte
 *              + `var NABD_EMBEDDED_FILES_ = {…};` — Styles, Common, School, Admin (then any other src/*.html,
 *                sorted) as JSON string literals. Code.gs reads them through embeddedHtml_(), so the pasted
 *                project needs no .html files.
 * The right-hand side of that declaration is plain JSON (other tools may JSON.parse it). On top of what
 * JSON.stringify escapes, every invisible / format / bidi-control / non-ASCII-space / private-use character is
 * written as a \uXXXX escape: a copy-paste or an editor cannot silently drop or change it, and U+2028/U+2029
 * never appear raw. The literals contain no raw line breaks, so CRLF conversion cannot change them either.
 * Every build re-reads its own output and checks it (syntax + byte-exact round-trip) before writing.
 * Deterministic: no timestamps, no absolute paths, no locale/time-zone/Unicode-version dependence.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SRC = path.join(ROOT, 'src');
const DEFAULT_OUT = path.join(ROOT, 'dist');
/** Bump when the bundle layout changes (it is part of the build id). */
const BUNDLE_FORMAT = 1;
/** Embedded in this order; any other src/*.html follows, sorted by name. */
const PAGE_ORDER = ['Styles', 'Common', 'School', 'Admin'];
const EMBED_VAR = 'NABD_EMBEDDED_FILES_';
const RULE = '═'.repeat(75);

class BuildError extends Error {}
function fail(msg) { throw new BuildError(msg); }

/* ------------------------------------------------------------------ inputs */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });   // keeps a BOM, rejects bad bytes

function readText(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { fail('Missing input file: ' + file); }
  let text;
  try { text = UTF8.decode(bytes); } catch (e) { fail(file + ' is not valid UTF-8 — re-save it as UTF-8.'); }
  return { bytes, text };
}

function readInputs(srcDir) {
  const dir = path.resolve(srcDir || DEFAULT_SRC);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { fail('Source folder not found: ' + dir); }
  const htmlNames = names.filter((f) => /\.html$/.test(f)).map((f) => f.replace(/\.html$/, ''));
  for (const n of PAGE_ORDER) if (htmlNames.indexOf(n) < 0) fail('Missing src/' + n + '.html');
  const extra = htmlNames.filter((n) => PAGE_ORDER.indexOf(n) < 0).sort();
  for (const n of extra) if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(n)) fail('src/' + n + '.html: page names must be letters/digits/_ (include() only accepts those).');
  const pages = PAGE_ORDER.concat(extra).map((name) => Object.assign({ name }, readText(path.join(dir, name + '.html'))));
  return { dir, code: readText(path.join(dir, 'Code.gs')), manifest: readText(path.join(dir, 'appsscript.json')), pages };
}

/* ------------------------------------------------------------------ encoding */
/** Characters that are invisible, change text direction, look like a plain space, or are private/special. */
function mustEscape(cp) {
  return (cp >= 0x7F && cp <= 0xA0) || cp === 0xAD || cp === 0x34F || cp === 0x61C ||
    cp === 0x115F || cp === 0x1160 || cp === 0x1680 || cp === 0x17B4 || cp === 0x17B5 || (cp >= 0x180B && cp <= 0x180F) ||
    (cp >= 0x2000 && cp <= 0x200F) || (cp >= 0x2028 && cp <= 0x202F) || (cp >= 0x205F && cp <= 0x206F) ||
    cp === 0x3000 || cp === 0x3164 || (cp >= 0xD800 && cp <= 0xDFFF) || (cp >= 0xE000 && cp <= 0xF8FF) ||
    (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0xFEFF || cp === 0xFFA0 || (cp >= 0xFFF0 && cp <= 0xFFFF) ||
    (cp >= 0x1BCA0 && cp <= 0x1BCA3) || (cp >= 0x1D173 && cp <= 0x1D17A) || (cp >= 0xE0000 && cp <= 0xE0FFF) ||
    cp >= 0xF0000;
}
function u16(n) { return '\\u' + n.toString(16).padStart(4, '0'); }

/** A JSON string literal for `s` that parses back to exactly `s` and holds no raw special character. */
function jsonLiteral(s) {
  const json = JSON.stringify(String(s));   // escapes " \ and C0 controls; lone surrogates become \udxxx
  const out = [];
  let plain = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c < 0x7F) continue;
    let cp = c, len = 1;
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < json.length) {
      const d = json.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { cp = (c - 0xD800) * 0x400 + (d - 0xDC00) + 0x10000; len = 2; }
    }
    if (mustEscape(cp)) {
      out.push(json.slice(plain, i));
      for (let k = 0; k < len; k++) out.push(u16(json.charCodeAt(i + k)));
      plain = i + len;
    }
    i += len - 1;
  }
  out.push(json.slice(plain));
  return out.join('');
}

/* ------------------------------------------------------------------ checks on src */
function appVersion(code) {
  const m = /^const APP_VERSION = '([^'\n]*)';$/m.exec(code);
  if (!m) fail("src/Code.gs: no line `const APP_VERSION = '…';` — the bundle header needs the version.");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(m[1])) fail('src/Code.gs: APP_VERSION "' + m[1] + '" is not a version like 1.2.0');
  return m[1];
}

function checkSources(inp) {
  const code = inp.code.text;
  if (code.indexOf(EMBED_VAR) < 0) fail('src/Code.gs never reads ' + EMBED_VAR + ' — a bundle would not find its pages.');
  if (new RegExp('(?:\\b(?:var|let|const|function|class)\\s+|\\b)' + EMBED_VAR + '\\s*=(?!=)').test(code)) {
    fail('src/Code.gs declares or assigns ' + EMBED_VAR + ' itself — only the bundler may define it.');
  }
  // Every page / partial the code or the pages load must be embedded (a missing one would fail at run time).
  const have = {};
  inp.pages.forEach((p) => { have[p.name] = true; });
  const wanted = [];
  const scan = (text, re, where) => { let m; while ((m = re.exec(text))) wanted.push({ name: m[1], where }); };
  scan(code, /\b(?:renderPage_|htmlTemplate_|htmlFile_|include)\(\s*'([A-Za-z0-9_]+)'/g, 'src/Code.gs');
  inp.pages.forEach((p) => scan(p.text, /<\?!?=?\s*include\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g, 'src/' + p.name + '.html'));
  wanted.forEach((w) => { if (!have[w.name]) fail(w.where + ' loads "' + w.name + '" but src/' + w.name + '.html does not exist.'); });
  // Project .html files are only read inside htmlTemplate_ / htmlFile_, which prefer the embedded copy.
  const outside = code.replace(/^function (?:htmlTemplate_|htmlFile_)\([\s\S]*?\n}\n/gm, '');
  if (/\.create(?:TemplateFromFile|HtmlOutputFromFile)\(/.test(outside)) {
    fail('src/Code.gs reads an .html file outside htmlTemplate_/htmlFile_ — a bundle (no .html files) could not serve it.');
  }
  let manifest;
  try { manifest = JSON.parse(inp.manifest.text); } catch (e) { fail('src/appsscript.json is not valid JSON: ' + e.message); }
  if (manifest.runtimeVersion !== 'V8') fail('src/appsscript.json must set "runtimeVersion": "V8" (Code.gs uses modern JavaScript).');
  return manifest;
}

/* ------------------------------------------------------------------ assembly */
const ID_SLOT = '<build-id>';
/**
 * The build id is a fingerprint of the whole output (with the id slot still empty) plus the manifest: any change to
 * src/, to the header text or to the layout gives a new id; the same inputs always give the same id.
 */
function buildId(draft, manifestBytes) {
  const h = crypto.createHash('sha256');
  h.update('nabd-bundle/' + BUNDLE_FORMAT + '\0');
  h.update(draft, 'utf8');
  h.update('\0');
  h.update(manifestBytes);
  return h.digest('hex').slice(0, 12);
}

function header(version, id) {
  return [
    '/**',
    ' * ' + RULE,
    ' *  نبض المدارس — «متابعة سير العملية التعليمية» — ملف التثبيت الكامل (ملف واحد)',
    ' *  Nabd Schools — complete single-file install · version ' + version + ' · build ' + id,
    ' *',
    ' *  ⚠ لا تعدّل هذا الملف — انسخه كما هو. يُولَّد آليًا من مجلد src بالأداة tools/build-bundle.js.',
    ' *  ⚠ Do not edit this file — copy it as is. It is generated from src/ by tools/build-bundle.js.',
    ' *',
    ' *  طريقة التثبيت:',
    ' *   1. أنشئ ملف Google Sheets جديدًا، ثم من القائمة العلوية: «الإضافات» ← «Apps Script».',
    ' *   2. احذف كل ما في Code.gs والصق هذا الملف كاملًا مكانه، ثم احفظ (Ctrl+S). لا تحتاج أي ملف آخر.',
    ' *   3. «نشر» ← «نشر جديد» ← ⚙ ← «تطبيق ويب»؛ «التنفيذ باسم»: أنا، «من يمكنه الوصول»: أي شخص ← «نشر»،',
    ' *      ثم «منح الإذن» ← حسابك ← «خيارات متقدمة» ← «الانتقال إلى … (غير آمن)» ← «تحديد الكل» ← «متابعة».',
    ' *   4. انسخ «رابط تطبيق الويب» (ينتهي بـ /exec) وافتحه — يبدأ معالج التجهيز. احفظ الرابط في المفضلة.',
    ' *  للتحديث: الصق النسخة الجديدة مكان القديمة واحفظ، ثم «نشر» ← «إدارة عمليات النشر» ← ✎ ←',
    ' *  «الإصدار»: إصدار جديد ← «نشر». يبقى الرابط نفسه ولا تتأثر بياناتك.',
    ' *  لتجهيز قالب ينسخه المشرفون: توقّف بعد الخطوة 2 ولا تنشر (التفاصيل في دليل التثبيت بمجلد docs).',
    ' *',
    ' *  Install:',
    ' *   1. Create a new Google Sheet, then Extensions → Apps Script.',
    ' *   2. Delete everything in Code.gs, paste this whole file in its place and save (Ctrl+S).',
    ' *      Nothing else is needed: the pages are embedded at the end of this file (no .html files).',
    ' *   3. Deploy → New deployment → ⚙ → Web app; Execute as: Me; Who has access: Anyone → Deploy,',
    ' *      then Authorize access → your account → Advanced → Go to … (unsafe) → Select all → Continue.',
    ' *   4. Copy the Web app URL (it ends in /exec) and open it: the setup wizard starts. Bookmark it.',
    ' *  Update: paste the new file over the old one and save, then Deploy → Manage deployments → ✎ →',
    ' *  Version: New version → Deploy. The link stays the same and your data is kept.',
    ' *  Preparing a template for other supervisors to copy? Stop after step 2, do not deploy (see docs/).',
    ' *  This must be the only .gs file in the project. dist/appsscript.json (time zone, V8, OAuth scopes)',
    ' *  is optional: the app works without it.',
    ' * ' + RULE,
    ' */',
    '',
    ''
  ].join('\n');
}

function embedBlock(pages) {
  const lines = [
    '',
    '// ' + RULE,
    '// Embedded pages — src/' + pages.map((p) => p.name + '.html').join(', src/') + ',',
    '// written by tools/build-bundle.js as JSON strings and served by embeddedHtml_(). Do not edit by hand.',
    '// ' + RULE,
    'var ' + EMBED_VAR + ' = {'
  ];
  pages.forEach((p, i) => lines.push('  ' + JSON.stringify(p.name) + ': ' + jsonLiteral(p.text) + (i < pages.length - 1 ? ',' : '')));
  lines.push('};', '');
  return lines.join('\n');
}

/** The embedded map as it reads back from bundle text: JSON (format check) and JS (what Apps Script runs). */
function readEmbedded(code) {
  const marker = '\nvar ' + EMBED_VAR + ' = ';
  const at = code.indexOf(marker);
  if (at < 0 || code.indexOf(marker, at + 1) >= 0) fail('bundle: expected exactly one `var ' + EMBED_VAR + ' = …` line');
  const tail = code.slice(at + marker.length);
  if (!/\};\n$/.test(tail)) fail('bundle: the embedded map must be the last statement of the file');
  const rhs = tail.slice(0, -2);
  return { json: JSON.parse(rhs), js: vm.runInNewContext('(' + rhs + '\n)', {}) };
}

function verify(code, inp) {
  try { new vm.Script(code, { filename: 'dist/Code.gs' }); } catch (e) { fail('bundle has a syntax error: ' + e.message); }
  const back = readEmbedded(code);
  const names = inp.pages.map((p) => p.name);
  for (const k of ['json', 'js']) {
    if (JSON.stringify(Object.keys(back[k])) !== JSON.stringify(names)) fail('bundle: embedded keys ' + Object.keys(back[k]) + ' ≠ ' + names);
    inp.pages.forEach((p) => {
      if (!Buffer.from(back[k][p.name], 'utf8').equals(p.bytes)) fail('bundle: embedded ' + p.name + '.html does not round-trip byte-exact (' + k + ')');
    });
  }
  const embedded = code.slice(code.indexOf('\nvar ' + EMBED_VAR + ' = '));
  for (const ch of embedded) if (mustEscape(ch.codePointAt(0))) fail('bundle: raw U+' + ch.codePointAt(0).toString(16).toUpperCase() + ' in the embedded pages');
  if (/\r/.test(embedded)) fail('bundle: raw CR in the embedded pages');
}

/** Pure: reads src/, returns the bundle text (never writes). */
function bundle(o) {
  o = o || {};
  const inp = readInputs(o.srcDir);
  const manifestObj = checkSources(inp);
  const version = appVersion(inp.code.text);
  const codeText = inp.code.text.endsWith('\n') ? inp.code.text : inp.code.text + '\n';
  const draftHead = header(version, ID_SLOT);
  if (draftHead.indexOf('*/') !== draftHead.lastIndexOf('*/')) fail('header: a "*/" would end the comment early');
  const tail = embedBlock(inp.pages);
  const id = buildId(draftHead + codeText + tail, inp.manifest.bytes);
  const head = draftHead.replace(ID_SLOT, id);
  const code = head + codeText + tail;
  verify(code, inp);
  const size = (s) => Buffer.byteLength(s, 'utf8');
  return {
    code,
    manifest: inp.manifest.bytes,
    manifestJson: manifestObj,
    version,
    buildId: id,
    srcDir: inp.dir,
    parts: { header: size(head), code: size(codeText), embedded: size(tail), total: size(code), lines: code.split('\n').length - 1 },
    files: inp.pages.map((p) => ({ name: p.name, bytes: p.bytes.length, literal: size(jsonLiteral(p.text)) }))
  };
}

function writeIfChanged(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  try { if (fs.readFileSync(file).equals(buf)) return false; } catch (e) { /* new file */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);   // never leave a half-written Code.gs behind
  return true;
}

/** Builds and writes outDir/Code.gs + outDir/appsscript.json (only when their bytes change). */
function build(o) {
  o = o || {};
  const b = bundle(o);
  const outDir = path.resolve(o.outDir || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const codePath = path.join(outDir, 'Code.gs');
  const manifestPath = path.join(outDir, 'appsscript.json');
  const changed = [writeIfChanged(codePath, b.code) && 'Code.gs', writeIfChanged(manifestPath, b.manifest) && 'appsscript.json'].filter(Boolean);
  if (!fs.readFileSync(codePath).equals(Buffer.from(b.code, 'utf8')) || !fs.readFileSync(manifestPath).equals(b.manifest)) {
    fail('the files on disk differ from the build right after writing them (' + outDir + ')');
  }
  return Object.assign(b, { outDir, codePath, manifestPath, changed });
}

/** Compares outDir with what src builds. Returns the list of stale/missing files ([] = up to date). */
function check(o) {
  o = o || {};
  const b = bundle(o);
  const outDir = path.resolve(o.outDir || DEFAULT_OUT);
  const stale = [];
  const same = (f, data) => { try { return fs.readFileSync(path.join(outDir, f)).equals(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')); } catch (e) { return false; } };
  if (!same('Code.gs', b.code)) stale.push('Code.gs');
  if (!same('appsscript.json', b.manifest)) stale.push('appsscript.json');
  return Object.assign(b, { outDir, stale });
}

/* ------------------------------------------------------------------ CLI */
function kb(n) { return (n / 1024).toFixed(1) + ' KiB'; }
function rel(p) { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; }

function summary(b) {
  const L = [];
  L.push('نبض المدارس bundle — version ' + b.version + ', build ' + b.buildId);
  L.push('  ' + rel(b.codePath || path.join(b.outDir, 'Code.gs')) + ': ' + b.parts.total.toLocaleString('en-US') + ' bytes (' + kb(b.parts.total) + '), ' + b.parts.lines.toLocaleString('en-US') + ' lines');
  L.push('    header ' + kb(b.parts.header) + ' · Code.gs ' + kb(b.parts.code) + ' · embedded pages ' + kb(b.parts.embedded));
  L.push('    ' + b.files.map((f) => f.name + ' ' + kb(f.bytes)).join(' · '));
  return L.join('\n');
}

function parseArgs(argv) {
  const o = { check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--out' || a === '--src') { if (!argv[i + 1]) fail(a + ' needs a folder'); o[a === '--out' ? 'outDir' : 'srcDir'] = argv[++i]; }
    else if (a === '--help' || a === '-h') o.help = true;
    else fail('Unknown option: ' + a + ' (try --help)');
  }
  return o;
}

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
    if (o.help) {
      process.stdout.write('Usage: node tools/build-bundle.js [--check] [--out DIR] [--src DIR] [--quiet]\n' +
        '  Writes DIR/Code.gs (one-file install: header + src/Code.gs + embedded pages) and DIR/appsscript.json.\n' +
        '  --check  write nothing; exit 1 when DIR is not what src/ builds.   Default DIR: dist/\n');
      return 0;
    }
    if (o.check) {
      const r = check(o);
      if (r.stale.length) {
        process.stderr.write('dist is out of date: ' + r.stale.join(', ') + ' — run: npm run build:bundle\n');
        return 1;
      }
      if (!o.quiet) process.stdout.write('dist is up to date (version ' + r.version + ', build ' + r.buildId + ')\n');
      return 0;
    }
    const r = build(o);
    if (!o.quiet) {
      process.stdout.write(summary(r) + '\n');
      const out = (f) => rel(path.join(r.outDir, f));
      const kept = ['Code.gs', 'appsscript.json'].filter((f) => r.changed.indexOf(f) < 0);
      process.stdout.write('  ' + [r.changed.length && 'written: ' + r.changed.map(out).join(', '), kept.length && 'unchanged: ' + kept.map(out).join(', ')].filter(Boolean).join(' · ') + '\n');
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        if (pkg.version && pkg.version !== r.version) process.stderr.write('warning: package.json version ' + pkg.version + ' ≠ APP_VERSION ' + r.version + '\n');
      } catch (e) { /* no package.json */ }
    }
    return 0;
  } catch (e) {
    process.stderr.write('build-bundle: ' + (e instanceof BuildError ? e.message : (e && e.stack) || String(e)) + '\n');
    return 2;
  }
}

module.exports = { bundle, build, check, jsonLiteral, mustEscape, readEmbedded, header, BUNDLE_FORMAT, PAGE_ORDER, EMBED_VAR, BuildError };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
