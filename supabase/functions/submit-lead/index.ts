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
//   supabase secrets set SALESFORCE_OID="<Setup > Company Information > Organization ID>"
//   supabase secrets set BOOKING_URL="<public booking page, e.g. a Cal.com link>"
//   supabase secrets set ALLOWED_ORIGIN="https://yourdomain.com"   (optional)
//   supabase secrets set SALESFORCE_DEBUG_EMAIL="you@quantumcx.net" (optional)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WEB_TO_LEAD = "https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8";

// Free-mail domains are the person, not an organisation
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "outlook.com",
  "hotmail.com", "live.com", "icloud.com", "proton.me", "protonmail.com",
  "aol.com", "rediffmail.com", "zoho.com",
]);

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

/** Salesforce requires Last Name; we collect one free-text name field. */
function splitName(full: string) {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "Unknown" };
  if (parts.length === 1) return { first: "", last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Salesforce also requires Company. Fall back rather than lose the lead. */
function companyFallback(email: string) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || FREEMAIL.has(domain)) return "Individual";
  return domain;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 120);
  const email = String(body.email ?? "").trim().slice(0, 200);
  const company = String(body.company ?? "").trim().slice(0, 120);
  const honeypot = String(body.website ?? "").trim();

  // Bots fill every field they find. Answer as if it worked, store nothing.
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
      source: "site-contact-bar",
      user_agent: req.headers.get("user-agent"),
    })
    .select("id")
    .single();

  if (error) {
    console.error("insert failed", error);
    return json({ error: "Could not save. Please try again." }, 500);
  }

  // Salesforce is best-effort: the lead is already safe in the table above, so
  // a CRM outage must not turn into a lost enquiry or a user-facing error.
  //
  // Caveat worth knowing: Web-to-Lead is fire-and-forget. It answers 200 with
  // an HTML body whether or not the Lead was actually created, so crm_synced
  // means "posted successfully", not "exists in Salesforce". Set
  // SALESFORCE_DEBUG_EMAIL while testing and Salesforce will email you the
  // parse result for each submission.
  const oid = Deno.env.get("SALESFORCE_OID");
  if (oid) {
    try {
      const { first, last } = splitName(name);
      const form = new URLSearchParams({
        oid,
        first_name: first,
        last_name: last,
        email,
        company: company || companyFallback(email),
        lead_source: "Web",
      });
      const debugTo = Deno.env.get("SALESFORCE_DEBUG_EMAIL");
      if (debugTo) { form.set("debug", "1"); form.set("debugEmail", debugTo); }

      const res = await fetch(WEB_TO_LEAD, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (res.ok) await db.from("leads").update({ crm_synced: true }).eq("id", lead.id);
      else console.error("web-to-lead rejected", res.status);
    } catch (e) {
      console.error("web-to-lead unreachable", e);
    }
  }

  // Absent until BOOKING_URL is set — the page handles that and simply
  // confirms instead of redirecting, so this ships before the calendar exists.
  return json({ ok: true, bookingUrl: Deno.env.get("BOOKING_URL") ?? null });
});
