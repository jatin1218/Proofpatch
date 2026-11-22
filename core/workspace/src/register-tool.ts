import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

type Inputs<S extends z.ZodRawShape> = { [K in keyof S]: z.output<S[K]> };
type Register = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: Inputs<S>) => Promise<CallToolResult>,
) => void;

// Select the four-argument SDK overload once. The SDK still parses each
// request with its original Zod schema before invoking the handler.
export function registrationFor(server: McpServer): Register {
  const register = server.tool as unknown as Register;
  return register.bind(server);
}
