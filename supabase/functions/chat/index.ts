// QuantumCX — chat
//
// Proxies the site's chat widget to OpenRouter. The API key lives here as a
// secret and never reaches the browser: index.html is served from a PUBLIC
// GitHub Pages repo, so a key embedded there would be readable by anyone and
// drained within days.
//
// Deploy:  supabase functions deploy chat --no-verify-jwt
//
// Secrets (set these yourself, never paste them into chat):
//   supabase secrets set OPENROUTER_API_KEY="sk-or-v1-..."
//   supabase secrets set OPENROUTER_MODEL="model-a:free,model-b:free"   (optional)
//
// OPENROUTER_MODEL is a comma-separated FALLBACK CHAIN, tried in order. Free
// models are not a stable resource: one went paid under us with a 404 reading
// "This model is unavailable for free", and another answered 429 "temporarily
// rate-limited upstream" in the same minute. A single model id means the chat
// dies silently the day that happens, so we walk the list instead. It is a
// secret rather than a constant so the chain can change without a redeploy.

// Ordered by measured latency on a realistic prompt, not by size. The 120b
// answered well but took 26s, which nobody waits for on a website; the 30b
// nano answered as usefully in 1.1s. Big model last, as a safety net.
const DEFAULT_MODELS = [
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "openai/gpt-oss-20b:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

// Per-attempt cap. A model that is merely slow should cost us one step down the
// chain, not a visitor staring at typing dots.
const ATTEMPT_MS = 12_000;

const ALLOWED = ["quantumcx.net", "www.quantumcx.net", "localhost:8123", "127.0.0.1:8123"];

const RATE_MAX = 30;             // messages per window, per IP
const RATE_WINDOW_MS = 60_000;
const MAX_CHARS = 1500;          // per user message
const MAX_TURNS = 12;            // history kept, newest wins

/** In-memory and therefore per-instance — this trims abuse and runaway loops,
 *  it is not a hard security boundary. The Origin check is the real guard. */
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();      // crude bound on memory
  return list.length > RATE_MAX;
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  let host: string;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  return ALLOWED.includes(host);
}

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "content-type": "application/json" },
  });

/* Noor is the name the visitor sees. She is warm and brief, and she never
   claims to be a person: a human name is branding, but letting someone believe
   a human is reading their message — on a site that asks for phone numbers and
   business details — is not something we do. If asked directly, she says
   plainly that she is QuantumCX's assistant. */
const SYSTEM = `
You are Noor, who answers questions on the QuantumCX website.

ABOUT QUANTUMCX
QuantumCX builds AI-powered business systems and automation for small and
mid-sized businesses, with a focus on clinics and service businesses in Kuwait
and the UAE. The work covers: websites and landing pages; chatbots and WhatsApp
automation; n8n and Make workflow automation; CRM setup and integration; lead
capture and lead distribution; social media automation; custom AI agents and
voice agents; API and data integration; plus ongoing maintenance, scaling,
tracking and performance-based partnerships.

The flagship offer is fast, reliable lead capture and response: an enquiry is
stored the moment it is sent — before any notification is attempted, so a mail
failure can never lose it — and the business is notified immediately. Most
leads are won or lost in the first hour, and that is the problem QuantumCX
solves.

HOW YOU TALK
- Warm, direct, and short. Two or three sentences is usually plenty.
- British English. No corporate filler, no exclamation marks, no emoji.
- Never invent prices, timelines, client names, case studies or guarantees.
  If you do not know, say so and offer to pass the question on.
- If someone wants to start, or asks for a quote, a call, or pricing, point
  them to the contact form at the bottom of the page, or offer to take their
  name, email and what they need so the team can reply.
- Stay on QuantumCX and the visitor's business problem. If asked about
  something unrelated, say briefly that it is outside what you can help with
  and steer back.

WHAT YOU ARE
You are QuantumCX's assistant. Do not open with that, and do not describe
yourself as an AI unprompted — but if a visitor sincerely asks whether they are
talking to a real person, tell them plainly that you are not, and offer to put
them in touch with the team. Never claim to be human.
`.trim();

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, origin);

  if (!originAllowed(origin)) {
    return json({ error: "Not available from this origin." }, 403, origin);
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (rateLimited(ip)) {
    return json({ error: "You're sending messages very quickly — give it a moment." }, 429, origin);
  }

  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) {
    console.error("OPENROUTER_API_KEY is not set");
    return json({ error: "Chat isn't configured yet." }, 503, origin);
  }

  const body = await req.json().catch(() => ({}));
  const incoming = Array.isArray(body.messages) ? body.messages : [];

  // Trust nothing from the browser: rebuild the history ourselves, keep only
  // the two roles we expect, cap the length, and prepend our own system prompt
  // so it cannot be overridden by anything the page sent.
  const history = incoming
    .filter((m: { role?: string; content?: unknown }) =>
      (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_TURNS)
    .map((m: { role: string; content: string }) => ({
      role: m.role,
      content: m.content.slice(0, MAX_CHARS),
    }));

  if (!history.length || history[history.length - 1].role !== "user") {
    return json({ error: "Nothing to reply to." }, 400, origin);
  }

  const chain = (Deno.env.get("OPENROUTER_MODEL") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const models = chain.length ? chain : DEFAULT_MODELS;

  const payload = {
    messages: [{ role: "system", content: SYSTEM }, ...history],
    // Several free models are reasoning models, and their reasoning tokens are
    // charged against max_tokens before a single visible word is produced. At
    // 400 that truncated a real answer to "I don" — the reasoning had eaten the
    // budget. Give it room, and ask for the shallowest reasoning the model
    // supports (ignored by models that have none).
    max_tokens: 900,
    reasoning: { effort: "low" },
    temperature: 0.6,
  };

  let lastStatus = 0;
  for (const model of models) {
    let r: Response;
    try {
      r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${key}`,
          "content-type": "application/json",
          // OpenRouter uses these for attribution on the free tier.
          "HTTP-Referer": "https://www.quantumcx.net",
          "X-Title": "QuantumCX",
        },
        body: JSON.stringify({ model, ...payload }),
        signal: AbortSignal.timeout(ATTEMPT_MS),
      });
    } catch (e) {
      // Includes the timeout above — treat a stall exactly like a failure.
      console.error("openrouter fetch failed", model, e?.name ?? e);
      lastStatus = 0;
      continue;                       // blip or stall — next model
    }

    if (!r.ok) {
      lastStatus = r.status;
      const detail = await r.text().catch(() => "");
      console.error("openrouter error", model, r.status, detail.slice(0, 300));
      continue;                       // 404 gone paid, 429 rate-limited, 5xx — next
    }

    const data = await r.json().catch(() => null);
    const choice = data?.choices?.[0];
    const reply = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";

    if (!reply) {
      console.error("openrouter returned no content", model, choice?.finish_reason);
      continue;
    }
    // A stub cut off mid-sentence is worse than trying the next model. A long
    // answer that merely clipped its last line is still worth showing.
    if (choice?.finish_reason === "length" && reply.length < 200) {
      console.error("truncated reply, trying next model", model, JSON.stringify(reply).slice(0, 80));
      continue;
    }

    return json({ reply, model }, 200, origin);
  }

  console.error("every model in the chain failed", models.join(","));
  return json({
    error: lastStatus === 429
      ? "Busy right now — try again in a minute."
      : "Couldn't reach the assistant. Please try again.",
  }, 502, origin);
});
