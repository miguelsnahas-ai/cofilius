/**
 * Cofilius · núcleo do gravador (regras puras, sem acesso ao Chrome).
 *
 * Carregado na página (para mascarar antes de qualquer dado sair dela), no popup e nos testes.
 * Expõe globalThis.CofiliusNucleo.
 */
(function (raiz) {
  'use strict';

  /** Sites onde a extensão grava. Por enquanto, só Mercado Livre. */
  const HOSTS_GRAVADOS = /(^|\.)(mercadolivre\.com\.br|mercadolibre\.com)$/i;

  /** Chamadas que não interessam: métricas, rastreadores e afins. */
  const IGNORAR = /(melidata|\/tracks?(\/|$|\?)|analytics|hotjar|google|doubleclick|newrelic|nr-data|sentry|clarity|\/metrics|\/beacon|\/jms\/.*\/log)/i;

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

  /** Grava só chamadas para os sites do Mercado Livre que não sejam métricas. */
  function deveGravar(url, base) {
    const u = urlAbsoluta(url, base);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
    if (!HOSTS_GRAVADOS.test(u.hostname)) return false;
    return !IGNORAR.test(u.hostname + u.pathname);
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
    return {
      formato: 'cofilius-gravacao',
      versao: 1,
      plataforma: 'mercado_livre',
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
    deveGravar: deveGravar,
    limparUrl: limparUrl,
    interpretarCorpo: interpretarCorpo,
    montarArquivo: montarArquivo,
  };
})(globalThis);
