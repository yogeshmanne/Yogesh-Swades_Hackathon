// Uploads a single chunk with exponential backoff retry

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
const MAX_RETRIES = 4;

export async function uploadChunk(
  sessionId: string,
  chunkId: string,
  chunkIndex: number,
  blob: Blob
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const fd = new FormData();
      fd.append("chunkId", chunkId);
      fd.append("sessionId", sessionId);
      fd.append("chunkIndex", String(chunkIndex));
      fd.append("chunk", blob, `${chunkId}.webm`);

      const res = await fetch(`${API_URL}/api/chunks/upload`, {
        method: "POST",
        body: fd,
      });

      if (res.ok) return;

      const body = await res.json().catch(() => ({}));
      console.warn(`Upload attempt ${attempt + 1} failed (${res.status}):`, body);
    } catch (err) {
      console.warn(`Upload attempt ${attempt + 1} network error:`, err);
    }

    if (attempt < MAX_RETRIES) {
      const delay = 500 * 2 ** attempt; // 500ms, 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(`Upload permanently failed after ${MAX_RETRIES + 1} attempts: ${chunkId}`);
}
