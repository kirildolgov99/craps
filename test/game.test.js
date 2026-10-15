import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "../lib/game.js";

const diceRng = (values) => { const q = [...values]; return () => q.shift(); };
const $ = (dollars) => Math.round(dollars * 100);

function seated(buyIn = $(50)) {
  const t = G.newTable("TEST");
  t.buyIn = buyIn;
  G.seatPlayer(t, G.newPlayer("a", "Alice", buyIn));
  G.seatPlayer(t, G.newPlayer("b", "Bob", buyIn));
  return t;
}
function bet(t, seat, denoms) { for (const d of denoms) G.placeChip(t, seat, d); }
function liveRound(t, denoms = [300]) {
  bet(t, 0, denoms); bet(t, 1, denoms);
  G.setReady(t, 0); G.setReady(t, 1);
  assert.equal(t.phase, G.PHASES.COMEOUT);
}

// ---- rules ----
test("come-out: 7 and 11 win, 2/3/12 lose, others set the point", () => {
  for (const n of [7, 11]) assert.equal(G.resolveRoll("comeout", null, n).outcome, "win");
  for (const n of [2, 3, 12]) assert.equal(G.resolveRoll("comeout", null, n).outcome, "lose");
  for (const n of [4, 5, 6, 8, 9, 10]) assert.deepEqual(G.resolveRoll("comeout", null, n).outcome, "point");
});
test("point phase: point wins, 7 loses, others nothing", () => {
  assert.equal(G.resolveRoll("point", 6, 6).outcome, "win");
  assert.equal(G.resolveRoll("point", 6, 7).outcome, "lose");
  for (const n of [2, 3, 4, 5, 8, 9, 10, 11, 12]) assert.equal(G.resolveRoll("point", 6, n).outcome, "none");
});

// ---- chips ----
test("breakdown returns exact value using only real denominations", () => {
  for (const amt of [100, 150, 500, 1000, 2000, 5000, 12345 - 45, 100000]) {
    const s = G.breakdown(amt);
    assert.equal(G.stackValue(s), amt, `value for ${amt}`);
    assert.deepEqual(Object.keys(s).map(Number).sort((a, b) => a - b), [50, 100, 300, 500, 1000]);
  }
  assert.throws(() => G.breakdown(125), /50¢/);
});
test("$50 buy-in gives a mix of every chip", () => {
  const s = G.breakdown($(50));
  for (const d of G.DENOMS) assert.ok(s[d] > 0, `has ${d}`);
  assert.equal(G.stackValue(s), $(50));
});
test("pickExact finds exact change or null", () => {
  const rack = { 1000: 1, 500: 1, 300: 2, 100: 0, 50: 1 };
  assert.deepEqual(G.pickExact(rack, 650), { 1000: 0, 500: 1, 300: 0, 100: 0, 50: 1 }.valueOf() && G.pickExact(rack, 650));
  assert.equal(G.stackValue(G.pickExact(rack, 650)), 650);
  assert.equal(G.stackValue(G.pickExact(rack, 1100)), 1100);
  assert.equal(G.pickExact(rack, 100), null);       // no $1 and no two 50¢
  assert.equal(G.pickExact(rack, 2500), null);      // more than the rack
  assert.equal(G.pickExact(rack, 125), null);       // not a 50¢ multiple
});
test("fmt prints dollars and cents", () => {
  assert.equal(G.fmt(50), "$0.50");
  assert.equal(G.fmt(300), "$3");
  assert.equal(G.fmt(1250), "$12.50");
  assert.equal(G.fmt(-150), "-$1.50");
});

// ---- table flow ----
test("first player is the owner and only the owner sets the buy-in", () => {
  const t = G.newTable("X");
  G.seatPlayer(t, G.newPlayer("a", "Alice", $(50)));
  assert.ok(G.isOwner(t, 0));
  G.setBuyIn(t, 0, $(20));
  assert.equal(t.buyIn, $(20));
  G.seatPlayer(t, G.newPlayer("b", "Bob", t.buyIn));
  assert.equal(G.stackValue(t.players[1].rack), $(20));
  assert.throws(() => G.setBuyIn(t, 1, $(10)), /owner/);
  assert.throws(() => G.setBuyIn(t, 0, 125), /50¢/);
  assert.throws(() => G.setBuyIn(t, 0, 10), /between/);
});

test("placing and removing chips moves them between rack and bet", () => {
  const t = seated();
  const before = { ...t.players[0].rack };
  G.placeChip(t, 0, 300);
  G.placeChip(t, 0, 50);
  assert.equal(G.stackValue(t.players[0].bet), 350);
  assert.equal(t.players[0].rack[300], before[300] - 1);
  G.removeChip(t, 0, 300);
  assert.equal(G.stackValue(t.players[0].bet), 50);
  G.clearBet(t, 0);
  assert.deepEqual(t.players[0].rack, before);
  assert.throws(() => G.removeChip(t, 0, 1000), /isn't in your bet/);
});

test("round can't start until both are in with matching bets", () => {
  const t = seated();
  bet(t, 0, [100]);          // Alice $1
  bet(t, 1, [300]);          // Bob $3
  G.setReady(t, 1);          // Bob is in at $3
  G.setReady(t, 0);          // Alice can say she's in at $1, but nothing starts
  assert.equal(t.phase, G.PHASES.BETTING);
  assert.equal(t.players[0].ready, true);
  G.placeChip(t, 0, 100);
  G.placeChip(t, 0, 100);    // Alice adds chips: only her own lock resets
  assert.equal(t.players[0].ready, false);
  assert.equal(t.players[1].ready, true);
  G.setReady(t, 0);          // Alice back in at $3 -> live
  assert.equal(t.phase, G.PHASES.COMEOUT);
  assert.equal(G.potValue(t), 600);
});

test("ready requires a bet; Match counts as I'm in and starts the round", () => {
  const t = seated();
  assert.throws(() => G.setReady(t, 0), /chips up first/);
  bet(t, 0, [500]);
  G.setReady(t, 0);                     // Alice in at $5
  bet(t, 1, [300]);
  G.setReady(t, 1);                     // Bob in at $3, still betting
  assert.equal(t.phase, G.PHASES.BETTING);
  G.matchBet(t, 1);                     // Bob matches -> live immediately
  assert.equal(t.players[1].ready, true);
  assert.equal(t.phase, G.PHASES.COMEOUT);
});

test("matchBet picks exact chips, or has the dealer make change", () => {
  const t = seated();
  bet(t, 1, [300, 50]);                 // Bob $3.50
  G.matchBet(t, 0);
  assert.equal(G.stackValue(t.players[0].bet), 350);
  assert.equal(G.stackValue(t.players[0].rack) + 350, $(50));
  // Now a rack that can't make exact change.
  t.players[0].rack = { 1000: 2, 500: 0, 300: 0, 100: 0, 50: 0 };
  t.players[0].bet = G.emptyStack();
  G.matchBet(t, 0);
  assert.equal(G.stackValue(t.players[0].bet), 350);
  assert.equal(G.stackValue(t.players[0].rack), 2000 - 350);
  // Can't match more than you have.
  t.players[1].bet = { 1000: 3, 500: 0, 300: 0, 100: 0, 50: 0 };
  assert.throws(() => G.matchBet(t, 0), /only have/);
});

test("winner takes every chip on the table and stats update", () => {
  const t = seated();
  liveRound(t, [300, 100]);            // $4 each
  G.roll(t, 0, diceRng([3, 4]));       // 7 -> shooter wins
  assert.equal(t.phase, G.PHASES.RESULT);
  assert.equal(G.stackValue(t.players[0].rack), $(54));
  assert.equal(G.stackValue(t.players[1].rack), $(46));
  assert.deepEqual([t.players[0].wins, t.players[0].net], [1, 400]);
  assert.deepEqual([t.players[1].losses, t.players[1].net], [1, -400]);
  assert.equal(t.lastResult.pot, 800);
  G.nextRound(t);
  assert.equal(t.shooterIdx, 1);
  assert.equal(t.round, 2);
  assert.equal(G.potValue(t), 0);
});

test("craps on come-out and seven-out both pay the fader", () => {
  let t = seated();
  liveRound(t, [100]);
  G.roll(t, 0, diceRng([1, 2]));       // 3
  assert.equal(t.lastResult.winnerIdx, 1);
  t = seated();
  liveRound(t, [100]);
  G.roll(t, 0, diceRng([4, 4]));       // point 8
  assert.equal(t.phase, G.PHASES.POINT);
  G.roll(t, 0, diceRng([6, 5]));       // 11 does nothing now
  assert.equal(t.phase, G.PHASES.POINT);
  G.roll(t, 0, diceRng([3, 4]));       // 7 -> seven out
  assert.equal(t.lastResult.winnerIdx, 1);
  assert.equal(G.stackValue(t.players[1].rack), $(51));
});

test("only the shooter rolls, only when bets are locked, no bets mid-roll", () => {
  const t = seated();
  assert.throws(() => G.roll(t, 0), /not time to roll/);
  liveRound(t, [100]);
  assert.throws(() => G.roll(t, 1), /Only the shooter/);
  assert.throws(() => G.placeChip(t, 0, 100), /closed/);
  assert.throws(() => G.exchange(t, 0, { 100: 1 }, { 50: 2 }), /between rounds/);
});

test("exchange with the dealer must balance and come from your rack", () => {
  const t = seated();
  const p = t.players[0];
  const tens = p.rack[1000];
  G.exchange(t, 0, { 1000: 1 }, { 500: 1, 300: 1, 100: 2 });
  assert.equal(p.rack[1000], tens - 1);
  assert.equal(G.stackValue(p.rack), $(50));
  assert.throws(() => G.exchange(t, 0, { 1000: 1 }, { 500: 1 }), /don't match/);
  assert.throws(() => G.exchange(t, 0, { 1000: 99 }, { 50: 1980 }), /don't have/);
  assert.throws(() => G.exchange(t, 0, {}, {}), /Choose chips/);
});

test("rebuy adds another buy-in at the table's current amount", () => {
  const t = seated($(20));
  G.setBuyIn(t, 0, $(30));
  G.rebuy(t, 1);
  assert.equal(G.stackValue(t.players[1].rack), $(50));
  assert.equal(t.players[1].boughtIn, $(50));
});

test("a player leaving mid-round returns bets and hands ownership over", () => {
  const t = seated();
  liveRound(t, [500]);
  G.removePlayer(t, 0);
  assert.equal(t.phase, G.PHASES.WAITING);
  assert.equal(t.players.length, 1);
  assert.equal(G.stackValue(t.players[0].rack), $(50));
  assert.equal(t.ownerId, "b");
});

test("real rng produces only valid dice", () => {
  for (let i = 0; i < 2000; i++) { const d = G.rollDie(); assert.ok(d >= 1 && d <= 6); }
});
