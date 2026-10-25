#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverTools, type ToolWithDefinition } from "./lib/tools.ts";
import pkg from "./package.json" with { type: "json" };

const SERVER_NAME = process.env.SERVER_NAME || pkg.name;
const SERVER_VERSION = process.env.SERVER_VERSION || pkg.version;

function transformTools(tools: ToolWithDefinition[]): Tool[] {
    return tools
        .map((tool) => {
            const fn = tool.definition?.function;
            if (!fn) return undefined;
            return {
                name: fn.name,
                description: fn.description,
                inputSchema: fn.parameters,
            } as Tool;
        })
        .filter((t): t is Tool => t !== undefined);
}

function setupServerHandlers(server: Server, tools: ToolWithDefinition[], transformedTools: Tool[]) {
    const toolMap = new Map(tools.map((tool) => [tool.definition.function.name, tool]));

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: transformedTools,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const tool = toolMap.get(toolName);
        if (!tool) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }
        const args = request.params.arguments || {};
        const requiredParameters = tool.definition?.function?.parameters?.required || [];
        for (const requiredParameter of requiredParameters) {
            if (!(requiredParameter in args)) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Missing required parameter: ${requiredParameter}`,
                );
            }
        }
        try {
            const result = await tool.function(args);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        } catch (error: any) {
            console.error("[Error] Failed to fetch data:", error);
            throw new McpError(ErrorCode.InternalError, `API error: ${error.message}`);
        }
    });
}

async function run() {
    const tools = await discoverTools();
    const transformedTools = transformTools(tools);

    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
    );
    server.onerror = (error) => console.error("[Error]", error);
    setupServerHandlers(server, tools, transformedTools);

    process.on("SIGINT", async () => {
        await server.close();
        process.exit(0);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

run().catch(console.error);
