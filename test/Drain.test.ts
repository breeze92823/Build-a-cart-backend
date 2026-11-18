import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { drainRooms } from "../src/drain.js";
import { testServer } from "./server.js";

describe("drain", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("locks the rooms and waits until the players have left", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-a" });
    let done = false;
    const drained = drainRooms(5000, 20).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(room.locked, true, "no new players are seated");
    assert.strictEqual(done, false, "a rider is still here");
    await c.leave();
    await drained;
    assert.strictEqual(done, true);
  });

  it("gives up after the maximum wait", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    await colyseus.connectTo(room, { userId: "guest-a" });
    const started = Date.now();
    await drainRooms(200, 20);
    assert.ok(Date.now() - started >= 180 && Date.now() - started < 2000);
  });
});
