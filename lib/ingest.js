// Turns the candidate's uploads (resume PDF, LinkedIn PDF export, job posting URL)
// into plain text the interviewer can work from.
import { createRequire } from "node:module";
import dns from "node:dns/promises";
import net from "node:net";

const require = createRequire(import.meta.url);
// Import the inner module: pdf-parse's index.js runs a debug harness when it has no parent module.
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

const MAX_CHARS = 60_000;

export async function pdfToText(buffer) {
  const { text } = await pdfParse(buffer);
  return clean(text);
}

export function clean(text = "") {
  return String(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);
}

export function htmlToText(html) {
  return clean(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  );
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") ||
    (v6.startsWith("::ffff:") && isPrivateAddress(v6.slice(7)));
}

// Fetches a public job-posting page and strips it to text.
export async function fetchJobPosting(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That job description link isn't a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Job description link must be http(s).");
  const { address } = await dns.lookup(url.hostname);
  if (isPrivateAddress(address)) throw new Error("Job description link must point to a public website.");

  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; RUEmployed/1.0; +https://hackru.org)",
      accept: "text/html,application/xhtml+xml,text/plain",
    },
  });
  if (!res.ok) throw new Error(`Couldn't load the job posting (HTTP ${res.status}). Paste the text instead.`);
  const body = await res.text();
  const text = /html/i.test(res.headers.get("content-type") || "") ? htmlToText(body) : clean(body);
  if (text.length < 200) {
    throw new Error("That page didn't have readable job details (it may need JavaScript or a login). Paste the text instead.");
  }
  return text;
}
