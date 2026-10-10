// ElevenLabs: the interviewer's voice (text-to-speech) and the candidate's ears (Scribe speech-to-text).
import { Readable } from "node:stream";

const API = "https://api.elevenlabs.io/v1";
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";

// A few stock ElevenLabs voices that sound like a real interviewer.
export const VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", style: "Warm, calm recruiter" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", style: "Measured hiring manager" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", style: "Direct engineering lead" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", style: "Upbeat, friendly screener" },
];

export const hasElevenLabs = () => Boolean(process.env.ELEVENLABS_API_KEY);

function key() {
  if (!process.env.ELEVENLABS_API_KEY) {
    const err = new Error("ELEVENLABS_API_KEY is not set");
    err.status = 501;
    throw err;
  }
  return process.env.ELEVENLABS_API_KEY;
}

async function fail(res, what) {
  const detail = await res.text().catch(() => "");
  const err = new Error(`ElevenLabs ${what} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
  err.status = 502;
  return err;
}

/** Streams interviewer speech as MP3 into an Express response. */
export async function streamSpeech(text, voiceId, res) {
  const voice = VOICES.some((v) => v.id === voiceId) ? voiceId : VOICES[0].id;
  const upstream = await fetch(`${API}/text-to-speech/${voice}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key(), "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
    }),
  });
  if (!upstream.ok) throw await fail(upstream, "text-to-speech");
  res.setHeader("content-type", "audio/mpeg");
  res.setHeader("cache-control", "no-store");
  Readable.fromWeb(upstream.body).pipe(res);
}

/** Transcribes one spoken answer. Returns { text, words } with word-level timestamps. */
export async function transcribe(buffer, mimetype = "audio/webm", filename = "answer.webm") {
  const form = new FormData();
  form.append("model_id", STT_MODEL);
  form.append("file", new Blob([buffer], { type: mimetype }), filename);
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "word");
  form.append("language_code", "en");

  const res = await fetch(`${API}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": key() },
    body: form,
  });
  if (!res.ok) throw await fail(res, "speech-to-text");
  const data = await res.json();
  return { text: (data.text || "").trim(), words: Array.isArray(data.words) ? data.words : [] };
}
