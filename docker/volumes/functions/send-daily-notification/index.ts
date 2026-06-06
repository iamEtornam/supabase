// Supabase Edge Function: send-daily-notification
//
// Sends the morning / afternoon / evening prayer push to subscribers
// whose local time currently matches that slot's hour. Triggered by a
// pg_cron job that hits this function once per hour. The function
// itself decides which slot(s) are active for the current UTC hour
// across all stored timezones.
//
// IMPORTANT: the previous implementation registered cron jobs in the
// edge function isolate via `croner`, which never fires reliably —
// edge isolates are torn down between invocations. That approach has
// been replaced with pg_cron + pg_net (see the matching migration).
//
// Required secrets:
//   - ONESIGNAL_APP_ID         (or ONE_SIGNAL_APP_ID)
//   - ONESIGNAL_REST_API_KEY   (or ONE_SIGNAL_API_KEY)
//   - DAILY_CRON_SECRET        shared secret between pg_cron and this
//                              function; rejects unauthenticated callers.
//   - SUPABASE_URL             (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY(auto-injected)
//
// Request body (POST):
// {
//   "slot"?: "morning" | "afternoon" | "evening"   // optional override
// }
// If `slot` is omitted, the function dispatches every slot whose local
// hour matches the current hour for any user; in practice the cron
// passes an explicit slot per call.
//
// Auth: must include `X-Cron-Secret: <DAILY_CRON_SECRET>`.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

type Slot = "morning" | "afternoon" | "evening";

// Slot → local hour (24h) + copy. The minute granularity is hour-only
// since the cron fires hourly; if you need :15 precision, shift the
// cron and add a minute-of-hour check here.
const SLOT_CONFIG: Record<Slot, { hour: number; title: string; body: string }> =
  {
    morning: {
      hour: 7,
      title: "Prayer Partner",
      body: "Rise and shine. Your morning devotion is ready.",
    },
    afternoon: {
      hour: 12,
      title: "Prayer Partner",
      body: "Good afternoon. Take some time to pray.",
    },
    evening: {
      hour: 20,
      title: "Prayer Partner",
      body:
        "Your evening prayer is ready. Take some time to study the word of God.",
    },
  };

const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID") ??
  Deno.env.get("ONE_SIGNAL_APP_ID");
const ONESIGNAL_REST_API_KEY = Deno.env.get("ONESIGNAL_REST_API_KEY") ??
  Deno.env.get("ONE_SIGNAL_API_KEY");
const DAILY_CRON_SECRET = Deno.env.get("DAILY_CRON_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendOneSignal(
  externalUserIds: string[],
  title: string,
  body: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    "https://onesignal.com/api/v1/notifications",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_external_user_ids: externalUserIds,
        channel_for_external_user_ids: "push",
        headings: { en: title },
        contents: { en: body },
      }),
    },
  );
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (
    !ONESIGNAL_APP_ID ||
    !ONESIGNAL_REST_API_KEY ||
    !DAILY_CRON_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return jsonResponse({ error: "missing_server_config" }, 500);
  }

  // Cron secret check. We accept it in either the dedicated header
  // (preferred for pg_net calls) or the Authorization bearer header
  // (handy for manual curl).
  const incomingSecret = req.headers.get("X-Cron-Secret") ??
    (req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (incomingSecret !== DAILY_CRON_SECRET) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: { slot?: Slot } = {};
  try {
    if (req.headers.get("Content-Length") !== "0") {
      body = await req.json();
    }
  } catch {
    body = {};
  }

  const slots: Slot[] = body.slot
    ? [body.slot]
    : ["morning", "afternoon", "evening"];
  for (const s of slots) {
    if (!(s in SLOT_CONFIG)) {
      return jsonResponse({ error: "unknown_slot", slot: s }, 400);
    }
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // For each requested slot, find users whose current local hour matches
  // the slot's hour. We rely on `extract(hour from (now() at time zone
  // users.timezone))` evaluated inside Postgres so the timezone math is
  // authoritative. Invalid IANA names fall back to UTC at the DB layer
  // via the `try_at_timezone` wrapper.
  const summary: Array<
    {
      slot: Slot;
      recipientCount: number;
      sent: boolean;
      oneSignalStatus?: number;
      inboxRows?: number;
    }
  > = [];

  for (const slot of slots) {
    const { hour, title, body: pushBody } = SLOT_CONFIG[slot];

    // RPC returns one row per user whose local hour == `hour` and who
    // hasn't opted out of `daily_verse`. Each row has both the int
    // app_user_id (for the inbox insert) and the text user_id (the
    // OneSignal external_user_id).
    const { data: recipients, error } = await admin.rpc(
      "users_in_local_hour",
      { p_hour: hour },
    );
    if (error) {
      console.error("users_in_local_hour failed", error);
      summary.push({ slot, recipientCount: 0, sent: false });
      continue;
    }

    const rows = (recipients ?? []) as Array<
      { app_user_id: number; user_id: string | null }
    >;
    const externalUserIds = rows
      .map((r) => r.user_id)
      .filter((v: unknown): v is string =>
        typeof v === "string" && v.length > 0
      );
    const appUserIds = rows
      .map((r) => r.app_user_id)
      .filter((v: unknown): v is number => typeof v === "number");

    // Write inbox rows for every opted-in recipient. Independent of
    // the OneSignal call so the inbox stays the durable record.
    let inboxWritten = 0;
    if (appUserIds.length > 0) {
      const inboxRows = appUserIds.map((uid) => ({
        user_id: uid,
        category: "daily_verse",
        event_type: `daily_verse_${slot}`,
        title,
        body: pushBody,
        route: null,
        path_params: null,
        query_params: null,
        data: { slot },
      }));
      const { error: inboxErr } = await admin
        .from("notifications")
        .insert(inboxRows);
      if (inboxErr) {
        console.error("inbox insert failed", inboxErr);
      } else {
        inboxWritten = inboxRows.length;
      }
    }

    if (externalUserIds.length === 0) {
      summary.push({
        slot,
        recipientCount: 0,
        sent: false,
        inboxRows: inboxWritten,
      });
      continue;
    }

    const res = await sendOneSignal(externalUserIds, title, pushBody);
    if (!res.ok) {
      console.error("OneSignal failed", res.status, res.body);
    }
    summary.push({
      slot,
      recipientCount: externalUserIds.length,
      sent: res.ok,
      oneSignalStatus: res.status,
      inboxRows: inboxWritten,
    });
  }

  return jsonResponse({ ok: true, summary });
});
