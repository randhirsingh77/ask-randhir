// Ask Randhir — Cloudflare Worker entry point.
//
// Routes:
//   POST /api/chat   the guarded chat endpoint (see chat.js)
//   GET  / and /chat the standalone full-screen chat page (static assets)
//   GET  /chat.js, /chat.css, /avatar.svg   the shared frontend component
//
// The LLM API keys live ONLY as Worker secrets:
//   wrangler secret put GEMINI_API_KEY
//   wrangler secret put GROQ_API_KEY
// They are never in this repo and never sent to a browser.

import { createChatHandler } from "./chat.js";
import knowledge from "../knowledge.md";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat") {
      // Bind the handler to this request's real environment (secrets, KV).
      const handler = createChatHandler({ env, knowledge });
      return handler(request);
    }

    if (url.pathname === "/" || url.pathname === "/chat") {
      // Serve the standalone page from the static assets.
      const pageUrl = new URL("/index.html", url.origin);
      return env.ASSETS.fetch(new Request(pageUrl, request));
    }

    // Everything else is a static asset (chat.js, chat.css, avatar.svg).
    return env.ASSETS.fetch(request);
  },
};
