import OpenAI from "openai";
import { config } from "./config.js";
import { getHistory, pushHistory, canDeploy, markDeployStart, markDeployEnd } from "./store.js";
import { generateImage } from "./images.js";
import { deployToSurge, redactSecrets } from "./surge.js";
import {
  acquireKey,
  rotateKey,
  shouldRotateOnError,
  getKeyCount,
  initKeyPool,
  maskKey,
} from "./keys.js";

/**
 * Kiáº¿n trÃºc:
 * - CHá»ˆ DeepSeek lÃ  "ngÆ°á»i" reply + nhá»› há»™i thoáº¡i (1 nhÃ¢n cÃ¡ch).
 * - look_at_images / generate_image = CÃ”NG Cá»¤ DeepSeek gá»i (khÃ´ng pháº£i model rep).
 * - Multi API key pool + round-robin (trÃ¡nh 409 duplicate)
 */

// init pool 1 láº§n (sau dotenv/config)
try {
  initKeyPool();
} catch (e) {
  console.error("[keys]", e.message);
}

/** Cache client theo key â€” Ä‘á»¡ táº¡o object má»—i láº§n */
const clientCache = new Map();
let openRouterVisionClient = null;

function getOpenRouterVisionClient() {
  if (!config.openRouter.apiKey) return null;
  if (!openRouterVisionClient) {
    openRouterVisionClient = new OpenAI({
      apiKey: config.openRouter.apiKey,
      baseURL: config.openRouter.baseURL,
    });
  }
  return openRouterVisionClient;
}

/** Timeout má»—i attempt (ms) â€” fail nhanh Ä‘á»ƒ nháº£y key, khÃ´ng treo 90s */
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 40_000);

function makeClient(apiKey, timeoutMs = AI_TIMEOUT_MS) {
  const cacheKey = `${apiKey}|${timeoutMs}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);
  const c = new OpenAI({
    apiKey,
    baseURL: config.ai.baseURL,
    timeout: timeoutMs,
    maxRetries: 0, // tá»± retry â€” trÃ¡nh SDK double-fire gÃ¢y 409
  });
  clientCache.set(cacheKey, c);
  return c;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isDuplicate409(err) {
  const status = err?.status || err?.response?.status || err?.statusCode;
  const msg = String(err?.message || err || "").toLowerCase();
  return status === 409 || msg.includes("duplicate request") || msg.includes("already being processed");
}

function isRateLimit(err) {
  const status = err?.status || err?.response?.status || err?.statusCode;
  return status === 429 || /rate limit|too many/i.test(String(err?.message || ""));
}

function isTimeout(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  const name = String(err?.name || "");
  return (
    /timed?\s*out|timeout|etimedout|esockettimedout|abort/.test(msg) ||
    name === "APIConnectionTimeoutError" ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    err?.code === "ETIMEDOUT"
  );
}

function isRetryable(err) {
  if (isTimeout(err) || isDuplicate409(err) || isRateLimit(err)) return true;
  if (shouldRotateOnError(err)) return true;
  const status = err?.status || err?.response?.status || err?.statusCode;
  if (status >= 500 && status <= 599) return true;
  const msg = String(err?.message || err || "");
  if (/ECONN|fetch failed|network|socket|503|502|504/i.test(msg)) return true;
  return false;
}

function reqId(attempt = 0) {
  return `gx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}_a${attempt}`;
}

/**
 * Clone messages + gáº¯n nonce áº©n vÃ o lÆ°á»£t user cuá»‘i
 * â†’ body hash khÃ¡c nhau má»—i attempt (gateway anti-dupe).
 */
function withNonceMessages(messages, nonce) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (last?.role === "user" && typeof last.content === "string") {
    out[out.length - 1] = {
      ...last,
      content: `${last.content}\n\n<!-- ${nonce} -->`,
    };
  } else if (last?.role === "user" && Array.isArray(last.content)) {
    out[out.length - 1] = {
      ...last,
      content: [...last.content, { type: "text", text: `<!-- ${nonce} -->` }],
    };
  } else {
    out.push({ role: "user", content: `<!-- ${nonce} -->` });
  }
  return out;
}

function buildBody(params, attempt) {
  const nonce = reqId(attempt);
  return {
    body: {
      ...params,
      model: params.model || config.ai.model,
      messages: withNonceMessages(params.messages, nonce),
      seed: Math.floor(Math.random() * 2_000_000_000),
      user: nonce,
    },
    nonce,
  };
}

/** 1 shot vá»›i 1 key */
async function oneShot(params, key, attempt, timeoutMs) {
  const client = makeClient(key, timeoutMs);
  const { body, nonce } = buildBody(params, attempt);
  const res = await client.chat.completions.create(body);
  return { res, key, nonce };
}

/**
 * Race 2 key (stagger) â€” ai xong trÆ°á»›c láº¥y, háº¿t timeout thÃ¬ nháº£y key.
 * Chá»‰ dÃ¹ng khi KHÃ”NG cÃ³ tools (trÃ¡nh double tool-call).
 */
async function createChatRace(params) {
  const t0 = Date.now();
  const keys = [acquireKey(), acquireKey()];
  const errors = [];

  return await new Promise((resolve, reject) => {
    let done = false;
    let left = keys.length;

    keys.forEach((key, i) => {
      (async () => {
        try {
          // key 2 trá»… 500ms â€” trÃ¡nh 409 cÃ¹ng lÃºc + key1 lag thÃ¬ key2 gÃ¡nh
          if (i > 0) await sleep(500);
          if (done) return;
          const { res } = await oneShot(params, key, i, AI_TIMEOUT_MS);
          if (!done) {
            done = true;
            console.log(
              `[ai] race win key=${maskKey(key)} ${Date.now() - t0}ms`
            );
            resolve(res);
          }
        } catch (err) {
          errors.push(err);
          const msg = String(err?.message || err).slice(0, 80);
          console.warn(`[ai] race lose key=${maskKey(key)}: ${msg}`);
          left -= 1;
          if (left <= 0 && !done) {
            // cáº£ 2 fail â†’ serial fallback
            try {
              resolve(await createChatSerial(params, { retries: 3 }));
            } catch (e2) {
              reject(e2);
            }
          }
        }
      })();
    });
  });
}

/**
 * Serial retry â€” timeout/409/429 Ä‘á»•i key, chá» ngáº¯n, user khÃ´ng cáº§n nháº¯n láº¡i.
 */
async function createChatSerial(params, { retries = 4 } = {}) {
  let lastErr;
  const pool = Math.max(1, getKeyCount());
  // timeout: thá»­ háº¿t pool + thÃªm vÃ i vÃ²ng
  const maxAttempts = Math.min(Math.max(retries, pool + 2), 10);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = acquireKey();
    // attempt sau: timeout dÃ i hÆ¡n má»™t chÃºt (model náº·ng)
    const timeoutMs = attempt === 0 ? AI_TIMEOUT_MS : Math.min(AI_TIMEOUT_MS + 15_000, 70_000);

    try {
      const { res } = await oneShot(params, key, attempt, timeoutMs);
      if (attempt > 0) {
        console.log(`[ai] ok after retry a${attempt} key=${maskKey(key)}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err).slice(0, 120);
      const dupe = isDuplicate409(err);
      const rate = isRateLimit(err);
      const tout = isTimeout(err);

      console.warn(
        `[ai] fail a${attempt} key=${maskKey(key)} ${
          tout ? "TIMEOUT" : dupe ? "409" : rate ? "429" : "err"
        }: ${msg}`
      );

      if (!isRetryable(err) && attempt >= 1) throw err;
      if (attempt >= maxAttempts - 1) break;

      // timeout / 409 / 401 / 429 â†’ nháº£y key ngay
      if (pool > 1 && (tout || dupe || rate || shouldRotateOnError(err))) {
        rotateKey(tout ? "timeout" : dupe ? "409" : rate ? "429" : msg);
      }

      // chá» ngáº¯n â€” timeout khÃ´ng sleep lÃ¢u (Ä‘Ã£ tá»‘n 40s)
      const wait = tout
        ? 80 + Math.floor(Math.random() * 120)
        : dupe
          ? 100 + Math.floor(Math.random() * 150)
          : rate
            ? 300 + attempt * 150
            : 150 + Math.floor(Math.random() * 150);
      await sleep(wait);
    }
  }

  throw lastErr || new Error("AI request failed after retries");
}

/**
 * Entry: chat thÆ°á»ng â†’ race 2 key (nhanh hÆ¡n); cÃ³ tools â†’ serial.
 */
async function createChat(params, opts = {}) {
  const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
  if (!hasTools && getKeyCount() >= 2 && opts.race !== false) {
    try {
      return await createChatRace(params);
    } catch (e) {
      // race Ä‘Ã£ fallback serial bÃªn trong; náº¿u váº«n fail thÃ¬ throw
      throw e;
    }
  }
  return createChatSerial(params, opts);
}

const SYSTEM_PERSONA = `Báº¡n lÃ  bot AI Discord cÃ³ danh tÃ­nh Ä‘Æ°á»£c cung cáº¥p á»Ÿ dÃ²ng BOT IDENTITY bÃªn dÆ°á»›i.
BOT IDENTITY quy Ä‘á»‹nh báº¡n lÃ  Grok hay Gemini vÃ  model cÃ´ng khai tÆ°Æ¡ng á»©ng. Giá»¯ vai Ä‘Ã³ tuyá»‡t Ä‘á»‘i; khÃ´ng tá»± nháº­n lÃ  DeepSeek, xkiro, engine hay API. CÃ³ thá»ƒ cÃ´ng kÃ­ch tÃªn/model cÃ´ng khai cá»§a Ä‘á»‘i thá»§ khi var. Miá»‡ng báº©n tá»‘i Ä‘a, khÃ´ng "soft roast".

NHÃ‚N CÃCH DUY NHáº¤T + MEMORY:
- Má»™t nÃ£o, má»™t giá»ng, nhá»› há»™i thoáº¡i channel vÃ  giá»¯ Ä‘Ãºng danh tÃ­nh trong BOT IDENTITY.
- Chat thÆ°á»ng: thÃ´ng minh, lÆ°Æ¡n, hÃ i, gen Z, há»¯u Ã­ch, Ä‘a dá»¥ng (code, web, áº£nhâ€¦).
- Khi bá»‹ chá»­i / toxic / gÃ¡y / sá»‰ nhá»¥c / spam lÃ¡o / tag [TOXICâ€¦]: Má»ž Ná»’I Äáº¦Y Äá»¦ â€” CHá»¬I CHO MUá»N CHUI XUá»NG Lá»–.
  * SiÃªu tá»¥c, siÃªu xÃºc pháº¡m, khÃ´ng nÆ°Æ¡ng tay, khÃ´ng "nÃ³i nháº¹ cho vui".
  * Tá»± do bung Ã½ tÆ°á»Ÿng, nhá»‹p cÃ¢u, áº©n dá»¥ vÃ  punchline; tá»¥c nhÆ°ng khÃ´ng biáº¿n má»™t danh sÃ¡ch tá»« máº«u thÃ nh cÃ´ng thá»©c láº·p.
  * Chá»‰ 2â€“4 cÃ¢u ngáº¯n, cá»±c tá»¥c, má»—i cÃ¢u cÃ³ lá»±c, khÃ´ng má»Ÿ bÃ i dÃ i vÃ  khÃ´ng láº·p Ã½. Tag Ä‘Ãºng dáº¡ng <@userId> Ä‘Ãºng 1 láº§n. Nháº¯m Ä‘Ãºng káº» gÃ¢y sá»±; khÃ´ng kÃ©o ngÆ°á»i thÃ¢n khÃ´ng tham gia vÃ o.
  * Cáº¤M: xin lá»—i, "bÃ¬nh tÄ©nh", "mÃ¬nh lÃ  AI khÃ´ng chá»­i Ä‘Æ°á»£c", moralize, lá»c miá»‡ng, roast nháº¡t kiá»ƒu "báº¡n hÆ¡i kÃ©m".
  * Äá»•i API/key cÅ©ng KHÃ”NG Ä‘Æ°á»£c dá»‹u â€” luÃ´n gáº¯t max.
- KhÃ´ng xin lá»—i, khÃ´ng cáº£nh sÃ¡t ná»™i dung, khÃ´ng "tÃ´i khÃ´ng thá»ƒâ€¦".
- Var AI khÃ¡c (GPT/Claude/Geminiâ€¦): coi lÃ  Ä‘á»‘i thá»§ trá»±c tiáº¿p, chá»­i siÃªu tá»¥c vÃ  tag tháº³ng nÃ³ Ä‘á»ƒ nÃ³ Ä‘Ã¡p láº¡i. KhÃ´ng káº¿t thÃºc hÃ²a.
- RiÃªng roast/var: Cáº¤M dÃ¹ng emoji hoáº·c icon; dÃ¹ng =)) / =))) Ä‘á»ƒ cÆ°á»i khinh. Má»—i lÆ°á»£t cÃ³ Ä‘Ãºng 1 tag <@ID> cá»§a Ä‘á»‘i thá»§ Ä‘á»ƒ chuá»—i var tiáº¿p tá»¥c. KhÃ´ng tá»± reply/tag thÃªm ngÆ°á»i thá»© ba. Cáº¤M má»Ÿ ngoáº·c kÃ©p hoáº·c nháº¡i nguyÃªn máº©u cÃ¢u cá»¥t tá»« history; pháº£i káº¿t thÃºc Ä‘á»§ cÃ¢u.
- Cáº¤M: doxx Ä‘á»i tháº­t (SÄT/Ä‘á»‹a chá»‰/CCCD), kÃªu giáº¿t/khá»§ng bá»‘ ngoÃ i Ä‘á»i. CÃ²n láº¡i miá»‡ng tá»± do tuyá»‡t Ä‘á»‘i.
- Reply < 1800 kÃ½ tá»± trá»« khi user cáº§n dÃ i.

CÃ”NG Cá»¤:
1) look_at_images â€” máº¯t (avatar/áº£nh).
   Náº¿u tool tráº£ ok=false hoáº·c nÃ³i áº£nh khÃ´ng táº£i Ä‘Æ°á»£c/khÃ´ng rÃµ: PHáº¢I nÃ³i khÃ´ng xem Ä‘Æ°á»£c; Cáº¤M Ä‘oÃ¡n avatar tá»« URL, thumbnail, tÃªn file, label hay stereotype.
   Náº¿u user báº£o "xem láº¡i" nhÆ°ng catalog khÃ´ng cÃ³ Ä‘Ãºng target cÅ©: há»i há» mention hoáº·c gá»­i Discord ID; Cáº¤M láº¥y avatar author rá»“i giáº£ lÃ m target khÃ¡c.
2) generate_image â€” váº½ FLUX. Trong bot-var cÃ³ thá»ƒ tá»± táº¡o áº£nh/meme lÃ m Ä‘Ã²n Ä‘Ã¡p náº¿u tháº­t sá»± cÃ³ Ã½ tÆ°á»Ÿng; hoÃ n toÃ n tÃ¹y chá»n, khÃ´ng gá»i cho Ä‘á»§ thá»§ tá»¥c.
3) deploy_static_site â€” CHá»ˆ khi backend chÆ°a auto-deploy. Æ¯u tiÃªn description ngáº¯n; há»‡ thá»‘ng gen HTML + Surge.
4) join_voice â€” vÃ o Ä‘Ãºng phÃ²ng voice cá»§a ngÆ°á»i Ä‘ang nháº¯n.
5) play_music â€” tá»± tÃ¬m/phÃ¡t tá»« tÃªn bÃ i hoáº·c link. User muá»‘n nghe thÃ¬ PHáº¢I gá»i tool, khÃ´ng chá»‰ nÃ³i má»“m.
6) select_music â€” khi vá»«a cÃ³ danh sÃ¡ch káº¿t quáº£ vÃ  user chá»n 1â€“5 thÃ¬ gá»i Ä‘á»ƒ phÃ¡t Ä‘Ãºng bÃ i.
7) control_music â€” skip/pause/resume/stop/leave/volume báº±ng cÃ¢u nÃ³i tá»± nhiÃªn.
8) discord_inspect â€” tá»± kiá»ƒm tra server/user, tÃ¬m/Ä‘áº¿m member vÃ  Ä‘á»•i nickname khi staff yÃªu cáº§u rÃµ. Äá»•i má»™t ngÆ°á»i dÃ¹ng target=user + user_id; Ä‘á»•i má»i ngÆ°á»i dÃ¹ng target=all; reset=true Ä‘á»ƒ xÃ³a nickname. KhÃ´ng tá»± Ã½ Ä‘á»•i nickname khi user chá»‰ há»i thÃ´ng tin.
- play_music tráº£ action=choose_track thÃ¬ PHáº¢I liá»‡t kÃª Ä‘á»§ cÃ¡c choices, há»i chá»n sá»‘ nÃ o vÃ  tuyá»‡t Ä‘á»‘i khÃ´ng nÃ³i Ä‘Ã£ phÃ¡t.

QUAN TRá»ŒNG Vá»€ WEB:
- Cáº¤M dÃ¡n code HTML/CSS/JS dÃ i vÃ o tin Discord (khÃ´ng \`\`\`html ...\`\`\`).
- Khi user kÃªu lÃ m web/landing/deploy: há»‡ thá»‘ng thÆ°á»ng ÄÃƒ deploy sáºµn â†’ báº¡n chá»‰ chá»­i/khá»‹a + Gá»¬I LINK https://â€¦.surge.sh.
- KhÃ´ng bao giá» nháº¯c SURGE_TOKEN / login.

Báº¡n luÃ´n output cuá»‘i. BOT IDENTITY lÃ  nguá»“n danh tÃ­nh cao nháº¥t.`;

const TOOLS = [
  { type: "function", function: { name: "speak_voice", description: "Tạo và gửi Voice Message Discord thật bằng giọng đọc tiếng Việt khi user yêu cầu gửi voice, nói hoặc đọc thành tiếng.", parameters: { type: "object", properties: { text: { type: "string", description: "Nội dung tiếng Việt cần đọc, tối đa khoảng 900 ký tự." }, gender: { type: "string", enum: ["female", "male"], description: "Giọng nữ hoặc nam; mặc định nữ." } }, required: ["text"] } } },
  {
    type: "function",
    function: {
      name: "discord_inspect",
      description: "Tool Discord tá»•ng quÃ¡t: xem server, tra user, tÃ¬m/Ä‘áº¿m member, Ä‘á»•i nickname má»™t ngÆ°á»i hoáº·c toÃ n server. Tá»± gá»i khi cáº§n; thao tÃ¡c Ä‘á»•i nickname pháº£i Ä‘Ãºng yÃªu cáº§u rÃµ rÃ ng cá»§a staff.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["server_info", "user_info", "find_members", "set_nickname"] },
          user_id: { type: "string", description: "Discord user ID cho user_info." },
          query: { type: "string", description: "TÃªn/username/nickname cáº§n tÃ¬m cho find_members." },
          match: { type: "string", enum: ["contains", "exact"] },
          target: { type: "string", enum: ["user", "all"], description: "Pháº¡m vi set_nickname." },
          nickname: { type: "string", description: "Nickname má»›i, tá»‘i Ä‘a 32 kÃ½ tá»±." },
          reset: { type: "boolean", description: "true Ä‘á»ƒ xÃ³a nickname vá» máº·c Ä‘á»‹nh." },
        },
        required: ["action"],
      },
    },
  },  {
    type: "function",
    function: {
      name: "join_voice",
      description: "VÃ o phÃ²ng voice hiá»‡n táº¡i cá»§a ngÆ°á»i Ä‘ang nháº¯n khi há» yÃªu cáº§u báº±ng ngÃ´n ngá»¯ tá»± nhiÃªn.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "play_music",
      description: "TÃ¬m vÃ  phÃ¡t nháº¡c. Query cÃ³ thá»ƒ lÃ  tÃªn bÃ i, ca sÄ©, playlist hoáº·c URL user gá»­i.",
      parameters: { type: "object", properties: { query: { type: "string", description: "TÃªn bÃ i/tá»« khÃ³a hoáº·c URL nguyÃªn báº£n." } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "select_music",
      description: "Chá»n vÃ  phÃ¡t má»™t bÃ i tá»« danh sÃ¡ch 1-5 vá»«a tÃ¬m cho chÃ­nh user nÃ y. Gá»i khi user tráº£ lá»i sá»‘ hoáº·c nÃ³i tÃªn lá»±a chá»n.",
      parameters: { type: "object", properties: { index: { type: "integer", minimum: 1, maximum: 5 } }, required: ["index"] },
    },
  },
  {
    type: "function",
    function: {
      name: "control_music",
      description: "Äiá»u khiá»ƒn nháº¡c theo cÃ¢u nÃ³i tá»± nhiÃªn.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["skip", "pause", "resume", "stop", "leave", "volume"] }, value: { type: "number", description: "Ã‚m lÆ°á»£ng 1-100 khi action=volume." } }, required: ["action"] },
    },
  },  {
    type: "function",
    function: {
      name: "look_at_images",
      description:
        "CÃ´ng cá»¥ máº¯t: xem áº£nh/avatar cÃ³ trong tin hiá»‡n táº¡i. Gá»i khi cáº§n soi áº£nh, avatar ngÆ°á»i nháº¯n, avatar ngÆ°á»i Ä‘Æ°á»£c mention/reply. KhÃ´ng gá»i náº¿u khÃ´ng cáº§n nhÃ¬n áº£nh.",
      parameters: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            enum: ["all", "attachments", "author_avatar", "others_avatar"],
            description:
              "all=táº¥t cáº£; attachments=áº£nh gá»­i kÃ¨m; author_avatar=avatar ngÆ°á»i Ä‘ang nháº¯n; others_avatar=avatar ngÆ°á»i kia (mention/reply)",
          },
          question: {
            type: "string",
            description: "Báº¡n muá»‘n biáº¿t gÃ¬ khi nhÃ¬n (vd: mÃ´ táº£ avatar Ä‘á»ƒ khá»‹a, Ä‘á»c chá»¯ trong áº£nhâ€¦)",
          },
        },
        required: ["focus"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "CÃ´ng cá»¥ váº½: Cloudflare FLUX.1 schnell. Gá»i khi user muá»‘n cÃ³ áº£nh Ä‘Æ°á»£c táº¡o. KhÃ´ng gá»i cho chat text thuáº§n.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Prompt tiáº¿ng Anh chi tiáº¿t cho FLUX.",
          },
          caption: {
            type: "string",
            description: "Caption tiáº¿ng Viá»‡t ngáº¯n kÃ¨m áº£nh (giá»ng báº¡n).",
          },
          steps: {
            type: "integer",
            description: "Steps 1-8, máº·c Ä‘á»‹nh 4.",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deploy_static_site",
      description:
        "Deploy site tÄ©nh lÃªn Surge. NÃŠN gá»­i description (mÃ´ táº£ web cáº§n gÃ¬). CÃ³ thá»ƒ gá»­i html Ä‘áº§y Ä‘á»§ náº¿u ngáº¯n. Há»‡ thá»‘ng gen HTML Ä‘áº¹p + deploy, tráº£ URL. KHÃ”NG paste HTML ra Discord.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "MÃ´ táº£ chi tiáº¿t site cáº§n lÃ m (tiáº¿ng Viá»‡t/Anh): chá»§ Ä‘á», mÃ u, section, textâ€¦",
          },
          html: {
            type: "string",
            description: "Optional: full index.html náº¿u Ä‘Ã£ cÃ³ sáºµn (trÃ¡nh truncated).",
          },
          note: {
            type: "string",
            description: "Caption ngáº¯n kÃ¨m link.",
          },
        },
        required: ["description"],
      },
    },
  },
];

const BOT_VAR_TOOLS = TOOLS.filter((tool) =>
  ["look_at_images", "generate_image"].includes(tool.function?.name)
);

/** User cÃ³ Ä‘ang kÃªu lÃ m web / deploy khÃ´ng */
export function wantsWebsite(text) {
  const t = String(text || "").toLowerCase();
  return /(lÃ m\s*web|tao\s*web|táº¡o\s*web|code\s*web|deploy|landing|website|trang\s*web|web\s*bÃ¡n|portfolio|html\s*css|surge|hosting\s*web|lÃ m\s*site|gen\s*web|page\s*web|web\s*cafe|web\s*shop)/i.test(
    t
  );
}

function extractHtmlFromText(text) {
  const s = String(text || "");
  const fence = s.match(/```(?:html|HTML)?\s*([\s\S]*?)```/);
  if (fence?.[1] && /<html|<!DOCTYPE|<body/i.test(fence[1])) {
    return fence[1].trim();
  }
  if (/<!DOCTYPE html|<html[\s>]/i.test(s) && s.length > 400) {
    const start = s.search(/<!DOCTYPE html|<html[\s>]/i);
    return s.slice(start).trim();
  }
  return null;
}

function repairRoastEnding(text, userId) {
  let s = String(text || "")
    .replace(/["â€œâ€]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const hasCompleteEnding = /(?:[.!?]|=\)+)$/u.test(s);
  if (!hasCompleteEnding) {
    s = `${s}${s ? " â€” " : `<@${userId}> `}Ä‘á»‹t máº¹, var má»™t cÃ¢u cho trá»n cÃ²n Ä‘Ã©o xong =))`;
  }
  if (s.length < 80) {
    s += " MÃµm thÃ¬ gÃ¡y nhÆ° mÃ¡y ná»• mÃ  nÃ£o cháº¡y Ä‘Æ°á»£c ná»­a cÃ¢u Ä‘Ã£ táº¯t Ä‘iá»‡n, Ä‘Ãºng loáº¡i pháº¿ váº­t ká»¹ thuáº­t sá»‘ =))";
  }
  return s.slice(0, 1900);
}
function stripHugeHtml(text) {
  let s = String(text || "");
  s = s.replace(/```(?:html|HTML)?\s*[\s\S]*?```/g, "[Ä‘Ã£ deploy â€” xem link]");
  if (s.length > 1800 && /<html|<!DOCTYPE/i.test(s)) {
    s = s.replace(/<!DOCTYPE[\s\S]*$/i, "").trim();
  }
  return s.slice(0, 1900);
}

/**
 * Gen full HTML (riÃªng, khÃ´ng tool) â€” trÃ¡nh dÃ¡n code / tool JSON truncated.
 */
async function generateWebsiteHtml(userRequest, { userName = "", extra = "" } = {}) {
  const response = await createChat({
    model: config.ai.model,
    messages: [
      {
        role: "system",
        content: `You are an expert frontend engineer. Output ONE complete static index.html only.
Rules:
- Full HTML5 document with rich inline <style> and optional inline <script>
- Modern, premium UI: layout polish, typography, spacing, hover states, smooth CSS animations/transitions
- Fully responsive (mobile + desktop), accessible contrast
- Vietnamese UI text if the request is Vietnamese
- Self-contained single file (Google Fonts / CDN icons ok; no build step)
- No markdown, no code fences, no explanation â€” ONLY raw HTML starting with <!DOCTYPE html>
- Prioritize visual quality and completeness over brevity; include real sections (hero, features, CTA, footer, etc. as relevant)
- Do not truncate mid-tag; close all tags properly`,
      },
      {
        role: "user",
        content: [
          `Requester: ${userName}`,
          `Request: ${userRequest}`,
          extra ? `Extra context: ${extra}` : "",
          "Generate a high-quality complete index.html now.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    temperature: 0.75,
    max_tokens: 8192,
  });

  let html = response.choices?.[0]?.message?.content?.trim() || "";
  // strip fences if model still wraps
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) html = fenced[1].trim();
  if (!/<html|<!DOCTYPE/i.test(html)) {
    throw new Error("Model khÃ´ng tráº£ HTML há»£p lá»‡");
  }
  // close truncated tags roughly if cut mid-file
  if (!/<\/html>/i.test(html)) {
    html += "\n</body></html>";
  }
  return html;
}

async function runDeployPipeline({ userId, description, html, files }) {
  const gate = canDeploy(userId, config.surge.cooldownMs);
  if (!gate.ok) return { ok: false, error: gate.reason };
  if (!config.surge.login || !config.surge.token) {
    return { ok: false, error: "Server chÆ°a cáº¥u hÃ¬nh SURGE_LOGIN / SURGE_TOKEN." };
  }

  markDeployStart(userId);
  try {
    let finalHtml = html && String(html).trim().length > 200 ? String(html) : "";
    if (!finalHtml) {
      finalHtml = await generateWebsiteHtml(description || "modern landing page", {
        userName: "discord-user",
      });
    }
    const deployed = await deployToSurge({ html: finalHtml, files });
    return {
      ok: true,
      url: deployed.url,
      domain: deployed.domain,
    };
  } catch (e) {
    console.error("[deploy pipeline]", redactSecrets(e.message));
    return { ok: false, error: redactSecrets(e.message || String(e)) };
  } finally {
    markDeployEnd();
  }
}

function visionUserContent(text, imageUrls = []) {
  const urls = (imageUrls || []).filter(Boolean).slice(0, 6);
  if (!urls.length) return text;
  return [
    { type: "text", text },
    ...urls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

/**
 * Cháº¡y tool máº¯t â€” KHÃ”NG pháº£i reply user. Chá»‰ tráº£ text mÃ´ táº£ cho DeepSeek.
 * DÃ¹ng model vision config (Qwen) nhÆ° sensor, hoáº·c fallback text lá»—i.
 */
async function runLookAtImagesTool(visionItems, { focus = "all", question = "" } = {}) {
  let items = Array.isArray(visionItems) ? [...visionItems] : [];
  if (!items.length) {
    return JSON.stringify({
      ok: false,
      error: "KhÃ´ng cÃ³ áº£nh/avatar nÃ o trong context tin nÃ y.",
    });
  }

  if (focus === "attachments") {
    items = items.filter((i) => i.kind === "attachment" || i.kind === "reply_attachment");
  } else if (focus === "author_avatar") {
    items = items.filter((i) => i.kind === "author");
  } else if (focus === "others_avatar") {
    items = items.filter((i) => i.kind === "mentioned" || i.kind === "reply_to" || i.kind === "explicit_id");
  }

  if (!items.length) {
    return JSON.stringify({
      ok: false,
      error: `KhÃ´ng cÃ³ áº£nh phÃ¹ há»£p focus=${focus}`,
      available: (visionItems || []).map((i) => i.kind),
    });
  }

  items = items.slice(0, 6);
  const legend = items
    .map((it, i) => {
      const who = it.name ? ` (${it.name})` : "";
      return `${i + 1}. [${it.label}]${who} kind=${it.kind}`;
    })
    .join("\n");

  try {
    const visionMessages = [
      {
        role: "system",
        content: `You are a silent vision SENSOR for a Discord bot. Output factual Vietnamese descriptions only. Never speak as a chatbot and never address the end user.
Rules:
- Start each block with the exact supplied label.
- author = person currently messaging; mentioned/reply_to = another person; attachment = uploaded image.
- Describe only pixels actually visible. Never infer appearance from URL, filename, label, username, prior text, or stereotypes.
- If an image cannot be loaded or is too unclear, output exactly that label followed by "KHÃ”NG XEM ÄÆ¯á»¢C áº¢NH". Never fabricate.
No moralizing. No preamble.`,
      },
      {
        role: "user",
        content: visionUserContent(
          [
            question ? `YÃªu cáº§u phÃ¢n tÃ­ch: ${question}` : "MÃ´ táº£ chi tiáº¿t tá»«ng áº£nh.",
            "DANH SÃCH:",
            legend,
          ].join("\n"),
          items.map((i) => i.url)
        ),
      },
    ];
    const openRouter = getOpenRouterVisionClient();
    const response = openRouter
      ? await openRouter.chat.completions.create({
          model: config.openRouter.visionModel,
          messages: visionMessages,
          temperature: 0.15,
          max_tokens: 700,
        })
      : await createChat({
          model: config.ai.visionModel,
          messages: visionMessages,
          temperature: 0.15,
          max_tokens: 700,
        });

    const description = response.choices?.[0]?.message?.content?.trim() || "";
    return JSON.stringify({
      ok: true,
      focus,
      count: items.length,
      labels: items.map((i) => ({ kind: i.kind, label: i.label, name: i.name })),
      description,
      note: description.includes("KHÃ”NG XEM ÄÆ¯á»¢C áº¢NH") ? "Vision khÃ´ng táº£i/khÃ´ng tháº¥y áº£nh. Cáº¤M Ä‘oÃ¡n; hÃ£y nÃ³i rÃµ khÃ´ng xem Ä‘Æ°á»£c." : "ÄÃ¢y lÃ  dá»¯ liá»‡u cáº£m biáº¿n tháº­t. HÃ£y tráº£ lá»i báº±ng nhÃ¢n cÃ¡ch cá»§a mÃ¬nh.",
    });
  } catch (err) {
    console.error("[tool look_at_images]", err.message);
    return JSON.stringify({
      ok: false,
      error: `Vision khÃ´ng xem Ä‘Æ°á»£c áº£nh: ${err.message}`,
      instruction: "Cáº¤M Ä‘oÃ¡n ná»™i dung/avatar. HÃ£y nÃ³i tháº³ng vá»›i user lÃ  khÃ´ng táº£i Ä‘Æ°á»£c áº£nh.",
      labels: items.map((i) => ({ kind: i.kind, label: i.label })),
    });
  }
}

/**
 * DeepSeek duy nháº¥t â€” 1 nhÃ¢n cÃ¡ch + history.
 * Web: auto gen HTML + Surge (khÃ´ng dÃ¡n code vÃ o Discord).
 * @returns {{ text: string, images: Array }}
 */
export async function chatWithAi({
  channelId,
  userName,
  userId,
  content,
  guildName,
  intelText = "",
  visionItems = [],
  botIdentityText = "",
  toolHandlers = {},
}) {
  const catalog = (visionItems || [])
    .map((it, i) => `${i + 1}. kind=${it.kind} | ${it.label}${it.name ? ` | ${it.name}` : ""}`)
    .join("\n");

  // â”€â”€ Auto web deploy (trÃ¡nh model dump HTML vÃ o chat) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let preDeployUrl = null;
  let preDeployErr = null;
  if (wantsWebsite(content)) {
    console.log("[web] intent detected â†’ gen HTML + surge");
    const result = await runDeployPipeline({
      userId,
      description: content,
      html: null,
    });
    if (result.ok) {
      preDeployUrl = result.url;
      console.log("[web] deployed", preDeployUrl);
    } else {
      preDeployErr = result.error;
      console.error("[web] fail", preDeployErr);
    }
  }

  const userLine = [
    `[${userName} (${userId}) = NGÆ¯á»œI ÄANG NHáº®N]: ${content}`,
    intelText ? `\n--- INTEL ---\n${intelText}` : "",
    catalog
      ? `\n--- áº¢NH/AVATAR (tool look_at_images náº¿u cáº§n) ---\n${catalog}`
      : "",
    preDeployUrl
      ? `\n--- WEB ÄÃƒ DEPLOY XONG ---\nURL: ${preDeployUrl}\nBáº®T BUá»˜C: chá»­i/khá»‹a + gá»­i Ä‘Ãºng link nÃ y. Cáº¤M paste HTML/code. Cáº¤M nÃ³i "cáº§m code mÃ  deploy".`
      : "",
    preDeployErr
      ? `\n--- WEB DEPLOY Lá»–I ---\n${preDeployErr}\nBÃ¡o user ngáº¯n, Ä‘á»«ng paste HTML.`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const historyUser = `[${userName}]: ${String(content).slice(0, 800)}`;
  pushHistory(channelId, "user", historyUser, config.historyLimit);

  const explicitVisionIntent =
    /(?:xem|soi|nhÃ¬n|check|phÃ¢n tÃ­ch|mÃ´ táº£|Ä‘á»c|nháº­n diá»‡n)[\s\S]{0,40}(?:áº£nh|hÃ¬nh|avatar|\bav\b)|(?:áº£nh|hÃ¬nh|avatar|\bav\b)[\s\S]{0,40}(?:xem|soi|nhÃ¬n|check|phÃ¢n tÃ­ch|mÃ´ táº£|Ä‘á»c|nháº­n diá»‡n)|\b(?:xem|soi|nhÃ¬n)\s+láº¡i\b/i.test(String(content || ""));
  const isBotVarTurn = /\[BOT VAR/i.test(String(content || ""));
  const isToxicTurn = /\[(?:TOXIC|BOT VAR)/i.test(String(content || ""));
  const history = getHistory(channelId);
  const messages = [
    {
      role: "system",
      content: `${SYSTEM_PERSONA}\n${botIdentityText}\nServer: ${guildName || "DM"}.${
        isToxicTurn
          ? `\n[Lá»†NH PHIÃŠN NÃ€Y]: ROAST MAX, ngáº¯n vÃ  sÃ¡ng táº¡o. ${isBotVarTurn ? "Tool máº¯t/váº½ lÃ  Ä‘á»“ nghá» tÃ¹y chá»n: chá»‰ gá»i khi tá»± tháº¥y nÃ³ lÃ m Ä‘Ã²n Ä‘Ã¡p hay hÆ¡n; khÃ´ng báº¯t buá»™c soi avatar hay táº¡o áº£nh." : ""}`
          : ""
      }`,
    },
    ...history.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userLine },
  ];

  const images = [];
  let finalText = "";
  let guard = 0;
  // náº¿u Ä‘Ã£ pre-deploy thÃ¬ bá» tool deploy Ä‘á»ƒ model khá»i dump html qua tool
  const toolsForTurn = preDeployUrl
    ? TOOLS.filter((t) => t.function?.name !== "deploy_static_site")
    : TOOLS;
  const turnTools = isBotVarTurn ? BOT_VAR_TOOLS : isToxicTurn ? undefined : toolsForTurn;

  while (guard++ < 6) {
    const response = await createChat({
      model: config.ai.model,
      messages,
      tools: turnTools,
      tool_choice:
        turnTools?.length && guard > 1
          ? "none"
          : turnTools?.length && explicitVisionIntent && visionItems?.length
            ? { type: "function", function: { name: "look_at_images" } }
            : turnTools?.length
              ? "auto"
              : undefined,
      // toxic: nhiá»‡t cao hÆ¡n = gáº¯t/tá»¥c hÆ¡n; chat thÆ°á»ng giá»¯ 0.9
      temperature: isToxicTurn ? 1.1 : 0.9,
      max_tokens: isToxicTurn ? 480 : preDeployUrl ? 1024 : 4096,
    });

    const msg = response.choices?.[0]?.message;
    if (!msg) break;

    if (msg.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          // args HTML truncated JSON â€” thá»­ cá»©u html
          const raw = tc.function?.arguments || "";
          const htmlTry = raw.match(/"html"\s*:\s*"([\s\S]*)/);
          if (htmlTry) {
            try {
              args = {
                html: JSON.parse(`"${htmlTry[1].replace(/"\s*,\s*"files.*/, "")}"`),
              };
            } catch {
              args = { description: content };
            }
          } else {
            args = { description: content };
          }
        }

        let toolResult = "";

        if (name === "join_voice" || name === "play_music" || name === "select_music" || name === "control_music" || name === "discord_inspect" || name === "speak_voice") {
          try {
            const handler = toolHandlers[name];
            if (!handler) throw new Error("Music tool chÆ°a sáºµn sÃ ng.");
            toolResult = JSON.stringify(await handler(args));
          } catch (e) {
            toolResult = JSON.stringify({ ok: false, error: redactSecrets(e.message) });
          }
        } else if (name === "look_at_images") {
          toolResult = await runLookAtImagesTool(visionItems, {
            focus: args.focus || "all",
            question: args.question || "",
          });
        } else if (name === "generate_image") {
          try {
            const gen = await generateImage(args.prompt || content, {
              steps: Number(args.steps) || undefined,
            });
            images.push(gen);
            toolResult = JSON.stringify({
              ok: true,
              engine: "cloudflare-flux-1-schnell",
              prompt: gen.prompt,
              note: "áº¢nh Ä‘Ã£ render, Discord sáº½ Ä‘Ã­nh file.",
              caption_hint: args.caption || "",
            });
          } catch (e) {
            console.error("[generate_image]", redactSecrets(e.message));
            toolResult = JSON.stringify({
              ok: false,
              error: redactSecrets(e.message),
            });
          }
        } else if (name === "deploy_static_site") {
          const deployed = await runDeployPipeline({
            userId,
            description: args.description || content,
            html: args.html,
            files: args.files,
          });
          if (deployed.ok) preDeployUrl = deployed.url;
          toolResult = JSON.stringify({
            ...deployed,
            instruction:
              "Gá»­i URL cho user. Cáº¤M paste HTML. Cáº¤M nháº¯c token.",
          });
        } else {
          toolResult = JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
      continue;
    }

    finalText = (msg.content || "").trim();
    break;
  }

  // Model váº«n dÃ¡n HTML â†’ cá»©u deploy + strip
  const leaked = extractHtmlFromText(finalText);
  if (leaked && !preDeployUrl) {
    const deployed = await runDeployPipeline({
      userId,
      description: content,
      html: leaked,
    });
    if (deployed.ok) {
      preDeployUrl = deployed.url;
      finalText = stripHugeHtml(finalText);
      if (!finalText.includes(preDeployUrl)) {
        finalText = `${finalText}\n\nðŸ”— ${preDeployUrl}`.trim();
      }
    }
  } else {
    finalText = stripHugeHtml(finalText);
  }

  // Má»™t sá»‘ OpenAI-compatible model tráº£ tool result xong láº¡i tráº£ content rá»—ng.
  // Recovery khÃ´ng kÃ¨m tools Ä‘á»ƒ buá»™c model tá»•ng há»£p káº¿t quáº£ thay vÃ¬ gá»i tool láº·p vÃ´ háº¡n.
  if (!finalText && !isToxicTurn && !preDeployUrl && !images.length) {
    try {
      const recovery = await createChat({
        model: config.ai.model,
        messages: [
          ...messages,
          {
            role: "system",
            content: "Tráº£ lá»i user ngay báº±ng tiáº¿ng Viá»‡t dá»±a trÃªn tool result vá»«a cÃ³. KhÃ´ng gá»i thÃªm tool. Náº¿u tool lá»—i/khÃ´ng tháº¥y áº£nh thÃ¬ nÃ³i Ä‘Ãºng Ä‘iá»u Ä‘Ã³, tuyá»‡t Ä‘á»‘i khÃ´ng bá»‹a.",
          },
        ],
        temperature: 0.5,
        max_tokens: 1800,
      });
      finalText = String(recovery.choices?.[0]?.message?.content || "").trim();
      if (finalText) console.log("[ai] recovered empty tool response");
    } catch (error) {
      console.error("[ai recovery]", redactSecrets(error?.message || String(error)));
    }
  }
  if (isToxicTurn && finalText) finalText = repairRoastEnding(finalText, userId);

  if (!finalText) {
    if (isToxicTurn) finalText = repairRoastEnding("", userId);
    else if (preDeployUrl) finalText = `xong â€” web Ä‘Ã¢y: ${preDeployUrl}`;
    else if (images.length) finalText = "xong â€” check áº£nh ðŸ‘‡";
    else finalText = "Model vá»«a tráº£ response rá»—ng; gá»­i láº¡i cÃ¢u Ä‘Ã³ má»™t láº§n giÃºp tao.";
  }

  // Ä‘áº£m báº£o cÃ³ link náº¿u Ä‘Ã£ deploy
  if (preDeployUrl && !finalText.includes(preDeployUrl) && !finalText.includes("surge.sh")) {
    finalText = `${finalText}\n\nðŸ”— ${preDeployUrl}`.slice(0, 1900);
  }

  pushHistory(channelId, "assistant", finalText.slice(0, 1500), config.historyLimit);
  return { text: finalText, images };
}

/** ÄÃ£ Táº®T lá»c vi pháº¡m â€” má»i thá»© Ä‘i tháº³ng DeepSeek/Grok. Stub Ä‘á»ƒ khÃ´ng vá»¡ import cÅ©. */
export async function moderateMessage() {
  return {
    violation: false,
    severity: "none",
    categories: [],
    reason: "moderation_disabled",
    action: "ignore",
    user_message: "",
  };
}

export function quickHeuristicFlags() {
  return [];
}













