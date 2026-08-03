import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
  return String(v).trim();
}

function list(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  clientId: process.env.DISCORD_CLIENT_ID || "",
  adminUserIds: list("ADMIN_USER_IDS"),
  adminRoleIds: list("ADMIN_ROLE_IDS"),

  ai: {
    /** Primary key (pool còn load thêm AI_API_KEYS + lệnh .api) */
    apiKey: process.env.AI_API_KEY || process.env.AI_API_KEYS?.split(/[\s,;]+/).filter(Boolean)[0] || "",
    baseURL: process.env.AI_BASE_URL || "https://api.xkiro.com/v1",
    /** Model chính — mọi reply user */
    model: process.env.AI_MODEL || "deepseek/deepseek-v4-pro",
    /** Model phụ — chỉ xem ảnh (vision) — Mistral Large */
    visionModel: process.env.AI_VISION_MODEL || "mistralai/mistral-large-2512",
  },

  /** Cloudflare Workers AI — FLUX.1 schnell (tạo ảnh) */
  cf: {
    accountId: process.env.CF_ACCOUNT_ID || "",
    apiToken: process.env.CF_API_TOKEN || "",
    steps: Number(process.env.CF_FLUX_STEPS || 4),
  },

  /** Surge.sh — deploy site tĩnh (tool của Grok, không log token) */
  surge: {
    login: process.env.SURGE_LOGIN || "",
    token: process.env.SURGE_TOKEN || "",
    /** cooldown deploy mỗi user (ms) */
    cooldownMs: Number(process.env.SURGE_COOLDOWN_MS || 60_000),
  },

  warnThreshold: Number(process.env.WARN_THRESHOLD || 3),
  kickThreshold: Number(process.env.KICK_THRESHOLD || 5),
  muteMinutes: Number(process.env.MUTE_MINUTES || 10),
  requireMention: String(process.env.REQUIRE_MENTION ?? "true").toLowerCase() !== "false",
  botName: process.env.BOT_NAME || "Grok",

  /** Giữ lịch sử chat AI theo channel (tin nhắn) — vừa đủ nhớ, không quá dài (chậm) */
  historyLimit: Number(process.env.HISTORY_LIMIT || 14),
  /** Cooldown AI reply mỗi user (ms) — thấp hơn = trả lời nhanh hơn, vẫn chống spam */
  aiCooldownMs: Number(process.env.AI_COOLDOWN_MS || 1200),
  /** Rate limit moderation AI (ms) giữa 2 lần check nặng */
  modCooldownMs: 800,
};
