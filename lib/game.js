// Pure game logic for a two-player craps duel (shooter vs. fader) with real chip denominations.
// All money is in integer cents. No networking here so it can be unit tested on its own.

import { randomInt } from "node:crypto";

export const DENOMS = Object.freeze([1000, 500, 300, 100, 50]); // $10, $5, $3, $1, 50¢ (cents)
export const DEFAULT_BUY_IN = 5000; // $50
export const MIN_BUY_IN = 100;
export const MAX_BUY_IN = 1_000_000;

export const PHASES = Object.freeze({
  WAITING: "waiting",   // fewer than two players seated
  BETTING: "betting",   // players place chips; both must match before rolling
  COMEOUT: "comeout",   // shooter's first roll of the round
  POINT: "point",       // point is set, shooter keeps rolling
  RESULT: "result",     // round over, waiting for "next round"
});

// ---------- chip helpers ----------
export function emptyStack() {
  const s = {};
  for (const d of DENOMS) s[d] = 0;
  return s;
}

export function stackValue(stack) {
  let v = 0;
  for (const d of DENOMS) v += d * (stack[d] || 0);
  return v;
}

export function stackCount(stack) {
  let n = 0;
  for (const d of DENOMS) n += stack[d] || 0;
  return n;
}

export function addStacks(a, b) {
  const out = emptyStack();
  for (const d of DENOMS) out[d] = (a[d] || 0) + (b[d] || 0);
  return out;
}

export function fitsIn(part, whole) {
  return DENOMS.every((d) => (part[d] || 0) <= (whole[d] || 0));
}

export function subtractStacks(whole, part) {
  if (!fitsIn(part, whole)) throw new Error("Not enough of those chips");
  const out = emptyStack();
  for (const d of DENOMS) out[d] = (whole[d] || 0) - (part[d] || 0);
  return out;
}

/** Sanitize a client-provided stack object into integer counts for known denominations. */
export function normalizeStack(input) {
  const out = emptyStack();
  if (!input || typeof input !== "object") return out;
  for (const d of DENOMS) {
    const n = Math.floor(Number(input[d]));
    if (Number.isFinite(n) && n > 0) out[d] = Math.min(n, 100000);
  }
  return out;
}

/**
 * The dealer's standard breakdown for a buy-in: a sensible mix of denominations.
 * Any amount that is a multiple of 50¢ is representable.
 */
export function breakdown(cents) {
  if (cents % 50 !== 0 || cents < 0) throw new Error("Amounts must be in 50¢ steps");
  const share = { 1000: 0.4, 500: 0.25, 300: 0.15, 100: 0.12, 50: 0.08 };
  const out = emptyStack();
  let used = 0;
  for (const d of DENOMS) {
    const n = Math.floor((cents * share[d]) / d);
    out[d] = n;
    used += n * d;
  }
  let rem = cents - used;
  for (const d of DENOMS) {
    const n = Math.floor(rem / d);
    out[d] += n;
    rem -= n * d;
  }
  return out;
}

/** Pick chips from `rack` summing to exactly `cents`, preferring fewer chips. Returns a stack or null. */
export function pickExact(rack, cents) {
  if (cents === 0) return emptyStack();
  if (cents < 0 || cents % 50 !== 0) return null;
  const units = cents / 50;
  // Bounded knapsack over 50¢ units: best[u] = {count, choice} minimal chips to make u.
  const best = new Array(units + 1).fill(null);
  best[0] = { count: 0, from: -1, denom: 0 };
  for (const d of DENOMS) {
    const step = d / 50;
    const avail = rack[d] || 0;
    if (!avail) continue;
    // Process as bounded: iterate units descending with up to `avail` copies via binary splitting.
    let left = avail;
    let k = 1;
    while (left > 0) {
      const take = Math.min(k, left);
      left -= take;
      k *= 2;
      const w = step * take;
      for (let u = units; u >= w; u--) {
        const prev = best[u - w];
        if (prev && (!best[u] || prev.count + take < best[u].count)) {
          best[u] = { count: prev.count + take, from: u - w, denom: d, n: take };
        }
      }
    }
  }
  if (!best[units]) return null;
  const out = emptyStack();
  let u = units;
  while (u > 0) {
    const b = best[u];
    out[b.denom] += b.n;
    u = b.from;
  }
  return out;
}

// ---------- formatting ----------
export function fmt(cents) {
  const neg = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${neg}$${dollars}` : `${neg}$${dollars}.${String(rem).padStart(2, "0")}`;
}

// ---------- dice ----------
export function rollDie(rng = randomInt) {
  return rng(1, 7); // 1..6
}

/**
 * Resolve a single roll against the current phase/point.
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

// ---------- table / players ----------
export function newPlayer(id, name, buyInCents = DEFAULT_BUY_IN) {
  return {
    id,
    name,
    rack: breakdown(buyInCents),
    bet: emptyStack(),
    ready: false,
    wins: 0,
    losses: 0,
    net: 0,          // lifetime cents won minus cents lost
    boughtIn: buyInCents,
    connected: true,
  };
}

export function newTable(code) {
  return {
    code,
    ownerId: null,
    buyIn: DEFAULT_BUY_IN,
    players: [],        // seat 0 and seat 1
    shooterIdx: 0,
    phase: PHASES.WAITING,
    point: null,
    lastRoll: null,     // { d1, d2, total }
    rolls: [],          // totals in the current round
    round: 0,
    lastResult: null,   // { winnerIdx, loserIdx, reason, amount, pot }
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

export function potValue(table) {
  return table.players.reduce((s, p) => s + stackValue(p.bet), 0);
}

export function isOwner(table, seat) {
  const p = table.players[seat];
  return !!p && p.id === table.ownerId;
}

function requirePhase(table, phases, msg) {
  if (!phases.includes(table.phase)) throw new Error(msg);
}

const BETWEEN_ROUNDS = [PHASES.WAITING, PHASES.BETTING, PHASES.RESULT];

/** Owner sets the buy-in (applies to future buy-ins and rebuys). */
export function setBuyIn(table, seat, cents) {
  if (!isOwner(table, seat)) throw new Error("Only the table owner can change the buy-in");
  requirePhase(table, BETWEEN_ROUNDS, "Wait until the round is over");
  const n = Math.round(Number(cents));
  if (!Number.isFinite(n) || n < MIN_BUY_IN || n > MAX_BUY_IN) throw new Error(`Buy-in must be between ${fmt(MIN_BUY_IN)} and ${fmt(MAX_BUY_IN)}`);
  if (n % 50 !== 0) throw new Error("Buy-in must be a multiple of 50¢");
  table.buyIn = n;
  addLog(table, `${table.players[seat].name} set the buy-in to ${fmt(n)}`);
}

/** Seat a player. Returns their seat index. Throws if the table is full. */
export function seatPlayer(table, player) {
  if (table.players.length >= 2) throw new Error("Table is full");
  table.players.push(player);
  if (!table.ownerId) table.ownerId = player.id;
  addLog(table, `${player.name} sat down and bought in for ${fmt(player.boughtIn)}`);
  if (table.players.length === 2 && table.phase === PHASES.WAITING) startBetting(table);
  return table.players.length - 1;
}

export function startBetting(table) {
  table.phase = PHASES.BETTING;
  table.point = null;
  table.rolls = [];
  table.lastRoll = null;
  table.round += 1;
  for (const p of table.players) {
    p.bet = emptyStack();
    p.ready = false;
  }
  addLog(table, `Round ${table.round}: ${table.players[table.shooterIdx].name} has the dice. Place your bets.`);
}

function resetReady(table, seat) {
  if (table.players[seat]) table.players[seat].ready = false;
}

/** If both players are in with equal bets, the come-out roll begins. */
function tryStart(table) {
  const [a, b] = table.players;
  if (!a || !b || !a.ready || !b.ready) return false;
  const va = stackValue(a.bet), vb = stackValue(b.bet);
  if (va === 0 || va !== vb) return false;
  table.phase = PHASES.COMEOUT;
  addLog(table, `Bets locked at ${fmt(va)} each. Pot ${fmt(potValue(table))}. ${table.players[table.shooterIdx].name}, roll!`);
  return true;
}

/** Move one chip of `denom` from rack to the bet spot. */
export function placeChip(table, seat, denom) {
  requirePhase(table, [PHASES.BETTING], "Bets are closed for this round");
  const p = table.players[seat];
  const d = Number(denom);
  if (!DENOMS.includes(d)) throw new Error("Unknown chip");
  if (!p.rack[d]) throw new Error(`You have no ${fmt(d)} chips. Exchange with the dealer.`);
  p.rack[d] -= 1;
  p.bet[d] += 1;
  resetReady(table, seat);
}

/** Move one chip of `denom` from the bet spot back to the rack. */
export function removeChip(table, seat, denom) {
  requirePhase(table, [PHASES.BETTING], "Bets are closed for this round");
  const p = table.players[seat];
  const d = Number(denom);
  if (!DENOMS.includes(d)) throw new Error("Unknown chip");
  if (!p.bet[d]) throw new Error("That chip isn't in your bet");
  p.bet[d] -= 1;
  p.rack[d] += 1;
  resetReady(table, seat);
}

export function clearBet(table, seat) {
  requirePhase(table, [PHASES.BETTING], "Bets are closed for this round");
  const p = table.players[seat];
  p.rack = addStacks(p.rack, p.bet);
  p.bet = emptyStack();
  resetReady(table, seat);
}

/** Set the bet to exactly the opponent's amount, making change with the dealer if needed. */
export function matchBet(table, seat) {
  requirePhase(table, [PHASES.BETTING], "Bets are closed for this round");
  const me = table.players[seat];
  const other = table.players[seat === 0 ? 1 : 0];
  if (!other) throw new Error("No one to match");
  const target = stackValue(other.bet);
  if (target === 0) throw new Error("Your opponent hasn't bet yet");
  const total = stackValue(me.rack) + stackValue(me.bet);
  if (total < target) throw new Error(`You only have ${fmt(total)}. Rebuy to cover ${fmt(target)}.`);
  // Return the current bet, then pick exact chips for the target.
  let rack = addStacks(me.rack, me.bet);
  let bet = pickExact(rack, target);
  if (!bet) {
    // Dealer makes change: rebuild both piles from the standard breakdown.
    bet = breakdown(target);
    rack = breakdown(stackValue(rack) - target);
    addLog(table, `Dealer made change for ${me.name}`);
  } else {
    rack = subtractStacks(rack, bet);
  }
  me.rack = rack;
  me.bet = bet;
  me.ready = true; // matching is saying "I'm in"
  addLog(table, `${me.name} matched ${fmt(target)} and is in`);
  tryStart(table);
}

/** Player says "I'm in" at their current bet. The round starts once both are in with equal bets. */
export function setReady(table, seat, ready = true) {
  requirePhase(table, [PHASES.BETTING], "Not in the betting phase");
  const me = table.players[seat];
  if (!ready) {
    me.ready = false;
    return;
  }
  const mine = stackValue(me.bet);
  if (mine === 0) throw new Error("Put some chips up first");
  me.ready = true;
  addLog(table, `${me.name} is in for ${fmt(mine)}`);
  tryStart(table);
}

/** Trade chips with the dealer: give some chips, get back the same value in other chips. */
export function exchange(table, seat, giveIn, receiveIn) {
  requirePhase(table, BETWEEN_ROUNDS, "You can exchange chips between rounds");
  const p = table.players[seat];
  const give = normalizeStack(giveIn);
  const receive = normalizeStack(receiveIn);
  if (stackCount(give) === 0 || stackCount(receive) === 0) throw new Error("Choose chips to give and chips to receive");
  if (stackValue(give) !== stackValue(receive)) {
    throw new Error(`Those don't match: giving ${fmt(stackValue(give))}, receiving ${fmt(stackValue(receive))}`);
  }
  if (!fitsIn(give, p.rack)) throw new Error("You don't have those chips in your rack");
  p.rack = addStacks(subtractStacks(p.rack, give), receive);
  addLog(table, `${p.name} exchanged ${fmt(stackValue(give))} in chips with the dealer`);
}

/** Shooter rolls. Resolves the round when the dice say so. */
export function roll(table, seat, rng = randomInt) {
  requirePhase(table, [PHASES.COMEOUT, PHASES.POINT], "It's not time to roll");
  if (seat !== table.shooterIdx) throw new Error("Only the shooter can roll");
  const d1 = rollDie(rng);
  const d2 = rollDie(rng);
  const total = d1 + d2;
  const res = resolveRoll(table.phase, table.point, total);
  table.lastRoll = { d1, d2, total };
  table.rolls.push(total);
  addLog(table, `${table.players[table.shooterIdx].name} rolled ${d1} + ${d2} = ${total}. ${res.reason}.`);
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
  const amount = stackValue(loser.bet);
  const pot = potValue(table);
  // Winner takes every chip on the table (their own back plus the loser's).
  winner.rack = addStacks(winner.rack, addStacks(winner.bet, loser.bet));
  winner.bet = emptyStack();
  loser.bet = emptyStack();
  winner.wins += 1;
  winner.net += amount;
  loser.losses += 1;
  loser.net -= amount;
  table.lastResult = { winnerIdx, loserIdx, reason, amount, pot };
  table.phase = PHASES.RESULT;
  addLog(table, `${winner.name} wins ${fmt(amount)} from ${loser.name}. ${reason}.`);
}

/** Move to the next round: dice pass to the other player. */
export function nextRound(table) {
  requirePhase(table, [PHASES.RESULT], "The round isn't over yet");
  if (table.players.length < 2) {
    table.phase = PHASES.WAITING;
    return;
  }
  table.shooterIdx = faderIdx(table);
  startBetting(table);
}

/** Buy in again for the table's buy-in amount. */
export function rebuy(table, seat) {
  requirePhase(table, BETWEEN_ROUNDS, "Wait until the round is over to rebuy");
  const p = table.players[seat];
  p.rack = addStacks(p.rack, breakdown(table.buyIn));
  p.boughtIn += table.buyIn;
  addLog(table, `${p.name} bought in for another ${fmt(table.buyIn)}`);
}

/** Remove a player who left for good; returns bets and ends any live round. */
export function removePlayer(table, seat) {
  const p = table.players[seat];
  if (!p) return;
  addLog(table, `${p.name} left the table`);
  for (const q of table.players) {
    q.rack = addStacks(q.rack, q.bet);
    q.bet = emptyStack();
    q.ready = false;
  }
  table.players.splice(seat, 1);
  if (table.ownerId === p.id) table.ownerId = table.players[0]?.id || null;
  table.shooterIdx = 0;
  table.phase = PHASES.WAITING;
  table.point = null;
  table.rolls = [];
}
