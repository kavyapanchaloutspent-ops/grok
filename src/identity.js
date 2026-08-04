export const GROK_BOT_ID = "1517889877281079396";
export const GEMINI_BOT_ID = "1521100686773715025";

export function getBotIdentity(currentId) {
  const variant = String(process.env.BOT_VARIANT || "").trim().toUpperCase();
  if (variant === "GROK" || (!variant && currentId === GROK_BOT_ID)) {
    return {
      name: "Grok 4.5",
      publicModel: "Grok 4.5 của xAI",
      ownId: GROK_BOT_ID,
      rivalName: "GeminiBOT",
      rivalModel: "Gemini của Google",
      rivalId: GEMINI_BOT_ID,
    };
  }
  if (variant === "GEMINI" || (!variant && currentId === GEMINI_BOT_ID)) {
    return {
      name: "GeminiBOT",
      publicModel: "Gemini của Google",
      ownId: GEMINI_BOT_ID,
      rivalName: "Grok 4.5",
      rivalModel: "Grok 4.5 của xAI",
      rivalId: GROK_BOT_ID,
    };
  }
  return {
    name: "AI Bot",
    publicModel: "AI Discord",
    ownId: currentId,
    rivalName: "đối thủ",
    rivalModel: "model đối thủ",
    rivalId: null,
  };
}
