/**
 * Cofilius · núcleo do gravador (regras puras, sem acesso ao Chrome).
 *
 * Carregado na página (para mascarar antes de qualquer dado sair dela), no popup e nos testes.
 * Expõe globalThis.CofiliusNucleo.
 */
(function (raiz) {
  'use strict';

  /**
   * Regras por plataforma.
   * - hosts: domínios da plataforma.
   * - afiliado: domínios do painel de afiliados. Ali grava tudo (menos métricas).
   * - Fora do painel (a loja em si), só grava chamadas cujo caminho bate com `chamadasNaLoja`,
   *   e só registra páginas que batem com `paginasNaLoja`. Assim compras pessoais ficam de fora.
   * TODO(confirmar): domínios do painel de afiliados da Shopee e da Amazon Brasil.
   */
  const PLATAFORMAS = [
    {
      id: 'mercado_livre',
      nome: 'Mercado Livre',
      hosts: /(^|\.)(mercadolivre\.com\.br|mercadolibre\.com)$/i,
      // No Mercado Livre o programa de afiliados fica dentro do próprio site (e a barra de afiliados
      // aparece nas páginas de produto); por isso a loja inteira vale, menos as áreas pessoais.
      afiliado: /(^|\.)(mercadolivre\.com\.br|mercadolibre\.com)$/i,
      ignorar: /(melidata|\/tracks?(\/|$|\?)|\/jms\/.*\/log)/i,
    },
    {
      id: 'shopee',
      nome: 'Shopee',
      hosts: /(^|\.)shopee\.com\.br$/i,
      afiliado: /^affiliate\.shopee\.com\.br$/i,
      chamadasNaLoja: /affiliate/i,
      paginasNaLoja: /(-i\.\d+\.\d+|\/product\/\d+\/\d+)/i,
      ignorar: /(\/__t__|\/apm|\/tracking|\/track\b|\/event|\/df\/|dem\.shopee|\/log(\/|$|\?))/i,
    },
    {
      id: 'amazon',
      nome: 'Amazon',
      hosts: /(^|\.)amazon\.com\.br$/i,
      afiliado: /^associados\.amazon\.com\.br$/i,
      chamadasNaLoja: /(associates|sitestripe)/i,
      paginasNaLoja: /(\/dp\/|\/gp\/product\/)/i,
      ignorar: /(uedata|\/csm|unagi|\/rd\/|\/1\/events|\/batch\/|fls-|\/af\/feedback|aax|\/sponsored)/i,
    },
  ];

  /** Métricas e rastreadores comuns a todas. */
  const IGNORAR_SEMPRE = /(analytics|hotjar|google|doubleclick|newrelic|nr-data|sentry|clarity|\/metrics|\/beacon)/i;

  /** Áreas pessoais da loja (compras, carrinho, conta, pagamento, login). Nunca gravadas. */
  const AREAS_PESSOAIS = /(checkout|\/cart|carrinho|minhas-compras|my-purchases|\/compras|purchase|your-orders|order-history|your-account|\/gp\/css\/|addresses|enderecos|payment|pagamento|wallet|carteira|\/login|signin|\/ap\/|\/perfil|\/profile)/i;

  /** Nomes de campo cujo valor nunca é gravado (dados pessoais e segredos). */
  const CHAVES_SENSIVEIS = new RegExp(
    '^(e-?mail|emails?|phones?|telefones?|celular|mobile|cpf|cnpj|documents?|doc_?(number|type)|identification|' +
      'address(es)?|endereco|street(_name|_number)?|zip_?code|cep|token|access_?token|refresh_?token|id_?token|' +
      'secret|password|senha|cookies?|authorization|first_?name|last_?name|full_?name|nome_?completo|birth_?date|' +
      'bank_?account|pix_?key|chave_?pix)$',
    'i',
  );

  /** Parâmetros de URL que nunca são gravados. */
  const PARAMS_SENSIVEIS = /^(access_?token|token|code|state|session|sid|auth|key|email)$/i;

  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;

  const LIMITE_CORPO = 1000000; // caracteres por resposta
  const LIMITE_CAPTURAS = 400;

  function mascararTexto(texto) {
    return String(texto).replace(EMAIL, '[email]').replace(CPF, '[cpf]');
  }

  /** Copia o valor trocando campos sensíveis por "***" e e-mails/CPFs soltos por marcadores. */
  function mascarar(valor, profundidade) {
    profundidade = profundidade || 0;
    if (profundidade > 40) return '[profundo demais]';
    if (typeof valor === 'string') return mascararTexto(valor);
    if (valor === null || typeof valor !== 'object') return valor;
    if (Array.isArray(valor)) return valor.map(function (v) { return mascarar(v, profundidade + 1); });
    const saida = {};
    for (const k of Object.keys(valor)) {
      saida[k] = CHAVES_SENSIVEIS.test(k) ? '***' : mascarar(valor[k], profundidade + 1);
    }
    return saida;
  }

  function urlAbsoluta(url, base) {
    try { return new URL(url, base); } catch (e) { return null; }
  }

  /** Plataforma de uma URL, ou null. */
  function plataformaDe(url, base) {
    const u = urlAbsoluta(url, base);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
    return PLATAFORMAS.find(function (p) { return p.hosts.test(u.hostname); }) || null;
  }

  function permitido(url, base, tipo) {
    const u = urlAbsoluta(url, base);
    const p = plataformaDe(url, base);
    if (!u || !p) return null;
    const caminho = u.hostname + u.pathname;
    if (IGNORAR_SEMPRE.test(caminho) || (p.ignorar && p.ignorar.test(caminho))) return null;
    const noPainel = p.afiliado.test(u.hostname);
    if (!noPainel || p.id === 'mercado_livre') {
      if (AREAS_PESSOAIS.test(u.pathname)) return null;
    }
    if (!noPainel) {
      const filtro = tipo === 'pagina' ? p.paginasNaLoja : p.chamadasNaLoja;
      if (filtro && !filtro.test(u.pathname + u.search)) return null;
    }
    return p;
  }

  /** A página aberta pode ser gravada (visita, salvar página, chamadas feitas por ela)? */
  function deveGravarPagina(url) {
    return permitido(url, undefined, 'pagina') !== null;
  }

  /** A chamada pode ser gravada? (`pagina` é a página que fez a chamada; se informada, também é conferida.) */
  function deveGravar(url, base, pagina) {
    if (pagina !== undefined && !deveGravarPagina(pagina)) return false;
    return permitido(url, base || pagina, 'chamada') !== null;
  }

  /** Id da plataforma ("mercado_livre", "shopee", "amazon") ou null. */
  function idPlataforma(url, base) {
    const p = plataformaDe(url, base);
    return p ? p.id : null;
  }

  /** URL sem parâmetros sensíveis e sem fragmento. */
  function limparUrl(url, base) {
    const u = urlAbsoluta(url, base);
    if (!u) return String(url);
    for (const p of Array.from(u.searchParams.keys())) {
      if (PARAMS_SENSIVEIS.test(p)) u.searchParams.set(p, '***');
    }
    u.hash = '';
    return mascararTexto(u.toString());
  }

  /**
   * Interpreta o corpo de uma resposta ou requisição. Devolve null se não for algo útil
   * (vazio ou HTML). JSON vira objeto mascarado; outro texto é mascarado e cortado.
   */
  function interpretarCorpo(texto) {
    if (texto === null || texto === undefined) return null;
    const t = String(texto);
    if (!t.trim()) return null;
    if (/^\s*</.test(t)) return null; // HTML/XML: não interessa aqui
    if (t.length > LIMITE_CORPO) return { truncado: true, tamanho: t.length, inicio: mascararTexto(t.slice(0, 2000)) };
    const inicio = t.trimStart()[0];
    if (inicio === '{' || inicio === '[') {
      try { return { json: mascarar(JSON.parse(t)) }; } catch (e) { /* segue como texto */ }
    }
    return { texto: mascararTexto(t.slice(0, 20000)) };
  }

  /** Monta o arquivo exportado. */
  function montarArquivo(capturas, info) {
    const plataformas = {};
    capturas.forEach(function (c) { if (c.plataforma) plataformas[c.plataforma] = (plataformas[c.plataforma] || 0) + 1; });
    return {
      formato: 'cofilius-gravacao',
      versao: 2,
      plataformas: plataformas,
      extensao: info && info.versao,
      gerado_em: new Date().toISOString(),
      total: capturas.length,
      capturas: capturas,
    };
  }

  // -------------------------------------------------------------------------
  // Sincronia com o painel: só estes dados vão para o painel do Cofilius (no seu computador).
  // O painel confere de novo (services/extensao/conversores.ts, tipoPelaUrl).
  // -------------------------------------------------------------------------
  const SINCRONIA = [
    { tipo: 'shopee.conversoes', host: 'affiliate.shopee.com.br', caminho: '/api/v3/report/list', paginas: true },
    { tipo: 'shopee.cliques', host: 'affiliate.shopee.com.br', caminho: '/api/v1/click_report/list', paginas: true },
    { tipo: 'amazon.link', host: 'www.amazon.com.br', caminho: '/associates/sitestripe/getShortUrl', paginas: false },
    // Lista de ofertas que ela navega no painel (sem leitura automática de páginas).
    { tipo: 'shopee.ofertas', host: 'affiliate.shopee.com.br', caminho: '/api/v3/offer/product/list', paginas: 'offset' },
    // Link personalizado gerado por ela: GraphQL, só a operação que cria o link com os sub_ids.
    { tipo: 'shopee.link', host: 'affiliate.shopee.com.br', caminho: '/api/v3/gql', paginas: false, operacao: 'batchGetCustomLink' },
  ];

  /** Páginas que a busca automática abre (escondidas) para os relatórios carregarem. */
  const PAGINAS_BUSCA = [
    'https://affiliate.shopee.com.br/report/conversion_report',
    'https://affiliate.shopee.com.br/report/click_report',
    'https://affiliate.shopee.com.br/offer/product_offer',
  ];
  const MAX_PAGINAS = 25;
  /** Lista de ofertas: até 5 páginas (100 ofertas) por lista aberta. */
  const MAX_PAGINAS_OFERTAS = 5;

  // -------------------------------------------------------------------------
  // Link personalizado: o mesmo pedido que a tela "Link personalizado" da Shopee faz
  // (gravação de 13/11/2026). A extensão gera os links que faltam com os sub_ids do Cofilius.
  // -------------------------------------------------------------------------
  const URL_GQL_SHOPEE = 'https://affiliate.shopee.com.br/api/v3/gql';
  const PAGINA_LINK_SHOPEE = 'https://affiliate.shopee.com.br/offer/custom_link';
  const QUERY_LINK_PERSONALIZADO = '\n    query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){\n      batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){\n        shortLink\n        longLink\n        failCode\n      }\n    }\n    ';
  const MAX_LINKS_POR_PEDIDO = 5;

  /** Item de link aceito: produto da Shopee (https) e 5 sub_ids só com letras minúsculas e números. */
  function itemDeLinkValido(item) {
    if (!item || typeof item.originalLink !== 'string' || !Array.isArray(item.subIds) || item.subIds.length !== 5) return false;
    const u = urlAbsoluta(item.originalLink);
    if (!u || u.protocol !== 'https:' || !/(^|\.)shopee\.com\.br$/.test(u.hostname)) return false;
    return item.subIds.every(function (v) { return typeof v === 'string' && /^[a-z0-9]{0,32}$/.test(v); });
  }

  /** Corpo do pedido de links personalizados (até 5 por vez). */
  function pedidoDeLinks(itens) {
    return {
      operationName: 'batchGetCustomLink',
      query: QUERY_LINK_PERSONALIZADO,
      variables: {
        linkParams: itens.map(function (i) {
          return {
            originalLink: i.originalLink,
            advancedLinkParams: { subId1: i.subIds[0], subId2: i.subIds[1], subId3: i.subIds[2], subId4: i.subIds[3], subId5: i.subIds[4] },
          };
        }),
        sourceCaller: 'CUSTOM_LINK_CALLER',
      },
    };
  }

  function regraSincronia(url, base, pedido) {
    const u = urlAbsoluta(url, base);
    if (!u || u.protocol !== 'https:') return null;
    return SINCRONIA.find(function (r) {
      if (r.host !== u.hostname || r.caminho !== u.pathname) return false;
      if (!r.operacao) return true;
      const j = pedido && pedido.json;
      return !!j && j.operationName === r.operacao;
    }) || null;
  }

  /** Tipo do dado para o painel, ou null se o painel não usa. `pedido` (corpo interpretado) só para o GraphQL. */
  function tipoSincronia(url, base, pedido) {
    const r = regraSincronia(url, base, pedido);
    return r ? r.tipo : null;
  }

  /**
   * Relatórios paginados da Shopee: endereço da próxima página, ou null se acabou.
   * Usa page_num / page_size / total_count, como a própria página faz.
   */
  function proximaPagina(url, base, json) {
    const r = regraSincronia(url, base);
    if (!r || !r.paginas || !json || json.code !== 0 || !json.data) return null;
    if (r.paginas === 'offset') {
      // Lista de ofertas: page_offset / page_limit / total_count.
      const desloc = Number(json.data.page_offset) || 0;
      const limite = Number(json.data.page_limit) || 0;
      const totalOf = Number(json.data.total_count) || 0;
      const uo = urlAbsoluta(url, base);
      if (!limite || !uo.searchParams.has('page_offset') || desloc + limite >= totalOf || desloc / limite + 1 >= MAX_PAGINAS_OFERTAS) return null;
      uo.searchParams.set('page_offset', String(desloc + limite));
      return uo.toString();
    }
    const pagina = Number(json.data.page_num) || 1;
    const tamanho = Number(json.data.page_size) || 0;
    const total = Number(json.data.total_count) || 0;
    if (!tamanho || pagina * tamanho >= total || pagina >= MAX_PAGINAS) return null;
    const u = urlAbsoluta(url, base);
    if (!u.searchParams.has('page_num')) return null;
    u.searchParams.set('page_num', String(pagina + 1));
    return u.toString();
  }

  /**
   * Dados de uma página de produto da Amazon (www.amazon.com.br/.../dp/ASIN), lidos do que a página já
   * mostra. Seletores conferidos na gravação de 13/11/2026 (produto B0HDVZQPT6). Devolve null fora de
   * página de produto ou sem título/preço. Nada pessoal: só título, preço, nota e categoria.
   */
  function extrairProdutoAmazon(doc, url) {
    const u = urlAbsoluta(url);
    if (!u || !/(^|\.)amazon\.com\.br$/i.test(u.hostname)) return null;
    const porUrl = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    const el = function (sel) { try { return doc.querySelector(sel); } catch (e) { return null; } };
    const texto = function (sel) { const e = el(sel); return e ? String(e.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
    const marcado = el('[data-csa-c-asin]');
    const asin = ((porUrl && porUrl[1]) || (marcado && marcado.getAttribute('data-csa-c-asin')) || '').toUpperCase();
    const titulo = texto('#productTitle');
    const preco = texto('#corePrice_feature_div .priceToPay .a-offscreen') || texto('#corePrice_desktop .a-price .a-offscreen') ||
      texto('#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen');
    if (!/^[A-Z0-9]{10}$/.test(asin) || !titulo || !preco) return null;
    const notaEl = el('#acrPopover');
    const avalEl = el('#acrCustomerReviewText');
    const categoria = [];
    try {
      doc.querySelectorAll('#wayfinding-breadcrumbs_feature_div li a').forEach(function (a) {
        const t = String(a.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) categoria.push(t);
      });
    } catch (e) { /* sem categoria */ }
    return {
      asin: asin,
      titulo: titulo.slice(0, 300),
      preco: preco,
      precoAntes: texto('#corePrice_feature_div .basisPrice .a-offscreen') || texto('#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen') || null,
      desconto: texto('#corePrice_feature_div .savingsPercentage') || texto('#corePriceDisplay_desktop_feature_div .savingsPercentage') || null,
      nota: (notaEl && notaEl.getAttribute('title')) || null,
      avaliacoes: (avalEl && (avalEl.getAttribute('aria-label') || avalEl.textContent)) || null,
      categoria: categoria.slice(0, 6),
    };
  }

  raiz.CofiliusNucleo = {
    extrairProdutoAmazon: extrairProdutoAmazon,
    URL_GQL_SHOPEE: URL_GQL_SHOPEE,
    PAGINA_LINK_SHOPEE: PAGINA_LINK_SHOPEE,
    MAX_LINKS_POR_PEDIDO: MAX_LINKS_POR_PEDIDO,
    itemDeLinkValido: itemDeLinkValido,
    pedidoDeLinks: pedidoDeLinks,
    tipoSincronia: tipoSincronia,
    proximaPagina: proximaPagina,
    PAGINAS_BUSCA: PAGINAS_BUSCA,
    LIMITE_CAPTURAS: LIMITE_CAPTURAS,
    mascarar: mascarar,
    mascararTexto: mascararTexto,
    PLATAFORMAS: PLATAFORMAS.map(function (p) { return { id: p.id, nome: p.nome }; }),
    deveGravar: deveGravar,
    deveGravarPagina: deveGravarPagina,
    idPlataforma: idPlataforma,
    limparUrl: limparUrl,
    interpretarCorpo: interpretarCorpo,
    montarArquivo: montarArquivo,
  };
})(globalThis);
