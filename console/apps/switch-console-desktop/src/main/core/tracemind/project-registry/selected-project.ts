import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface LocalLocationCandidate {
  id: string;
  dir: string;
  sshHost: string | null;
}

export interface SelectedProject {
  locationId: string;
  root: string;
}

/**
 * Resolve a location already selected and authorized by the user. This does not itself
 * establish consent or prevent a path from being replaced after it is resolved.
 */
export async function resolveSelectedLocalProject(
  locationId: string,
  getLocation: (id: string) => Promise<LocalLocationCandidate | undefined>
): Promise<SelectedProject> {
  if (!locationId.trim()) throw new Error('Location not found');
  const location = await getLocation(locationId);
  if (!location || location.id !== locationId) throw new Error('Location not found');
  if (location.sshHost !== null) throw new Error('A local location is required');
  if (!isAbsolute(location.dir)) throw new Error('An absolute directory is required');
  const root = await realpath(location.dir);
  if (!(await stat(root)).isDirectory()) throw new Error('Location is not a directory');
  return { locationId, root };
}
