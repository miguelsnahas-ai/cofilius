# Cofilius · extensão de Chrome

## Etapa 1: gravador do Mercado Livre

Enquanto está ligada, a extensão grava os dados que as páginas de afiliado do Mercado Livre carregam:
ganhos, cliques, etiquetas, links gerados. Ela **não clica em nada, não muda nada na página e não envia nada pela internet**.
Tudo fica no Chrome até você baixar o arquivo.

Para que serve: com esse arquivo, o Cofilius aprende o formato real dos dados do painel.
As próximas etapas (gerar links com a etiqueta certa e importar ganhos sozinha) são construídas em cima dele.

### Instalar (uma vez)

1. Baixe esta pasta `extensao` para o computador (pelo GitHub: botão **Code → Download ZIP**, depois descompacte).
2. No Chrome, abra `chrome://extensions`.
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta `extensao`.
5. Clique no ícone de quebra-cabeça da barra do Chrome e fixe o **Cofilius · Gravador**.

### Gravar

1. Clique no ícone do Cofilius e em **Começar a gravar**. O ícone mostra um número vermelho com o total gravado.
2. Navegue normalmente pelas páginas de afiliado do Mercado Livre. Vale passar por:
   - o painel ou resumo de ganhos;
   - os relatórios, mudando o período e filtrando por etiqueta;
   - a página de etiquetas;
   - o gerador de links: gere **um** link de um produto qualquer, com uma etiqueta;
   - uma página de produto com a barra de afiliados aparecendo, clicando para gerar o link por ela.
3. Em cada uma dessas páginas, clique também em **Salvar esta página**. Isso guarda o desenho da tela, que vou usar para a extensão preencher campos na etapa 2.
4. Clique em **Parar de gravar** e depois em **Baixar arquivo**. O arquivo `cofilius-mercadolivre-....json` vai para a pasta de downloads.
5. Envie o arquivo para o Miguel. Depois, se quiser, clique em **Limpar tudo**.

### Privacidade

- Antes de guardar qualquer coisa, a extensão troca por `***` os campos de e-mail, CPF, telefone, endereço, nome, senha e tokens. E-mails e CPFs soltos no texto também são trocados.
- Ela só olha páginas `mercadolivre.com.br`, e só enquanto a gravação está ligada.
- Mesmo assim, o arquivo pode ter dados da conta, como o apelido do vendedor, valores de ganhos e etiquetas. Trate-o como um relatório da conta.

### Para desenvolvedores

- `nucleo.js`: regras puras (o que gravar e o que mascarar). Testes: `npm test`.
- `interceptor.js`: roda dentro da página e observa `fetch` e `XMLHttpRequest` sem alterá-los.
- `ponte.js`: repassa as capturas ao `servico.js`, que guarda em `chrome.storage.local`.
- `popup.html` e `popup.js`: a janelinha com os botões.
- Teste de ponta a ponta num Chromium real, com páginas falsas do Mercado Livre: `npm run extensao:e2e`.
