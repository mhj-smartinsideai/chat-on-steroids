import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  executeFullRelay,
  parseFullRelayRequest,
  resetFullRelayStateForTests,
  type FullRelayResponse
} from '../src/main/full/codex-mhj_26_09_02_09_relay.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const CONVERSATION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let tempRoot = '';
let userData = '';

function request(tool: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { conversationId: CONVERSATION, id: `${tool}-001`, mode: 'full', tool, ...fields };
}

function successful(response: FullRelayResponse): Extract<FullRelayResponse, { ok: true }> {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error('expected a successful Full Relay response');
  return response;
}

beforeEach(async () => {
  tempRoot = await makeTempDir('full-relay-');
  userData = await makeTempDir('full-relay-state-');
  initConfigPath(path.join(userData, 'config.json'));
  initSessionStore(path.join(userData, 'sessions'));
  resetFullRelayStateForTests();
  resetSessionStoreForTests();
  resetRecorderForTests();
  await fs.mkdir(path.join(tempRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'README.md'), '# Full Relay\n', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'src', 'main.ts'), 'export const answer = 42;\n', 'utf8');
  const config = defaultConfig('win32');
  await saveConfig({
    ...config,
    roots: [{ name: 'project', path: tempRoot }],
    fullRelay: { enabled: true, rootName: 'project' }
  });
});

afterEach(async () => {
  resetFullRelayStateForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  await removeTempDir(tempRoot);
  await removeTempDir(userData);
  initConfigPath(path.join(os.tmpdir(), 'full-relay-test-unused', 'config.json'));
});

describe('Full Relay request contract', () => {
  it('keeps Full Relay disabled by default', () => {
    expect(defaultConfig('win32').fullRelay).toEqual({ enabled: false, rootName: '' });
  });

  it('requires full mode and rejects unsafe or unknown request fields', () => {
    expect(parseFullRelayRequest({ id: 'read-001', mode: 'full', tool: 'read_file', path: 'src/main.ts' })).toEqual({
      id: 'read-001',
      mode: 'full',
      tool: 'read_file',
      path: 'src/main.ts'
    });
    expect(() => parseFullRelayRequest({ id: 'read-001', tool: 'read_file', path: 'src/main.ts' })).toThrow();
    expect(() => parseFullRelayRequest({ id: 'read-001', mode: 'full', tool: 'read_file', path: '../secret' })).toThrow();
    expect(() => parseFullRelayRequest({ id: 'read-001', mode: 'full', tool: 'read_file', path: 'C:\\outside' })).toThrow();
    expect(() => parseFullRelayRequest({ id: 'read-001', mode: 'full', tool: 'write_plan', path: 'plan.md', content: 'x' })).toThrow();
    expect(() => parseFullRelayRequest({ id: 'read-001', mode: 'full', tool: 'read_file', path: 'src/main.ts', extra: true })).toThrow();
    expect(parseFullRelayRequest({
      id: 'exec-001',
      mode: 'full',
      tool: 'exec_command',
      command: ['node', '-e', 'console.log(1)'],
      cwd: '.',
      timeout_ms: 30_000
    })).toMatchObject({ command: ['node', '-e', 'console.log(1)'], cwd: '', timeout_ms: 30_000 });
  });
});

describe('Full Relay filesystem adapter', () => {
  it('lists, reads, searches and writes only through the selected approved root', async () => {
    const list = successful(await executeFullRelay(request('list_directory', { path: '' })));
    expect(JSON.stringify(list.result)).toContain('README.md');

    const read = successful(await executeFullRelay(request('read_file', { path: 'src/main.ts' })));
    expect(JSON.stringify(read.result)).toContain('answer = 42');

    const search = successful(await executeFullRelay(request('search_files', { path: '', query: 'answer' })));
    expect(JSON.stringify(search.result)).toContain('src/main.ts');

    const write = successful(await executeFullRelay(request('write_file', { path: 'src/generated.ts', content: 'export const generated = true;\n' })));
    expect(JSON.stringify(write.result)).toContain('generated.ts');
    expect(await fs.readFile(path.join(tempRoot, 'src', 'generated.ts'), 'utf8')).toBe('export const generated = true;\n');
  });

  it('fails closed when Full Relay is disabled or its selected root disappears', async () => {
    const config = defaultConfig('win32');
    await saveConfig({
      ...config,
      roots: [{ name: 'project', path: tempRoot }],
      fullRelay: { enabled: false, rootName: 'project' }
    });
    await expect(executeFullRelay(request('read_file', { path: 'README.md' }))).resolves.toMatchObject({
      ok: false,
      error: 'full_relay_disabled'
    });

    await saveConfig({
      ...config,
      roots: [],
      fullRelay: { enabled: true, rootName: 'project' }
    });
    await expect(executeFullRelay(request('read_file', { path: 'README.md' }))).resolves.toMatchObject({
      ok: false,
      error: 'full_relay_root_unavailable'
    });
  });

  it('does not execute a duplicate id a second time', async () => {
    const first = await executeFullRelay(request('write_file', { path: 'duplicate.txt', content: 'first\n' }));
    const second = await executeFullRelay(request('write_file', { path: 'duplicate.txt', content: 'second\n' }));
    expect(second).toEqual(first);
    expect(await fs.readFile(path.join(tempRoot, 'duplicate.txt'), 'utf8')).toBe('first\n');
  });

  it('forces apply_patch headers into the selected virtual root', async () => {
    const patch = `*** Begin Patch
*** Update File: src/main.ts
@@
-export const answer = 42;
+export const answer = 43;
*** End Patch`;
    const result = successful(await executeFullRelay(request('apply_patch', { patch })));
    expect(JSON.stringify(result.result)).toContain('src/main.ts');
    expect(await fs.readFile(path.join(tempRoot, 'src', 'main.ts'), 'utf8')).toBe('export const answer = 43;\n');
  });

  it('starts commands in the selected root through the existing exec runtime', async () => {
    const command = process.platform === 'win32' ? ['Write-Output', 'full relay exec'] : ['printf', 'full relay exec'];
    const result = successful(await executeFullRelay(request('exec_command', { command, timeout_ms: 30_000 })));
    expect(JSON.stringify(result.result)).toContain('full relay exec');
  });

  it('caps operations per conversation', async () => {
    for (let index = 0; index < 100; index += 1) {
      const result = await executeFullRelay({
        ...request('read_file', { path: 'README.md' }),
        id: `bounded-${index}`
      });
      expect(result.ok).toBe(true);
    }
    await expect(
      executeFullRelay({ ...request('read_file', { path: 'README.md' }), id: 'bounded-100' })
    ).resolves.toMatchObject({ ok: false, error: 'full_operation_limit' });
  });
});
