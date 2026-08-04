import { Riffy } from "riffy";

const NODES = [
  { name: "Horizxon Singapore", host: "lava1.horizxon.studio", port: 80, password: "horizxon.studio", secure: false },
  { name: "Horizxon Mumbai", host: "lava4.horizxon.studio", port: 80, password: "horizxon.studio", secure: false },
  { name: "Horizxon Frankfurt", host: "lava3.horizxon.studio", port: 80, password: "horizxon.studio", secure: false },
  { name: "Horizxon US West", host: "lava2.horizxon.studio", port: 80, password: "horizxon.studio", secure: false },
  { name: "Serenetia v4 SSL", host: "lavalinkv4.serenetia.com", port: 443, password: "https://dsc.gg/ajidevserver", secure: true },
  { name: "Serenetia v4 Non-SSL", host: "lavalinkv4.serenetia.com", port: 80, password: "https://dsc.gg/ajidevserver", secure: false },
  { name: "Ajieblogs v4 SSL", host: "lava-v4.ajieblogs.eu.org", port: 443, password: "https://dsc.gg/ajidevserver", secure: true },
  { name: "HeavenCloud", host: "89.106.84.59", port: 4000, password: "heavencloud.in", secure: false },
  { name: "DevamOP India", host: "lavalink.devamop.in", port: 443, password: "DevamOP", secure: true },
  { name: "Jirayu v4", host: "lavalink.jirayu.net", port: 13592, password: "youshallnotpass", secure: false },
  { name: "NYX Singapore 1", host: "sg1-nodelink.nyxbot.app", port: 3000, password: "nyxbot.app/support", secure: false },
  { name: "TriniumHost", host: "lavalink.triniumhost.com", port: 4333, password: "free", secure: false },
  { name: "Lavalink.rocks v4", host: "v4.lavalink.rocks", port: 443, password: "horizxon.tech", secure: true },
];

let riffy;
const pendingSearches = new Map();

export function initMusic(client) {
  riffy = new Riffy(client, NODES, {
    send: (payload) => { const guild = client.guilds.cache.get(payload.d.guild_id); if (guild) guild.shard.send(payload); },
    defaultSearchPlatform: "ytsearch",
    restVersion: "v4",
    bypassChecks: { nodeFetchInfo: true },
  });
  client.riffy = riffy;
  riffy.on("nodeConnect", (node) => console.log(`[music] node connected: ${node.name}`));
  riffy.on("nodeDisconnect", (node) => console.warn(`[music] node disconnected: ${node.name}`));
  riffy.on("nodeError", (node, error) => console.error(`[music] node error ${node.name}:`, error?.message || error));
  riffy.on("trackError", (_player, track, error) => console.error(`[music] track error ${track?.info?.title || "?"}:`, error));
  riffy.on("queueEnd", (player) => { const channel = client.channels.cache.get(player.textChannel); player.destroy(); channel?.send("hết nhạc rồi — tao out voice đây 👋").catch(() => {}); });
}

export function initMusicNodes(clientUserId) { if (!riffy) throw new Error("Music chưa được khởi tạo"); riffy.init(clientUserId); }
export function updateMusicVoiceState(packet) { if (riffy && ["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(packet.t)) riffy.updateVoiceState(packet); }
function getPlayer(guildId) { return riffy?.players?.get(guildId) || null; }
function searchKey(message) { return `${message.guild.id}:${message.author.id}`; }
export function hasPendingMusicSearch(message) {
  const pending = pendingSearches.get(searchKey(message));
  if (!pending || pending.expiresAt <= Date.now()) { if (pending) pendingSearches.delete(searchKey(message)); return false; }
  return true;
}
function isUrl(value) { return /^https?:\/\//i.test(String(value || "").trim()); }
function formatDuration(ms) { const total = Math.max(0, Math.floor(Number(ms || 0) / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function disconnectAndVerify(message, player) {
  try { player?.destroy(); } catch { /* fallback bên dưới */ }
  for (let i = 0; i < 8; i++) {
    if (!message.guild.members.me?.voice?.channelId && !getPlayer(message.guild.id)) return { ok: true, action: "leave", verified: true };
    await sleep(250);
  }
  try { message.guild.members.me?.voice?.disconnect(); } catch { /* verify bên dưới */ }
  for (let i = 0; i < 8; i++) {
    if (!message.guild.members.me?.voice?.channelId) return { ok: true, action: "leave", verified: true, forced: true };
    await sleep(250);
  }
  throw new Error("Discord chưa xác nhận bot đã rời voice; không báo out giả.");
}

function ensurePlayer(message) {
  const voice = message.member?.voice?.channel;
  if (!voice) throw new Error("Mày phải vào một phòng voice trước.");
  const permissions = voice.permissionsFor(message.guild.members.me);
  if (!permissions?.has("Connect") || !permissions?.has("Speak")) throw new Error("Tao thiếu quyền Connect hoặc Speak trong phòng voice đó.");
  let player = getPlayer(message.guild.id);
  if (!player) player = riffy.createConnection({ guildId: message.guild.id, voiceChannel: voice.id, textChannel: message.channel.id, deaf: true });
  player.requesterId = message.author.id;
  return { player, voice };
}

async function enqueue(message, tracks, { playlist = false } = {}) {
  const { player, voice } = ensurePlayer(message);
  const selected = tracks.slice(0, 100);
  for (const track of selected) { track.info.requester = message.author; player.queue.add(track); }
  if (!player.playing && !player.paused) await player.play();
  return { ok: true, action: "playing", voiceChannel: voice.name, title: selected[0]?.info?.title || "unknown", author: selected[0]?.info?.author || "", added: selected.length, playlist, node: player.node?.name || "auto" };
}

export async function joinVoice(message) {
  const { player, voice } = ensurePlayer(message);
  return { ok: true, action: "joined", channel: voice.name, node: player.node?.name || "auto" };
}

export async function playMusic(message, query) {
  const clean = String(query || "").trim();
  if (!clean) throw new Error("Thiếu tên bài hát hoặc link.");
  ensurePlayer(message);
  const resolved = await riffy.resolve({ query: clean, requester: message.author });
  const tracks = resolved?.tracks || [];
  if (!tracks.length) throw new Error(`Không tìm thấy nhạc cho: ${clean}`);

  if (!isUrl(clean) && resolved.loadType === "search") {
    const choices = tracks.slice(0, 5);
    const key = searchKey(message);
    pendingSearches.set(key, { tracks: choices, expiresAt: Date.now() + 60_000 });
    setTimeout(() => { const current = pendingSearches.get(key); if (current && current.expiresAt <= Date.now()) pendingSearches.delete(key); }, 61_000);
    return {
      ok: true,
      action: "choose_track",
      instruction: "Liệt kê đúng 5 lựa chọn dưới đây theo số và hỏi user chọn số nào. Chưa phát bài nào.",
      expiresInSeconds: 60,
      choices: choices.map((track, index) => ({ index: index + 1, title: track.info.title, author: track.info.author, duration: formatDuration(track.info.length) })),
    };
  }

  return enqueue(message, resolved.loadType === "playlist" ? tracks : [tracks[0]], { playlist: resolved.loadType === "playlist" });
}

export async function selectMusic(message, index) {
  const key = searchKey(message);
  const pending = pendingSearches.get(key);
  if (!pending || pending.expiresAt <= Date.now()) { pendingSearches.delete(key); throw new Error("Danh sách chọn bài đã hết hạn, tìm lại đi."); }
  const choice = Number(index);
  if (!Number.isInteger(choice) || choice < 1 || choice > pending.tracks.length) throw new Error(`Chọn số từ 1 đến ${pending.tracks.length}.`);
  const track = pending.tracks[choice - 1];
  pendingSearches.delete(key);
  return enqueue(message, [track]);
}

export async function controlMusic(message, action, value) {
  const player = getPlayer(message.guild.id);
  if (!player) throw new Error("Tao chưa ở voice hoặc chưa phát nhạc.");
  switch (action) {
    case "skip": player.stop(); break;
    case "pause": player.pause(true); break;
    case "resume": player.pause(false); break;
    case "stop": case "leave": return disconnectAndVerify(message, player);
    case "volume": { const volume = Math.max(1, Math.min(100, Number(value) || 50)); player.setVolume(volume); return { ok: true, action, volume }; }
    default: throw new Error(`Thao tác nhạc không hợp lệ: ${action}`);
  }
  return { ok: true, action };
}




export async function releaseMusicForNarration(guildId) {
  const player = getPlayer(guildId);
  if (player) { try { player.destroy(); } catch {} }
  return { ok: true };
}

export async function resolveTrackMetadata(message, query) {
  const clean=String(query||"").trim(); if(!clean)throw new Error("Thiếu link cần nhận diện.");
  const result=await riffy.resolve({query:clean,requester:message.author}); const track=result?.tracks?.[0];
  if(!track)throw new Error("Node không nhận diện được audio từ link này.");
  return {title:track.info.title||"Unknown",author:track.info.author||"Unknown",length:track.info.length||0,uri:track.info.uri||clean,sourceName:track.info.sourceName||"unknown",pluginInfo:track.pluginInfo||{}};
}