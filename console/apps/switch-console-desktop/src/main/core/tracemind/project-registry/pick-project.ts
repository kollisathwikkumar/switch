import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { ensureLocation } from '@main/core/locations/store';
import type { Location } from '@shared/core/locations/locations';

/** A native picker chooses the path; selecting it does not approve any audit. */
export async function pickLocalProject(): Promise<Location | null> {
  const window = getMainWindow();
  if (!window) return null;
  const result = await dialog.showOpenDialog(window, {
    title: 'Select a local project for TraceMind',
    message: 'Choose a project directory to register locally.',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  if (!isAbsolute(result.filePaths[0])) throw new Error('Invalid project directory');
  const root = await realpath(result.filePaths[0]);
  if (!(await stat(root)).isDirectory()) throw new Error('Project is not a directory');
  return ensureLocation({ sshHost: null, dir: root, name: basename(root) || root });
}
