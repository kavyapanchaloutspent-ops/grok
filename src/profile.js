/**
 * Lấy info user/role/avatar/ảnh đính kèm — để AI tự khịa, không cần lệnh.
 * Avatar được GÁN NHÃN rõ: người nhắn vs người được mention/reply.
 */

function fmtDate(d) {
  if (!d) return null;
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function daysSince(d) {
  if (!d) return null;
  const ms = Date.now() - new Date(d).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

const LABEL_VI = {
  author: "AVATAR CỦA NGƯỜI ĐANG NHẮN (author — người gửi tin này)",
  mentioned: "AVATAR CỦA NGƯỜI ĐƯỢC MENTION (người kia / target)",
  reply_to: "AVATAR CỦA NGƯỜI ĐƯỢC REPLY (người kia / tin gốc)",
  explicit_id: "AVATAR CỦA DISCORD ID ĐƯỢC GÕ TRỰC TIẾP (target)",
  attachment: "ẢNH ĐÍNH KÈM TRONG TIN NHẮN (không phải avatar)",
  reply_attachment: "ẢNH TRONG TIN REPLY",
};

/**
 * Profile 1 member để AI khịa.
 */
export function buildMemberProfile(member, user) {
  const u = user || member?.user;
  if (!u) return null;

  const roles =
    member?.roles?.cache
      ?.filter((r) => r.name !== "@everyone")
      ?.sort((a, b) => b.position - a.position)
      ?.map((r) => r.name)
      ?.slice(0, 15) || [];

  const highest = roles[0] || "không role";
  const avatar = u.displayAvatarURL?.({ extension: "png", size: 512, forceStatic: false }) || null;
  const banner = u.bannerURL?.({ extension: "png", size: 512 }) || null;

  return {
    id: u.id,
    username: u.username,
    globalName: u.globalName || null,
    displayName: member?.displayName || u.globalName || u.username,
    nickname: member?.nickname || null,
    bot: Boolean(u.bot),
    roles,
    highestRole: highest,
    roleCount: roles.length,
    accountCreated: fmtDate(u.createdAt),
    accountAgeDays: daysSince(u.createdAt),
    joinedServer: fmtDate(member?.joinedAt),
    serverDays: daysSince(member?.joinedAt),
    booster: Boolean(member?.premiumSince),
    timedOut: Boolean(member?.isCommunicationDisabled?.()),
    avatarUrl: avatar,
    bannerUrl: banner,
    accentColor: u.hexAccentColor || null,
    defaultAvatar: Boolean(u.defaultAvatarURL && avatar?.includes("embed/avatars")),
  };
}

export function collectMessageImages(message, { max = 4 } = {}) {
  const urls = [];

  for (const att of message.attachments?.values?.() || message.attachments || []) {
    const a = att;
    const url = a.url || a.proxyURL;
    const name = (a.name || "").toLowerCase();
    const ct = (a.contentType || "").toLowerCase();
    const isImg =
      ct.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(url || "") ||
      /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
    if (url && isImg) urls.push(url);
    if (urls.length >= max) return urls;
  }

  for (const emb of message.embeds || []) {
    if (emb.image?.url) urls.push(emb.image.url);
    else if (emb.thumbnail?.url) urls.push(emb.thumbnail.url);
    if (urls.length >= max) return urls;
  }

  for (const st of message.stickers?.values?.() || []) {
    if (st.url) urls.push(st.url);
    if (urls.length >= max) return urls;
  }

  return [...new Set(urls)].slice(0, max);
}

/**
 * @returns {{
 *   profiles: any[],
 *   imageUrls: string[],
 *   visionItems: { url: string, label: string, kind: string, name?: string }[],
 *   textBlock: string
 * }}
 */
export async function gatherIntel(message, clientUserId) {
  const guild = message.guild;
  const profiles = [];
  const visionItems = [];
  const seenUsers = new Set();
  const seenUrls = new Set();

  function pushVision(url, kind, name) {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    visionItems.push({
      url,
      kind,
      name: name || null,
      label: LABEL_VI[kind] || kind,
    });
  }

  async function addMember(userId, kind) {
    if (!userId || seenUsers.has(userId)) return;
    if (clientUserId && userId === clientUserId) return;
    seenUsers.add(userId);

    let member = message.guild?.members?.cache?.get(userId) || null;
    if (!member && guild) {
      member = await guild.members.fetch(userId).catch(() => null);
    }
    let user = member?.user || message.mentions?.users?.get(userId) || null;
    if (!user && message.client?.users) {
      user = await message.client.users.fetch(userId).catch(() => null);
    }
    if (user?.fetch) {
      try {
        user = await user.fetch(true);
      } catch {
        /* ignore */
      }
    }

    const profile = buildMemberProfile(member, user);
    if (profile) {
      profile._label = kind;
      profile._labelVi =
        kind === "author"
          ? "NGƯỜI ĐANG NHẮN (author)"
          : kind === "mentioned"
            ? "NGƯỜI ĐƯỢC MENTION (người kia)"
            : kind === "reply_to"
              ? "NGƯỜI ĐƯỢC REPLY (người kia)"
              : kind === "explicit_id"
                ? "NGƯỜI CÓ DISCORD ID ĐƯỢC GÕ TRỰC TIẾP (target)"
                : kind;
      profiles.push(profile);
      if (profile.avatarUrl) {
        pushVision(
          profile.avatarUrl,
          kind,
          profile.displayName || profile.username
        );
      }
    }
  }

  // Ảnh đính kèm tin nhắn trước
  for (const url of collectMessageImages(message, { max: 4 })) {
    pushVision(url, "attachment");
  }

  // Author — luôn gắn nhãn "người đang nhắn"
  await addMember(message.author.id, "author");

  // Mentions = "người kia"
  for (const [id] of message.mentions?.users || []) {
    await addMember(id, "mentioned");
  }

  // Discord ID gõ trần trong nội dung — ví dụ "xem avatar 1433427819739873402".
  // Không phụ thuộc mention nên tool luôn có đúng avatar target để xem.
  const explicitIds = [...String(message.content || "").matchAll(/(?<!\d)(\d{17,20})(?!\d)/g)]
    .map((match) => match[1])
    .filter((id) => id !== message.author.id && id !== clientUserId)
    .slice(0, 4);
  for (const id of explicitIds) {
    await addMember(id, "explicit_id");
  }
  // Reply target
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      if (ref?.author?.id) await addMember(ref.author.id, "reply_to");
      for (const u of collectMessageImages(ref, { max: 2 })) {
        pushVision(u, "reply_attachment");
      }
    } catch {
      /* ignore */
    }
  }

  return {
    profiles,
    imageUrls: visionItems.map((v) => v.url).slice(0, 8),
    visionItems: visionItems.slice(0, 8),
    textBlock: formatIntelText(profiles),
  };
}

function formatIntelText(profiles) {
  if (!profiles?.length) return "(không có profile)";
  return profiles
    .map((p) => {
      const who = p._labelVi || p._label || "user";
      const lines = [
        `[${who}] ${p.displayName} (@${p.username}) id=${p.id}`,
        p._label === "author"
          ? "  ★ Đây là NGƯỜI ĐANG GỬI TIN / đang chat với bot."
          : "  ★ Đây là NGƯỜI KHÁC (không phải người nhắn) — khi user kêu soi avatar người này thì dùng cái này.",
        p.nickname ? `  nick: ${p.nickname}` : null,
        `  roles (${p.roleCount}): ${p.roles.join(", ") || "không"} | highest: ${p.highestRole}`,
        `  acc: ${p.accountCreated} (${p.accountAgeDays}d) | join: ${p.joinedServer || "?"} (${p.serverDays ?? "?"}d)`,
        `  booster: ${p.booster} | timeout: ${p.timedOut} | bot: ${p.bot} | defaultAvatar: ${p.defaultAvatar}`,
        p.avatarUrl
          ? `  avatar_url: ${p.avatarUrl} (${p._label === "author" ? "AVATAR NGƯỜI NHẮN" : "AVATAR NGƯỜI KIA"})`
          : null,
      ];
      return lines.filter(Boolean).join("\n");
    })
    .join("\n\n");
}
