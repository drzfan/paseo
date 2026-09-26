import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

import type { MailboxMailMessage } from "@getpaseo/protocol/messages";

/** 信件（内存/线上形态；jsonl 里多一层 type:"mail"）。 */
export interface MailboxMailRecord {
  id: string;
  from: string;
  text: string;
  ts: number;
}

/** 订阅者：住户扩展经 session 的 OwnedSubscription 适配进来。 */
export interface MailboxSubscriber {
  emit(message: MailboxMailMessage): void;
}

interface MailboxLine {
  type: "mail" | "delivered";
}

interface MailLine extends MailboxLine {
  type: "mail";
  id: string;
  from: string;
  text: string;
  ts: number;
}

interface DeliveredLine extends MailboxLine {
  type: "delivered";
  batch: number;
  ids: string[];
  ts: number;
}

interface AgentMailboxState {
  /** 串行化该 agent 的一切文件操作与投递（push/subscribe-drain/rotate 互斥）。 */
  queue: Promise<unknown>;
  subscribers: Set<MailboxSubscriber>;
}

/**
 * MailboxService —— 机器消息信箱（P7-M1，spec：plan/mailbox-spec.md §三-M1）。
 *
 * daemon 内单实例（paseoHome 相对目录 `<PASEO_HOME>/mailboxes/<agentId>.jsonl`），
 * daemon 是唯一写者。行型：
 * - `{"type":"mail","id","from","text","ts"}` 信件
 * - `{"type":"delivered","batch","ids","ts"}` 投递水位线
 *
 * 投递语义 **at-least-once**：先把 batch 推送给订阅者、成功后落 delivered 行。
 * 崩溃窗口（推送后、水位线落盘前）→ daemon 重启后订阅重放该批 = 重复投递，
 * 通知可重不可丢，重复无害（住户侧按需幂等）。反向窗口（落了水位线但推送
 * 实际没到对端，如半死 socket）不在本层保证范围——与 timeline 推送同级，
 * WS 断连即解绑订阅、住户重连重订（扩展侧自动补发订阅）。
 *
 * 旋转（rotate）：订阅排空积压后截断水位线之前的内容（保留最后一条 delivered
 * 行本身——既是 debug 痕迹也是重放锚点）。单消费者前提下水位线之前的内容
 * 永不再读。不做的：定时器旋转（未订阅的箱自然不积压大量 delivered 前缀）。
 *
 * 生命周期决策：agent 归档/删除时信箱**留存**。理由：archive ≠ delete（可恢复），
 * jsonl 极小且 rotate 有界；挂进各删除路径会放大补丁面，M1 不做清理钩子。
 */
export class MailboxService {
  private readonly rootDir: string;
  private readonly logger: Logger;
  private readonly agents = new Map<string, AgentMailboxState>();
  /**
   * P7-M2/M3 自门控旗语：本 daemon 生命周期内曾订阅过信箱的 agent。
   * 语义 = 扩展在场且旗标开（扩展订阅即写入）→ 写信箱；从未订阅（非 pi /
   * 旗标关 / 本轮 daemon 尚未拉起）→ 写入方回退原 send 通道（provider 中立
   * 白条保底）。刻意不持久化：旗标关回滚后旧标记会永远指向无人读的信箱
   * （信件丢失比白条更糟）；daemon 重启后的短暂窗口回退白条 = 与今日行为
   * 一致的可接受降级（spec v1.2 §三-M3 自门控）。
   */
  private readonly everSubscribed = new Set<string>();
  private rootReady: Promise<void> | null = null;

  constructor(rootDir: string, logger: Logger) {
    this.rootDir = rootDir;
    this.logger = logger.child({ module: "mailbox" });
  }

  /**
   * 写一封信。无订阅者 → 只积压（返回 queued:true）；有 → 立即推送整批
   * （本调用即一批）+ 落水位线（queued:false）。
   */
  push(agentId: string, from: string, text: string): Promise<{ id: string; queued: boolean }> {
    const record: MailboxMailRecord = { id: randomUUID(), from, text, ts: Date.now() };
    const result = this.enqueue(agentId, async () => {
      await this.appendLine(agentId, { type: "mail", ...record });
      const subscribers = [...this.state(agentId).subscribers];
      if (subscribers.length === 0) return { id: record.id, queued: true };
      await this.deliver(agentId, subscribers, [record]);
      return { id: record.id, queued: false };
    });
    return result;
  }

  /**
   * 订阅：先登记（防登记与读积压之间漏信），再在串行段内排空水位线之后的
   * 积压（推送 + 落水位线 + 旋转），此后 push 即实时推。
   */
  subscribe(agentId: string, subscriber: MailboxSubscriber): Promise<void> {
    this.everSubscribed.add(agentId);
    this.state(agentId).subscribers.add(subscriber);
    return this.enqueue(agentId, async () => {
      const pending = await this.pendingAfterWatermark(agentId);
      if (pending.length === 0) return;
      const subscribers = [...this.state(agentId).subscribers];
      if (subscribers.length === 0) return; // 登记后立刻被解绑的竞态
      await this.deliver(agentId, subscribers, pending);
      await this.rotate(agentId);
    });
  }

  unsubscribe(agentId: string, subscriber: MailboxSubscriber): void {
    const state = this.agents.get(agentId);
    if (state) state.subscribers.delete(subscriber);
  }

  /** P7-M2/M3 自门控旗语查询（daemon 内存态；语义见字段注释）。 */
  hasEverSubscribed(agentId: string): boolean {
    return this.everSubscribed.has(agentId);
  }

  // ---------- 内部 ----------

  private state(agentId: string): AgentMailboxState {
    let state = this.agents.get(agentId);
    if (!state) {
      state = { queue: Promise.resolve(), subscribers: new Set() };
      this.agents.set(agentId, state);
    }
    return state;
  }

  private enqueue<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(agentId);
    const result = state.queue.catch(() => undefined).then(operation);
    state.queue = result;
    return result;
  }

  /** 推送一批 + 落水位线（顺序即语义：先推后落 = at-least-once）。 */
  private async deliver(
    agentId: string,
    subscribers: readonly MailboxSubscriber[],
    records: readonly MailboxMailRecord[],
  ): Promise<void> {
    const message: MailboxMailMessage = {
      type: "mailbox.mail",
      payload: {
        agentId,
        batch: records.map(({ id, from, text, ts }) => ({ id, from, text, ts })),
      },
    };
    for (const subscriber of subscribers) {
      try {
        subscriber.emit(message);
      } catch (error) {
        // 单个订阅者故障不阻断他人投递与水位线（emit 失败的订阅者随断连解绑）
        this.logger.warn({ err: error, agentId }, "mailbox subscriber emit failed");
      }
    }
    const lines = await this.readLines(agentId);
    const batch = lastDeliveredBatch(lines) + 1;
    await this.appendLine(agentId, {
      type: "delivered",
      batch,
      ids: records.map((record) => record.id),
      ts: Date.now(),
    });
  }

  private ensureRoot(): Promise<void> {
    this.rootReady ??= mkdir(this.rootDir, { recursive: true }).then(() => undefined);
    return this.rootReady;
  }

  private async appendLine(agentId: string, line: MailLine | DeliveredLine): Promise<void> {
    await this.ensureRoot();
    await appendFile(this.file(agentId), `${JSON.stringify(line)}\n`, "utf8");
  }

  private file(agentId: string): string {
    return path.join(this.rootDir, `${agentId}.jsonl`);
  }

  private async readLines(agentId: string): Promise<(MailLine | DeliveredLine)[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(agentId), "utf8");
    } catch {
      return []; // 无文件 = 空信箱
    }
    const lines: (MailLine | DeliveredLine)[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as MailLine | DeliveredLine;
        if (parsed.type === "mail" || parsed.type === "delivered") lines.push(parsed);
      } catch {
        this.logger.warn({ agentId }, "mailbox jsonl has malformed line (skipped)");
      }
    }
    return lines;
  }

  /** 水位线（最后一条 delivered）之后的所有信件。 */
  private async pendingAfterWatermark(agentId: string): Promise<MailboxMailRecord[]> {
    const lines = await this.readLines(agentId);
    const lastDelivered = lines.findLastIndex((line) => line.type === "delivered");
    return lines
      .slice(lastDelivered + 1)
      .filter((line): line is MailLine => line.type === "mail")
      .map(({ id, from, text, ts }) => ({ id, from, text, ts }));
  }

  /** 截断水位线之前的内容（保留最后一条 delivered 行及之后）。 */
  private async rotate(agentId: string): Promise<void> {
    const file = this.file(agentId);
    const lines = await this.readLines(agentId);
    const lastDelivered = lines.findLastIndex((line) => line.type === "delivered");
    if (lastDelivered < 0) return; // 从未投递过：无处截断
    const kept = lines.slice(lastDelivered);
    const temp = `${file}.tmp-${randomUUID()}`;
    await this.ensureRoot();
    await writeFile(temp, kept.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    await rename(temp, file);
  }
}

function lastDeliveredBatch(lines: readonly (MailLine | DeliveredLine)[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === "delivered" && typeof line.batch === "number") return line.batch;
  }
  return 0;
}
