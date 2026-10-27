import { randomUUID, randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEVICE_DIR = path.join(os.homedir(), ".stackmem");
const DEVICE_FILE = path.join(DEVICE_DIR, "device.json");

interface DeviceFile {
  device_id: string;
  device_secret?: string;
}

let cachedDeviceId: string | null = null;
let cachedDeviceSecret: string | null = null;

function readDeviceFile(): DeviceFile | null {
  try {
    const raw = fs.readFileSync(DEVICE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.device_id === "string" && parsed.device_id.length > 0) {
      return parsed;
    }
  } catch {
    // No device file yet, or it's unreadable/corrupt — create a fresh one below.
  }
  return null;
}

function writeDeviceFile(file: DeviceFile): void {
  fs.mkdirSync(DEVICE_DIR, { recursive: true });
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(file, null, 2), "utf-8");
}

// Loads (or creates) the device_id and device_secret together — an
// existing file that predates device_secret needs exactly one write to
// upgrade, not a separate read/write pass per field. Soft upgrade: the
// device_id never changes, so nothing this device already saved is
// orphaned; it just gains a secret it didn't have before.
function loadOrCreateDevice(): { deviceId: string; deviceSecret: string } {
  if (cachedDeviceId && cachedDeviceSecret) {
    return { deviceId: cachedDeviceId, deviceSecret: cachedDeviceSecret };
  }

  const existing = readDeviceFile();
  const deviceId = existing?.device_id ?? randomUUID();
  const deviceSecret = existing?.device_secret ?? randomBytes(32).toString("hex");

  if (!existing || !existing.device_secret) {
    writeDeviceFile({ device_id: deviceId, device_secret: deviceSecret });
  }

  cachedDeviceId = deviceId;
  cachedDeviceSecret = deviceSecret;
  return { deviceId, deviceSecret };
}

// Every request is scoped to this id (see storage.ts), so it's effectively
// a bearer credential for whatever this device has saved — treat device.json
// like a secret, not just a preference file.
export function getDeviceId(): string {
  return loadOrCreateDevice().deviceId;
}

export function getDeviceSecret(): string {
  return loadOrCreateDevice().deviceSecret;
}

// base64(device_id:sha256(device_id+device_secret+timestamp_hour)) — the
// current UTC hour (truncated, not wall-clock-precise) is the rotating
// input, so a captured token is only valid for the hour it was issued in
// without requiring tight clock sync with a future verifier. Not verified
// server-side yet (see storage.ts's USE_EDGE_FUNCTION-adjacent comment) —
// this just puts the token on the wire so enforcement can be turned on
// later without a client-side change.
export function getDeviceToken(): string {
  const { deviceId, deviceSecret } = loadOrCreateDevice();
  const timestampHour = Math.floor(Date.now() / (60 * 60 * 1000));
  const signature = createHash("sha256")
    .update(`${deviceId}${deviceSecret}${timestampHour}`)
    .digest("hex");
  return Buffer.from(`${deviceId}:${signature}`).toString("base64");
}
