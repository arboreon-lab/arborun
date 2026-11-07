import type { NodeSpec, NodeState, Session } from '../mcp/schema';

export function nodeSpecification(node: NodeSpec): NodeSpec {
  return { id: node.id, parentId: node.parentId, kind: node.kind, ...(node.by ? { by: node.by } : {}), title: node.title, action: node.action,
    target: node.target, input: node.input, acceptance: [...node.acceptance], failure: node.failure,
    dependsOn: [...node.dependsOn], ...(node.when ? { when: { ...node.when } } : {}), agentId: node.agentId };
}

export function subtreeIds(nodes: NodeSpec[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let pass = 0; pass < nodes.length; pass++) {
    const before = ids.size;
    for (const node of nodes) if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
    if (before === ids.size) break;
  }
  return ids;
}

/** Conservative UI preview; the server remains authoritative about invalidation. */
export function previewImpact(session: Session, changed: NodeSpec): NodeSpec[] {
  const oldNodes: NodeSpec[] = session.nodes;
  const nextNodes = [...oldNodes.filter(node => node.id !== changed.id), changed];
  const affected = new Set([changed.id, ...session.attempts.filter(a => a.status === 'running').map(a => a.nodeId)]);
  for (let pass = 0; pass < oldNodes.length + nextNodes.length; pass++) {
    const size = affected.size;
    for (const graph of [oldNodes, nextNodes]) {
      for (const node of graph) {
        if ((node.parentId && affected.has(node.parentId)) || node.dependsOn.some(id => affected.has(id)) ||
          (node.when && affected.has(node.when.nodeId))) affected.add(node.id);
        if (node.kind === 'agent' && [...subtreeIds(graph, node.id)].some(id => id !== node.id && affected.has(id))) affected.add(node.id);
      }
    }
    if (size === affected.size) break;
  }
  return nextNodes.filter(node => affected.has(node.id));
}

export function deletionImpact(session: Session, nodeId: string) {
  const node = session.nodes.find(n => n.id === nodeId);
  const ids = subtreeIds(session.nodes, nodeId);
  const descendants = session.nodes.filter(n => n.id !== nodeId && ids.has(n.id));
  const references = session.nodes.filter(n => !ids.has(n.id) &&
    (n.dependsOn.some(id => ids.has(id)) || (n.when && ids.has(n.when.nodeId))));
  const parent = session.nodes.find(n => n.id === node?.parentId);
  const leavesEmptyGroup = parent?.kind === 'group' && session.nodes.filter(n => n.parentId === parent.id).length === 1;
  return { descendants, references, isRoot: node?.parentId === null, leavesEmptyGroup,
    canDelete: Boolean(node && node.parentId !== null && !descendants.length && !references.length && !leavesEmptyGroup) };
}

export function nodeStatusText(node: NodeState, session: Session): string {
  if (node.status === 'draft' && session.status !== 'draft') return '等待执行条件';
  return ({ draft: '待批准', ready: '待执行', running: '执行中', passed: '检查通过', failed: '检查未通过',
    blocked: '等待依据', skipped: '条件未触发', stale: '结果待重验' } as const)[node.status];
}
