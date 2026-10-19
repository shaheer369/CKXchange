'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { getVapidConfig, hasVapidConfig, allowedPushEndpoint, encryptPayload, vapidToken } = require('../lib/web-push');

assert.equal(hasVapidConfig({}), false, 'Push must stay off without server-side VAPID configuration');
const appKeys = crypto.createECDH('prime256v1');
appKeys.generateKeys();
const env = {
  VAPID_PUBLIC_KEY: appKeys.getPublicKey().toString('base64url'),
  VAPID_PRIVATE_KEY: appKeys.getPrivateKey().toString('base64url'),
  VAPID_SUBJECT: 'mailto:security@example.test'
};
assert.equal(hasVapidConfig(env), true, 'A matching P-256 VAPID key pair should validate');
assert.ok(getVapidConfig(env).publicText);
const config = getVapidConfig(env);
const endpoint = 'https://fcm.googleapis.com/fcm/send/example';
const token = vapidToken(endpoint, config, 1_800_000_000);
const tokenParts = token.split('.');
assert.equal(tokenParts.length, 3, 'VAPID token should be a three-part JWT');
const claims = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString('utf8'));
assert.equal(claims.aud, 'https://fcm.googleapis.com', 'VAPID audience should match the push service origin');
assert.equal(claims.exp, 1_800_000_000 + 12 * 60 * 60, 'VAPID token should use a bounded expiration');
const point = config.publicKey;
const publicJwk = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') }, format: 'jwk' });
assert.equal(crypto.verify('sha256', Buffer.from(`${tokenParts[0]}.${tokenParts[1]}`), { key: publicJwk, dsaEncoding: 'ieee-p1363' }, Buffer.from(tokenParts[2], 'base64url')), true, 'VAPID ES256 signature must verify with the configured public key');
assert.equal(hasVapidConfig({ ...env, VAPID_PUBLIC_KEY: crypto.createECDH('prime256v1').generateKeys().toString('base64url') }), false, 'Mismatched VAPID keys must be rejected');
assert.equal(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/example'), true);
assert.equal(allowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/example'), true);
assert.equal(allowedPushEndpoint('http://127.0.0.1:8080/internal'), false, 'Push endpoint validation must reject non-HTTPS/private targets');
assert.equal(allowedPushEndpoint('https://localhost/push'), false);
const deviceKeys = crypto.createECDH('prime256v1');
deviceKeys.generateKeys();
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/example', keys: { p256dh: deviceKeys.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
const encrypted = encryptPayload(subscription, { title: 'Test', body: 'No private details', url: '/', tag: 'test-id' });
assert.ok(encrypted.length > 100, 'Payload should contain the RFC 8291 encrypted record');
assert.equal(encrypted.readUInt32BE(16), 4096, 'Record size header should be present');
assert.equal(encrypted[20], 65, 'Server public key length header should be present');
console.log('CKXchange notification crypto tests passed.');
