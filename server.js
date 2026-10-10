import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pdfToText, clean, fetchJobPosting } from "./lib/ingest.js";
import { planInterview, interviewerTurn, generateFeedback, LENGTHS, aiProvider } from "./lib/ai.js";
import { streamSpeech, transcribe, VOICES, hasElevenLabs } from "./lib/elevenlabs.js";
import { analyzeDelivery } from "./lib/delivery.js";

// Load secrets from .env (project root) or env/.env — both are gitignored.
for (const file of [".env", "env/.env"]) {
  try {
    process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), file));
  } catch {}
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory sessions — fine for a hackathon demo; swap for Redis/DB to scale.
const sessions = new Map();
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.startedAt < cutoff) sessions.delete(id);
}, 10 * 60 * 1000).unref();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function getSession(req) {
  const s = sessions.get(req.params.id);
  if (!s) {
    const err = new Error("Interview session not found or expired. Start a new one.");
    err.status = 404;
    throw err;
  }
  return s;
}

app.get("/api/config", (_req, res) => {
  res.json({
    voices: VOICES,
    lengths: LENGTHS,
    elevenlabs: hasElevenLabs(),
    ai: aiProvider(),
  });
});

// 1) Ingest resume / LinkedIn / job description, design the interview, and get the opening line.
app.post(
  "/api/sessions",
  upload.fields([{ name: "resumeFile", maxCount: 1 }, { name: "linkedinFile", maxCount: 1 }]),
  wrap(async (req, res) => {
    const b = req.body;
    const fileText = async (field) => {
      const f = req.files?.[field]?.[0];
      if (!f) return "";
      if (f.mimetype === "application/pdf" || f.originalname.toLowerCase().endsWith(".pdf")) return pdfToText(f.buffer);
      return clean(f.buffer.toString("utf8"));
    };

    const resume = (await fileText("resumeFile")) || clean(b.resumeText);
    const linkedin = (await fileText("linkedinFile")) || clean(b.linkedinText);
    let job = clean(b.jobText);
    if (!job && b.jobUrl) job = await fetchJobPosting(b.jobUrl.trim());

    if (!resume) return res.status(400).json({ error: "Add your resume (PDF or pasted text)." });
    if (!job) return res.status(400).json({ error: "Add the job description (link or pasted text)." });

    const materials = { resume, linkedin, job, notes: clean(b.notes).slice(0, 2000) };
    const plan = await planInterview(materials, { length: b.length, focus: b.focus });

    const session = {
      id: randomUUID(),
      startedAt: Date.now(),
      voiceId: b.voiceId,
      materials,
      plan,
      messages: [], // append-only Claude conversation
      turns: [], // human-readable transcript + metrics
      ended: false,
      feedback: null,
    };
    const opening = await interviewerTurn(session, null);
    session.turns.push({ role: "interviewer", text: opening.say });
    sessions.set(session.id, session);

    res.json({
      id: session.id,
      plan: {
        company: plan.company,
        role: plan.role,
        interviewer: plan.interviewer,
        format_summary: plan.format_summary,
        question_count: plan.questions.length,
      },
      reply: opening.say,
    });
  })
);

// 2) Candidate answers (voice or typed) → transcript + delivery metrics → interviewer's next line.
app.post(
  "/api/sessions/:id/answer",
  upload.single("audio"),
  wrap(async (req, res) => {
    const session = getSession(req);
    if (session.ended) return res.status(409).json({ error: "This interview has already ended." });

    let text = clean(req.body.text);
    let words = [];
    if (req.file) {
      const result = await transcribe(req.file.buffer, req.file.mimetype, req.file.originalname);
      text = result.text;
      words = result.words;
    }
    const metrics = analyzeDelivery(text, words, Number(req.body.thinkTimeMs));
    session.turns.push({ role: "candidate", text, metrics });

    const next = await interviewerTurn(session, text);
    session.turns.push({ role: "interviewer", text: next.say });
    if (next.end_interview) session.ended = true;

    res.json({ transcript: text, metrics, reply: next.say, ended: session.ended });
  })
);

// 3) Interviewer voice via ElevenLabs.
app.post(
  "/api/sessions/:id/speech",
  wrap(async (req, res) => {
    const session = getSession(req);
    const text = String(req.body.text || "").slice(0, 2500);
    if (!text) return res.status(400).json({ error: "Nothing to say." });
    await streamSpeech(text, session.voiceId, res);
  })
);

// 4) End early (candidate hangs up).
app.post("/api/sessions/:id/end", (req, res, next) => {
  try {
    getSession(req).ended = true;
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// 5) Feedback report.
app.post(
  "/api/sessions/:id/feedback",
  wrap(async (req, res) => {
    const session = getSession(req);
    session.ended = true;
    if (!session.turns.some((t) => t.role === "candidate" && t.text)) {
      return res.status(400).json({ error: "Answer at least one question before asking for feedback." });
    }
    session.feedback ??= await generateFeedback(session);
    res.json({
      feedback: session.feedback,
      transcript: session.turns,
      plan: { company: session.plan.company, role: session.plan.role, interviewer: session.plan.interviewer },
    });
  })
);

app.use((err, _req, res, _next) => {
  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: err.message || "Something went wrong." });
  else res.end();
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`RU Employed running → http://localhost:${port}`);
  const ai = aiProvider();
  if (ai) console.log(`AI brain: ${ai === "openai" ? "OpenAI" : "Claude"}`);
  else console.warn("⚠  No ANTHROPIC_API_KEY or OPENAI_API_KEY in .env — the interviewer can't think.");
  if (!hasElevenLabs()) console.warn("⚠  ELEVENLABS_API_KEY not set — falling back to the browser's built-in voice and typed answers.");
});
