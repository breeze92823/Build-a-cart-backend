import { createHash } from "node:crypto";

import { DEV_ID_PREFIX, GAME_SLUG, GUEST_ID_PREFIX, NAME_MAX, OUTFIT_MAX_LEN } from "./constants.js";

// Who a player really is (docs.bloxity.io, Multiplayer: "Server identity: trust only the platform").
// The client's Bloxity game token is checked with POST {BLOXITY_API_URL}/v1/auth/game-token/verify
// and only the user id Bloxity returns is used (saves, chat bubbles, leaderboard scores). In
// production no token, a refused one or an outage = a guest: the id a client sends is never trusted.
// Off production (a local `npm start`, the tests) a client's `devId` / legacy `userId` (anything not
// `guest-...`) is accepted so two local tabs can tell themselves apart.
const VERIFY_PATH = "/v1/auth/game-token/verify";
const TIMEOUT_MS = 6000;
const GOOD_TTL_MS = 60_000; // how long an answer is remembered
const BAD_TTL_MS = 30_000;
const CACHE_MAX = 2000;

// What Bloxity vouches for. userId "" = refused / unreachable.
export interface Verified {
  userId: string;
  outfitKey?: string; // the platform-verified outfit key (prefer it over the client's)
  username?: string; // display name
}

const NONE: Verified = { userId: "" };
const cache = new Map<string, { who: Verified; until: number }>();

// Cached by a hash, so this map never holds a usable credential.
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export const apiUrl = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
export const gameId = () => process.env.BLOXITY_GAME_ID || GAME_SLUG;

// The account `token` belongs to ({ userId: "" } when it is refused or Bloxity can't be reached).
export async function verifyToken(token: string, now = Date.now()): Promise<Verified> {
  const key = hashOf(token);
  const known = cache.get(key);
  if (known && known.until > now) return known.who;

  let who = NONE;
  let reached = false;
  try {
    const res = await fetch(`${apiUrl()}${VERIFY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ gameSlug: gameId() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    reached = res.ok || res.status === 401 || res.status === 403;
    if (res.ok) {
      const body = (await res.json()) as { valid?: boolean; user?: { _id?: unknown; displayName?: unknown; username?: unknown; outfitKey?: unknown } };
      const user = body.user;
      const id = user?._id;
      if (body.valid !== false && typeof id === "string" && id.length > 0 && id.length <= 128) {
        const name = [user?.displayName, user?.username].find((n): n is string => typeof n === "string" && n.length > 0);
        const outfit = user?.outfitKey;
        who = {
          userId: id,
          ...(name && { username: name.slice(0, NAME_MAX) }),
          ...(typeof outfit === "string" && outfit.length > 0 && outfit.length <= OUTFIT_MAX_LEN && { outfitKey: outfit }),
        };
      }
    }
  } catch (err) {
    console.warn("[auth] verify failed", err);
  }
  // An outage is not a verdict on the token: the next attempt asks again.
  if (reached) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { who, until: now + (who.userId ? GOOD_TTL_MS : BAD_TTL_MS) });
  }
  return who;
}

export type Claim = { token?: unknown; devId?: unknown; userId?: unknown };

// The verified account of a join / `identify`. userId "" = guest.
export async function identityFor(who: Claim | undefined, production = process.env.NODE_ENV === "production"): Promise<Verified> {
  const token = who?.token;
  if (typeof token === "string" && token && token.length <= 8192) {
    const v = await verifyToken(token);
    if (v.userId || production) return v;
  }
  if (!production) {
    for (const id of [who?.devId, who?.userId]) {
      if (typeof id === "string" && id && id.length <= 128 && !id.startsWith(GUEST_ID_PREFIX)) return { userId: id };
    }
  }
  return NONE;
}

// Just the id, for callers that need nothing else.
export async function accountFor(who: Claim | undefined, production = process.env.NODE_ENV === "production"): Promise<string> {
  return (await identityFor(who, production)).userId;
}

// A Bloxity-issued id (not a local dev id): only those are reported to the platform boards.
export const isPlatformId = (userId: string) => !!userId && !userId.startsWith(DEV_ID_PREFIX) && !userId.startsWith(GUEST_ID_PREFIX);

// Test-only: forget the cached answers.
export function __resetAuthForTest(): void {
  cache.clear();
}
