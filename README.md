# Yogesh-Swades_Hackathon
# Reliable Recording Chunking Pipeline

A production-grade, zero-data-loss audio recording pipeline. Browser chunks are written to **OPFS** before any network call, uploaded to an **S3-compatible bucket**, and acknowledged in **PostgreSQL** only after the bucket confirms receipt. A reconciler on startup re-uploads any unsynced chunks, guaranteeing full consistency across crashes, tab closes, and network failures.

---

## Table of contents

- [Architecture](#architecture)
- [Data flow guarantee](#data-flow-guarantee)
- [Tech stack](#tech-stack)
- [Monorepo structure](#monorepo-structure)
- [Prerequisites](#prerequisites)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Database](#database)
- [Object storage (MinIO)](#object-storage-minio)
- [API reference](#api-reference)
- [Frontend internals](#frontend-internals)
- [Reconciler](#reconciler)
- [Deployment](#deployment)
- [Load testing](#load-testing)
- [Failure scenarios and how they are handled](#failure-scenarios-and-how-they-are-handled)

---

## Architecture

```
Browser
  │
  ├─ 1. MediaRecorder splits stream → 5 s blobs
  ├─ 2. Each blob written to OPFS (crash-safe local buffer)
  ├─ 3. Blob uploaded to server  →  bucket (S3/R2/MinIO)
  ├─ 4. Server writes DB ack only after bucket confirms
  └─ 5. OPFS entry deleted only after server returns 200

On next page load
  └─ Reconciler: OPFS entries not in DB acks → re-upload → delete
```

OPFS is the single source of truth on the client. Nothing leaves OPFS until the server has confirmed both the bucket write and the database acknowledgement. This means every failure mode — network drop, server crash, browser tab close — is recoverable without user intervention.

---

## Data flow guarantee

| Step | What happens | Failure effect |
|------|-------------|----------------|
| 1 | `MediaRecorder.ondataavailable` fires a blob | Blob lost — only if tab crashes before step 2 (< 5 ms window) |
| 2 | Blob written synchronously to OPFS | Safe. Survives tab close, network loss, OS sleep |
| 3 | `POST /api/chunks/upload` with FormData | Network error → retry loop (exponential backoff, 4 attempts) |
| 4 | Server writes blob to bucket, then inserts DB row | Bucket fail → 502, no DB row written. Retry from client |
| 5 | Client deletes OPFS entry on HTTP 200 | If delete fails → chunk stays in OPFS, reconciler cleans it |
| 6 | On page load: reconciler diffs OPFS vs DB acks | Re-uploads anything missing from DB, clears stale OPFS entries |

**Invariant:** a chunk is deleted from OPFS if and only if it exists in both the bucket and the database.

---

## Tech stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | Next.js App Router | 14.x |
| Backend | Hono on Bun | 4.x / 1.x |
| ORM | Drizzle ORM | 0.30.x |
| Database | PostgreSQL | 15+ |
| Object storage | S3-compatible (MinIO / R2 / AWS S3) | — |
| Monorepo | Turborepo | 2.x |
| UI | Tailwind CSS | 3.x |
| Env validation | Zod | 3.x |
| Type checking | TypeScript | 5.x |

---

## Monorepo structure

```
recording-pipeline/
├── apps/
│   ├── web/                     # Next.js 14 — chunking, OPFS, upload UI
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── page.tsx     # Main recording UI
│   │   │   │   └── globals.css
│   │   │   ├── hooks/
│   │   │   │   └── useRecorder.ts   # MediaRecorder + OPFS + upload logic
│   │   │   └── lib/
│   │   │       ├── opfs.ts          # OPFS read/write/list/delete helpers
│   │   │       ├── uploader.ts      # fetch with exponential-backoff retry
│   │   │       └── reconciler.ts    # Startup diff + re-upload logic
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   └── .env.local
│   │
│   └── server/                  # Hono API — bucket upload + DB ack
│       ├── src/
│       │   └── index.ts         # All routes
│       ├── Dockerfile
│       ├── railway.toml
│       └── .env
│
├── packages/
│   ├── db/                      # Drizzle schema + postgres client
│   │   ├── src/
│   │   │   ├── schema.ts
│   │   │   └── index.ts
│   │   └── drizzle.config.ts
│   ├── env/                     # Zod-validated env for server and client
│   │   └── src/
│   │       ├── server.ts
│   │       └── client.ts
│   └── ui/                      # Shared shadcn/ui components (optional)
│
├── turbo.json
├── package.json
└── tsconfig.json
```

---

## Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Node.js | 20.x | https://nodejs.org |
| Bun | 1.x | `curl -fsSL https://bun.sh/install \| bash` |
| Docker | 24.x | https://docs.docker.com/get-docker/ |
| PostgreSQL | 15 | Local or hosted (Neon, Supabase, Railway) |

---

## Environment variables

### `apps/server/.env`

```env
DATABASE_URL=postgresql://user:password@localhost:5432/chunks_db
BUCKET_ENDPOINT=http://localhost:9000
BUCKET_ACCESS_KEY=minioadmin
BUCKET_SECRET_KEY=minioadmin
BUCKET_NAME=recordings
PORT=3000
NODE_ENV=development
```

### `apps/web/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

All server env vars are validated at startup via Zod in `packages/env/src/server.ts`. The process exits immediately with a descriptive error if any required variable is missing or malformed.

---

## Local development

```bash
# 1. Install all workspace dependencies
npm install

# 2. Start MinIO (local S3-compatible bucket)
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data --console-address ":9001"

# 3. Create the bucket
# Open http://localhost:9001 → login minioadmin/minioadmin
# Create a bucket named "recordings"

# 4. Apply the database schema
npm run db:push

# 5. Start all apps
npm run dev
```

- Web app: http://localhost:3001
- API server: http://localhost:3000
- MinIO console: http://localhost:9001
- Drizzle Studio: `npm run db:studio` → http://local.drizzle.studio

To run apps individually:

```bash
npm run dev:web      # Next.js only
npm run dev:server   # Hono/Bun only
```

---

## Database

### Schema

```sql
CREATE TABLE chunks (
  id           TEXT PRIMARY KEY,              -- e.g. "session-1234-chunk-0003"
  session_id   TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  bucket_key   TEXT NOT NULL,                 -- S3 object path: "{sessionId}/{chunkId}"
  acked_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  size_bytes   INTEGER NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT 'audio/webm',
  recovered    BOOLEAN NOT NULL DEFAULT FALSE, -- true if written by reconciler
  uploaded_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX session_idx ON chunks (session_id);
```

### Useful scripts

```bash
npm run db:push       # Apply schema changes directly (dev)
npm run db:generate   # Generate migration files
npm run db:migrate    # Run pending migrations (prod)
npm run db:studio     # Open Drizzle Studio GUI
```

`onConflictDoNothing()` on insert makes all uploads idempotent. Re-uploading the same `chunkId` never causes a duplicate row or an error.

---

## Object storage (MinIO)

For local development MinIO emulates the S3 API exactly. In production, swap the endpoint and credentials for any S3-compatible provider:

| Provider | `BUCKET_ENDPOINT` | Notes |
|----------|------------------|-------|
| MinIO (local) | `http://localhost:9000` | `forcePathStyle: true` required |
| AWS S3 | `https://s3.amazonaws.com` | Remove `forcePathStyle` |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | Free egress |
| Backblaze B2 | `https://s3.us-west-004.backblazeb2.com` | S3-compatible |

The `@aws-sdk/client-s3` package works with all of the above.

---

## API reference

### `POST /api/chunks/upload`

Uploads a single chunk to the bucket and writes a DB ack atomically.

**Request** — `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chunkId` | string | yes | Unique ID: `{sessionId}-chunk-{paddedIndex}` |
| `sessionId` | string | yes | Recording session identifier |
| `chunkIndex` | number | yes | Zero-based position in the recording |
| `chunk` | File (Blob) | yes | Raw audio blob from MediaRecorder |

**Responses**

| Status | Body | Meaning |
|--------|------|---------|
| `200` | `{ ok: true, chunkId, bucketKey }` | Bucket write + DB ack both succeeded |
| `400` | `{ error: "Missing required fields: ..." }` | Malformed request |
| `502` | `{ error: "Bucket upload failed" }` | S3 unreachable or rejected |
| `500` | `{ error: "DB ack failed, chunk is in bucket" }` | Bucket has chunk, DB failed — reconciler will fix |

**Idempotency:** re-uploading the same `chunkId` returns `200` with no side effects.

---

### `GET /api/chunks/status/:sessionId`

Returns all chunk IDs that have been acknowledged in the database for the given session. Used by the client-side reconciler on startup.

**Response**

```json
{
  "ackedIds": ["session-abc-chunk-0000", "session-abc-chunk-0001"],
  "count": 2
}
```

---

### `GET /api/sessions`

Returns all distinct session IDs that have at least one acked chunk.

**Response**

```json
{
  "sessions": ["session-1717000000000-abc12", "session-1717001234567-xyz99"]
}
```

---

### `GET /health`

```json
{ "ok": true, "timestamp": "2025-01-01T00:00:00.000Z" }
```

Use this for uptime monitoring and deployment health checks.

---

## Frontend internals

### `useRecorder` hook

Manages the full lifecycle: microphone access → chunking → OPFS write → upload → OPFS delete.

```
MediaRecorder (5 s interval)
  └─ ondataavailable(blob)
       ├─ saveChunkToOpfs(dir, chunkId, blob)   ← always first
       ├─ uploadChunk(sessionId, chunkId, idx, blob)
       │    └─ fetch POST /api/chunks/upload
       │         ├─ success → deleteChunkFromOpfs(dir, chunkId)
       │         └─ failure (after 4 retries) → chunk stays in OPFS
       └─ update UI state (uploadedCount / failedChunks)
```

**Retry strategy in `uploader.ts`:**

| Attempt | Delay before retry |
|---------|--------------------|
| 1 | 0 ms (immediate) |
| 2 | 500 ms |
| 3 | 1 000 ms |
| 4 | 2 000 ms |
| 5 | 4 000 ms |

After 5 attempts the chunk remains in OPFS. The reconciler picks it up on the next page load.

### OPFS helpers (`lib/opfs.ts`)

```
getChunksDir()         → FileSystemDirectoryHandle ("chunks/" dir in OPFS)
saveChunkToOpfs()      → FileSystemFileHandle.createWritable() + write + close
deleteChunkFromOpfs()  → dir.removeEntry() — silent no-op if already gone
listChunksInOpfs()     → async iterator over dir.entries(), filtered by sessionId prefix
```

OPFS operations are synchronous from the perspective of the recording pipeline because they are `await`ed before the upload starts. The file is fully flushed to disk before any network call is made.

---

## Reconciler

Runs once on every page load via `useEffect` in `page.tsx`.

```
reconcile(sessionId)
  │
  ├─ GET /api/chunks/status/:sessionId   → ackedIds (Set)
  ├─ listChunksInOpfs(dir, sessionId)    → local chunks array
  │
  └─ for each local chunk:
       ├─ if chunkId ∈ ackedIds  → deleteChunkFromOpfs()     (stale, safe to remove)
       └─ if chunkId ∉ ackedIds  → uploadChunk() → deleteChunkFromOpfs()  (re-upload)
```

The reconciler returns the number of chunks it recovered. The UI shows a banner when `recoveredCount > 0`.

**Edge case — bucket has chunk but DB row is missing:**
The server's `POST /api/chunks/upload` returns `500` with the message `"DB ack failed, chunk is in bucket"`. The bucket already has the data. On the next reconciler run, it will attempt to re-upload; the bucket write will be a no-op (overwrite) and the DB insert uses `onConflictDoNothing()`. No data is lost and no duplicate is created.

---

## Deployment

### Frontend — Vercel

1. Push the repo to GitHub.
2. Import the project at vercel.com.
3. Set the following in Vercel project settings → Environment Variables:

   | Variable | Value |
   |----------|-------|
   | `NEXT_PUBLIC_API_URL` | Your deployed server URL |

4. Vercel auto-detects Next.js. Build command: `npm run build --filter=web`.

### Backend — Railway (recommended for Bun)

1. Connect the repo at railway.app.
2. Railway detects `apps/server/railway.toml` automatically.
3. Set all variables from `apps/server/.env` in Railway's environment panel.
4. Railway builds using the `apps/server/Dockerfile` and exposes the `PORT` env var.

The `Dockerfile`:

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package*.json turbo.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/server/ ./apps/server/
RUN bun install --frozen-lockfile
EXPOSE 3000
CMD ["bun", "run", "apps/server/src/index.ts"]
```

### Alternative backend platforms

| Platform | Command | Notes |
|----------|---------|-------|
| Fly.io | `fly launch` in `apps/server/` | Edge-close, generous free tier |
| Render | Docker deploy | Free tier available, spins down on inactivity |
| AWS ECS | Push to ECR + task definition | Production scale |

### Database — Neon (recommended)

1. Create a free project at neon.tech.
2. Copy the connection string.
3. Set `DATABASE_URL` in both Railway and your local `.env`.
4. Run `npm run db:migrate` to apply the schema.

### Object storage — Cloudflare R2 (recommended)

1. Create a bucket at dash.cloudflare.com → R2.
2. Generate an API token with Object Read & Write permissions.
3. Set `BUCKET_ENDPOINT`, `BUCKET_ACCESS_KEY`, `BUCKET_SECRET_KEY`, `BUCKET_NAME` accordingly.
4. R2 has zero egress fees — critical for audio data at scale.

---

## Load testing

Target: **300,000 requests** to validate the chunking pipeline under sustained load.

### k6 script

```javascript
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    chunk_uploads: {
      executor: "constant-arrival-rate",
      rate: 5000,           // 5,000 req/s
      timeUnit: "1s",
      duration: "1m",       // 300,000 requests in 60 s
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
};

export default function () {
  const payload = JSON.stringify({
    chunkId: `chunk-${__VU}-${__ITER}`,
    data: "x".repeat(1024),
  });

  const res = http.post(
    "http://localhost:3000/api/chunks/upload",
    payload,
    { headers: { "Content-Type": "application/json" } }
  );

  check(res, { "status 200": (r) => r.status === 200 });
}
```

```bash
k6 run load-test.js
```

### What to validate after a load test run

- **No data loss** — every row in `chunks` has a matching object in the bucket. Run:
  ```sql
  SELECT COUNT(*) FROM chunks;
  -- must equal number of objects in bucket
  ```
- **OPFS recovery** — kill the browser tab mid-recording, reload, confirm the reconciler banner appears and `recoveredCount > 0`.
- **Idempotency** — re-send the same `chunkId` 10 times, confirm exactly one DB row and one bucket object exist.
- **Throughput** — server sustains 5,000 req/s with p99 latency under 200 ms.

---

## Failure scenarios and how they are handled

| Scenario | What happens | Recovery |
|----------|-------------|----------|
| Network drops mid-upload | `fetch` throws, retry loop starts (up to 4 retries with backoff) | Automatic — no user action needed |
| All retries exhausted | Chunk stays in OPFS, `failedChunks` counter increments in UI | Reconciler re-uploads on next page load |
| Browser tab closed mid-chunk | OPFS write is either complete or not started (atomic) | If complete: reconciler uploads it. If not started: chunk is lost (< 5 ms window at blob emission) |
| Server bucket write succeeds, DB write fails | Server returns 500. Client retries. Bucket gets overwritten (no-op), DB insert uses `onConflictDoNothing()` | Automatic on retry |
| Server crashes between bucket write and DB write | Client retry re-uploads. Same outcome as above | Automatic on retry |
| PostgreSQL is down | Upload returns 500. Chunk stays in OPFS | Automatic once DB recovers and client retries or reconciler runs |
| Bucket is temporarily unavailable | Upload returns 502. Retry loop + OPFS fallback | Automatic |
| Client refreshes mid-session | New session ID generated. Old session reconciler runs and re-uploads unacked chunks | Automatic |
| Duplicate `chunkId` upload (network retry) | `onConflictDoNothing()` on DB insert, bucket overwrite is idempotent | No duplicates, no errors |

---

## Available scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start all apps (web + server) in watch mode |
| `npm run dev:web` | Start only the Next.js frontend |
| `npm run dev:server` | Start only the Hono/Bun backend |
| `npm run build` | Build all apps for production |
| `npm run check-types` | TypeScript type-check across all packages |
| `npm run db:push` | Push schema to database (dev — no migration files) |
| `npm run db:generate` | Generate Drizzle migration files |
| `npm run db:migrate` | Apply pending migrations (prod) |
| `npm run db:studio` | Open Drizzle Studio at http://local.drizzle.studio |

---

## License

MIT
