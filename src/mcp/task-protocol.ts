/** Wire contract: ext-tasks v0.2.3, cc9aaac1047a9440b07486e38f37060bbebeef4c, schema/2026-07-28. */
import { z } from "zod";
import { sleep, raceWithTimeout } from "../shared/abortable-deadline.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const TASK_POLL_INTERVAL_MS = 250;

const TaskFieldsSchema = z.object({
  taskId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  lastUpdatedAt: z.iso.datetime({ offset: true }),
  ttlMs: z.number().int().nullable(),
  pollIntervalMs: z.number().int().optional(),
  statusMessage: z.string().optional(),
});
const TaskStatusSchema = z.enum(["working", "input_required", "completed", "failed", "cancelled"]);
const TaskErrorSchema = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
export const DetailedTaskSchema = z.discriminatedUnion("status", [
  TaskFieldsSchema.extend({ status: z.literal("working") }),
  TaskFieldsSchema.extend({ status: z.literal("input_required"), inputRequests: z.record(z.string(), z.unknown()) }),
  TaskFieldsSchema.extend({ status: z.literal("completed"), result: z.record(z.string(), z.unknown()) }),
  TaskFieldsSchema.extend({ status: z.literal("failed"), error: TaskErrorSchema }),
  TaskFieldsSchema.extend({ status: z.literal("cancelled") }),
]);
export type DetailedTask = z.infer<typeof DetailedTaskSchema>;
const CreateTaskResultSchema = TaskFieldsSchema.extend({ resultType: z.literal("task"), status: TaskStatusSchema });

/** Both host clients consume the same flat task envelope and nested terminal result. */
export async function awaitMcpTask(
  createResult: unknown,
  request: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const created = CreateTaskResultSchema.parse(createResult);
  const deadline = Date.now() + timeoutMs;
  let interval = created.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Task '${created.taskId}' timed out`);
      const response = await raceWithTimeout(
        request("tasks/get", { taskId: created.taskId }, remaining), remaining,
        () => new Error(`Task '${created.taskId}' timed out`),
      );
      if (!response || typeof response !== "object" || (response as Record<string, unknown>).resultType !== "complete") {
        throw new Error("Invalid tasks/get result type");
      }
      const task = DetailedTaskSchema.parse(response);
      if (task.taskId !== created.taskId) throw new Error("Task response identifier mismatch");
      if (task.status === "completed") return task.result;
      if (task.status === "failed" || task.status === "cancelled") {
        throw new Error(`Task '${task.taskId}' ended '${task.status}'${task.status === "failed" ? `: ${task.error.message}` : ""}`);
      }
      if (task.status === "input_required") throw new Error("Task input requests are unsupported");
      interval = task.pollIntervalMs ?? interval;
      await sleep(Math.min(Math.max(100, interval), Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    // Cancellation is ack-only and cooperative; a broken transport cannot hold error delivery forever.
    await raceWithTimeout(
      request("tasks/cancel", { taskId: created.taskId }, TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs),
      TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs, () => new Error("Task cancellation timed out"),
    ).catch(() => {});
    throw error;
  }
}
