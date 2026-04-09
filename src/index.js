#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  // Ignorar se não conseguir carregar o dotenv
}
// ─── Config ────────────────────────────────────────────────────────────────
// Lidas de variáveis de ambiente (defina no .env ou no mcp_config.json)
const BASE_URL = process.env.CLICKMASSA_BASE_URL;   // ex: https://enterprise-40api.seudominio.com.br
const TOKEN    = process.env.CLICKMASSA_TOKEN;       // Bearer token do PUSH/API
const CANAL_ID = process.env.CLICKMASSA_CANAL_ID;   // ID do canal (API/Webhook)

const EMAIL    = process.env.CLICKMASSA_EMAIL;       // E-mail de login (resolução para tickets)
const PASSWORD = process.env.CLICKMASSA_PASSWORD;    // Senha de login (resolução para tickets)
let userSessionToken = null;

if (!BASE_URL || !TOKEN) {
  process.stderr.write("[clickmassa-mcp] ERRO: defina CLICKMASSA_BASE_URL e CLICKMASSA_TOKEN\n");
  process.exit(1);
}

// ─── Helper para Obter Token de Sessão ──────────────────────────────────────
async function getUserToken() {
  if (userSessionToken) return userSessionToken;
  if (!EMAIL || !PASSWORD) return TOKEN; // Fallback
  try {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD })
    });
    const text = await res.text();
    const data = JSON.parse(text);
    if (data.token) {
      userSessionToken = data.token;
      return userSessionToken;
    }
  } catch (e) {
    process.stderr.write(`[clickmassa-mcp] Erro no auto-login: ${e.message}\n`);
  }
  return TOKEN; 
}

// ─── Helper HTTP ────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  
  // Priorizar token de sessão (User Login) para TUDO, se disponível.
  // Isso garante permissões de dashboard e evita custos de Push API em várias rotas.
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
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(`ClickMassa ${method} ${path} → ${res.status}: ${text}`);
  }
  return data;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ─── Servidor MCP ───────────────────────────────────────────────────────────
const server = new McpServer({
  name: "clickmassa",
  version: "1.0.0",
});

// ════════════════════════════════════════════════════════════════
// CONTATOS
// ════════════════════════════════════════════════════════════════

server.tool(
  "buscar_contato_por_numero",
  "Busca um contato na ClickMassa pelo número de WhatsApp. Retorna id, nome, e-mail, tags e campos customizados.",
  {
    numero: z.string().describe(
      "Número com DDI+DDD sem espaços ou caracteres especiais. Ex: 5527999990000"
    ),
  },
  async ({ numero }) => {
    const data = await api("GET", `/v1/contacts/number/${numero}`);
    return ok(data);
  }
);

server.tool(
  "buscar_contato_por_id",
  "Busca um contato na ClickMassa pelo seu ID interno.",
  {
    id: z.string().describe("ID interno do contato na ClickMassa"),
  },
  async ({ id }) => {
    const data = await api("GET", `/v1/contacts/${id}`);
    return ok(data);
  }
);

server.tool(
  "listar_contatos",
  "Lista todos os contatos da conta ClickMassa.",
  {},
  async () => {
    const data = await api("GET", "/v1/contacts/");
    return ok(data);
  }
);

server.tool(
  "criar_contato",
  "Cria um novo contato na ClickMassa.",
  {
    nome:   z.string().describe("Nome completo do contato"),
    numero: z.string().describe("Número WhatsApp com DDI+DDD. Ex: 5527999990000"),
    email:  z.string().optional().describe("E-mail do contato (opcional)"),
    tags:   z.array(z.string()).optional().describe("Lista de etiquetas (opcional)"),
    campos_customizados: z.record(z.string()).optional().describe(
      "Campos customizados em formato chave-valor. Ex: { 'cpf_cliente': '123.456.789-00' }"
    ),
  },
  async ({ nome, numero, email, tags, campos_customizados }) => {
    const body = { name: nome, number: numero };
    if (email) body.email = email;
    if (tags?.length) body.tags = tags;
    if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
    const data = await api("POST", "/v1/contacts/", body);
    return ok(data);
  }
);

server.tool(
  "atualizar_contato",
  "Atualiza dados de um contato existente na ClickMassa (nome, e-mail, tags, leadStatusId ou leadOriginId).",
  {
    id: z.string().describe("ID interno do contato"),
    nome:   z.string().optional(),
    email:  z.string().optional(),
    leadStatusId: z.number().optional().describe("ID da fase do lead (veja listar_status_lead)"),
    leadOriginId: z.number().optional().describe("ID da origem do lead (veja listar_origens_lead)"),
    tags:   z.array(z.string()).optional().describe(
      "Nova lista completa de tags. ATENÇÃO: tags não listadas aqui NÃO são apagadas — apenas as informadas são adicionadas."
    ),
    campos_customizados: z.record(z.string()).optional().describe(
      "Campos customizados. ATENÇÃO: substitui TODOS os campos existentes. Busque o contato antes para preservar campos já preenchidos."
    ),
  },
  async ({ id, nome, email, leadStatusId, leadOriginId, tags, campos_customizados }) => {
    // Para atualizar metadados de lead, usamos o Dashboard API (PUT /contacts/:id)
    const body = { id: parseInt(id) };
    if (nome)  body.name  = nome;
    if (email) body.email = email;
    if (leadStatusId) body.leadStatusId = leadStatusId;
    if (leadOriginId) body.leadOriginId = leadOriginId;
    if (tags)  body.tags  = tags;
    if (campos_customizados) body.customFields = JSON.stringify(campos_customizados);
    
    // Tentamos usar o endpoint do dashboard primeiro para os metadados
    const data = await api("PUT", `/contacts/${id}`, body);
    return ok(data);
  }
);

server.tool(
  "adicionar_etiquetas",
  "Adiciona etiquetas a um contato sem apagar as existentes.",
  {
    id:   z.string().describe("ID do contato"),
    tags: z.array(z.string()).describe("Etiquetas a adicionar"),
  },
  async ({ id, tags }) => {
    const data = await api("PATCH", `/v1/contacts/${id}`, { tags });
    return ok(data);
  }
);

server.tool(
  "remover_todas_etiquetas",
  "Remove todas as etiquetas de um contato.",
  {
    id: z.string().describe("ID do contato"),
  },
  async ({ id }) => {
    const data = await api("PATCH", `/v1/contacts/${id}`, { tags: [] });
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// ENVIO DE MENSAGENS (PUSH)
// ════════════════════════════════════════════════════════════════

server.tool(
  "enviar_mensagem_direta",
  "Envia uma mensagem de texto como o usuário logado (sem consumir créditos de Push/API). Útil quando o saldo de créditos é zero.",
  {
    numero:   z.string().describe("Número destino com DDI+DDD."),
    mensagem: z.string().describe("Texto a ser enviado"),
  },
  async ({ numero, mensagem }) => {
    // 1. Encontrar o ticket aberto
    const search = await api("GET", `/tickets?searchParam=${numero}&showAll=true`);
    let ticket = search.tickets?.find(t => t.contact.number === numero && (t.status === "open" || t.status === "pending"));
    
    if (!ticket) {
      throw new Error(`Nenhum ticket aberto ou pendente encontrado para o número ${numero}. Abra um ticket no painel primeiro.`);
    }

    // 2. Enviar a mensagem para o ticket encontrado
    const data = await api("POST", `/messages/${ticket.id}`, { body: mensagem });
    return ok(data);
  }
);

server.tool(
  "enviar_mensagem",
  "Envia uma mensagem de texto para um número de WhatsApp via ClickMassa (push). Cria ou reabre o ticket automaticamente.",
  {
    numero:       z.string().describe("Número destino com DDI+DDD. Ex: 5527999990000"),
    mensagem:     z.string().describe("Texto a ser enviado ao cliente"),
    external_key: z.string().optional().describe("Chave de rastreio nos logs (qualquer valor)"),
    canal_id:     z.string().optional().describe("ID do canal. Usa CLICKMASSA_CANAL_ID do .env se omitido."),
  },
  async ({ numero, mensagem, external_key, canal_id }) => {
    const cid = canal_id || CANAL_ID;
    if (!cid) throw new Error("Informe canal_id ou defina CLICKMASSA_CANAL_ID no .env");
    const body = {
      number:      numero,
      body:        mensagem,
      externalKey: external_key || `mcp-${Date.now()}`,
    };
    const data = await api("POST", `/v1/api/external/${cid}`, body);
    return ok(data);
  }
);

server.tool(
  "enviar_midia",
  "Envia um arquivo (imagem, PDF, áudio, vídeo) para um número de WhatsApp via ClickMassa.",
  {
    numero:    z.string().describe("Número destino com DDI+DDD"),
    url_midia: z.string().describe("URL pública do arquivo a ser enviado"),
    legenda:   z.string().optional().describe("Texto que acompanha a mídia (opcional)"),
    canal_id:  z.string().optional(),
  },
  async ({ numero, url_midia, legenda, canal_id }) => {
    const cid = canal_id || CANAL_ID;
    if (!cid) throw new Error("Informe canal_id ou defina CLICKMASSA_CANAL_ID no .env");
    const body = {
      number:      numero,
      body:        legenda || "",
      externalKey: `mcp-media-${Date.now()}`,
      mediaUrl:    url_midia,
    };
    const data = await api("POST", `/v1/api/external/${cid}`, body);
    return ok(data);
  }
);

server.tool(
  "enviar_nota_interna",
  "Envia uma nota interna (visível apenas para atendentes) sem enviar nada ao cliente.",
  {
    numero:  z.string().describe("Número do contato vinculado ao ticket"),
    nota:    z.string().describe("Texto da nota interna"),
    canal_id: z.string().optional(),
  },
  async ({ numero, nota, canal_id }) => {
    const cid = canal_id || CANAL_ID;
    if (!cid) throw new Error("Informe canal_id ou defina CLICKMASSA_CANAL_ID no .env");
    const body = {
      number:      numero,
      body:        "",
      externalKey: `mcp-note-${Date.now()}`,
      onlyNote:    true,
      note:        { body: nota },
    };
    const data = await api("POST", `/v1/api/external/${cid}`, body);
    return ok(data);
  }
);

server.tool(
  "escalar_para_atendente",
  "Escala o atendimento para um atendente humano específico. Diferente da anterior, esta versão não consome créditos por mensagem externa.",
  {
    numero:    z.string().describe("Número do cliente"),
    user_id:   z.number().describe("ID do atendente na ClickMassa"),
  },
  async ({ numero, user_id }) => {
    // 1. Encontrar o ticket aberto/pendente deste número
    const search = await api("GET", `/tickets?searchParam=${numero}&showAll=true`);
    const ticket = search.tickets?.find(t => t.contact.number === numero && (t.status === "open" || t.status === "pending"));
    
    if (!ticket) {
      throw new Error(`Nenhum ticket aberto ou pendente encontrado para o número ${numero}`);
    }

    // 2. Atualizar o ticket diretamente (PUT)
    const data = await api("PUT", `/tickets/${ticket.id}`, { userId: user_id });
    return ok(data);
  }
);

server.tool(
  "devolver_para_fila",
  "Devolve um ticket para a fila de espera, removendo a atribuição do atendente atual.",
  {
    numero: z.string().describe("Número do cliente"),
  },
  async ({ numero }) => {
    const search = await api("GET", `/tickets?searchParam=${numero}&showAll=true`);
    const ticket = search.tickets?.find(t => t.contact.number === numero && (t.status === "open" || t.status === "pending"));
    
    if (!ticket) {
      throw new Error(`Nenhum ticket aberto ou pendente encontrado para o número ${numero}`);
    }

    // Define userId como null e status como pending para voltar à fila
    const data = await api("PUT", `/tickets/${ticket.id}`, { userId: null, status: "pending" });
    return ok(data);
  }
);

server.tool(
  "escalar_para_departamento",
  "Escala o atendimento para um departamento (fila) específico sem consumir créditos.",
  {
    numero:       z.string().describe("Número do cliente"),
    queue_id:     z.number().describe("ID do departamento/fila na ClickMassa"),
  },
  async ({ numero, queue_id }) => {
    // 1. Encontrar o ticket
    const search = await api("GET", `/tickets?searchParam=${numero}&showAll=true`);
    const ticket = search.tickets?.find(t => t.contact.number === numero && (t.status === "open" || t.status === "pending"));
    
    if (!ticket) {
      throw new Error(`Nenhum ticket aberto ou pendente encontrado para o número ${numero}`);
    }

    // 2. Atualizar a fila do ticket diretamente
    const data = await api("PUT", `/tickets/${ticket.id}`, { queueId: queue_id });
    return ok(data);
  }
);

server.tool(
  "fechar_ticket",
  "Fecha o ticket de atendimento de um contato na ClickMassa.",
  {
    numero:            z.string().describe("Número do cliente"),
    closing_reason_id: z.number().optional().describe("ID do motivo de fechamento (opcional)"),
    canal_id:          z.string().optional(),
  },
  async ({ numero, closing_reason_id, canal_id }) => {
    const cid = canal_id || CANAL_ID;
    if (!cid) throw new Error("Informe canal_id ou defina CLICKMASSA_CANAL_ID no .env");
    const body = {
      number:              numero,
      body:                "",
      externalKey:         `mcp-close-${Date.now()}`,
      forceTicketToClosed: true,
    };
    if (closing_reason_id) body.closingReasonId = closing_reason_id;
    const data = await api("POST", `/v1/api/external/${cid}`, body);
    return ok(data);
  }
);

server.tool(
  "listar_tickets_pendentes",
  "Lista os tickets que estão aguardando na fila (pendentes).",
  {
    pagina: z.number().optional().describe("Número da página (default: 1)"),
    busca: z.string().optional().describe("Termo de busca"),
    queue_ids: z.array(z.number()).optional().describe("Filtro por IDs de fila (opcional)"),
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
    if (queue_ids && queue_ids.length > 0) {
      queue_ids.forEach(id => url += `&queuesIds[]=${id}`);
    }
    const data = await api("GET", url);
    return ok(data);
  }
);

server.tool(
  "listar_tickets_abertos",
  "Lista os tickets que estão em atendimento (abertos).",
  {
    pagina: z.number().optional().describe("Número da página (default: 1)"),
    busca: z.string().optional().describe("Termo de busca"),
    queue_ids: z.array(z.number()).optional().describe("Filtro por IDs de fila (opcional)"),
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
    if (queue_ids && queue_ids.length > 0) {
      queue_ids.forEach(id => url += `&queuesIds[]=${id}`);
    }
    const data = await api("GET", url);
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// ETIQUETAS
// ════════════════════════════════════════════════════════════════

server.tool(
  "listar_etiquetas",
  "Lista todas as etiquetas cadastradas na conta ClickMassa.",
  {},
  async () => {
    const data = await api("GET", "/v1/labels");
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// USUÁRIOS / ATENDENTES
// ════════════════════════════════════════════════════════════════

server.tool(
  "listar_atendentes",
  "Lista todos os atendentes (usuários) cadastrados na conta ClickMassa.",
  {},
  async () => {
    const data = await api("GET", "/users");
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// GESTÃO DE LEADS (METADADOS)
// ════════════════════════════════════════════════════════════════

server.tool(
  "listar_origens_lead",
  "Lista todas as origens de leads cadastradas (ex: Facebook, Organico, Indicação). Retorna os IDs usados no contato.",
  {},
  async () => {
    const data = await api("GET", "/lead-origin");
    return ok(data);
  }
);

server.tool(
  "listar_status_lead",
  "Lista todas as fases de lead cadastradas (ex: Novo Lead, Qualificado). Retorna os IDs usados no contato.",
  {},
  async () => {
    const data = await api("GET", "/lead-status");
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// GESTÃO DE TAREFAS
// ════════════════════════════════════════════════════════════════

server.tool(
  "listar_tarefas",
  "Lista as tarefas agendadas no sistema com filtros de data e status.",
  {
    data_inicio: z.string().describe("Data inicial YYYY-MM-DD (ex: 2026-04-01)"),
    data_fim:    z.string().describe("Data final YYYY-MM-DD (ex: 2026-12-31)"),
    concluidas:  z.boolean().optional().describe("Filtrar por tarefas concluídas (true) ou pendentes (false)"),
    pagina:      z.number().optional().describe("Número da página (default: 1)"),
  },
  async ({ data_inicio, data_fim, concluidas = false, pagina = 1 }) => {
    const query = new URLSearchParams({
      startDate: data_inicio,
      endDate: data_fim,
      completed: concluidas.toString(),
      pageNumber: pagina.toString(),
    });
    const data = await api("GET", `/tasks/pages?${query.toString()}`);
    return ok(data);
  }
);

server.tool(
  "criar_tarefa",
  "Cria uma nova tarefa ou compromisso para um atendente e contato.",
  {
    titulo:       z.string().describe("Título da tarefa"),
    contato_id:   z.number().describe("ID do contato vinculado"),
    responsavel_id: z.number().describe("ID do atendente (Eduardo=170, Alex=184)"),
    data:         z.string().describe("Data YYYY-MM-DD"),
    hora:         z.string().optional().describe("Hora HH:mm:ss (ex: 14:00:00)"),
    tipo:         z.enum(["T", "L", "C"]).optional().describe("Tipo: T=Tarefa, L=Ligação, C=Compromisso. Default: T"),
    observacao:   z.string().optional().describe("Detalhes da tarefa"),
    duracao_min:  z.number().optional().describe("Duração em minutos. Default: 30"),
  },
  async ({ titulo, contato_id, responsavel_id, data, hora = "09:00:00", tipo = "T", observacao, duracao_min = 30 }) => {
    const body = {
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
      notifyContact: false
    };
    const data_res = await api("POST", "/tasks", body);
    return ok(data_res);
  }
);

// ════════════════════════════════════════════════════════════════
// FLUXOS DE CHAT (CHATBOTS)
// ════════════════════════════════════════════════════════════════

server.tool(
  "listar_fluxos_chat",
  "Lista os fluxos de chatbot (Chat Flows) configurados no sistema.",
  {},
  async () => {
    const data = await api("GET", "/chat-flow");
    return ok(data);
  }
);

server.tool(
  "atribuir_fluxo_chat",
  "Atribui um fluxo de chatbot específico a um ticket ou remove o fluxo atual.",
  {
    numero:      z.string().describe("Número do cliente"),
    fluxo_id:    z.number().nullable().describe("ID do fluxo de chat ou null para desativar"),
  },
  async ({ numero, fluxo_id }) => {
    const search = await api("GET", `/tickets?searchParam=${numero}&showAll=true`);
    const ticket = search.tickets?.find(t => t.contact.number === numero && (t.status === "open" || t.status === "pending"));
    
    if (!ticket) {
      throw new Error(`Nenhum ticket aberto ou pendente encontrado para o número ${numero}`);
    }

    const data = await api("PUT", `/tickets/${ticket.id}`, { chatFlowId: fluxo_id });
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// MONITORAMENTO DE CHAMADAS
// ════════════════════════════════════════════════════════════════

server.tool(
  "verificar_chamadas_perdidas",
  "Realiza uma varredura nos tickets recentes em busca de registros de chamadas perdidas ou rejeitadas.",
  {
    limite_tickets: z.number().optional().describe("Número de tickets recentes a verificar (default: 10)"),
  },
  async ({ limite_tickets = 10 }) => {
    const search = await api("GET", `/tickets?showAll=true&pageNumber=1`);
    const tickets = search.tickets || [];
    const results = [];

    for (const ticket of tickets.slice(0, limite_tickets)) {
      const msgRes = await api("GET", `/messages/${ticket.id}`);
      const msgs = msgRes.messages || msgRes.data || (Array.isArray(msgRes) ? msgRes : []);
      
      const calls = msgs.filter(m => 
        m.mediaType === "call_log" || 
        m.body?.toLowerCase().includes("chamada") ||
        m.body?.toLowerCase().includes("call")
      );

      if (calls.length > 0) {
        results.push({
          ticketId: ticket.id,
          contato: ticket.contact.name,
          numero: ticket.contact.number,
          chamadas: calls.map(c => ({ data: c.createdAt, corpo: c.body }))
        });
      }
    }

    return ok({ total_tickets_verificados: Math.min(tickets.length, limite_tickets), chamadas_encontradas: results });
  }
);

// ════════════════════════════════════════════════════════════════
// FUNIS DE MENSAGENS (FOLLOW-UP)
// ════════════════════════════════════════════════════════════════

server.tool(
  "listar_funis",
  "Lista todos os funis de mensagem (réguas de follow-up) cadastrados.",
  {},
  async () => {
    const data = await api("GET", "/funnel");
    return ok(data);
  }
);

server.tool(
  "atribuir_funil_contato",
  "Vincula um contato a um funil de mensagens para iniciar o follow-up automático.",
  {
    contato_id: z.number().describe("ID interno do contato"),
    funnel_id:  z.number().describe("ID do funil de mensagens"),
  },
  async ({ contato_id, funnel_id }) => {
    // Nota: O endpoint padrão para vincular contato a funil costuma ser /funnel-contact
    const data = await api("POST", "/funnel-contact", { 
      funnelId: funnel_id, 
      contactId: contato_id 
    });
    return ok(data);
  }
);

server.tool(
  "listar_conexoes_whatsapp",
  "Lista as conexões de WhatsApp (Canais) disponíveis para saber qual sessionId usar em funis e mensagens.",
  {},
  async () => {
    const data = await api("GET", "/whatsapp");
    return ok(data);
  }
);

server.tool(
  "criar_funil",
  "Cria um novo funil de mensagens (régua de follow-up) com etapas customizadas.",
  {
    nome: z.string().describe("Nome do funil"),
    whatsapp_id: z.number().describe("ID da conexão de WhatsApp (sessionId)"),
    acao_ao_finalizar: z.enum(["C", "N"]).optional().describe("Ação: C = Fechar atendimento, N = Nenhuma. Default: N"),
    etapas: z.array(z.object({
      mensagem: z.string().describe("Texto da mensagem"),
      minutos_atraso: z.number().describe("Minutos após a etapa anterior (ou após entrar no funil se for a primeira)"),
      ordem: z.number().describe("Ordem da etapa (1, 2, 3...)")
    })).describe("Lista de etapas do funil")
  },
  async ({ nome, whatsapp_id, acao_ao_finalizar = "N", etapas }) => {
    const body = {
      name: nome,
      sessionId: whatsapp_id,
      action: acao_ao_finalizar,
      steps: etapas.map(e => ({
        message: e.mensagem,
        minutesLater: e.minutos_atraso,
        order: e.ordem
      }))
    };
    const data = await api("POST", "/funnel", body);
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// EVENTOS PUSH (WEBHOOKS EXTERNOS)
// ════════════════════════════════════════════════════════════════

const SUPER_API_URL = "https://superapi.clickmassa.com.br";

server.tool(
  "listar_eventos_push",
  "Lista todos os eventos push e webhooks configurados nas plataformas (Kiwify, Eduzz, ClickMetrics, etc.).",
  {},
  async () => {
    const data = await api("GET", `${SUPER_API_URL}/push-event`);
    return ok(data);
  }
);

server.tool(
  "criar_evento_push",
  "Configura um novo gatilho de Push (Webhook) para receber dados de plataformas externas.",
  {
    nome: z.string().describe("Nome identificador do push"),
    plataforma: z.string().describe("Nome da plataforma (ex: ClickMetrics, KiwiFy, Eduzz, Nutror)"),
    evento: z.string().describe("Nome do evento (ex: Formulário do Facebook, Venda Aprovada)"),
    whatsapp_id: z.number().describe("ID da conexão de WhatsApp (sessionId)"),
    mensagem: z.string().describe("Mensagem automática a ser enviada. Use {{variável}} para campos dinâmicos."),
    acao: z.enum(["C", "N"]).optional().describe("Ação inicial: C = Criar ticket/Fechar, N = Nenhuma. Default: N")
  },
  async ({ nome, plataforma, evento, whatsapp_id, mensagem, acao = "N" }) => {
    const body = {
      name: nome,
      platform: plataforma,
      event: evento,
      sessionId: whatsapp_id,
      message: mensagem,
      action: acao,
      active: true
    };
    const data = await api("POST", `${SUPER_API_URL}/push-event`, body);
    return ok(data);
  }
);

// ════════════════════════════════════════════════════════════════
// Start
// ════════════════════════════════════════════════════════════════
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[clickmassa-mcp] Servidor iniciado via stdio\n");
