#!/usr/bin/env bun
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contextFromEnv } from "./context.js";
import { buildServer } from "./server.js";

// stdout carries the protocol, so everything human-readable goes to stderr.
const ctx = contextFromEnv(process.env);
const server = buildServer(ctx);
await server.connect(new StdioServerTransport());
console.error(
  `recall-debitrail MCP ready on ${ctx.network}. ` +
    (ctx.operatorAddress ? `Operator wallet ${ctx.operatorAddress}.` : "No RECALL_OPERATOR_KEY: read-only tools only."),
);
