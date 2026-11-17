import assert from "assert";

import { CURRENCY_MAX, OWNED_COUNT_MAX, REBIRTHS_MAX, TOP_RUNS_MAX, LOADOUTS_MAX, QUEST_STAT_KEYS_MAX, TIMER_AHEAD_S } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({
      cash: 1e40, totalEarned: -5, rebirths: 3.7, wagons: 500, goldenCarts: 2.5, stars: -1, questLevel: 7.9, dice: "x",
      fuelNextRun: "yes", hack: "x", trophies: 5, gems: 5,
    })!;
    assert.strictEqual(out.cash, CURRENCY_MAX);
    assert.strictEqual(out.totalEarned, 0);
    assert.strictEqual(out.rebirths, 3);
    assert.strictEqual(out.wagons, 100);
    assert.strictEqual(out.goldenCarts, 2);
    assert.strictEqual(out.stars, 0);
    assert.strictEqual(out.questLevel, 7);
    assert.strictEqual(out.dice, undefined);
    assert.strictEqual(out.fuelNextRun, undefined);
    assert.strictEqual(sanitizeProgress({ rebirths: 1e20 })!.rebirths, REBIRTHS_MAX);
    for (const k of ["hack", "trophies", "gems"]) assert.ok(!(k in out), k);
  });

  it("bounds owned gear, equipped slots, discovered ids and passes", () => {
    const out = sanitizeProgress({
      owned: { rusty: 1, jerry: 2.9, wooden: 0, "Bad Id!": 3, none: "1", nitro: 1e9 },
      equipped: { engine: "rusty", fuel: "Bad Id!", wheels: "wooden", booster: 3, hat: "cap" },
      discovered: ["rusty", "rusty", "Bad Id!", "nitro", 7],
      passes: ["vip", "vip", "x y"],
    })!;
    assert.deepStrictEqual(out.owned, { rusty: 1, jerry: 2, nitro: OWNED_COUNT_MAX });
    assert.deepStrictEqual(out.equipped, { engine: "rusty", wheels: "wooden" });
    assert.deepStrictEqual(out.discovered, ["rusty", "nitro"]);
    assert.deepStrictEqual(out.passes, ["vip"]);
    // The client's in-memory { id: true } maps are accepted too.
    assert.deepStrictEqual(sanitizeProgress({ discovered: { rusty: true, jerry: false }, passes: { vip: true } })!.passes, ["vip"]);
    assert.deepStrictEqual(sanitizeProgress({ discovered: { rusty: true, jerry: false } })!.discovered, ["rusty"]);
  });

  it("keeps known stats, derives best / playtime and bounds upgrades and top runs", () => {
    const out = sanitizeProgress({
      stats: { rides: 4, best: 1234.5, playtime: 99, jumps: -2, spins: NaN, hack: 1 },
      upgrades: { dist: 3.9, mult: 5000, cur: -1, other: 2 },
      topRuns: [{ d: 10, cash: 5 }, { d: -1, cash: 1e40 }, { d: "x", cash: 1 }, ...Array.from({ length: 12 }, () => ({ d: 1, cash: 1 }))],
    })!;
    assert.deepStrictEqual(out.stats, { rides: 4, best: 1234.5, jumps: 0, playtime: 99 });
    assert.strictEqual(out.best, 1234.5);
    assert.strictEqual(out.playtime, 99);
    assert.deepStrictEqual(out.upgrades, { dist: 3, mult: 1000, cur: 0 });
    assert.strictEqual(out.topRuns!.length, TOP_RUNS_MAX);
    assert.deepStrictEqual(out.topRuns!.slice(0, 2), [{ d: 10, cash: 5 }, { d: 0, cash: CURRENCY_MAX }]);
    assert.strictEqual(sanitizeProgress({ cash: 1 })!.best, undefined, "no stats, no derived best");
  });

  it("bounds timers, restock, loadouts and slots", () => {
    const nowS = Date.now() / 1000;
    const out = sanitizeProgress({
      lastGift: -5, spinAt: 1e15, cashBoostUntil: nowS + 60, fuelNextRun: true,
      restock: { period: 12.5, nonce: 1e12, bought: { nitro: 2, "Bad Id!": 1, rusty: 0 } },
      loadouts: [null, { engine: "rusty", fuel: "jerry", wheels: "x y", booster: "none", extra: "y" }, "junk", ...Array(20).fill(null)],
      slotsOpen: [0, 1, 1, 10, -1, 2.5, 9],
    })!;
    assert.strictEqual(out.lastGift, 0);
    assert.ok(out.spinAt! <= nowS + TIMER_AHEAD_S + 5 && out.spinAt! >= nowS + TIMER_AHEAD_S - 5);
    assert.strictEqual(out.cashBoostUntil, nowS + 60);
    assert.strictEqual(out.fuelNextRun, true);
    assert.deepStrictEqual(out.restock, { period: 12, nonce: 1e9, bought: { nitro: 2 } });
    assert.deepStrictEqual(sanitizeProgress({ restock: { period: -1, bought: {} } })!.restock, { period: -1, nonce: 0, bought: {} });
    assert.strictEqual(out.loadouts!.length, LOADOUTS_MAX);
    assert.deepStrictEqual(out.loadouts!.slice(0, 3), [null, { engine: "rusty", fuel: "jerry", booster: "none" }, null]);
    assert.deepStrictEqual(out.slotsOpen, [0, 1, 9]);
  });

  it("bounds the client's quest progress", () => {
    const progress: Record<string, unknown> = { playtime: 120, cash: -3, "bad key": 1, rides: "2" };
    for (let i = 0; i < 30; i++) progress[`s${i}`] = i;
    const out = sanitizeProgress({ quests: { daily: { period: 20000, progress, done: ["warmup", "warmup", "x y"] }, weekly: "junk" } })!;
    assert.strictEqual(out.quests!.daily.period, 20000);
    assert.strictEqual(Object.keys(out.quests!.daily.progress).length, QUEST_STAT_KEYS_MAX);
    assert.strictEqual(out.quests!.daily.progress.playtime, 120);
    assert.strictEqual(out.quests!.daily.progress.cash, 0);
    assert.ok(!("bad key" in out.quests!.daily.progress) && !("rides" in out.quests!.daily.progress));
    assert.deepStrictEqual(out.quests!.daily.done, ["warmup"]);
    assert.deepStrictEqual(out.quests!.weekly, { period: -1, progress: {}, done: [] });
  });

  it("never accepts the server-owned fields", () => {
    const out = sanitizeProgress({ srvSpins: 9, srvSpinAt: 0, dailyDay: 7, questDaily: { period: 1, ids: [], rerolls: 0 }, questWeekly: {} })!;
    assert.deepStrictEqual(out, {});
  });
});
