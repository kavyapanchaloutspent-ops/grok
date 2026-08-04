/**
 * Lưu trạng thái in-memory (đủ cho Railway single instance).
 * Restart bot sẽ reset — muốn persist thì gắn Redis/DB sau.
 */

const userRecords = new Map(); // userId -> { warnings, lastWarnAt, reasons[] }
const chatHistory = new Map(); // channelId -> messages[]
const lastAiAt = new Map(); // userId -> timestamp
const lastModAt = new Map(); // userId -> timestamp
const lastDeployAt = new Map(); // userId -> timestamp
let deployBusy = false;

/** Chống Discord double-fire / process trùng cùng message */
const claimedMessages = new Map(); // messageId -> expiresAt

function emptyRecord() {
  return { warnings: 0, lastWarnAt: 0, reasons: [] };
}

export function getUserRecord(userId) {
  if (!userRecords.has(userId)) userRecords.set(userId, emptyRecord());
  return userRecords.get(userId);
}

export function addWarning(userId, reason) {
  const rec = getUserRecord(userId);
  rec.warnings += 1;
  rec.lastWarnAt = Date.now();
  rec.reasons.push({ reason, at: Date.now() });
  if (rec.reasons.length > 20) rec.reasons.shift();
  return rec;
}

export function clearWarnings(userId) {
  userRecords.set(userId, emptyRecord());
}

export function getHistory(channelId) {
  if (!chatHistory.has(channelId)) chatHistory.set(channelId, []);
  return chatHistory.get(channelId);
}

export function pushHistory(channelId, role, content, limit = 20) {
  const h = getHistory(channelId);
  h.push({ role, content });
  while (h.length > limit) h.shift();
}

export function canUseAi(userId, cooldownMs) {
  const last = lastAiAt.get(userId) || 0;
  if (Date.now() - last < cooldownMs) return false;
  lastAiAt.set(userId, Date.now());
  return true;
}

export function canRunMod(userId, cooldownMs) {
  const last = lastModAt.get(userId) || 0;
  if (Date.now() - last < cooldownMs) return false;
  lastModAt.set(userId, Date.now());
  return true;
}

/** Rate-limit deploy Surge (đông người đỡ spam) */
export function canDeploy(userId, cooldownMs) {
  if (deployBusy) return { ok: false, reason: "Đang có deploy khác chạy — thử lại sau vài giây." };
  const last = lastDeployAt.get(userId) || 0;
  const left = cooldownMs - (Date.now() - last);
  if (left > 0) {
    return { ok: false, reason: `Cooldown chậm deploy ~${Math.ceil(left / 1000)}s.` };
  }
  return { ok: true };
}

export function markDeployStart(userId) {
  deployBusy = true;
  lastDeployAt.set(userId, Date.now());
}

export function markDeployEnd() {
  deployBusy = false;
}

/** true = được xử lý; false = đang/đã xử lý */
export function claimMessage(messageId, ttlMs = 90_000) {
  if (!messageId) return true;
  const now = Date.now();
  // dọn rác nhẹ
  if (claimedMessages.size > 500) {
    for (const [id, exp] of claimedMessages) {
      if (exp < now) claimedMessages.delete(id);
    }
  }
  const exp = claimedMessages.get(messageId);
  if (exp && exp > now) return false;
  claimedMessages.set(messageId, now + ttlMs);
  return true;
}

export function releaseMessage(messageId) {
  if (messageId) claimedMessages.delete(messageId);
}


