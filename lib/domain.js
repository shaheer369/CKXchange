'use strict';
const crypto = require('node:crypto');

function id(prefix) { return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`; }
function now() { return new Date().toISOString(); }
function toUsdtMicro(value) { return Math.round(Number(value) * 1_000_000); }
function fromUsdtMicro(value) { return Number(value) / 1_000_000; }
function toPaise(value) { return Math.round(Number(value) * 100); }
function fromPaise(value) { return Number(value) / 100; }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function newCsrf() { return crypto.randomBytes(32).toString('hex'); }
function validName(name) {
  const value = String(name || '').trim();
  return value.length <= 80 && value.replace(/[^\p{L}]/gu, '').length >= 2 && /^[\p{L}][\p{L}\s.'-]*$/u.test(value) && value === value.toLocaleUpperCase('en-IN');
}
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function validDepositAddress(network, address) { return network === 'TRC20' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(address || '').trim()); }
function validTransactionHash(network, value) { return network === 'TRC20' && /^[a-fA-F0-9]{64}$/.test(String(value || '')); }
function duplicateKeyError(error) { return error?.code === 11000 || error?.code === '11000'; }
module.exports = { id, now, toUsdtMicro, fromUsdtMicro, toPaise, fromPaise, safeEqual, newCsrf, validName, validEmail, validDepositAddress, validTransactionHash, duplicateKeyError };
