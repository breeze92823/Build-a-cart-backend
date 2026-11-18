import { AVATAR_MAX_LEN, CART_BOUNDS, EMOTE_PATTERN, ID_PATTERN, OUTFIT_MAX_LEN, POSE_BOUNDS, RIDE_STATES } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world (client remotePlayers.js).
// Relayed through the roster as sent, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const asObject = (msg: unknown): Record<string, unknown> | null => (msg && typeof msg === "object" ? (msg as Record<string, unknown>) : null);

// `pose` { x, y, z, yaw, speed, grounded }: the walking player's feet position in world coordinates
// (as the sender sees them), heading (rad), horizontal speed (m/s) and whether they stand on the floor.
export function applyPose(p: PlayerState, msg: unknown): void {
  const m = asObject(msg);
  if (!m) return;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.xy, b.xy);
  if (finite(m.z)) p.z = clamp(m.z, -b.z, b.xy);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
  if (typeof m.grounded === "boolean") p.grounded = m.grounded;
}

// `cart` { ride, crash, s, cy, pitch, roll, lx, v, throttle, braking, boosting, air, fuelOk, tip }:
// the riding cart. Every field is optional; a malformed one is ignored.
export function applyCart(p: PlayerState, msg: unknown): void {
  const m = asObject(msg);
  if (!m) return;
  const b = CART_BOUNDS;
  if (typeof m.ride === "string" && (RIDE_STATES as readonly string[]).includes(m.ride)) p.ride = m.ride;
  if (m.crash === "" || isId(m.crash)) p.crash = m.crash as string;
  if (finite(m.s)) p.s = clamp(m.s, -b.s, b.s);
  if (finite(m.cy)) p.cy = clamp(m.cy, -b.cy, b.cy);
  if (finite(m.pitch)) p.pitch = clamp(m.pitch, -b.angle, b.angle);
  if (finite(m.roll)) p.roll = clamp(m.roll, -b.angle, b.angle);
  if (finite(m.lx)) p.lx = clamp(m.lx, -b.lx, b.lx);
  if (finite(m.v)) p.v = clamp(m.v, -b.v, b.v);
  if (finite(m.throttle)) p.throttle = clamp(m.throttle, 0, 1);
  if (finite(m.tip)) p.tip = clamp(m.tip, -b.tip, b.tip);
  for (const key of ["braking", "boosting", "air", "fuelOk"] as const) {
    if (typeof m[key] === "boolean") p[key] = m[key] as boolean;
  }
}

// `loadout` { engine, fuel, wheels, booster, wagons, golden }: the cart's equipped catalog ids
// ("" = none) and how many extra / Golden Carts trail behind it.
export function applyLoadout(p: PlayerState, msg: unknown): void {
  const m = asObject(msg);
  if (!m) return;
  for (const key of ["engine", "fuel", "wheels", "booster"] as const) {
    const v = m[key];
    if (v === "" || isId(v)) p[key] = v as string;
  }
  for (const key of ["wagons", "golden"] as const) {
    const v = m[key];
    if (finite(v)) p[key] = Math.floor(clamp(v, 0, CART_BOUNDS.wagons));
  }
}

// `setAvatar` { avatar, outfit }: the Bloxity look as an opaque JSON string and the outfit key
// ("" = default), both length-capped. Also read from the join options.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const m = asObject(msg);
  if (!m) return;
  if (typeof m.avatar === "string" && m.avatar.length <= AVATAR_MAX_LEN) p.avatar = m.avatar;
  if (typeof m.outfit === "string" && m.outfit.length <= OUTFIT_MAX_LEN) p.outfit = m.outfit;
}

// `emote` { id }: the emote the portal's wheel is playing ("" = stopped). True when accepted (the
// room then bumps emoteSeq so a repeat restarts the clip).
export function applyEmote(p: PlayerState, msg: unknown): boolean {
  const id = asObject(msg)?.id;
  if (id !== "" && !(typeof id === "string" && EMOTE_PATTERN.test(id))) return false;
  p.emote = id;
  p.emoteSeq = (p.emoteSeq + 1) & 0xffff;
  return true;
}
