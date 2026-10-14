/*
 * runtime.js — loads Code.gs into a simulated Apps Script runtime.
 *
 *   Node:    const { loadApp } = require('./runtime');
 *            const app = loadApp({ srcDir: 'src', env });           // env from gas-mock createGasEnv()
 *   Browser: const app = GasRuntime.loadAppFromSource(codeSource, env);   // same API (new Function)
 *
 *   app.call(fn, ...args)      → google.script.run semantics (public functions only, JSON-cloned args/result,
 *                                throws if the result contains a Date / function / undefined-in-array / NaN …)
 *   app.doGet(params)          → HTML string;   app.doGetOutput(params) → { html, title, metaTags, … }
 *   app.invoke(fn, ...args)    → raw call of ANY function (private helpers too) — for white-box tests only
 *   app.runTrigger(fn, event)  → time-driven trigger execution (no UI)
 *   app.runMenu(fn, {prompts}) → menu handler execution (SpreadsheetApp.getUi() allowed)
 *   app.onOpen({authMode})     → simple trigger (UI allowed, AuthMode.LIMITED by default)
 *   app.evaluate(expr)         → evaluate an expression in a fresh execution (e.g. 'APP_VERSION')
 *   app.publicFunctions()      → names callable from google.script.run
 *   app.lastCall               → { fn, ms, ops } service-call counters of the latest execution
 *
 * Fidelity: EVERY call is a fresh execution — Code.gs top-level code re-runs and global variables do not
 * survive between calls (exactly like Apps Script), while persistent state lives in the env (Sheets,
 * Properties, Cache, Drive, triggers, mailbox).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  else { root.GasRuntime = api; }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var IDENT = /^[A-Za-z_$][\w$]*$/;
  // Browser globals that do not exist in the Apps Script V8 runtime — shadowed as undefined in the
  // browser loader so Code.gs cannot accidentally depend on them.
  var SHADOWED = ['window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'location', 'history',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
    'requestAnimationFrame', 'queueMicrotask', 'atob', 'btoa', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
    'structuredClone', 'alert', 'confirm', 'prompt', 'process', 'require', 'module', 'exports', 'Buffer', 'global', 'self',
    'crypto', 'GasMock', 'GasRuntime'];

  function isPublicName(name) { return typeof name === 'string' && IDENT.test(name) && !/_$/.test(name); }

  /**
   * Finds the first value google.script.run cannot transfer. Returns null when OK or {path, reason}.
   * mode 'result': server → client.  mode 'arg': client → server.
   */
  function findIllegal(v, path, seen, inArray, mode) {
    if (v === null) return null;
    var t = typeof v;
    if (t === 'undefined') return inArray && mode === 'result' ? { path: path, reason: 'undefined inside an array (spec §2.3)' } : null;
    if (t === 'string' || t === 'boolean') return null;
    if (t === 'number') return isFinite(v) ? null : (mode === 'result' ? { path: path, reason: String(v) + ' (non-finite number)' } : null);
    if (t === 'function') return { path: path, reason: 'function' };
    if (t === 'symbol' || t === 'bigint') return { path: path, reason: t };
    var tag = Object.prototype.toString.call(v);
    if (tag === '[object Date]') {
      return { path: path, reason: mode === 'result' ? 'Date object — google.script.run turns the WHOLE result into null (spec §2.3: return strings)' : 'Date object' };
    }
    if (seen.indexOf(v) >= 0) return { path: path, reason: 'circular reference' };
    seen.push(v);
    var r = null;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length && !r; i++) {
        if (!(i in v)) { if (mode === 'result') r = { path: path + '[' + i + ']', reason: 'hole (undefined) inside an array' }; continue; }
        r = findIllegal(v[i], path + '[' + i + ']', seen, true, mode);
      }
    } else {
      var proto = Object.getPrototypeOf(v);
      if (tag !== '[object Object]' || (proto !== null && Object.getPrototypeOf(proto) !== null)) {
        var ctor = proto && proto.constructor && proto.constructor.name;
        r = { path: path, reason: 'non-plain object (' + (ctor || tag) + ')' };
      } else {
        var keys = Object.keys(v);
        for (var k = 0; k < keys.length && !r; k++) r = findIllegal(v[keys[k]], path + '.' + keys[k], seen, false, mode);
      }
    }
    seen.pop();
    return r;
  }
  function checkTransferable(value, mode, path) { return findIllegal(value, path || 'result', [], false, mode || 'result'); }

  /** Pulls window.BOOT = {...}; out of a rendered page (BOOT JSON must be '<'-escaped per spec §2.15). */
  function extractBoot(html) {
    var s = String(html), m = /window\.BOOT\s*=\s*/.exec(s);
    if (!m) return null;
    var i = m.index + m[0].length, start = i, depth = 0, inStr = false;
    if (s.charAt(i) !== '{' && s.charAt(i) !== '[') {   // e.g. a literal null
      var lit = /^[^;<\n]*/.exec(s.slice(i))[0].trim();
      return JSON.parse(lit);
    }
    for (; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
    }
    throw new Error('extractBoot: unterminated BOOT JSON');
  }

  function hostError(e, fn) {
    var name = e && e.name ? String(e.name) : 'Error';
    var msg = e && e.message !== undefined ? String(e.message) : String(e);
    var shown = name === 'Error' ? msg : name + ': ' + msg;   // Apps Script shows "Exception: …" / "TypeError: …"
    var err = new Error(shown);
    err.serverName = name;
    err.serverMessage = msg;
    err.serverStack = e && e.stack ? String(e.stack) : null;
    err.fn = fn;
    return err;
  }

  function buildEvent(params) {
    var p = params || {};
    var qs = '';
    if (typeof p === 'string') { qs = p.replace(/^\?/, ''); p = {}; }
    var parameter = {}, parameters = {};
    var add = function (k, v) { v = v === undefined || v === null ? '' : String(v); if (!(k in parameter)) parameter[k] = v; (parameters[k] = parameters[k] || []).push(v); };
    if (qs) {
      qs.split('&').filter(Boolean).forEach(function (pair) {
        var i = pair.indexOf('='), k = i < 0 ? pair : pair.slice(0, i), v = i < 0 ? '' : pair.slice(i + 1);
        add(decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' ')));
      });
    } else {
      Object.keys(p).forEach(function (k) { if (Array.isArray(p[k])) p[k].forEach(function (v) { add(k, v); }); else add(k, p[k]); });
      qs = Object.keys(parameters).map(function (k) { return parameters[k].map(function (v) { return encodeURIComponent(k) + '=' + encodeURIComponent(v); }).join('&'); }).join('&');
    }
    return { parameter: parameter, parameters: parameters, queryString: qs, contextPath: '', contentLength: -1, pathInfo: undefined };
  }

  function topLevelFunctionNames(sources) {
    var names = {}, re = /^[ \t]*(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)[ \t]*\(|^[ \t]*(?:var|let|const)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?(?:function\b|\([^)]*\)[ \t]*=>|[A-Za-z_$][\w$]*[ \t]*=>)/gm;
    sources.forEach(function (s) { var m; while ((m = re.exec(s.code))) names[m[1] || m[2]] = true; });
    return Object.keys(names);
  }

  /* ------------------------------------------------------------------ core app (engine-agnostic) */
  function createApp(holder, env) {
    var app = { env: env, lastCall: null, history: [] };

    function lookup(ex, name) {
      if (!IDENT.test(name)) return undefined;
      return ex.eval('(typeof ' + name + ' === "function") ? ' + name + ' : undefined');
    }

    function execute(label, o, body) {
      o = o || {};
      var prevUi = env.uiContext, prevAuth = env.authMode;
      env.uiContext = !!o.uiContext;
      env.authMode = o.authMode || 'FULL';
      var before = {};
      Object.keys(env.counters).forEach(function (k) { before[k] = env.counters[k]; });
      var t0 = Date.now();
      env._beginExecution({ label: label });
      var ex;
      try {
        ex = holder.engine.newExecution(env);
        env._setExecutionRealm({ Error: ex.Error, evalInApp: ex.eval });
        return body(ex);
      } finally {
        env._endExecution();
        env.uiContext = prevUi;
        env.authMode = prevAuth;
        var ops = {};
        Object.keys(env.counters).forEach(function (k) { var d = env.counters[k] - (before[k] || 0); if (d) ops[k] = d; });
        app.lastCall = { fn: label, ms: Date.now() - t0, ops: ops };
        app.history.push(app.lastCall);
        if (app.history.length > 200) app.history.shift();
      }
    }

    function invokeIn(ex, fn, args, label) {
      var f = lookup(ex, fn);
      if (!f) { var e = new TypeError('Script function not found: ' + fn); e.code = 'NO_FUNCTION'; throw e; }
      try { return f.apply(undefined, args); } catch (err) { throw hostError(err, label || fn); }
    }

    /** google.script.run semantics. */
    app.call = function (fn) {
      if (!isPublicName(fn)) {
        var e = new TypeError('google.script.run.' + fn + ' is not a function' + (/_$/.test(String(fn)) ? ' (functions ending in "_" are private and cannot be called from the client — spec §2.2)' : ''));
        e.code = 'NOT_CALLABLE';
        throw e;
      }
      var args = Array.prototype.slice.call(arguments, 1);
      while (args.length && args[args.length - 1] === undefined) args.pop();
      for (var i = 0; i < args.length; i++) {
        var bad = checkTransferable(args[i], 'arg', String(i));
        if (bad) { var ae = new TypeError('Failed due to illegal value in property: ' + bad.path + ' (' + bad.reason + ')'); ae.code = 'ILLEGAL_ARG'; throw ae; }
      }
      var json = JSON.stringify(args.map(function (a) { return a === undefined ? null : a; }));
      return execute(fn, { uiContext: false, authMode: 'FULL' }, function (ex) {
        var f = lookup(ex, fn);
        if (!f) { var ne = new TypeError('google.script.run.' + fn + ' is not a function'); ne.code = 'NOT_CALLABLE'; throw ne; }
        var realmArgs = ex.JSON.parse(json);
        var res;
        try { res = f.apply(undefined, realmArgs); } catch (err) { throw hostError(err, fn); }
        var badRes = checkTransferable(res, 'result', 'result');
        if (badRes) {
          var re = new Error('[gas-run] ' + fn + '() returned a value google.script.run cannot deliver: ' + badRes.reason + ' at ' + badRes.path + '.');
          re.code = 'ILLEGAL_RESULT';
          re.path = badRes.path;
          throw re;
        }
        return res === undefined ? undefined : JSON.parse(JSON.stringify(res));
      });
    };

    /** Raw invocation of any function (private helpers included). Arguments are passed as-is. */
    app.invoke = function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return execute(fn, { uiContext: false }, function (ex) { return invokeIn(ex, fn, args); });
    };

    app.evaluate = function (expr) {
      return execute('evaluate', {}, function (ex) {
        try { return ex.eval('(' + expr + ')'); } catch (err) { throw hostError(err, 'evaluate'); }
      });
    };

    app.doGetOutput = function (params) {
      var e = buildEvent(params);
      return execute('doGet', { uiContext: false }, function (ex) {
        var out = invokeIn(ex, 'doGet', [e]);
        if (!out || !out.__isHtmlOutput) {
          var err = new Error('[gas-run] doGet must return an HtmlOutput (got ' + (out === null ? 'null' : typeof out) + '). Apps Script would show "The script completed but did not return anything."');
          err.code = 'BAD_DOGET';
          throw err;
        }
        return { html: out.getContent(), title: out.getTitle(), metaTags: out._metas.slice(), xFrameOptionsMode: out._xfo,
          sandboxMode: out._sandbox, faviconUrl: out._favicon, width: out._w, height: out._h, event: e };
      });
    };
    app.doGet = function (params) { return app.doGetOutput(params).html; };

    app.runTrigger = function (fn, event) {
      return execute(fn, { uiContext: false, authMode: 'FULL' }, function (ex) {
        var ev = event || clockEvent(env);
        return invokeIn(ex, fn, [ev]);
      });
    };

    app.runMenu = function (fn, o) {
      o = o || {};
      (o.prompts || []).forEach(function (p) { env.ui.queuePrompt(p); });
      (o.alerts || []).forEach(function (b) { env.ui.queueAlert(b); });
      return execute(fn, { uiContext: true, authMode: 'FULL' }, function (ex) { return invokeIn(ex, fn, []); });
    };

    app.onOpen = function (o) {
      o = o || {};
      var mode = o.authMode || 'LIMITED';
      return execute('onOpen', { uiContext: true, authMode: mode }, function (ex) {
        var ss = env.globals.SpreadsheetApp.getActiveSpreadsheet();
        return invokeIn(ex, 'onOpen', [{ authMode: mode, source: ss, user: env.globals.Session.getActiveUser() }]);
      });
    };

    /** Names of functions that google.script.run can reach (top-level, no trailing underscore). */
    app.functions = function () {
      return execute('introspect', {}, function (ex) {
        var names = topLevelFunctionNames(holder.sources);
        if (ex.ctx) Object.getOwnPropertyNames(ex.ctx).forEach(function (n) { if (names.indexOf(n) < 0 && typeof ex.ctx[n] === 'function' && !(n in env.globals)) names.push(n); });
        return names.filter(function (n) { return !(n in env.globals) && typeof lookup(ex, n) === 'function'; }).sort();
      });
    };
    app.publicFunctions = function () { return app.functions().filter(isPublicName); };
    app.sources = function () { return holder.sources.map(function (s) { return s.filename; }); };
    return app;
  }

  function clockEvent(env) {
    var d = new Date(env.clock.now());
    return { authMode: 'FULL', triggerUid: 'mock-trigger', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, 'day-of-month': d.getUTCDate(),
      'day-of-week': d.getUTCDay() || 7, hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), timezone: 'UTC', 'week-of-year': 1 };
  }

  /* ------------------------------------------------------------------ browser engine (new Function) */
  function functionEngine(sources, env) {
    var names = Object.keys(env.globals).filter(function (n) { return IDENT.test(n) && n !== 'eval' && n !== 'arguments'; });
    var shadow = SHADOWED.filter(function (n) { return names.indexOf(n) < 0; });
    var params = names.concat(shadow);
    var code = sources.map(function (s) { return s.code; }).join('\n;\n');
    var body = code + '\n;return function (__gas_code__) { return eval(__gas_code__); };';
    var factory = Function.apply(null, params.concat([body]));
    return {
      newExecution: function () {
        var args = names.map(function (n) { return env.globals[n]; }).concat(shadow.map(function () { return undefined; }));
        var ev = factory.apply(undefined, args);
        return { eval: ev, JSON: JSON, Error: Error, ctx: null };
      }
    };
  }

  /** Browser-compatible loader: codeSource is the Code.gs text (or an array of {filename, code}). */
  function loadAppFromSource(codeSource, env, o) {
    o = o || {};
    if (!env || !env.globals) throw new Error('loadAppFromSource(codeSource, env): env from GasMock.createGasEnv() is required');
    var sources = Array.isArray(codeSource) ? codeSource : [{ filename: 'Code.gs', code: String(codeSource) }];
    if (o.files) env.setFiles(o.files);
    var holder = { sources: sources, engine: functionEngine(sources, env) };
    var app = createApp(holder, env);
    app.reload = function (newSource) {
      holder.sources = Array.isArray(newSource) ? newSource : [{ filename: 'Code.gs', code: String(newSource) }];
      holder.engine = functionEngine(holder.sources, env);
    };
    return app;
  }

  /* ------------------------------------------------------------------ Node engine (node:vm) */
  function vmEngine(sources, env) {
    var vm = require('node:vm');
    var scripts = sources.map(function (s) { return new vm.Script(s.code, { filename: s.filename }); });
    return {
      newExecution: function () {
        var sandbox = {};
        Object.keys(env.globals).forEach(function (k) { sandbox[k] = env.globals[k]; });
        var ctx = vm.createContext(sandbox, { name: 'apps-script-execution' });
        var realm = { JSON: vm.runInContext('JSON', ctx), Error: vm.runInContext('Error', ctx) };
        var ev = function (c) { return vm.runInContext(c, ctx); };
        env._setExecutionRealm({ Error: realm.Error, evalInApp: ev });
        scripts.forEach(function (s) { s.runInContext(ctx); });
        return { eval: ev, JSON: realm.JSON, Error: realm.Error, ctx: ctx };
      }
    };
  }

  /**
   * Node loader. o = { srcDir, env?, envOptions?, code? }.
   * Reads every *.gs in srcDir (Code.gs first) and serves *.html files to HtmlService (fresh from disk).
   */
  function loadApp(o) {
    o = o || {};
    var fs = require('node:fs');
    var path = require('node:path');
    var srcDir = path.resolve(o.srcDir || path.join(__dirname, '..', 'src'));
    var env = o.env;
    if (!env) {
      var GasMock = require('./gas-mock.js');
      env = GasMock.createGasEnv(o.envOptions || {});
    }
    function readSources() {
      if (o.code) return [{ filename: path.join(srcDir, 'Code.gs'), code: String(o.code) }];
      var files = fs.readdirSync(srcDir).filter(function (f) { return /\.gs$/.test(f); });
      files.sort(function (a, b) { return a === 'Code.gs' ? -1 : b === 'Code.gs' ? 1 : a < b ? -1 : a > b ? 1 : 0; });
      if (!files.length) throw new Error('No .gs files found in ' + srcDir);
      return files.map(function (f) { return { filename: path.join(srcDir, f), code: fs.readFileSync(path.join(srcDir, f), 'utf8') }; });
    }
    function mtimes() {
      try { return fs.readdirSync(srcDir).filter(function (f) { return /\.gs$/.test(f); }).map(function (f) { return f + ':' + fs.statSync(path.join(srcDir, f)).mtimeMs; }).join('|'); }
      catch (e) { return ''; }
    }
    env.setFiles(function (name) {
      var n = String(name);
      if (n.indexOf('/') >= 0 || n.indexOf('\\') >= 0 || n.indexOf('..') >= 0) return null;
      var candidates = /\.html$/.test(n) ? [n] : [n + '.html', n];
      for (var i = 0; i < candidates.length; i++) {
        var p = path.join(srcDir, candidates[i]);
        try { if (fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8'); } catch (e) { /* next */ }
      }
      return null;
    });
    var sources = readSources();
    var holder = { sources: sources, engine: vmEngine(sources, env) };
    var app = createApp(holder, env);
    var stamp = mtimes();
    app.srcDir = srcDir;
    app.reload = function () { holder.sources = readSources(); holder.engine = vmEngine(holder.sources, env); stamp = mtimes(); return app; };
    app.maybeReload = function () { var now = mtimes(); if (now !== stamp) { app.reload(); return true; } return false; };
    return app;
  }

  return {
    loadApp: loadApp,
    loadAppFromSource: loadAppFromSource,
    checkTransferable: checkTransferable,
    extractBoot: extractBoot,
    buildEvent: buildEvent,
    isPublicName: isPublicName
  };
}));
