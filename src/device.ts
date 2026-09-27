import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEVICE_DIR = path.join(os.homedir(), ".stackmem");
const DEVICE_FILE = path.join(DEVICE_DIR, "device.json");

let cachedDeviceId: string | null = null;

// Every request is scoped to this id (see storage.ts), so it's effectively
// a bearer credential for whatever this device has saved — treat device.json
// like a secret, not just a preference file.
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    const raw = fs.readFileSync(DEVICE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.device_id === "string" && parsed.device_id.length > 0) {
      cachedDeviceId = parsed.device_id;
      return parsed.device_id;
    }
  } catch {
    // No device file yet, or it's unreadable/corrupt — create a fresh one below.
  }

  const deviceId = randomUUID();
  fs.mkdirSync(DEVICE_DIR, { recursive: true });
  fs.writeFileSync(DEVICE_FILE, JSON.stringify({ device_id: deviceId }, null, 2), "utf-8");

  cachedDeviceId = deviceId;
  return deviceId;
}
