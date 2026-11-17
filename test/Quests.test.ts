import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { QUEST_POOLS, QUESTS_PER_PERIOD } from "../src/constants.js";
import {
  dailyPeriod, weeklyPeriod, periodEndsAt, pickQuests, readQuests, rollQuests, rerollQuests, questsView,
} from "../src/quests.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const DAY = 86_400_000;
const distinctFrom = (ids: string[], pool: readonly string[]) =>
  ids.length === QUESTS_PER_PERIOD && new Set(ids).size === ids.length && ids.every((id) => pool.includes(id));

describe("quest schedule rules", () => {
  it("uses UTC days and Monday-start UTC weeks", () => {
    const t = Date.UTC(2026, 10, 18, 15, 30); // Wednesday 2026-11-18
    assert.strictEqual(dailyPeriod(t), Math.floor(t / DAY));
    assert.strictEqual(periodEndsAt("daily", dailyPeriod(t)), Date.UTC(2026, 10, 19));
    assert.strictEqual(periodEndsAt("weekly", weeklyPeriod(t)), Date.UTC(2026, 10, 23), "next Monday 00:00 UTC");
    const monday = Date.UTC(2026, 10, 23);
    assert.strictEqual(weeklyPeriod(monday - 1), weeklyPeriod(t), "Sunday 23:59 is still this week");
    assert.strictEqual(weeklyPeriod(monday), weeklyPeriod(t) + 1, "Monday 00:00 starts the next week");
    assert.strictEqual(periodEndsAt("weekly", weeklyPeriod(monday)), monday + 7 * DAY);
    assert.strictEqual(weeklyPeriod(Date.UTC(1970, 0, 5)), 1, "the first Monday of the epoch");
  });

  it("picks 5 distinct pool ids, deterministically per period, kind and rerolls", () => {
    for (let p = 20000; p < 20050; p++) {
      assert.ok(distinctFrom(pickQuests("daily", p), QUEST_POOLS.daily));
      assert.ok(distinctFrom(pickQuests("weekly", p), QUEST_POOLS.weekly));
      assert.deepStrictEqual(pickQuests("daily", p), pickQuests("daily", p));
    }
    const picks = new Set(Array.from({ length: 30 }, (_, p) => pickQuests("daily", 20000 + p).join()));
    assert.ok(picks.size > 20, "different periods get different picks");
    assert.notDeepStrictEqual(pickQuests("daily", 20000, 0), pickQuests("daily", 20000, 1));
  });

  it("rolls a new period with rerolls 0 and keeps a current one", () => {
    const now = Date.UTC(2026, 10, 18, 12);
    const s = readQuests(null);
    assert.strictEqual(s.daily.period, -1);
    assert.ok(rollQuests(s, now));
    assert.deepStrictEqual(s.daily, { period: dailyPeriod(now), ids: pickQuests("daily", dailyPeriod(now)), rerolls: 0 });
    assert.strictEqual(s.weekly.period, weeklyPeriod(now));
    assert.ok(!rollQuests(s, now + 60_000), "same period: nothing changes");
    s.daily.rerolls = 3;
    assert.ok(rollQuests(s, now + DAY));
    assert.strictEqual(s.daily.rerolls, 0);
    assert.strictEqual(s.weekly.period, weeklyPeriod(now), "the week goes on");

    // A malformed stored pick is replaced.
    const bad = readQuests({ questDaily: { period: dailyPeriod(now), ids: ["warmup", "warmup", "x", "y", "z"], rerolls: 1 } });
    assert.strictEqual(bad.daily.period, -1);
    const view = questsView(s, now);
    assert.deepStrictEqual(Object.keys(view).sort(), ["daily", "serverTime", "weekly"]);
    assert.strictEqual(view.daily.endsAt, (dailyPeriod(now + DAY) + 1) * DAY);
  });

  it("rerolls every quest but the finished ones, distinct, positions kept", () => {
    const now = Date.UTC(2026, 10, 18, 12);
    const s = readQuests(null);
    rollQuests(s, now);
    const before = [...s.daily.ids];
    const keep = [before[1], before[3], "notOnTheList"];
    rerollQuests(s, "daily", keep);
    assert.strictEqual(s.daily.rerolls, 1);
    assert.ok(distinctFrom(s.daily.ids, QUEST_POOLS.daily));
    assert.strictEqual(s.daily.ids[1], before[1]);
    assert.strictEqual(s.daily.ids[3], before[3]);
    for (const i of [0, 2, 4]) assert.ok(!before.includes(s.daily.ids[i]), "the daily pool has enough fresh ids");

    // The weekly pool (8) runs short when nothing is kept: still 5 distinct ids.
    const w = [...s.weekly.ids];
    rerollQuests(s, "weekly", []);
    assert.ok(distinctFrom(s.weekly.ids, QUEST_POOLS.weekly));
    const fresh = QUEST_POOLS.weekly.filter((id) => !w.includes(id));
    for (const id of fresh) assert.ok(s.weekly.ids.includes(id), "every id that was off comes on first");
    rerollQuests(s, "weekly", "junk");
    assert.strictEqual(s.weekly.rerolls, 2);
    assert.ok(distinctFrom(s.weekly.ids, QUEST_POOLS.weekly));
  });
});

describe("quest schedule room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends the period's quests after the load, stores them and rerolls on request", async () => {
    const now = Date.now();
    const fake = fakePlayers([
      // Yesterday's pick: rolled to today's on load.
      { _id: "q1", cash: 5, questDaily: { period: dailyPeriod(now) - 1, ids: pickQuests("daily", 1), rerolls: 4 }, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "q1" });
    const order: string[] = [];
    let quests: any = null;
    const results: any[] = [];
    c.onMessage("progress", () => order.push("progress"));
    c.onMessage("quests", (m: any) => {
      order.push("quests");
      quests = m;
    });
    c.onMessage("questsResult", (m: any) => results.push(m));
    c.onMessage("spins", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    assert.deepStrictEqual(order.slice(0, 2), ["progress", "quests"]);
    assert.deepStrictEqual(quests.daily, { period: dailyPeriod(now), ids: pickQuests("daily", dailyPeriod(now)), endsAt: (dailyPeriod(now) + 1) * DAY });
    assert.strictEqual(quests.weekly.period, weeklyPeriod(now));
    assert.strictEqual(quests.weekly.endsAt, ((weeklyPeriod(now) + 1) * 7 - 3) * DAY);
    assert.ok(Math.abs(quests.serverTime - now) < 5000);
    const doc = () => fake.docs.get("q1") as any;
    assert.deepStrictEqual(doc().questDaily, { period: dailyPeriod(now), ids: quests.daily.ids, rerolls: 0 });
    assert.strictEqual(doc().questWeekly.ids.length, QUESTS_PER_PERIOD);

    c.send("rerollQuests", { kind: "daily", keep: [quests.daily.ids[0]] });
    c.send("rerollQuests", { kind: "monthly", keep: [] });
    await sleep(150);
    const ok = results.find((r) => r.ok);
    assert.ok(ok, "the reroll answered");
    assert.strictEqual(ok.kind, "daily");
    assert.strictEqual(ok.ids[0], quests.daily.ids[0], "the finished quest stays");
    assert.ok(distinctFrom(ok.ids, QUEST_POOLS.daily));
    assert.strictEqual(ok.endsAt, quests.daily.endsAt);
    assert.deepStrictEqual(doc().questDaily, { period: dailyPeriod(now), ids: ok.ids, rerolls: 1 });
    assert.deepStrictEqual(results.find((r) => !r.ok), { ok: false, kind: "monthly", reason: "kind" });

    // questsRefresh in the same period answers the same pick; the client can't write it.
    let again: any = null;
    c.onMessage("quests", (m: any) => (again = m));
    c.send("questsRefresh");
    c.send("saveProgress", { questDaily: { period: 0, ids: [], rerolls: 0 }, questWeekly: null });
    await sleep(150);
    assert.deepStrictEqual(again?.daily.ids, ok.ids);
    assert.strictEqual(doc().questDaily.rerolls, 1);
    assert.strictEqual(doc().questWeekly.ids.length, QUESTS_PER_PERIOD);
  });

  it("gives a guest a session-only schedule and answers loading before the load", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const signedIn = await colyseus.connectTo(room, { userId: "q2" });
    const early: any[] = [];
    signedIn.onMessage("questsResult", (m: any) => early.push(m));
    signedIn.onMessage("noProgress", () => {});
    signedIn.onMessage("quests", () => {});
    signedIn.send("rerollQuests", { kind: "weekly", keep: [] });
    await sleep(100);
    assert.deepStrictEqual(early, [{ ok: false, kind: "weekly", reason: "loading" }]);

    fake.release();
    const guest = await colyseus.connectTo(room, { userId: "guest-q" });
    let quests: any = null;
    let result: any = null;
    guest.onMessage("noProgress", () => {});
    guest.onMessage("quests", (m: any) => (quests = m));
    guest.onMessage("questsResult", (m: any) => (result = m));
    await sleep(100);
    // A guest's load answers within onJoin, before these handlers exist: ask again.
    guest.send("questsRefresh");
    await sleep(100);
    assert.strictEqual(quests?.daily.ids.length, QUESTS_PER_PERIOD);
    guest.send("rerollQuests", { kind: "weekly", keep: [] });
    await sleep(150);
    assert.strictEqual(result?.ok, true);
    assert.ok(distinctFrom(result.ids, QUEST_POOLS.weekly));
    assert.ok(![...fake.docs.keys()].some((id) => id.startsWith("guest-")), "a guest is never written");
  });
});
