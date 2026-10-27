import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTelemetryEnabled, stackmemVersion } from "./telemetry.js";

export const ERROR_LOG_PATH = path.join(os.homedir(), ".stackmem-errors.log");

// Placeholder — this endpoint doesn't exist yet, same as telemetry.ts's.
// reportError() fails silently on any network/DNS/HTTP error.
const ERROR_REPORTING_ENDPOINT = "https://api.stackmem.dev/errors";

// Always writes the local log (lightweight error reporting without
// Sentry) regardless of telemetry opt-in; only sends to the remote
// endpoint when the user has opted in. Never throws — a broken error
// reporter must never mask or replace the original error.
export async function reportError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const timestamp = new Date().toISOString();

  try {
    fs.appendFileSync(ERROR_LOG_PATH, `[${timestamp}] ${message}\n${stack}\n\n`, "utf-8");
  } catch {
    // Can't write the log — nothing more to do locally.
  }

  if (!isTelemetryEnabled()) return;

  try {
    await fetch(ERROR_REPORTING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: stackmemVersion(),
        os: process.platform,
        node_version: process.version,
        error_message: message,
        // Never send memory content or file paths — just enough of the
        // stack to be useful, capped well short of leaking surrounding
        // source context.
        error_stack: stack.slice(0, 500),
      }),
    });
  } catch {
    // Placeholder endpoint — unreachable by design. Fail silently.
  }
}
