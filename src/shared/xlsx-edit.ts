export const XLSX_EDIT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  backupBytes: 8 * 1024 * 1024,
  maxValueChars: 32767,
});

export const WINDOWS_WORKBOOK_IDENTITY_ENV = "AVE_WINDOWS_WORKBOOK_IDENTITY";

export type XlsxCellValue = string | number | boolean | null;
