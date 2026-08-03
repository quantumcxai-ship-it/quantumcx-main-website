// QuantumCX — lead capture
//
// The browser posts here and nowhere else. This function holds every secret,
// so nothing sensitive exists in the published page.
//
// Deploy:  supabase functions deploy submit-lead --no-verify-jwt
//
// --no-verify-jwt makes it callable from a public form. That is intentional —
// the alternative is shipping the anon key in the HTML, which is no more
// private and only adds noise.
//
// Secrets to set yourself (never share them):
//   supabase secrets set BOOKING_URL="<public booking page, e.g. a Cal.com link>"
//   supabase secrets set ALLOWED_ORIGIN="https://yourdomain.com"   (optional)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cors() {
  return {
    "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), "content-type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 120);
  const email = String(body.email ?? "").trim().slice(0, 200);
  const company = String(body.company ?? "").trim().slice(0, 120);
  const phone = String(body.phone ?? "").trim().slice(0, 40);
  const message = String(body.message ?? "").trim().slice(0, 2000);
  const honeypot = String(body.website ?? "").trim();

  // Bots fill every field they find. Answer 200 as if it worked and store
  // nothing, so a scraper cannot tell a rejection from a success and retry.
  // This is the only spam control on the endpoint: verify_jwt is false and
  // ALLOWED_ORIGIN sets CORS, which browsers honour and servers ignore.
  if (honeypot) return json({ ok: true });

  if (!EMAIL.test(email)) return json({ error: "Enter a valid email" }, 400);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: lead, error } = await db
    .from("leads")
    .insert({
      name,
      email,
      company: company || null,
      phone: phone || null,
      message: message || null,
      channel: "form",
      source: "site-contact-bar",
      user_agent: req.headers.get("user-agent"),
    })
    .select("id")
    .single();

  if (error) {
    console.error("insert failed", error);
    return json({ error: "Could not save. Please try again." }, 500);
  }

  // Salesforce Web-to-Lead removed 2026-08-03: the trial expires 2026-08-07,
  // after which every POST would fail, log noise on each lead, and leave
  // crm_synced permanently false. The column is kept — it is harmless and the
  // next CRM can reuse it.

  // Absent until BOOKING_URL is set — the page handles that and simply
  // confirms instead of redirecting, so this ships before the calendar exists.
  return json({ ok: true, bookingUrl: Deno.env.get("BOOKING_URL") ?? null });
});
