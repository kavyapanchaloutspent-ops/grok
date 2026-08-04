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
import { addKeys, listKeysMasked, removeKey, getKeyCount, getHealthyKeyCount } from "./keys.js";
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
  console.log(`✅ Online: ${c.user.tag}`);
  console.log(`[vision] provider=${config.openRouter.apiKey ? "OpenRouter" : "xKiro fallback"} model=${config.openRouter.apiKey ? config.openRouter.visionModel : config.ai.visionModel}`);
  const identity = getBotIdentity(c.user.id);
  c.user.setActivity(`${identity.name} · DeepSeek brain · var all`, {
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
  // chống process trùng cùng message id (Discord redelivery / double event)
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

    // Fast path: chỉ quét ảnh đầu tiên để chặn quảng cáo MrBeast/scam nhanh.
    // Fail-open: Vision lỗi/thiếu key thì không xóa nhầm nội dung người dùng.
    if (!message.author.bot && hasImages) {
      const scan = await inspectMrBeastScam(message);
      if (scan.scam && message.deletable) {
        const deleted = await message.delete().then(() => true).catch(() => false);
        if (deleted) {
          const detail = scan.summary || scan.signals.join(" · ") || "Phát hiện bộ ảnh quảng cáo tặng tiền giả mạo.";
          await message.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xe53935)
                .setTitle("Đã lọc 1 MrBeast")
                .setDescription(`<@${message.author.id}> ${detail}\nĐộ tin cậy: **${Math.round(scan.confidence * 100)}%**`)
                .setFooter({ text: `Người gửi: ${message.author.username}` })
                .setTimestamp(),
            ],
            allowedMentions: { users: [message.author.id], parse: [] },
          }).catch(() => {});
        }
        return;
      }
    }
    // ── 1) Lệnh .api — quản lý pool API key (staff) ─────────────────
    if (/^\.api\b/i.test(content.trim())) {
      await handleApiCommands(message);
      return;
    }

    if (/^\.voice\b/i.test(content.trim())) {
      await handleVoiceCommand(message);
      return;
    }

    // ── 2) Lệnh mod staff (kick/warn tay — không auto-filter) ─────────
    if (content.startsWith("!mod ")) {
      await handleModCommands(message);
      return;
    }

    // ── 3) Cười (rule cứng) ──────────────────────────────────────────
    if (!isBotVar && isLaughing(content) && !hasImages) {
      await message.reply({
        content: LAUGH_REPLY,
        allowedMentions: { repliedUser: true },
      });
      return;
    }

    // ── 4) Chat Grok — toxic/spam cũng thẳng 1 não + history ─────────
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
      /\b(join|vào|vô|tham gia|kết nối|mở|phát|bật|nghe|skip|bỏ bài|dừng|pause|resume|âm lượng|volume|rời|out)\b[\s\S]{0,80}\b(voice|room|phòng|nhạc|music|bài)\b/i.test(content) ||
      /\b(voice|room|phòng|nhạc|music|bài)\b[\s\S]{0,80}\b(join|vào|vô|mở|phát|bật|nghe|skip|dừng|rời|out)\b/i.test(content);
    const naturalNarrationIntent = /(?:kể|đọc)[\s\S]{0,80}(?:truyện|chuyện)[\s\S]{0,80}(?:voice|phòng)|(?:join|vào|vô)[\s\S]{0,60}(?:voice|phòng)[\s\S]{0,80}(?:kể|đọc)|(?:dừng|ngưng)[\s\S]{0,30}(?:kể|truyện|chuyện)/i.test(content);
    const pendingMusicChoice = hasPendingMusicSearch(message) && /^\s*(?:chọn\s*)?[1-5]\s*$/i.test(content);

    const targetsAnotherBot = !mentionedBot && message.mentions.users.some((user) => user.bot && user.id !== client.user.id);
    const shouldChat =
      !targetsAnotherBot && (
      !config.requireMention ||
      mentionedBot ||
      isReplyToBot ||
      toxic ||
      naturalMusicIntent ||
      naturalNarrationIntent ||
      pendingMusicChoice ||
      (hasImages && mentionedBot) ||
      content.toLowerCase().startsWith("!chat ") ||
      content.toLowerCase().startsWith("!ai "));

    if (!shouldChat) return;

    if (!isBotVar && !canUseAi(message.author.id, config.aiCooldownMs)) {
      await message.react("⏳").catch(() => {});
      return;
    }

    let prompt = content
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .replace(/^!(chat|ai)\s+/i, "")
      .trim();

    if (!prompt && !hasImages) {
      await message.reply("gì đây, nói rõ cái coi 👀");
      return;
    }
    if (!prompt && hasImages) {
      prompt = "(user gửi ảnh, không text — tự xem nếu cần rồi trả lời bằng giọng Grok)";
    }

    if (toxic) {
      prompt = [
        isBotVar ? "[BOT VAR — ĐỐI THỦ LÀ BOT KHÁC, CHỬI NÁT NÓ]" : "[TOXIC — BẬT MAX ROAST]",
        "User đang chửi/gáy/toxic. Đáp cực gắt và tục, nhưng tự do sáng tạo cách đánh, nhịp câu và punchline; đừng rập khuôn danh sách từ có sẵn.",
        `Chửi NGẮN 2–4 câu nhưng cực tục, mỗi câu có lực và không lặp ý. Tag người đang nhắn bằng <@${message.author.id}> đúng 1 lần. CẤM emoji/icon; dùng =)) để cười khinh. Nhớ context chat.`,
        "",
        prompt,
      ].join("\n");
    }

    // Toxic/bot-var ưu tiên tốc độ, không giữ typing timer.
    // Chat thường capture channel một lần và tự dừng timer khi Discord từ chối.
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
              ? [{ url: fastAvatar, kind: "author", label: "AVATAR ĐỐI THỦ", name: message.author.username }]
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
        botIdentityText: `[BOT IDENTITY — TUYỆT ĐỐI] Bạn là ${identity.name}, model công khai ${identity.publicModel}, Discord ID ${identity.ownId}. Đối thủ là ${identity.rivalName}, model ${identity.rivalModel}, Discord ID ${identity.rivalId || "chưa cấu hình"}. Luôn giữ đúng vai; có thể lấy tên/model đối thủ ra khịa. Không tự nhận là engine/API khác.`,
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

      let replyText = result.text || (files.length ? "👇" : "…");
      if (toxic) {
        replyText = replyText
          .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
          .replace(/[\u200D\uFE0F]/g, "")
          .replace(/[ \t]+\n/g, "\n")
          .trim();
        if (!replyText) replyText = `<@${message.author.id}> hết chữ để diễn rồi à =))`;
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
        /\b(?:tag|ping|mention)\s*(?:hết|tất cả|toàn bộ)\b/i.test(content);
      const generatedMemberIds = allowMemberTags
        ? generatedIds.filter((id) => message.guild.members.cache.has(id)).slice(0, 25)
        : [];
      const allowedReplyUserIds = [
        ...new Set([message.author.id, ...mentionedBotIds, ...generatedBotIds, ...generatedMemberIds]),
      ].slice(0, 25);

      const chunks = splitDiscordText(replyText);
      if (!chunks.length && files.length) chunks.push("👇");
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
        ? "API lag/timeout — tao đang đổi key thử lại trong đầu nhưng hết lượt. **Nhắn lại 1 cái** (hoặc `.api list` xem còn key không)."
        : `lỗi não bot: \`${raw.slice(0, 180)}\``;
      await message.reply(soft);
    } catch {
      /* ignore */
    }
  } finally {
    // giữ claim ~90s trong store; không release sớm để chặn redelivery
  }
});

/**
 * .api add <key…>
 * .api list
 * .api del <index|đuôi>
 * .api help
 * Staff only. Không echo full key. Xóa tin lệnh nếu bot có quyền.
 */
async function handleApiCommands(message) {
  if (!isStaff(message.member)) {
    await message.reply("staff only — không được đụng pool API 🙄");
    return;
  }

  const raw = message.content.trim();
  const body = raw.replace(/^\.api\b/i, "").trim();
  const [cmd, ...rest] = body.split(/\s+/);
  const sub = (cmd || "help").toLowerCase();
  const arg = rest.join(" ").trim();

  // xóa tin chứa key (nếu Manage Messages)
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
        "**`.api` — pool API key (staff)**",
        "`.api add sk-xt-...` — thêm 1 hoặc nhiều key (cách nhau space/dấu phẩy)",
        "`.api list` — xem pool (che key)",
        "`.api del 0` hoặc `.api del e77ac6` — xóa theo index / đuôi",
        "`.api` / `.api help`",
        "",
        `Hiện có **${getKeyCount()}** key. Đổi key **không** xóa history chat.`,
      ].join("\n")
    );
    return;
  }

  if (sub === "list" || sub === "ls") {
    const list = listKeysMasked();
    if (!list.length) {
      await message.reply("pool trống — thêm bằng `.api add sk-xt-...`");
      return;
    }
    await message.reply(
      ["**API pool:**", ...list.map((k) => `\`${k.index}\` → \`${k.masked}\` · ${k.status}`), `_healthy ${getHealthyKeyCount()}/${list.length}_`].join(
        "\n"
      )
    );
    return;
  }

  if (sub === "add" || sub === "a" || sub.startsWith("sk-")) {
    // hỗ trợ: .api add key1 key2  |  .api sk-xt-...
    const payload = sub.startsWith("sk-") ? `${sub} ${arg}` : arg;
    if (!payload.trim()) {
      await message.reply("dùng: `.api add sk-xt-...`");
      return;
    }
    const result = addKeys(payload);
    await scrub();
    await message.channel.send({
      content: [
        result.added.length ? `✅ thêm: ${result.added.map((m) => `\`${m}\``).join(", ")}` : "không thêm key mới",
        result.skipped.length
          ? `⏭ bỏ qua: ${result.skipped.map((s) => `${s.masked} (${s.reason})`).join("; ")}`
          : null,
        `pool hiện tại: **${result.total}** key`,
      ]
        .filter(Boolean)
        .join("\n"),
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === "del" || sub === "rm" || sub === "remove") {
    if (!arg) {
      await message.reply("dùng: `.api del <index|đuôi key>`");
      return;
    }
    const r = removeKey(arg);
    if (!r.ok) {
      await message.reply(`không xóa được: ${r.reason}`);
      return;
    }
    await message.reply(`🗑 đã xóa \`${r.removed}\` — còn **${r.total}** key`);
    return;
  }

  await message.reply("lệnh lạ. gõ `.api help`");
}

async function handleModCommands(message) {
  if (!isStaff(message.member)) {
    await message.reply("có quyền mod đâu mà gáy lệnh 🙄");
    return;
  }

  const parts = message.content.slice(5).trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const target =
    message.mentions.users.first() ||
    (parts[1] && /^\d{16,20}$/.test(parts[1]) ? { id: parts[1] } : null);

  if (cmd === "warns" || cmd === "check") {
    if (!target) return message.reply("dùng: `!mod warns @user` (auto-mod đã tắt)");
    const rec = getUserRecord(target.id);
    return message.reply(
      `📋 <@${target.id}> — **${rec.warnings}** (legacy, auto-mod off).\n${
        rec.reasons
          .slice(-5)
          .map((r) => `• ${r.reason}`)
          .join("\n") || "không có"
      }`
    );
  }

  if (cmd === "clear" || cmd === "reset") {
    if (!target) return message.reply("dùng: `!mod clear @user`");
    clearWarnings(target.id);
    return message.reply(`đã xóa record của <@${target.id}>`);
  }

  if (cmd === "kick") {
    if (!target) return message.reply("dùng: `!mod kick @user [lý do]`");
    const member = await message.guild.members.fetch(target.id).catch(() => null);
    if (!member?.kickable) return message.reply("không kick được (thiếu quyền / role cao hơn).");
    const reason = parts.slice(2).join(" ") || "kick bởi admin";
    await member.kick(reason);
    clearWarnings(target.id);
    return message.reply(`đã kick <@${target.id}> — ${reason}`);
  }

  if (cmd === "help") {
    return message.reply(
      [
        "**Staff:** `!mod kick` (warn auto đã TẮT)",
        "",
        "**Bot = Grok 4.5** (1 não, no content filter)",
        "• Toxic/vi phạm → thẳng Grok chửi, không cảnh báo soft",
        "• Tools: look_at_images · generate_image · deploy_static_site (Surge)",
        "• `.api add/list/del` — pool API key (staff)",
        '• cười → "cười cặc"',
      ].join("\n")
    );
  }

  return message.reply("lệnh lạ. gõ `!mod help`");
}

client.on(Events.GuildCreate, (guild) => {
  console.log(`âž• joined: ${guild.name} (${guild.id})`);
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

console.log("Booting…");
client.login(config.discordToken);

















