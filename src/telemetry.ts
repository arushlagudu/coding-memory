import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Existence of this file IS the opt-in signal — no separate config field,
// no "already asked" marker. Default is opted OUT: the file is absent
// until the user explicitly agrees (cm init --wizard's prompt, or
// `cm telemetry --enable`).
export const TELEMETRY_FLAG_PATH = path.join(os.homedir(), ".stackmem-telemetry");

// Placeholder — this endpoint doesn't exist yet. trackEvent() fails
// silently on any network/DNS/HTTP error so a dead telemetry backend
// never affects a real command.
const TELEMETRY_ENDPOINT = "https://api.stackmem.dev/telemetry";

export type TelemetryEvent = "install" | "init" | "session_start" | "daily_active";

export function isTelemetryEnabled(): boolean {
  return fs.existsSync(TELEMETRY_FLAG_PATH);
}

export function enableTelemetry(): void {
  fs.writeFileSync(TELEMETRY_FLAG_PATH, "enabled\n", "utf-8");
}

export function disableTelemetry(): void {
  if (fs.existsSync(TELEMETRY_FLAG_PATH)) fs.rmSync(TELEMETRY_FLAG_PATH);
}

export function stackmemVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// A once-per-calendar-day marker, separate from the opt-in flag itself,
// so "daily_active" fires at most once per day per machine rather than
// on every single command that happens to start a session.
const LAST_ACTIVE_PATH = path.join(os.homedir(), ".stackmem-last-active");

export async function maybeTrackDailyActive(): Promise<void> {
  if (!isTelemetryEnabled()) return;

  const today = new Date().toISOString().slice(0, 10);
  try {
    const last = fs.existsSync(LAST_ACTIVE_PATH) ? fs.readFileSync(LAST_ACTIVE_PATH, "utf-8").trim() : "";
    if (last === today) return;
    fs.writeFileSync(LAST_ACTIVE_PATH, today, "utf-8");
  } catch {
    return;
  }

  await trackEvent("daily_active");
}

// Fire-and-forget: never awaited by a caller that needs its result, never
// throws. No code, file paths, or memory content is ever included — just
// enough to tell which commands get used.
export async function trackEvent(event: TelemetryEvent): Promise<void> {
  if (!isTelemetryEnabled()) return;

  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        version: stackmemVersion(),
        os: process.platform,
        node_version: process.version,
      }),
    });
  } catch {
    // Placeholder endpoint — unreachable by design. Fail silently.
  }
}
