// Supabase Edge Function: notify-schedule
//
// Schedules (or cancels) timed OneSignal pushes for a prayer schedule.
// Two pushes per schedule:
//   * lead reminder, 15 minutes before start_time
//   * start notification, at start_time
//
// On schedule, the function:
//   1. Validates the caller is a joined member of the group.
//   2. Resolves the schedule + every member's external_user_id.
//   3. POSTs to OneSignal twice with `send_after`, capturing each id.
//   4. Writes the returned ids back to prayer_schedules so a later
//      cancel can target them.
//
// On cancel, the function:
//   1. Loads the row, calls OneSignal DELETE for each non-null id.
//   2. Clears the columns.
//
// Required secrets (set via `supabase secrets set ...`). Both naming
// conventions are accepted so this function works alongside both the
// newer `notify-group` (ONESIGNAL_*) and the legacy
// `send-notification-*` (ONE_SIGNAL_*) functions:
//   - ONESIGNAL_APP_ID         (or ONE_SIGNAL_APP_ID)
//   - ONESIGNAL_REST_API_KEY   (or ONE_SIGNAL_API_KEY)
//   - SUPABASE_URL             (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY(auto-injected)
//
// Request body schema:
// {
//   "action": "schedule" | "cancel",
//   "scheduleId": number,
//   "leadMinutes"?: number       // default 15
// }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

interface RequestBody {
  action: "schedule" | "cancel";
  scheduleId: number;
  leadMinutes?: number;
}

// Prefer the newer naming used by notify-group; fall back to the
// underscore-style names used by the older send-notification-* family.
const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID") ??
  Deno.env.get("ONE_SIGNAL_APP_ID");
const ONESIGNAL_REST_API_KEY = Deno.env.get("ONESIGNAL_REST_API_KEY") ??
  Deno.env.get("ONE_SIGNAL_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface OneSignalSchedulePayload {
  groupId: number;
  groupName: string;
  scheduleId: number;
  scheduleTitle: string;
  recipients: string[]; // OneSignal external_user_ids
  sendAfter: string;    // ISO timestamp
  kind: "lead" | "start";
  leadMinutes: number;
}

async function scheduleOneSignal(p: OneSignalSchedulePayload): Promise<string | null> {
  const body = {
    app_id: ONESIGNAL_APP_ID,
    include_external_user_ids: p.recipients,
    channel_for_external_user_ids: "push",
    headings: { en: p.groupName },
    contents: {
      en: p.kind === "lead"
        ? `${p.scheduleTitle} starts in ${p.leadMinutes} minutes`
        : `${p.scheduleTitle} is starting now`,
    },
    send_after: p.sendAfter,
    data: {
      eventType: p.kind === "lead"
        ? "schedule_reminder"
        : "schedule_start",
      route: "prayer-group-detail",
      pathParams: JSON.stringify({ id: String(p.groupId) }),
      queryParams: JSON.stringify({ tab: "schedules" }),
      scheduleId: p.scheduleId,
      groupId: p.groupId,
    },
  };

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("OneSignal schedule failed", res.status, text);
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

async function cancelOneSignal(notificationId: string): Promise<boolean> {
  if (!notificationId) return true;
  const url =
    `https://onesignal.com/api/v1/notifications/${notificationId}?app_id=${ONESIGNAL_APP_ID}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`,
    },
  });
  // OneSignal returns 200 or 404 when the notification has already been
  // delivered/expired; treat 404 as success since the goal is "no longer
  // queued."
  return res.ok || res.status === 404;
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
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return jsonResponse({ error: "missing_server_config" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  if (!body.scheduleId || !body.action) {
    return jsonResponse({ error: "missing_required_fields" }, 400);
  }

  const authedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: authedUser, error: authedErr } = await authedClient.auth
    .getUser();
  if (authedErr || !authedUser?.user) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Resolve the schedule, its group, and confirm the caller is a joined
  // member of that group (defense in depth — RLS also protects the
  // underlying SELECT/UPDATE).
  const { data: schedule, error: scheduleErr } = await admin
    .from("prayer_schedules")
    .select(
      "id, group_id, title, start_time, lead_notification_id, start_notification_id",
    )
    .eq("id", body.scheduleId)
    .maybeSingle();
  if (scheduleErr || !schedule) {
    return jsonResponse({ error: "schedule_not_found" }, 404);
  }

  const { data: callerAppUser } = await admin
    .from("users")
    .select("id")
    .eq("user_id", authedUser.user.id)
    .maybeSingle();
  if (!callerAppUser) {
    return jsonResponse({ error: "caller_not_found" }, 403);
  }

  const { data: membership } = await admin
    .from("group_members")
    .select("user_id, status")
    .eq("group_id", schedule.group_id)
    .eq("user_id", callerAppUser.id)
    .eq("status", "joined")
    .maybeSingle();
  if (!membership) {
    return jsonResponse({ error: "not_a_member" }, 403);
  }

  if (body.action === "cancel") {
    const ids = [
      schedule.lead_notification_id,
      schedule.start_notification_id,
    ].filter((v: unknown): v is string => typeof v === "string" && v.length > 0);

    const results = await Promise.all(ids.map(cancelOneSignal));
    await admin
      .from("prayer_schedules")
      .update({ lead_notification_id: null, start_notification_id: null })
      .eq("id", schedule.id);
    return jsonResponse({
      ok: true,
      cancelled: results.filter(Boolean).length,
    });
  }

  // action === "schedule"
  // Cancel previous ids (if any) before rescheduling so reschedules
  // don't double-deliver.
  const previous = [
    schedule.lead_notification_id,
    schedule.start_notification_id,
  ].filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
  if (previous.length > 0) {
    await Promise.all(previous.map(cancelOneSignal));
  }

  const { data: group } = await admin
    .from("prayer_groups")
    .select("id, name")
    .eq("id", schedule.group_id)
    .maybeSingle();
  if (!group) {
    return jsonResponse({ error: "group_not_found" }, 404);
  }

  const { data: members } = await admin
    .from("group_members")
    .select("user_id")
    .eq("group_id", schedule.group_id)
    .eq("status", "joined");
  const recipientAppUserIds = (members ?? []).map((
    m: { user_id: number },
  ) => m.user_id);
  if (recipientAppUserIds.length === 0) {
    return jsonResponse({ ok: true, sent: 0, reason: "no_members" });
  }

  // Pull user identities + their notification_prefs so we can skip
  // anyone who's opted out of schedule reminders. Captured at
  // scheduling time — if a user opts out later, they'll still receive
  // any pushes already queued in OneSignal until the next reschedule.
  const { data: users } = await admin
    .from("users")
    .select("id, user_id, notification_prefs")
    .in("id", recipientAppUserIds);
  const optedIn = (users ?? []).filter(
    (u: { notification_prefs: unknown }) => {
      const prefs = u.notification_prefs;
      if (!prefs || typeof prefs !== "object") return true;
      const v = (prefs as Record<string, unknown>)["schedules"];
      return v !== false;
    },
  );
  const externalUserIds = optedIn
    .map((u: { user_id: string | null }) => u.user_id)
    .filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
  if (externalUserIds.length === 0) {
    return jsonResponse({ ok: true, sent: 0, reason: "no_external_ids" });
  }

  const leadMinutes = body.leadMinutes ?? 15;
  const startMs = new Date(schedule.start_time).getTime();
  const leadMs = startMs - leadMinutes * 60 * 1000;
  const nowMs = Date.now();

  // Only schedule a push if its target time is in the future. A schedule
  // created within the lead window still gets the at-start push; a
  // schedule created in the past is rejected.
  const promises: Array<Promise<string | null>> = [];
  let leadIndex = -1;
  let startIndex = -1;
  if (leadMs > nowMs) {
    leadIndex = promises.length;
    promises.push(scheduleOneSignal({
      groupId: schedule.group_id,
      groupName: group.name,
      scheduleId: schedule.id,
      scheduleTitle: schedule.title,
      recipients: externalUserIds,
      sendAfter: new Date(leadMs).toISOString(),
      kind: "lead",
      leadMinutes,
    }));
  }
  if (startMs > nowMs) {
    startIndex = promises.length;
    promises.push(scheduleOneSignal({
      groupId: schedule.group_id,
      groupName: group.name,
      scheduleId: schedule.id,
      scheduleTitle: schedule.title,
      recipients: externalUserIds,
      sendAfter: new Date(startMs).toISOString(),
      kind: "start",
      leadMinutes,
    }));
  }
  if (promises.length === 0) {
    return jsonResponse({ ok: true, sent: 0, reason: "in_past" });
  }

  const results = await Promise.all(promises);
  const leadId = leadIndex >= 0 ? results[leadIndex] : null;
  const startId = startIndex >= 0 ? results[startIndex] : null;

  await admin
    .from("prayer_schedules")
    .update({
      lead_notification_id: leadId,
      start_notification_id: startId,
    })
    .eq("id", schedule.id);

  return jsonResponse({
    ok: true,
    leadNotificationId: leadId,
    startNotificationId: startId,
  });
});
