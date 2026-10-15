/*
 * qr-decode.js — an independent QR code reader for the tests (no dependencies).
 *
 *   const { qrDecode, svgToMatrix } = require('./qr-decode.js');
 *   qrDecode(matrix) → { version, mask, text }   (matrix: rows of booleans, true = dark; throws when invalid)
 *
 * It checks what a phone camera relies on: finder / timing patterns, both copies of the format information
 * (BCH), the version information (v ≥ 7), Reed–Solomon syndromes of every block, and the byte-mode segment
 * with its terminator and padding. It follows the published formulas (block counts, alignment positions,
 * raw module counts as in Nayuki's reference), NOT the tables of the app's encoder, so a wrong table in
 * src/Admin.html cannot pass by agreeing with itself. Error correction level M, byte mode only.
 */
'use strict';

function qrDecode(m) {
  const n = m.length, v = (n - 17) / 4;
  if (!Number.isInteger(v) || v < 1 || v > 40) throw new Error('bad size ' + n);
  const ECC = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const fn = m.map((row) => row.map(() => false));
  const mark = (r, c) => { if (r >= 0 && r < n && c >= 0 && c < n) fn[r][c] = true; };
  const finder = (r0, c0) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c); };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let k = 0; k < n; k++) { mark(6, k); mark(k, 6); }
  const align = [];
  if (v >= 2) {
    const cnt = Math.floor(v / 7) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (cnt * 2 - 2)) * 2;
    align.push(6);
    for (let pos = n - 7; align.length < cnt; pos -= step) align.splice(1, 0, pos);
  }
  for (const r of align) for (const c of align) {
    if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) mark(r + a, c + b);
  }
  for (let k = 0; k < 9; k++) { mark(8, k); mark(k, 8); }
  for (let k = 0; k < 8; k++) { mark(8, n - 1 - k); mark(n - 1 - k, 8); }
  if (v >= 7) for (let k = 0; k < 18; k++) { mark(Math.floor(k / 3), n - 11 + k % 3); mark(n - 11 + k % 3, Math.floor(k / 3)); }
  // finder / timing / dark module shapes
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const want = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
    if (m[r0 + r][c0 + c] !== want) throw new Error('finder pattern');
  }
  for (let k = 8; k < n - 8; k++) if (m[6][k] !== (k % 2 === 0) || m[k][6] !== (k % 2 === 0)) throw new Error('timing pattern');
  if (m[n - 8][8] !== true) throw new Error('dark module');
  // format information (both copies), BCH(15,5) with mask 0x5412
  const fmtBits = (data) => { let rem = data; for (let k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); return ((data << 10) | rem) ^ 0x5412; };
  let f1 = 0, f2 = 0;
  for (let k = 0; k <= 5; k++) f1 |= m[k][8] << k;
  f1 |= m[7][8] << 6 | m[8][8] << 7 | m[8][7] << 8;
  for (let k = 9; k < 15; k++) f1 |= m[8][14 - k] << k;
  for (let k = 0; k < 8; k++) f2 |= m[8][n - 1 - k] << k;
  for (let k = 8; k < 15; k++) f2 |= m[n - 15 + k][8] << k;
  if (f1 !== f2) throw new Error('format copies differ');
  const data5 = (f1 ^ 0x5412) >>> 10, ecl = data5 >>> 3, mask = data5 & 7;
  if (fmtBits(data5) !== f1) throw new Error('format BCH');
  if (ecl !== 0) throw new Error('not level M');
  if (v >= 7) {
    let rem = v; for (let k = 0; k < 12; k++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = v << 12 | rem;
    for (let k = 0; k < 18; k++) {
      const bit = (bits >>> k & 1) === 1;
      if (m[Math.floor(k / 3)][n - 11 + k % 3] !== bit || m[n - 11 + k % 3][Math.floor(k / 3)] !== bit) throw new Error('version info');
    }
  }
  const masks = [(x, y) => (x + y) % 2, (x, y) => y % 2, (x) => x % 3, (x, y) => (x + y) % 3, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2,
    (x, y) => x * y % 2 + x * y % 3, (x, y) => (x * y % 2 + x * y % 3) % 2, (x, y) => ((x + y) % 2 + x * y % 3) % 2];
  let raw = (16 * v + 128) * v + 64;
  if (v >= 2) { const na = Math.floor(v / 7) + 2; raw -= (25 * na - 10) * na - 55; if (v >= 7) raw -= 36; }
  const total = Math.floor(raw / 8);
  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
      if (!fn[y][x] && bits.length < total * 8) bits.push((m[y][x] ? 1 : 0) ^ (masks[mask](x, y) === 0 ? 1 : 0));
    }
  }
  if (bits.length !== total * 8) throw new Error('codeword count ' + bits.length / 8 + ' vs ' + total);
  const cw = [];
  for (let k = 0; k < bits.length; k += 8) cw.push(bits.slice(k, k + 8).reduce((a, b) => a << 1 | b, 0));
  const nb = BLOCKS[v], ecc = ECC[v], shortLen = Math.floor(total / nb), nShort = nb - total % nb;
  const blocks = [];
  for (let b = 0; b < nb; b++) blocks.push([]);
  let p = 0;
  for (let k = 0; k < shortLen - ecc + 1; k++) for (let b = 0; b < nb; b++) if (k < shortLen - ecc || b >= nShort) blocks[b].push(cw[p++]);
  for (let k = 0; k < ecc; k++) for (let b = 0; b < nb; b++) blocks[b].push(cw[p++]);
  if (p !== total) throw new Error('interleave');
  const EXP = [], LOG = [];
  for (let k = 0, x = 1; k < 255; k++) { EXP[k] = x; LOG[x] = k; x = (x << 1) ^ (x & 0x80 ? 0x11D : 0); }
  const mul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);
  const data = [];
  for (const blk of blocks) {
    for (let k = 0; k < ecc; k++) { let s = 0; for (const c of blk) s = mul(s, EXP[k]) ^ c; if (s) throw new Error('RS syndrome ≠ 0'); }
    data.push(...blk.slice(0, blk.length - ecc));
  }
  const dbits = [];
  data.forEach((c) => { for (let k = 7; k >= 0; k--) dbits.push(c >>> k & 1); });
  const take = (len) => { let x = 0; for (let k = 0; k < len; k++) x = x << 1 | dbits.shift(); return x; };
  if (take(4) !== 4) throw new Error('not byte mode');
  const len = take(v < 10 ? 8 : 16), bytes = [];
  for (let k = 0; k < len; k++) bytes.push(take(8));
  const rest = dbits.splice(0);
  const term = rest.slice(0, Math.min(4, rest.length));
  if (term.some(Boolean)) throw new Error('terminator');
  const after = rest.slice(term.length), pad = after.slice(after.length % 8);
  if (after.slice(0, after.length % 8).some(Boolean)) throw new Error('bit padding');
  for (let k = 0; k < pad.length / 8; k++) if (pad.slice(k * 8, k * 8 + 8).reduce((a, b) => a << 1 | b, 0) !== (k % 2 ? 0x11 : 0xEC)) throw new Error('pad bytes');
  return { version: v, mask, text: Buffer.from(bytes).toString('utf8') };
}
/** The <svg> QR.svg() draws (runs `M<x> <y>h<w>v1h-<w>z` on a quiet zone) → module matrix. */
function svgToMatrix(svg) {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const d = /<path[^>]* d="([^"]*)"/.exec(svg);
  if (!vb || !d || vb[1] !== vb[2]) throw new Error('not a QR svg');
  const runs = [...d[1].matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
  if (runs.map((r) => r[0]).join('') !== d[1]) throw new Error('unexpected path data');
  let q = Infinity;
  runs.forEach((r) => { q = Math.min(q, +r[1], +r[2]); });
  const n = +vb[1] - 2 * q;
  const m = Array.from({ length: n }, () => Array(n).fill(false));
  runs.forEach((r) => { for (let k = 0; k < +r[3]; k++) m[+r[2] - q][+r[1] - q + k] = true; });
  return m;
}

module.exports = { qrDecode, svgToMatrix };
