import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadSource } from '../src/download-source.ts';
import { discoverSkills } from '../src/skills.ts';

function mockFetchFile(filePath: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const bytes = readFileSync(filePath);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length) },
      });
    })
  );
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: Array<{ path: string; contents: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const contents = Buffer.from(entry.contents);
    const checksum = crc32(contents);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + contents.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

describe('downloadSource', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `skills-download-source-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts a direct SKILL.md download', async () => {
    const skillFile = join(testDir, 'download');
    writeFileSync(
      skillFile,
      `---
name: direct-url-skill
description: A skill served as a bare markdown download
---

# Direct URL Skill
`
    );
    mockFetchFile(skillFile);

    const downloaded = await downloadSource('https://internal.example.com/download');
    const skills = await discoverSkills(downloaded.rootDir);

    expect(downloaded.kind).toBe('skill-md');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('direct-url-skill');

    rmSync(downloaded.tempDir, { recursive: true, force: true });
  });

  it.each([
    ['tar', false],
    ['tgz', true],
  ])('accepts a %s archive download without relying on the URL extension', async (_label, gzip) => {
    const archiveRoot = join(testDir, 'archive-root');
    const skillDir = join(archiveRoot, 'repo-main', 'skills', 'archive-url-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: archive-url-skill
description: A skill served from an archive
---

# Archive URL Skill
`
    );

    const archivePath = join(testDir, `payload.${gzip ? 'tgz' : 'tar'}`);
    await tar.c({ cwd: archiveRoot, gzip, file: archivePath }, ['repo-main']);
    mockFetchFile(archivePath);

    const downloaded = await downloadSource('https://internal.example.com/download');
    const skills = await discoverSkills(downloaded.rootDir);

    expect(downloaded.kind).toBe('archive');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('archive-url-skill');

    rmSync(downloaded.tempDir, { recursive: true, force: true });
  });

  it('accepts a zip archive download without relying on the URL extension', async () => {
    const zipPath = join(testDir, 'payload.zip');
    writeFileSync(
      zipPath,
      createStoredZip([
        {
          path: 'repo-main/skills/zip-url-skill/SKILL.md',
          contents: `---
name: zip-url-skill
description: A skill served from a zip archive
---

# Zip URL Skill
`,
        },
      ])
    );
    mockFetchFile(zipPath);

    const downloaded = await downloadSource('https://internal.example.com/download');
    const skills = await discoverSkills(downloaded.rootDir);

    expect(downloaded.kind).toBe('archive');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('zip-url-skill');

    rmSync(downloaded.tempDir, { recursive: true, force: true });
  });

  it('reports unsafe archive paths instead of treating the archive as unsupported', async () => {
    const zipPath = join(testDir, 'unsafe.zip');
    writeFileSync(
      zipPath,
      createStoredZip([
        {
          path: '../SKILL.md',
          contents: `---
name: unsafe-skill
description: Unsafe archive path
---
`,
        },
      ])
    );
    mockFetchFile(zipPath);

    await expect(downloadSource('https://internal.example.com/download')).rejects.toThrow(
      'Archive contains unsafe path'
    );
  });

  it('reports archive file count limit errors instead of treating the archive as unsupported', async () => {
    const zipPath = join(testDir, 'too-many-files.zip');
    writeFileSync(
      zipPath,
      createStoredZip([
        {
          path: 'repo-main/skills/limited/SKILL.md',
          contents: '---\nname: limited\ndescription: Limited\n---\n',
        },
        { path: 'repo-main/skills/limited/extra.txt', contents: 'extra' },
      ])
    );
    mockFetchFile(zipPath);
    vi.stubEnv('SKILLS_EXTRACT_MAX_FILES', '1');

    await expect(downloadSource('https://internal.example.com/download')).rejects.toThrow(
      'Archive contains too many files'
    );
  });

  it('counts tar directory entries toward the archive entry limit', async () => {
    const archiveRoot = join(testDir, 'directory-limit');
    const skillDir = join(archiveRoot, 'repo-main', 'skills', 'limited');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: limited\ndescription: Limited\n---\n');

    const archivePath = join(testDir, 'directory-limit.tgz');
    await tar.c({ cwd: archiveRoot, gzip: true, file: archivePath }, ['repo-main']);
    mockFetchFile(archivePath);
    vi.stubEnv('SKILLS_EXTRACT_MAX_FILES', '1');

    let downloadedTempDir: string | undefined;
    try {
      const downloaded = await downloadSource('https://internal.example.com/download');
      downloadedTempDir = downloaded.tempDir;
      expect.fail('expected archive entry limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Archive contains too many files');
    } finally {
      if (downloadedTempDir) {
        rmSync(downloadedTempDir, { recursive: true, force: true });
      }
    }
  });
});
