#!/usr/bin/env node
/**
 * ClickMassa MCP — transporte HTTP/SSE
 * Use este arquivo quando o n8n estiver em nuvem ou em servidor separado.
 *
 * Execução:
 *   PORT=3100 node src/index-sse.js
 *
 * No n8n MCP Client node:
 *   Transport: SSE
 *   URL: http://SEU_SERVIDOR:3100/sse
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "http";
import { z } from "zod";

const BASE_URL = process.env.CLICKMASSA_BASE_URL;
const TOKEN    = process.env.CLICKMASSA_TOKEN;
const CANAL_ID = process.env.CLICKMASSA_CANAL_ID;
const PORT     = parseInt(process.env.PORT || "3100");

if (!BASE_URL || !TOKEN) {
  process.stderr.write("[clickmassa-mcp-sse] ERRO: defina CLICKMASSA_BASE_URL e CLICKMASSA_TOKEN\n");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ClickMassa ${method} ${path} → ${res.status}: ${text}`);
  return data;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ─── Cria e registra tools (mesmas do index.js) ─────────────────────────────
function registerTools(server) {
  server.tool("buscar_contato_por_numero", "Busca contato pelo número de WhatsApp",
    { numero: z.string() },
    async ({ numero }) => ok(await api("GET", `/v1/contacts/number/${numero}`))
  );

  server.tool("buscar_contato_por_id", "Busca contato pelo ID interno",
    { id: z.string() },
    async ({ id }) => ok(await api("GET", `/v1/contacts/${id}`))
  );

  server.tool("listar_contatos", "Lista todos os contatos", {},
    async () => ok(await api("GET", "/v1/contacts/"))
  );

  server.tool("criar_contato", "Cria novo contato na ClickMassa",
    {
      nome:   z.string(),
      numero: z.string(),
      email:  z.string().optional(),
      tags:   z.array(z.string()).optional(),
      campos_customizados: z.record(z.string()).optional(),
    },
    async ({ nome, numero, email, tags, campos_customizados }) => {
      const body = { name: nome, number: numero };
      if (email) body.email = email;
      if (tags?.length) body.tags = tags;
      if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
      return ok(await api("POST", "/v1/contacts/", body));
    }
  );

  server.tool("atualizar_contato", "Atualiza dados de um contato",
    {
      id: z.string(),
      nome: z.string().optional(),
      email: z.string().optional(),
      tags: z.array(z.string()).optional(),
      campos_customizados: z.record(z.string()).optional(),
    },
    async ({ id, nome, email, tags, campos_customizados }) => {
      const body = {};
      if (nome)  body.name  = nome;
      if (email) body.email = email;
      if (tags)  body.tags  = tags;
      if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
      return ok(await api("PATCH", `/v1/contacts/${id}`, body));
    }
  );

  server.tool("adicionar_etiquetas", "Adiciona etiquetas sem apagar as existentes",
    { id: z.string(), tags: z.array(z.string()) },
    async ({ id, tags }) => ok(await api("PATCH", `/v1/contacts/${id}`, { tags }))
  );

  server.tool("remover_todas_etiquetas", "Zera as etiquetas de um contato",
    { id: z.string() },
    async ({ id }) => ok(await api("PATCH", `/v1/contacts/${id}`, { tags: [] }))
  );

  const enviaMsg = async ({ numero, mensagem, external_key, canal_id, extra = {} }) => {
    const cid = canal_id || CANAL_ID;
    if (!cid) throw new Error("Informe canal_id ou defina CLICKMASSA_CANAL_ID");
    return ok(await api("POST", `/v1/api/external/${cid}`, {
      number: numero, body: mensagem,
      externalKey: external_key || `mcp-${Date.now()}`,
      ...extra,
    }));
  };

  server.tool("enviar_mensagem", "Envia mensagem de texto ao cliente",
    {
      numero: z.string(), mensagem: z.string(),
      external_key: z.string().optional(), canal_id: z.string().optional(),
    },
    async (p) => enviaMsg(p)
  );

  server.tool("enviar_midia", "Envia arquivo/imagem via URL pública",
    { numero: z.string(), url_midia: z.string(), legenda: z.string().optional(), canal_id: z.string().optional() },
    async ({ numero, url_midia, legenda, canal_id }) =>
      enviaMsg({ numero, mensagem: legenda || "", canal_id, extra: { mediaUrl: url_midia } })
  );

  server.tool("enviar_nota_interna", "Envia nota interna (só atendentes veem)",
    { numero: z.string(), nota: z.string(), canal_id: z.string().optional() },
    async ({ numero, nota, canal_id }) =>
      enviaMsg({ numero, mensagem: "", canal_id, extra: { onlyNote: true, note: { body: nota } } })
  );

  server.tool("escalar_para_atendente", "Escala ticket para atendente humano",
    { numero: z.string(), mensagem: z.string().optional(), user_id: z.number(), canal_id: z.string().optional() },
    async ({ numero, mensagem, user_id, canal_id }) =>
      enviaMsg({ numero, mensagem: mensagem || "Transferindo...", canal_id,
        extra: { userId: user_id, forceTicketToUser: true } })
  );

  server.tool("escalar_para_departamento", "Escala ticket para fila/departamento",
    { numero: z.string(), mensagem: z.string().optional(), queue_id: z.string(), canal_id: z.string().optional() },
    async ({ numero, mensagem, queue_id, canal_id }) =>
      enviaMsg({ numero, mensagem: mensagem || "Transferindo...", canal_id,
        extra: { forceTicketToDepartment: true, queueId: queue_id } })
  );

  server.tool("fechar_ticket", "Fecha o ticket de atendimento",
    { numero: z.string(), closing_reason_id: z.number().optional(), canal_id: z.string().optional() },
    async ({ numero, closing_reason_id, canal_id }) => {
      const extra = { forceTicketToClosed: true };
      if (closing_reason_id) extra.closingReasonId = closing_reason_id;
      return enviaMsg({ numero, mensagem: "", canal_id, extra });
    }
  );

  server.tool("listar_etiquetas", "Lista etiquetas da conta", {},
    async () => ok(await api("GET", "/v1/labels"))
  );

  server.tool("listar_atendentes", "Lista atendentes da conta", {},
    async () => ok(await api("GET", "/v1/users"))
  );
}

// ─── HTTP Server com SSE ────────────────────────────────────────────────────
const transports = {};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/sse") {
    const server = new McpServer({ name: "clickmassa", version: "1.0.0" });
    registerTools(server);
    const transport = new SSEServerTransport("/message", res);
    transports[transport.sessionId] = transport;
    await server.connect(transport);
    res.on("close", () => delete transports[transport.sessionId]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/message") {
    const sessionId = url.searchParams.get("sessionId");
    const transport = transports[sessionId];
    if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        await transport.handlePostMessage(req, res, JSON.parse(body));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "clickmassa-mcp-sse" }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

httpServer.listen(PORT, () => {
  process.stderr.write(`[clickmassa-mcp-sse] Rodando em http://0.0.0.0:${PORT}/sse\n`);
});
