// Keep in step with the Build a Cart client's src/config.js by hand.
// The game slug registered on bloxity.io (the client's GAME_SLUG). Bloxity hosting also injects it
// as BLOXITY_GAME_ID, which wins when set (auth.ts gameId()).
export const GAME_SLUG = "build-a-cart";

// Five bases in a row: one player per base. Boxity learns the room size from the matchmaker joins
// and the deploy workflow sends this number as `roomSize` (keep the `ROOM_MAX_CLIENTS = <digits>`
// line format: the workflow greps it). Must stay 2-100 for party play.
export const ROOM_MAX_CLIENTS = 5;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): what the other players draw. The Bloxity avatar JSON and outfit key are
// relayed for them (opaque, length-capped), the walking pose is bounded (|x|, |y| up to `xy` m, z
// down to -`z` m, speed in m/s) and so is the cart's state while riding.
export const AVATAR_MAX_LEN = 3000;
export const OUTFIT_MAX_LEN = 600;
export const POSE_BOUNDS = { xy: 5000, z: 1e8, speed: 2000 };
export const CART_BOUNDS = {
  s: 1e6, // metres along the track
  cy: 5000, // cart height
  angle: 3.2, // pitch / roll, rad
  lx: 200, // lane offset, m
  v: 2000, // signed speed, m/s
  tip: 4, // lean tip (the cart goes onto two wheels past 1)
  wagons: 100, // trailing carts drawn (WAGONS_MAX)
};
export const RIDE_STATES = ["foot", "riding", "crashed", "ending"] as const;
export type RideState = (typeof RIDE_STATES)[number];
// A Bloxity emote id (24-char catalogue ids, kept opaque).
export const EMOTE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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
export const UPGRADE_KEYS = ["power", "tank", "aero", "dist", "mult", "cur"] as const; // cart upgrades (levels)
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

// The client's per-browser dev id (VITE_DEV_MODE, no Bloxity): accepted off production only.
export const DEV_ID_PREFIX = "dev-";

// Rewarded ads (adReward.ts): a token is checked with Bloxity before the client pays out, at most
// once per AD_COOLDOWN_MS per session (server clock).
export const AD_TOKEN_MAX_LEN = 4096;
export const AD_COOLDOWN_MS = 60 * 1000;

// Bloxity's own leaderboards (platformBoards.ts): declared here and by the client (config.js
// LEADERBOARDS), scores of verified players are reported in batches from the server. `best` is
// the best ride distance, `playtime` is reported in whole minutes.
export const PLATFORM_BOARD_EVERY_MS = 30 * 1000;
export const PLATFORM_BOARD_BATCH = 200;
export const PLATFORM_BOARDS = [
  { id: "best", label: "Best Distance (m)", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "earned", label: "Total Earned", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "rebirths", label: "Rebirths", order: "desc", mode: "best", format: "number", reset: "none" },
  { id: "playtime", label: "Play Time (min)", order: "desc", mode: "latest", format: "number", reset: "none" },
] as const;
export type BoardId = (typeof PLATFORM_BOARDS)[number]["id"];

// SIGTERM drain (index.ts): how long a deploy / scale-down waits for the riders to leave (Legion
// kills the pod after 10 minutes).
export const DRAIN_MAX_MS = 9 * 60 * 1000;
export const DRAIN_POLL_MS = 1000;
