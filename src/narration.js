import { Readable } from "node:stream";
import { AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel } from "@discordjs/voice";
import { synthesizeVietnameseVoice } from "./voice-message.js";
import { generateStoryChapter } from "./ai.js";
import { releaseMusicForNarration } from "./music.js";

const sessions = new Map();
const splitSpeech = (text, max=850) => { const out=[]; let rest=String(text||"").trim(); while(rest.length>max){let cut=rest.lastIndexOf(". ",max);if(cut<max*.55)cut=rest.lastIndexOf(" ",max);if(cut<max*.55)cut=max;out.push(rest.slice(0,cut+1).trim());rest=rest.slice(cut+1).trim();}if(rest)out.push(rest);return out; };
const playResource = (player, resource) => new Promise((resolve,reject)=>{ const onError=e=>{cleanup();reject(e);}; const onIdle=()=>{cleanup();resolve();}; const cleanup=()=>{player.off("error",onError);player.off(AudioPlayerStatus.Idle,onIdle);}; player.once("error",onError);player.once(AudioPlayerStatus.Idle,onIdle);player.play(resource); });

async function runSession(session) {
  let chapterPromise;
  try {
    chapterPromise = generateStoryChapter({ topic:session.topic, continuity:session.continuity, previousEnding:session.previousEnding, chapter:session.chapter });
    while (!session.stopped && Date.now() < session.endsAt) {
      const chapter = await chapterPromise;
      session.continuity = chapter.continuity || session.continuity;
      session.previousEnding = chapter.narration.slice(-1400);
      session.chapter += 1;
      chapterPromise = generateStoryChapter({ topic:session.topic, continuity:session.continuity, previousEnding:session.previousEnding, chapter:session.chapter });
      const parts = splitSpeech(chapter.narration);
      const audioChunks = await Promise.all(parts.map(part => synthesizeVietnameseVoice(part, session.gender)));
      for (const audio of audioChunks) {
        if (session.stopped || Date.now() >= session.endsAt) break;
        await playResource(session.player, createAudioResource(Readable.from(audio.buffer), { inputType: StreamType.OggOpus }));
      }
    }
    if (!session.stopped) await session.textChannel.send(`Đã kể xong **${session.minutes} phút** truyện “${session.topic}”.`).catch(()=>{});
  } catch (error) {
    console.error("[narration]", error);
    await session.textChannel.send(`Kể chuyện bị dừng: ${String(error.message||error).slice(0,180)}`).catch(()=>{});
  } finally {
    void chapterPromise?.catch(() => {});
    session.player.stop(true); session.connection.destroy(); sessions.delete(session.guildId);
  }
}

export async function startNarration(message, { topic, duration_minutes=10, gender="female" }={}) {
  const voice=message.member?.voice?.channel; if(!voice) throw new Error("Bạn phải vào phòng voice trước.");
  const minutes=Math.max(1,Math.min(60,Math.floor(Number(duration_minutes)||10)));
  await stopNarration(message.guild.id, false); await releaseMusicForNarration(message.guild.id);
  const connection=joinVoiceChannel({channelId:voice.id,guildId:message.guild.id,adapterCreator:message.guild.voiceAdapterCreator,selfDeaf:true});
  await entersState(connection,VoiceConnectionStatus.Ready,20_000);
  const player=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Play}}); connection.subscribe(player);
  const session={guildId:message.guild.id,textChannel:message.channel,connection,player,topic:String(topic||"một câu chuyện ma Việt Nam").slice(0,500),minutes,gender,endsAt:Date.now()+minutes*60_000,chapter:1,continuity:"",previousEnding:"",stopped:false};
  sessions.set(message.guild.id,session); void runSession(session);
  return {ok:true,action:"narrating",voiceChannel:voice.name,durationMinutes:minutes,topic:session.topic,instruction:"Đã bắt đầu kể trực tiếp; không cần chờ kể xong mới trả lời user."};
}
export async function stopNarration(guildId, announce=true) { const s=sessions.get(guildId);if(!s)return {ok:false,error:"Không có phiên kể chuyện đang chạy."};s.stopped=true;s.player.stop(true);s.connection.destroy();sessions.delete(guildId);if(announce)await s.textChannel.send("Đã dừng kể chuyện trong voice.").catch(()=>{});return {ok:true,action:"narration_stopped"}; }