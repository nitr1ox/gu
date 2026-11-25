// API serveur-à-serveur : permet à un AUTRE bot de créer des panels et de piloter ajout de membres / stats.
// Auth : en-tête  Authorization: Bearer <clé>  (clés dans la variable d'environnement API_KEYS, séparées par des virgules).
// "user_id" = l'ID Discord de la personne qui a lancé la commande dans l'autre bot.
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const services = require('./services');

const ID = /^\d{17,20}$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

module.exports = () => {
  const keys = (process.env.API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean).map(sha);
  if (!keys.length) console.warn('API_KEYS vide : l\'API /v1 est désactivée.');

  const r = express.Router();
  r.use(express.json({ limit: '10kb' }));

  // ---- authentification + limite de débit (120 req/min par clé) ----
  const hits = new Map();
  r.use((req, res, next) => {
    const given = sha((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    const idx = keys.findIndex((k) => crypto.timingSafeEqual(k, given));
    if (idx < 0) return res.status(401).json({ error: 'Clé API invalide.' });
    const minute = Math.floor(Date.now() / 60000);
    const h = hits.get(idx);
    if (!h || h.minute !== minute) hits.set(idx, { minute, n: 1 });
    else if (++h.n > 120) return res.status(429).json({ error: 'Trop de requêtes.' });
    next();
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

  // Crée (ou retrouve) le panel d'un utilisateur. Idempotent.
  r.post('/panels', wrap(async (req, res) => {
    const userId = uid(req.body.user_id);
    const existing = await db.getPanel(userId);
    await db.savePanel(userId, {
      user_id: userId,
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

  // Bots, serveurs et stats d'un utilisateur
  r.get('/panels/:userId', wrap(async (req, res) => {
    const userId = uid(req.params.userId);
    if (!(await db.getPanel(userId))) return res.status(404).json({ error: "Cet utilisateur n'a pas de panel." });
    res.json({ panel_url: services.panelUrl(), ...(await services.overview(userId)) });
  }));

  // Stats d'un serveur (l'utilisateur doit y être admin avec un de ses bots)
  r.get('/guilds/:guildId/stats', wrap(async (req, res) => {
    res.json(await services.guildStats(uid(req.query.user_id), String(req.params.guildId)));
  }));

  // Ajoute les membres sauvegardés dans un serveur : body { user_id, source } (source = ID d'un serveur, ou "all")
  r.post('/guilds/:guildId/members/add', wrap(async (req, res) => {
    const jobId = await services.startRestore({
      userId: uid(req.body.user_id), guildId: String(req.params.guildId), source: req.body.source });
    res.status(202).json({ job_id: jobId });
  }));

  // Progression d'un ajout de membres
  r.get('/jobs/:jobId', wrap(async (req, res) => {
    const userId = uid(req.query.user_id);
    const job = await db.getJob(String(req.params.jobId));
    if (!job || job.user_id !== userId) return res.status(404).json({ error: 'Introuvable.' });
    const { status, total, done, added, already, failed } = job;
    res.json({ status, total, done, added, already, failed });
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  return r;
};
