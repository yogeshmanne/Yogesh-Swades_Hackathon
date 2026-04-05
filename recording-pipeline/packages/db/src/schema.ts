import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    bucketKey: text("bucket_key").notNull(),
    ackedAt: timestamp("acked_at").notNull().defaultNow(),
    sizeBytes: integer("size_bytes").notNull(),
    mimeType: text("mime_type").notNull().default("audio/webm"),
    recovered: boolean("recovered").notNull().default(false),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("session_idx").on(table.sessionId),
  })
);

export const transcriptJobs = pgTable(
  "transcript_jobs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    status: text("status").notNull().default("queued"),
    provider: text("provider").notNull().default("deepgram"),
    language: text("language").notNull().default("en"),
    totalChunks: integer("total_chunks").notNull().default(0),
    processedChunks: integer("processed_chunks").notNull().default(0),
    transcriptText: text("transcript_text"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    jobSessionIdx: index("transcript_jobs_session_idx").on(table.sessionId),
    jobStatusIdx: index("transcript_jobs_status_idx").on(table.status),
  })
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    sessionId: text("session_id").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    segmentSessionIdx: index("transcript_segments_session_idx").on(table.sessionId),
    segmentJobIdx: index("transcript_segments_job_idx").on(table.jobId),
    segmentOrderIdx: index("transcript_segments_order_idx").on(table.jobId, table.segmentIndex),
  })
);

export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type TranscriptJob = typeof transcriptJobs.$inferSelect;
export type NewTranscriptJob = typeof transcriptJobs.$inferInsert;
export type TranscriptSegment = typeof transcriptSegments.$inferSelect;
export type NewTranscriptSegment = typeof transcriptSegments.$inferInsert;
