import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { arrowHead, isTrivial, metrics, simplify, type AnnotationTool } from '../lib/annotations';
import { uid } from '../lib/id';
import type { Annotation } from '../lib/types';
import { cx } from './ui';

const HALO = 'rgba(0, 0, 0, 0.55)';
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

function Shape({ a, w, h, pass }: { a: Annotation; w: number; h: number; pass: 'halo' | 'ink' | 'hit' }) {
  const m = metrics(w, h);
  const stroke = pass === 'halo' ? HALO : pass === 'hit' ? 'transparent' : a.color;
  const width = pass === 'halo' ? m.halo : pass === 'hit' ? m.halo * 3.2 : m.stroke;
  const common = { stroke, strokeWidth: width, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (a.kind) {
    case 'ellipse':
      return <ellipse cx={a.cx * w} cy={a.cy * h} rx={Math.max(1, a.rx * w)} ry={Math.max(1, a.ry * h)} {...common} />;
    case 'arrow': {
      const [x1, y1, x2, y2] = [a.x1 * w, a.y1 * h, a.x2 * w, a.y2 * h];
      const head = arrowHead(x1, y1, x2, y2, m.head);
      const bx = (head[1][0] + head[2][0]) / 2;
      const by = (head[1][1] + head[2][1]) / 2;
      return (
        <>
          <line x1={x1} y1={y1} x2={bx} y2={by} {...common} />
          <polygon points={head.map((p) => p.join(',')).join(' ')} {...common} fill={stroke} strokeWidth={pass === 'ink' ? 0 : width} />
        </>
      );
    }
    case 'pen': {
      const pts: string[] = [];
      for (let i = 0; i < a.points.length; i += 2) pts.push(`${a.points[i] * w},${a.points[i + 1] * h}`);
      return <polyline points={pts.join(' ')} {...common} />;
    }
    case 'text':
      return (
        <text
          x={a.x * w}
          y={a.y * h}
          fontFamily={FONT}
          fontWeight={600}
          fontSize={m.font}
          dominantBaseline="central"
          fill={pass === 'ink' ? a.color : pass === 'hit' ? 'transparent' : 'none'}
          stroke={pass === 'ink' ? 'none' : stroke}
          strokeWidth={pass === 'ink' ? 0 : m.font / 5}
          strokeLinejoin="round"
        >
          {a.text}
        </text>
      );
  }
}

interface Draft {
  tool: 'ellipse' | 'arrow' | 'pen';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  square: boolean;
  points: number[];
}

function draftToAnnotation(d: Draft, color: string, w: number, h: number): Annotation {
  const id = uid();
  if (d.tool === 'pen') return { id, kind: 'pen', color, points: simplify(d.points) };
  if (d.tool === 'arrow') return { id, kind: 'arrow', color, x1: d.x0, y1: d.y0, x2: d.x1, y2: d.y1 };
  let rx = Math.abs(d.x1 - d.x0) / 2;
  let ry = Math.abs(d.y1 - d.y0) / 2;
  let cx0 = (d.x0 + d.x1) / 2;
  let cy0 = (d.y0 + d.y1) / 2;
  if (d.square) {
    // Shift draws a true circle, measured in pixels rather than fractions.
    const r = Math.max(rx * w, ry * h);
    rx = r / w;
    ry = r / h;
    cx0 = d.x0 + Math.sign(d.x1 - d.x0 || 1) * rx;
    cy0 = d.y0 + Math.sign(d.y1 - d.y0 || 1) * ry;
  }
  return { id, kind: 'ellipse', color, cx: cx0, cy: cy0, rx, ry };
}

/**
 * The marks on a photo, as an SVG that sits exactly over it. Read-only unless
 * a `tool` is given, in which case dragging draws and (with the eraser)
 * clicking a mark removes it.
 */
export function AnnotationLayer({
  width,
  height,
  annotations,
  tool,
  color = '#FFD60A',
  onAdd,
  onRemove,
  onText,
}: {
  width: number;
  height: number;
  annotations: Annotation[];
  tool?: AnnotationTool | null;
  color?: string;
  onAdd?: (a: Annotation) => void;
  onRemove?: (id: string) => void;
  /** The text tool was clicked at this point (fractions of the photo, and screen position). */
  onText?: (at: { x: number; y: number; clientX: number; clientY: number; scale: number }) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const interactive = !!tool;

  const at = (e: { clientX: number; clientY: number }): [number, number, DOMRect] => {
    const r = svg.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height), r];
  };
  const update = (d: Draft | null) => {
    draftRef.current = d;
    setDraft(d);
  };

  const onPointerDown = (e: RPointerEvent) => {
    if (!tool || e.button !== 0 || tool === 'erase' || tool === 'text') return;
    const [x, y] = at(e);
    svg.current?.setPointerCapture(e.pointerId);
    update({ tool, x0: x, y0: y, x1: x, y1: y, square: e.shiftKey, points: [x, y] });
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = draftRef.current;
    if (!d) return;
    const [x, y] = at(e);
    update({ ...d, x1: x, y1: y, square: e.shiftKey, points: d.tool === 'pen' ? [...d.points, x, y] : d.points });
  };
  const finish = (commit: boolean) => {
    const d = draftRef.current;
    update(null);
    if (!d || !commit) return;
    const a = draftToAnnotation(d, color, width, height);
    if (!isTrivial(a)) onAdd?.(a);
  };

  const preview = draft ? draftToAnnotation(draft, color, width, height) : null;
  const all = preview ? [...annotations, preview] : annotations;

  return (
    <svg
      ref={svg}
      className={cx('anno-layer', interactive && 'is-drawing', tool && `tool-${tool}`)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      // Text is placed on click (after the button is released), so the label's input keeps the focus it is given.
      onClick={(e) => {
        if (tool !== 'text') return;
        const [x, y, r] = at(e);
        onText?.({ x, y, clientX: e.clientX, clientY: e.clientY, scale: r.width / width });
      }}
      aria-hidden={!interactive}
    >
      <g>
        {all.map((a) => (
          <Shape key={`h-${a.id}`} a={a} w={width} h={height} pass="halo" />
        ))}
      </g>
      <g>
        {all.map((a) => (
          <Shape key={`i-${a.id}`} a={a} w={width} h={height} pass="ink" />
        ))}
      </g>
      {tool === 'erase' && (
        <g className="anno-hits">
          {annotations.map((a) => (
            <g
              key={`x-${a.id}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                onRemove?.(a.id);
              }}
            >
              <Shape a={a} w={width} h={height} pass="hit" />
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
