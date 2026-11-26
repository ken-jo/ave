import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import { TableDocumentError } from "./table-document-error.js";

const PDF_RASTER_FONT = /^(?:10px sans-serif|(?:normal|italic) (?:normal|bold|900) \d+(?:\.\d+)?px "[\w-]+", (?:sans-serif|serif|monospace))$/;

/** Outlined glyphs need no native font resolution. Apply canvas fonts when text actually uses them. */
export function deferPdfRasterFonts(context: SKRSContext2D): () => void {
  const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(context), "font");
  if (!native?.get || !native.set) {
    throw new TableDocumentError("renderer-unavailable", "The PDF raster font interface is unavailable.");
  }
  const getFont = native.get.bind(context);
  const setFont = native.set.bind(context);
  let pendingFont: string | undefined;
  const savedFonts: Array<string | undefined> = [];
  const applyFont = () => {
    if (pendingFont === undefined) return;
    setFont(pendingFont);
    pendingFont = undefined;
  };
  Object.defineProperty(context, "font", {
    get: () => pendingFont ?? getFont(),
    set(font: string) {
      // The renderer emits these valid shorthands. Delegate other strings to the native parser.
      if (PDF_RASTER_FONT.test(font)) pendingFont = font;
      else { applyFont(); setFont(font); }
    },
  });
  const { save, restore, measureText, fillText, strokeText } = context;
  context.save = () => { save.call(context); savedFonts.push(pendingFont); };
  context.restore = () => {
    restore.call(context);
    if (savedFonts.length > 0) pendingFont = savedFonts.pop();
  };
  context.measureText = (...args) => { applyFont(); return measureText.apply(context, args); };
  context.fillText = (...args) => { applyFont(); fillText.apply(context, args); };
  context.strokeText = (...args) => { applyFont(); strokeText.apply(context, args); };
  return () => { pendingFont = undefined; savedFonts.length = 0; };
}

interface PdfCanvasSurface {
  canvas: Canvas | null;
  context: SKRSContext2D | null;
  resetFont: () => void;
}

export function pdfRasterCanvasFactory(createCanvas: (width: number, height: number) => Canvas) {
  return class PdfRasterCanvasFactory {
    create(width: number, height: number): PdfCanvasSurface {
      if (width <= 0 || height <= 0) throw new Error("Invalid PDF raster size.");
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      return { canvas, context, resetFont: deferPdfRasterFonts(context) };
    }

    reset(surface: PdfCanvasSurface, width: number, height: number): void {
      if (!surface.canvas || width <= 0 || height <= 0) throw new Error("Invalid PDF raster size.");
      surface.canvas.width = width;
      surface.canvas.height = height;
      surface.resetFont();
    }

    destroy(surface: PdfCanvasSurface): void {
      if (!surface.canvas) throw new Error("Missing PDF raster surface.");
      surface.canvas.width = surface.canvas.height = 0;
      surface.resetFont();
      surface.canvas = null;
      surface.context = null;
    }
  };
}
