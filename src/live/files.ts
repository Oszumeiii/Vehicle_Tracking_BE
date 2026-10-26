import { readdir, rm, stat } from 'node:fs/promises';
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
