import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { ROOM_MAX_CLIENTS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("roster", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("relays each player's profile picture and race distance, bounded", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann", pfp: "https://static.bloxity.io/img/pfps/3.png" });
    const b = await colyseus.connectTo(room, { userId: "guest-b", username: "Bo", pfp: "javascript:alert(1)" });
    await sleep(50);
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    assert.strictEqual(pa.pfp, "https://static.bloxity.io/img/pfps/3.png");
    assert.strictEqual(pb.pfp, "", "only http(s) pictures are relayed");

    a.send("race", { racing: true, distance: 1234.5 });
    b.send("race", { racing: true, distance: -5 });
    await sleep(50);
    assert.strictEqual(pa.racing, true);
    assert.strictEqual(pa.distance, 1234.5);
    assert.strictEqual(pb.distance, 0);

    a.send("race", { racing: false, distance: 9999 });
    b.send("identify", { username: "Bo", pfp: "https://static.bloxity.io/img/pfps/7.png" });
    await sleep(50);
    assert.strictEqual(pa.racing, false);
    assert.strictEqual(pa.distance, 0, "a finished race reads 0");
    assert.strictEqual(pb.pfp, "https://static.bloxity.io/img/pfps/7.png");
  });

  it("seats five players (one per base) and refuses a sixth", async () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, 5);
    const room = await colyseus.createRoom<WorldState>("world", {});
    assert.strictEqual(room.maxClients, 5);
    for (let i = 0; i < 5; i++) await colyseus.connectTo(room, { userId: `guest-${i}`, username: `P${i}` });
    await sleep(50);
    assert.strictEqual(room.state.players.size, 5);
    await assert.rejects(colyseus.connectTo(room, { userId: "guest-6", username: "P6" }), "the room is full");
    assert.strictEqual(room.state.players.size, 5);
  });

  it("marks guests and keeps the verified id public for chat bubbles", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const guest = await colyseus.connectTo(room, { userId: "guest-a", username: "G" });
    const dev = await colyseus.connectTo(room, { devId: "dev-abc", username: "D" });
    await sleep(50);
    const pg = room.state.players.get(guest.sessionId)!;
    const pd = room.state.players.get(dev.sessionId)!;
    assert.deepStrictEqual([pg.signedIn, pg.uid], [false, ""]);
    assert.deepStrictEqual([pd.signedIn, pd.uid], [true, "dev-abc"]);
  });
});
