# Agentes

Cada agente é uma pasta com o contrato que o harness (`harness/agentes.ts`) exige:

| Arquivo | O que é |
|---|---|
| `prompt.md` | O prompt. A versão é calculada do texto: mudou o texto, mudou a versão gravada em `execucoes_agente`. |
| `esquema.json` | Esquema JSON da entrada e da saída. Saída fora do esquema é descartada e o passo roda de novo (no máximo 2 vezes). |
| `contrato.json` | Nome, porte do modelo (`pequeno` ou `forte`, resolvido pelo `.env`) e ferramentas permitidas. |
| `regras.ts` | Regras além do esquema (ex.: o Redator não escreve preço; o Curador só escolhe IDs da lista recebida). |
| `casos/*.json` | Entradas de teste, rodadas a cada mudança de prompt. A meta é 15 a 20 casos reais por agente. |

Situação:

- **redator**: ligado à API do Claude (`harness/modeloClaude.ts`) e à lista do dia (`services/lista/redator.ts`, comando `redigir`).
  O prompt ainda é um **rascunho**, com 3 casos.
  TODO: trocar os casos por 15 a 20 ofertas reais, com mensagens que tiveram bom clique.
- curador, analista, atendente: ainda não existem.
