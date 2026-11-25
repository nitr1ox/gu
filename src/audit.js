const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const manager = require('./botmanager');

const MASS_RESTORE = Number(process.env.ALERT_MASS_RESTORE || 50);
const MASS_DELETE = Number(process.env.ALERT_MASS_DELETE || 10);
const MASS_DELETE_WINDOW = 10 * 60 * 1000;
exports.MASS_RESTORE = MASS_RESTORE;

const COLORS = { info: 0x5865f2, warn: 0xf0a020, danger: 0xd83c3e };

exports.log = async (guildId, actor, action, detail = {}) => {
  try {
    await db.addAudit(guildId, {
      ts: Date.now(),
      actor_id: actor?.id || null,
      actor_name: String(actor?.name || '').slice(0, 64),
      via: actor?.via || 'panel',
      action,
      detail,
    });
  } catch (e) { console.error('audit', e.message); }
};

exports.alert = async ({ guildId, botId, level = 'warn', title, lines = [] }) => {
  const text = lines.join('\n').slice(0, 1800);
  try {
    const cfg = guildId ? await db.getGuild(guildId) : null;
    const bot = manager.get(botId || cfg?.bot_id);
    if (cfg?.alert_channel_id && bot) {
      const ch = await bot.client.channels.fetch(cfg.alert_channel_id).catch(() => null);
      if (ch?.send) {
        const embed = new EmbedBuilder().setColor(COLORS[level]).setTitle(title).setDescription(text).setTimestamp();
        await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
      }
    }
  } catch (e) { console.error('alert salon', e.message); }

  const hook = process.env.ALERT_WEBHOOK_URL;
  if (hook) {
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowed_mentions: { parse: [] },
          embeds: [{ title: title, description: `${guildId ? `Serveur \`${guildId}\`\n` : ''}${text}`, color: COLORS[level], timestamp: new Date().toISOString() }],
        }),
      });
    } catch (e) { console.error('alert webhook', e.message); }
  }
};

const deletions = new Map();
exports.noteMemberRemoval = (guildId, botId, actor) => {
  const now = Date.now();
  let d = deletions.get(guildId);
  if (!d || now - d.start > MASS_DELETE_WINDOW) { d = { n: 0, start: now, alerted: false }; deletions.set(guildId, d); }
  d.n++;
  if (d.n >= MASS_DELETE && !d.alerted) {
    d.alerted = true;
    exports.alert({ guildId, botId, level: 'danger', title: 'Suppression massive de membres sauvegardés',
      lines: [`${d.n} membres retirés en moins de ${Math.round(MASS_DELETE_WINDOW / 60000)} min.`, `Par : ${actor.name || actor.id} (${actor.id})`] });
    exports.log(guildId, actor, 'members.mass_removal', { count: d.n });
  }
};
