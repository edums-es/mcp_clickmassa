# scripts/

## update-n8n-workflow.mjs

Script utilitário que atualiza programaticamente um workflow n8n via API REST do n8n. Usado durante o desenvolvimento para manter o workflow do agente CRM sincronizado com mudanças nos parâmetros dos nós.

**O que ele faz:**
- Busca o workflow `C98qQdOADhZXTqMo` na instância n8n
- Atualiza parâmetros de nós específicos (Normalizar Payload, AI Agent CRM, Window Buffer Memory, OpenAI Chat Model)
- Adiciona/configura o nó de transferência segura para humano (`toolHttpRequest`)
- Faz PATCH (com fallback para PUT) e retorna um resumo das alterações

**Pré-requisitos:**
```
N8N_API_KEY_TEMP=sua_api_key_do_n8n   # Configurações → API no painel n8n
CLICKMASSA_BASE_URL=https://appapi.flemy.com.br
CLICKMASSA_TOKEN=seu_token
```

**Como usar:**
```bash
N8N_API_KEY_TEMP=xxx node scripts/update-n8n-workflow.mjs
# ou com .env preenchido:
node scripts/update-n8n-workflow.mjs
```

**Quando usar:**
- Após alterar prompts ou parâmetros do agente no n8n localmente
- Para atualizar o workflow em produção sem entrar no painel n8n manualmente
- **Não** rodar em loops automáticos — é um script one-shot de manutenção

**Nota:** O `workflowId` e a `baseUrl` estão hardcoded no script. Se o ambiente n8n mudar, edite as linhas 9-10 do arquivo.
