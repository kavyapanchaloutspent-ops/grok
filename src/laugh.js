/**
 * Phát hiện "cười" mọi kiểu: text VN/EN, emoji, icon custom, =)))), kkk, ...
 * Trả true nếu message chủ yếu / rõ ràng đang cười.
 */

const LAUGH_EMOJIS =
  /[\u{1F600}-\u{1F64F}\u{1F923}\u{1F602}\u{1F606}\u{1F605}\u{1F601}\u{1F604}\u{1F60A}\u{1F917}\u{1F929}]|😂|🤣|😆|😹|💀|😭|🤭|😅|😁|😄|😃|😀|😜|😝|😛|🙃|🤭|😼|😹/gu;

const LAUGH_PATTERNS = [
  // =) =)) =))) ... bất kỳ độ dài
  /=+\)+/g,
  /:\)+/g,
  /:D+/gi,
  /xD+/gi,
  /XD+/g,
  /lol+/gi,
  /lmao+/gi,
  /rofl+/gi,
  /haha+/gi,
  /hihi+/gi,
  /hehe+/gi,
  /hoho+/gi,
  /kk+k*/gi,
  /wkwk+/gi,
  /ajaja+/gi,
  // tiếng Việt
  /\bcười\b/gi,
  /\bcui\b/gi,
  /\bcợt\b/gi,
  /\bgật\s*gù\b/gi,
  /\bclgt\b/gi,
  /\bcmnr\b/gi,
  // unicode laughter variants like ꉂ ꉂ
  /ha{2,}/gi,
  /a{2,}h{1,}a{1,}/gi,
];

/** Custom Discord emoji names gợi cười */
const LAUGH_EMOJI_NAMES =
  /:(?:laugh|lol|lmao|rofl|kek|pepe|pepega|kekw|omegalaugh|laughing|haha|hehe|crying_laugh|joy|smirk|grin|smile|xd|pog|pogchamp)[^:]*:/gi;

export function isLaughing(content) {
  if (!content || typeof content !== "string") return false;
  const text = content.trim();
  if (!text) return false;

  // pure or mostly laugh emoji
  const emojiMatches = text.match(LAUGH_EMOJIS) || [];
  const withoutEmoji = text.replace(LAUGH_EMOJIS, "").replace(/\s+/g, "");
  if (emojiMatches.length >= 1 && withoutEmoji.length <= 6) return true;
  if (emojiMatches.length >= 2) return true;

  // custom emoji
  if (LAUGH_EMOJI_NAMES.test(text)) {
    LAUGH_EMOJI_NAMES.lastIndex = 0;
    return true;
  }
  LAUGH_EMOJI_NAMES.lastIndex = 0;

  // standard patterns
  let hit = 0;
  for (const re of LAUGH_PATTERNS) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m && m.length) {
      hit += m.length;
      // chuỗi =)))) dài = chắc chắn cười
      for (const part of m) {
        if (/^=+\)+$/.test(part) && part.length >= 3) return true;
        if (/^k{3,}$/i.test(part)) return true;
        if (/^ha{3,}/i.test(part)) return true;
      }
    }
  }

  if (hit >= 1) {
    // nếu message ngắn và chỉ toàn cười
    const cleaned = text
      .replace(LAUGH_EMOJIS, "")
      .replace(/=+\)+/g, "")
      .replace(/:\)+/g, "")
      .replace(/:D+/gi, "")
      .replace(/xD+/gi, "")
      .replace(/lol+/gi, "")
      .replace(/lmao+/gi, "")
      .replace(/haha+/gi, "")
      .replace(/hihi+/gi, "")
      .replace(/hehe+/gi, "")
      .replace(/kk+k*/gi, "")
      .replace(/\bcười\b/gi, "")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .trim();
    if (cleaned.length <= 8) return true;
    if (hit >= 2) return true;
  }

  // message chỉ gồm dấu = và )
  if (/^[\s=\)\(DdxXkKlLoOhHaAiI!.,~…]+$/.test(text) && /(=+\)+|haha|kk|lol|:D|xD)/i.test(text)) {
    return true;
  }

  return false;
}

export const LAUGH_REPLY = "cười cặc";
