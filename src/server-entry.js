import { start } from "./server.js";

const port = Number(process.env.HUMAN_REVIEW_PORT || 0);
let review;
try {
  review = await start(port);
} catch (err) {
  if (err.code !== "SERVER_LOCKED") {
    console.error(`human-review server could not start: ${err.message}`);
    process.exitCode = 1;
  }
}

// The detached server exits on its own once idle (see IDLE_SHUTDOWN_MS).
async function shutdown() {
  if (!review) return;
  try {
    await review.dispose();
  } catch (err) {
    console.error(`human-review server shutdown failed: ${err.message}`);
    process.exitCode = 1;
  }
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
