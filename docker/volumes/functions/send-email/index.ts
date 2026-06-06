// send-email: bridges GoTrue "Send Email" auth hook -> OneSignal email API.
// Verifies the standardwebhooks signature (HMAC-SHA256) manually (no remote deps).
const APP_ID = Deno.env.get("ONESIGNAL_APP_ID") ?? "";
const API_KEY = Deno.env.get("ONESIGNAL_API_KEY") ?? "";
const SECRET_B64 = (Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "").replace(/^v1,whsec_/, "");
const SITE = "https://supabase.prayerpartner.site";
const FROM_NAME = "Prayer Partner App";
const FROM_ADDR = "hello@prayerpartner.site";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function abToB64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
async function verifySig(id: string, ts: string, body: string, sigHeader: string): Promise<boolean> {
  if (!id || !ts || !sigHeader || !SECRET_B64) return false;
  const now = Math.floor(Date.now() / 1000);
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(now - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", b64ToBytes(SECRET_B64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const expected = abToB64(mac);
  for (const part of sigHeader.split(" ")) {
    const sig = part.split(",")[1];
    if (sig && sig === expected) return true;
  }
  return false;
}

const SUBJECTS: Record<string, string> = {
  signup: "Confirm your email",
  magiclink: "Your sign-in link",
  recovery: "Reset your password",
  invite: "You've been invited to Prayer Partner",
  email_change: "Confirm your new email",
  email_change_current: "Confirm your email change",
  reauthentication: "Your verification code",
};

Deno.serve(async (req) => {
  const body = await req.text();
  const h = req.headers;
  const ok = await verifySig(h.get("webhook-id") ?? "", h.get("webhook-timestamp") ?? "", body, h.get("webhook-signature") ?? "");
  if (!ok) {
    console.error("send-email: signature verification failed");
    return new Response(JSON.stringify({ error: { http_code: 401, message: "invalid signature" } }), { status: 401, headers: { "content-type": "application/json" } });
  }
  let data: any;
  try { data = JSON.parse(body); } catch { return new Response(JSON.stringify({ error: { http_code: 400, message: "bad json" } }), { status: 400, headers: { "content-type": "application/json" } }); }

  const user = data.user ?? {};
  const ed = data.email_data ?? {};
  const type: string = ed.email_action_type ?? "";
  const recipient: string = user.email ?? ed.new_email ?? "";
  const subject = SUBJECTS[type] ?? "Prayer Partner notification";
  const link = `${SITE}/auth/v1/verify?token=${encodeURIComponent(ed.token_hash ?? "")}&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(ed.redirect_to || SITE)}`;

  let htmlBody: string;
  if (type === "reauthentication") {
    htmlBody = `<div style="font-family:sans-serif;max-width:480px;margin:auto"><h2 style="color:#5b51d8">Prayer Partner</h2><p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:3px">${ed.token ?? ""}</p></div>`;
  } else {
    htmlBody = `<div style="font-family:sans-serif;max-width:480px;margin:auto">
  <h2 style="color:#5b51d8">Prayer Partner</h2>
  <p>Tap the button below to ${subject.toLowerCase()}.</p>
  <p><a href="${link}" style="display:inline-block;padding:12px 22px;background:#5b51d8;color:#fff;text-decoration:none;border-radius:8px">${subject}</a></p>
  <p style="font-size:12px;color:#666">Or paste this link into your browser:<br>${link}</p>
  <p style="font-size:12px;color:#999">If you didn't request this, you can safely ignore this email.</p>
</div>`;
  }

  if (!recipient) {
    return new Response(JSON.stringify({ error: { http_code: 400, message: "no recipient email in payload" } }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const osRes = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Key ${API_KEY}` },
    body: JSON.stringify({
      app_id: APP_ID,
      target_channel: "email",
      include_email_tokens: [recipient],
      email_subject: subject,
      email_body: htmlBody,
      email_from_name: FROM_NAME,
      email_from_address: FROM_ADDR,
    }),
  });
  const osText = await osRes.text();
  console.log(`send-email type=${type} to=${recipient} onesignal_status=${osRes.status} resp=${osText}`);

  if (!osRes.ok) {
    return new Response(JSON.stringify({ error: { http_code: 500, message: `onesignal ${osRes.status}: ${osText}` } }), { status: 500, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
});
