/**
 * Roda DENTRO das páginas do Mercado Livre, da Shopee e da Amazon (mundo "MAIN"), antes dos scripts dela.
 * Observa as chamadas que a própria página faz (fetch e XMLHttpRequest) e, para as que
 * interessam, manda uma cópia mascarada para a ponte da extensão. Não altera nem bloqueia nada:
 * a página recebe a resposta original, intacta.
 *
 * Relatórios paginados da Shopee (conversões e cliques): a página só carrega a primeira página;
 * o interceptor pede as seguintes do mesmo jeito que a página pediu (mesmo endereço e cabeçalhos,
 * só muda page_num), para o painel receber o relatório inteiro. Os cabeçalhos nunca saem da página.
 */
(function () {
  'use strict';
  const N = globalThis.CofiliusNucleo;
  if (!N || window.__cofiliusInterceptor) return;
  window.__cofiliusInterceptor = true;

  function enviar(captura) {
    try {
      window.postMessage({ cofilius: 'captura', captura: captura }, window.location.origin);
    } catch (e) { /* nunca quebra a página */ }
  }

  const jaPedidas = new Set();

  /** Pede a próxima página de um relatório paginado e registra como se a página tivesse pedido. */
  function seguirPaginas(url, cabecalhos, json) {
    const proxima = N.proximaPagina(url, location.href, json);
    if (!proxima || jaPedidas.has(proxima)) return;
    jaPedidas.add(proxima);
    setTimeout(function () {
      fetchOriginal.call(window, proxima, { credentials: 'include', headers: cabecalhos || {} })
        .then(function (resp) { return resp.text().then(function (t) { registrar('GET', proxima, resp.status, null, t, cabecalhos); }); })
        .catch(function () { /* sem a próxima página: o painel fica com o que veio */ });
    }, 800);
  }

  function registrar(metodo, url, status, corpoPedido, textoResposta, cabecalhos) {
    try {
      if (!N.deveGravar(url, location.href, location.href)) return;
      const resposta = N.interpretarCorpo(textoResposta);
      if (!resposta) return;
      if (status === 200 && resposta.json && String(metodo).toUpperCase() === 'GET') seguirPaginas(url, cabecalhos, resposta.json);
      enviar({
        tipo: 'resposta',
        plataforma: N.idPlataforma(location.href),
        quando: new Date().toISOString(),
        pagina: N.limparUrl(location.href),
        metodo: String(metodo || 'GET').toUpperCase(),
        url: N.limparUrl(url, location.href),
        status: status,
        pedido: typeof corpoPedido === 'string' ? N.interpretarCorpo(corpoPedido) : null,
        resposta: resposta,
      });
    } catch (e) { /* nunca quebra a página */ }
  }

  // Visita: registra a página aberta (endereço e título).
  function registrarVisita() {
    if (!N.deveGravarPagina(location.href)) return;
    enviar({ tipo: 'visita', plataforma: N.idPlataforma(location.href), quando: new Date().toISOString(), pagina: N.limparUrl(location.href), titulo: N.mascararTexto(document.title || '') });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', registrarVisita);
  else registrarVisita();

  function copiarCabecalhos(h) {
    const saida = {};
    try {
      if (!h) return saida;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { saida[k] = v; });
      else if (Array.isArray(h)) h.forEach(function (par) { saida[par[0]] = par[1]; });
      else Object.keys(h).forEach(function (k) { saida[k] = h[k]; });
    } catch (e) { /* sem cabeçalhos */ }
    return saida;
  }

  // fetch
  const fetchOriginal = window.fetch;
  if (typeof fetchOriginal === 'function') {
    window.fetch = function (entrada, opcoes) {
      const promessa = fetchOriginal.apply(this, arguments);
      try {
        const url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || String(entrada);
        const metodo = (opcoes && opcoes.method) || (entrada && entrada.method) || 'GET';
        const corpo = opcoes && typeof opcoes.body === 'string' ? opcoes.body : null;
        if (N.deveGravar(url, location.href, location.href)) {
          const cabecalhos = N.tipoSincronia(url, location.href) ? copiarCabecalhos((opcoes && opcoes.headers) || (entrada && entrada.headers)) : null;
          promessa.then(function (resp) {
            resp.clone().text().then(function (t) { registrar(metodo, url, resp.status, corpo, t, cabecalhos); }, function () {});
          }, function () {});
        }
      } catch (e) { /* nunca quebra a página */ }
      return promessa;
    };
  }

  // XMLHttpRequest
  const abrir = XMLHttpRequest.prototype.open;
  const mandar = XMLHttpRequest.prototype.send;
  const definirCabecalho = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (metodo, url) {
    this.__cofilius = { metodo: metodo, url: String(url), cabecalhos: {} };
    return abrir.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (nome, valor) {
    try { if (this.__cofilius) this.__cofilius.cabecalhos[nome] = valor; } catch (e) { /* nada */ }
    return definirCabecalho.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (corpo) {
    const info = this.__cofilius;
    if (info && N.deveGravar(info.url, location.href, location.href)) {
      const xhr = this;
      xhr.addEventListener('loadend', function () {
        try {
          let texto = null;
          if (xhr.responseType === '' || xhr.responseType === 'text') texto = xhr.responseText;
          else if (xhr.responseType === 'json') texto = JSON.stringify(xhr.response);
          registrar(info.metodo, info.url, xhr.status, typeof corpo === 'string' ? corpo : null, texto,
            N.tipoSincronia(info.url, location.href) ? info.cabecalhos : null);
        } catch (e) { /* nunca quebra a página */ }
      });
    }
    return mandar.apply(this, arguments);
  };
})();
