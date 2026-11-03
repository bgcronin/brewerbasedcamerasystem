import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { cx } from './ui';

export interface ZoomState {
  zoom: number;
  x: number;
  y: number;
}

export const ZOOM_FIT: ZoomState = { zoom: 1, x: 0, y: 0 };

/**
 * Image viewer with wheel / pinch zoom around the pointer, drag to pan and
 * double-click to toggle between fit and 1:1 pixels. Controlled, so two panes
 * can share one state for synchronised comparison.
 */
export function ZoomPane({
  src,
  naturalWidth,
  naturalHeight,
  view,
  onView,
  alt,
  className,
}: {
  src: string | null;
  naturalWidth: number;
  naturalHeight: number;
  view: ZoomState;
  onView: (v: ZoomState) => void;
  alt: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const drag = useRef<{ id: number; x: number; y: number; start: ZoomState } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale = Math.min(size.w / (naturalWidth || 1), size.h / (naturalHeight || 1));
  const maxZoom = Math.max(2, (1 / (fitScale || 1)) * 4);
  const dispW = naturalWidth * fitScale;
  const dispH = naturalHeight * fitScale;

  const clamp = useCallback(
    (v: ZoomState): ZoomState => {
      const zoom = Math.min(maxZoom, Math.max(1, v.zoom));
      const limX = Math.max(0, (dispW * zoom - size.w) / 2);
      const limY = Math.max(0, (dispH * zoom - size.h) / 2);
      return { zoom, x: Math.min(limX, Math.max(-limX, v.x)), y: Math.min(limY, Math.max(-limY, v.y)) };
    },
    [maxZoom, dispW, dispH, size],
  );

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = box.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const px = clientX - r.left - r.width / 2;
      const py = clientY - r.top - r.height / 2;
      const v = viewRef.current;
      const zoom = Math.min(maxZoom, Math.max(1, v.zoom * factor));
      const qx = (px - v.x) / v.zoom;
      const qy = (py - v.y) / v.zoom;
      onView(clamp({ zoom, x: px - zoom * qx, y: py - zoom * qy }));
    },
    [clamp, maxZoom, onView],
  );

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.ctrlKey ? e.deltaY * 3 : e.deltaY; // trackpad pinch arrives as ctrl+wheel
      zoomAt(e.clientX, e.clientY, Math.exp(-delta * 0.0018));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: viewRef.current };
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    onView(clamp({ ...d.start, x: d.start.x + e.clientX - d.x, y: d.start.y + e.clientY - d.y }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const v = viewRef.current;
    if (v.zoom > 1.01) onView(ZOOM_FIT);
    else zoomAt(e.clientX, e.clientY, Math.max(2, 1 / (fitScale || 1)) / v.zoom);
  };

  return (
    <div
      ref={box}
      className={cx('zoom-pane', view.zoom > 1 && 'is-zoomed', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{
            width: dispW,
            height: dispH,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            imageRendering: view.zoom * fitScale >= 2 ? 'pixelated' : 'auto',
          }}
        />
      ) : (
        <div className="spinner" />
      )}
      {view.zoom > 1.01 && <span className="zoom-readout">{Math.round(view.zoom * fitScale * 100)}%</span>}
    </div>
  );
}
