import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { db, chunks, transcriptJobs, transcriptSegments } from "@repo/db";
import { asc, desc, eq } from "drizzle-orm";
import { serverEnv } from "@repo/env/server";

const app = new Hono();
const runningTranscriptionSessions = new Set<string>();

app.use("*", logger());
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

const s3 = new S3Client({
  endpoint: serverEnv.BUCKET_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: serverEnv.BUCKET_ACCESS_KEY,
    secretAccessKey: serverEnv.BUCKET_SECRET_KEY,
  },
  forcePathStyle: true,
});

// Health check
app.get("/health", (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));

type DeepgramWord = {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
};

type ChunkSegment = {
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
};

const startTranscriptSchema = z.object({
  sessionId: z.string().min(1),
  force: z.boolean().optional().default(false),
});

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray === "function"
  ) {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "arrayBuffer" in body &&
    typeof (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer === "function"
  ) {
    return Buffer.from(await (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer());
  }

  throw new Error("Unsupported S3 object body format");
}

function normalizeChunkSegments(words: DeepgramWord[]): Array<ChunkSegment & { durationMs: number }> {
  if (words.length === 0) {
    return [];
  }

  const maxEndSec = words.reduce((acc, w) => {
    if (typeof w.end === "number" && Number.isFinite(w.end)) {
      return Math.max(acc, w.end);
    }
    return acc;
  }, 5);

  const segments: ChunkSegment[] = [];
  let current: { speakerLabel: string; startSec: number; endSec: number; text: string } | null = null;

  for (const word of words) {
    const token = (word.punctuated_word ?? word.word ?? "").trim();
    if (!token) continue;

    const startSec = typeof word.start === "number" ? word.start : 0;
    const endSec = typeof word.end === "number" ? word.end : startSec + 0.2;
    const speakerLabel = `Speaker ${(typeof word.speaker === "number" ? word.speaker : 0) + 1}`;

    if (!current) {
      current = { speakerLabel, startSec, endSec, text: token };
      continue;
    }

    const speakerChanged = current.speakerLabel !== speakerLabel;
    const gapTooLarge = startSec - current.endSec > 1.2;

    if (speakerChanged || gapTooLarge) {
      segments.push({
        speakerLabel: current.speakerLabel,
        startMs: Math.round(current.startSec * 1000),
        endMs: Math.round(current.endSec * 1000),
        text: current.text.trim(),
      });
      current = { speakerLabel, startSec, endSec, text: token };
      continue;
    }

    current.endSec = endSec;
    current.text = `${current.text} ${token}`;
  }

  if (current) {
    segments.push({
      speakerLabel: current.speakerLabel,
      startMs: Math.round(current.startSec * 1000),
      endMs: Math.round(current.endSec * 1000),
      text: current.text.trim(),
    });
  }

  return segments.map((s) => ({ ...s, durationMs: Math.max(1, s.endMs - s.startMs || Math.round(maxEndSec * 1000)) }));
}

async function transcribeChunkWithDeepgram(
  audioBytes: Buffer,
  mimeType: string,
  language: string
): Promise<{ chunkText: string; segments: Array<ChunkSegment & { durationMs: number }>; chunkDurationMs: number }> {
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", "nova-2");
  url.searchParams.set("language", language);
  url.searchParams.set("diarize", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Token ${serverEnv.DEEPGRAM_API_KEY}`,
      "Content-Type": mimeType || "audio/webm",
    },
    body: audioBytes,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`Deepgram request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{
          transcript?: string;
          words?: DeepgramWord[];
        }>;
      }>;
    };
  };

  const alt = payload.results?.channels?.[0]?.alternatives?.[0];
  const words = Array.isArray(alt?.words) ? alt.words : [];
  const segments = normalizeChunkSegments(words);
  const chunkText = (alt?.transcript ?? "").trim();

  const chunkDurationMs = words.reduce((acc, w) => {
    if (typeof w.end === "number" && Number.isFinite(w.end)) {
      return Math.max(acc, Math.round(w.end * 1000));
    }
    return acc;
  }, 5000);

  if (segments.length === 0 && chunkText.length > 0) {
    return {
      chunkText,
      segments: [
        {
          speakerLabel: "Speaker 1",
          startMs: 0,
          endMs: chunkDurationMs,
          text: chunkText,
          durationMs: chunkDurationMs,
        },
      ],
      chunkDurationMs,
    };
  }

  return {
    chunkText,
    segments,
    chunkDurationMs,
  };
}

async function processTranscriptJob(jobId: string, sessionId: string): Promise<void> {
  if (runningTranscriptionSessions.has(sessionId)) {
    return;
  }

  runningTranscriptionSessions.add(sessionId);
  try {
    await db
      .update(transcriptJobs)
      .set({
        status: "processing",
        updatedAt: new Date(),
        error: null,
      })
      .where(eq(transcriptJobs.id, jobId));

    const chunkRows = await db
      .select({
        bucketKey: chunks.bucketKey,
        chunkIndex: chunks.chunkIndex,
        mimeType: chunks.mimeType,
      })
      .from(chunks)
      .where(eq(chunks.sessionId, sessionId))
      .orderBy(asc(chunks.chunkIndex));

    if (chunkRows.length === 0) {
      throw new Error("No chunks found for session");
    }

    await db
      .update(transcriptJobs)
      .set({
        totalChunks: chunkRows.length,
        processedChunks: 0,
        updatedAt: new Date(),
      })
      .where(eq(transcriptJobs.id, jobId));

    await db.delete(transcriptSegments).where(eq(transcriptSegments.jobId, jobId));

    const allSegments: Array<{
      id: string;
      jobId: string;
      sessionId: string;
      segmentIndex: number;
      speakerLabel: string;
      startMs: number;
      endMs: number;
      text: string;
    }> = [];
    const transcriptParts: string[] = [];

    let timelineOffsetMs = 0;
    let segmentIndex = 0;

    for (let i = 0; i < chunkRows.length; i++) {
      const row = chunkRows[i];
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: serverEnv.BUCKET_NAME,
          Key: row.bucketKey,
        })
      );

      const body = await streamToBuffer(object.Body);
      const transcribed = await transcribeChunkWithDeepgram(
        body,
        row.mimeType || "audio/webm",
        serverEnv.TRANSCRIBE_LANGUAGE
      );

      if (transcribed.chunkText.length > 0) {
        transcriptParts.push(transcribed.chunkText);
      }

      for (const seg of transcribed.segments) {
        const startMs = timelineOffsetMs + seg.startMs;
        const endMs = Math.max(startMs + 1, timelineOffsetMs + seg.endMs);
        allSegments.push({
          id: makeId("segment"),
          jobId,
          sessionId,
          segmentIndex,
          speakerLabel: seg.speakerLabel,
          startMs,
          endMs,
          text: seg.text,
        });
        segmentIndex++;
      }

      timelineOffsetMs += Math.max(1000, transcribed.chunkDurationMs);

      await db
        .update(transcriptJobs)
        .set({
          processedChunks: i + 1,
          updatedAt: new Date(),
        })
        .where(eq(transcriptJobs.id, jobId));
    }

    for (let i = 0; i < allSegments.length; i += 200) {
      const batch = allSegments.slice(i, i + 200);
      if (batch.length > 0) {
        await db.insert(transcriptSegments).values(batch);
      }
    }

    const transcriptText = transcriptParts.join(" ").replace(/\s+/g, " ").trim();
    await db
      .update(transcriptJobs)
      .set({
        status: "completed",
        transcriptText,
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(transcriptJobs.id, jobId));
  } catch (error) {
    await db
      .update(transcriptJobs)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : "Transcription failed",
        updatedAt: new Date(),
      })
      .where(eq(transcriptJobs.id, jobId));
  } finally {
    runningTranscriptionSessions.delete(sessionId);
  }
}

// Upload a chunk  bucket  ack DB
app.post("/api/chunks/upload", async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data" }, 400);
  }

  const chunkId    = formData.get("chunkId") as string | null;
  const sessionId  = formData.get("sessionId") as string | null;
  const chunkIndex = formData.get("chunkIndex") as string | null;
  const file       = formData.get("chunk") as File | null;

  if (!chunkId || !sessionId || chunkIndex === null || !file) {
    return c.json({ error: "Missing required fields: chunkId, sessionId, chunkIndex, chunk" }, 400);
  }

  const idx = parseInt(chunkIndex, 10);
  if (Number.isNaN(idx)) {
    return c.json({ error: "chunkIndex must be a number" }, 400);
  }

  const buffer    = Buffer.from(await file.arrayBuffer());
  const bucketKey = `${sessionId}/${chunkId}`;

  // Write to bucket first � if this fails, no DB record is written
  try {
    await s3.send(new PutObjectCommand({
      Bucket: serverEnv.BUCKET_NAME,
      Key: bucketKey,
      Body: buffer,
      ContentType: file.type || "audio/webm",
      Metadata: { sessionId, chunkId, chunkIndex: String(idx) },
    }));
  } catch (err) {
    console.error("Bucket upload failed:", err);
    return c.json({ error: "Bucket upload failed" }, 502);
  }

  // Ack in DB only after bucket confirms � idempotent on duplicate chunkId
  try {
    await db.insert(chunks)
      .values({
        id: chunkId,
        sessionId,
        chunkIndex: idx,
        bucketKey,
        sizeBytes: buffer.length,
        mimeType: file.type || "audio/webm",
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error("DB ack failed:", err);
    // Bucket has the chunk; DB ack failed � reconciler will catch this
    return c.json({ error: "DB ack failed, chunk is in bucket" }, 500);
  }

  return c.json({ ok: true, chunkId, bucketKey });
});

// Start English transcription with speaker diarization for a session
app.post("/api/transcripts/start", zValidator("json", startTranscriptSchema), async (c) => {
  const body = c.req.valid("json");
  const sessionId = body.sessionId;
  const force = body.force;

  const chunkCountRows = await db
    .select({ count: chunks.id })
    .from(chunks)
    .where(eq(chunks.sessionId, sessionId));

  if (chunkCountRows.length === 0) {
    return c.json({ error: "No chunks found for this session" }, 404);
  }

  const existing = await db
    .select({
      id: transcriptJobs.id,
      status: transcriptJobs.status,
      totalChunks: transcriptJobs.totalChunks,
      processedChunks: transcriptJobs.processedChunks,
      transcriptText: transcriptJobs.transcriptText,
      error: transcriptJobs.error,
      updatedAt: transcriptJobs.updatedAt,
    })
    .from(transcriptJobs)
    .where(eq(transcriptJobs.sessionId, sessionId))
    .orderBy(desc(transcriptJobs.createdAt))
    .limit(1);

  const latest = existing[0];
  if (latest && !force) {
    if (latest.status === "queued" || latest.status === "processing") {
      return c.json({
        ok: true,
        reused: true,
        job: latest,
      }, 202);
    }

    if (latest.status === "completed") {
      return c.json({
        ok: true,
        reused: true,
        job: latest,
      });
    }
  }

  const jobId = makeId("job");
  await db.insert(transcriptJobs).values({
    id: jobId,
    sessionId,
    status: "queued",
    provider: serverEnv.TRANSCRIBE_PROVIDER,
    language: serverEnv.TRANSCRIBE_LANGUAGE,
    totalChunks: chunkCountRows.length,
    processedChunks: 0,
  });

  void processTranscriptJob(jobId, sessionId);

  return c.json({
    ok: true,
    job: {
      id: jobId,
      sessionId,
      status: "queued",
      totalChunks: chunkCountRows.length,
      processedChunks: 0,
    },
  }, 202);
});

// Get latest transcript job status for a session
app.get("/api/transcripts/:sessionId/status", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400);

  const rows = await db
    .select({
      id: transcriptJobs.id,
      sessionId: transcriptJobs.sessionId,
      status: transcriptJobs.status,
      provider: transcriptJobs.provider,
      language: transcriptJobs.language,
      totalChunks: transcriptJobs.totalChunks,
      processedChunks: transcriptJobs.processedChunks,
      error: transcriptJobs.error,
      createdAt: transcriptJobs.createdAt,
      updatedAt: transcriptJobs.updatedAt,
      completedAt: transcriptJobs.completedAt,
    })
    .from(transcriptJobs)
    .where(eq(transcriptJobs.sessionId, sessionId))
    .orderBy(desc(transcriptJobs.createdAt))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ status: "not_found" }, 404);
  }

  return c.json({ job: rows[0] });
});

// Get latest transcript text and speaker-labeled segments for a session
app.get("/api/transcripts/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400);

  const jobs = await db
    .select({
      id: transcriptJobs.id,
      status: transcriptJobs.status,
      transcriptText: transcriptJobs.transcriptText,
      error: transcriptJobs.error,
      completedAt: transcriptJobs.completedAt,
    })
    .from(transcriptJobs)
    .where(eq(transcriptJobs.sessionId, sessionId))
    .orderBy(desc(transcriptJobs.createdAt))
    .limit(1);

  const latest = jobs[0];
  if (!latest) {
    return c.json({ error: "No transcript job found" }, 404);
  }

  const segments = await db
    .select({
      speakerLabel: transcriptSegments.speakerLabel,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      text: transcriptSegments.text,
      segmentIndex: transcriptSegments.segmentIndex,
    })
    .from(transcriptSegments)
    .where(eq(transcriptSegments.jobId, latest.id))
    .orderBy(asc(transcriptSegments.segmentIndex));

  return c.json({
    job: latest,
    transcriptText: latest.transcriptText ?? "",
    segments,
  });
});

// Return all acked chunk IDs for a session (for reconciler)
app.get("/api/chunks/status/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400);

  const rows = await db
    .select({ id: chunks.id, chunkIndex: chunks.chunkIndex })
    .from(chunks)
    .where(eq(chunks.sessionId, sessionId));

  return c.json({ ackedIds: rows.map((r) => r.id), count: rows.length });
});

// List all sessions
app.get("/api/sessions", async (c) => {
  const rows = await db
    .selectDistinct({ sessionId: chunks.sessionId })
    .from(chunks);
  return c.json({ sessions: rows.map((r) => r.sessionId) });
});

export default {
  port: serverEnv.PORT,
  fetch: app.fetch,
};
