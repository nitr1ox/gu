const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const services = require('./services');
const schedule = require('./schedule');
const { limiter } = require('./security');

const ID = /^\d{17,20}$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

module.exports = () => {
  const entries = (process.env.API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean).map((raw, i) => {
    const m = raw.match(/^([A-Za-z0-9_-]{1,32}):(.+)$/);
    if (!m) console.warn(`API_KEYS : la clé n°${i + 1} n'a pas de nom (format nom:secret) ; elle est nommée « key${i + 1} ».`);
    return m ? { label: m[1], hash: sha(m[2]) } : { label: `key${i + 1}`, hash: sha(raw) };
  });
  if (!entries.length) console.warn('API_KEYS vide : l\'API /v1 est désactivée.');
  const LEGACY = process.env.API_LEGACY_CLIENT || null;

  const r = express.Router();
  r.use(limiter({ windowMs: 60000, max: 300, message: 'Trop de requêtes.' }));
  r.use(express.json({ limit: '10kb' }));

  const hits = new Map();
  r.use(async (req, res, next) => {
    try {
      const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      const given = sha(raw);
      let bucket;
      const idx = entries.findIndex((e) => crypto.timingSafeEqual(e.hash, given));
      if (idx >= 0) {
        req.apiClient = entries[idx].label;
        bucket = `c:${idx}`;
      } else if (raw.startsWith('ak_') && raw.length <= 100) {
        const k = await db.getApiKeyByHash(given.toString('hex'));
        if (!k) return res.status(401).json({ error: 'Clé API invalide.' });
        req.apiUser = k.user_id;
        bucket = `u:${k.id}`;
        if (!k.last_used || Date.now() - k.last_used > 10 * 60 * 1000) db.touchApiKey(k.id).catch(() => {});
      } else {
        return res.status(401).json({ error: 'Clé API invalide.' });
      }
      const minute = Math.floor(Date.now() / 60000);
      const h = hits.get(bucket);
      if (!h || h.minute !== minute) hits.set(bucket, { minute, n: 1 });
      else if (++h.n > 120) return res.status(429).json({ error: 'Trop de requêtes.' });
      next();
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (e instanceof services.ApiError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Erreur interne.' });
  });
  const uid = (v) => {
    if (!ID.test(String(v || ''))) throw new services.ApiError(400, 'user_id invalide.');
    return String(v);
  };

  const owned = async (req, userId) => {
    const p = await db.getPanel(userId);
    if (!p) return null;
    if (p.api_client === req.apiClient) return p;
    if (!p.api_client && LEGACY && LEGACY === req.apiClient) {
      await db.savePanel(userId, { api_client: req.apiClient });
      return { ...p, api_client: req.apiClient };
    }
    throw new services.ApiError(403, "Ce panel n'appartient pas à cette clé API.");
  };

  const who = async (req, v) => {
    if (req.apiUser) {
      if (v != null && v !== '' && String(v) !== req.apiUser) throw new services.ApiError(403, 'Cette clé ne peut agir que pour son propriétaire.');
      return req.apiUser;
    }
    const userId = uid(v);
    await owned(req, userId);
    return userId;
  };

  r.post('/panels', wrap(async (req, res) => {
    const userId = await who(req, req.body.user_id);
    const existing = req.apiUser ? true : !!(await db.getPanel(userId));
    if (!req.apiUser) await db.savePanel(userId, {
      user_id: userId,
      api_client: req.apiClient,
      username: String(req.body.username || '').slice(0, 64),
      ...(existing ? {} : { created: Date.now() }),
    });
    const overview = await services.overview(userId);
    res.status(existing ? 200 : 201).json({
      created: !existing,
      panel_url: services.panelUrl(),
      redirect_uri: process.env.REDIRECT_URI,
      has_bot: overview.bots.length > 0,
      ...overview,
    });
  }));

  r.get('/panels/:userId', wrap(async (req, res) => {
    const userId = await who(req, req.params.userId);
    if (!req.apiUser && !(await db.getPanel(userId))) return res.status(404).json({ error: "Cet utilisateur n'a pas de panel." });
    res.json({ panel_url: services.panelUrl(), ...(await services.overview(userId)) });
  }));

  r.get('/guilds/:guildId/stats', wrap(async (req, res) => {
    const userId = await who(req, req.query.user_id);
    res.json(await services.guildStats(userId, String(req.params.guildId)));
  }));

  r.post('/guilds/:guildId/members/add', wrap(async (req, res) => {
    const userId = await who(req, req.body.user_id);
    const jobId = await services.startRestore({
      userId, guildId: String(req.params.guildId), source: req.body.source,
      actor: { id: userId, name: String((await db.getPanel(userId))?.username || userId), via: 'api' } });
    res.status(202).json({ job_id: jobId });
  }));

  r.post('/guilds/:guildId/members/schedule', wrap(async (req, res) => {
    const userId = await who(req, req.body.user_id);
    const guildId = String(req.params.guildId);
    if (!(await services.findGuild(userId, guildId))) throw new services.ApiError(404, "Serveur introuvable, ou tu n'y es pas admin avec un de tes bots.");
    const out = await schedule.create({ userId, guildId, source: req.body.source, runAt: schedule.parseRunAt(req.body.run_at),
      actor: { id: userId, name: String((await db.getPanel(userId))?.username || userId), via: 'api' } });
    res.status(201).json({ schedule_id: out.id, run_at: out.run_at, expected: out.expected });
  }));

  r.get('/guilds/:guildId/members/schedules', wrap(async (req, res) => {
    const userId = await who(req, req.query.user_id);
    const guildId = String(req.params.guildId);
    if (!(await services.findGuild(userId, guildId))) throw new services.ApiError(404, "Serveur introuvable, ou tu n'y es pas admin avec un de tes bots.");
    res.json({ schedules: await schedule.list(guildId) });
  }));

  r.delete('/guilds/:guildId/members/schedules/:id', wrap(async (req, res) => {
    const userId = await who(req, req.query.user_id);
    const guildId = String(req.params.guildId);
    if (!(await services.findGuild(userId, guildId))) throw new services.ApiError(404, "Serveur introuvable, ou tu n'y es pas admin avec un de tes bots.");
    await schedule.cancel({ guildId, scheduleId: req.params.id,
      actor: { id: userId, name: String((await db.getPanel(userId))?.username || userId), via: 'api' } });
    res.json({ ok: true });
  }));

  r.get('/jobs/:jobId', wrap(async (req, res) => {
    const userId = await who(req, req.query.user_id);
    const job = await db.getJob(String(req.params.jobId));
    if (!job || job.user_id !== userId) return res.status(404).json({ error: 'Introuvable.' });
    const { status, total, done, added, already, failed } = job;
    res.json({ status, total, done, added, already, failed });
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  return r;
};
