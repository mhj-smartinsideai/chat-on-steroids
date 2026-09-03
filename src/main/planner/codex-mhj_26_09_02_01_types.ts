import type { Root } from '../../shared/types.js';

export const PLANNER_PORT = 8771;
export const PLANNER_HOST = '127.0.0.1';
export const PLANNER_ORIGINS = [`http://${PLANNER_HOST}:${PLANNER_PORT}`, `http://localhost:${PLANNER_PORT}`] as const;
export const MAX_PLANNER_BODY_BYTES = 1024 * 1024;
export const MAX_PLANNER_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PLANNER_READ_BYTES = 256 * 1024;
export const MAX_PLANNER_WRITE_BYTES = 256 * 1024;
export const DEFAULT_TREE_DEPTH = 3;
export const MAX_TREE_DEPTH = 6;
export const MAX_TREE_ENTRIES = 2000;
export const MAX_TREE_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_SEARCH_RESULTS = 50;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_IDENTIFIER_LENGTH = 64;
export const MAX_PLANNER_PATH_LENGTH = 4096;

export type PlannerDocumentType = 'plan' | 'macro' | 'micro' | 'status' | 'review';
export type PlannerTreeEntryType = 'file' | 'directory' | 'other';
export type PlannerSearchMode = 'name' | 'content';
export type PlannerStopReason = 'limit' | 'time' | 'files' | 'size' | null;

export interface PlannerRootStatus {
  name: string;
  selected: boolean;
  available: boolean;
}

export interface PlannerStatus {
  running: boolean;
  port: number | null;
  roots: PlannerRootStatus[];
  selectedRoot: string | null;
}

export interface PlannerRoot {
  name: string;
  config: Root;
  real: string;
}

export interface ResolvedPlannerPath {
  root: PlannerRoot;
  relativePath: string;
  virtualPath: string;
  realPath: string;
}

export interface PlannerDocumentPath {
  root: PlannerRoot;
  taskId: string;
  documentType: PlannerDocumentType;
  blockId: string | null;
  relativePath: string;
  virtualPath: string;
  realPath: string;
}

export interface RepoTreeInput {
  rootName: string;
  path: string;
  depth: number;
}

export interface RepoTreeEntry {
  path: string;
  type: PlannerTreeEntryType;
  bytes: number | null;
}

export interface RepoTreeResult {
  rootName: string;
  path: string;
  entries: RepoTreeEntry[];
  truncated: boolean;
}

export interface RepoSearchInput {
  rootName: string;
  query: string;
  path: string;
  mode: PlannerSearchMode;
  maxResults: number;
  include: string | null;
  caseSensitive: boolean;
}

export interface RepoSearchHit {
  path: string;
  line: number | null;
  text: string | null;
}

export interface RepoSearchResult {
  rootName: string;
  path: string;
  hits: RepoSearchHit[];
  filesScanned: number;
  truncated: boolean;
  stoppedBecause: PlannerStopReason;
  elapsedMs: number;
}

export interface RepoReadInput {
  rootName: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  maxBytes: number;
}

export interface RepoReadResult {
  path: string;
  text: string;
  truncated: boolean;
  hasMore: boolean;
  firstLine: number;
  lastLine: number;
  totalLines: number | null;
  bytesReturned: number;
  fileBytes: number;
}

export interface PlanWriteInput {
  rootName: string;
  taskId: string;
  documentType: PlannerDocumentType;
  blockId: string | null;
  content: string;
}

export interface PlanWriteResult {
  relativePath: string;
  mode: 'created' | 'replaced';
  bytes: number;
}

export interface PlannerErrorBody {
  error: string;
  message: string;
}
