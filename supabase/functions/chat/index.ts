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
//   supabase secrets set OPENROUTER_MODEL="deepseek/deepseek-chat-v3-0324:free"   (optional)
//
// The model is a secret rather than a constant on purpose: OpenRouter's free
// model line-up changes often, and swapping it should not need a redeploy.

const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324:free";

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

  const model = Deno.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL;

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
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM }, ...history],
        max_tokens: 400,
        temperature: 0.6,
      }),
    });
  } catch (e) {
    console.error("openrouter fetch failed", e);
    return json({ error: "Couldn't reach the assistant. Please try again." }, 502, origin);
  }

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("openrouter error", r.status, detail.slice(0, 500));
    // 429 from the free tier is the common one and deserves its own wording.
    const msg = r.status === 429
      ? "Busy right now — try again in a minute."
      : "Couldn't reach the assistant. Please try again.";
    return json({ error: msg }, 502, origin);
  }

  const data = await r.json().catch(() => null);
  const reply = data?.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) {
    console.error("openrouter returned no content", JSON.stringify(data)?.slice(0, 500));
    return json({ error: "Couldn't reach the assistant. Please try again." }, 502, origin);
  }

  return json({ reply: reply.trim() }, 200, origin);
});
