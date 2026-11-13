import { McpTaskStore } from "../../src/mcp/task-store.ts";

const store = new McpTaskStore("restart-probe");
const action = process.argv[2];
let task;
if (action === "read") task = await store.get(process.argv[3]);
else {
  task = await store.create();
  if (action === "complete") task = await store.complete(task.taskId, {
    resultType: "complete", content: [{ type: "text", text: "durable result" }],
    _meta: { "ai.agent-connector.ave/rawResult": { retained: true } },
  });
}
console.log(JSON.stringify(task));
