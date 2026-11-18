import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none), for the others' racer heads
    racing: t.boolean().default(false), // in a race right now (`race` message)
    distance: t.float64().default(0), // this race's distance so far, studs
    // Presence (presence.ts, `pose` / `cart` / `loadout` / `setAvatar` / `emote`): what the others draw.
    uid: t.string().default(""), // verified Bloxity id ("" = guest); public, lets clients match chat bubbles to players
    x: t.float64().default(0), // feet position, world coordinates as the sender sees them
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing -Z)
    speed: t.float32().default(0), // m/s on foot, for the walk cycle
    grounded: t.boolean().default(true),
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
    outfit: t.string().default(""), // Bloxity outfit key (the character kit draws a whole look from it), "" = none
    // The cart (client config.js GEAR ids, "" = none / bare) and its trailing carts.
    engine: t.string().default(""),
    fuel: t.string().default(""),
    wheels: t.string().default(""),
    booster: t.string().default(""),
    wagons: t.uint8().default(0), // extra carts
    golden: t.uint8().default(0), // Golden Carts
    // The ride (`cart` message, ~15x/s while riding): "foot" | "riding" | "crashed" | "ending".
    ride: t.string().default("foot"),
    crash: t.string().default(""), // crash kind while crashed (spikes, derail, herd, rocks, splash)
    s: t.float64().default(0), // metres along the track
    cy: t.float32().default(0), // cart height
    pitch: t.float32().default(0),
    roll: t.float32().default(0),
    lx: t.float32().default(0), // lane offset (the Gem Run branch)
    v: t.float32().default(0), // signed speed, m/s
    throttle: t.float32().default(0), // 0..1
    braking: t.boolean().default(false),
    boosting: t.boolean().default(false),
    air: t.boolean().default(false),
    fuelOk: t.boolean().default(true), // fuel left (exhaust and flames)
    tip: t.float32().default(0), // lean tip: past 1 the cart rides on two wheels
    // The portal's emote wheel: the id playing ("" = none); emoteSeq changes on every emote message so
    // the same emote can restart.
    emote: t.string().default(""),
    emoteSeq: t.uint16().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
