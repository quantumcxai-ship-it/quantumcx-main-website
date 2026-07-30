# QuantumCX

Marketing site for QuantumCX — AI-powered business systems & automation.

A single-page WebGL scroll film that loops: four acts of copy over a pinned 3D
scene, played twice (brand pass, then services pass), so scrolling down forever
returns you to the hero.

## Layout

```
index.html            the entire site — markup, styles, and scene, no build step
assets/               fonts, light maps, and the point clouds the scene loads
supabase/
  functions/
    submit-lead/      Edge Function behind the contact form
  migrations/         the leads table
```

## Running it

There is no build. Serve the folder over HTTP — `file://` will not work, because
the page uses ES modules.

```bash
python -m http.server 8123
```

Then open http://127.0.0.1:8123.

Three.js and Lenis load from a CDN via an import map; everything else is local.

## Lead capture

The page posts to the `submit-lead` Edge Function and nowhere else. That function
holds every secret, so nothing sensitive exists in the published page. It stores
the lead in Supabase, forwards it to Salesforce, and returns the booking URL,
which the page uses to redirect to Cal.com with the name and email prefilled.

Secrets live in Supabase and are set from the CLI, never committed:

```bash
supabase secrets set SALESFORCE_OID="..."
supabase secrets set BOOKING_URL="..."
supabase secrets set ALLOWED_ORIGIN="https://yourdomain.com"
```

Deploy the function with:

```bash
supabase functions deploy submit-lead --no-verify-jwt
```

`--no-verify-jwt` is intentional — it makes the function callable from a public
form. The `leads` table has row-level security on with no policies, so the public
anon key cannot read or write it.
