import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, resolveBundledWebUiDistDir, resolveConfigFromPersisted } from "./config.js";
import { loadPersistedConfig } from "./persisted-config.js";

const roots: string[] = [];

describe("server config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("records when the daemon is managed by Paseo Desktop", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-desktop-managed-"));
    roots.push(paseoHome);

    const desktopConfig = loadConfig(paseoHome, {
      env: { PASEO_DESKTOP_MANAGED: "1" },
    });
    const standaloneConfig = loadConfig(paseoHome, { env: {} });

    expect(desktopConfig.desktopManaged).toBe(true);
    expect(standaloneConfig.desktopManaged).toBe(false);
  });

  test("loads the provider catalog refresh timeout", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-provider-timeout-"));
    roots.push(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ agents: { catalogRefreshTimeoutMs: 180_000 } }),
    );

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.providerCatalogRefreshTimeoutMs).toBe(180_000);
  });

  test("resolves reload state from the supplied validated snapshot", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-snapshot-"));
    roots.push(paseoHome);
    const snapshot = loadPersistedConfig(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        ...snapshot,
        daemon: { ...snapshot.daemon, browserTools: { enabled: true } },
      }),
    );

    expect(resolveConfigFromPersisted(paseoHome, snapshot, { env: {} }).browserToolsEnabled).toBe(
      false,
    );
    expect(loadConfig(paseoHome, { env: {} }).browserToolsEnabled).toBe(true);
  });

  test("records mutable and startup launch overrides by persisted leaf", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-overrides-"));
    roots.push(paseoHome);
    const config = loadConfig(paseoHome, {
      env: {
        PASEO_LISTEN: "127.0.0.1:7000",
        PASEO_PASSWORD: "secret",
        PASEO_RELAY_ENDPOINT: "relay.example.test:443",
        PASEO_TRUSTED_PROXIES: "true",
        PASEO_WEB_UI_ENABLED: "true",
        PASEO_LOG_FILE_PATH: "custom.log",
        PASEO_VOICE_LLM_PROVIDER: "codex",
      },
      cli: { relayUseTls: false },
    });

    expect(config.configReload?.overrideControlledPaths).toEqual([
      "daemon.auth.password",
      "daemon.listen",
      "daemon.relay.endpoint",
      "daemon.relay.useTls",
      "daemon.trustedProxies",
      "features.voiceMode.llm.provider",
      "features.webUi.enabled",
      "log.file.path",
    ]);
    expect(config.listen).toBe("127.0.0.1:7000");
    expect(config.trustedProxies).toBe(true);
    expect(config.log?.file?.path).toBe("custom.log");
    expect(config.voiceLlmProvider).toBe("codex");
  });

  test.each([
    {
      name: "local speech providers",
      providers: { dictation: "local", voiceStt: "local", voiceTts: "local" },
      expected: [
        "features.dictation.stt.model",
        "features.voiceMode.stt.model",
        "features.voiceMode.tts.model",
      ],
    },
    {
      name: "OpenAI speech providers",
      providers: { dictation: "openai", voiceStt: "openai", voiceTts: "openai" },
      expected: [
        "features.dictation.stt.confidenceThreshold",
        "features.dictation.stt.model",
        "features.voiceMode.stt.model",
        "features.voiceMode.tts.model",
        "features.voiceMode.tts.voice",
      ],
    },
    {
      name: "mixed local and OpenAI speech providers",
      providers: { dictation: "local", voiceStt: "openai", voiceTts: "local" },
      expected: [
        "features.dictation.stt.confidenceThreshold",
        "features.dictation.stt.model",
        "features.voiceMode.stt.model",
        "features.voiceMode.tts.model",
      ],
    },
  ])("classifies speech overrides for $name", ({ providers, expected }) => {
    const config = resolveConfigFromPersisted(
      "/tmp/paseo-speech-override-classification",
      {
        version: 1,
        features: {
          dictation: { enabled: true, stt: { provider: providers.dictation } },
          voiceMode: {
            enabled: true,
            stt: { provider: providers.voiceStt },
            tts: { provider: providers.voiceTts },
          },
        },
      },
      {
        env: {
          OPENAI_API_KEY: "test-api-key",
          PASEO_DICTATION_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
          PASEO_VOICE_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
          PASEO_VOICE_LOCAL_TTS_MODEL: "kokoro-en-v0_19",
          STT_CONFIDENCE_THRESHOLD: "0.5",
          STT_MODEL: "whisper-1",
          TTS_MODEL: "tts-1",
          TTS_VOICE: "alloy",
        },
      },
    );

    expect(config.configReload?.overrideControlledPaths).toEqual(expected);
  });

  test("resolves bundled web UI path from source-tree modules", () => {
    const root = path.parse(process.cwd()).root;
    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(
          path.join(root, "repo", "packages", "server", "src", "server", "config.ts"),
        ),
      }),
    ).toBe(path.join(root, "repo", "packages", "server", "dist", "server", "web-ui"));
  });

  test("resolves bundled web UI path from globally installed compiled modules", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-compiled-"));
    roots.push(packageRoot);
    await mkdir(path.join(packageRoot, "dist", "server", "web-ui"), { recursive: true });

    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(path.join(packageRoot, "dist", "server", "server", "config.js")),
      }),
    ).toBe(path.join(packageRoot, "dist", "server", "web-ui"));
  });

  test("resolves packaged desktop web UI path from resources app-dist", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-packaged-"));
    roots.push(packageRoot);
    await mkdir(path.join(packageRoot, "app-dist"), { recursive: true });

    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(
          path.join(
            packageRoot,
            "app.asar",
            "node_modules",
            "@getpaseo",
            "server",
            "dist",
            "server",
            "server",
            "config.js",
          ),
        ),
        resourcesPath: packageRoot,
      }),
    ).toBe(path.join(packageRoot, "app-dist"));
  });
});

test("loads private plugin registry settings through the configuration boundary", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-registry-config-"));
  try {
    const pluginRegistries = { "plugins.example.test": { authorization: "Bearer fixture" } };
    await writeFile(path.join(home, "config.json"), JSON.stringify({ pluginRegistries }));
    const config = loadConfig(home, {
      env: { PASEO_PLUGIN_REGISTRY: "https://plugins.example.test/internal" },
    });
    expect(config.pluginRegistryUrl).toBe("https://plugins.example.test/internal");
    expect(config.pluginRegistries).toEqual(pluginRegistries);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

describe("directory-derived providers", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createProfilesTree(roles: string[]): Promise<string> {
    const profilesDir = await mkdtemp(path.join(os.tmpdir(), "paseo-config-profiles-"));
    roots.push(profilesDir);
    for (const role of roles) {
      await mkdir(path.join(profilesDir, role, "agent-dir"), { recursive: true });
      await writeFile(
        path.join(profilesDir, role, "profile.json"),
        JSON.stringify({ profile: role, env: { PROBE_KEY: `=agentDir/${role}.probe` } }),
      );
    }
    return profilesDir;
  }

  async function createHome(config: Record<string, unknown>): Promise<string> {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-derived-"));
    roots.push(paseoHome);
    await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config));
    return paseoHome;
  }

  test("derives providers from the configured profiles directory", async () => {
    const profilesDir = await createProfilesTree(["worker", "tester"]);
    const paseoHome = await createHome({
      agents: { profileDerivation: { profilesDir } },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.profileDerivation).toEqual({ profilesDir, failures: [] });
    expect(config.providerOverrides).toEqual({
      "paseo-worker": {
        extends: "pi",
        label: "worker (paseo-profile)",
        env: {
          PI_CODING_AGENT_DIR: path.join(profilesDir, "worker", "agent-dir"),
          PROBE_KEY: path.join(profilesDir, "worker", "agent-dir", "worker.probe"),
        },
      },
      "paseo-tester": {
        extends: "pi",
        label: "tester (paseo-profile)",
        env: {
          PI_CODING_AGENT_DIR: path.join(profilesDir, "tester", "agent-dir"),
          PROBE_KEY: path.join(profilesDir, "tester", "agent-dir", "tester.probe"),
        },
      },
    });
    expect(Object.keys(config.agentProviderSettings ?? {}).sort()).toEqual([
      "paseo-tester",
      "paseo-worker",
    ]);
    // The derived declarations are never written back to the persisted config.
    expect((await loadPersistedConfig(paseoHome)).agents?.providers).toBeUndefined();
  });

  test("a hand-written provider overrides the derived one", async () => {
    const profilesDir = await createProfilesTree(["worker"]);
    const paseoHome = await createHome({
      agents: {
        profileDerivation: { profilesDir },
        providers: {
          "paseo-worker": {
            extends: "pi",
            label: "worker (paseo-profile)",
            env: { PI_CODING_AGENT_DIR: "/somewhere/else" },
          },
        },
      },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.providerOverrides?.["paseo-worker"]?.env).toEqual({
      PI_CODING_AGENT_DIR: "/somewhere/else",
    });
  });

  test("defaults to the standard profiles tree when the section is absent", async () => {
    const paseoHome = await createHome({});

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.profileDerivation?.profilesDir).toBe("/root/pi-profiles");
    expect(Object.keys(config.providerOverrides ?? {})).toContain("paseo-worker");
  });

  test("reports broken roles without failing the load", async () => {
    const profilesDir = await mkdtemp(path.join(os.tmpdir(), "paseo-config-profiles-broken-"));
    roots.push(profilesDir);
    await mkdir(path.join(profilesDir, "worker", "agent-dir"), { recursive: true });
    await writeFile(path.join(profilesDir, "worker", "profile.json"), "{ not json");
    const paseoHome = await createHome({ agents: { profileDerivation: { profilesDir } } });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.providerOverrides).toBeUndefined();
    expect(config.profileDerivation?.failures).toHaveLength(1);
    expect(config.profileDerivation?.failures[0]).toMatchObject({
      role: "worker",
      code: "bad_profile_json",
    });
  });
});
