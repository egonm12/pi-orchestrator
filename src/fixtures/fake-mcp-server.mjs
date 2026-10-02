// A fake MCP server for tests: newline-delimited JSON-RPC over stdio, as pi's
// stdio transport speaks it, with no network. It offers `lookup`, which does
// not say whether it changes anything, and `peek`, which declares itself
// read-only. A call answers with the tool's name.
import { createInterface } from "node:readline";

const TOOLS = [
  { name: "lookup", description: "Looks something up.", inputSchema: { type: "object", properties: {} } },
  { name: "peek", description: "Peeks at something.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } } });
  } else if (method === "tools/list") {
    send({ id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    send({ id, result: { content: [{ type: "text", text: `called ${params.name}` }] } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `no method ${method}` } });
  }
});
