/**
 * notification.test.ts —— 终态回执 housekeeping 脚注的格式契约（本地补丁 4375ae3de）。
 *
 * 0.13 起 `formatFinishNotificationBody` 随完成通知子系统迁到
 * `finish-subscriptions/internal/notification.ts`，原先挂在
 * `agent-prompt.test.ts` 里的断言（依赖已删的 setupFinishNotification fixtures）
 * 降级为本文件：只锁"文本形态"契约，不依赖通知投递路径。
 */

import { expect, test } from "vitest";

import { formatFinishNotificationBody } from "./notification.js";

/** 与源码 formatFinishHousekeepingHint 同构的期望值（锁契约用，独立书写）。 */
function housekeeping(agentId: string): string {
  return [
    "<housekeeping>",
    "This child's agent process stays resident until archived. If it has no further work for you, reclaim it:",
    `paseo_archive_agent(agentId="${agentId}")`,
    "(history stays on disk — recoverable via paseo_list_agents with includeArchived; follow-up prompts to an archived agent are not delivered)",
    "To review what it did recently:",
    `paseo_get_agent_activity(agentId="${agentId}", limit=10)`,
    "</housekeeping>",
  ].join("\n");
}

test("finished 回执结尾带 housekeeping 脚注（ID 嵌入）", () => {
  const body = formatFinishNotificationBody({
    childAgentId: "child-agent",
    title: "Child Agent",
    reason: "finished",
    lastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });
  expect(body).toBe(
    "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>\n\n" +
      housekeeping("child-agent"),
  );
});

test("closed 回执结尾带 housekeeping 脚注", () => {
  const body = formatFinishNotificationBody({
    childAgentId: "child-agent",
    title: "Child Agent",
    reason: "was closed",
    lastAssistantMessage: null,
  });
  expect(body).toBe(
    "Agent child-agent (Child Agent) was closed.\n\n" + housekeeping("child-agent"),
  );
});

test("needs permission 不是终态，不带脚注", () => {
  const body = formatFinishNotificationBody({
    childAgentId: "child-agent",
    title: "Child Agent",
    reason: "needs permission",
    lastAssistantMessage: null,
    permissionRequest: {
      id: "req-1",
      provider: "codex",
      sessionId: "session-1",
      kind: "command",
      title: "Run tests",
      detail: {},
      createdAt: "2026-01-01T00:00:00Z",
    } as never,
  });
  expect(body).not.toContain("<housekeeping>");
});

test("host unreachable / removed 走独立正文，不带脚注（子代理不在本机）", () => {
  for (const reason of ["host unreachable", "host removed"] as const) {
    const body = formatFinishNotificationBody({
      childAgentId: "child-agent",
      serverId: "remote",
      title: "Child Agent",
      reason,
      lastAssistantMessage: null,
    });
    expect(body).not.toContain("<housekeeping>");
    expect(body).toContain("Server: remote");
  }
});
