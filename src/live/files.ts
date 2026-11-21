import { readdir, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

/** Total size of the files under a folder; 0 when it does not exist. */
export async function folderBytes(folder: string): Promise<number> {
  let total = 0;
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    total += entry.isDirectory() ? await folderBytes(file) : (await stat(file)).size;
  }
  return total;
}

/** Remove a folder after its rows are gone; a failure leaves an orphan for retention to sweep. */
export async function removeFolder(folder: string) {
  await rm(folder, { recursive: true, force: true }).catch(() => {});
}

/**
 * rename() that waits out a brief lock: Windows refuses to move a folder while another process
 * (an antivirus, the search indexer, or the cloud sync uploading an image) has a file in it open. Other errors, or a lock that outlasts ~3 s, are thrown.
 */
export async function moveFolder(from: string, to: string, move = rename) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await move(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}
