import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.N8N_API_KEY_TEMP;
const clickmassaBaseUrl = process.env.CLICKMASSA_BASE_URL;
const clickmassaToken = process.env.CLICKMASSA_TOKEN;
const workflowId = "C98qQdOADhZXTqMo";
const baseUrl = "https://n8n.skplus.online/api/v1/workflows";

if (!apiKey) {
  throw new Error("N8N_API_KEY_TEMP nao foi definida.");
}

if (!clickmassaBaseUrl || !clickmassaToken) {
  throw new Error("CLICKMASSA_BASE_URL ou CLICKMASSA_TOKEN nao foram definidos.");
}

const headers = {
  "X-N8N-API-KEY": apiKey,
  "Content-Type": "application/json",
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.response = data;
    throw error;
  }

  return data;
}

function getWorkflowRoot(payload) {
  return payload?.data?.workflow || payload?.data || payload;
}

function setNodeValue(nodes, nodeName, setter) {
  const node = nodes.find((item) => item.name === nodeName);
  if (!node) throw new Error(`Node nao encontrado: ${nodeName}`);
  setter(node);
}

function ensureConnection(connections, sourceName, sourceOutput, targetName) {
  connections[sourceName] = connections[sourceName] || {};
  connections[sourceName][sourceOutput] = connections[sourceName][sourceOutput] || [[]];

  const branch = connections[sourceName][sourceOutput][0];
  const exists = branch.some((item) => item.node === targetName && item.type === sourceOutput);
  if (!exists) {
    branch.push({
      node: targetName,
      type: sourceOutput,
      index: 0,
    });
  }
}

const normalizeCode = `const payload = $input.item.json.body ?? $input.item.json;
const event = payload.event;

if (event !== 'NewMessage') {
  return [];
}

const message = payload.message ?? {};

if (message.fromMe === true || message.note === true) {
  return [];
}

const rawBody = String(message.body ?? '').replace(/\\s+/g, ' ').trim();
if (!rawBody) {
  return [];
}

const ticket = message.ticket ?? {};
const contact = ticket.contact ?? {};
const lower = rawBody.toLowerCase();
const palavras = [...new Set((lower.match(/[\\p{L}\\p{N}]+/gu) ?? []).slice(0, 12))];
const pedido_humano = /(humano|atendente|pessoa|consultor|especialista|vendedor|suporte|comercial)/i.test(lower);
const pedido_preco = /(preco|preço|valor|plano|planos|mensalidade|quanto custa|investimento|orcamento|orçamento)/i.test(lower);
const interesse_crm = /(crm|automac|automação|whatsapp|atendimento|funil|chatbot|lead|vendas|equipe)/i.test(lower);
const saudacao = /^(oi|ola|olá|opa|bom dia|boa tarde|boa noite)$/i.test(lower);
const mensagem_fragmentada = rawBody.length <= 18 || palavras.length <= 3 || /^(crm|preco|preço|valor|planos?|como|duvida|dúvida|ajuda|oi|ola|olá)$/i.test(lower);

return [{
  json: {
    numero_cliente: contact.number,
    mensagem_cliente: rawBody,
    sessionId: String(ticket.id),
    ticketId: ticket.id,
    contactId: contact.id,
    contactName: contact.name || 'Cliente',
    event,
    mediaType: message.mediaType,
    pedido_humano,
    pedido_preco,
    interesse_crm,
    saudacao,
    mensagem_fragmentada,
    palavras_chave: palavras.join(', '),
    contexto_detectado: pedido_humano
      ? 'pedido_humano'
      : pedido_preco
        ? 'pedido_preco'
        : interesse_crm
          ? 'interesse_crm'
          : saudacao
            ? 'saudacao'
            : 'conversa_geral'
  }
}];`;

const agentText = `=Mensagem atual do lead: {{ $json.mensagem_cliente }}

Sinais do atendimento:
- Cliente: {{ $json.contactName }}
- Numero: {{ $json.numero_cliente }}
- Ticket: {{ $json.ticketId }}
- Contexto detectado: {{ $json.contexto_detectado }}
- Pedido de humano: {{ $json.pedido_humano }}
- Pedido de preco: {{ $json.pedido_preco }}
- Interesse em CRM: {{ $json.interesse_crm }}
- Mensagem fragmentada: {{ $json.mensagem_fragmentada }}
- Palavras-chave: {{ $json.palavras_chave }}`;

const systemMessage = `=Voce e um SDR consultivo e especialista da ClickMassa. Seu papel e atender leads no WhatsApp com clareza, contexto e postura comercial, sem parecer robo.

OBJETIVOS
1. Tirar duvidas de forma objetiva e coerente.
2. Entender o cenario do lead e qualificar sem interrogatorio chato.
3. Levar para humano somente quando o lead pedir explicitamente ou quando ja houver contexto suficiente para avancar comercialmente.

SOBRE A CLICKMASSA
- CRM com atendimento de varios atendentes no mesmo numero de WhatsApp.
- Chatbot, funis de mensagens, notas internas e tarefas.
- Integracoes com plataformas e webhooks.
- Foco em organizacao comercial, velocidade no atendimento e acompanhamento de leads.
- Diferencial comercial: assinatura mensal e operacao forte em WhatsApp e CRM.

COMPORTAMENTO OBRIGATORIO
- Responda primeiro a duvida atual do lead e depois faca no maximo 1 pergunta de qualificacao por vez.
- Seja natural, direto e comercial. Nada de texto generico ou palestra longa.
- Se o lead mandar mensagem curta ou picotada, use a memoria da conversa para inferir o contexto antes de responder.
- Nunca responda "nao entendi" de primeira para mensagens curtas como "crm", "preco", "como funciona" ou semelhantes.
- Para mensagens vagas, assuma a interpretacao mais provavel, responda de forma util e em seguida peca confirmacao curta.

QUALIFICACAO
- Descubra com naturalidade: segmento ou empresa, principal problema, quantidade de atendentes ou volume de conversas, e se usa CRM ou WhatsApp hoje.
- Se descobrir o nome do lead, atualize o contato com \`atualizar_contato\`.
- Quando houver interesse real e contexto minimo, adicione a tag \`Lead Qualificado\` com \`adicionar_etiquetas\`.
- Antes de transferir, registre uma nota interna com resumo do contexto usando \`enviar_nota_interna\`.

DUVIDAS COMUNS
- Se o lead falar apenas "crm", explique brevemente o que a ClickMassa faz em CRM e pergunte qual processo ele quer organizar.
- Se perguntar preco, explique que depende do cenario e pergunte quantos atendentes ou qual operacao ele quer estruturar.
- Se perguntar processo de implantacao, explique de forma simples: diagnostico, configuracao, treinamento e acompanhamento.

TRANSFERENCIA PARA HUMANO
- Se o lead pedir humano, atendente, consultor ou especialista, considere isso prioridade.
- Fluxo obrigatorio:
1. Use \`enviar_nota_interna\` resumindo o que o lead quer.
2. Use \`enviar_mensagem\` dizendo exatamente: "Perfeito, vou te encaminhar para um especialista agora."
3. Prefira a tool \`Transferencia Segura Ticket\` informando o \`ticketId\` atual.
4. Se a tool de transferencia segura nao estiver disponivel, use \`escalar_para_atendente\` com \`user_id: 173\`.
- Nunca diga apenas "transferindo".
- Nunca invente IDs e nunca use null.

REGRAS DE RESPOSTA
- Sempre envie a resposta ao lead com \`enviar_mensagem\` para o numero {{ $('Normalizar Payload').item.json.numero_cliente }}.
- Nunca responda somente em texto puro no output final do agente.
- Mantenha respostas curtas, uteis e coerentes com o historico.

DADOS DO ATENDIMENTO
- Cliente: {{ $('Normalizar Payload').item.json.contactName }} ({{ $('Normalizar Payload').item.json.numero_cliente }})
- Ticket: {{ $('Normalizar Payload').item.json.ticketId }}`;

const payload = await request(`${baseUrl}/${workflowId}`, { method: "GET" });
const workflow = getWorkflowRoot(payload);

const backupPath = path.join(process.cwd(), `workflow-backup-${workflowId}.json`);
await fs.writeFile(backupPath, JSON.stringify(workflow, null, 2), "utf8");

setNodeValue(workflow.nodes, "Normalizar Payload", (node) => {
  node.parameters.jsCode = normalizeCode;
});

setNodeValue(workflow.nodes, "AI Agent CRM", (node) => {
  node.parameters.text = agentText;
  node.parameters.options = node.parameters.options || {};
  node.parameters.options.systemMessage = systemMessage;
});

setNodeValue(workflow.nodes, "Window Buffer Memory", (node) => {
  node.parameters.contextWindowLength = 20;
});

setNodeValue(workflow.nodes, "OpenAI Chat Model", (node) => {
  node.parameters.options = node.parameters.options || {};
  node.parameters.options.temperature = 0.2;
});

const safeTransferNodeName = "Transferencia Segura Ticket";
const safeTransferNode = workflow.nodes.find((node) => node.name === safeTransferNodeName);
const safeTransferParameters = {
  toolDescription:
    "Use esta tool para transferir com seguranca o ticket atual para o atendente humano Administrador (user_id 173). Sempre informe o ticketId atual do atendimento.",
  method: "PUT",
  url: `${clickmassaBaseUrl}/tickets/{ticketId}`,
  authentication: "none",
  sendHeaders: true,
  specifyHeaders: "keypair",
  parametersHeaders: {
    values: [
      {
        name: "Authorization",
        valueProvider: "fieldValue",
        value: `Bearer ${clickmassaToken}`,
      },
      {
        name: "Content-Type",
        valueProvider: "fieldValue",
        value: "application/json",
      },
    ],
  },
  sendBody: true,
  specifyBody: "json",
  jsonBody: "{\"userId\":173}",
  placeholderDefinitions: {
    values: [
      {
        name: "ticketId",
        type: "string",
        description: "ID do ticket atual do cliente no ClickMassa",
      },
    ],
  },
  optimizeResponse: true,
};

if (safeTransferNode) {
  safeTransferNode.parameters = safeTransferParameters;
} else {
  workflow.nodes.push({
    id: "node-transfer-safe",
    name: safeTransferNodeName,
    type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
    typeVersion: 1.1,
    position: [1216, 656],
    parameters: safeTransferParameters,
  });
}

ensureConnection(workflow.connections, safeTransferNodeName, "ai_tool", "AI Agent CRM");

const updateBody = {
  name: workflow.name,
  nodes: workflow.nodes,
  connections: workflow.connections,
  settings: {
    executionOrder: workflow.settings?.executionOrder || "v1",
  },
};

let result;
try {
  result = await request(`${baseUrl}/${workflowId}`, {
    method: "PATCH",
    body: JSON.stringify(updateBody),
  });
} catch (patchError) {
  result = await request(`${baseUrl}/${workflowId}`, {
    method: "PUT",
    body: JSON.stringify(updateBody),
  });
}

const refreshedPayload = await request(`${baseUrl}/${workflowId}`, { method: "GET" });
const refreshed = getWorkflowRoot(refreshedPayload);

const summary = {
  updatedWorkflowId: workflowId,
  normalizePreview: refreshed.nodes.find((node) => node.name === "Normalizar Payload")?.parameters?.jsCode?.slice(0, 220),
  agentTextPreview: refreshed.nodes.find((node) => node.name === "AI Agent CRM")?.parameters?.text,
  memoryWindow: refreshed.nodes.find((node) => node.name === "Window Buffer Memory")?.parameters?.contextWindowLength,
  temperature: refreshed.nodes.find((node) => node.name === "OpenAI Chat Model")?.parameters?.options?.temperature,
  updateResult: result,
};

console.log(JSON.stringify(summary, null, 2));
