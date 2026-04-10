#!/usr/bin/env node
/**
 * ClickMassa MCP — transporte HTTP/SSE
 * Use este arquivo quando o n8n estiver em nuvem ou em servidor separado.
 *
 * Execucao:
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
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as path from "path";

try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  dotenv.config({ path: path.join(__dirname, "../.env"), quiet: true });
} catch (e) {
  // Ignorar se nao conseguir carregar o dotenv
}

const BASE_URL = process.env.CLICKMASSA_BASE_URL;
const TOKEN = process.env.CLICKMASSA_TOKEN;
const CANAL_ID = process.env.CLICKMASSA_CANAL_ID;
const EMAIL = process.env.CLICKMASSA_EMAIL;
const PASSWORD = process.env.CLICKMASSA_PASSWORD;
const PORT = parseInt(process.env.PORT || "3100", 10);
const SUPER_API_URL = "https://superapi.clickmassa.com.br";

let userSessionToken = null;

if (!BASE_URL || !TOKEN) {
  process.stderr.write("[clickmassa-mcp-sse] ERRO: defina CLICKMASSA_BASE_URL e CLICKMASSA_TOKEN\n");
  process.exit(1);
}

async function getUserToken() {
  if (userSessionToken) return userSessionToken;
  if (!EMAIL || !PASSWORD) return TOKEN;

  try {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const text = await res.text();
    const data = JSON.parse(text);
    if (data.token) {
      userSessionToken = data.token;
      return userSessionToken;
    }
  } catch (e) {
    process.stderr.write(`[clickmassa-mcp-sse] Erro no auto-login: ${e.message}\n`);
  }

  return TOKEN;
}

async function api(method, requestPath, body) {
  const url = requestPath.startsWith("http") ? requestPath : `${BASE_URL}${requestPath}`;
  const activeToken = await getUserToken();
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${activeToken}`,
    },
  };

  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`ClickMassa ${method} ${requestPath} -> ${res.status}: ${text}`);
  }

  return data;
}

async function apiWithFallback(method, paths, body) {
  let lastError = null;

  for (const requestPath of paths) {
    try {
      return await api(method, requestPath, body);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function findTicketByNumber(numero) {
  const search = await api("GET", `/tickets?searchParam=${numero}&showAll=true`);
  const tickets = search.tickets || [];
  const exactTicket = tickets.find(
    (ticket) =>
      ticket.contact?.number === numero &&
      (ticket.status === "open" || ticket.status === "pending")
  );

  if (!exactTicket) {
    throw new Error(`Nenhum ticket aberto ou pendente encontrado para o numero ${numero}`);
  }

  return exactTicket;
}

async function sendExternalMessage({ numero, mensagem, external_key, canal_id, extra = {} }) {
  const cid = canal_id || CANAL_ID;
  if (!cid) {
    throw new Error("Informe canal_id ou defina CLICKMASSA_CANAL_ID");
  }

  return api("POST", `/v1/api/external/${cid}`, {
    number: numero,
    body: mensagem,
    externalKey: external_key || `mcp-${Date.now()}`,
    ...extra,
  });
}

function registerTools(server) {
  server.tool(
    "buscar_contato_por_numero",
    "Busca um contato na ClickMassa pelo numero de WhatsApp. Retorna id, nome, email, tags e campos customizados.",
    {
      numero: z.string().describe("Numero com DDI+DDD sem espacos ou caracteres especiais. Ex: 5527999990000"),
    },
    async ({ numero }) => ok(await api("GET", `/v1/contacts/number/${numero}`))
  );

  server.tool(
    "buscar_contato_por_id",
    "Busca um contato na ClickMassa pelo seu ID interno.",
    {
      id: z.string().describe("ID interno do contato na ClickMassa"),
    },
    async ({ id }) => ok(await api("GET", `/v1/contacts/${id}`))
  );

  server.tool(
    "listar_contatos",
    "Lista todos os contatos da conta ClickMassa.",
    {},
    async () => ok(await api("GET", "/v1/contacts/"))
  );

  server.tool(
    "criar_contato",
    "Cria um novo contato na ClickMassa.",
    {
      nome: z.string().describe("Nome completo do contato"),
      numero: z.string().describe("Numero WhatsApp com DDI+DDD. Ex: 5527999990000"),
      email: z.string().optional().describe("E-mail do contato (opcional)"),
      tags: z.array(z.string()).optional().describe("Lista de etiquetas (opcional)"),
      campos_customizados: z
        .record(z.string())
        .optional()
        .describe("Campos customizados em formato chave-valor."),
    },
    async ({ nome, numero, email, tags, campos_customizados }) => {
      const body = { name: nome, number: numero };
      if (email) body.email = email;
      if (tags?.length) body.tags = tags;
      if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
      return ok(await api("POST", "/v1/contacts/", body));
    }
  );

  server.tool(
    "atualizar_contato",
    "Atualiza dados de um contato existente na ClickMassa (nome, email, tags, leadStatusId ou leadOriginId).",
    {
      id: z.string().describe("ID interno do contato"),
      nome: z.string().optional(),
      email: z.string().optional(),
      leadStatusId: z.number().optional().describe("ID da fase do lead"),
      leadOriginId: z.number().optional().describe("ID da origem do lead"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Etiquetas a adicionar ao contato."),
      campos_customizados: z
        .record(z.string())
        .optional()
        .describe("Campos customizados. Preserve os existentes quando necessario."),
    },
    async ({ id, nome, email, leadStatusId, leadOriginId, tags, campos_customizados }) => {
      const body = { id: parseInt(id, 10) };
      if (nome) body.name = nome;
      if (email) body.email = email;
      if (leadStatusId) body.leadStatusId = leadStatusId;
      if (leadOriginId) body.leadOriginId = leadOriginId;
      if (tags) body.tags = tags;
      if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
      return ok(await api("PUT", `/contacts/${id}`, body));
    }
  );

  server.tool(
    "adicionar_etiquetas",
    "Adiciona etiquetas a um contato sem apagar as existentes.",
    {
      id: z.string().describe("ID do contato"),
      tags: z.array(z.string()).describe("Etiquetas a adicionar"),
    },
    async ({ id, tags }) => ok(await api("PATCH", `/v1/contacts/${id}`, { tags }))
  );

  server.tool(
    "remover_todas_etiquetas",
    "Remove todas as etiquetas de um contato.",
    {
      id: z.string().describe("ID do contato"),
    },
    async ({ id }) => ok(await api("PATCH", `/v1/contacts/${id}`, { tags: [] }))
  );

  server.tool(
    "enviar_mensagem_direta",
    "Envia uma mensagem de texto como o usuario logado, reutilizando o ticket ja aberto no CRM.",
    {
      numero: z.string().describe("Numero destino com DDI+DDD."),
      mensagem: z.string().describe("Texto a ser enviado"),
    },
    async ({ numero, mensagem }) => {
      const ticket = await findTicketByNumber(numero);
      return ok(await api("POST", `/messages/${ticket.id}`, { body: mensagem }));
    }
  );

  server.tool(
    "enviar_mensagem",
    "Envia uma mensagem de texto para um numero de WhatsApp via ClickMassa e cria ou reabre o ticket automaticamente.",
    {
      numero: z.string().describe("Numero destino com DDI+DDD. Ex: 5527999990000"),
      mensagem: z.string().describe("Texto a ser enviado ao cliente"),
      external_key: z.string().optional().describe("Chave de rastreio nos logs"),
      canal_id: z.string().optional().describe("ID do canal. Usa CLICKMASSA_CANAL_ID se omitido."),
    },
    async (params) => ok(await sendExternalMessage(params))
  );

  server.tool(
    "enviar_midia",
    "Envia um arquivo (imagem, PDF, audio, video) para um numero de WhatsApp via ClickMassa.",
    {
      numero: z.string().describe("Numero destino com DDI+DDD"),
      url_midia: z.string().describe("URL publica do arquivo a ser enviado"),
      legenda: z.string().optional().describe("Texto que acompanha a midia"),
      canal_id: z.string().optional(),
    },
    async ({ numero, url_midia, legenda, canal_id }) =>
      ok(
        await sendExternalMessage({
          numero,
          mensagem: legenda || "",
          canal_id,
          external_key: `mcp-media-${Date.now()}`,
          extra: { mediaUrl: url_midia },
        })
      )
  );

  server.tool(
    "enviar_nota_interna",
    "Envia uma nota interna (visivel apenas para atendentes) sem enviar nada ao cliente.",
    {
      numero: z.string().describe("Numero do contato vinculado ao ticket"),
      nota: z.string().describe("Texto da nota interna"),
      canal_id: z.string().optional(),
    },
    async ({ numero, nota, canal_id }) =>
      ok(
        await sendExternalMessage({
          numero,
          mensagem: "",
          canal_id,
          external_key: `mcp-note-${Date.now()}`,
          extra: { onlyNote: true, note: { body: nota } },
        })
      )
  );

  server.tool(
    "buscar_historico_ticket",
    "Busca o historico recente de mensagens de um ticket para entender mensagens picotadas ou contexto da conversa.",
    {
      numero: z.string().describe("Numero do cliente com DDI+DDD"),
      limite: z.number().optional().describe("Quantidade maxima de mensagens. Default: 20"),
    },
    async ({ numero, limite = 20 }) => {
      const ticket = await findTicketByNumber(numero);
      const msgRes = await api("GET", `/messages/${ticket.id}`);
      const messages = msgRes.messages || msgRes.data || (Array.isArray(msgRes) ? msgRes : []);
      return ok({
        ticketId: ticket.id,
        numero,
        historico: messages.slice(-limite).map((message) => ({
          id: message.id,
          body: message.body,
          fromMe: message.fromMe,
          mediaType: message.mediaType,
          createdAt: message.createdAt,
        })),
      });
    }
  );

  server.tool(
    "escalar_para_atendente",
    "Escala o atendimento para um atendente humano especifico sem enviar o ticket para destinos nulos.",
    {
      numero: z.string().describe("Numero do cliente"),
      user_id: z.number().describe("ID do atendente na ClickMassa"),
    },
    async ({ numero, user_id }) => {
      const ticket = await findTicketByNumber(numero);
      return ok(await api("PUT", `/tickets/${ticket.id}`, { userId: user_id }));
    }
  );

  server.tool(
    "devolver_para_fila",
    "Devolve um ticket para a fila de espera, removendo a atribuicao do atendente atual.",
    {
      numero: z.string().describe("Numero do cliente"),
    },
    async ({ numero }) => {
      const ticket = await findTicketByNumber(numero);
      return ok(await api("PUT", `/tickets/${ticket.id}`, { userId: null, status: "pending" }));
    }
  );

  server.tool(
    "escalar_para_departamento",
    "Escala o atendimento para um departamento ou fila especifica sem consumir creditos.",
    {
      numero: z.string().describe("Numero do cliente"),
      queue_id: z.number().describe("ID do departamento ou fila na ClickMassa"),
    },
    async ({ numero, queue_id }) => {
      const ticket = await findTicketByNumber(numero);
      return ok(await api("PUT", `/tickets/${ticket.id}`, { queueId: queue_id }));
    }
  );

  server.tool(
    "fechar_ticket",
    "Fecha o ticket de atendimento de um contato na ClickMassa.",
    {
      numero: z.string().describe("Numero do cliente"),
      closing_reason_id: z.number().optional().describe("ID do motivo de fechamento"),
      canal_id: z.string().optional(),
    },
    async ({ numero, closing_reason_id, canal_id }) => {
      const extra = { forceTicketToClosed: true };
      if (closing_reason_id) extra.closingReasonId = closing_reason_id;
      return ok(
        await sendExternalMessage({
          numero,
          mensagem: "",
          canal_id,
          external_key: `mcp-close-${Date.now()}`,
          extra,
        })
      );
    }
  );

  server.tool(
    "listar_tickets_pendentes",
    "Lista os tickets que estao aguardando na fila (pendentes).",
    {
      pagina: z.number().optional().describe("Numero da pagina"),
      busca: z.string().optional().describe("Termo de busca"),
      queue_ids: z.array(z.number()).optional().describe("Filtro por IDs de fila"),
    },
    async ({ pagina = 1, busca = "", queue_ids }) => {
      const query = new URLSearchParams({
        status: "pending",
        searchParam: busca,
        showAll: "true",
        withUnreadMessages: "false",
        unansweredMessages: "false",
        isNotAssignedUser: "false",
        includeNotQueueDefined: "true",
        isChatBot: "false",
        order: "DESC",
        pageNumber: pagina.toString(),
      });

      let url = `/tickets?${query.toString()}`;
      if (queue_ids?.length) {
        queue_ids.forEach((id) => {
          url += `&queuesIds[]=${id}`;
        });
      }

      return ok(await api("GET", url));
    }
  );

  server.tool(
    "listar_tickets_abertos",
    "Lista os tickets que estao em atendimento (abertos).",
    {
      pagina: z.number().optional().describe("Numero da pagina"),
      busca: z.string().optional().describe("Termo de busca"),
      queue_ids: z.array(z.number()).optional().describe("Filtro por IDs de fila"),
    },
    async ({ pagina = 1, busca = "", queue_ids }) => {
      const query = new URLSearchParams({
        status: "open",
        searchParam: busca,
        showAll: "true",
        withUnreadMessages: "false",
        unansweredMessages: "false",
        isNotAssignedUser: "false",
        includeNotQueueDefined: "true",
        isChatBot: "false",
        order: "DESC",
        pageNumber: pagina.toString(),
      });

      let url = `/tickets?${query.toString()}`;
      if (queue_ids?.length) {
        queue_ids.forEach((id) => {
          url += `&queuesIds[]=${id}`;
        });
      }

      return ok(await api("GET", url));
    }
  );

  server.tool(
    "listar_etiquetas",
    "Lista todas as etiquetas cadastradas na conta ClickMassa.",
    {},
    async () => ok(await apiWithFallback("GET", ["/v1/labels", "/labels"]))
  );

  server.tool(
    "listar_atendentes",
    "Lista todos os atendentes (usuarios) cadastrados na conta ClickMassa.",
    {},
    async () => ok(await apiWithFallback("GET", ["/users", "/v1/users"]))
  );

  server.tool(
    "listar_origens_lead",
    "Lista todas as origens de leads cadastradas e retorna os IDs usados no contato.",
    {},
    async () => ok(await api("GET", "/lead-origin"))
  );

  server.tool(
    "listar_status_lead",
    "Lista todas as fases de lead cadastradas e retorna os IDs usados no contato.",
    {},
    async () => ok(await api("GET", "/lead-status"))
  );

  server.tool(
    "listar_tarefas",
    "Lista as tarefas agendadas no sistema com filtros de data e status.",
    {
      data_inicio: z.string().describe("Data inicial YYYY-MM-DD"),
      data_fim: z.string().describe("Data final YYYY-MM-DD"),
      concluidas: z.boolean().optional().describe("Filtrar por tarefas concluidas"),
      pagina: z.number().optional().describe("Numero da pagina"),
    },
    async ({ data_inicio, data_fim, concluidas = false, pagina = 1 }) => {
      const query = new URLSearchParams({
        startDate: data_inicio,
        endDate: data_fim,
        completed: concluidas.toString(),
        pageNumber: pagina.toString(),
      });
      return ok(await api("GET", `/tasks/pages?${query.toString()}`));
    }
  );

  server.tool(
    "criar_tarefa",
    "Cria uma nova tarefa ou compromisso para um atendente e contato.",
    {
      titulo: z.string().describe("Titulo da tarefa"),
      contato_id: z.number().describe("ID do contato vinculado"),
      responsavel_id: z.number().describe("ID do atendente responsavel"),
      data: z.string().describe("Data YYYY-MM-DD"),
      hora: z.string().optional().describe("Hora HH:mm:ss"),
      tipo: z.enum(["T", "L", "C"]).optional().describe("Tipo: T=Tarefa, L=Ligacao, C=Compromisso"),
      observacao: z.string().optional().describe("Detalhes da tarefa"),
      duracao_min: z.number().optional().describe("Duracao em minutos"),
    },
    async ({
      titulo,
      contato_id,
      responsavel_id,
      data,
      hora = "09:00:00",
      tipo = "T",
      observacao,
      duracao_min = 30,
    }) =>
      ok(
        await api("POST", "/tasks", {
          name: titulo,
          contactId: contato_id,
          responsibleUserId: responsavel_id,
          date: data,
          time: hora,
          type: tipo,
          observation: observacao || "",
          duration: duracao_min,
          completed: false,
          fullDay: false,
          notifyContact: false,
        })
      )
  );

  server.tool(
    "listar_fluxos_chat",
    "Lista os fluxos de chatbot configurados no sistema.",
    {},
    async () => ok(await api("GET", "/chat-flow"))
  );

  server.tool(
    "atribuir_fluxo_chat",
    "Atribui um fluxo de chatbot especifico a um ticket ou remove o fluxo atual.",
    {
      numero: z.string().describe("Numero do cliente"),
      fluxo_id: z.number().nullable().describe("ID do fluxo de chat ou null para desativar"),
    },
    async ({ numero, fluxo_id }) => {
      const ticket = await findTicketByNumber(numero);
      return ok(await api("PUT", `/tickets/${ticket.id}`, { chatFlowId: fluxo_id }));
    }
  );

  server.tool(
    "verificar_chamadas_perdidas",
    "Realiza uma varredura nos tickets recentes em busca de registros de chamadas perdidas ou rejeitadas.",
    {
      limite_tickets: z.number().optional().describe("Numero de tickets recentes a verificar"),
    },
    async ({ limite_tickets = 10 }) => {
      const search = await api("GET", "/tickets?showAll=true&pageNumber=1");
      const tickets = search.tickets || [];
      const results = [];

      for (const ticket of tickets.slice(0, limite_tickets)) {
        const msgRes = await api("GET", `/messages/${ticket.id}`);
        const messages = msgRes.messages || msgRes.data || (Array.isArray(msgRes) ? msgRes : []);
        const calls = messages.filter(
          (message) =>
            message.mediaType === "call_log" ||
            message.body?.toLowerCase().includes("chamada") ||
            message.body?.toLowerCase().includes("call")
        );

        if (calls.length > 0) {
          results.push({
            ticketId: ticket.id,
            contato: ticket.contact?.name,
            numero: ticket.contact?.number,
            chamadas: calls.map((call) => ({ data: call.createdAt, corpo: call.body })),
          });
        }
      }

      return ok({
        total_tickets_verificados: Math.min(tickets.length, limite_tickets),
        chamadas_encontradas: results,
      });
    }
  );

  server.tool(
    "listar_funis",
    "Lista todos os funis de mensagem cadastrados.",
    {},
    async () => ok(await api("GET", "/funnel"))
  );

  server.tool(
    "atribuir_funil_contato",
    "Vincula um contato a um funil de mensagens para iniciar o follow-up automatico.",
    {
      contato_id: z.number().describe("ID interno do contato"),
      funnel_id: z.number().describe("ID do funil de mensagens"),
    },
    async ({ contato_id, funnel_id }) =>
      ok(await api("POST", "/funnel-contact", { funnelId: funnel_id, contactId: contato_id }))
  );

  server.tool(
    "listar_conexoes_whatsapp",
    "Lista as conexoes de WhatsApp disponiveis para saber qual sessionId usar em funis e mensagens.",
    {},
    async () => ok(await api("GET", "/whatsapp"))
  );

  server.tool(
    "criar_funil",
    "Cria um novo funil de mensagens com etapas customizadas.",
    {
      nome: z.string().describe("Nome do funil"),
      whatsapp_id: z.number().describe("ID da conexao de WhatsApp"),
      acao_ao_finalizar: z.enum(["C", "N"]).optional().describe("Acao: C = Fechar atendimento, N = Nenhuma"),
      etapas: z.array(
        z.object({
          mensagem: z.string().describe("Texto da mensagem"),
          minutos_atraso: z.number().describe("Minutos apos a etapa anterior"),
          ordem: z.number().describe("Ordem da etapa"),
        })
      ),
    },
    async ({ nome, whatsapp_id, acao_ao_finalizar = "N", etapas }) =>
      ok(
        await api("POST", "/funnel", {
          name: nome,
          sessionId: whatsapp_id,
          action: acao_ao_finalizar,
          steps: etapas.map((etapa) => ({
            message: etapa.mensagem,
            minutesLater: etapa.minutos_atraso,
            order: etapa.ordem,
          })),
        })
      )
  );

  server.tool(
    "listar_eventos_push",
    "Lista todos os eventos push e webhooks configurados nas plataformas externas.",
    {},
    async () => ok(await api("GET", `${SUPER_API_URL}/push-event`))
  );

  server.tool(
    "criar_evento_push",
    "Configura um novo gatilho de Push para receber dados de plataformas externas.",
    {
      nome: z.string().describe("Nome identificador do push"),
      plataforma: z.string().describe("Nome da plataforma"),
      evento: z.string().describe("Nome do evento"),
      whatsapp_id: z.number().describe("ID da conexao de WhatsApp"),
      mensagem: z.string().describe("Mensagem automatica a ser enviada"),
      acao: z.enum(["C", "N"]).optional().describe("Acao inicial"),
    },
    async ({ nome, plataforma, evento, whatsapp_id, mensagem, acao = "N" }) =>
      ok(
        await api("POST", `${SUPER_API_URL}/push-event`, {
          name: nome,
          platform: plataforma,
          event: evento,
          sessionId: whatsapp_id,
          message: mensagem,
          action: acao,
          active: true,
        })
      )
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
