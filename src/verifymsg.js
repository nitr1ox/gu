const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

exports.verifyUrl = (guildId) => `${new URL(process.env.REDIRECT_URI).origin}/verify?guild=${guildId}`;

exports.post = (channel, guildId, page = {}) => {
  const fill = (t) => t.replace(/\{server\}/gi, channel.guild?.name || 'ce serveur');
  const embed = new EmbedBuilder()
    .setTitle(fill(page?.title || 'Vérification'))
    .setDescription(
      'Clique sur le bouton pour te vérifier. Si le serveur est un jour perdu, tu pourras être réinvité automatiquement, ' +
      'et le propriétaire pourra aussi t\'ajouter à ses autres serveurs où ce bot est présent. ' +
      'Cela reste actif jusqu\'à ce que tu retires l\'application dans Discord (Paramètres > Applications autorisées).\n\n' +
      'Données stockées : ton ID Discord, ton pseudo et un jeton d\'accès chiffré. ' +
      'Tu peux tout supprimer à tout moment avec `/deletemydata`.');
  if (page?.accent) embed.setColor(page.accent);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(fill(page?.button || 'Se vérifier')).setStyle(ButtonStyle.Link).setURL(exports.verifyUrl(guildId)));
  return channel.send({ embeds: [embed], components: [row] });
};
