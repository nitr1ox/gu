const crypto = require('crypto');
const db = require('./db');

const MAX_KEYS = 5;

exports.MAX_KEYS = MAX_KEYS;

exports.createPersonalKey = async (userId, rawName) => {
  const name = String(rawName || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Ma clé';
  if ((await db.apiKeysOf(userId)).length >= MAX_KEYS) {
    throw Object.assign(new Error(`Maximum ${MAX_KEYS} clés. Révoque-en une d'abord.`), { code: 'MAX_KEYS' });
  }
  const key = `ak_${crypto.randomBytes(32).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const id = await db.createApiKey({ user_id: userId, name, hash, prefix: key.slice(0, 8), created: Date.now(), last_used: null });
  return { id, name, key };
};
