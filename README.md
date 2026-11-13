# Cofilius

Serviço de operação para afiliados de Shopee, Mercado Livre e Amazon que divulgam ofertas em grupos de WhatsApp.
Arquitetura e roadmap: [docs/arquitetura.md](docs/arquitetura.md).

**Estado atual:** Fases 0 a 3 construídas em código: Shopee (API e modo manual), os 4 agentes (Curador, Redator, Analista, Atendente), lista do dia com painel de aprovação, vendas, fechamento semanal, cadastro de clientes, registro de uso e o Disparador com WhatsApp **ainda não conferido** na documentação da Meta. Faltam os importadores dos relatórios reais e a primeira rodada da IA com a chave da API.

- banco com as 11 tabelas do modelo de dados, todas com `cliente_id`;
- padrão de etiquetas de rastreio (sub_ids da Shopee, etiqueta do Mercado Livre, tracking ID da Amazon);
- **Conector de ofertas**: busca ofertas na Shopee por palavra-chave do nicho e grava em `ofertas`;
- **Links e rastreio**: gera o link de afiliado da Shopee com os sub_ids e grava em `links`;
- um comando de linha para testar os dois com a conta real;
- **modo manual**, para usar enquanto a Open API da Shopee não estiver liberada: ofertas por planilha e links gerados no painel;
- **lista diária**: rascunho → validada → aprovada → enviada → medida, com os estados garantidos pelo banco, marcadores preenchidos pelo código e os validadores da arquitetura;
- **vendas**: atribuição de cada venda à postagem (ou "não atribuída"), cliques e resumo do período com comissão pendente, validada e cancelada separadas;
- **esteira e fila de tarefas**: etapas do dia com horário por cliente, novas tentativas e falha isolada;
- **harness dos agentes**: contrato de cada agente (prompt versionado, esquemas, até 2 repetições, registro de custo e casos de teste), ligado à API do Claude (modelo padrão: Claude Haiku 5.5);
- **Curador**: escolhe as ofertas do dia só entre as candidatas, seguindo as **diretrizes de nicho** aprovadas;
- **Redator**: escreve as mensagens com marcadores; preço e link são preenchidos pelo sistema;
- **cadastro de clientes e nichos** e **registro de uso** (minutos do operador e custo de IA por cliente);
- **Atendente**: entende o pedido da afiliada, responde com números do banco ou passa para você;
- **Disparador**: envio manual (hoje) ou pela WhatsApp Cloud API, com recebimento de mensagens e avisos de entrega/leitura;
- **painel do operador**: tela web local para aprovar a lista do dia (escolhas do Curador, links, mensagens, propostas de diretriz);
- **Analista e fechamento semanal**: indicadores calculados em código, 3 leituras ligadas aos dados e propostas de diretriz que só valem com aprovação;
- **extensão de Chrome (etapa 1: gravador para Mercado Livre, Shopee e Amazon)**: grava os dados que as páginas de afiliado carregam, para mapear o formato real. Instalação e uso em [extensao/LEIA-ME.md](extensao/LEIA-ME.md).

## Começar sem terminal (Windows)

1. Instale o **Node.js** (versão LTS) em https://nodejs.org/pt (avançar, avançar, concluir).
2. Baixe o Cofilius: no GitHub, branch `claude/cofilius-fase0-shopee-e9by0t`, botão **Code → Download ZIP**.
   Descompacte numa pasta sua (ex.: `Documentos\Cofilius`).
3. Dentro da pasta, dê **dois cliques em `Cofilius.bat`**. Na primeira vez ele instala o que falta (alguns minutos)
   e abre o navegador. Deixe a janela preta aberta enquanto usa.
4. No navegador, a **configuração inicial** pede o endereço do banco (Supabase, com o passo a passo na própria tela),
   seu nome e uma senha para o painel. Ao clicar em "Conectar e criar as tabelas", o painel cria tudo sozinho.
5. Pronto: o navegador pede a senha (usuário: qualquer) e abre o painel.

Do dia a dia em diante, tudo é pelo painel:

| Aba | O que tem |
|---|---|
| **Dia** | escolhas do Curador, links, mensagens (validar, aprovar, enviar), pedidos da afiliada, propostas de diretriz; aviso quando a extensão para de mandar vendas |
| **Resultados** | comissão validada e pendente (nunca somadas), pedidos, cliques e conversão; comissão e cliques por dia (com tabela), produtos que mais renderam, vendas recentes; 7, 30 ou 90 dias, por plataforma |
| **Clientes** | cadastrar e editar clientes, nichos e palavras de busca, credenciais da Shopee, diretrizes; pausar e reativar |
| **Importar** | planilha de ofertas, planilha de vendas (com modelos para baixar) e arquivo de gravação da extensão |
| **Relatórios** | fechamento do período (com a leitura do Analista), uso por cliente, esteira automática |
| **Configuração** | seu nome, senha, provedor de IA (Gemini gratuito ou Claude) e a chave dele, modelos, esteira ligada/desligada, pareamento da extensão do Chrome, testar os agentes |

**Visual:** o painel segue o Design System Cofilius (cores, logo, fontes Gabarito, Onest e DM Mono, voz). As fontes e o logo
ficam em `painel/publico/`; as cores estão no topo de `painel/publico/estilo.css`, com o tema escuro do próprio sistema.
Na aba Dia, o bloco **Próximo passo** diz o que fazer agora, e a linha de andamento mostra onde o dia está.

**Esteira automática:** enquanto o painel estiver aberto, a cada 5 minutos ele roda as etapas do dia sozinho
(Curador às 6h, Redator às 6h30, validação às 6h45, fechamento aos domingos às 20h). Sem a chave da IA, essas etapas
aparecem como "puladas".

**Atualizar o Cofilius:** baixe o ZIP de novo, descompacte numa pasta nova e **copie o arquivo `.env`** da pasta antiga
para a nova (é nele que ficam a conexão com o banco e as chaves). Depois, use o `Cofilius.bat` da pasta nova.

## Estrutura

```
agents/      contratos dos agentes de IA (Curador, Redator, Analista)
services/
  etiquetas/ padrão de etiquetas de rastreio
  shopee/    cliente da Shopee Affiliate Open API (client.ts) e parser das respostas
  ofertas/   Conector de ofertas · Shopee (API e planilha)
  links/     Links e rastreio · Shopee (API e painel)
  lista/     lista diária: marcadores, validadores, aprovação, envio
  vendas/    atribuição de vendas, cliques, resumo do período
  curadoria/ Curador e diretrizes de nicho
  relatorios/ indicadores, Analista, fechamento semanal, registro de uso
  clientes/  cadastro de clientes e nichos
  atendimento/ Atendente e entrada de mensagens
  disparador/ envio (manual e WhatsApp) e cliente da WhatsApp Cloud API
painel/      painel do operador (servidor local + páginas): dia, clientes, importar, relatórios, configuração
Cofilius.bat atalho do Windows: instala, abre o painel e o navegador
harness/     o que roda os serviços: config, log, novas tentativas, cifragem, banco, fila, esteira, agentes, comandos
testes/      apoio aos testes com banco
db/          migrations, seed, script de migração, acesso a clientes e credenciais
extensao/   extensão de Chrome (gravador: Mercado Livre, Shopee e Amazon)
docs/        arquitetura
```

Regras que o código já segue:

- Nenhuma credencial no código. O `.env` é local; as credenciais de cada cliente ficam **cifradas** na tabela `credenciais` (AES-256-GCM, chave mestra no `.env`).
- Toda chamada externa (Shopee e banco) tem timeout, até 3 novas tentativas com espera crescente e log.
- Links, preços e comissões só vêm da API e do banco. Os serviços devolvem o que foi gravado no banco, não o que a API respondeu.

## 1. Preparar

Requisitos: Node 20.6 ou mais novo.

```bash
npm install
```

```bash
cp .env.example .env
```

### No Windows pelo PowerShell (alternativa ao Cofilius.bat)

1. Instale o [Git](https://git-scm.com/download/win) e o [Node.js](https://nodejs.org) (versão LTS).
2. Libere scripts do npm para o seu usuário (uma vez só):
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```
   Alternativa sem mudar nada: use `npm.cmd` no lugar de `npm` (ex.: `npm.cmd run painel`).
3. Baixe o projeto e entre na pasta:
   ```powershell
   git clone -b claude/cofilius-fase0-shopee-e9by0t https://github.com/miguelsnahas-ai/cofilius.git
   cd cofilius
   npm install
   copy .env.example .env
   notepad .env
   ```
4. Siga as seções 2 a 4 abaixo (Supabase, tabelas, credenciais). Todo comando `npm run ...` deve ser rodado dentro da pasta `cofilius`.

## 2. Configurar o Supabase

1. Crie um projeto em [supabase.com](https://supabase.com) (região São Paulo, `sa-east-1`) e anote a senha do banco.
2. No projeto: **Connect** (botão no topo) → **Connection string** → **Session pooler** → copie a URI.
3. No `.env`, cole a URI em `DATABASE_URL` e troque `[YOUR-PASSWORD]` pela senha.

> Use o *Session pooler*: a conexão direta do Supabase só funciona em redes com IPv6.

## 3. Criar as tabelas (migrations)

```bash
npm run db:seed
```

Isso aplica as migrations de `db/migrations/` (só as que ainda não rodaram) e cria o cliente de teste `c1`, com os nichos `casa` e `beleza`.
Rodar de novo não duplica nada. Para aplicar só as migrations, sem o seed, use `npm run db:migrate`.

Também dá para fazer sem terminal: no Supabase, abra **SQL Editor**, cole o conteúdo de `db/migrations/0001_modelo_inicial.sql`, rode, e depois faça o mesmo com `db/seed.sql`.
Se fizer assim, não use mais o `npm run db:migrate` nesse projeto: ele tentaria criar as tabelas de novo e daria erro.

Todas as tabelas ficam com RLS ligado e sem políticas: as chaves públicas do Supabase (anon) não leem nada.
O sistema acessa pela `DATABASE_URL`.

## 4. Credenciais

1. Gere a chave mestra e cole em `CREDENCIAIS_CHAVE` no `.env`:
   ```bash
   npm run gerar-chave
   ```
   Guarde essa chave. Sem ela, as credenciais gravadas no banco não podem ser lidas (dá para gravá-las de novo).
2. No painel de afiliados da Shopee, seção **Open API**, copie o App ID e o Secret para `SHOPEE_APP_ID` e `SHOPEE_SECRET` no `.env`.
3. Grave-os cifrados no banco, para o cliente `c1`:
   ```bash
   npm run cli -- credenciais-shopee --cliente c1
   ```
   Depois disso, pode apagar `SHOPEE_APP_ID` e `SHOPEE_SECRET` do `.env`: os serviços leem do banco.

## Sem a Open API: modo manual

Enquanto a Open API não estiver liberada, as ofertas entram por planilha e os links são gerados no painel de afiliados.
Os dados vão para as mesmas tabelas (`ofertas` e `links`), com as mesmas regras.
Quando a API sair, basta trocar pelos comandos da seção 5. Para o modo manual, você só precisa do Supabase (seções 2 e 3) e de `DATABASE_URL` no `.env`.

### 1. Ofertas pela planilha

1. Faça uma cópia de [`docs/modelos/ofertas-shopee.csv`](docs/modelos/ofertas-shopee.csv) e abra no Excel ou no Google Planilhas.
2. Preencha uma linha por produto:

   | Coluna | Obrigatória | Exemplo | Observação |
   |---|---|---|---|
   | `link` | sim | `https://shopee.com.br/Nome-do-Produto-i.334455667.22912345678` | link **completo** da página do produto (o link curto não traz o ID do produto) |
   | `titulo` | sim | `Organizador de Gaveta` | |
   | `preco` | sim | `29,90` | aceita `R$ 1.299,90`, `29,90` ou `29.90` |
   | `desconto` | não | `25` | em %, de 0 a 100 |
   | `comissao` | não | `12` | taxa de comissão em %, como aparece no painel |
   | `comissao_valor` | não | `3,59` | comissão em reais |
   | `nicho` | não | `casa` | se vazio, usa o `--nicho` do comando |

3. Salve como CSV (no Google Planilhas: Arquivo → Fazer download → CSV) e importe:
   ```bash
   npm run cli -- importar-ofertas --cliente c1 --arquivo ofertas.csv --nicho casa
   ```

Linhas com problema não são gravadas. O comando mostra o número da linha e o motivo; corrija e importe de novo.
Importar de novo no mesmo dia não duplica: atualiza as ofertas que já estão lá.

### 2. Links com rastreio, gerados no painel

1. Peça os sub_ids das ofertas do dia, informando o horário em que a postagem vai sair:
   ```bash
   npm run cli -- preparar-links --cliente c1 --quando "2026-11-12 08:15"
   ```
   Para cada oferta, o comando mostra o link do produto, os 5 Sub_ids e um comando `registrar-link` pronto.
2. No painel de afiliados da Shopee, gere o link personalizado do produto preenchendo Sub_id1 a Sub_id5 exatamente como mostrado. Um produto por vez, porque o Sub_id4 muda a cada produto.
3. Copie o comando `registrar-link` que apareceu para aquela oferta, troque `COLE_O_LINK_AQUI` pelo link gerado e rode:
   ```bash
   npm run cli -- registrar-link --cliente c1 --oferta <id> --quando "2026-11-12 08:15" --link https://s.shopee.com.br/XXXX
   ```

O comando aceita só links da Shopee e recusa um link que já foi registrado.
**Limite deste modo:** o sistema não consegue ver se os Sub_ids foram digitados certo no painel, porque o link curto não mostra isso.
A conferência vem do relatório de conversões da Shopee, que traz os Sub_ids de cada venda.

## 5. Testar os dois serviços com a conta real

Tudo de uma vez: busca 10 ofertas do nicho, grava, gera o link de afiliado da primeira e confere no banco.

```bash
npm run cli -- teste --cliente c1 --nicho casa --limite 10 --gravar respostas-shopee
```

Ou cada serviço separado:

```bash
npm run cli -- ofertas --cliente c1 --nicho casa --limite 10
```

```bash
npm run cli -- ofertas --cliente c1 --nicho casa --palavra "air fryer" --palavra "potes"
```

```bash
npm run cli -- link --cliente c1 --oferta <id da oferta mostrado na tabela>
```

```bash
npm run cli -- link --cliente c1 --url "https://shopee.com.br/Nome-do-Produto-i.123.456" --canal wa
```

- Sem `--palavra`, a busca usa as palavras-chave do nicho cadastradas em `clientes.nichos`.
- `--gravar <pasta>` salva as respostas brutas da Shopee. **Na primeira vez com a conta real, use essa opção** e me mande os arquivos: com eles eu confirmo os campos e troco as respostas de exemplo dos testes por respostas reais.
- O log (JSON) sai na saída de erro. Para ver mais detalhes: `LOG_NIVEL=debug npm run cli -- ...`.

Para conferir no Supabase (**Table Editor** ou **SQL Editor**):

```sql
select produto_id, titulo, preco, desconto_pct, comissao_pct, data_coleta from ofertas order by criado_em desc limit 10;
select url_afiliado, sub_ids, chave_rastreio, criado_em from links order by criado_em desc limit 5;
```

### Como ficam os sub_ids

| Campo | Exemplo | Conteúdo |
|---|---|---|
| 1 | `c1` | código do cliente |
| 2 | `wa` | canal |
| 3 | `20261112` | dia da postagem (fuso do cliente) |
| 4 | `22912345678` | ID do produto na Shopee (`avulso` se a URL não tiver o ID) |
| 5 | `0815` | horário da postagem |

Em `links.chave_rastreio` eles ficam unidos por hífen (`c1-wa-20261112-22912345678-0815`).
É por essa chave que o Sincronizador de ganhos vai casar vendas com postagens.

### Ofertas sem duplicar

Uma linha por cliente + produto + dia de coleta. Buscar de novo no mesmo dia atualiza preço, desconto e comissão.
Em outro dia, entra uma linha nova, o que guarda o histórico de preço.

## Painel de aprovação

A tela do dia a dia: em vez dos comandos de lista, você aprova tudo no navegador.

1. No `.env`, defina `PAINEL_SENHA` (obrigatória) e `PAINEL_OPERADOR` (seu nome, gravado em cada aprovação).
2. Rode:
   ```bash
   npm run painel
   ```
3. Abra `http://127.0.0.1:3000`. O navegador pede a senha (usuário: qualquer).

O que dá para fazer, por cliente e por dia:

| Seção | Ações |
|---|---|
| Escolhidas do Curador | rodar o Curador; para as escolhidas sem link, ver o produto e os 5 Sub_ids (com botão de copiar) e colar o link gerado no painel da Shopee |
| Mensagens do dia | redigir com o Redator; validar, aprovar, descartar com motivo; copiar o texto para o WhatsApp; confirmar o preço olhando a página; marcar como enviada |
| Propostas de diretriz | aprovar ou descartar o que o Analista propôs |

As regras são as mesmas do terminal e do banco: nada é aprovado sem validar, nada é enviado sem aprovação,
o preço precisa ter sido conferido há no máximo 30 minutos, e preço mudado tira a mensagem da lista.
Os Sub_ids mostrados usam o horário de envio do cliente (`clientes.horario_envio`, padrão 08:00).

Segurança: o painel só aceita conexões do próprio computador (para abrir na rede, defina `PAINEL_HOST`), exige senha,
e só aceita ações vindas da própria página (outro site aberto no navegador não consegue aprovar nada).
Rodar o Curador e o Redator pela tela exige `ANTHROPIC_API_KEY`; sem ela, o resto funciona e os botões ficam desligados.

## Clientes, uso, Atendente e WhatsApp

### Cadastro de clientes

```bash
npm run cli -- novo-cliente --codigo ana --nome "Ana" --whatsapp 5511999998888 --horario 08:00 --limite 5
```

```bash
npm run cli -- nicho --cliente ana --nome "Casa" --palavras "organizador, air fryer, potes"
```

```bash
npm run cli -- clientes
```

O código (`ana`) vai nos links de rastreio e não muda depois. Também há `editar-cliente`, `remover-nicho`,
`pausar-cliente` (sai da esteira e do painel) e `ativar-cliente`.

### Registro de uso

Cada ação sua no painel ou no terminal fica registrada por cliente. Ações com até 10 minutos de intervalo formam uma sessão;
a soma das sessões estima os minutos que cada cliente consome. Junto vem o custo da IA:

```bash
npm run cli -- uso --de 2026-11-01 --ate 2026-11-30
```

É uma estimativa: tempo olhando a tela sem clicar não aparece.

### Atendente (pedidos da afiliada)

Cada mensagem dela vira um pedido. O Atendente só classifica e extrai dados; as respostas são textos fixos do sistema:

| Pedido | O que acontece |
|---|---|
| "quanto ganhei?" | responde na hora, com comissão validada e pendente do banco |
| "me manda o link disso" | com a Open API da Shopee, gera o link na hora; senão, fica para você e ela recebe "já te mando" |
| "fica de olho nesse", "quero pets também", "pausa até dia 20" | fica para você; ela recebe uma confirmação de que você vai ver |
| "mandar a lista de hoje" | sem IA: envia as mensagens aprovadas do dia, em ordem |
| qualquer outra coisa | fica para você, com a mensagem original, sem resposta automática |

Nada muda sozinho: pausar, mudar nicho e acompanhar produto sempre passam por você.
Os pedidos aparecem no painel (seção "Pedidos da afiliada"), onde você conclui cada um.
Enquanto o WhatsApp não existe, cole a mensagem dela no campo "Processar mensagem" do painel.

### Disparador e WhatsApp

Hoje o envio é **manual**: copie o texto no painel, envie pelo WhatsApp Business e clique em "Marcar como enviada".
Antes de registrar, o sistema confere preço (até 30 minutos), repetição e aprovação.

Quando o número for aprovado na Cloud API da Meta:
1. Preencha as variáveis `WHATSAPP_*` no `.env` (veja `.env.example`).
2. Rode o receptor de avisos (precisa de HTTPS público; ex.: atrás de um proxy, ou depois como Edge Function):
   ```bash
   npm run webhook
   ```
3. Cadastre o endereço e o texto de verificação no painel da Meta.

Daí em diante, o painel mostra "Enviar pelo WhatsApp". Pela regra da janela de 24 horas, a lista sai quando ela
pede ("Mandar a lista de hoje"); fora da janela, o envio é recusado com explicação. Entrega e leitura ficam
registradas em cada mensagem.

## Lista do dia, vendas e esteira

Funciona hoje com o modo manual (planilha e links do painel); nada aqui depende da Open API ou da extensão.

### Montar a lista do dia

Você (ou, depois, o agente Redator) escreve o texto com **marcadores**. O sistema preenche com os valores do banco:

```bash
npm run cli -- rascunho --cliente c1 --oferta <id> --texto "Achado! 😍 {{preco}} com {{desconto}} off 👉 {{link}}"
```

| Marcador | Vira |
|---|---|
| `{{preco}}` | preço atual da oferta (`R$ 29,90`) |
| `{{desconto}}` | desconto da oferta (`25%`); só se a oferta tiver desconto |
| `{{link}}` | link de afiliado registrado para a oferta (obrigatório) |

O texto é recusado se trouxer preço, percentual, link ou número escrito à mão.
Números grudados em letras (`4L`, `128GB`) podem ficar; "6 divisórias" precisa virar "seis divisórias".

Depois:

```bash
npm run cli -- validar --cliente c1
```

```bash
npm run cli -- lista --cliente c1
```

```bash
npm run cli -- aprovar --cliente c1 --mensagem <id> --por Miguel
```

Depois de enviar a mensagem pelo WhatsApp, registre o envio:

```bash
npm run cli -- enviada --cliente c1 --mensagem <id>
```

**Validadores** (em `validar`): texto só com marcadores; link do cliente certo, da plataforma e do produto da oferta
(na Shopee, o Sub_id1 tem de ser o código do cliente); preço igual ao da oferta; produto não enviado nos últimos 7 dias;
limite de mensagens por dia do cliente (`clientes.limite_mensagens_dia`, padrão 10).

**Antes do envio**, o sistema confere de novo:
- se o preço foi conferido há mais de 30 minutos, a mensagem não sai; confirme o preço olhando a página e repita:
  ```bash
  npm run cli -- confirmar-preco --cliente c1 --oferta <id> --preco 29,90
  ```
- se o preço mudou, ou o produto foi enviado nos últimos 7 dias, a mensagem sai da lista (descartada, com o motivo).

O banco garante a ordem dos estados: nada vira "enviada" sem ter sido "aprovada", e mexer no texto de uma mensagem
validada ou aprovada a devolve para rascunho.

### Vendas e resumo

**Shopee, sem arquivo:** com a extensão do Chrome pareada (painel › Configuração › Extensão do Chrome),
as vendas e os cliques chegam sozinhos do painel de afiliados da Shopee, a cada 6 horas ou quando você abre os relatórios.
Os links curtos que você gera pela barra SiteStripe da Amazon também chegam. Passo a passo em [`extensao/LEIA-ME.md`](extensao/LEIA-ME.md).
Um arquivo de gravação da extensão também pode ser importado em **Importar › Gravação da extensão**.

Para o resto (Mercado Livre, pedidos da Amazon), as vendas entram pela planilha
[`docs/modelos/vendas.csv`](docs/modelos/vendas.csv) (na Shopee, com as colunas `sub_id1` a `sub_id5`):

```bash
npm run cli -- importar-vendas --cliente c1 --arquivo vendas.csv
```

```bash
npm run cli -- resumo --cliente c1 --de 2026-11-09 --ate 2026-11-15
```

- **Shopee:** a venda casa com a postagem pelos 5 Sub_ids. Se o comprador levou outro produto, continua atribuída e fica marcada.
- **Mercado Livre e Amazon:** casa pela etiqueta (ou tracking ID) **e** pelo produto, com o link criado antes do pedido.
- Sem par, a venda fica como **não atribuída** e aparece no resumo; nunca some.
- Reimportar atualiza a situação (pendente → validada ou cancelada) e mostra o que mudou.
- O resumo nunca soma comissão pendente com validada.

### Esteira e fila

```bash
npm run cli -- agendar-dia
```

```bash
npm run cli -- fila
```

```bash
npm run cli -- fila-status
```

`agendar-dia` cria as tarefas do dia para cada cliente, no horário dele (Brasília). Rodar de novo não duplica.

| Horário | Etapa | Observação |
|---|---|---|
| 05:00 | medição | mensagens enviadas há mais de 7 dias passam a "medida" |
| 05:30 | coleta de ofertas | só com a Open API da Shopee; sem ela, a etapa é pulada (ofertas entram pela planilha) |
| 06:00 | Curador escolhe as ofertas do dia | |
| 06:15 | links das escolhidas | só com a Open API; sem ela, `preparar-links` mostra as escolhidas sem link |
| 06:30 | Redator escreve as mensagens | só das escolhidas que já têm link |
| 06:45 | validação da lista | |
| domingo 20:00 | fechamento e Analista | o texto do fechamento fica no resultado da tarefa até o WhatsApp existir |

`fila` executa as tarefas vencidas: uma etapa que falha tenta de novo com espera crescente (1, 2 e 4 minutos), até 3 vezes,
sem segurar as outras. Para rodar sozinho, basta chamar `fila` a cada poucos minutos (cron do servidor ou do Supabase).

### Agentes (IA)

Todos usam o mesmo harness, com o provedor escolhido na aba Configuração:

- **Gemini (padrão, gratuito):** chave em aistudio.google.com ("Get API key"). Modelos padrão: `gemini-3.5-flash-lite`
  (Redator e Atendente) e `gemini-4-hydrogen` (Curador e Analista), ambos com nível gratuito. Há limite de chamadas
  por minuto e por dia (veja no AI Studio), e no nível gratuito o Google pode usar o conteúdo enviado para melhorar os produtos dele.
- **Claude (pago):** chave em platform.claude.com. Modelo padrão: Claude Haiku 5.5.

As regras são as mesmas nos dois: saída em JSON conferida pelo harness, repetição com o motivo e registro de cada chamada.
Para trocar, defina no `.env` `MODELO_IA_PEQUENO` (Redator) e/ou `MODELO_IA_FORTE` (Curador e Analista),
com `MODELO_IA_..._PRECO` para registrar o custo. A chave vai em `ANTHROPIC_API_KEY`.

**Curador** (escolhe as ofertas do dia):

```bash
npm run cli -- curar --cliente c1
```

```bash
npm run cli -- selecionadas --cliente c1
```

Recebe as candidatas do dia (sem produtos enviados nos últimos 7 dias), as diretrizes aprovadas e o que foi enviado recentemente.
Devolve IDs em ordem, com um motivo cada. ID fora da lista é recusado. A escolha fica gravada na oferta.

**Redator** (escreve as mensagens das escolhidas que já têm link):

```bash
npm run cli -- redigir-dia --cliente c1
```

Recebe título, nicho, se tem desconto, o tom do grupo e até 3 mensagens antigas com mais cliques, **nunca preço nem link**.
Também dá para redigir ofertas avulsas: `npm run cli -- redigir --cliente c1 --oferta <id>`.

**Diretrizes de nicho** (o texto que o Curador segue; só valem aprovadas):

```bash
npm run cli -- diretrizes --cliente c1
```

```bash
npm run cli -- propor-diretriz --cliente c1 --nicho casa --texto "Priorizar utilidades de cozinha até R$ 60."
```

```bash
npm run cli -- aprovar-diretriz --cliente c1 --id <id>
```

**Analista e fechamento** (semanal; também roda sozinho aos domingos pela fila):

```bash
npm run cli -- fechamento --cliente c1 --de 2026-11-09 --ate 2026-11-15
```

Os indicadores (por nicho, horário, plataforma, faixa de preço e postagem) são calculados em código.
O Analista devolve 3 leituras, cada uma apontando para as linhas de dado que a sustentam, e propostas de diretriz.
No texto, os números saem do banco; leitura com valor em reais ou percentual escrito pelo modelo é recusada.
As propostas ficam como "proposta" até você aprovar: o Analista nunca muda código, prompt ou diretriz em vigor.

**Testar um agente** com seus casos de teste (gera custo, pequeno):

```bash
npm run cli -- testar-agente --cliente c1 --agente curador
```

Proteções de toda chamada: timeout de 60 s e até 3 novas tentativas pelo SDK; saída em JSON com o esquema do agente,
conferida de novo; resposta recusada é repetida com o motivo, no máximo 2 vezes; chave errada para na primeira tentativa;
cada tentativa fica em `execucoes_agente` (entrada, saída, versão do prompt, modelo, tokens, custo).

Contrato e formato dos agentes: [agents/LEIA-ME.md](agents/LEIA-ME.md).

## 6. Testes automatizados

```bash
npm test
```

Extensão num Chromium de verdade (páginas falsas): `npm run extensao:e2e` e `npm run extensao:sincronia`.

Testa o módulo de etiquetas, o parser e o cliente da Shopee (com respostas de exemplo em `services/shopee/fixtures/`), as novas tentativas, a cifragem, os marcadores, as planilhas e o núcleo da extensão.

Os testes com banco de verdade (serviços, lista, vendas, fila, agentes e painel) rodam só com `TEST_DATABASE_URL` apontando para um Postgres **de teste**.
O nome do banco precisa conter `teste`, porque o schema `public` dele é apagado a cada execução:

```bash
TEST_DATABASE_URL=postgres://usuario:senha@localhost:5432/cofilius_teste npm test
```

```bash
npm run typecheck
```

## TODO

### Para conferir na documentação oficial da Shopee

Tudo isso está isolado em `services/shopee/client.ts` e `services/shopee/parser.ts`, marcado com `TODO(shopee-doc)`.
Se algo estiver diferente, o erro aparece no primeiro teste com a conta real: a resposta gravada com `--gravar` mostra o que mudar.

1. **Assinatura**: `SHA256(AppId + Timestamp + Payload + Secret)` em hexadecimal minúsculo, com o timestamp em **segundos** e o payload igual ao corpo enviado. Cabeçalho: `Authorization: SHA256 Credential=<AppId>, Timestamp=<ts>, Signature=<assinatura>`.
2. **Corpo da requisição**: `{"query": "..."}`, com os valores escritos dentro da consulta (não usei `variables`).
3. **`productOfferV2`**: argumentos `keyword`, `sortType`, `page`, `limit` (máximo suposto: 50 por página) e os valores de `sortType` (1 relevância, 2 mais vendidos, 3 maior preço, 4 menor preço, 5 maior comissão). Sem `--ordenacao`, vale o padrão da API.
4. **Campos de `productOfferV2`**: `itemId shopId productName productLink offerLink imageUrl shopName priceMin priceMax priceDiscountRate commissionRate commission sales ratingStar periodStartTime periodEndTime`, e `pageInfo { page limit hasNextPage }`. **Um campo com nome errado faz a API recusar a consulta inteira.**
5. **Unidades**: `commissionRate` como fração (0.12 = 12%), `priceDiscountRate` como inteiro em % (25 = 25%), preços em reais, datas em segundos Unix.
6. **`generateShortLink`**: `input: { originUrl, subIds }` devolvendo `shortLink`.
7. **sub_ids**: caracteres aceitos e tamanho máximo de cada um (o código usa só letras minúsculas e números).
8. **Códigos de erro**: a suposição é 10020 para assinatura inválida e 10030 para limite de chamadas. 10000 e 10030 geram nova tentativa; os outros não.
9. **Limite de chamadas** por minuto ou por dia da conta.

### Para conferir na documentação do WhatsApp Cloud API

Tudo isolado em `services/disparador/whatsapp.ts`, marcado com `TODO(whatsapp-doc)`. Nada foi testado contra a API real.

1. Endpoint de envio `POST https://graph.facebook.com/{versao}/{numeroId}/messages`, cabeçalho `Authorization: Bearer`, e o corpo de texto (`messaging_product`, `to`, `type: "text"`, `text.body`, `text.preview_url`).
2. A versão atual da Graph API (vai em `WHATSAPP_VERSAO_API`).
3. Código de erro de mensagem fora da janela de 24 horas (suposto: 131047).
4. Verificação do webhook (`hub.mode`, `hub.verify_token`, `hub.challenge`) e assinatura `X-Hub-Signature-256` (`sha256=` + HMAC do corpo com o segredo do app).
5. Formato dos avisos: mensagens (`entry[].changes[].value.messages[]`, texto em `text.body`, botões em `button.text` ou `interactive.button_reply.title`) e status (`statuses[]` com `delivered` e `read`).
6. Como criar o botão "Mandar a lista de hoje" (modelo aprovado com botão de resposta rápida) e se a categoria dele é utilidade.

### Formatos da gravação de 13/nov (extensão → painel)

Isolados em `services/extensao/conversores.ts`, marcados com `TODO(confirmar)`:

1. **Escala do dinheiro da Shopee**: valores inteiros divididos por 100.000 (`item_price` 4800000 = R$ 48,00; taxa 3000 = 3%). Conferir uma venda no painel da Shopee contra o painel do Cofilius.
2. **Situação "Completed"** da Shopee foi tratada como **validada**. Se na Shopee "Concluído" ainda espera validação, trocar para pendente.
3. Pedido = `order_sn` (o número que aparece na Shopee); produto = `item_id`; Sub_ids vêm unidos por `-` em `utm_content` (`----` = sem Sub_id).
4. As páginas seguintes dos relatórios são pedidas com os mesmos cabeçalhos da página (só muda `page_num`). Se a Shopee recusar, o painel fica só com a primeira página: aparece no cartão da extensão.

### Relatórios recebidos em 12/nov (para o Sincronizador de ganhos)

- **Shopee, `AffiliateDashboardReport`**: só totais por dia (cliques, pedidos, comissão). Não tem Sub_id nem produto, então não serve para ligar venda a postagem. Falta o **relatório de conversões**, com uma linha por pedido e as colunas de Sub_id.
- **Amazon, relatórios `Tracking-Id`, `Linked-Product`, `Category` e `Top-Sellers`**: são resumos. O de tracking ID não tem data, e o de produto agrupa tudo em "Other". Faltam os relatórios de **pedidos** e de **ganhos**, que listam cada item com ASIN, data e tracking ID.
- Detalhes de formato já vistos na Amazon: data `DD-MM-AAAA`, ponto como separador decimal, `-` para vazio, cabeçalhos ora em português, ora em inglês.
- A conta da Amazon tem hoje **um único tracking ID**. Para separar canal e nicho, é preciso criar mais no painel. A Amazon termina todo tracking ID com `-20`; a sugestão de nome da função de etiquetas (`wa-casa`) ainda precisa seguir esse formato.

### Para confirmar nos painéis (da arquitetura)

- Mercado Livre: se a etiqueta (`wa-s46-casa`) pode ser criada na hora de gerar o link.
- Amazon: quantos tracking IDs são permitidos. A função de etiquetas usa um tracking ID já cadastrado para o par canal+nicho; se não houver, sugere o nome (`wa-casa`) e avisa que precisa criá-lo no painel.

### Decisões em aberto, para depois

- **Aviso de falha:** etapa que falha de vez fica em `fila-status` e no log de erro. Falta mandar o aviso por WhatsApp quando o canal existir.
- **Casos de teste dos agentes:** são 2 a 3 de exemplo por agente; a meta é 15 a 20 reais. Nenhum foi rodado ainda com o modelo de verdade.
- **Modelo:** todos no Claude Haiku 5.5 por enquanto. Se a curadoria ou a análise ficarem fracas, o primeiro teste é subir o porte "forte" (`MODELO_IA_FORTE`).
- **WhatsApp:** o código existe, mas os formatos não foram conferidos (lista acima). Até a aprovação do número, o envio é manual e o fechamento fica no resultado da tarefa (`fila-status`) e no comando `fechamento`.
- **Mensagem automática do fechamento e aviso de falha:** saem pelo WhatsApp quando ele estiver ligado; falta o modelo aprovado pela Meta para mensagens fora da janela de 24 horas.

- **Link perdido se o banco falhar:** se a Shopee gerar o link e a gravação falhar depois das novas tentativas, o link não fica salvo. Ele é só registrado no log de erro. Basta pedir o link de novo.
- **Paginação além do necessário:** se uma página da Shopee só trouxer produtos repetidos, a busca segue para a próxima, até 5 páginas por palavra-chave.
