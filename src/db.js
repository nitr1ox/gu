const Database = require('better-sqlite3');
const db = new Database('data.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  role_id  TEXT
);
CREATE TABLE IF NOT EXISTS members (
  user_id       TEXT NOT NULL,
  guild_id      TEXT NOT NULL,
  username      TEXT,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, guild_id)
);
`);

module.exports = {
  setGuild: (guildId, roleId) =>
    db.prepare('INSERT INTO guilds (guild_id, role_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET role_id = excluded.role_id').run(guildId, roleId),
  getGuild: (guildId) => db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId),
  saveMember: (m) =>
    db.prepare(`INSERT INTO members (user_id, guild_id, username, access_token, refresh_token, expires_at)
      VALUES (@user_id, @guild_id, @username, @access_token, @refresh_token, @expires_at)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET username=excluded.username,
      access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at`).run(m),
  membersOf: (guildId) => db.prepare('SELECT * FROM members WHERE guild_id = ?').all(guildId),
  expiringBefore: (ts) => db.prepare('SELECT * FROM members WHERE expires_at < ?').all(ts),
  deleteMember: (userId, guildId) => db.prepare('DELETE FROM members WHERE user_id = ? AND guild_id = ?').run(userId, guildId),
  deleteAllOfUser: (userId) => db.prepare('DELETE FROM members WHERE user_id = ?').run(userId),
  count: (guildId) => db.prepare('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?').get(guildId).n,
};
