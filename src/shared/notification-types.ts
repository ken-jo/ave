export const NOTIFICATION_HISTORY_LIMIT = 50;

export type NotificationKind = "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "alert" | "system";

export interface NotificationContextRef {
  sessionId?: string;
  routineId?: string;
  questionId?: string;
  approvalId?: string;
}

/** Session identity and arrival time remain unchanged when history is restored. */
export interface NotificationToastPayload {
  id: string;
  createdAt: number;
  kind: NotificationKind;
  title: string;
  body: string;
  contextRef?: NotificationContextRef;
  sticky?: true;
}

export interface NotificationClickPayload {
  kind: NotificationKind;
  contextRef?: NotificationContextRef;
}
