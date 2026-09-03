import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import { rawPromises as fs } from '../rawfs.js';
import { isContained, SandboxError } from '../sandbox.js';
import {
  PlannerOperationError,
  PlannerValidationError,
  resolvePlannerRelayWritePath,
  selectedPlannerRoot,
  validateRelativePath
} from './codex-mhj_26_09_02_02_security.js';
import { repoRead, repoSearch, repoTree } from './codex-mhj_26_09_02_03_repository.js';
import type { PlannerRoot } from './codex-mhj_26_09_02_01_types.js';

export const PLANNER_RELAY_PROJECT_ROOT = 'C:\\Users\\mhj\\Desktop\\mhj_workspace\\orca_harness';
export const MAX_PLANNER_RELAY_ID_LENGTH = 64;
export const MAX_PLANNER_RELAY_QUERY_LENGTH = 512;
export const MAX_PLANNER_RELAY_READ_BYTES = 200 * 1024;
export const MAX_PLANNER_RELAY_WRITE_BYTES = 200 * 1024;
export const MAX_PLANNER_RELAY_SEARCH_RESULTS = 100;
export const MAX_PLANNER_RELAY_DIRECTORY_ENTRIES = 2000;

export type PlannerRelayTool = 'list_directory' | 'read_file' | 'search_files' | 'write_plan';

export interface PlannerRelayRequest {
  id: string;
  tool: PlannerRelayTool;
  path: string;
  query?: string;
  content?: string;
  start_line?: number;
  end_line?: number;
}

export interface PlannerRelayFailure {
  id: string;
  tool: PlannerRelayTool;
  ok: false;
  error: string;
}

export type PlannerRelayResponse =
  | {
      id: string;
      tool: 'list_directory';
      ok: true;
      path: string;
      entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }>;
      truncated: boolean;
    }
  | {
      id: string;
      tool: 'read_file';
      ok: true;
      path: string;
      content: string;
      truncated: boolean;
      hasMore: boolean;
      firstLine: number;
      lastLine: number;
      totalLines: number | null;
      bytesReturned: number;
      fileBytes: number;
    }
  | {
      id: string;
      tool: 'search_files';
      ok: true;
      path: string;
      hits: Array<{ path: string; line: number | null; text: string | null }>;
      filesScanned: number;
      truncated: boolean;
      stoppedBecause: string | null;
      elapsedMs: number;
    }
  | {
      id: string;
      tool: 'write_plan';
      ok: true;
      path: string;
      mode: 'created' | 'replaced';
      bytes: number;
    }
  | PlannerRelayFailure;

export interface PlannerRelayExecutionOptions {
  /** Test-only root override. The bridge never accepts a root name from the browser. */
  rootName?: string;
}

export class PlannerRelayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerRelayRequestError';
  }
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
    if (!fields.has(key)) throw new PlannerRelayRequestError(`unknown field: ${key}`);
  }
}

function stringField(value: unknown, field: string, maxLength: number, allowEmpty = false, allowControl = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim() === '')) {
    throw new PlannerRelayRequestError(`${field} is invalid`);
  }
  if (!allowControl && [...value].some((character) => character < ' ')) {
    throw new PlannerRelayRequestError(`${field} contains a control character`);
  }
  return value;
}

function lineField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new PlannerRelayRequestError(`${field} is invalid`);
  }
  return value;
}

function pathField(value: unknown, allowEmpty = false): string {
  const text = stringField(value, 'path', 4096, allowEmpty);
  try {
    return validateRelativePath(text);
  } catch {
    throw new PlannerRelayRequestError('path is not repository-relative');
  }
}

export function parsePlannerRelayRequest(value: unknown): PlannerRelayRequest {
  if (!isRecord(value)) throw new PlannerRelayRequestError('request must be a JSON object');
  const id = stringField(value.id, 'id', MAX_PLANNER_RELAY_ID_LENGTH);
  const tool = stringField(value.tool, 'tool', 32) as PlannerRelayTool;
  if (!['list_directory', 'read_file', 'search_files', 'write_plan'].includes(tool)) {
    throw new PlannerRelayRequestError('unknown planner relay tool');
  }

  if (tool === 'list_directory') {
    rejectUnknownFields(value, ['id', 'tool', 'path']);
    return { id, tool, path: pathField(value.path, true) };
  }
  if (tool === 'read_file') {
    rejectUnknownFields(value, ['id', 'tool', 'path', 'start_line', 'end_line']);
    const request: PlannerRelayRequest = { id, tool, path: pathField(value.path) };
    if (hasOwn(value, 'start_line')) request.start_line = lineField(value.start_line, 'start_line');
    if (hasOwn(value, 'end_line')) request.end_line = lineField(value.end_line, 'end_line');
    if (request.start_line !== undefined && request.end_line !== undefined && request.end_line < request.start_line) {
      throw new PlannerRelayRequestError('end_line is before start_line');
    }
    return request;
  }
  if (tool === 'search_files') {
    rejectUnknownFields(value, ['id', 'tool', 'path', 'query']);
    return {
      id,
      tool,
      path: pathField(value.path, true),
      query: stringField(value.query, 'query', MAX_PLANNER_RELAY_QUERY_LENGTH)
    };
  }

  rejectUnknownFields(value, ['id', 'tool', 'path', 'content']);
  const content = stringField(value.content, 'content', MAX_PLANNER_RELAY_WRITE_BYTES, false, true);
  if (Buffer.byteLength(content, 'utf8') > MAX_PLANNER_RELAY_WRITE_BYTES) {
    throw new PlannerRelayRequestError('content is too large');
  }
  return { id, tool, path: pathField(value.path), content };
}

function samePath(left: string, right: string): boolean {
  const normalise = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return normalise(left) === normalise(right);
}

async function relayRoot(rootName: string | undefined): Promise<PlannerRoot> {
  if (rootName !== undefined) return selectedPlannerRoot(rootName);
  const target = path.resolve(PLANNER_RELAY_PROJECT_ROOT);
  for (const configured of getConfig().roots) {
    try {
      const candidate = await selectedPlannerRoot(configured.name);
      if (samePath(candidate.real, target)) return candidate;
    } catch {
      // An unavailable or changed approved root is not a candidate. The caller receives one
      // fail-closed result rather than an error containing the configured physical paths.
    }
  }
  throw new PlannerOperationError('Approved planner root is unavailable');
}

function failure(request: PlannerRelayRequest, error: unknown): PlannerRelayFailure {
  let code = 'operation_failed';
  if (error instanceof SandboxError) code = 'path_not_allowed';
  else if (error instanceof PlannerValidationError) {
    code = /binary/i.test(error.message) ? 'binary_file_not_supported' : 'invalid_request';
  } else if (error instanceof PlannerOperationError && /approved planner root/i.test(error.message)) {
    code = 'planner_root_unavailable';
  }
  return { id: request.id, tool: request.tool, ok: false, error: code };
}

async function writeRelayPlan(request: PlannerRelayRequest, rootName: string): Promise<Extract<PlannerRelayResponse, { tool: 'write_plan'; ok: true }>> {
  const target = await resolvePlannerRelayWritePath(rootName, request.path);
  const plansRoot = path.join(target.root.real, 'docs', 'plans');
  if (!isContained(plansRoot, path.dirname(target.realPath))) throw new SandboxError('Planner relay write target is outside docs/plans');
  await fs.mkdir(path.dirname(target.realPath), { recursive: true });

  // The directory may have been replaced while it was being created. Resolve the final path
  // again immediately before staging and committing any bytes.
  const revalidated = await resolvePlannerRelayWritePath(rootName, request.path);
  let mode: 'created' | 'replaced' = 'created';
  try {
    const existing = await fs.lstat(revalidated.realPath);
    if (existing.isDirectory()) throw new PlannerValidationError('write target is a directory');
    mode = 'replaced';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof PlannerValidationError) throw error;
      throw new PlannerOperationError('Could not inspect the planning file');
    }
  }

  const temporary = path.join(path.dirname(revalidated.realPath), `.clf-planner-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(request.content ?? '', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const finalTarget = await resolvePlannerRelayWritePath(rootName, request.path);
    await fs.rename(temporary, finalTarget.realPath);
  } catch {
    throw new PlannerOperationError('Could not write the planning file');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return {
    id: request.id,
    tool: 'write_plan',
    ok: true,
    path: request.path,
    mode,
    bytes: Buffer.byteLength(request.content ?? '', 'utf8')
  };
}

export async function executePlannerRelay(
  value: unknown,
  options: PlannerRelayExecutionOptions = {}
): Promise<PlannerRelayResponse> {
  const request = parsePlannerRelayRequest(value);
  logInfo(`planner relay request detected: ${request.id} ${request.tool}`);
  let root: PlannerRoot;
  try {
    root = await relayRoot(options.rootName);
  } catch (error) {
    logWarn(`planner relay request rejected: ${request.id} planner root unavailable`);
    return failure(request, error);
  }

  try {
    if (request.tool === 'list_directory') {
      const tree = await repoTree({ rootName: root.name, path: request.path, depth: 0 });
      const entries = tree.entries
        .slice(0, MAX_PLANNER_RELAY_DIRECTORY_ENTRIES)
        .map((entry) => ({ name: path.posix.basename(entry.path), type: entry.type }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type));
      const response: Extract<PlannerRelayResponse, { tool: 'list_directory'; ok: true }> = {
        id: request.id,
        tool: request.tool,
        ok: true,
        path: request.path,
        entries,
        truncated: tree.truncated || tree.entries.length > entries.length
      };
      logInfo(`planner relay request completed: ${request.id} ${request.tool}`);
      return response;
    }
    if (request.tool === 'read_file') {
      const read = await repoRead({
        rootName: root.name,
        path: request.path,
        startLine: request.start_line ?? null,
        endLine: request.end_line ?? null,
        maxBytes: MAX_PLANNER_RELAY_READ_BYTES
      });
      const response: Extract<PlannerRelayResponse, { tool: 'read_file'; ok: true }> = {
        id: request.id,
        tool: request.tool,
        ok: true,
        path: request.path,
        content: read.text,
        truncated: read.truncated,
        hasMore: read.hasMore,
        firstLine: read.firstLine,
        lastLine: read.lastLine,
        totalLines: read.totalLines,
        bytesReturned: read.bytesReturned,
        fileBytes: read.fileBytes
      };
      logInfo(`planner relay request completed: ${request.id} ${request.tool}`);
      return response;
    }
    if (request.tool === 'search_files') {
      const search = await repoSearch({
        rootName: root.name,
        query: request.query ?? '',
        path: request.path,
        mode: 'content',
        maxResults: MAX_PLANNER_RELAY_SEARCH_RESULTS,
        include: null,
        caseSensitive: false
      });
      const pathPrefix = request.path ? `${request.path}/` : '';
      const hits = search.hits
        .map((hit) => ({ ...hit, path: `${pathPrefix}${hit.path}` }))
        .sort(
        (left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0) || (left.text ?? '').localeCompare(right.text ?? '')
        );
      const response: Extract<PlannerRelayResponse, { tool: 'search_files'; ok: true }> = {
        id: request.id,
        tool: request.tool,
        ok: true,
        path: request.path,
        hits,
        filesScanned: search.filesScanned,
        truncated: search.truncated,
        stoppedBecause: search.stoppedBecause,
        elapsedMs: search.elapsedMs
      };
      logInfo(`planner relay request completed: ${request.id} ${request.tool}`);
      return response;
    }
    const response = await writeRelayPlan(request, root.name);
    logInfo(`planner relay request completed: ${request.id} ${request.tool}`);
    return response;
  } catch (error) {
    const response = failure(request, error);
    logWarn(`planner relay request failed: ${request.id} ${request.tool} ${response.error}`);
    return response;
  }
}
