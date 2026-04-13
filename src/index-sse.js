#!/usr/bin/env node
/**
 * ClickMassa MCP — transporte HTTP/SSE (multi-tenant)
 * Engine core para plataforma GapHub-Ai
 *
 * MULTI-TENANT (Option B): credenciais passadas por request, sem .env por cliente.
 * Cada conexão SSE pode trazer suas próprias credenciais via:
 *   - Query params: ?base_url=...&token=...&canal_id=...
 *   - Headers:      x-clickmassa-base-url, x-clickmassa-token, x-clickmassa-canal-id
 *   - Fallback:     variáveis de ambiente do processo (útil para instância single-tenant)
 *
 * Endpoints disponíveis:
 *   GET  /sse         - Abre conexão SSE (MCP transport)
 *   POST /message     - Envia mensagem MCP para sessão ativa
 *   GET  /health      - Health check
 *   GET  /info        - Lista capacidades e versão
 *
 * Execução:
 *   PORT=3100 node src/index-sse.js
 *
 * Conexão no n8n (MCP Client node):
 *   Transport: SSE
 *   URL: http://SEU_SERVIDOR:3100/sse?base_url=https://appapi.empresa.com.br&token=TOKEN
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "http";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as path from "path";
import { registerTools } from "./tools.js";

try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  dotenv.config({ path: path.join(__dirname, "../.env"), quiet: true });
} catch (_) {}

const PORT                = parseInt(process.env.PORT || "3100", 10);
const DEFAULT_BASE_URL    = process.env.CLICKMASSA_BASE_URL      || "";
const DEFAULT_TOKEN       = process.env.CLICKMASSA_TOKEN         || "";
const DEFAULT_CANAL_ID    = process.env.CLICKMASSA_CANAL_ID      || "";
const DEFAULT_EMAIL       = process.env.CLICKMASSA_EMAIL         || "";
const DEFAULT_PASSWORD    = process.env.CLICKMASSA_PASSWORD      || "";
const DEFAULT_SUPER_API   = process.env.CLICKMASSA_SUPER_API_URL || ""; // Opcional

// ─── Registro de sessões SSE ativas ─────────────────────────────────────────
const transports = {}; // sessionId → SSEServerTransport
let totalConnections = 0;
let activeConnections = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extractCreds(req, url) {
  const q = url.searchParams;
  const h = req.headers;
  return {
    baseUrl:    q.get("base_url")    || h["x-clickmassa-base-url"]    || DEFAULT_BASE_URL,
    token:      q.get("token")       || h["x-clickmassa-token"]       || DEFAULT_TOKEN,
    canalId:    q.get("canal_id")    || h["x-clickmassa-canal-id"]    || DEFAULT_CANAL_ID,
    email:      q.get("email")       || h["x-clickmassa-email"]       || DEFAULT_EMAIL,
    password:   q.get("password")    || h["x-clickmassa-password"]    || DEFAULT_PASSWORD,
    superApiUrl: q.get("super_api_url") || h["x-clickmassa-super-api-url"] || DEFAULT_SUPER_API || undefined,
  };
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-clickmassa-base-url, x-clickmassa-token, x-clickmassa-canal-id, x-clickmassa-email, x-clickmassa-password, x-clickmassa-super-api-url"
  );
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  setCorsHeaders(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /sse — Abre conexão MCP SSE ────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/sse") {
    const creds = extractCreds(req, url);

    if (!creds.baseUrl || !creds.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Credenciais ausentes",
        details: "Forneça base_url e token via query params ou headers x-clickmassa-*",
        example: "/sse?base_url=https://appapi.flemy.com.br&token=SEU_TOKEN&canal_id=SEU_CANAL"
      }));
      return;
    }

    // credsFn é closure sobre as creds desta conexão (multi-tenant isolado)
    const credsFn = () => creds;

    const mcpServer = new McpServer({ name: "clickmassa", version: "2.1.0" });
    registerTools(mcpServer, credsFn);

    const transport = new SSEServerTransport("/message", res);
    transports[transport.sessionId] = transport;
    totalConnections++;
    activeConnections++;

    process.stderr.write(
      `[clickmassa-mcp-sse] Nova conexão: ${transport.sessionId} | tenant: ${creds.baseUrl} | ativas: ${activeConnections}\n`
    );

    await mcpServer.connect(transport);

    res.on("close", () => {
      delete transports[transport.sessionId];
      activeConnections--;
      process.stderr.write(`[clickmassa-mcp-sse] Conexão encerrada: ${transport.sessionId} | ativas: ${activeConnections}\n`);
    });
    return;
  }

  // ── POST /message — Recebe mensagem MCP ────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/message") {
    const sessionId = url.searchParams.get("sessionId");
    const transport = transports[sessionId];

    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sessão não encontrada", sessionId }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        await transport.handlePostMessage(req, res, JSON.parse(body));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      server: "clickmassa-mcp-sse",
      version: "2.1.0",
      uptime: process.uptime(),
      connections: { active: activeConnections, total: totalConnections },
    }));
    return;
  }

  // ── GET /info ───────────────────────────────────────────────────────────────
  if (url.pathname === "/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "clickmassa-mcp-sse",
      version: "2.1.0",
      description: "ClickMassa CRM MCP Server — Engine multi-tenant para GapHub-Ai",
      transport: "SSE",
      multiTenant: true,
      authMethod: "query-params ou headers x-clickmassa-*",
      endpoints: {
        sse: "GET /sse?base_url=URL&token=TOKEN&canal_id=CANAL",
        message: "POST /message?sessionId=SESSION_ID",
        health: "GET /health",
        info: "GET /info",
      },
      tools: [
        // Contatos
        "buscar_contato_por_numero", "buscar_contato_por_id", "listar_contatos",
        "criar_contato", "atualizar_contato", "adicionar_etiquetas", "remover_todas_etiquetas",
        // Mensagens
        "enviar_mensagem_direta", "enviar_mensagem", "enviar_midia", "enviar_nota_interna",
        // Tickets
        "escalar_para_atendente", "devolver_para_fila", "escalar_para_departamento",
        "fechar_ticket", "listar_tickets_pendentes", "listar_tickets_abertos",
        // Lookups
        "listar_etiquetas", "listar_atendentes", "listar_origens_lead", "listar_status_lead",
        // Tarefas
        "listar_tarefas", "criar_tarefa",
        // Chatbot / Funis
        "listar_fluxos_chat", "atribuir_fluxo_chat",
        "verificar_chamadas_perdidas", "listar_funis", "atribuir_funil_contato",
        "listar_conexoes_whatsapp", "criar_funil",
        // Push Events
        "listar_eventos_push", "criar_evento_push",
        // Utilitários v2.1 (5 novas)
        "listar_pipelines", "listar_filas", "listar_motivos_fechamento",
        "listar_oportunidades", "verificar_blacklist",
        // Ferramentas de agente v2.0 (12 novas)
        "obter_resumo_lead", "buscar_historico_ticket", "transferir_para_humano",
        "registrar_objecao", "qualificar_lead", "criar_nota_interna",
        "adicionar_tag", "remover_tag", "agendar_followup",
        "verificar_disponibilidade", "registrar_venda", "atualizar_etapa_funil",
      ],
      totalTools: 49,
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: url.pathname }));
});

// ─── Start ───────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  process.stderr.write(
    `[clickmassa-mcp-sse] ✓ Rodando em http://0.0.0.0:${PORT} (v2.1.0 multi-tenant)\n` +
    `[clickmassa-mcp-sse] ✓ SSE: http://0.0.0.0:${PORT}/sse?base_url=URL&token=TOKEN\n` +
    `[clickmassa-mcp-sse] ✓ Health: http://0.0.0.0:${PORT}/health\n`
  );
});
