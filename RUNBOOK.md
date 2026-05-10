# Demo runbook

Two terminals.

```bash
# Terminal 1 — Cloudflare tunnel (prints a public URL each session)
cloudflared tunnel --url http://localhost:3000

# Terminal 2 — Next.js (loads .env.local with API keys + Fly relay URL)
cd /Users/matthewlones/git/soon2026 && npm run dev
```

On the laptop, open the URL Terminal 1 printed + `/scan`:

```
https://<words>.trycloudflare.com/scan
```

Use it normally — AI, design the room, then 🎉 **start party** → phones scan QR.

Phones auto-connect to:

- **Page**: the Cloudflare URL above (regenerates each session)
- **WebSocket**: `wss://relay-drifting-sunrise-6481.fly.dev/ws` (stable, in `.env.local`)

Done? Ctrl-C both terminals.
