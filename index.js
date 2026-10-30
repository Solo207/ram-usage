const fs = require("fs");
const http = require("http");

const TARGET_MB = Number(process.env.RAM_MB); // total RAM for the whole process
const STEP_MB = Number(process.env.STEP_MB || 50);
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || 250);
const SAFETY_MARGIN_MB = Number(process.env.SAFETY_MARGIN_MB || 300);
const TOUCH_INTERVAL_MS = Number(process.env.TOUCH_INTERVAL_MS ?? 5000); // 0 = off
const PORT = Number(process.env.PORT || 3000);
const PAGE = 4096;

const chunks = [];
let ballastMb = 0;
let ballastTargetMb = 0;
let baselineMb = 0;
let state = "starting";

const log = (msg) => console.log(`[ballast] ${msg}`);
const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

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
  if (ballastMb >= ballastTargetMb) {
    state = "holding";
    log(`Holding. Process RSS is ${rssMb()} MB (target ${TARGET_MB} MB). Stop the app to release it.`);
    return;
  }

  const size = Math.min(STEP_MB, ballastTargetMb - ballastMb);
  const avail = availableMb();

  // Safety cap: never push the host below the safety margin
  if (avail !== null && avail - size < SAFETY_MARGIN_MB) {
    state = "stopped-by-safety-cap";
    log(
      `Safety cap hit: only ${avail} MB available, margin is ${SAFETY_MARGIN_MB} MB. ` +
        `Holding at RSS ${rssMb()} MB instead of ${TARGET_MB} MB.`
    );
    return;
  }

  // Non-zero fill so the pages are really touched and counted as used
  chunks.push(Buffer.alloc(size * 1024 * 1024, 1));
  ballastMb += size;
  state = "ramping";
  log(`RSS ${rssMb()}/${TARGET_MB} MB (ballast ${ballastMb}/${ballastTargetMb} MB, host available ${availableMb()} MB)`);
  setTimeout(step, STEP_DELAY_MS);
}

// Re-touch one byte per page so the kernel sees the ballast as active
// and prefers swapping out other things instead
function touch() {
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += PAGE) chunk[i] ^= 1;
  }
}

// Small status endpoint so the app has something to health-check
http
  .createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        state,
        targetTotalMb: TARGET_MB,
        currentRssMb: rssMb(),
        baselineMb,
        ballastMb,
        ballastTargetMb,
        hostAvailableMb: availableMb(),
        safetyMarginMb: SAFETY_MARGIN_MB,
        touchIntervalMs: TOUCH_INTERVAL_MS,
      })
    );
  })
  .listen(PORT, () => log(`Status server on port ${PORT}`));

// Exit fast when EasyPanel stops the container
process.on("SIGTERM", () => {
  log("SIGTERM received, exiting. The OS reclaims all memory.");
  process.exit(0);
});
process.on("SIGINT", () => process.exit(0));

if (!Number.isFinite(TARGET_MB) || TARGET_MB <= 0) {
  state = "invalid-config";
  log("RAM_MB env var is missing or invalid. Set it to a number of MB, e.g. RAM_MB=500. Idling.");
} else {
  baselineMb = rssMb();
  ballastTargetMb = Math.max(0, TARGET_MB - baselineMb);
  log(
    `Target total ${TARGET_MB} MB. Node baseline ~${baselineMb} MB, so ballast ${ballastTargetMb} MB. ` +
      `Step ${STEP_MB} MB every ${STEP_DELAY_MS} ms, safety margin ${SAFETY_MARGIN_MB} MB, ` +
      `host available ${availableMb()} MB`
  );
  if (ballastTargetMb === 0) {
    log("RAM_MB is below Node's own baseline, so no ballast is needed.");
  }
  if (TOUCH_INTERVAL_MS > 0) setInterval(touch, TOUCH_INTERVAL_MS);
  step();
}
