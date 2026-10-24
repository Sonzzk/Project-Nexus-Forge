import { describe, expect, it } from 'vitest';
import { isSensitivePath } from './sensitive-paths';

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    'config/.env.production',
    'keys/server.pem',
    'cert.PFX',
    'store.p12',
    'vault.kdbx',
    'release.keystore',
    'private.key',
    '.ssh/config',
    'home/.ssh/known_hosts',
    '.gnupg/pubring.kbx',
    '.aws/credentials',
    '.azure/accessTokens.json',
    'id_rsa',
    'id_rsa.pub',
    'keys\\id_ed25519',
    'id_ecdsa',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.git-credentials',
    'credentials.json',
    'credentials-prod.json',
    '.docker/config.json',
    '.claude/.credentials.json',
    '.codex/auth.json',
    'notes/my-secrets.txt',
    'Passwords.xlsx',
    'C:\\Users\\me\\.ssh\\id_rsa',
  ])('denies %s', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    'README.md',
    'src/main/index.ts',
    'Content/Maps/Level1.umap',
    'project.godot',
    'package.json',
    'docs/environment.md',
    '.envrc-notes/readme.md',
    '.docker/daemon-notes.txt',
    'sshd/readme.txt',
    '',
  ])('allows %s', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});
