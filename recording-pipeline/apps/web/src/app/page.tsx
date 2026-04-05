"use client";

import { useEffect, useState } from "react";
import { useRecorder } from "@/hooks/useRecorder";
import { reconcile } from "@/lib/reconciler";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

type TranscriptJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  totalChunks: number;
  processedChunks: number;
  error?: string | null;
};

type TranscriptSegment = {
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  segmentIndex: number;
};

function msToClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  if (hh > 0) {
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function generateSessionId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  return `session-${ts}-${rand}`;
}

// Session ID is stable for the lifetime of this page load
const SESSION_ID = generateSessionId();

export default function HomePage() {
  const { status, uploadedCount, failedChunks, start, stop } = useRecorder(SESSION_ID);
  const [recoveredCount, setRecoveredCount] = useState(0);
  const [reconciling, setReconciling] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [transcriptJob, setTranscriptJob] = useState<TranscriptJob | null>(null);
  const [transcriptText, setTranscriptText] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);

  // Run reconciler once on mount
  useEffect(() => {
    reconcile(SESSION_ID)
      .then((n) => {
        setRecoveredCount(n);
        setReconciling(false);
      })
      .catch(() => setReconciling(false));
  }, []);

  const handleStart = async () => {
    setStartError(null);
    try {
      await start();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start recording");
    }
  };

  const loadTranscript = async () => {
    const res = await fetch(`${API_URL}/api/transcripts/${SESSION_ID}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? "Could not fetch transcript");
    }

    const data = (await res.json()) as {
      transcriptText: string;
      segments: TranscriptSegment[];
      job: TranscriptJob;
    };

    setTranscriptText(data.transcriptText || "");
    setSegments(data.segments || []);
    setTranscriptJob(data.job || null);
  };

  const pollTranscriptStatus = async (): Promise<void> => {
    const res = await fetch(`${API_URL}/api/transcripts/${SESSION_ID}/status`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? "Could not fetch transcript status");
    }

    const data = (await res.json()) as { job: TranscriptJob };
    setTranscriptJob(data.job);

    if (data.job.status === "queued" || data.job.status === "processing") {
      setTimeout(() => {
        pollTranscriptStatus().catch((err) => {
          setTranscriptError(err instanceof Error ? err.message : "Polling failed");
          setIsTranscribing(false);
        });
      }, 2000);
      return;
    }

    if (data.job.status === "failed") {
      setTranscriptError(data.job.error ?? "Transcription failed");
      setIsTranscribing(false);
      return;
    }

    await loadTranscript();
    setIsTranscribing(false);
  };

  const handleTranscribe = async () => {
    setTranscriptError(null);
    setIsTranscribing(true);

    try {
      const res = await fetch(`${API_URL}/api/transcripts/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Could not start transcription");
      }

      const data = (await res.json()) as { job?: TranscriptJob };
      if (data.job) {
        setTranscriptJob(data.job);
      }

      await pollTranscriptStatus();
    } catch (err) {
      setTranscriptError(err instanceof Error ? err.message : "Transcription failed");
      setIsTranscribing(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <div className="w-full max-w-md space-y-6">

        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Recording pipeline</h1>
          <p className="text-sm text-gray-500 mt-1 font-mono break-all">{SESSION_ID}</p>
        </div>

        {reconciling && (
          <div className="text-sm text-center text-gray-400 animate-pulse">
            Checking for unsynced chunks
          </div>
        )}

        {!reconciling && recoveredCount > 0 && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            Reconciler recovered <strong>{recoveredCount}</strong> chunk
            {recoveredCount !== 1 ? "s" : ""} from a previous session.
          </div>
        )}

        {startError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
            {startError}
          </div>
        )}

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <span
              className={`inline-block w-3 h-3 rounded-full ${
                status === "recording"
                  ? "bg-red-500 animate-pulse"
                  : status === "stopped"
                  ? "bg-green-500"
                  : "bg-gray-300"
              }`}
            />
            <span className="text-sm font-medium capitalize">
              {status === "stopping" ? "Finalising" : status}
            </span>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleStart}
              disabled={status === "recording" || status === "stopping"}
              className="flex-1 py-2.5 rounded-lg bg-red-600 text-white text-sm font-semibold
                         hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Start recording
            </button>
            <button
              onClick={stop}
              disabled={status !== "recording"}
              className="flex-1 py-2.5 rounded-lg bg-gray-900 text-white text-sm font-semibold
                         hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Stop
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
              <p className="text-2xl font-bold text-gray-900">{uploadedCount}</p>
              <p className="text-xs text-gray-500 mt-0.5">Chunks uploaded</p>
            </div>
            <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
              <p className={`text-2xl font-bold ${failedChunks.length > 0 ? "text-red-600" : "text-gray-900"}`}>
                {failedChunks.length}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">In OPFS (pending)</p>
            </div>
          </div>

          {failedChunks.length > 0 && (
            <p className="text-xs text-gray-400">
              Failed chunks are saved locally and will auto-recover on next page load.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
          <h2 className="text-sm font-semibold mb-3">Pipeline guarantee</h2>
          <ol className="space-y-2 text-xs text-gray-600">
            {[
              "Record audio  split into 5s chunks",
              "Write each chunk to OPFS before any network call",
              "Upload chunk to bucket with exponential-backoff retry",
              "DB ack written only after bucket confirms receipt",
              "On reload: reconciler re-uploads any unacked OPFS chunks",
            ].map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="font-mono text-gray-400">{i + 1}.</span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">English transcript with speakers</h2>
            <button
              onClick={handleTranscribe}
              disabled={isTranscribing || uploadedCount === 0}
              className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-semibold
                         hover:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {isTranscribing ? "Transcribing..." : "Generate transcript"}
            </button>
          </div>

          {transcriptJob && (
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <p>
                Status: <strong>{transcriptJob.status}</strong>
              </p>
              <p>
                Progress: <strong>{transcriptJob.processedChunks}</strong> / <strong>{transcriptJob.totalChunks}</strong> chunks
              </p>
            </div>
          )}

          {transcriptError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
              {transcriptError}
            </div>
          )}

          {transcriptText.length > 0 && (
            <div className="space-y-3">
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 max-h-56 overflow-auto">
                <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{transcriptText}</p>
              </div>

              <div className="rounded-lg border border-gray-200">
                <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-700">
                  Speaker segments
                </div>
                <ul className="max-h-72 overflow-auto divide-y divide-gray-100">
                  {segments.map((segment) => (
                    <li key={`${segment.segmentIndex}-${segment.startMs}`} className="px-4 py-3 text-xs text-gray-700">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-gray-900">{segment.speakerLabel}</span>
                        <span className="font-mono text-gray-500">
                          {msToClock(segment.startMs)} - {msToClock(segment.endMs)}
                        </span>
                      </div>
                      <p className="leading-relaxed">{segment.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

      </div>
    </main>
  );
}
