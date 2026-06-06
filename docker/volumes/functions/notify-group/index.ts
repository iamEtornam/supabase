// Supabase Edge Function: notify-group
//
// Fans out a single prayer-group event into per-recipient OneSignal push
// notifications. Called by the Flutter client after a group mutation succeeds.
//
// Required secrets (set via `supabase secrets set ...`):
//   - ONESIGNAL_APP_ID
//   - ONESIGNAL_REST_API_KEY
//   - SUPABASE_URL              (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//
// Request body schema:
// {
//   "groupId": number,
//   "eventType": "new_message" | "new_prayer_point" | "new_schedule"
//              | "join_request" | "join_approved" | "member_invited",
//   "actorUserId"?: number,   // app users.id of whoever triggered the event;
//                             // excluded from broadcast recipients.
//   "targetUserId"?: number,  // app users.id for events that target one user
//                             // (join_approved, member_invited).
//   "title"?: string,         // overrides default title
//   "body"?: string,          // overrides default body
//   "payload"?: Record<string, unknown> // forwarded as `data` to the device
// }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

type EventType =
  | "new_message"
  | "new_prayer_point"
  | "new_schedule"
  | "join_request"
  | "join_approved"
  | "member_invited";

interface NotifyBody {
  groupId: number;
  eventType: EventType;
  actorUserId?: number;
  targetUserId?: number;
  title?: string;
  body?: string;
  payload?: Record<string, unknown>;
}

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

// Each push event belongs to one preference category. Users opt out of
// pushes via `users.notification_prefs.<category> = false`; we filter
// recipients on that, and tag the inbox row with the category so the
// settings screen and the inbox stay aligned.
function categoryFor(eventType: EventType): string {
  switch (eventType) {
    case "new_message":
      return "group_messages";
    case "new_prayer_point":
      return "prayer_points";
    case "new_schedule":
      return "schedules";
    case "join_request":
      return "join_requests";
    case "join_approved":
    case "member_invited":
      return "member_invites";
  }
}

function defaultCopy(eventType: EventType, groupName: string): {
  title: string;
  body: string;
} {
  switch (eventType) {
    case "new_message":
      return { title: groupName, body: "New message in your group." };
    case "new_prayer_point":
      return { title: groupName, body: "A new prayer point was added." };
    case "new_schedule":
      return { title: groupName, body: "A new prayer time was scheduled." };
    case "join_request":
      return {
        title: groupName,
        body: "Someone requested to join your group.",
      };
    case "join_approved":
      return {
        title: groupName,
        body: "You were approved to join this group.",
      };
    case "member_invited":
      return { title: groupName, body: "You've been invited to a group." };
  }
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

  // Require the caller's JWT so anonymous callers can't spam push.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let payload: NotifyBody;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  if (!payload.groupId || !payload.eventType) {
    return jsonResponse({ error: "missing_required_fields" }, 400);
  }

  // Verify the caller against the JWT (binds actor to authenticated session).
  const authedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: authedUser, error: authedErr } = await authedClient.auth
    .getUser();
  if (authedErr || !authedUser?.user) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // Service client for cross-row reads, bypassing RLS deliberately.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Fetch group display name for default copy.
  const { data: group, error: groupErr } = await admin
    .from("prayer_groups")
    .select("id, name")
    .eq("id", payload.groupId)
    .maybeSingle();
  if (groupErr || !group) {
    return jsonResponse({ error: "group_not_found" }, 404);
  }

  // Compute recipient app-user IDs based on event type.
  let recipientAppUserIds: number[] = [];
  if (
    payload.eventType === "new_message" ||
    payload.eventType === "new_prayer_point" ||
    payload.eventType === "new_schedule"
  ) {
    const { data: members } = await admin
      .from("group_members")
      .select("user_id")
      .eq("group_id", payload.groupId)
      .eq("status", "joined");
    recipientAppUserIds = (members ?? [])
      .map((m: { user_id: number }) => m.user_id)
      .filter((id) => id !== payload.actorUserId);
  } else if (payload.eventType === "join_request") {
    const { data: admins } = await admin
      .from("group_members")
      .select("user_id")
      .eq("group_id", payload.groupId)
      .eq("status", "joined")
      .in("role", ["admin", "moderator"]);
    recipientAppUserIds = (admins ?? []).map((
      m: { user_id: number },
    ) => m.user_id);
  } else if (
    payload.eventType === "join_approved" ||
    payload.eventType === "member_invited"
  ) {
    if (!payload.targetUserId) {
      return jsonResponse({ error: "missing_target_user_id" }, 400);
    }
    recipientAppUserIds = [payload.targetUserId];
  } else {
    return jsonResponse({ error: "unknown_event_type" }, 400);
  }

  if (recipientAppUserIds.length === 0) {
    return jsonResponse({ ok: true, sent: 0 });
  }

  // Filter recipients by their notification_prefs: skip anyone who's
  // opted out of this category. Also fetch the external_user_id (used
  // for OneSignal) in the same query.
  const category = categoryFor(payload.eventType);
  const { data: recipientUsers } = await admin
    .from("users")
    .select("id, user_id, notification_prefs")
    .in("id", recipientAppUserIds);

  const wantsCategory = (row: { notification_prefs: unknown }) => {
    const prefs = row.notification_prefs;
    if (!prefs || typeof prefs !== "object") return true; // default opt-in
    const value = (prefs as Record<string, unknown>)[category];
    return value !== false; // missing key = opted in
  };

  const optedInRows = (recipientUsers ?? []).filter(wantsCategory);
  const optedInAppIds = optedInRows.map(
    (u: { id: number }) => u.id,
  );
  const externalUserIds = optedInRows
    .map((u: { user_id: string | null }) => u.user_id)
    .filter((v: unknown): v is string =>
      typeof v === "string" && v.length > 0
    );

  // Write inbox rows for every opted-in recipient, independent of the
  // OneSignal call. The inbox is the durable record; the OS push is the
  // best-effort alert. We use the service role client so RLS doesn't
  // block the insert.
  const copy = defaultCopy(payload.eventType, group.name);
  const title = payload.title ?? copy.title;
  const body = payload.body ?? copy.body;
  if (optedInAppIds.length > 0) {
    const inboxRows = optedInAppIds.map((uid: number) => ({
      user_id: uid,
      category,
      event_type: payload.eventType,
      title,
      body,
      route: "prayer-group-detail",
      path_params: { id: String(payload.groupId) },
      query_params: null,
      data: { groupId: payload.groupId, ...(payload.payload ?? {}) },
    }));
    const { error: inboxErr } = await admin
      .from("notifications")
      .insert(inboxRows);
    if (inboxErr) {
      console.error("inbox insert failed", inboxErr);
      // Best-effort: still attempt the OneSignal send.
    }
  }

  if (externalUserIds.length === 0) {
    return jsonResponse({
      ok: true,
      sent: 0,
      reason: "no_external_ids",
      inboxRows: optedInAppIds.length,
    });
  }

  const oneSignalPayload = {
    app_id: ONESIGNAL_APP_ID,
    include_external_user_ids: externalUserIds,
    channel_for_external_user_ids: "push",
    headings: { en: title },
    contents: { en: body },
    data: {
      eventType: payload.eventType,
      groupId: payload.groupId,
      category,
      route: "prayer-group-detail",
      // pathParams populates `:id` in /prayer-groups/:id. The legacy
      // `payload` key is kept so older app builds (which read
      // additional.payload into queryParameters) still navigate
      // somewhere sensible rather than dead-ending.
      pathParams: JSON.stringify({ id: String(payload.groupId) }),
      payload: JSON.stringify({ id: String(payload.groupId) }),
      ...(payload.payload ?? {}),
    },
  };

  const oneSignalRes = await fetch(
    "https://onesignal.com/api/v1/notifications",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify(oneSignalPayload),
    },
  );

  const oneSignalBody = await oneSignalRes.text();
  if (!oneSignalRes.ok) {
    return jsonResponse(
      {
        error: "onesignal_failed",
        status: oneSignalRes.status,
        body: oneSignalBody,
        inboxRows: optedInAppIds.length,
      },
      502,
    );
  }

  return jsonResponse({
    ok: true,
    sent: externalUserIds.length,
    inboxRows: optedInAppIds.length,
  });
});
