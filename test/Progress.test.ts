import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fake = fakePlayers([{
      _id: "u1", cash: 5000, owned: { rusty: 1, nitro: 2 }, equipped: { engine: "rusty", booster: "nitro" }, best: 900,
      stats: { best: 900, rides: 3 }, spinAt: 1_700_000_000, srvSpins: 2, srvSpinAt: Date.now(), version: 1, updatedAt: new Date(),
    }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.cash, 5000);
    assert.deepStrictEqual(got?.owned, { rusty: 1, nitro: 2 });
    assert.deepStrictEqual(got?.equipped, { engine: "rusty", booster: "nitro" });
    assert.strictEqual(got?.spinAt, 1_700_000_000, "the client's lucky wheel timer comes back");
    assert.ok(!("srvSpins" in got) && !("questDaily" in got), "server-owned fields stay on the server");

    c.send("saveProgress", {
      cash: 7000, totalEarned: 9000, stats: { best: 400, rides: 4, playtime: 30 }, equipped: { engine: "v8" },
      spinAt: 1_700_000_500, srvSpins: 99, questDaily: { period: 0, ids: [], rerolls: 0 }, hack: 1,
    });
    await sleep(150);
    const doc = fake.docs.get("u1")! as any;
    assert.strictEqual(doc.cash, 7000);
    assert.strictEqual(doc.totalEarned, 9000);
    assert.strictEqual(doc.equipped.engine, "v8");
    assert.strictEqual(doc.best, 900, "the leaderboard best never goes down");
    assert.strictEqual(doc.stats.best, 400, "the client's own stats are saved as sent");
    assert.strictEqual(doc.playtime, 30);
    assert.strictEqual(doc.spinAt, 1_700_000_500);
    assert.strictEqual(doc.srvSpins, 2, "the server spin count is not the client's to set");
    assert.strictEqual(doc.questDaily?.ids.length, 5, "the quest pick is not the client's to set");
    assert.strictEqual(doc.username, "Ann");
    assert.ok(!("hack" in doc));
  });

  it("creates a new account's save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "new1" });
    let none = false;
    c.onMessage("noProgress", () => (none = true));
    fake.release();
    await sleep(150);
    assert.ok(none);
    c.send("saveProgress", { cash: 10 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("new1")?.cash, 10);

    const guest = await colyseus.connectTo(room, { userId: "guest-abc" });
    guest.onMessage("noProgress", () => {});
    await sleep(150);
    guest.send("saveProgress", { cash: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
  });

  it("loads the new identity when a guest signs in mid-session", async () => {
    const fake = fakePlayers([{ _id: "u2", cash: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-x" });
    let got: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("progress", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    c.send("identify", { userId: "u2", username: "Bea" });
    await sleep(150);
    assert.strictEqual(got?.cash, 42);
    assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "u3", cash: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u3" });
    let failed = false;
    c.onMessage("serverError", () => (failed = true));
    fake.release();
    await sleep(150);
    assert.ok(failed);
    c.send("saveProgress", { cash: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("u3")!.cash, 1e9, "the unread save is never overwritten");
  });
});
