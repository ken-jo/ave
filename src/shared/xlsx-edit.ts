export const XLSX_EDIT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  backupBytes: 8 * 1024 * 1024,
  maxValueChars: 32767,
});

export type XlsxCellValue = string | number | boolean | null;
