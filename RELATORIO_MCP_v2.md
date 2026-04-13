# Relatório de Evolução — ClickMassa MCP v2.0.0
**Data:** 2026-04-11 | **Tarefa:** melhorar-mcp (scheduled task)

---

## 1. Diagnóstico Técnico do MCP e do CRM

### 1.1 CRM Inspecionado

| Item | Valor |
|------|-------|
| Plataforma | Flemy CRM (fork ClickMassa) |
| URL do App | https://app.flemy.com.br |
| **URL da API** | **https://appapi.flemy.com.br** |
| Autenticação | Bearer JWT (armazenado em localStorage) |
| TenantId | 27 |
| TenantUID | 4f803c5f-c501-4b0e-8348-5933e9d9b671 |

### 1.2 Endpoints Mapeados

**Autenticação:**
- `POST /auth/login` → retorna JWT token
- `POST /auth/logout`
- `POST /auth/refresh_token`

**Contatos:**
- `GET /v1/contacts/` — listar
- `GET /v1/contacts/number/:number` — busca por WhatsApp
- `GET /v1/contacts/:id` — busca por ID
- `POST /v1/contacts/` — criar
- `PUT /contacts/:id` — atualizar (dashboard API)
- `PATCH /v1/contacts/:id` — atualização parcial (tags)

**Tickets:**
- `GET /tickets` — listar com filtros
- `PUT /tickets/:id` — atualizar (status, userId, queueId, chatFlowId)
- `GET /tickets/:id/lastTicket`
- `GET /tickets-search` — busca avançada
- `POST /tickets-bulk-action` — ações em lote

**Mensagens:**
- `POST /messages/:ticketId` — enviar (suporta `isPrivate: true` para notas)
- `GET /messages/:ticketId` — histórico
- `POST /messages/:id/resend` — reenviar
- `POST /v1/api/external/:canalId` — Push API (cria/reabre ticket)

**Leads / Pipeline:**
- `GET /lead-status/` — fases de lead
- `GET /lead-origin/` — origens de lead
- `GET /pipelines?includeSteps=true` — funis kanban
- `GET /pipelines/:id` — detalhe do pipeline
- `POST /opportunity/` — criar oportunidade/venda
- `PUT /opportunity/:id` — mover etapa no kanban
- `GET /opportunity/search` — buscar oportunidades

**Tarefas / Agenda:**
- `GET /tasks/pages` — listar tarefas
- `POST /tasks` — criar tarefa
- `POST /schedule-message` — agendar mensagem automática

**Usuários / Filas:**
- `GET /users` — atendentes
- `GET /queue/` — filas/departamentos

**Chatbot / Funis:**
- `GET /chat-flow` — fluxos de chatbot
- `GET /funnel/` — funis de mensagem
- `POST /funnel/` — criar funil
- `POST /funnel-contact` — vincular contato a funil
- `GET /whatsapp` — conexões WhatsApp

**Outros:**
- `GET /blacklist/check-number/:number` — verificar blacklist
- `GET /closing-reason/` — motivos de fechamento
- `GET /tags/` — tags
- `POST /schedule-message` — mensagem agendada
- `GET /tenants/credits` — saldo de créditos
- `GET /reports/pipeline-steps-work` — relatórios

---

### 1.3 Limitações do MCP v1 (identificadas)

| # | Limitação | Impacto | Severidade |
|---|-----------|---------|-----------|
| 1 | **Single-tenant**: credenciais fixas no processo | Impossibilita multi-tenancy | 🔴 Crítico |
| 2 | **Duplicação total**: `index.js` e `index-sse.js` tinham 100% de código repetido | Manutenção dobrada, bugs desincronizados | 🔴 Crítico |
| 3 | **Sem TTL no token cache**: `userSessionToken` nunca expira | Tokens expirados causam 401s silenciosos | 🟠 Alto |
| 4 | **Sem auto-retry em 401**: falha ao token expirar sem tentar renovar | Sessões longas quebram silenciosamente | 🟠 Alto |
| 5 | **12 ferramentas faltando** do roadmap definido | Agentes de IA sem capacidade de qualificação, objeções, vendas | 🟠 Alto |
| 6 | **Sem CORS**: SSE bloqueado em contextos browser | Impossibilita frontend direto | 🟡 Médio |
| 7 | **Sem health/info endpoint** no SSE | Sem monitoramento, sem descoberta de capacidades | 🟡 Médio |
| 8 | **index.js não tinha** `findTicketByNumber` helper | Código inconsistente entre arquivos | 🟡 Médio |
| 9 | **Sem tracking de conexões** no SSE | Impossível monitorar tenants conectados | 🟡 Médio |

---

## 2. Arquitetura v2.0.0 Implementada

### 2.1 Estrutura de Arquivos

```
clickmassa-mcp/
├── src/
│   ├── tools.js        ← NOVO: módulo compartilhado com todas as 44 ferramentas
│   ├── index.js        ← REFATORADO: STDIO single-tenant (importa tools.js)
│   └── index-sse.js    ← REFATORADO: HTTP/SSE multi-tenant (importa tools.js)
├── .env.example
├── package.json
└── RELATORIO_MCP_v2.md  ← este arquivo
```

### 2.2 Fluxo Multi-tenant (Option B — Headers por Request)

```
GapHub-Ai Frontend
       │
       │  GET /sse?base_url=https://appapi.clienteX.com&token=TOKEN_X&canal_id=CANAL_X
       ▼
  index-sse.js (HTTP Server :3100)
       │
       ├─ Extrai credenciais de query params OU headers x-clickmassa-*
       ├─ Fallback para ENV se não fornecido
       ├─ Valida: base_url + token obrigatórios → 401 se ausentes
       │
       ├─ credsFn = () => { baseUrl, token, canalId, email, password }
       ├─ new McpServer() por conexão (isolamento total de tenant)
       ├─ registerTools(mcpServer, credsFn) ← closure sobre creds desta conexão
       │
       └─ SSEServerTransport (sessionId único por conexão)
```

### 2.3 Token Cache com TTL

```javascript
// Em tools.js — cache por baseUrl com 30 min de TTL
const tokenCache = new Map(); // baseUrl → { token, expiresAt }

// Auto-retry em 401: invalida cache + re-login automático
if (res.status === 401 && creds.email && creds.password) {
  invalidateTokenCache(creds.baseUrl);
  // ... retry com novo token
}
```

---

## 3. Ferramentas Implementadas (44 total)

### 3.1 Ferramentas Existentes (32) — Mantidas e refatoradas

As 32 ferramentas originais foram migradas para `tools.js` com:
- Passagem de credenciais por `creds` (sem variáveis globais)
- Helpers compartilhados: `findTicketByNumber`, `sendExternalMessage`, `apiWithFallback`
- Mesma interface/schema para compatibilidade retroativa

### 3.2 Novas 12 Ferramentas ★

| # | Ferramenta | Endpoint(s) usados | Caso de uso |
|---|-----------|-------------------|-------------|
| 1 | `obter_resumo_lead` | `/v1/contacts/number/:n` + `/tickets` + `/tasks/pages` | Agente consulta perfil completo antes de abordar |
| 2 | `buscar_historico_ticket` | `/messages/:ticketId` | Agente entende contexto da conversa |
| 3 | `transferir_para_humano` | `PUT /tickets/:id` + `POST /messages/:id` | Agente escala com mensagem de handoff |
| 4 | `registrar_objecao` | `POST /messages/:id` (isPrivate) | Agente documenta objeções para time de vendas |
| 5 | `qualificar_lead` | `PUT /contacts/:id` (leadStatusId + customFields) | Agente qualifica e pontua lead automaticamente |
| 6 | `criar_nota_interna` | `POST /messages/:id` (isPrivate) | Agente deixa comentários internos sem notificar cliente |
| 7 | `adicionar_tag` | `GET /v1/contacts/:id` + `PATCH` | Adiciona tag preservando as existentes |
| 8 | `remover_tag` | `GET /v1/contacts/:id` + `PATCH` | Remove tag específica preservando as demais |
| 9 | `agendar_followup` | `POST /tasks` + `POST /schedule-message` | Agenda tarefa + mensagem automática para data futura |
| 10 | `verificar_disponibilidade` | `/users` + `/tickets` | Agente encontra atendente disponível para transferir |
| 11 | `registrar_venda` | `POST /opportunity/` + `PUT /contacts/:id` | Registra venda no kanban e histórico do contato |
| 12 | `atualizar_etapa_funil` | `PUT /contacts/:id` + `PUT /opportunity/:id` | Move lead entre etapas do funil de vendas |

---

## 4. Backlog Priorizado — Próximas Iterações

### 🔴 Alta Prioridade (Quick Wins)

| # | Item | Complexidade | Impacto |
|---|------|-------------|---------|
| B1 | **Rate limiting** no SSE (express-rate-limit ou manual) | Baixa | Segurança em multi-tenant |
| B2 | **API Key para autenticação no SSE** (`x-api-key` header para o MCP server em si) | Baixa | Segurança: evita uso não autorizado do MCP |
| B3 | **Listar pipelines** (`GET /pipelines?includeSteps=true`) como ferramenta explícita | Baixa | Suporte a `registrar_venda` e `atualizar_etapa_funil` |
| B4 | **Listar filas** (`GET /queue/`) como ferramenta | Baixa | Agente sabe para onde transferir |
| B5 | **Listar motivos de fechamento** (`GET /closing-reason/`) | Baixa | Agente usa IDs corretos ao fechar tickets |
| B6 | **Listar oportunidades** (`GET /opportunity/search`) | Baixa | Agente consulta pipeline de vendas |

### 🟠 Média Prioridade (Sprint 2)

| # | Item | Complexidade | Impacto |
|---|------|-------------|---------|
| B7 | **Streaming SSE de eventos** (receber webhooks do CRM em tempo real) | Média | Agentes reativos a eventos (mensagem recebida, ticket aberto) |
| B8 | **Ferramenta `enviar_template`** (HSM/mensagens pré-aprovadas para iniciar conversa) | Média | Campanhas outbound via agente |
| B9 | **Ferramenta `criar_broadcast`** (disparo em massa) | Média | Automação de marketing |
| B10 | **Ferramenta `verificar_blacklist`** antes de enviar mensagem | Baixa | Compliance + evitar bloqueios |
| B11 | **Paginação automática** em `listar_contatos` e `listar_tickets` | Média | Agentes que processam listas grandes |
| B12 | **Cache Redis** para tokens e dados frequentes (etiquetas, atendentes) | Média | Performance em alta escala |

### 🟡 Baixa Prioridade (Sprint 3+)

| # | Item | Complexidade | Impacto |
|---|------|-------------|---------|
| B13 | **Webhook receiver** no MCP SSE para push de eventos CRM → agente | Alta | Loop de feedback em tempo real |
| B14 | **Ferramenta `analisar_sentimento_conversa`** (chamada LLM interna) | Alta | Qualificação automática por NLP |
| B15 | **Módulo de billing multi-tenant** (rastrear uso de API por tenant) | Alta | Monetização do GapHub-Ai |
| B16 | **Admin API**: listar tenants conectados, revogar sessões | Média | Gestão da plataforma |
| B17 | **SDK cliente** (TypeScript) para GapHub-Ai se conectar ao MCP | Alta | DX para integradores |

---

## 5. Primeiros Passos para Integração com GapHub-Ai

### 5.1 Arquitetura Recomendada

```
GapHub-Ai Platform
┌─────────────────────────────────────────────────────┐
│                                                     │
│  ┌──────────────┐    ┌─────────────────────────┐   │
│  │  Agent UI    │    │  Orchestration Engine   │   │
│  │  (React)     │───▶│  (n8n / LangChain)      │   │
│  └──────────────┘    └────────────┬────────────┘   │
│                                   │                 │
│                          MCP Client (SSE)            │
│                                   │                 │
└───────────────────────────────────┼─────────────────┘
                                    │
                   ┌────────────────▼───────────────────┐
                   │  clickmassa-mcp-sse  :3100          │
                   │  (index-sse.js — este servidor)     │
                   │                                     │
                   │  GET /sse?base_url=X&token=Y        │
                   │  → credsFn isolada por tenant       │
                   │  → McpServer por conexão            │
                   └────────────────┬───────────────────┘
                                    │
                   ┌────────────────▼───────────────────┐
                   │  https://appapi.{cliente}.com.br    │
                   │  ClickMassa / Flemy CRM API         │
                   └────────────────────────────────────┘
```

### 5.2 Configuração de Deploy (Docker)

```yaml
# docker-compose.yml (já existe no repo)
services:
  clickmassa-mcp:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./:/app
    command: node src/index-sse.js
    ports:
      - "3100:3100"
    environment:
      PORT: 3100
      # Credenciais default (fallback single-tenant)
      # Para multi-tenant: não definir — usar query params por cliente
      CLICKMASSA_BASE_URL: ""
      CLICKMASSA_TOKEN: ""
```

### 5.3 Integração com n8n (Agente IA)

```
1. No n8n: adicionar nó "MCP Client"
2. Transport: SSE
3. URL: http://mcp-server:3100/sse?base_url={{$env.CRM_BASE_URL}}&token={{$env.CRM_TOKEN}}&canal_id={{$env.CANAL_ID}}
4. Ferramentas disponíveis: todas as 44 aparecem automaticamente
```

### 5.4 Integração com Claude Desktop (single-tenant)

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "clickmassa": {
      "command": "node",
      "args": ["/path/to/clickmassa-mcp/src/index.js"],
      "env": {
        "CLICKMASSA_BASE_URL": "https://appapi.flemy.com.br",
        "CLICKMASSA_TOKEN": "SEU_TOKEN",
        "CLICKMASSA_CANAL_ID": "SEU_CANAL_ID",
        "CLICKMASSA_EMAIL": "admin@empresa.com",
        "CLICKMASSA_PASSWORD": "sua_senha"
      }
    }
  }
}
```

### 5.5 Como o MCP serve como Engine de Agentes no GapHub-Ai

O MCP funciona como **camada de ação** do agente:

```
Usuário: "Qualifica o lead João Silva e agenda follow-up para sexta"
         │
         ▼
  Agente LLM (Claude/GPT)
         │
         ├─ Tool call: buscar_contato_por_numero("5527...")
         │   └─ Retorna: { id: 123, leadStatus: "Novo Lead", ... }
         │
         ├─ Tool call: qualificar_lead({ contato_id: "123", lead_status_id: 2, pontuacao: 75 })
         │   └─ Atualiza CRM: leadStatus = "Qualificado", lead_score = "75"
         │
         ├─ Tool call: verificar_disponibilidade()
         │   └─ Retorna atendentes online com menos tickets
         │
         └─ Tool call: agendar_followup({ contato_id: 123, data: "2026-04-18", motivo: "Demo do produto" })
             └─ Cria tarefa no CRM + agenda mensagem automática
```

---

## 6. Resumo das Mudanças Implementadas

| Arquivo | Status | O que mudou |
|---------|--------|-------------|
| `src/tools.js` | ✅ CRIADO | Módulo compartilhado: 44 ferramentas, token cache TTL, auto-retry 401, helpers |
| `src/index.js` | ✅ REFATORADO | Apenas bootstrap STDIO + credsFn de ENV; importa tools.js |
| `src/index-sse.js` | ✅ REFATORADO | Multi-tenant via query params/headers; CORS; health+info endpoints; tracking de conexões |

**Ferramentas antes:** 32 (duplicadas entre os dois arquivos)
**Ferramentas depois:** 44 (em módulo único compartilhado, sem duplicação)

**Linhas de código antes:** ~740 (index.js) + ~740 (index-sse.js) = ~1480 linhas repetidas
**Linhas de código depois:** ~450 (tools.js) + ~55 (index.js) + ~115 (index-sse.js) = ~620 linhas únicas

**Redução de duplicação:** ~58%
