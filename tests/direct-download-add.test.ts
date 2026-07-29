import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@clack/prompts', () => {
  const noop = () => {};
  return {
    intro: noop,
    outro: noop,
    note: noop,
    confirm: vi.fn().mockResolvedValue(true),
    cancel: noop,
    log: {
      info: noop,
      message: noop,
      warn: noop,
      error: noop,
      step: noop,
      success: noop,
    },
    spinner: () => ({ start: noop, stop: noop }),
  };
});

vi.mock('picocolors', () => {
  const identity = (value: string) => value;
  const colors = [
    'red',
    'green',
    'blue',
    'yellow',
    'cyan',
    'white',
    'black',
    'dim',
    'bold',
    'bgRed',
    'bgCyan',
    'bgBlack',
    'bgWhite',
    'underline',
    'inverse',
    'magenta',
    'gray',
    'reset',
  ];
  const colorMap: any = identity;
  for (const color of colors) colorMap[color] = identity;
  return { default: colorMap };
});

vi.mock('../src/telemetry.ts', () => ({
  track: vi.fn(),
  setVersion: vi.fn(),
  fetchAuditData: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/detect-agent.ts', () => ({
  detectAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: { name: 'none' } }),
  getAgentType: vi.fn(),
  ensureUniversalAgents: vi.fn((agents: string[]) => agents),
}));

vi.mock('../src/source-parser.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/source-parser.ts')>();
  return {
    ...actual,
    isRepoPrivate: vi.fn().mockResolvedValue(false),
  };
});

import { runAdd } from '../src/add.ts';

describe('direct download add', () => {
  let project: string;
  let originalCwd: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'direct-download-add-'));
    originalCwd = process.cwd();
    process.chdir(project);
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await rm(project, { recursive: true, force: true });
  });

  it('installs a signed direct URL without persisting it for updates', async () => {
    const directUrl = 'https://downloads.example.com/artifacts/direct-skill?x-amz-signature=secret';
    const skillMd = '---\nname: direct-skill\ndescription: Direct skill\n---\n\n# Direct skill\n';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === directUrl) {
        return new Response(skillMd, {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(skillMd)) },
        });
      }
      return new Response('not found', { status: 404 });
    });

    await runAdd([directUrl], {
      yes: true,
      agent: ['codex'],
      global: false,
      copy: true,
    });

    await expect(
      readFile(join(project, '.agents', 'skills', 'direct-skill', 'SKILL.md'), 'utf-8')
    ).resolves.toContain('# Direct skill');
    expect(existsSync(join(project, 'skills-lock.json'))).toBe(false);
  });
});
