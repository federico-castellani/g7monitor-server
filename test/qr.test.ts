import assert from 'node:assert/strict';
import { test } from 'node:test';

// public/qr.js is a browser script (it sets window.g7qr): load it the same way here.
(globalThis as { window?: object }).window = {};
await import(new URL('../public/qr.js', import.meta.url).href); // a browser script, not typed
const qr = (globalThis as unknown as { window: { g7qr: { encode(text: string, mask?: number | null): boolean[][]; svg(text: string): string } } }).window.g7qr;

/**
 * Reference made by an independent encoder (segno 1.6.6, error correction M, byte mode, mask 3),
 * with the standard padding rule of ISO/IEC 18004 §7.4.10.
 */
const GOLDEN = [
    '111111101000001110111111001111111',
    '100000101000101001000001001000001',
    '101110100100111110100000101011101',
    '101110101001000100100100101011101',
    '101110100100000011100011101011101',
    '100000100011000110100011001000001',
    '111111101010101010101010101111111',
    '000000001101100111110000100000000',
    '101101110000011111101111101001011',
    '001101000110111111111001011101100',
    '111100101001010000100111100001011',
    '110111001110000111001111101001001',
    '100101110010001010011111100101000',
    '011101000100001001001101010100010',
    '010101100111010001011100011010000',
    '010001000101111100000110101101111',
    '111000101100100000100011001010010',
    '000110010110001000100011111110001',
    '110110111001010110100100100100100',
    '011100001011110011101011110100011',
    '100101100001100110000010100110111',
    '110011001000011110001110010000101',
    '000001100011010100011111010001011',
    '011001011010011100001000001001001',
    '101110100111001011011001111110101',
    '000000001110111100010110100011011',
    '111111101010111011110101101011000',
    '100000101101111111110001100011111',
    '101110100110110011110011111110111',
    '101110101011000010010011110101011',
    '101110101011111110001011001001100',
    '100000100111001001101010001100001',
    '111111101001111001111111010110000',
];

test('QR code: identical, module by module, to an independent encoder', () => {
  const m = qr.encode('otpauth://totp/G7:x?secret=JBSWY3DPEHPK3PXP', 3);
  assert.deepEqual(m.map((r) => r.map((v) => (v ? '1' : '0')).join('')), GOLDEN);
});

test('QR code: a real two-step address fits, a too long text is refused', () => {
  const uri = 'otpauth://totp/G7%20Monitor:un.nome_utente-lungo-32-caratteri?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=G7%20Monitor&algorithm=SHA1&digits=6&period=30';
  assert.equal(qr.encode(uri).length, 4 * 9 + 17); // version 9
  assert.match(qr.svg(uri), /^<svg class="qr" viewBox="0 0 61 61"/);
  assert.throws(() => qr.encode('x'.repeat(300)), /troppo lungo/);
});
