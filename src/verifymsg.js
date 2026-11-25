const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

exports.verifyUrl = (guildId) => `${new URL(process.env.REDIRECT_URI).origin}/verify?guild=${guildId}`;

exports.post = (channel, guildId, page = {}) => {
  const fill = (t) => t.replace(/\{server\}/gi, channel.guild?.name || 'ce serveur');
  const embed = new EmbedBuilder()
    .setTitle(fill(page?.title || 'Vérification'))
    .setDescription(fill(page?.text || 'Clique sur le bouton ci-dessous pour te vérifier.'));
  if (page?.accent) embed.setColor(page.accent);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(fill(page?.button || 'Se vérifier')).setStyle(ButtonStyle.Link).setURL(exports.verifyUrl(guildId)));
  return channel.send({ embeds: [embed], components: [row] });
};
