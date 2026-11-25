const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const oauth = require('./oauth');
const restore = require('./restore');
const verifymsg = require('./verifymsg');
const verifypage = require('./verifypage');
const protection = require('./protection');
const { decrypt } = require('./crypto');
const manager = require('./botmanager');
const services = require('./services');
const schedule = require('./schedule');
const audit = require('./audit');
const { limiter, noStore } = require('./security');
const { encrypt } = require('./crypto');
const { sign, safeEq, parseCookies } = require('./util');

const SESSION_TTL = 7 * 24 * 3600;
const MAX_BOTS_PER_USER = Number(process.env.MAX_BOTS_PER_USER || 3);
const origin = () => new URL(process.env.REDIRECT_URI).origin;
const panelRedirect = () => `${origin()}/panel/callback`;
const isSecure = () => process.env.REDIRECT_URI.startsWith('https');
const isAdmin = (g) => g.owner || (BigInt(g.permissions) & 0x8n) === 0x8n;
const panelApp = () => ({ clientId: process.env.PANEL_CLIENT_ID, clientSecret: process.env.PANEL_CLIENT_SECRET });
const INVITE_PERMS = 268454913;
const inviteUrl = (botId) => `https://discord.com/oauth2/authorize?${new URLSearchParams({
  client_id: botId, scope: 'bot applications.commands', permissions: String(INVITE_PERMS) })}`;

const safeDecrypt = (v) => { try { return decrypt(v); } catch { return null; } };

module.exports = () => {
  const r = express.Router();
  const authLimit = limiter({ windowMs: 10 * 60 * 1000, max: 30 });
  const apiLimit = limiter({ windowMs: 60 * 1000, max: 300 });
  const sensitiveLimit = limiter({ windowMs: 10 * 60 * 1000, max: 10, message: 'Trop de tentatives, réessaie dans quelques minutes.' });
  const restoreLimit = limiter({ windowMs: 10 * 60 * 1000, max: 5, message: 'Trop de restaurations lancées, réessaie dans quelques minutes.' });
  const actorOf = (req) => ({ id: req.session.user_id, name: req.session.username, via: 'panel' });
  const cookieOpts = (maxAgeMs) => ({ httpOnly: true, sameSite: 'lax', secure: isSecure(), maxAge: maxAgeMs });

  r.get('/panel/login', authLimit, (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie('ak_state', `${nonce}.${sign(nonce)}`, cookieOpts(10 * 60 * 1000));
    res.redirect(oauth.authUrl(panelApp(), nonce, { scope: 'identify guilds', redirect: panelRedirect() }));
  });

  r.get('/panel/callback', authLimit, async (req, res) => {
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

  const api = express.Router();
  api.use(noStore, apiLimit, express.json({ limit: '10kb' }));

  api.use(async (req, res, next) => {
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

  const botIn = (userId, guildId) => manager.botsOf(userId).find((id) => manager.get(id).client.guilds.cache.has(guildId));

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

  const MAX_KEYS = 5;
  api.get('/keys', wrap(async (req, res) => {
    const keys = (await db.apiKeysOf(req.session.user_id)).sort((a, b) => b.created - a.created)
      .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, created: k.created, last_used: k.last_used || null }));
    res.json({ keys });
  }));

  api.post('/keys', sensitiveLimit, wrap(async (req, res) => {
    const uid = req.session.user_id;
    const name = String(req.body.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Ma clé';
    if ((await db.apiKeysOf(uid)).length >= MAX_KEYS) return res.status(400).json({ error: `Maximum ${MAX_KEYS} clés. Révoque-en une d'abord.` });
    const key = 'ak_' + crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const id = await db.createApiKey({ user_id: uid, name, hash, prefix: key.slice(0, 8), created: Date.now(), last_used: null });
    res.status(201).json({ id, name, key });
  }));

  api.delete('/keys/:id', wrap(async (req, res) => {
    if (!(await db.deleteApiKey(String(req.params.id), req.session.user_id))) return res.status(404).json({ error: 'Clé introuvable.' });
    res.json({ ok: true });
  }));

  api.post('/bots', sensitiveLimit, wrap(async (req, res) => {
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

  api.delete('/bots/:botId', sensitiveLimit, wrap(async (req, res) => {
    const bot = await db.getBot(String(req.params.botId));
    if (!bot || bot.owner_id !== req.session.user_id) return res.status(404).json({ error: 'Bot introuvable.' });
    const actor = actorOf(req);
    const cfgs = await Promise.all((await db.guildsManagedBy(req.session.user_id)).filter((g) => g.bot_id === bot.id).map((g) => db.getGuild(g.id)));
    const total = await db.countBot(bot.id);
    if (total > 0) {
      await Promise.all(cfgs.filter(Boolean).map((g) => audit.alert({ guildId: g.id, botId: bot.id, level: 'danger',
        title: 'Bot supprimé avec ses membres sauvegardés',
        lines: [`**${bot.name || bot.id}** supprimé par ${actor.name} (${actor.id}).`, `**${total}** membres sauvegardés effacés définitivement.`] })));
    }
    await manager.stop(bot.id);
    const { guildIds } = await db.deleteBotAndData(bot.id);
    await Promise.all(guildIds.map((gid) => audit.log(gid, actor, 'bot.delete', { bot: bot.name || bot.id, members_deleted: total })));
    res.json({ ok: true });
  }));

  api.get('/guilds/:id', guildGuard, wrap(async (req, res) => {
    const guild = req.guild;
    await guild.roles.fetch();
    await guild.channels.fetch();
    const [cfg, saved, members, managed, botTotal, log] = await Promise.all([
      db.getGuild(guild.id), db.count(guild.id), db.membersOf(guild.id, 100), db.guildsManagedBy(req.session.user_id),
      db.countBot(req.bot.id), db.listAudit(guild.id, 50),
    ]);
    const schedules = await schedule.list(guild.id);
    const sources = await Promise.all(managed.filter((g) => g.id !== guild.id && g.bot_id === req.bot.id)
      .map(async (g) => ({ id: g.id, name: g.name || g.id, count: await db.count(g.id) })));
    res.json({
      id: guild.id,
      name: guild.name,
      botName: guild.client.user.username,
      roleId: cfg?.role_id || null,
      alertChannelId: cfg?.alert_channel_id || null,
      massRestore: audit.MASS_RESTORE,
      audit: log.map((a) => ({ id: a.id, ts: a.ts, actor: a.actor_name || a.actor_id || '—', actor_id: a.actor_id, via: a.via, action: a.action, detail: a.detail || {} })),
      protection: { ...protection.resolve(cfg?.protection), blacklist: cfg?.blacklist || [], maxBlacklist: protection.MAX_BLACKLIST, maxAge: protection.MAX_AGE_DAYS },
      verifyUrl: cfg?.role_id ? verifymsg.verifyUrl(guild.id) : null,
      page: {
        values: { ...verifypage.DEFAULTS, ...Object.fromEntries(Object.entries(cfg?.verify_page || {}).filter(([k, v]) => k in verifypage.DEFAULTS && v)) },
        custom: Object.keys(verifypage.DEFAULTS).filter((k) => cfg?.verify_page?.[k]),
        defaults: verifypage.DEFAULTS,
        logoUrl: cfg?.verify_page?.logo_v ? `/verify/logo/${guild.id}?v=${cfg.verify_page.logo_v}` : null,
        serverIcon: guild.iconURL({ size: 128, extension: 'png' }),
        serverName: guild.name,
      },
      saved,
      botTotal,
      roles: [...guild.roles.cache.values()]
        .filter((x) => !x.managed && x.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((x) => ({ id: x.id, name: x.name })),
      channels: [...guild.channels.cache.values()].filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name })),
      sources: sources.filter((s) => s.count > 0),
      members: members.map((m) => ({ id: m.user_id, username: m.username, expires_at: m.expires_at,
        ip: m.ip ? safeDecrypt(m.ip) : null, email: m.email ? safeDecrypt(m.email) : null })),
      restoring: restore.isRunning(guild.id),
      schedules,
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
    await audit.log(guild.id, actorOf(req), 'settings.role', { role: role.name });
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/page', guildGuard, wrap(async (req, res) => {
    let page;
    try { page = verifypage.sanitize(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const cfg = await db.getGuild(req.guild.id);
    await db.upsertGuild(req.guild.id,
      { verify_page: { ...page, logo_v: cfg?.verify_page?.logo_v || null }, name: req.guild.name, bot_id: req.bot.id }, [req.session.user_id]);
    await audit.log(req.guild.id, actorOf(req), 'settings.page', {});
    res.json({ ok: true });
  }));

  const logoTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const setLogoVersion = async (req, v) => {
    const cfg = await db.getGuild(req.guild.id);
    await db.upsertGuild(req.guild.id,
      { verify_page: { ...(cfg?.verify_page || {}), logo_v: v }, name: req.guild.name, bot_id: req.bot.id }, [req.session.user_id]);
  };

  api.put('/guilds/:id/page/logo', guildGuard, express.raw({ type: logoTypes, limit: verifypage.LOGO_MAX }), wrap(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Image PNG, JPEG, GIF ou WebP de 200 Ko maximum.' });
    const type = verifypage.sniffImage(buf);
    if (!type) return res.status(400).json({ error: 'Format non reconnu (PNG, JPEG, GIF ou WebP).' });
    await db.saveLogo(req.guild.id, buf, type);
    await setLogoVersion(req, Date.now());
    await audit.log(req.guild.id, actorOf(req), 'settings.page', { logo: 'défini' });
    res.json({ ok: true });
  }));

  api.delete('/guilds/:id/page/logo', guildGuard, wrap(async (req, res) => {
    await db.deleteLogo(req.guild.id);
    await setLogoVersion(req, null);
    await audit.log(req.guild.id, actorOf(req), 'settings.page', { logo: 'retiré' });
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/protection', guildGuard, wrap(async (req, res) => {
    let prot;
    try { prot = protection.sanitize(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    await db.upsertGuild(req.guild.id, { protection: prot, name: req.guild.name, bot_id: req.bot.id }, [req.session.user_id]);
    await audit.log(req.guild.id, actorOf(req), 'settings.protection', prot);
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/blacklist', guildGuard, sensitiveLimit, wrap(async (req, res) => {
    const uid = String(req.body.userId || '').trim().replace(/^<@!?(\d+)>$/, '$1');
    if (!protection.isSnowflake(uid)) return res.status(400).json({ error: 'ID Discord invalide (17 à 20 chiffres).' });
    if (uid === req.session.user_id || uid === req.guild.ownerId) return res.status(400).json({ error: 'Impossible de blacklister le propriétaire ou toi-même.' });
    const cfg = await db.getGuild(req.guild.id);
    const list = cfg?.blacklist || [];
    if (!list.includes(uid) && list.length >= protection.MAX_BLACKLIST) {
      return res.status(400).json({ error: `Liste noire pleine (${protection.MAX_BLACKLIST} maximum).` });
    }
    await db.addBlacklist(req.guild.id, uid);
    await db.deleteMember(uid, req.guild.id);
    await audit.log(req.guild.id, actorOf(req), 'blacklist.add', { user_id: uid });
    res.json({ ok: true });
  }));

  api.delete('/guilds/:id/blacklist/:uid', guildGuard, wrap(async (req, res) => {
    const uid = String(req.params.uid);
    if (!protection.isSnowflake(uid)) return res.status(400).json({ error: 'ID invalide.' });
    await db.removeBlacklist(req.guild.id, uid);
    await audit.log(req.guild.id, actorOf(req), 'blacklist.remove', { user_id: uid });
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/announce', guildGuard, wrap(async (req, res) => {
    const cfg = await db.getGuild(req.guild.id);
    if (!cfg?.role_id) return res.status(400).json({ error: 'Choisis d\'abord un rôle.' });
    const channel = req.guild.channels.cache.get(String(req.body.channelId));
    if (!channel || channel.type !== 0) return res.status(400).json({ error: 'Salon invalide.' });
    try { await verifymsg.post(channel, req.guild.id, cfg.verify_page); }
    catch { return res.status(400).json({ error: 'Le bot ne peut pas écrire dans ce salon.' }); }
    await audit.log(req.guild.id, actorOf(req), 'verify.announce', { channel: channel.name });
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/alerts', guildGuard, wrap(async (req, res) => {
    const raw = String(req.body.channelId || '');
    let channel = null;
    if (raw) {
      channel = req.guild.channels.cache.get(raw);
      if (!channel || channel.type !== 0) return res.status(400).json({ error: 'Salon invalide.' });
      const me = req.guild.members.me;
      if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        return res.status(400).json({ error: 'Le bot ne peut pas écrire (ou intégrer des liens) dans ce salon.' });
      }
    }
    await db.upsertGuild(req.guild.id, { alert_channel_id: channel ? channel.id : null, name: req.guild.name, bot_id: req.bot.id }, [req.session.user_id]);
    await audit.log(req.guild.id, actorOf(req), 'settings.alerts', { channel: channel ? channel.name : null });
    if (channel) {
      await audit.alert({ guildId: req.guild.id, botId: req.bot.id, level: 'info', title: 'Alertes activées',
        lines: [`Ce salon recevra les alertes de sécurité (restauration ou suppression massive).`, `Activé par ${req.session.username}.`] });
    }
    res.json({ ok: true });
  }));

  api.delete('/guilds/:id/members/:uid', guildGuard, wrap(async (req, res) => {
    const uid = String(req.params.uid);
    await db.deleteMember(uid, req.guild.id);
    const actor = actorOf(req);
    await audit.log(req.guild.id, actor, 'member.remove', { user_id: uid });
    audit.noteMemberRemoval(req.guild.id, req.bot.id, actor);
    res.json({ ok: true });
  }));

  api.post('/guilds/:id/restore', guildGuard, restoreLimit, wrap(async (req, res) => {
    try {
      const jobId = await services.startRestore({ userId: req.session.user_id, guildId: req.guild.id, source: req.body.source, actor: actorOf(req) });
      res.json({ jobId });
    } catch (e) {
      if (e instanceof services.ApiError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }));

  api.post('/guilds/:id/restore/schedule', guildGuard, restoreLimit, wrap(async (req, res) => {
    try {
      const out = await schedule.create({ userId: req.session.user_id, guildId: req.guild.id, source: req.body.source,
        runAt: schedule.parseRunAt(req.body.runAt), actor: actorOf(req) });
      res.json(out);
    } catch (e) {
      if (e instanceof services.ApiError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }));

  api.delete('/guilds/:id/restore/schedule/:sid', guildGuard, wrap(async (req, res) => {
    try {
      await schedule.cancel({ guildId: req.guild.id, scheduleId: req.params.sid, actor: actorOf(req) });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof services.ApiError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }));

  api.get('/jobs/:jobId', wrap(async (req, res) => {
    const job = await db.getJob(String(req.params.jobId));
    if (!job || job.user_id !== req.session.user_id) return res.status(404).json({ error: 'Introuvable.' });
    const { status, total, done, added, already, failed } = job;
    res.json({ status, total, done, added, already, failed });
  }));

  api.use((err, _req, res, _next) => {
    if (err.status === 413 || err.type === 'entity.too.large') return res.status(413).json({ error: 'Image trop lourde (200 Ko maximum).' });
    console.error(err);
    res.status(err.status || 500).json({ error: 'Requête invalide.' });
  });

  r.use('/api', api);
  r.use('/panel', express.static(path.join(__dirname, '..', 'public')));
  return r;
};
