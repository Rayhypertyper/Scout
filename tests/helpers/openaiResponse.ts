export function openAIEnvelope(value: unknown, status = "completed", text = JSON.stringify(value)): object {
  return {
    status,
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    }],
  };
}

export function openAIResponse(value: unknown, status = "completed"): Response {
  return new Response(JSON.stringify(openAIEnvelope(value, status)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
