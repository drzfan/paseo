import { setTimeout as pause } from "node:timers/promises";
import { HostObservationError } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./internal/notification.js";
export { createJsonFinishSubscriptionStore } from "./internal/json-store.js";

export interface FinishSubscription {
  id: string;
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
  /** Creation subscriptions stop reporting after the child is detached. */
  requireParentOwnership?: boolean;
}
export interface FinishSubscriptionStore {
  list(): Promise<FinishSubscription[]>;
  put(subscription: FinishSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface FinishObservationSession {
  next(): Promise<FinishObservationResult>;
  close(): Promise<void>;
}
export interface FinishObservation {
  open(subscription: FinishSubscription, signal: AbortSignal): Promise<FinishObservationSession>;
}
/**
 * [pbash/mailbox-seam] P7-M3 投递岔口的结构类型（内联，不引入 mailbox 模块依赖）：
 * 订阅者曾订阅过信箱 = pi 扩展在场且旗标开 → 完成通知写信箱（住户自投、零时间线痕迹）。
 */
export interface FinishMailboxSeam {
  hasEverSubscribed(agentId: string): boolean;
  push(agentId: string, from: string, text: string): Promise<unknown>;
}
interface Dependencies extends FinishObservation {
  store: FinishSubscriptionStore;
  messages(): AgentMessageDelivery;
  /**
   * [pbash/mailbox-seam] 信箱实例取用点（生产实现在共享 agentManager 上，结构类型挂载）。
   * 缺省/返回 undefined = 原路投递，零行为变化（非 pi / 旗标关 / 未挂载）。
   */
  mailbox?: () => FinishMailboxSeam | undefined;
  callerIsActive(agentId: string): Promise<boolean>;
  serverId: string;
  logger: Logger;
  retryDelayMs?: number;
}
export interface FinishRegistration {
  /** The prompt was accepted. Replaces preceding registrations for this pair. */
  accept(): void;
  /** Rejected dispatch preserves preceding registrations. */
  reject(): Promise<void>;
}
export interface FinishSubscriptions {
  start(): Promise<void>;
  register(
    input: Omit<FinishSubscription, "id">,
    pendingDispatch?: boolean,
  ): Promise<FinishRegistration>;
  close(): Promise<void>;
}
interface Watch {
  records: FinishSubscription[];
  controller: AbortController;
  decision: Promise<boolean>;
  decide(accepted: boolean): void;
  pending: boolean;
  task?: Promise<void>;
}
function key(record: FinishSubscription): string {
  return JSON.stringify([record.callerAgentId, record.childAgentId, record.serverId]);
}

/** Owns durable intent, live observation, supersession, and dispatch acknowledgment. */
export function createFinishSubscriptions(deps: Dependencies): FinishSubscriptions {
  const tasks = new Set<Promise<void>>();
  const watches = new Map<string, Set<Watch>>();
  let closed = false;
  let mutations = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = mutations.then(action);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function attach(records: FinishSubscription[], pending: boolean): Watch {
    let decide!: Watch["decide"];
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const watch: Watch = { records, controller: new AbortController(), pending, decision, decide };
    const group = watches.get(key(records[0]!)) ?? new Set<Watch>();
    group.add(watch);
    watches.set(key(records[0]!), group);
    if (!pending) decide(true);
    watch.task = run(watch, group).catch((error) =>
      deps.logger.error({ err: error }, "Finish subscription failed"),
    );
    tasks.add(watch.task);
    void watch.task.then(() => tasks.delete(watch.task!));
    return watch;
  }
  function stop(watch: Watch, group: Set<Watch>): void {
    watch.controller.abort();
    watch.decide(false);
    group.delete(watch);
    if (!group.size && watches.get(key(watch.records[0]!)) === group)
      watches.delete(key(watch.records[0]!));
  }
  async function remove(watch: Watch): Promise<void> {
    // Only IDs captured by this observer are eligible; newer registrations survive.
    for (const record of watch.records) await deps.store.remove(record.id);
  }
  async function delay(signal: AbortSignal, attempt: number): Promise<void> {
    try {
      await pause(
        Math.min((deps.retryDelayMs ?? 1000) * 2 ** Math.min(attempt, 3), 5000),
        undefined,
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, cancellation]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function decisions(group: Set<Watch>): Promise<void> {
    // New candidates may arrive while an older dispatch decision is pending.
    while (true) {
      if (closed) return;
      const pending = [...group].filter((watch) => watch.pending);
      if (!pending.length) return;
      await Promise.all(pending.map((watch) => watch.decision));
    }
  }
  async function suppressed(
    record: FinishSubscription,
    result?: WaitForFinishResult,
  ): Promise<boolean> {
    if (!(await deps.callerIsActive(record.callerAgentId))) return true;
    if (!record.requireParentOwnership || !result?.final) return false;
    const parent = getParentAddressFromLabels(
      result.final.labels,
      record.serverId ?? deps.serverId,
    );
    return parent?.agentId !== record.callerAgentId || parent.serverId !== deps.serverId;
  }
  function reasonFor(result: FinishObservationResult): FinishNotificationReason {
    if (result.reason === "host unreachable" || result.reason === "host removed")
      return result.reason;
    if (!result.final) return "is unavailable";
    if (result.final.status === "closed") return "was closed";
    if (result.status === "error") return "errored";
    if (result.status === "permission") return "needs permission";
    return result.reason ?? "finished";
  }
  async function deliver(
    record: FinishSubscription,
    result: FinishObservationResult,
    permissions: Set<string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const requests = result.final?.pendingPermissions ?? [];
    const reason = reasonFor(result);
    for (const id of permissions)
      if (!requests.some((request) => request.id === id)) permissions.delete(id);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return false;
      if (request && permissions.has(request.id)) continue;
      const title = result.final?.title ?? record.childAgentId;
      const body = formatFinishNotificationBody({
        childAgentId: record.childAgentId,
        serverId: record.serverId ?? deps.serverId,
        title,
        reason,
        lastAssistantMessage: result.lastMessage,
        permissionRequest: request,
      });
      // [pbash/mailbox-seam] P7-M3 看门狗投递岔口（0.13 版落点）：上游把完成通知
      // 从 agent-prompt.setupFinishNotification 迁到 finish-subscriptions，本缝随
      // 之迁到同一个“投递出口”。曾订阅信箱 → 写信箱（from:paseo-system，零时间线
      // 痕迹）；否则走上游 enqueue 原路（白条保底，零行为变化）。
      const seamMailbox = deps.mailbox?.();
      if (seamMailbox?.hasEverSubscribed(record.callerAgentId)) {
        await abortable(
          seamMailbox.push(record.callerAgentId, "paseo-system", body),
          signal,
        );
        if (request) permissions.add(request.id);
        continue;
      }
      const receipt = deps.messages().enqueue({
        recipientId: record.callerAgentId,
        prompt: body,
        source: {
          kind: "agent-notification",
          agentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          event: finishNotificationEvents[reason],
        },
        activeTurnBehavior: "steer",
        unarchive: false,
      });
      acknowledgments.push(
        receipt.dispatched.then(() => {
          if (request) permissions.add(request.id);
          return undefined;
        }),
      );
    }
    await abortable(Promise.all(acknowledgments), signal);
    if (signal.aborted) return false;
    if (reason !== "needs permission") return true;
    return false;
  }
  async function run(watch: Watch, group: Set<Watch>): Promise<void> {
    const signal = watch.controller.signal;
    if (!(await watch.decision) || signal.aborted) return;
    const record = {
      ...watch.records[0]!,
      requireParentOwnership: watch.records.every(
        (intent) => intent.requireParentOwnership === true,
      ),
    };
    const permissions = new Set<string>();
    let observation: FinishObservationSession | undefined;
    let pending: FinishObservationResult | undefined;
    let acknowledged = false;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    async function observeNext(): Promise<FinishObservationResult | undefined> {
      try {
        observation ??= await deps.open(record, signal);
        const result = await abortable(observation.next(), signal);
        remoteFailures = 0;
        return result;
      } catch (error) {
        await observation?.close();
        observation = undefined;
        signal.throwIfAborted();
        if (!(error instanceof HostObservationError) || !record.serverId) throw error;
        if (error.reason === "connecting") return undefined;
        if (error.reason === "unreachable" && ++remoteFailures < 3) return undefined;
        // Host visibility ends this subscription; it says nothing about child completion.
        return {
          status: "error",
          final: null,
          lastMessage: null,
          error: null,
          reason: error.reason === "removed" ? "host removed" : "host unreachable",
        };
      }
    }
    try {
      while (!signal.aborted) {
        try {
          if (await suppressed(record)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (!pending) pending = await observeNext();
          if (!pending) {
            await delay(signal, retries++);
            continue;
          }
          if (signal.aborted) return;
          await decisions(group);
          if (signal.aborted) return;
          if (await suppressed(record, pending)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (!acknowledged) acknowledged = await deliver(record, pending, permissions, signal);
          if (acknowledged) {
            // A removal failure retries only the commit, never the already accepted callback.
            await remove(watch);
            stop(watch, group);
            return;
          }
          pending = undefined;
          retries = 0;
          warned = false;
        } catch (error) {
          if (signal.aborted) return;
          // Delivery and storage failures retain the captured outcome and durable intent.
          // They do not spend the remote-observation budget or change the child's outcome.
          if (!warned) {
            deps.logger.warn(
              { err: error, subscription: record.id },
              "Retrying finish subscription",
            );
            warned = true;
          }
          await delay(signal, retries++);
        }
      }
    } finally {
      await observation?.close();
    }
  }

  return {
    start: () =>
      serialize(async () => {
        const groups = new Map<string, FinishSubscription[]>();
        for (const record of await deps.store.list()) {
          const records = groups.get(key(record)) ?? [];
          records.push(record);
          groups.set(key(record), records);
        }
        for (const records of groups.values()) attach(records, false);
      }),
    register: (input, pendingDispatch = false) =>
      serialize(async () => {
        if (closed) throw new Error("Finish subscriptions are closed");
        const record: FinishSubscription = {
          ...input,
          serverId: input.serverId === deps.serverId ? undefined : input.serverId,
          id: randomUUID(),
        };
        await deps.store.put(record);
        const group = watches.get(key(record)) ?? new Set<Watch>();
        const predecessors = [...group];
        const watch = attach([record], true);
        const actualGroup = watches.get(key(record))!;
        const registration: FinishRegistration = {
          accept() {
            if (!watch.pending || closed) return;
            watch.pending = false;
            for (const prior of predecessors) stop(prior, actualGroup);
            watch.decide(true);
            void serialize(async () => {
              for (const prior of predecessors) await remove(prior);
            }).catch((error) =>
              deps.logger.error({ err: error }, "Failed to remove superseded finish subscriptions"),
            );
          },
          reject: () =>
            serialize(async () => {
              stop(watch, actualGroup);
              await remove(watch);
            }),
        };
        if (!pendingDispatch) registration.accept();
        return registration;
      }),
    async close() {
      closed = true;
      await mutations;
      for (const group of watches.values())
        for (const watch of group) {
          watch.controller.abort();
          watch.decide(false);
        }
      await mutations;
      await Promise.all(tasks);
      await deps.store.list();
      // Dispatch may still be pending. The delivery owner drains it after observers stop.
    },
  };
}

export { createFinishObservation } from "./internal/observation.js";
