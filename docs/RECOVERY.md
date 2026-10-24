# Recovery guide

Plain steps for getting the app's own data back. Your game projects are never part of this: the app does not copy, change or back up project folders, so use Git and your own backups for those.

## Make a backup

Settings, then Data and backups, then **Back up now**. To have the app do it for you, turn on **Back up automatically** and choose how often. Backups are kept in `%APPDATA%\GameDevCommandCenter\backups\`. Copy that folder somewhere else now and then if the data matters to you.

## Go back to an earlier backup

1. Settings, Data and backups, find the backup, press **Restore…**.
2. Read the confirmation and press **Restore and restart**. The app saves your current data first (a backup named "Before a restore"), then restarts with the old data.
3. Changed your mind? Restore the "Before a restore" backup the same way.

The data that was in use is also kept as `data\gdcc.replaced-<time>.db` in the app data folder.

## The app says it cannot open its data

If the database is damaged, or was made by a newer version of the app, a window offers:

- **Restore the newest backup.** Uses the newest backup that passes its check and is not newer than this app. The unusable file is renamed, not deleted.
- **Open the backups folder.** Look at what you have; then choose again.
- **Start a new, empty database.** The old file is renamed `gdcc.corrupt-<time>.db`. You can ask for help recovering it later, or restore a backup afterwards.
- **Quit.** Nothing is changed.

If the message says the data comes from a newer version, install that version (or a later one) rather than restoring an old backup, unless you accept losing what the newer version stored.

## Move data to another PC or keep a copy

**Export data…** writes settings, projects, project detections and activity to a JSON file. On the other PC (same or newer app version), **Choose a file to import…** shows what would be added, changed or skipped. Nothing is overwritten unless you choose "Replace", and you confirm the project folders that would be added. The exported file contains project folder names and notes, so treat it as private.

## If something goes wrong anyway

- The log is `%APPDATA%\GameDevCommandCenter\logs\main.log` (secrets are redacted).
- Files named `gdcc.replaced-*.db` and `gdcc.corrupt-*.db` in `data\` are earlier databases. A copy of one can be opened with any SQLite tool; do not edit the live `gdcc.db` by hand.
- Never delete `backups\` while the app is deciding what to restore.
