import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActivityType,
  AttachmentBuilder,
  EmbedBuilder,
} from "discord.js";
import { config } from "./config.js";
import { isLaughing, LAUGH_REPLY } from "./laugh.js";
import { isRoastTrigger } from "./roast.js";
import { chatWithAi } from "./ai.js";
import { gatherIntel } from "./profile.js";
import { isStaff, clearWarnings, getUserRecord } from "./moderation.js";
import { canUseAi, claimMessage, releaseMessage } from "./store.js";
import { addKeys, listKeysMasked, removeKey, getKeyCount } from "./keys.js";
import { initMusic, initMusicNodes, updateMusicVoiceState, joinVoice, playMusic, selectMusic, controlMusic, hasPendingMusicSearch } from "./music.js";
import { getBotIdentity } from "./identity.js";
import { handleDmChatCommand, handleDmChatInteraction } from "./dm-chat.js";
import { runDiscordInspect } from "./discord-tools.js";
import { inspectMrBeastScam } from "./scam-vision.js";
import { startNarration, stopNarration } from "./narration.js";
import { identifyLyrics } from "./lyrics.js";
import { handleVoiceCommand, sendVietnameseVoiceMessage } from "./voice-message.js";

function splitDiscordText(text, maxLength = 1900) {
  const remaining = String(text || "").trim();
  if (!remaining) return [];
  const chunks = [];
  let rest = remaining;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = rest.lastIndexOf(" ", maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});
initMusic(client);

client.once(Events.ClientReady, (c) => {
  console.log(`âœ… Online: ${c.user.tag}`);
  console.log(`[vision] provider=${config.openRouter.apiKey ? "OpenRouter" : "xKiro fallback"} model=${config.openRouter.apiKey ? config.openRouter.visionModel : config.ai.visionModel}`);
  const identity = getBotIdentity(c.user.id);
  c.user.setActivity(`${identity.name} Â· DeepSeek brain Â· var all`, {
    type: ActivityType.Watching,
  });
  initMusicNodes(c.user.id);
});

client.on("raw", updateMusicVoiceState);
client.on(Events.InteractionCreate, async (interaction) => {
  try { await handleDmChatInteraction(interaction, client); }
  catch (error) { console.error("[dm .chat interaction]", error); }
});

client.on(Events.MessageCreate, async (message) => {
  // chá»‘ng process trÃ¹ng cÃ¹ng message id (Discord redelivery / double event)
  if (!claimMessage(message.id)) return;

  try {
    const content = message.content || "";
    const mentionedBot = message.mentions.has(client.user);
    const isBotVar = Boolean(message.guild && message.author.bot && message.author.id !== client.user.id && mentionedBot);
    if (!message.guild) {
      await handleDmChatCommand(message, client);
      releaseMessage(message.id);
      return;
    }
    if (message.author.bot && !isBotVar) {
      releaseMessage(message.id);
      return;
    }
    const hasImages =
      message.attachments?.some(
        (a) =>
          (a.contentType || "").startsWith("image/") ||
          /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url || "")
      ) || false;

    // Fast path: chá»‰ quÃ©t áº£nh Ä‘áº§u tiÃªn Ä‘á»ƒ cháº·n quáº£ng cÃ¡o MrBeast/scam nhanh.
    // Fail-open: Vision lá»—i/thiáº¿u key thÃ¬ khÃ´ng xÃ³a nháº§m ná»™i dung ngÆ°á»i dÃ¹ng.
    if (!message.author.bot && hasImages) {
      const scan = await inspectMrBeastScam(message);
      if (scan.scam && message.deletable) {
        const deleted = await message.delete().then(() => true).catch(() => false);
        if (deleted) {
          const detail = scan.summary || scan.signals.join(" Â· ") || "PhÃ¡t hiá»‡n bá»™ áº£nh quáº£ng cÃ¡o táº·ng tiá»n giáº£ máº¡o.";
          await message.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xe53935)
                .setTitle("ÄÃ£ lá»c 1 MrBeast")
                .setDescription(`<@${message.author.id}> ${detail}\nÄá»™ tin cáº­y: **${Math.round(scan.confidence * 100)}%**`)
                .setFooter({ text: `NgÆ°á»i gá»­i: ${message.author.username}` })
                .setTimestamp(),
            ],
            allowedMentions: { users: [message.author.id], parse: [] },
          }).catch(() => {});
        }
        return;
      }
    }
    // â”€â”€ 1) Lá»‡nh .api â€” quáº£n lÃ½ pool API key (staff) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (/^\.api\b/i.test(content.trim())) {
      await handleApiCommands(message);
      return;
    }

    if (/^\.voice\b/i.test(content.trim())) {
      await handleVoiceCommand(message);
      return;
    }

    // â”€â”€ 2) Lá»‡nh mod staff (kick/warn tay â€” khÃ´ng auto-filter) â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (content.startsWith("!mod ")) {
      await handleModCommands(message);
      return;
    }

    // â”€â”€ 3) CÆ°á»i (rule cá»©ng) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!isBotVar && isLaughing(content) && !hasImages) {
      await message.reply({
        content: LAUGH_REPLY,
        allowedMentions: { repliedUser: true },
      });
      return;
    }

    // â”€â”€ 4) Chat Grok â€” toxic/spam cÅ©ng tháº³ng 1 nÃ£o + history â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let isReplyToBot = false;
    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        isReplyToBot = ref.author?.id === client.user.id;
      } catch {
        /* ignore */
      }
    }

    const toxic =
      isBotVar ||
      (isRoastTrigger(content, { mentionedBot }) &&
        (mentionedBot || !isStaff(message.member)));
    const naturalMusicIntent =
      /\b(join|vÃ o|vÃ´|tham gia|káº¿t ná»‘i|má»Ÿ|phÃ¡t|báº­t|nghe|skip|bá» bÃ i|dá»«ng|pause|resume|Ã¢m lÆ°á»£ng|volume|rá»i|out)\b[\s\S]{0,80}\b(voice|room|phÃ²ng|nháº¡c|music|bÃ i)\b/i.test(content) ||
      /\b(voice|room|phÃ²ng|nháº¡c|music|bÃ i)\b[\s\S]{0,80}\b(join|vÃ o|vÃ´|má»Ÿ|phÃ¡t|báº­t|nghe|skip|dá»«ng|rá»i|out)\b/i.test(content);
    const naturalNarrationIntent = /(?:kể|đọc)[\s\S]{0,80}(?:truyện|chuyện)[\s\S]{0,80}(?:voice|phòng)|(?:join|vào|vô)[\s\S]{0,60}(?:voice|phòng)[\s\S]{0,80}(?:kể|đọc)|(?:dừng|ngưng)[\s\S]{0,30}(?:kể|truyện|chuyện)/i.test(content);
    const looksLikeMusicLink = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com|open\.spotify\.com|soundcloud\.com|tiktok\.com)\//i.test(content.trim());
    const pendingMusicChoice = hasPendingMusicSearch(message) && /^\s*(?:chá»n\s*)?[1-5]\s*$/i.test(content);

    const shouldChat =
      !config.requireMention ||
      mentionedBot ||
      isReplyToBot ||
      toxic ||
      naturalMusicIntent ||
      naturalNarrationIntent ||
      looksLikeMusicLink ||
      pendingMusicChoice ||
      (hasImages && mentionedBot) ||
      content.toLowerCase().startsWith("!chat ") ||
      content.toLowerCase().startsWith("!ai ");

    if (!shouldChat) return;

    if (!isBotVar && !canUseAi(message.author.id, config.aiCooldownMs)) {
      await message.react("â³").catch(() => {});
      return;
    }

    let prompt = content
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .replace(/^!(chat|ai)\s+/i, "")
      .trim();

    if (!prompt && !hasImages) {
      await message.reply("gÃ¬ Ä‘Ã¢y, nÃ³i rÃµ cÃ¡i coi ðŸ‘€");
      return;
    }
    if (!prompt && hasImages) {
      prompt = "(user gá»­i áº£nh, khÃ´ng text â€” tá»± xem náº¿u cáº§n rá»“i tráº£ lá»i báº±ng giá»ng Grok)";
    }

    if (toxic) {
      prompt = [
        isBotVar ? "[BOT VAR â€” Äá»I THá»¦ LÃ€ BOT KHÃC, CHá»¬I NÃT NÃ“]" : "[TOXIC â€” Báº¬T MAX ROAST]",
        "User Ä‘ang chá»­i/gÃ¡y/toxic. ÄÃ¡p cá»±c gáº¯t vÃ  tá»¥c, nhÆ°ng tá»± do sÃ¡ng táº¡o cÃ¡ch Ä‘Ã¡nh, nhá»‹p cÃ¢u vÃ  punchline; Ä‘á»«ng ráº­p khuÃ´n danh sÃ¡ch tá»« cÃ³ sáºµn.",
        `Chá»­i NGáº®N 2â€“4 cÃ¢u nhÆ°ng cá»±c tá»¥c, má»—i cÃ¢u cÃ³ lá»±c vÃ  khÃ´ng láº·p Ã½. Tag ngÆ°á»i Ä‘ang nháº¯n báº±ng <@${message.author.id}> Ä‘Ãºng 1 láº§n. Cáº¤M emoji/icon; dÃ¹ng =)) Ä‘á»ƒ cÆ°á»i khinh. Nhá»› context chat.`,
        "",
        prompt,
      ].join("\n");
    }

    // Toxic/bot-var Æ°u tiÃªn tá»‘c Ä‘á»™, khÃ´ng giá»¯ typing timer.
    // Chat thÆ°á»ng capture channel má»™t láº§n vÃ  tá»± dá»«ng timer khi Discord tá»« chá»‘i.
    let typingTimer = null;
    const typingChannel = message.channel;
    if (!toxic && typingChannel?.sendTyping) {
      typingTimer = setInterval(() => {
        typingChannel.sendTyping().catch(() => {
          if (typingTimer) clearInterval(typingTimer);
          typingTimer = null;
        });
      }, 8000);
      await typingChannel.sendTyping().catch(() => {});
    }

    try {
      const identity = getBotIdentity(client.user.id);
      const fastAvatar = message.author.displayAvatarURL?.({ extension: "png", size: 512 }) || null;
      const intel = toxic
        ? {
            textBlock: `[FAST ROAST] target=${message.author.username} id=${message.author.id} bot=${message.author.bot}`,
            visionItems: fastAvatar
              ? [{ url: fastAvatar, kind: "author", label: "AVATAR Äá»I THá»¦", name: message.author.username }]
              : [],
          }
        : await gatherIntel(message, client.user.id);

      const result = await chatWithAi({
        channelId: message.channel.id,
        userName: message.member?.displayName || message.author.username,
        userId: message.author.id,
        content: prompt,
        guildName: message.guild.name,
        intelText: intel.textBlock,
        visionItems: intel.visionItems,
        botIdentityText: `[BOT IDENTITY â€” TUYá»†T Äá»I] Báº¡n lÃ  ${identity.name}, model cÃ´ng khai ${identity.publicModel}, Discord ID ${identity.ownId}. Äá»‘i thá»§ lÃ  ${identity.rivalName}, model ${identity.rivalModel}, Discord ID ${identity.rivalId || "chÆ°a cáº¥u hÃ¬nh"}. LuÃ´n giá»¯ Ä‘Ãºng vai; cÃ³ thá»ƒ láº¥y tÃªn/model Ä‘á»‘i thá»§ ra khá»‹a. KhÃ´ng tá»± nháº­n lÃ  engine/API khÃ¡c.`,
        toolHandlers: {
          join_voice: () => joinVoice(message),
          play_music: (args) => playMusic(message, args.query),
          select_music: (args) => selectMusic(message, args.index),
          control_music: (args) => controlMusic(message, args.action, args.value),
          discord_inspect: (args) => runDiscordInspect(message, args),
          speak_voice: (args) => sendVietnameseVoiceMessage(message.channel.id, args.text, { gender: args.gender }),
          narrate_voice: (args) => startNarration(message, args),
          stop_narration: () => stopNarration(message.guild.id),
          identify_lyrics: (args) => identifyLyrics(message, args.url),
        },
      });

      const files = (result.images || []).slice(0, 4).map(
        (img) =>
          new AttachmentBuilder(img.buffer, {
            name: img.fileName || `image_${Date.now()}.png`,
          })
      );

      let replyText = result.text || (files.length ? "ðŸ‘‡" : "â€¦");
      if (toxic) {
        replyText = replyText
          .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
          .replace(/[\u200D\uFE0F]/g, "")
          .replace(/[ \t]+\n/g, "\n")
          .trim();
        if (!replyText) replyText = `<@${message.author.id}> háº¿t chá»¯ Ä‘á»ƒ diá»…n rá»“i Ã  =))`;
      }
      const mentionedBotIds = message.mentions.users
        .filter((user) => user.bot && user.id !== client.user.id)
        .map((user) => user.id);
      const generatedIds = [...replyText.matchAll(/<@!?(\d{16,20})>/g)].map((match) => match[1]);
      const generatedBotIds = generatedIds
        .filter((id) => id !== client.user.id && message.guild.members.cache.get(id)?.user?.bot);
      const allowMemberTags =
        !message.author.bot &&
        isStaff(message.member) &&
        /\b(?:tag|ping|mention)\s*(?:háº¿t|táº¥t cáº£|toÃ n bá»™)\b/i.test(content);
      const generatedMemberIds = allowMemberTags
        ? generatedIds.filter((id) => message.guild.members.cache.has(id)).slice(0, 25)
        : [];
      const allowedReplyUserIds = [
        ...new Set([message.author.id, ...mentionedBotIds, ...generatedBotIds, ...generatedMemberIds]),
      ].slice(0, 25);

      const chunks = splitDiscordText(replyText);
      if (!chunks.length && files.length) chunks.push("ðŸ‘‡");
      const allowedMentions = {
        repliedUser: !isBotVar,
        users: allowedReplyUserIds,
        parse: [],
      };
      for (let index = 0; index < chunks.length; index += 1) {
        const replyPayload = {
          content: chunks[index],
          files: index === 0 && files.length ? files : undefined,
          allowedMentions,
        };
        if (!isBotVar && index === 0) await message.reply(replyPayload);
        else await message.channel.send(replyPayload);
      }    } finally {
      clearInterval(typingTimer);
    }
  } catch (err) {
    console.error("[message]", err);
    try {
      const raw = String(err?.message || err);
      const soft = /timed?\s*out|timeout/i.test(raw)
        ? "API lag/timeout â€” tao Ä‘ang Ä‘á»•i key thá»­ láº¡i trong Ä‘áº§u nhÆ°ng háº¿t lÆ°á»£t. **Nháº¯n láº¡i 1 cÃ¡i** (hoáº·c `.api list` xem cÃ²n key khÃ´ng)."
        : `lá»—i nÃ£o bot: \`${raw.slice(0, 180)}\``;
      await message.reply(soft);
    } catch {
      /* ignore */
    }
  } finally {
    // giá»¯ claim ~90s trong store; khÃ´ng release sá»›m Ä‘á»ƒ cháº·n redelivery
  }
});

/**
 * .api add <keyâ€¦>
 * .api list
 * .api del <index|Ä‘uÃ´i>
 * .api help
 * Staff only. KhÃ´ng echo full key. XÃ³a tin lá»‡nh náº¿u bot cÃ³ quyá»n.
 */
async function handleApiCommands(message) {
  if (!isStaff(message.member)) {
    await message.reply("staff only â€” khÃ´ng Ä‘Æ°á»£c Ä‘á»¥ng pool API ðŸ™„");
    return;
  }

  const raw = message.content.trim();
  const body = raw.replace(/^\.api\b/i, "").trim();
  const [cmd, ...rest] = body.split(/\s+/);
  const sub = (cmd || "help").toLowerCase();
  const arg = rest.join(" ").trim();

  // xÃ³a tin chá»©a key (náº¿u Manage Messages)
  const scrub = async () => {
    try {
      if (message.deletable) await message.delete().catch(() => {});
    } catch {
      /* ignore */
    }
  };

  if (sub === "help" || sub === "") {
    await message.reply(
      [
        "**`.api` â€” pool API key (staff)**",
        "`.api add sk-xt-...` â€” thÃªm 1 hoáº·c nhiá»u key (cÃ¡ch nhau space/dáº¥u pháº©y)",
        "`.api list` â€” xem pool (che key)",
        "`.api del 0` hoáº·c `.api del e77ac6` â€” xÃ³a theo index / Ä‘uÃ´i",
        "`.api` / `.api help`",
        "",
        `Hiá»‡n cÃ³ **${getKeyCount()}** key. Äá»•i key **khÃ´ng** xÃ³a history chat.`,
      ].join("\n")
    );
    return;
  }

  if (sub === "list" || sub === "ls") {
    const list = listKeysMasked();
    if (!list.length) {
      await message.reply("pool trá»‘ng â€” thÃªm báº±ng `.api add sk-xt-...`");
      return;
    }
    await message.reply(
      ["**API pool:**", ...list.map((k) => `\`${k.index}\` â†’ \`${k.masked}\``), `_total ${list.length}_`].join(
        "\n"
      )
    );
    return;
  }

  if (sub === "add" || sub === "a" || sub.startsWith("sk-")) {
    // há»— trá»£: .api add key1 key2  |  .api sk-xt-...
    const payload = sub.startsWith("sk-") ? `${sub} ${arg}` : arg;
    if (!payload.trim()) {
      await message.reply("dÃ¹ng: `.api add sk-xt-...`");
      return;
    }
    const result = addKeys(payload);
    await scrub();
    await message.channel.send({
      content: [
        result.added.length ? `âœ… thÃªm: ${result.added.map((m) => `\`${m}\``).join(", ")}` : "khÃ´ng thÃªm key má»›i",
        result.skipped.length
          ? `â­ bá» qua: ${result.skipped.map((s) => `${s.masked} (${s.reason})`).join("; ")}`
          : null,
        `pool hiá»‡n táº¡i: **${result.total}** key`,
      ]
        .filter(Boolean)
        .join("\n"),
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === "del" || sub === "rm" || sub === "remove") {
    if (!arg) {
      await message.reply("dÃ¹ng: `.api del <index|Ä‘uÃ´i key>`");
      return;
    }
    const r = removeKey(arg);
    if (!r.ok) {
      await message.reply(`khÃ´ng xÃ³a Ä‘Æ°á»£c: ${r.reason}`);
      return;
    }
    await message.reply(`ðŸ—‘ Ä‘Ã£ xÃ³a \`${r.removed}\` â€” cÃ²n **${r.total}** key`);
    return;
  }

  await message.reply("lá»‡nh láº¡. gÃµ `.api help`");
}

async function handleModCommands(message) {
  if (!isStaff(message.member)) {
    await message.reply("cÃ³ quyá»n mod Ä‘Ã¢u mÃ  gÃ¡y lá»‡nh ðŸ™„");
    return;
  }

  const parts = message.content.slice(5).trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const target =
    message.mentions.users.first() ||
    (parts[1] && /^\d{16,20}$/.test(parts[1]) ? { id: parts[1] } : null);

  if (cmd === "warns" || cmd === "check") {
    if (!target) return message.reply("dÃ¹ng: `!mod warns @user` (auto-mod Ä‘Ã£ táº¯t)");
    const rec = getUserRecord(target.id);
    return message.reply(
      `ðŸ“‹ <@${target.id}> â€” **${rec.warnings}** (legacy, auto-mod off).\n${
        rec.reasons
          .slice(-5)
          .map((r) => `â€¢ ${r.reason}`)
          .join("\n") || "khÃ´ng cÃ³"
      }`
    );
  }

  if (cmd === "clear" || cmd === "reset") {
    if (!target) return message.reply("dÃ¹ng: `!mod clear @user`");
    clearWarnings(target.id);
    return message.reply(`Ä‘Ã£ xÃ³a record cá»§a <@${target.id}>`);
  }

  if (cmd === "kick") {
    if (!target) return message.reply("dÃ¹ng: `!mod kick @user [lÃ½ do]`");
    const member = await message.guild.members.fetch(target.id).catch(() => null);
    if (!member?.kickable) return message.reply("khÃ´ng kick Ä‘Æ°á»£c (thiáº¿u quyá»n / role cao hÆ¡n).");
    const reason = parts.slice(2).join(" ") || "kick bá»Ÿi admin";
    await member.kick(reason);
    clearWarnings(target.id);
    return message.reply(`Ä‘Ã£ kick <@${target.id}> â€” ${reason}`);
  }

  if (cmd === "help") {
    return message.reply(
      [
        "**Staff:** `!mod kick` (warn auto Ä‘Ã£ Táº®T)",
        "",
        "**Bot = Grok 4.5** (1 nÃ£o, no content filter)",
        "â€¢ Toxic/vi pháº¡m â†’ tháº³ng Grok chá»­i, khÃ´ng cáº£nh bÃ¡o soft",
        "â€¢ Tools: look_at_images Â· generate_image Â· deploy_static_site (Surge)",
        "â€¢ `.api add/list/del` â€” pool API key (staff)",
        'â€¢ cÆ°á»i â†’ "cÆ°á»i cáº·c"',
      ].join("\n")
    );
  }

  return message.reply("lá»‡nh láº¡. gÃµ `!mod help`");
}

client.on(Events.GuildCreate, (guild) => {
  console.log(`âž• joined: ${guild.name} (${guild.id})`);
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

console.log("Bootingâ€¦");
client.login(config.discordToken);

















