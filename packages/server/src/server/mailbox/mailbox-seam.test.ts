/**
 * mailbox-seam.test.ts —— P7-M3 看门狗投递岔口（[pbash/mailbox-seam]）单测。
 *
 * 0.13 起的落点：上游把完成通知从 `agent-prompt.setupFinishNotification` 整块
 * 迁到 `agent/finish-subscriptions`（deliver 出口 = `messages().enqueue`）。本缝
 * 随之迁到同一个投递出口，语义不变：
 * 1. 曾订阅（daemon 内存旗语亮）→ 通知写信箱，`AgentMessageDelivery` 原路不被触碰
 * 2. 从未订阅 → 原路 enqueue（信箱零落盘）
 * 3. 生产未挂载（deps.mailbox 缺省）→ 原路 enqueue
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentMessageDelivery } from "../agent/agent-messages/index.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
import {
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  type FinishMailboxSeam,
  type FinishObservation,
  type FinishSubscriptions,
} from "../agent/finish-subscriptions/index.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { MailboxService, type MailboxSubscriber } from "./mailbox-service.js";

/** 收信哑订阅者（排空积压用）。 */
const sink: MailboxSubscriber = { emit: () => undefined };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

class Observation implements FinishObservation {
  wait!: ReturnType<typeof deferred<WaitForFinishResult>>;
  async open() {
    return {
      next: () => {
        this.wait = deferred<WaitForFinishResult>();
        return this.wait.promise;
      },
      close: async () => undefined,
    };
  }
}

class Delivery implements AgentMessageDelivery {
  prompts: string[] = [];
  enqueue(message: Parameters<AgentMessageDelivery["enqueue"]>[0]) {
    this.prompts.push(String(message.prompt));
    return {
      status: "queued" as const,
      messageId: "notification",
      dispatched: Promise.resolve("steered" as const),
    };
  }
  async close() {}
  async waitForDispatch() {}
}

function outcome(): WaitForFinishResult {
  return {
    status: "idle",
    final: buildStoredAgentPayload(
      {
        id: "child-1",
        provider: "codex",
        cwd: "/tmp",
        title: "Child",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: { "paseo.parent-agent-id": "parent-1" },
        lastStatus: "closed",
      },
      ["codex"],
    ),
    lastMessage: "task output",
    error: null,
  };
}

function mailLines(root: string, agentId: string): string {
  try {
    return readFileSync(join(root, `${agentId}.jsonl`), "utf8");
  } catch {
    return "";
  }
}

describe("mailbox seam（[pbash/mailbox-seam] P7-M3 → 0.13 finish-subscriptions）", () => {
  let root: string;
  const services: FinishSubscriptions[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-seam-"));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function scenario(mailbox: () => FinishMailboxSeam | undefined) {
    const observation = new Observation();
    const delivery = new Delivery();
    const service = createFinishSubscriptions({
      store: createJsonFinishSubscriptionStore(join(root, "store")),
      serverId: "origin",
      logger: createTestLogger(),
      messages: () => delivery,
      mailbox,
      open: observation.open.bind(observation),
      callerIsActive: async () => true,
      retryDelayMs: 1,
    });
    services.push(service);
    await service.start();
    await service.register({ callerAgentId: "parent-1", childAgentId: "child-1" });
    await expect.poll(() => Boolean(observation.wait)).toBe(true);
    observation.wait.resolve(outcome());
    return { delivery };
  }

  test("曾订阅 → 通知写信箱（from:paseo-system），原路 enqueue 不被触碰", async () => {
    const mailbox = new MailboxService(root, createTestLogger());
    // 点亮旗语：父 agent 曾订阅（pi 扩展在场）
    await mailbox.subscribe("parent-1", sink);

    const { delivery } = await scenario(() => mailbox);

    await expect.poll(() => mailLines(root, "parent-1")).toContain('"from":"paseo-system"');
    const lines = mailLines(root, "parent-1");
    expect(lines).toContain("was closed");
    expect(delivery.prompts).toHaveLength(0); // 原路未触发
  });

  test("从未订阅 → 原路 enqueue，信箱零落盘", async () => {
    const mailbox = new MailboxService(root, createTestLogger());

    const { delivery } = await scenario(() => mailbox);

    await expect.poll(() => delivery.prompts.length).toBe(1);
    expect(delivery.prompts[0]).toContain("was closed");
    expect(mailLines(root, "parent-1")).toBe(""); // 信箱未写一字
  });

  test("deps.mailbox 缺省（生产未挂载）→ 原路 enqueue", async () => {
    const { delivery } = await scenario(() => undefined);

    await expect.poll(() => delivery.prompts.length).toBe(1);
    expect(mailLines(root, "parent-1")).toBe("");
  });
});
