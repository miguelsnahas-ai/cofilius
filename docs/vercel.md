# Cofilius na nuvem (Vercel, plano grátis)

Com o Cofilius no Vercel, o painel fica no ar o tempo todo (abre no celular também) e a esteira roda sozinha.
O notebook pode ficar desligado. O banco continua o mesmo Supabase.

Uma coisa não muda: os dados da Shopee chegam pela **extensão do Chrome**, quando alguém abre o painel de
afiliados da Shopee num Chrome de computador (qualquer um) com a extensão pareada.

> **Plano grátis (Hobby):** pelas regras do Vercel, ele é para uso pessoal e não comercial. Se o Cofilius
> passar a atender clientes pagantes, o certo é mudar para o plano Pro.

## O que você vai precisar

| Variável | O que é | Onde pegar |
|---|---|---|
| `DATABASE_URL` | Endereço do banco | Supabase › seu projeto › **Connect** › **Transaction pooler** (porta **6543**). Troque `[YOUR-PASSWORD]` pela senha do banco. |
| `PAINEL_SENHA` | Senha para abrir o painel | Invente uma com **12 caracteres ou mais** (o painel fica na internet). |
| `CREDENCIAIS_CHAVE` | Chave que cifra as credenciais guardadas no banco | **Se você já usou o painel no notebook:** abra o arquivo `.env` da pasta do Cofilius no Bloco de Notas e copie a linha `CREDENCIAIS_CHAVE`. Tem que ser a **mesma**, senão as credenciais já gravadas não abrem. **Banco novo:** o próprio Vercel sugere uma (passo 4). |
| `CRON_SECRET` | Senha que o agendador do Vercel usa para rodar a esteira | Qualquer texto longo e aleatório; o Vercel também sugere um (passo 4). |
| `GEMINI_API_KEY` (opcional) | Chave da IA | Pode colocar aqui ou depois, no próprio painel (Configuração). |

## Passo a passo

1. **Código no GitHub.** O Vercel publica a partir do GitHub. O trabalho está no branch
   `claude/cofilius-fase0-shopee-e9by0t`: junte no `main` (pull request) **ou** use esse branch como
   "Production Branch" no passo 3.
2. **Conta no Vercel.** Em vercel.com, entre com o GitHub e escolha o plano **Hobby**.
3. **Projeto.** **Add New… › Project**, escolha o repositório `cofilius` e clique em **Import**.
   - *Framework Preset*: **Other**. Não mude os comandos: o `vercel.json` do projeto já diz como montar.
   - Se não juntou no `main`: depois de criar, vá em **Settings › Git › Production Branch** e ponha o branch do passo 1.
4. **Variáveis.** Antes de publicar, em **Environment Variables**, cole as variáveis da tabela.
   Se esquecer alguma, o endereço do projeto mostra o que falta e sugere valores para `CREDENCIAIS_CHAVE`
   (só para banco novo) e `CRON_SECRET`. Depois de colar, clique em **Deployments › … › Redeploy**.
5. **Publicar.** **Deploy**. Leva uns dois minutos. As tabelas são criadas ou atualizadas sozinhas no primeiro acesso.
6. **Abrir.** Entre em `https://<nome-do-projeto>.vercel.app`. O navegador pede usuário e senha:
   usuário qualquer, senha = `PAINEL_SENHA`.
7. **Configuração.** Na aba Configuração, confira a chave da IA, o provedor e deixe a **esteira ligada**.
   Na nuvem, o que você salva ali fica no banco (as chaves cifradas). A senha do painel só se troca no Vercel.
8. **Extensão.** Atualize a pasta `extensao` (versão 0.6.0) e recarregue em `chrome://extensions`.
   No painel novo, **Configuração › Extensão do Chrome › Gerar código de pareamento**. No ícone do
   Cofilius, **Trocar de painel ou cliente**, cole `https://<nome-do-projeto>.vercel.app` e o código, e **Parear**.
9. **Pronto.** Pode fechar o painel do notebook. Se ele continuar ligado também, não há conflito
   (a fila não repete etapas), mas não é necessário.

## Quando a esteira roda (plano grátis)

O agendador do plano grátis roda **no máximo uma vez por dia** por agendamento e pode atrasar até uma hora.

| Agendamento | Horário (Brasília) | O que faz |
|---|---|---|
| Rodada da manhã | todo dia, entre 6h e 7h | agenda o dia e roda, em ordem, medição, coleta (com a API da Shopee), Curador, links, Redator e validação |
| Rodada da noite | domingo, entre 20h e 21h | fechamento da semana (com a leitura do Analista, se a IA estiver ligada) |

- Uma etapa que falhar fica para a próxima rodada; para não esperar, use **Relatórios › Esteira automática › Rodar agora**.
- Cada rodada tem até 5 minutos (limite do Vercel). Com muitos clientes, o que não couber termina na próxima rodada ou no "Rodar agora".
- Os agendamentos aparecem em **Settings › Cron Jobs** do projeto no Vercel.

## Segurança na internet

- Senha obrigatória em tudo, com HTTPS do Vercel. Senha com menos de 12 caracteres: o painel não abre.
- Dez senhas erradas (ou códigos de extensão errados) do mesmo endereço em 15 minutos: bloqueio por 15 minutos.
- A extensão entra só com o código de pareamento do cliente; o agendador, só com o `CRON_SECRET`.
- Chaves de IA guardadas cifradas no banco; a chave mestra existe só nas variáveis do Vercel.

## Como funciona por dentro (para desenvolvedores)

- `npm run nuvem:build` (o Vercel roda sozinho) monta `.vercel/output` no formato Build Output API v3:
  uma função (`index.func`, Node 22, região `gru1`, até 300 s) com o código empacotado e as telas, os
  prompts e as migrations ao lado; `config.json` manda todas as rotas para ela e define os agendamentos.
- `nuvem/funcao.ts`: entrada da função (restaura o caminho original, roda as migrations uma vez por
  instância, carrega a configuração do banco, atende o agendador em `/api/cron/esteira`).
- `painel/servidor.ts` com `nuvem: true`: sem tela de configuração inicial, configuração no banco
  (`harness/configBanco.ts`), bloqueio por tentativas, esteira só pelo agendador.
- Testes: `nuvem/funcao.db.test.ts`.
