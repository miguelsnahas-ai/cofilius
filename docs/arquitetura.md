# Arquitetura e roadmap técnico — Afiliado

2026-11-12 · @Miguel

## Resumo

O sistema é uma esteira diária com estado em um banco único. Quatro agentes de IA tomam as decisões que pedem julgamento; seis serviços de código fazem o resto. Você aprova antes do envio enquanto o MVP roda, e o afiliado só enxerga o WhatsApp.

Decisões que proponho:

- **Dos seus 10 agentes, 4 continuam agentes e 6 viram serviços.** Gerar link, agendar, disparar e ler relatório são tarefas com entrada e saída fixas. Código faz isso mais barato, sem inventar nada, e é testável. Agente fica onde há escolha: o que postar, como escrever, o que aprender, o que o afiliado está pedindo.
- **A IA nunca escreve link, preço ou valor de comissão.** Ela escolhe ofertas por ID e escreve texto com marcadores. O código preenche os números e os links. Isso elimina o erro mais caro do produto: mandar link errado para um grupo.
- **Os agentes não conversam entre si.** Cada um lê e grava no banco. O orquestrador decide a ordem. Fica simples de depurar e de trocar uma peça.
- **Cada plataforma entra por um caminho diferente.** Shopee tem API e vira a primeira integração completa. Mercado Livre e Amazon não têm API ao alcance de um afiliado pequeno, então começam por importação de relatório e geração de link assistida.
- **Multi-cliente desde a primeira tabela.** Toda linha carrega o cliente. Sua esposa é o cliente 1, não um caso especial.
- **O MVP concierge não depende do sistema.** Cada etapa tem um modo manual. Você automatiza na ordem do que mais consome seus minutos por dia.

## Integrações: o que cada plataforma permite

Consulta feita em 12/nov/2026. Parte vem de fontes secundárias, listadas no fim. Confirme nos termos de cada programa antes de automatizar.

| Plataforma | Buscar ofertas | Gerar link com rastreio | Ler ganhos | Caminho recomendado |
|---|---|---|---|---|
| Shopee | Open API (`productOfferV2`), com taxa de comissão por produto | Open API (`generateShortLink`), com até 5 sub_ids por link | Open API (`conversionReport`), por sub_id | Integração por API com o App ID e o Secret da conta dela. Primeira a ficar pronta. |
| Mercado Livre | Sem API pública de afiliados que eu tenha encontrado. Páginas de ofertas do site. | Gerador da Central, Barra de Afiliados ou extensão oficial, com etiqueta | Relatórios do painel, filtráveis por etiqueta | Fase 1: link gerado no painel e relatório importado. Depois: automação no navegador com a sessão dela. |
| Amazon | Creators API exige 10 vendas qualificadas em 30 dias | Painel de Associados (SiteStripe), por tracking ID | Relatórios baixáveis no painel. API de relatórios só para contas de grande volume. | Fase 1: link no painel e relatório importado. Creators API quando ela passar das 10 vendas por mês. |
| WhatsApp | não se aplica | não se aplica | não se aplica | Cloud API oficial para a conversa 1 a 1 entre o sistema e o afiliado. |

### Chave de rastreio por plataforma

O que liga uma postagem a uma venda é a etiqueta gravada no link. A granularidade muda por programa, e o modelo de dados precisa aceitar as três:

- **Shopee:** 5 sub_ids por link. Proposta: cliente, canal, data, ID da oferta, horário. Dá atribuição por postagem.
- **Mercado Livre:** uma etiqueta por link. Proposta: canal + semana + nicho (ex.: `wa-s48-casa`). O produto vendido vem do relatório. A confirmar no painel dela: se dá para criar etiqueta por oferta sem trabalho manual.
- **Amazon:** tracking ID, criado no painel e em número limitado. Proposta: um por canal e nicho. O produto vendido vem do relatório.

### WhatsApp: duas decisões

1. **O sistema fala com o afiliado, não com o grupo.** Ela recebe a lista e encaminha. Postar direto em grupo fica fora por enquanto: não verifiquei o suporte atual da API oficial a grupos, e as bibliotecas não oficiais colocam o número dela em risco de bloqueio.
2. **Conversa dentro da janela de 24 horas.** Quando ela manda uma mensagem, abre uma janela em que o sistema responde em texto livre. Fora dela, só modelos aprovados pela Meta, cobrados por mensagem: cerca de R$ 0,035 para utilidade e R$ 0,32 para marketing no Brasil. Na escala do MVP o custo é irrelevante; o cuidado é a lista diária não ser classificada como marketing. Solução simples: ela toca em um botão "mandar a lista de hoje" e a resposta sai dentro da janela.

### Rastreio de clique próprio (seu item 8)

Um redirecionador próprio (domínio curto que registra o clique e leva ao link de afiliado) daria clique por link igual nas três plataformas. Recomendo deixar para a fase 2 e começar só com Shopee e Mercado Livre:

- A Shopee já entrega cliques por sub_id, então o ganho inicial é pequeno.
- Há relatos de que a Amazon restringe encurtadores de terceiros sem transparência. Na Amazon, use o link direto até ler os termos.
- A prévia do link no WhatsApp passa a mostrar o seu domínio, não o produto. Isso pode derrubar o clique e precisa de teste.

## Arquitetura

> *Diagrama: arquitetura em camadas · 4 agentes, serviços de código, banco único (imagem no documento original: https://claude.ai/artifact/BqT2LrYnq6rcLrpnN8rdBE).*

A camada destacada é a única com IA. Os serviços de Relatórios e o Agendador completam os seis serviços descritos adiante. Cada camada só fala com o banco e com a camada de baixo; o afiliado nunca vê nada abaixo da primeira linha.

### Um dia na esteira

1. **05h00 · Sincronizador de ganhos** puxa conversões e cliques de ontem e casa com os links.
2. **05h30 · Conector de ofertas** coleta candidatas dos nichos de cada cliente.
3. **06h00 · Curador** escolhe as 5 do dia por cliente, lendo as diretrizes do nicho.
4. **06h15 · Links e rastreio** gera o link de afiliado de cada oferta com a etiqueta do dia.
5. **06h30 · Redator** escreve as mensagens; o código preenche preço e link.
6. **06h45 · Validadores** conferem link, preço e repetição.
7. **07h00 · Você** aprova ou corrige no painel.
8. **08h00 · Disparador** envia a lista ao afiliado, que encaminha ao grupo.
9. **Ao longo do dia · Atendente** recebe pedidos no WhatsApp e abre tarefas.
10. **Domingo · Relatórios e Analista** montam o fechamento semanal e propõem as novas diretrizes.

## Agentes e serviços

### Sua lista de 10, refinada

| Seu item | Vira | Por quê |
|---|---|---|
| 1. Busca ofertas por nicho | Serviço **Conector de ofertas** + agente **Curador** | Coletar é código. Escolher as 5 do dia é julgamento. |
| 2. Verifica ganhos diariamente | Serviço **Sincronizador de ganhos** | Leitura de relatório, sem decisão. |
| 3. Cria link de afiliado, priorizando por nicho | Serviço **Links e rastreio** | A priorização já saiu do Curador. Gerar o link é chamada de API ou painel. |
| 4. Cria as mensagens | Agente **Redator** | Texto por nicho e por tom do grupo. |
| 5. Dispara as mensagens para ela | Serviço **Disparador WhatsApp** | Envio com confirmação de entrega. |
| 6. Aprende com cliques e compras | Agente **Analista** | Lê o desempenho e reescreve as diretrizes de curadoria. |
| 7. Dispara resumo de ganhos e insights | Serviço **Relatórios** + agente **Analista** | Números saem de consulta ao banco. O Analista escreve a leitura. |
| 8. Transforma link genérico em link rastreado | Serviço **Links e rastreio** | Mesmo serviço do item 3, outra entrada. |
| 9. Recebe demandas de rastreio de produtos | Agente **Atendente** | Entende o pedido no WhatsApp e abre a tarefa certa. |
| 10. Agendamento de mensagens | Serviço **Agendador e fila** | Relógio e fila de tarefas. |

### Os 4 agentes

**Curador.** Escolhe as ofertas do dia para cada cliente.

- Entrada: candidatas coletadas (com preço, desconto, comissão, avaliação), diretrizes do nicho, o que já foi enviado nos últimos 7 dias.
- Saída: lista ordenada de IDs de oferta, com uma linha de motivo para cada.
- Ferramentas: consulta ao banco de ofertas e ao histórico de desempenho. Não navega na web.
- Regra: nunca devolve produto fora da lista de candidatas.

**Redator.** Escreve a mensagem de cada oferta.

- Entrada: dados da oferta, tom do grupo do cliente, 3 mensagens antigas que tiveram bom clique.
- Saída: texto com marcadores `{{preco}}`, `{{desconto}}` e `{{link}}`, que o código preenche.
- Ferramentas: nenhuma. É o agente mais barato; roda em modelo pequeno.

**Analista.** Fecha o ciclo de aprendizado.

- Entrada: tabelas de cliques e vendas por oferta, horário, plataforma e nicho, já calculadas por consulta.
- Saída 1: diretrizes de curadoria do nicho, um texto curto e versionado que o Curador lê no dia seguinte (ex.: "priorizar utilidades de cozinha até R$ 60; evitar eletrônico sem frete grátis").
- Saída 2: os 3 insights do fechamento semanal, cada um apontando para a linha de dado que o sustenta.
- Regra: aprender muda as diretrizes, nunca o código nem o prompt dos outros agentes. Você revisa a mudança antes de valer.

**Atendente.** É a porta de entrada do afiliado.

- Entrada: mensagem recebida no WhatsApp.
- Saída: uma intenção reconhecida e a tarefa criada. Intenções iniciais: rastrear este produto, transformar este link, quanto ganhei, mudar meu nicho, pausar.
- Regra: o que ele não reconhece vai para você, com a mensagem original. Não improvisa resposta.

### Os 6 serviços

| Serviço | O que faz | Modo manual enquanto não existe |
|---|---|---|
| Conector de ofertas | Coleta candidatas por plataforma e nicho e grava no banco | Você cola URLs em uma planilha |
| Links e rastreio | Recebe URL, cliente e contexto; devolve link de afiliado com etiqueta e registra | Link gerado no painel, colado na planilha com a etiqueta |
| Sincronizador de ganhos | Todo dia puxa conversões e cliques e casa com os links pela etiqueta | Exportar o relatório e subir o arquivo |
| Agendador e fila | Dispara cada etapa no horário e reexecuta o que falhou | Você roda o comando de manhã |
| Disparador WhatsApp | Envia mensagens aprovadas e grava entrega e leitura | Você copia e envia pelo WhatsApp Business |
| Relatórios | Calcula ganhos por produto, plataforma e horário e monta o fechamento | Tabela dinâmica na planilha |

## Harness

O harness é o que transforma agentes soltos em produto: quem roda quando, com que dados, com que limites, e o que acontece quando algo falha. Proponho construí-lo pequeno, em cima de peças prontas.

### Pilha sugerida

- **Estado:** Postgres no Supabase, que você já tem conectado. Guarda tudo: ofertas, links, mensagens, vendas, execuções.
- **Orquestração:** um único programa (Python ou TypeScript) com a esteira escrita como passos em sequência. Agendamento por cron do próprio Supabase ou de um servidor pequeno.
- **Agentes:** chamadas à API do Claude com ferramentas restritas e saída em JSON validada por esquema. Modelo pequeno para o Redator e o Atendente, modelo mais forte para o Curador e o Analista.
- **Segredos:** credenciais de cada cliente cifradas no cofre do banco, nunca no código nem em prompt.
- **Painel do operador:** no início, as próprias tabelas do Supabase com uma tela de aprovação simples.

Não recomendo começar por um framework de multiagentes. A esteira é linear e conhecida; um framework acrescenta peças para depurar sem resolver nenhum dos seus riscos reais, que estão nas integrações.

### Contrato de cada agente

Todo agente é uma pasta no repositório com quatro arquivos:

1. **Prompt**, versionado.
2. **Esquema de entrada e de saída** em JSON. Saída que não valida é descartada e o passo roda de novo, no máximo 2 vezes.
3. **Lista de ferramentas** que ele pode chamar. O Redator não tem nenhuma; o Curador só lê.
4. **Casos de teste:** 15 a 20 entradas reais com a saída esperada, rodadas a cada mudança de prompt.

### Estados da lista diária

`rascunho` → `validada` → `aprovada` → `enviada` → `medida`

- De rascunho a validada é código (validadores abaixo).
- De validada a aprovada é você, no painel, durante todo o MVP.
- A aprovação automática só entra depois de 2 semanas seguidas sem correção sua, e por cliente.

### Validadores, todos em código

- O link abre e contém o identificador de afiliado do cliente certo.
- O preço foi conferido de novo até 30 minutos antes do envio; se mudou, a oferta sai da lista.
- A oferta não foi enviada a esse cliente nos últimos 7 dias.
- A mensagem não tem número nem link escrito pelo modelo, só marcadores.
- Limite de mensagens por cliente por dia.

### Registro e custo

Cada execução de agente grava entrada, saída, versão do prompt, duração e custo em tokens. Com isso você responde a duas perguntas do plano de MVP: quantos minutos seus cada cliente consome e quanto custa atender um cliente por mês.

### Falhas

- Passo que falha entra em nova tentativa com espera crescente, até 3 vezes.
- Plataforma fora do ar não segura a esteira: a lista sai com as outras duas e você recebe um aviso.
- Sem aprovação até o horário de envio, nada é enviado. O padrão é não mandar.

## Modelo de dados mínimo

Toda tabela carrega `cliente_id`. É o que permite atender o segundo cliente sem reescrever nada.

| Tabela | Guarda | Quem grava |
|---|---|---|
| `clientes` | Nome, WhatsApp, nichos, tom do grupo, horário de envio | Operador |
| `credenciais` | Por cliente e plataforma: chaves de API e identificadores de afiliado, cifrados | Operador |
| `diretrizes_nicho` | Texto versionado de curadoria por cliente e nicho | Analista, com sua aprovação |
| `ofertas` | Candidatas coletadas: plataforma, ID do produto, preço, desconto, comissão, data | Conector de ofertas |
| `links` | Link de afiliado gerado, etiqueta usada, oferta e cliente | Links e rastreio |
| `mensagens` | Texto final, link, estado (rascunho a medida), horário de envio e de leitura | Redator, validadores, Disparador |
| `cliques` | Por link e por dia, vindos da plataforma ou do redirecionador | Sincronizador |
| `vendas` | Pedido, produto, valor, comissão, situação (pendente, validada, cancelada), etiqueta | Sincronizador |
| `pedidos_afiliado` | O que o afiliado pediu pelo WhatsApp e o que foi feito | Atendente |
| `tarefas` | Fila: tipo, cliente, horário, tentativas, resultado | Agendador |
| `execucoes_agente` | Entrada, saída, versão do prompt, duração, custo | Harness |

Dois cuidados de modelagem:

- **Venda casa com link por etiqueta e produto, não por um ID único.** Na Shopee a etiqueta identifica a postagem. No Mercado Livre e na Amazon ela identifica canal e nicho, e o produto vendido fecha a ligação. Venda sem par fica marcada como "não atribuída" em vez de sumir: é comum o comprador clicar em um produto e levar outro.
- **Comissão tem situação.** O fechamento semanal mostra pendente e validada separadas. Pedido cancelado derruba comissão dias depois, e o afiliado precisa confiar no número.

## Roadmap por fases

Datas alinhadas ao plano de MVP, com início em 16/nov. A regra de prioridade é uma só: automatize primeiro o que mais consome seus minutos por dia no concierge.

| Fase | Quando | O que fica pronto | Como saber que terminou |
|---|---|---|---|
| 0. Fundação | Hoje a 17/nov | Repositório, banco com as 11 tabelas, padrão de etiquetas, credenciais da Shopee Open API da conta dela, pedido do número na WhatsApp Cloud API | Uma chamada de teste à API da Shopee devolve ofertas |
| 1. Shopee de ponta a ponta | 18 a 22/nov | Conector de ofertas, Links e rastreio e Sincronizador para Shopee. Curador e Redator com aprovação sua. Mercado Livre e Amazon em modo manual (planilha e importação de relatório). | Ela recebe uma lista de 5 ofertas gerada pela esteira, e uma venda da Shopee aparece ligada à postagem |
| 2. Operação para 9 clientes | 23 a 29/nov | Cadastro de clientes e nichos, fila por cliente, Disparador pela Cloud API se o número estiver aprovado, registro de uso | Lista das 8h sai para todos com menos de 20 minutos seus por cliente |
| 3. Fechamento e aprendizado | 30/nov a 6/dez | Serviço de Relatórios, Analista gerando insights e a primeira versão das diretrizes de nicho | Fechamento semanal sai do banco, sem planilha |
| 4. Produto invisível | Depois do MVP, se validar (4 a 6 semanas) | Atendente no WhatsApp, automação de Mercado Livre e Amazon, redirecionador de cliques, aprovação automática por cliente, painel simples do afiliado, cobrança recorrente | Um cliente novo entra e opera uma semana sem você tocar em nada |

### O que fazer hoje

- [ ] Abrir a seção Open API no painel de afiliados da Shopee dela e gerar App ID e Secret. Se não estiver liberada, pedir acesso: é o item com maior risco de prazo.
- [ ] Iniciar o cadastro do número na WhatsApp Cloud API. A verificação da empresa pode levar dias; até lá, o envio é manual.
- [ ] Baixar um relatório de cada painel (Shopee, Mercado Livre, Amazon) para desenhar a importação com colunas reais.
- [ ] Definir com ela os nichos e o padrão de etiquetas, e passar a usá-lo já nos links de amanhã.

### Como a automação de Mercado Livre e Amazon pode evoluir (fase 4)

Três caminhos, do mais seguro ao mais frágil:

1. **Importação assistida:** o afiliado encaminha o relatório ou um print pelo WhatsApp e o Atendente lê. Funciona para qualquer cliente, sem credencial.
2. **Extensão de navegador do próprio afiliado:** roda na sessão dele, gera links e lê relatórios sem a senha sair do computador dele.
3. **Automação de navegador no servidor com a sessão do cliente:** resolve tudo, mas exige guardar acesso de terceiros e pode contrariar os termos dos programas. Só para a conta da sua esposa, e depois de ler os termos.

## Riscos e pontos em aberto

| Risco | Efeito | Como tratar |
|---|---|---|
| Acesso à Open API da Shopee demora ou é negado | Fase 1 atrasa | Começar pelo modo manual da Shopee (conversão de 5 links por vez no painel) e trocar quando liberar |
| Termos dos programas vetam automação de painel ou operação por terceiros | Conta suspensa | Ler os três termos na fase 0. Sem senha de cliente externo. Automação de navegador só na conta dela. |
| Lista diária tratada como marketing pela Meta, ou número bloqueado | Custo sobe ou o canal cai | Envio dentro da janela de 24 horas, iniciado por ela. Número dedicado ao serviço. |
| Preço ou estoque muda entre a curadoria e o envio | Oferta errada no grupo, perda de confiança | Validador de preço até 30 minutos antes; ela ainda revisa antes de encaminhar |
| Atribuição incompleta em Mercado Livre e Amazon | Fechamento semanal com buracos | Mostrar "não atribuído" de forma explícita e medir o tamanho do buraco antes de prometer precisão |
| Construir demais antes de validar | Semanas de código para uma entrega que ninguém paga | Fase 4 só depois do resultado do Dia 20 do MVP |
| Dados de clientes e credenciais (LGPD) | Responsabilidade legal | Credenciais cifradas, acesso só seu, termo simples de consentimento antes de cadastrar cada cliente |

### A confirmar na conta dela

- A seção Open API aparece no painel da Shopee? Quais limites de chamadas?
- No Mercado Livre, a etiqueta pode ser criada no momento de gerar o link, ou precisa existir antes?
- Quantos tracking IDs a Amazon permite e quais relatórios detalham produto por tracking ID?
- Quantas vendas qualificadas ela teve na Amazon nos últimos 30 dias (limiar de 10 para a Creators API)?

## Fontes

- [SDK da Shopee Affiliate Open API: operações e endpoint do Brasil](https://github.com/gregojoao/shopee-affiliate)
- [Remessa Online: geração de link e sub_ids na Shopee](https://www.remessaonline.com.br/blog/shopee-afiliado)
- [Mercado Livre: comece a recomendar](https://www.mercadolivre.com.br/l/comece-a-recomendar)
- [Mercado Livre: como criar etiquetas](https://www.mercadolivre.com.br/l/organize-seus-links)
- [Amazon Creators API: introdução e requisitos](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction)
- [Amazon Associates: como baixar relatórios](https://affiliate-program.amazon.com/help/node/topic/GF4ZWWG8EYT5TNR2)
- [Strackr: acesso programático a relatórios da Amazon](https://strackr.com/docs/EMLZQ5)
- [ChatMaxima: tarifas da API do WhatsApp no Brasil desde 1/out/2026](https://chatmaxima.com/pt-br/whatsapp-api-pricing/brazil/)
- [Digisac: mudança de cobrança da API oficial do WhatsApp](https://digisac.com.br/blog/preco-whatsapp-api-outubro-2026)
- [DivulgaNinja: regras de divulgação de links da Amazon](https://www.divulganinja.com.br/blog/como-divulgar-links-de-afiliado-amazon-rapido-profissional)

