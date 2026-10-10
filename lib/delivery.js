// Speech-delivery metrics computed from ElevenLabs Scribe word timestamps.
// These feed the "tone & confidence" part of the feedback report.

const FILLERS = ["um", "uh", "erm", "er", "ah", "hmm", "like", "you know", "i mean", "basically", "actually", "literally", "so yeah", "kind of", "sort of"];
const HEDGES = ["i think", "i guess", "maybe", "probably", "i feel like", "kind of", "sort of", "i'm not sure", "not sure", "i believe", "hopefully", "somewhat", "just"];
const OWNERSHIP_I = /\b(i|i'm|i've|i'd|my|me)\b/g;
const OWNERSHIP_WE = /\b(we|we're|we've|our|us)\b/g;

function countPhrases(text, phrases) {
  const lower = ` ${text.toLowerCase().replace(/[^a-z' ]+/g, " ")} `;
  const counts = {};
  for (const p of phrases) {
    const re = new RegExp(`(?<=\\s)${p.replace(/ /g, "\\s+")}(?=\\s)`, "g");
    const n = (lower.match(re) || []).length;
    if (n) counts[p] = n;
  }
  return counts;
}

const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

/**
 * @param {string} text transcript
 * @param {Array<{text:string,start:number,end:number,type:string}>} words Scribe words (may be empty for typed answers)
 * @param {number} [thinkTimeMs] time between the question finishing and the candidate starting to answer
 */
export function analyzeDelivery(text, words = [], thinkTimeMs) {
  const spoken = words.filter((w) => w.type === "word");
  const wordCount = spoken.length || (text.match(/\S+/g) || []).length;
  const fillers = countPhrases(text, FILLERS);
  const hedges = countPhrases(text, HEDGES);

  const metrics = {
    word_count: wordCount,
    filler_words: fillers,
    filler_total: sum(fillers),
    filler_per_100_words: wordCount ? +((sum(fillers) / wordCount) * 100).toFixed(1) : 0,
    hedges,
    hedge_total: sum(hedges),
    i_vs_we: {
      i: (text.toLowerCase().match(OWNERSHIP_I) || []).length,
      we: (text.toLowerCase().match(OWNERSHIP_WE) || []).length,
    },
    audio_events: words.filter((w) => w.type === "audio_event").map((w) => w.text),
    source: spoken.length ? "voice" : "typed",
  };

  if (spoken.length >= 2) {
    const start = spoken[0].start;
    const end = spoken[spoken.length - 1].end;
    const durationSec = Math.max(end - start, 0.001);
    const gaps = [];
    for (let i = 1; i < spoken.length; i++) gaps.push(spoken[i].start - spoken[i - 1].end);
    const longPauses = gaps.filter((g) => g >= 1.5);
    metrics.duration_sec = +durationSec.toFixed(1);
    metrics.words_per_minute = Math.round((spoken.length / durationSec) * 60);
    metrics.long_pauses = longPauses.length;
    metrics.longest_pause_sec = gaps.length ? +Math.max(...gaps).toFixed(1) : 0;
    metrics.pace =
      metrics.words_per_minute < 110 ? "slow" : metrics.words_per_minute > 175 ? "fast" : "conversational";
  }
  if (Number.isFinite(thinkTimeMs) && thinkTimeMs >= 0) metrics.think_time_sec = +(thinkTimeMs / 1000).toFixed(1);
  return metrics;
}
