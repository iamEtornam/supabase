// This example shows how to use Edge Functions to read incoming multipart/form-data request,
// and write files to Supabase Storage and other fields to a database table.

import { Application } from "https://deno.land/x/oak@v11.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const MB = 1024 * 1024;

const app = new Application();

const supabaseClient = createClient(
  // Supabase API URL - env var exported by default.
  Deno.env.get("SUPABASE_URL")!,
  // Supabase API ANON KEY - env var exported by default.
  Deno.env.get("SUPABASE_ANON_KEY")!,
);

app.use(async (ctx) => {
  const body = ctx.request.body({ type: "form-data" });
  const formData = await body.value.read({
    // Need to set the maxSize so files will be stored in memory.
    // This is necessary as Edge Functions don't have disk write access.
    // We are setting the max size as 10MB (an Edge Function has a max memory limit of 150MB)
    // For more config options, check: https://deno.land/x/oak@v11.1.0/mod.ts?s=FormDataReadOptions
    maxSize: 100 * MB,
  });
  if (!formData.files || !formData.files.length) {
    ctx.response.status = 400;
    ctx.response.body = "missing file";
    return;
  }

  //upload image to Storage
  const file = formData.files[0];
  const bucketName = formData.fields!.bucket_name;
  const timestamp = +new Date();
  const uploadName = `${file.name}-${timestamp}`;
  const { data: upload, error: uploadError } = await supabaseClient.storage
    .from(bucketName)
    .upload(uploadName, file.content!.buffer, {
      contentType: file.contentType,
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadError) {
    console.error(uploadError);
    ctx.response.status = 500;
    ctx.response.body = uploadError;
    return;
  }

  // // insert record to messages table
  // const { error } = await supabaseClient.from('comments').insert({
  //   message: formData.fields!.message || '',
  //   image_path: upload.path,
  // })
  // if (error) {
  //   console.error(error)
  //   ctx.response.status = 500
  //   ctx.response.body = 'Fail to add the record'
  //   return
  // }

  ctx.response.status = 200;
  ctx.response.body = upload.path;
});

await app.listen({ port: 8000 });

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/media-file-upload' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
