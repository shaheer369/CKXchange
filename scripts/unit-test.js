'use strict';
const assert = require('node:assert/strict');
const {
  id, toUsdtMicro, fromUsdtMicro, canDeleteWithDustBalance, toPaise, fromPaise, safeEqual, newCsrf,
  validName, validEmail, validDepositAddress, validTransactionHash, duplicateKeyError
} = require('../lib/domain');

assert.match(id('USR'), /^USR-[A-F0-9]{18}$/);
assert.equal(toUsdtMicro(1.234567), 1234567);
assert.equal(fromUsdtMicro(1234567), 1.234567);
assert.equal(canDeleteWithDustBalance(toUsdtMicro(0.01 / 106), 0, 106), true, 'A remaining INR value below ₹1 should not block account deletion');
assert.equal(canDeleteWithDustBalance(toUsdtMicro(1 / 106), 0, 106), false, 'A remaining INR value of ₹1 should block account deletion');
assert.equal(canDeleteWithDustBalance(0, 1, 106), false, 'Reserved USDT must always block account deletion');
assert.equal(canDeleteWithDustBalance(-1, 0, 106), false, 'Negative balances must not qualify as dust');
assert.equal(toPaise(110.25), 11025);
assert.equal(fromPaise(11025), 110.25);
assert.equal(safeEqual('abc', 'abc'), true);
assert.equal(safeEqual('abc', 'abd'), false);
assert.equal(safeEqual('abc', 'abcd'), false);
assert.match(newCsrf(), /^[a-f0-9]{64}$/);
assert.equal(validName('SHAHEER KHAN'), true);
assert.equal(validName('Shaheer Khan'), false);
assert.equal(validName('SHAHEER123'), false);
assert.equal(validEmail('user@example.com'), true);
assert.equal(validEmail('not-an-email'), false);
assert.equal(validDepositAddress('TRC20', `T${'1'.repeat(33)}`), true);
assert.equal(validDepositAddress('ERC20', `T${'1'.repeat(33)}`), false);
assert.equal(validTransactionHash('TRC20', 'a'.repeat(64)), true);
assert.equal(validTransactionHash('TRC20', 'not-a-hash'), false);
assert.equal(duplicateKeyError({ code: 11000 }), true);
assert.equal(duplicateKeyError({ code: 500 }), false);

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.ok(packageJson.dependencies.mongodb, 'MongoDB Node.js driver must be installed');
assert.equal(canDeleteWithDustBalance(toUsdtMicro(0.01 / 106), 0, 106), true);
assert.ok(packageJson.dependencies['connect-mongo'], 'sessions must use MongoDB-backed storage');
assert.equal(packageJson.dependencies['better-sqlite3'], undefined, 'SQLite must no longer be an application dependency');
console.log('CKXchange unit tests passed. Run npm run test:integration with MONGODB_TEST_URI to exercise the HTTP/database workflow.');
