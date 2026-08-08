// QuantumCX Form Service — form-embed
//
// Serves the JavaScript the client pastes onto their site:
//   <script src="https://<project>.supabase.co/functions/v1/form-embed?k=KEY"></script>
//
// Deploy:  supabase functions deploy form-embed --no-verify-jwt
//
// The script renders a form where the tag sits, posts to form-submit, and
// confirms on the page. It inherits the host page's font and colour rather
// than imposing a look — this drops onto medical sites we do not control.

const js = (key: string, submitUrl: string) => `
(function () {
  "use strict";
  var KEY = ${JSON.stringify(key)};

  // Anchor to this very tag so the form appears exactly where it was pasted.
  var tag = document.currentScript;
  if (!tag) {
    var all = document.getElementsByTagName("script");
    tag = all[all.length - 1];
  }

  // Derive the endpoint from the origin that actually served this script.
  // Do NOT build it server-side from req.url: Supabase terminates TLS at the
  // edge, so inside the function req.url reports http://, and the browser
  // cannot reach that — it fails as "Failed to fetch" before any status.
  var URL_ = (function () {
    try {
      return new URL(tag.src).origin + "/functions/v1/form-submit";
    } catch (e) {
      return ${JSON.stringify(submitUrl)};
    }
  })();

  var wrap = document.createElement("div");
  wrap.className = "qcx-form";
  tag.parentNode.insertBefore(wrap, tag.nextSibling);

  var css = document.createElement("style");
  css.textContent = [
    ".qcx-form{font:inherit;color:inherit;max-width:34rem;margin:1rem 0}",
    ".qcx-form label{display:block;margin:0 0 .75rem}",
    ".qcx-form span.l{display:block;font-size:.9em;margin:0 0 .25rem;opacity:.85}",
    ".qcx-form .req{color:#c0392b;margin-left:.15em}",
    ".qcx-form input,.qcx-form textarea{",
      "width:100%;box-sizing:border-box;font:inherit;color:inherit;",
      "padding:.6em .7em;border:1px solid currentColor;border-radius:.35em;",
      "background:transparent;opacity:.95}",
    ".qcx-form textarea{min-height:6em;resize:vertical}",
    ".qcx-form button{font:inherit;cursor:pointer;padding:.65em 1.4em;",
      "border:0;border-radius:.35em;background:currentColor;}",
    ".qcx-form button span{filter:invert(1) grayscale(1) contrast(9)}",
    ".qcx-form button[disabled]{opacity:.6;cursor:default}",
    ".qcx-form .qcx-msg{margin:.75rem 0 0;font-size:.95em}",
    ".qcx-form .qcx-err{color:#c0392b}",
    ".qcx-form .qcx-hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}"
  ].join("");
  wrap.appendChild(css);

  function field(name, label, type, required) {
    var l = document.createElement("label");
    var s = document.createElement("span");
    s.className = "l";
    s.textContent = label;
    if (required) {
      var star = document.createElement("span");
      star.className = "req";
      star.textContent = "*";
      s.appendChild(star);
    }
    l.appendChild(s);
    var el = document.createElement(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") el.type = type;
    el.name = name;
    if (required) el.required = true;
    l.appendChild(el);
    return { label: l, input: el };
  }

  var form = document.createElement("form");
  form.noValidate = false;

  // Required fields carry a visible asterisk. Given this is sold to fix
  // broken forms, nothing may be required without saying so on screen.
  var fName = field("name", "Name", "text", true);
  var fMail = field("email", "Email", "email", true);
  var fPhone = field("phone", "Phone", "tel", false);
  var fMsg = field("message", "Message", "textarea", false);
  [fName, fMail, fPhone, fMsg].forEach(function (f) { form.appendChild(f.label); });

  var hp = document.createElement("input");
  hp.type = "text"; hp.name = "website"; hp.className = "qcx-hp";
  hp.tabIndex = -1; hp.setAttribute("autocomplete", "off");
  hp.setAttribute("aria-hidden", "true");
  form.appendChild(hp);

  var note = document.createElement("p");
  note.className = "qcx-msg";
  note.style.opacity = ".7";
  note.innerHTML = '<span class="req">*</span> required';
  form.appendChild(note);

  var btn = document.createElement("button");
  btn.type = "submit";
  var btnText = document.createElement("span");
  btnText.textContent = "Send";
  btn.appendChild(btnText);
  form.appendChild(btn);

  var out = document.createElement("p");
  out.className = "qcx-msg";
  out.setAttribute("role", "status");
  form.appendChild(out);

  wrap.appendChild(form);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (btn.disabled) return;
    out.textContent = "";
    out.className = "qcx-msg";

    btn.disabled = true;
    btnText.textContent = "Sending\\u2026";

    fetch(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: KEY,
        name: fName.input.value,
        email: fMail.input.value,
        phone: fPhone.input.value,
        message: fMsg.input.value,
        website: hp.value,
        source_url: location.href
      })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; })
          .then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (res) {
        if (!res.ok || !res.data.ok) {
          throw new Error(res.data && res.data.error ? res.data.error : "Something went wrong.");
        }
        // Replace the form with the confirmation.
        form.innerHTML = "";
        var done = document.createElement("p");
        done.className = "qcx-msg";
        done.textContent = "Thank you \\u2014 we've received your message and will be in touch.";
        form.appendChild(done);
      })
      .catch(function (err) {
        // Never fail silently, and never discard what they typed.
        btn.disabled = false;
        btnText.textContent = "Send";
        out.className = "qcx-msg qcx-err";
        var m = (err && err.message) ? String(err.message) : "Something went wrong";
        out.textContent = m.replace(/[.\\s]*$/, "") + ". Please try again, or email us directly.";
      });
  });
})();
`;

Deno.serve((req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("k") ?? "";
  // Fallback only — the script prefers its own tag.src at runtime. Force https
  // because req.url is http inside the runtime (TLS ends at the edge).
  const submitUrl = `${url.origin.replace(/^http:/, "https:")}/functions/v1/form-submit`;

  const headers = {
    "content-type": "application/javascript; charset=utf-8",
    // Short cache: a client re-pasting the snippet should not be stuck with a
    // stale script, but every page view should not re-fetch either.
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  };

  if (!key) {
    return new Response(
      `console.error("QuantumCX form: missing ?k= site key in the script tag.");`,
      { status: 200, headers },
    );
  }

  return new Response(js(key, submitUrl), { status: 200, headers });
});
