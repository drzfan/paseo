import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractAttention,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  options: { broadcastTimeline: boolean };
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();

/**
 * How long a failed lazy load stays cached once a caller opts in. Polling clients retry a
 * dead agent's timeline on a timer; without this window every poll respawns the provider
 * binary just to watch it die, which floods the logs and starves the event loop.
 */
export const AGENT_LOAD_FAILURE_CACHE_TTL_MS = 30_000;
const AGENT_LOAD_FAILURE_CACHE_LIMIT = 500;

const CACHED_AGENT_LOAD_FAILURE = Symbol.for("paseo.cachedAgentLoadFailure");

interface CachedAgentLoadFailure {
  error: Error;
  expiresAt: number;
}

const agentLoadFailures = new Map<string, CachedAgentLoadFailure>();

/**
 * True when the error was replayed from the negative cache instead of a fresh attempt.
 * Callers can use it to log repeats quietly — the first failure is already on record.
 */
export function isCachedAgentLoadFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { [CACHED_AGENT_LOAD_FAILURE]?: boolean })[CACHED_AGENT_LOAD_FAILURE] === true
  );
}

function markCachedAgentLoadFailure(error: Error): Error {
  Object.defineProperty(error, CACHED_AGENT_LOAD_FAILURE, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
}

function pruneAgentLoadFailures(now: number): void {
  for (const [agentId, entry] of agentLoadFailures) {
    if (entry.expiresAt <= now) {
      agentLoadFailures.delete(agentId);
    }
  }
  while (agentLoadFailures.size >= AGENT_LOAD_FAILURE_CACHE_LIMIT) {
    const oldest = agentLoadFailures.keys().next();
    if (oldest.done) {
      return;
    }
    agentLoadFailures.delete(oldest.value);
  }
}

function rememberAgentLoadFailure(agentId: string, error: Error, ttlMs: number, now: number): void {
  if (!(ttlMs > 0)) {
    return;
  }
  pruneAgentLoadFailures(now);
  agentLoadFailures.set(agentId, { error, expiresAt: now + ttlMs });
}

function readCachedAgentLoadFailure(agentId: string, now: number): Error | null {
  const cached = agentLoadFailures.get(agentId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= now) {
    agentLoadFailures.delete(agentId);
    return null;
  }
  return cached.error;
}

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  /**
   * Enables the negative cache: how long a failed load for the same agent stays
   * replayed (no storage read, no provider spawn). Opt-in per caller so that
   * user-driven paths (prompt, import, voice) keep retrying immediately after a
   * fix, while poll loops stop hammering a known-dead agent.
   */
  failureCacheTtlMs?: number;
  logger: Logger;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps & {
    agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
  },
): Promise<ManagedAgent> {
  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }

  const agent = await ensureAgentLoaded(agentId, deps);
  const latestRecord = await deps.agentStorage.get(agentId);
  if (latestRecord?.archivedAt) {
    await deps.agentManager.closeAgent(agentId).catch((error: unknown) => {
      deps.logger.warn({ err: error, agentId }, "Failed to close concurrently archived agent");
    });
    throw new Error(`Agent is archived: ${agentId}`);
  }

  return agent;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return inflight.promise;
  }

  const existing = deps.agentManager.getAgent(agentId);
  if (existing) {
    return existing;
  }

  // Opt-in negative cache: replay a recent failure instead of respawning the provider
  // binary that just died. Entries expire on their own, and a successful load clears
  // them, so a fixed agent loads on the next attempt.
  const failureCacheTtlMs = deps.failureCacheTtlMs;
  const cachedFailure =
    failureCacheTtlMs === undefined ? null : readCachedAgentLoadFailure(agentId, Date.now());
  if (cachedFailure) {
    throw markCachedAgentLoadFailure(cachedFailure);
  }

  // A close may have started after the first barrier observed no in-flight
  // work. Once the live lookup is empty, this second barrier closes that gap
  // before storage-backed resume begins.
  await deps.agentManager.waitForAgentClose?.(agentId);

  const laterInflight = pendingAgentInitializations.get(agentId);
  if (laterInflight) {
    laterInflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return laterInflight.promise;
  }

  const pendingOptions = {
    broadcastTimeline: deps.broadcastTimeline === true,
  };
  const initPromise = (async () => {
    const record = await deps.agentStorage.get(agentId);
    if (!record) {
      throw new AgentNotFoundError(agentId);
    }

    const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
    if (!isStoredAgentProviderAvailable(record, validProviders)) {
      throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
    }

    const handle = toAgentPersistenceHandle(validProviders, record.persistence);

    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        { ...extractTimestamps(record), attention: extractAttention(record) },
        record.archivedAt ? { purpose: "history" } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      // No provider handle to resume: this starts the agent's first session rather than
      // bringing one back, so it stamps activity and carries no stored attention. Records
      // without a handle never got far enough to accumulate either.
      const config = buildSessionConfig(record, {
        validProviders,
      });
      if (!config) {
        throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
      }
      snapshot = await deps.agentManager.createAgent(config, agentId, {
        labels: record.labels,
        workspaceId: record.workspaceId,
        owner: record.owner,
      });
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => pendingOptions.broadcastTimeline,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  const pending: PendingAgentInitialization = { promise: initPromise, options: pendingOptions };
  pendingAgentInitializations.set(agentId, pending);

  try {
    const loaded = await initPromise;
    if (failureCacheTtlMs !== undefined) {
      agentLoadFailures.delete(agentId);
    }
    return loaded;
  } catch (error) {
    if (error instanceof Error && failureCacheTtlMs !== undefined) {
      rememberAgentLoadFailure(agentId, error, failureCacheTtlMs, Date.now());
    }
    throw error;
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === pending) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}
