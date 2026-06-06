import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

const env = await load();

const ONE_SIGNAL_API_URL = "https://onesignal.com/api/v1/notifications";
const ONE_SIGNAL_APP_ID = Deno.env.get("ONE_SIGNAL_APP_ID") ?? env['ONE_SIGNAL_APP_ID'];
const ONE_SIGNAL_API_KEY = Deno.env.get("ONE_SIGNAL_API_KEY") ?? env['ONE_SIGNAL_API_KEY'];

const supabaseClient = createClient(
  // Supabase API URL - env var exported by default.
  Deno.env.get("SUPABASE_URL")!,
  // Supabase API ANON KEY - env var exported by default.
  Deno.env.get("SUPABASE_ANON_KEY")!,
);

Deno.serve(async (req) => {
 try {
    const { message,custom_data } = await req.json();

    // Query for all user tokens
    const { data: tokens, error } = await supabaseClient
      .from('user_push_notification')
      .select('token');

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    const playerIds = tokens.map((token) => token.token);

    if (playerIds.length === 0) {
      return new Response(JSON.stringify({ error: 'No player IDs found' }), { status: 400 });
    }

    const response = await fetch(ONE_SIGNAL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${ONE_SIGNAL_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONE_SIGNAL_APP_ID,
        include_subscription_ids: playerIds,
        contents: { en: message },
        custom_data:custom_data
      }),
    });

    const result = await response.json();

    return new Response(JSON.stringify(result), { status: response.status });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});


/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/send-notification-to-all' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
