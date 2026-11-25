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
  // Retourne { members, guildIds } pour le journal / les alertes
  deleteBotAndData: async (botId) => {
    const guildIds = (await col('guilds').where('bot_id', '==', botId).get()).docs.map((d) => d.id);
    const members = await deleteWhere('members', 'bot_id', botId);
    await Promise.all(guildIds.map((g) => col('guild_logos').doc(g).delete()));
    await deleteWhere('guilds', 'bot_id', botId);
    await deleteWhere('schedules', 'bot_id', botId); // restaurations planifiées de ce bot
    await Promise.all(guildIds.map((g) => deleteWhere('ip_hashes', 'guild_id', g)));
    await col('bots').doc(botId).delete();
    return { members, guildIds };
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

  // --- logo de la page de vérification (collection a part : le document du serveur reste leger) ---
  saveLogo: (guildId, buf, type) => col('guild_logos').doc(guildId).set({ data: buf, type, ts: Date.now() }),
  getLogo: async (guildId) => {
    const d = await col('guild_logos').doc(guildId).get();
    return d.exists ? { data: Buffer.from(d.data().data), type: d.data().type } : null;
  },
  deleteLogo: (guildId) => col('guild_logos').doc(guildId).delete(),

  // --- journal d'activité (sous-collection : pas d'index composite nécessaire) ---
  addAudit: (guildId, entry) => col('guilds').doc(guildId).collection('audit').add(entry),
  listAudit: async (guildId, limit = 50) =>
    (await col('guilds').doc(guildId).collection('audit').orderBy('ts', 'desc').limit(limit).get()).docs.map(withId),

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
  // Retire aussi l'empreinte IP (anti-alts) du membre pour ce serveur
  deleteMember: async (userId, guildId) => {
    await col('members').doc(memberId(guildId, userId)).delete();
    const snap = await col('ip_hashes').where('guild_id', '==', guildId).where('user_id', '==', userId).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  },
  deleteAllOfUser: async (userId) => {
    const n = await deleteWhere('members', 'user_id', userId);
    return n + (await deleteWhere('ip_hashes', 'user_id', userId));
  },

  // --- anti-alts : empreinte IP (HMAC, jamais l'IP en clair) -> membre, par serveur ---
  getIpOwner: async (guildId, hash) => {
    const d = await col('ip_hashes').doc(`${guildId}_${hash}`).get();
    return d.exists ? d.data().user_id : null;
  },
  saveIp: (guildId, hash, userId) =>
    col('ip_hashes').doc(`${guildId}_${hash}`).set({ guild_id: guildId, user_id: userId, ts: Date.now() }),

  // --- liste noire (tableau d'IDs dans le document du serveur) ---
  addBlacklist: (guildId, userId) => col('guilds').doc(guildId).set({ blacklist: FV.arrayUnion(userId) }, { merge: true }),
  removeBlacklist: (guildId, userId) => col('guilds').doc(guildId).set({ blacklist: FV.arrayRemove(userId) }, { merge: true }),
  count: async (guildId) =>
    (await col('members').where('guild_id', '==', guildId).count().get()).data().count,

  // --- panels crees via l'API ---
  // --- clés d'API personnelles (seul le hash SHA-256 est stocké) ---
  createApiKey: async (data) => (await col('api_keys').add(data)).id,
  apiKeysOf: async (userId) => (await col('api_keys').where('user_id', '==', userId).get()).docs.map(withId),
  getApiKeyByHash: async (hash) => {
    const snap = await col('api_keys').where('hash', '==', hash).limit(1).get();
    return snap.empty ? null : withId(snap.docs[0]);
  },
  touchApiKey: (id) => col('api_keys').doc(id).update({ last_used: Date.now() }),
  deleteApiKey: async (id, userId) => {
    const d = await col('api_keys').doc(id).get();
    if (!d.exists || d.data().user_id !== userId) return false;
    await d.ref.delete();
    return true;
  },

  savePanel: (userId, data) => col('panels').doc(userId).set(data, { merge: true }),
  getPanel: async (userId) => withId(await col('panels').doc(userId).get()),

  // --- restaurations planifiees (collection schedules) ---
  // status : pending -> running -> started | failed | missed, ou cancelled
  createSchedule: async (data) => (await col('schedules').add(data)).id,
  getSchedule: async (id) => withId(await col('schedules').doc(id).get()),
  updateSchedule: (id, data) => col('schedules').doc(id).set(data, { merge: true }),
  // Passe pending -> running de façon atomique : un seul appelant « gagne » (false si annulée, supprimée ou déjà prise)
  claimSchedule: (id) => store.runTransaction(async (t) => {
    const ref = col('schedules').doc(id);
    const d = await t.get(ref);
    if (!d.exists || d.data().status !== 'pending') return false;
    t.update(ref, { status: 'running' });
    return true;
  }),
  pendingSchedules: async () => (await col('schedules').where('status', '==', 'pending').get()).docs.map(withId),
  // Filtre/tri en mémoire : évite un index composite Firestore
  schedulesOfGuild: async (guildId, limit = 10) =>
    (await col('schedules').where('target', '==', guildId).get()).docs.map(withId)
      .sort((a, b) => b.run_at - a.run_at).slice(0, limit),

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
