import type { Edge, Node } from '@xyflow/react';

// Ported from the AOC portal's markdown editor (bitswan-space/
// automation-operation-center PR #290): a hand-rolled bidirectional
// converter between the Mermaid `flowchart TD` subset the visual editor
// supports and React Flow graphs. Diagrams stay plain mermaid in the
// README, so the coding agent and any markdown renderer can read them.

export type FlowchartNodeType = 'process' | 'decision' | 'terminal';

export interface FlowchartNodeData {
  label: string;
  nodeType: FlowchartNodeType;
  /** Background fill color (hex). */
  color?: string;
  [key: string]: unknown; // eslint-disable-line no-restricted-syntax -- React Flow requires Record-compatible node data
}

export type FlowchartNode = Node<FlowchartNodeData>;

/**
 * 32 curated background colors paired with hand-picked text colors that
 * stay readable on each background.
 */
export const COLOR_PALETTE: { bg: string; text: string }[] = [
  // Row 1 — vivid warm → cool
  { bg: '#ef4444', text: '#ffffff' },
  { bg: '#f97316', text: '#ffffff' },
  { bg: '#f59e0b', text: '#422006' },
  { bg: '#eab308', text: '#422006' },
  { bg: '#84cc16', text: '#1a2e05' },
  { bg: '#22c55e', text: '#052e16' },
  { bg: '#10b981', text: '#022c22' },
  { bg: '#14b8a6', text: '#042f2e' },
  // Row 2 — vivid cool → purple/pink
  { bg: '#06b6d4', text: '#083344' },
  { bg: '#0ea5e9', text: '#082f49' },
  { bg: '#3b82f6', text: '#ffffff' },
  { bg: '#6366f1', text: '#ffffff' },
  { bg: '#8b5cf6', text: '#ffffff' },
  { bg: '#a855f7', text: '#ffffff' },
  { bg: '#d946ef', text: '#ffffff' },
  { bg: '#ec4899', text: '#ffffff' },
  // Row 3 — pastels (dark text)
  { bg: '#fca5a5', text: '#7f1d1d' },
  { bg: '#fdba74', text: '#7c2d12' },
  { bg: '#fde047', text: '#422006' },
  { bg: '#bef264', text: '#1a2e05' },
  { bg: '#86efac', text: '#052e16' },
  { bg: '#6ee7b7', text: '#022c22' },
  { bg: '#5eead4', text: '#042f2e' },
  { bg: '#7dd3fc', text: '#082f49' },
  // Row 4 — soft / muted
  { bg: '#93c5fd', text: '#1e3a5f' },
  { bg: '#a5b4fc', text: '#312e81' },
  { bg: '#c4b5fd', text: '#3b0764' },
  { bg: '#d8b4fe', text: '#3b0764' },
  { bg: '#f0abfc', text: '#701a75' },
  { bg: '#f9a8d4', text: '#831843' },
  { bg: '#d6d3d1', text: '#292524' },
  { bg: '#9ca3af', text: '#111827' },
];

/** Hand-picked text color for a palette bg, or a luminance-based one for custom colors. */
// eslint-disable-next-line no-restricted-syntax -- undefined = inherit the node's default text color
export function textColorForBg(hex?: string): string | undefined {
  if (!hex) return undefined;
  const entry = COLOR_PALETTE.find((c) => c.bg.toLowerCase() === hex.toLowerCase());
  if (entry) return entry.text;
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return undefined;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#000000' : '#ffffff';
}

// ---------- Metadata (positions) stored as %% meta: {...} comment ----------

interface DiagramMeta {
  positions?: Record<string, { x?: number; y?: number }>;
}

function parseMetaComment(lines: string[]): DiagramMeta {
  for (const line of lines) {
    const m = /^%%\s*meta:\s*(.+)$/.exec(line.trim());
    if (m?.[1]) {
      try {
        // eslint-disable-next-line no-restricted-syntax -- JSON boundary; shape is best-effort
        return JSON.parse(m[1]) as DiagramMeta;
      } catch {
        return {};
      }
    }
  }
  return {};
}

function buildMetaComment(nodes: FlowchartNode[]): string {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    positions[n.id] = {
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
    };
  }
  return `%% meta: ${JSON.stringify({ positions })}`;
}

// ---------- Mermaid → React Flow ----------

interface ParsedNode {
  id: string;
  label: string;
  type: FlowchartNodeType;
  color?: string;
}

interface ParsedEdge {
  source: string;
  target: string;
  label: string;
}

/**
 * Parse a Mermaid `flowchart TD` source into React Flow nodes and edges.
 *
 * Supported node shapes:
 *   A[text]   → process (rectangle)
 *   A{text}   → decision (diamond)
 *   A([text]) → terminal (stadium)
 *
 * Supported edge syntaxes:
 *   A --> B
 *   A -->|label| B
 *   A -- label --> B
 *
 * Supported style directives:
 *   style A fill:#ff0000
 *
 * Position metadata:
 *   %% meta: {"positions":{"A":{"x":100,"y":50},...}}
 */
export function parseMermaidToReactFlow(mermaid: string): {
  nodes: FlowchartNode[];
  edges: Edge[];
} {
  const lines = mermaid
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const parsedNodes = new Map<string, ParsedNode>();
  const parsedEdges: ParsedEdge[] = [];
  const nodeColors = new Map<string, string>();

  const meta = parseMetaComment(lines);

  // Skip the header line(s) like "flowchart TD"
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && /^(flowchart|graph)\s+(TD|TB|LR|RL|BT)/i.test(line)) {
      startIdx = i + 1;
      break;
    }
  }

  const nodeShapeRegex =
    /^([A-Za-z_][A-Za-z0-9_]*)\s*(\(\[(.+?)\]\)|\[(.+?)\]|\{(.+?)\})\s*$/;

  // Edge pattern:  A -->|label| B  or  A -- label --> B  or  A --> B
  const edgeRegex =
    /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:--\s+(.+?)\s+)?-->(?:\|(.+?)\|)?\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*(\(\[(.+?)\]\)|\[(.+?)\]|\{(.+?)\}))?$/;

  // Style directive:  style A fill:#hex[,other-props...]
  const styleRegex = /^style\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/;

  function ensureNode(id: string) {
    if (!parsedNodes.has(id)) {
      parsedNodes.set(id, { id, label: id, type: 'process' });
    }
  }

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^%%/.test(line)) continue;

    const sm = styleRegex.exec(line);
    if (sm) {
      const nodeId = sm[1];
      const props = sm[2];
      const fillMatch = props ? /fill:\s*(#[0-9a-fA-F]{3,8})/.exec(props) : undefined;
      if (nodeId && fillMatch?.[1]) {
        nodeColors.set(nodeId, fillMatch[1]);
      }
      continue;
    }

    // Standalone node definition
    const nm = nodeShapeRegex.exec(line);
    if (nm) {
      const id = nm[1];
      if (!id) continue;
      const stadiumLabel = nm[3];
      const rectLabel = nm[4];
      const diamondLabel = nm[5];

      let type: FlowchartNodeType = 'process';
      let label = id;
      if (stadiumLabel !== undefined) {
        type = 'terminal';
        label = stadiumLabel;
      } else if (diamondLabel !== undefined) {
        type = 'decision';
        label = diamondLabel;
      } else if (rectLabel !== undefined) {
        label = rectLabel;
      }

      parsedNodes.set(id, { id, label, type });
      continue;
    }

    // Edge definition
    const em = edgeRegex.exec(line);
    if (em) {
      const sourceId = em[1];
      const targetId = em[4];
      if (!sourceId || !targetId) continue;
      const edgeLabel = em[3] || em[2] || '';

      ensureNode(sourceId);
      ensureNode(targetId);

      // Inline shape definition on the target
      const targetStadium = em[6];
      const targetRect = em[7];
      const targetDiamond = em[8];
      if (targetStadium !== undefined) {
        parsedNodes.set(targetId, { id: targetId, label: targetStadium, type: 'terminal' });
      } else if (targetDiamond !== undefined) {
        parsedNodes.set(targetId, { id: targetId, label: targetDiamond, type: 'decision' });
      } else if (targetRect !== undefined) {
        parsedNodes.set(targetId, { id: targetId, label: targetRect, type: 'process' });
      }

      parsedEdges.push({ source: sourceId, target: targetId, label: edgeLabel });
    }
  }

  for (const [nodeId, color] of nodeColors) {
    const node = parsedNodes.get(nodeId);
    if (node) node.color = color;
  }

  // Layout: saved positions from metadata, falling back to a simple grid.
  const COL_WIDTH = 200;
  const ROW_HEIGHT = 100;
  const COLS = 3;

  const nodes: FlowchartNode[] = Array.from(parsedNodes.values()).map((n, idx) => {
    const savedPos = meta.positions?.[n.id];
    const position =
      savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number'
        ? { x: savedPos.x, y: savedPos.y }
        : {
            x: (idx % COLS) * COL_WIDTH + 50,
            y: Math.floor(idx / COLS) * ROW_HEIGHT + 50,
          };
    return {
      id: n.id,
      type: n.type,
      position,
      data: {
        label: n.label,
        nodeType: n.type,
        ...(n.color ? { color: n.color } : {}),
      },
    };
  });

  const edges: Edge[] = parsedEdges.map((e, idx) => ({
    id: `e-${idx}`,
    source: e.source,
    target: e.target,
    ...(e.label ? { label: e.label } : {}),
    type: 'smoothstep',
  }));

  return { nodes, edges };
}

// ---------- React Flow → Mermaid ----------

const shapeOpen: Record<FlowchartNodeType, string> = {
  process: '[',
  decision: '{',
  terminal: '([',
};
const shapeClose: Record<FlowchartNodeType, string> = {
  process: ']',
  decision: '}',
  terminal: '])',
};

/**
 * Convert React Flow nodes and edges back into Mermaid `flowchart TD`
 * syntax. Colored nodes get a `style` directive; positions persist via a
 * `%% meta: {...}` comment (mermaid ignores comments, and the agent can
 * still read the graph structure).
 */
export function reactFlowToMermaid(nodes: FlowchartNode[], edges: Edge[]): string {
  const lines: string[] = ['flowchart TD'];

  for (const n of nodes) {
    const type = n.data.nodeType ?? 'process';
    const label = n.data.label || n.id;
    lines.push(`    ${n.id}${shapeOpen[type]}${label}${shapeClose[type]}`);
  }

  for (const e of edges) {
    if (e.label) {
      lines.push(`    ${e.source} -->|${String(e.label)}| ${e.target}`);
    } else {
      lines.push(`    ${e.source} --> ${e.target}`);
    }
  }

  for (const n of nodes) {
    if (n.data.color) {
      lines.push(`    style ${n.id} fill:${n.data.color}`);
    }
  }

  lines.push(`    ${buildMetaComment(nodes)}`);
  return lines.join('\n');
}
