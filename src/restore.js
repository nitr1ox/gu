const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const oauth = require('./oauth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = new Set();

exports.canManage = async (userId, guildId) => {
  const g = await db.getGuild(guildId);
  return !!g && (g.managers || []).includes(userId);
};

exports.isRunning = (target) => running.has(target);

exports.run = async ({ source, target, bot, onProgress = () => {} }) => {
  if (running.has(target)) throw new Error('Une restauration est deja en cours pour ce serveur.');
  running.add(target);
  const app = { clientId: bot.id, clientSecret: bot.secret };
  const stats = { total: 0, done: 0, added: 0, already: 0, failed: 0 };
  try {
    const members = source === 'all' ? await db.membersOfBot(bot.id) : await db.membersOf(source);
    stats.total = members.length;
    await onProgress({ ...stats });
    for (const m of members) {
      try {
        if (m.bot_id !== bot.id) throw new Error('autre bot');
        let access = decrypt(m.access_token);
        if (m.expires_at < Date.now() / 1000 + 60) {
          const t = await oauth.refresh(app, decrypt(m.refresh_token));
          access = t.access_token;
          await db.saveMember({ ...m, access_token: encrypt(t.access_token), refresh_token: encrypt(t.refresh_token),
            expires_at: Math.floor(Date.now() / 1000) + t.expires_in });
        }
        const res = await oauth.addMember(bot.token, target, m.user_id, access);
        if (res === 'added') stats.added++; else if (res === 'already') stats.already++; else stats.failed++;
      } catch (e) {
        stats.failed++;
        if (e.code === 'invalid_grant') await db.deleteMember(m.user_id, m.guild_id);
      }
      stats.done++;
      if (stats.done % 5 === 0) await onProgress({ ...stats });
      await sleep(1100);
    }
    await onProgress({ ...stats });
    return stats;
  } finally {
    running.delete(target);
  }
};
