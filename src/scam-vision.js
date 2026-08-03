import OpenAI from "openai";
import { config } from "./config.js";

let client = null;

function openRouterClient() {
  if (!config.openRouter.apiKey) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: config.openRouter.apiKey,
      baseURL: config.openRouter.baseURL,
    });
  }
  return client;
}

function imageAttachments(message) {
  return [...(message.attachments?.values?.() || [])]
    .filter((attachment) => {
      const contentType = String(attachment.contentType || "").toLowerCase();
      return contentType.startsWith("image/") ||
        /\.(?:png|jpe?g|gif|webp)(?:\?|$)/i.test(attachment.url || "");
    })
    .slice(0, 4);
}

function parseJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

export async function inspectFourImageScam(message) {
  const api = openRouterClient();
  if (!api) return { checked: false, reason: "missing_openrouter_key" };

  const images = imageAttachments(message);
  if (images.length < 4) return { checked: false, reason: "not_four_images" };

  try {
    const response = await api.chat.completions.create({
      model: config.openRouter.visionModel,
      temperature: 0,
      max_tokens: 450,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a strict Discord anti-scam vision classifier.",
            "Inspect all four images together. Detect coordinated MrBeast impersonation/giveaway scams:",
            "fake MrBeast branding or likeness, promises of free money/prizes, QR codes or suspicious links,",
            "instructions to click/claim/connect/download, urgency, repeated ad panels, or botnet-style spam.",
            "Do not flag ordinary MrBeast memes, news, fan art, or legitimate discussion without scam solicitation.",
            "Return JSON only with keys: is_mrbeast_scam (boolean), confidence (0..1), summary (Vietnamese string), signals (string array).",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Phân loại bộ 4 ảnh Discord này. Chỉ kết luận scam khi bằng chứng trực quan rõ ràng." },
            ...images.map((attachment) => ({
              type: "image_url",
              image_url: { url: attachment.url },
            })),
          ],
        },
      ],
    });

    const result = parseJson(response.choices?.[0]?.message?.content);
    const confidence = Math.max(0, Math.min(1, Number(result?.confidence) || 0));
    return {
      checked: true,
      scam: result?.is_mrbeast_scam === true && confidence >= 0.85,
      confidence,
      summary: String(result?.summary || "").slice(0, 300),
      signals: Array.isArray(result?.signals) ? result.signals.slice(0, 6).map(String) : [],
    };
  } catch (error) {
    console.error("[openrouter vision]", error?.message || error);
    return { checked: false, reason: "vision_error" };
  }
}
