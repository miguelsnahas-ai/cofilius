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

  raiz.CofiliusNucleo = {
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
