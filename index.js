const fs = require("fs");
const http = require("http");

const TARGET_MB = Number(process.env.RAM_MB);
const STEP_MB = Number(process.env.STEP_MB || 50);
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || 250);
const SAFETY_MARGIN_MB = Number(process.env.SAFETY_MARGIN_MB || 300);
const PORT = Number(process.env.PORT || 3000);

const chunks = [];
let allocatedMb = 0;
let state = "starting";

const log = (msg) => console.log(`[ballast] ${msg}`);

// Host-wide available RAM (what the kernel can hand out without swapping)
function availableMb() {
  try {
    const m = fs
      .readFileSync("/proc/meminfo", "utf8")
      .match(/MemAvailable:\s+(\d+)\s+kB/);
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function step() {
  if (allocatedMb >= TARGET_MB) {
    state = "holding";
    log(`Target reached: holding ${allocatedMb} MB. Stop the app to release it.`);
    return;
  }

  const size = Math.min(STEP_MB, TARGET_MB - allocatedMb);
  const avail = availableMb();

  // Safety cap: never push the host below the safety margin
  if (avail !== null && avail - size < SAFETY_MARGIN_MB) {
    state = "stopped-by-safety-cap";
    log(
      `Safety cap hit: only ${avail} MB available, margin is ${SAFETY_MARGIN_MB} MB. ` +
        `Holding ${allocatedMb} MB instead of the ${TARGET_MB} MB requested.`
    );
    return;
  }

  // Fill with non-zero bytes so the pages are really touched and counted as used
  chunks.push(Buffer.alloc(size * 1024 * 1024, 1));
  allocatedMb += size;
  state = "ramping";
  log(`Allocated ${allocatedMb}/${TARGET_MB} MB (host available: ${availableMb()} MB)`);
  setTimeout(step, STEP_DELAY_MS);
}

// Small status endpoint so the app has something to health-check
http
  .createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        state,
        targetMb: TARGET_MB,
        allocatedMb,
        hostAvailableMb: availableMb(),
        safetyMarginMb: SAFETY_MARGIN_MB,
      })
    );
  })
  .listen(PORT, () => log(`Status server on port ${PORT}`));

// Exit fast when EasyPanel stops the container
process.on("SIGTERM", () => {
  log("SIGTERM received, releasing memory.");
  process.exit(0);
});
process.on("SIGINT", () => process.exit(0));

if (!Number.isFinite(TARGET_MB) || TARGET_MB <= 0) {
  state = "invalid-config";
  log("RAM_MB env var is missing or invalid. Set it to a number of MB, e.g. RAM_MB=500. Idling.");
} else {
  log(
    `Target ${TARGET_MB} MB, step ${STEP_MB} MB every ${STEP_DELAY_MS} ms, ` +
      `safety margin ${SAFETY_MARGIN_MB} MB, host available ${availableMb()} MB`
  );
  step();
}
