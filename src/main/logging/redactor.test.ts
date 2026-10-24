import { describe, expect, it } from 'vitest';
import { createRedactor } from './redactor';

const redactor = createRedactor({ homeDir: 'C:\\Users\\Amos Remahl' });

describe('redact', () => {
  it.each([
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'Anthropic key'],
    ['sk-proj1234567890abcdefghijkl', 'OpenAI-style key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub token'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'GitHub fine-grained token'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS key id'],
    ['xoxb-1234567890-abcdefghij', 'Slack token'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstuvw', 'Google key'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'JWT'],
  ])('removes %s (%s)', (secret) => {
    const out = redactor.redact(`value is ${secret} here`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('removes bearer tokens, basic credentials and credentials inside URLs', () => {
    expect(redactor.redact('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890');
    expect(redactor.redact('git clone https://me:hunter2@github.com/x/y.git')).toBe(
      'git clone https://[redacted]@github.com/x/y.git',
    );
    expect(redactor.redact('Authorization: Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNzd29yZA');
  });

  it('removes whole private key blocks', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----';
    const out = redactor.redact(`before\n${block}\nafter`);
    expect(out).toBe('before\n[redacted private key]\nafter');
  });

  it.each([
    ['password=hunter2', 'hunter2'],
    ['PASSWORD: hunter2', 'hunter2'],
    ['{"api_key": "abc123xyz"}', 'abc123xyz'],
    ["client_secret = 'topsecretvalue'", 'topsecretvalue'],
    ['ANTHROPIC_API_KEY=plainvalue123', 'plainvalue123'],
    ['access_token=zzz999', 'zzz999'],
  ])('removes the value of a secret-named key in %s', (text, value) => {
    expect(redactor.redact(text)).not.toContain(value);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Build passed in 12 ms; author: Sonzzk; compass=north; max 4096 items';
    expect(redactor.redact(text)).toBe(text);
  });

  it('shows the home folder as ~ with either slash, and only as a whole folder name', () => {
    expect(redactor.redact('C:\\Users\\Amos Remahl\\AppData\\x')).toBe('~\\AppData\\x');
    expect(redactor.redact('c:/users/amos remahl/Documents')).toBe('~/Documents');
    expect(redactor.redact('C:\\Users\\Amos Remahl2\\x')).toBe('C:\\Users\\Amos Remahl2\\x');
  });
});

describe('redactValue', () => {
  it('redacts strings deeply and secret-named keys, without changing the input', () => {
    const input = {
      path: 'C:\\Users\\Amos Remahl\\game',
      token: 'abc',
      nested: { list: ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 1, null], Password: 'x' },
      tokenEstimate: 1200,
    };
    const out = redactor.redactValue(input);
    expect(out).toEqual({
      path: '~\\game',
      token: '[redacted]',
      nested: { list: ['[redacted]', 1, null], Password: '[redacted]' },
      tokenEstimate: 1200,
    });
    expect(input.token).toBe('abc');
  });

  it('turns errors into plain redacted objects, including the cause', () => {
    const error = new Error('failed with token=abc12345', { cause: new Error('inner password=pw') });
    const out = redactor.redactValue({ error }) as { error: { message: string; cause: { message: string } } };
    expect(out.error.message).toBe('failed with token=[redacted]');
    expect(out.error.cause.message).toBe('inner password=[redacted]');
  });

  it('survives circular references', () => {
    const loop: Record<string, unknown> = { name: 'x' };
    loop['self'] = loop;
    expect(redactor.redactValue(loop)).toEqual({ name: 'x', self: '[circular]' });
  });
});
