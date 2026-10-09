import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import type { ProviderOverride } from "@getpaseo/protocol/provider-config";

/**
 * Directory-derived provider layer (spec §1.2 / §2.1).
 *
 * Every role directory under `profilesDir` that contains an `agent-dir` becomes a
 * thin `paseo-<role>` provider declaration (`extends: "pi"` + env carrying
 * `PI_CODING_AGENT_DIR` and the role's `profile.json` `env` section). The result is
 * merged into the daemon config with static (hand-written) entries winning, so a
 * config.json declaration keeps overriding the derived one.
 *
 * This module is pure with respect to process control: it only reads the
 * filesystem, never spawns a child and never touches the network. Failures are
 * reported through `DeriveResult.failures` instead of throwing, so a broken role
 * directory can never take the daemon down.
 */

/** Default profiles tree (spec §1.2 `DeriveOptions`). */
export const DEFAULT_PROFILES_DIR = "/root/pi-profiles";

/** Subdirectory that marks a role directory as a pi profile (spec §1.2 rule 1). */
const AGENT_DIR_NAME = "agent-dir";
/** Role declaration file read for the `env` section (spec §1.1). */
const PROFILE_FILE_NAME = "profile.json";
/** env key that always points at the derived agent dir (spec §1.2 rule 2). */
const AGENT_DIR_ENV_KEY = "PI_CODING_AGENT_DIR";
/** `PBASH_DIRECTORY_ROLE_SOURCE` is deliberately NOT written (spec §1.2 rule 3). */

/** Value prefixes of the profile.json `env` section grammar (spec §1.1). */
const AGENT_DIR_VALUE_PREFIX = "=agentDir/";
const FILE_VALUE_PREFIX = "!file:";

/** Same pattern the protocol uses for provider ids (`ProviderOverridesSchema`). */
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/** env key convention (spec §1.1). */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
/**
 * Directory names that are never roles: dot entries (VCS/tooling metadata) and the
 * dependency tree. They are skipped silently instead of being reported as
 * `no_agent_dir` failures so the failure list stays a role-level signal.
 */
const NON_ROLE_DIRECTORY_NAMES = new Set(["node_modules"]);

function isRoleDirectoryName(name: string): boolean {
  return !name.startsWith(".") && !NON_ROLE_DIRECTORY_NAMES.has(name);
}

export interface DerivedProviderEntry {
  providerName: string;
  extends: "pi";
  label: string;
  env: Record<string, string>;
}

/**
 * `no_agent_dir` / `bad_profile_json` / `bad_env_value` / `secret_read_failed` are the
 * codes pinned by spec §1.2. `invalid_provider_name` and `profiles_dir_unreadable` are
 * the two conditions the spec describes in prose (rule 4 "directory name contains
 * illegal characters" and an unreadable scan root) without giving them a code slot;
 * they are additive, so every spec-pinned code keeps its meaning.
 */
export type DeriveFailureCode =
  | "no_agent_dir"
  | "bad_profile_json"
  | "bad_env_value"
  | "secret_read_failed"
  | "invalid_provider_name"
  | "profiles_dir_unreadable";

export interface DeriveFailure {
  role: string;
  code: DeriveFailureCode;
  message: string;
}

export interface DeriveResult {
  derived: Map<string, DerivedProviderEntry>;
  failures: DeriveFailure[];
}

export interface DeriveOptions {
  profilesDir: string;
}

/** Injection seam for `resolveEnvValue` (spec §1.1 TS schema). */
export interface EnvValueResolveContext {
  agentDir: string;
  readFile: (path: string) => string;
}

export type EnvValueResolution = { ok: true; value: string } | { ok: false; error: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve one `profile.json` env value (spec §1.1).
 *
 * - `=agentDir/<relative>` → `<agentDir>/<relative>` (no `..` escape, no absolute path)
 * - `!file:<absolute>` → file contents with trailing newlines trimmed
 * - anything else → the literal value, which must be non-empty
 */
export function resolveEnvValue(raw: string, ctx: EnvValueResolveContext): EnvValueResolution {
  if (raw.startsWith(AGENT_DIR_VALUE_PREFIX)) {
    const relative = raw.slice(AGENT_DIR_VALUE_PREFIX.length);
    if (relative.length === 0) {
      return { ok: false, error: `${AGENT_DIR_VALUE_PREFIX} value must name a relative path` };
    }
    if (isAbsolute(relative)) {
      return { ok: false, error: `${AGENT_DIR_VALUE_PREFIX} value must be relative: ${relative}` };
    }
    if (relative.split("/").some((segment) => segment === "..")) {
      return {
        ok: false,
        error: `${AGENT_DIR_VALUE_PREFIX} value must not escape the agent dir: ${relative}`,
      };
    }
    return { ok: true, value: join(ctx.agentDir, relative) };
  }

  if (raw.startsWith(FILE_VALUE_PREFIX)) {
    const filePath = raw.slice(FILE_VALUE_PREFIX.length).trim();
    if (!isAbsolute(filePath)) {
      return {
        ok: false,
        error: `${FILE_VALUE_PREFIX} value must be an absolute path: ${filePath}`,
      };
    }
    let contents: string;
    try {
      contents = ctx.readFile(filePath);
    } catch (error) {
      return { ok: false, error: `Cannot read ${filePath}: ${describeError(error)}` };
    }
    const value = contents.replace(/[\r\n]+$/, "");
    if (value.trim().length === 0) {
      return { ok: false, error: `${filePath} has no content` };
    }
    return { ok: true, value };
  }

  if (raw.trim().length === 0) {
    return { ok: false, error: "env value must be a non-empty literal" };
  }
  return { ok: true, value: raw };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedEnvSection {
  ok: true;
  spec: Record<string, string>;
}

function parseEnvSection(profile: unknown): ParsedEnvSection | { ok: false; error: string } {
  if (!isRecord(profile)) {
    return { ok: false, error: "profile.json must contain a JSON object" };
  }
  const env = profile.env;
  if (env === undefined) {
    return { ok: true, spec: {} };
  }
  if (!isRecord(env)) {
    return { ok: false, error: "env section must be an object of string values" };
  }
  const spec: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      return { ok: false, error: `env key "${key}" must match ${ENV_KEY_PATTERN.source}` };
    }
    if (typeof value !== "string") {
      return { ok: false, error: `env value for "${key}" must be a string` };
    }
    spec[key] = value;
  }
  return { ok: true, spec };
}

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}

/** Maps a rejected env value onto the spec §1.2 failure code. */
function envFailureCode(raw: string): DeriveFailureCode {
  if (!raw.startsWith(FILE_VALUE_PREFIX)) return "bad_env_value";
  const filePath = raw.slice(FILE_VALUE_PREFIX.length).trim();
  return isAbsolute(filePath) ? "secret_read_failed" : "bad_env_value";
}

/**
 * Scan `profilesDir` and synthesize one provider declaration per role directory.
 *
 * Pure function: no spawn, no network. Every broken role is reported in
 * `failures` and skipped, so the caller can log it without losing the daemon.
 */
export function deriveProfileProviders(opts?: Partial<DeriveOptions>): DeriveResult {
  const profilesDir = opts?.profilesDir ?? DEFAULT_PROFILES_DIR;
  const derived = new Map<string, DerivedProviderEntry>();
  const failures: DeriveFailure[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch (error) {
    failures.push({
      role: profilesDir,
      code: "profiles_dir_unreadable",
      message: `Cannot read profiles directory ${profilesDir}: ${describeError(error)}`,
    });
    return { derived, failures };
  }

  for (const entry of entries) {
    const role = entry.name;
    if (!isRoleDirectoryName(role)) continue;
    const roleDir = join(profilesDir, role);
    if (!isDirectory(roleDir)) continue;

    const agentDir = join(roleDir, AGENT_DIR_NAME);
    if (!isDirectory(agentDir)) {
      failures.push({
        role,
        code: "no_agent_dir",
        message: `No ${AGENT_DIR_NAME} directory at ${agentDir}`,
      });
      continue;
    }

    const providerName = `paseo-${role}`;
    if (!PROVIDER_NAME_PATTERN.test(providerName)) {
      failures.push({
        role,
        code: "invalid_provider_name",
        message: `Role "${role}" yields invalid provider name "${providerName}" (must match ${PROVIDER_NAME_PATTERN.source})`,
      });
      continue;
    }

    const profilePath = join(roleDir, PROFILE_FILE_NAME);
    let raw: string;
    try {
      raw = readFileText(profilePath);
    } catch (error) {
      failures.push({
        role,
        code: "bad_profile_json",
        message: `Cannot read ${profilePath}: ${describeError(error)}`,
      });
      continue;
    }

    let profile: unknown;
    try {
      profile = JSON.parse(raw);
    } catch (error) {
      failures.push({
        role,
        code: "bad_profile_json",
        message: `Invalid JSON in ${profilePath}: ${describeError(error)}`,
      });
      continue;
    }

    const envSection = parseEnvSection(profile);
    if (!envSection.ok) {
      failures.push({ role, code: "bad_profile_json", message: envSection.error });
      continue;
    }

    // Spec §1.2 rule 2: `{ PI_CODING_AGENT_DIR: <abs> } ∪ env section`. The base key is
    // written first so an explicit env-section declaration of the same key wins.
    const env: Record<string, string> = { [AGENT_DIR_ENV_KEY]: agentDir };
    let failed: DeriveFailure | null = null;
    // Alphabetical key order keeps generated declarations diff-stable (spec §1.1).
    for (const key of Object.keys(envSection.spec).sort()) {
      const resolved = resolveEnvValue(envSection.spec[key], {
        agentDir,
        readFile: readFileText,
      });
      if (!resolved.ok) {
        failed = { role, code: envFailureCode(envSection.spec[key]), message: resolved.error };
        break;
      }
      env[key] = resolved.value;
    }
    if (failed) {
      failures.push(failed);
      continue;
    }

    derived.set(providerName, {
      providerName,
      extends: "pi",
      label: `${role} (paseo-profile)`,
      env,
    });
  }

  return { derived, failures };
}

/**
 * Static-wins merge of the runtime provider settings map (spec §1.2).
 *
 * A hand-written entry wins wholesale: its value replaces the derived entry entirely
 * (no key-level env merge). Names only present in `derived` are added as
 * `{ env }` runtime settings.
 */
export function mergeProviderConfigs(
  staticProviders: AgentProviderRuntimeSettingsMap | undefined,
  derived: Map<string, DerivedProviderEntry>,
): AgentProviderRuntimeSettingsMap {
  const merged: AgentProviderRuntimeSettingsMap = { ...staticProviders };
  for (const [providerName, entry] of derived) {
    if (providerName in merged) continue;
    merged[providerName] = { env: { ...entry.env } };
  }
  return merged;
}

/**
 * Static-wins merge of the provider override declarations (spec §1.2 rule 5).
 *
 * Hand-written declarations keep every field they declare; derived names that the
 * static section does not declare are materialized as thin `extends: "pi"`
 * declarations carrying the derived env.
 */
export function mergeDerivedProviderOverrides(
  staticProviders: Record<string, ProviderOverride> | undefined,
  derived: Map<string, DerivedProviderEntry>,
): Record<string, ProviderOverride> {
  const merged: Record<string, ProviderOverride> = { ...staticProviders };
  for (const [providerName, entry] of derived) {
    if (providerName in merged) continue;
    merged[providerName] = {
      extends: entry.extends,
      label: entry.label,
      env: { ...entry.env },
    };
  }
  return merged;
}

/** Convenience helper: the provider names the derivation layer currently owns. */
export function deriveProviderNames(opts?: Partial<DeriveOptions>): string[] {
  return [...deriveProfileProviders(opts).derived.keys()];
}
