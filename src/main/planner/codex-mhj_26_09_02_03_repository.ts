import { rawPromises as fs } from '../rawfs.js';
import path from 'node:path';
import { getConfig } from '../config.js';
import { listDirectory } from '../fsops.js';
import { DEFAULT_EXCLUDES, search } from '../search.js';
import { BinaryReadError, readTextFile } from '../codex/read-backend.js';
import {
  DEFAULT_TREE_DEPTH,
  MAX_PLANNER_READ_BYTES,
  MAX_PLANNER_WRITE_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  MAX_TREE_RESPONSE_BYTES,
  type PlanWriteInput,
  type PlanWriteResult,
  type RepoReadInput,
  type RepoReadResult,
  type RepoSearchInput,
  type RepoSearchResult,
  type RepoTreeInput,
  type RepoTreeResult
} from './codex-mhj_26_09_02_01_types.js';
import {
  PlannerValidationError,
  PlannerOperationError,
  relativeToPlannerRoot,
  resolvePlannerDocumentPath,
  resolvePlannerReadPath,
  selectedPlannerRoot,
  validateRelativePath
} from './codex-mhj_26_09_02_02_security.js';

function finiteInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PlannerValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normaliseTreeInput(input: RepoTreeInput): RepoTreeInput {
  return {
    rootName: input.rootName,
    path: validateRelativePath(input.path),
    depth: finiteInteger(input.depth, 'depth', 0, MAX_TREE_DEPTH)
  };
}

export async function repoTree(input: RepoTreeInput): Promise<RepoTreeResult> {
  const request = normaliseTreeInput(input);
  const target = await resolvePlannerReadPath(request.rootName, request.path);
  let targetStat;
  try {
    targetStat = await fs.stat(target.realPath);
  } catch {
    throw new PlannerOperationError('Could not inspect the repository tree');
  }
  if (!targetStat.isDirectory()) throw new PlannerValidationError('tree path must be a directory');

  const entries: RepoTreeResult['entries'] = [];
  let truncated = false;
  const walk = async (realDir: string, relativeDir: string, remainingDepth: number): Promise<void> => {
    if (truncated) return;
    let listed;
    try {
      listed = await listDirectory(realDir, `/${target.root.name}/${relativeDir}`.replace(/\/$/, ''), {
        recursive: false,
        maxEntries: MAX_TREE_ENTRIES,
        exclude: DEFAULT_EXCLUDES
      });
    } catch {
      throw new PlannerOperationError('Could not list the repository tree');
    }
    for (const item of listed.entries) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      if (item.type === 'directory' && DEFAULT_EXCLUDES.some((excluded) => excluded.endsWith('*')
        ? item.name.toLowerCase().startsWith(excluded.slice(0, -1).toLowerCase())
        : item.name.toLowerCase() === excluded.toLowerCase())) continue;
      const relativePath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
      entries.push({ path: relativePath, type: item.type, bytes: item.bytes });
      const candidateBytes = Buffer.byteLength(JSON.stringify({ entries, truncated: false }), 'utf8');
      if (candidateBytes > MAX_TREE_RESPONSE_BYTES) {
        entries.pop();
        truncated = true;
        return;
      }
      if (item.type === 'directory' && remainingDepth > 0) {
        const child = await resolvePlannerReadPath(target.root.name, relativePath);
        await walk(child.realPath, relativePath, remainingDepth - 1);
        if (truncated) return;
      }
    }
    if (listed.truncated) truncated = true;
  };

  await walk(target.realPath, request.path, request.depth);
  return { rootName: target.root.name, path: request.path, entries, truncated };
}

function normaliseSearchInput(input: RepoSearchInput): RepoSearchInput {
  if (typeof input.query !== 'string' || input.query.length === 0 || input.query.length > 512) {
    throw new PlannerValidationError('query must be a non-empty string of at most 512 characters');
  }
  if (input.mode !== 'name' && input.mode !== 'content') throw new PlannerValidationError('mode must be name or content');
  return {
    rootName: input.rootName,
    query: input.query,
    path: validateRelativePath(input.path),
    mode: input.mode,
    maxResults: finiteInteger(input.maxResults, 'maxResults', 1, MAX_SEARCH_RESULTS),
    include: input.include === null ? null : validateRelativePath(input.include, 'include'),
    caseSensitive: input.caseSensitive
  };
}

export async function repoSearch(input: RepoSearchInput): Promise<RepoSearchResult> {
  const request = normaliseSearchInput(input);
  const target = await resolvePlannerReadPath(request.rootName, request.path);
  let targetStat;
  try {
    targetStat = await fs.stat(target.realPath);
  } catch {
    throw new PlannerOperationError('Could not inspect the repository search path');
  }
  if (!targetStat.isDirectory()) throw new PlannerValidationError('search path must be a directory');
  let outcome;
  try {
    outcome = await search({
      realDir: target.realPath,
      virtualDir: target.virtualPath,
      query: request.query,
      mode: request.mode,
      ...(request.include === null ? {} : { include: request.include }),
      exclude: DEFAULT_EXCLUDES,
      caseSensitive: request.caseSensitive,
      regex: false,
      maxResults: request.maxResults
    });
  } catch {
    throw new PlannerOperationError('Could not search the repository');
  }
  return {
    rootName: target.root.name,
    path: request.path,
    hits: outcome.hits.map((hit) => ({
      path: relativeToPlannerRoot(target.root, path.join(target.root.real, hit.path.slice(target.virtualPath.length).replace(/^[/\\]/, ''))),
      line: hit.line ?? null,
      text: hit.text ?? null
    })),
    filesScanned: outcome.filesScanned,
    truncated: outcome.truncated,
    stoppedBecause: outcome.stoppedBecause,
    elapsedMs: outcome.elapsedMs
  };
}

function normaliseReadInput(input: RepoReadInput): RepoReadInput {
  return {
    rootName: input.rootName,
    path: validateRelativePath(input.path),
    startLine: input.startLine === null ? null : finiteInteger(input.startLine, 'startLine', 1, 1_000_000),
    endLine: input.endLine === null ? null : finiteInteger(input.endLine, 'endLine', 1, 1_000_000),
    maxBytes: finiteInteger(input.maxBytes, 'maxBytes', 1, MAX_PLANNER_READ_BYTES)
  };
}

export async function repoRead(input: RepoReadInput): Promise<RepoReadResult> {
  const request = normaliseReadInput(input);
  if (request.startLine !== null && request.endLine !== null && request.endLine < request.startLine) {
    throw new PlannerValidationError('endLine must be greater than or equal to startLine');
  }
  const target = await resolvePlannerReadPath(request.rootName, request.path);
  try {
    const result = await readTextFile(target.realPath, {
      ...(request.startLine === null ? {} : { startLine: request.startLine }),
      ...(request.endLine === null ? {} : { endLine: request.endLine }),
      maxBytes: request.maxBytes
    });
    return { path: request.path, ...result };
  } catch (error) {
    if (error instanceof BinaryReadError) throw new PlannerValidationError(error.message);
    if (error instanceof PlannerValidationError) throw error;
    throw new PlannerOperationError('Could not read the repository file');
  }
}

function normaliseWriteInput(input: PlanWriteInput): PlanWriteInput {
  if (typeof input.content !== 'string' || input.content.length === 0) {
    throw new PlannerValidationError('content must be a non-empty string');
  }
  if (Buffer.byteLength(input.content, 'utf8') > MAX_PLANNER_WRITE_BYTES) {
    throw new PlannerValidationError(`content exceeds ${MAX_PLANNER_WRITE_BYTES} bytes`);
  }
  return input;
}

export async function planWrite(input: PlanWriteInput): Promise<PlanWriteResult> {
  const request = normaliseWriteInput(input);
  const target = await resolvePlannerDocumentPath(request.rootName, request.taskId, request.documentType, request.blockId);
  try {
    await fs.mkdir(path.dirname(target.realPath), { recursive: true });
  } catch {
    throw new PlannerOperationError('Could not create the planning document directory');
  }
  const revalidated = await resolvePlannerDocumentPath(request.rootName, request.taskId, request.documentType, request.blockId);
  let mode: PlanWriteResult['mode'] = 'created';
  try {
    await fs.lstat(revalidated.realPath);
    mode = 'replaced';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PlannerOperationError('Could not inspect the planning document');
    }
  }
  try {
    await fs.writeFile(revalidated.realPath, request.content, 'utf8');
  } catch {
    throw new PlannerOperationError('Could not write the planning document');
  }
  return { relativePath: revalidated.relativePath, mode, bytes: Buffer.byteLength(request.content, 'utf8') };
}

export async function plannerStatus(selectedRootName: string | null): Promise<{
  roots: Array<{ name: string; selected: boolean; available: boolean }>;
  selectedRoot: string | null;
}> {
  const roots = getConfig().roots;
  const selected = selectedRootName === null
    ? roots.length === 1 ? roots[0]?.name.toLowerCase() ?? null : null
    : selectedRootName.toLowerCase();
  const statuses: Array<{ name: string; selected: boolean; available: boolean }> = [];
  for (const root of roots) {
    let available = true;
    try {
      await selectedPlannerRoot(root.name);
    } catch {
      available = false;
    }
    statuses.push({ name: root.name, selected: selected === root.name.toLowerCase(), available });
  }
  const selectedStatus = statuses.find((root) => root.selected && root.available);
  return { roots: statuses, selectedRoot: selectedStatus?.name ?? null };
}

export function defaultTreeDepth(): number {
  return DEFAULT_TREE_DEPTH;
}
