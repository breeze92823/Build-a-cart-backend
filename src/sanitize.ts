import {
  CURRENCY_MAX, REBIRTHS_MAX, DISTANCE_MAX, STAT_MAX, PLAY_SECONDS_MAX, TIMER_AHEAD_S, OWNED_MAX, OWNED_COUNT_MAX,
  GEAR_SLOTS, WAGONS_MAX, GOLDEN_CARTS_MAX, PASSES_MAX, UPGRADE_KEYS, UPGRADE_LEVEL_MAX, TOP_RUNS_MAX,
  RESTOCK_NONCE_MAX, PERIOD_MAX, LOADOUTS_MAX, LOADOUT_SLOT_MAX, STARS_MAX, QUEST_LEVEL_MAX, DICE_MAX,
  QUEST_STAT_KEYS_MAX, QUEST_DONE_MAX, ID_PATTERN,
} from "./constants.js";
import type { Gear, PlayerDoc, QuestProgress, Restock, Stats, TopRun, Upgrades } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Id lists (discovered gear, passes, finished quests): slug strings, no duplicates, bounded count.
// A `{ id: true }` map (the client's in-memory shape) is accepted too: its truthy keys.
export function sanitizeIds(raw: unknown, max = OWNED_MAX): string[] {
  const list = Array.isArray(raw) ? raw : isObject(raw) ? Object.keys(raw).filter((k) => raw[k]) : [];
  return [...new Set(list.filter(isId))].slice(0, max);
}

// { id: count } maps (owned gear, restock purchases): slug ids, whole counts, 0s dropped.
function sanitizeCounts(raw: unknown, maxCount: number, maxKeys = OWNED_MAX): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  let n = 0;
  for (const [id, v] of Object.entries(raw)) {
    if (n >= maxKeys) break;
    if (!isId(id) || !finite(v)) continue;
    const c = clampInt(v, maxCount);
    if (c > 0) {
      out[id] = c;
      n++;
    }
  }
  return out;
}

// { engine, fuel, wheels, booster } gear ids: only those four keys, only well-formed ids.
function sanitizeGear(raw: unknown): Gear {
  const out: Gear = {};
  if (!isObject(raw)) return out;
  for (const k of GEAR_SLOTS) if (isId(raw[k])) out[k] = raw[k] as string;
  return out;
}

const STAT_BOUNDS: Record<keyof Stats, number> = {
  rides: STAT_MAX,
  best: DISTANCE_MAX,
  gearBought: STAT_MAX,
  wagonsBought: STAT_MAX,
  spins: STAT_MAX,
  boosts: STAT_MAX,
  jumps: STAT_MAX,
  totalDistance: DISTANCE_MAX,
  playtime: PLAY_SECONDS_MAX,
  upgradesBought: STAT_MAX,
  invites: STAT_MAX,
};

function sanitizeStats(raw: unknown): Stats {
  const out: Stats = {};
  if (!isObject(raw)) return out;
  for (const [k, max] of Object.entries(STAT_BOUNDS) as [keyof Stats, number][]) {
    if (finite(raw[k])) out[k] = clampNum(raw[k] as number, max);
  }
  return out;
}

function sanitizeUpgrades(raw: unknown): Upgrades {
  const out: Upgrades = {};
  if (!isObject(raw)) return out;
  for (const k of UPGRADE_KEYS) if (finite(raw[k])) out[k] = clampInt(raw[k] as number, UPGRADE_LEVEL_MAX);
  return out;
}

function sanitizeTopRuns(raw: unknown): TopRun[] {
  if (!Array.isArray(raw)) return [];
  const out: TopRun[] = [];
  for (const r of raw) {
    if (out.length >= TOP_RUNS_MAX) break;
    if (isObject(r) && finite(r.d) && finite(r.cash)) out.push({ d: clampNum(r.d, DISTANCE_MAX), cash: clampNum(r.cash, CURRENCY_MAX) });
  }
  return out;
}

const period = (v: unknown, fallback = -1) => (finite(v) ? clampInt(v, PERIOD_MAX, -1) : fallback);

function sanitizeRestock(raw: unknown): Restock {
  const r = isObject(raw) ? raw : {};
  return {
    period: period(r.period),
    nonce: finite(r.nonce) ? clampInt(r.nonce, RESTOCK_NONCE_MAX) : 0,
    bought: sanitizeCounts(r.bought, OWNED_COUNT_MAX),
  };
}

// Loadout slots: each `null` (empty) or a gear set. Positions matter (slot i), so a malformed
// entry becomes null instead of being dropped.
function sanitizeLoadouts(raw: unknown): (Gear | null)[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, LOADOUTS_MAX).map((l) => (isObject(l) ? sanitizeGear(l) : null));
}

function sanitizeSlots(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((i): i is number => Number.isInteger(i) && i >= 0 && i <= LOADOUT_SLOT_MAX))];
}

function sanitizeQuestProgress(raw: unknown): QuestProgress {
  const r = isObject(raw) ? raw : {};
  const progress: Record<string, number> = {};
  if (isObject(r.progress)) {
    let n = 0;
    for (const [k, v] of Object.entries(r.progress)) {
      if (n >= QUEST_STAT_KEYS_MAX) break;
      if (isId(k) && finite(v)) {
        progress[k] = clampNum(v, STAT_MAX);
        n++;
      }
    }
  }
  return { period: period(r.period), progress, done: sanitizeIds(r.done, QUEST_DONE_MAX) };
}

// Epoch-seconds timers (gift clock, lucky wheel, cash boost): >= 0 and at most a year ahead.
const timer = (v: number) => clampNum(v, Date.now() / 1000 + TIMER_AHEAD_S);

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save. Server-owned doc fields (srvSpins,
// srvSpinAt, daily*, questDaily, questWeekly) are never accepted here.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.cash)) out.cash = clampNum(raw.cash, CURRENCY_MAX);
  if (finite(raw.totalEarned)) out.totalEarned = clampNum(raw.totalEarned, CURRENCY_MAX);
  if (raw.owned !== undefined) out.owned = sanitizeCounts(raw.owned, OWNED_COUNT_MAX);
  if (raw.equipped !== undefined) out.equipped = sanitizeGear(raw.equipped);
  if (raw.discovered !== undefined) out.discovered = sanitizeIds(raw.discovered);
  if (finite(raw.wagons)) out.wagons = clampInt(raw.wagons, WAGONS_MAX);
  if (finite(raw.goldenCarts)) out.goldenCarts = clampInt(raw.goldenCarts, GOLDEN_CARTS_MAX);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTHS_MAX);
  if (raw.passes !== undefined) out.passes = sanitizeIds(raw.passes, PASSES_MAX);
  if (raw.stats !== undefined) {
    out.stats = sanitizeStats(raw.stats);
    // Top-level copies for the leaderboards (indexed; `best` is saved with $max).
    if (out.stats.best !== undefined) out.best = out.stats.best;
    if (out.stats.playtime !== undefined) out.playtime = out.stats.playtime;
  }
  if (raw.upgrades !== undefined) out.upgrades = sanitizeUpgrades(raw.upgrades);
  if (raw.topRuns !== undefined) out.topRuns = sanitizeTopRuns(raw.topRuns);
  if (finite(raw.lastGift)) out.lastGift = timer(raw.lastGift);
  if (finite(raw.spinAt)) out.spinAt = timer(raw.spinAt);
  if (finite(raw.cashBoostUntil)) out.cashBoostUntil = timer(raw.cashBoostUntil);
  if (typeof raw.fuelNextRun === "boolean") out.fuelNextRun = raw.fuelNextRun;
  if (raw.restock !== undefined) out.restock = sanitizeRestock(raw.restock);
  if (raw.loadouts !== undefined) out.loadouts = sanitizeLoadouts(raw.loadouts);
  if (raw.slotsOpen !== undefined) out.slotsOpen = sanitizeSlots(raw.slotsOpen);
  if (finite(raw.stars)) out.stars = clampInt(raw.stars, STARS_MAX);
  if (finite(raw.questLevel)) out.questLevel = clampInt(raw.questLevel, QUEST_LEVEL_MAX);
  if (finite(raw.dice)) out.dice = clampInt(raw.dice, DICE_MAX);
  if (raw.quests !== undefined) {
    const q = isObject(raw.quests) ? raw.quests : {};
    out.quests = { daily: sanitizeQuestProgress(q.daily), weekly: sanitizeQuestProgress(q.weekly) };
  }
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);
  return out;
}
