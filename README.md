# Grok video pipeline

Async file-based job queue. One job (and only one Grok/whisper/ffmpeg) at a time — designed for a 4GB RAM / 1-2 vCPU VPS.

## Architecture invariants (do not break)

- Single worker loop, strictly serial jobs.
- Fresh `grok` process per image batch, killed after.
- File-backed state only (`jobs/<id>/job.json`). No Redis/Postgres.
- One heavy process system-wide at any moment.

## Quick setup on VPS

```bash
# system
apt-get update && apt-get install -y ffmpeg git build-essential

# whisper.cpp (for transcription)
git clone https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp && make -j$(nproc)
./models/download-ggml-model.sh base.en   # or small.en

# grok CLI (xAI Grok Build). Ensure authenticated (XAI_API_KEY or login)
# The pipeline calls `grok -p "..." --yolo ...` (confirmed via --help + live test)

# app
cd /path/to/pipeline
npm install
cp .env.example .env
# edit .env with your keys, paths, limits
mkdir -p logs
```

## Environment variables

See `.env.example`. Important ones:

- `GROK_BIN`, `WHISPER_BIN`, `WHISPER_MODEL`
- `API_KEYS` (comma list — clients must send `X-API-Key`)
- `MAX_JOBS_PER_DAY`, `MAX_DISK_BYTES`, `JOB_TTL_HOURS`
- `PORT`
- **Grok session cleanup (worker):** `GROK_SESSION_RETENTION_DAYS` (default **2** = 48 hours).
  Periodically deletes old folders under `~/.grok/sessions` (VPS root: `/root/.grok/sessions`).
  Does **not** delete `~/.grok` itself. Override path with `GROK_SESSIONS_DIR`.
- **Optional durable storage:** see `.env.example`. When enabled, the worker uploads
  **all job outputs** to Drive + MongoDB, then deletes local copies after verify.
  **Personal Gmail:** service accounts cannot store files in My Drive — set
  `GOOGLE_DRIVE_AUTH_MODE=oauth`, create an OAuth Desktop client, run `npm run drive:oauth`
  once, then restart server/worker. **Workspace Shared drives** can use a service account.
  Leave `GOOGLE_DRIVE_ENABLED=false` for local-only.

## Running

Use pm2 (recommended) or systemd:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

Or plain:

```bash
node server.js   # in one tmux/screen
node worker.js
```

## API usage (authenticated)

```bash
# Modern usage (recommended)
curl -X POST http://.../api/jobs \
  -H "X-API-Key: $KEY" \
  -F "title=My Video" \
  -F "script=..." \
  -F "media=@input.mp4" \
  -F "characters=[{\"name\":\"Alice\",\"gender\":\"female\"}]" \
  -F "characterImages=@alice.png" \
  -F "characterImages=@bob.png"

# Legacy (still supported)
# -F "referenceImages=@char1.png" -F "referenceImages=@char2.png"
```

Poll `GET /api/jobs/:id` (includes `progress.step`, `progress.batch`, `progress.etaSeconds`).

`DELETE /api/jobs/:id` removes the entire job tree.

Downloads when `status=done`.

## Health & observability

- `GET /health` — returns `{ok, queued}`
- Per-job logs: `jobs/<id>/job.log` (structured lines with timestamps)
- Worker + server logs captured by pm2/systemd

## Deployment (HTTPS reverse proxy)

**Do not** expose Node directly.

- Caddy (easiest LE): see `Caddyfile.example`
- nginx: see `nginx.conf.example` + certbot

Production example domain used in configs: `videofurge.voiceforgeai.site` (update to match your DNS).

Example systemd units are simple `Restart=always` wrappers around the pm2 or direct node commands.

## Verification commands (run these after setup)

See `TESTING.md` for the full procedure. Summary:

1. Grok CLI single image:
   ```
   npm run test:grok
   ```
   Must succeed with a real image written.

2. Long stitch (700+ frames):
   ```
   npm run test:stitch
   ```
   Must complete and report duration match within tolerance.

3. Crash recovery simulation: see TESTING.md .

## Sizing & ops notes

- Budget 1-3h wall time for a full 2h production on small VPS.
- Keep swap 2-4 GB.
- Set a disk quota check (see `MAX_DISK_BYTES` in server.js) before
  storage silently fills up.

## Frontend

The frontend is a plain HTML/CSS/JS SPA served as static files by the same Express process.
No build step, no bundler, no extra Node.js server process — a requirement for the 4 GB RAM VPS.

### Setup (one-time)

```bash
npm install   # also installs socket.io (added to dependencies)
```

Files:

```
frontend/
  index.html   # SPA shell
  app.css      # design system (dark theme, indigo/violet palette)
  app.js       # router + all three screens + Socket.IO client
```

### Running

```bash
node server.js   # API + Socket.IO + static frontend all on one port (default: 3000)
node worker.js   # unchanged — separate process, pm2 restart=always
```

Open `http://localhost:3000` (or your production URL e.g. https://videofurge.voiceforgeai.site) — the gear icon (⚙) in the top-right corner lets you enter the API key.

### Auth

The server uses `X-API-Key` header auth (see `API_KEYS` env var in `server.js`).

- **If `API_KEYS` is empty**: any non-empty key string is accepted (useful for dev; the key is
  still required to be present in the header — a missing header returns 401).
- **If `API_KEYS` is set**: only keys in the comma-separated list are valid.

The frontend stores the API key in **`sessionStorage`** (browser memory only, cleared when the
tab closes). This was chosen over `localStorage` to avoid writing credentials to disk.
**This is a temporary mechanism** — the code comments flag it as `TODO: Replace with proper
server-side session auth`. The key is attached as an `X-API-Key` header on every `fetch()` call,
and as a `?k=` query parameter for browser-native media requests (`<video src>`, `<a download>`)
that cannot send custom headers.

### Real-time updates (Socket.IO)

The frontend connects via Socket.IO on the same port as the API. No extra port or process.

- The server watches `jobs/` with `fs.watch` (inotify on Linux); when the worker writes a
  `job.json` update, the server emits `job:update` to the subscribed socket room within ~150 ms.
- The jobs list receives `jobs:update` delta events automatically.
- On disconnect, Socket.IO auto-reconnects with exponential backoff and re-subscribes.
  A yellow banner is shown while disconnected.

### Screens

1. **Jobs list** (`/`) — all jobs for your API key, live-updated via socket.
2. **New Job** (`/new`) — form with client-side validation, multipart upload with progress bar,
   media duration preview, character photo uploads + optional style references.
3. **Job detail** (`/jobs/:id`) — 6-step progress indicator (queued → transcribing →
   building_prompts → generating [batch X/Y] → stitching → done), live-updated via socket.
   Shows a video player + download buttons once done. Delete button with confirmation dialog.
- Only one job runs; queue the rest.

All correctness fixes (auth, resume+retry, verified grok flags, scalable stitch, logging, cleanup, proxy, health) have been applied while preserving the original low-RAM single-process architecture.
