// Craps Duel server: serves the client and runs tables over WebSockets.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import * as G from "./lib/game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_BUY_IN = Number(process.env.DEFAULT_BUY_IN) || G.DEFAULT_BUY_IN;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- static files ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, tables: tables.size }));
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // Any unknown path serves the app so /ROOMCODE links work.
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) {
          res.writeHead(404);
          return res.end("not found");
        }
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- tables ----------
/** @type {Map<string, {table: object, sockets: Set<WebSocket>, tokens: Map<string, string>, cleanup?: NodeJS.Timeout}>} */
const tables = new Map();

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += alphabet[randomBytes(1)[0] % alphabet.length];
  return tables.has(code) ? makeCode() : code;
}

function getRoom(code) {
  let room = tables.get(code);
  if (!room) {
    room = { table: G.newTable(code), sockets: new Set(), tokens: new Map() };
    room.table.buyIn = DEFAULT_BUY_IN;
    tables.set(code, room);
  }
  if (room.cleanup) {
    clearTimeout(room.cleanup);
    room.cleanup = undefined;
  }
  return room;
}

function scheduleCleanup(room) {
  if (room.sockets.size > 0) return;
  room.cleanup = setTimeout(() => {
    if (room.sockets.size === 0) tables.delete(room.table.code);
  }, 30 * 60 * 1000); // keep an empty table around 30 min so a refresh doesn't lose it
}

function seatOf(room, playerId) {
  return room.table.players.findIndex((p) => p.id === playerId);
}

function publicState(room, ws) {
  const t = room.table;
  const mySeat = ws.playerId ? seatOf(room, ws.playerId) : -1;
  return {
    type: "state",
    you: mySeat,
    spectators: [...room.sockets].filter((s) => !s.playerId || seatOf(room, s.playerId) < 0).length,
    table: {
      code: t.code,
      phase: t.phase,
      ownerSeat: t.players.findIndex((p) => p.id === t.ownerId),
      buyIn: t.buyIn,
      denoms: G.DENOMS,
      shooterIdx: t.shooterIdx,
      pot: G.potValue(t),
      point: t.point,
      lastRoll: t.lastRoll,
      rolls: t.rolls,
      round: t.round,
      lastResult: t.lastResult,
      rolloff: t.rolloff,
      firstRoll: t.firstRoll,
      log: t.log.slice(-25),
      players: t.players.map((p) => ({
        name: p.name,
        rack: p.rack,
        bet: p.bet,
        bankroll: G.stackValue(p.rack) + G.stackValue(p.bet),
        ready: p.ready,
        wins: p.wins,
        losses: p.losses,
        net: p.net,
        boughtIn: p.boughtIn,
        connected: p.connected,
      })),
    },
  };
}

function broadcast(room) {
  for (const ws of room.sockets) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(publicState(room, ws)));
  }
}

function sendError(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message }));
}

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, "Bad message");
    }
    try {
      handle(ws, msg);
    } catch (err) {
      sendError(ws, err.message || String(err));
      if (ws.room) broadcast(ws.room);
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;
    room.sockets.delete(ws);
    const seat = ws.playerId ? seatOf(room, ws.playerId) : -1;
    if (seat >= 0) {
      room.table.players[seat].connected = false;
      G.addLog(room.table, `${room.table.players[seat].name} disconnected (seat held for reconnect)`);
    }
    broadcast(room);
    scheduleCleanup(room);
  });
});

function handle(ws, msg) {
  if (msg.type === "join") {
    const name = String(msg.name || "").trim().slice(0, 20) || "Player";
    let code = String(msg.room || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!code) code = makeCode();
    const room = getRoom(code);
    ws.room = room;
    room.sockets.add(ws);

    // Reconnect with a token -> reclaim seat.
    const token = typeof msg.token === "string" ? msg.token : null;
    let playerId = token ? room.tokens.get(token) : null;
    let seat = playerId ? seatOf(room, playerId) : -1;

    if (seat >= 0) {
      ws.playerId = playerId;
      const p = room.table.players[seat];
      p.connected = true;
      if (name && name !== p.name) p.name = name;
      G.addLog(room.table, `${p.name} reconnected`);
      ws.token = token;
    } else if (room.table.players.length < 2 && !msg.spectate) {
      playerId = randomBytes(8).toString("hex");
      const newToken = randomBytes(16).toString("hex");
      room.tokens.set(newToken, playerId);
      ws.playerId = playerId;
      ws.token = newToken;
      // The person opening a table picks its buy-in.
      if (room.table.ownerId === null && msg.buyIn != null) {
        const cents = Math.round(Number(msg.buyIn));
        if (Number.isFinite(cents) && cents >= G.MIN_BUY_IN && cents <= G.MAX_BUY_IN && cents % 50 === 0) {
          room.table.buyIn = cents;
        }
      }
      G.seatPlayer(room.table, G.newPlayer(playerId, name, room.table.buyIn));
    } else {
      ws.playerId = null; // spectator
    }
    ws.send(JSON.stringify({ type: "joined", room: code, token: ws.token || null, seat: ws.playerId ? seatOf(room, ws.playerId) : -1 }));
    return broadcast(room);
  }

  const room = ws.room;
  if (!room) throw new Error("Join a table first");
  const seat = ws.playerId ? seatOf(room, ws.playerId) : -1;
  const t = room.table;

  switch (msg.type) {
    case "setBuyIn":
      requireSeat(seat);
      G.setBuyIn(t, seat, msg.cents);
      break;
    case "placeChip":
      requireSeat(seat);
      G.placeChip(t, seat, msg.denom);
      break;
    case "removeChip":
      requireSeat(seat);
      G.removeChip(t, seat, msg.denom);
      break;
    case "clearBet":
      requireSeat(seat);
      G.clearBet(t, seat);
      break;
    case "matchBet":
      requireSeat(seat);
      G.matchBet(t, seat);
      break;
    case "allIn":
      requireSeat(seat);
      G.allIn(t, seat);
      break;
    case "ready":
      requireSeat(seat);
      G.setReady(t, seat, msg.ready !== false);
      break;
    case "exchange":
      requireSeat(seat);
      G.exchange(t, seat, msg.give, msg.receive);
      break;
    case "roll":
      requireSeat(seat);
      if (t.phase === G.PHASES.ROLLOFF) G.rollForFirst(t, seat);
      else G.roll(t, seat);
      break;
    case "nextRound":
      requireSeat(seat);
      G.nextRound(t);
      break;
    case "rebuy":
      requireSeat(seat);
      G.rebuy(t, seat);
      break;
    case "leave":
      if (seat >= 0) {
        room.tokens.delete(ws.token);
        G.removePlayer(t, seat);
        ws.playerId = null;
        ws.token = null;
      }
      break;
    case "ping":
      return; // keepalive from client, no state change
    default:
      throw new Error(`Unknown action "${msg.type}"`);
  }
  broadcast(room);
}

function requireSeat(seat) {
  if (seat < 0) throw new Error("You're spectating; the table is full");
}

// Heartbeat to drop dead sockets (free the seat for reconnect).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Craps Duel listening on http://localhost:${PORT}`);
});
