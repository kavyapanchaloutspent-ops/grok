import { spawn } from "node:child_process";
import edgeTtsPackage from "@andresaya/edge-tts";
import ffmpegPath from "ffmpeg-static";
import { config } from "./config.js";
const { EdgeTTS } = edgeTtsPackage;
const clean = text => String(text || "").replace(/<@!?(\d+)>/g, "người dùng").replace(/<a?:\w+:\d+>/g, "").replace(/https?:\/\/\S+/gi, " đường dẫn ").replace(/\s+/g, " ").trim().slice(0, 900);
function toOgg(mp3) { return new Promise((resolve, reject) => { if (!ffmpegPath) return reject(new Error("Không tìm thấy ffmpeg.")); const p = spawn(ffmpegPath, ["-hide_banner","-loglevel","error","-i","pipe:0","-vn","-ac","1","-ar","48000","-c:a","libopus","-b:a","32k","-application","voip","-f","ogg","pipe:1"], { windowsHide:true, stdio:["pipe","pipe","pipe"] }); const out=[], err=[]; const timer=setTimeout(()=>p.kill(),30000); p.stdout.on("data",x=>out.push(x)); p.stderr.on("data",x=>err.push(x)); p.on("error",reject); p.on("close",code=>{ clearTimeout(timer); const b=Buffer.concat(out); code===0&&b.length?resolve(b):reject(new Error(`Đổi OGG lỗi: ${Buffer.concat(err).toString("utf8").slice(0,300)}`)); }); p.stdin.end(mp3); }); }
function getDuration(ogg) { let at=0,g=0n; while(at+27<=ogg.length){const page=ogg.indexOf("OggS",at,"ascii");if(page<0||page+27>ogg.length)break;g=ogg.readBigUInt64LE(page+6);const n=ogg[page+26];if(page+27+n>ogg.length)break;let size=0;for(let i=0;i<n;i++)size+=ogg[page+27+i];at=page+27+n+size;} const s=Number(g)/48000;return Number.isFinite(s)&&s>0?s:1; }
function waveform(text){let seed=2166136261;for(const c of text){seed^=c.codePointAt(0);seed=Math.imul(seed,16777619);}const b=Buffer.alloc(96);for(let i=0;i<b.length;i++){seed=Math.imul(seed^(seed>>>15),2246822519);b[i]=Math.max(8,Math.min(255,Math.round((45+(seed>>>24))*Math.sin(Math.PI*(i+1)/(b.length+1)))));}return b.toString("base64");}
export async function synthesizeVietnameseVoice(text, gender="female") { const spoken=clean(text);if(!spoken)throw new Error("Thiếu nội dung cần đọc.");const tts=new EdgeTTS();await tts.synthesize(spoken,gender==="male"?"vi-VN-NamMinhNeural":"vi-VN-HoaiMyNeural",{rate:"+5%",pitch:"0Hz",volume:"100%"});const buffer=await toOgg(tts.toBuffer());return{buffer,duration:Math.min(1200,Math.max(.1,getDuration(buffer))),waveform:waveform(spoken)}; }
export async function sendVietnameseVoiceMessage(channelId,text,options={}) { const a=await synthesizeVietnameseVoice(text,options.gender);const form=new FormData();form.append("payload_json",JSON.stringify({flags:8192,attachments:[{id:"0",filename:"voice-message.ogg",duration_secs:a.duration,waveform:a.waveform}]}));form.append("files[0]",new Blob([a.buffer],{type:"audio/ogg"}),"voice-message.ogg");const r=await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`,{method:"POST",headers:{Authorization:`Bot ${config.discordToken}`},body:form});if(!r.ok)throw new Error(`Discord voice ${r.status}: ${(await r.text().catch(()=>"")).slice(0,300)}`);return{ok:true,type:"voice_message",language:"vi-VN",duration:a.duration}; }
async function readAttachedText(message, max=50_000) {
  for (const file of message.attachments?.values?.() || []) {
    if (!/\.(?:txt|md|log|json)$/i.test(file.name||"") && !String(file.contentType||"").startsWith("text/")) continue;
    if (Number(file.size||0)>200_000) throw new Error("File chữ tối đa 200 KB.");
    const response=await fetch(file.url);if(!response.ok)throw new Error("Không tải được file chữ.");
    return (await response.text()).replace(/^\uFEFF/,"").slice(0,max);
  }
  return "";
}
export async function handleVoiceCommand(message) {
  let body=message.content.replace(/^\.voice\b/i,"").trim(),gender="female";
  if(/^(?:nam|male)\s+/i.test(body)){gender="male";body=body.replace(/^(?:nam|male)\s+/i,"");}else if(/^(?:nữ|nu|female)\s+/i.test(body))body=body.replace(/^(?:nữ|nu|female)\s+/i,"");
  const attached=await readAttachedText(message,10_000); if(!body&&attached)body=attached;
  if(!body)return message.reply("Dùng `.voice nội dung`, `.voice nam nội dung` hoặc đính kèm file `.txt`.");
  await message.channel.sendTyping().catch(()=>{});
  const parts=[];let rest=body;while(rest.length>850&&parts.length<11){let cut=rest.lastIndexOf(" ",850);if(cut<450)cut=850;parts.push(rest.slice(0,cut).trim());rest=rest.slice(cut).trim();}if(rest&&parts.length<12)parts.push(rest);
  for(const part of parts)await sendVietnameseVoiceMessage(message.channel.id,part,{gender});
}
