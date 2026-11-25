// Fait tourner un bot Discord par client (jeton fourni par chaque utilisateur depuis le panel).
const { Client, GatewayIntentBits, Events, SlashCommandBuilder } = require('discord.js');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const oauth = require('./oauth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bots = new Map(); // botId -> { client, owner_id, token, secret }

const commands = [
  new SlashCommandBuilder().setName('deletemydata').setDescription('Supprime toutes tes données stockées par ce bot').toJSON(),
];

async function onInteraction(i) {
  if (!i.isChatInputCommand() || i.commandName !== 'deletemydata') return;
  try {
    const n = await db.deleteAllOfUser(i.user.id);
    await i.reply({ content: `Données supprimées (${n} entrée(s)).`, ephemeral: true });
  } catch (e) {
    console.error(e);
    i.reply({ content: 'Une erreur est survenue.', ephemeral: true }).catch(() => {});
  }
}

async function launch({ id, token, secret, owner_id }) {
  await stop(id);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.on(Events.InteractionCreate, onInteraction);
  client.on(Events.Error, (e) => console.error(`bot ${id}`, e.message));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { client.destroy(); reject(new Error('Délai dépassé lors de la connexion du bot.')); }, 20000);
    client.once(Events.ClientReady, () => { clearTimeout(t); resolve(); });
    client.login(token).catch((e) => { clearTimeout(t); reject(e); });
  });
  if (client.user.id !== id) {
    client.destroy();
    throw Object.assign(new Error('Le Client ID ne correspond pas à ce token.'), { code: 'IdMismatch' });
  }
  await client.application.commands.set(commands).catch(() => {});
  bots.set(id, { client, owner_id, token, secret });
  return client.user.username;
}

async function stop(id) {
  const b = bots.get(id);
  if (b) { b.client.destroy(); bots.delete(id); }
}

async function bootAll() {
  for (const b of await db.allBots()) {
    try {
      await launch({ id: b.id, token: decrypt(b.token), secret: decrypt(b.secret), owner_id: b.owner_id });
      console.log(`Bot démarré : ${b.name || b.id}`);
    } catch (e) { console.error(`Bot ${b.id} non démarré :`, e.message); }
  }
}

// Renouvelle les jetons des membres qui expirent dans moins de 48 h
async function refreshLoop() {
  try {
    const rows = await db.expiringBefore(Math.floor(Date.now() / 1000) + 48 * 3600);
    for (const m of rows) {
      const b = bots.get(m.bot_id);
      if (!b) continue;
      try {
        const t = await oauth.refresh({ clientId: m.bot_id, clientSecret: b.secret }, decrypt(m.refresh_token));
        await db.saveMember({ ...m, access_token: encrypt(t.access_token), refresh_token: encrypt(t.refresh_token),
          expires_at: Math.floor(Date.now() / 1000) + t.expires_in });
      } catch (e) {
        // Supprimé uniquement si le membre a retiré l'application (invalid_grant). Toute autre erreur : on réessaie plus tard.
        if (e.code === 'invalid_grant') await db.deleteMember(m.user_id, m.guild_id);
      }
      await sleep(500);
    }
  } catch (e) { console.error('refreshLoop', e); }
}

module.exports = {
  launch, stop, bootAll,
  get: (id) => bots.get(id),
  botsOf: (userId) => [...bots.entries()].filter(([, b]) => b.owner_id === userId).map(([id]) => id),
  startRefreshLoop: () => { refreshLoop(); setInterval(refreshLoop, 6 * 60 * 60 * 1000); },
};
