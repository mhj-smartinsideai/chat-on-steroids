/**
 * Full WebMCP adapter.
 *
 * This module projects the existing Core and Desktop surface registrations into a safe JSON
 * description and invokes the same registration handlers through kernel.dispatch. It owns no
 * filesystem, process, desktop, session or permission logic. A page snapshot is stable until
 * that page reconnects, while each invocation receives fresh live capabilities.
 */

import { z } from 'zod';
import { effectiveCapabilities, getConfig } from '../config.js';
import { logWarn } from '../logger.js';
import {
  createSurfaceRegistrar,
  type SurfaceToolRegistration,
  type ToolContext,
  type ToolResult
} from '../mcp/kernel.js';
import { registerCoreTools } from '../mcp/tools-core.js';
import { registerDesktopTools } from '../mcp/tools-desktop.js';
import { surfaceDefinition, type SurfaceId } from '../mcp/surfaces.js';
import type { Capabilities, Config } from '../../shared/types.js';

export const MAX_FULL_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_FULL_RESPONSE_BYTES = 8 * 1024 * 1024;
export const FULL_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const MAX_FULL_SNAPSHOTS = 32;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };

export interface FullToolMetadata {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  surface: SurfaceId;
  compatibility: 'standard' | 'image-content' | 'caller-identity-required';
}

export interface FullRegistrationDiagnostic {
  name: string;
  surface: SurfaceId;
  state: 'registered' | 'failed';
  reason?: string;
}

export interface FullToolsResponse {
  pageId: string;
  roots: string[];
  readOnly: boolean;
  capabilities: Capabilities;
  sessionRecording: boolean;
  multiAgent: boolean;
  tools: FullToolMetadata[];
  diagnostics: FullRegistrationDiagnostic[];
}

export interface FullCallInput {
  pageId: string;
  name: string;
  arguments: unknown;
}

interface FullSnapshot {
  pageId: string;
  createdAt: number;
  exposedCaps: Capabilities;
  exposedSessionTools: boolean;
  exposedAgentTools: boolean;
  exposedFind: boolean;
  tools: FullToolMetadata[];
  diagnostics: FullRegistrationDiagnostic[];
}

export class FullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FullRequestError';
  }
}

export class FullUnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown Full tool: ${name}`);
    this.name = 'FullUnknownToolError';
  }
}

const snapshots = new Map<string, FullSnapshot>();

function isPageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function requirePageId(value: unknown): string {
  if (!isPageId(value)) throw new FullRequestError('A valid Full page id is required');
  return value;
}

function cloneCapabilities(caps: Capabilities): Capabilities {
  return { ...caps };
}

function contextFor(config: Config, exposed?: FullSnapshot): ToolContext {
  const caps = effectiveCapabilities(config);
  return {
    roots: config.roots,
    caps,
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots,
    sessionTools: config.sessions.record,
    agentTools: config.multiAgent.enabled,
    ...(exposed
      ? {
          exposedCaps: cloneCapabilities(exposed.exposedCaps),
          exposedSessionTools: exposed.exposedSessionTools,
          exposedAgentTools: exposed.exposedAgentTools,
          exposedFind: exposed.exposedFind
        }
      : {})
  };
}

function compatibilityFor(name: string): FullToolMetadata['compatibility'] {
  if (name === 'agents') return 'caller-identity-required';
  if (name === 'view_image' || name === 'observe' || name === 'computer') return 'image-content';
  return 'standard';
}

function schemaFor(registration: SurfaceToolRegistration): JsonSchema {
  // Zod is already the authoritative schema used by the normal MCP registration. JSON Schema
  // conversion is the only protocol adaptation here; it does not loosen runtime safeParse.
  return z.toJSONSchema(registration.config.inputSchema) as unknown as JsonSchema;
}

function metadataFor(registration: SurfaceToolRegistration, surface: SurfaceId): FullToolMetadata {
  const metadata: FullToolMetadata = {
    name: registration.name,
    description: registration.config.description,
    inputSchema: schemaFor(registration),
    surface,
    compatibility: compatibilityFor(registration.name)
  };
  if (registration.config.title !== undefined) metadata.title = registration.config.title;
  if (registration.config.annotations !== undefined) metadata.annotations = { ...registration.config.annotations };
  return metadata;
}

function collectRegistrations(ctx: ToolContext, surface: SurfaceId): SurfaceToolRegistration[] {
  const registrations: SurfaceToolRegistration[] = [];
  const registrar = createSurfaceRegistrar(ctx, surface, (registration) => registrations.push(registration));
  if (surface === 'core') registerCoreTools(registrar);
  else registerDesktopTools(registrar);

  const declared = new Set(surfaceDefinition(surface).tools);
  const seen = new Set<string>();
  return registrations.filter((registration) => {
    if (!declared.has(registration.name)) {
      logWarn(`Full surface ${surface} registered undeclared tool "${registration.name}"`);
      return false;
    }
    if (seen.has(registration.name)) {
      logWarn(`Full surface ${surface} registered duplicate tool "${registration.name}"`);
      return false;
    }
    seen.add(registration.name);
    return true;
  });
}

function buildSnapshot(pageId: string): FullSnapshot {
  const config = getConfig();
  const live = effectiveCapabilities(config);
  const exposedCaps = cloneCapabilities(live);
  const context: ToolContext = {
    ...contextFor(config),
    exposedCaps,
    exposedSessionTools: config.sessions.record,
    exposedAgentTools: config.multiAgent.enabled,
    exposedFind: !live.command && live.search
  };
  const tools: FullToolMetadata[] = [];
  const diagnostics: FullRegistrationDiagnostic[] = [];
  for (const surface of ['core', 'desktop'] as const) {
    for (const registration of collectRegistrations(context, surface)) {
      try {
        tools.push(metadataFor(registration, surface));
        diagnostics.push({ name: registration.name, surface, state: 'registered' });
      } catch {
        // Schema conversion errors are local compatibility failures. Do not send the error or
        // schema internals to the browser, and do not advertise a tool that cannot register.
        diagnostics.push({
          name: registration.name,
          surface,
          state: 'failed',
          reason: 'The existing tool schema could not be represented for WebMCP'
        });
        logWarn(`Full WebMCP could not convert the ${surface} schema for "${registration.name}"`);
      }
    }
  }
  return {
    pageId,
    createdAt: Date.now(),
    exposedCaps,
    exposedSessionTools: config.sessions.record,
    exposedAgentTools: config.multiAgent.enabled,
    exposedFind: !live.command && live.search,
    tools,
    diagnostics
  };
}

function pruneSnapshots(now: number): void {
  for (const [pageId, snapshot] of snapshots) {
    if (now - snapshot.createdAt > FULL_SNAPSHOT_TTL_MS) snapshots.delete(pageId);
  }
  while (snapshots.size > MAX_FULL_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

function snapshotFor(pageIdValue: unknown): FullSnapshot {
  const pageId = requirePageId(pageIdValue);
  const now = Date.now();
  pruneSnapshots(now);
  const existing = snapshots.get(pageId);
  if (existing !== undefined) return existing;
  const snapshot = buildSnapshot(pageId);
  snapshots.set(pageId, snapshot);
  return snapshot;
}

export function clearFullSnapshots(): void {
  snapshots.clear();
}

export function fullTools(pageIdValue: unknown): FullToolsResponse {
  const snapshot = snapshotFor(pageIdValue);
  const config = getConfig();
  return {
    pageId: snapshot.pageId,
    roots: config.roots.map((root) => root.name),
    readOnly: config.readOnly,
    capabilities: effectiveCapabilities(config),
    sessionRecording: config.sessions.record,
    multiAgent: config.multiAgent.enabled,
    tools: snapshot.tools.map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema },
      ...(tool.annotations ? { annotations: { ...tool.annotations } } : {})
    })),
    diagnostics: snapshot.diagnostics.map((diagnostic) => ({ ...diagnostic }))
  };
}

function validationMessage(error: z.ZodError): string {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'arguments';
    return `${path}: ${issue.message}`;
  });
  return `Invalid arguments: ${issues.join('; ')}`.slice(0, 2000);
}

function findRegistration(ctx: ToolContext, name: string): SurfaceToolRegistration | null {
  for (const surface of ['core', 'desktop'] as const) {
    const found = collectRegistrations(ctx, surface).find((registration) => registration.name === name);
    if (found) return found;
  }
  return null;
}

export async function invokeFullTool(input: FullCallInput): Promise<ToolResult> {
  const snapshot = snapshotFor(input.pageId);
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 128) {
    throw new FullRequestError('A valid Full tool name is required');
  }
  if (!snapshot.tools.some((tool) => tool.name === input.name)) throw new FullUnknownToolError(input.name);

  const config = getConfig();
  const registration = findRegistration(contextFor(config, snapshot), input.name);
  if (!registration) throw new FullUnknownToolError(input.name);
  const parsed = registration.config.inputSchema.safeParse(input.arguments);
  if (!parsed.success) throw new FullRequestError(validationMessage(parsed.error));
  // transportKey is intentionally null: WebMCP does not provide the MCP transport identity,
  // and a localhost page is not a substitute for the application's caller proof chain.
  return registration.invoke(parsed.data, null);
}
