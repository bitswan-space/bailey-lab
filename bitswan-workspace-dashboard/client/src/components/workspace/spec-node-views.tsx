import {
  Component,
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ReactNode,
  type Ref,
} from 'react';
import { useEditorEventCallback } from '@handlewithcare/react-prosemirror';
import {
  ReactFlow,
  ReactFlowProvider,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeViewComponentProps } from '@handlewithcare/react-prosemirror';
import { api } from '@/lib/api';
import {
  parseMermaidToReactFlow,
  type FlowchartNode,
} from '@/lib/mermaid-reactflow-converter';
import { flowchartNodeTypes } from './flowchart/FlowchartNodes';
import { CODE_LANGUAGES, detectLanguage } from './spec-code-highlight';

/**
 * Per-editor data the node view components need. react-prosemirror
 * requires `nodeViewComponents` to be a stable module-level map, so
 * instance data flows through context instead of props.
 */
export interface SpecEditorContextValue {
  copy: string;
  bpId: string;
  onEditMermaid: (pos: number, source: string) => void;
  onDeleteMermaid: (pos: number) => void;
}

// eslint-disable-next-line no-restricted-syntax -- null = rendered outside SpecificationTab (programming error)
export const SpecEditorContext = createContext<SpecEditorContextValue | null>(null);

function useSpecEditorContext(): SpecEditorContextValue {
  const ctx = useContext(SpecEditorContext);
  if (!ctx) {
    throw new Error('spec node views must render inside SpecEditorContext');
  }
  return ctx;
}

// ---- Mermaid preview ------------------------------------------------------

function PreviewNote({ text, destructive = false }: { text: string; destructive?: boolean }) {
  return (
    <p
      style={{
        color: destructive ? '#b91c1c' : '#71717a',
        fontStyle: 'italic',
        textAlign: 'center',
        marginTop: 100,
      }}
    >
      {text}
    </p>
  );
}

/**
 * A rendering error inside React Flow would otherwise unmount the whole
 * editor tree. Contain it to the block and reset when the diagram source
 * changes, so fixing the source recovers the preview.
 */
class PreviewErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (this.state.failed) {
      return <PreviewNote text="Invalid diagram — click to edit" destructive />;
    }
    return this.props.children;
  }
}

function MermaidPreview({ source }: { source: string }) {
  if (!source.trim()) {
    return <PreviewNote text="Empty diagram — click to edit" />;
  }
  let nodes: FlowchartNode[];
  let edges: Edge[];
  try {
    ({ nodes, edges } = parseMermaidToReactFlow(source));
  } catch {
    return <PreviewNote text="Invalid diagram — click to edit" destructive />;
  }
  if (nodes.length === 0) {
    return <PreviewNote text="Empty diagram — click to edit" />;
  }
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={flowchartNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      />
    </ReactFlowProvider>
  );
}

// ---- Node view components ---------------------------------------------------

/**
 * `code_block` view: mermaid fences render as a read-only diagram preview
 * (click to edit, ✕ to delete); other code blocks render as standard
 * pre/code with editable content.
 */
export const CodeBlockView = forwardRef<HTMLElement, NodeViewComponentProps>(
  function CodeBlockView({ children, nodeProps, ...props }, ref) {
    const { onEditMermaid, onDeleteMermaid } = useSpecEditorContext();
    const { node, getPos, contentDOMRef } = nodeProps;
    const params = typeof node.attrs.params === 'string' ? node.attrs.params.trim() : '';
    const isMermaid = params === 'mermaid';
    const source = node.textContent;

    const setLanguage = useEditorEventCallback((view, language: string) => {
      view.dispatch(view.state.tr.setNodeMarkup(getPos(), undefined, { params: language }));
      view.focus();
    });
    // Label for the Auto option — what highlight.js currently guesses.
    const detected = useMemo(
      () => (isMermaid || params ? undefined : detectLanguage(source)),
      [isMermaid, params, source],
    );

    if (!isMermaid) {
      const knownLanguage = !params || CODE_LANGUAGES.includes(params);
      return (
        <div
          {...props}
          // eslint-disable-next-line no-restricted-syntax -- DOM ref boundary: react-prosemirror hands us an element-agnostic ref
          ref={ref as Ref<HTMLDivElement>}
          className={`spec-code-block ${typeof props.className === 'string' ? props.className : ''}`}
        >
          <select
            className="spec-code-lang"
            contentEditable={false}
            value={params}
            title="Syntax highlighting language"
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="">{detected ? `auto · ${detected}` : 'auto'}</option>
            {!knownLanguage && <option value={params}>{params}</option>}
            {CODE_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
          <pre>
            <code ref={contentDOMRef}>{children}</code>
          </pre>
        </div>
      );
    }
    return (
      <div
        {...props}
        // eslint-disable-next-line no-restricted-syntax -- DOM ref boundary: react-prosemirror hands us an element-agnostic ref
        ref={ref as Ref<HTMLDivElement>}
        className="mermaid-preview"
        contentEditable={false}
        onClick={() => onEditMermaid(getPos(), source)}
      >
        <button
          type="button"
          className="mermaid-preview-delete"
          title="Delete diagram"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteMermaid(getPos());
          }}
        >
          ✕
        </button>
        <div className="mermaid-preview-overlay">Edit diagram</div>
        <div className="mermaid-preview-rf">
          <PreviewErrorBoundary resetKey={source}>
            <MermaidPreview source={source} />
          </PreviewErrorBoundary>
        </div>
      </div>
    );
  },
);

function isAbsoluteSrc(src: string): boolean {
  return /^(https?:|data:|blob:|\/)/i.test(src);
}

/**
 * `image` view: the markdown stores copy-relative paths (e.g.
 * `attachments/diagram.png`, what the coding agent sees on disk); this
 * rewrites them to the copy-files raw endpoint for display. Absolute
 * URLs render untouched.
 */
export const ImageView = forwardRef<HTMLImageElement, NodeViewComponentProps>(
  function ImageView({ children: _children, nodeProps, ...props }, ref) {
    const { copy, bpId } = useSpecEditorContext();
    const { node } = nodeProps;
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
    const resolved =
      !src || isAbsoluteSrc(src) ? src : api.copyFiles.rawUrl(copy, `${bpId}/${src}`);
    const alt = typeof node.attrs.alt === 'string' && node.attrs.alt ? node.attrs.alt : src;
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : undefined;
    return (
      <img
        {...props}
        ref={ref}
        src={resolved}
        alt={alt}
        {...(title ? { title } : {})}
        contentEditable={false}
      />
    );
  },
);

/**
 * Stable module-level map, as react-prosemirror requires. Components get
 * per-editor data via {@link SpecEditorContext}.
 */
export const specNodeViewComponents = {
  code_block: CodeBlockView,
  image: ImageView,
};
