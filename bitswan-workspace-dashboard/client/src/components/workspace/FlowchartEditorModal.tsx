import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnConnectStart,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Circle, Diamond, Palette, Square, Trash2 } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  COLOR_PALETTE,
  parseMermaidToReactFlow,
  reactFlowToMermaid,
  type FlowchartNode,
  type FlowchartNodeType,
} from '@/lib/mermaid-reactflow-converter';
import { flowchartNodeTypes } from './flowchart/FlowchartNodes';

interface FlowchartEditorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing mermaid source when editing; empty for a new diagram. */
  initialMermaid?: string;
  onSave: (mermaidSource: string) => void;
}

// Module-level counter so node ids never collide across modal opens.
let nodeIdCounter = 0;

function generateNodeId(): string {
  return `N${++nodeIdCounter}`;
}

function FlowchartEditorInner({
  initialMermaid,
  onSave,
  onCancel,
}: {
  initialMermaid?: string;
  onSave: (src: string) => void;
  onCancel: () => void;
}) {
  // Parse initial mermaid into nodes/edges
  const initial = useMemo(() => {
    if (initialMermaid?.trim()) {
      const parsed = parseMermaidToReactFlow(initialMermaid);
      // Bump the id counter past existing ids to avoid collisions
      for (const n of parsed.nodes) {
        const num = parseInt(n.id.replace(/\D/g, ''), 10);
        if (!isNaN(num) && num >= nodeIdCounter) nodeIdCounter = num;
      }
      return parsed;
    }
    // Start empty diagrams with one process node
    const startId = generateNodeId();
    const nodes: FlowchartNode[] = [
      {
        id: startId,
        type: 'process',
        position: { x: 200, y: 200 },
        data: { label: 'Process', nodeType: 'process' },
      },
    ];
    const edges: Edge[] = [];
    return { nodes, edges };
  }, [initialMermaid]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId);

  // Track connection start for "drag to empty canvas → new node" behavior
  const connectStartRef = useRef<{
    nodeId: string;
    handleId?: string;
    handleType?: string;
  }>();
  const { screenToFlowPosition } = useReactFlow();

  const onConnectStart: OnConnectStart = useCallback((_event, params) => {
    connectStartRef.current = {
      nodeId: params.nodeId ?? '',
      ...(params.handleId ? { handleId: params.handleId } : {}),
      ...(params.handleType ? { handleType: params.handleType } : {}),
    };
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      connectStartRef.current = undefined; // successful connection, don't spawn
      setEdges((eds) => addEdge({ ...connection, type: 'smoothstep' }, eds));
    },
    [setEdges],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const start = connectStartRef.current;
      connectStartRef.current = undefined;
      if (!start?.nodeId) return;

      // A drop on an existing node/handle is a valid connection, not a spawn
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.react-flow__handle')) return;
      if (target.closest('.react-flow__node')) return;

      const point =
        'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY });

      const newId = generateNodeId();
      const newNode: FlowchartNode = {
        id: newId,
        type: 'process',
        position,
        data: { label: 'Process', nodeType: 'process' },
      };

      const isSource = start.handleType === 'source';
      const newEdge: Edge = {
        id: `e-${start.nodeId}-${newId}`,
        source: isSource ? start.nodeId : newId,
        target: isSource ? newId : start.nodeId,
        ...(isSource && start.handleId ? { sourceHandle: start.handleId } : {}),
        type: 'smoothstep',
      };

      setNodes((nds) => [...nds, { ...newNode, selected: true }]);
      setEdges((eds) => [...eds, newEdge]);
      setSelectedNodeId(newId);
      setSelectedEdgeId(undefined);
    },
    [screenToFlowPosition, setNodes, setEdges],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: { nodes: Node[]; edges: Edge[] }) => {
      setSelectedNodeId(selNodes.length === 1 ? selNodes[0]?.id : undefined);
      setSelectedEdgeId(selEdges.length === 1 ? selEdges[0]?.id : undefined);
    },
    [],
  );

  const addNode = useCallback(
    (type: FlowchartNodeType) => {
      const id = generateNodeId();
      const label =
        type === 'process' ? 'Process' : type === 'decision' ? 'Decision' : 'Terminal';
      const newNode: FlowchartNode = {
        id,
        type,
        position: { x: 200, y: 200 },
        data: { label, nodeType: type },
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  const deleteSelected = useCallback(() => {
    if (selectedNodeId) {
      setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
      setEdges((eds) =>
        eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId),
      );
      setSelectedNodeId(undefined);
    }
    if (selectedEdgeId) {
      setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(undefined);
    }
  }, [selectedNodeId, selectedEdgeId, setNodes, setEdges]);

  const updateNodeLabel = useCallback(
    (label: string) => {
      if (!selectedNodeId) return;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId ? { ...n, data: { ...n.data, label } } : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const updateNodeColor = useCallback(
    (color?: string) => {
      if (!selectedNodeId) return;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId ? { ...n, data: { ...n.data, color } } : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const changeNodeType = useCallback(
    (newType: FlowchartNodeType) => {
      if (!selectedNodeId) return;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId
            ? { ...n, type: newType, data: { ...n.data, nodeType: newType } }
            : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const updateEdgeLabel = useCallback(
    (label: string) => {
      if (!selectedEdgeId) return;
      setEdges((eds) => eds.map((e) => (e.id === selectedEdgeId ? { ...e, label } : e)));
    },
    [selectedEdgeId, setEdges],
  );

  const handleSave = useCallback(() => {
    onSave(reactFlowToMermaid(nodes, edges));
  }, [nodes, edges, onSave]);

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-muted/30 p-3">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Add node
          </p>
          <div className="flex flex-col gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="justify-start gap-2"
              onClick={() => addNode('process')}
            >
              <Square className="size-3.5" aria-hidden /> Process
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start gap-2"
              onClick={() => addNode('decision')}
            >
              <Diamond className="size-3.5" aria-hidden /> Decision
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start gap-2"
              onClick={() => addNode('terminal')}
            >
              <Circle className="size-3.5" aria-hidden /> Terminal
            </Button>
          </div>
        </div>

        <Separator />

        {selectedNode && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Node properties
            </p>
            <label className="text-xs text-muted-foreground">Label</label>
            <Input
              value={selectedNode.data.label}
              onChange={(e) => updateNodeLabel(e.target.value)}
              className="h-8 text-sm"
            />
            <label className="text-xs text-muted-foreground">Type</label>
            <div className="flex gap-1">
              {(['process', 'decision', 'terminal'] as const).map((t) => (
                <Button
                  key={t}
                  variant={selectedNode.type === t ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 text-xs capitalize"
                  onClick={() => changeNodeType(t)}
                >
                  {t}
                </Button>
              ))}
            </div>
            <label className="text-xs text-muted-foreground">Color</label>
            <div className="grid grid-cols-8 gap-1">
              {COLOR_PALETTE.map(({ bg }) => (
                <button
                  key={bg}
                  type="button"
                  className={`size-5 cursor-pointer rounded border transition-transform hover:scale-125
                    ${selectedNode.data.color === bg ? 'ring-2 ring-primary ring-offset-1' : 'border-border'}`}
                  style={{ backgroundColor: bg }}
                  onClick={() => updateNodeColor(bg)}
                  title={bg}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 justify-start gap-2 text-xs"
                  >
                    <Palette className="size-3" aria-hidden />
                    Custom
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3" side="right" align="start">
                  <HexColorPicker
                    color={selectedNode.data.color || '#ffffff'}
                    onChange={(c) => updateNodeColor(c)}
                  />
                </PopoverContent>
              </Popover>
              {selectedNode.data.color && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => updateNodeColor(undefined)}
                >
                  Reset
                </Button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5 text-destructive hover:bg-destructive/10"
              onClick={deleteSelected}
            >
              <Trash2 className="size-3.5" aria-hidden /> Delete node
            </Button>
          </div>
        )}

        {selectedEdge && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Edge properties
            </p>
            <label className="text-xs text-muted-foreground">Label</label>
            <Input
              value={typeof selectedEdge.label === 'string' ? selectedEdge.label : ''}
              onChange={(e) => updateEdgeLabel(e.target.value)}
              className="h-8 text-sm"
              placeholder="Optional label"
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5 text-destructive hover:bg-destructive/10"
              onClick={deleteSelected}
            >
              <Trash2 className="size-3.5" aria-hidden /> Delete edge
            </Button>
          </div>
        )}

        {!selectedNode && !selectedEdge && (
          <p className="text-xs text-muted-foreground">
            Drag from a handle to empty space to add a connected node. Select a
            node to edit its label, type, or color.
          </p>
        )}
      </div>

      {/* React Flow canvas */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnectStart={onConnectStart}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onSelectionChange={onSelectionChange}
            nodeTypes={flowchartNodeTypes}
            fitView
            deleteKeyCode="Delete"
            className="bg-background"
          >
            <Background gap={16} size={1} />
            <Controls />
            <MiniMap nodeStrokeWidth={3} className="!bg-muted/50" />
          </ReactFlow>
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-3">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save diagram</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen visual editor for the mermaid flowchart blocks embedded in
 * a BP specification. Reads/writes plain Mermaid `flowchart TD` source so
 * the diagram stays readable to the coding agent and any markdown viewer.
 */
export function FlowchartEditorModal({
  open,
  onOpenChange,
  initialMermaid,
  onSave,
}: FlowchartEditorModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <DialogTitle>Flowchart editor</DialogTitle>
          <DialogDescription>
            Drag from a handle to empty space to create a connected node. Drag
            between handles to connect existing nodes. Double-click labels to
            edit.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1">
          {open && (
            <ReactFlowProvider>
              <FlowchartEditorInner
                {...(initialMermaid ? { initialMermaid } : {})}
                onSave={(src) => {
                  onSave(src);
                  onOpenChange(false);
                }}
                onCancel={() => onOpenChange(false)}
              />
            </ReactFlowProvider>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
