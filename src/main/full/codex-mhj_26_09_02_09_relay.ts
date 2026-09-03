import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { effectiveCapabilities, getConfig } from '../config.js';
import { assertWritableSize, sniffBinary } from '../fsops.js';
import { logInfo, logWarn } from '../logger.js';
import {
  createSurfaceRegistrar,
  type SurfaceRegistrar,
  type SurfaceToolRegistration,
  type ToolResult
} from '../mcp/kernel.js';
import { registerCoreTools } from '../mcp/tools-core.js';
import { rawPromises as fs } from '../rawfs.js';
import { detectShellType, shlexJoin } from '../codex/shell.js';
import { SandboxError, resolvePath } from '../sandbox.js';
import { noteChanges } from '../mcp/call-context.js';
import type { FileChange } from '../../shared/session.js';
import type { Capabilities, Root } from '../../shared/types.js';

export const FULL_RELAY_MAX_ID_LENGTH = 64;
export const FULL_RELAY_MAX_PATH_LENGTH = 4096;
export const FULL_RELAY_MAX_QUERY_LENGTH = 1000;
export const FULL_RELAY_MAX_CONTENT_BYTES = 1_000_000;
export const FULL_RELAY_MAX_PATCH_BYTES = 1_000_000;
export const FULL_RELAY_MAX_COMMAND_BYTES = 100_000;
export const FULL_RELAY_MAX_TIMEOUT_MS = 300_000;
export const FULL_RELAY_MAX_RESULT_BYTES = 512 * 1024;
export const FULL_RELAY_MAX_OPERATIONS = 100;
export const FULL_RELAY_MAX_EXEC_COMMANDS = 20;

const CONVERSATION_ID = /^[0-9a-f-]{8,64}$/i;
const FULL_RELAY_TOOLS = [
  'list_directory',
  'read_file',
  'search_files',
  'write_file',
  'apply_patch',
  'exec_command',
  'write_stdin'
] as const;
const CORE_TOOL_NAMES = new Set(['read', 'find', 'apply_patch', 'exec_command', 'write_stdin']);

export type FullRelayTool = (typeof FULL_RELAY_TOOLS)[number];

interface FullRelayBase {
  id: string;
  mode: 'full';
  tool: FullRelayTool;
}

export type FullRelayRequest =
  | (FullRelayBase & { tool: 'list_directory'; path: string })
  | (FullRelayBase & {
      tool: 'read_file';
      path: string;
      start_line?: number;
      end_line?: number;
      max_bytes?: number;
    })
  | (FullRelayBase & {
      tool: 'search_files';
      path: string;
      query: string;
      include?: string;
      exclude?: string[];
      case_sensitive?: boolean;
      regex?: boolean;
      max_results?: number;
    })
  | (FullRelayBase & { tool: 'write_file'; path: string; content: string })
  | (FullRelayBase & { tool: 'apply_patch'; patch: string })
  | (FullRelayBase & {
      tool: 'exec_command';
      cmd?: string;
      cmds?: string[];
      command?: string[];
      cwd?: string;
      shell?: string;
      tty?: boolean;
      login?: boolean;
      yield_time_ms?: number;
      timeout_ms?: number;
      max_output_tokens?: number;
    })
  | (FullRelayBase & {
      tool: 'write_stdin';
      session_id: number;
      input?: string;
      yield_time_ms?: number;
      max_output_tokens?: number;
    });

export type FullRelayResponse =
  | {
      id: string;
      mode: 'full';
      tool: FullRelayTool;
      ok: true;
      result: Record<string, unknown>;
    }
  | {
      id: string;
      mode: 'full';
      tool: FullRelayTool;
      ok: false;
      error: string;
    };

export class FullRelayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FullRelayRequestError';
  }
}

class FullRelayPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FullRelayPathError';
  }
}

class FullRelayOperationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'FullRelayOperationError';
  }
}

interface FullRelayEnvelope {
  conversationId: string;
  request: FullRelayRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new FullRelayRequestError(`unknown field: ${key}`);
  }
}

function stringField(value: unknown, field: string, maxLength: number, allowEmpty = false, allowControls = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim() === '')) {
    throw new FullRelayRequestError(`${field} is invalid`);
  }
  if (!allowControls && [...value].some((character) => character < ' ')) {
    throw new FullRelayRequestError(`${field} contains a control character`);
  }
  return value;
}

function integerField(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new FullRelayRequestError(`${field} is invalid`);
  }
  return value;
}

function optionalInteger(value: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  if (!hasOwn(value, field)) return undefined;
  return integerField(value[field], field, min, max);
}

function relativePath(value: unknown, field: string, allowEmpty = false, allowCurrent = false): string {
  const input = stringField(value, field, FULL_RELAY_MAX_PATH_LENGTH, allowEmpty);
  if (input === '') return '';
  if (/^(?:[/\\]|[A-Za-z]:[/\\]|\\\\)/.test(input)) {
    throw new FullRelayRequestError(`${field} must be relative to the selected approved folder`);
  }
  const segments = input.split(/[\\/]/);
  if (
    segments.some((segment) => segment.length === 0 || segment === '..' || (!allowCurrent && segment === '.')) ||
    segments.some((segment) => [...segment].some((character) => character < ' '))
  ) {
    throw new FullRelayRequestError(`${field} must be a normalized relative path`);
  }
  return segments.filter((segment) => segment !== '.').join('/');
}

function commandField(value: unknown, field: string): string {
  return stringField(value, field, FULL_RELAY_MAX_COMMAND_BYTES, false, true);
}

function commandArgument(value: unknown, field: string): string {
  const argument = stringField(value, field, FULL_RELAY_MAX_COMMAND_BYTES, true, true);
  if (argument.includes('\0')) throw new FullRelayRequestError(`${field} contains a NUL byte`);
  return argument;
}

function commandArguments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > FULL_RELAY_MAX_EXEC_COMMANDS) {
    throw new FullRelayRequestError('command is invalid');
  }
  const args = value.map((item, index) => commandArgument(item, `command[${index}]`));
  if (args[0]!.trim() === '') throw new FullRelayRequestError('command[0] is invalid');
  return args;
}

function parseExec(value: Record<string, unknown>, id: string): FullRelayRequest {
  rejectUnknownFields(value, [
    'id',
    'mode',
    'tool',
    'cmd',
    'cmds',
    'command',
    'cwd',
    'shell',
    'tty',
    'login',
    'yield_time_ms',
    'timeout_ms',
    'max_output_tokens'
  ]);
  const hasCmd = hasOwn(value, 'cmd');
  const hasCmds = hasOwn(value, 'cmds');
  const hasCommand = hasOwn(value, 'command');
  if (Number(hasCmd) + Number(hasCmds) + Number(hasCommand) !== 1) {
    throw new FullRelayRequestError('exec_command requires exactly one of cmd, cmds or command');
  }
  const request: FullRelayRequest = hasCmd
    ? { id, mode: 'full', tool: 'exec_command', cmd: commandField(value.cmd, 'cmd') }
    : hasCmds
      ? {
        id,
        mode: 'full',
        tool: 'exec_command',
        cmds: (() => {
          if (!Array.isArray(value.cmds) || value.cmds.length < 1 || value.cmds.length > FULL_RELAY_MAX_EXEC_COMMANDS) {
            throw new FullRelayRequestError('cmds is invalid');
          }
          return value.cmds.map((command, index) => commandField(command, `cmds[${index}]`));
        })()
        }
      : { id, mode: 'full', tool: 'exec_command', command: commandArguments(value.command) };
  const cwd = hasOwn(value, 'cwd') ? relativePath(value.cwd, 'cwd', true, true) : undefined;
  if (cwd !== undefined) request.cwd = cwd;
  if (hasOwn(value, 'shell')) request.shell = stringField(value.shell, 'shell', FULL_RELAY_MAX_PATH_LENGTH);
  if (hasOwn(value, 'tty')) {
    if (typeof value.tty !== 'boolean') throw new FullRelayRequestError('tty is invalid');
    request.tty = value.tty;
  }
  if (hasOwn(value, 'login')) {
    if (typeof value.login !== 'boolean') throw new FullRelayRequestError('login is invalid');
    request.login = value.login;
  }
  const yieldTime = optionalInteger(value, 'yield_time_ms', 0, 120_000);
  if (yieldTime !== undefined) request.yield_time_ms = yieldTime;
  const timeout = optionalInteger(value, 'timeout_ms', 0, FULL_RELAY_MAX_TIMEOUT_MS);
  if (timeout !== undefined) {
    if (yieldTime !== undefined) throw new FullRelayRequestError('timeout_ms cannot be combined with yield_time_ms');
    request.timeout_ms = timeout;
  }
  const maxOutput = optionalInteger(value, 'max_output_tokens', 1, 10_000);
  if (maxOutput !== undefined) request.max_output_tokens = maxOutput;
  return request;
}

export function parseFullRelayRequest(value: unknown): FullRelayRequest {
  if (!isRecord(value)) throw new FullRelayRequestError('request must be a JSON object');
  rejectUnknownFields(value, [
    'id',
    'mode',
    'tool',
    'path',
    'query',
    'include',
    'exclude',
    'case_sensitive',
    'regex',
    'max_results',
    'start_line',
    'end_line',
    'max_bytes',
    'content',
    'patch',
    'cmd',
    'cmds',
    'command',
    'cwd',
    'shell',
    'tty',
    'login',
    'yield_time_ms',
    'timeout_ms',
    'max_output_tokens',
    'session_id',
    'input'
  ]);
  const id = stringField(value.id, 'id', FULL_RELAY_MAX_ID_LENGTH).trim();
  if (value.mode !== 'full') throw new FullRelayRequestError('mode must be "full"');
  const toolValue = stringField(value.tool, 'tool', 32);
  if (!(FULL_RELAY_TOOLS as readonly string[]).includes(toolValue)) {
    throw new FullRelayRequestError('unknown full relay tool');
  }
  const tool = toolValue as FullRelayTool;

  if (tool === 'list_directory') {
    rejectUnknownFields(value, ['id', 'mode', 'tool', 'path']);
    return { id, mode: 'full', tool, path: relativePath(value.path, 'path', true) };
  }
  if (tool === 'read_file') {
    rejectUnknownFields(value, ['id', 'mode', 'tool', 'path', 'start_line', 'end_line', 'max_bytes']);
    const request: FullRelayRequest = { id, mode: 'full', tool, path: relativePath(value.path, 'path') };
    const start = optionalInteger(value, 'start_line', 1, 1_000_000);
    const end = optionalInteger(value, 'end_line', 1, 1_000_000);
    const maxBytes = optionalInteger(value, 'max_bytes', 1, 512 * 1024);
    if (start !== undefined) request.start_line = start;
    if (end !== undefined) request.end_line = end;
    if (maxBytes !== undefined) request.max_bytes = maxBytes;
    if (start !== undefined && end !== undefined && end < start) {
      throw new FullRelayRequestError('end_line is before start_line');
    }
    return request;
  }
  if (tool === 'search_files') {
    rejectUnknownFields(value, [
      'id',
      'mode',
      'tool',
      'path',
      'query',
      'include',
      'exclude',
      'case_sensitive',
      'regex',
      'max_results'
    ]);
    const request: FullRelayRequest = {
      id,
      mode: 'full',
      tool,
      path: relativePath(value.path, 'path', true),
      query: stringField(value.query, 'query', FULL_RELAY_MAX_QUERY_LENGTH)
    };
    if (hasOwn(value, 'include')) request.include = stringField(value.include, 'include', 200);
    if (hasOwn(value, 'exclude')) {
      if (!Array.isArray(value.exclude) || value.exclude.length > 50) throw new FullRelayRequestError('exclude is invalid');
      request.exclude = value.exclude.map((item, index) => {
        const pattern = stringField(item, `exclude[${index}]`, 100);
        if (/[\\/]/.test(pattern) || (pattern.includes('*') && !pattern.endsWith('*'))) {
          throw new FullRelayRequestError(`exclude[${index}] is invalid`);
        }
        return pattern;
      });
    }
    if (hasOwn(value, 'case_sensitive')) {
      if (typeof value.case_sensitive !== 'boolean') throw new FullRelayRequestError('case_sensitive is invalid');
      request.case_sensitive = value.case_sensitive;
    }
    if (hasOwn(value, 'regex')) {
      if (typeof value.regex !== 'boolean') throw new FullRelayRequestError('regex is invalid');
      request.regex = value.regex;
    }
    const maxResults = optionalInteger(value, 'max_results', 1, 500);
    if (maxResults !== undefined) request.max_results = maxResults;
    return request;
  }
  if (tool === 'write_file') {
    rejectUnknownFields(value, ['id', 'mode', 'tool', 'path', 'content']);
    const content = stringField(value.content, 'content', FULL_RELAY_MAX_CONTENT_BYTES, true, true);
    assertWritableSize(content);
    if (Buffer.byteLength(content, 'utf8') > FULL_RELAY_MAX_CONTENT_BYTES) {
      throw new FullRelayRequestError('content is too large');
    }
    return { id, mode: 'full', tool, path: relativePath(value.path, 'path'), content };
  }
  if (tool === 'apply_patch') {
    rejectUnknownFields(value, ['id', 'mode', 'tool', 'patch']);
    const patch = stringField(value.patch, 'patch', FULL_RELAY_MAX_PATCH_BYTES, false, true);
    if (Buffer.byteLength(patch, 'utf8') > FULL_RELAY_MAX_PATCH_BYTES) {
      throw new FullRelayRequestError('patch is too large');
    }
    return { id, mode: 'full', tool, patch };
  }
  if (tool === 'exec_command') return parseExec(value, id);

  rejectUnknownFields(value, ['id', 'mode', 'tool', 'session_id', 'input', 'yield_time_ms', 'max_output_tokens']);
  const sessionId = integerField(value.session_id, 'session_id', 1, 2_147_483_647);
  const request: Extract<FullRelayRequest, { tool: 'write_stdin' }> = {
    id,
    mode: 'full',
    tool: 'write_stdin',
    session_id: sessionId
  };
  if (hasOwn(value, 'input')) request.input = stringField(value.input, 'input', FULL_RELAY_MAX_COMMAND_BYTES, true, true);
  const yieldTime = optionalInteger(value, 'yield_time_ms', 0, 120_000);
  if (yieldTime !== undefined) request.yield_time_ms = yieldTime;
  const maxOutput = optionalInteger(value, 'max_output_tokens', 1, 10_000);
  if (maxOutput !== undefined) request.max_output_tokens = maxOutput;
  return request;
}

function parseEnvelope(value: unknown): FullRelayEnvelope {
  if (!isRecord(value)) throw new FullRelayRequestError('request must be a JSON object');
  const conversationId = stringField(value.conversationId, 'conversationId', 64);
  if (!CONVERSATION_ID.test(conversationId)) throw new FullRelayRequestError('conversationId is invalid');
  const requestValue = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'conversationId'));
  return { conversationId, request: parseFullRelayRequest(requestValue) };
}

function failure(request: FullRelayRequest, error: unknown): FullRelayResponse {
  let code = 'operation_failed';
  if (error instanceof FullRelayOperationError) code = error.code;
  else if (error instanceof FullRelayPathError || error instanceof SandboxError) code = 'path_not_allowed';
  else if (error instanceof FullRelayRequestError) code = 'invalid_request';
  else if (error instanceof Error && /TOOL_DISABLED/i.test(error.message)) code = 'tool_disabled';
  return { id: request.id, mode: 'full', tool: request.tool, ok: false, error: code };
}

function relayPath(root: Root, relative: string): string {
  return relative === '' ? `/${root.name}` : `/${root.name}/${relative}`;
}

async function resolveRelayPath(root: Root, relative: string, allowMissing = false) {
  return resolvePath([root], relayPath(root, relative), { allowMissing });
}

function prefixPatchPaths(patch: string, root: Root): string {
  const lines = patch.split(/\r?\n/);
  let changed = false;
  const prefixed = lines.map((line) => {
    const match = /^(\*\*\* (?:Update|Delete|Add) File: |\*\*\* Move to: )(.+)$/.exec(line);
    if (!match) return line;
    const target = match[2];
    const clean = relativePath(target, 'patch path');
    if (clean === '') throw new FullRelayPathError('patch path is empty');
    changed = true;
    return `${match[1]}${relayPath(root, clean)}`;
  });
  if (!changed) throw new FullRelayRequestError('patch contains no supported file paths');
  return prefixed.join('\n');
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length;
}

async function writeFullFile(
  root: Root,
  request: { path: string; content: string },
  registrar: SurfaceRegistrar
): Promise<ToolResult> {
  const target = await resolveRelayPath(root, request.path, true);
  let existing: Buffer | null = null;
  try {
    const stat = await fs.lstat(target.real);
    if (stat.isDirectory()) return { content: [{ type: 'text', text: 'target_is_directory' }], isError: true };
    if (!stat.isFile()) return { content: [{ type: 'text', text: 'target_is_not_file' }], isError: true };
    if (stat.size > FULL_RELAY_MAX_CONTENT_BYTES) return { content: [{ type: 'text', text: 'existing_file_is_too_large' }], isError: true };
    if (await sniffBinary(target.real)) return { content: [{ type: 'text', text: 'binary_file_not_supported' }], isError: true };
    existing = await fs.readFile(target.real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const capability: keyof Capabilities = existing === null ? 'create' : 'edit';
  return registrar.guarded(capability, 'write_file', async () => {
    await fs.mkdir(path.dirname(target.real), { recursive: true });
    const revalidated = await resolveRelayPath(root, request.path, true);
    let mode: 'created' | 'replaced' = existing === null ? 'created' : 'replaced';
    try {
      const now = await fs.lstat(revalidated.real);
      if (existing === null) return { content: [{ type: 'text', text: 'target_appeared_during_create' }], isError: true };
      if (!now.isFile()) return { content: [{ type: 'text', text: 'target_is_not_file' }], isError: true };
      mode = 'replaced';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (existing !== null) return { content: [{ type: 'text', text: 'target_disappeared_during_replace' }], isError: true };
    }
    if (mode === 'replaced' && existing !== null) {
      const current = await fs.readFile(revalidated.real);
      if (!current.equals(existing)) return { content: [{ type: 'text', text: 'target_changed_during_write' }], isError: true };
    }
    const temporary = path.join(path.dirname(revalidated.real), `.clf-full-${process.pid}-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(request.content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      const finalTarget = await resolveRelayPath(root, request.path, true);
      await fs.rename(temporary, finalTarget.real);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    const nextBytes = Buffer.byteLength(request.content, 'utf8');
    const changes: FileChange = {
      path: revalidated.virtual,
      added: lineCount(request.content),
      removed: existing === null ? 0 : lineCount(existing.toString('utf8')),
      approximate: true
    };
    noteChanges([changes]);
    return {
      content: [{ type: 'text', text: JSON.stringify({ path: request.path, mode, bytes: nextBytes }) }]
    };
  });
}

function boundedResult(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') <= FULL_RELAY_MAX_RESULT_BYTES) return value;
  for (const key of ['output', 'text', 'content']) {
    const candidate = value[key];
    if (typeof candidate !== 'string') continue;
    const empty = { ...value, [key]: '', truncated: true };
    const budget = FULL_RELAY_MAX_RESULT_BYTES - Buffer.byteLength(JSON.stringify(empty), 'utf8');
    if (budget <= 0) return { truncated: true };
    const bounded = { ...value, [key]: Buffer.from(candidate, 'utf8').subarray(0, budget).toString('utf8'), truncated: true };
    return Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= FULL_RELAY_MAX_RESULT_BYTES ? bounded : { truncated: true };
  }
  return { truncated: true };
}

function responseFromTool(request: FullRelayRequest, result: ToolResult): FullRelayResponse {
  if (result.isError) return failure(request, new Error(result.content.find((item) => item.type === 'text')?.text ?? 'operation_failed'));
  const text = result.content.find((item): item is { type: 'text'; text: string } => item.type === 'text')?.text;
  const structured = result.structuredContent;
  const resultValue = structured ?? (text === undefined ? {} : { text });
  return {
    id: request.id,
    mode: 'full',
    tool: request.tool,
    ok: true,
    result: boundedResult(resultValue)
  };
}

function registrationMap(registrations: readonly SurfaceToolRegistration[]): Map<string, SurfaceToolRegistration> {
  return new Map(registrations.filter((registration) => CORE_TOOL_NAMES.has(registration.name)).map((registration) => [registration.name, registration]));
}

const writeFileInput = z.object({ path: z.string(), content: z.string() }).strict();

function shellCommandFromArgv(command: readonly string[], shell: string | undefined): string {
  const shellType = shell === undefined
    ? (process.platform === 'win32' ? 'powershell' : 'sh')
    : detectShellType(shell);
  if (shellType === 'powershell') {
    const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    return `& ${command.map(quote).join(' ')}`;
  }
  if (shellType === 'cmd') {
    const quote = (value: string): string => {
      if (value !== '' && !/[\s"]/.test(value)) return value;
      let result = '"';
      let slashes = 0;
      for (const character of value) {
        if (character === '\\') {
          slashes += 1;
          continue;
        }
        if (character === '"') {
          result += '\\'.repeat(slashes * 2 + 1) + '"';
        } else {
          result += '\\'.repeat(slashes) + character;
        }
        slashes = 0;
      }
      return result + '\\'.repeat(slashes * 2) + '"';
    };
    return command.map(quote).join(' ');
  }
  return shlexJoin(command);
}

async function executeOperation(envelope: FullRelayEnvelope, root: Root): Promise<FullRelayResponse> {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const context = {
    roots: [root],
    caps,
    exposedCaps: caps,
    readOnly: config.readOnly,
    privacyScreenshots: false,
    sessionTools: false,
    exposedSessionTools: false,
    agentTools: false,
    exposedAgentTools: false,
    exposedFind: true
  };
  const registrations: SurfaceToolRegistration[] = [];
  const registrar = createSurfaceRegistrar(context, 'core', (registration) => registrations.push(registration));
  registerCoreTools(registrar);
  registrar.register(
    'write_file',
    {
      title: 'Write a text file',
      description: 'Replace one UTF-8 text file inside the selected approved folder.',
      inputSchema: writeFileInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (input) => writeFullFile(root, input, registrar)
  );
  const byName = registrationMap(registrations);
  const invoke = async (name: string, args: unknown): Promise<FullRelayResponse> => {
    const registration = byName.get(name);
    if (!registration) return failure(envelope.request, new FullRelayOperationError('tool_disabled'));
    const result = await registration.invoke(args, null, envelope.conversationId);
    return responseFromTool(envelope.request, result);
  };
  const request = envelope.request;
  if (request.tool === 'list_directory') {
    const target = await resolveRelayPath(root, request.path);
    return invoke('read', { paths: [target.virtual], max_bytes: 128 * 1024 });
  }
  if (request.tool === 'read_file') {
    const target = await resolveRelayPath(root, request.path);
    return invoke('read', {
      paths: [target.virtual],
      ...(request.start_line === undefined ? {} : { start_line: request.start_line }),
      ...(request.end_line === undefined ? {} : { end_line: request.end_line }),
      ...(request.max_bytes === undefined ? {} : { max_bytes: request.max_bytes })
    });
  }
  if (request.tool === 'search_files') {
    const target = await resolveRelayPath(root, request.path);
    return invoke('find', {
      query: request.query,
      path: target.virtual,
      mode: 'content',
      ...(request.include === undefined ? {} : { include: request.include }),
      ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
      ...(request.case_sensitive === undefined ? {} : { case_sensitive: request.case_sensitive }),
      ...(request.regex === undefined ? {} : { regex: request.regex }),
      ...(request.max_results === undefined ? {} : { max_results: request.max_results })
    });
  }
  if (request.tool === 'write_file') {
    const registration = registrations.find((item) => item.name === 'write_file');
    if (!registration) return failure(request, new FullRelayOperationError('tool_disabled'));
    return responseFromTool(
      request,
      await registration.invoke({ path: request.path, content: request.content }, null, envelope.conversationId)
    );
  }
  if (request.tool === 'apply_patch') return invoke('apply_patch', { patch: prefixPatchPaths(request.patch, root) });
  if (request.tool === 'exec_command') {
    const workdir = await resolveRelayPath(root, request.cwd ?? '');
    return invoke('exec_command', {
      ...(request.cmd === undefined ? {} : { cmd: request.cmd }),
      ...(request.cmds === undefined ? {} : { cmds: request.cmds }),
      ...(request.command === undefined ? {} : { cmd: shellCommandFromArgv(request.command, request.shell) }),
      workdir: workdir.virtual,
      ...(request.shell === undefined ? {} : { shell: request.shell }),
      ...(request.tty === undefined ? {} : { tty: request.tty }),
      ...(request.login === undefined ? {} : { login: request.login }),
      ...(request.yield_time_ms === undefined && request.timeout_ms === undefined
        ? {}
        : { yield_time_ms: request.yield_time_ms ?? request.timeout_ms }),
      ...(request.max_output_tokens === undefined ? {} : { max_output_tokens: request.max_output_tokens })
    });
  }
  const stdinRequest = request as Extract<FullRelayRequest, { tool: 'write_stdin' }>;
  return invoke('write_stdin', {
    session_id: stdinRequest.session_id,
    ...(stdinRequest.input === undefined ? {} : { chars: stdinRequest.input }),
    ...(stdinRequest.yield_time_ms === undefined ? {} : { yield_time_ms: stdinRequest.yield_time_ms }),
    ...(stdinRequest.max_output_tokens === undefined ? {} : { max_output_tokens: stdinRequest.max_output_tokens })
  });
}

const inFlight = new Map<string, Promise<FullRelayResponse>>();
const completed = new Map<string, FullRelayResponse>();
const operationCounts = new Map<string, number>();

function requestKey(conversationId: string, id: string): string {
  return `${conversationId}\u0000${id}`;
}

function selectedRoot(rootName: string): Root {
  const config = getConfig();
  if (!config.fullRelay.enabled) throw new FullRelayOperationError('full_relay_disabled');
  const root = config.roots.find((candidate) => candidate.name === rootName);
  if (!root) throw new FullRelayOperationError('full_relay_root_unavailable');
  return root;
}

export async function executeFullRelay(value: unknown): Promise<FullRelayResponse> {
  const envelope = parseEnvelope(value);
  let root: Root;
  try {
    root = selectedRoot(getConfig().fullRelay.rootName);
    await resolveRelayPath(root, '');
  } catch (error) {
    return failure(envelope.request, error);
  }
  const key = requestKey(envelope.conversationId, envelope.request.id);
  if (completed.has(key)) return completed.get(key)!;
  const prior = inFlight.get(key);
  if (prior) return prior;
  const count = operationCounts.get(envelope.conversationId) ?? 0;
  if (count >= FULL_RELAY_MAX_OPERATIONS) return failure(envelope.request, new FullRelayOperationError('full_operation_limit'));
  operationCounts.set(envelope.conversationId, count + 1);
  const work = executeOperation(envelope, root)
    .catch((error) => {
      logWarn(`full relay request failed: ${envelope.request.id} ${envelope.request.tool}`);
      return failure(envelope.request, error);
    })
    .then((result) => {
      completed.set(key, result);
      while (completed.size > 2_000) completed.delete(completed.keys().next().value!);
      return result;
    })
    .finally(() => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    });
  inFlight.set(key, work);
  logInfo(`full relay request accepted: ${envelope.request.id} ${envelope.request.tool}`);
  return work;
}

export function resetFullRelayStateForTests(): void {
  inFlight.clear();
  completed.clear();
  operationCounts.clear();
}
