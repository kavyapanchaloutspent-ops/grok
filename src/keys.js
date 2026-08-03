/**
 * Pool API keys — round-robin mỗi request + rotate khi lỗi.
 * Thêm runtime bằng lệnh .api (staff).
 * Không log full key.
 */

import { config } from "./config.js";

/** @type {string[]} */
const keys = [];
let cursor = 0;

function normalizeKey(k) {
  return String(k || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function isValidKey(k) {
  const s = normalizeKey(k);
  return s.length >= 20 && /^(sk-|sk-xt-)/i.test(s);
}

export function maskKey(k) {
  const s = normalizeKey(k);
  if (s.length < 12) return "***";
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

function uniquePush(k) {
  const s = normalizeKey(k);
  if (!isValidKey(s)) return { ok: false, reason: "key không hợp lệ (cần sk- / sk-xt- …)" };
  if (keys.includes(s)) return { ok: false, reason: "key đã có trong pool", key: s, masked: maskKey(s) };
  keys.push(s);
  return { ok: true, key: s, masked: maskKey(s), index: keys.length - 1 };
}

export function initKeyPool() {
  keys.length = 0;
  cursor = 0;

  const fromSingle = config.ai.apiKey;
  const fromList = (process.env.AI_API_KEYS || "")
    .split(/[\s,;]+/)
    .map(normalizeKey)
    .filter(Boolean);

  for (const k of [fromSingle, ...fromList].filter(Boolean)) uniquePush(k);

  if (!keys.length) {
    throw new Error("Không có AI API key nào (AI_API_KEY / AI_API_KEYS)");
  }

  console.log(`[keys] pool = ${keys.length} key(s): ${keys.map(maskKey).join(", ")}`);
  return keys.length;
}

export function getKeyCount() {
  return keys.length;
}

export function listKeysMasked() {
  return keys.map((k, i) => ({ index: i, masked: maskKey(k) }));
}

export function getCurrentKey() {
  if (!keys.length) throw new Error("pool key rỗng");
  return keys[cursor % keys.length];
}

/**
 * Lấy key cho 1 request — round-robin ngay (tránh 2 request dính cùng key/body fingerprint).
 */
export function acquireKey() {
  if (!keys.length) throw new Error("pool key rỗng");
  const k = keys[cursor % keys.length];
  cursor = (cursor + 1) % keys.length;
  return k;
}

export function rotateKey(reason = "") {
  if (keys.length <= 1) return getCurrentKey();
  cursor = (cursor + 1) % keys.length;
  console.log(`[keys] rotate → #${cursor} ${maskKey(keys[cursor])}${reason ? ` (${reason})` : ""}`);
  return keys[cursor];
}

export function addKeys(input) {
  const parts = String(input || "")
    .split(/[\s,;]+/)
    .map(normalizeKey)
    .filter(Boolean);

  const added = [];
  const skipped = [];
  for (const p of parts) {
    const r = uniquePush(p);
    if (r.ok) added.push(r.masked);
    else skipped.push({ masked: isValidKey(p) ? maskKey(p) : p.slice(0, 12), reason: r.reason });
  }
  return { added, skipped, total: keys.length };
}

export function removeKey(query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, reason: "thiếu index hoặc đuôi key" };

  let idx = -1;
  if (/^\d+$/.test(q)) idx = Number(q);
  else idx = keys.findIndex((k) => k.endsWith(q) || maskKey(k).includes(q) || k.includes(q));

  if (idx < 0 || idx >= keys.length) return { ok: false, reason: "không tìm thấy key" };
  if (keys.length <= 1) return { ok: false, reason: "phải giữ ít nhất 1 key" };

  const removed = maskKey(keys[idx]);
  keys.splice(idx, 1);
  if (cursor >= keys.length) cursor = 0;
  return { ok: true, removed, total: keys.length };
}

export function shouldRotateOnError(err) {
  const status = err?.status || err?.response?.status || err?.statusCode;
  const msg = String(err?.message || err || "").toLowerCase();
  if (status === 401 || status === 403 || status === 402 || status === 429) return true;
  if (status === 409) return true; // duplicate — đổi key thường hết
  if (/invalid.*key|incorrect.*key|unauthorized|forbidden|quota|insufficient|balance|credit/i.test(msg)) {
    return true;
  }
  if (/rate limit|too many|duplicate request|already being processed/i.test(msg)) return true;
  return false;
}
