export type NativeAction = "hover" | "drag" | "slider" | "select" | "scroll" | "screenshot" | "upload" | "cancel-upload" | "submit" | "navigate" | "select-navigation" | "resume" | "hold-control" | "edit-original";

export interface NativeOracle {
  readonly hover: number;
  readonly dragStarted: number;
  readonly dropped: string;
  readonly humanClicks: number;
  readonly selected: string;
  readonly slider: string;
  readonly upload: { name: string; bytes: number } | null;
  readonly uploadResponse: string | null;
  readonly scrollTop: number;
  readonly pageY: number;
  readonly viewport: { width: number; height: number };
  readonly content: { width: number; height: number };
  readonly humanPoint: { x: number; y: number };
  readonly bottom: { x: number; y: number; width: number; height: number };
  readonly url: string;
}

export interface NativeActionResult {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
  readonly value?: unknown;
  readonly oracle: NativeOracle;
  readonly mode: string;
  readonly generation: number;
  readonly owner: string | null;
  readonly received: { bytes: string; name: string } | null;
  readonly focus: { window: boolean; guest: boolean; mainFrame: boolean; host: unknown };
  readonly nativeEvents: readonly { event: string; type: string; modifiers: number; raw?: Readonly<Record<string, unknown>> }[];
}

export interface NativeBrowserFixture {
  readonly ready: boolean;
  run(action: NativeAction): Promise<NativeActionResult>;
  read(): Promise<NativeActionResult>;
  close(): Promise<void>;
}
