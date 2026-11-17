import { QUEST_KINDS, QUEST_POOLS, QUESTS_PER_PERIOD, type QuestKind } from "./constants.js";
import type { PlayerDoc, QuestPick } from "./db.js";

// Quest schedule (client src/quests.js, QUESTS in config.js): the SERVER decides which quests are
// on each period, on its own UTC clock, so a changed device clock can't skip ahead. Daily periods
// are UTC days; weekly periods are UTC weeks starting Monday 00:00. Each period gets a deterministic
// pick of QUESTS_PER_PERIOD distinct pool ids (seeded by period, reroll count and kind). Progress,
// rewards, stars and the reroll's Cash price are the client's (saved in `quests` via saveProgress);
// only the pick is stored here, in doc fields `questDaily` / `questWeekly`, written by the server.

export type QuestState = Record<QuestKind, QuestPick>;

const DAY_MS = 86_400_000;
export const dailyPeriod = (now = Date.now()) => Math.floor(now / DAY_MS);
// Epoch day 0 was a Thursday, so +3 makes weeks start on Monday.
export const weeklyPeriod = (now = Date.now()) => Math.floor((Math.floor(now / DAY_MS) + 3) / 7);
export const periodOf = (kind: QuestKind, now = Date.now()) => (kind === "daily" ? dailyPeriod(now) : weeklyPeriod(now));
// When a period ends (epoch ms): the next UTC midnight / the next Monday 00:00 UTC.
export const periodEndsAt = (kind: QuestKind, period: number) =>
  kind === "daily" ? (period + 1) * DAY_MS : ((period + 1) * 7 - 3) * DAY_MS;

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SALT: Record<QuestKind, number> = { daily: 0x5d1a7, weekly: 0x3e3c1 };
const rngFor = (kind: QuestKind, period: number, rerolls: number) =>
  mulberry32(Math.imul(period | 0, 0x9e3779b1) ^ Math.imul((rerolls | 0) + 1, 0x85ebca6b) ^ SALT[kind]);

// A seeded shuffle (Fisher-Yates) of a copy of `list`.
function shuffled<T>(list: readonly T[], rand: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The period's quests: QUESTS_PER_PERIOD distinct pool ids, the same for the same inputs.
export function pickQuests(kind: QuestKind, period: number, rerolls = 0): string[] {
  return shuffled(QUEST_POOLS[kind], rngFor(kind, period, rerolls)).slice(0, QUESTS_PER_PERIOD);
}

const pool = (kind: QuestKind): readonly string[] => QUEST_POOLS[kind];

// A stored pick, if it is well formed (right count, distinct pool ids).
function readPick(kind: QuestKind, raw: unknown): QuestPick | null {
  const r = raw as Partial<QuestPick> | null | undefined;
  if (!r || !Number.isInteger(r.period) || !Array.isArray(r.ids)) return null;
  const ids = r.ids.filter((id): id is string => typeof id === "string" && pool(kind).includes(id));
  if (ids.length !== QUESTS_PER_PERIOD || new Set(ids).size !== ids.length) return null;
  const rerolls = Number.isInteger(r.rerolls) && (r.rerolls as number) >= 0 ? (r.rerolls as number) : 0;
  return { period: r.period as number, ids, rerolls };
}

// The saved picks from a player's doc (null / missing / malformed = none yet: period -1, which the
// next roll replaces).
export function readQuests(doc: Partial<PlayerDoc> | null): QuestState {
  const none = (): QuestPick => ({ period: -1, ids: [], rerolls: 0 });
  return {
    daily: readPick("daily", doc?.questDaily) ?? none(),
    weekly: readPick("weekly", doc?.questWeekly) ?? none(),
  };
}

// A new period (or no pick yet) gets a fresh pick with rerolls 0. True when anything changed (save it).
export function rollQuests(s: QuestState, now = Date.now()): boolean {
  let changed = false;
  for (const kind of QUEST_KINDS) {
    const period = periodOf(kind, now);
    if (s[kind].period === period && s[kind].ids.length === QUESTS_PER_PERIOD) continue;
    s[kind] = { period, ids: pickQuests(kind, period, 0), rerolls: 0 };
    changed = true;
  }
  return changed;
}

// REFRESH QUESTS: `keep` = the ids the client already finished (only those in the current pick
// count). Every other slot gets a new id: first from the pool ids not currently on, then (pool run
// short) from any pool id not kept. Slots keep their positions; ids stay distinct. rerolls++.
export function rerollQuests(s: QuestState, kind: QuestKind, keep: unknown): void {
  const cur = s[kind];
  const kept = new Set(Array.isArray(keep) ? cur.ids.filter((id) => keep.includes(id)) : []);
  const rand = rngFor(kind, cur.period, cur.rerolls + 1);
  const fresh = shuffled(pool(kind).filter((id) => !cur.ids.includes(id)), rand);
  const fallback = shuffled(pool(kind).filter((id) => !kept.has(id) && !fresh.includes(id)), rand);
  const candidates = [...fresh, ...fallback];
  const ids = cur.ids.map((id) => (kept.has(id) ? id : candidates.shift()!));
  s[kind] = { period: cur.period, ids, rerolls: cur.rerolls + 1 };
}

// What one tab is sent: the period, its quest ids and when it ends (server clock, ms).
export const kindView = (s: QuestState, kind: QuestKind) => ({ period: s[kind].period, ids: [...s[kind].ids], endsAt: periodEndsAt(kind, s[kind].period) });

// `quests` { daily: { period, ids, endsAt }, weekly: { period, ids, endsAt }, serverTime }.
export const questsView = (s: QuestState, now = Date.now()) => ({ daily: kindView(s, "daily"), weekly: kindView(s, "weekly"), serverTime: now });

// The doc fields that store it.
export const questFields = (s: QuestState) => ({
  questDaily: { ...s.daily, ids: [...s.daily.ids] },
  questWeekly: { ...s.weekly, ids: [...s.weekly.ids] },
});

export const isQuestKind = (v: unknown): v is QuestKind => typeof v === "string" && (QUEST_KINDS as string[]).includes(v);
