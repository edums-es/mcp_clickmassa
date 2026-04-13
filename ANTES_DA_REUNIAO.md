# ⚠️ Checklist pré-reunião — clickmassa-mcp

## 🔴 URGENTE — Fazer AGORA (antes de mostrar o repo)

### 1. Revogar credenciais vazadas no git history

O commit `19b9deb` contém token e senha reais. Mesmo que o `.env` atual esteja sem credenciais, qualquer pessoa com acesso ao repositório pode rodar `git show 19b9deb:.env` e ver:
- `CLICKMASSA_TOKEN=eyJhbGci...` (JWT com exp em 2028)
- `CLICKMASSA_PASSWORD=N72026!Acesso`
- `CLICKMASSA_EMAIL=admin@nucleo7.com`

**Passo 1 — Revogar o token AGORA:**
1. Acesse `https://app.flemy.com.br`
2. Vá em Configurações → API/Webhook
3. Delete o canal atual e crie um novo — isso invalida o token `eyJhbGci...`
4. Anote o novo `TOKEN` e `CANAL_ID`

**Passo 2 — Trocar a senha:**
1. Vá em Configurações → Perfil
2. Troque a senha `N72026!Acesso` por outra

**Passo 3 — Limpar o histórico git (rodar no Windows, dentro da pasta do projeto):**

```powershell
# No PowerShell, dentro de C:\Users\Eduardo\Downloads\clickmassa-mcp

# Opção A — git-filter-repo (recomendado, mais rápido):
pip install git-filter-repo
git filter-repo --path .env --invert-paths --force

# Opção B — filter-branch (sem instalar nada):
$env:FILTER_BRANCH_SQUELCH_WARNING = "1"
git filter-branch --force --index-filter `
  "git rm --cached --ignore-unmatch .env" `
  --prune-empty --tag-name-filter cat -- --all

# Após limpar, faça um commit com o estado v2.1:
git add src/tools.js src/index.js src/index-sse.js `
    docker-compose.yml scripts/ RELATORIO_MCP_v2.1.md RELATORIO_MCP_v2.md
git commit -m "feat: MCP v2.1 — 49 ferramentas, multi-tenant, bugfixes críticos"
```

**Verificar que limpou:**
```powershell
git show 19b9deb:.env   # deve dar erro "exists on disk but not in tree"
```

---

## ✅ Já resolvido pelo Cowork (não precisa fazer)

| Item | Status |
|------|--------|
| `.env` local — credenciais removidas | ✅ Feito |
| `SUPER_API_URL` hardcoded removido | ✅ Feito |
| `listar_contatos` com paginação | ✅ Feito |
| `buscar_historico_ticket` retornava 500 | ✅ Corrigido (`?contactId=` adicionado) |
| `verificar_chamadas_perdidas` retornava 500 | ✅ Corrigido |
| `listar_etiquetas` com fallback errado | ✅ Corrigido (`/tags` primeiro) |
| `buscar_contato_por_numero` sem fallback | ✅ Corrigido |
| `criar_nota_interna` duplicava nota | ✅ Corrigido (sem fallback para Push) |
| `docker-compose.yml` sem EMAIL/PASSWORD | ✅ Adicionados |
| 5 ferramentas utilitárias novas | ✅ Adicionadas (total: 49) |
| `scripts/README.md` | ✅ Criado |
| Arquitetura multi-tenant SSE | ✅ Funcionando |

---

## 🟡 Para a demo — testar ao vivo

```bash
# Preencher o .env com credenciais novas e testar:
node src/index-sse.js &
curl http://localhost:3100/health
curl http://localhost:3100/info | jq '.totalTools'   # → 49

# Testar listar_contatos ao vivo (verificar se não trunca):
# Conectar via Claude Desktop ou n8n e chamar a ferramenta
```

---

## 📋 Novidades para mostrar na reunião

- **49 ferramentas** cobrindo todo o ciclo de vendas (vs. 32 antes)
- **Multi-tenant**: um servidor SSE atende N clientes com credenciais isoladas por conexão
- **Engine para GapHub-Ai**: qualquer agente LLM (Claude, GPT, Gemini) conecta via SSE e tem acesso ao CRM
- **Bugs críticos corrigidos**: 3 ferramentas que quebravam em produção já funcionam
- **Token cache 30min + auto-retry 401**: sessões longas não quebram mais silenciosamente
