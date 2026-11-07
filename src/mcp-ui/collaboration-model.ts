import type { AgentActivity, Session } from '../mcp/schema';
import { activeAttempts } from './canvas-model';

export function currentWork(session: Session) {
  return activeAttempts(session).map(attempt => ({
    attempt,
    agent: session.agents.find(agent => agent.id === attempt.agentId),
    runtimeAgentId: [...(session.activities ?? [])].reverse().find(activity => activity.attemptId === attempt.id && activity.revision === session.revision && activity.runtimeAgentId)?.runtimeAgentId,
    activity: [...(session.activities ?? [])].reverse().find(activity => activity.attemptId === attempt.id && activity.revision === session.revision),
  }));
}

export function collaborationMessages(session: Session) {
  const activities = (session.activities ?? []).filter(activity => activity.revision === session.revision);
  return activities.filter(activity => activity.kind === 'message_sent').map(sent => ({
    sent,
    received: activities.find(activity => activity.kind === 'message_received' && activity.messageId === sent.messageId && activity.agentId === sent.toAgentId),
  }));
}

export function visibleAncestor(session: Session, id: string | undefined, visible: ReadonlySet<string>): string | undefined {
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    if (visible.has(id)) return id;
    visited.add(id);
    id = session.nodes.find(node => node.id === id)?.parentId ?? undefined;
  }
}

export function nodeActivities(session: Session, nodeId: string): AgentActivity[] {
  const ids = new Set([nodeId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of session.nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true; }
  }
  return (session.activities ?? []).filter(activity => ids.has(activity.nodeId) || Boolean(activity.toNodeId && ids.has(activity.toNodeId))).slice(-40).reverse();
}
