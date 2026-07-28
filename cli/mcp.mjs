import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAccessToken } from "./oauth.mjs";

// MCP client for the CLI's `mcp` commands. It speaks the real Model Context
// Protocol (Streamable HTTP, JSON-RPC) to /api/mcp/mcp, authenticating with an
// OAuth access token bound to the "mcp" audience. This is the CLI sitting
// directly "above" the MCP surface, using the same tools an AI assistant would.

/** Open an authenticated MCP session, run fn(client), and always close it. */
export async function withMcp(base, fn) {
  const token = await getAccessToken(base, "mcp");
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: "lettertrace-cli", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listTools(base) {
  return withMcp(base, async (client) => (await client.listTools()).tools ?? []);
}

export async function callTool(base, name, args) {
  return withMcp(base, (client) => client.callTool({ name, arguments: args ?? {} }));
}

/** Flatten an MCP tool result's content blocks into printable text. */
export function renderToolResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { text, isError: Boolean(result?.isError) };
}
