import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Logger } from "pino";

import { MailboxService, type MailboxSubscriber } from "./mailbox-service.js";

const logger: Logger = {
  child: () => logger,
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function recordingSubscriber(): MailboxSubscriber & {
  batches: { agentId: string; items: { id: string; from: string; text: string }[] }[];
} {
  const batches: { agentId: string; items: { id: string; from: string; text: string }[] }[] = [];
  return {
    batches,
    emit: (message) => {
      batches.push({
        agentId: message.payload.agentId,
        items: message.payload.batch.map(({ id, from, text }) => ({ id, from, text })),
      });
    },
  };
}

function readJsonl(root: string, agentId: string): Record<string, unknown>[] {
  return readFileSync(join(root, `${agentId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("MailboxService", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-mailbox-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("无订阅者：只积压（存储 + queued:true，无水位线）", async () => {
    const service = new MailboxService(root, logger);
    const result = await service.push("agent-a", "webhook", "hello");
    expect(result.queued).toBe(true);

    const lines = readJsonl(root, "agent-a");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "mail", from: "webhook", text: "hello" });
    expect(lines[0].id).toBe(result.id);
    expect(typeof lines[0].ts).toBe("number");
  });

  test("订阅排空：积压一次性推送 + delivered 水位线 + 旋转截断", async () => {
    const service = new MailboxService(root, logger);
    await service.push("agent-a", "webhook", "第一封");
    await service.push("agent-a", "pbash", "第二封");

    const subscriber = recordingSubscriber();
    await service.subscribe("agent-a", subscriber);

    // 一批两条，顺序即写入顺序
    expect(subscriber.batches).toHaveLength(1);
    expect(subscriber.batches[0].agentId).toBe("agent-a");
    expect(subscriber.batches[0].items.map((item) => item.text)).toEqual(["第一封", "第二封"]);
    expect(subscriber.batches[0].items.every((item) => item.id && item.from)).toBe(true);

    // 旋转后文件只剩最后一条 delivered 行（水位线锚点保留）
    const lines = readJsonl(root, "agent-a");
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("delivered");
    expect(lines[0].batch).toBe(1);
    expect(lines[0].ids).toHaveLength(2);
  });

  test("实时投递：有订阅者的 push 立即推送并落水位线（queued:false）", async () => {
    const service = new MailboxService(root, logger);
    const subscriber = recordingSubscriber();
    await service.subscribe("agent-a", subscriber);

    const result = await service.push("agent-a", "webhook", "实时信");
    expect(result.queued).toBe(false);
    expect(subscriber.batches).toHaveLength(1);
    expect(subscriber.batches[0].items[0]).toMatchObject({
      from: "webhook",
      text: "实时信",
      id: result.id,
    });

    const lines = readJsonl(root, "agent-a");
    const delivered = lines.filter((line) => line.type === "delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].ids).toEqual([result.id]);
  });

  test("重放语义（at-least-once）：崩溃窗口未落水位线的信，重订后补投", async () => {
    const service = new MailboxService(root, logger);
    // 场景 1：正常一轮——订阅者在线时 push 即投即落水位线；新订阅者不应重复收
    const online = recordingSubscriber();
    await service.subscribe("agent-a", online);
    await service.push("agent-a", "webhook", "已投递的信");
    const late = recordingSubscriber();
    await service.subscribe("agent-a", late);
    expect(late.batches).toHaveLength(0); // 水位线已过：不重复推

    // 场景 2：崩溃窗口——push 推了但 delivered 行没落（进程死在推后落盘前），
    // 手写 jsonl 模拟“只有 mail 行无水位线”，重启后新订阅者重放该批
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      join(root, "agent-b.jsonl"),
      `${JSON.stringify({ type: "mail", id: "m1", from: "webhook", text: "孤儿信", ts: 1 })}\n`,
      "utf8",
    );
    const replay = recordingSubscriber();
    await service.subscribe("agent-b", replay);
    expect(replay.batches).toHaveLength(1);
    expect(replay.batches[0].items[0]).toMatchObject({ id: "m1", text: "孤儿信" });
    // 补投后水位线落地 + 旋转
    const lines = readJsonl(root, "agent-b");
    expect(lines.filter((line) => line.type === "delivered")).toHaveLength(1);
  });

  test("畸形行容错：坏行跳过，好信照常投递", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(root, "agent-c.jsonl"),
      ['{"type":"mail","id":"ok1","from":"a","text":"好信","ts":1}', "not-json-garbage", ""].join(
        "\n",
      ) + "\n",
      "utf8",
    );
    const service = new MailboxService(root, logger);
    const subscriber = recordingSubscriber();
    await service.subscribe("agent-c", subscriber);
    expect(subscriber.batches).toHaveLength(1);
    expect(subscriber.batches[0].items.map((item) => item.text)).toEqual(["好信"]);

    // 追加一封（验证坏行不破坏后续 append/重读）
    await service.push("agent-c", "x", "后续信");
    const subscriber2 = recordingSubscriber();
    await service.subscribe("agent-c", subscriber2);
    expect(subscriber2.batches).toHaveLength(0); // 上一轮已投递，无积压
  });

  test("多订阅者扇出：一封信推给所有订阅者，水位线只落一条", async () => {
    const service = new MailboxService(root, logger);
    const s1 = recordingSubscriber();
    const s2 = recordingSubscriber();
    await service.subscribe("agent-a", s1);
    await service.subscribe("agent-a", s2);

    await service.push("agent-a", "webhook", "广播信");
    expect(s1.batches.at(-1)?.items[0].text).toBe("广播信");
    expect(s2.batches.at(-1)?.items[0].text).toBe("广播信");

    const delivered = readJsonl(root, "agent-a").filter((line) => line.type === "delivered");
    // 空积压订阅不落水位线（没投递就没行）；广播信一封只落一条
    expect(delivered).toHaveLength(1);
    expect(delivered[0].ids).toHaveLength(1);
  });

  test("batch 计数单调递增", async () => {
    const service = new MailboxService(root, logger);
    const subscriber = recordingSubscriber();
    await service.subscribe("agent-a", subscriber);
    await service.push("agent-a", "w", "1");
    await service.push("agent-a", "w", "2");
    const delivered = readJsonl(root, "agent-a")
      .filter((line) => line.type === "delivered")
      .map((line) => line.batch as number);
    // 空积压订阅不落行；两次 push = 两条水位线 batch 1、2
    expect(delivered).toEqual([1, 2]);
  });

  test("unsubscribe：解绑后 push 积压，新订阅者可补投", async () => {
    const service = new MailboxService(root, logger);
    const s1 = recordingSubscriber();
    await service.subscribe("agent-a", s1);
    service.unsubscribe("agent-a", s1);

    const result = await service.push("agent-a", "w", "离线信");
    expect(result.queued).toBe(true);
    expect(s1.batches.every((batch) => !batch.items.some((item) => item.text === "离线信"))).toBe(
      true,
    );

    const s2 = recordingSubscriber();
    await service.subscribe("agent-a", s2);
    expect(s2.batches.at(-1)?.items.map((item) => item.text)).toContain("离线信");
  });

  test("并发 push 串行化：行序完整不交错", async () => {
    const service = new MailboxService(root, logger);
    const subscriber = recordingSubscriber();
    await service.subscribe("agent-a", subscriber);
    await Promise.all(Array.from({ length: 20 }, (_, i) => service.push("agent-a", "w", `信${i}`)));
    const lines = readJsonl(root, "agent-a");
    const mails = lines.filter((line) => line.type === "mail");
    const delivered = lines.filter((line) => line.type === "delivered");
    // 旋转发生在首轮订阅；此后 20 封 = 20 条 mail + 20 条 delivered
    expect(mails).toHaveLength(20);
    expect(delivered).toHaveLength(20);
  });
});
