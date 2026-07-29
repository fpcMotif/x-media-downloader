import type { TweetRecord } from './record'

export type TweetNode = TweetRecord & { children: TweetNode[] }

export type ConversationTree = { conversationId: string; roots: TweetNode[] }

/** Stable order: `createdAt` ascending (absent sorts first) then `tweetId`. */
const bySortKey = (a: TweetNode, b: TweetNode): number => {
  const ta = a.createdAt ?? Number.NEGATIVE_INFINITY
  const tb = b.createdAt ?? Number.NEGATIVE_INFINITY
  return ta !== tb ? ta - tb : a.tweetId.localeCompare(b.tweetId)
}

/**
 * Reconstruct conversation reply trees from {@link TweetRecord}s (spec §6.2):
 * group by `conversationId`; link each node under its `inReplyToTweetId` parent
 * iff that parent is in the group; roots are true roots plus orphan replies whose
 * parent wasn't captured. Parentage comes SOLELY from `inReplyToTweetId` — the raw
 * `conversationthread` module nesting is ignored. Cycle-defended: a node reachable
 * only through a cycle (no real root) is promoted to a root, and the descent's
 * visited set keeps the traversal total.
 */
export function buildTree(records: ReadonlyArray<TweetRecord>): ConversationTree[] {
  const groups = new Map<string, TweetNode[]>()
  for (const record of records) {
    const node: TweetNode = { ...record, children: [] }
    const group = groups.get(record.conversationId)
    if (group) group.push(node)
    else groups.set(record.conversationId, [node])
  }

  const trees: ConversationTree[] = []
  for (const [conversationId, nodes] of groups) {
    const byId = new Map(nodes.map((n) => [n.tweetId, n]))
    const roots: TweetNode[] = []

    for (const node of nodes) {
      const parentId = node.inReplyToTweetId
      const parent = parentId !== undefined ? byId.get(parentId) : undefined
      if (parent === undefined || parent === node) roots.push(node)
      else parent.children.push(node)
    }

    const visited = new Set<TweetNode>()
    /** Stable pre-order without call-stack growth on a valid long reply chain. */
    const order = (level: TweetNode[]): TweetNode[] => {
      const out = level.toSorted(bySortKey)
      const stack: Array<{ readonly nodes: TweetNode[]; index: number }> = [
        { nodes: out, index: 0 },
      ]
      while (stack.length > 0) {
        const frame = stack.at(-1)!
        const node = frame.nodes[frame.index]
        if (node === undefined) {
          stack.pop()
          continue
        }
        frame.index += 1
        visited.add(node)
        node.children = node.children.filter((child) => !visited.has(child)).toSorted(bySortKey)
        if (node.children.length > 0) stack.push({ nodes: node.children, index: 0 })
      }
      return out
    }

    const orderedRoots = order(roots)
    // Any node only reachable through a cycle has no root entry; promote it.
    for (const node of nodes) {
      if (!visited.has(node)) orderedRoots.push(...order([node]))
    }

    // Cycle-only components are promoted after the ordinary-root walk. Sort the
    // finished forest too, so promotion timing cannot change the public order.
    trees.push({ conversationId, roots: orderedRoots.toSorted(bySortKey) })
  }

  return trees
}
