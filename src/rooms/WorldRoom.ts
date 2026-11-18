import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { AD_COOLDOWN_MS, DISTANCE_MAX, GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { accrue, rollWedge, spinStateFrom, type SpinState } from "../spin.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollDaily, type DailyState } from "../daily.js";
import { applyAvatar, applyCart, applyEmote, applyLoadout, applyPose } from "../presence.js";
import { identityFor, type Claim, type Verified } from "../auth.js";
import { verifyAdReward } from "../adReward.js";
import { queueScores } from "../platformBoards.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { isQuestKind, questFields, questsView, readQuests, rerollQuests, rollQuests, type QuestState } from "../quests.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

// What a client says about itself on join / `identify`: its Bloxity game token (verified, auth.ts),
// or off production a `devId` / legacy `userId`; plus how it looks.
interface Who extends Claim {
  username?: string;
  pfp?: string;
  avatar?: string;
  outfit?: string;
  pose?: unknown;
  loadout?: unknown;
  private?: boolean;
}

/**
 * Room every Build a Cart client joins via `client.joinOrCreate("world", { token, username, pfp })`. Loads and
 * saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of its
 * own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). One player per base: a room holds
 * ROOM_MAX_CLIENTS (5), full rooms spill into a fresh one automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> Spin wheel state (spin.ts), set once the session's save has been read. Kept for
  // guests and serverless sessions too (it then lasts the connection).
  private spinStates = new Map<string, SpinState>();
  // sessionId -> Daily Reward state (daily.ts), read with the save. Guests and serverless sessions
  // keep theirs here only (like the rest of their progress, it lasts the session).
  private dailies = new Map<string, DailyState>();
  // sessionId -> quest schedule (quests.ts), read with the save. Guests and serverless sessions
  // keep theirs here only.
  private quests = new Map<string, QuestState>();
  // sessionId -> when the next rewarded-ad token may be redeemed (server clock), and the sessions with
  // a verification in flight.
  private adAt = new Map<string, number>();
  private adBusy = new Set<string>();
  // sessionId -> the platform-verified outfit key, which the client's own `setAvatar` outfit can't override.
  private verifiedOutfit = new Map<string, string>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The leaderboard's best ride only ever goes up ($max), so a stale or replayed save can't lower it.
      const { best, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", updatedAt: new Date() },
            ...(best !== undefined && { $max: { best } }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
        return;
      }
      // Bloxity's own boards (platformBoards.ts): the verified account's latest scores, reported in batches.
      queueScores(userId, {
        ...(best !== undefined && { best: Math.floor(best) }),
        ...(rest.totalEarned !== undefined && { earned: Math.floor(rest.totalEarned) }),
        ...(rest.rebirths !== undefined && { rebirths: Math.floor(rest.rebirths) }),
        ...(rest.playtime !== undefined && { playtime: Math.floor(rest.playtime / 60) }),
      });
    },
    // Claims Daily Reward day `msg.day` (0-based). The server decides: answers `dailyResult`
    // { ok, day, ...state }; the client only grants the reward on ok.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const day = msg?.day;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, day, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s); // midnight passed while online
      if (!claimDaily(s, day)) return client.send("dailyResult", { ok: false, day, reason: "locked", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.claimed = s.claimed.filter((i) => i !== day); // not stored: not claimed
        return client.send("dailyResult", { ok: false, day, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, day, ...dailyView(s) });
    },
    // The client's countdown reached the next UTC day: unlock it (server clock) and answer `daily`.
    dailyRefresh: (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      client.send("daily", dailyView(s));
    },
    // The client's quest countdown reached zero: roll to the new period (server clock) and answer `quests`.
    questsRefresh: (client: Client) => {
      const s = this.quests.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollQuests(s)) void this.saveQuests(client.sessionId, s);
      client.send("quests", questsView(s));
    },
    // REFRESH QUESTS { kind: "daily" | "weekly", keep: [ids already finished] }: replaces every other
    // quest of that tab. Answers `questsResult` { ok: true, kind, period, ids, endsAt } or
    // { ok: false, kind, reason: "loading" | "kind" }. The client charges the Cash itself.
    rerollQuests: async (client: Client, msg: { kind?: unknown; keep?: unknown }) => {
      const kind = msg?.kind;
      const s = this.quests.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return client.send("questsResult", { ok: false, kind, reason: "loading" });
      if (!isQuestKind(kind)) return client.send("questsResult", { ok: false, kind, reason: "kind" });
      rollQuests(s); // a period that ended meanwhile gets its new pick first
      rerollQuests(s, kind, msg?.keep);
      const view = questsView(s)[kind];
      await this.saveQuests(client.sessionId, s);
      client.send("questsResult", { ok: true, kind, ...view });
    },
    // Spin wheel: uses one spin and rolls the prize here, so the client can't choose it. Answers
    // `spinResult` { ok, id (SPIN_WEDGES id), spins, nextAt, serverTime } or { ok: false, reason }.
    spin: async (client: Client) => {
      const s = this.spinStates.get(client.sessionId);
      if (!s) return client.send("spinResult", { ok: false, reason: "loading" });
      const now = Date.now();
      accrue(s, now);
      if (s.spins < 1) return client.send("spinResult", { ok: false, reason: "none", ...this.spinView(s, now) });
      s.spins--;
      accrue(s, now); // dropping below the cap starts the free-spin clock
      const wedge = rollWedge();
      client.send("spinResult", { ok: true, id: wedge.id, ...this.spinView(s, now) });
      await this.saveSpins(client.sessionId, s);
    },
    // The sender's race, relayed through the roster so everyone draws them on the distance bar and
    // podium: { racing, distance (studs this race) }, a few times a second while racing.
    race: (client: Client, msg: { racing?: unknown; distance?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.racing = msg?.racing === true;
      const d = msg?.distance;
      p.distance = p.racing && typeof d === "number" && Number.isFinite(d) ? Math.min(DISTANCE_MAX, Math.max(0, d)) : 0;
    },
    // Presence (presence.ts), relayed through the roster so everyone draws the sender in the world
    // (client remotePlayers.js): the walking pose ~10x/s, the riding cart ~15x/s, the equipped gear
    // and trailing carts, the Bloxity look and the portal emote being played.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    cart: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyCart(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      applyAvatar(p, msg);
      const verified = this.verifiedOutfit.get(client.sessionId);
      if (verified) p.outfit = verified;
    },
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    // A rewarded ad finished on the client (Bloxity `ads.showRewarded`): its token is checked with
    // Bloxity before the client pays out. Answers `adReward` { ok, reason?: "cooldown" | "invalid" }.
    adReward: async (client: Client, msg: { rewardToken?: unknown }) => {
      const sid = client.sessionId;
      if (Date.now() < (this.adAt.get(sid) ?? 0) || this.adBusy.has(sid)) return client.send("adReward", { ok: false, reason: "cooldown" });
      this.adBusy.add(sid);
      let ok = false;
      try {
        ok = await verifyAdReward(msg?.rewardToken);
      } finally {
        this.adBusy.delete(sid);
      }
      if (!this.state.players.has(sid)) return; // left meanwhile
      if (!ok) return client.send("adReward", { ok: false, reason: "invalid" });
      this.adAt.set(sid, Date.now() + AD_COOLDOWN_MS);
      client.send("adReward", { ok: true });
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session): a new token (or none), name, picture and look. Re-verified; the server answers with
    // progress/noProgress for the new identity. Without token / devId / userId only the name, picture
    // and look change.
    identify: async (client: Client, msg: Who) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !msg || typeof msg !== "object") return;
      if (typeof msg.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      applyAvatar(p, msg);
      if (!("token" in msg || "devId" in msg || "userId" in msg)) return;
      const who = await identityFor(msg);
      if (this.state.players.get(client.sessionId) !== p) return; // left while the token was checked
      this.applyIdentity(client, p, who);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate(options?: { private?: boolean }) {
    // CrazyGames "Play with friends" (?instantMultiplayer=true) makes a private room.
    if (options?.private) void this.setPrivate(true);
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
  }

  // `leaderboard` { boards: { rebirths|totalEarned|best|playtime: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  async onJoin(client: Client, options?: Who) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);
    const who = await identityFor(options);
    if (this.state.players.get(client.sessionId) !== p) return; // left while the token was checked
    this.applyIdentity(client, p, who);
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dailies.delete(sessionId);
    this.spinStates.delete(sessionId);
    this.quests.delete(sessionId);
    this.adAt.delete(sessionId);
    this.adBusy.delete(sessionId);
    this.verifiedOutfit.delete(sessionId);
  }

  private spinView(s: SpinState, now: number) {
    return { spins: s.spins, nextAt: s.nextAt, serverTime: now };
  }

  // The spin fields go straight to Mongo (saveProgress never carries them).
  private async saveSpins(sessionId: string, s: SpinState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { srvSpins: s.spins, srvSpinAt: s.nextAt, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn("[WorldRoom] saveSpins failed", err);
    }
  }

  // Stores a session's Daily Reward state. True when stored, or when there is nowhere to store it
  // (guest / no database: it lives in `dailies` for the session).
  private async saveDaily(sessionId: string, s: DailyState): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...dailyFields(s), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveDaily failed", err);
      return false;
    }
  }

  // Stores a session's quest schedule (questDaily / questWeekly). Guests / no database: it lives
  // in `quests` for the session.
  private async saveQuests(sessionId: string, s: QuestState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...questFields(s), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn("[WorldRoom] saveQuests failed", err);
    }
  }

  // The platform-verified account of a join / `identify` (auth.ts; "" = guest): its display name and
  // outfit key win over what the client reported. Then the save is loaded for it.
  private applyIdentity(client: Client, p: PlayerState, who: Verified) {
    if (who.userId && who.username) p.username = sanitizeName(who.username);
    if (who.userId && who.outfitKey) {
      this.verifiedOutfit.set(client.sessionId, who.outfitKey);
      p.outfit = who.outfitKey;
    } else this.verifiedOutfit.delete(client.sessionId);
    this.setUserId(client, p, who.userId);
  }

  // Bloxity user id from auth.ts (guest ids are dropped, see GUEST_ID_PREFIX); in production only a
  // verified token yields one. Called from applyIdentity; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.spinStates.delete(client.sessionId); // nor spins
    this.quests.delete(client.sessionId); // nor quest rerolls
    p.signedIn = !!userId;
    p.uid = userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const spin = spinStateFrom(doc, now);
    this.spinStates.set(client.sessionId, spin);
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });

    // Quest schedule: a new period (server clock) gets its pick, then the client gets `quests`.
    const quests = readQuests(doc);
    this.quests.set(client.sessionId, quests);
    if (rollQuests(quests, now)) void this.saveQuests(client.sessionId, quests);
    client.send("quests", questsView(quests, now));

    client.send("spins", this.spinView(spin, now));

    // Daily Reward: today's day unlocks on join (server clock), then the client gets the calendar.
    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    if (rollDaily(daily)) await this.saveDaily(client.sessionId, daily);
    if (this.dailies.get(client.sessionId) === daily) client.send("daily", dailyView(daily));
    void this.sendLeaderboard(client);
  }
}
