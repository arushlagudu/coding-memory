// Run these in the Supabase SQL editor after changing the RLS scoping
// mechanism from a session-config RPC to a request header. `set_config` from
// an RPC call doesn't persist to the next request under PostgREST (each call
// is its own transaction), so RLS now reads the 'x-device-id' header that
// supabase-js attaches to every request instead.
//
// DROP POLICY IF EXISTS "device owns memories" ON memories;
// CREATE POLICY "device owns memories" ON memories
// USING (device_id = (current_setting('request.headers', true)::json->>'x-device-id'))
// WITH CHECK (device_id = (current_setting('request.headers', true)::json->>'x-device-id'));
//
// DROP POLICY IF EXISTS "device owns execution_log" ON execution_log;
// CREATE POLICY "device owns execution_log" ON execution_log
// USING (device_id = (current_setting('request.headers', true)::json->>'x-device-id'))
// WITH CHECK (device_id = (current_setting('request.headers', true)::json->>'x-device-id'));
//
// DROP POLICY IF EXISTS "device owns memory_links" ON memory_links;
// CREATE POLICY "device owns memory_links" ON memory_links
// USING (
//   source_id in (
//     select id from memories
//     where device_id = (current_setting('request.headers', true)::json->>'x-device-id')
//   )
// );

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import { getDeviceId } from "./device.js";

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    headers: {
      "x-device-id": getDeviceId(),
    },
  },
});

// Run this migration in the Supabase SQL editor to add the access_count
// column used by the memory decay scoring in src/scoring.ts (computeDecayScore)
// and consumed by cm start / session_start in src/cli.ts and src/index.ts.
//
// ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer default 0;

// Run this migration in the Supabase SQL editor to create the memory_links
// table used by the semantic linking system in src/index.ts (save_memory /
// session_start). Assumes memories.id is a uuid, matching Supabase's default.
//
// create table memory_links (
//   id uuid primary key default gen_random_uuid(),
//   source_id uuid not null references memories(id) on delete cascade,
//   target_id uuid not null references memories(id) on delete cascade,
//   score double precision not null,
//   created_at timestamptz not null default now()
// );
//
// create index memory_links_source_id_idx on memory_links(source_id);
// create index memory_links_target_id_idx on memory_links(target_id);
