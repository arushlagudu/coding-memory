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
