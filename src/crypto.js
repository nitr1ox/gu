const crypto = require('crypto');
const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
if (key.length !== 32) throw new Error('ENCRYPTION_KEY doit faire 32 octets (64 caracteres hex)');

exports.encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
};

exports.decrypt = (b64) => {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
};
