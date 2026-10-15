#!/usr/bin/env node
/*
 * server.js — local dev server that serves the Apps Script web app from src/ through the mock runtime.
 *
 *   node test/server.js [--port 8787] [--latency 150] [--clock 2026-10-14T07:30] [--src src]
 *                       [--owner supervisor@gmail.com] [--not-deployed] [--plain-urls] [--quiet]
 *
 *   const { startServer } = require('./test/server');
 *   const srv = await startServer({ port: 0, latency: 0, clock: '2026-10-14T07:30' });
 *   srv.url  srv.env  srv.app  await srv.reset({...})  await srv.close()
 *
 * Pages:   GET /  /?s=<token>  /?f=all   → doGet(e) HTML with an injected shim <script> (first in <head>)
 *          that defines google.script.run (chainable withSuccessHandler / withFailureHandler / withUserObject;
 *          only the app's public functions exist, like the real API), google.script.url.getLocation,
 *          google.script.history and google.script.host.
 *          Like the real Apps Script iframe: meta viewport / <title> inside the HTML are ignored (only
 *          HtmlOutput.addMetaTag / setTitle count), location.search does NOT contain the app parameters
 *          (the URL is rewritten to /userCodeAppPanel — use BOOT or google.script.url.getLocation),
 *          and links without target="_blank"/"_top" are blocked with a console error.
 * Test API: POST /__rpc {fn,args}         → {ok:true,result} | {ok:false,error}   (simulated latency)
 *           POST /__call {fn,args}        → same rules, no latency / failure injection (fast seeding)
 *           POST /__exec {fn,args}        → raw invoke of ANY function (private helpers too)
 *           POST /__trigger {fn,event?}   → run a trigger handler (e.g. dailyDigest)
 *           GET  /__mail [?to=&last=1]    → mailbox;   GET /__mail/last-code → {code}
 *           GET|POST /__clock {iso | advanceMs | advanceMinutes | running}
 *           POST /__reset {clock?, ownerEmail?, notDeployed?, state?, envOptions?}
 *           GET  /__state → env.snapshot();  POST /__state {state} → env.restore()
 *           POST /__latency {ms};  POST /__fail {fn?, error?, network?, count?};  GET /__info
 * Security: binds to 127.0.0.1 only — the test endpoints execute arbitrary server functions.
 */
'use strict';
const http = require('node:http');
const path = require('node:path');
const { createGasEnv } = require('./gas-mock.js');
const { loadApp } = require('./runtime.js');

const DEFAULT_SRC = path.join(__dirname, '..', 'src');
/**
 * The deployment URL ScriptApp reports in the dev server. The app only accepts real deployment URLs
 * (https://script.google.com/…/exec) as the base of school links, so the server uses this stand-in and
 * the page shim sends any link to it back to the local server.
 */
const DEV_DEPLOY_URL = 'https://script.google.com/macros/s/AKfycbLocalDevServer/exec';
const MAX_BODY = 30 * 1024 * 1024;

/* ---------------------------------------------------------------- the browser shim (stringified) */
function gasShim(CFG) {
  'use strict';
  var pending = 0;
  window.__gasPending = 0;
  window.__gasCalls = [];
  if (CFG.rewrite && window.history && history.replaceState) {
    try { history.replaceState(history.state, '', '/userCodeAppPanel' + (CFG.qs ? '?__q=' + encodeURIComponent(CFG.qs) : '') + location.hash); } catch (e) { /* ignore */ }
  }
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
  function formToObject(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
      if (el.type === 'file') { console.warn('[gas-shim] file inputs in forms are not supported by the dev shim'); return; }
      if (Object.prototype.hasOwnProperty.call(out, el.name)) out[el.name] = [].concat(out[el.name], el.value);
      else out[el.name] = el.value;
    });
    return out;
  }
  function scriptError(msg) { var e = new Error(msg); e.name = 'ScriptError'; return e; }
  function settle(fn, value, userObject, isError) {
    pending = Math.max(0, pending - 1); window.__gasPending = pending;
    setTimeout(function () {
      if (typeof fn === 'function') fn(value, userObject);
      else if (isError) throw value;   // unhandled server failure → uncaught error, like Apps Script
    }, 0);
  }
  function invoke(runner, name, argsLike) {
    var done = false;
    function once(fn, value, isError) { if (done) return; done = true; settle(fn, value, runner._u, isError); }
    var args = Array.prototype.slice.call(argsLike).map(function (a) {
      return (typeof HTMLFormElement !== 'undefined' && a instanceof HTMLFormElement) ? formToObject(a) : a;
    });
    for (var i = 0; i < args.length; i++) {
      var bad = illegal(args[i], String(i), []);
      if (bad !== null) throw new Error('Failed due to illegal value in property: ' + bad);
    }
    while (args.length && args[args.length - 1] === undefined) args.pop();
    var body = JSON.stringify({ fn: name, args: args.map(function (a) { return a === undefined ? null : a; }) });
    pending++; window.__gasPending = pending;
    window.__gasCalls.push(name);
    fetch(CFG.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.network) throw new Error('network');
        if (data && data.ok) once(runner._s, Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : undefined, false);
        else once(runner._f, scriptError(data && data.error ? data.error : 'Unknown server error'), true);
      })
      .catch(function () { once(runner._f, scriptError('NetworkError: Connection failure due to HTTP 0'), true); });
  }
  // Runners are plain objects whose methods close over their handlers (they do not depend on `this`,
  // so `run[fn].apply(null, args)` works like the real google.script.run).
  function makeRunner(s, f, u) {
    var state = { _s: s || null, _f: f || null, _u: u };
    var r = {
      withSuccessHandler: function (fn) { return makeRunner(fn, state._f, state._u); },
      withFailureHandler: function (fn) { return makeRunner(state._s, fn, state._u); },
      withUserObject: function (o) { return makeRunner(state._s, state._f, o); }
    };
    CFG.fns.forEach(function (name) {
      if (name === 'withSuccessHandler' || name === 'withFailureHandler' || name === 'withUserObject') return;
      r[name] = function () { invoke(state, name, arguments); };
    });
    return r;
  }
  var historyHandler = null, histState = null;
  window.google = window.google || {};
  window.google.script = {
    run: makeRunner(),
    url: { getLocation: function (cb) { setTimeout(function () { cb({ hash: CFG.hash || '', parameter: CFG.parameter, parameters: CFG.parameters }); }, 0); } },
    history: {
      push: function (state, params, hash) { histState = state; },
      replace: function (state, params, hash) { histState = state; },
      setChangeHandler: function (fn) { historyHandler = fn; }
    },
    host: { origin: location.origin, close: function () {}, setHeight: function () {}, setWidth: function () {}, editor: { focus: function () {} } }
  };
  window.addEventListener('popstate', function () { if (historyHandler) historyHandler({ state: histState, location: { hash: '', parameter: CFG.parameter, parameters: CFG.parameters } }); });
  // The real page lives in a sandboxed iframe on *.googleusercontent.com: a plain link would try to load
  // inside that iframe and fail. Links that leave the app must use target="_blank" or "_top" (spec §2.13).
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || ev.defaultPrevented) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel|sms|blob|data):/i.test(href) || a.hasAttribute('download')) return;
    var target = (a.getAttribute('target') || '').toLowerCase();
    if (CFG.deployUrl && href.indexOf(CFG.deployUrl) === 0) {   // a school / preview link → this local server
      ev.preventDefault();
      var local = CFG.localUrl + href.slice(CFG.deployUrl.length).replace(/^\//, '');
      if (target === '_blank') window.open(local, '_blank'); else location.href = local;
      return;
    }
    if (target === '_blank' || target === '_top') return;
    ev.preventDefault();
    console.error('[gas-sandbox] Blocked navigation: <a href="' + href + '"> has no target="_blank" or "_top"; inside the Apps Script iframe this link would not work.');
  }, true);
}

/* ---------------------------------------------------------------- helpers */
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function safeJson(v) { return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) { const t = await readBody(req); if (!t.trim()) return {}; return JSON.parse(t); }
function send(res, status, body, type) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}
function jsonSafe(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function codesIn(m) { return ((m.subject || '') + ' ' + (m.body || '') + ' ' + (m.htmlBody || '')).match(/\b\d{6}\b/g) || []; }

function injectShim(out, cfg) {
  let html = out.html;
  // Apps Script ignores these inside the user HTML; only addMetaTag()/setTitle() reach the real page.
  html = html.replace(/<meta\b[^>]*\bname\s*=\s*["']?viewport["']?[^>]*>/gi, '');
  html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '');
  const head = '<script data-gas-shim>(' + gasShim.toString() + ')(' + safeJson(cfg) + ');</script>' +
    (out.metaTags || []).map((m) => '<meta name="' + escAttr(m.name) + '" content="' + escAttr(m.content) + '">').join('') +
    '<title>' + escText(out.title || '') + '</title>';
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + head);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + head + '</head>');
  return '<head>' + head + '</head>' + html;
}
function errorPage(err) {
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Error</title></head><body style="font-family:sans-serif;padding:24px">' +
    '<h1 style="color:#C0392B">Error</h1><p>' + escText(err && err.message || err) + '</p><pre style="white-space:pre-wrap;direction:ltr;text-align:left">' +
    escText(err && (err.serverStack || err.stack) || '') + '</pre></body></html>';
}

/* ---------------------------------------------------------------- server */
function startServer(opts = {}) {
  const srcDir = path.resolve(opts.srcDir || process.env.NABD_SRC || DEFAULT_SRC);
  const host = opts.host || '127.0.0.1';
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  const state = {
    latency: opts.latency === undefined ? 150 : opts.latency,
    rewrite: opts.rewriteLocation !== false,
    failRules: [],
    env: opts.env || null,
    app: opts.app || null,
    url: null,
    port: null
  };
  const baseEnvOptions = Object.assign({}, opts.envOptions || {});

  function makeEnv(o = {}) {
    const envOpts = Object.assign({}, baseEnvOptions, o.envOptions || {});
    envOpts.ownerEmail = o.ownerEmail || envOpts.ownerEmail || opts.ownerEmail || 'supervisor@gmail.com';
    envOpts.scriptUrl = (o.notDeployed || opts.notDeployed) ? null : (o.scriptUrl || envOpts.scriptUrl || opts.scriptUrl || DEV_DEPLOY_URL);
    const clk = o.clock !== undefined ? o.clock : opts.clock;
    if (clk !== undefined && clk !== null) envOpts.clock = clk; else delete envOpts.clock;
    const env = createGasEnv(envOpts);
    if (o.state) env.restore(o.state);
    return env;
  }
  function makeApp(env) { return loadApp({ srcDir, env }); }

  async function handle(req, res) {
    const t0 = Date.now();
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/exec' || p === '/dev' || p === '/userCodeAppPanel')) {
        let qs = u.search.replace(/^\?/, '');
        if (p === '/userCodeAppPanel') qs = u.searchParams.get('__q') || '';
        const params = new URLSearchParams(qs);
        const parameter = {}, parameters = {};
        for (const [k, v] of params) { if (!(k in parameter)) parameter[k] = v; (parameters[k] = parameters[k] || []).push(v); }
        if (state.app.maybeReload) state.app.maybeReload();
        let out;
        try { out = state.app.doGetOutput(parameters); }
        catch (e) { log('[doGet] ' + (e.serverStack || e.stack)); return send(res, 500, errorPage(e), 'text/html; charset=utf-8'); }
        const cfg = { fns: state.app.publicFunctions(), parameter, parameters, hash: '', qs, rewrite: state.rewrite, rpc: '/__rpc',
          deployUrl: state.env.scriptUrl || '', localUrl: state.url };
        send(res, 200, injectShim(out, cfg), 'text/html; charset=utf-8');
        log(`GET ${req.url} → 200 (${Date.now() - t0} ms)`);
        return;
      }
      if (req.method === 'POST' && (p === '/__rpc' || p === '/__call')) {
        const body = await readJson(req);
        const fn = String(body.fn || ''), args = Array.isArray(body.args) ? body.args : [];
        if (p === '/__rpc') {
          if (state.latency > 0) await sleep(state.latency);
          const rule = state.failRules.find((r) => !r.fn || r.fn === fn);
          if (rule) {
            if (--rule.count <= 0) state.failRules.splice(state.failRules.indexOf(rule), 1);
            log(`RPC ${fn} → injected failure`);
            return send(res, 200, rule.network ? { ok: false, network: true } : { ok: false, error: rule.error || 'Injected failure' });
          }
        }
        if (state.app.maybeReload) state.app.maybeReload();
        try {
          const result = state.app.call(fn, ...args);
          const payload = { ok: true };
          if (result !== undefined) payload.result = result;
          send(res, 200, payload);
          log(`RPC ${fn} → ok (${Date.now() - t0} ms)`);
        } catch (e) {
          const serverBug = e.code === 'ILLEGAL_RESULT' || e.code === 'NOT_CALLABLE' || e.code === 'ILLEGAL_ARG' || (e.serverName && e.serverName !== 'Error');
          if (serverBug) console.error(`\x1b[31m[rpc] ${fn}: ${e.message}\x1b[0m\n${e.serverStack || ''}`);
          else log(`RPC ${fn} → error: ${e.message}`);
          send(res, 200, { ok: false, error: e.message, code: e.code || null });
        }
        return;
      }
      if (req.method === 'POST' && p === '/__exec') {
        const body = await readJson(req);
        try { send(res, 200, { ok: true, result: jsonSafe(state.app.invoke(String(body.fn), ...(body.args || []))) }); }
        catch (e) { send(res, 200, { ok: false, error: e.message }); }
        return;
      }
      if (req.method === 'POST' && p === '/__trigger') {
        const body = await readJson(req);
        try { send(res, 200, { ok: true, result: jsonSafe(state.app.runTrigger(String(body.fn || 'dailyDigest'), body.event)) }); }
        catch (e) { send(res, 200, { ok: false, error: e.message }); }
        return;
      }
      if (req.method === 'GET' && p === '/__mail/last-code') {
        const to = u.searchParams.get('to');
        const list = state.env.mailbox.filter((m) => !to || m.to === to);
        const last = list[list.length - 1];
        const codes = last ? codesIn(last) : [];
        return send(res, 200, { code: codes[0] || null, subject: last ? last.subject : null, count: list.length });
      }
      if ((req.method === 'GET' || req.method === 'DELETE') && p === '/__mail') {
        if (req.method === 'DELETE') { state.env.mailbox.length = 0; return send(res, 200, { ok: true }); }
        const to = u.searchParams.get('to');
        const list = state.env.mailbox.filter((m) => !to || m.to === to).map((m) => Object.assign({}, m, { codes: codesIn(m) }));
        if (u.searchParams.get('last')) return send(res, 200, list.length ? list[list.length - 1] : null);
        return send(res, 200, list);
      }
      if (p === '/__clock') {
        if (req.method === 'POST') {
          const b = await readJson(req);
          if (b.iso !== undefined) state.env.clock.set(b.iso, { running: !!b.running });
          else if (b.running === true) state.env.clock.run();
          else if (b.running === false) state.env.clock.freeze();
          if (b.advanceMs) state.env.clock.advance(Number(b.advanceMs));
          if (b.advanceMinutes) state.env.clock.advance(Number(b.advanceMinutes) * 60000);
          if (b.advanceDays) state.env.clock.advance(Number(b.advanceDays) * 86400000);
        }
        return send(res, 200, { iso: state.env.clock.iso(), local: state.env.clock.local(), ms: state.env.clock.now(), frozen: state.env.clock.frozen });
      }
      if (req.method === 'POST' && p === '/__reset') {
        const b = await readJson(req);
        state.env = makeEnv(b);
        state.app = makeApp(state.env);
        state.failRules = [];
        if (b.latency !== undefined) state.latency = Number(b.latency);
        log('[reset] fresh environment');
        return send(res, 200, { ok: true, clock: state.env.clock.iso(), scriptUrl: state.env.scriptUrl });
      }
      if (p === '/__state') {
        if (req.method === 'POST') { const b = await readJson(req); state.env.restore(b.state || b); return send(res, 200, { ok: true }); }
        return send(res, 200, state.env.snapshot());
      }
      if (req.method === 'POST' && p === '/__latency') { const b = await readJson(req); state.latency = Math.max(0, Number(b.ms) || 0); return send(res, 200, { ok: true, latency: state.latency }); }
      if (p === '/__fail') {
        if (req.method === 'DELETE') { state.failRules = []; return send(res, 200, { ok: true }); }
        const b = await readJson(req);
        state.failRules.push({ fn: b.fn || null, error: b.error || null, network: !!b.network, count: b.count || 1 });
        return send(res, 200, { ok: true, rules: state.failRules.length });
      }
      if (req.method === 'GET' && p === '/__info') {
        return send(res, 200, { srcDir, url: state.url, latency: state.latency, clock: state.env.clock.local(), publicFunctions: state.app.publicFunctions(),
          formulaWrites: state.env.formulaWrites, warnings: state.env.warnings, lastCall: state.app.lastCall, scriptUrl: state.env.scriptUrl });
      }
      if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      send(res, 404, { ok: false, error: 'Not found: ' + p });
    } catch (e) {
      console.error('[server] ' + (e.stack || e));
      if (!res.headersSent) send(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { handle(req, res); });
    server.on('error', reject);
    server.listen(opts.port === undefined ? 8787 : opts.port, host, () => {
      state.port = server.address().port;
      state.url = `http://localhost:${state.port}/`;
      try {
        if (!state.env) state.env = makeEnv({});
        else if (state.env.scriptUrl === undefined) state.env.setScriptUrl(DEV_DEPLOY_URL);
        if (!state.app) state.app = makeApp(state.env);
      } catch (e) { server.close(); reject(e); return; }
      const sockets = new Set();
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      resolve({
        url: state.url,
        port: state.port,
        server,
        srcDir,
        get env() { return state.env; },
        get app() { return state.app; },
        get latency() { return state.latency; },
        setLatency(ms) { state.latency = ms; },
        reset(o = {}) { state.env = makeEnv(o); state.app = makeApp(state.env); state.failRules = []; return state.env; },
        close() { return new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }); }
      });
    });
  });
}

module.exports = { startServer, gasShim, injectShim, DEV_DEPLOY_URL };

/* ---------------------------------------------------------------- CLI */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
  const flag = (name) => argv.includes('--' + name);
  const port = Number(arg('port', process.env.PORT || 8787));
  startServer({
    port,
    latency: Number(arg('latency', 150)),
    clock: arg('clock', undefined),
    srcDir: arg('src', undefined),
    ownerEmail: arg('owner', 'supervisor@gmail.com'),
    notDeployed: flag('not-deployed'),
    rewriteLocation: !flag('plain-urls'),
    quiet: flag('quiet')
  }).then((srv) => {
    console.log('\n  نبض المدارس — dev server (Apps Script mock)');
    console.log('  Admin:        ' + srv.url);
    console.log('  General link: ' + srv.url + '?f=all');
    console.log('  Preview form: ' + srv.url + '?s=__preview');
    console.log('  OTP codes:    ' + srv.url + '__mail/last-code');
    console.log('  Source:       ' + srv.srcDir + '  (hot-reloads .gs on change; .html read on every request)\n');
    const stop = () => srv.close().then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch((e) => { console.error(e.stack || e); process.exit(1); });
}
