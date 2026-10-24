import { describe, expect, it } from 'vitest';
import { MODEL_NAME, parseSuggestedSteps, PROVIDER_IDS, PROVIDER_LOCATION } from './providers';

describe('provider facts', () => {
  it('knows which providers keep text on this PC and which send it to a vendor', () => {
    expect(PROVIDER_IDS).toEqual(['ollama', 'claude-code', 'codex']);
    expect(PROVIDER_LOCATION).toEqual({ ollama: 'local', 'claude-code': 'cloud', codex: 'cloud' });
  });

  it('accepts ordinary model names and refuses anything that could be an option, a path or a command', () => {
    for (const ok of ['llama3.2:1b', 'qwen2.5-coder:7b', 'library/model:latest', 'hf.co/user/repo:Q4_K_M']) expect(MODEL_NAME.test(ok), ok).toBe(true);
    for (const bad of ['', '-rf', 'a b', 'a;b', 'a$b', 'a|b', 'x'.repeat(201), 'name\n']) expect(MODEL_NAME.test(bad), bad).toBe(false);
  });
});

describe('reading suggested steps', () => {
  it('reads plain JSON, JSON in a code fence, JSON surrounded by chatter, and a bare list of titles', () => {
    const steps = [{ title: 'Add input', acceptance: ['C works'] }, { title: 'Lower camera', acceptance: [] }];
    expect(parseSuggestedSteps(JSON.stringify({ steps }))).toEqual(steps);
    expect(parseSuggestedSteps('```json\n' + JSON.stringify({ steps }) + '\n```')).toEqual(steps);
    expect(parseSuggestedSteps('Sure! Here you go: ' + JSON.stringify({ steps }) + ' Hope that helps.')).toEqual(steps);
    expect(parseSuggestedSteps('["One","Two"]')).toEqual([{ title: 'One', acceptance: [] }, { title: 'Two', acceptance: [] }]);
    expect(parseSuggestedSteps('{"steps":[{"title":"Only a title"}]}')).toEqual([{ title: 'Only a title', acceptance: [] }]);
  });

  it('refuses anything that is not a list of steps instead of guessing', () => {
    for (const bad of ['', 'No steps here.', '{"steps":[]}', '{"steps":"nope"}', '{"steps":[{"name":"x"}]}', '[1,2,3]', '{"steps":[{"title":""}]}', '{"steps": [', JSON.stringify({ steps: Array.from({ length: 31 }, (_, i) => `s${i}`) })])
      expect(parseSuggestedSteps(bad), bad).toBeUndefined();
  });
});
