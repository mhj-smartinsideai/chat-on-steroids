import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  executePlannerRelay,
  MAX_PLANNER_RELAY_READ_BYTES,
  MAX_PLANNER_RELAY_WRITE_BYTES,
  parsePlannerRelayRequest
} from '../src/main/planner/codex-mhj_26_09_02_07_relay.js';

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-relay-'));
  initConfigPath(path.join(tempRoot, 'config.json'));
  await fs.mkdir(path.join(tempRoot, 'orca_loop'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'orca_loop', 'machine.py'), 'class GenerationController:\n    pass\n', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'orca_loop', 'worker.py'), 'class Worker:\n    controller = GenerationController\n', 'utf8');
  const config = defaultConfig('win32');
  await saveConfig({ ...config, roots: [{ name: 'project', path: tempRoot }] });
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  initConfigPath(path.join(os.tmpdir(), 'planner-relay-test-unused'));
});

const run = (request: unknown) => executePlannerRelay(request, { rootName: 'project' });

describe('Planner Relay request validation', () => {
  it('accepts only the four operations and their declared fields', () => {
    expect(parsePlannerRelayRequest({ id: 'req-1', tool: 'list_directory', path: 'orca_loop' })).toEqual({
      id: 'req-1',
      tool: 'list_directory',
      path: 'orca_loop'
    });
    expect(() => parsePlannerRelayRequest({ id: 'req-1', tool: 'exec_command', path: '' })).toThrow();
    expect(() => parsePlannerRelayRequest({ id: 'req-1', tool: 'read_file', path: 'x', extra: true })).toThrow();
    expect(() => parsePlannerRelayRequest('{"id":')).toThrow();
  });

  it('rejects traversal, absolute Windows and UNC path spellings', () => {
    for (const value of ['../Windows', '..\\Windows', 'C:\\Windows\\System32', '\\\\server\\share', 'orca_loop/../../outside']) {
      expect(() => parsePlannerRelayRequest({ id: 'req-1', tool: 'read_file', path: value })).toThrow();
    }
  });
});

describe('Planner Relay filesystem operations', () => {
  it('lists immediate children deterministically', async () => {
    const result = await run({ id: 'req-1', tool: 'list_directory', path: 'orca_loop' });
    expect(result).toMatchObject({ id: 'req-1', tool: 'list_directory', ok: true, path: 'orca_loop', truncated: false });
    if (result.ok !== true || result.tool !== 'list_directory') throw new Error('unexpected list response');
    expect(result.entries).toEqual([
      { name: 'machine.py', type: 'file' },
      { name: 'worker.py', type: 'file' }
    ]);
  });

  it('reads UTF-8 text and reports bounded output', async () => {
    const result = await run({ id: 'req-2', tool: 'read_file', path: 'orca_loop/machine.py' });
    expect(result).toMatchObject({ id: 'req-2', tool: 'read_file', ok: true, path: 'orca_loop/machine.py', truncated: false });
    if (result.ok !== true || result.tool !== 'read_file') throw new Error('unexpected read response');
    expect(result.content).toContain('GenerationController');

    await fs.writeFile(path.join(tempRoot, 'large.txt'), `${'x'.repeat(100)}\n`.repeat(Math.ceil((MAX_PLANNER_RELAY_READ_BYTES + 100) / 101)), 'utf8');
    const bounded = await run({ id: 'req-3', tool: 'read_file', path: 'large.txt' });
    expect(bounded).toMatchObject({ ok: true, truncated: true, hasMore: true });
  });

  it('searches text files with bounded deterministic hits', async () => {
    const result = await run({ id: 'req-4', tool: 'search_files', path: 'orca_loop', query: 'GenerationController' });
    expect(result).toMatchObject({ id: 'req-4', tool: 'search_files', ok: true, path: 'orca_loop' });
    if (result.ok !== true || result.tool !== 'search_files') throw new Error('unexpected search response');
    expect(result.hits.map((hit) => hit.path)).toEqual(['orca_loop/machine.py', 'orca_loop/worker.py']);
    expect(result.hits[0]?.line).toBe(1);
  });

  it('writes and replaces only files under docs/plans', async () => {
    const first = await run({ id: 'req-5', tool: 'write_plan', path: 'docs/plans/poc_test.md', content: '# Planner Relay\n' });
    expect(first).toMatchObject({ id: 'req-5', tool: 'write_plan', ok: true, path: 'docs/plans/poc_test.md', mode: 'created' });
    expect(await fs.readFile(path.join(tempRoot, 'docs', 'plans', 'poc_test.md'), 'utf8')).toBe('# Planner Relay\n');

    const second = await run({ id: 'req-6', tool: 'write_plan', path: 'docs/plans/poc_test.md', content: '# Replaced\n' });
    expect(second).toMatchObject({ id: 'req-6', tool: 'write_plan', ok: true, mode: 'replaced' });
    expect(await fs.readFile(path.join(tempRoot, 'docs', 'plans', 'poc_test.md'), 'utf8')).toBe('# Replaced\n');

    const outside = await run({ id: 'req-7', tool: 'write_plan', path: 'orca_loop/HACK.md', content: 'fail' });
    expect(outside).toMatchObject({ id: 'req-7', tool: 'write_plan', ok: false, error: 'path_not_allowed' });
    await expect(fs.access(path.join(tempRoot, 'orca_loop', 'HACK.md'))).rejects.toThrow();
  });

  it('fails closed when the configured root is not the target project', async () => {
    const result = await executePlannerRelay({ id: 'req-8', tool: 'list_directory', path: 'orca_loop' });
    expect(result).toMatchObject({ id: 'req-8', tool: 'list_directory', ok: false, error: 'planner_root_unavailable' });
  });

  it('rejects oversized plan content before writing', async () => {
    await expect(run({ id: 'req-9', tool: 'write_plan', path: 'docs/plans/large.md', content: 'x'.repeat(MAX_PLANNER_RELAY_WRITE_BYTES + 1) })).rejects.toThrow();
  });
});
