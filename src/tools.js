// src/tools.js
// Módulo compartilhado de ferramentas ClickMassa MCP
// Usado por index.js (STDIO) e index-sse.js (SSE/HTTP)
// Arquitetura multi-tenant: credenciais passadas via credsFn() por request

import { z } from "zod";

// ─── Token Cache com TTL por tenant ─────────────────────────────────────────
const tokenCache = new Map(); // key: baseUrl -> { token, expiresAt }
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutos

async function getUserToken(creds) {
  const { baseUrl, token, email, password } = creds;
  if (!email || !password) return token;

  const cached = tokenCache.get(baseUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  try {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (data.token) {
      tokenCache.set(baseUrl, { token: data.token, expiresAt: Date.now() + TOKEN_TTL_MS });
      return data.token;
    }
  } catch (e) {
    process.stderr.write(`[clickmassa-mcp] Erro no auto-login (${baseUrl}): ${e.message}\n`);
  }
  return token;
}

// Invalida cache de token (ex: após 401)
export function invalidateTokenCache(baseUrl) {
  tokenCache.delete(baseUrl);
}

async function api(method, reqPath, body, creds) {
  const { baseUrl } = creds;
  const url = reqPath.startsWith("http") ? reqPath : `${baseUrl}${reqPath}`;
  const activeToken = await getUserToken(creds);

  const opts = {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  // Auto-retry com re-login em caso de 401
  if (res.status === 401 && creds.email && creds.password) {
    invalidateTokenCache(creds.baseUrl);
    const retryToken = await getUserToken(creds);
    opts.headers.Authorization = `Bearer ${retryToken}`;
    const retry = await fetch(url, opts);
    const retryText = await retry.text();
    let retryData;
    try { retryData = JSON.parse(retryText); } catch { retryData = { raw: retryText }; }
    if (!retry.ok) throw new Error(`ClickMassa ${method} ${reqPath} → ${retry.status}: ${retryText}`);
    return retryData;
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ClickMassa ${method} ${reqPath} → ${res.status}: ${text}`);
  return data;
}

async function apiWithFallback(method, paths, body, creds) {
  let lastError = null;
  for (const p of paths) {
    try { return await api(method, p, body, creds); } catch (e) { lastError = e; }
  }
  throw lastError;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function findTicketByNumber(numero, creds) {
  const search = await api("GET", `/tickets?searchParam=${numero}&showAll=true`, null, creds);
  const tickets = search.tickets || [];
  const ticket = tickets.find(
    (t) => t.contact?.number === numero && (t.status === "open" || t.status === "pending")
  );
  if (!ticket) throw new Error(`Nenhum ticket aberto ou pendente para o número ${numero}`);
  return ticket;
}

async function sendExternalMessage({ numero, mensagem, external_key, canal_id, extra = {}, creds }) {
  const cid = canal_id || creds.canalId;
  if (!cid) throw new Error("Informe canal_id ou defina CLICKMASSA_CANAL_ID");
  return api(
    "POST",
    `/v1/api/external/${cid}`,
    { number: numero, body: mensagem, externalKey: external_key || `mcp-${Date.now()}`, ...extra },
    creds
  );
}

// ─── Registro de todas as ferramentas ────────────────────────────────────────
// credsFn() → { baseUrl, token, canalId, email?, password? }
export function registerTools(server, credsFn) {
  // superApiUrl: usa baseUrl do tenant por padrão (instâncias próprias).
  // Para instâncias que usam a SuperAPI centralizada, passe superApiUrl nas creds.
  const getSuperApiUrl = () => credsFn().superApiUrl || credsFn().baseUrl;

  // ════════════════════════════════════════════════════════════════
  // CONTATOS
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "buscar_contato_por_numero",
    "Busca um contato pelo número de WhatsApp. Retorna id, nome, email, tags e campos customizados.",
    { numero: z.string().describe("Número com DDI+DDD sem espaços. Ex: 5527999990000") },
    async ({ numero }) => {
      // Tenta /v1/contacts/number/:n primeiro; faz fallback para busca textual se falhar
      try {
        const data = await api("GET", `/v1/contacts/number/${numero}`, null, credsFn());
        if (data && data.id) return ok(data);
        throw new Error("empty");
      } catch (_) {
        const res = await api("GET", `/contacts?searchParam=${numero}&pageNumber=1`, null, credsFn());
        const contacts = res.contacts || (Array.isArray(res) ? res : []);
        const contact = contacts.find((c) => c.number === numero) || contacts[0];
        if (!contact) throw new Error(`Contato não encontrado para o número ${numero}`);
        // Busca dados completos pelo ID
        return ok(await api("GET", `/contacts/${contact.id}`, null, credsFn()));
      }
    }
  );

  server.tool(
    "buscar_contato_por_id",
    "Busca um contato pelo ID interno.",
    { id: z.string().describe("ID interno do contato") },
    async ({ id }) => ok(await api("GET", `/v1/contacts/${id}`, null, credsFn()))
  );

  server.tool(
    "listar_contatos",
    "Lista contatos da conta com suporte a busca e paginação. Retorna {contacts, count, hasMore}.",
    {
      busca: z.string().optional().describe("Filtro por nome, número ou e-mail"),
      pagina: z.number().optional().describe("Número da página (default: 1)"),
      todos: z.boolean().optional().describe("Se true, percorre todas as páginas e retorna lista completa (cuidado: pode ser lento)"),
    },
    async ({ busca = "", pagina = 1, todos = false }) => {
      const creds = credsFn();
      const buildUrl = (p) => {
        const q = new URLSearchParams({ pageNumber: String(p) });
        if (busca) q.set("searchParam", busca);
        // /contacts (sem /v1) confirmado via live API; retorna {contacts, count, hasMore}
        return `/contacts?${q}`;
      };

      if (!todos) {
        return ok(await api("GET", buildUrl(pagina), null, creds));
      }

      // Modo "todos": percorre páginas até hasMore = false
      let currentPage = 1;
      const allContacts = [];
      let totalCount = 0;
      while (true) {
        const res = await api("GET", buildUrl(currentPage), null, creds);
        const batch = res.contacts || [];
        allContacts.push(...batch);
        totalCount = parseInt(res.count || 0, 10);
        if (!res.hasMore || batch.length === 0) break;
        currentPage++;
        if (currentPage > 50) break; // safety cap: 50 páginas ≈ 1000 contatos
      }
      return ok({ contacts: allContacts, count: totalCount, paginasPercorridas: currentPage });
    }
  );

  server.tool(
    "criar_contato",
    "Cria um novo contato.",
    {
      nome: z.string().describe("Nome completo do contato"),
      numero: z.string().describe("Número WhatsApp com DDI+DDD. Ex: 5527999990000"),
      email: z.string().optional(),
      tags: z.array(z.string()).optional(),
      campos_customizados: z.record(z.string()).optional().describe("Campos chave-valor"),
    },
    async ({ nome, numero, email, tags, campos_customizados }) => {
      const body = { name: nome, number: numero };
      if (email) body.email = email;
      if (tags?.length) body.tags = tags;
      if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
      return ok(await api("POST", "/v1/contacts/", body, credsFn()));
    }
  );

  server.tool(
    "atualizar_contato",
    "Atualiza dados de um contato (nome, email, tags, leadStatusId, leadOriginId, campos customizados).",
    {
      id: z.string().describe("ID interno do contato"),
      nome: z.string().optional(),
      email: z.string().optional(),
      leadStatusId: z.number().optional().describe("ID da fase do lead"),
      leadOriginId: z.number().optional().describe("ID da origem do lead"),
      tags: z.array(z.string()).optional(),
      campos_customizados: z.record(z.string()).optional(),
    },
    async ({ id, nome, email, leadStatusId, leadOriginId, tags, campos_customizados }) => {
      const body = { id: parseInt(id, 10) };
      if (nome) body.name = nome;
      if (email) body.email = email;
      if (leadStatusId) body.leadStatusId = leadStatusId;
      if (leadOriginId) body.leadOriginId = leadOriginId;
      if (tags) body.tags = tags;
      if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
      return ok(await api("PUT", `/contacts/${id}`, body, credsFn()));
    }
  );

  server.tool(
    "adicionar_etiquetas",
    "Adiciona etiquetas a um contato sem apagar as existentes.",
    { id: z.string().describe("ID do contato"), tags: z.array(z.string()) },
    async ({ id, tags }) => ok(await api("PATCH", `/v1/contacts/${id}`, { tags }, credsFn()))
  );

  server.tool(
    "remover_todas_etiquetas",
    "Remove todas as etiquetas de um contato.",
    { id: z.string().describe("ID do contato") },
    async ({ id }) => ok(await api("PATCH", `/v1/contacts/${id}`, { tags: [] }, credsFn()))
  );

  // ════════════════════════════════════════════════════════════════
  // MENSAGENS
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "enviar_mensagem_direta",
    "Envia mensagem de texto via ticket aberto no CRM sem consumir créditos Push.",
    { numero: z.string().describe("Número destino com DDI+DDD"), mensagem: z.string() },
    async ({ numero, mensagem }) => {
      const ticket = await findTicketByNumber(numero, credsFn());
      return ok(await api("POST", `/messages/${ticket.id}`, { body: mensagem }, credsFn()));
    }
  );

  server.tool(
    "enviar_mensagem",
    "Envia mensagem de texto via Push API (cria ou reabre ticket automaticamente).",
    {
      numero: z.string().describe("Número destino com DDI+DDD. Ex: 5527999990000"),
      mensagem: z.string(),
      external_key: z.string().optional().describe("Chave de rastreio nos logs"),
      canal_id: z.string().optional().describe("ID do canal. Usa CLICKMASSA_CANAL_ID se omitido."),
    },
    async (params) => ok(await sendExternalMessage({ ...params, creds: credsFn() }))
  );

  server.tool(
    "enviar_midia",
    "Envia arquivo (imagem, PDF, áudio, vídeo) via WhatsApp.",
    {
      numero: z.string(),
      url_midia: z.string().describe("URL pública do arquivo a ser enviado"),
      legenda: z.string().optional(),
      canal_id: z.string().optional(),
    },
    async ({ numero, url_midia, legenda, canal_id }) =>
      ok(
        await sendExternalMessage({
          numero, mensagem: legenda || "", canal_id,
          external_key: `mcp-media-${Date.now()}`,
          extra: { mediaUrl: url_midia },
          creds: credsFn(),
        })
      )
  );

  server.tool(
    "enviar_nota_interna",
    // ATENÇÃO: use criar_nota_interna se o ticket já existir — evita duplicação.
    // Esta ferramenta usa a Push API: cria/reabre o ticket E registra a nota.
    // Use apenas quando não há ticket aberto e você quer criá-lo com uma nota inicial.
    "Envia nota interna via Push API. Cria ou reabre o ticket automaticamente antes de registrar a nota. Use criar_nota_interna se o ticket já existir.",
    { numero: z.string(), nota: z.string(), canal_id: z.string().optional() },
    async ({ numero, nota, canal_id }) =>
      ok(
        await sendExternalMessage({
          numero, mensagem: "", canal_id,
          external_key: `mcp-note-${Date.now()}`,
          extra: { onlyNote: true, note: { body: nota } },
          creds: credsFn(),
        })
      )
  );

  // ════════════════════════════════════════════════════════════════
  // TICKETS
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "escalar_para_atendente",
    "Escala ticket para um atendente humano específico.",
    { numero: z.string(), user_id: z.number().describe("ID do atendente na ClickMassa") },
    async ({ numero, user_id }) => {
      const ticket = await findTicketByNumber(numero, credsFn());
      return ok(await api("PUT", `/tickets/${ticket.id}`, { userId: user_id }, credsFn()));
    }
  );

  server.tool(
    "devolver_para_fila",
    "Devolve ticket para a fila de espera, removendo atribuição do atendente atual.",
    { numero: z.string() },
    async ({ numero }) => {
      const ticket = await findTicketByNumber(numero, credsFn());
      return ok(await api("PUT", `/tickets/${ticket.id}`, { userId: null, status: "pending" }, credsFn()));
    }
  );

  server.tool(
    "escalar_para_departamento",
    "Escala atendimento para departamento/fila específico.",
    { numero: z.string(), queue_id: z.number().describe("ID do departamento/fila") },
    async ({ numero, queue_id }) => {
      const ticket = await findTicketByNumber(numero, credsFn());
      return ok(await api("PUT", `/tickets/${ticket.id}`, { queueId: queue_id }, credsFn()));
    }
  );

  server.tool(
    "fechar_ticket",
    "Fecha o ticket de atendimento.",
    {
      numero: z.string(),
      closing_reason_id: z.number().optional().describe("ID do motivo de fechamento"),
      canal_id: z.string().optional(),
    },
    async ({ numero, closing_reason_id, canal_id }) => {
      const extra = { forceTicketToClosed: true };
      if (closing_reason_id) extra.closingReasonId = closing_reason_id;
      return ok(
        await sendExternalMessage({
          numero, mensagem: "", canal_id,
          external_key: `mcp-close-${Date.now()}`,
          extra, creds: credsFn(),
        })
      );
    }
  );

  server.tool(
    "listar_tickets_pendentes",
    "Lista tickets aguardando na fila (status: pending).",
    {
      pagina: z.number().optional().describe("Número da página (default: 1)"),
      busca: z.string().optional(),
      queue_ids: z.array(z.number()).optional(),
    },
    async ({ pagina = 1, busca = "", queue_ids }) => {
      const query = new URLSearchParams({
        status: "pending", searchParam: busca, showAll: "true",
        withUnreadMessages: "false", unansweredMessages: "false",
        isNotAssignedUser: "false", includeNotQueueDefined: "true",
        isChatBot: "false", order: "DESC", pageNumber: pagina.toString(),
      });
      let url = `/tickets?${query}`;
      if (queue_ids?.length) queue_ids.forEach((id) => (url += `&queuesIds[]=${id}`));
      return ok(await api("GET", url, null, credsFn()));
    }
  );

  server.tool(
    "listar_tickets_abertos",
    "Lista tickets em atendimento (status: open).",
    {
      pagina: z.number().optional(),
      busca: z.string().optional(),
      queue_ids: z.array(z.number()).optional(),
    },
    async ({ pagina = 1, busca = "", queue_ids }) => {
      const query = new URLSearchParams({
        status: "open", searchParam: busca, showAll: "true",
        withUnreadMessages: "false", unansweredMessages: "false",
        isNotAssignedUser: "false", includeNotQueueDefined: "true",
        isChatBot: "false", order: "DESC", pageNumber: pagina.toString(),
      });
      let url = `/tickets?${query}`;
      if (queue_ids?.length) queue_ids.forEach((id) => (url += `&queuesIds[]=${id}`));
      return ok(await api("GET", url, null, credsFn()));
    }
  );

  // ════════════════════════════════════════════════════════════════
  // ETIQUETAS / ATENDENTES / LEADS / FILAS
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "listar_etiquetas",
    "Lista todas as etiquetas cadastradas na conta.",
    {},
    // Ordem de fallback confirmada via inspeção live: /tags funciona; /v1/labels e /labels retornam 404
    async () => ok(await apiWithFallback("GET", ["/tags", "/tags/", "/v1/labels"], null, credsFn()))
  );

  server.tool(
    "listar_atendentes",
    "Lista todos os atendentes (usuários) cadastrados.",
    {},
    async () => ok(await apiWithFallback("GET", ["/users", "/v1/users"], null, credsFn()))
  );

  server.tool(
    "listar_origens_lead",
    "Lista todas as origens de leads (ex: Facebook, Orgânico, Indicação).",
    {},
    async () => ok(await api("GET", "/lead-origin", null, credsFn()))
  );

  server.tool(
    "listar_status_lead",
    "Lista todas as fases de lead (ex: Novo Lead, Qualificado, Fechado).",
    {},
    async () => ok(await api("GET", "/lead-status", null, credsFn()))
  );

  // ════════════════════════════════════════════════════════════════
  // TAREFAS
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "listar_tarefas",
    "Lista tarefas com filtros de data e status.",
    {
      data_inicio: z.string().describe("Data inicial YYYY-MM-DD"),
      data_fim: z.string().describe("Data final YYYY-MM-DD"),
      concluidas: z.boolean().optional().describe("Filtrar concluídas (true) ou pendentes (false)"),
      pagina: z.number().optional(),
    },
    async ({ data_inicio, data_fim, concluidas = false, pagina = 1 }) => {
      const query = new URLSearchParams({
        startDate: data_inicio, endDate: data_fim,
        completed: concluidas.toString(), pageNumber: pagina.toString(),
      });
      return ok(await api("GET", `/tasks/pages?${query}`, null, credsFn()));
    }
  );

  server.tool(
    "criar_tarefa",
    "Cria nova tarefa ou compromisso para um atendente e contato.",
    {
      titulo: z.string(),
      contato_id: z.number().describe("ID do contato vinculado"),
      responsavel_id: z.number().describe("ID do atendente responsável"),
      data: z.string().describe("Data YYYY-MM-DD"),
      hora: z.string().optional().describe("Hora HH:mm:ss (default: 09:00:00)"),
      tipo: z.enum(["T", "L", "C"]).optional().describe("T=Tarefa, L=Ligação, C=Compromisso"),
      observacao: z.string().optional(),
      duracao_min: z.number().optional().describe("Duração em minutos (default: 30)"),
    },
    async ({ titulo, contato_id, responsavel_id, data, hora = "09:00:00", tipo = "T", observacao, duracao_min = 30 }) =>
      ok(
        await api("POST", "/tasks", {
          name: titulo, contactId: contato_id, responsibleUserId: responsavel_id,
          date: data, time: hora, type: tipo, observation: observacao || "",
          duration: duracao_min, completed: false, fullDay: false, notifyContact: false,
        }, credsFn())
      )
  );

  // ════════════════════════════════════════════════════════════════
  // CHATBOTS / FUNIS / CONEXÕES
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "listar_fluxos_chat",
    "Lista os fluxos de chatbot configurados.",
    {},
    async () => ok(await api("GET", "/chat-flow", null, credsFn()))
  );

  server.tool(
    "atribuir_fluxo_chat",
    "Atribui fluxo de chatbot a um ticket ou remove o fluxo atual.",
    {
      numero: z.string(),
      fluxo_id: z.number().nullable().describe("ID do fluxo ou null para remover"),
    },
    async ({ numero, fluxo_id }) => {
      const ticket = await findTicketByNumber(numero, credsFn());
      return ok(await api("PUT", `/tickets/${ticket.id}`, { chatFlowId: fluxo_id }, credsFn()));
    }
  );

  server.tool(
    "verificar_chamadas_perdidas",
    "Varre tickets recentes em busca de registros de chamadas perdidas.",
    { limite_tickets: z.number().optional().describe("Tickets a verificar (default: 10)") },
    async ({ limite_tickets = 10 }) => {
      const creds = credsFn();
      const search = await api("GET", "/tickets?showAll=true&pageNumber=1", null, creds);
      const tickets = (search.tickets || []).slice(0, limite_tickets);
      const results = [];
      for (const ticket of tickets) {
        // IMPORTANTE: /messages/:ticketId exige ?contactId= — sem ele retorna 500
        const contactId = ticket.contactId || ticket.contact?.id;
        if (!contactId) continue;
        try {
          const msgRes = await api("GET", `/messages/${ticket.id}?contactId=${contactId}`, null, creds);
          const messages = msgRes.messages || msgRes.data || (Array.isArray(msgRes) ? msgRes : []);
          const calls = messages.filter(
            (m) => m.mediaType === "call_log" || m.body?.toLowerCase().includes("chamada") || m.body?.toLowerCase().includes("call")
          );
          if (calls.length > 0) {
            results.push({
              ticketId: ticket.id, contato: ticket.contact?.name, numero: ticket.contact?.number,
              chamadas: calls.map((c) => ({ data: c.createdAt || c.msgCreatedAt, corpo: c.body })),
            });
          }
        } catch (_) { /* ignora erros individuais de ticket */ }
      }
      return ok({ total_tickets_verificados: tickets.length, chamadas_encontradas: results });
    }
  );

  server.tool(
    "listar_funis",
    "Lista todos os funis de mensagem (réguas de follow-up).",
    {},
    async () => ok(await api("GET", "/funnel", null, credsFn()))
  );

  server.tool(
    "atribuir_funil_contato",
    "Vincula contato a funil de mensagens para iniciar follow-up automático.",
    { contato_id: z.number(), funnel_id: z.number() },
    async ({ contato_id, funnel_id }) =>
      ok(await api("POST", "/funnel-contact", { funnelId: funnel_id, contactId: contato_id }, credsFn()))
  );

  server.tool(
    "listar_conexoes_whatsapp",
    "Lista conexões de WhatsApp disponíveis.",
    {},
    async () => ok(await api("GET", "/whatsapp", null, credsFn()))
  );

  server.tool(
    "criar_funil",
    "Cria novo funil de mensagens com etapas customizadas.",
    {
      nome: z.string(),
      whatsapp_id: z.number().describe("ID da conexão WhatsApp (sessionId)"),
      acao_ao_finalizar: z.enum(["C", "N"]).optional().describe("C=Fechar ticket, N=Nenhuma"),
      etapas: z.array(
        z.object({
          mensagem: z.string(),
          minutos_atraso: z.number().describe("Minutos após etapa anterior"),
          ordem: z.number(),
        })
      ),
    },
    async ({ nome, whatsapp_id, acao_ao_finalizar = "N", etapas }) =>
      ok(
        await api("POST", "/funnel", {
          name: nome, sessionId: whatsapp_id, action: acao_ao_finalizar,
          steps: etapas.map((e) => ({ message: e.mensagem, minutesLater: e.minutos_atraso, order: e.ordem })),
        }, credsFn())
      )
  );

  // ════════════════════════════════════════════════════════════════
  // PUSH EVENTS
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "listar_eventos_push",
    "Lista eventos push/webhooks configurados nas plataformas externas.",
    {},
    async () => ok(await api("GET", `${getSuperApiUrl()}/push-event`, null, credsFn()))
  );

  server.tool(
    "criar_evento_push",
    "Configura gatilho de Push para receber dados de plataformas externas.",
    {
      nome: z.string(),
      plataforma: z.string().describe("Ex: ClickMetrics, KiwiFy, Eduzz"),
      evento: z.string().describe("Nome do evento"),
      whatsapp_id: z.number(),
      mensagem: z.string().describe("Use {{variável}} para campos dinâmicos"),
      acao: z.enum(["C", "N"]).optional(),
    },
    async ({ nome, plataforma, evento, whatsapp_id, mensagem, acao = "N" }) =>
      ok(
        await api("POST", `${getSuperApiUrl()}/push-event`, {
          name: nome, platform: plataforma, event: evento,
          sessionId: whatsapp_id, message: mensagem, action: acao, active: true,
        }, credsFn())
      )
  );

  // ════════════════════════════════════════════════════════════════
  // UTILITÁRIOS — LOOKUP / DISCOVERY (v2.1 — confirmados via live API)
  // ════════════════════════════════════════════════════════════════

  server.tool(
    "listar_pipelines",
    "Lista os pipelines (funis kanban) com suas etapas para uso em registrar_venda e atualizar_etapa_funil.",
    {},
    async () => ok(await api("GET", "/pipelines?includeSteps=true", null, credsFn()))
  );

  server.tool(
    "listar_filas",
    "Lista as filas/departamentos de atendimento cadastrados na conta.",
    {},
    async () => ok(await apiWithFallback("GET", ["/queue/", "/queue"], null, credsFn()))
  );

  server.tool(
    "listar_motivos_fechamento",
    "Lista os motivos de fechamento de ticket disponíveis na conta.",
    {},
    async () => ok(await apiWithFallback("GET", ["/closing-reason/", "/closing-reason"], null, credsFn()))
  );

  server.tool(
    "listar_oportunidades",
    "Busca oportunidades de venda no kanban, filtradas por contato ou listagem geral.",
    {
      contato_id: z.number().optional().describe("ID do contato para filtrar oportunidades"),
      pagina: z.number().optional().describe("Página (default: 1)"),
    },
    async ({ contato_id, pagina = 1 }) => {
      const q = new URLSearchParams({ pageNumber: pagina.toString() });
      if (contato_id) q.set("contactId", contato_id.toString());
      return ok(await api("GET", `/opportunity/search?${q}`, null, credsFn()));
    }
  );

  server.tool(
    "verificar_blacklist",
    "Verifica se um número está na blacklist (bloqueado para envio de mensagens).",
    { numero: z.string().describe("Número com DDI+DDD. Ex: 5527999990000") },
    async ({ numero }) => ok(await api("GET", `/blacklist/check-number/${numero}`, null, credsFn()))
  );

  // ════════════════════════════════════════════════════════════════
  // ★ NOVAS 12 FERRAMENTAS ★
  // ════════════════════════════════════════════════════════════════

  // 1. obter_resumo_lead
  server.tool(
    "obter_resumo_lead",
    "Retorna resumo completo do lead: dados do contato, status, origem, ticket ativo e tarefas pendentes.",
    { numero: z.string().describe("Número do contato com DDI+DDD") },
    async ({ numero }) => {
      const creds = credsFn();
      const contato = await api("GET", `/v1/contacts/number/${numero}`, null, creds);
      const contactId = contato.id;

      let ticketAtivo = null;
      try { ticketAtivo = await findTicketByNumber(numero, creds); } catch (_) { }

      const hoje = new Date().toISOString().split("T")[0];
      const dataFim = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      let tarefas = [];
      try {
        const tRes = await api("GET", `/tasks/pages?startDate=${hoje}&endDate=${dataFim}&completed=false&pageNumber=1`, null, creds);
        tarefas = (tRes.tasks || tRes.data || []).filter((t) => t.contactId === contactId).slice(0, 5);
      } catch (_) { }

      return ok({
        contato: {
          id: contato.id, nome: contato.name, numero: contato.number,
          email: contato.email, tags: contato.tags,
          leadStatus: contato.leadStatus, leadOrigin: contato.leadOrigin,
          campos_customizados: contato.extraInfo || contato.customFields,
        },
        ticket_ativo: ticketAtivo
          ? {
            id: ticketAtivo.id, status: ticketAtivo.status,
            queue: ticketAtivo.queue?.name, atendente: ticketAtivo.user?.name,
            ultima_mensagem: ticketAtivo.lastMessage, criado_em: ticketAtivo.createdAt,
          }
          : null,
        tarefas_pendentes: tarefas.map((t) => ({
          id: t.id, titulo: t.name, data: t.date, tipo: t.type,
          status: t.completed ? "concluída" : "pendente",
        })),
      });
    }
  );

  // 2. buscar_historico_ticket
  server.tool(
    "buscar_historico_ticket",
    "Busca histórico de mensagens de um ticket para entender o contexto da conversa.",
    {
      numero: z.string().describe("Número do cliente com DDI+DDD"),
      limite: z.number().optional().describe("Quantidade máxima de mensagens (default: 20)"),
    },
    async ({ numero, limite = 20 }) => {
      const creds = credsFn();
      const ticket = await findTicketByNumber(numero, creds);
      // IMPORTANTE: /messages/:ticketId exige ?contactId= — sem ele retorna 500
      const contactId = ticket.contactId || ticket.contact?.id;
      const msgRes = await api("GET", `/messages/${ticket.id}?contactId=${contactId}`, null, creds);
      const messages = msgRes.messages || msgRes.data || (Array.isArray(msgRes) ? msgRes : []);
      return ok({
        ticketId: ticket.id, contactId, numero, contato: ticket.contact?.name, status: ticket.status,
        historico: messages.slice(-limite).map((m) => ({
          id: m.id, body: m.body || m.caption, fromMe: m.fromMe,
          mediaType: m.mediaType, isPrivate: m.isPrivate,
          createdAt: m.createdAt || m.msgCreatedAt,
          note: m.note || null,
        })),
      });
    }
  );

  // 3. transferir_para_humano
  server.tool(
    "transferir_para_humano",
    "Transfere ticket para atendente humano: remove chatbot, atribui usuário e opcionalmente envia mensagem de transição.",
    {
      numero: z.string().describe("Número do cliente"),
      user_id: z.number().describe("ID do atendente humano destino"),
      mensagem_transicao: z.string().optional().describe("Mensagem enviada ao cliente informando a transferência"),
      queue_id: z.number().optional().describe("Departamento destino (opcional)"),
    },
    async ({ numero, user_id, mensagem_transicao, queue_id }) => {
      const creds = credsFn();
      const ticket = await findTicketByNumber(numero, creds);

      const updateBody = { userId: user_id, chatFlowId: null, status: "open" };
      if (queue_id) updateBody.queueId = queue_id;
      const result = await api("PUT", `/tickets/${ticket.id}`, updateBody, creds);

      if (mensagem_transicao) {
        await api("POST", `/messages/${ticket.id}`, { body: mensagem_transicao }, creds);
      }
      return ok({ ticket: result, mensagem_enviada: !!mensagem_transicao });
    }
  );

  // 4. registrar_objecao
  server.tool(
    "registrar_objecao",
    "Registra objeção do lead como nota interna no ticket para acompanhamento da equipe.",
    {
      numero: z.string().describe("Número do cliente"),
      objecao: z.string().describe("Descrição da objeção levantada"),
      categoria: z.string().optional().describe("Categoria: preco, prazo, concorrente, produto, necessidade, etc."),
    },
    async ({ numero, objecao, categoria }) => {
      const creds = credsFn();
      const ticket = await findTicketByNumber(numero, creds);
      const prefixo = categoria ? `🚫 OBJEÇÃO [${categoria.toUpperCase()}]` : "🚫 OBJEÇÃO";
      const nota = `${prefixo}\n${objecao}\n📅 ${new Date().toLocaleString("pt-BR")}`;

      try {
        const result = await api("POST", `/messages/${ticket.id}`, { body: nota, isPrivate: true }, creds);
        return ok({ sucesso: true, nota_id: result.id, ticket_id: ticket.id, objecao, categoria });
      } catch (_) {
        const result = await sendExternalMessage({
          numero, mensagem: "", creds,
          extra: { onlyNote: true, note: { body: nota } },
        });
        return ok({ sucesso: true, ticket_id: ticket.id, objecao, categoria, via: "push" });
      }
    }
  );

  // 5. qualificar_lead
  server.tool(
    "qualificar_lead",
    "Qualifica o lead definindo status, score e observações. Atualiza o leadStatusId e campos customizados.",
    {
      contato_id: z.string().describe("ID interno do contato"),
      lead_status_id: z.number().describe("ID do status de qualificação (use listar_status_lead)"),
      pontuacao: z.number().min(0).max(100).optional().describe("Score de qualificação de 0 a 100"),
      observacao: z.string().optional().describe("Observação sobre a qualificação"),
      tags_qualificacao: z.array(z.string()).optional().describe("Tags para classificar o lead"),
    },
    async ({ contato_id, lead_status_id, pontuacao, observacao, tags_qualificacao }) => {
      const creds = credsFn();
      const body = { id: parseInt(contato_id, 10), leadStatusId: lead_status_id };
      if (tags_qualificacao?.length) body.tags = tags_qualificacao;
      await api("PUT", `/contacts/${contato_id}`, body, creds);

      if (pontuacao !== undefined || observacao) {
        const contato = await api("GET", `/v1/contacts/${contato_id}`, null, creds);
        let campos = {};
        try { campos = JSON.parse(contato.extraInfo || contato.customFields || "{}"); } catch (_) { }
        if (pontuacao !== undefined) campos.lead_score = pontuacao.toString();
        if (observacao) campos.qualificacao_obs = observacao;
        campos.qualificacao_data = new Date().toISOString().split("T")[0];
        await api("PUT", `/contacts/${contato_id}`, { id: parseInt(contato_id, 10), customFields: JSON.stringify(campos) }, creds);
      }
      return ok({ sucesso: true, contato_id, lead_status_id, pontuacao, observacao });
    }
  );

  // 6. criar_nota_interna
  server.tool(
    "criar_nota_interna",
    // Use esta ferramenta quando o ticket JÁ EXISTE. Usa POST /messages/:id com isPrivate:true.
    // NÃO faz fallback para Push API (que criaria nota duplicada via novo ticket).
    "Adiciona nota interna privada a um ticket existente via API de mensagens (isPrivate). Não enviada ao cliente. Use enviar_nota_interna se não houver ticket aberto.",
    {
      numero: z.string().describe("Número do cliente"),
      nota: z.string().describe("Conteúdo da nota interna"),
    },
    async ({ numero, nota }) => {
      const creds = credsFn();
      const ticket = await findTicketByNumber(numero, creds);
      const result = await api("POST", `/messages/${ticket.id}`, { body: nota, isPrivate: true }, creds);
      return ok({ sucesso: true, nota_id: result.id, ticket_id: ticket.id });
    }
  );

  // 7. adicionar_tag
  server.tool(
    "adicionar_tag",
    "Adiciona uma tag específica ao contato preservando as demais tags existentes.",
    {
      contato_id: z.string().describe("ID interno do contato"),
      tag: z.string().describe("Nome exato da tag a adicionar"),
    },
    async ({ contato_id, tag }) => {
      const creds = credsFn();
      const contato = await api("GET", `/v1/contacts/${contato_id}`, null, creds);
      const tagsAtuais = contato.tags || [];
      if (tagsAtuais.includes(tag)) {
        return ok({ sucesso: true, mensagem: "Tag já existe no contato", tags: tagsAtuais });
      }
      const novasTags = [...tagsAtuais, tag];
      await api("PATCH", `/v1/contacts/${contato_id}`, { tags: novasTags }, creds);
      return ok({ sucesso: true, tag_adicionada: tag, tags: novasTags });
    }
  );

  // 8. remover_tag
  server.tool(
    "remover_tag",
    "Remove uma tag específica do contato preservando as demais tags.",
    {
      contato_id: z.string().describe("ID interno do contato"),
      tag: z.string().describe("Nome exato da tag a remover"),
    },
    async ({ contato_id, tag }) => {
      const creds = credsFn();
      const contato = await api("GET", `/v1/contacts/${contato_id}`, null, creds);
      const tagsAtuais = contato.tags || [];
      const novasTags = tagsAtuais.filter((t) => t !== tag);
      if (novasTags.length === tagsAtuais.length) {
        return ok({ sucesso: true, mensagem: "Tag não encontrada no contato", tags: tagsAtuais });
      }
      await api("PATCH", `/v1/contacts/${contato_id}`, { tags: novasTags }, creds);
      return ok({ sucesso: true, tag_removida: tag, tags: novasTags });
    }
  );

  // 9. agendar_followup
  server.tool(
    "agendar_followup",
    "Agenda follow-up para um lead: cria tarefa e opcionalmente agenda mensagem automática ao cliente.",
    {
      contato_id: z.number().describe("ID do contato"),
      responsavel_id: z.number().describe("ID do atendente responsável"),
      data: z.string().describe("Data do follow-up YYYY-MM-DD"),
      hora: z.string().optional().describe("Hora HH:mm:ss (default: 09:00:00)"),
      motivo: z.string().describe("Motivo ou pauta do follow-up"),
      mensagem_agendada: z.string().optional().describe("Mensagem automática para enviar ao cliente na data/hora"),
      canal_id: z.string().optional().describe("Canal para mensagem agendada"),
    },
    async ({ contato_id, responsavel_id, data, hora = "09:00:00", motivo, mensagem_agendada, canal_id }) => {
      const creds = credsFn();
      const resultados = {};

      const tarefa = await api("POST", "/tasks", {
        name: `Follow-up: ${motivo}`, contactId: contato_id,
        responsibleUserId: responsavel_id, date: data, time: hora,
        type: "T", observation: motivo, duration: 30,
        completed: false, fullDay: false, notifyContact: false,
      }, creds);
      resultados.tarefa = { id: tarefa.id, data, hora, motivo };

      if (mensagem_agendada) {
        const cid = canal_id || creds.canalId;
        if (cid) {
          try {
            const scheduledMsg = await api("POST", "/schedule-message", {
              contactId: contato_id, body: mensagem_agendada,
              sendAt: `${data}T${hora}`, whatsappId: parseInt(cid, 10),
            }, creds);
            resultados.mensagem_agendada = { id: scheduledMsg.id, data, hora };
          } catch (e) {
            resultados.mensagem_agendada = { erro: e.message };
          }
        } else {
          resultados.mensagem_agendada = { aviso: "canal_id necessário para agendar mensagem" };
        }
      }
      return ok({ sucesso: true, ...resultados });
    }
  );

  // 10. verificar_disponibilidade
  server.tool(
    "verificar_disponibilidade",
    "Verifica quais atendentes estão online e quantos tickets abertos cada um possui.",
    {
      queue_id: z.number().optional().describe("Filtrar por fila/departamento (opcional)"),
    },
    async ({ queue_id }) => {
      const creds = credsFn();
      const usersRes = await apiWithFallback("GET", ["/users", "/v1/users"], null, creds);
      const users = usersRes.users || usersRes.data || (Array.isArray(usersRes) ? usersRes : []);

      const ticketsRes = await api("GET", "/tickets?status=open&showAll=true&pageNumber=1", null, creds);
      const tickets = ticketsRes.tickets || [];
      const ticketsPorAtendente = {};
      tickets.forEach((t) => {
        if (t.userId) ticketsPorAtendente[t.userId] = (ticketsPorAtendente[t.userId] || 0) + 1;
      });

      const atendentes = users
        .filter((u) => !queue_id || u.queues?.some((q) => q.id === queue_id))
        .map((u) => ({
          id: u.id, nome: u.name, email: u.email,
          online: u.online || false, perfil: u.profile,
          tickets_abertos: ticketsPorAtendente[u.id] || 0,
        }))
        .sort((a, b) => Number(b.online) - Number(a.online));

      return ok({
        total_atendentes: atendentes.length,
        online: atendentes.filter((a) => a.online).length,
        atendentes,
      });
    }
  );

  // 11. registrar_venda
  server.tool(
    "registrar_venda",
    "Registra uma venda: cria oportunidade no CRM, salva valor nos campos do contato e opcionalmente fecha ticket.",
    {
      contato_id: z.number().describe("ID do contato"),
      valor: z.number().describe("Valor da venda em reais"),
      produto: z.string().optional().describe("Nome do produto ou serviço vendido"),
      observacao: z.string().optional(),
      pipeline_id: z.number().optional().describe("ID do pipeline de vendas"),
      fechar_ticket: z.boolean().optional().describe("Fechar ticket após registrar a venda?"),
      numero: z.string().optional().describe("Número do cliente (necessário para fechar ticket)"),
    },
    async ({ contato_id, valor, produto, observacao, pipeline_id, fechar_ticket, numero }) => {
      const creds = credsFn();
      const resultados = {};

      try {
        const oppBody = {
          contactId: contato_id, value: valor,
          title: produto || `Venda - ${new Date().toLocaleDateString("pt-BR")}`,
          observation: observacao || "",
        };
        if (pipeline_id) oppBody.pipelineId = pipeline_id;
        const opp = await api("POST", "/opportunity/", oppBody, creds);
        resultados.oportunidade = { id: opp.id, valor, produto };
      } catch (e) {
        resultados.oportunidade_erro = e.message;
      }

      try {
        const contato = await api("GET", `/v1/contacts/${contato_id}`, null, creds);
        let campos = {};
        try { campos = JSON.parse(contato.extraInfo || contato.customFields || "{}"); } catch (_) { }
        campos.ultima_venda_valor = valor.toString();
        campos.ultima_venda_produto = produto || "";
        campos.ultima_venda_data = new Date().toISOString().split("T")[0];
        await api("PUT", `/contacts/${contato_id}`, { id: contato_id, customFields: JSON.stringify(campos) }, creds);
        resultados.campos_atualizados = true;
      } catch (e) {
        resultados.campos_erro = e.message;
      }

      if (fechar_ticket && numero) {
        try {
          const ticket = await findTicketByNumber(numero, creds);
          await api("PUT", `/tickets/${ticket.id}`, { status: "closed" }, creds);
          resultados.ticket_fechado = ticket.id;
        } catch (e) {
          resultados.ticket_erro = e.message;
        }
      }
      return ok({ sucesso: true, valor, produto, ...resultados });
    }
  );

  // 12. atualizar_etapa_funil
  server.tool(
    "atualizar_etapa_funil",
    "Atualiza etapa do lead no funil de vendas: move contato entre fases (leadStatus) e/ou oportunidade no kanban.",
    {
      contato_id: z.string().describe("ID do contato"),
      lead_status_id: z.number().optional().describe("ID da fase de lead (use listar_status_lead)"),
      opportunity_id: z.number().optional().describe("ID da oportunidade no kanban (se existir)"),
      step_id: z.number().optional().describe("ID da etapa destino no pipeline kanban"),
    },
    async ({ contato_id, lead_status_id, opportunity_id, step_id }) => {
      const creds = credsFn();
      const resultados = {};

      if (lead_status_id) {
        await api("PUT", `/contacts/${contato_id}`, { id: parseInt(contato_id, 10), leadStatusId: lead_status_id }, creds);
        resultados.lead_status = { id: lead_status_id, atualizado: true };
      }

      if (opportunity_id && step_id) {
        try {
          await api("PUT", `/opportunity/${opportunity_id}`, { id: opportunity_id, pipelineStepId: step_id }, creds);
          resultados.kanban = { opportunity_id, step_id, movido: true };
        } catch (e) {
          resultados.kanban_erro = e.message;
        }
      }

      if (!lead_status_id && !opportunity_id) {
        try {
          const pipelines = await api("GET", "/pipelines?includeSteps=true", null, creds);
          resultados.pipelines_disponiveis = pipelines;
        } catch (e) {
          resultados.info = "Informe lead_status_id e/ou opportunity_id + step_id para atualizar";
        }
      }
      return ok({ sucesso: !!(lead_status_id || opportunity_id), contato_id, ...resultados });
    }
  );
}
