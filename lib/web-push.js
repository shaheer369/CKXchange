'use strict';

// Minimal RFC 8291 / RFC 8292 Web Push sender using Node's built-in crypto and
// https modules. Callers pass only brief summaries; never send a full account number
// or an unabridged transaction hash in a push payload.
const crypto = require('node:crypto');
const https = require('node:https');

function fromBase64Url(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(text + '='.repeat((4 - text.length % 4) % 4), 'base64');
}
function toBase64Url(value) { return Buffer.from(value).toString('base64url'); }
function hmac(key, value) { return crypto.createHmac('sha256', key).update(value).digest(); }
function hkdfExpand(prk, info, length) {
  const blocks = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter += 1) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}
function getVapidConfig(env = process.env) {
  const publicText = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateText = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  if (!publicText || !privateText || !subject) return null;
  try {
    const publicKey = fromBase64Url(publicText);
    const privateKey = fromBase64Url(privateText);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32) return null;
    if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/[^\s]+$/.test(subject)) return null;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    const derivedPublic = ecdh.getPublicKey();
    if (!crypto.timingSafeEqual(derivedPublic, publicKey)) return null;
    return { publicText: toBase64Url(publicKey), publicKey, privateKey, subject };
  } catch (_) { return null; }
}
function hasVapidConfig(env = process.env) { return Boolean(getVapidConfig(env)); }
function vapidToken(endpoint, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  const audience = new URL(endpoint).origin;
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(Buffer.from(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 60 * 60, sub: config.subject })));
  const signingInput = `${header}.${claims}`;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(config.privateKey);
  const point = ecdh.getPublicKey();
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33, 65)),
    d: toBase64Url(config.privateKey)
  };
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${toBase64Url(signature)}`;
}
function encryptPayload(subscription, payload) {
  const userPublic = fromBase64Url(subscription.keys.p256dh);
  const authSecret = fromBase64Url(subscription.keys.auth);
  if (userPublic.length !== 65 || userPublic[0] !== 4 || authSecret.length < 16 || authSecret.length > 32) {
    throw new Error('Push subscription encryption keys are invalid.');
  }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(userPublic);
  const keyPrk = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, serverPublic]);
  const ikm = hkdfExpand(keyPrk, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.concat([Buffer.from(JSON.stringify(payload), 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4); recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, encrypted]);
}
function allowedPushEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return host === 'fcm.googleapis.com' || host === 'web.push.apple.com' || host.endsWith('.push.apple.com') ||
    host === 'push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') ||
    host.endsWith('.notify.windows.com');
}
function sendHttps(endpoint, headers, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const request = https.request(endpoint, { method: 'POST', headers, timeout: timeoutMs }, response => {
      const chunks = [];
      response.on('data', chunk => { if (chunks.reduce((n, value) => n + value.length, 0) < 2048) chunks.push(chunk); });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('Push provider timed out.')));
    request.on('error', reject);
    request.end(body);
  });
}
async function sendPush(subscription, payload, env = process.env) {
  const config = getVapidConfig(env);
  if (!config) throw new Error('Web Push is not configured.');
  if (!subscription || !allowedPushEndpoint(subscription.endpoint)) throw new Error('Push endpoint is not a supported public push service.');
  const body = encryptPayload(subscription, payload);
  const response = await sendHttps(subscription.endpoint, {
    Authorization: `vapid t=${vapidToken(subscription.endpoint, config)}, k=${config.publicText}`,
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'Content-Length': String(body.length),
    TTL: '60',
    Urgency: 'normal'
  }, body);
  if (response.statusCode >= 200 && response.statusCode < 300) return { ok: true, statusCode: response.statusCode };
  if (response.statusCode === 404 || response.statusCode === 410) return { ok: false, gone: true, statusCode: response.statusCode };
  throw new Error(`Push provider returned HTTP ${response.statusCode}.`);
}

module.exports = { getVapidConfig, hasVapidConfig, allowedPushEndpoint, encryptPayload, vapidToken, sendPush };
