// QuantumCX Form Service — form-submit
//
// Called from a client's own website by the snippet that form-embed serves.
//
// Deploy:  supabase functions deploy form-submit --no-verify-jwt
//
// verify_jwt is false because this is called from an ordinary browser on a
// third-party page. The api_key in the body is public — it identifies a site,
// it authorises nothing. The real guard is the Origin check below.
//
// Secrets (set these yourself, never share them):
//   supabase secrets set SMTP_HOST="smtp.titan.email"
//   supabase secrets set SMTP_PORT="465"
//   supabase secrets set SMTP_USER="you@quantumcx.net"
//   supabase secrets set SMTP_PASS="<mailbox password>"
//   supabase secrets set SMTP_FROM="you@quantumcx.net"     (optional, defaults to SMTP_USER)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const RATE_WINDOW_SECONDS = 60;
const RATE_MAX = 5;

/** Compare an Origin header against a stored domain, ignoring scheme, port
 *  differences that matter (kept), leading www, and case. */
function originMatches(origin: string | null, domain: string): boolean {
  if (!origin) return false;                       // no Origin = not a browser form post
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();     // includes port when present
  } catch {
    return false;
  }
  const want = domain.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(host) === strip(want);
}

function cors(origin: string | null) {
  return {
    // Echo only the origin we have already validated against the row.
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

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium", timeStyle: "short", timeZone: tz,
    }).format(new Date(iso)) + ` (${tz})`;
  } catch {
    return new Date(iso).toUTCString();
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, origin);

  const body = await req.json().catch(() => ({}));
  const apiKey = String(body.api_key ?? "").trim();
  const honeypot = String(body.website ?? "").trim();

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1. Identify the site.
  const { data: site } = await db
    .from("client_sites")
    .select("id, clinic_name, domain, notify_email, timezone")
    .eq("api_key", apiKey)
    .eq("active", true)
    .maybeSingle();

  if (!site) return json({ error: "Unknown or inactive site key." }, 403, origin);

  // 2. Origin must match the row. This is what stops the public key being
  //    lifted out of the snippet and reused on another site.
  if (!originMatches(origin, site.domain)) {
    return json({ error: "Origin not allowed for this key." }, 403, origin);
  }

  // 3. Honeypot. Answer as if it worked and store nothing, so a bot cannot
  //    tell a rejection from a success and retry.
  if (honeypot) return json({ ok: true }, 200, origin);

  // 4. Rate limit per site.
  const since = new Date(Date.now() - RATE_WINDOW_SECONDS * 1000).toISOString();
  const { count } = await db
    .from("client_leads")
    .select("id", { count: "exact", head: true })
    .eq("site_id", site.id)
    .gte("created_at", since);

  if ((count ?? 0) >= RATE_MAX) {
    return json({ error: "Too many submissions. Please wait a moment." }, 429, origin);
  }

  const name = String(body.name ?? "").trim().slice(0, 120);
  const email = String(body.email ?? "").trim().slice(0, 200);
  const phone = String(body.phone ?? "").trim().slice(0, 40);
  const message = String(body.message ?? "").trim().slice(0, 5000);
  const sourceUrl = String(body.source_url ?? "").trim().slice(0, 500);

  // 5. INSERT BEFORE EMAIL. Non-negotiable: a mail failure must never lose an
  //    enquiry. notified_at staying null is the signal that a retry is owed.
  const { data: lead, error } = await db
    .from("client_leads")
    .insert({
      site_id: site.id,
      name: name || null,
      email: email || null,
      phone: phone || null,
      message: message || null,
      source_url: sourceUrl || null,
      user_agent: req.headers.get("user-agent"),
    })
    .select("id, created_at")
    .single();

  if (error) {
    console.error("client_leads insert failed", error);
    return json({ error: "Could not save. Please try again." }, 500, origin);
  }

  // 6. Notify. Titan SMTP only — SPF on quantumcx.net is -all, so any other
  //    sender fails SPF and is quarantined silently.
  const host = Deno.env.get("SMTP_HOST");
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  const port = Number(Deno.env.get("SMTP_PORT") ?? "465");
  const from = Deno.env.get("SMTP_FROM") ?? user;

  if (host && user && pass) {
    try {
      const when = fmtTime(lead.created_at, site.timezone || "UTC");
      const text = [
        `Name:    ${name || "not provided"}`,
        `Email:   ${email || "not provided"}`,
        `Phone:   ${phone || "not provided"}`,
        `Page:    ${sourceUrl || "not provided"}`,
        `Time:    ${when}`,
        ``,
        message || "(no message)",
        ``,
        `—`,
        `Delivered by QuantumCX. Reply directly to this email to reach them.`,
      ].join("\n")
        // CRLF, not bare LF. GoDaddy answers 552 "bare LF ... violating 822.bis
        // section 2.3" and drops the message. Normalise the whole body, not just
        // the joins: the enquirer's own message carries LF the moment they press
        // Enter in the textarea, so a client typing two paragraphs would fail.
        .replace(/\r\n|\r|\n/g, "\r\n");

      const client = new SMTPClient({
        connection: {
          hostname: host,
          port,
          tls: port === 465,        // 465 implicit TLS, 587 STARTTLS
          auth: { username: user, password: pass },
        },
      });

      await client.send({
        from: `QuantumCX <${from}>`,
        to: site.notify_email,
        replyTo: email || undefined,   // reply lands with the enquirer, not us
        subject: `New enquiry from your website — ${name || "no name given"}`,
        content: text,
      });
      await client.close();

      await db.from("client_leads")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", lead.id);
    } catch (e) {
      // Logged, not surfaced: the enquiry is already safe in the table.
      console.error("notify failed, notified_at left null", e);
    }
  } else {
    console.error("SMTP secrets missing — lead stored, notification skipped");
  }

  return json({ ok: true }, 200, origin);
});
