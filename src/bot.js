const {
  Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const oauth = require('./oauth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = PermissionFlagsBits.Administrator;

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Configure la verification (role + message)')
    .addRoleOption((o) => o.setName('role').setDescription('Role donne aux membres verifies').setRequired(true))
    .setDefaultMemberPermissions(ADMIN).setDMPermission(false),
  new SlashCommandBuilder().setName('restore').setDescription('Restaure les membres verifies d\'un ancien serveur dans celui-ci')
    .addStringOption((o) => o.setName('source').setDescription('ID de l\'ancien serveur').setRequired(true))
    .setDefaultMemberPermissions(ADMIN).setDMPermission(false),
  new SlashCommandBuilder().setName('stats').setDescription('Nombre de membres sauvegardes')
    .setDefaultMemberPermissions(ADMIN).setDMPermission(false),
  new SlashCommandBuilder().setName('deletemydata').setDescription('Supprime toutes tes donnees stockees par le bot'),
].map((c) => c.toJSON());

exports.createBot = () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

  client.once('ready', async () => {
    await client.application.commands.set(commands);
    console.log(`Bot connecte : ${client.user.tag}`);
    refreshLoop();
    setInterval(refreshLoop, 6 * 60 * 60 * 1000);
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'setup') {
      const role = i.options.getRole('role');
      db.setGuild(i.guildId, role.id);
      const url = `${new URL(process.env.REDIRECT_URI).origin}/verify?guild=${i.guildId}`;
      const embed = new EmbedBuilder()
        .setTitle('Verification')
        .setDescription(
          'Clique pour te verifier. Si le serveur est un jour perdu, tu pourras etre reinvite automatiquement.\n\n' +
          'Donnees stockees : ton ID Discord, ton pseudo et un jeton d\'acces chiffre. ' +
          'Tu peux tout supprimer a tout moment avec `/deletemydata`.');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Se verifier').setStyle(ButtonStyle.Link).setURL(url));
      await i.channel.send({ embeds: [embed], components: [row] });
      return i.reply({ content: 'Configuré', ephemeral: true });
    }

    if (i.commandName === 'stats') {
      return i.reply({ content: `${db.count(i.guildId)} membre(s) sauvegarde(s).`, ephemeral: true });
    }

    if (i.commandName === 'deletemydata') {
      const r = db.deleteAllOfUser(i.user.id);
      return i.reply({ content: `Donnees supprimees (${r.changes} entree(s)).`, ephemeral: true });
    }

    if (i.commandName === 'restore') {
      const source = i.options.getString('source').trim();
      // L'utilisateur doit etre admin du serveur source aussi
      const srcGuild = await client.guilds.fetch(source).catch(() => null);
      const srcMember = srcGuild && (await srcGuild.members.fetch(i.user.id).catch(() => null));
      const isOwner = srcGuild && srcGuild.ownerId === i.user.id;
      if (!isOwner && !srcMember?.permissions.has(ADMIN)) {
        return i.reply({ content: 'Tu dois etre admin du serveur source (et le bot doit y etre).', ephemeral: true });
      }
      const members = db.membersOf(source);
      if (!members.length) return i.reply({ content: 'Aucun membre sauvegarde pour ce serveur.', ephemeral: true });

      await i.reply({ content: `Restauration de ${members.length} membre(s) en cours...`, ephemeral: true });
      let added = 0, already = 0, failed = 0;
      for (const m of members) {
        try {
          let access = decrypt(m.access_token);
          if (m.expires_at < Date.now() / 1000 + 60) {
            const t = await oauth.refresh(decrypt(m.refresh_token));
            access = t.access_token;
            db.saveMember({ ...m, access_token: encrypt(t.access_token), refresh_token: encrypt(t.refresh_token),
              expires_at: Math.floor(Date.now() / 1000) + t.expires_in });
          }
          const res = await oauth.addMember(i.guildId, m.user_id, access);
          if (res === 'added') added++; else if (res === 'already') already++; else failed++;
        } catch { failed++; }
        await sleep(1100); // reste sous les rate limits
      }
      return i.followUp({
        content: `Termine : ${added} ajoute(s), ${already} deja present(s), ${failed} echec(s).`, ephemeral: true });
    }
  });

  // Renouvelle les tokens qui expirent dans moins de 48h
  async function refreshLoop() {
    const rows = db.expiringBefore(Math.floor(Date.now() / 1000) + 48 * 3600);
    for (const m of rows) {
      try {
        const t = await oauth.refresh(decrypt(m.refresh_token));
        db.saveMember({ ...m, access_token: encrypt(t.access_token), refresh_token: encrypt(t.refresh_token),
          expires_at: Math.floor(Date.now() / 1000) + t.expires_in });
      } catch {
        db.deleteMember(m.user_id, m.guild_id); // token revoque : on nettoie
      }
      await sleep(500);
    }
  }

  return client;
};
