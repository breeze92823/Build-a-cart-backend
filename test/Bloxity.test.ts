import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __resetAuthForTest, accountFor, identityFor } from "../src/auth.js";
import { __queuedForTest, queueScores, reportScores } from "../src/platformBoards.js";
import { __setPlayersForTest } from "../src/db.js";
import { AD_COOLDOWN_MS, PLATFORM_BOARDS } from "../src/constants.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// Replaces fetch for Bloxity's API only: the test client's own HTTP calls go through untouched.
const realFetch = globalThis.fetch;
type Call = { url: string; init: RequestInit };
function stubBloxity(answer: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith("https://api.bloxity.test")) return realFetch(input, init);
    calls.push({ url, init });
    const { status = 200, body = {} } = answer(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

describe("bloxity", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.BLOXITY_API_URL = "https://api.bloxity.test";
    delete process.env.BLOXITY_GAME_ID;
    __resetAuthForTest();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ["BLOXITY_API_URL", "BLOXITY_GAME_ID", "BLOXITY_REPORT_TOKEN"]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    __queuedForTest().clear();
  });

  describe("accountFor", () => {
    it("trusts a dev id or legacy user id off production, never a guest- one", async () => {
      assert.strictEqual(await accountFor({ devId: "dev-abc" }, false), "dev-abc");
      assert.strictEqual(await accountFor({ userId: "u1" }, false), "u1");
      assert.strictEqual(await accountFor({ userId: "guest-x" }, false), "");
      assert.strictEqual(await accountFor({ devId: 5 }, false), "");
      assert.strictEqual(await accountFor(undefined, false), "");
    });

    it("in production ignores every client-sent id", async () => {
      const calls = stubBloxity(() => ({ body: { valid: true, user: { _id: "legion_1" } } }));
      assert.strictEqual(await accountFor({ devId: "dev-abc", userId: "u1" }, true), "");
      assert.strictEqual(calls.length, 0);
    });

    it("verifies the game token with Bloxity and uses only the id it returns", async () => {
      const calls = stubBloxity(() => ({ body: { valid: true, user: { _id: "legion_42", displayName: "Ann", outfitKey: "okey" } } }));
      const who = await identityFor({ token: "tok", userId: "someone-else" }, true);
      assert.deepStrictEqual(who, { userId: "legion_42", username: "Ann", outfitKey: "okey" });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://api.bloxity.test/v1/auth/game-token/verify");
      assert.strictEqual((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");
      assert.deepStrictEqual(JSON.parse(String(calls[0].init.body)), { gameSlug: "build-a-cart" });
      // Remembered for a minute.
      assert.strictEqual(await accountFor({ token: "tok" }, true), "legion_42");
      assert.strictEqual(calls.length, 1);
    });

    it("treats a refused token or an outage as a guest in production", async () => {
      stubBloxity(() => ({ status: 401, body: { valid: false } }));
      assert.strictEqual(await accountFor({ token: "bad", userId: "u1" }, true), "");
      stubBloxity(() => ({ body: { valid: false, user: { _id: "legion_1" } } }));
      assert.strictEqual(await accountFor({ token: "bad2" }, true), "");
      globalThis.fetch = (async () => {
        throw new Error("down");
      }) as typeof fetch;
      assert.strictEqual(await accountFor({ token: "tok3" }, true), "");
    });
  });

  describe("room", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    before(async () => (colyseus = await testServer()));
    beforeEach(async () => await colyseus.cleanup());
    afterEach(() => __setPlayersForTest(null));

    it("identifies a player from the verified token, name and outfit", async () => {
      process.env.NODE_ENV = "production";
      try {
        stubBloxity(() => ({ body: { valid: true, user: { _id: "legion_7", displayName: "Verified Vic", outfitKey: "platform-key" } } }));
        const room = await colyseus.createRoom<WorldState>("world", {});
        const c = await colyseus.connectTo(room, { token: "t1", userId: "forged", username: "Liar", outfit: "client-key" });
        const g = await colyseus.connectTo(room, { userId: "forged", username: "Guest" });
        await sleep(100);
        const p = room.state.players.get(c.sessionId)!;
        assert.deepStrictEqual([p.uid, p.signedIn, p.username, p.outfit], ["legion_7", true, "Verified Vic", "platform-key"]);
        c.send("setAvatar", { outfit: "client-key2" });
        await sleep(50);
        assert.strictEqual(p.outfit, "platform-key", "the platform-verified outfit key wins");
        const pg = room.state.players.get(g.sessionId)!;
        assert.deepStrictEqual([pg.uid, pg.signedIn], ["", false], "a forged id is a guest in production");
      } finally {
        process.env.NODE_ENV = env.NODE_ENV;
        if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
      }
    });

    it("re-identifies on identify with a new id, and keeps the identity when none is sent", async () => {
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { userId: "guest-a", username: "A" });
      await sleep(50);
      const p = room.state.players.get(c.sessionId)!;
      assert.strictEqual(p.uid, "");
      c.send("identify", { devId: "dev-zed", username: "Zed" });
      await sleep(50);
      assert.deepStrictEqual([p.uid, p.signedIn, p.username], ["dev-zed", true, "Zed"]);
      c.send("identify", { username: "Zed2", pfp: "https://static.bloxity.io/img/pfps/1.png", outfit: "o2" });
      await sleep(50);
      assert.deepStrictEqual([p.uid, p.username, p.outfit], ["dev-zed", "Zed2", "o2"], "name and look change, identity stays");
      c.send("identify", { token: null });
      await sleep(50);
      assert.deepStrictEqual([p.uid, p.signedIn], ["", false], "signing out makes a guest");
    });

    it("redeems a rewarded ad once per cooldown and refuses an invalid token", async () => {
      let valid = true;
      const calls = stubBloxity(() => ({ body: { valid } }));
      const room = await colyseus.createRoom<WorldState>("world", {});
      const a = await colyseus.connectTo(room, { userId: "guest-a" });
      const b = await colyseus.connectTo(room, { userId: "guest-b" });
      const answers: any[] = [];
      a.onMessage("adReward", (m: any) => answers.push(["a", m]));
      b.onMessage("adReward", (m: any) => answers.push(["b", m]));
      await sleep(50);

      a.send("adReward", { rewardToken: "tok-1" });
      await sleep(100);
      assert.deepStrictEqual(answers.pop(), ["a", { ok: true }]);
      assert.strictEqual(calls[0].url, "https://api.bloxity.test/v1/ads/reward/verify");
      assert.deepStrictEqual(JSON.parse(String(calls[0].init.body)), { gameSlug: "build-a-cart", rewardToken: "tok-1" });

      a.send("adReward", { rewardToken: "tok-2" });
      await sleep(100);
      assert.deepStrictEqual(answers.pop(), ["a", { ok: false, reason: "cooldown" }]);
      assert.strictEqual(calls.length, 1, "a cooling-down session is not even asked");
      assert.ok(AD_COOLDOWN_MS >= 60_000);

      valid = false;
      b.send("adReward", { rewardToken: "tok-3" });
      await sleep(100);
      assert.deepStrictEqual(answers.pop(), ["b", { ok: false, reason: "invalid" }]);
      b.send("adReward", {});
      await sleep(100);
      assert.deepStrictEqual(answers.pop(), ["b", { ok: false, reason: "invalid" }], "a missing token is invalid (and a bad try starts no cooldown)");
    });

    it("queues a verified player's scores for Bloxity's boards when they save", async () => {
      process.env.BLOXITY_REPORT_TOKEN = "report-token";
      process.env.NODE_ENV = "production";
      try {
        stubBloxity(() => ({ body: { valid: true, user: { _id: "legion_9" } } }));
        const fake = fakePlayers();
        __setPlayersForTest(fake);
        const room = await colyseus.createRoom<WorldState>("world", {});
        const c = await colyseus.connectTo(room, { token: "t9" });
        fake.release();
        await sleep(150);
        c.send("saveProgress", { cash: 5, totalEarned: 1234.9, rebirths: 2, stats: { best: 876.5, playtime: 725 } });
        await sleep(150);
        assert.deepStrictEqual(__queuedForTest().get("legion_9"), { best: 876, earned: 1234, rebirths: 2, playtime: 12 });
      } finally {
        process.env.NODE_ENV = env.NODE_ENV;
        if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
      }
    });
  });

  describe("platform boards", () => {
    it("does nothing without the report token, and never reports dev or guest ids", () => {
      delete process.env.BLOXITY_REPORT_TOKEN;
      queueScores("legion_1", { best: 5 });
      assert.strictEqual(__queuedForTest().size, 0);
      process.env.BLOXITY_REPORT_TOKEN = "t";
      queueScores("dev-abc", { best: 5 });
      queueScores("guest-abc", { best: 5 });
      queueScores("", { best: 5 });
      assert.strictEqual(__queuedForTest().size, 0);
    });

    it("keeps the latest score per board and reports them with the board declarations", async () => {
      process.env.BLOXITY_REPORT_TOKEN = "report-token";
      const calls = stubBloxity(() => ({ body: { dropped: {} } }));
      queueScores("legion_a", { best: 100, earned: 5 });
      queueScores("legion_a", { best: 150, playtime: 0 });
      queueScores("legion_b#m1", { rebirths: 3.9 });
      await reportScores();
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://api.bloxity.test/v1/leaderboards/hosted/build-a-cart/report");
      assert.strictEqual((calls[0].init.headers as Record<string, string>).authorization, "Bearer report-token");
      const body = JSON.parse(String(calls[0].init.body));
      assert.deepStrictEqual(body.boards.map((b: any) => b.id), PLATFORM_BOARDS.map((b) => b.id));
      assert.deepStrictEqual(
        body.scores.sort((x: any, y: any) => (x.board + x.userId).localeCompare(y.board + y.userId)),
        [
          { board: "best", userId: "legion_a", score: 150 },
          { board: "earned", userId: "legion_a", score: 5 },
          { board: "rebirths", userId: "legion_b", score: 3 },
        ],
        "zero scores are skipped, the #m suffix is stripped, scores are whole numbers",
      );
      assert.strictEqual(__queuedForTest().size, 0);
      await reportScores();
      assert.strictEqual(calls.length, 1, "nothing queued: no call");
    });

    it("reports in batches of at most 200 scores", async () => {
      process.env.BLOXITY_REPORT_TOKEN = "report-token";
      const calls = stubBloxity(() => ({ body: {} }));
      for (let i = 0; i < 250; i++) queueScores(`legion_${i}`, { best: i + 1 });
      await reportScores();
      await reportScores();
      assert.strictEqual(calls.length, 2);
      const sizes = calls.map((c) => JSON.parse(String(c.init.body)).scores.length);
      assert.ok(sizes.every((n) => n <= 200), `batch sizes ${sizes}`);
      assert.strictEqual(sizes[0] + sizes[1], 250);
      assert.strictEqual(__queuedForTest().size, 0);
    });
  });
});
