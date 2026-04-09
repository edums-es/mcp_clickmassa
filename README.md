# ClickMassa MCP Server

Servidor MCP para transformar o **ClickMassa CRM** em um motor de operações para Agentes de IA. Permite que a IA atue como um gerente administrativo, gerenciando leads, tickets, tarefas, chatbots e funis de forma autônoma.

---

## 🚀 Diferencial: Modo Administrativo (Dashboard Login)

Ao contrário de integrações via Push API tradicionais, este servidor utiliza o **Token de Sessão** do seu usuário.
- **Economia Total:** Envio de mensagens e gestão de tickets sem consumo de créditos da API.
- **Poder Total:** A IA pode fazer tudo o que você faz no painel: mover leads no funil, agendar tarefas e criar automações.

---

## Ferramentas Disponíveis

| Tool | Categoria | O que faz |
|---|---|---|
| `listar_tickets_pendentes` | Tickets | Lista tickets aguardando na fila |
| `listar_tickets_abertos` | Tickets | Lista tickets em atendimento com busca |
| `devolver_para_fila` | Tickets | Desatribui o atendente e volta ticket para pendente |
| `fechar_ticket` | Tickets | Encerra o atendimento |
| `listar_status_lead` | Leads | Descobre os IDs das fases do funil CRM |
| `listar_origens_lead` | Leads | Lista as origens cadastradas (Facebook, Ads, etc.) |
| `atualizar_contato` | Leads | Atualiza fase do lead, origem e campos customizados |
| `listar_tarefas` | Tarefas | Lista agendamentos e lembretes |
| `criar_tarefa` | Tarefas | Agenda Tarefa, Ligação ou Compromisso para atendentes |
| `listar_fluxos_chat` | Automação | Lista os chatbots (Chat Flows) nativos |
| `atribuir_fluxo_chat` | Automação | Ativa ou desativa um bot nativo por ticket |
| `listar_funis` | Funis | Lista réguas de follow-up automático |
| `criar_funil` | Funis | Cria novas réguas de follow-up com múltiplas etapas |
| `atribuir_funil_contato` | Funis | Insere um lead diretamente em um funil de follow-up |
| `listar_eventos_push` | Webhooks | Lista gatilhos externos e seus webhooks únicos |
| `criar_evento_push` | Webhooks | Cria novos webhooks (Kiwify, Facebook, etc.) |
| `verificar_chamadas_perdidas` | Voz | Varredura de logs para detectar ligações não atendidas |
| `listar_conexoes_whatsapp` | Config | Lista os canais de WhatsApp ativos (IDs de sessão) |
| `enviar_mensagem` | Chat | Envia texto (via dashboard, sem custo de crédito) |
| `enviar_nota_interna` | Chat | Nota invisível para o cliente |

---

## Instalação

```bash
git clone https://github.com/seu-usuario/clickmassa-mcp
cd clickmassa-mcp
npm install
cp .env.example .env
# Edite o .env com seu E-mail e Senha do ClickMassa
```

---

## Variáveis de Ambiente (.env)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `CLICKMASSA_BASE_URL` | ✅ | URL da sua instância (ex: `https://appapi.flemy.com.br`) |
| `CLICKMASSA_EMAIL` | ✅ | Seu e-mail de login no painel ClickMassa |
| `CLICKMASSA_PASSWORD` | ✅ | Sua senha de login |
| `CLICKMASSA_CANAL_ID` | ✅ | ID do canal padrão de WhatsApp |

---

## Estrutura do projeto

```
clickmassa-mcp/
├── src/
│   └── index.js        # Servidor MCP Centralizado
├── .env.example
├── package.json
└── README.md
```
