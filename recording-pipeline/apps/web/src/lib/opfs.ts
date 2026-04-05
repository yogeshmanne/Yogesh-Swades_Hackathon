// Origin Private File System helpers — crash-safe local buffer

export async function getChunksDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("chunks", { create: true });
}

export async function saveChunkToOpfs(
  dir: FileSystemDirectoryHandle,
  chunkId: string,
  blob: Blob
): Promise<void> {
  const fileHandle = await dir.getFileHandle(chunkId, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function deleteChunkFromOpfs(
  dir: FileSystemDirectoryHandle,
  chunkId: string
): Promise<void> {
  try {
    await dir.removeEntry(chunkId);
  } catch {
    // Already deleted or never existed — safe to ignore
  }
}

export async function listChunksInOpfs(
  dir: FileSystemDirectoryHandle,
  sessionPrefix: string
): Promise<Array<{ name: string; file: File }>> {
  const results: Array<{ name: string; file: File }> = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(sessionPrefix) && handle.kind === "file") {
      const file = await (handle as FileSystemFileHandle).getFile();
      results.push({ name, file });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}
