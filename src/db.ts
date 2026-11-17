import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save. Times marked "s" are epoch
// SECONDS (the client's clock), "ms" epoch milliseconds.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  cash?: number; // the currency (Cash); everything is bought with it
  totalEarned?: number; // lifetime Cash earned (leaderboard)
  owned?: Record<string, number>; // gear id -> copies owned (client GEAR ids)
  equipped?: Gear; // the cart's gear
  discovered?: string[]; // gear ids ever seen (the catalog's NEW / ??? state)
  wagons?: number; // extra wagons bought (0..WAGONS_MAX)
  goldenCarts?: number;
  rebirths?: number;
  passes?: string[]; // pass ids owned (bought with Cash)
  stats?: Stats;
  best?: number; // = stats.best, top-level for the leaderboard ($max: never drops)
  playtime?: number; // = stats.playtime (s), top-level for the leaderboard
  upgrades?: Upgrades;
  topRuns?: TopRun[]; // best rides, at most TOP_RUNS_MAX
  lastGift?: number; // s, last free gift claimed
  spinAt?: number; // s, the client's lucky wheel: next free spin (NOT the server spin.ts clock)
  cashBoostUntil?: number; // s, cash boost active until
  fuelNextRun?: boolean;
  restock?: Restock; // the gear shop's stock period and what was bought in it
  loadouts?: (Gear | null)[]; // saved cart setups, null = empty slot
  slotsOpen?: number[]; // loadout slot indexes unlocked (0..9)
  stars?: number; // quest stars
  questLevel?: number; // star level
  dice?: number;
  quests?: { daily: QuestProgress; weekly: QuestProgress }; // the client's progress on the server's quests
  lastSeen?: number; // ms of the last activity
  // Spin wheel (spin.ts): written only by the server's `spin` handler, never by saveProgress.
  // Prefixed `srv` so they never collide with the client's own `spinAt` above.
  srvSpins?: number; // spins ready to use
  srvSpinAt?: number; // ms the next free spin arrives
  // Daily Reward (daily.ts): written by the server only, never by saveProgress.
  dailyDay?: number; // days unlocked this cycle
  dailyLast?: number; // UTC day index of the last unlock
  dailyClaimed?: number[]; // claimed day indexes this cycle
  // Quest schedule (quests.ts): written by the server only, never by saveProgress.
  questDaily?: QuestPick;
  questWeekly?: QuestPick;
  version: number;
  updatedAt: Date;
}

// { engine, fuel, wheels, booster } gear ids (client GEAR ids).
export interface Gear {
  engine?: string;
  fuel?: string;
  wheels?: string;
  booster?: string;
}

export interface Stats {
  rides?: number;
  best?: number; // best ride distance, studs
  gearBought?: number;
  wagonsBought?: number;
  spins?: number;
  boosts?: number;
  jumps?: number;
  totalDistance?: number;
  playtime?: number; // s with the game visible
  upgradesBought?: number;
  invites?: number;
}

// Cart upgrade levels.
export interface Upgrades {
  dist?: number;
  mult?: number;
  cur?: number;
}

export interface TopRun {
  d: number; // distance, studs
  cash: number; // Cash earned
}

export interface Restock {
  period: number; // the client's restock period index (-1 = none yet)
  nonce: number;
  bought: Record<string, number>; // gear id -> bought this period
}

// The client's progress on one period's quests.
export interface QuestProgress {
  period: number; // the period the progress belongs to (-1 = none yet)
  progress: Record<string, number>; // stat -> amount this period
  done: string[]; // quest ids finished this period
}

// The server's pick for one quest period (quests.ts).
export interface QuestPick {
  period: number;
  ids: string[];
  rerolls: number;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
