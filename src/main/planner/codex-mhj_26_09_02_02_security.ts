import path from 'node:path';
import { getConfig } from '../config.js';
import { isContained, resolvePath, resolveRoot, SandboxError } from '../sandbox.js';
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_PLANNER_PATH_LENGTH,
  type PlannerDocumentPath,
  type PlannerDocumentType,
  type PlannerRoot,
  type ResolvedPlannerPath
} from './codex-mhj_26_09_02_01_types.js';

export class PlannerValidationError extends Error {}
export class PlannerOperationError extends Error {}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stringField(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new PlannerValidationError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

export function validateIdentifier(value: unknown, field: string): string {
  const identifier = stringField(value, field, MAX_IDENTIFIER_LENGTH);
  if (!IDENTIFIER.test(identifier)) {
    throw new PlannerValidationError(`${field} contains unsupported characters`);
  }
  return identifier;
}

export function validateRootName(value: unknown): string {
  return validateIdentifier(value, 'rootName');
}

export function validateRelativePath(value: unknown, field = 'path'): string {
  if (typeof value !== 'string' || value.length > MAX_PLANNER_PATH_LENGTH) {
    throw new PlannerValidationError(`${field} must be a string of at most ${MAX_PLANNER_PATH_LENGTH} characters`);
  }
  if (value === '') return '';
  if (/^[/\\]/.test(value) || /^[A-Za-z]:[/\\]/.test(value) || /^\\\\/.test(value)) {
    throw new PlannerValidationError(`${field} must be repository-relative`);
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new PlannerValidationError(`${field} contains an invalid path segment`);
  }
  if (segments.some((segment) => /[\x00-\x1f]/.test(segment))) {
    throw new PlannerValidationError(`${field} contains a control character`);
  }
  return segments.join('/');
}

export async function selectedPlannerRoot(rootName: unknown): Promise<PlannerRoot> {
  const name = validateRootName(rootName);
  const roots = getConfig().roots;
  const resolved = await resolveRoot(roots, name);
  return { name: resolved.root.name, config: resolved.root, real: resolved.real };
}

export async function resolvePlannerReadPath(rootName: unknown, requestedPath: unknown): Promise<ResolvedPlannerPath> {
  const root = await selectedPlannerRoot(rootName);
  const relativePath = validateRelativePath(requestedPath);
  const virtualPath = relativePath ? `/${root.name}/${relativePath}` : `/${root.name}`;
  const resolved = await resolvePath(getConfig().roots, virtualPath);
  return { root, relativePath, virtualPath: resolved.virtual, realPath: resolved.real };
}

/**
 * Resolves the one path the browser planner may write. This is intentionally separate from
 * the task-document writer below: the browser protocol carries a repository-relative filename
 * and must never be able to select one of the app's broader document mappings.
 */
export async function resolvePlannerRelayWritePath(
  rootName: unknown,
  requestedPath: unknown
): Promise<ResolvedPlannerPath> {
  const root = await selectedPlannerRoot(rootName);
  const relativePath = validateRelativePath(requestedPath);
  const segments = relativePath.split('/');
  if (segments.length < 3 || segments[0] !== 'docs' || segments[1] !== 'plans') {
    throw new SandboxError('Planner relay writes are limited to docs/plans');
  }
  const virtualPath = `/${root.name}/${relativePath}`;
  const resolved = await resolvePath(getConfig().roots, virtualPath, { allowMissing: true });
  const plansRoot = path.join(root.real, 'docs', 'plans');
  if (!isContained(root.real, plansRoot) || !isContained(plansRoot, resolved.real)) {
    throw new SandboxError('Planner relay write target is outside docs/plans');
  }
  return { root, relativePath, virtualPath: resolved.virtual, realPath: resolved.real };
}

export function documentRelativePath(
  taskIdValue: unknown,
  documentTypeValue: unknown,
  blockIdValue: unknown
): { taskId: string; documentType: PlannerDocumentType; blockId: string | null; relativePath: string } {
  const taskId = validateIdentifier(taskIdValue, 'taskId');
  if (documentTypeValue !== 'plan' && documentTypeValue !== 'macro' && documentTypeValue !== 'micro'
    && documentTypeValue !== 'status' && documentTypeValue !== 'review') {
    throw new PlannerValidationError('documentType must be plan, macro, micro, status, or review');
  }
  const documentType = documentTypeValue as PlannerDocumentType;
  const blockId = blockIdValue === null || blockIdValue === undefined ? null : validateIdentifier(blockIdValue, 'blockId');
  if (documentType === 'micro') {
    if (blockId === null) throw new PlannerValidationError('blockId is required for micro documents');
    return { taskId, documentType, blockId, relativePath: `docs/tasks/${taskId}/micro/${blockId}.md` };
  }
  if (blockId !== null) throw new PlannerValidationError('blockId is only valid for micro documents');
  if (documentType === 'status' || documentType === 'review') {
    return { taskId, documentType, blockId: null, relativePath: `docs/tasks/${taskId}/${documentType}.md` };
  }
  return {
    taskId,
    documentType,
    blockId: null,
    relativePath: `docs/tasks/${taskId}/${documentType === 'plan' ? '00_plan.md' : '01_macro.md'}`
  };
}

export async function resolvePlannerDocumentPath(
  rootName: unknown,
  taskIdValue: unknown,
  documentTypeValue: unknown,
  blockIdValue: unknown
): Promise<PlannerDocumentPath> {
  const root = await selectedPlannerRoot(rootName);
  const mapped = documentRelativePath(taskIdValue, documentTypeValue, blockIdValue);
  const virtualPath = `/${root.name}/${mapped.relativePath}`;
  const resolved = await resolvePath(getConfig().roots, virtualPath, { allowMissing: true });
  const docsTasks = path.join(root.real, 'docs', 'tasks');
  if (!isContained(root.real, docsTasks) || !isContained(docsTasks, path.dirname(resolved.real))) {
    throw new SandboxError('Planner write target is outside docs/tasks');
  }
  return {
    root,
    ...mapped,
    virtualPath: resolved.virtual,
    realPath: resolved.real
  };
}

export function relativeToPlannerRoot(root: PlannerRoot, realPath: string): string {
  const relative = path.relative(root.real, realPath);
  return relative.split(path.sep).join('/');
}
