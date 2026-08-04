import { resolveTrackMetadata } from "./music.js";
const tenWords = text => String(text||"").replace(/\[[^\]]+\]/g," ").split(/\s+/).filter(Boolean).slice(0,10).join(" ");
export async function identifyLyrics(message, url) {
  const track=await resolveTrackMetadata(message,String(url||"").trim());
  const q=new URLSearchParams({track_name:track.title,artist_name:track.author});
  if(track.length)q.set("duration",String(Math.round(track.length/1000)));
  let data=null;
  const exact=await fetch(`https://lrclib.net/api/get?${q}`,{headers:{"User-Agent":"DiscordAIBot/1.0"}});
  if(exact.ok)data=await exact.json();
  if(!data){const search=await fetch(`https://lrclib.net/api/search?${new URLSearchParams({track_name:track.title,artist_name:track.author})}`,{headers:{"User-Agent":"DiscordAIBot/1.0"}});if(search.ok)data=(await search.json())?.[0]||null;}
  return {ok:true,identified:{title:track.title,artist:track.author,source:track.sourceName,url:track.uri},lyricsFound:Boolean(data),synced:Boolean(data?.syncedLyrics),lyricsExcerpt:data?tenWords(data.plainLyrics||data.syncedLyrics):null,note:data?"Chỉ trả đoạn nhận diện ngắn; không dán toàn bộ lời bài hát.":"Đã nhận diện track nhưng chưa tìm thấy lời khớp."};
}