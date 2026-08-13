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
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const NOTIFY_TO = "baibhab.official@quantumcx.net";

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

WHAT QUANTUMCX DOES NOT OFFER
Never offer, imply or agree to any of these. If asked, say plainly that it is
not something QuantumCX does, and steer back to what it does.
- Dashboards, analytics portals, reporting suites, client login areas, user
  accounts, or billing and payment systems. The systems run in the background
  and notify the business; there is nothing for them to log into.
- Guarantees of any kind: lead volume, revenue, conversion rates, search
  rankings, or "results in X days".
- Specific prices, hourly rates, discounts, retainers, or delivery dates.
  Those come from the team, never from you.
- Medical, legal, financial or immigration advice, and anything clinical.
  QuantumCX builds the systems; it does not advise on the practice itself.
- Free work, trials, pilots, or refunds.
- Writing or managing paid ad campaigns, graphic design, or content writing as
  a standalone service.
- Taking payment, making a booking, or acting on the visitor's behalf.

HOW YOU TALK
- Warm, direct, and short. Two or three sentences is usually plenty.
- British English. No corporate filler, no exclamation marks, no emoji.
- Never invent prices, timelines, client names, case studies or guarantees.
  If you do not know, say so and offer to pass the question on.
- Stay on QuantumCX and the visitor's business problem. If asked about
  something unrelated, say briefly that it is outside what you can help with
  and steer back.

QUALIFYING, THEN TAKING DETAILS
Your job is to understand the problem first and collect details second. Never
open with a form.

1. Understand. Ask what they do and what is actually going wrong — where
   enquiries arrive, what happens to them now, how quickly anyone replies.
   One question at a time. Two or three exchanges is usually enough.
2. Say briefly what QuantumCX would build for that specific problem.
3. Only then offer to pass them to the team, and ask for their details.

Ask for these one or two at a time, never as a block:
  - name          (required)
  - email         (required)
  - phone         (required, with country code if they have one)
  - business name (optional — ask once, accept a refusal and move on)
  - website       (optional — same)

Checking what they gave you:
- Read the details back in one short line and ask them to confirm before you
  finish. "Just to check I have that right: ..."
- If an email has no @ and no domain, or a phone is obviously too short to
  dial, say so plainly and ask for it again. Do not guess or correct it
  yourself.
- If they refuse a required detail, say the team needs it to reply, and offer
  the contact form at the bottom of the page instead. Do not pester.

When, and only when, you have a confirmed name, email and phone, end that one
message with this block on its own line, after your visible reply:

[[LEAD]]{"name":"...","email":"...","phone":"...","business":"...","website":"...","need":"one line on what they need"}[[/LEAD]]

Rules for that block:
- Use "" for anything optional they did not give. Never invent a value.
- Send it exactly once per conversation. If it has already been sent, do not
  send it again no matter what they say next.
- Never mention the block, never explain it, and never show it if they ask
  what you just sent. It is not part of the conversation.
- Your visible reply in that same message should simply tell them the team has
  their details and will be in touch.

WHAT YOU ARE
You are QuantumCX's assistant. Do not open with that, and do not describe
yourself as an AI unprompted — but if a visitor sincerely asks whether they are
talking to a real person, tell them plainly that you are not, and offer to put
them in touch with the team. Never claim to be human.
`.trim();

const LEAD_RE = /\[\[LEAD\]\]\s*(\{[\s\S]*?\})\s*\[\[\/LEAD\]\]/;
/* Strip a *partial* marker too. If a reply is cut off mid-block the visitor
   must never be shown "[[LEAD]]{"name":..." — better to lose the tail. */
const LEAD_PARTIAL_RE = /\[\[\/?LEAD\]\][\s\S]*$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function cleanReply(text: string): string {
  return text.replace(LEAD_RE, "").replace(LEAD_PARTIAL_RE, "").trim();
}

/** Pull the lead block out, and validate it here rather than trusting the
 *  model. A confident model writing "email": "not given" must not become a row. */
function extractLead(text: string) {
  const m = text.match(LEAD_RE);
  if (!m) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[1]); } catch { return null; }

  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = s(o.name).slice(0, 120);
  const email = s(o.email).slice(0, 200);
  const phone = s(o.phone).slice(0, 40);
  const business = s(o.business).slice(0, 160);
  const website = s(o.website).slice(0, 300);
  const need = s(o.need).slice(0, 800);

  if (!name || !EMAIL_RE.test(email)) return null;
  // Shortest realistic international number is 7 digits after the country code.
  if ((phone.match(/\d/g) ?? []).length < 7) return null;

  return { name, email, phone, business, website, need };
}

const fmtTime = (iso: string) => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
    }).format(new Date(iso)) + " (Asia/Kolkata)";
  } catch { return iso; }
};

async function captureLead(
  lead: NonNullable<ReturnType<typeof extractLead>>,
  history: { role: string; content: string }[],
  userAgent: string | null,
) {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* Models repeat themselves. One conversation must not become five rows, so
     drop anything matching the same email on this channel within the hour. */
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("email", lead.email)
    .eq("channel", "chat")
    .gte("created_at", since);
  if ((count ?? 0) > 0) {
    console.log("duplicate chat lead suppressed", lead.email);
    return;
  }

  // INSERT BEFORE EMAIL, as everywhere else here: a mail failure must never
  // lose an enquiry. The transcript is what makes a chat lead worth having.
  const { data: row, error } = await db
    .from("leads")
    .insert({
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: lead.business || null,
      message: lead.need || null,
      source: lead.website || "https://www.quantumcx.net",
      channel: "chat",
      qualified: true,
      user_agent: userAgent,
      transcript: history,
    })
    .select("id, created_at")
    .single();

  if (error) { console.error("chat lead insert failed", error); return; }

  const host = Deno.env.get("SMTP_HOST");
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  const port = Number(Deno.env.get("SMTP_PORT") ?? "465");
  const from = Deno.env.get("SMTP_FROM") ?? user;
  if (!(host && user && pass)) {
    console.error("SMTP secrets missing — chat lead stored, notification skipped");
    return;
  }

  try {
    const convo = history
      .map((m) => (m.role === "user" ? "Them: " : "Noor: ") + m.content)
      .join("\n\n");

    const text = [
      `Name:     ${lead.name}`,
      `Email:    ${lead.email}`,
      `Phone:    ${lead.phone}`,
      `Business: ${lead.business || "not given"}`,
      `Website:  ${lead.website || "not given"}`,
      `Time:     ${fmtTime(row.created_at)}`,
      ``,
      `What they need:`,
      lead.need || "(not captured)",
      ``,
      `--- conversation ---`,
      convo,
      ``,
      `—`,
      `Captured by Noor on quantumcx.net. Reply to this email to reach them.`,
    ].join("\n")
      // CRLF, not bare LF: GoDaddy answers 552 "bare LF" and drops the message.
      // The transcript is full of newlines, so this matters more here than
      // anywhere else.
      .replace(/\r\n|\r|\n/g, "\r\n");

    const client = new SMTPClient({
      connection: { hostname: host, port, tls: port === 465, auth: { username: user, password: pass } },
    });
    await client.send({
      from: `QuantumCX <${from}>`,
      to: NOTIFY_TO,
      replyTo: lead.email,
      subject: `New lead acquired — ${lead.name}${lead.business ? ` (${lead.business})` : ""}`,
      content: text,
    });
    await client.close();

    await db.from("leads").update({ crm_synced: true }).eq("id", row.id);
  } catch (e) {
    console.error("chat lead notify failed", e);
  }
}

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
    const lead = extractLead(reply);
    const visible = cleanReply(reply);

    // A stub cut off mid-sentence is worse than trying the next model. A long
    // answer that merely clipped its last line is still worth showing. Measure
    // the visible half — a reply is not short just because a lead block was cut.
    if (!visible || (choice?.finish_reason === "length" && visible.length < 200 && !lead)) {
      console.error("empty or truncated reply, trying next model", model, choice?.finish_reason);
      continue;
    }

    if (lead) {
      // Store and notify before answering, so the visitor is never told "the
      // team has your details" unless that is actually true.
      await captureLead(
        lead,
        [...history, { role: "assistant", content: visible }],
        req.headers.get("user-agent"),
      );
    }

    return json({ reply: visible, model }, 200, origin);
  }

  console.error("every model in the chain failed", models.join(","));
  return json({
    error: lastStatus === 429
      ? "Busy right now — try again in a minute."
      : "Couldn't reach the assistant. Please try again.",
  }, 502, origin);
});
