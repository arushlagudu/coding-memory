#!/usr/bin/env node
// npm postinstall hook for the "install" telemetry event. Deliberately a
// plain, untranspiled script with no dist/ dependency — this must never
// fail (or block) `npm install`/`npm ci`, including for this very repo's
// own dev setup, which runs postinstall before `npm run build` has ever
// produced a dist/ directory.
try {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const flagPath = path.join(os.homedir(), ".stackmem-telemetry");

  if (fs.existsSync(flagPath)) {
    fetch("https://api.stackmem.dev/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "install", os: process.platform, node_version: process.version }),
    }).catch(() => {
      // Placeholder endpoint — unreachable by design. Fail silently.
    });
  }
} catch {
  // Telemetry must never fail package installation.
}
