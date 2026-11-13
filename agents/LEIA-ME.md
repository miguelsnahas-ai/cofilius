# Agentes

Cada agente é uma pasta com o contrato que o harness (`harness/agentes.ts`) exige:

| Arquivo | O que é |
|---|---|
| `prompt.md` | O prompt. A versão é calculada do texto: mudou o texto, mudou a versão gravada em `execucoes_agente`. |
| `esquema.json` | Esquema JSON da entrada e da saída. Saída fora do esquema é descartada e o passo roda de novo (no máximo 2 vezes). |
| `contrato.json` | Nome, porte do modelo (`pequeno` ou `forte`, resolvido pelo `.env`) e ferramentas permitidas. |
| `regras.ts` | Regras além do esquema (ex.: o Redator não escreve preço; o Curador só escolhe IDs da lista recebida). |
| `casos/*.json` | Entradas de teste, rodadas a cada mudança de prompt. A meta é 15 a 20 casos reais por agente. |

Situação (modelo padrão de todos: Claude Haiku 5.5, trocável no `.env`):

| Agente | Porte | Onde é usado | Casos |
|---|---|---|---|
| **curador** | forte | `services/curadoria/curador.ts` · comando `curar` · esteira 06:00 | 3 de exemplo |
| **redator** | pequeno | `services/lista/redator.ts` · comandos `redigir`, `redigir-dia` · esteira 06:30 | 3 de exemplo |
| **analista** | forte | `services/relatorios/analista.ts` · comando `fechamento` · esteira domingo 20:00 | 2 de exemplo |
| atendente | pequeno | ainda não existe (depende do WhatsApp) | - |

Os prompts são **rascunhos**: nenhum foi rodado ainda com o modelo de verdade.
TODO: trocar os casos de exemplo por 15 a 20 casos reais por agente e rodar `testar-agente` a cada mudança de prompt.
