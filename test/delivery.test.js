import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDelivery } from "../lib/delivery.js";
import { htmlToText } from "../lib/ingest.js";

test("counts fillers and hedges in typed answers", () => {
  const m = analyzeDelivery("Um, I think we basically, like, shipped it. Um I led the API work.", []);
  assert.equal(m.source, "typed");
  assert.equal(m.filler_words.um, 2);
  assert.equal(m.filler_words.like, 1);
  assert.equal(m.filler_words.basically, 1);
  assert.equal(m.hedges["i think"], 1);
  assert.equal(m.i_vs_we.i, 2);
  assert.equal(m.i_vs_we.we, 1);
  assert.equal(m.words_per_minute, undefined);
});

test("computes pace and pauses from word timestamps", () => {
  const words = [];
  let t = 0;
  for (let i = 0; i < 30; i++) {
    words.push({ text: "word", start: t, end: t + 0.3, type: "word" });
    words.push({ text: " ", start: t + 0.3, end: t + 0.4, type: "spacing" });
    t += i === 10 ? 2.5 : 0.4; // one long pause
  }
  words.push({ text: "(laughs)", start: t, end: t + 0.5, type: "audio_event" });
  const m = analyzeDelivery("word ".repeat(30), words, 2300);
  assert.equal(m.source, "voice");
  assert.equal(m.word_count, 30);
  assert.equal(m.long_pauses, 1);
  assert.equal(m.think_time_sec, 2.3);
  assert.deepEqual(m.audio_events, ["(laughs)"]);
  assert.ok(m.words_per_minute > 100 && m.words_per_minute < 160, `wpm ${m.words_per_minute}`);
});

test("strips job posting HTML to readable text", () => {
  const txt = htmlToText("<html><script>evil()</script><h1>SWE Intern</h1><ul><li>Python</li><li>React</li></ul><p>We&#39;re hiring &amp; growing</p></html>");
  assert.match(txt, /SWE Intern/);
  assert.match(txt, /• Python/);
  assert.match(txt, /We're hiring & growing/);
  assert.doesNotMatch(txt, /evil/);
});
