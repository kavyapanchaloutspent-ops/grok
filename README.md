# Discord AI Mod Bot

Bot Discord quản lý server bằng **AI** (DeepSeek V4 Pro qua [xkiro](https://api.xkiro.com) — OpenAI-compatible).

## Tính năng

| Tính năng | Mô tả |
|-----------|--------|
| **Grok 4.5** | Persona Grok 4.5 tiên tiến, var AI khác, 1 não + memory |
| **No filter** | Auto-mod **TẮT** — toxic/vi phạm → thẳng Grok chửi |
| **Cười** | `=))))` / 😂 / haha… → **`cười cặc`** |
| **Tạo ảnh** | Tool `generate_image` → Cloudflare FLUX |
| **Vision** | Tool `look_at_images` → sensor (không rep) |
| **Deploy web** | Tool `deploy_static_site` → **Surge.sh** → `https://xxx.surge.sh` |
| **Lệnh mod** | Staff tay `!mod kick` (không auto warn) |
| **Multi API** | Pool key + rotate khi 429/401 · lệnh `.api add/list/del` (staff) |

## Cấu trúc

```
discord-ai-modbot/
├── package.json
├── railway.toml
├── Procfile
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── index.js        # entry + message handler
    ├── config.js       # env
    ├── ai.js           # Grok 4.5 persona + tools
    ├── laugh.js        # phát hiện cười
    ├── roast.js        # detect toxic → gửi Grok
    ├── profile.js      # role / info / avatar
    ├── images.js       # Cloudflare FLUX
    ├── surge.js        # Surge.sh static deploy (no token in logs)
    ├── moderation.js   # staff helpers only (filter off)
    └── store.js        # state in-memory
```

### Surge deploy

Env: `SURGE_LOGIN`, `SURGE_TOKEN` (Railway Variables — **không** commit, **không** log/Discord).

Grok tự tool-call → ghi `index.html` temp → `surge` → xóa temp → reply `https://<random>.surge.sh`.  
Cooldown-limit: `SURGE_COOLDOWN_MS` (mặc định 60s/user), 1 deploy tại một thời điểm.

### Stack — 1 não DeepSeek

| Vai trò | Cái gì |
|---------|--------|
| **Nhân cách + memory + reply** | Chỉ `deepseek/deepseek-v4-pro` |
| **Tool mắt** | `look_at_images` → sensor **Mistral Large** `mistralai/mistral-large-2512` |
| **Tool vẽ** | `generate_image` → Cloudflare FLUX.1 schnell |

Không có “mode chửi” tách model / system prompt khác. Chửi cũng là DeepSeek + cùng history channel.

Env tạo ảnh: `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_FLUX_STEPS` (mặc định 4).

## 1. Tạo bot Discord

1. Vào [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Tab **Bot** → **Reset Token** → copy token → `DISCORD_TOKEN`
3. Bật **Privileged Gateway Intents**:
   - ✅ Presence Intent (optional)
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent** (bắt buộc)
4. Tab **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Send Messages`, `Read Message History`, `Manage Messages`, `Kick Members`, `Moderate Members`, `Add Reactions`, `Embed Links`, `View Channels`
5. Mở URL invite, thêm bot vào server
6. **Role bot** phải **cao hơn** role user cần kick/timeout

## 2. Chạy local

```bash
cd discord-ai-modbot
cp .env.example .env
# sửa .env: DISCORD_TOKEN, AI_API_KEY, ...
npm install
npm start
```

### Biến môi trường quan trọng

```env
DISCORD_TOKEN=...
AI_API_KEY=sk-xt-...
AI_BASE_URL=https://api.xkiro.com/v1
AI_MODEL=deepseek/deepseek-v4-pro
ADMIN_USER_IDS=123456789012345678
WARN_THRESHOLD=3
KICK_THRESHOLD=5
REQUIRE_MENTION=true
```

## 3. Đẩy GitHub

```bash
cd discord-ai-modbot
git init
git add .
git commit -m "feat: Discord AI mod bot"
# tạo repo trống trên GitHub rồi:
git branch -M main
git remote add origin https://github.com/USERNAME/discord-ai-modbot.git
git push -u origin main
```

> **Không commit file `.env`** (đã có trong `.gitignore`). Key chỉ set trên Railway.

## 4. Deploy Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Chọn repo vừa push
3. **Variables** → thêm toàn bộ từ `.env.example` (điền giá trị thật)
4. Settings:
   - Start command: `npm start` (đã có trong `railway.toml`)
   - Không cần public HTTP port — đây là **worker bot**
5. Deploy → xem logs đến khi thấy `✅ Online: YourBot#1234`

### Railway tips

- Nếu Railway báo cần PORT: bot **không listen HTTP**; giữ `worker` / start `npm start` là đủ.
- Restart bot sẽ **reset** số cảnh báo (in-memory). Muốn persist: gắn Redis sau.

## 5. Cách dùng trên Discord

| Hành động | Kết quả |
|-----------|---------|
| Mention bot hoặc reply bot | Chat AI |
| `!chat hỏi gì đó` | Chat AI |
| Gửi `=))))` / 😂 / haha / kkk… | Bot: **cười cặc** |
| Chửi / toxic / chửi bot | Bot **chửi lại SIÊU CĂNG** + bóc role/avatar |
| Mention bot + chat / gửi ảnh | AI tự trả lời / khịa (có intel + vision) |
| Spam / scam | Cảnh báo → ping admin → kick |
| `!mod help` | Lệnh staff only (không có lệnh khịa) |

## Bảo mật

- **Đừng** public `DISCORD_TOKEN` / `AI_API_KEY`.
- Nếu key từng dán chat công khai → **rotate** key mới trên xkiro + Discord.
- Chỉ đưa quyền kick cho bot trên server tin cậy.

## License

MIT

## Voice và nhạc

Nói tự nhiên để bot join voice, tìm/phát nhạc theo tên bài hoặc link, và điều khiển skip/pause/resume/volume/leave. Model tự gọi tool qua NodeLink; không cần prefix cứng.

## DM command: .chat

Admin trong ADMIN_USER_IDS nhắn riêng bot: `.chat nội dung`. Bot trả menu chọn server rồi chọn kênh; bot tự mention đối thủ, đồng thời giữ các mention người dùng tự thêm.




### AI đổi nickname

Staff có Manage Nicknames được đổi một member; đổi toàn server yêu cầu Administrator. Bot cần quyền Manage Nicknames và role cao hơn target. Server owner/chính bot/member không manageable sẽ được bỏ qua.
