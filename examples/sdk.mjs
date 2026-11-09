import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connect(name, url, token, fetcher) {
  const client = new Client({ name, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    ...(fetcher && { fetch: fetcher })
  });
  await client.connect(transport);
  return client;
}

export async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.structuredContent?.error ?? 'MCP tool failed');
  return result.structuredContent;
}
