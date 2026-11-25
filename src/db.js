// Stockage Firebase (Firestore) via le SDK Admin.
// Collections : bots, guilds, members, sessions, jobs
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const p = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'serviceAccountKey.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

admin.initializeApp({ credential: admin.credential.cert(loadCredential()) });
const store = admin.firestore();
const FV = admin.firestore.FieldValue;
const col = (n) => store.collection(n);
const memberId = (g, u) => `${g}_${u}`;
const withId = (d) => (d.exists ? { id: d.id, ...d.data() } : null);

async function deleteWhere(collection, field, value) {
  const snap = await col(collection).where(field, '==', value).get();
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = store.batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    n += Math.min(400, snap.docs.length - i);
  }
  return n;
}

module.exports = {
  // --- bots des utilisateurs (jeton et secret chiffres) ---
  saveBot: (id, data) => col('bots').doc(id).set(data),
  getBot: async (id) => withId(await col('bots').doc(id).get()),
  allBots: async () => (await col('bots').get()).docs.map(withId),
  botsOwnedBy: async (userId) => (await col('bots').where('owner_id', '==', userId).get()).docs.map(withId),
  deleteBotAndData: async (botId) => {
    await deleteWhere('members', 'bot_id', botId);
    await deleteWhere('guilds', 'bot_id', botId);
    await col('bots').doc(botId).delete();
  },

  // --- serveurs ---
  getGuild: async (id) => withId(await col('guilds').doc(id).get()),
  upsertGuild: (id, data, managers = []) =>
    col('guilds').doc(id).set(
      { ...data, ...(managers.length ? { managers: FV.arrayUnion(...managers) } : {}) },
      { merge: true }
    ),
  guildsManagedBy: async (userId) =>
    (await col('guilds').where('managers', 'array-contains', userId).get()).docs.map(withId),

  // --- membres ---
  saveMember: (m) => col('members').doc(memberId(m.guild_id, m.user_id)).set(m),
  membersOf: async (guildId, limit) => {
    let q = col('members').where('guild_id', '==', guildId);
    if (limit) q = q.limit(limit);
    return (await q.get()).docs.map((d) => d.data());
  },
  membersOfBot: async (botId) =>
    (await col('members').where('bot_id', '==', botId).get()).docs.map((d) => d.data()),
  countBot: async (botId) =>
    (await col('members').where('bot_id', '==', botId).count().get()).data().count,
  expiringBefore: async (ts) =>
    (await col('members').where('expires_at', '<', ts).get()).docs.map((d) => d.data()),
  deleteMember: (userId, guildId) => col('members').doc(memberId(guildId, userId)).delete(),
  deleteAllOfUser: (userId) => deleteWhere('members', 'user_id', userId),
  count: async (guildId) =>
    (await col('members').where('guild_id', '==', guildId).count().get()).data().count,

  // --- panels crees via l'API ---
  savePanel: (userId, data) => col('panels').doc(userId).set(data, { merge: true }),
  getPanel: async (userId) => withId(await col('panels').doc(userId).get()),

  // --- sessions du panel ---
  createSession: (sid, data) => col('sessions').doc(sid).set(data),
  getSession: async (sid) => {
    const s = withId(await col('sessions').doc(sid).get());
    if (s && s.expires < Date.now() / 1000) {
      await col('sessions').doc(sid).delete();
      return null;
    }
    return s;
  },
  deleteSession: (sid) => col('sessions').doc(sid).delete(),

  // --- jobs de restauration ---
  createJob: async (data) => (await col('jobs').add(data)).id,
  updateJob: (id, data) => col('jobs').doc(id).set(data, { merge: true }),
  getJob: async (id) => withId(await col('jobs').doc(id).get()),
};
