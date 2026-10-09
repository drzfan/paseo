import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_PROFILES_DIR,
  deriveProfileProviders,
  deriveProviderNames,
  mergeDerivedProviderOverrides,
  mergeProviderConfigs,
  resolveEnvValue,
} from "./profile-provider-deriver.js";
import type { ProviderOverride } from "@getpaseo/protocol/provider-config";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createProfilesDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-profile-deriver-"));
  tempDirs.push(dir);
  return dir;
}

function writeRole(
  profilesDir: string,
  role: string,
  options: { profile?: unknown; agentDir?: boolean; profileText?: string } = {},
): void {
  const roleDir = path.join(profilesDir, role);
  mkdirSync(roleDir, { recursive: true });
  if (options.agentDir === false) return;
  mkdirSync(path.join(roleDir, "agent-dir"), { recursive: true });
  if (options.profileText !== undefined) {
    writeFileSync(path.join(roleDir, "profile.json"), options.profileText);
    return;
  }
  if (options.profile !== undefined) {
    writeFileSync(path.join(roleDir, "profile.json"), JSON.stringify(options.profile, null, 2));
  }
}

describe("deriveProfileProviders", () => {
  test("derives a provider per role directory that has an agent-dir", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", { profile: { profile: "worker" } });

    const result = deriveProfileProviders({ profilesDir });

    expect(result.failures).toEqual([]);
    expect([...result.derived.keys()]).toEqual(["paseo-worker"]);
    expect(result.derived.get("paseo-worker")).toEqual({
      providerName: "paseo-worker",
      extends: "pi",
      label: "worker (paseo-profile)",
      env: { PI_CODING_AGENT_DIR: path.join(profilesDir, "worker", "agent-dir") },
    });
  });

  test("expands the profile.json env section (agentDir, file, literal)", () => {
    const profilesDir = createProfilesDir();
    const valueFile = path.join(profilesDir, "value.txt");
    writeFileSync(valueFile, "file-contents\n");
    writeRole(profilesDir, "worker", {
      profile: {
        profile: "worker",
        env: {
          PBASH_SETTLE_REMIND_FLAG_PATH: "=agentDir/settle-remind.on",
          PLAIN_LITERAL: "on",
          FILE_VALUE: `!file:${valueFile}`,
        },
      },
    });

    const result = deriveProfileProviders({ profilesDir });

    expect(result.failures).toEqual([]);
    expect(result.derived.get("paseo-worker")?.env).toEqual({
      PI_CODING_AGENT_DIR: path.join(profilesDir, "worker", "agent-dir"),
      FILE_VALUE: "file-contents",
      PBASH_SETTLE_REMIND_FLAG_PATH: path.join(
        profilesDir,
        "worker",
        "agent-dir",
        "settle-remind.on",
      ),
      PLAIN_LITERAL: "on",
    });
  });
  test("never writes PBASH_DIRECTORY_ROLE_SOURCE", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", { profile: { profile: "worker" } });

    const entry = deriveProfileProviders({ profilesDir }).derived.get("paseo-worker");

    expect(entry?.env.PBASH_DIRECTORY_ROLE_SOURCE).toBeUndefined();
    expect(Object.keys(entry?.env ?? {})).toEqual(["PI_CODING_AGENT_DIR"]);
  });

  test("writes env section keys in alphabetical order", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", {
      profile: { env: { ZEBRA: "1", ALPHA: "2", MIDDLE: "3" } },
    });

    const env = deriveProfileProviders({ profilesDir }).derived.get("paseo-worker")?.env ?? {};

    expect(Object.keys(env)).toEqual(["PI_CODING_AGENT_DIR", "ALPHA", "MIDDLE", "ZEBRA"]);
  });

  test("skips a role directory without agent-dir", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", { profile: { profile: "worker" } });
    writeRole(profilesDir, "broken", { agentDir: false, profile: { profile: "broken" } });

    const result = deriveProfileProviders({ profilesDir });

    expect([...result.derived.keys()]).toEqual(["paseo-worker"]);
    expect(result.failures).toEqual([
      {
        role: "broken",
        code: "no_agent_dir",
        message: `No agent-dir directory at ${path.join(profilesDir, "broken", "agent-dir")}`,
      },
    ]);
  });

  test("skips a role with unreadable profile.json", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", { profileText: "{ not json" });
    writeRole(profilesDir, "designer", { profile: { profile: "designer" } });

    const result = deriveProfileProviders({ profilesDir });

    expect([...result.derived.keys()]).toEqual(["paseo-designer"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.role).toBe("worker");
    expect(result.failures[0]?.code).toBe("bad_profile_json");
  });

  test("skips a role without profile.json", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", {});

    const result = deriveProfileProviders({ profilesDir });

    expect(result.derived.size).toBe(0);
    expect(result.failures[0]?.code).toBe("bad_profile_json");
  });

  test("skips a role whose env section is malformed", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", { profile: { env: ["nope"] } });
    writeRole(profilesDir, "designer", { profile: { env: { "lower-case": "x" } } });
    writeRole(profilesDir, "reviewer", { profile: { env: { GOOD_KEY: 7 } } });

    const result = deriveProfileProviders({ profilesDir });

    expect(result.derived.size).toBe(0);
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "bad_profile_json",
      "bad_profile_json",
      "bad_profile_json",
    ]);
  });

  test.each([
    ["=agentDir/", "bad_env_value"],
    ["=agentDir//etc/passwd", "bad_env_value"],
    ["=agentDir/../../etc/passwd", "bad_env_value"],
    ["!file:relative/path.txt", "bad_env_value"],
    [`!file:${path.join(tmpdir(), "paseo-derive-missing-file.txt")}`, "secret_read_failed"],
    ["", "bad_env_value"],
    ["   ", "bad_env_value"],
  ])("skips a role with env value %j (%s)", (value, code) => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "worker", { profile: { env: { PROBE_KEY: value } } });

    const result = deriveProfileProviders({ profilesDir });

    expect(result.derived.size).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ role: "worker", code });
  });

  test("skips a role whose directory name cannot form a provider id", () => {
    const profilesDir = createProfilesDir();
    writeRole(profilesDir, "Bad_Role", { profile: { profile: "Bad_Role" } });
    writeRole(profilesDir, "UPPER", { profile: { profile: "UPPER" } });
    writeRole(profilesDir, "worker", { profile: { profile: "worker" } });

    const result = deriveProfileProviders({ profilesDir });

    expect([...result.derived.keys()]).toEqual(["paseo-worker"]);
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "invalid_provider_name",
      "invalid_provider_name",
    ]);
  });

  test("reports an unreadable profiles directory instead of throwing", () => {
    const result = deriveProfileProviders({
      profilesDir: path.join(tmpdir(), "paseo-derive-profiles-missing"),
    });

    expect(result.derived.size).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe("profiles_dir_unreadable");
  });

  test("ignores plain files and non-role bookkeeping directories", () => {
    const profilesDir = createProfilesDir();
    writeFileSync(path.join(profilesDir, "README.md"), "not a role");
    mkdirSync(path.join(profilesDir, ".git"), { recursive: true });
    mkdirSync(path.join(profilesDir, "node_modules"), { recursive: true });
    writeRole(profilesDir, "worker", { profile: { profile: "worker" } });

    const result = deriveProfileProviders({ profilesDir });

    expect([...result.derived.keys()]).toEqual(["paseo-worker"]);
    expect(result.failures).toEqual([]);
  });

  test("derives every role of the real profiles tree", () => {
    const result = deriveProfileProviders();

    expect(result.failures).toEqual([]);
    for (const role of [
      "acceptance",
      "designer",
      "foreman",
      "manager",
      "opus",
      "quick",
      "reviewer",
      "sol",
      "sonnet",
      "tester",
      "writer",
      "worker",
    ]) {
      const entry = result.derived.get(`paseo-${role}`);
      expect(entry, `missing paseo-${role}`).toBeDefined();
      expect(entry?.env.PI_CODING_AGENT_DIR).toBe(`${DEFAULT_PROFILES_DIR}/${role}/agent-dir`);
      expect(entry?.label).toBe(`${role} (paseo-profile)`);
      expect(entry?.extends).toBe("pi");
    }
    expect(deriveProviderNames()).toEqual([...deriveProfileProviders().derived.keys()]);
  });
});

describe("resolveEnvValue", () => {
  const agentDir = "/root/pi-profiles/worker/agent-dir";

  test("resolves agentDir-relative values", () => {
    expect(resolveEnvValue("=agentDir/settle-remind.on", { agentDir, readFile: () => "" })).toEqual(
      {
        ok: true,
        value: "/root/pi-profiles/worker/agent-dir/settle-remind.on",
      },
    );
    expect(
      resolveEnvValue("=agentDir/nested/dir/file.txt", { agentDir, readFile: () => "" }),
    ).toEqual({ ok: true, value: "/root/pi-profiles/worker/agent-dir/nested/dir/file.txt" });
  });

  test("rejects agentDir escapes", () => {
    for (const raw of ["=agentDir/", "=agentDir/../escape", "=agentDir//abs"]) {
      const resolved = resolveEnvValue(raw, { agentDir, readFile: () => "" });
      expect(resolved.ok).toBe(false);
    }
  });

  test("reads file values and trims the trailing newline", () => {
    expect(
      resolveEnvValue("!file:/etc/hostname", { agentDir, readFile: () => "value\n\n" }),
    ).toEqual({ ok: true, value: "value" });
    expect(resolveEnvValue("!file:/etc/hostname", { agentDir, readFile: () => "value" })).toEqual({
      ok: true,
      value: "value",
    });
  });

  test("rejects unreadable, empty and non-absolute file values", () => {
    expect(
      resolveEnvValue("!file:/missing", {
        agentDir,
        readFile: () => {
          throw new Error("ENOENT");
        },
      }).ok,
    ).toBe(false);
    expect(resolveEnvValue("!file:/empty", { agentDir, readFile: () => "\n" }).ok).toBe(false);
    expect(resolveEnvValue("!file:relative.txt", { agentDir, readFile: () => "x" }).ok).toBe(false);
  });

  test("passes literals through unchanged", () => {
    expect(resolveEnvValue("plain-string", { agentDir, readFile: () => "" })).toEqual({
      ok: true,
      value: "plain-string",
    });
    expect(resolveEnvValue("  ", { agentDir, readFile: () => "" }).ok).toBe(false);
  });
});

describe("mergeProviderConfigs", () => {
  const derived = new Map([
    [
      "paseo-worker",
      {
        providerName: "paseo-worker",
        extends: "pi" as const,
        label: "worker (paseo-profile)",
        env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/worker/agent-dir" },
      },
    ],
    [
      "paseo-tester",
      {
        providerName: "paseo-tester",
        extends: "pi" as const,
        label: "tester (paseo-profile)",
        env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/tester/agent-dir" },
      },
    ],
  ]);

  test("adds derived names as runtime settings", () => {
    expect(mergeProviderConfigs(undefined, derived)).toEqual({
      "paseo-worker": { env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/worker/agent-dir" } },
      "paseo-tester": { env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/tester/agent-dir" } },
    });
  });

  test("static entries win wholesale (no key-level env merge)", () => {
    const merged = mergeProviderConfigs(
      { "paseo-worker": { env: { PI_CODING_AGENT_DIR: "/somewhere/else" } } },
      derived,
    );

    expect(merged["paseo-worker"]).toEqual({ env: { PI_CODING_AGENT_DIR: "/somewhere/else" } });
    expect(merged["paseo-tester"]).toEqual({
      env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/tester/agent-dir" },
    });
  });

  test("does not mutate its inputs", () => {
    const staticProviders = { pi: { env: { EXISTING: "1" } } };
    const derivedCopy = new Map(derived);

    mergeProviderConfigs(staticProviders, derivedCopy);

    expect(staticProviders).toEqual({ pi: { env: { EXISTING: "1" } } });
    expect(derivedCopy).toEqual(derived);
  });
});

describe("mergeDerivedProviderOverrides", () => {
  const derived = new Map([
    [
      "paseo-worker",
      {
        providerName: "paseo-worker",
        extends: "pi" as const,
        label: "worker (paseo-profile)",
        env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/worker/agent-dir" },
      },
    ],
  ]);

  test("materializes derived declarations with extends/label/env", () => {
    expect(mergeDerivedProviderOverrides(undefined, derived)).toEqual({
      "paseo-worker": {
        extends: "pi",
        label: "worker (paseo-profile)",
        env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/worker/agent-dir" },
      },
    });
  });

  test("keeps a static declaration untouched", () => {
    const staticProviders: Record<string, ProviderOverride> = {
      "paseo-worker": {
        extends: "pi",
        label: "worker (paseo-profile)",
        env: { PI_CODING_AGENT_DIR: "/root/pi-profiles/worker/agent-dir", X: "1" },
      },
    };

    expect(mergeDerivedProviderOverrides(staticProviders, derived)).toEqual(staticProviders);
  });
});

describe("hand-written provider equivalence (spec §2.1 migration check)", () => {
  // Verbatim copy of the hand-written `agents.providers` entries of a real daemon
  // config (~/.paseo/config.json). Derived output must match field for field, with
  // PBASH_DIRECTORY_ROLE_SOURCE as the only difference.
  const HAND_WRITTEN: Record<string, ProviderOverride> = {
    "paseo-designer": {
      extends: "pi",
      label: "designer (paseo-profile)",
      env: {
        PI_CODING_AGENT_DIR: "/root/pi-profiles/designer/agent-dir",
        PBASH_DIRECTORY_ROLE_SOURCE: "on",
      },
    },
    "paseo-foreman": {
      extends: "pi",
      label: "foreman (paseo-profile)",
      env: {
        PI_CODING_AGENT_DIR: "/root/pi-profiles/foreman/agent-dir",
        PBASH_DIRECTORY_ROLE_SOURCE: "on",
      },
    },
    "paseo-manager": {
      extends: "pi",
      label: "manager (paseo-profile)",
      env: {
        PI_CODING_AGENT_DIR: "/root/pi-profiles/manager/agent-dir",
        PBASH_DIRECTORY_ROLE_SOURCE: "on",
      },
    },
    "paseo-quick": {
      extends: "pi",
      label: "quick (paseo-profile)",
      env: {
        PI_CODING_AGENT_DIR: "/root/pi-profiles/quick/agent-dir",
        PBASH_DIRECTORY_ROLE_SOURCE: "on",
      },
    },
    "paseo-reviewer": {
      extends: "pi",
      label: "reviewer (paseo-profile)",
      env: {
        PI_CODING_AGENT_DIR: "/root/pi-profiles/reviewer/agent-dir",
        PBASH_DIRECTORY_ROLE_SOURCE: "on",
      },
    },
    "paseo-sol": {
      extends: "pi",
      label: "sol (paseo-profile)",
      env: {
        PI_CODING_AGENT_DIR: "/root/pi-profiles/sol/agent-dir",
        PBASH_DIRECTORY_ROLE_SOURCE: "on",
      },
    },
    "paseo-worker": {
      extends: "pi",
      label: "worker (paseo-profile)",
      env: {
        PI_CODING_AGENT_DIR: "/root/pi-profiles/worker/agent-dir",
        PBASH_DIRECTORY_ROLE_SOURCE: "on",
      },
    },
  };

  test("derived declarations match the hand-written ones byte for byte", () => {
    const result = deriveProfileProviders();

    for (const [providerName, handWritten] of Object.entries(HAND_WRITTEN)) {
      const entry = result.derived.get(providerName);
      expect(entry, `missing derived ${providerName}`).toBeDefined();
      const derivedEnv = { ...entry?.env };
      const handWrittenEnv = { ...handWritten.env };
      delete derivedEnv.PBASH_DIRECTORY_ROLE_SOURCE;
      delete handWrittenEnv.PBASH_DIRECTORY_ROLE_SOURCE;
      expect(derivedEnv).toEqual(handWrittenEnv);
      expect(entry?.extends).toBe(handWritten.extends);
      expect(entry?.label).toBe(handWritten.label);
      expect(Object.keys(entry?.env ?? {}).filter((key) => key !== "PI_CODING_AGENT_DIR")).toEqual(
        [],
      );
    }
  });

  test("static-wins merge keeps the hand-written value at runtime", () => {
    const merged = mergeDerivedProviderOverrides(HAND_WRITTEN, deriveProfileProviders().derived);

    for (const [providerName, handWritten] of Object.entries(HAND_WRITTEN)) {
      expect(merged[providerName]).toEqual(handWritten);
    }
  });
});
