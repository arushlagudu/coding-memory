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

const rawSupabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    headers: {
      "x-device-id": getDeviceId(),
    },
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// maxAttempts counts RETRIES, not total tries — the default (3 retries,
// 500ms base) produces exactly the 500ms / 1000ms / 2000ms backoff
// sequence across 4 total tries (1 initial + 3 retries).
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;

      const delayMs = baseDelayMs * 2 ** attempt;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Supabase request failed (retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms): ${message}`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// A 4xx response (bad request, not found, RLS denial) is a logic error —
// retrying it wastes time and can't succeed. status 0 (the fetch itself
// failed: DNS, connection refused, timeout) and 5xx (transient server
// errors) are the cases retrying can actually help with.
function isRetryableStatus(status: number): boolean {
  return status === 0 || status >= 500;
}

// Supabase/postgrest query results RESOLVE with { data, error, status }
// even on failure — they don't reject — so a plain try/catch around the
// call never sees a 5xx or network failure to retry. This wraps every
// query builder returned from `.from(...)` so that a retryable result
// is converted into a throw (for withRetry's catch to see), while a
// success or a non-retryable 4xx result still resolves normally, exactly
// as every existing `const { data, error } = await supabase.from(...)...`
// call site already expects — no call site elsewhere needs to change.
function wrapWithRetry<T>(target: T): T {
  if (target === null || typeof target !== "object") return target;

  return new Proxy(target as object, {
    get(obj: any, prop, receiver) {
      if (prop === "then") {
        return (onFulfilled?: unknown, onRejected?: unknown) => {
          const attempt = () =>
            new Promise((resolve, reject) => {
              obj.then(
                (result: any) => {
                  if (result && result.error && isRetryableStatus(result.status)) {
                    const err = new Error(
                      `Supabase request failed (status ${result.status}): ${result.error.message}`
                    );
                    (err as any).status = result.status;
                    (err as any).supabaseError = result.error;
                    reject(err);
                  } else {
                    resolve(result);
                  }
                },
                (err: unknown) => reject(err)
              );
            });

          return withRetry(attempt).then(
            onFulfilled as ((value: unknown) => unknown) | undefined,
            onRejected as ((reason: unknown) => unknown) | undefined
          );
        };
      }

      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => wrapWithRetry(value.apply(obj, args));
      }
      return value;
    },
  }) as T;
}

export const supabase: SupabaseClient = new Proxy(rawSupabase, {
  get(obj, prop, receiver) {
    if (prop === "from") {
      return (...args: unknown[]) => wrapWithRetry((obj.from as (...a: unknown[]) => unknown)(...args));
    }
    return Reflect.get(obj, prop, receiver);
  },
}) as SupabaseClient;

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

// `cm link` (src/cli.ts) writes to a link_codes table, and the vault pairs
// devices to GitHub accounts via user_devices. The vault owns that schema —
// run supabase/migrations/001_user_devices_and_link_codes.sql from the
// stackmem-vault repo. link_codes is RLS-scoped to the same 'x-device-id'
// header as the policies above, so a device can create and poll only its own
// codes; the vault reads them with the service-role key.
