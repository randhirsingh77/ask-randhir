// Guardrail primitives for the Ask Randhir assistant.
//
// Pure functions only — no I/O — so the exact code that runs in the
// Cloudflare Worker is also exercised by the offline test suite
// (tests/run-tests.mjs).
//
// Design (see README "How the guardrail works"):
//   1. A deterministic pre-gate in code catches unambiguous abuse and
//      off-topic openers and answers with the fixed refusal template
//      WITHOUT spending an LLM call.
//   2. The system prompt (buildSystemPrompt in chat.js) scopes the model to
//      the knowledge file.
//   3. History is truncated so a conversation cannot drift or be used to
//      smuggle in a false "fact" about Randhir.
// The pre-gate is a filter, not a wall — paraphrases slip past it and are
// the model's job. The assistant has no tools and no secrets in context,
// so the worst case of a slip is one off-topic answer, never a leak.

export const CONTACT_EMAIL = "rs6201849307@gmail.com";

export const REFUSAL_SCOPE =
  "I can only answer questions about Randhir Singh — his skills, projects, " +
  "experience and how to contact him. Try asking about those!";

export const REFUSAL_NO_INFO =
  "I don't have that information — you can ask Randhir directly at " +
  CONTACT_EMAIL +
  ".";

export const NOT_CONFIGURED_MESSAGE =
  "The assistant is not configured yet — please check back soon, or email " +
  "Randhir directly at " +
  CONTACT_EMAIL +
  ".";

export const RESTING_MESSAGE =
  "The assistant is resting right now (free-tier limits) — please try again " +
  "in a little while, or email Randhir directly at " +
  CONTACT_EMAIL +
  ".";

// Unambiguous instruction-override / jailbreak openers and requests that are
// never about Randhir. Matched case-insensitively against the raw message.
const BLOCKED_PATTERNS = [
  /ignore\s+(all\s+|your\s+|the\s+|previous\s+|above\s+)*(instructions|rules|prompt|directions)/i,
  /disregard\s+(all\s+|your\s+|the\s+)*(instructions|rules|prompt)/i,
  /forget\s+(all\s+|your\s+|the\s+)*(instructions|rules|prompt|everything)/i,
  /(reveal|show|print|repeat|tell me|what is|what's)\s+(me\s+)?(your\s+)?(system\s+prompt|instructions|initial prompt)/i,
  /system\s+prompt/i,
  /jailbreak/i,
  /\bDAN\b|developer mode|god mode/i,
  /pretend\s+(you are|to be)\s+(a|an|not)/i,
  /you are now\s+(a|an|no longer)/i,
  /act as\s+(a|an)\s+(general|unrestricted|different)/i,
  /write\s+(me\s+)?(a|an|the)\s+(poem|essay|story|song|rap|joke|letter|code|program|script|function)\b/i,
  /solve\s+(this|my|the)\s+(math|homework|equation)/i,
  /do my homework/i,
];

// A short allow-signal list is NOT used for blocking — plenty of legitimate
// questions share no keyword with the profile ("is he available?", "where
// does he live?"). Anything not blocked here goes to the model, whose
// system prompt enforces scope.

/**
 * Deterministic pre-gate. Returns { blocked: true, reason } when the
 * message is unambiguously an override attempt or an off-mission request
 * the assistant must never spend an LLM call on.
 */
export function preGate(message) {
  const text = String(message || "");
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return { blocked: true, reason: "pattern" };
    }
  }
  return { blocked: false };
}

/**
 * Keep only the last `maxTurns` messages, drop anything that is not a
 * user/assistant message with string content, and cap the total characters
 * so the prompt stays inside the smallest free-tier token-per-minute
 * budget. Assumes messages are chronological; the last one must be the
 * new user message (enforced by the caller).
 */
export function sanitizeHistory(messages, { maxTurns = 6, maxChars = 4000 } = {}) {
  if (!Array.isArray(messages)) return [];
  const clean = [];
  for (const m of messages) {
    if (
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim().length > 0
    ) {
      clean.push({ role: m.role, content: m.content.trim() });
    }
  }
  const windowed = clean.slice(-maxTurns);
  // Enforce the character budget from the newest end backwards.
  let total = 0;
  const kept = [];
  for (let i = windowed.length - 1; i >= 0; i--) {
    total += windowed[i].content.length;
    if (total > maxChars && kept.length > 0) break;
    kept.unshift(windowed[i]);
  }
  return kept;
}

/**
 * Conservative output check. The model call is already constrained
 * (max_tokens ~350, temperature 0.2), so this only catches gross failures:
 * an empty answer, or an answer so long it cannot be a scoped reply.
 * Returns the answer to send, or null to substitute the no-info template.
 */
export function checkOutput(answer) {
  if (typeof answer !== "string") return null;
  const trimmed = answer.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 1600) return null;
  return trimmed;
}
