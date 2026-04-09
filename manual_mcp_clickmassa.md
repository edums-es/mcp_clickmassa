# 📘 Manual de Operações — MCP ClickMassa Pro

> Este manual detalha todos os recursos avançados disponíveis para o Agente de IA no CRM ClickMassa.

---

## 🔐 Modo Dashboard (Administrativo)

Todas as operações agora são enviadas com a identidade do usuário logado via **E-mail e Senha**. 
- **Sem custos:** Enviar mensagens não consome créditos.
- **Sessão Persistente:** O MCP renova o token automaticamente.

---

## 📁 Metadados & Gestão de CRM

### `listar_status_lead`
Retorna as fases cadastradas no seu funil de vendas (ex: Novo Lead, Qualificado). Utilize o ID retornado para mover contatos.

### `listar_origens_lead`
Lista os canais de entrada (ex: Indicação, Facebook, Orgânico).

### `atualizar_contato`
Permite preencher dados completos do lead.
| Parâmetro | Descrição |
|---|---|
| `leadStatusId` | ID retornado por `listar_status_lead` |
| `leadOriginId` | ID retornado por `listar_origens_lead` |
| `campos_customizados` | Objeto chave-valor (ex: `{"cpf": "..."}`) |

---

## 🎫 Tickets & Fila de Espera

### `listar_tickets_pendentes` / `listar_tickets_abertos`
Permite que o Agente IA veja quem está aguardando atendimento. Suporta busca por texto.

### `devolver_para_fila`
Remove o atendente atual e devolve o contato para a fila geral de aguardo. Excelente para resets de transbordo.

---

## 📅 Agendas & Tarefas (CRM)

### `listar_tarefas`
Veja os lembretes e agendamentos configurados no sistema.

### `criar_tarefa`
Agende novos compromissos vinculados a um contato.
| Tipo | Descrição |
|---|---|
| `T` | Tarefa (E-mail, lembrete) |
| `L` | Ligação |
| `C` | Compromisso (Reunião) |

---

## 🤖 Automação Avançada

### `atribuir_fluxo_chat`
Gerencia os chatbots nativos. 
- Passe um `fluxo_id` para ligar o chatbot antigo.
- Passe `null` para desligar o bot e deixar a **IA assumir o controle total**.

### `listar_funis` / `criar_funil`
Crie réguas de follow-up que enviam mensagens automáticas após X minutos. A IA pode construir estas réguas sozinha dependendo do comportamento do lead.

### `atribuir_funil_contato`
Coloca o lead dentro de um funil pré-configurado para reengajamento automático.

---

## 📡 Integrações (Push Events)

### `listar_eventos_push` / `criar_evento_push`
Gerencie webhooks de entrada. Ideal para receber leads de plataformas externas (Kiwify, Facebook, Eduzz) diretamente no CRM com mensagens de boas-vindas personalizadas.

---

## 📞 Monitoramento de Voz

### `verificar_chamadas_perdidas`
Varre os últimos tickets em busca do registro `call_log: rejected/missed`. 
> [!TIP]
> Use esta ferramenta para que a IA peça desculpas por chat automaticamente caso uma ligação não tenha sido atendida.

---

## 🛠️ Utilidades de Sistema

- `listar_conexoes_whatsapp`: Use para descobrir o `sessionId` dos seus aparelhos conectados.
- `listar_atendentes`: Veja os IDs dos seus colegas de equipe para transferências (`user_id`).

---
**Status:** Operações MCP de Alta Performance Ativadas. 🚀
