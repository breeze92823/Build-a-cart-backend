import { matchMaker } from "colyseus";

import { DRAIN_MAX_MS, DRAIN_POLL_MS } from "./constants.js";

// Zero-downtime deploys (Bloxity hosting, "Drain"): on SIGTERM Legion waits up to 10 minutes for the
// pod to exit. Rooms are locked at once, so the matchmaker sends every new player to the new pod, and
// the riders already here keep playing until they leave (or `maxMs` passes). Resolves when no player is
// left on this process.
export async function drainRooms(maxMs = DRAIN_MAX_MS, pollMs = DRAIN_POLL_MS): Promise<void> {
  const until = Date.now() + maxMs;
  for (;;) {
    let players = 0;
    try {
      // Re-listed every pass: a room created by a straggling request is locked too.
      for (const listing of await matchMaker.query({})) {
        const room = matchMaker.getLocalRoomById(listing.roomId);
        if (!room) continue; // another process's room
        if (!room.locked) await room.lock();
        players += room.clients.length;
      }
    } catch (err) {
      console.warn("[drain] could not list the rooms", err);
    }
    if (players === 0 || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
