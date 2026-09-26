/**
 * mailbox-seam.test.ts —— P7-M3 看门狗投递岔口（[pbash/mailbox-seam]）单测。
 *
 * 两例（施工单 M3-2）：
 * 1. 曾订阅（daemon 内存旗语亮）→ 通知写信箱，原 sendPromptToAgent 不被触碰
 * 2. 从未订阅 → 原路注入（sendPromptToAgent 深处触碰 agentManager 的 prompt
 *    启动面 → 以 marker 错误为证，被 notifySafely 捕获记日志）
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import type { Logger } from "pino";

import { setupFinishNotification } from "../agent/agent-prompt.js";
import { MailboxService, type MailboxSubscriber } from "./mailbox-service.js";

/** 收信哑订阅者（排空积压用）。 */
const sink: MailboxSubscriber = { emit: () => undefined };

function testLogger(errors: string[]): Logger {
  const logger = {
    child: () => logger,
    // notifySafely 的失败信封是 {err, childAgentId, ...}，消息藏在 err.message
    error: (entry: { err?: { message?: string } }) =>
      errors.push(String(entry?.err?.message ?? "")),
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };
  return logger as unknown as Logger;
}

/**
 * 假 agentManager：已知安全面（subscribe/getLastAssistantMessage + 挂 mailbox）
 * 显式实现；其余任何**方法调用**（sendPromptToAgent 深处的启动面）抛 marker——
 * 证明"原路注入"被走到。属性读取不抛（只在实际调用时炸）。
 */
function makeAgentManager(mailbox?: MailboxService) {
  let listener: ((event: Record<string, unknown>) => void) | null = null;
  const base: Record<string, unknown> = {
    subscribe: (fn: (event: Record<string, unknown>) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    getLastAssistantMessage: async () => "task output",
    // setupFinishNotification 的事件面自己会查 child 快照（非投递路径）
    getAgent: () => ({ lifecycle: "idle", pendingPermissions: new Set<string>() }),
    ...(mailbox !== undefined ? { mailbox } : {}),
  };
  const manager = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // mailbox 与生产对齐：未挂载就是 undefined（seam 判 falsy 走原路），
      // 不能用 marker 代替——否则缝本身会被 marker 炸掉
      if (typeof prop === "symbol" || prop === "mailbox") return undefined;
      const name = String(prop);
      return () => {
        throw new Error(`LEGACY_PATH_HIT:${name}`);
      };
    },
  });
  return {
    manager,
    emitState(lifecycle: string) {
      listener?.({
        type: "agent_state",
        agent: { lifecycle, pendingPermissions: new Set<string>() },
      });
    },
  };
}

const fakeStorage = {
  get: async () => null,
} as Parameters<typeof setupFinishNotification>[0]["agentStorage"];

function mailLines(root: string, agentId: string): string {
  try {
    return readFileSync(join(root, `${agentId}.jsonl`), "utf8");
  } catch {
    return "";
  }
}

describe("mailbox seam（[pbash/mailbox-seam] P7-M3）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-seam-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("曾订阅 → 通知写信箱（from:paseo-system），原路不被触碰", async () => {
    const errors: string[] = [];
    const mailbox = new MailboxService(root, testLogger([]));
    // 点亮旗语：父 agent 曾订阅（扩展在场）
    await mailbox.subscribe("parent-1", sink);
    // 清掉订阅排空的 delivered 行，让后续断言只看新信
    const { manager, emitState } = makeAgentManager(mailbox);

    setupFinishNotification({
      agentManager: manager as never,
      agentStorage: fakeStorage,
      childAgentId: "child-1",
      callerAgentId: "parent-1",
      logger: testLogger(errors),
    });

    emitState("running");
    emitState("idle");

    await vi.waitFor(() => {
      expect(mailLines(root, "parent-1")).toContain('"from":"paseo-system"');
    });
    expect(errors).toEqual([]); // 原路未触发（无 marker 错误）
  });

  test("从未订阅 → 原路注入（触碰 prompt 启动面，marker 为证），信箱零落盘", async () => {
    const errors: string[] = [];
    const { manager, emitState } = makeAgentManager(); // 不挂 mailbox

    setupFinishNotification({
      agentManager: manager as never,
      agentStorage: fakeStorage,
      childAgentId: "child-2",
      callerAgentId: "parent-2",
      logger: testLogger(errors),
    });

    emitState("running");
    emitState("idle");

    const legacyHit = () => errors.some((line) => line.includes("LEGACY_PATH_HIT"));
    await vi.waitFor(() => {
      expect(legacyHit()).toBe(true);
    });
    expect(mailLines(root, "parent-2")).toBe(""); // 信箱未写一字
  });
});
