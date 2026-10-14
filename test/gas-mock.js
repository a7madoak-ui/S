/*
 * gas-mock.js — high-fidelity Google Apps Script mock for «نبض المدارس» (Nabd).
 *
 * Isomorphic (Node + browser): NO Node built-ins. Pure-JS SHA-256 / HMAC / base64 / UTF-8,
 * Intl only for time-zone maths. Exports via module.exports when available, else window.GasMock.
 *
 *   var env = GasMock.createGasEnv({ ownerEmail, scriptUrl, files, clock });
 *   env.globals  → SpreadsheetApp, DriveApp, PropertiesService, CacheService, LockService, MailApp,
 *                  Session, ScriptApp, HtmlService, Utilities, Logger, console, Date (clock-aware), Intl (blocked)
 *   env.mailbox / env.triggers / env.formulaWrites / env.warnings  (live views of the state)
 *   env.clock.set('2026-10-14T07:30')   // no offset = wall time in Asia/Riyadh; or full ISO with Z/offset
 *   env.snapshot() / env.restore(state) // whole persistent state as plain JSON
 *
 * The point of this file is to reproduce the platform behaviours that break real Apps Script apps:
 * Sheets auto-conversion ('2026-10-14' → Date, '0123' → 123, 'TRUE' → true, '+9665…' → number),
 * formulas from user text, getRange() bounds errors, getUi() in web context, Properties/Cache limits,
 * Cache TTL, DriveApp ids that do not exist, trashed files still returned by getFileById, Blob bytes
 * being signed Java bytes, Utilities.formatDate refusing strings, Date in google.script.run results …
 * Messages of platform errors mirror Apps Script (error.name === 'Exception').
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  else { root.GasMock = api; }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.1.0';
  var RealDate = Date;
  function realNow() { return RealDate.now(); }
  var hasOwn = Object.prototype.hasOwnProperty;

  /* ============================================================================================
   * Bytes: UTF-8, base64, signed/unsigned
   * ========================================================================================== */
  function utf8Encode(str) {
    str = String(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++; } else { c = 0xFFFD; }
      } else if (c >= 0xD800 && c <= 0xDFFF) { c = 0xFFFD; }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function utf8Length(str) {
    str = String(str);
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function utf8Decode(bytes) {
    var chunks = [], buf = [], i = 0, n = bytes.length;
    function flush() { if (buf.length) { chunks.push(String.fromCharCode.apply(null, buf)); buf = []; } }
    while (i < n) {
      var b = bytes[i++] & 255, cp, need;
      if (b < 0x80) { cp = b; need = 0; }
      else if (b >= 0xF0 && b < 0xF8) { cp = b & 7; need = 3; }
      else if (b >= 0xE0) { cp = b & 15; need = 2; }
      else if (b >= 0xC0) { cp = b & 31; need = 1; }
      else { cp = 0xFFFD; need = 0; }
      for (var k = 0; k < need; k++) {
        if (i >= n || (bytes[i] & 0xC0) !== 0x80) { cp = 0xFFFD; break; }
        cp = (cp << 6) | (bytes[i++] & 63);
      }
      if (cp > 0xFFFF) { cp -= 0x10000; buf.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023)); }
      else buf.push(cp);
      if (buf.length > 8000) flush();
    }
    flush();
    return chunks.join('');
  }
  function toSignedBytes(bytes) {
    var out = new Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) { var b = bytes[i] & 255; out[i] = b > 127 ? b - 256 : b; }
    return out;
  }
  function toUnsignedBytes(bytes) {
    var out = new Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] & 255;
    return out;
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_REV = (function () { var m = {}; for (var i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; }());
  function base64Encode(bytes, webSafe) {
    var out = [], chunk = '', i, n = bytes.length;
    for (i = 0; i + 2 < n; i += 3) {
      var t = ((bytes[i] & 255) << 16) | ((bytes[i + 1] & 255) << 8) | (bytes[i + 2] & 255);
      chunk += B64[t >> 18] + B64[(t >> 12) & 63] + B64[(t >> 6) & 63] + B64[t & 63];
      if (chunk.length > 16000) { out.push(chunk); chunk = ''; }
    }
    if (n - i === 1) { var a = (bytes[i] & 255) << 16; chunk += B64[a >> 18] + B64[(a >> 12) & 63] + '=='; }
    else if (n - i === 2) { var b2 = ((bytes[i] & 255) << 16) | ((bytes[i + 1] & 255) << 8); chunk += B64[b2 >> 18] + B64[(b2 >> 12) & 63] + B64[(b2 >> 6) & 63] + '='; }
    out.push(chunk);
    var s = out.join('');
    if (webSafe) s = s.replace(/\+/g, '-').replace(/\//g, '_');
    return s;
  }
  /** Returns unsigned bytes or null when the input is not valid base64 (Apps Script: "Could not decode string."). */
  function base64DecodeOrNull(str, webSafe) {
    var s = String(str).replace(/[\r\n\t ]+/g, '');
    if (webSafe) s = s.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
    var body = s.replace(/=+$/, '');
    if (body.length % 4 === 1) return null;
    if (s.length !== body.length && s.length % 4 !== 0) return null;
    var out = new Array(Math.floor(body.length * 3 / 4));
    var o = 0, i;
    for (i = 0; i + 3 < body.length; i += 4) {
      var t = (B64_REV[body.charCodeAt(i)] << 18) | (B64_REV[body.charCodeAt(i + 1)] << 12) | (B64_REV[body.charCodeAt(i + 2)] << 6) | B64_REV[body.charCodeAt(i + 3)];
      out[o++] = (t >> 16) & 255; out[o++] = (t >> 8) & 255; out[o++] = t & 255;
    }
    var rest = body.length - i;
    if (rest === 2) { var t2 = (B64_REV[body.charCodeAt(i)] << 18) | (B64_REV[body.charCodeAt(i + 1)] << 12); out[o++] = (t2 >> 16) & 255; }
    else if (rest === 3) { var t3 = (B64_REV[body.charCodeAt(i)] << 18) | (B64_REV[body.charCodeAt(i + 1)] << 12) | (B64_REV[body.charCodeAt(i + 2)] << 6); out[o++] = (t3 >> 16) & 255; out[o++] = (t3 >> 8) & 255; }
    out.length = o;
    return out;
  }
  function base64Decode(str, webSafe) {
    var r = base64DecodeOrNull(str, webSafe);
    if (r === null) throw new Error('Could not decode string.');
    return r;
  }
  function bytesFromInput(v) {
    if (typeof v === 'string') return utf8Encode(v);
    if (v && typeof v.length === 'number') return toUnsignedBytes(v);
    return utf8Encode(String(v));
  }

  /* ============================================================================================
   * SHA-256 / HMAC-SHA256 (pure JS)
   * ========================================================================================== */
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  /** SHA-256 of a string (UTF-8) or byte array; returns UNSIGNED bytes. */
  function sha256Bytes(input) {
    var msg = typeof input === 'string' ? utf8Encode(input) : input;
    var len = msg.length, i;
    var nBlocks = ((len + 8) >> 6) + 1;
    var words = new Array(nBlocks * 16);
    for (i = 0; i < words.length; i++) words[i] = 0;
    for (i = 0; i < len; i++) words[i >> 2] |= (msg[i] & 255) << (24 - (i % 4) * 8);
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[nBlocks * 16 - 2] = Math.floor(len / 0x20000000);
    words[nBlocks * 16 - 1] = (len * 8) >>> 0;
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64);
    for (var blk = 0; blk < nBlocks; blk++) {
      for (i = 0; i < 16; i++) W[i] = words[blk * 16 + i] | 0;
      for (i = 16; i < 64; i++) {
        var w15 = W[i - 15], w2 = W[i - 2];
        var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
    return out;
  }
  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { var b = bytes[i] & 255; s += (b < 16 ? '0' : '') + b.toString(16); }
    return s;
  }
  function sha256Hex(input) { return bytesToHex(sha256Bytes(input)); }
  function hmacSha256Bytes(value, key) {
    var k = typeof key === 'string' ? utf8Encode(key) : toUnsignedBytes(key);
    var m = typeof value === 'string' ? utf8Encode(value) : toUnsignedBytes(value);
    if (k.length > 64) k = sha256Bytes(k);
    var ipad = [], opad = [], i;
    for (i = 0; i < 64; i++) { var kb = k[i] || 0; ipad.push(kb ^ 0x36); opad.push(kb ^ 0x5c); }
    return sha256Bytes(opad.concat(sha256Bytes(ipad.concat(m))));
  }

  /* ============================================================================================
   * Randomness (crypto.getRandomValues when present; seeded PRNG when a seed is given)
   * ========================================================================================== */
  function makeRng(seed) {
    if (seed !== undefined && seed !== null) {
      var s = (typeof seed === 'number' ? seed : sha256Bytes(String(seed)).slice(0, 4).reduce(function (a, b) { return (a << 8) | b; }, 0)) >>> 0;
      var next = function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      return { float: next, bytes: function (n) { var o = []; for (var i = 0; i < n; i++) o.push(Math.floor(next() * 256)); return o; } };
    }
    var cr = (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') ? globalThis.crypto : null;
    return {
      float: function () { if (cr) { var a = new Uint32Array(1); cr.getRandomValues(a); return a[0] / 4294967296; } return Math.random(); },
      bytes: function (n) {
        if (cr) { var a = new Uint8Array(n); cr.getRandomValues(a); return Array.prototype.slice.call(a); }
        var o = []; for (var i = 0; i < n; i++) o.push(Math.floor(Math.random() * 256)); return o;
      }
    };
  }

  /* ============================================================================================
   * Time zones (Intl) + Java SimpleDateFormat
   * ========================================================================================== */
  var dtfCache = {};
  function getDtf(tz) {
    if (hasOwn.call(dtfCache, tz)) return dtfCache[tz];
    var f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch (e) { f = null; }
    dtfCache[tz] = f;
    return f;
  }
  function fixedOffsetMinutes(tz) {
    var m = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(String(tz));
    if (!m) return null;
    if (!m[1]) return 0;
    return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
  }
  function isValidTimeZone(tz) { return fixedOffsetMinutes(tz) !== null || !!getDtf(tz); }
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function tzParts(ms, tz) {
    var fixed = fixedOffsetMinutes(tz);
    var dtf = fixed === null ? getDtf(tz) : null;
    if (fixed === null && !dtf) fixed = 0; // java.util.TimeZone falls back to GMT for unknown ids
    var S = ((ms % 1000) + 1000) % 1000;
    if (fixed !== null) {
      var d = new RealDate(ms + fixed * 60000);
      return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), S: S, wd: d.getUTCDay(), offSec: fixed * 60 };
    }
    var o = {};
    var parts = dtf.formatToParts(new RealDate(ms));
    for (var i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
    var y = parseInt(o.year, 10);
    if (o.era && /^B/i.test(o.era)) y = 1 - y;
    var H = parseInt(o.hour, 10); if (H === 24) H = 0;
    var res = { y: y, M: parseInt(o.month, 10), d: parseInt(o.day, 10), H: H, m: parseInt(o.minute, 10), s: parseInt(o.second, 10), S: S };
    var asUtc = wallToUtcNaive(res.y, res.M, res.d, res.H, res.m, res.s, 0);
    res.offSec = Math.round((asUtc - (ms - S)) / 1000);
    res.wd = new RealDate(asUtc).getUTCDay();
    return res;
  }
  /** Milliseconds for a wall-clock time interpreted as UTC (exact for every year). */
  function wallToUtcNaive(y, M, d, H, m, s, S) {
    var dt = new RealDate(0);
    dt.setUTCFullYear(y, M - 1, d);
    dt.setUTCHours(H || 0, m || 0, s || 0, S || 0);
    return dt.getTime();
  }
  /** Wall time in `tz` → epoch ms. */
  function zonedToUtc(y, M, d, H, m, s, S, tz) {
    var guess = wallToUtcNaive(y, M, d, H, m, s, S);
    var off1 = tzParts(guess, tz).offSec;
    var t = guess - off1 * 1000;
    var off2 = tzParts(t, tz).offSec;
    if (off2 !== off1) t = guess - off2 * 1000;
    return t;
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function pad(v, n) { var neg = v < 0; var s = String(Math.abs(v)); while (s.length < n) s = '0' + s; return (neg ? '-' : '') + s; }
  function offsetStr(offSec, colon, minutes) {
    var sign = offSec < 0 ? '-' : '+';
    var a = Math.abs(offSec), hh = Math.floor(a / 3600), mm = Math.floor((a % 3600) / 60);
    return sign + pad(hh, 2) + (minutes === false ? '' : (colon ? ':' : '') + pad(mm, 2));
  }
  function tzName(ms, tz, long) {
    try {
      var f = new Intl.DateTimeFormat('en-US', { timeZone: fixedOffsetMinutes(tz) !== null ? 'UTC' : tz, timeZoneName: long ? 'long' : 'short' });
      var p = f.formatToParts(new RealDate(ms)).filter(function (x) { return x.type === 'timeZoneName'; })[0];
      return p ? p.value : 'GMT';
    } catch (e) { return 'GMT'; }
  }
  function dayOfYear(p) { return Math.round((wallToUtcNaive(p.y, p.M, p.d) - wallToUtcNaive(p.y, 1, 1)) / 86400000) + 1; }
  /** java.text.SimpleDateFormat (English locale) subset used by Utilities.formatDate. */
  function formatJava(ms, tz, pattern) {
    var p = tzParts(ms, tz);
    var out = '', i = 0, n = pattern.length;
    while (i < n) {
      var ch = pattern.charAt(i);
      if (ch === "'") {
        if (pattern.charAt(i + 1) === "'") { out += "'"; i += 2; continue; }
        var j = i + 1, lit = '', closed = false;
        while (j < n) {
          if (pattern.charAt(j) === "'") { if (pattern.charAt(j + 1) === "'") { lit += "'"; j += 2; continue; } closed = true; break; }
          lit += pattern.charAt(j); j++;
        }
        if (!closed) throw new Error('Unterminated quote');
        out += lit; i = j + 1; continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        var k = i; while (k < n && pattern.charAt(k) === ch) k++;
        var cnt = k - i;
        switch (ch) {
          case 'G': out += p.y > 0 ? 'AD' : 'BC'; break;
          case 'y': case 'Y': out += cnt === 2 ? pad(((p.y % 100) + 100) % 100, 2) : pad(p.y, cnt); break;
          case 'M': case 'L': out += cnt >= 4 ? MONTHS[p.M - 1] : cnt === 3 ? MONTHS[p.M - 1].slice(0, 3) : pad(p.M, cnt); break;
          case 'd': out += pad(p.d, cnt); break;
          case 'D': out += pad(dayOfYear(p), cnt); break;
          case 'E': out += cnt >= 4 ? DAYS[p.wd] : DAYS[p.wd].slice(0, 3); break;
          case 'u': out += pad(((p.wd + 6) % 7) + 1, cnt); break;
          case 'F': out += pad(Math.floor((p.d - 1) / 7) + 1, cnt); break;
          case 'w': out += pad(Math.floor((dayOfYear(p) - 1 + new RealDate(wallToUtcNaive(p.y, 1, 1)).getUTCDay()) / 7) + 1, cnt); break;
          case 'W': out += pad(Math.floor((p.d - 1 + new RealDate(wallToUtcNaive(p.y, p.M, 1)).getUTCDay()) / 7) + 1, cnt); break;
          case 'a': out += p.H < 12 ? 'AM' : 'PM'; break;
          case 'H': out += pad(p.H, cnt); break;
          case 'k': out += pad(p.H === 0 ? 24 : p.H, cnt); break;
          case 'K': out += pad(p.H % 12, cnt); break;
          case 'h': out += pad(p.H % 12 === 0 ? 12 : p.H % 12, cnt); break;
          case 'm': out += pad(p.m, cnt); break;
          case 's': out += pad(p.s, cnt); break;
          case 'S': out += pad(p.S, cnt); break;
          case 'z': out += tzName(ms, tz, cnt >= 4); break;
          case 'Z': out += offsetStr(p.offSec, false); break;
          case 'X':
            if (p.offSec === 0) out += 'Z';
            else out += cnt === 1 ? offsetStr(p.offSec, false, false) : cnt === 2 ? offsetStr(p.offSec, false) : offsetStr(p.offSec, true);
            break;
          default: throw new Error("Illegal pattern character '" + ch + "'");
        }
        i = k; continue;
      }
      out += ch; i++;
    }
    return out;
  }
  /** Lenient java.text.SimpleDateFormat.parse subset (numbers, MMM/MMMM, literals, a, Z/X). */
  function parseJava(str, tz, pattern) {
    var re = '^', fields = [], i = 0, n = pattern.length;
    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    while (i < n) {
      var ch = pattern.charAt(i);
      if (ch === "'") {
        var j = i + 1, lit = '';
        while (j < n && pattern.charAt(j) !== "'") { lit += pattern.charAt(j); j++; }
        re += esc(lit || "'"); i = j + 1; continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        var k = i; while (k < n && pattern.charAt(k) === ch) k++;
        var cnt = k - i;
        if ((ch === 'M' || ch === 'L') && cnt >= 3) { re += '([A-Za-z]+)'; fields.push('Mtext'); }
        else if (ch === 'E') { re += '[A-Za-z]+'; }
        else if (ch === 'a') { re += '([AaPp][Mm])'; fields.push('a'); }
        else if (ch === 'Z' || ch === 'X') { re += '(Z|[+-]\\d{2}:?\\d{2}|[+-]\\d{2})'; fields.push('off'); }
        else if ('yYMLdHkKhmsSD'.indexOf(ch) >= 0) { re += '([+-]?\\d+)'; fields.push(ch); }
        else throw new Error("Illegal pattern character '" + ch + "'");
        i = k; continue;
      }
      re += esc(ch); i++;
    }
    var m = new RegExp(re).exec(String(str));
    if (!m) throw new Error('Unparseable date: "' + str + '"');
    var v = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0, S: 0, pm: null, off: null };
    for (var f = 0; f < fields.length; f++) {
      var t = m[f + 1];
      switch (fields[f]) {
        case 'y': case 'Y': v.y = parseInt(t, 10); if (t.length <= 2) v.y += v.y < 50 ? 2000 : 1900; break;
        case 'M': case 'L': v.M = parseInt(t, 10); break;
        case 'Mtext': var idx = MONTHS.map(function (x) { return x.slice(0, 3).toLowerCase(); }).indexOf(t.slice(0, 3).toLowerCase()); if (idx < 0) throw new Error('Unparseable date: "' + str + '"'); v.M = idx + 1; break;
        case 'd': v.d = parseInt(t, 10); break;
        case 'D': v.M = 1; v.d = parseInt(t, 10); break;
        case 'H': case 'k': v.H = parseInt(t, 10); break;
        case 'K': case 'h': v.H = parseInt(t, 10) % 12; break;
        case 'm': v.m = parseInt(t, 10); break;
        case 's': v.s = parseInt(t, 10); break;
        case 'S': v.S = parseInt(t, 10); break;
        case 'a': v.pm = /^p/i.test(t); break;
        case 'off': v.off = t === 'Z' ? 0 : (t.charAt(0) === '-' ? -1 : 1) * (parseInt(t.substr(1, 2), 10) * 60 + (parseInt(t.replace(':', '').substr(3, 2), 10) || 0)); break;
      }
    }
    if (v.pm === true && v.H < 12) v.H += 12;
    // Lenient: overflow rolls over (2026-13-01 → 2027-01-01) exactly like SimpleDateFormat's default.
    var wall = wallToUtcNaive(v.y, v.M, v.d, v.H, v.m, v.s, v.S);
    if (v.off !== null) return wall - v.off * 60000;
    var w = new RealDate(wall);
    return zonedToUtc(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), w.getUTCMilliseconds(), tz);
  }

  /* ============================================================================================
   * Small utilities
   * ========================================================================================== */
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function colToNum(s) { var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
  function numToCol(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function a1(r, c) { return numToCol(c) + r; }
  function isEmptyObj(o) { for (var k in o) if (hasOwn.call(o, k)) return false; return true; }
  function typeName(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return 'String';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'Boolean';
    if (isDate(v)) return 'Date';
    if (Array.isArray(v)) return 'Object[]';
    if (typeof v === 'function') return 'Function';
    return 'Object';
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function formatString(template) {
    var args = Array.prototype.slice.call(arguments, 1), ai = 0;
    return String(template).replace(/%([%sdifjo])|%(\.\d+)f/g, function (m, t, prec) {
      if (t === '%') return '%';
      var v = args[ai++];
      if (prec) return Number(v).toFixed(parseInt(prec.slice(1), 10));
      if (t === 'd' || t === 'i') return String(Math.trunc(Number(v)));
      if (t === 'f') return String(Number(v));
      if (t === 'j' || t === 'o') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
      return String(v);
    });
  }
  function parseCsv(text, delim) {
    delim = delim || ',';
    var rows = [], row = [], cur = '', q = false, i = 0, s = String(text);
    while (i < s.length) {
      var ch = s.charAt(i);
      if (q) {
        if (ch === '"') { if (s.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; } q = false; i++; continue; }
        cur += ch; i++; continue;
      }
      if (ch === '"') { q = true; i++; continue; }
      if (ch === delim) { row.push(cur); cur = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += ch; i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  /** A chainable do-nothing builder (any method returns the builder; build() returns a rule-like object). */
  function chainStub(label, store) {
    var calls = [];
    var target = {};
    var proxy = new Proxy(target, {
      get: function (t, k) {
        if (k === 'toString') return function () { return label; };
        if (k === 'build') return function () { var rule = { __stub: label, calls: calls.slice(), copy: function () { return chainStub(label, store); }, toString: function () { return label; } }; if (store) store.push(rule); return rule; };
        if (typeof k === 'symbol') return undefined;
        return function () { calls.push([k].concat(Array.prototype.slice.call(arguments).map(function (a) { return typeof a === 'object' ? String(a) : a; }))); return proxy; };
      }
    });
    return proxy;
  }

  /* ============================================================================================
   * Sheets value coercion (what Google Sheets does to a value written with setValue/appendRow)
   * ========================================================================================== */
  var RE_NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  var RE_NUM_THOUSANDS = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
  var RE_PCT = /^[+-]?(?:\d+\.?\d*|\.\d+)\s?%$/;
  var RE_DATE = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  var RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AaPp][Mm]))?$/;
  var RE_BOOL = /^(?:true|false)$/i;

  function daysInMonth(y, M) { return new RealDate(RealDate.UTC(2001, M, 0)).getUTCDate() + (M === 2 && isLeap(y) ? 1 : 0); }

  /* ============================================================================================
   * createGasEnv
   * ========================================================================================== */
  function createGasEnv(opts) {
    opts = opts || {};
    var SCRIPT_TZ = opts.scriptTimeZone || 'Asia/Riyadh';
    var DEFAULT_ROWS = opts.newSheetRows || 1000;
    var DEFAULT_COLS = opts.newSheetColumns || 26;
    var QUOTE_MODE = opts.textCellQuotePrefix === 'strip' ? 'strip' : 'keep';
    var STRICT_INTL = opts.strictIntl !== false;
    var MAIL_QUOTA = typeof opts.mailQuota === 'number' ? opts.mailQuota : 100;
    var rng = makeRng(opts.seed);
    var filesResolver = null;
    var S = null;                      // the whole persistent state (plain JSON)
    var exec = null;                   // current execution context (set by runtime)
    var counters = {};

    function randChars(n, alphabet) {
      var b = rng.bytes(n), s = '';
      for (var i = 0; i < n; i++) s += alphabet.charAt(b[i] % alphabet.length);
      return s;
    }
    function driveId(len) { return '1' + randChars((len || 33) - 1, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'); }
    function uuid() {
      var b = rng.bytes(16);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = bytesToHex(b);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
    function bump(name) { counters[name] = (counters[name] || 0) + 1; }

    /* ------------------------------------------------------------------ errors */
    function ErrCtor() { return (exec && exec.Error) || Error; }
    function exc(msg) { var C = ErrCtor(); var e = new C(msg); e.name = 'Exception'; return e; }
    function sigError(method, args) { return exc('The parameters (' + Array.prototype.map.call(args, typeName).join(',') + ") don't match the method signature for " + method + '.'); }
    function policy(msg) { var C = ErrCtor(); var e = new C('[gas-mock policy] ' + msg); e.name = 'Exception'; return e; }
    function warn(msg) { S.warnings.push({ at: clock.local(), execution: exec ? exec.label : null, message: msg }); if (S.warnings.length > 500) S.warnings.shift(); }
    function requireAuth(what) {
      if (env.authMode === 'LIMITED' || env.authMode === 'NONE') {
        throw exc('You do not have permission to call ' + what + '. Required permissions: (simple triggers such as onOpen run with AuthMode.' + env.authMode + ')');
      }
    }
    function intArg(v, method) {
      if (typeof v !== 'number' || !isFinite(v)) throw exc('Cannot convert ' + (typeof v === 'string' ? "'" + v + "'" : String(v)) + ' to int.' + (method ? ' (' + method + ')' : ''));
      if (Math.floor(v) !== v) throw exc('Cannot convert ' + v + ' to int.');
      return v;
    }

    /* ------------------------------------------------------------------ state */
    function newSheetState(id, name, rows, cols) {
      return { id: id, name: name, maxRows: rows || DEFAULT_ROWS, maxCols: cols || DEFAULT_COLS, frozenRows: 0, frozenCols: 0,
        rtl: false, hiddenGrid: false, tabColor: null, hidden: false, rows: {}, fmt: [], sty: [], dv: [], colW: {}, rowH: {},
        merges: [], notes: {}, hiddenCols: {}, cf: [], protections: 0 };
    }
    function parseClockInput(t) {
      if (typeof t === 'number') return t;
      if (t && typeof t.getTime === 'function') return t.getTime();
      var s = String(t).trim();
      var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(s);
      if (m) return zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +((m[7] || '0') + '00').slice(0, 3), SCRIPT_TZ);
      var ms = RealDate.parse(s);
      if (isNaN(ms)) throw new Error('[gas-mock] clock: cannot parse time "' + s + '" (use ISO like 2026-10-14T07:30 — wall time in ' + SCRIPT_TZ + ' — or with Z/offset)');
      return ms;
    }
    function freshState() {
      var initClock = { frozen: false, ms: 0, offset: 0 };
      if (opts.clock !== undefined && opts.clock !== null) {
        if (typeof opts.clock === 'object' && !isDate(opts.clock) && !('getTime' in opts.clock)) {
          var ms0 = opts.clock.iso !== undefined ? parseClockInput(opts.clock.iso) : realNow();
          if (opts.clock.running) { initClock.frozen = false; initClock.offset = ms0 - realNow(); } else { initClock.frozen = true; initClock.ms = ms0; }
        } else { initClock.frozen = true; initClock.ms = parseClockInput(opts.clock); }
      }
      var ssId = opts.spreadsheetId || driveId(44);
      var firstSheets = opts.initialSheets || [opts.firstSheetName || 'Sheet1'];
      var sheets = firstSheets.map(function (n, i) { return newSheetState(i === 0 ? 0 : 100000 + Math.floor(rng.float() * 1e9), n); });
      return {
        v: 1,
        config: {
          ownerEmail: opts.ownerEmail || 'owner@gmail.com',
          activeUserEmail: opts.activeUserEmail || '',
          scriptUrl: opts.scriptUrl === undefined ? 'https://script.google.com/macros/s/' + driveId(72) + '/exec' : opts.scriptUrl,
          scriptId: opts.scriptId || driveId(57),
          scriptTimeZone: SCRIPT_TZ
        },
        clock: initClock,
        ss: { id: ssId, name: opts.spreadsheetName || 'نبض المدارس', tz: opts.spreadsheetTimeZone || SCRIPT_TZ, locale: opts.spreadsheetLocale || 'ar',
          sheets: sheets, activeSheetId: sheets[0].id, toasts: [], owner: opts.ownerEmail || 'owner@gmail.com' },
        props: { script: {}, user: {}, document: {} },
        cache: { script: {}, user: {}, document: {} },
        triggers: [],
        mail: [],
        mailQuota: { day: '', used: 0 },
        drive: { rootId: driveId(28), folders: {}, files: {} },
        formulaWrites: [],
        warnings: [],
        logs: [],
        ui: { menus: [], alerts: [], dialogs: [], promptQueue: [], alertQueue: [] },
        seq: 0
      };
    }

    /* ------------------------------------------------------------------ clock + Date */
    var clock = {
      now: function () { var c = S.clock; return c.frozen ? c.ms : realNow() + c.offset; },
      set: function (t, o) {
        var ms = parseClockInput(t);
        if (o && o.running) { S.clock.frozen = false; S.clock.offset = ms - realNow(); } else { S.clock.frozen = true; S.clock.ms = ms; }
        return clock;
      },
      advance: function (ms) { if (S.clock.frozen) S.clock.ms += ms; else S.clock.offset += ms; return clock; },
      advanceMinutes: function (n) { return clock.advance(n * 60000); },
      advanceDays: function (n) { return clock.advance(n * 86400000); },
      freeze: function () { if (!S.clock.frozen) { S.clock.ms = clock.now(); S.clock.frozen = true; } return clock; },
      run: function () { if (S.clock.frozen) { S.clock.offset = S.clock.ms - realNow(); S.clock.frozen = false; } return clock; },
      real: function () { S.clock.frozen = false; S.clock.offset = 0; return clock; },
      get frozen() { return S.clock.frozen; },
      iso: function () { return new RealDate(clock.now()).toISOString(); },
      local: function (pattern, tz) { return formatJava(clock.now(), tz || SCRIPT_TZ, pattern || 'yyyy-MM-dd HH:mm:ss'); },
      today: function () { return formatJava(clock.now(), SCRIPT_TZ, 'yyyy-MM-dd'); }
    };
    var LOCALE_MSG = ' depends on Intl/ICU and the script time zone in Apps Script — use Utilities.formatDate(date, TZ, pattern) (spec §2.1/§2.4).';
    var GasDate = function Date(a, b, c, d, e, f, g) {
      if (!new.target) return new RealDate(clock.now()).toString();
      var args = arguments.length === 0 ? [clock.now()] : Array.prototype.slice.call(arguments);
      return Reflect.construct(RealDate, args, new.target);
    };
    GasDate.prototype = Object.create(RealDate.prototype, { constructor: { value: GasDate, writable: true, configurable: true } });
    Object.setPrototypeOf(GasDate, RealDate);
    GasDate.now = function now() { return clock.now(); };
    if (STRICT_INTL) {
      ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (k) {
        Object.defineProperty(GasDate.prototype, k, { configurable: true, writable: true, value: function () { throw new Error('[gas-mock] Date.prototype.' + k + LOCALE_MSG); } });
      });
    }
    function newDate(ms) { return new GasDate(ms); }
    var IntlBlocked = new Proxy({}, {
      get: function (t, k) {
        if (k === Symbol.toStringTag) return 'Intl';
        if (typeof k === 'symbol') return undefined;
        throw new Error('[gas-mock] Intl.' + String(k) + LOCALE_MSG);
      }
    });

    /* ------------------------------------------------------------------ sheet state helpers */
    function sheetById(id, mustExist) {
      var list = S.ss.sheets;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      if (mustExist) throw exc('The sheet has been deleted or is no longer available.');
      return null;
    }
    function cellGet(sh, r, c) { var row = sh.rows[r]; return row ? row[c] : undefined; }
    function cellPut(sh, r, c, cell) {
      if (!cell || ((cell.v === '' || cell.v === undefined) && !cell.f)) {
        var row0 = sh.rows[r];
        if (row0) { delete row0[c]; if (isEmptyObj(row0)) delete sh.rows[r]; }
        return;
      }
      (sh.rows[r] || (sh.rows[r] = {}))[c] = cell;
    }
    function cellOut(cell) {
      if (!cell) return '';
      var v = cell.v;
      if (v !== null && typeof v === 'object') return newDate(v.$d);
      return v === undefined ? '' : v;
    }
    function rectFind(list, r, c, key) {
      for (var i = list.length - 1; i >= 0; i--) {
        var x = list[i];
        if (r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2 && (key === undefined || x.k === key)) return x;
      }
      return null;
    }
    function addRect(list, rect) {
      for (var i = list.length - 1; i >= 0; i--) {
        var x = list[i];
        if (x.k === rect.k && x.r1 >= rect.r1 && x.r2 <= rect.r2 && x.c1 >= rect.c1 && x.c2 <= rect.c2) list.splice(i, 1);
      }
      list.push(rect);
    }
    function nfAt(sh, r, c) { var x = rectFind(sh.fmt, r, c); return x ? x.nf : null; }
    function styleAt(sh, r, c, k, dflt) { var x = rectFind(sh.sty, r, c, k); return x ? x.v : dflt; }
    function lastRowOf(sh) { var m = 0; for (var k in sh.rows) if (hasOwn.call(sh.rows, k)) { var r = +k; if (r > m) m = r; } return m; }
    function lastColOf(sh) {
      var m = 0;
      for (var k in sh.rows) if (hasOwn.call(sh.rows, k)) { var row = sh.rows[k]; for (var c in row) if (hasOwn.call(row, c) && +c > m) m = +c; }
      return m;
    }
    function shiftList(list, axis, fn) {
      var A1 = axis === 'r' ? 'r1' : 'c1', A2 = axis === 'r' ? 'r2' : 'c2';
      for (var i = list.length - 1; i >= 0; i--) {
        var res = fn(list[i][A1], list[i][A2]);
        if (!res) list.splice(i, 1); else { list[i][A1] = res[0]; list[i][A2] = res[1]; }
      }
    }
    function insertShift(after, n) {
      return function (a, b) { if (a > after) return [a + n, b + n]; if (b >= after) return [a, b + n]; return [a, b]; };
    }
    function deleteShift(start, n) {
      var end = start + n - 1;
      return function (a, b) {
        if (b < start) return [a, b];
        if (a > end) return [a - n, b - n];
        var na = a < start ? a : start, nb = b > end ? b - n : start - 1;
        return nb < na ? null : [na, nb];
      };
    }
    function shiftKeyed(obj, fn) { var out = {}; for (var k in obj) if (hasOwn.call(obj, k)) { var nk = fn(+k); if (nk !== null) out[nk] = obj[k]; } return out; }
    function shiftNotes(sh, axis, fn) {
      var out = {};
      for (var k in sh.notes) if (hasOwn.call(sh.notes, k)) {
        var p = k.split(':'), r = +p[0], c = +p[1];
        if (axis === 'r') { r = fn(r); if (r === null) continue; } else { c = fn(c); if (c === null) continue; }
        out[r + ':' + c] = sh.notes[k];
      }
      sh.notes = out;
    }
    function insertRowsState(sh, after, n) {
      sh.rows = shiftKeyed(sh.rows, function (r) { return r > after ? r + n : r; });
      [sh.fmt, sh.sty, sh.dv, sh.merges].forEach(function (l) { shiftList(l, 'r', insertShift(after, n)); });
      sh.rowH = shiftKeyed(sh.rowH, function (r) { return r > after ? r + n : r; });
      shiftNotes(sh, 'r', function (r) { return r > after ? r + n : r; });
      sh.maxRows += n;
    }
    function deleteRowsState(sh, start, n) {
      var end = start + n - 1;
      sh.rows = shiftKeyed(sh.rows, function (r) { return r < start ? r : r > end ? r - n : null; });
      [sh.fmt, sh.sty, sh.dv, sh.merges].forEach(function (l) { shiftList(l, 'r', deleteShift(start, n)); });
      sh.rowH = shiftKeyed(sh.rowH, function (r) { return r < start ? r : r > end ? r - n : null; });
      shiftNotes(sh, 'r', function (r) { return r < start ? r : r > end ? r - n : null; });
      sh.maxRows -= n;
    }
    function insertColsState(sh, after, n) {
      for (var k in sh.rows) if (hasOwn.call(sh.rows, k)) sh.rows[k] = shiftKeyed(sh.rows[k], function (c) { return c > after ? c + n : c; });
      [sh.fmt, sh.sty, sh.dv, sh.merges].forEach(function (l) { shiftList(l, 'c', insertShift(after, n)); });
      sh.colW = shiftKeyed(sh.colW, function (c) { return c > after ? c + n : c; });
      shiftNotes(sh, 'c', function (c) { return c > after ? c + n : c; });
      sh.maxCols += n;
    }
    function deleteColsState(sh, start, n) {
      var end = start + n - 1;
      for (var k in sh.rows) if (hasOwn.call(sh.rows, k)) {
        sh.rows[k] = shiftKeyed(sh.rows[k], function (c) { return c < start ? c : c > end ? c - n : null; });
        if (isEmptyObj(sh.rows[k])) delete sh.rows[k];
      }
      [sh.fmt, sh.sty, sh.dv, sh.merges].forEach(function (l) { shiftList(l, 'c', deleteShift(start, n)); });
      sh.colW = shiftKeyed(sh.colW, function (c) { return c < start ? c : c > end ? c - n : null; });
      shiftNotes(sh, 'c', function (c) { return c < start ? c : c > end ? c - n : null; });
      sh.maxCols -= n;
    }

    /* ------------------------------------------------------------------ coercion */
    function recordFormula(where, value, kind) {
      S.formulaWrites.push({ sheet: where.sheet, a1: where.a1, value: String(value), kind: kind, execution: exec ? exec.label : null, at: clock.local() });
      if (S.formulaWrites.length > 2000) S.formulaWrites.shift();
    }
    function checkValidation(sh, r, c, cell, where) {
      var rule = rectFind(sh.dv, r, c);
      if (!rule || !rule.rule || rule.rule.allowInvalid !== false) return;
      var v = cell.v, ok = true;
      if (v === '' || v === undefined) return;
      if (rule.rule.type === 'list') ok = rule.rule.values.map(String).indexOf(String(isDateCell(v) ? v : v)) >= 0;
      else if (rule.rule.type === 'checkbox') ok = typeof v === 'boolean';
      if (!ok) throw exc('The data you entered in cell ' + where.a1 + ' violates the data validation rules set on this cell.');
    }
    function isDateCell(v) { return v !== null && typeof v === 'object' && '$d' in v; }
    function coerce(value, nf, where) {
      if (value === null || value === undefined) return { v: '' };
      var t = typeof value;
      if (t === 'number') {
        if (!isFinite(value)) throw exc('[gas-mock] Refusing to write ' + value + ' to ' + where.sheet + '!' + where.a1 + ' (Sheets would show #NUM! — this is a bug in the caller).');
        return { v: value };
      }
      if (t === 'boolean') return { v: value };
      if (isDate(value)) {
        var ms = value.getTime();
        if (isNaN(ms)) throw exc('Invalid argument: value (Invalid Date) at ' + where.a1);
        return { v: { $d: ms }, af: 'datetime' };
      }
      if (t === 'object' || t === 'function' || t === 'symbol') {
        throw exc('[gas-mock] Cannot write a value of type ' + typeName(value) + ' to ' + where.sheet + '!' + where.a1 + ' — stringify objects (JSON.stringify) before writing.');
      }
      var s = String(value);
      if (s.length > 50000) throw exc('Your input contains more than the maximum of 50000 characters in a single cell.');
      var trimmed = s.trim();
      var risky = /^[=+\-@]/.test(trimmed);
      if (s.charAt(0) === "'") {
        if (nf === '@' && QUOTE_MODE === 'keep') return { v: s };  // plain-text cells keep the apostrophe literally
        return { v: s.slice(1), q: 1 };                           // quote prefix: forced text, apostrophe hidden
      }
      if (nf === '@') {
        if (risky && !(trimmed === '-' || trimmed === '+')) recordFormula(where, s, 'unescaped-in-text-cell');
        return { v: s };
      }
      if (trimmed.charAt(0) === '=') { recordFormula(where, s, 'formula'); return { v: '#ERROR!', f: s }; }
      if (RE_BOOL.test(trimmed)) return { v: trimmed.toLowerCase() === 'true' };
      if (RE_NUM.test(trimmed)) return { v: Number(trimmed) };
      if (RE_NUM_THOUSANDS.test(trimmed)) return { v: Number(trimmed.replace(/,/g, '')) };
      if (RE_PCT.test(trimmed)) return { v: Number(trimmed.replace(/\s?%$/, '')) / 100, af: 'percent' };
      if (/^[+\-]/.test(trimmed) && trimmed.length > 1) { recordFormula(where, s, 'formula'); return { v: '#ERROR!', f: '=' + trimmed }; }
      if (trimmed.charAt(0) === '@') { recordFormula(where, s, 'at-sign'); return { v: s }; }
      var m = RE_DATE.exec(trimmed);
      if (m) {
        var y = +m[1], M = +m[2], d = +m[3];
        if (M >= 1 && M <= 12 && d >= 1 && d <= daysInMonth(y, M) && (m[4] === undefined || (+m[4] <= 23 && +m[5] <= 59 && (m[6] === undefined || +m[6] <= 59)))) {
          var ms2 = zonedToUtc(y, M, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), 0, S.ss.tz);
          return { v: { $d: ms2 }, af: m[4] !== undefined ? 'datetime' : 'date' };
        }
        return { v: s };
      }
      var tm = RE_TIME.exec(trimmed);
      if (tm && +tm[2] <= 59 && (tm[3] === undefined || +tm[3] <= 59)) {
        var H = +tm[1];
        if (tm[4]) { if (H < 1 || H > 12) return { v: s }; H = H % 12 + (/p/i.test(tm[4]) ? 12 : 0); }
        var ms3 = zonedToUtc(1899, 12, 30, 0, 0, 0, 0, S.ss.tz) + ((H * 60 + (+tm[2])) * 60 + (+(tm[3] || 0))) * 1000;
        return { v: { $d: ms3 }, af: 'time' };
      }
      return { v: s };
    }
    function writeCell(sh, r, c, value) {
      var where = { sheet: sh.name, a1: a1(r, c) };
      var cell = coerce(value, nfAt(sh, r, c), where);
      checkValidation(sh, r, c, cell, where);
      cellPut(sh, r, c, cell);
    }
    function displayOf(sh, r, c) {
      var cell = cellGet(sh, r, c);
      if (!cell) return '';
      var v = cell.v, nf = nfAt(sh, r, c);
      if (isDateCell(v)) {
        var f = cell.af === 'date' ? 'yyyy-MM-dd' : cell.af === 'time' ? 'H:mm:ss' : 'yyyy-MM-dd H:mm:ss';
        return formatJava(v.$d, S.ss.tz, f);
      }
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      if (typeof v === 'number') {
        if (cell.af === 'percent') return String(Math.round(v * 10000) / 100) + '%';
        if (nf === '0') return String(Math.round(v));
        if (nf && /^0\.(0+)$/.test(nf)) return v.toFixed(nf.length - 2);
        return String(v);
      }
      return String(v);
    }

    /* ------------------------------------------------------------------ Range */
    function Range(sid, r, c, nr, nc) { this._sid = sid; this._r = r; this._c = c; this._nr = nr; this._nc = nc; }
    function makeRange(sh, r, c, nr, nc) {
      r = intArg(r, 'getRange'); c = intArg(c, 'getRange'); nr = intArg(nr, 'getRange'); nc = intArg(nc, 'getRange');
      if (r < 1) throw exc('The starting row of the range is too small.');
      if (c < 1) throw exc('The starting column of the range is too small.');
      if (nr < 1) throw exc('The number of rows in the range must be at least 1.');
      if (nc < 1) throw exc('The number of columns in the range must be at least 1.');
      if (r + nr - 1 > sh.maxRows || c + nc - 1 > sh.maxCols) throw exc('The coordinates of the range are outside the dimensions of the sheet.');
      bump('Sheet.getRange');
      return new Range(sh.id, r, c, nr, nc);
    }
    function parseA1(sh, notation) {
      var s = String(notation).trim().replace(/\$/g, '').toUpperCase();
      var parts = s.split(':');
      if (parts.length > 2 || !s) throw exc('Range not found');
      function ref(x) { var m = /^([A-Z]*)(\d*)$/.exec(x); if (!m || (!m[1] && !m[2])) throw exc('Range not found'); return { c: m[1] ? colToNum(m[1]) : null, r: m[2] ? +m[2] : null }; }
      var a = ref(parts[0]), b = parts.length > 1 ? ref(parts[1]) : a;
      if (parts.length === 1 && (a.c === null || a.r === null)) throw exc('Range not found');
      var r1 = a.r === null ? 1 : a.r, c1 = a.c === null ? 1 : a.c;
      var r2 = b.r === null ? sh.maxRows : b.r, c2 = b.c === null ? sh.maxCols : b.c;
      if (parts.length > 1 && a.r === null && b.r !== null) { r1 = 1; }
      var rr1 = Math.min(r1, r2), rr2 = Math.max(r1, r2), cc1 = Math.min(c1, c2), cc2 = Math.max(c1, c2);
      return makeRange(sh, rr1, cc1, rr2 - rr1 + 1, cc2 - cc1 + 1);
    }
    function styleSetter(key, validate) {
      return function (v) {
        var sh = this._sh(); if (validate) validate(v);
        addRect(sh.sty, { r1: this._r, c1: this._c, r2: this._r + this._nr - 1, c2: this._c + this._nc - 1, k: key, v: v === undefined ? null : v });
        return this;
      };
    }
    function stylesSetter(key) {
      return function (grid) {
        var sh = this._sh();
        checkDims(grid, this._nr, this._nc);
        for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) addRect(sh.sty, { r1: this._r + i, c1: this._c + j, r2: this._r + i, c2: this._c + j, k: key, v: grid[i][j] });
        return this;
      };
    }
    function styleGetter(key, dflt) { return function () { return styleAt(this._sh(), this._r, this._c, key, dflt); }; }
    function stylesGetter(key, dflt) {
      return function () { var sh = this._sh(), out = []; for (var i = 0; i < this._nr; i++) { var row = []; for (var j = 0; j < this._nc; j++) row.push(styleAt(sh, this._r + i, this._c + j, key, dflt)); out.push(row); } return out; };
    }
    function checkDims(values, nr, nc) {
      if (!Array.isArray(values)) throw sigError('SpreadsheetApp.Range.setValues', [values]);
      if (values.length !== nr) throw exc('The number of rows in the data does not match the number of rows in the range. The data has ' + values.length + ' but the range has ' + nr + '.');
      for (var i = 0; i < values.length; i++) {
        if (!Array.isArray(values[i])) throw sigError('SpreadsheetApp.Range.setValues', [values]);
        if (values[i].length !== nc) throw exc('The number of columns in the data does not match the number of columns in the range. The data has ' + values[i].length + ' but the range has ' + nc + '.');
      }
    }
    Range.prototype = {
      constructor: Range,
      toString: function () { return 'Range'; },
      _sh: function () { return sheetById(this._sid, true); },
      getSheet: function () { this._sh(); return new Sheet(this._sid); },
      getRow: function () { return this._r; },
      getRowIndex: function () { return this._r; },
      getColumn: function () { return this._c; },
      getColumnIndex: function () { return this._c; },
      getLastRow: function () { return this._r + this._nr - 1; },
      getLastColumn: function () { return this._c + this._nc - 1; },
      getNumRows: function () { return this._nr; },
      getNumColumns: function () { return this._nc; },
      getHeight: function () { return this._nr; },
      getWidth: function () { return this._nc; },
      getA1Notation: function () {
        var s = a1(this._r, this._c);
        return this._nr === 1 && this._nc === 1 ? s : s + ':' + a1(this._r + this._nr - 1, this._c + this._nc - 1);
      },
      getCell: function (row, col) {
        if (row < 1 || col < 1 || row > this._nr || col > this._nc) throw exc('The coordinates of the range are outside the dimensions of the sheet.');
        return makeRange(this._sh(), this._r + row - 1, this._c + col - 1, 1, 1);
      },
      offset: function (ro, co, nr, nc) {
        return makeRange(this._sh(), this._r + ro, this._c + co, nr === undefined ? this._nr : nr, nc === undefined ? this._nc : nc);
      },
      getValues: function () {
        bump('Range.getValues'); var sh = this._sh(), out = [];
        for (var i = 0; i < this._nr; i++) { var row = new Array(this._nc), src = sh.rows[this._r + i]; for (var j = 0; j < this._nc; j++) row[j] = cellOut(src ? src[this._c + j] : undefined); out.push(row); }
        return out;
      },
      getValue: function () { bump('Range.getValue'); return cellOut(cellGet(this._sh(), this._r, this._c)); },
      getDisplayValues: function () {
        bump('Range.getDisplayValues'); var sh = this._sh(), out = [];
        for (var i = 0; i < this._nr; i++) { var row = []; for (var j = 0; j < this._nc; j++) row.push(displayOf(sh, this._r + i, this._c + j)); out.push(row); }
        return out;
      },
      getDisplayValue: function () { return displayOf(this._sh(), this._r, this._c); },
      setValues: function (values) {
        bump('Range.setValues'); var sh = this._sh();
        checkDims(values, this._nr, this._nc);
        for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) writeCell(sh, this._r + i, this._c + j, values[i][j]);
        return this;
      },
      setValue: function (value) {
        bump('Range.setValue'); var sh = this._sh();
        for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) writeCell(sh, this._r + i, this._c + j, value);
        return this;
      },
      getFormula: function () { var c = cellGet(this._sh(), this._r, this._c); return c && c.f ? c.f : ''; },
      getFormulas: function () { var sh = this._sh(), out = []; for (var i = 0; i < this._nr; i++) { var row = []; for (var j = 0; j < this._nc; j++) { var c = cellGet(sh, this._r + i, this._c + j); row.push(c && c.f ? c.f : ''); } out.push(row); } return out; },
      setFormula: function (f) {
        var sh = this._sh();
        for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) { recordFormula({ sheet: sh.name, a1: a1(this._r + i, this._c + j) }, f, 'setFormula'); cellPut(sh, this._r + i, this._c + j, { v: '#ERROR!', f: String(f) }); }
        return this;
      },
      setFormulas: function (grid) { checkDims(grid, this._nr, this._nc); var sh = this._sh(); for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) { recordFormula({ sheet: sh.name, a1: a1(this._r + i, this._c + j) }, grid[i][j], 'setFormula'); cellPut(sh, this._r + i, this._c + j, { v: '#ERROR!', f: String(grid[i][j]) }); } return this; },
      setRichTextValue: function (rt) { var sh = this._sh(); var text = rt && typeof rt.getText === 'function' ? rt.getText() : String(rt); cellPut(sh, this._r, this._c, { v: text, q: 1 }); return this; },
      getRichTextValue: function () { var v = cellOut(cellGet(this._sh(), this._r, this._c)); return { getText: function () { return String(v); }, getLinkUrl: function () { return null; }, getRuns: function () { return []; } }; },
      setNumberFormat: function (f) {
        bump('Range.setNumberFormat'); var sh = this._sh();
        addRect(sh.fmt, { r1: this._r, c1: this._c, r2: this._r + this._nr - 1, c2: this._c + this._nc - 1, nf: f === null || f === undefined ? null : String(f) });
        return this;
      },
      setNumberFormats: function (grid) {
        checkDims(grid, this._nr, this._nc); var sh = this._sh();
        for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) addRect(sh.fmt, { r1: this._r + i, c1: this._c + j, r2: this._r + i, c2: this._c + j, nf: grid[i][j] });
        return this;
      },
      getNumberFormat: function () { var sh = this._sh(), c = cellGet(sh, this._r, this._c), nf = nfAt(sh, this._r, this._c); if (nf) return nf; if (c && c.af === 'date') return 'yyyy-mm-dd'; if (c && c.af === 'time') return 'h:mm:ss'; if (c && c.af === 'datetime') return 'yyyy-mm-dd h:mm:ss'; return 'General'; },
      getNumberFormats: function () { var out = []; for (var i = 0; i < this._nr; i++) { var row = []; for (var j = 0; j < this._nc; j++) row.push(this.getCell(i + 1, j + 1).getNumberFormat()); out.push(row); } return out; },
      setFontWeight: styleSetter('fontWeight', function (v) { if (v !== null && v !== 'bold' && v !== 'normal') throw exc('Invalid argument: fontWeight'); }),
      setFontWeights: stylesSetter('fontWeight'),
      getFontWeight: styleGetter('fontWeight', 'normal'),
      getFontWeights: stylesGetter('fontWeight', 'normal'),
      setFontStyle: styleSetter('fontStyle'),
      getFontStyle: styleGetter('fontStyle', 'normal'),
      setFontSize: styleSetter('fontSize', function (v) { if (typeof v !== 'number' || v < 1 || v > 400) throw exc('Invalid argument: size'); }),
      setFontSizes: stylesSetter('fontSize'),
      getFontSize: styleGetter('fontSize', 10),
      setFontColor: styleSetter('fontColor'),
      setFontColors: stylesSetter('fontColor'),
      getFontColor: styleGetter('fontColor', '#000000'),
      getFontColorObject: function () { var v = this.getFontColor(); return { asRgbColor: function () { return { asHexString: function () { return v; } }; } }; },
      setFontFamily: styleSetter('fontFamily'),
      setFontFamilies: stylesSetter('fontFamily'),
      getFontFamily: styleGetter('fontFamily', 'Arial'),
      setFontLine: styleSetter('fontLine'),
      setBackground: styleSetter('background'),
      setBackgroundColor: styleSetter('background'),
      setBackgrounds: stylesSetter('background'),
      getBackground: styleGetter('background', '#ffffff'),
      getBackgrounds: stylesGetter('background', '#ffffff'),
      setHorizontalAlignment: styleSetter('hAlign'),
      setHorizontalAlignments: stylesSetter('hAlign'),
      getHorizontalAlignment: styleGetter('hAlign', 'general'),
      setVerticalAlignment: styleSetter('vAlign'),
      setVerticalAlignments: stylesSetter('vAlign'),
      getVerticalAlignment: styleGetter('vAlign', 'bottom'),
      setWrap: styleSetter('wrap'),
      setWraps: stylesSetter('wrap'),
      getWrap: styleGetter('wrap', false),
      setWrapStrategy: styleSetter('wrapStrategy'),
      setWrapStrategies: stylesSetter('wrapStrategy'),
      getWrapStrategy: styleGetter('wrapStrategy', 'OVERFLOW'),
      setTextDirection: styleSetter('textDirection'),
      setTextRotation: styleSetter('textRotation'),
      setTextStyle: styleSetter('textStyle'),
      setShowHyperlink: function () { return this; },
      setBorder: function () { var sh = this._sh(); addRect(sh.sty, { r1: this._r, c1: this._c, r2: this._r + this._nr - 1, c2: this._c + this._nc - 1, k: 'border', v: Array.prototype.slice.call(arguments).map(function (a) { return a === null || typeof a !== 'object' ? a : String(a); }) }); return this; },
      setNote: function (note) { var sh = this._sh(); var k = this._r + ':' + this._c; if (note === null || note === '') delete sh.notes[k]; else sh.notes[k] = String(note); return this; },
      getNote: function () { return this._sh().notes[this._r + ':' + this._c] || ''; },
      setNotes: function (grid) { checkDims(grid, this._nr, this._nc); for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) this.getCell(i + 1, j + 1).setNote(grid[i][j]); return this; },
      clearNote: function () { return this.setNote(null); },
      merge: function () {
        var sh = this._sh();
        for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) if (i || j) cellPut(sh, this._r + i, this._c + j, null);
        sh.merges.push({ r1: this._r, c1: this._c, r2: this._r + this._nr - 1, c2: this._c + this._nc - 1 });
        return this;
      },
      mergeAcross: function () { for (var i = 0; i < this._nr; i++) makeRange(this._sh(), this._r + i, this._c, 1, this._nc).merge(); return this; },
      mergeVertically: function () { for (var j = 0; j < this._nc; j++) makeRange(this._sh(), this._r, this._c + j, this._nr, 1).merge(); return this; },
      breakApart: function () {
        var sh = this._sh(), r1 = this._r, c1 = this._c, r2 = this._r + this._nr - 1, c2 = this._c + this._nc - 1;
        sh.merges = sh.merges.filter(function (m) { return !(m.r1 >= r1 && m.r2 <= r2 && m.c1 >= c1 && m.c2 <= c2); });
        return this;
      },
      isPartOfMerge: function () { var sh = this._sh(), r = this._r, c = this._c; return sh.merges.some(function (m) { return r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2; }); },
      getMergedRanges: function () { var sh = this._sh(), self = this; return sh.merges.filter(function (m) { return !(m.r2 < self._r || m.r1 > self._r + self._nr - 1 || m.c2 < self._c || m.c1 > self._c + self._nc - 1); }).map(function (m) { return new Range(sh.id, m.r1, m.c1, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1); }); },
      clearContent: function () { bump('Range.clearContent'); var sh = this._sh(); for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) cellPut(sh, this._r + i, this._c + j, null); return this; },
      clearFormat: function () {
        var sh = this._sh(), box = { r1: this._r, c1: this._c, r2: this._r + this._nr - 1, c2: this._c + this._nc - 1 };
        addRect(sh.fmt, { r1: box.r1, c1: box.c1, r2: box.r2, c2: box.c2, nf: null });
        sh.sty = sh.sty.filter(function (x) { return !(x.r1 >= box.r1 && x.r2 <= box.r2 && x.c1 >= box.c1 && x.c2 <= box.c2); });
        return this;
      },
      clear: function (o) {
        if (o && (o.contentsOnly || o.formatOnly || o.commentsOnly || o.validationsOnly)) {
          if (o.contentsOnly) this.clearContent();
          if (o.formatOnly) this.clearFormat();
          if (o.validationsOnly) this.clearDataValidations();
          return this;
        }
        this.clearContent(); this.clearFormat(); return this;
      },
      clearDataValidations: function () { return this.setDataValidation(null); },
      setDataValidation: function (rule) {
        var sh = this._sh();
        addRect(sh.dv, { r1: this._r, c1: this._c, r2: this._r + this._nr - 1, c2: this._c + this._nc - 1, rule: rule ? { type: rule.type, values: rule.values, allowInvalid: rule.allowInvalid, helpText: rule.helpText } : null });
        return this;
      },
      setDataValidations: function (grid) { for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) this.getCell(i + 1, j + 1).setDataValidation(grid[i][j]); return this; },
      getDataValidation: function () { var x = rectFind(this._sh().dv, this._r, this._c); return x && x.rule ? x.rule : null; },
      activate: function () { S.ss.activeSheetId = this._sid; return this; },
      sort: function (spec) {
        var sh = this._sh(), values = this.getValues(), self = this;
        var specs = (Array.isArray(spec) ? spec : [spec]).map(function (s) { return typeof s === 'number' ? { column: s, ascending: true } : { column: s.column, ascending: s.ascending !== false }; });
        values.sort(function (a, b) {
          for (var i = 0; i < specs.length; i++) {
            var k = specs[i].column - self._c, x = a[k], y = b[k];
            if (isDate(x)) x = x.getTime(); if (isDate(y)) y = y.getTime();
            if (x === y) continue;
            if (x === '') return 1; if (y === '') return -1;
            var r = x < y ? -1 : 1; return specs[i].ascending ? r : -r;
          }
          return 0;
        });
        for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) { var v = values[i][j]; cellPut(sh, this._r + i, this._c + j, v === '' ? null : (isDate(v) ? { v: { $d: v.getTime() } } : { v: v })); }
        return this;
      },
      createTextFinder: function (text) { return textFinder(this, text); },
      protect: function () { return protectionStub(); },
      applyRowBanding: function () { return chainStub('Banding'); },
      getBandings: function () { return []; },
      insertCheckboxes: function () { this.setDataValidation({ type: 'checkbox', values: [true, false], allowInvalid: false }); for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) if (cellOut(cellGet(this._sh(), this._r + i, this._c + j)) === '') cellPut(this._sh(), this._r + i, this._c + j, { v: false }); return this; },
      isBlank: function () { var sh = this._sh(); for (var i = 0; i < this._nr; i++) for (var j = 0; j < this._nc; j++) if (cellGet(sh, this._r + i, this._c + j)) return false; return true; },
      copyTo: function (dest) {
        var vals = this.getValues(), dsh = dest._sh();
        for (var i = 0; i < vals.length; i++) for (var j = 0; j < vals[i].length; j++) { var v = vals[i][j]; cellPut(dsh, dest._r + i, dest._c + j, v === '' ? null : isDate(v) ? { v: { $d: v.getTime() } } : { v: v }); }
        return this;
      }
    };
    function textFinder(range, text) {
      var o = { matchCase: false, entire: false, regex: false };
      var tf = {
        matchCase: function (b) { o.matchCase = !!b; return tf; },
        matchEntireCell: function (b) { o.entire = !!b; return tf; },
        useRegularExpression: function (b) { o.regex = !!b; return tf; },
        matchFormulaText: function () { return tf; },
        ignoreDiacritics: function () { return tf; },
        findAll: function () {
          var sh = range._sh(), out = [];
          for (var i = 0; i < range._nr; i++) for (var j = 0; j < range._nc; j++) {
            var r = range._r + i, c = range._c + j, d = displayOf(sh, r, c);
            if (d === '') continue;
            var hay = o.matchCase ? d : d.toLowerCase(), needle = o.matchCase ? String(text) : String(text).toLowerCase(), hit;
            if (o.regex) { var re = new RegExp(o.entire ? '^(?:' + text + ')$' : String(text), o.matchCase ? '' : 'i'); hit = re.test(d); }
            else hit = o.entire ? hay === needle : hay.indexOf(needle) >= 0;
            if (hit) out.push(new Range(sh.id, r, c, 1, 1));
          }
          bump('TextFinder.findAll');
          return out;
        },
        findNext: function () { var all = tf.findAll(); return all.length ? all[0] : null; }
      };
      return tf;
    }
    function protectionStub() {
      var p = { setDescription: function () { return p; }, setWarningOnly: function () { return p; }, isWarningOnly: function () { return false; },
        removeEditors: function () { return p; }, removeEditor: function () { return p; }, addEditor: function () { return p; }, addEditors: function () { return p; },
        getEditors: function () { return []; }, canDomainEdit: function () { return false; }, setDomainEdit: function () { return p; }, canEdit: function () { return true; },
        remove: function () {}, setUnprotectedRanges: function () { return p; }, getUnprotectedRanges: function () { return []; }, getDescription: function () { return ''; },
        toString: function () { return 'Protection'; } };
      return p;
    }

    /* ------------------------------------------------------------------ Sheet */
    function Sheet(id) { this._id = id; }
    Sheet.prototype = {
      constructor: Sheet,
      toString: function () { return 'Sheet'; },
      _s: function () { return sheetById(this._id, true); },
      getName: function () { return this._s().name; },
      setName: function (name) {
        name = String(name);
        var sh = this._s();
        if (!name.trim()) throw exc('Invalid argument: name');
        S.ss.sheets.forEach(function (x) { if (x !== sh && x.name.toLowerCase() === name.toLowerCase()) throw exc('A sheet with the name "' + name + '" already exists. Please enter another name.'); });
        sh.name = name; return this;
      },
      getSheetId: function () { return this._id; },
      getIndex: function () { var id = this._id; return S.ss.sheets.findIndex(function (x) { return x.id === id; }) + 1; },
      getParent: function () { return spreadsheetApi; },
      activate: function () { S.ss.activeSheetId = this._id; return this; },
      getRange: function (a, b, c, d) {
        bump('Sheet.getRange.call');
        var sh = this._s();
        if (typeof a === 'string' && b === undefined) return parseA1(sh, a);
        if (arguments.length === 0) throw sigError('SpreadsheetApp.Sheet.getRange', arguments);
        if (arguments.length === 1) throw sigError('SpreadsheetApp.Sheet.getRange', arguments);
        return makeRange(sh, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
      },
      getRangeList: function (list) { var self = this; var ranges = list.map(function (x) { return self.getRange(x); }); return { getRanges: function () { return ranges; }, setNumberFormat: function (f) { ranges.forEach(function (r) { r.setNumberFormat(f); }); return this; }, setFontWeight: function (w) { ranges.forEach(function (r) { r.setFontWeight(w); }); return this; }, setBackground: function (bg) { ranges.forEach(function (r) { r.setBackground(bg); }); return this; } }; },
      getSheetValues: function (r, c, nr, nc) { var sh = this._s(); return makeRange(sh, r, c, nr === -1 ? lastRowOf(sh) - r + 1 : nr, nc === -1 ? lastColOf(sh) - c + 1 : nc).getValues(); },
      getDataRange: function () { var sh = this._s(); bump('Sheet.getDataRange'); return makeRange(sh, 1, 1, Math.max(1, lastRowOf(sh)), Math.max(1, lastColOf(sh))); },
      getLastRow: function () { bump('Sheet.getLastRow'); return lastRowOf(this._s()); },
      getLastColumn: function () { bump('Sheet.getLastColumn'); return lastColOf(this._s()); },
      getMaxRows: function () { return this._s().maxRows; },
      getMaxColumns: function () { return this._s().maxCols; },
      appendRow: function (rowContents) {
        bump('Sheet.appendRow');
        if (!Array.isArray(rowContents)) throw sigError('SpreadsheetApp.Sheet.appendRow', arguments);
        if (rowContents.length === 0) throw exc('Invalid argument: rowContents');
        var sh = this._s(), r = lastRowOf(sh) + 1;
        if (r > sh.maxRows) insertRowsState(sh, sh.maxRows, r - sh.maxRows);
        if (rowContents.length > sh.maxCols) insertColsState(sh, sh.maxCols, rowContents.length - sh.maxCols);
        for (var j = 0; j < rowContents.length; j++) writeCell(sh, r, j + 1, rowContents[j]);
        return this;
      },
      deleteRow: function (r) { return this.deleteRows(r, 1); },
      deleteRows: function (start, n) {
        bump('Sheet.deleteRows');
        var sh = this._s(); intArg(start); intArg(n);
        if (n < 1) throw exc('The number of rows to delete must be at least 1.');
        if (start < 1 || start + n - 1 > sh.maxRows) throw exc('Those rows are out of bounds.');
        if (sh.maxRows - n <= sh.frozenRows) throw exc('Sorry, it is not possible to delete all non-frozen rows.');
        deleteRowsState(sh, start, n); return this;
      },
      insertRowsAfter: function (after, n) {
        var sh = this._s(); intArg(after); intArg(n);
        if (after < 1 || after > sh.maxRows) throw exc('Those rows are out of bounds.');
        if (n < 1) throw exc('The number of rows to insert must be at least 1.');
        insertRowsState(sh, after, n); return this;
      },
      insertRowAfter: function (after) { return this.insertRowsAfter(after, 1); },
      insertRowsBefore: function (before, n) {
        var sh = this._s(); intArg(before); intArg(n);
        if (before < 1 || before > sh.maxRows) throw exc('Those rows are out of bounds.');
        insertRowsState(sh, before - 1, n); return this;
      },
      insertRowBefore: function (before) { return this.insertRowsBefore(before, 1); },
      insertRows: function (rowIndex, n) { return this.insertRowsBefore(rowIndex, n === undefined ? 1 : n); },
      insertColumnsAfter: function (after, n) {
        var sh = this._s(); intArg(after); intArg(n);
        if (after < 1 || after > sh.maxCols) throw exc('Those columns are out of bounds.');
        if (n < 1) throw exc('The number of columns to insert must be at least 1.');
        insertColsState(sh, after, n); return this;
      },
      insertColumnAfter: function (after) { return this.insertColumnsAfter(after, 1); },
      insertColumnsBefore: function (before, n) {
        var sh = this._s(); intArg(before); intArg(n);
        if (before < 1 || before > sh.maxCols) throw exc('Those columns are out of bounds.');
        insertColsState(sh, before - 1, n); return this;
      },
      insertColumnBefore: function (before) { return this.insertColumnsBefore(before, 1); },
      insertColumns: function (idx, n) { return this.insertColumnsBefore(idx, n === undefined ? 1 : n); },
      deleteColumn: function (c) { return this.deleteColumns(c, 1); },
      deleteColumns: function (start, n) {
        var sh = this._s(); intArg(start); intArg(n);
        if (start < 1 || start + n - 1 > sh.maxCols) throw exc('Those columns are out of bounds.');
        if (sh.maxCols - n <= sh.frozenCols) throw exc('Sorry, it is not possible to delete all non-frozen columns.');
        deleteColsState(sh, start, n); return this;
      },
      setFrozenRows: function (n) { var sh = this._s(); intArg(n); if (n < 0 || n >= sh.maxRows) throw exc('Sorry, it is not possible to freeze all rows.'); sh.frozenRows = n; return this; },
      getFrozenRows: function () { return this._s().frozenRows; },
      setFrozenColumns: function (n) { var sh = this._s(); intArg(n); if (n < 0 || n >= sh.maxCols) throw exc('Sorry, it is not possible to freeze all columns.'); sh.frozenCols = n; return this; },
      getFrozenColumns: function () { return this._s().frozenCols; },
      setColumnWidth: function (c, w) { this._s().colW[c] = w; return this; },
      setColumnWidths: function (start, n, w) { for (var i = 0; i < n; i++) this._s().colW[start + i] = w; return this; },
      getColumnWidth: function (c) { var w = this._s().colW[c]; return w === undefined ? 100 : w; },
      setRowHeight: function (r, h) { this._s().rowH[r] = h; return this; },
      setRowHeights: function (start, n, h) { for (var i = 0; i < n; i++) this._s().rowH[start + i] = h; return this; },
      setRowHeightsForced: function (start, n, h) { return this.setRowHeights(start, n, h); },
      getRowHeight: function (r) { var h = this._s().rowH[r]; return h === undefined ? 21 : h; },
      autoResizeColumns: function (start, n) { if (start < 1) throw exc('Those columns are out of bounds.'); return this; },
      autoResizeColumn: function () { return this; },
      autoResizeRows: function () { return this; },
      setRightToLeft: function (b) { this._s().rtl = !!b; return this; },
      isRightToLeft: function () { return this._s().rtl; },
      setHiddenGridlines: function (b) { this._s().hiddenGrid = !!b; return this; },
      hasHiddenGridlines: function () { return this._s().hiddenGrid; },
      setTabColor: function (c) { this._s().tabColor = c; return this; },
      getTabColor: function () { return this._s().tabColor; },
      setTabColorObject: function () { return this; },
      hideSheet: function () {
        var visible = S.ss.sheets.filter(function (x) { return !x.hidden; });
        if (visible.length <= 1 && !this._s().hidden) throw exc("You can't hide all the sheets in a document.");
        this._s().hidden = true; return this;
      },
      showSheet: function () { this._s().hidden = false; return this; },
      isSheetHidden: function () { return this._s().hidden; },
      hideColumns: function (c, n) { for (var i = 0; i < (n || 1); i++) this._s().hiddenCols[c + i] = true; return this; },
      showColumns: function (c, n) { for (var i = 0; i < (n || 1); i++) delete this._s().hiddenCols[c + i]; return this; },
      hideColumn: function (r) { return this.hideColumns(r.getColumn(), r.getNumColumns()); },
      isColumnHiddenByUser: function (c) { return !!this._s().hiddenCols[c]; },
      hideRows: function () { return this; },
      showRows: function () { return this; },
      clear: function (o) {
        var sh = this._s();
        if (o && o.contentsOnly) { sh.rows = {}; return this; }
        if (o && o.formatOnly) { sh.fmt = []; sh.sty = []; return this; }
        sh.rows = {}; sh.fmt = []; sh.sty = []; sh.notes = {}; return this;
      },
      clearContents: function () { this._s().rows = {}; return this; },
      clearFormats: function () { var sh = this._s(); sh.fmt = []; sh.sty = []; return this; },
      clearNotes: function () { this._s().notes = {}; return this; },
      clearConditionalFormatRules: function () { this._s().cf = []; return this; },
      setConditionalFormatRules: function (rules) { this._s().cf = (rules || []).map(String); return this; },
      getConditionalFormatRules: function () { return this._s().cf.map(function () { return chainStub('ConditionalFormatRule').build(); }); },
      createTextFinder: function (text) { var sh = this._s(); return textFinder(new Range(sh.id, 1, 1, Math.max(1, lastRowOf(sh)), Math.max(1, lastColOf(sh))), text); },
      protect: function () { this._s().protections++; return protectionStub(); },
      getProtections: function () { return []; },
      getCharts: function () { return []; },
      getActiveRange: function () { return new Range(this._id, 1, 1, 1, 1); },
      setActiveRange: function (r) { return r; },
      setActiveSelection: function (r) { return typeof r === 'string' ? this.getRange(r) : r; },
      getType: function () { return 'GRID'; },
      copyTo: function () { throw policy('Sheet.copyTo is not mocked'); }
    };

    /* ------------------------------------------------------------------ Spreadsheet */
    function nextDefaultSheetName() {
      for (var i = S.ss.sheets.length + 1; ; i++) {
        var n = 'Sheet' + i;
        if (!S.ss.sheets.some(function (x) { return x.name.toLowerCase() === n.toLowerCase(); })) return n;
      }
    }
    var spreadsheetApi = {
      toString: function () { return 'Spreadsheet'; },
      getId: function () { return S.ss.id; },
      getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + S.ss.id + '/edit'; },
      getName: function () { return S.ss.name; },
      rename: function (n) { S.ss.name = String(n); },
      getOwner: function () { return userObj(S.ss.owner); },
      getEditors: function () { return [userObj(S.ss.owner)]; },
      getSpreadsheetTimeZone: function () { return S.ss.tz; },
      setSpreadsheetTimeZone: function (tz) { S.ss.tz = String(tz); },
      getSpreadsheetLocale: function () { return S.ss.locale; },
      setSpreadsheetLocale: function (l) { S.ss.locale = String(l); },
      getSheetByName: function (name) {
        bump('Spreadsheet.getSheetByName');
        var list = S.ss.sheets;
        for (var i = 0; i < list.length; i++) if (list[i].name === String(name)) return new Sheet(list[i].id);
        return null;
      },
      getSheetById: function (id) { var s = sheetById(id); return s ? new Sheet(s.id) : null; },
      getSheets: function () { bump('Spreadsheet.getSheets'); return S.ss.sheets.map(function (x) { return new Sheet(x.id); }); },
      getNumSheets: function () { return S.ss.sheets.length; },
      insertSheet: function (a, b) {
        bump('Spreadsheet.insertSheet');
        var name = null, index = null;
        if (typeof a === 'string') { name = a; if (typeof b === 'number') index = b; }
        else if (typeof a === 'number') index = a;
        if (name === null) name = nextDefaultSheetName();
        if (!String(name).trim()) throw exc('Invalid argument: sheetName');
        if (String(name).length > 100) throw exc('The sheet name cannot exceed 100 characters.');
        if (S.ss.sheets.some(function (x) { return x.name.toLowerCase() === String(name).toLowerCase(); })) throw exc('A sheet with the name "' + name + '" already exists. Please enter another name.');
        var id = Math.floor(rng.float() * 2000000000) + 1;
        var st = newSheetState(id, String(name));
        if (index === null) {
          var activeIdx = S.ss.sheets.findIndex(function (x) { return x.id === S.ss.activeSheetId; });
          index = activeIdx < 0 ? S.ss.sheets.length : activeIdx + 1;
        }
        if (index < 0 || index > S.ss.sheets.length) throw exc('Invalid argument: sheetIndex');
        S.ss.sheets.splice(index, 0, st);
        S.ss.activeSheetId = id;
        return new Sheet(id);
      },
      deleteSheet: function (sheet) {
        if (!sheet || !(sheet instanceof Sheet)) throw sigError('SpreadsheetApp.Spreadsheet.deleteSheet', arguments);
        if (S.ss.sheets.length <= 1) throw exc("This operation is not allowed. You can't remove all the sheets in a document.");
        var id = sheet._id;
        S.ss.sheets = S.ss.sheets.filter(function (x) { return x.id !== id; });
        if (S.ss.activeSheetId === id) S.ss.activeSheetId = S.ss.sheets[0].id;
      },
      getActiveSheet: function () { var s = sheetById(S.ss.activeSheetId) || S.ss.sheets[0]; return new Sheet(s.id); },
      setActiveSheet: function (sheet) { if (!(sheet instanceof Sheet)) throw sigError('SpreadsheetApp.Spreadsheet.setActiveSheet', arguments); S.ss.activeSheetId = sheet._id; return sheet; },
      moveActiveSheet: function (pos) {
        intArg(pos);
        if (pos < 1 || pos > S.ss.sheets.length) throw exc('Invalid argument: pos');
        var idx = S.ss.sheets.findIndex(function (x) { return x.id === S.ss.activeSheetId; });
        var st = S.ss.sheets.splice(idx, 1)[0];
        S.ss.sheets.splice(pos - 1, 0, st);
      },
      getRange: function (notation) {
        var s = String(notation), i = s.lastIndexOf('!');
        if (i < 0) return this.getActiveSheet().getRange(s);
        var name = s.slice(0, i).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
        var sh = this.getSheetByName(name);
        if (!sh) throw exc('Range not found');
        return sh.getRange(s.slice(i + 1));
      },
      getActiveRange: function () { return this.getActiveSheet().getRange(1, 1); },
      toast: function (msg, title, timeout) { S.ss.toasts.push({ msg: String(msg), title: title === undefined ? null : String(title), timeout: timeout === undefined ? null : timeout, at: clock.local() }); },
      addEditor: function () { return this; },
      setActiveSelection: function (r) { return r; },
      getFormUrl: function () { return null; }
    };
    function userObj(email) { return { getEmail: function () { return email; }, getUsername: function () { return String(email).split('@')[0]; }, toString: function () { return 'User'; } }; }

    /* ------------------------------------------------------------------ Ui */
    var Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' };
    var ButtonSet = { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' };
    function menuBuilder(caption, store) {
      var m = { caption: caption, items: [] };
      var api = {
        addItem: function (cap, fn) { if (typeof fn !== 'string') throw sigError('Ui.Menu.addItem', arguments); m.items.push({ caption: String(cap), fn: fn }); return api; },
        addSeparator: function () { m.items.push({ separator: true }); return api; },
        addSubMenu: function (sub) { m.items.push({ submenu: sub.__menu }); return api; },
        addToUi: function () { store.push(m); },
        __menu: m,
        toString: function () { return 'Menu'; }
      };
      return api;
    }
    var uiApi = {
      Button: Button, ButtonSet: ButtonSet,
      createMenu: function (caption) { return menuBuilder(String(caption), S.ui.menus); },
      createAddonMenu: function () { return menuBuilder('Add-on', S.ui.menus); },
      alert: function (a, b, c) {
        var rec = arguments.length >= 2 && typeof b === 'string' ? { title: a, prompt: b, buttons: c || ButtonSet.OK } : { title: null, prompt: a, buttons: b || ButtonSet.OK };
        S.ui.alerts.push(rec);
        var next = S.ui.alertQueue.length ? S.ui.alertQueue.shift() : (rec.buttons === ButtonSet.YES_NO || rec.buttons === ButtonSet.YES_NO_CANCEL ? Button.YES : Button.OK);
        return next;
      },
      prompt: function (a, b, c) {
        var rec = arguments.length >= 2 && typeof b === 'string' ? { title: a, prompt: b, buttons: c || ButtonSet.OK } : { title: null, prompt: a, buttons: b || ButtonSet.OK };
        S.ui.alerts.push({ prompt: rec.prompt, title: rec.title, buttons: rec.buttons, kind: 'prompt' });
        var resp = S.ui.promptQueue.length ? S.ui.promptQueue.shift() : { text: '', button: Button.CLOSE };
        return { getResponseText: function () { return String(resp.text || ''); }, getSelectedButton: function () { return resp.button || Button.OK; }, toString: function () { return 'PromptResponse'; } };
      },
      showModalDialog: function (out, title) { S.ui.dialogs.push({ kind: 'modal', title: String(title), html: out && out.getContent ? out.getContent() : String(out) }); },
      showModelessDialog: function (out, title) { S.ui.dialogs.push({ kind: 'modeless', title: String(title), html: out && out.getContent ? out.getContent() : String(out) }); },
      showSidebar: function (out) { S.ui.dialogs.push({ kind: 'sidebar', title: out && out.getTitle ? out.getTitle() : '', html: out && out.getContent ? out.getContent() : String(out) }); },
      toString: function () { return 'Ui'; }
    };

    /* ------------------------------------------------------------------ SpreadsheetApp */
    var SpreadsheetApp = {
      toString: function () { return 'SpreadsheetApp'; },
      getActiveSpreadsheet: function () { bump('SpreadsheetApp.getActiveSpreadsheet'); return env.activeSpreadsheetAvailable === false ? null : spreadsheetApi; },
      getActive: function () { return SpreadsheetApp.getActiveSpreadsheet(); },
      getActiveSheet: function () { return spreadsheetApi.getActiveSheet(); },
      getActiveRange: function () { return spreadsheetApi.getActiveRange(); },
      openById: function (id) {
        bump('SpreadsheetApp.openById');
        if (typeof id !== 'string') throw sigError('SpreadsheetApp.openById', arguments);
        if (id === S.ss.id) return spreadsheetApi;
        throw exc('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      },
      openByUrl: function (url) {
        var m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(url));
        if (m && m[1] === S.ss.id) return spreadsheetApi;
        throw exc('Unexpected error while getting the method or property openByUrl on object SpreadsheetApp.');
      },
      flush: function () { bump('SpreadsheetApp.flush'); },
      getUi: function () {
        if (!env.uiContext) throw exc('Cannot call SpreadsheetApp.getUi() from this context.');
        return uiApi;
      },
      newDataValidation: function () {
        var rule = { type: null, values: null, allowInvalid: true, helpText: '' };
        var b = {
          requireValueInList: function (values, showDropdown) { rule.type = 'list'; rule.values = values.slice(); rule.dropdown = showDropdown !== false; return b; },
          requireCheckbox: function () { rule.type = 'checkbox'; rule.values = [true, false]; return b; },
          requireNumberBetween: function (a, z) { rule.type = 'between'; rule.values = [a, z]; return b; },
          requireNumberGreaterThanOrEqualTo: function (a) { rule.type = 'gte'; rule.values = [a]; return b; },
          requireTextLengthLessThanOrEqualTo: function (a) { rule.type = 'len'; rule.values = [a]; return b; },
          requireDate: function () { rule.type = 'date'; return b; },
          setAllowInvalid: function (v) { rule.allowInvalid = !!v; return b; },
          setHelpText: function (t) { rule.helpText = String(t); return b; },
          build: function () { var r = clone(rule); r.copy = function () { return SpreadsheetApp.newDataValidation(); }; r.getCriteriaType = function () { return r.type; }; r.getCriteriaValues = function () { return r.values; }; return r; }
        };
        return b;
      },
      newConditionalFormatRule: function () { return chainStub('ConditionalFormatRuleBuilder'); },
      newTextStyle: function () { return chainStub('TextStyleBuilder'); },
      newRichTextValue: function () {
        var text = '';
        var b = { setText: function (t) { text = String(t); return b; }, setLinkUrl: function () { return b; }, setTextStyle: function () { return b; },
          build: function () { return { getText: function () { return text; }, toString: function () { return 'RichTextValue'; } }; } };
        return b;
      },
      WrapStrategy: { WRAP: 'WRAP', OVERFLOW: 'OVERFLOW', CLIP: 'CLIP' },
      BorderStyle: { SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM', SOLID_THICK: 'SOLID_THICK', DOTTED: 'DOTTED', DASHED: 'DASHED', DOUBLE: 'DOUBLE' },
      Dimension: { ROWS: 'ROWS', COLUMNS: 'COLUMNS' },
      TextDirection: { LEFT_TO_RIGHT: 'LEFT_TO_RIGHT', RIGHT_TO_LEFT: 'RIGHT_TO_LEFT' },
      ProtectionType: { RANGE: 'RANGE', SHEET: 'SHEET' },
      BandingTheme: new Proxy({}, { get: function (t, k) { return typeof k === 'string' ? k : undefined; } }),
      DataValidationCriteria: new Proxy({}, { get: function (t, k) { return typeof k === 'string' ? k : undefined; } }),
      SheetType: { GRID: 'GRID', OBJECT: 'OBJECT' }
    };

    /* ------------------------------------------------------------------ Properties */
    var PROP_VALUE_LIMIT = 9 * 1024, PROP_TOTAL_LIMIT = 500 * 1024;
    function propsStore(kind) {
      function store() { return S.props[kind]; }
      function total(st) { var n = 0; for (var k in st) if (hasOwn.call(st, k)) n += utf8Length(k) + utf8Length(st[k]); return n; }
      function setOne(st, key, value) {
        if (key === null || key === undefined || String(key) === '') throw exc('Invalid argument: key');
        var v = String(value);
        if (utf8Length(v) > PROP_VALUE_LIMIT) throw exc('Argument too large: value');
        st[String(key)] = v;
      }
      var api = {
        toString: function () { return 'Properties'; },
        getProperty: function (key) { bump('Properties.getProperty'); var st = store(); var k = String(key); return hasOwn.call(st, k) ? st[k] : null; },
        setProperty: function (key, value) {
          bump('Properties.setProperty');
          if (arguments.length < 2) throw sigError('PropertiesService.Properties.setProperty', arguments);
          var st = store(), before = hasOwn.call(st, String(key)) ? st[String(key)] : undefined;
          setOne(st, key, value);
          if (total(st) > PROP_TOTAL_LIMIT) { if (before === undefined) delete st[String(key)]; else st[String(key)] = before; throw exc('You have exceeded the property storage quota. Please remove some properties and try again.'); }
          return api;
        },
        setProperties: function (obj, deleteAllOthers) {
          bump('Properties.setProperties');
          var st = store(), backup = clone(st);
          if (deleteAllOthers) { for (var k0 in st) if (hasOwn.call(st, k0)) delete st[k0]; }
          try { for (var k in obj) if (hasOwn.call(obj, k)) setOne(st, k, obj[k]); }
          catch (e) { S.props[kind] = backup; throw e; }
          if (total(st) > PROP_TOTAL_LIMIT) { S.props[kind] = backup; throw exc('You have exceeded the property storage quota. Please remove some properties and try again.'); }
          return api;
        },
        getProperties: function () { bump('Properties.getProperties'); return clone(store()); },
        getKeys: function () { return Object.keys(store()); },
        deleteProperty: function (key) { bump('Properties.deleteProperty'); delete store()[String(key)]; return api; },
        deleteAllProperties: function () { bump('Properties.deleteAllProperties'); S.props[kind] = {}; return api; }
      };
      return api;
    }
    var PropertiesService = {
      toString: function () { return 'PropertiesService'; },
      getScriptProperties: function () { return propsStore('script'); },
      getUserProperties: function () { return propsStore('user'); },
      getDocumentProperties: function () { return propsStore('document'); }
    };

    /* ------------------------------------------------------------------ Cache */
    var CACHE_MAX_TTL = 21600, CACHE_VALUE_LIMIT = 100 * 1024;
    function cacheStore(kind) {
      function st() { return S.cache[kind]; }
      function live(k) { var e = st()[k]; if (!e) return null; if (clock.now() >= e.exp) { delete st()[k]; return null; } return e; }
      function checkKey(k) { if (k === null || k === undefined) throw exc('Invalid argument: key'); k = String(k); if (k.length > 250) throw exc('Argument too large: key'); return k; }
      function ttlOf(t) {
        if (t === undefined) return 600;
        if (typeof t !== 'number' || !isFinite(t)) throw sigError('CacheService.Cache.put', [t]);
        if (t < 1) throw exc('Invalid argument: expirationInSeconds');
        if (t > CACHE_MAX_TTL) throw exc('Argument too large: expirationInSeconds (max 21600 = 6 hours)');
        return Math.floor(t);
      }
      var api = {
        toString: function () { return 'Cache'; },
        get: function (k) { bump('Cache.get'); var e = live(checkKey(k)); return e ? e.v : null; },
        getAll: function (keys) { bump('Cache.getAll'); var out = {}; (keys || []).forEach(function (k) { var e = live(checkKey(k)); if (e) out[String(k)] = e.v; }); return out; },
        put: function (k, v, ttl) {
          bump('Cache.put');
          if (arguments.length < 2) throw sigError('CacheService.Cache.put', arguments);
          k = checkKey(k); var s = String(v); var t = ttlOf(ttl);
          if (utf8Length(s) > CACHE_VALUE_LIMIT) throw exc('Argument too large: value');
          st()[k] = { v: s, exp: clock.now() + t * 1000 };
        },
        putAll: function (obj, ttl) { bump('Cache.putAll'); var t = ttlOf(ttl); for (var k in obj) if (hasOwn.call(obj, k)) { var s = String(obj[k]); if (utf8Length(s) > CACHE_VALUE_LIMIT) throw exc('Argument too large: value'); st()[checkKey(k)] = { v: s, exp: clock.now() + t * 1000 }; } },
        remove: function (k) { bump('Cache.remove'); delete st()[checkKey(k)]; },
        removeAll: function (keys) { (keys || []).forEach(function (k) { delete st()[checkKey(k)]; }); }
      };
      return api;
    }
    var CacheService = {
      toString: function () { return 'CacheService'; },
      getScriptCache: function () { return cacheStore('script'); },
      getUserCache: function () { return cacheStore('user'); },
      getDocumentCache: function () { return cacheStore('document'); }
    };

    /* ------------------------------------------------------------------ Lock */
    var lockStats = { acquired: 0, released: 0, nested: 0, timeouts: 0, contention: 0 };
    function makeLock(kind) {
      var mine = false;
      var api = {
        toString: function () { return 'Lock'; },
        tryLock: function (ms) {
          if (typeof ms !== 'number') throw sigError('LockService.Lock.tryLock', arguments);
          if (lockStats.contention > 0) { lockStats.contention--; lockStats.timeouts++; return false; }
          if (!mine) { if (exec && exec.locks > 0) lockStats.nested++; mine = true; lockStats.acquired++; if (exec) exec.locks++; }
          return true;
        },
        waitLock: function (ms) {
          if (typeof ms !== 'number') throw sigError('LockService.Lock.waitLock', arguments);
          if (!api.tryLock(ms)) throw exc('Lock timeout: another process was holding the lock for too long.');
        },
        releaseLock: function () { if (mine) { mine = false; lockStats.released++; if (exec) exec.locks = Math.max(0, exec.locks - 1); } },
        hasLock: function () { return mine; }
      };
      return api;
    }
    var LockService = {
      toString: function () { return 'LockService'; },
      getScriptLock: function () { return makeLock('script'); },
      getUserLock: function () { return makeLock('user'); },
      getDocumentLock: function () { return makeLock('document'); }
    };

    /* ------------------------------------------------------------------ Mail */
    var RE_EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
    function splitAddrs(s) { return s ? String(s).split(',').map(function (x) { return x.trim(); }).filter(Boolean) : []; }
    function quotaToday() { var day = formatJava(clock.now(), 'America/Los_Angeles', 'yyyy-MM-dd'); if (S.mailQuota.day !== day) { S.mailQuota.day = day; S.mailQuota.used = 0; } return S.mailQuota; }
    var MailApp = {
      toString: function () { return 'MailApp'; },
      sendEmail: function (a, b, c, d) {
        requireAuth('MailApp.sendEmail');
        bump('MailApp.sendEmail');
        var m;
        if (a && typeof a === 'object') m = { to: a.to, cc: a.cc, bcc: a.bcc, replyTo: a.replyTo, subject: a.subject, body: a.body, htmlBody: a.htmlBody, name: a.name, noReply: a.noReply, attachments: a.attachments };
        else if (typeof d === 'string') m = { to: a, replyTo: b, subject: c, body: d };
        else { m = { to: a, subject: b, body: c }; if (d && typeof d === 'object') { m.htmlBody = d.htmlBody; m.name = d.name; m.cc = d.cc; m.bcc = d.bcc; m.replyTo = d.replyTo; m.noReply = d.noReply; m.attachments = d.attachments; } }
        var rcpts = splitAddrs(m.to).concat(splitAddrs(m.cc), splitAddrs(m.bcc));
        if (!rcpts.length) throw exc('Failed to send email: no recipient');
        rcpts.forEach(function (r) { if (!RE_EMAIL.test(r)) throw exc('Invalid email: ' + r); });
        if (m.subject === undefined || m.subject === null) throw exc('Invalid argument: subject');
        if (String(m.subject).length > 250) throw exc('Argument too large: subject');
        if (m.body === undefined && m.htmlBody === undefined) throw exc('Invalid argument: body');
        var q = quotaToday();
        if (q.used + rcpts.length > MAIL_QUOTA) throw exc('Service invoked too many times for one day: email.');
        q.used += rcpts.length;
        var rec = { id: ++S.seq, at: new RealDate(clock.now()).toISOString(), atLocal: clock.local(), from: S.config.ownerEmail,
          to: String(m.to), cc: m.cc ? String(m.cc) : '', bcc: m.bcc ? String(m.bcc) : '', replyTo: m.replyTo ? String(m.replyTo) : '',
          subject: String(m.subject), body: m.body === undefined || m.body === null ? '' : String(m.body),
          htmlBody: m.htmlBody === undefined || m.htmlBody === null ? null : String(m.htmlBody), name: m.name ? String(m.name) : null,
          noReply: !!m.noReply, attachments: (m.attachments || []).length };
        S.mail.push(rec);
      },
      getRemainingDailyQuota: function () { return MAIL_QUOTA - quotaToday().used; }
    };

    /* ------------------------------------------------------------------ Session */
    var Session = {
      toString: function () { return 'Session'; },
      getEffectiveUser: function () { return userObj(env.authMode === 'LIMITED' || env.authMode === 'NONE' ? '' : S.config.ownerEmail); },
      getActiveUser: function () { return userObj(S.config.activeUserEmail || ''); },
      getScriptTimeZone: function () { return S.config.scriptTimeZone; },
      getActiveUserLocale: function () { return 'ar'; },
      getTemporaryActiveUserKey: function () { return 'tmp-' + sha256Hex(S.config.scriptId + ':' + (S.config.activeUserEmail || 'anon')).slice(0, 24); }
    };

    /* ------------------------------------------------------------------ ScriptApp */
    var EventType = { CLOCK: 'CLOCK', ON_OPEN: 'ON_OPEN', ON_EDIT: 'ON_EDIT', ON_FORM_SUBMIT: 'ON_FORM_SUBMIT', ON_CHANGE: 'ON_CHANGE', ON_EVENT_UPDATED: 'ON_EVENT_UPDATED' };
    var TriggerSource = { SPREADSHEETS: 'SPREADSHEETS', CLOCK: 'CLOCK', FORMS: 'FORMS', DOCUMENTS: 'DOCUMENTS', CALENDAR: 'CALENDAR' };
    var WeekDay = { SUNDAY: 'SUNDAY', MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY' };
    function triggerObj(t) {
      return {
        toString: function () { return 'Trigger'; },
        getUniqueId: function () { return t.id; },
        getHandlerFunction: function () { return t.handler; },
        getEventType: function () { return t.eventType; },
        getTriggerSource: function () { return t.source; },
        getTriggerSourceId: function () { return t.sourceId || null; },
        __id: t.id
      };
    }
    function addTrigger(t) {
      requireAuth('ScriptApp.newTrigger');
      if (S.triggers.length >= 20) throw exc('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
      t.id = String(Math.floor(rng.float() * 9e15) + 1e15);
      t.createdAt = clock.local();
      S.triggers.push(t);
      return triggerObj(t);
    }
    function clockBuilder(handler) {
      var t = { handler: handler, eventType: EventType.CLOCK, source: TriggerSource.CLOCK, kind: 'CLOCK' };
      var b = {
        toString: function () { return 'ClockTriggerBuilder'; },
        after: function (ms) { t.afterMs = intArg(ms); return b; },
        at: function (d) { if (!isDate(d)) throw sigError('ScriptApp.ClockTriggerBuilder.at', arguments); t.at = d.getTime(); return b; },
        atDate: function (y, m, d) { t.atDate = [y, m, d]; return b; },
        atHour: function (h) { intArg(h); if (h < 0 || h > 23) throw exc('Invalid argument: hour (0-23)'); t.atHour = h; return b; },
        nearMinute: function (m) { intArg(m); if (m < 0 || m > 59) throw exc('Invalid argument: minute (0-59)'); t.nearMinute = m; return b; },
        everyDays: function (n) { intArg(n); if (n < 1) throw exc('Invalid argument: n'); t.everyDays = n; return b; },
        everyHours: function (n) { intArg(n); if ([1, 2, 4, 6, 8, 12].indexOf(n) < 0) throw exc('The value for everyHours must be one of 1, 2, 4, 6, 8 or 12.'); t.everyHours = n; return b; },
        everyMinutes: function (n) { intArg(n); if ([1, 5, 10, 15, 30].indexOf(n) < 0) throw exc('The value for everyMinutes must be one of 1, 5, 10, 15 or 30.'); t.everyMinutes = n; return b; },
        everyWeeks: function (n) { intArg(n); t.everyWeeks = n; return b; },
        onWeekDay: function (d) { t.onWeekDay = d; return b; },
        onMonthDay: function (d) { t.onMonthDay = d; return b; },
        inTimezone: function (tz) { if (!isValidTimeZone(tz)) throw exc('Invalid argument: timezone'); t.timezone = String(tz); return b; },
        create: function () {
          var sched = t.everyDays || t.everyHours || t.everyMinutes || t.everyWeeks || t.at !== undefined || t.afterMs !== undefined || t.atDate || t.onMonthDay;
          if (!sched) throw exc('Trigger schedule is missing (call everyDays/everyHours/everyMinutes/at/after before create()).');
          if ((t.atHour !== undefined || t.nearMinute !== undefined) && !(t.everyDays || t.everyWeeks)) throw exc('atHour()/nearMinute() can only be used with everyDays() or everyWeeks().');
          if (!t.timezone) t.timezone = S.config.scriptTimeZone;
          return addTrigger(t);
        }
      };
      return b;
    }
    var ScriptApp = {
      toString: function () { return 'ScriptApp'; },
      AuthMode: { NONE: 'NONE', CUSTOM_FUNCTION: 'CUSTOM_FUNCTION', LIMITED: 'LIMITED', FULL: 'FULL' },
      AuthorizationStatus: { REQUIRED: 'REQUIRED', NOT_REQUIRED: 'NOT_REQUIRED' },
      EventType: EventType, TriggerSource: TriggerSource, WeekDay: WeekDay,
      getService: function () {
        return { getUrl: function () { return S.config.scriptUrl || null; }, isEnabled: function () { return !!S.config.scriptUrl; }, toString: function () { return 'Service'; } };
      },
      getScriptId: function () { return S.config.scriptId; },
      getOAuthToken: function () { requireAuth('ScriptApp.getOAuthToken'); return 'ya29.mock-token'; },
      newTrigger: function (fn) {
        if (typeof fn !== 'string' || !fn) throw sigError('ScriptApp.newTrigger', arguments);
        if (/_$/.test(fn)) warn('Trigger handler "' + fn + '" ends with "_" (private functions cannot be trigger handlers in Apps Script).');
        return {
          timeBased: function () { return clockBuilder(fn); },
          forSpreadsheet: function (ss) {
            var t = { handler: fn, source: TriggerSource.SPREADSHEETS, sourceId: ss && ss.getId ? ss.getId() : String(ss), kind: 'SPREADSHEET' };
            function ev(type) { return function () { t.eventType = type; return { create: function () { return addTrigger(t); } }; }; }
            return { onOpen: ev(EventType.ON_OPEN), onEdit: ev(EventType.ON_EDIT), onChange: ev(EventType.ON_CHANGE), onFormSubmit: ev(EventType.ON_FORM_SUBMIT) };
          },
          toString: function () { return 'TriggerBuilder'; }
        };
      },
      getProjectTriggers: function () { requireAuth('ScriptApp.getProjectTriggers'); bump('ScriptApp.getProjectTriggers'); return S.triggers.map(triggerObj); },
      getUserTriggers: function () { requireAuth('ScriptApp.getUserTriggers'); return S.triggers.map(triggerObj); },
      deleteTrigger: function (trig) {
        requireAuth('ScriptApp.deleteTrigger');
        if (!trig || !trig.__id) throw sigError('ScriptApp.deleteTrigger', arguments);
        var before = S.triggers.length;
        S.triggers = S.triggers.filter(function (t) { return t.id !== trig.__id; });
        if (S.triggers.length === before) throw exc('No trigger with the given ID could be found.');
      },
      invalidateAuth: function () {},
      requireScopes: function () {},
      getInstallationSource: function () { return 'NONE'; }
    };

    /* ------------------------------------------------------------------ Blob */
    function Blob(bytes, contentType, name) { this._b = bytes; this._t = contentType || null; this._n = name || null; }
    Blob.prototype = {
      constructor: Blob,
      toString: function () { return 'Blob'; },
      getBytes: function () { return toSignedBytes(this._b); },
      setBytes: function (data) { this._b = toUnsignedBytes(data); return this; },
      getDataAsString: function (charset) { return charset === 'US_ASCII' ? this._b.map(function (b) { return String.fromCharCode(b & 127); }).join('') : utf8Decode(this._b); },
      setDataFromString: function (s) { this._b = utf8Encode(s); return this; },
      getContentType: function () { return this._t; },
      setContentType: function (t) { this._t = t === null ? null : String(t); return this; },
      setContentTypeFromExtension: function () { var ext = String(this._n || '').split('.').pop().toLowerCase(); var map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', csv: 'text/csv', json: 'application/json' }; if (!map[ext]) throw exc('Unsupported extension: ' + ext); this._t = map[ext]; return this; },
      getName: function () { return this._n; },
      setName: function (n) { this._n = n === null ? null : String(n); return this; },
      copyBlob: function () { return new Blob(this._b.slice(), this._t, this._n); },
      getAs: function (t) { if (String(t) === this._t) return this.copyBlob(); throw exc('Converting from ' + this._t + ' to ' + t + ' is not supported.'); },
      getBlob: function () { return this; },
      isGoogleType: function () { return false; }
    };
    function newBlob(data, contentType, name) {
      bump('Utilities.newBlob');
      var bytes;
      if (data === undefined || data === null) bytes = [];
      else if (typeof data === 'string') bytes = utf8Encode(data);
      else if (typeof data.length === 'number') {
        bytes = new Array(data.length);
        for (var i = 0; i < data.length; i++) {
          var b = data[i];
          if (typeof b !== 'number' || b < -128 || b > 255 || Math.floor(b) !== b) throw sigError('Utilities.newBlob', [data, contentType, name]);
          bytes[i] = b & 255;
        }
      } else throw sigError('Utilities.newBlob', arguments);
      return new Blob(bytes, contentType === undefined ? null : contentType, name === undefined ? null : name);
    }

    /* ------------------------------------------------------------------ Drive */
    function ownerOk(item) { return item && item.owner === S.config.ownerEmail; }
    function driveNotFound() { return exc('No item with the given ID could be found. Or perhaps you do not have permission to access it.'); }
    function iterator(list, label) {
      var i = 0;
      return {
        hasNext: function () { return i < list.length; },
        next: function () { if (i >= list.length) throw exc('Cannot retrieve the next object: iterator has reached the end.'); return list[i++]; },
        getContinuationToken: function () { return null; },
        toString: function () { return label; }
      };
    }
    function createFileIn(folderId, a, b, c) {
      requireAuth('DriveApp.createFile');
      bump('Drive.createFile');
      var blob;
      if (a instanceof Blob) blob = a;
      else if (a && typeof a.getBlob === 'function' && typeof a !== 'string') blob = a.getBlob();
      else if (typeof a === 'string' && b !== undefined) blob = newBlob(String(b), c || 'text/plain', a);
      else throw sigError('DriveApp.Folder.createFile', arguments);
      var id = driveId(33);
      var now = clock.now();
      S.drive.files[id] = { id: id, name: blob.getName() || 'Untitled', mimeType: blob.getContentType() || 'application/octet-stream',
        data: base64Encode(blob._b), size: blob._b.length, description: null, trashed: false, parents: [folderId], owner: S.config.ownerEmail,
        created: now, updated: now, sharing: 'PRIVATE' };
      return fileObj(id);
    }
    function fileObj(id) {
      function f() { var x = S.drive.files[id]; if (!x) throw driveNotFound(); return x; }
      var api = {
        toString: function () { return f().name; },
        getId: function () { return id; },
        getName: function () { return f().name; },
        setName: function (n) { f().name = String(n); f().updated = clock.now(); return api; },
        getSize: function () { return f().size; },
        getMimeType: function () { return f().mimeType; },
        getUrl: function () { return 'https://drive.google.com/file/d/' + id + '/view?usp=drivesdk'; },
        getDownloadUrl: function () { return 'https://drive.google.com/uc?id=' + id + '&export=download'; },
        getBlob: function () { bump('Drive.getBlob'); var x = f(); return new Blob(base64Decode(x.data), x.mimeType, x.name); },
        getAs: function (t) { return api.getBlob().getAs(t); },
        setTrashed: function (b) { requireAuth('DriveApp.File.setTrashed'); f().trashed = !!b; f().updated = clock.now(); return api; },
        isTrashed: function () { return !!f().trashed; },
        setDescription: function (d) { f().description = d === null ? null : String(d); return api; },
        getDescription: function () { return f().description; },
        getParents: function () { return iterator(f().parents.filter(function (p) { return S.drive.folders[p]; }).map(folderObj), 'FolderIterator'); },
        getDateCreated: function () { return newDate(f().created); },
        getLastUpdated: function () { return newDate(f().updated); },
        setSharing: function (access, perm) { f().sharing = String(access) + ':' + String(perm); return api; },
        getSharingAccess: function () { return String(f().sharing).split(':')[0]; },
        getSharingPermission: function () { return String(f().sharing).split(':')[1] || 'NONE'; },
        getOwner: function () { return userObj(f().owner); },
        getThumbnail: function () { return null; },
        moveTo: function (folder) { f().parents = [folder.getId()]; return api; },
        makeCopy: function () { throw policy('File.makeCopy is not used by this app'); },
        setContent: function (s) { var x = f(); var b = utf8Encode(String(s)); x.data = base64Encode(b); x.size = b.length; return api; }
      };
      return api;
    }
    function folderObj(id) {
      function fo() { var x = S.drive.folders[id]; if (!x) throw driveNotFound(); return x; }
      var api = {
        toString: function () { return fo().name; },
        getId: function () { return id; },
        getName: function () { return fo().name; },
        setName: function (n) { fo().name = String(n); return api; },
        getUrl: function () { return 'https://drive.google.com/drive/folders/' + id; },
        createFile: function (a, b, c) { fo(); return createFileIn(id, a, b, c); },
        createFolder: function (name) { fo(); return makeFolder(name, id); },
        isTrashed: function () { return !!fo().trashed; },
        setTrashed: function (b) { requireAuth('DriveApp.Folder.setTrashed'); fo().trashed = !!b; return api; },
        setDescription: function (d) { fo().description = String(d); return api; },
        getDescription: function () { return fo().description || null; },
        getFiles: function () {
          bump('Drive.Folder.getFiles');
          return iterator(Object.keys(S.drive.files).map(function (k) { return S.drive.files[k]; }).filter(function (x) { return x.parents.indexOf(id) >= 0 && !x.trashed && ownerOk(x); }).map(function (x) { return fileObj(x.id); }), 'FileIterator');
        },
        getFilesByName: function (name) {
          return iterator(Object.keys(S.drive.files).map(function (k) { return S.drive.files[k]; }).filter(function (x) { return x.parents.indexOf(id) >= 0 && !x.trashed && x.name === String(name) && ownerOk(x); }).map(function (x) { return fileObj(x.id); }), 'FileIterator');
        },
        getFolders: function () { return iterator(Object.keys(S.drive.folders).map(function (k) { return S.drive.folders[k]; }).filter(function (x) { return x.parents.indexOf(id) >= 0 && !x.trashed && ownerOk(x); }).map(function (x) { return folderObj(x.id); }), 'FolderIterator'); },
        getParents: function () { return iterator([], 'FolderIterator'); },
        getDateCreated: function () { return newDate(fo().created); },
        setSharing: function (access, perm) { fo().sharing = String(access) + ':' + String(perm); return api; },
        addFile: function (file) { var x = S.drive.files[file.getId()]; if (x && x.parents.indexOf(id) < 0) x.parents.push(id); return api; },
        removeFile: function (file) { var x = S.drive.files[file.getId()]; if (x) x.parents = x.parents.filter(function (p) { return p !== id; }); return api; },
        getOwner: function () { return userObj(fo().owner); }
      };
      return api;
    }
    function makeFolder(name, parent) {
      requireAuth('DriveApp.createFolder');
      bump('Drive.createFolder');
      if (name === undefined || name === null) throw sigError('DriveApp.createFolder', [name]);
      var id = driveId(33);
      S.drive.folders[id] = { id: id, name: String(name), trashed: false, parents: [parent || S.drive.rootId], owner: S.config.ownerEmail, created: clock.now(), description: null, sharing: 'PRIVATE' };
      return folderObj(id);
    }
    function forbiddenDrive(name) { return function () { throw policy('DriveApp.' + name + ' lists or searches the user\'s Drive — not allowed (spec §2.16: drive.file scope, app-created photos only).'); }; }
    var DriveApp = {
      toString: function () { return 'DriveApp'; },
      Access: { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', PRIVATE: 'PRIVATE' },
      Permission: { VIEW: 'VIEW', EDIT: 'EDIT', COMMENT: 'COMMENT', OWNER: 'OWNER', ORGANIZER: 'ORGANIZER', NONE: 'NONE' },
      createFolder: function (name) { return makeFolder(name, S.drive.rootId); },
      createFile: function (a, b, c) { return createFileIn(S.drive.rootId, a, b, c); },
      getFolderById: function (id) {
        requireAuth('DriveApp.getFolderById');
        bump('Drive.getFolderById');
        if (typeof id !== 'string') throw sigError('DriveApp.getFolderById', arguments);
        if (id === '') throw exc('Invalid argument: id');
        var x = S.drive.folders[id];
        if (!x || !ownerOk(x)) throw driveNotFound();
        return folderObj(id);
      },
      getFileById: function (id) {
        requireAuth('DriveApp.getFileById');
        bump('Drive.getFileById');
        if (typeof id !== 'string') throw sigError('DriveApp.getFileById', arguments);
        if (id === '') throw exc('Invalid argument: id');
        var x = S.drive.files[id];
        if (!x || !ownerOk(x)) throw driveNotFound();   // trashed files ARE returned (check isTrashed())
        return fileObj(id);
      },
      getRootFolder: function () {
        requireAuth('DriveApp.getRootFolder');
        if (!S.drive.folders[S.drive.rootId]) S.drive.folders[S.drive.rootId] = { id: S.drive.rootId, name: 'My Drive', trashed: false, parents: [], owner: S.config.ownerEmail, created: 0 };
        return folderObj(S.drive.rootId);
      },
      getFiles: forbiddenDrive('getFiles'), searchFiles: forbiddenDrive('searchFiles'), getFilesByName: forbiddenDrive('getFilesByName'),
      getFilesByType: forbiddenDrive('getFilesByType'), getFolders: forbiddenDrive('getFolders'), searchFolders: forbiddenDrive('searchFolders'),
      getFoldersByName: forbiddenDrive('getFoldersByName'), getTrashedFiles: forbiddenDrive('getTrashedFiles'), getTrashedFolders: forbiddenDrive('getTrashedFolders'),
      getStorageUsed: function () { return 0; }
    };

    /* ------------------------------------------------------------------ HtmlService */
    var META_ALLOWED = ['apple-mobile-web-app-capable', 'google-site-verification', 'mobile-web-app-capable', 'viewport'];
    var XFrameOptionsMode = { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' };
    var SandboxMode = { EMULATED: 'EMULATED', IFRAME: 'IFRAME', NATIVE: 'NATIVE' };
    function readFile(name) {
      var n = String(name);
      var content = null;
      if (typeof filesResolver === 'function') { content = filesResolver(n); if (content === null || content === undefined) content = filesResolver(n + '.html'); }
      else if (filesResolver) {
        if (hasOwn.call(filesResolver, n)) content = filesResolver[n];
        else if (hasOwn.call(filesResolver, n + '.html')) content = filesResolver[n + '.html'];
      }
      if (content === null || content === undefined) throw exc('No HTML file named ' + n + ' was found.');
      return String(content);
    }
    function HtmlOutput(content) {
      this._content = content === undefined || content === null ? '' : String(content);
      this._title = ''; this._metas = []; this._xfo = XFrameOptionsMode.DEFAULT; this._sandbox = SandboxMode.IFRAME;
      this._w = 600; this._h = 400; this._favicon = null;
      Object.defineProperty(this, '__isHtmlOutput', { value: true });
    }
    HtmlOutput.prototype = {
      constructor: HtmlOutput,
      toString: function () { return 'HtmlOutput'; },
      append: function (s) { this._content += String(s); return this; },
      appendUntrusted: function (s) { this._content += escHtml(s); return this; },
      clear: function () { this._content = ''; return this; },
      getContent: function () { return this._content; },
      setContent: function (s) { this._content = String(s); return this; },
      getTitle: function () { return this._title; },
      setTitle: function (t) { if (typeof t !== 'string') throw sigError('HtmlService.HtmlOutput.setTitle', arguments); this._title = t; return this; },
      addMetaTag: function (name, content) {
        if (META_ALLOWED.indexOf(String(name)) < 0) throw exc('Invalid argument: name. Only these meta tags may be added: ' + META_ALLOWED.join(', ') + ' (got "' + name + '").');
        this._metas.push({ name: String(name), content: String(content) }); return this;
      },
      getMetaTags: function () { return this._metas.map(function (m) { return { getName: function () { return m.name; }, getContent: function () { return m.content; } }; }); },
      setXFrameOptionsMode: function (m) { if (m !== XFrameOptionsMode.ALLOWALL && m !== XFrameOptionsMode.DEFAULT) throw exc('Invalid argument: mode'); this._xfo = m; return this; },
      setSandboxMode: function (m) { this._sandbox = m; return this; },
      getSandboxMode: function () { return this._sandbox; },
      setFaviconUrl: function (u) { if (!/^https:\/\//.test(String(u))) throw exc('Invalid argument: iconUrl (must be an https URL)'); this._favicon = String(u); return this; },
      getFaviconUrl: function () { return this._favicon; },
      setWidth: function (w) { this._w = intArg(w); return this; },
      getWidth: function () { return this._w; },
      setHeight: function (h) { this._h = intArg(h); return this; },
      getHeight: function () { return this._h; },
      asTemplate: function () { return new HtmlTemplate(this._content, null); },
      getBlob: function () { return newBlob(this._content, 'text/html', (this._title || 'output') + '.html'); },
      getAs: function (t) { return this.getBlob().getAs(t); }
    };
    var IDENT = /^[A-Za-z_$][\w$]*$/;
    function compileTemplate(src) {
      var code = 'var __o = [];\n', re = /<\?(!?=)?([\s\S]*?)\?>/g, m, last = 0;
      while ((m = re.exec(src))) {
        if (m.index > last) code += '__o.push(' + JSON.stringify(src.slice(last, m.index)) + ');\n';
        if (m[1] === '=') code += '__o.push(__esc((' + m[2] + ')));\n';
        else if (m[1] === '!=') code += '__o.push(__str((' + m[2] + ')));\n';
        else code += m[2] + '\n';
        last = re.lastIndex;
      }
      if (last < src.length) code += '__o.push(' + JSON.stringify(src.slice(last)) + ');\n';
      return code + 'return __o.join("");';
    }
    function tplStr(v) { return v === undefined || v === null ? '' : String(v); }
    function tplEsc(v) { return escHtml(tplStr(v)); }
    function HtmlTemplate(src, name) {
      Object.defineProperty(this, '__src', { value: String(src) });
      Object.defineProperty(this, '__name', { value: name });
    }
    HtmlTemplate.prototype = {
      constructor: HtmlTemplate,
      toString: function () { return 'HtmlTemplate'; },
      getRawContent: function () { return this.__src; },
      getCode: function () { return compileTemplate(this.__src); },
      getCodeWithComments: function () { return compileTemplate(this.__src); },
      evaluate: function () {
        bump('HtmlTemplate.evaluate');
        var vars = {}, names = [];
        for (var k in this) if (hasOwn.call(this, k) && IDENT.test(k)) { vars[k] = this[k]; names.push(k); }
        var decl = names.map(function (n) { return 'var ' + n + ' = __vars[' + JSON.stringify(n) + '];'; }).join('\n');
        var fnSrc = '(function (__vars, __esc, __str) {\n' + decl + '\n' + compileTemplate(this.__src) + '\n})';
        var fn;
        try {
          fn = exec && exec.evalInApp ? exec.evalInApp(fnSrc) : (new Function('return ' + fnSrc))();
        } catch (e) {
          throw exc('Syntax error in HTML template' + (this.__name ? ' "' + this.__name + '"' : '') + ': ' + (e && e.message));
        }
        return new HtmlOutput(fn(vars, tplEsc, tplStr));
      }
    };
    var HtmlService = {
      toString: function () { return 'HtmlService'; },
      XFrameOptionsMode: XFrameOptionsMode,
      SandboxMode: SandboxMode,
      createTemplateFromFile: function (name) { bump('HtmlService.createTemplateFromFile'); return new HtmlTemplate(readFile(name), String(name)); },
      createTemplate: function (src) { return new HtmlTemplate(src && src.getDataAsString ? src.getDataAsString() : src, null); },
      createHtmlOutputFromFile: function (name) { bump('HtmlService.createHtmlOutputFromFile'); return new HtmlOutput(readFile(name)); },
      createHtmlOutput: function (src) {
        if (src instanceof HtmlTemplate) return src.evaluate();
        if (src && typeof src.getDataAsString === 'function') return new HtmlOutput(src.getDataAsString());
        return new HtmlOutput(src);
      },
      getUserAgent: function () { return env.userAgent || 'Mozilla/5.0 (gas-mock)'; }
    };

    /* ------------------------------------------------------------------ Logger / console */
    function log(level, args) {
      var msg = Array.prototype.map.call(args, function (a) { if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch (e) { return String(a); } }).join(' ');
      S.logs.push({ at: clock.local(), level: level, message: msg, execution: exec ? exec.label : null });
      if (S.logs.length > 1000) S.logs.shift();
      if (env.verbose && typeof console !== 'undefined') console.log('[gas ' + level + '] ' + msg);
    }
    var Logger = {
      toString: function () { return 'Logger'; },
      log: function (a) { if (arguments.length > 1 && typeof a === 'string' && /%/.test(a)) log('log', [formatString.apply(null, arguments)]); else log('log', arguments); return Logger; },
      getLog: function () { return S.logs.map(function (l) { return l.at + ' ' + l.message; }).join('\n'); },
      clear: function () { S.logs = []; }
    };
    var gasConsole = {
      log: function () { log('log', arguments); }, info: function () { log('info', arguments); }, warn: function () { log('warn', arguments); },
      error: function () { log('error', arguments); }, debug: function () { log('debug', arguments); },
      time: function () {}, timeEnd: function () {}, assert: function (c) { if (!c) log('error', ['Assertion failed']); }
    };

    /* ------------------------------------------------------------------ Utilities */
    var DigestAlgorithm = { MD2: 'MD2', MD5: 'MD5', SHA_1: 'SHA_1', SHA_256: 'SHA_256', SHA_384: 'SHA_384', SHA_512: 'SHA_512' };
    var MacAlgorithm = { HMAC_MD5: 'HMAC_MD5', HMAC_SHA_1: 'HMAC_SHA_1', HMAC_SHA_256: 'HMAC_SHA_256', HMAC_SHA_384: 'HMAC_SHA_384', HMAC_SHA_512: 'HMAC_SHA_512' };
    var Charset = { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' };
    function charsetBytes(value, charset) {
      if (typeof value === 'string') return charset === Charset.US_ASCII ? value.split('').map(function (c) { return c.charCodeAt(0) & 127; }) : utf8Encode(value);
      if (value && typeof value.length === 'number') return toUnsignedBytes(value);
      throw sigError('Utilities', [value]);
    }
    var Utilities = {
      toString: function () { return 'Utilities'; },
      DigestAlgorithm: DigestAlgorithm, MacAlgorithm: MacAlgorithm, Charset: Charset,
      formatDate: function (date, timeZone, format) {
        bump('Utilities.formatDate');
        if (!isDate(date) || typeof timeZone !== 'string' || typeof format !== 'string') throw sigError('Utilities.formatDate', arguments);
        var ms = date.getTime();
        if (isNaN(ms)) throw exc('Invalid argument: date');
        try { return formatJava(ms, timeZone, format); } catch (e) { throw exc(e.message); }
      },
      parseDate: function (str, timeZone, format) {
        if (typeof str !== 'string' || typeof timeZone !== 'string' || typeof format !== 'string') throw sigError('Utilities.parseDate', arguments);
        try { return newDate(parseJava(str, timeZone, format)); } catch (e) { throw exc(e.message); }
      },
      formatString: formatString,
      getUuid: function () { bump('Utilities.getUuid'); return uuid(); },
      computeDigest: function (algorithm, value, charset) {
        bump('Utilities.computeDigest');
        if (algorithm !== DigestAlgorithm.SHA_256) {
          if (DigestAlgorithm[algorithm]) throw policy('Utilities.computeDigest(' + algorithm + ') is not implemented by the mock — the app uses SHA_256 (spec).');
          throw sigError('Utilities.computeDigest', arguments);
        }
        return toSignedBytes(sha256Bytes(charsetBytes(value, charset)));
      },
      computeHmacSha256Signature: function (value, key, charset) {
        bump('Utilities.computeHmacSha256Signature');
        return toSignedBytes(hmacSha256Bytes(charsetBytes(value, charset), charsetBytes(key, charset)));
      },
      computeHmacSignature: function (algorithm, value, key, charset) {
        if (algorithm !== MacAlgorithm.HMAC_SHA_256) throw policy('Utilities.computeHmacSignature(' + algorithm + ') is not implemented by the mock.');
        return toSignedBytes(hmacSha256Bytes(charsetBytes(value, charset), charsetBytes(key, charset)));
      },
      base64Encode: function (data, charset) { bump('Utilities.base64Encode'); return base64Encode(charsetBytes(data, charset)); },
      base64EncodeWebSafe: function (data, charset) { return base64Encode(charsetBytes(data, charset), true); },
      base64Decode: function (encoded) {
        bump('Utilities.base64Decode');
        if (typeof encoded !== 'string') throw sigError('Utilities.base64Decode', arguments);
        var r = base64DecodeOrNull(encoded, false);
        if (r === null) throw exc('Could not decode string.');
        return toSignedBytes(r);
      },
      base64DecodeWebSafe: function (encoded) {
        if (typeof encoded !== 'string') throw sigError('Utilities.base64DecodeWebSafe', arguments);
        var r = base64DecodeOrNull(encoded, true);
        if (r === null) throw exc('Could not decode string.');
        return toSignedBytes(r);
      },
      newBlob: newBlob,
      sleep: function (ms) {
        if (typeof ms !== 'number') throw sigError('Utilities.sleep', arguments);
        if (ms > 300000) throw exc('Argument too large: milliseconds');
        if (env.sleepAdvancesClock) clock.advance(ms);
      },
      parseCsv: parseCsv,
      jsonParse: function (s) { return JSON.parse(s); },
      jsonStringify: function (o) { return JSON.stringify(o); },
      zip: function () { throw policy('Utilities.zip is not used by this app'); },
      unzip: function () { throw policy('Utilities.unzip is not used by this app'); }
    };

    /* ------------------------------------------------------------------ disallowed services */
    function forbiddenService(name) {
      return new Proxy({}, { get: function (t, k) {
        if (typeof k === 'symbol' || k === 'toString') return function () { return name; };
        throw exc('You do not have permission to call ' + name + '.' + String(k) + '. [gas-mock policy: spec §2.16 allows no ' + name + ']');
      } });
    }

    /* ------------------------------------------------------------------ env */
    var env = {
      VERSION: VERSION,
      uiContext: false,
      authMode: 'FULL',
      activeSpreadsheetAvailable: true,
      verbose: !!opts.verbose,
      sleepAdvancesClock: !!opts.sleepAdvancesClock,
      userAgent: opts.userAgent || null,
      clock: clock,
      counters: counters,
      lockStats: lockStats,
      globals: {
        SpreadsheetApp: SpreadsheetApp, DriveApp: DriveApp, PropertiesService: PropertiesService, CacheService: CacheService,
        LockService: LockService, MailApp: MailApp, Session: Session, ScriptApp: ScriptApp, HtmlService: HtmlService,
        Utilities: Utilities, Logger: Logger, console: gasConsole, Date: GasDate,
        UrlFetchApp: forbiddenService('UrlFetchApp'), GmailApp: forbiddenService('GmailApp'), DocumentApp: forbiddenService('DocumentApp'),
        FormApp: forbiddenService('FormApp'), CalendarApp: forbiddenService('CalendarApp'), ContactsApp: forbiddenService('ContactsApp'),
        Browser: forbiddenService('Browser')
      },
      get mailbox() { return S.mail; },
      get triggers() { return S.triggers; },
      get formulaWrites() { return S.formulaWrites; },
      get warnings() { return S.warnings; },
      get logs() { return S.logs; },
      get toasts() { return S.ss.toasts; },
      get ownerEmail() { return S.config.ownerEmail; },
      get scriptUrl() { return S.config.scriptUrl; },
      spreadsheet: spreadsheetApi,
      Date: GasDate,
      ui: {
        get menus() { return S.ui.menus; },
        get alerts() { return S.ui.alerts; },
        get dialogs() { return S.ui.dialogs; },
        queuePrompt: function (text, button) { S.ui.promptQueue.push(typeof text === 'object' && text ? text : { text: text, button: button || Button.OK }); },
        queueAlert: function (button) { S.ui.alertQueue.push(button); },
        Button: Button
      },
      drive: {
        get files() { return Object.keys(S.drive.files).map(function (k) { var x = S.drive.files[k]; return { id: x.id, name: x.name, mimeType: x.mimeType, size: x.size, description: x.description, trashed: x.trashed, parents: x.parents.slice(), owner: x.owner }; }); },
        get folders() { return Object.keys(S.drive.folders).map(function (k) { var x = S.drive.folders[k]; return { id: x.id, name: x.name, trashed: x.trashed, parents: x.parents.slice(), owner: x.owner }; }); },
        file: function (id) { return S.drive.files[id] ? clone(S.drive.files[id]) : null; },
        bytes: function (id) { return S.drive.files[id] ? base64Decode(S.drive.files[id].data) : null; },
        trash: function (id) { if (S.drive.files[id]) S.drive.files[id].trashed = true; else if (S.drive.folders[id]) S.drive.folders[id].trashed = true; },
        remove: function (id) { delete S.drive.files[id]; delete S.drive.folders[id]; },
        DriveApp: DriveApp
      },
      properties: function (kind) { return clone(S.props[kind || 'script']); },
      cacheEntries: function (kind) { return clone(S.cache[kind || 'script']); },
      evictCache: function (kind) { if (kind) S.cache[kind] = {}; else S.cache = { script: {}, user: {}, document: {} }; },
      contendLock: function (times) { lockStats.contention = times === undefined ? 1 : times; },
      setFiles: function (f) { filesResolver = f || null; },
      setScriptUrl: function (url) { S.config.scriptUrl = url || null; },
      setOwnerEmail: function (email) { S.config.ownerEmail = String(email); },
      setActiveUserEmail: function (email) { S.config.activeUserEmail = email ? String(email) : ''; },
      resetCounters: function () { for (var k in counters) if (hasOwn.call(counters, k)) delete counters[k]; },
      inspect: {
        sheetNames: function () { return S.ss.sheets.map(function (x) { return x.name; }); },
        sheet: function (name) {
          var sh = S.ss.sheets.filter(function (x) { return x.name === name; })[0];
          if (!sh) return null;
          var lr = lastRowOf(sh), lc = lastColOf(sh), values = [], types = [], formats = [];
          for (var r = 1; r <= lr; r++) {
            var vr = [], tr = [], fr = [];
            for (var c = 1; c <= lc; c++) {
              var cell = cellGet(sh, r, c);
              vr.push(cellOut(cell));
              tr.push(!cell ? 'empty' : cell.f ? 'formula' : isDateCell(cell.v) ? 'date' : typeof cell.v);
              fr.push(nfAt(sh, r, c));
            }
            values.push(vr); types.push(tr); formats.push(fr);
          }
          return { name: sh.name, maxRows: sh.maxRows, maxCols: sh.maxCols, frozenRows: sh.frozenRows, rtl: sh.rtl, hiddenGridlines: sh.hiddenGrid,
            lastRow: lr, lastColumn: lc, values: values, types: types, formats: formats, headers: values[0] || [],
            numberFormatAt: function (r, c) { return nfAt(sh, r, c); }, styleAt: function (r, c, k) { return styleAt(sh, r, c, k, null); } };
        },
        allCells: function () {
          var out = [];
          S.ss.sheets.forEach(function (sh) {
            for (var rk in sh.rows) if (hasOwn.call(sh.rows, rk)) for (var ck in sh.rows[rk]) if (hasOwn.call(sh.rows[rk], ck)) {
              var cell = sh.rows[rk][ck], r = +rk, c = +ck;
              out.push({ sheet: sh.name, r: r, c: c, a1: a1(r, c), value: cellOut(cell), formula: cell.f || null,
                type: cell.f ? 'formula' : isDateCell(cell.v) ? 'date' : typeof cell.v, numberFormat: nfAt(sh, r, c) });
            }
          });
          return out;
        }
      },
      /** Simulate «إنشاء نسخة» (File → Make a copy) by another Google account. */
      simulateCopy: function (o) {
        o = o || {};
        S.config.ownerEmail = o.ownerEmail || 'copy.owner@gmail.com';
        S.ss.owner = S.config.ownerEmail;
        S.ss.id = o.spreadsheetId || driveId(44);
        S.ss.name = 'نسخة من ' + S.ss.name;
        S.config.scriptId = driveId(57);
        S.config.scriptUrl = o.scriptUrl === undefined ? null : o.scriptUrl;   // a fresh copy is not deployed yet
        if (o.keepScriptProperties === false) S.props.script = {};             // default: properties travel with the project
        S.props.user = {};
        S.cache = { script: {}, user: {}, document: {} };
        S.triggers = [];                                                       // installable triggers are never copied
        S.ui.menus = [];
        return env;
      },
      snapshot: function () { return JSON.parse(JSON.stringify(S)); },
      restore: function (state) {
        if (!state || state.v !== 1 || !state.ss || !state.config) throw new Error('[gas-mock] restore(): not a gas-mock state (v1)');
        S = JSON.parse(JSON.stringify(state));
        S.ui = S.ui || { menus: [], alerts: [], dialogs: [], promptQueue: [], alertQueue: [] };
        S.warnings = S.warnings || []; S.logs = S.logs || []; S.formulaWrites = S.formulaWrites || [];
        return env;
      },
      /* ---- hooks used by runtime.js (one call = one Apps Script execution) ---- */
      _beginExecution: function (info) {
        exec = { label: info && info.label || null, Error: info && info.Error || null, evalInApp: info && info.evalInApp || null, locks: 0 };
        return exec;
      },
      _setExecutionRealm: function (realm) { if (exec) { if (realm.Error) exec.Error = realm.Error; if (realm.evalInApp) exec.evalInApp = realm.evalInApp; } },
      _endExecution: function () {
        var e = exec; exec = null;
        if (e && e.locks > 0) warn('Execution "' + e.label + '" ended while still holding a lock (missing releaseLock() in finally).');
        return { label: e && e.label, locksHeld: e ? e.locks : 0 };
      }
    };
    if (STRICT_INTL) env.globals.Intl = IntlBlocked;

    S = freshState();
    if (opts.state) env.restore(opts.state);
    if (opts.files) filesResolver = opts.files;
    return env;
  }

  return {
    VERSION: VERSION,
    createGasEnv: createGasEnv,
    sha256Hex: sha256Hex,
    sha256Bytes: sha256Bytes,
    hmacSha256Bytes: hmacSha256Bytes,
    bytesToHex: bytesToHex,
    base64Encode: function (bytesOrString) { return base64Encode(bytesFromInput(bytesOrString)); },
    base64Decode: base64Decode,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    toSignedBytes: toSignedBytes,
    formatDate: function (date, tz, pattern) { return formatJava(typeof date === 'number' ? date : date.getTime(), tz, pattern); },
    parseDate: function (str, tz, pattern) { return new Date(parseJava(str, tz, pattern)); },
    zonedToUtc: zonedToUtc,
    isDate: isDate,
    escHtml: escHtml
  };
}));
