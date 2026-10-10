# RU Employed 🎙️

**A voice-first AI mock interviewer built from your resume, your LinkedIn and the real job posting.** HackRU project.

You upload your resume, your LinkedIn and the job description. An AI interviewer that has read all three calls you. It speaks with a realistic **ElevenLabs** voice and asks the questions this company would actually ask for this role. That includes questions about your own projects and how they connect to the company's mission. You answer out loud. When the call ends you get a coaching report covering:

- **STAR breakdown for every answer.** Each Situation, Task, Action and Result is scored, with notes on what worked, what to **elaborate on** and what to **cut**, plus an outline of a stronger retelling.
- **Tone & confidence.** Uses measured speaking pace (words per minute), long pauses, filler words ("um", "like"…), hedging ("I think", "maybe"), think time before answering, and how often you said "I" vs "we".
- **Experience vs. the role.** Your strengths, the gaps against the job description, resume items you should have used, and how well you tied your experience to the mission.
- **A prioritized improvement plan** with concrete practice drills, plus the next questions to rehearse.

## How it works

```
Resume PDF ──┐
LinkedIn PDF ┼─► text ─► Claude designs a realistic interview plan for this exact role/company
Job URL ─────┘                                  │
                                                ▼
           ┌───────────── live call loop ──────────────┐
           │ Claude (interviewer persona) → next line  │
           │ ElevenLabs TTS → interviewer speaks       │
           │ You answer → mic recording                │
           │ ElevenLabs Scribe STT → transcript +      │
           │   word timestamps → delivery metrics      │
           └───────────────────────────────────────────┘
                                                │
                                                ▼
         Claude grades transcript + metrics → STAR / delivery / fit / plan report
```

| Piece | Tech |
|---|---|
| Interviewer voice | ElevenLabs text-to-speech (streaming, `eleven_flash_v2_5` for low latency) |
| Hearing your answers | ElevenLabs Scribe speech-to-text with word-level timestamps |
| Interview design, live interviewer, feedback | Claude (`claude-opus-5-5`) with structured outputs |
| Server | Node.js + Express |
| Frontend | Vanilla HTML/CSS/JS with a Web Audio voice visualizer and MediaRecorder |

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY and ELEVENLABS_API_KEY
npm start              # → http://localhost:3000
```

Open it in Chrome, Edge or Safari, allow microphone access, and use headphones so the interviewer's voice doesn't bleed into your mic.

- **Answering:** tap the mic (or press <kbd>Space</kbd>), speak, then tap again when you're done. You can also type an answer at any point.
- **No ElevenLabs key?** The app still runs. The interviewer uses the browser's built-in voice and you type your answers.
- **LinkedIn:** on your profile, choose *More → Save to PDF* and upload that file. You can also paste the sections in.
- **Job posting:** paste a link. If the page needs a login or JavaScript to load, paste the text instead.

## Project layout

```
server.js           Express API: sessions, answers, speech, feedback
lib/ingest.js       PDF + job-page text extraction
lib/claude.js       Interview planner, live interviewer, feedback grader
lib/elevenlabs.js   TTS streaming + Scribe transcription
lib/delivery.js     Pace / pause / filler / hedge / ownership metrics
public/             Single-page UI (setup → call → report)
test/               Unit tests (npm test)
```

## Notes

- Sessions live in memory and expire after 3 hours, which is fine for a demo. Use Redis or a database before running multiple instances.
- A transcript doesn't capture vocal pitch, so "tone" is inferred from pacing, pauses, fillers, hedging and word choice. The report says this.
- Requests use Claude's server-side refusal fallback (`fallbacks: "default"`), so a false-positive safety decline doesn't end an interview partway through.
