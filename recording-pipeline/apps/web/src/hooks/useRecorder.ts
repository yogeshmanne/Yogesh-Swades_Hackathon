"use client";

import { useRef, useState, useCallback } from "react";
import { getChunksDir, saveChunkToOpfs, deleteChunkFromOpfs } from "@/lib/opfs";
import { uploadChunk } from "@/lib/uploader";

const CHUNK_INTERVAL_MS = 5_000;

export type RecorderStatus = "idle" | "recording" | "stopping" | "stopped";

export interface RecorderState {
  status: RecorderStatus;
  uploadedCount: number;
  failedChunks: string[];
  start: () => Promise<void>;
  stop: () => void;
}

export function useRecorder(sessionId: string): RecorderState {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunkIndexRef = useRef(0);
  const opfsDirRef = useRef<FileSystemDirectoryHandle | null>(null);

  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [failedChunks, setFailedChunks] = useState<string[]>([]);

  const start = useCallback(async () => {
    if (status === "recording") return;
    chunkIndexRef.current = 0;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      console.error("Microphone access denied:", err);
      throw new Error("Microphone permission denied");
    }

    const opfsDir = await getChunksDir();
    opfsDirRef.current = opfsDir;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const mr = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = mr;

    mr.ondataavailable = async (event) => {
      if (!event.data.size) return;

      const idx = chunkIndexRef.current++;
      const chunkId = `${sessionId}-chunk-${String(idx).padStart(4, "0")}`;

      // Step 1: persist to OPFS BEFORE any network call
      await saveChunkToOpfs(opfsDir, chunkId, event.data);

      // Step 2: upload to server with retry
      try {
        await uploadChunk(sessionId, chunkId, idx, event.data);
        // Step 3: only delete from OPFS after confirmed ack
        await deleteChunkFromOpfs(opfsDir, chunkId);
        setUploadedCount((n) => n + 1);
      } catch {
        // Chunk stays in OPFS — reconciler will handle it on next load
        setFailedChunks((prev) => [...prev, chunkId]);
      }
    };

    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setStatus("stopped");
    };

    mr.start(CHUNK_INTERVAL_MS);
    setStatus("recording");
  }, [sessionId, status]);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      setStatus("stopping");
      mediaRecorderRef.current.stop();
    }
  }, []);

  return { status, uploadedCount, failedChunks, start, stop };
}
