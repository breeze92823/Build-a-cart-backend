// Keep in step with the Build a Cart client's src/config.js by hand.
export const ROOM_MAX_CLIENTS = 50;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, the most pets
// drawn per player, and the pose bounds (|x|, |y| and z up to `xy` m; z down to -`z` m; speed in
// m/s). Not used by the Build a Cart client yet; kept bounded for when it is.
export const AVATAR_MAX_LEN = 3000;
export const PRESENCE_PETS_MAX = 8;
export const PET_TIERS_MAX = 16;
export const POSE_BOUNDS = { xy: 5000, z: 1e8, speed: 2000 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules: the dearest gear costs ~1e5 Cash (client GEAR), rebirths scale it.
export const CURRENCY_MAX = 1e18; // cash, totalEarned, a top run's cash
export const REBIRTHS_MAX = 1e9;
export const DISTANCE_MAX = 1e15; // studs: a ride's distance, stats.best / totalDistance
export const STAT_MAX = 1e15; // any other stats counter, quest progress
export const PLAY_SECONDS_MAX = 315_360_000; // stats.playtime, ~10 years
export const TIMER_AHEAD_S = 365 * 24 * 3600; // lastGift / spinAt / cashBoostUntil: at most now + 1 year (epoch s)

// Gear (client GEAR: engine, fuel, wheels, booster ids) and the counters around it.
export const OWNED_MAX = 256; // distinct owned / discovered / restock ids
export const OWNED_COUNT_MAX = 1e6; // copies of one gear id
export const GEAR_SLOTS = ["engine", "fuel", "wheels", "booster"] as const;
export const WAGONS_MAX = 100;
export const GOLDEN_CARTS_MAX = 1e6;
export const PASSES_MAX = 64;
export const UPGRADE_KEYS = ["dist", "mult", "cur"] as const; // cart upgrades (levels)
export const UPGRADE_LEVEL_MAX = 1000;
export const TOP_RUNS_MAX = 8;
export const RESTOCK_NONCE_MAX = 1e9;
export const PERIOD_MAX = 1e12; // restock / quest period indexes (-1 = none yet)
export const LOADOUTS_MAX = 10;
export const LOADOUT_SLOT_MAX = 9; // slotsOpen entries 0..9
export const STARS_MAX = 1e9;
export const QUEST_LEVEL_MAX = 1e6;
export const DICE_MAX = 1e6;
export const QUEST_STAT_KEYS_MAX = 16; // keys in one quest period's progress map
export const QUEST_DONE_MAX = 64;

// Daily Reward (daily.ts): days in one calendar cycle. Not used by the Build a Cart client yet.
export const DAILY_DAYS = 7;

// Quests (quests.ts; client QUESTS in config.js): each UTC day / UTC week (from Monday) the server
// picks QUESTS_PER_PERIOD ids from the pool. Ids must match the client's QUESTS.daily/weekly.pool.
export const QUESTS_PER_PERIOD = 5;
export const QUEST_POOLS = {
  daily: ["warmup", "steady", "champion", "collector", "walker", "rider", "hopper", "shopper", "mechanic", "booster", "lucky"],
  weekly: ["warrior", "community", "grinder", "weeklychamp", "explorer", "earner", "gapmaster", "regular"],
} as const;
export type QuestKind = keyof typeof QUEST_POOLS;
export const QUEST_KINDS = Object.keys(QUEST_POOLS) as QuestKind[];

// Spin wheel (spin.ts): server-authoritative spins, one free spin every SPIN_EVERY_MS, stored up
// to SPIN_CAP; a new player starts with SPIN_START. SPINS_MAX bounds a saved count. Not used by the
// Build a Cart client yet (its own lucky wheel is the client-saved `spinAt`).
export const SPIN_EVERY_MS = 15 * 60 * 1000;
export const SPIN_CAP = 5;
export const SPIN_START = 1;
export const SPINS_MAX = 1e6;
// The wedges' prizes and odds (weights in %). The client decides what each prize is, the server
// only which one is won.
export const SPIN_WEDGES = [
  { id: "doubleWins", weight: 35 },
  { id: "wins50", weight: 25 },
  { id: "luck", weight: 35 },
  { id: "wins250", weight: 4.9 },
  { id: "hugePet", weight: 0.1 },
] as const;

// Leaderboards (leaderboard.ts): the saved doc fields ranked (Rebirths, Total Earned, Best ride
// distance, Playtime), rows per board and how often the lists are re-read and re-sent. `best` and
// `playtime` are top-level copies of stats.best / stats.playtime (sanitize.ts) so they can be indexed.
export const LEADERBOARD_STATS = ["rebirths", "totalEarned", "best", "playtime"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (gear, passes, quests, stat keys): slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
