const path = require('path');
const express = require('express');
const db = require('./db');
const { encrypt } = require('./crypto');
const oauth = require('./oauth');
const manager = require('./botmanager');
const { sign, safeEq } = require('./util');
const { headers, limiter } = require('./security');
const verifypage = require('./verifypage');
const protection = require('./protection');
const audit = require('./audit');

const makeState = (guildId) => `${guildId}.${sign(guildId)}`;
const readState = (state = '') => {
  const [guildId, sig] = state.split('.');
  return guildId && sig && safeEq(sig, sign(guildId)) ? guildId : null;
};

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (title, body) => `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<style>
:root{--bg:#f4f5f1;--card:#fff;--ink:#1b1f16;--muted:#646b5a;--line:#e1e4d8}
@media(prefers-color-scheme:dark){:root{--bg:#14160f;--card:#1c1f15;--ink:#eceee4;--muted:#a0a692;--line:#2d3123}}
body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.c{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:32px 24px;text-align:center}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:0;color:var(--muted)}
</style><body><main class="c"><h1>${title}</h1><p>${body}</p></main></body></html>`;

const botFor = async (guildId) => {
  const cfg = await db.getGuild(guildId);
  const bot = cfg?.bot_id && manager.get(cfg.bot_id);
  return cfg && bot ? { cfg, bot, id: cfg.bot_id } : null;
};

exports.startWeb = () => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.use(headers);

  const publicLimit = limiter({ windowMs: 60000, max: 30 });
  app.use(['/verify', '/callback'], publicLimit);

  const logoUrl = (guildId, cfg) => (cfg.verify_page?.logo_v ? `/verify/logo/${guildId}?v=${cfg.verify_page.logo_v}` : null);

  app.get('/verify', async (req, res) => {
    const guildId = String(req.query.guild || '');
    const found = await botFor(guildId);
    if (!found?.cfg.role_id) return res.status(404).send(page('Serveur inconnu', 'Ce serveur n\'est pas configuré ou son bot est hors ligne.'));
    const guild = found.bot.client.guilds.cache.get(guildId);
    const pr = protection.resolve(found.cfg.protection);
    res.send(verifypage.render({
      stored: found.cfg.verify_page, guildId, guildName: guild?.name || found.cfg.name, ipCheck: pr.anti_alt || pr.anti_vpn, logIp: pr.log_ip, logEmail: pr.log_email,
      logoUrl: logoUrl(guildId, found.cfg) || guild?.iconURL({ size: 128, extension: 'png' }),
    }));
  });

  app.get('/verify/start', async (req, res) => {
    const guildId = String(req.query.guild || '');
    const found = await botFor(guildId);
    if (!found?.cfg.role_id) return res.status(404).send(page('Serveur inconnu', 'Ce serveur n\'est pas configuré ou son bot est hors ligne.'));
    const scope = protection.resolve(found.cfg.protection).log_email ? 'identify guilds.join email' : 'identify guilds.join';
    res.redirect(oauth.authUrl({ clientId: found.id }, makeState(guildId), { scope }));
  });

  app.get('/verify/logo/:guild', async (req, res) => {
    const logo = /^\d{17,20}$/.test(req.params.guild) ? await db.getLogo(req.params.guild) : null;
    if (!logo) return res.status(404).end();
    res.set({ 'Content-Type': logo.type, 'Cache-Control': 'public, max-age=3600' }).send(logo.data);
  });

  app.get('/callback', async (req, res) => {
    const guildId = readState(String(req.query.state || ''));
    if (!guildId || !req.query.code) return res.status(400).send(page('Erreur', 'Lien invalide ou expiré.'));
    try {
      const found = await botFor(guildId);
      if (!found) return res.status(404).send(page('Erreur', 'Le bot de ce serveur est hors ligne.'));
      const t = await oauth.exchangeCode({ clientId: found.id, clientSecret: found.bot.secret }, String(req.query.code));
      const user = await oauth.getUser(t.access_token);

      const blocked = await protection.check({ cfg: found.cfg, guildId, userId: user.id, ip: req.ip });
      if (blocked) {
        await oauth.revoke({ clientId: found.id, clientSecret: found.bot.secret }, t.access_token);
        await audit.log(guildId, { id: user.id, name: user.username, via: 'verify' }, 'verify.blocked', { reason: blocked.reason, ...blocked.detail });
        return res.status(403).send(page('Vérification refusée', protection.MESSAGES[blocked.reason]));
      }
      const pr = protection.resolve(found.cfg.protection);
      await protection.remember({ cfg: found.cfg, guildId, userId: user.id, ip: req.ip });

      await db.saveMember({
        user_id: user.id,
        guild_id: guildId,
        bot_id: found.id,
        username: user.username,
        ...(pr.log_ip && req.ip ? { ip: encrypt(req.ip) } : {}),
        ...(pr.log_email && user.email ? { email: encrypt(user.email) } : {}),
        access_token: encrypt(t.access_token),
        refresh_token: encrypt(t.refresh_token),
        expires_at: Math.floor(Date.now() / 1000) + t.expires_in,
      });
      const guild = found.bot.client.guilds.cache.get(guildId);
      const member = guild && (await guild.members.fetch(user.id).catch(() => null));
      if (member && found.cfg.role_id) await member.roles.add(found.cfg.role_id).catch(() => {});
      res.send(verifypage.render({
        stored: found.cfg.verify_page, guildId, guildName: guild?.name || found.cfg.name, kind: 'done',
        logoUrl: logoUrl(guildId, found.cfg) || guild?.iconURL({ size: 128, extension: 'png' }),
      }));
    } catch (e) {
      console.error(e);
      res.status(500).send(page('Erreur', 'Réessaie dans un instant.'));
    }
  });

  app.use('/v1', require('./api')());
  app.use(require('./panel')());
  app.get(['/docs', '/docs/'], (req, res) => res.sendFile(path.join(__dirname, '..', 'site', 'docs.html')));
  app.use(express.static(path.join(__dirname, '..', 'site'), { index: 'index.html', extensions: false }));
  app.listen(process.env.PORT || 3000, () => console.log('Web prêt'));
};
