const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const oauth = require('./oauth');
const restore = require('./restore');
const verifymsg = require('./verifymsg');
const manager = require('./botmanager');
const { encrypt } = require('./crypto');
const { sign, safeEq, parseCookies } = require('./util');

const SESSION_TTL = 7 * 24 * 3600; // secondes
const MAX_BOTS_PER_USER = Number(process.env.MAX_BOTS_PER_USER || 3);
const origin = () => new URL(process.env.REDIRECT_URI).origin;
const panelRedirect = () => `${origin()}/panel/callback`;
const isSecure = () => process.env.REDIRECT_URI.startsWith('https');
const isAdmin = (g) => g.owner || (BigInt(g.permissions) & 0x8n) === 0x8n;
// Application Discord du panel (connexion uniquement, pas besoin de bot)
const panelApp = () => ({ clientId: process.env.PANEL_CLIENT_ID, clientSecret: process.env.PANEL_CLIENT_SECRET });
// Gérer les rôles + créer des invitations + voir/écrire dans les salons + intégrer des liens
const INVITE_PERMS = 268454913;
const inviteUrl = (botId) => `https://discord.com/oauth2/authorize?${new URLSearchParams({
  client_id: botId, scope: 'bot applications.commands', permissions: String(INVITE_PERMS) })}`;

module.exports = () => {
  const r = express.Router();
  const cookieOpts = (maxAgeMs) => ({ httpOnly: true, sameSite: 'lax', secure: isSecure(), maxAge: maxAgeMs });

  // ---------- connexion Discord ----------
  r.get('/panel/login', (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie('ak_state', `${nonce}.${sign(nonce)}`, cookieOpts(10 * 60 * 1000));
    res.redirect(oauth.authUrl(panelApp(), nonce, { scope: 'identify guilds', redirect: panelRedirect() }));
  });

  r.get('/panel/callback', async (req, res) => {
    const [nonce, sig] = (parseCookies(req.headers.cookie).ak_state || '').split('.');
    if (!nonce || !sig || !safeEq(sig, sign(nonce)) || nonce !== req.query.state || !req.query.code) {
      return res.status(400).send('Connexion invalide ou expirée. Retourne sur /panel/ et réessaie.');
    }
    try {
      const t = await oauth.exchangeCode(panelApp(), String(req.query.code), panelRedirect());
      const [user, guilds] = await Promise.all([oauth.getUser(t.access_token), oauth.getUserGuilds(t.access_token)]);
      const sid = crypto.randomBytes(32).toString('hex');
      await db.createSession(sid, {
        user_id: user.id,
        username: user.global_name || user.username,
        avatar: user.avatar || null,
        guilds: guilds.filter(isAdmin).map((g) => ({ id: g.id, name: g.name, icon: g.icon || null })),
        expires: Math.floor(Date.now() / 1000) + SESSION_TTL,
      });
      res.cookie('sid', sid, cookieOpts(SESSION_TTL * 1000));
      res.clearCookie('ak_state');
      res.redirect('/panel/');
    } catch (e) {
      console.error(e);
      res.status(500).send('Erreur de connexion. Réessaie.');
    }
  });

  // ---------- API ----------
  const api = express.Router();
  api.use(express.json());

  api.use(async (req, res, next) => {
    // Anti-CSRF : un en-tête personnalisé ne peut pas être envoyé par un autre site sans autorisation
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'ak47') {
      return res.status(403).json({ error: 'Requête refusée.' });
    }
    const sid = parseCookies(req.headers.cookie).sid;
    const session = sid && /^[0-9a-f]{64}$/.test(sid) ? await db.getSession(sid) : null;
    if (!session) return res.status(401).json({ error: 'Non connecté.' });
    req.sid = sid;
    req.session = session;
    next();
  });

  // Un des bots de l'utilisateur qui est présent dans ce serveur
  const botIn = (userId, guildId) => manager.botsOf(userId).find((id) => manager.get(id).client.guilds.cache.has(guildId));

  // Serveur où l'utilisateur est admin ET où l'un de SES bots est présent
  const guildGuard = (req, res, next) => {
    const id = req.params.id;
    const botId = req.session.guilds.some((g) => g.id === id) && botIn(req.session.user_id, id);
    if (!botId) return res.status(404).json({ error: 'Serveur introuvable ou aucun de tes bots n\'y est.' });
    req.bot = { id: botId, ...manager.get(botId) };
    req.guild = req.bot.client.guilds.cache.get(id);
    next();
  };

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'Erreur interne.' });
  });

  api.get('/me', wrap(async (req, res) => {
    const s = req.session;
    const owned = await db.botsOwnedBy(s.user_id);
    res.json({
      user: { id: s.user_id, username: s.username, avatar: s.avatar },
      redirectUri: process.env.REDIRECT_URI,
      bots: owned.map((b) => ({ id: b.id, name: b.name || b.id, online: !!manager.get(b.id), inviteUrl: inviteUrl(b.id) })),
      guilds: s.guilds.map((g) => ({ ...g, botIn: !!botIn(s.user_id, g.id) })),
    });
  }));

  api.post('/logout', wrap(async (req, res) => {
    await db.deleteSession(req.sid);
    res.clearCookie('sid');
    res.json({ ok: true });
  }));

  // ----- bots -----
  api.post('/bots', wrap(async (req, res) => {
    const uid = req.session.user_id;
    const clientId = String(req.body.clientId || '').trim();
    const token = String(req.body.token || '').trim();
    const secret = String(req.body.clientSecret || '').trim();
    if (!/^\d{17,20}$/.test(clientId) || !token || token.length > 200 || !secret || secret.length > 100) {
      return res.status(400).json({ error: 'Client ID, token ou secret invalide.' });
    }
    const existing = await db.getBot(clientId);
    if (existing && existing.owner_id !== uid) return res.status(409).json({ error: 'Ce bot est déjà enregistré.' });
    if (!existing && manager.botsOf(uid).length >= MAX_BOTS_PER_USER) {
      return res.status(400).json({ error: `Maximum ${MAX_BOTS_PER_USER} bots par compte.` });
    }
    let name;
    try {
      name = await manager.launch({ id: clientId, token, secret, owner_id: uid });
    } catch (e) {
      const msg = /intent/i.test(e.message) ? 'Active « Server Members Intent » dans l\'onglet Bot de ton application, puis réessaie.'
        : e.code === 'IdMismatch' ? e.message
        : /token/i.test(e.message) || e.code === 'TokenInvalid' ? 'Token invalide.'
        : 'Connexion du bot impossible : vérifie le token.';
      return res.status(400).json({ error: msg });
    }
    await db.saveBot(clientId, { owner_id: uid, name, token: encrypt(token), secret: encrypt(secret), created: Date.now() });
    res.json({ ok: true, id: clientId, name });
  }));

  api.delete('/bots/:botId', wrap(async (req, res) => {
    const bot = await db.getBot(String(req.params.botId));
    if (!bot || bot.owner_id !== req.session.user_id) return res.status(404).json({ error: 'Bot introuvable.' });
    await manager.stop(bot.id);
    await db.deleteBotAndData(bot.id);
    res.json({ ok: true });
  }));

  // ----- serveurs -----
  api.get('/guilds/:id', guildGuard, wrap(async (req, res) => {
    const guild = req.guild;
    await guild.roles.fetch();
    await guild.channels.fetch();
    const [cfg, saved, members, managed, botTotal] = await Promise.all([
      db.getGuild(guild.id), db.count(guild.id), db.membersOf(guild.id, 100), db.guildsManagedBy(req.session.user_id),
      db.countBot(req.bot.id),
    ]);
    // Restaurer n'est possible que depuis un serveur géré par le même bot (les jetons sont liés à son application)
    const sources = await Promise.all(managed.filter((g) => g.id !== guild.id && g.bot_id === req.bot.id)
      .map(async (g) => ({ id: g.id, name: g.name || g.id, count: await db.count(g.id) })));
    res.json({
      id: guild.id,
      name: guild.name,
      botName: guild.client.user.username,
      roleId: cfg?.role_id || null,
      verifyUrl: cfg?.role_id ? verifymsg.verifyUrl(guild.id) : null,
      saved,
      botTotal,
      roles: [...guild.roles.cache.values()]
        .filter((x) => !x.managed && x.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((x) => ({ id: x.id, name: x.name })),
      channels: [...guild.channels.cache.values()].filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name })),
      sources: sources.filter((s) => s.count > 0),
      members: members.map((m) => ({ id: m.user_id, username: m.username, expires_at: m.expires_at })),
      restoring: restore.isRunning(guild.id),
    });
  }));

  api.post('/guilds/:id/settings', guildGuard, wrap(async (req, res) => {
    const guild = req.guild;
    await guild.roles.fetch();
    const role = guild.roles.cache.get(String(req.body.roleId));
    if (!role || role.managed || role.id === guild.id) return res.status(400).json({ error: 'Rôle invalide.' });
    if (guild.members.me.roles.highest.comparePositionTo(role) <= 0) {
      return res.status(400).json({ error: 'Place le rôle du bot au-dessus de ce rôle dans les paramètres du serveur.' });
    }
    const cfg = await db.getGuild(guild.id);
    if (cfg?.bot_id && cfg.bot_id !== req.bot.id && manager.get(cfg.bot_id)?.client.guilds.cache.has(guild.id)) {
      return res.status(409).json({ error: 'Ce serveur est déjà géré par un autre bot.' });
    }
    await db.upsertGuild(guild.id, { role_id: role.id, name: guild.name, owner_id: guild.ownerId, bot_id: req.bot.id },
      [req.session.user_id, guild.ownerId]);
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/announce', guildGuard, wrap(async (req, res) => {
    const cfg = await db.getGuild(req.guild.id);
    if (!cfg?.role_id) return res.status(400).json({ error: 'Choisis d\'abord un rôle.' });
    const channel = req.guild.channels.cache.get(String(req.body.channelId));
    if (!channel || channel.type !== 0) return res.status(400).json({ error: 'Salon invalide.' });
    try { await verifymsg.post(channel, req.guild.id); }
    catch { return res.status(400).json({ error: 'Le bot ne peut pas écrire dans ce salon.' }); }
    res.json({ ok: true });
  }));

  api.delete('/guilds/:id/members/:uid', guildGuard, wrap(async (req, res) => {
    await db.deleteMember(String(req.params.uid), req.guild.id);
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/restore', guildGuard, wrap(async (req, res) => {
    const source = String(req.body.source || '');
    if (source === req.guild.id || !source) return res.status(400).json({ error: 'La source doit être un autre serveur.' });
    if (source !== 'all') {
      const src = await db.getGuild(source);
      if (!(await restore.canManage(req.session.user_id, source))) {
        return res.status(403).json({ error: 'Tu n\'as pas configuré le bot sur ce serveur source.' });
      }
      if (src.bot_id !== req.bot.id) {
        return res.status(400).json({ error: 'Ce serveur utilisait un autre bot : invite ce même bot ici pour restaurer.' });
      }
    }
    if (restore.isRunning(req.guild.id)) return res.status(409).json({ error: 'Une restauration est déjà en cours.' });

    const jobId = await db.createJob({ user_id: req.session.user_id, source, target: req.guild.id,
      status: 'running', total: 0, done: 0, added: 0, already: 0, failed: 0, created: Date.now() });
    restore.run({ source, target: req.guild.id,
        bot: { id: req.bot.id, token: req.bot.token, secret: req.bot.secret },
        onProgress: (s) => db.updateJob(jobId, s) })
      .then(() => db.updateJob(jobId, { status: 'done' }))
      .catch((e) => { console.error(e); db.updateJob(jobId, { status: 'error' }); });
    res.json({ jobId });
  }));

  api.get('/jobs/:jobId', wrap(async (req, res) => {
    const job = await db.getJob(String(req.params.jobId));
    if (!job || job.user_id !== req.session.user_id) return res.status(404).json({ error: 'Introuvable.' });
    const { status, total, done, added, already, failed } = job;
    res.json({ status, total, done, added, already, failed });
  }));

  r.use('/api', api);
  r.use('/panel', express.static(path.join(__dirname, '..', 'public')));
  return r;
};
