const express = require('express');
const db = require('./db');
const { encrypt } = require('./crypto');
const oauth = require('./oauth');
const manager = require('./botmanager');
const { sign, safeEq } = require('./util');

const makeState = (guildId) => `${guildId}.${sign(guildId)}`;
const readState = (state = '') => {
  const [guildId, sig] = state.split('.');
  return guildId && sig && safeEq(sig, sign(guildId)) ? guildId : null;
};

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;background:#e8eae0;color:#1f2418;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;padding:24px;text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`;

// Retrouve le bot (en ligne) qui gere ce serveur
const botFor = async (guildId) => {
  const cfg = await db.getGuild(guildId);
  const bot = cfg?.bot_id && manager.get(cfg.bot_id);
  return cfg && bot ? { cfg, bot, id: cfg.bot_id } : null;
};

exports.startWeb = () => {
  const app = express();
  app.disable('x-powered-by');

  app.get('/verify', async (req, res) => {
    const found = await botFor(String(req.query.guild || ''));
    if (!found?.cfg.role_id) return res.status(404).send(page('Serveur inconnu', 'Ce serveur n\'est pas configuré ou son bot est hors ligne.'));
    res.redirect(oauth.authUrl({ clientId: found.id }, makeState(req.query.guild)));
  });

  app.get('/callback', async (req, res) => {
    const guildId = readState(String(req.query.state || ''));
    if (!guildId || !req.query.code) return res.status(400).send(page('Erreur', 'Lien invalide ou expiré.'));
    try {
      const found = await botFor(guildId);
      if (!found) return res.status(404).send(page('Erreur', 'Le bot de ce serveur est hors ligne.'));
      const t = await oauth.exchangeCode({ clientId: found.id, clientSecret: found.bot.secret }, String(req.query.code));
      const user = await oauth.getUser(t.access_token);
      await db.saveMember({
        user_id: user.id,
        guild_id: guildId,
        bot_id: found.id,
        username: user.username,
        access_token: encrypt(t.access_token),
        refresh_token: encrypt(t.refresh_token),
        expires_at: Math.floor(Date.now() / 1000) + t.expires_in,
      });
      const guild = found.bot.client.guilds.cache.get(guildId);
      const member = guild && (await guild.members.fetch(user.id).catch(() => null));
      if (member && found.cfg.role_id) await member.roles.add(found.cfg.role_id).catch(() => {});
      res.send(page('Vérifié ✅', 'Tu peux retourner sur Discord.'));
    } catch (e) {
      console.error(e);
      res.status(500).send(page('Erreur', 'Réessaie dans un instant.'));
    }
  });

  app.use(require('./panel')());
  app.get('/', (_req, res) => res.redirect('/panel/'));
  app.listen(process.env.PORT || 3000, () => console.log('Web prêt'));
};
