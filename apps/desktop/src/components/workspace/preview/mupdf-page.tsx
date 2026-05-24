import { useEffect, useRef, useState, useCallback, memo } from "react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { createLogger } from "@/lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import type { StructuredTextData, LinkData } from "@/lib/mupdf/types";

const log = createLogger("mupdf-page");

interface MupdfPageProps {
  docId: number;
  pageIndex: number;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  isVisible: boolean;
}

/** Check if a canvas appears blank (GPU context was silently invalidated).
 *  Uses a single getImageData call covering a small center region. */
function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return true; // context fully lost
  // Sample a 2x2 region from the center in one GPU readback
  const cx = Math.max(0, Math.floor(canvas.width / 2) - 1);
  const cy = Math.max(0, Math.floor(canvas.height / 2) - 1);
  const data = ctx.getImageData(cx, cy, 2, 2).data;
  // If all sampled pixels have zero alpha, canvas is blank
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

export const MupdfPage = memo(function MupdfPage({
  docId,
  pageIndex,
  scale,
  pageWidth,
  pageHeight,
  isVisible,
}: MupdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [textData, setTextData] = useState<StructuredTextData | null>(null);
  const [links, setLinks] = useState<LinkData[]>([]);
  const renderGenRef = useRef(0);

  const cssW = pageWidth * scale;
  const cssH = pageHeight * scale;

  /** Re-render the page onto the canvas via MuPDF worker. */
  const renderPage = useCallback(() => {
    if (!isVisible || docId <= 0) return;

    const gen = ++renderGenRef.current;
    const client = getMupdfClient();
    const dpr = window.devicePixelRatio || 1;
    const dpi = scale * 72 * dpr;

    client
      .drawPage(docId, pageIndex, dpi)
      .then(async (imageData) => {
        if (gen !== renderGenRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const bitmap = await createImageBitmap(imageData);
        if (gen !== renderGenRef.current) {
          bitmap.close();
          return;
        }
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch((err) => {
        if (gen !== renderGenRef.current) return;
        log.error(`Render error page ${pageIndex}`, { error: String(err) });
      });
  }, [docId, pageIndex, scale, isVisible]);

  // Initial render and re-render on dependency changes
  useEffect(() => {
    if (!isVisible || docId <= 0) return;

    renderPage();

    const client = getMupdfClient();
    const gen = renderGenRef.current;

    client
      .getPageText(docId, pageIndex)
      .then((data) => {
        if (gen !== renderGenRef.current) return;
        setTextData(data);
      })
      .catch(() => {});

    client
      .getPageLinks(docId, pageIndex)
      .then((data) => {
        if (gen !== renderGenRef.current) return;
        setLinks(data);
      })
      .catch(() => {});
  }, [docId, pageIndex, scale, isVisible, renderPage]);

  // Re-render canvas when returning from background if content was lost
  useEffect(() => {
    const handleVisibilityRestored = () => {
      const canvas = canvasRef.current;
      if (!canvas || !isVisible || docId <= 0) return;
      if (isCanvasBlank(canvas)) {
        log.warn(
          `Canvas blank after visibility restore, re-rendering page ${pageIndex}`,
        );
        renderPage();
      }
    };

    window.addEventListener(APP_VISIBILITY_RESTORED, handleVisibilityRestored);
    return () =>
      window.removeEventListener(
        APP_VISIBILITY_RESTORED,
        handleVisibilityRestored,
      );
  }, [docId, pageIndex, scale, isVisible, renderPage]);

  return (
    <div
      className="mupdf-page relative mb-4 shadow-lg"
      data-page-number={pageIndex + 1}
      style={{ width: cssW, height: cssH }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: cssW, height: cssH, display: "block" }}
      />

      {/* Text layer for selection (HTML-based; WKWebView SVG selection is unreliable) */}
      {textData && (
        <div className="mupdf-text-layer">
          <div
            className="mupdf-text-layer-inner"
            style={{
              width: `${pageWidth}px`,
              height: `${pageHeight}px`,
              transform: `scale(${scale})`,
            }}
          >
            {textData.blocks.map(
              (block, bi) =>
                block.type === "text" &&
                block.lines.map((line, li) => {
                  const targetW = line.bbox.w > 0 ? line.bbox.w : undefined;
                  return (
                    <span
                      key={`${bi}-${li}`}
                      ref={(el) => {
                        if (!el || !targetW) return;
                        // Fit rendered width to the PDF's bbox width.
                        // requestAnimationFrame so layout has settled.
                        requestAnimationFrame(() => {
                          const measured = el.getBoundingClientRect().width;
                          if (measured > 0) {
                            const sx = targetW / (measured / scale);
                            el.style.transform = `scaleX(${sx})`;
                          }
                        });
                      }}
                      className="mupdf-text-line"
                      style={{
                        left: `${line.bbox.x}px`,
                        top: `${line.y - line.font.size * 0.8}px`,
                        fontSize: `${line.font.size}px`,
                        fontFamily:
                          line.font.family || line.font.name || "serif",
                      }}
                    >
                      {line.text}
                    </span>
                  );
                }),
            )}
          </div>
        </div>
      )}

      {/* Link layer */}
      {links.length > 0 && (
        <div className="mupdf-link-layer">
          {links.map((link, i) => (
            <a
              key={i}
              href={link.href}
              data-external={link.isExternal ? "true" : undefined}
              style={{
                left: `${(link.x / pageWidth) * 100}%`,
                top: `${(link.y / pageHeight) * 100}%`,
                width: `${(link.w / pageWidth) * 100}%`,
                height: `${(link.h / pageHeight) * 100}%`,
              }}
            >
              <span className="sr-only">Link</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
});
