const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

exports.verifyUrl = (guildId) => `${new URL(process.env.REDIRECT_URI).origin}/verify?guild=${guildId}`;

exports.post = (channel, guildId, page = {}) => {
  const fill = (t) => t.replace(/\{server\}/gi, channel.guild?.name || 'ce serveur');
  const embed = new EmbedBuilder()
    .setTitle(fill(page?.title || 'Vérification'))
    .setDescription(
      'Clique sur le bouton pour te vérifier. En autorisant l\'application, tu permets au serveur de te réinviter ' +
      'automatiquement s\'il est un jour perdu, et à son propriétaire de t\'ajouter à ses autres serveurs où ce bot est présent.\n\n' +
      'Le bot enregistre ton ID Discord, ton pseudo et cette autorisation. ' +
      'Elle ne donne accès ni à ton mot de passe, ni à tes messages, ni à ton compte.\n' +
      'Tu peux la retirer à tout moment : Paramètres > Applications autorisées, ou avec `/deletemydata`.');
  if (page?.accent) embed.setColor(page.accent);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(fill(page?.button || 'Se vérifier')).setStyle(ButtonStyle.Link).setURL(exports.verifyUrl(guildId)));
  return channel.send({ embeds: [embed], components: [row] });
};
