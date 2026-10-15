// Pure game logic for a two-player craps duel (shooter vs. fader).
// No networking in here so it can be unit tested on its own.

import { randomInt } from "node:crypto";

export const STARTING_CHIPS = 1000;
export const MIN_STAKE = 5;

export const PHASES = Object.freeze({
  WAITING: "waiting",   // fewer than two players seated
  BETTING: "betting",   // both players put chips up for the round
  COMEOUT: "comeout",   // shooter's first roll of the round
  POINT: "point",       // point is set, shooter keeps rolling
  RESULT: "result",     // round over, waiting for "next round"
});

export function rollDie(rng = randomInt) {
  return rng(1, 7); // 1..6
}

/**
 * Resolve a single roll against the current phase/point.
 * Returns { outcome: 'win' | 'lose' | 'point' | 'none', point? }
 *   - On the come-out roll: 7/11 => win, 2/3/12 => lose, else point set.
 *   - With a point: hitting the point => win, 7 => lose, else nothing.
 */
export function resolveRoll(phase, point, total) {
  if (phase === PHASES.COMEOUT) {
    if (total === 7 || total === 11) return { outcome: "win", reason: `Natural ${total} on the come-out` };
    if (total === 2 || total === 3 || total === 12) return { outcome: "lose", reason: `Craps ${total} on the come-out` };
    return { outcome: "point", point: total, reason: `Point is ${total}` };
  }
  if (phase === PHASES.POINT) {
    if (total === point) return { outcome: "win", reason: `Made the point ${point}` };
    if (total === 7) return { outcome: "lose", reason: `Seven out (point was ${point})` };
    return { outcome: "none", reason: `${total}, still looking for ${point}` };
  }
  throw new Error(`Cannot roll during phase "${phase}"`);
}

export function newPlayer(id, name, chips = STARTING_CHIPS) {
  return {
    id,
    name,
    chips,
    wins: 0,
    losses: 0,
    net: 0,        // lifetime chips won minus chips lost
    putUp: false,  // has this player committed their stake for the current round
    connected: true,
  };
}

export function newTable(code) {
  return {
    code,
    players: [],        // seat 0 and seat 1
    shooterIdx: 0,
    phase: PHASES.WAITING,
    stake: 50,          // proposed per-player stake for the round
    pot: 0,
    point: null,
    lastRoll: null,     // { d1, d2, total }
    rolls: [],          // rolls in the current round
    round: 0,
    lastResult: null,   // { winnerIdx, loserIdx, reason, amount }
    log: [],
  };
}

export function addLog(table, text) {
  table.log.push({ t: Date.now(), text });
  if (table.log.length > 60) table.log.splice(0, table.log.length - 60);
}

export function faderIdx(table) {
  return table.shooterIdx === 0 ? 1 : 0;
}

export function maxStake(table) {
  if (table.players.length < 2) return 0;
  return Math.max(0, Math.min(table.players[0].chips, table.players[1].chips));
}

/** Seat a player. Returns their seat index. Throws if the table is full. */
export function seatPlayer(table, player) {
  if (table.players.length >= 2) throw new Error("Table is full");
  table.players.push(player);
  addLog(table, `${player.name} sat down with ${player.chips} chips`);
  if (table.players.length === 2 && table.phase === PHASES.WAITING) {
    startBetting(table);
  }
  return table.players.length - 1;
}

export function startBetting(table) {
  table.phase = PHASES.BETTING;
  table.pot = 0;
  table.point = null;
  table.rolls = [];
  table.lastRoll = null;
  table.round += 1;
  for (const p of table.players) p.putUp = false;
  table.stake = Math.min(table.stake, maxStake(table));
  if (table.stake < MIN_STAKE) table.stake = Math.min(MIN_STAKE, maxStake(table));
  addLog(table, `Round ${table.round}: ${table.players[table.shooterIdx].name} is shooting. Put up your chips.`);
}

/** Either player can change the stake while betting. Resets any chips already put up. */
export function setStake(table, seat, amount) {
  if (table.phase !== PHASES.BETTING) throw new Error("You can only change the stake between rounds");
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n < MIN_STAKE) throw new Error(`Minimum stake is ${MIN_STAKE}`);
  const cap = maxStake(table);
  if (n > cap) throw new Error(`Stake can't exceed ${cap} (the smaller stack at the table)`);
  if (n === table.stake) return;
  // Refund anyone who already committed at the old stake.
  for (const p of table.players) {
    if (p.putUp) {
      p.chips += table.stake;
      p.putUp = false;
    }
  }
  table.pot = 0;
  table.stake = n;
  addLog(table, `${table.players[seat].name} set the stake to ${n}`);
}

/** A player commits their stake into the pot. When both have, the come-out roll begins. */
export function putUp(table, seat) {
  if (table.phase !== PHASES.BETTING) throw new Error("Not in the betting phase");
  const p = table.players[seat];
  if (!p) throw new Error("Not seated");
  if (p.putUp) throw new Error("You already put your chips up");
  if (p.chips < table.stake) throw new Error("Not enough chips for that stake");
  p.chips -= table.stake;
  p.putUp = true;
  table.pot += table.stake;
  addLog(table, `${p.name} put up ${table.stake}`);
  if (table.players.every((q) => q.putUp)) {
    table.phase = PHASES.COMEOUT;
    addLog(table, `Pot is ${table.pot}. ${table.players[table.shooterIdx].name}, roll the dice!`);
  }
}

/** Shooter rolls. Resolves the round when the dice say so. */
export function roll(table, seat, rng = randomInt) {
  if (table.phase !== PHASES.COMEOUT && table.phase !== PHASES.POINT) {
    throw new Error("It's not time to roll");
  }
  if (seat !== table.shooterIdx) throw new Error("Only the shooter can roll");

  const d1 = rollDie(rng);
  const d2 = rollDie(rng);
  const total = d1 + d2;
  const res = resolveRoll(table.phase, table.point, total);
  table.lastRoll = { d1, d2, total };
  table.rolls.push(total);
  const shooter = table.players[table.shooterIdx];
  addLog(table, `${shooter.name} rolled ${d1} + ${d2} = ${total}. ${res.reason}.`);

  if (res.outcome === "point") {
    table.phase = PHASES.POINT;
    table.point = res.point;
  } else if (res.outcome === "win") {
    finishRound(table, table.shooterIdx, res.reason);
  } else if (res.outcome === "lose") {
    finishRound(table, faderIdx(table), res.reason);
  }
  return { d1, d2, total, ...res };
}

export function finishRound(table, winnerIdx, reason) {
  const loserIdx = winnerIdx === 0 ? 1 : 0;
  const winner = table.players[winnerIdx];
  const loser = table.players[loserIdx];
  const amount = table.stake; // what each side risked
  winner.chips += table.pot;
  winner.wins += 1;
  winner.net += amount;
  loser.losses += 1;
  loser.net -= amount;
  table.lastResult = { winnerIdx, loserIdx, reason, amount, pot: table.pot };
  table.pot = 0;
  table.phase = PHASES.RESULT;
  addLog(table, `${winner.name} wins ${amount} from ${loser.name}. ${reason}.`);
}

/** Move to the next round: dice pass to the other player. */
export function nextRound(table) {
  if (table.phase !== PHASES.RESULT) throw new Error("The round isn't over yet");
  if (table.players.length < 2) {
    table.phase = PHASES.WAITING;
    return;
  }
  table.shooterIdx = faderIdx(table);
  startBetting(table);
}

/** Buy back in when busted (or just top up). */
export function rebuy(table, seat, amount = STARTING_CHIPS) {
  const p = table.players[seat];
  if (!p) throw new Error("Not seated");
  if (table.phase !== PHASES.BETTING && table.phase !== PHASES.RESULT && table.phase !== PHASES.WAITING) {
    throw new Error("Wait until the round is over to rebuy");
  }
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid rebuy amount");
  p.chips += n;
  p.net -= 0; // rebuys don't count against net; they're just more ammo
  addLog(table, `${p.name} bought in for ${n} more chips`);
}

/** Remove a player who left for good; refunds a committed stake and ends any live round. */
export function removePlayer(table, seat) {
  const p = table.players[seat];
  if (!p) return;
  addLog(table, `${p.name} left the table`);
  // Refund committed chips to both (round can't continue).
  if (table.phase === PHASES.COMEOUT || table.phase === PHASES.POINT || table.phase === PHASES.BETTING) {
    for (const q of table.players) {
      if (q.putUp) {
        q.chips += table.stake;
        q.putUp = false;
      }
    }
    table.pot = 0;
  }
  table.players.splice(seat, 1);
  table.shooterIdx = 0;
  table.phase = PHASES.WAITING;
  table.point = null;
  table.rolls = [];
}
