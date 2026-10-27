import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** An MCP client signed in with the token, talking to /mcp on the test server. */
export async function mcpClient(baseUrl: string, token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return {
    client,
    /**
     * Calls a tool and returns its JSON payload plus whether it was an error. Input that fails the
     * tool's schema is rejected by the SDK with plain text, returned as `text`.
     */
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      const text = content!.text;
      const isError = result.isError === true;
      return text.startsWith('{')
        ? { isError, data: JSON.parse(text) }
        : { isError, data: { text } };
    },
    close: () => client.close(),
  };
}
