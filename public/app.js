// RU Employed — browser client: setup → live voice interview → feedback report.
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  config: null,
  sessionId: null,
  plan: null,
  lastReply: "",
  ended: false,
  busy: false,
  recording: false,
  recorder: null,
  chunks: [],
  stream: null,
  questionEndedAt: null,
  callStart: null,
  timer: null,
  useBrowserVoice: false,
};

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res;
}

// ------------------------------------------------------------------ setup
async function init() {
  state.config = await (await api("/api/config")).json();
  const sel = $("#voiceId");
  sel.innerHTML = state.config.voices.map((v) => `<option value="${v.id}">${esc(v.name)} — ${esc(v.style)}</option>`).join("");

  const warn = [];
  if (!state.config.ai) warn.push("No AI key found: put <b>OPENAI_API_KEY</b> or <b>ANTHROPIC_API_KEY</b> in your <code>.env</code> file and restart the server.");
  if (!state.config.elevenlabs) {
    warn.push("<b>ELEVENLABS_API_KEY</b> isn't set: the interviewer will use your browser's built-in voice and you'll type your answers.");
    state.useBrowserVoice = true;
  }
  if (warn.length) {
    $("#keys-warning").innerHTML = warn.join("<br>");
    $("#keys-warning").classList.remove("hidden");
  }

  document.querySelectorAll(".drop").forEach((drop) => {
    const input = drop.querySelector("input");
    const text = drop.querySelector(".drop-text");
    const original = text.textContent;
    const update = () => {
      const f = input.files[0];
      drop.classList.toggle("filled", !!f);
      text.textContent = f ? `✓ ${f.name}` : original;
    };
    input.addEventListener("change", update);
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
      if (e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        update();
      }
    });
  });

  $("#setup-form").addEventListener("submit", startInterview);
}

const loadingSteps = [
  ["Reading your resume…", "Pulling out your projects, roles and wins."],
  ["Studying the job posting…", "Figuring out what this team really cares about."],
  ["Designing your interview…", "Picking the questions this company would actually ask."],
  ["Your interviewer is joining…", "Warming up the voice. Grab some water."],
];

async function startInterview(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  $("#setup-error").textContent = "";

  const hasResume = fd.get("resumeFile")?.size || fd.get("resumeText")?.trim();
  const hasJob = fd.get("jobUrl")?.trim() || fd.get("jobText")?.trim();
  if (!hasResume) return ($("#setup-error").textContent = "Add your resume (PDF or pasted text).");
  if (!hasJob) return ($("#setup-error").textContent = "Add the job description (link or pasted text).");
  for (const k of ["resumeFile", "linkedinFile"]) if (!fd.get(k)?.size) fd.delete(k);

  // Ask for the mic up front (it's also a user gesture, which unlocks audio playback).
  if (!state.useBrowserVoice) {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      $("#setup-error").textContent = "Microphone access was blocked — you can still type your answers.";
    }
  }
  audio.unlock();

  show("loading");
  let i = 0;
  const tick = () => {
    const [t, s] = loadingSteps[Math.min(i++, loadingSteps.length - 1)];
    $("#loading-title").textContent = t;
    $("#loading-sub").textContent = s;
  };
  tick();
  const loader = setInterval(tick, 4500);

  try {
    const data = await (await api("/api/sessions", { method: "POST", body: fd })).json();
    state.sessionId = data.id;
    state.plan = data.plan;
    enterCall();
    await interviewerSays(data.reply);
  } catch (err) {
    show("setup");
    $("#setup-error").textContent = err.message;
  } finally {
    clearInterval(loader);
  }
}

// ------------------------------------------------------------------ audio
const audio = (() => {
  const el = new Audio();
  let ctx, analyser, data, raf, micSource;
  const canvas = $("#viz");
  const g = canvas.getContext("2d");

  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    data = new Uint8Array(analyser.frequencyBinCount);
    ctx.createMediaElementSource(el).connect(analyser);
    analyser.connect(ctx.destination);
  }

  function draw(color) {
    cancelAnimationFrame(raf);
    const loop = () => {
      analyser.getByteFrequencyData(data);
      g.clearRect(0, 0, 240, 240);
      const bars = 64;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) * data.length * 0.7)] / 255;
        const a = (i / bars) * Math.PI * 2;
        const r1 = 72;
        const r2 = r1 + 6 + v * 40;
        g.strokeStyle = color;
        g.globalAlpha = 0.35 + v * 0.65;
        g.lineWidth = 3;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(120 + Math.cos(a) * r1, 120 + Math.sin(a) * r1);
        g.lineTo(120 + Math.cos(a) * r2, 120 + Math.sin(a) * r2);
        g.stroke();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  return {
    unlock() {
      try {
        ensureCtx();
        ctx.resume();
      } catch {}
    },
    async play(blob) {
      ensureCtx();
      await ctx.resume();
      if (micSource) micSource.disconnect();
      el.src = URL.createObjectURL(blob);
      draw("#cc0033");
      await el.play();
      await new Promise((resolve) => {
        el.onended = resolve;
        el.onerror = resolve;
      });
      URL.revokeObjectURL(el.src);
      this.stop();
    },
    showMic(stream) {
      ensureCtx();
      micSource = ctx.createMediaStreamSource(stream);
      micSource.connect(analyser);
      analyser.disconnect();
      draw("#8a93a3");
    },
    stop() {
      cancelAnimationFrame(raf);
      g.clearRect(0, 0, 240, 240);
      if (micSource) {
        micSource.disconnect();
        micSource = null;
      }
      try {
        analyser.disconnect();
        analyser.connect(ctx.destination);
      } catch {}
    },
    interrupt() {
      el.pause();
      el.dispatchEvent(new Event("ended"));
      speechSynthesis?.cancel();
    },
  };
})();

function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

// ------------------------------------------------------------------ call
function enterCall() {
  const { plan } = state;
  $("#call-company").textContent = plan.company;
  $("#call-role").textContent = plan.role;
  $("#interviewer-name").textContent = plan.interviewer.name;
  $("#interviewer-title").textContent = `${plan.interviewer.title} · ${plan.company}`;
  $("#interviewer-initial").textContent = (plan.interviewer.name || "A")[0].toUpperCase();
  if (!state.stream) toggleTyping(true);
  state.callStart = Date.now();
  state.timer = setInterval(() => {
    const s = Math.floor((Date.now() - state.callStart) / 1000);
    $("#call-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
  show("interview");
}

function setStatus(text, mode) {
  $("#status").textContent = text;
  $("#orb").className = `orb ${mode || ""}`;
}

function addBubble(role, text, meta) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.innerHTML = `${esc(text || "(no answer)")}${meta ? `<small>${esc(meta)}</small>` : ""}`;
  $("#transcript").append(div);
  $("#transcript").scrollTop = $("#transcript").scrollHeight;
}

async function interviewerSays(text) {
  state.lastReply = text;
  addBubble("interviewer", text);
  $("#caption").textContent = text;
  $("#mic-btn").disabled = true;
  setStatus(`${state.plan.interviewer.name} is speaking…`, "speaking");

  let spoke = false;
  if (!state.useBrowserVoice) {
    try {
      const res = await api(`/api/sessions/${state.sessionId}/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      await audio.play(await res.blob());
      spoke = true;
    } catch (err) {
      console.warn("ElevenLabs voice unavailable, using browser voice:", err.message);
    }
  }
  if (!spoke) await speakWithBrowser(text);

  state.questionEndedAt = Date.now();
  if (state.ended) return finishCall();
  setStatus("Your turn — answer out loud", "listening");
  $("#mic-btn").disabled = !state.stream;
}

function pickMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
}

function startRecording() {
  if (!state.stream || state.busy || state.ended) return;
  const mimeType = pickMime();
  state.chunks = [];
  state.thinkTimeMs = state.questionEndedAt ? Date.now() - state.questionEndedAt : undefined;
  state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.recorder.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
  state.recorder.onstop = sendRecording;
  state.recorder.start(250);
  state.recording = true;
  audio.showMic(state.stream);
  $("#mic-btn").classList.add("recording");
  $("#mic-btn").setAttribute("aria-label", "Stop answering");
  $("#mic-hint").innerHTML = "Recording… tap (or <kbd>Space</kbd>) when you're finished";
  setStatus("Listening…", "listening");
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  state.recorder.stop();
  audio.stop();
  $("#mic-btn").classList.remove("recording");
  $("#mic-btn").setAttribute("aria-label", "Start answering");
  $("#mic-hint").innerHTML = "Tap (or press <kbd>Space</kbd>) to answer, tap again when you're done";
}

async function sendRecording() {
  const type = state.recorder.mimeType || "audio/webm";
  const blob = new Blob(state.chunks, { type });
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, `answer.${ext}`);
  if (Number.isFinite(state.thinkTimeMs)) fd.append("thinkTimeMs", String(state.thinkTimeMs));
  await submitAnswer(fd, "Transcribing your answer…");
}

async function submitAnswer(fd, label) {
  state.busy = true;
  $("#mic-btn").disabled = true;
  setStatus(label, "");
  $("#caption").textContent = "";
  const thinking = setTimeout(() => setStatus(`${state.plan.interviewer.name} is thinking…`, ""), 1800);
  try {
    const data = await (await api(`/api/sessions/${state.sessionId}/answer`, { method: "POST", body: fd })).json();
    clearTimeout(thinking);
    const m = data.metrics;
    const meta = m.words_per_minute ? `${m.words_per_minute} wpm · ${m.filler_total} fillers` : `${m.word_count} words`;
    addBubble("candidate", data.transcript, meta);
    state.ended = data.ended;
    state.busy = false;
    await interviewerSays(data.reply);
  } catch (err) {
    clearTimeout(thinking);
    state.busy = false;
    setStatus(`⚠ ${err.message}`, "listening");
    $("#mic-btn").disabled = !state.stream;
  }
}

function toggleTyping(force) {
  const on = force ?? $("#type-form").classList.contains("hidden");
  $("#type-form").classList.toggle("hidden", !on);
  $("#toggle-type").textContent = on ? "🎙️ Speak instead" : "⌨️ Type instead";
  if (!state.stream) $("#toggle-type").classList.add("hidden");
  if (on) $("#type-input").focus();
}

async function finishCall() {
  clearInterval(state.timer);
  stopRecording();
  audio.interrupt();
  state.ended = true;
  $("#mic-btn").disabled = true;
  show("loading");
  $("#loading-title").textContent = "Reviewing your interview…";
  $("#loading-sub").textContent = "Scoring every STAR story, your delivery and your fit for the role. This takes about a minute.";
  try {
    const data = await (await api(`/api/sessions/${state.sessionId}/feedback`, { method: "POST" })).json();
    renderReport(data);
    show("report");
  } catch (err) {
    show("interview");
    setStatus(`⚠ ${err.message}`, "");
  }
}

$("#mic-btn").addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || !$("#view-interview").classList.contains("active")) return;
  if (["TEXTAREA", "INPUT", "BUTTON", "SELECT"].includes(document.activeElement.tagName)) return;
  e.preventDefault();
  if (state.recording) stopRecording();
  else if (!$("#mic-btn").disabled) startRecording();
});
$("#type-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#type-input").value.trim();
  if (!text || state.busy || state.ended) return;
  $("#type-input").value = "";
  const fd = new FormData();
  fd.append("text", text);
  if (state.questionEndedAt) fd.append("thinkTimeMs", String(Date.now() - state.questionEndedAt));
  submitAnswer(fd, "Sending…");
});
$("#type-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#type-form").requestSubmit();
  }
});
$("#toggle-type").addEventListener("click", () => toggleTyping());
$("#toggle-transcript").addEventListener("click", () => $("#transcript").classList.toggle("hidden"));
$("#replay-btn").addEventListener("click", () => {
  if (!state.busy && !state.recording && state.lastReply) {
    $("#transcript").lastElementChild?.remove();
    interviewerSays(state.lastReply);
  }
});
$("#end-btn").addEventListener("click", async () => {
  if (state.busy) return;
  const answered = $("#transcript").querySelector(".bubble.candidate");
  if (!answered) {
    if (!confirm("You haven't answered anything yet. Leave the interview?")) return;
    location.reload();
    return;
  }
  if (!state.ended && !confirm("End the interview now and get your feedback?")) return;
  fetch(`/api/sessions/${state.sessionId}/end`, { method: "POST" }).catch(() => {});
  finishCall();
});

// ------------------------------------------------------------------ report
const signalLabel = {
  strong_yes: ["Strong hire", "good"],
  yes: ["Hire", "good"],
  lean_yes: ["Leaning hire", "mid"],
  lean_no: ["Leaning no hire", "mid"],
  no: ["No hire (yet)", "bad"],
};
const colorFor = (pct) => (pct >= 75 ? "var(--good)" : pct >= 50 ? "var(--warn)" : "var(--bad)");
const list = (items) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted small">—</p>`);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

function deliveryTotals(transcript) {
  const answers = transcript.filter((t) => t.role === "candidate" && t.metrics);
  const voiced = answers.filter((t) => t.metrics.words_per_minute);
  const avg = (arr, k) => (arr.length ? Math.round(arr.reduce((a, t) => a + (t.metrics[k] || 0), 0) / arr.length) : null);
  const total = (k) => answers.reduce((a, t) => a + (t.metrics[k] || 0), 0);
  const words = total("word_count");
  const fillerCounts = {};
  answers.forEach((t) => Object.entries(t.metrics.filler_words || {}).forEach(([w, n]) => (fillerCounts[w] = (fillerCounts[w] || 0) + n)));
  const topFillers = Object.entries(fillerCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    wpm: avg(voiced, "words_per_minute"),
    fillers: total("filler_total"),
    fillerRate: words ? ((total("filler_total") / words) * 100).toFixed(1) : "0",
    pauses: total("long_pauses"),
    hedges: total("hedge_total"),
    think: answers.length ? (answers.reduce((a, t) => a + (t.metrics.think_time_sec || 0), 0) / answers.length).toFixed(1) : null,
    topFillers,
  };
}

function renderReport({ feedback: f, transcript, plan }) {
  const score = clamp(f.overall.score, 0, 100);
  const [sigText, sigClass] = signalLabel[f.overall.hire_signal] || ["—", "mid"];
  const d = deliveryTotals(transcript);
  const conf = clamp(f.delivery.confidence_score, 0, 100);

  const answers = f.answers
    .map((a, i) => {
      const cells = ["situation", "task", "action", "result"]
        .map((k) => {
          const s = a.star[k];
          const pct = (clamp(s.score, 0, 5) / 5) * 100;
          return `<div class="star-cell"><div class="lbl"><span>${k[0].toUpperCase()}${k.slice(1)}</span><span>${clamp(s.score, 0, 5)}/5</span></div>
            <div class="bar"><i style="width:${pct}%;background:${colorFor(pct)}"></i></div><p>${esc(s.note)}</p></div>`;
        })
        .join("");
      return `<article class="answer">
        <h4>Q${i + 1}. ${esc(a.question)}</h4>
        <p class="sum">${esc(a.answer_summary)}</p>
        ${a.uses_star ? "" : `<p class="muted small">Not a STAR question — scored on structure.</p>`}
        <div class="star">${cells}</div>
        <div class="cols">
          <div class="col worked"><h5>✓ What worked</h5>${list(a.what_worked)}</div>
          <div class="col expand"><h5>＋ Elaborate on</h5>${list(a.elaborate_on)}</div>
          <div class="col cut"><h5>✂ Cut</h5>${list(a.cut)}</div>
        </div>
        <details><summary><b>How to retell it</b></summary><div class="rewrite">${esc(a.stronger_version)}</div></details>
      </article>`;
    })
    .join("");

  const plans = [...f.improvement_plan]
    .sort((a, b) => a.priority - b.priority)
    .map(
      (p) => `<li><span class="when">${esc(p.timeframe)}</span><h4>${esc(p.title)}</h4><p class="muted">${esc(p.why)}</p>
        ${list(p.actions)}<div class="drill"><b>Drill:</b> ${esc(p.practice_drill)}</div></li>`
    )
    .join("");

  const transcriptHtml = transcript
    .map((t) => `<div class="bubble ${t.role}">${esc(t.text || "(no answer)")}${t.metrics?.words_per_minute ? `<small>${t.metrics.words_per_minute} wpm · ${t.metrics.filler_total} fillers · ${t.metrics.long_pauses} long pauses</small>` : ""}</div>`)
    .join("");

  $("#report").innerHTML = `<div class="report">
    <div class="card report-head">
      <div class="ring" style="--v:${score};--ring-color:${colorFor(score)}"><div><b>${Math.round(score)}</b><span>overall</span></div></div>
      <div>
        <span class="signal ${sigClass}">${sigText}</span>
        <h2>${esc(f.overall.headline)}</h2>
        <p class="muted small">${esc(plan.role)} · ${esc(plan.company)} · interviewed by ${esc(plan.interviewer.name)}</p>
        <p>${esc(f.overall.summary)}</p>
      </div>
    </div>

    <nav class="report-nav">
      <a href="#r-star">⭐ STAR answers</a><a href="#r-delivery">🎙️ Delivery</a><a href="#r-fit">🎯 Role fit</a>
      <a href="#r-plan">🗺️ Improvement plan</a><a href="#r-practice">🔁 Practice next</a><a href="#r-transcript">📝 Transcript</a>
    </nav>

    <section class="block" id="r-star"><h3>STAR breakdown</h3>
      <p class="muted">For every story: what landed, what to expand, and what to cut.</p>${answers}</section>

    <section class="block card" id="r-delivery"><h3>Tone & confidence</h3>
      <div class="stats">
        <div class="stat"><b style="color:${colorFor(conf)}">${Math.round(conf)}</b><span>confidence score</span></div>
        <div class="stat"><b>${d.wpm ?? "—"}</b><span>avg words / min (130–170 ideal)</span></div>
        <div class="stat"><b>${d.fillers}</b><span>filler words (${d.fillerRate} per 100)${d.topFillers.length ? ` · top: ${d.topFillers.map(([w, n]) => `“${esc(w)}” ×${n}`).join(", ")}` : ""}</span></div>
        <div class="stat"><b>${d.pauses}</b><span>long pauses · ${d.hedges} hedges${d.think ? ` · ${d.think}s avg think time` : ""}</span></div>
      </div>
      <dl class="kv">
        <dt>Tone</dt><dd>${esc(f.delivery.tone)}</dd>
        <dt>Pace</dt><dd>${esc(f.delivery.pace)}</dd>
        <dt>Filler & hedging</dt><dd>${esc(f.delivery.filler_words)}</dd>
        <dt>Ownership</dt><dd>${esc(f.delivery.ownership)}</dd>
      </dl>
      <h4 style="margin-top:16px">Delivery tips</h4>${list(f.delivery.tips)}
    </section>

    <section class="block card" id="r-fit"><h3>Your experience vs. this role</h3>
      <div class="two">
        <div><h4>Strengths for this role</h4>${list(f.experience_fit.strengths_for_role)}</div>
        <div><h4>Gaps vs. the job description</h4>${list(f.experience_fit.gaps_vs_job)}</div>
      </div>
      <h4>Experiences you should have used</h4>${list(f.experience_fit.underused_experiences)}
      <h4>Mission alignment</h4><p>${esc(f.experience_fit.mission_alignment)}</p>
    </section>

    <section class="block" id="r-plan"><h3>Your improvement plan</h3><ol class="plan">${plans}</ol></section>

    <section class="block card" id="r-practice"><h3>Practice these next</h3>
      <ul>${f.practice_questions.map((q) => `<li><b>${esc(q.question)}</b><br><span class="muted small">${esc(q.why)}</span></li>`).join("")}</ul>
    </section>

    <section class="block card" id="r-transcript"><h3>Full transcript</h3><div class="transcript">${transcriptHtml}</div></section>

    <div class="report-actions">
      <button class="btn" onclick="window.print()">🖨️ Save as PDF</button>
      <button class="btn primary" onclick="location.reload()">Practice again</button>
    </div>
  </div>`;
}

init().catch((err) => {
  $("#setup-error").textContent = `Couldn't reach the server: ${err.message}`;
});
