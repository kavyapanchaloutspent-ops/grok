import {
  ActionRowBuilder,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { config } from "./config.js";
import { getBotIdentity } from "./identity.js";

const pending = new Map();

function isAdminUser(userId) {
  return config.adminUserIds.includes(userId);
}

function nonce() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function expire(id) {
  setTimeout(() => pending.delete(id), 5 * 60_000);
}

export async function handleDmChatCommand(message, client) {
  if (message.guild || message.author.bot || !/^\.chat(?:\s|$)/i.test(message.content.trim())) return false;
  if (!isAdminUser(message.author.id)) {
    await message.reply("Lệnh `.chat` trong DM chỉ dành cho ADMIN_USER_IDS.");
    return true;
  }
  const content = message.content.trim().replace(/^\.chat\s*/i, "").trim();
  if (!content) {
    await message.reply("Dùng: `.chat nội dung khích đểu` rồi chọn server và kênh. Mention bot là tùy chọn.");
    return true;
  }
  const guilds = [...client.guilds.cache.values()].slice(0, 25);
  if (!guilds.length) {
    await message.reply("Bot chưa ở server nào.");
    return true;
  }
  const id = nonce();
  pending.set(id, { userId: message.author.id, content, guildId: null });
  expire(id);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`dmchat:guild:${id}`)
    .setPlaceholder("Chọn server để khích var")
    .addOptions(guilds.map((guild) => new StringSelectMenuOptionBuilder().setLabel(guild.name.slice(0, 100)).setValue(guild.id)));
  await message.reply({ content: "Chọn server:", components: [new ActionRowBuilder().addComponents(menu)] });
  return true;
}

export async function handleDmChatInteraction(interaction, client) {
  if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith("dmchat:")) return false;
  const [, step, id] = interaction.customId.split(":");
  const state = pending.get(id);
  if (!state || state.userId !== interaction.user.id) {
    await interaction.reply({ content: "Phiên `.chat` hết hạn hoặc không thuộc về m.", ephemeral: true });
    return true;
  }
  if (step === "guild") {
    const guild = client.guilds.cache.get(interaction.values[0]);
    if (!guild) {
      pending.delete(id);
      await interaction.update({ content: "Không còn truy cập được server này.", components: [] });
      return true;
    }
    const me = guild.members.me;
    const channels = [...guild.channels.cache.values()]
      .filter((channel) =>
        [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) &&
        channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
      )
      .slice(0, 25);
    if (!channels.length) {
      await interaction.update({ content: "Server này không có kênh text bot gửi được.", components: [] });
      pending.delete(id);
      return true;
    }
    state.guildId = guild.id;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`dmchat:channel:${id}`)
      .setPlaceholder("Chọn kênh để bot mở màn")
      .addOptions(channels.map((channel) => new StringSelectMenuOptionBuilder().setLabel(`#${channel.name}`.slice(0, 100)).setValue(channel.id)));
    await interaction.update({ content: `Server: **${guild.name}**\nChọn kênh:`, components: [new ActionRowBuilder().addComponents(menu)] });
    return true;
  }
  if (step === "channel") {
    const guild = client.guilds.cache.get(state.guildId);
    const channel = guild?.channels?.cache?.get(interaction.values[0]);
    if (!channel?.isTextBased()) {
      pending.delete(id);
      await interaction.update({ content: "Kênh không còn hợp lệ.", components: [] });
      return true;
    }
    const identity = getBotIdentity(client.user.id);
    const requestedBotIds = [...state.content.matchAll(/<@!?(\d{16,20})>/g)]
      .map((match) => match[1])
      .filter((botId) => guild.members.cache.get(botId)?.user?.bot);
    const autoRivalId = identity.rivalId && guild.members.cache.get(identity.rivalId)?.user?.bot
      ? identity.rivalId
      : null;
    const allowedBotIds = [...new Set([...requestedBotIds, ...(autoRivalId ? [autoRivalId] : [])])].slice(0, 10);
    const alreadyTagsRival = autoRivalId && new RegExp(`<@!?${autoRivalId}>`).test(state.content);
    const outgoing = `${autoRivalId && !alreadyTagsRival ? `<@${autoRivalId}> ` : ""}${state.content}`;

    await channel.send({
      content: outgoing.slice(0, 1900),
      allowedMentions: { users: allowedBotIds, parse: [] },
    });
    pending.delete(id);
    await interaction.update({ content: `Đã gửi vào **${guild.name} / #${channel.name}**.`, components: [] });
    return true;
  }
  return false;
}



