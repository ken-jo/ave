import { useEffect } from "react";

/** Block default file-drop navigation here because main permits file:// for the app itself; detect either Files type or a
 * nonempty file list and preserve non-file drags. */
export function useWindowFileDropGuard(): void {
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      return dt.types.includes("Files") || dt.files.length > 0;
    };
    const block = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
}
