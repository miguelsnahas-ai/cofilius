# Cofilius · extensão de Chrome

## Etapa 2: vendas, cliques e links chegam sozinhos no painel

Com a extensão **pareada** com o painel, não há arquivo para subir:

| O que | De onde | Vira no painel |
|---|---|---|
| Vendas (conversões) | Shopee Afiliados › Relatório de conversões | Vendas, ligadas à postagem pelos Sub_ids; a situação (pendente, concluída, cancelada) se atualiza a cada busca |
| Cliques | Shopee Afiliados › Relatório de cliques | Cliques por dia e por Sub_id |
| Links curtos | Barra SiteStripe na página de produto da Amazon | Link da Amazon (produto + tracking ID), para atribuir as vendas depois |

Como chega:
- **Sozinha, a cada 6 horas** (com o Chrome aberto e logada na Shopee Afiliados): a extensão abre os dois relatórios da Shopee numa janela minimizada, pega os dados e fecha a janela.
- **Na hora**, sempre que você abre esses relatórios, ou pelo botão **Buscar agora**.
- A extensão percorre todas as páginas do relatório (até 25), não só a primeira.
- Se o painel estiver fechado, os dados esperam numa fila e vão quando ele abrir (tentativa a cada 5 minutos).

### Parear (uma vez por cliente)

1. Abra o painel do Cofilius, escolha o cliente no topo e vá em **Configuração › Extensão do Chrome › Gerar código de pareamento**.
2. Clique no ícone do Cofilius no Chrome, confira o endereço do painel (`http://127.0.0.1:3000`), cole o código e clique em **Parear**.
3. Pronto: aparece "Pareada · cliente ...". No painel, o mesmo cartão mostra quando cada dado chegou.

O painel e o Chrome precisam estar **no mesmo computador** (o painel só aceita conexões do próprio computador).

### Ainda não automatizado (falta gravar)

- **Lista de ofertas da Shopee** (busca de produtos no painel de afiliados): ainda importada pela planilha.
- **Link personalizado da Shopee** (o que preenche os Sub_ids): ainda colado à mão no painel.
- **Ganhos e pedidos da Amazon**: a gravação trouxe só totais por produto, sem os pedidos. Grave o relatório de **pedidos** e o de **ganhos** por dia.

## Etapa 1: gravador (Mercado Livre, Shopee e Amazon)

Uma única extensão para as três plataformas. Enquanto está ligada, ela grava os dados que as páginas de afiliado carregam:
ganhos, cliques, etiquetas, relatórios, links gerados. Ela **não clica em nada, não muda nada na página e não envia nada pela internet**.
Tudo fica no Chrome até você baixar o arquivo.

Para que serve: com esse arquivo, o Cofilius aprende o formato real dos dados do painel.
As próximas etapas (gerar links com a etiqueta certa e importar ganhos sozinha) são construídas em cima dele.

### Instalar (uma vez)

1. Baixe esta pasta `extensao` para o computador (pelo GitHub: botão **Code → Download ZIP**, depois descompacte).
2. No Chrome, abra `chrome://extensions`.
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta `extensao`.
5. Clique no ícone de quebra-cabeça da barra do Chrome e fixe o **Cofilius**.
6. Para atualizar: baixe a pasta nova, substitua a antiga e clique no botão de recarregar da extensão em `chrome://extensions`.

### Gravar

1. Clique no ícone do Cofilius, abra **Gravador (para formatos novos)** e clique em **Começar a gravar**. O ícone mostra um número vermelho com o total gravado.
2. Navegue normalmente pelas páginas de afiliado. Vale passar por:

   **Mercado Livre**
   - o painel ou resumo de ganhos;
   - os relatórios, mudando o período e filtrando por etiqueta;
   - a página de etiquetas;
   - o gerador de links: gere **um** link de um produto qualquer, com uma etiqueta;
   - uma página de produto com a barra de afiliados aparecendo, clicando para gerar o link por ela.

   **Shopee** (painel em `affiliate.shopee.com.br`)
   - o painel inicial;
   - a lista de ofertas de produtos, fazendo uma busca por palavra (ex.: "organizador");
   - o **relatório de conversões**, com o período dos últimos 30 dias, passando por mais de uma página da tabela;
   - a tela de link personalizado: gere **um** link preenchendo os Sub_ids (ex.: `c1`, `wa`, `20261112`, `teste`, `0815`).

   **Amazon** (painel em `associados.amazon.com.br`)
   - a página inicial do painel;
   - os relatórios, abrindo o de **pedidos** e o de **ganhos**, com o período dos últimos 30 dias;
   - a página de gerenciar tracking IDs;
   - uma página de produto na Amazon com a barra SiteStripe, gerando o link curto por ela.
3. Em cada uma dessas páginas, clique também em **Salvar esta página**. Isso guarda o desenho da tela, que vou usar para a extensão preencher campos na etapa 2.
4. Clique em **Parar de gravar** e depois em **Baixar arquivo**. O arquivo `cofilius-gravacao-....json` vai para a pasta de downloads. O popup mostra quanto foi gravado em cada plataforma.
5. Envie o arquivo para o Miguel. Depois, se quiser, clique em **Limpar tudo**.

### Privacidade

- Antes de guardar qualquer coisa, a extensão troca por `***` os campos de e-mail, CPF, telefone, endereço, nome, senha e tokens. E-mails e CPFs soltos no texto também são trocados.
- Ela só olha `mercadolivre.com.br`, `shopee.com.br` e `amazon.com.br`. O gravador só guarda enquanto está ligado; a sincronia manda ao painel apenas os três dados da tabela acima, e só para o endereço do painel que você pareou.
- O painel guarda das vendas só o necessário (pedido, produto, valores, situação, Sub_ids, data). Nada da compradora.
- Na Shopee e na Amazon, que também são lojas onde você compra, ela grava só o painel de afiliados e as páginas de produto (por causa da barra de link). Fora do painel, grava só as chamadas de afiliado ou do SiteStripe.
- Carrinho, compras, pedidos, endereços, pagamento, conta e login **nunca** são gravados, em nenhuma das três.
- Se em alguma página do painel o número do ícone não subir, me avise o endereço da página: pode ser um domínio que a extensão ainda não conhece.
- Mesmo assim, o arquivo pode ter dados da conta, como o apelido do vendedor, valores de ganhos e etiquetas. Trate-o como um relatório da conta.

### Para desenvolvedores

- `nucleo.js`: regras puras (o que gravar e o que mascarar). Testes: `npm test`.
- `interceptor.js`: roda dentro da página e observa `fetch` e `XMLHttpRequest` sem alterá-los.
- `ponte.js`: repassa as capturas ao `servico.js`, que guarda em `chrome.storage.local` e manda ao painel o que é de sincronia (`POST /extensao/receber`, cabeçalho `X-Cofilius-Extensao` com o código).
- Conversão no painel: `services/extensao/conversores.ts` (formatos confirmados pela gravação de 13/11/2026) e `receber.ts`.
- Testes de ponta a ponta: `npm run extensao:e2e` (gravador) e `npm run extensao:sincronia` (pareamento, páginas seguintes, fila).
- `popup.html` e `popup.js`: a janelinha com os botões.
- Teste de ponta a ponta num Chromium real, com páginas falsas das três plataformas: `npm run extensao:e2e`.
