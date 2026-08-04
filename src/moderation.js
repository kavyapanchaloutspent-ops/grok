import { PermissionFlagsBits } from "discord.js";
import { config } from "./config.js";
import { getUserRecord, clearWarnings } from "./store.js";

/**
 * Lọc nội dung vi phạm: ĐÃ TẮT.
 * Toxic / "vi phạm" → index gửi thẳng Nemotron (Grok 4.5 persona) để chửi.
 * File này chỉ còn staff helpers + lệnh !mod tay.
 */

function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ModerateMembers)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.adminUserIds.includes(member.id)) return true;
  if (member.roles?.cache?.some((r) => config.adminRoleIds.includes(r.id))) return true;
  return false;
}

/** Always no-op — không filter, không warn auto */
export async function handleModeration() {
  return { handled: false };
}

export { isStaff, clearWarnings, getUserRecord };
