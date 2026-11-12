# Cofilius

Serviço de operação para afiliados de Shopee, Mercado Livre e Amazon que divulgam ofertas em grupos de WhatsApp.
Arquitetura e roadmap: [docs/arquitetura.md](docs/arquitetura.md).

**Estado atual:** Fase 0 (fundação) e o primeiro serviço da Fase 1, só para a Shopee:

- banco com as 11 tabelas do modelo de dados, todas com `cliente_id`;
- padrão de etiquetas de rastreio (sub_ids da Shopee, etiqueta do Mercado Livre, tracking ID da Amazon);
- **Conector de ofertas**: busca ofertas na Shopee por palavra-chave do nicho e grava em `ofertas`;
- **Links e rastreio**: gera o link de afiliado da Shopee com os sub_ids e grava em `links`;
- um comando de linha para testar os dois com a conta real;
- **modo manual**, para usar enquanto a Open API da Shopee não estiver liberada: ofertas por planilha e links gerados no painel;
- **lista diária**: rascunho → validada → aprovada → enviada → medida, com os estados garantidos pelo banco, marcadores preenchidos pelo código e os validadores da arquitetura;
- **vendas**: atribuição de cada venda à postagem (ou "não atribuída"), cliques e resumo do período com comissão pendente, validada e cancelada separadas;
- **esteira e fila de tarefas**: etapas do dia com horário por cliente, novas tentativas e falha isolada;
- **harness dos agentes**: contrato de cada agente (prompt versionado, esquemas, até 2 repetições, registro de custo e casos de teste), com o contrato do Redator como primeiro exemplo;
- **extensão de Chrome (etapa 1: gravador para Mercado Livre, Shopee e Amazon)**: grava os dados que as páginas de afiliado carregam, para mapear o formato real. Instalação e uso em [extensao/LEIA-ME.md](extensao/LEIA-ME.md).

## Estrutura

```
agents/      contratos dos agentes de IA (por enquanto, o Redator)
services/
  etiquetas/ padrão de etiquetas de rastreio
  shopee/    cliente da Shopee Affiliate Open API (client.ts) e parser das respostas
  ofertas/   Conector de ofertas · Shopee (API e planilha)
  links/     Links e rastreio · Shopee (API e painel)
  lista/     lista diária: marcadores, validadores, aprovação, envio
  vendas/    atribuição de vendas, cliques, resumo do período
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

Enquanto não há importador para os relatórios de cada plataforma, as vendas entram pela planilha
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

`agendar-dia` cria as tarefas do dia para cada cliente, no horário dele. Hoje são duas etapas:
a coleta de ofertas, que só roda com a Open API da Shopee (sem ela, a etapa é pulada e avisada), e a validação da lista.
Rodar de novo não duplica.
`fila` executa as tarefas vencidas: uma etapa que falha tenta de novo com espera crescente (1, 2 e 4 minutos), até 3 vezes,
sem segurar as outras. Para rodar sozinho, basta chamar `fila` a cada poucos minutos (cron do servidor ou do Supabase).

### Agentes

O harness (`harness/agentes.ts`) e o formato do contrato estão em [agents/LEIA-ME.md](agents/LEIA-ME.md).
O contrato do Redator já existe, mas **nenhum agente roda ainda**: falta o cliente da API do Claude e a escolha dos modelos
(`MODELO_IA_PEQUENO` e `MODELO_IA_FORTE` no `.env`).

## 6. Testes automatizados

```bash
npm test
```

Testa o módulo de etiquetas, o parser e o cliente da Shopee (com respostas de exemplo em `services/shopee/fixtures/`), as novas tentativas, a cifragem, os marcadores, as planilhas e o núcleo da extensão.

Os testes com banco de verdade (serviços, lista, vendas, fila e agentes) rodam só com `TEST_DATABASE_URL` apontando para um Postgres **de teste**.
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
- **Cliente da API do Claude:** falta, para os agentes rodarem. O harness já está pronto para recebê-lo.
- **Casos de teste do Redator:** são 3 de exemplo; a meta é 15 a 20 reais.

- **Link perdido se o banco falhar:** se a Shopee gerar o link e a gravação falhar depois das novas tentativas, o link não fica salvo. Ele é só registrado no log de erro. Basta pedir o link de novo.
- **Paginação além do necessário:** se uma página da Shopee só trouxer produtos repetidos, a busca segue para a próxima, até 5 páginas por palavra-chave.
