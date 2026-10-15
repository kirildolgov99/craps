import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "../lib/game.js";

// Deterministic rng: returns dice from a queue.
function diceRng(values) {
  const q = [...values];
  return () => {
    if (!q.length) throw new Error("rng queue empty");
    return q.shift();
  };
}

function freshTable(stake = 50) {
  const t = G.newTable("TEST");
  G.seatPlayer(t, G.newPlayer("a", "Alice", 1000));
  G.seatPlayer(t, G.newPlayer("b", "Bob", 1000));
  G.setStake(t, 0, stake);
  G.putUp(t, 0);
  G.putUp(t, 1);
  return t;
}

test("come-out: 7 and 11 are instant wins", () => {
  for (const total of [7, 11]) {
    assert.equal(G.resolveRoll(G.PHASES.COMEOUT, null, total).outcome, "win");
  }
});

test("come-out: 2, 3, 12 are instant losses", () => {
  for (const total of [2, 3, 12]) {
    assert.equal(G.resolveRoll(G.PHASES.COMEOUT, null, total).outcome, "lose");
  }
});

test("come-out: 4,5,6,8,9,10 set the point", () => {
  for (const total of [4, 5, 6, 8, 9, 10]) {
    const r = G.resolveRoll(G.PHASES.COMEOUT, null, total);
    assert.equal(r.outcome, "point");
    assert.equal(r.point, total);
  }
});

test("point phase: hitting point wins, 7 loses, others nothing", () => {
  assert.equal(G.resolveRoll(G.PHASES.POINT, 6, 6).outcome, "win");
  assert.equal(G.resolveRoll(G.PHASES.POINT, 6, 7).outcome, "lose");
  for (const total of [2, 3, 4, 5, 8, 9, 10, 11, 12]) {
    assert.equal(G.resolveRoll(G.PHASES.POINT, 6, total).outcome, "none");
  }
});

test("two players seated moves table into betting", () => {
  const t = G.newTable("X");
  G.seatPlayer(t, G.newPlayer("a", "Alice"));
  assert.equal(t.phase, G.PHASES.WAITING);
  G.seatPlayer(t, G.newPlayer("b", "Bob"));
  assert.equal(t.phase, G.PHASES.BETTING);
  assert.equal(t.round, 1);
  assert.throws(() => G.seatPlayer(t, G.newPlayer("c", "Carol")), /full/);
});

test("putting up chips moves them to the pot and starts the come-out", () => {
  const t = freshTable(50);
  assert.equal(t.phase, G.PHASES.COMEOUT);
  assert.equal(t.pot, 100);
  assert.equal(t.players[0].chips, 950);
  assert.equal(t.players[1].chips, 950);
});

test("shooter wins natural: pot and stats go to shooter, then dice pass", () => {
  const t = freshTable(50);
  G.roll(t, 0, diceRng([3, 4])); // 7
  assert.equal(t.phase, G.PHASES.RESULT);
  assert.equal(t.players[0].chips, 1050);
  assert.equal(t.players[1].chips, 950);
  assert.deepEqual([t.players[0].wins, t.players[0].net], [1, 50]);
  assert.deepEqual([t.players[1].losses, t.players[1].net], [1, -50]);
  assert.equal(t.lastResult.winnerIdx, 0);
  G.nextRound(t);
  assert.equal(t.shooterIdx, 1);
  assert.equal(t.phase, G.PHASES.BETTING);
  assert.equal(t.round, 2);
});

test("shooter craps out: fader takes pot", () => {
  const t = freshTable(50);
  G.roll(t, 0, diceRng([1, 1])); // 2
  assert.equal(t.phase, G.PHASES.RESULT);
  assert.equal(t.lastResult.winnerIdx, 1);
  assert.equal(t.players[1].chips, 1050);
  assert.equal(t.players[0].chips, 950);
});

test("point set, then made: shooter wins", () => {
  const t = freshTable(100);
  G.roll(t, 0, diceRng([4, 4])); // 8 -> point
  assert.equal(t.phase, G.PHASES.POINT);
  assert.equal(t.point, 8);
  G.roll(t, 0, diceRng([1, 1])); // 2 does nothing with a point on
  assert.equal(t.phase, G.PHASES.POINT);
  G.roll(t, 0, diceRng([5, 6])); // 11 does nothing with a point on
  assert.equal(t.phase, G.PHASES.POINT);
  G.roll(t, 0, diceRng([6, 2])); // 8 -> made the point
  assert.equal(t.phase, G.PHASES.RESULT);
  assert.equal(t.lastResult.winnerIdx, 0);
  assert.equal(t.players[0].chips, 1100);
});

test("point set, then seven-out: fader wins", () => {
  const t = freshTable(100);
  G.roll(t, 0, diceRng([2, 2])); // 4 -> point
  G.roll(t, 0, diceRng([3, 4])); // 7 -> seven out
  assert.equal(t.phase, G.PHASES.RESULT);
  assert.equal(t.lastResult.winnerIdx, 1);
  assert.equal(t.players[1].chips, 1100);
});

test("only the shooter can roll and only when it's time", () => {
  const t = freshTable(50);
  assert.throws(() => G.roll(t, 1, diceRng([1, 1])), /Only the shooter/);
  G.roll(t, 0, diceRng([3, 4]));
  assert.throws(() => G.roll(t, 0, diceRng([3, 4])), /not time to roll/);
});

test("stake is capped by the smaller stack and changing it refunds committed chips", () => {
  const t = G.newTable("X");
  G.seatPlayer(t, G.newPlayer("a", "Alice", 1000));
  G.seatPlayer(t, G.newPlayer("b", "Bob", 200));
  assert.throws(() => G.setStake(t, 0, 500), /can't exceed 200/);
  assert.throws(() => G.setStake(t, 0, 1), /Minimum/);
  G.setStake(t, 0, 100);
  G.putUp(t, 0);
  assert.equal(t.players[0].chips, 900);
  G.setStake(t, 1, 200); // Bob bumps the stake; Alice's 100 is refunded, she must re-commit
  assert.equal(t.players[0].chips, 1000);
  assert.equal(t.players[0].putUp, false);
  assert.equal(t.pot, 0);
});

test("busted player can rebuy between rounds", () => {
  const t = G.newTable("X");
  G.seatPlayer(t, G.newPlayer("a", "Alice", 1000));
  G.seatPlayer(t, G.newPlayer("b", "Bob", 50));
  G.setStake(t, 0, 50);
  G.putUp(t, 0);
  G.putUp(t, 1);
  G.roll(t, 0, diceRng([5, 6])); // 11, Alice wins, Bob has 0
  assert.equal(t.players[1].chips, 0);
  G.rebuy(t, 1, 1000);
  assert.equal(t.players[1].chips, 1000);
  G.nextRound(t);
  assert.equal(t.stake, 50);
  assert.equal(G.maxStake(t), 1000);
});

test("removing a player mid-round refunds the pot and resets to waiting", () => {
  const t = freshTable(50);
  G.removePlayer(t, 1);
  assert.equal(t.phase, G.PHASES.WAITING);
  assert.equal(t.players.length, 1);
  assert.equal(t.players[0].chips, 1000);
  assert.equal(t.pot, 0);
});

test("real rng produces only valid dice over many rolls", () => {
  for (let i = 0; i < 2000; i++) {
    const d = G.rollDie();
    assert.ok(d >= 1 && d <= 6);
  }
});
