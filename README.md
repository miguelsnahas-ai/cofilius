# Cofilius

Serviço de operação para afiliados de Shopee, Mercado Livre e Amazon que divulgam ofertas em grupos de WhatsApp.
Arquitetura e roadmap: [docs/arquitetura.md](docs/arquitetura.md).

**Estado atual:** Fase 0 (fundação) e o primeiro serviço da Fase 1, só para a Shopee:

- banco com as 11 tabelas do modelo de dados, todas com `cliente_id`;
- padrão de etiquetas de rastreio (sub_ids da Shopee, etiqueta do Mercado Livre, tracking ID da Amazon);
- **Conector de ofertas**: busca ofertas na Shopee por palavra-chave do nicho e grava em `ofertas`;
- **Links e rastreio**: gera o link de afiliado da Shopee com os sub_ids e grava em `links`;
- um comando de linha para testar os dois com a conta real.

## Estrutura

```
agents/      agentes de IA (ainda vazio)
services/
  etiquetas/ padrão de etiquetas de rastreio
  shopee/    cliente da Shopee Affiliate Open API (client.ts) e parser das respostas
  ofertas/   Conector de ofertas · Shopee
  links/     Links e rastreio · Shopee
harness/     o que roda os serviços: config, log, timeout e novas tentativas, cifragem, banco, comando de teste
db/          migrations, seed, script de migração, acesso a clientes e credenciais
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

## 6. Testes automatizados

```bash
npm test
```

Testa o módulo de etiquetas, o parser e o cliente da Shopee (com respostas de exemplo em `services/shopee/fixtures/`), as novas tentativas e a cifragem.

Os testes dos serviços com banco de verdade rodam só com `TEST_DATABASE_URL` apontando para um Postgres **de teste**.
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

### Para confirmar nos painéis (da arquitetura)

- Mercado Livre: se a etiqueta (`wa-s46-casa`) pode ser criada na hora de gerar o link.
- Amazon: quantos tracking IDs são permitidos. A função de etiquetas usa um tracking ID já cadastrado para o par canal+nicho; se não houver, sugere o nome (`wa-casa`) e avisa que precisa criá-lo no painel.

### Decisões em aberto, para depois

- **Link perdido se o banco falhar:** se a Shopee gerar o link e a gravação falhar depois das novas tentativas, o link não fica salvo. Ele é só registrado no log de erro. Basta pedir o link de novo.
- **Paginação além do necessário:** se uma página da Shopee só trouxer produtos repetidos, a busca segue para a próxima, até 5 páginas por palavra-chave.
