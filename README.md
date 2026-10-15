# Craps Duel

A two-player online craps table. Each of you opens the same link from your own computer, sits down, and takes turns as the shooter. Winner takes the pot; wins, losses and net chips are tracked for both players.

## Rules

Each round both players put up the **same stake** (you pick the amount, from 5 chips up to the smaller stack at the table). Then the shooter rolls:

| Come-out roll | Result |
| --- | --- |
| 7 or 11 | Shooter wins the pot instantly |
| 2, 3 or 12 | Shooter craps out, the other player takes the pot |
| 4, 5, 6, 8, 9, 10 | That number becomes the **point** |

With a point set, the shooter keeps rolling. Hitting the point wins; rolling a 7 first ("seven-out") loses. Every other number does nothing.

After each round the dice pass to the other player. Everyone starts with 1000 chips and can rebuy 1000 if they bust.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open the page, enter a name, leave the table code blank, and click **Sit down**. Click **Copy invite link** and send it to your opponent. When they open it and sit down, the first round starts.

## Playing from two different computers

The server has to be reachable by both players. Pick one:

**Same Wi-Fi / LAN**: run `npm start` on one machine and have the other open `http://<your-local-ip>:3000`.

**Over the internet, no deploy** (quickest): run the server locally and tunnel it.

```bash
npm start
# in another terminal, any one of:
npx localtunnel --port 3000
ngrok http 3000
cloudflared tunnel --url http://localhost:3000
tailscale serve 3000        # if you both use Tailscale
```

Send the https URL the tunnel prints. WebSockets work through all of these.

**Deploy it for free** so it's always up:

- **Render**: this repo includes `render.yaml`. New → Blueprint → point it at this repo.
- **Railway / Fly.io / any Docker host**: a `Dockerfile` is included. The server listens on `$PORT`.
- **Glitch / Replit**: import the repo and press run.

## Options

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | HTTP + WebSocket port |
| `STARTING_CHIPS` | 1000 | Chips each player sits down with |

## Notes

- Your seat survives a refresh or a dropped connection (a token is kept in the browser's local storage). Click **Leave** to give it up.
- A third person opening the link watches as a spectator.
- Tables live in memory on the server. Restarting the server resets all chips and stats.
- Space bar rolls when it's your turn.

## Development

```bash
npm test           # rules + chip accounting unit tests
npm run dev        # restart server on file change
```

- `lib/game.js` – pure game logic (rules, chips, turns), no networking
- `server.js` – static file server + WebSocket rooms
- `public/index.html` – the whole client
