# Reliable Recording Chunking Pipeline

Production-grade monorepo implementing a crash-safe, resumable audio recording pipeline:

- Browser records audio in 5-second chunks.
- Each chunk is persisted to OPFS before network upload.
- Backend uploads chunk to S3-compatible object storage.
- Backend writes DB ack only after object storage confirms write.
- On page reload, a reconciler re-uploads any chunks still in OPFS that are not acked in DB.
- Backend can transcribe long sessions to English with speaker diarization.

## Monorepo Structure

```text
recording-pipeline/
├── apps/
│   ├── web/                  # Next.js 14 App Router frontend
│   └── server/               # Hono + Bun backend
├── packages/
│   ├── db/                   # Drizzle ORM schema + client
│   ├── ui/                   # Shared UI package
│   └── env/                  # Type-safe env validation (zod)
├── package.json
├── turbo.json
└── tsconfig.json
```

## Architecture Guarantees

1. Record audio and split into 5s chunks.
2. Persist chunk to OPFS first (durable client-side buffer).
3. Upload with retry and exponential backoff.
4. Write DB ack only after object storage write succeeds.
5. Reconcile on startup by comparing OPFS chunks to server ack state.

This ordering prevents data loss during transient network failures and supports eventual recovery.

## Transcription Capabilities

- English transcription for long recordings (processed chunk-by-chunk).
- Multi-speaker diarization (speaker-labeled segments).
- Async transcript jobs with status polling.
- Transcript text and per-speaker timeline segments persisted in PostgreSQL.

## Tech Stack

- Frontend: Next.js 14 (App Router), React 18, Tailwind CSS
- Backend: Hono on Bun
- Database: PostgreSQL + Drizzle ORM
- Bucket: Any S3-compatible storage (MinIO locally, R2 in production)
- Speech-to-text provider: Deepgram (Nova-2 with diarization)
- Env validation: Zod
- Monorepo orchestration: Turborepo workspaces

## Environment Variables

### Backend (`apps/server/.env`)

```env
DATABASE_URL=postgresql://user:password@localhost:5432/chunks_db
BUCKET_ENDPOINT=http://localhost:9000
BUCKET_ACCESS_KEY=minioadmin
BUCKET_SECRET_KEY=minioadmin
BUCKET_NAME=recordings
TRANSCRIBE_PROVIDER=deepgram
DEEPGRAM_API_KEY=replace_with_real_deepgram_key
TRANSCRIBE_LANGUAGE=en
PORT=3000
NODE_ENV=development
```

### Frontend (`apps/web/.env.local`)

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## Install and Run

From repo root:

```bash
npm install
```

Apply DB schema:

```bash
npm run db:push
```

Start frontend + backend together:

```bash
npm run dev
```

Expected local URLs:

- Frontend: http://localhost:3001
- Backend health: http://localhost:3000/health

Run individual apps if needed:

```bash
npm run dev:web
npm run dev:server
```

## Local Object Storage with MinIO

Start MinIO:

```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data --console-address ":9001"
```

Then open http://localhost:9001 and create bucket:

- Bucket name: `recordings`

## How to Verify End-to-End

1. Open http://localhost:3001.
2. Click **Start recording**, speak for at least 10s, then click **Stop**.
3. Confirm objects appear in MinIO under `recordings/<sessionId>/...`.
4. Confirm rows appear in PostgreSQL `chunks` table.
5. Simulate network loss while recording:
   - Disable network.
   - Continue recording for one or more chunk intervals.
   - Stop recording.
6. Re-enable network and reload page.
7. Reconciler should re-upload missing chunks and clear them from OPFS.
8. Click **Generate transcript** in the UI.
9. Confirm transcription status progresses from `queued` → `processing` → `completed`.
10. Confirm transcript text and speaker segments appear.

## API Overview

### `GET /health`

Returns service heartbeat with timestamp.

### `POST /api/chunks/upload`

Multipart form fields:

- `chunkId` (string)
- `sessionId` (string)
- `chunkIndex` (number as string)
- `chunk` (binary file/blob)

Behavior:

- Stores chunk in bucket first.
- Writes DB ack second (`onConflictDoNothing` for idempotency).

### `GET /api/chunks/status/:sessionId`

Returns acked chunk IDs for a session.

### `GET /api/sessions`

Returns all distinct session IDs.

### `POST /api/transcripts/start`

Starts (or reuses) an async transcription job for a session.

JSON body:

- `sessionId` (string, required)
- `force` (boolean, optional, default `false`)

Behavior:

- Reads session chunks in order from bucket.
- Sends each chunk to Deepgram for English diarized transcription.
- Stores consolidated transcript and speaker segments in DB.

### `GET /api/transcripts/:sessionId/status`

Returns latest transcript job status and progress:

- `status`: `queued | processing | completed | failed`
- `processedChunks`
- `totalChunks`
- `error` (if failed)

### `GET /api/transcripts/:sessionId`

Returns latest transcript result:

- Full transcript text
- Speaker-labeled segments with start/end timestamps

## Deployment

### Frontend (Vercel)

- Import repo in Vercel.
- Uses `vercel.json` in root.
- Set environment variable:
  - `NEXT_PUBLIC_API_URL` to deployed backend URL.

### Backend (Railway / Fly / Render)

- Uses `apps/server/Dockerfile` and `apps/server/railway.toml`.
- Set all backend env vars from `apps/server/.env`.

### Managed Services

- PostgreSQL: Neon
- S3-compatible bucket: Cloudflare R2

## Production Notes

- Keep bucket and DB in same region when possible to reduce latency.
- Configure CORS on backend and bucket for your frontend domain.
- Add authentication/authorization before public exposure.
- Add structured logging and request IDs for observability.
- Add lifecycle cleanup policy for stale chunks/sessions if needed.
- For very large backlogs, move transcription processing to a durable queue worker.

## Useful Commands

```bash
npm run build
npm run check-types
npm run db:generate
npm run db:migrate
npm run db:studio
```

## Troubleshooting

- `DATABASE_URL is not set`:
  - Confirm `apps/server/.env` exists and has valid value.
- Upload fails with bucket error:
  - Confirm bucket exists and credentials/endpoint are correct.
- Reconciler does not recover:
  - Check backend `/api/chunks/status/:sessionId` response and browser console logs.
- No chunks uploaded:
  - Ensure microphone permission is granted in browser.
- Transcription fails:
  - Confirm `DEEPGRAM_API_KEY` is valid.
  - Confirm backend can reach `https://api.deepgram.com`.
