/** A complete `text/event-stream` response of JSON `data:` events, as an SDK stream reader consumes it. */
export function sseResponse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
