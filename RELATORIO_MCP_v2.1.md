# Relatório de Evolução — ClickMassa MCP v2.1.0
**Data:** 2026-04-13 | **Tarefa:** melhorar-mcp (scheduled task — 2ª execução)

---

## Resumo Executivo

Esta execução realizou **inspeção live do CRM via browser devtools** (appapi.flemy.com.br), identificou **3 bugs críticos** na v2.0.0 que causavam falhas silenciosas em produção, corrigiu todos eles, e adicionou **5 ferramentas utilitárias** confirmadas via API real.

**Total de ferramentas:** 32 (originais) + 12 (v2.0) + 5 (v2.1) = **49 ferramentas**

---

## 1. Inspeção Live do CRM (2026-04-13)

### 1.1 Ambiente Confirmado

| Item | Valor |
|------|-------|
| App URL | https://app.flemy.com.br |
| API URL | https://appapi.flemy.com.br |
| TenantId | 27 |
| TenantUID | 4f803c5f-c501-4b0e-8348-5933e9d9b671 |
| Autenticação | POST /auth/login → Bearer JWT |
| WhatsApp | ID 35 "Teste" — status: CONNECTED |
| Capacidades ativas | isPush=true, isFunnel=true, isOpportunity=true |
| connectionLimit | 5 |

### 1.2 Endpoints Validados Live (status HTTP confirmado)

| Endpoint | Método | Status | Observação |
|----------|--------|--------|------------|
| `/auth/login` | POST | 200 | Retorna JWT token |
| `/contacts` | GET | 200 | `{contacts, count, hasMore}` — 24 contatos |
| `/contacts/:id` | GET | 200 | Objeto completo com `customFields`, `extraInfo`, `wallets` |
| `/contacts?searchParam=` | GET | 200 | Busca textual — funciona como fallback de /v1/contacts/number/ |
| `/v1/contacts/number/:n` | GET | 200* | Funciona em Node.js; CORS bloqueia em browser |
| `/tickets` | GET | 200 | `{tickets, count, hasMore}` — campos: `saleValue`, `sentiment`, `sentimentNote`, `promptId` |
| `/tickets/:id` | GET | 200 | Detalhe completo; tem `contactId` direto no objeto |
| `/messages/:ticketId?contactId=` | GET | 200 | **`?contactId=` é OBRIGATÓRIO** — sem ele retorna 500 |
| `/messages/:ticketId` (sem contactId) | GET | 500 | `WHERE parameter "contactId" has invalid "undefined" value` |
| `/users` | GET | 200 | `{users, count, hasMore}` |
| `/queue` | GET | 200 | Array vazio (sem filas configuradas neste tenant) |
| `/closing-reason` | GET | 200 | Array com 1 motivo: "Desquelificado" |
| `/lead-status` | GET | 200 | Array com 1 status: id=122 "Novo Lead" #00f500 |
| `/lead-origin` | GET | 200 | Array com 1 origem |
| `/pipelines?includeSteps=true` | GET | 200 | Array vazio (sem pipelines configurados) |
| `/opportunity/search` | GET | 200 | Array vazio (sem oportunidades) |
| `/opportunity/search?contactId=` | GET | 200 | Filtro por contato funciona |
| `/funnel` | GET | 200 | `{funnels, limit}` — funil "Acompanhamento" id=11 |
| `/whatsapp` | GET | 200 | Array[1]: id=35, status=CONNECTED |
| `/chat-flow` | GET | 200 | `{chatFlow: [...]}` |
| `/tags` | GET | 200 | Array vazio (sem tags globais) |
| `/blacklist/check-number/:n` | GET | 200 | `{isBlacklisted: false}` |
| `/schedule-message` | GET | 200 | `{messages, count, hasMore}` |
| `/tasks/pages` | GET | 200 | `{tasks, count, hasMore}` |
| `/tenants/credits` | GET | 200 | Objeto completo com capabilities do tenant |
| `/v1/labels` | GET | **404** | Não existe nesta instância |
| `/labels` | GET | **404** | Não existe nesta instância |
| `/reports/*` | GET | **404** | Endpoints de relatórios não expostos via API |

---

## 2. Bugs Críticos Corrigidos (v2.0.0 → v2.1.0)

### Bug #1 — CRÍTICO: `/messages/:ticketId` sem `?contactId=` retorna 500

**Impacto:** `buscar_historico_ticket` e `verificar_chamadas_perdidas` sempre falhavam em produção.

**Causa:** A API do CRM exige `?contactId=` como query param obrigatório. Sem ele, o backend tenta usar `contactId = undefined` na query SQL, causando erro 500.

**Correção aplicada:**
```javascript
// ANTES (bugado)
const msgRes = await api("GET", `/messages/${ticket.id}`, null, creds);

// DEPOIS (corrigido)
const contactId = ticket.contactId || ticket.contact?.id;
const msgRes = await api("GET", `/messages/${ticket.id}?contactId=${contactId}`, null, creds);
```

**Arquivos:** `src/tools.js` — funções `buscar_historico_ticket` e `verificar_chamadas_perdidas`

---

### Bug #2 — ALTO: `listar_etiquetas` com fallbacks 404

**Impacto:** `listar_etiquetas` sempre lançava erro pois tentava `/v1/labels` e `/labels` primeiro (ambos 404 nesta instância).

**Causa:** Ordem de fallback incorreta — os dois primeiros endpoints não existem.

**Correção aplicada:**
```javascript
// ANTES
apiWithFallback("GET", ["/v1/labels", "/labels", "/tags/"], ...)

// DEPOIS (confirmado via live API)
apiWithFallback("GET", ["/tags", "/tags/", "/v1/labels"], ...)
```

---

### Bug #3 — ALTO: `buscar_contato_por_numero` sem fallback

**Impacto:** Se `/v1/contacts/number/:n` retornar objeto vazio `{}` (comportamento observado), a ferramenta retornava dados inválidos.

**Causa:** Sem validação do retorno e sem fallback para busca textual.

**Correção aplicada:**
```javascript
// DEPOIS: tenta v1 com validação, faz fallback para searchParam se necessário
try {
  const data = await api("GET", `/v1/contacts/number/${numero}`, null, credsFn());
  if (data && data.id) return ok(data);
  throw new Error("empty");
} catch (_) {
  const res = await api("GET", `/contacts?searchParam=${numero}&pageNumber=1`, null, credsFn());
  const contact = contacts.find(c => c.number === numero) || contacts[0];
  if (!contact) throw new Error(`Contato não encontrado para o número ${numero}`);
  return ok(await api("GET", `/contacts/${contact.id}`, null, credsFn()));
}
```

---

## 3. Novas Ferramentas Adicionadas (v2.1.0)

### 5 Ferramentas Utilitárias — Confirmadas via Live API

| # | Ferramenta | Endpoint | Status API |
|---|-----------|---------|-----------|
| 45 | `listar_pipelines` | `GET /pipelines?includeSteps=true` | ✅ 200 |
| 46 | `listar_filas` | `GET /queue/` | ✅ 200 |
| 47 | `listar_motivos_fechamento` | `GET /closing-reason/` | ✅ 200 |
| 48 | `listar_oportunidades` | `GET /opportunity/search?contactId=` | ✅ 200 |
| 49 | `verificar_blacklist` | `GET /blacklist/check-number/:n` | ✅ 200 |

**Por que essas 5 são importantes para agentes:**
- `listar_pipelines` — agente descobre IDs de etapas antes de chamar `registrar_venda` ou `atualizar_etapa_funil`
- `listar_filas` — agente sabe para qual departamento transferir antes de chamar `escalar_para_departamento`
- `listar_motivos_fechamento` — agente usa IDs corretos ao chamar `fechar_ticket`
- `listar_oportunidades` — agente consulta histórico de vendas de um contato
- `verificar_blacklist` — agente checa antes de enviar mensagem (compliance)

---

## 4. Estrutura de Arquivos Atualizada

```
clickmassa-mcp/src/
├── tools.js        ← 49 ferramentas + 3 bugs críticos corrigidos
├── index.js        ← STDIO single-tenant (v2.1.0)
└── index-sse.js    ← HTTP/SSE multi-tenant (v2.1.0, /info atualizado)
```

---

## 5. Descobertas Adicionais do CRM (v2.1)

### Campos Novos no Ticket (features de IA já no CRM)
O objeto ticket retorna campos que indicam funcionalidades de IA já existentes:
- `sentiment` — análise de sentimento da conversa
- `sentimentNote` — nota/descrição do sentimento
- `promptId` — prompt de IA associado ao ticket
- `saleValue` — valor de venda registrado

**Oportunidade:** Ferramentas futuras podem ler/escrever estes campos diretamente.

### Estrutura de Mensagem (campos completos)
```
id, messageId, body, caption, fromMe, mediaType, mediaUrl, mediaName,
isPrivate, note, isDeleted, isTransfer, destinationUserId, destinationQueueId,
ticketId, contactId, userId, timestamp, createdAt, msgCreatedAt,
sendType, typeTemplate, templateId, params, vCardList, externalKey,
quotedMsgId, quotedMsg, contact, ticket, tenantId, tenantUid
```

**Destaque:** Campo `note` e `isTransfer` — mensagens de transferência ficam registradas com dados completos do destino.

### Endpoints de Mensagens Agendadas
- `GET /schedule-message` retorna `{messages, count, hasMore}`
- `GET /schedule-message?pageNumber=1` — paginação funciona

---

## 6. Backlog Atualizado (pós v2.1)

### 🔴 Alta Prioridade

| # | Item | Complexidade | Base Técnica |
|---|------|-------------|--------------|
| B1 | **`listar_mensagens_agendadas`** — listar mensagens agendadas do contato | Baixa | `GET /schedule-message?contactId=` |
| B2 | **`cancelar_mensagem_agendada`** — cancelar agendamento | Baixa | `DELETE /schedule-message/:id` |
| B3 | **`obter_creditos_tenant`** — saldo e capacidades do tenant | Baixa | `GET /tenants/credits` |
| B4 | **`buscar_ticket_por_id`** — buscar ticket diretamente | Baixa | `GET /tickets/:id` |
| B5 | **Rate limiting** no endpoint SSE | Baixa | express-rate-limit ou manual |
| B6 | **API Key** para proteger o MCP SSE (`x-api-key`) | Baixa | Middleware simples |

### 🟠 Média Prioridade

| # | Item | Complexidade | Base Técnica |
|---|------|-------------|--------------|
| B7 | **`atualizar_sentimento_ticket`** — escrever campos de IA no ticket | Baixa | `PUT /tickets/:id` com `sentiment`, `sentimentNote` |
| B8 | **`registrar_valor_venda_ticket`** — escrever `saleValue` no ticket | Baixa | `PUT /tickets/:id` com `saleValue` |
| B9 | **`enviar_template_hsm`** — mensagens template aprovadas | Média | Canal WABA (se ativo no tenant) |
| B10 | **Paginação automática** em listar_contatos/listar_tickets | Média | Loop com `hasMore` |
| B11 | **Cache Redis** para dados frequentes (etiquetas, atendentes, motivos) | Média | Redis client + TTL |

### 🟡 Baixa Prioridade (Sprint 3+)

| # | Item | Complexidade | Observação |
|---|------|-------------|-----------|
| B12 | Webhook receiver (eventos CRM → agente em tempo real) | Alta | Loop de feedback |
| B13 | Módulo de billing multi-tenant (tracking por tenant) | Alta | Monetização GapHub-Ai |
| B14 | Admin API: listar sessões ativas, revogar tokens | Média | Gestão da plataforma |
| B15 | SDK TypeScript para GapHub-Ai | Alta | DX para integradores |

---

## 7. Métricas de Evolução

| Versão | Data | Ferramentas | Linhas de código | Bugs críticos |
|--------|------|-------------|-----------------|---------------|
| v1.0.0 | anterior | 32 (duplicadas) | ~1480 (em 2 arquivos) | 4+ identificados |
| v2.0.0 | 2026-04-11 | 44 (módulo único) | ~620 (3 arquivos) | 3 residuais |
| **v2.1.0** | **2026-04-13** | **49** | **~720** | **0 críticos** |

---

## 8. Verificação Final

```bash
# Checagem de sintaxe — todos passaram ✓
node --input-type=module --check < src/tools.js   # ✓ OK
node --input-type=module --check < src/index.js   # ✓ OK
node --input-type=module --check < src/index-sse.js # ✓ OK

# Contagem de ferramentas
grep -c 'server\.tool(' src/tools.js  # → 49 ✓
```
