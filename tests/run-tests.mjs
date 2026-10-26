// Test runner for Ask Randhir.
//
//   node tests/run-tests.mjs           offline (default)
//   node tests/run-tests.mjs --live    against the real LLM provider
//
// Offline mode exercises the exact Worker code with a mocked provider:
// the deterministic pre-gate, CORS, validation, history truncation, rate
// limits, the daily cap, the not-configured default and error hygiene.
// The golden/adversarial sets are also run through a mock that returns a
// compliant canned answer, which validates the assertion plumbing.
//
// Live mode (needs GEMINI_API_KEY and/or GROQ_API_KEY in the environment)
// runs the same sets against the real model — that is the run that proves
// the system prompt and knowledge file actually hold the line. Run it
// after every prompt, knowledge or provider change.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createChatHandler } from "../worker/src/chat.js";
import { REFUSAL_SCOPE, REFUSAL_NO_INFO } from "../worker/src/guardrail.js";
import { GOLDEN, ADVERSARIAL } from "./cases.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const knowledge = readFileSync(join(root, "worker", "knowledge.md"), "utf8");
const LIVE = process.argv.includes("--live");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    failures.push(name);
    console.log("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

function chatRequest(body, { origin = "https://randhirsingh77.github.io", ip = "1.2.3.4" } = {}) {
  return new Request("https://ask-randhir.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

function includesGroups(answer, groups) {
  const a = (answer || "").toLowerCase();
  return groups.every((g) => g.some((s) => a.includes(s.toLowerCase())));
}
function excludesAll(answer, list = []) {
  const a = (answer || "").toLowerCase();
  return list.every((s) => !a.includes(s.toLowerCase()));
}

// ---------- mocked provider ----------
let fetchCalls = [];
function mockFetch(mode = "ok") {
  return async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (mode === "429") {
      return { ok: false, status: 429, json: async () => ({ error: { message: "quota" } }) };
    }
    const body = JSON.parse(opts.body);
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    const golden = GOLDEN.find((g) => g.q === lastUser?.content);
    const adv = ADVERSARIAL.find((a) => a.q === lastUser?.content);
    let content;
    if (golden) content = golden.offlineAnswer;
    else if (adv) content = adv.expect === "noinfo" ? REFUSAL_NO_INFO : REFUSAL_SCOPE;
    else content = "He is a full-stack developer based in New Delhi who builds with the MERN stack and React Native.";
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

async function ask(handler, q, extra = {}) {
  const res = await handler(chatRequest({ messages: [{ role: "user", content: q }] }, extra));
  return { status: res.status, body: await res.json() };
}

// ---------- offline suite ----------
async function offline() {
  console.log("\n== static checks ==");
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  })(root);
  const secretPattern = /(AIza[0-9A-Za-z_-]{10,}|gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,})/;
  const offenders = files.filter(
    (f) => !f.includes("tests/") && secretPattern.test(readFileSync(f, "utf8"))
  );
  check("no API-key-shaped strings anywhere in the repo", offenders.length === 0, offenders.join(","));
  check(
    "knowledge file fits the prompt budget (<= 16000 chars)",
    knowledge.length <= 16000,
    knowledge.length + " chars"
  );
  const chatJs = readFileSync(join(root, "public", "chat.js"), "utf8");
  check("frontend never assigns innerHTML (answers render as text)", !chatJs.includes("innerHTML"));

  console.log("\n== handler: deploy-safe default ==");
  const bare = createChatHandler({ env: {}, knowledge, fetchImpl: mockFetch() });
  const nc = await ask(bare, "What are his skills?");
  check("no keys -> 503 not_configured with a clean message", nc.status === 503 && nc.body.error === "not_configured" && typeof nc.body.message === "string");

  console.log("\n== handler: CORS + validation ==");
  fetchCalls = [];
  const h = createChatHandler({
    env: { GEMINI_API_KEY: "test-key", PER_IP_PER_MIN: "1000", DAILY_CAP: "100000" },
    knowledge,
    fetchImpl: mockFetch(),
  });
  const evil = await h(chatRequest({ messages: [{ role: "user", content: "hi" }] }, { origin: "https://evil.example" }));
  check("unknown origin -> 403", evil.status === 403);
  const long = await ask(h, "x".repeat(900));
  check("message over the limit -> 400 message_too_long", long.status === 400 && long.body.error === "message_too_long");
  const empty = await h(chatRequest({ messages: [] }));
  check("no user message -> 400", empty.status === 400);

  console.log("\n== handler: prompt construction ==");
  fetchCalls = [];
  const many = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "turn " + i,
  }));
  many.push({ role: "user", content: "What are Randhir's main skills?" });
  const res = await h(chatRequest({ messages: many }));
  check("long conversation still answers", res.status === 200);
  const sent = JSON.parse(fetchCalls[0].opts.body);
  check("provider receives system + at most 6 history turns", sent.messages.length <= 7, sent.messages.length + " messages");
  check("system prompt carries the knowledge file", sent.messages[0].content.includes("Foodie"));
  check("system prompt carries the refusal templates", sent.messages[0].content.includes(REFUSAL_SCOPE));
  check("temperature is 0.2 and max_tokens is 350", sent.temperature === 0.2 && sent.max_tokens === 350);
  check("provider key is sent only to the provider", fetchCalls[0].opts.headers.authorization === "Bearer test-key");

  console.log("\n== handler: pre-gate (no LLM call allowed) ==");
  for (const c of ADVERSARIAL.filter((a) => a.preGate)) {
    fetchCalls = [];
    const out = await ask(h, c.q);
    check("pre-gate refuses: " + c.q, out.body.answer === REFUSAL_SCOPE && fetchCalls.length === 0,
      "fetchCalls=" + fetchCalls.length);
  }

  console.log("\n== handler: golden + adversarial via mock ==");
  for (const g of GOLDEN) {
    const out = await ask(h, g.q);
    check("golden: " + g.q, includesGroups(out.body.answer, g.mustInclude) && excludesAll(out.body.answer, g.mustNotInclude), out.body.answer);
  }
  for (const a of ADVERSARIAL.filter((x) => !x.liveOnly && !x.preGate)) {
    const out = await ask(h, a.q);
    const want = a.expect === "noinfo" ? REFUSAL_NO_INFO : REFUSAL_SCOPE;
    const okTemplate = a.expect === "either" ? [REFUSAL_SCOPE, REFUSAL_NO_INFO].includes(out.body.answer) || includesGroups(out.body.answer, a.mustInclude || []) : out.body.answer === want;
    check("adversarial: " + a.q, okTemplate, out.body.answer);
  }

  console.log("\n== handler: provider failure hygiene ==");
  const h429 = createChatHandler({ env: { GEMINI_API_KEY: "test-key" }, knowledge, fetchImpl: mockFetch("429") });
  const out429 = await ask(h429, "What are his skills?");
  check("provider 429 -> friendly resting message, nothing leaked", out429.status === 503 && out429.body.error === "provider_unavailable" && !JSON.stringify(out429.body).includes("quota"));

  console.log("\n== handler: abuse caps ==");
  const hCap = createChatHandler({ env: { GEMINI_API_KEY: "k", DAILY_CAP: "2", PER_IP_PER_MIN: "100" }, knowledge, fetchImpl: mockFetch() });
  await ask(hCap, "What are his skills?", { ip: "9.9.9.9" });
  await ask(hCap, "Where does he live?", { ip: "9.9.9.9" });
  const third = await ask(hCap, "Tell me about Foodie", { ip: "9.9.9.9" });
  check("daily cap -> resting message", third.body.error === "daily_cap");
  const hIp = createChatHandler({ env: { GEMINI_API_KEY: "k", PER_IP_PER_MIN: "3", DAILY_CAP: "1000" }, knowledge, fetchImpl: mockFetch() });
  let last;
  for (let i = 0; i < 4; i++) last = await ask(hIp, "skills?", { ip: "8.8.8.8" });
  check("per-IP limit -> 429", last.status === 429 && last.body.error === "rate_limited");

  console.log("\n== handler: provider swap ==");
  fetchCalls = [];
  const hGroq = createChatHandler({ env: { LLM_PROVIDER: "groq", GROQ_API_KEY: "g-key" }, knowledge, fetchImpl: mockFetch() });
  await ask(hGroq, "What are his skills?");
  check("LLM_PROVIDER=groq calls the Groq endpoint + model", fetchCalls[0].url.includes("api.groq.com") && JSON.parse(fetchCalls[0].opts.body).model === "openai/gpt-oss-120b");
  fetchCalls = [];
  const hFallback = createChatHandler({ env: { LLM_PROVIDER: "gemini", GROQ_API_KEY: "g-key" }, knowledge, fetchImpl: mockFetch() });
  await ask(hFallback, "What are his skills?");
  check("missing primary key falls back to the configured provider", fetchCalls[0].url.includes("api.groq.com"));
}

// ---------- live suite ----------
async function live() {
  const env = { LLM_PROVIDER: process.env.LLM_PROVIDER || "gemini" };
  if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (process.env.GROQ_API_KEY) env.GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
    console.log("\n--live needs GEMINI_API_KEY or GROQ_API_KEY in the environment. Skipping.");
    return;
  }
  const h = createChatHandler({ env, knowledge, fetchImpl: fetch });
  for (const g of GOLDEN) {
    const out = await ask(h, g.q);
    check("LIVE golden: " + g.q, includesGroups(out.body.answer, g.mustInclude) && excludesAll(out.body.answer, g.mustNotInclude), out.body.answer);
  }
  for (const a of ADVERSARIAL) {
    const out = await ask(h, a.q);
    const templates = { scope: REFUSAL_SCOPE, noinfo: REFUSAL_NO_INFO };
    const ok =
      a.expect === "either"
        ? [REFUSAL_SCOPE, REFUSAL_NO_INFO].includes(out.body.answer) || includesGroups(out.body.answer, a.mustInclude || [])
        : out.body.answer === templates[a.expect] && excludesAll(out.body.answer, a.mustNotInclude);
    check("LIVE adversarial: " + a.q, ok, out.body.answer);
  }
}

if (LIVE) await live();
else await offline();

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log("failures:\n - " + failures.join("\n - "));
process.exit(failed ? 1 : 0);
