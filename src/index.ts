import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { drainRooms } from "./drain.js";
import { installRoomReporter } from "./legion-room-reporter.js";
import { installPlatformBoards, reportScores } from "./platformBoards.js";
import { connectDb } from "./db.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
const server = await listen(app);

// Both are no-ops without the Bloxity hosting env vars: this pod's rooms for the matchmaker's
// cross-pod directory (Open Rooms, join by id), and the scores for Bloxity's own boards.
installRoomReporter();
installPlatformBoards();

// A Legion deploy or scale-down sends SIGTERM and waits up to 10 minutes: drain instead of dropping
// players (app.config.ts turns Colyseus' own immediate shutdown off). New players already go to the
// new pod; the ones riding here finish and leave, then the pod closes its rooms and exits.
let stopping = false;
async function shutdown(drain: boolean) {
  if (stopping) return;
  stopping = true;
  try {
    if (drain) {
      console.info("[drain] SIGTERM: locking the rooms and waiting for the players to leave");
      await drainRooms();
    }
    await reportScores(); // the last queued scores
  } finally {
    await server.gracefullyShutdown(true);
  }
}
process.once("SIGTERM", () => void shutdown(true));
process.once("SIGINT", () => void shutdown(false));
