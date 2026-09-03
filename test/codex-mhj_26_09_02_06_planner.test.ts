import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  documentRelativePath,
  validateRelativePath
} from '../src/main/planner/codex-mhj_26_09_02_02_security.js';
import {
  planWrite,
  repoRead,
  repoSearch,
  repoTree
} from '../src/main/planner/codex-mhj_26_09_02_03_repository.js';
import { MAX_PLANNER_WRITE_BYTES } from '../src/main/planner/codex-mhj_26_09_02_01_types.js';
import { PLANNER_HTML, PLANNER_SCRIPT } from '../src/main/planner/codex-mhj_26_09_02_04_page.js';
import {
  plannerServerPort,
  shutdownPlannerServer,
  startPlannerServer
} from '../src/main/planner/codex-mhj_26_09_02_05_server.js';

let tempRoot = '';
let serverStarted = false;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-bridge-'));
  initConfigPath(path.join(tempRoot, 'config.json'));
  await fs.mkdir(path.join(tempRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'README.md'), '# Planner\n\n카메라 계획\n', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'src', 'service.ts'), 'export class CameraService {}\n', 'utf8');
  const config = defaultConfig('win32');
  await saveConfig({ ...config, roots: [{ name: 'project', path: tempRoot }] });
});

afterEach(async () => {
  if (serverStarted) {
    await shutdownPlannerServer();
    serverStarted = false;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  initConfigPath(path.join(os.tmpdir(), 'planner-bridge-test-unused'));
});

describe('planner security', () => {
  it('accepts relative paths and rejects escape spellings', () => {
    expect(validateRelativePath('src/service.ts')).toBe('src/service.ts');
    expect(validateRelativePath('')).toBe('');
    for (const value of ['../secret', '..\\secret', '/etc/passwd', '\\windows\\system32', 'C:\\outside', '\\\\server\\share']) {
      expect(() => validateRelativePath(value)).toThrow();
    }
  });

  it('maps only the five logical document types', () => {
    expect(documentRelativePath('TASK-001', 'plan', null).relativePath).toBe('docs/tasks/TASK-001/00_plan.md');
    expect(documentRelativePath('TASK-001', 'macro', null).relativePath).toBe('docs/tasks/TASK-001/01_macro.md');
    expect(documentRelativePath('TASK-001', 'micro', 'M01').relativePath).toBe('docs/tasks/TASK-001/micro/M01.md');
    expect(documentRelativePath('TASK-001', 'status', null).relativePath).toBe('docs/tasks/TASK-001/status.md');
    expect(documentRelativePath('TASK-001', 'review', null).relativePath).toBe('docs/tasks/TASK-001/review.md');
    expect(() => documentRelativePath('../TASK', 'plan', null)).toThrow();
    expect(() => documentRelativePath('TASK', 'micro', null)).toThrow();
    expect(() => documentRelativePath('TASK', 'unknown', null)).toThrow();
  });
});

describe('planner repository operations', () => {
  it('returns bounded tree, search and UTF-8 read results', async () => {
    const tree = await repoTree({ rootName: 'project', path: '', depth: 3 });
    expect(tree.entries.map((entry) => entry.path)).toContain('README.md');
    expect((await repoSearch({ rootName: 'project', query: 'CameraService', path: '', mode: 'content', maxResults: 50, include: null, caseSensitive: false })).hits[0]?.path).toBe('src/service.ts');
    const read = await repoRead({ rootName: 'project', path: 'README.md', startLine: null, endLine: null, maxBytes: 4096 });
    expect(read.text).toContain('카메라 계획');
  });

  it('writes only fixed planning documents and replaces them', async () => {
    const first = await planWrite({ rootName: 'project', taskId: 'TASK-001', documentType: 'plan', blockId: null, content: '# 계획\n' });
    expect(first.relativePath).toBe('docs/tasks/TASK-001/00_plan.md');
    expect(first.mode).toBe('created');
    const second = await planWrite({ rootName: 'project', taskId: 'TASK-001', documentType: 'plan', blockId: null, content: '# 수정 계획\n' });
    expect(second.mode).toBe('replaced');
    expect(await fs.readFile(path.join(tempRoot, 'docs/tasks/TASK-001/00_plan.md'), 'utf8')).toBe('# 수정 계획\n');
    expect(await fs.readdir(path.join(tempRoot, 'docs/tasks/TASK-001'))).toContain('00_plan.md');
    for (const documentType of ['status', 'review'] as const) {
      const result = await planWrite({ rootName: 'project', taskId: 'TASK-001', documentType, blockId: null, content: `# ${documentType}\n` });
      expect(result.relativePath).toBe(`docs/tasks/TASK-001/${documentType}.md`);
      expect(await fs.readFile(path.join(tempRoot, result.relativePath), 'utf8')).toBe(`# ${documentType}\n`);
    }
  });

  it('rejects oversized plan content', async () => {
    await expect(planWrite({ rootName: 'project', taskId: 'TASK-001', documentType: 'plan', blockId: null, content: 'x'.repeat(MAX_PLANNER_WRITE_BYTES + 1) })).rejects.toThrow();
  });
});

describe('planner page adapter', () => {
  it('contains diagnostics and exactly four registrations', () => {
    expect(PLANNER_HTML).toContain('/planner.js');
    expect(PLANNER_SCRIPT).toContain('document.modelContext');
    expect((PLANNER_SCRIPT.match(/name: '(repo_tree|repo_search|repo_read|plan_write)'/g) ?? [])).toHaveLength(4);
    expect(PLANNER_SCRIPT).toContain('readOnlyHint: true');
    expect(new Function(PLANNER_SCRIPT)).toBeInstanceOf(Function);
  });
});

describe('planner HTTP server', () => {
  it('serves the page and four bounded local operations', async () => {
    expect(await startPlannerServer()).toBe(8771);
    serverStarted = true;
    expect(plannerServerPort()).toBe(8771);
    const base = 'http://127.0.0.1:8771';
    const page = await fetch(`${base}/planner`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Planner Bridge');
    const status = await fetch(`${base}/api/planner/status?root=project`);
    expect(status.status).toBe(200);
    expect((await status.json()).selectedRoot).toBe('project');
    const origin = { Origin: 'http://127.0.0.1:8771', 'Content-Type': 'application/json' };
    const tree = await fetch(`${base}/api/planner/tree`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ rootName: 'project', path: '', depth: 1 })
    });
    expect(tree.status).toBe(200);
    expect((await tree.json()).entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'README.md' })]));
    const read = await fetch(`${base}/api/planner/read`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ rootName: 'project', path: 'README.md', maxBytes: 4096 })
    });
    expect(read.status).toBe(200);
    expect((await read.json()).text).toContain('카메라 계획');
    const write = await fetch(`${base}/api/planner/write`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ rootName: 'project', taskId: 'HTTP-001', documentType: 'micro', blockId: 'M01', content: '# HTTP\n' })
    });
    expect(write.status).toBe(200);
    expect((await write.json()).relativePath).toBe('docs/tasks/HTTP-001/micro/M01.md');
    const rejected = await fetch(`${base}/api/planner/write`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootName: 'project', taskId: 'HTTP-002', documentType: 'plan', blockId: null, content: '# blocked\n' })
    });
    expect(rejected.status).toBe(403);
    await shutdownPlannerServer();
    serverStarted = false;
  });
});
