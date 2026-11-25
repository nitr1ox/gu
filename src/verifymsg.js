const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

exports.verifyUrl = (guildId) => `${new URL(process.env.REDIRECT_URI).origin}/verify?guild=${guildId}`;

exports.post = (channel, guildId) => {
  const embed = new EmbedBuilder()
    .setTitle('Vérification')
    .setDescription(
      'Clique sur le bouton pour te vérifier. Si le serveur est un jour perdu, tu pourras être réinvité automatiquement.\n\n' +
      'Données stockées : ton ID Discord, ton pseudo et un jeton d\'accès chiffré. ' +
      'Tu peux tout supprimer à tout moment avec `/deletemydata`.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Se vérifier').setStyle(ButtonStyle.Link).setURL(exports.verifyUrl(guildId)));
  return channel.send({ embeds: [embed], components: [row] });
};
