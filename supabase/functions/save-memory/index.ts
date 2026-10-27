// Supabase Edge Function (Deno runtime — not part of the Node.js build,
// not imported by src/**, deployed separately via `supabase functions
// deploy save-memory`).
//
// Replaces a direct `supabase.from("memories").insert(...)` for memory
// saves with a rate-limited path: the anon key alone can't enforce "max
// N saves per device" since a client could just omit that logic, so this
// runs with the service role key instead and enforces it server-side.
//
// Not wired into src/storage.ts yet — see USE_EDGE_FUNCTION there. This
// file is the infrastructure; cmdSave/cmdFix/etc. still insert directly
// until that flag flips.
//
// Schema this depends on (run manually in the Supabase SQL editor):
//
// CREATE TABLE IF NOT EXISTS rate_limits (
//   device_id text NOT NULL,
//   window_start timestamptz NOT NULL,
//   window_type text NOT NULL, -- 'hour' or 'day'
//   count integer DEFAULT 0,
//   PRIMARY KEY (device_id, window_start, window_type)
// );
//
// rate_limits is only ever touched by this function using the service
// role key, which bypasses RLS entirely — but per Supabase convention,
// consider also running (not included above since it's not part of what
// was asked for, just a defense-in-depth suggestion):
//   ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
// with no policies, so a direct anon/authenticated PostgREST request
// against this table is denied regardless of this function's own access.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_SAVES_PER_HOUR = 100;
const MAX_SAVES_PER_DAY = 1000;
const MAX_MEMORIES_PER_PROJECT = 500;

type WindowType = "hour" | "day";

interface SaveMemoryBody {
  project?: string;
  type?: string;
  content?: string;
  [key: string]: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function startOfHour(date: Date): string {
  const truncated = new Date(date);
  truncated.setUTCMinutes(0, 0, 0);
  return truncated.toISOString();
}

function startOfDay(date: Date): string {
  const truncated = new Date(date);
  truncated.setUTCHours(0, 0, 0, 0);
  return truncated.toISOString();
}

// Reads the current count for this device/window, and — only if under
// the limit — increments it. Returns the limit-check result; the caller
// decides what to do (block with 429, or proceed to the next check).
async function checkAndIncrementRateLimit(
  supabase: ReturnType<typeof createClient>,
  deviceId: string,
  windowType: WindowType,
  windowStart: string,
  max: number
): Promise<{ ok: boolean; count: number }> {
  const { data: existing, error: selectError } = await supabase
    .from("rate_limits")
    .select("count")
    .eq("device_id", deviceId)
    .eq("window_start", windowStart)
    .eq("window_type", windowType)
    .maybeSingle();

  if (selectError) throw new Error(`rate_limits select failed: ${selectError.message}`);

  const currentCount: number = existing?.count ?? 0;
  if (currentCount >= max) {
    return { ok: false, count: currentCount };
  }

  const { error: upsertError } = await supabase.from("rate_limits").upsert(
    {
      device_id: deviceId,
      window_start: windowStart,
      window_type: windowType,
      count: currentCount + 1,
    },
    { onConflict: "device_id,window_start,window_type" }
  );

  if (upsertError) throw new Error(`rate_limits upsert failed: ${upsertError.message}`);

  return { ok: true, count: currentCount + 1 };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const deviceId = req.headers.get("x-device-id");
  if (!deviceId) {
    return jsonResponse({ error: "Missing x-device-id header" }, 400);
  }

  let body: SaveMemoryBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { project, type, content } = body;
  if (!project || !type || !content) {
    return jsonResponse({ error: "project, type, and content are required" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();

  try {
    const hourCheck = await checkAndIncrementRateLimit(
      supabase,
      deviceId,
      "hour",
      startOfHour(now),
      MAX_SAVES_PER_HOUR
    );
    if (!hourCheck.ok) {
      return jsonResponse({ error: "Rate limit exceeded. Max 100 saves/hour." }, 429);
    }

    const dayCheck = await checkAndIncrementRateLimit(
      supabase,
      deviceId,
      "day",
      startOfDay(now),
      MAX_SAVES_PER_DAY
    );
    if (!dayCheck.ok) {
      return jsonResponse({ error: "Rate limit exceeded. Max 1000 saves/day." }, 429);
    }

    const { count: projectCount, error: countError } = await supabase
      .from("memories")
      .select("id", { count: "exact", head: true })
      .eq("project", project)
      .eq("device_id", deviceId);

    if (countError) throw new Error(`project memory count failed: ${countError.message}`);

    if ((projectCount ?? 0) >= MAX_MEMORIES_PER_PROJECT) {
      return jsonResponse(
        { error: "Rate limit exceeded. Max 500 memories per project per device." },
        429
      );
    }

    const { data: inserted, error: insertError } = await supabase
      .from("memories")
      .insert({ ...body, device_id: deviceId })
      .select()
      .single();

    if (insertError) throw new Error(`insert failed: ${insertError.message}`);

    return jsonResponse(inserted, 200);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});
