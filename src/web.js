const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { encrypt } = require('./crypto');
const oauth = require('./oauth');

const sign = (data) => crypto.createHmac('sha256', process.env.STATE_SECRET).update(data).digest('hex');
const makeState = (guildId) => `${guildId}.${sign(guildId)}`;
const readState = (state = '') => {
  const [guildId, sig] = state.split('.');
  if (!guildId || !sig) return null;
  const ok = sig.length === sign(guildId).length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(guildId)));
  return ok ? guildId : null;
};

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;background:#1e1f22;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;padding:24px;text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`;

exports.startWeb = (client) => {
  const app = express();

  app.get('/verify', (req, res) => {
    const guildId = String(req.query.guild || '');
    if (!db.getGuild(guildId)) return res.status(404).send(page('Serveur inconnu', 'Ce serveur n\'est pas configure.'));
    res.redirect(oauth.authUrl(makeState(guildId)));
  });

  app.get('/callback', async (req, res) => {
    const guildId = readState(String(req.query.state || ''));
    if (!guildId || !req.query.code) return res.status(400).send(page('Erreur', 'Lien invalide ou expire.'));
    try {
      const t = await oauth.exchangeCode(String(req.query.code));
      const user = await oauth.getUser(t.access_token);
      db.saveMember({
        user_id: user.id,
        guild_id: guildId,
        username: user.username,
        access_token: encrypt(t.access_token),
        refresh_token: encrypt(t.refresh_token),
        expires_at: Math.floor(Date.now() / 1000) + t.expires_in,
      });
      const cfg = db.getGuild(guildId);
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      const member = guild && (await guild.members.fetch(user.id).catch(() => null));
      if (member && cfg?.role_id) await member.roles.add(cfg.role_id).catch(() => {});
      res.send(page('Verifie ✅', 'Tu peux retourner sur Discord.'));
    } catch (e) {
      console.error(e);
      res.status(500).send(page('Erreur', 'Reessaie dans un instant.'));
    }
  });

  app.get('/', (_req, res) => res.send(page('ak47bot', 'Service de sauvegarde de membres Discord.')));
  app.listen(process.env.PORT || 3000, () => console.log('Web pret'));
};
