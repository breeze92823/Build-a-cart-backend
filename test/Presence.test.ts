import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { PlayerState, WorldState } from "../src/rooms/schema/WorldState.js";
import { applyAvatar, applyCart, applyEmote, applyLoadout, applyPose } from "../src/presence.js";
import { AVATAR_MAX_LEN, CART_BOUNDS, OUTFIT_MAX_LEN, POSE_BOUNDS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence (units)", () => {
  it("bounds the walking pose", () => {
    const p = new PlayerState();
    applyPose(p, { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3, grounded: false });
    assert.strictEqual(p.x, POSE_BOUNDS.xy);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.z);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "yaw wrapped to -PI..PI");
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.grounded, false);
    applyPose(p, { grounded: "yes" });
    assert.strictEqual(p.grounded, false, "a non-boolean is ignored");
    applyPose(p, null);
    applyPose(p, 5);
  });

  it("bounds the riding cart and validates its enums", () => {
    const p = new PlayerState();
    applyCart(p, { ride: "riding", crash: "", s: 123.5, cy: 7, pitch: 0.2, roll: -0.1, lx: 3, v: -12, throttle: 1, braking: true, boosting: true, air: true, fuelOk: false, tip: 0.5 });
    assert.deepStrictEqual([p.ride, p.crash, p.s, p.cy, p.lx, p.v, p.throttle, p.tip], ["riding", "", 123.5, 7, 3, -12, 1, 0.5]);
    assert.deepStrictEqual([p.braking, p.boosting, p.air, p.fuelOk], [true, true, true, false]);
    assert.ok(Math.abs(p.pitch - 0.2) < 1e-5 && Math.abs(p.roll + 0.1) < 1e-5);

    applyCart(p, { ride: "flying", crash: "Bad Kind!", s: 1e12, cy: -1e9, pitch: 99, roll: -99, lx: 1e6, v: 1e9, throttle: 7, tip: -50, air: "x" });
    assert.strictEqual(p.ride, "riding", "an unknown ride state is ignored");
    assert.strictEqual(p.crash, "", "a malformed crash kind is ignored");
    assert.strictEqual(p.s, CART_BOUNDS.s);
    assert.strictEqual(p.cy, -CART_BOUNDS.cy);
    assert.ok(Math.abs(p.pitch - CART_BOUNDS.angle) < 1e-5 && Math.abs(p.roll + CART_BOUNDS.angle) < 1e-5);
    assert.strictEqual(p.lx, CART_BOUNDS.lx);
    assert.strictEqual(p.v, CART_BOUNDS.v);
    assert.strictEqual(p.throttle, 1);
    assert.strictEqual(p.tip, -CART_BOUNDS.tip);
    assert.strictEqual(p.air, true, "a non-boolean is ignored");

    applyCart(p, { ride: "crashed", crash: "derail" });
    assert.deepStrictEqual([p.ride, p.crash], ["crashed", "derail"]);
  });

  it("bounds the gear and trailing carts", () => {
    const p = new PlayerState();
    applyLoadout(p, { engine: "v8", fuel: "big", wheels: "Bad Id!", booster: "", wagons: 4.9, golden: 2 });
    assert.deepStrictEqual([p.engine, p.fuel, p.wheels, p.booster, p.wagons, p.golden], ["v8", "big", "", "", 4, 2]);
    applyLoadout(p, { wagons: 1e6, golden: -3, engine: "" });
    assert.deepStrictEqual([p.wagons, p.golden, p.engine], [CART_BOUNDS.wagons, 0, ""]);
  });

  it("caps the look and the outfit key", () => {
    const p = new PlayerState();
    applyAvatar(p, { avatar: '{"equipped":{}}', outfit: "abc123" });
    assert.deepStrictEqual([p.avatar, p.outfit], ['{"equipped":{}}', "abc123"]);
    applyAvatar(p, { avatar: "x".repeat(AVATAR_MAX_LEN + 1), outfit: "y".repeat(OUTFIT_MAX_LEN + 1) });
    assert.deepStrictEqual([p.avatar, p.outfit], ['{"equipped":{}}', "abc123"], "oversized values are ignored");
  });

  it("accepts emote ids and bumps the sequence on every accepted message", () => {
    const p = new PlayerState();
    assert.strictEqual(applyEmote(p, { id: "wave_1" }), true);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["wave_1", 1]);
    assert.strictEqual(applyEmote(p, { id: "wave_1" }), true);
    assert.strictEqual(p.emoteSeq, 2, "the same emote restarts");
    assert.strictEqual(applyEmote(p, { id: "" }), true);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["", 3]);
    assert.strictEqual(applyEmote(p, { id: "bad id!" }), false);
    assert.strictEqual(applyEmote(p, { id: 5 }), false);
    assert.strictEqual(applyEmote(p, null), false);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["", 3], "a rejected emote changes nothing");
    p.emoteSeq = 0xffff;
    applyEmote(p, { id: "a" });
    assert.strictEqual(p.emoteSeq, 0, "the counter wraps");
  });
});

describe("presence (room)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("takes the pose, gear and look from the join options", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      userId: "guest-a",
      pose: { x: 3, y: 0.5, z: -12, yaw: Math.PI, speed: 4 },
      loadout: { engine: "v8", fuel: "big", wheels: "rubber", booster: "nitro", wagons: 3, golden: 1 },
      avatar: '{"equipped":{}}',
      outfit: "key1",
    });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed], [3, 0.5, -12, 4]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.deepStrictEqual([p.engine, p.fuel, p.wheels, p.booster, p.wagons, p.golden], ["v8", "big", "rubber", "nitro", 3, 1]);
    assert.deepStrictEqual([p.avatar, p.outfit, p.ride], ['{"equipped":{}}', "key1", "foot"]);
  });

  it("relays pose, cart, loadout, look and emote to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3 });
    a.send("loadout", { engine: "basic", wagons: 2 });
    a.send("cart", { ride: "riding", s: 250.5, cy: 3, v: 40, throttle: 1, boosting: true, air: false, fuelOk: true, tip: 0.3 });
    a.send("setAvatar", { avatar: "x".repeat(AVATAR_MAX_LEN + 1), outfit: "key2" });
    a.send("emote", { id: "dance_2" });
    a.send("emote", { id: "not valid!" });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xy);
    assert.strictEqual(p.y, 0);
    assert.strictEqual(p.avatar, "", "an oversized look is ignored");
    assert.strictEqual(p.outfit, "key2");
    assert.deepStrictEqual([p.ride, p.s, p.v, p.boosting], ["riding", 250.5, 40, true]);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["dance_2", 1]);

    // b's synced copy of the roster sees a's presence.
    const seen = (b.state as any).players.get(a.sessionId);
    assert.deepStrictEqual([seen.engine, seen.wagons, seen.ride, seen.s, seen.boosting, seen.emote], ["basic", 2, "riding", 250.5, true, "dance_2"]);
    assert.strictEqual(seen.x, POSE_BOUNDS.xy);
  });
});
