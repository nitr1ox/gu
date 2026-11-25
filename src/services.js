const db = require('./db');
const manager = require('./botmanager');
const restore = require('./restore');
const audit = require('./audit');

const ADMIN = 0x8n;
const INVITE_PERMS = 268454913;

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
exports.ApiError = ApiError;

exports.origin = () => new URL(process.env.REDIRECT_URI).origin;
exports.panelUrl = () => `${exports.origin()}/panel/`;
exports.inviteUrl = (botId) => `https://discord.com/oauth2/authorize?${new URLSearchParams({
  client_id: botId, scope: 'bot applications.commands', permissions: String(INVITE_PERMS) })}`;

const isGuildAdmin = async (guild, userId) => {
  if (guild.ownerId === userId) return true;
  const m = await guild.members.fetch(userId).catch(() => null);
  return !!m && m.permissions.has(ADMIN);
};

exports.findGuild = async (userId, guildId) => {
  for (const botId of manager.botsOf(userId)) {
    const b = manager.get(botId);
    const guild = b.client.guilds.cache.get(guildId);
    if (guild && (await isGuildAdmin(guild, userId))) return { bot: { id: botId, ...b }, guild };
  }
  return null;
};

exports.overview = async (userId) => {
  const owned = await db.botsOwnedBy(userId);
  const bots = await Promise.all(owned.map(async (b) => {
    const live = manager.get(b.id);
    const guilds = live ? [...live.client.guilds.cache.values()].slice(0, 50) : [];
    return {
      id: b.id,
      name: b.name || b.id,
      online: !!live,
      invite_url: exports.inviteUrl(b.id),
      saved_members: await db.countBot(b.id),
      guilds: await Promise.all(guilds.map(async (g) => {
        const cfg = await db.getGuild(g.id);
        return { id: g.id, name: g.name, configured: !!(cfg?.bot_id === b.id && cfg?.role_id), saved_members: await db.count(g.id) };
      })),
    };
  }));
  return {
    bots,
    totals: { bots: bots.length, saved_members: bots.reduce((n, b) => n + b.saved_members, 0) },
  };
};

exports.guildStats = async (userId, guildId) => {
  const found = await exports.findGuild(userId, guildId);
  if (!found) throw new ApiError(404, "Serveur introuvable, ou tu n'y es pas admin avec un de tes bots.");
  const cfg = await db.getGuild(guildId);
  const [saved, botTotal] = await Promise.all([db.count(guildId), db.countBot(found.bot.id)]);
  return {
    guild: { id: guildId, name: found.guild.name, member_count: found.guild.memberCount },
    bot: { id: found.bot.id, name: found.guild.client.user.username },
    configured: !!cfg?.role_id,
    saved_members: saved,
    bot_total_saved_members: botTotal,
    restoring: restore.isRunning(guildId),
  };
};

exports.validateRestore = async ({ userId, guildId, source }) => {
  source = String(source || '');
  const found = await exports.findGuild(userId, guildId);
  if (!found) throw new ApiError(404, "Serveur introuvable, ou tu n'y es pas admin avec un de tes bots.");
  const { bot } = found;
  if (!source || source === guildId) throw new ApiError(400, 'La source doit être un autre serveur.');
  if (source !== 'all') {
    const src = await db.getGuild(source);
    if (!src || !(await restore.canManage(userId, source))) throw new ApiError(403, "Tu n'as pas configuré le bot sur ce serveur source.");
    if (src.bot_id !== bot.id) throw new ApiError(400, 'Ce serveur utilisait un autre bot : invite ce même bot ici pour restaurer.');
  }
  const expected = source === 'all' ? await db.countBot(bot.id) : await db.count(source);
  const srcName = source === 'all' ? `tous les membres du bot ${found.guild.client.user.username}` : ((await db.getGuild(source))?.name || source);
  return { found, bot, expected, srcName };
};

exports.startRestore = async ({ userId, guildId, source, actor }) => {
  actor = actor || { id: userId, name: userId, via: 'panel' };
  source = String(source || '');
  const { found, bot, expected, srcName } = await exports.validateRestore({ userId, guildId, source });
  if (restore.isRunning(guildId)) throw new ApiError(409, 'Une restauration est déjà en cours.');

  const jobId = await db.createJob({ user_id: userId, source, target: guildId,
    status: 'running', total: 0, done: 0, added: 0, already: 0, failed: 0, created: Date.now() });
  await audit.log(guildId, actor, 'restore.start', { source, source_name: srcName, expected, job_id: jobId });
  if (expected >= audit.MASS_RESTORE) {
    audit.alert({ guildId, botId: bot.id, level: 'danger', title: 'Restauration massive lancée',
      lines: [`**${expected}** membres vont être ajoutés dans **${found.guild.name}**.`,
        `Source : ${srcName}`, `Lancé par : ${actor.name || actor.id} (${actor.id}) via ${actor.via}`] });
  }
  let last = {};
  restore.run({ source, target: guildId,
      bot: { id: bot.id, token: bot.token, secret: bot.secret },
      onProgress: (s) => { last = s; return db.updateJob(jobId, s); } })
    .then(() => {
      db.updateJob(jobId, { status: 'done' });
      audit.log(guildId, actor, 'restore.end', { job_id: jobId, status: 'done', added: last.added, already: last.already, failed: last.failed, total: last.total });
    })
    .catch((e) => {
      console.error(e);
      db.updateJob(jobId, { status: 'error' });
      audit.log(guildId, actor, 'restore.end', { job_id: jobId, status: 'error', added: last.added, failed: last.failed, total: last.total });
    });
  return jobId;
};
