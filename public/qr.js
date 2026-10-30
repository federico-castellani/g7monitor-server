// QR code generator (ISO/IEC 18004) for the two-step verification set-up: byte mode, error
// correction level M, versions 1–10 (up to 213 bytes, plenty for an otpauth:// address).
// Written here because the page's CSP accepts only its own scripts. Exposed as window.g7qr.

/** Error correction M, per version: [blocks, codewords per block, data codewords per block], … */
const BLOCKS_M = [
  null,
  [[1, 26, 16]], [[1, 44, 28]], [[1, 70, 44]], [[2, 50, 32]], [[2, 67, 43]],
  [[4, 43, 27]], [[4, 49, 31]], [[2, 60, 38], [2, 61, 39]], [[3, 58, 36], [2, 59, 37]], [[4, 69, 43], [1, 70, 44]],
];
/** Centres of the alignment patterns, per version. */
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const LEVEL_M = 0b00;

// ------------------------------------------------------------------ Reed–Solomon over GF(256), x^8+x^4+x^3+x^2+1

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Generator polynomial (x - α^0)…(x - α^(n-1)), highest degree first. */
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function errorCodewords(data, n) {
  const g = generator(n);
  const rest = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = rest[i];
    if (c) for (let j = 0; j < g.length; j++) rest[i + j] ^= mul(g[j], c);
  }
  return rest.slice(data.length);
}

// ------------------------------------------------------------------ data

function dataCapacity(version) {
  return BLOCKS_M[version].reduce((s, [n, , d]) => s + n * d, 0);
}

/** Codewords ready to place: data in byte mode, padded, split in blocks, error correction, interleaved. */
function codewords(bytes, version) {
  const cap = dataCapacity(version);
  const bits = [];
  const put = (v, len) => { for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  const dataBlocks = [];
  const ecBlocks = [];
  let k = 0;
  for (const [n, total, d] of BLOCKS_M[version]) {
    for (let i = 0; i < n; i++) {
      const block = data.slice(k, k + d);
      k += d;
      dataBlocks.push(block);
      ecBlocks.push(errorCodewords(block, total - d));
    }
  }
  const out = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecBlocks[0].length; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

// ------------------------------------------------------------------ matrix

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

const digits = (n) => { let d = 0; while (n) { d++; n >>>= 1; } return d; };
function bch(data, poly, shift) {
  let d = data << shift;
  while (digits(d) - digits(poly) >= 0) d ^= poly << (digits(d) - digits(poly));
  return (data << shift) | d;
}

function matrix(version, words, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  // finder patterns with their white separators
  for (const [r0, c0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        m[rr][cc] = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      }
    }
  }
  // alignment patterns (not over the finders)
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if (m[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    }
  }
  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
  }
  // format information (level and mask), twice
  const format = bch((LEVEL_M << 3) | mask, 0x537, 10) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const dark = ((format >> i) & 1) === 1;
    if (i < 6) m[i][8] = dark;
    else if (i < 8) m[i + 1][8] = dark;
    else m[size - 15 + i][8] = dark;
    if (i < 8) m[8][size - i - 1] = dark;
    else if (i < 9) m[8][15 - i] = dark;
    else m[8][14 - i] = dark;
  }
  m[size - 8][8] = true; // dark module
  // version information (version 7 and later), twice
  if (version >= 7) {
    const v = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const dark = ((v >> i) & 1) === 1;
      m[Math.floor(i / 3)][(i % 3) + size - 11] = dark;
      m[(i % 3) + size - 11][Math.floor(i / 3)] = dark;
    }
  }
  // data, in two-column zigzag from the bottom right, masked
  const apply = MASKS[mask];
  let byte = 0, bit = 7, dir = -1, row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // the vertical timing pattern
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] !== null) continue;
        let dark = byte < words.length && ((words[byte] >>> bit) & 1) === 1;
        if (apply(row, col - c)) dark = !dark;
        m[row][col - c] = dark;
        if (--bit < 0) { byte++; bit = 7; }
      }
      row += dir;
      if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
    }
  }
  return m;
}

/** The standard penalty: the mask with the lowest one is the easiest to scan. */
function penalty(m) {
  const n = m.length;
  let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        const a = pass ? m[j - 1]?.[i] : m[i][j - 1];
        const b = j < n ? (pass ? m[j][i] : m[i][j]) : null;
        if (b === a) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const v = m[i][j];
      if (v === m[i + 1][j] && v === m[i][j + 1] && v === m[i + 1][j + 1]) p += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true];
  const light = (get, k) => { for (let x = k; x < k + 4; x++) if (x >= 0 && x < n && get(x)) return false; return true; };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 7 <= n; j++) {
      for (const get of [(x) => m[i][x], (x) => m[x][i]]) {
        if (pattern.every((v, k) => get(j + k) === v) && (light(get, j - 4) || light(get, j + 7))) p += 40;
      }
    }
  }
  const dark = m.reduce((s, r) => s + r.filter(Boolean).length, 0);
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/** @returns the module matrix (true = dark) for [text]; [mask] forces one (tests), otherwise the best. */
function encode(text, mask = null) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version++;
  if (version > 10) throw new Error('Testo troppo lungo per il QR code');
  const words = codewords(bytes, version);
  if (mask !== null) return matrix(version, words, mask);
  let best = null, bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const m = matrix(version, words, k);
    const score = penalty(m);
    if (score < bestScore) { best = m; bestScore = score; }
  }
  return best;
}

/** SVG of the QR code: dark on white with the 4-module quiet zone, in any page theme (scanners need it). */
function svg(text, label = 'QR code') {
  const m = encode(text);
  const n = m.length + 8;
  let d = '';
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" role="img" aria-label="${label}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

window.g7qr = { encode, svg };
