import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  clearFullSnapshots,
  fullTools,
  invokeFullTool,
  type FullToolsResponse
} from '../src/main/full/codex-mhj_26_09_02_01_adapter.js';
import { FULL_HTML, FULL_SCRIPT } from '../src/main/full/codex-mhj_26_09_02_02_page.js';
import { SURFACE_LIST } from '../src/main/mcp/surfaces.js';
import { plannerRequestHandler } from '../src/main/planner/codex-mhj_26_09_02_05_server.js';
import { PLANNER_SCRIPT } from '../src/main/planner/codex-mhj_26_09_02_04_page.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await makeTempDir('full-webmcp-');
  initConfigPath(path.join(tempRoot, 'config.json'));
  await fs.writeFile(path.join(tempRoot, 'sample.txt'), 'Full bridge read smoke test\n', 'utf8');
});

afterAll(async () => {
  clearFullSnapshots();
  await removeTempDir(tempRoot);
});

async function configure(options: {
  capabilities?: Partial<ReturnType<typeof defaultConfig>['capabilities']>;
  readOnly?: boolean;
  recording?: boolean;
  multiAgent?: boolean;
} = {}): Promise<void> {
  const base = defaultConfig('win32');
  await saveConfig({
    ...base,
    roots: [{ name: 'project', path: tempRoot }],
    capabilities: { ...base.capabilities, ...options.capabilities },
    readOnly: options.readOnly ?? false,
    sessions: { ...base.sessions, record: options.recording ?? false },
    multiAgent: { ...base.multiAgent, enabled: options.multiAgent ?? false }
  });
  clearFullSnapshots();
}

function names(response: FullToolsResponse, surface: 'core' | 'desktop'): string[] {
  return response.tools.filter((tool) => tool.surface === surface).map((tool) => tool.name);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, method: 'GET' | 'POST', requestPath: string, body?: string, origin?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('Full WebMCP projection', () => {
  it('derives Core and Desktop metadata from the existing registrations', async () => {
    await configure();
    const response = fullTools('full-test-page-0001');
    const core = names(response, 'core');
    const desktop = names(response, 'desktop');

    expect(core).toEqual(['read', 'view_image', 'apply_patch', 'exec_command', 'write_stdin']);
    expect(desktop).toEqual(['observe', 'computer']);
    expect(response.tools.find((tool) => tool.name === 'read')?.description).toContain('one or more paths');
    expect(response.tools.find((tool) => tool.name === 'read')?.inputSchema).toMatchObject({
      type: 'object',
      required: ['paths']
    });
    expect(response.tools.find((tool) => tool.name === 'computer')?.compatibility).toBe('image-content');
    expect(response.tools.every((tool) => SURFACE_LIST.some((surface) => surface.id === tool.surface))).toBe(true);
  });

  it('preserves the find versus command projection and feature gates', async () => {
    await configure({
      capabilities: {
        command: false,
        search: true,
        create: false,
        edit: false,
        move: false,
        deleteFile: false,
        screen: false,
        control: false,
        clipboardRead: false,
        clipboardWrite: false
      },
      recording: false,
      multiAgent: false
    });
    const response = fullTools('full-test-page-0002');
    const core = names(response, 'core');

    expect(core).toContain('find');
    expect(core).not.toContain('exec_command');
    expect(core).not.toContain('write_stdin');
    expect(core).not.toContain('apply_patch');
    expect(core).not.toContain('session');
    expect(core).not.toContain('agents');
    expect(names(response, 'desktop')).toEqual([]);
  });

  it('keeps page exposure stable while revoking live permissions', async () => {
    await configure({ recording: false, multiAgent: false });
    const response = fullTools('full-test-page-0003');
    expect(names(response, 'core')).toContain('apply_patch');
    expect(names(response, 'core')).toContain('exec_command');
    expect(names(response, 'desktop')).toContain('computer');

    // Do not clear snapshots here: this models a browser that cached registrations before the
    // user switched read-only on. A deliberate new page gets a narrower snapshot below.
    await saveConfig({
      ...defaultConfig('win32'),
      roots: [{ name: 'project', path: tempRoot }],
      readOnly: true,
      sessions: { ...defaultConfig('win32').sessions, record: false },
      multiAgent: { ...defaultConfig('win32').multiAgent, enabled: false }
    });
    const stale = fullTools('full-test-page-0003');
    expect(names(stale, 'core')).toContain('apply_patch');
    expect(names(stale, 'core')).toContain('exec_command');
    const fresh = fullTools('full-test-page-0004');
    expect(names(fresh, 'core')).not.toContain('apply_patch');
    expect(names(fresh, 'core')).not.toContain('exec_command');
    const result = await invokeFullTool({
      pageId: 'full-test-page-0003',
      name: 'exec_command',
      arguments: { cmd: 'echo must-not-run' }
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('TOOL_DISABLED');
  });

  it('rechecks desktop action permissions instead of treating computer exposure as authority', async () => {
    await configure({ recording: false, multiAgent: false });
    fullTools('full-test-page-0005');
    await configure({
      readOnly: true,
      capabilities: { control: false, clipboardWrite: false },
      recording: false,
      multiAgent: false
    });
    const result = await invokeFullTool({
      pageId: 'full-test-page-0005',
      name: 'computer',
      arguments: { actions: [{ type: 'click', x: 1, y: 1 }] }
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('TOOL_DISABLED');
  });

  it('uses existing read and preserves image-capable result envelopes', async () => {
    await configure({ recording: false, multiAgent: false });
    const result = await invokeFullTool({
      pageId: 'full-test-page-0006',
      name: 'read',
      arguments: { paths: [path.join(tempRoot, 'sample.txt')] }
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('Full bridge read smoke test');
    expect(FULL_SCRIPT).toContain('return payload.result');
    expect(FULL_SCRIPT).not.toContain('[image]');
    expect(FULL_HTML).toContain('Desktop surface');
  });

  it('rejects unknown and schema-invalid tools before handler execution', async () => {
    await configure({ recording: false, multiAgent: false });
    await expect(
      invokeFullTool({ pageId: 'full-test-page-0007', name: 'totally_internal_function', arguments: {} })
    ).rejects.toThrow('Unknown Full tool');
    await expect(invokeFullTool({ pageId: 'full-test-page-0007', name: 'read', arguments: { paths: [] } })).rejects.toThrow(
      'Invalid arguments'
    );
  });

  it('does not fabricate caller identity for agents', async () => {
    await configure({ recording: false, multiAgent: true });
    const response = fullTools('full-test-page-0008');
    expect(names(response, 'core')).toContain('agents');
    const result = await invokeFullTool({ pageId: 'full-test-page-0008', name: 'agents', arguments: { action: 'status' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/identity|caller|worker/i);
  });

  it('keeps Planner page registration separate from Full tools', () => {
    expect(PLANNER_SCRIPT).toContain("const TOOL_NAMES = ['repo_tree', 'repo_search', 'repo_read', 'plan_write']");
    expect(PLANNER_SCRIPT).not.toMatch(/exec_command|apply_patch|write_stdin|agents|observe|computer/);
    expect(FULL_HTML + FULL_SCRIPT).not.toMatch(/bearer|safeStorage|OPENAI_API_KEY|mcp\/core/i);
    expect(() => new Function(FULL_SCRIPT)).not.toThrow();
  });

  it('serves Full through the shared local handler with origin and unknown-tool protection', async () => {
    await configure({ recording: false, multiAgent: false });
    const server = http.createServer(plannerRequestHandler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('dynamic test server did not expose an address');
      const port = address.port;
      const page = await request(port, 'GET', '/full');
      expect(page.status).toBe(200);
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.body).toContain('Command execution: checking');
      const foreign = await request(port, 'GET', '/full', undefined, 'https://evil.example');
      expect(foreign.status).toBe(403);

      const toolsResponse = await request(port, 'GET', '/api/full/tools?pageId=full-http-page-0001');
      expect(toolsResponse.status).toBe(200);
      const toolsPayload = JSON.parse(toolsResponse.body) as FullToolsResponse;
      expect(toolsPayload.tools.map((tool) => tool.name)).not.toContain('repo_read');
      expect(toolsResponse.body).not.toContain(tempRoot);

      const read = await request(
        port,
        'POST',
        '/api/full/call',
        JSON.stringify({ pageId: 'full-http-page-0001', name: 'read', arguments: { paths: [path.join(tempRoot, 'sample.txt')] } }),
        'http://127.0.0.1:8771'
      );
      expect(read.status).toBe(200);
      expect(JSON.parse(read.body).result.content[0].text).toContain('Full bridge read smoke test');

      const noOrigin = await request(
        port,
        'POST',
        '/api/full/call',
        JSON.stringify({ pageId: 'full-http-page-0001', name: 'read', arguments: { paths: [path.join(tempRoot, 'sample.txt')] } })
      );
      expect(noOrigin.status).toBe(403);

      const unknown = await request(
        port,
        'POST',
        '/api/full/call',
        JSON.stringify({ pageId: 'full-http-page-0001', name: 'totally_internal_function', arguments: {} }),
        'http://127.0.0.1:8771'
      );
      expect(unknown.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
