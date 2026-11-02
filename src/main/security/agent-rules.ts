// Deny rules passed to Claude Code on every run (spec §14, ARCHITECTURE.md section 28). A deny rule blocks in every permission mode
// and no allow rule overrides it (Claude Code docs, "Configure permissions"), so these hold even if an option elsewhere is widened.
// Syntax checked 2026-10-24: `Read(<gitignore-style path>)` and `Edit(<path>)` (Edit rules cover every file-editing tool), a bare
// file name matches at any depth, and `Bash(<command> *)` matches a command prefix.

/** File names and folders that can hold credentials. Mirrors `isSensitivePath`, which keeps them out of previews and context packs. */
const SECRET_FILES = [
  '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', '*.kdbx', '*.keystore',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa*', 'id_ecdsa*', 'id_ed25519*', 'credentials*.json',
  '*secret*', '*password*', '.ssh/**', '.gnupg/**', '.aws/**', '.azure/**', '.docker/config.json', '.claude/.credentials.json', '.codex/auth.json',
];

/**
 * Files that run code later or change what an agent may do: Claude Code's own settings and hooks, MCP server lists, Git hooks, CI files.
 * A writing run may not edit them, because an edit there would run outside any permission check the next time something starts.
 */
const CODE_RUNNING_FILES = ['.claude/**', '.mcp.json', '.git/**', '.husky/**', '.github/workflows/**'];

/** Commands that delete files or rewrite history. In a headless run nothing can approve a command anyway; this is the second lock. */
const DESTRUCTIVE_COMMANDS = [
  'Bash(rm *)', 'Bash(rmdir *)', 'Bash(del *)', 'Bash(rd *)', 'Bash(rimraf *)',
  'Bash(git reset *)', 'Bash(git clean *)', 'Bash(git checkout *)', 'Bash(git restore *)', 'Bash(git push *)', 'Bash(git rebase *)',
  'Bash(git filter-branch *)', 'Bash(git branch -D *)', 'Bash(git stash drop *)', 'Bash(git reflog expire *)',
  'PowerShell(Remove-Item *)', 'PowerShell(git reset *)', 'PowerShell(git clean *)', 'PowerShell(git push *)',
];

/** The rules for `--disallowedTools`: no reading or editing of secret files, no editing of files that run code later, and no destructive commands. */
export function agentDenyRules(): string[] {
  return [...SECRET_FILES.flatMap((file) => [`Read(${file})`, `Edit(${file})`]), ...CODE_RUNNING_FILES.map((file) => `Edit(${file})`), ...DESTRUCTIVE_COMMANDS];
}

/** What a write-capable Claude Code run may do without asking: edit files. Nothing else is pre-approved, and a headless run denies the rest. */
export const AGENT_WRITE_ALLOW = ['Edit', 'Write'] as const;
