/**
 * Cloudflare Workers AI — FLUX.1 schnell (tool phụ cho DeepSeek).
 * POST /accounts/{id}/ai/run/@cf/black-forest-labs/flux-1-schnell
 */

import { config } from "./config.js";

const MODEL = "@cf/black-forest-labs/flux-1-schnell";

/**
 * @returns {{ buffer: Buffer, url: string|null, prompt: string, fileName: string }}
 */
export async function generateImage(prompt, opts = {}) {
  const clean = String(prompt || "")
    .trim()
    .slice(0, 2048)
    .replace(/\s+/g, " ");
  if (!clean) throw new Error("prompt rỗng");

  const accountId = config.cf.accountId;
  const token = config.cf.apiToken;
  if (!accountId || !token) {
    throw new Error("Thiếu CF_ACCOUNT_ID hoặc CF_API_TOKEN");
  }

  const steps = Math.min(8, Math.max(1, Number(opts.steps) || config.cf.steps || 4));
  const seed =
    opts.seed != null
      ? Number(opts.seed)
      : Math.floor(Math.random() * 999_999_999) + 1;

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: clean,
      steps,
      seed,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Cloudflare không trả JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }

  if (!res.ok || data.success === false) {
    const errMsg =
      data?.errors?.[0]?.message ||
      data?.messages?.[0] ||
      raw.slice(0, 200) ||
      `HTTP ${res.status}`;
    throw new Error(`Cloudflare Flux: ${errMsg}`);
  }

  const b64 = data?.result?.image;
  if (!b64 || typeof b64 !== "string") {
    throw new Error("Cloudflare không trả result.image (base64)");
  }

  const buffer = Buffer.from(b64, "base64");
  if (buffer.length < 500) {
    throw new Error("ảnh base64 quá nhỏ / lỗi decode");
  }

  return {
    buffer,
    url: null,
    prompt: clean,
    fileName: `flux_${seed}.jpg`,
  };
}
