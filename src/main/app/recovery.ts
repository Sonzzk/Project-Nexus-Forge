import { AppError } from '@shared/errors';
import type { Logger } from '../logging';
import { backupsDir, newestUsableBackup, replaceDatabase, setAsideDatabase } from '../storage';
import { join } from 'node:path';

// Startup recovery (spec §22, KI-010). When the database cannot be used, the app does not guess: it says what is wrong and
// offers the safe choices in a native dialog. Nothing is deleted; a database that is set aside is renamed and stays in the
// data folder.

export interface RecoveryDeps {
  userDataDir: string;
  /** The newest schema version this build can use. */
  knownSchemaVersion: number;
  logFile: string;
  /** Shows a native message box and resolves to the index of the button pressed. */
  showBox(options: { title: string; message: string; detail: string; buttons: string[] }): Promise<number>;
  openFolder(path: string): void;
  /** Starts the app again and quits this instance. */
  relaunch(): void;
  logger: Logger;
  now?: () => Date;
}

/** True for the errors this module can offer a way out of. */
export const isRecoverable = (error: unknown): error is AppError =>
  error instanceof AppError && (error.code === 'DB_CORRUPT' || error.code === 'DB_NEWER_THAN_APP');

/**
 * Asks the user what to do about an unusable database and does it. Resolves to `true` when the app was set to restart, or
 * `false` when the user chose to quit (or nothing could be done).
 */
export async function runStartupRecovery(error: AppError, deps: RecoveryDeps): Promise<boolean> {
  const newer = error.code === 'DB_NEWER_THAN_APP';
  for (;;) {
    const backup = newestUsableBackup(deps.userDataDir, deps.knownSchemaVersion);
    const buttons: { label: string; run: () => Promise<boolean | 'again'> }[] = [];
    if (backup !== undefined)
      buttons.push({
        label: 'Restore the newest backup',
        run: () => {
          replaceDatabase({ userDataDir: deps.userDataDir, source: join(backupsDir(deps.userDataDir), backup), kind: newer ? 'replaced' : 'corrupt', ...(deps.now === undefined ? {} : { now: deps.now }) });
          deps.logger.info('startup recovery: restored a backup', { backup });
          deps.relaunch();
          return Promise.resolve(true);
        },
      });
    buttons.push(
      {
        label: 'Open the backups folder',
        run: () => {
          deps.openFolder(backupsDir(deps.userDataDir));
          return Promise.resolve('again');
        },
      },
      {
        label: 'Start a new, empty database',
        run: () => {
          const moved = setAsideDatabase(deps.userDataDir, deps.now);
          deps.logger.warn('startup recovery: database set aside', { movedTo: moved });
          deps.relaunch();
          return Promise.resolve(true);
        },
      },
      { label: 'Quit', run: () => Promise.resolve(false) },
    );

    const choice = await deps.showBox({
      title: 'GameDev Command Center cannot open its data',
      message: newer
        ? 'The app data was made by a newer version of GameDev Command Center, so this version will not touch it.'
        : 'The app data file is damaged or is not a database.',
      detail: [
        error.message,
        backup === undefined
          ? 'No usable backup was found.'
          : `The newest usable backup is ${backup}. Restoring it replaces the current data with that backup; the current file is renamed and kept.`,
        'Starting a new database also keeps the old file (renamed) in the data folder. Nothing is deleted. Your project folders are never touched.',
        `Data folder: ${deps.userDataDir}\nLog: ${deps.logFile}`,
      ].join('\n\n'),
      buttons: buttons.map((b) => b.label),
    });
    const outcome = await buttons[choice]?.run();
    if (outcome !== 'again') return outcome === true;
  }
}
