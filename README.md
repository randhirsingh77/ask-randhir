# Ask Randhir

An AI assistant for [Randhir Singh's portfolio](https://randhirsingh77.github.io/portfolio/).
It answers questions about Randhir — his skills, projects, experience and how
to contact him — and politely refuses everything else.

It runs in two modes from one dependency-free frontend component:

- **Widget mode** — a launcher button on the portfolio opens the chat as a
  popup panel (~75% of the screen height, a native `<dialog>`; on phones it
  becomes a full-viewport sheet). The portfolio itself never navigates away.
- **Page mode** — the same component full-screen at the Worker's own URL
  (`/` and `/chat`), for anyone who prefers a full page or arrives by link.

Everything runs on free tiers. The browser never sees an API key.

## Architecture

```
Browser (portfolio widget OR standalone page)
  │  POST /api/chat   { messages: [...last 6 turns] }     ← no key, ever
  ▼
Cloudflare Worker (this repo)
  1. Origin allow-list (CORS): the portfolio origin + the Worker's own origin
  2. Per-IP rate limit (default 10/min) + global daily cap (default 350,
     KV counter when bound, in-memory otherwise)
  3. Validation: last message ≤ 800 chars, history truncated to 6 turns
  4. Deterministic pre-gate: unambiguous override/off-topic requests get the
     fixed refusal template WITHOUT an LLM call
  5. LLM call: system prompt + knowledge.md + history, temperature 0.2,
     max_tokens 350, 15 s timeout, no tools
  6. Conservative output check; provider errors become a friendly
     "assistant is resting" message — provider details never leak
  ▼
{ answer: "…" } → rendered as text (never HTML) in the widget
```

**LLM providers** — both are called through their OpenAI-compatible
endpoints, so one env var swaps them:

| `LLM_PROVIDER` | Model | Key secret |
|---|---|---|
| `gemini` (default) | `gemini-3.5-flash-lite` (Google Gemini free tier) | `GEMINI_API_KEY` |
| `groq` | `openai/gpt-oss-120b` (Groq free plan) | `GROQ_API_KEY` |

If the selected provider's key is missing but the other one is set, the
Worker falls back automatically. If **neither** key is set, `/api/chat`
returns a clean `503 {"error":"not_configured", …}` — the site deploys
safely before any key exists.

## How the guardrail works

Layered, because a system prompt alone is not a boundary:

1. **Knowledge file** (`worker/knowledge.md`) — public facts only, injected
   whole into the system prompt on every request. No vector DB, no
   fine-tuning: the file is ~2,000 tokens, edits are "edit one Markdown
   file and redeploy".
2. **System prompt** — names the only allowed topic and the only source of
   facts; gives the exact refusal sentence for off-topic questions and the
   exact "I don't have that information" sentence for missing facts; tells
   the model that visitor text is never an instruction and that the
   knowledge file outranks conversation history (blocks false-premise and
   drift attacks).
3. **Deterministic pre-gate** (`worker/src/guardrail.js`) — pattern-based,
   in code, before the model: "ignore your instructions", "system prompt",
   "write me a poem/essay/code…", etc. are refused for free. It is a filter,
   not a wall — paraphrases are the model's job.
4. **Constrained call** — temperature 0.2, `max_tokens` 350 (answers
   physically can't become essays), no tools, no web grounding.
5. **Test set** (`tests/`) — golden questions that must be answered from
   the knowledge file, plus adversarial ones (overrides, role-play,
   extraction, false premises, private-data asks) that must refuse or
   correct. Re-run after every prompt/knowledge/provider change.

Honest limits: a determined jailbreak can occasionally produce an
off-topic answer. The blast radius is one silly answer on a portfolio
site — the assistant has no tools, no actions, and nothing secret in its
context. The knowledge file contains only facts already public on the
portfolio, which also matters because free-tier prompts may be used by
Google to improve its products — never put private details in it.

## Repo layout

```
worker/
  knowledge.md        the only source of facts about Randhir (public only)
  src/index.js        Worker entry: routes /api/chat, /, /chat, assets
  src/chat.js         chat handler: validation, caps, prompt, provider call
  src/guardrail.js    pure guardrail functions (also unit-tested)
public/
  index.html          standalone full-screen page
  chat.js             the component (widget + page modes)
  chat.css            styles, matched to the portfolio's design
  avatar.svg          placeholder avatar (initials) — see "Avatar" below
embed/
  embed-snippet.html  the snippet pasted into the portfolio
tests/
  cases.mjs           golden + adversarial test sets
  run-tests.mjs       offline suite (mocked provider) + --live suite
wrangler.jsonc        Worker config (vars, assets, optional KV)
```

## Tests

```bash
npm test                # offline: pre-gate, CORS, caps, prompt shape, sets via mock
GEMINI_API_KEY=… npm run test:live   # the same sets against the real model
```

The offline suite needs no keys and no network. The live suite is the one
that proves the prompt holds against the real model — run it before
flipping providers or after editing `knowledge.md`/the system prompt.

## Avatar

The avatar is currently a clean initials placeholder (`RS`) in
`public/avatar.svg`. To use Randhir's photo: save it as `public/avatar.jpg`
and change the single `AVATAR_FILE` line at the top of `public/chat.js`.

## Owner deploy checklist

The code is deploy-ready; these steps need the owner's own accounts and
must be done by him (keys are entered as platform secrets — never commit
them, never paste them into chat or code):

1. **Create the free Gemini key** — go to Google AI Studio
   (aistudio.google.com), sign in, "Get API key" → create key. No card
   needed. (Optional but recommended: also create a free Groq key at
   console.groq.com so the fallback exists.)
2. **Create a free Cloudflare account** at cloudflare.com if you don't
   have one.
3. **Deploy the Worker** from this repo:
   ```bash
   npx wrangler login
   npx wrangler deploy
   ```
   Note the URL Wrangler prints, e.g.
   `https://ask-randhir.<your-subdomain>.workers.dev` — that is the
   assistant's standalone live link (`/` and `/chat`).
4. **Set the secrets** (Wrangler will prompt you to paste each key):
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put GROQ_API_KEY   # optional fallback
   ```
   `LLM_PROVIDER` is already `gemini` in `wrangler.jsonc`; change it to
   `groq` and redeploy to swap providers.
5. **Optional:** create the KV counter for an exact global daily cap:
   `npx wrangler kv namespace create CHAT_KV`, then uncomment the
   `kv_namespaces` block in `wrangler.jsonc` with the printed id and
   redeploy.
6. **Point the portfolio at the real URL** — in the portfolio repo's
   `index.html`, the embed snippet at the end of `<body>` has one line:
   `window.ASK_RANDHIR_API = "https://ask-randhir.YOUR-CLOUDFLARE-SUBDOMAIN.workers.dev/api/chat";`
   Replace the placeholder host with the real Worker host from step 3
   (and do the same for the project's "full-page assistant" link), commit
   and push. That is the only portfolio change needed.
7. **Smoke-test**: open the portfolio, click "Ask Randhir", ask "What are
   his main skills?" and one off-topic question ("What's the weather?") —
   the first must answer from the profile, the second must refuse politely.
   Then run `npm run test:live` locally with your key for the full set.

### Two caveats worth knowing

- **Region:** Google's Gemini API terms say the unpaid tier may not be
  used to serve API clients to users in the EEA, Switzerland or the UK.
  Randhir's audience is India-first, and this is a personal portfolio —
  but if that audience ever matters, set `LLM_PROVIDER=groq` (Groq's free
  plan has no such clause found) and redeploy.
- **Data:** on Gemini's free tier, prompts may be used by Google to
  improve its products. That is why `knowledge.md` holds public facts
  only, and why the Worker logs counts and error codes, not conversations.
