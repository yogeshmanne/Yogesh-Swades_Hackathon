// On startup: re-upload any OPFS chunks that were never acked in DB

import { getChunksDir, listChunksInOpfs, deleteChunkFromOpfs } from "./opfs";
import { uploadChunk } from "./uploader";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

export async function reconcile(sessionId: string): Promise<number> {
  let recoveredCount = 0;

  // 1. Get all acked chunk IDs from server
  let ackedSet: Set<string>;
  try {
    const res = await fetch(`${API_URL}/api/chunks/status/${sessionId}`);
    const data: { ackedIds: string[] } = await res.json();
    ackedSet = new Set(data.ackedIds);
  } catch {
    console.warn("Reconciler: could not fetch acked IDs, skipping");
    return 0;
  }

  // 2. Scan OPFS for chunks belonging to this session
  const dir = await getChunksDir();
  const opfsChunks = await listChunksInOpfs(dir, sessionId);

  for (const { name, file } of opfsChunks) {
    if (ackedSet.has(name)) {
      // Acked in DB  safe to remove from OPFS
      await deleteChunkFromOpfs(dir, name);
      continue;
    }

    // Not acked  re-upload
    const parts = name.split("-chunk-");
    const idx = parts[1] !== undefined ? parseInt(parts[1], 10) : 0;

    try {
      await uploadChunk(sessionId, name, idx, file);
      await deleteChunkFromOpfs(dir, name);
      recoveredCount++;
      console.log(`Reconciler: recovered chunk ${name}`);
    } catch (err) {
      console.error(`Reconciler: failed to recover chunk ${name}`, err);
      // Leave in OPFS for next startup
    }
  }

  return recoveredCount;
}
