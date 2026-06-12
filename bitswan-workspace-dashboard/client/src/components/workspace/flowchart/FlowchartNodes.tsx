import { useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  textColorForBg,
  type FlowchartNode,
} from '@/lib/mermaid-reactflow-converter';

// --- Shared inline-edit label ----------------------------------------------

function EditableLabel({
  label,
  onChange,
}: {
  label: string;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(label);
  }, [label]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    if (value.trim() && value !== label) onChange(value.trim());
    else setValue(label);
  }, [value, label, onChange]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="nodrag nopan w-full border-b border-primary bg-transparent text-center text-sm outline-none"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setValue(label);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span
      className="max-w-full cursor-text select-none truncate text-sm"
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
    >
      {label}
    </span>
  );
}

function useUpdateNodeLabel(nodeId: string) {
  const { setNodes } = useReactFlow();
  return useCallback(
    (newLabel: string) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, label: newLabel } } : n,
        ),
      );
    },
    [nodeId, setNodes],
  );
}

function SourceTargetHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-primary" />
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-primary" />
    </>
  );
}

/** Rectangle node — a process step. */
export function ProcessNode({ id, data, selected }: NodeProps<FlowchartNode>) {
  const updateLabel = useUpdateNodeLabel(id);
  const colorStyle = data.color
    ? { backgroundColor: data.color, color: textColorForBg(data.color) }
    : undefined;
  return (
    <div
      className={`min-w-[100px] rounded border px-4 py-2 text-center
        ${!data.color ? 'bg-white text-foreground' : ''}
        ${selected ? 'ring-2 ring-primary' : 'border-border'}`}
      style={colorStyle}
    >
      <SourceTargetHandles />
      <EditableLabel label={data.label} onChange={updateLabel} />
    </div>
  );
}

/** Diamond node — a decision point. */
export function DecisionNode({ id, data, selected }: NodeProps<FlowchartNode>) {
  const updateLabel = useUpdateNodeLabel(id);
  return (
    <div className="relative flex h-[120px] w-[120px] items-center justify-center">
      {/* Diamond shape via rotated square */}
      <div
        className={`absolute inset-[15%] rotate-45 border
          ${!data.color ? 'bg-white' : ''}
          ${selected ? 'ring-2 ring-primary' : 'border-border'}`}
        style={data.color ? { backgroundColor: data.color } : undefined}
      />
      {/* Label sits on top, not rotated */}
      <div
        className={`relative z-10 max-w-[80px] px-1 text-center ${!data.color ? 'text-foreground' : ''}`}
        style={data.color ? { color: textColorForBg(data.color) } : undefined}
      >
        <EditableLabel label={data.label} onChange={updateLabel} />
      </div>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !bg-primary"
        style={{ top: 0 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !bg-primary"
        style={{ bottom: 0 }}
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!h-2 !w-2 !bg-primary"
        style={{ left: 0 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!h-2 !w-2 !bg-primary"
        style={{ right: 0 }}
      />
    </div>
  );
}

/** Stadium / pill node — a start or end point. */
export function TerminalNode({ id, data, selected }: NodeProps<FlowchartNode>) {
  const updateLabel = useUpdateNodeLabel(id);
  const colorStyle = data.color
    ? { backgroundColor: data.color, color: textColorForBg(data.color) }
    : undefined;
  return (
    <div
      className={`min-w-[100px] rounded-full border px-5 py-2 text-center
        ${!data.color ? 'bg-white text-foreground' : ''}
        ${selected ? 'ring-2 ring-primary' : 'border-border'}`}
      style={colorStyle}
    >
      <SourceTargetHandles />
      <EditableLabel label={data.label} onChange={updateLabel} />
    </div>
  );
}

export const flowchartNodeTypes = {
  process: ProcessNode,
  decision: DecisionNode,
  terminal: TerminalNode,
};
