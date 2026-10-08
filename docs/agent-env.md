# Agent process environment

How environment variables reach spawned agent processes, and what the daemon does — and does
not — filter. This documents a behavior that used to be folklore: operators assumed
`agent.create`'s `env` field was key-filtered by a daemon-side whitelist. It is not. The
daemon applies a small scrub **blacklist** at the spawn boundary and passes everything
else through.

## The create `env` field

`agent.create.request` (protocol: `CreateAgentRequestMessageSchema`) and the agent-scoped
`create_agent` MCP tool both accept `env: Record<string, string>` — arbitrary keys. The
schema does not enumerate keys, and the daemon does not filter them by name.

What the field is **not**: an inheritance surface. The create `env` does not inherit the
daemon's process environment or the caller's environment. Whatever keys are in the request
body (plus the daemon-injected identity keys below) are the entire overlay on top of the
daemon process environment. A client that expects a variable it set in its own process
environment to reach the agent will not see it arrive unless it puts it in `env`.

## The chain

For the pi provider (the same shape applies to other providers that spawn a child
process):

1. `session.ts` — `handleCreateAgentRequest` → `createSessionAgent` → `createAgentCommand({ ..., env })`.
   The Hub execution path (`hub/execution-controller.ts` → `hub/daemon-executions.ts`)
   forwards `env` the same way.
2. `create-agent/create.ts` — `env` lands in `createOptions`.
3. `agent-manager.ts` — `createAgentInternal` → `buildLaunchContext()`. A plugin
   lifecycle hook (`agent.session_open`) can rewrite `env` first. Here the daemon
   **injects its identity keys** into the overlay:
   - `PASEO_AGENT_ID` — always.
   - `PASEO_AGENT_CWD` — always.
   - `PASEO_WORKSPACE_ID` — only when the workspace is known (P8-T7; the contract is
     "present iff workspace known", never an empty string).
4. `providers/pi/agent.ts` — `createSession()` forwards `launchContext.env` to
   `runtime.startSession()`.
5. `providers/pi/runtime.ts` — `buildPiLaunch()` merges provider `runtimeSettings.env`
   (per-provider configuration) under the per-session env.
6. `providers/jsonl-rpc-process.ts` — passes the merged env as `envOverlay` to
   `spawnProcess()`.
7. `utils/spawn.ts` → `server/paseo-env.ts` — the final child environment is
   `{ ...daemonProcessEnv, ...envOverlay }` with the scrub list applied (below).

## The only key-level filtering: the spawn scrub list

The one place the daemon deletes keys by name is the external-process boundary in
`server/paseo-env.ts` (`buildExternalProcessEnv`), applied to every externally spawned
process including agent processes and terminals:

- **Removed outright** (`RUNTIME_CONTROL_ENV_KEYS`): `PASEO_NODE_ENV`,
  `PASEO_DESKTOP_MANAGED`, `PASEO_SUPERVISED`, `ELECTRON_RUN_AS_NODE`,
  `ELECTRON_NO_ATTACH_CONSOLE`, `ESBUILD_BINARY_PATH`.
  These are daemon-runtime control variables. If they leaked into a child, a nested daemon
  or Electron-node shim launched by a child (or by an agent's tooling) could inherit the
  parent's runtime mode and sabotage the launch — e.g. a spawned daemon thinking it is
  Electron-managed, or a build tool pinned to the wrong esbuild binary.
- **Keys with `undefined` values are dropped** so a caller can explicitly delete an
  inherited key by overlaying `undefined`.

A second, provider-scoped scrub lives in `agent/provider-launch-config.ts`
(`createProviderEnvSpec`): `PARENT_SESSION_ENV_VARS` — `CLAUDECODE`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_AGENT_SDK_VERSION` — are set to
`undefined` for provider children. Without this, a daemon started from inside a Claude Code
session leaks that session's markers into child agents, which then refuse to launch
("cannot be launched inside another session").

## Security considerations

- The scrub lists are a **deny-list, not an allow-list**: if a key is not on them, it
  reaches the child. Treat everything you put in a create `env` as visible to the agent
  process and its children. Never put secrets in ad-hoc create env; use per-provider
  `runtimeSettings.env` (provider configuration) or the provider's own credential files.
- The scrub lists exist because those specific keys can hijack process launch semantics
  (runtime mode, Electron node shim, toolchain selection). Adding a key to either list is
  a security-relevant change and needs a test in
  `packages/server/src/server/paseo-env.test.ts` and
  `packages/server/src/server/agent/provider-launch-config` coverage.
- Agent env is per-session overlay state, not durable config. It is captured at create
  time; changing the daemon environment later does not retroactively change a running or
  a persisted agent's environment.

## `PI_CODING_AGENT_DIR` and other keys with daemon-side meaning

Most env keys are opaque pass-through. A few are read by the daemon itself before or
while spawning:

| Key                           | Consumer                                      | Effect                                                                                                              |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PI_CODING_AGENT_DIR`         | `providers/pi/agent.ts` `resolvePiAgentDir()` | Points the pi provider's agent dir (auth files, global MCP config, session discovery). Falls back to `~/.pi/agent`. |
| `PI_CODING_AGENT_SESSION_DIR` | `providers/pi/session-descriptor.ts`          | Session listing directory for import.                                                                               |

These are not a whitelist — they are keys the daemon reads in addition to forwarding
them. Any other key (e.g. `PASEO_REPORT_TO`, `GROUNDING_*`) is forwarded verbatim to the
child process; in-repo tests pin this: `pi/agent.test.ts` "forwards launch-context env to
the Pi process launch" (an arbitrary `CHUNK14_PROBE` key arrives in the recorded launch
env unchanged).

## Why operators saw "only `PI_CODING_AGENT_DIR` arrives"

A 2026-10-07 live investigation (ticketing 19-C4) observed that probes created on the
test daemon only ever saw `PI_CODING_AGENT_DIR` in the child process environment, and
concluded a daemon-side whitelist. Reading the full chain shows no such whitelist; the
in-repo test above demonstrates arbitrary keys passing through. The observed effect comes
from the **caller side**, not the daemon:

- The production create path used by the pbash extension
  (`agent-stack/extensions/pbash/agent-tools.ts`, `buildProfileEnv()`) constructs its env
  as a small closure: `PI_CODING_AGENT_DIR` always, plus `PASEO_NATIVE_INCLUDE` and a
  `PATH` append for the worker role, plus `PASEO_REPORT_TO` for parallel creates. The tool
  does not accept arbitrary caller env.
- `pdsh create` sends no `env` at all.
- Because the create `env` is explicit-only (no inheritance — see above), a probe that
  sets a variable in the CLI process environment and expects it to reach the agent sees
  nothing unless it puts the key in the request body.

Lesson for probes: if a key must reach the child, put it in the create request `env`
explicitly and verify with `printenv` inside the session; do not assume inheritance or
assume daemon-side filtering.

## Agent env vs. terminal env

Terminals are a separate env surface and do **not** inherit an agent's create env. A
terminal launched by the terminal tool gets `{ ...daemonProcessEnv, ...terminalEnv }`
(`terminal/terminal.ts`, `buildTerminalEnvironment`), where `terminalEnv` is what the
terminal registration carries. An agent that needs a variable visible in its terminals
must either re-set it per terminal or rely on the daemon-wide environment. (This is why
the worker profile appends `/root/.local/bin` to `PATH` in its own create env rather than
expecting it to flow to terminals.)

## How to change the contract

- **Pass a new key to agents:** just include it in the create request `env` (or provider
  `runtimeSettings.env` for per-provider values). No daemon change needed.
- **Strip a new key daemon-wide:** add it to `RUNTIME_CONTROL_ENV_KEYS` in
  `server/paseo-env.ts` with a comment stating the launch-hijack it prevents, and add a
  case to `paseo-env.test.ts`. For provider-scoped strips, use `PARENT_SESSION_ENV_VARS`
  in `agent/provider-launch-config.ts`.
- **Inject identity keys:** extend `buildLaunchContext()` in `agent-manager.ts`; follow the
  "present iff known" convention (never inject empty strings).
