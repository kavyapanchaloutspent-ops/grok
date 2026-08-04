import { PermissionFlagsBits } from "discord.js";

function userSummary(user) {
  if (!user) return null;
  return {
    id: user.id,
    mention: `<@${user.id}>`,
    username: user.username,
    globalName: user.globalName || null,
    bot: Boolean(user.bot),
    createdAt: user.createdAt?.toISOString?.() || null,
    avatarUrl: user.displayAvatarURL?.({ extension: "png", size: 512 }) || null,
  };
}

function memberSummary(member) {
  return {
    ...userSummary(member.user),
    displayName: member.displayName,
    nickname: member.nickname || null,
    joinedAt: member.joinedAt?.toISOString?.() || null,
    roles: member.roles.cache
      .filter((role) => role.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name }))
      .slice(0, 20),
  };
}

export async function runDiscordInspect(message, args = {}) {
  const guild = message.guild;
  if (!guild) throw new Error("Tool Discord cần chạy trong server.");
  const action = String(args.action || "server_info");

  if (action === "server_info") {
    const owner = await guild.fetchOwner().catch(() => null);
    return {
      ok: true,
      action,
      server: {
        id: guild.id,
        name: guild.name,
        description: guild.description || null,
        owner: owner ? memberSummary(owner) : { id: guild.ownerId, mention: `<@${guild.ownerId}>` },
        memberCount: guild.memberCount,
        channels: guild.channels.cache.size,
        roles: guild.roles.cache.size,
        emojis: guild.emojis.cache.size,
        boosts: guild.premiumSubscriptionCount || 0,
        boostTier: guild.premiumTier,
        createdAt: guild.createdAt?.toISOString?.() || null,
        iconUrl: guild.iconURL?.({ extension: "png", size: 512 }) || null,
      },
    };
  }

  if (action === "user_info") {
    const userId = String(args.user_id || "").replace(/\D/g, "");
    if (!/^\d{16,20}$/.test(userId)) throw new Error("user_id không hợp lệ.");
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) return { ok: true, action, inServer: true, user: memberSummary(member) };
    const user = await message.client.users.fetch(userId, { force: true }).catch(() => null);
    if (!user) return { ok: false, action, inServer: false, error: "Discord không trả user cho ID này." };
    return { ok: true, action, inServer: false, user: userSummary(user) };
  }

  if (action === "find_members") {
    const query = String(args.query || "").trim().toLocaleLowerCase("vi");
    if (!query) throw new Error("Thiếu query tên cần tìm.");
    await guild.members.fetch().catch(() => null);
    const mode = args.match === "exact" ? "exact" : "contains";
    const matches = guild.members.cache.filter((member) => {
      const names = [member.user.username, member.user.globalName, member.displayName, member.nickname]
        .filter(Boolean)
        .map((name) => String(name).toLocaleLowerCase("vi"));
      return mode === "exact" ? names.some((name) => name === query) : names.some((name) => name.includes(query));
    });
    const all = [...matches.values()];
    return {
      ok: true,
      action,
      query,
      match: mode,
      count: all.length,
      truncated: all.length > 50,
      members: all.slice(0, 50).map(memberSummary),
      instruction: "Báo tổng count. Chỉ dùng mention khi user yêu cầu rõ; không bịa thêm ID.",
    };
  }

  if (action === "set_nickname") {
    const requester = message.member;
    const target = args.target === "all" ? "all" : "user";
    const isAdmin = requester?.permissions?.has(PermissionFlagsBits.Administrator);
    const canManageNicknames = isAdmin || requester?.permissions?.has(PermissionFlagsBits.ManageNicknames);
    if (!canManageNicknames) throw new Error("M cần quyền Manage Nicknames để dùng chức năng này.");
    if (target === "all" && !isAdmin) throw new Error("Đổi nickname toàn server yêu cầu Administrator.");

    const reset = Boolean(args.reset);
    const nickname = reset ? null : String(args.nickname ?? "").trim();
    if (!reset && !nickname) throw new Error("Thiếu nickname mới; dùng reset=true để xóa nickname.");
    if (nickname && nickname.length > 32) throw new Error("Nickname Discord tối đa 32 ký tự.");

    if (target === "user") {
      const userId = String(args.user_id || "").replace(/\D/g, "");
      if (!/^\d{16,20}$/.test(userId)) throw new Error("Thiếu user_id hợp lệ.");
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) throw new Error("User không ở trong server nên không thể đổi nickname server.");
      if (member.id === guild.ownerId) throw new Error("Không thể đổi nickname server owner.");
      if (member.id === message.client.user.id) throw new Error("Không dùng tool này để đổi nickname chính bot.");
      if (!member.manageable) throw new Error("Role bot không đủ cao để đổi nickname người này.");
      if (!isAdmin && requester.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
        throw new Error("Role của m không cao hơn target.");
      }
      await member.setNickname(nickname, `AI nickname request by ${message.author.id}`);
      return { ok: true, action, target, changed: 1, member: memberSummary(member), nickname };
    }

    await guild.members.fetch();
    const candidates = [...guild.members.cache.values()].filter((member) =>
      member.id !== guild.ownerId &&
      member.id !== message.client.user.id &&
      member.manageable
    );
    let changed = 0;
    const failed = [];
    for (let i = 0; i < candidates.length; i += 10) {
      const batch = candidates.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map((member) => member.setNickname(nickname, `AI bulk nickname by ${message.author.id}`))
      );
      results.forEach((result, index) => {
        if (result.status === "fulfilled") changed += 1;
        else failed.push({ id: batch[index].id, error: String(result.reason?.message || result.reason).slice(0, 120) });
      });
    }
    return {
      ok: true,
      action,
      target,
      nickname,
      attempted: candidates.length,
      changed,
      failed: failed.length,
      failedSamples: failed.slice(0, 10),
      skippedUnmanageable: guild.memberCount - candidates.length,
    };
  }
  throw new Error(`Discord action không hỗ trợ: ${action}`);
}

