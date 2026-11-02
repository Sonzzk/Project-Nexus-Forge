import { describe, expect, it } from 'vitest';
import { SETTING_KEYS } from '@shared/settings';
import { agentDenyRules } from './agent-rules';
import { isSensitivePath } from './sensitive-paths';

// Secret protection (spec §14): credentials are never kept in ordinary settings, and the files that can hold them are denied to
// agents with the same list that keeps them out of previews and context packs.

describe('secret protection', () => {
  it('keeps no credential in ordinary settings: no setting is named like one', () => {
    expect(SETTING_KEYS.filter((key) => /password|secret|token|api[-_]?key|credential|auth/i.test(key))).toEqual([]);
  });

  it('denies agents every file name the context denylist keeps out of packs, for reading and for editing', () => {
    const rules = new Set(agentDenyRules());
    const samples: [string, string][] = [
      ['.env', '.env'],
      ['config/.env.production', '.env.*'],
      ['certs/server.pem', '*.pem'],
      ['deploy/signing.key', '*.key'],
      ['store.pfx', '*.pfx'],
      ['keys/vault.kdbx', '*.kdbx'],
      ['android.keystore', '*.keystore'],
      ['.npmrc', '.npmrc'],
      ['.git-credentials', '.git-credentials'],
      ['home/.ssh/id_rsa', 'id_rsa*'],
      ['credentials-prod.json', 'credentials*.json'],
      ['notes/passwords.txt', '*password*'],
      ['secrets.yml', '*secret*'],
      ['.aws/config', '.aws/**'],
    ];
    for (const [path, pattern] of samples) {
      expect(isSensitivePath(path), path).toBe(true);
      expect(rules.has(`Read(${pattern})`), `Read(${pattern})`).toBe(true);
      expect(rules.has(`Edit(${pattern})`), `Edit(${pattern})`).toBe(true);
    }
  });

  it('denies editing the files that would run code outside any check: agent settings and hooks, MCP lists, Git hooks, CI', () => {
    const rules = agentDenyRules();
    for (const rule of ['Edit(.claude/**)', 'Edit(.mcp.json)', 'Edit(.git/**)', 'Edit(.husky/**)', 'Edit(.github/workflows/**)']) expect(rules).toContain(rule);
    expect(rules).not.toContain('Read(.claude/**)'); // reading them is fine; only changing them is not
  });

  it('denies the destructive commands in every writing run', () => {
    const rules = agentDenyRules();
    for (const rule of ['Bash(rm *)', 'Bash(git reset *)', 'Bash(git clean *)', 'Bash(git checkout *)', 'Bash(git push *)', 'Bash(git rebase *)', 'PowerShell(Remove-Item *)']) expect(rules).toContain(rule);
  });
});
