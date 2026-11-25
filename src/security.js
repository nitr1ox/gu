// En-têtes de sécurité + limitation de requêtes (en mémoire, sans dépendance).
// Derrière un proxy (Render, etc.) : app.set('trust proxy', 1) est fait dans web.js pour que req.ip soit la vraie IP.

const secure = () => String(process.env.REDIRECT_URI || '').startsWith('https');

exports.headers = (_req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://cdn.discordapp.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (secure()) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
};

// Pas de cache pour les réponses d'API (elles contiennent des données de session / de membres)
exports.noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

// limiter({ windowMs, max, keyFn?, message? }) -> middleware Express
exports.limiter = ({ windowMs, max, keyFn = (req) => req.ip, message = 'Trop de requêtes, réessaie plus tard.' }) => {
  const hits = new Map(); // clé -> { n, reset }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.max(windowMs, 30000)).unref();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - h.n)));
    if (h.n > max) {
      const wait = Math.ceil((h.reset - now) / 1000);
      res.set('Retry-After', String(wait));
      const wantsJson = req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/v1');
      return res.status(429)[wantsJson ? 'json' : 'send'](wantsJson ? { error: message } : message);
    }
    next();
  };
};
