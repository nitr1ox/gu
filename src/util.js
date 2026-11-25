const crypto = require('crypto');

exports.sign = (data) =>
  crypto.createHmac('sha256', process.env.STATE_SECRET).update(data).digest('hex');

exports.safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

exports.parseCookies = (header = '') =>
  Object.fromEntries(
    header.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
    })
  );
