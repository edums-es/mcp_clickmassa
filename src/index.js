#!/usr/bin/env node
/**
 * ClickMassa MCP — transporte STDIO (Claude Desktop / MCP local)
 * Single-tenant: credenciais lidas de variáveis de ambiente ou .env
 *
 * Configuração no claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "clickmassa": {
 *         "command": "node",
 *         "args": ["/caminho/para/clickmassa-mcp/src/index.js"],
 *         "env": {
 *           "CLICKMASSA_BASE_URL": "https://appapi.seudominio.com.br",
 *           "CLICKMASSA_TOKEN": "seu_token_aqui",
 *           "CLICKMASSA_CANAL_ID": "seu_canal_id",
 *           "CLICKMASSA_EMAIL": "admin@empresa.com",
 *           "CLICKMASSA_PASSWORD": "sua_senha"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as path from "path";
import { registerTools } from "./tools.js";

try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  dotenv.config({ path: path.join(__dirname, "../.env"), quiet: true });
} catch (_) {
  // Ignorar se não conseguir carregar o .env
}

// ─── Credenciais (single-tenant via ENV) ────────────────────────────────────
const BASE_URL  = process.env.CLICKMASSA_BASE_URL;
const TOKEN     = process.env.CLICKMASSA_TOKEN;
const CANAL_ID  = process.env.CLICKMASSA_CANAL_ID;
const EMAIL     = process.env.CLICKMASSA_EMAIL;
const PASSWORD  = process.env.CLICKMASSA_PASSWORD;

if (!BASE_URL || !TOKEN) {
  process.stderr.write(
    "[clickmassa-mcp] ERRO: defina CLICKMASSA_BASE_URL e CLICKMASSA_TOKEN no .env ou nas variáveis de ambiente\n"
  );
  process.exit(1);
}

// credsFn retorna as credenciais deste tenant (imutável no STDIO)
const credsFn = () => ({
  baseUrl:  BASE_URL,
  token:    TOKEN,
  canalId:  CANAL_ID,
  email:    EMAIL,
  password: PASSWORD,
});

// ─── Servidor MCP ────────────────────────────────────────────────────────────
const server = new McpServer({ name: "clickmassa", version: "2.1.0" });

// Registra todas as 49 ferramentas do módulo compartilhado
registerTools(server, credsFn);

// ─── Transporte STDIO ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[clickmassa-mcp] Servidor iniciado via STDIO (v2.1.0)\n");
