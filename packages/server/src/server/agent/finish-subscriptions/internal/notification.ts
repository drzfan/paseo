import type { AgentPermissionRequest } from "../../agent-sdk-types.js";
export type FinishNotificationReason =
  | "host unreachable"
  | "host removed"
  | "finished"
  | "errored"
  | "needs permission"
  | "is unavailable"
  | "was closed"
  | "was canceled";

export const finishNotificationEvents = {
  "host unreachable": "errored",
  "host removed": "errored",
  finished: "finished",
  errored: "errored",
  "needs permission": "permission-required",
  "was closed": "closed",
  "is unavailable": "closed",
  // Use the existing failure event so older clients still parse agent-message metadata.
  "was canceled": "errored",
} as const;

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  serverId?: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

/**
 * Terminal (non-permission) finish notifications end with a housekeeping
 * footer so the receiving agent can act without remembering tool names:
 * archive the finished child to reclaim its resident agent process, or
 * review its recent activity first. The child's agentId is embedded verbatim.
 */
export function formatFinishHousekeepingHint(childAgentId: string): string {
  return [
    "<housekeeping>",
    "This child's agent process stays resident until archived. If it has no further work for you, reclaim it:",
    `paseo_archive_agent(agentId="${childAgentId}")`,
    "(history stays on disk — recoverable via paseo_list_agents with includeArchived; a follow-up prompt still wakes the archived agent with full context — archive only reclaims the resident process)",
    "To review what it did recently:",
    `paseo_get_agent_activity(agentId="${childAgentId}", limit=10)`,
    "</housekeeping>",
  ].join("\n");
}

export function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  if (params.reason === "host unreachable" || params.reason === "host removed") {
    const host =
      params.reason === "host removed"
        ? `Host ${params.serverId} was removed or is unavailable.`
        : `Could not observe child agent ${params.childAgentId} on host ${params.serverId} after three failed attempts.`;
    return `${host}\n\nStatus of child agent ${params.childAgentId} (${params.title}) is unknown.\n\nServer: ${params.serverId}\n\nThis finish subscription has ended. Reassess the delegated work; reconnecting will not resume notifications.`;
  }
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.serverId) sections.push(`Server: ${params.serverId}`);
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          ...(params.serverId ? { serverId: params.serverId } : {}),
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  // 终态回执脚注：善后指引（归档回收常驻进程/复核活动，ID 嵌死、免查手册）。
  // 「needs permission」不算终态，不带脚注。
  if (params.reason !== "needs permission") {
    sections.push(formatFinishHousekeepingHint(params.childAgentId));
  }
  return sections.join("\n\n");
}
