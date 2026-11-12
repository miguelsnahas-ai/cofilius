/**
 * Roda DENTRO das páginas do Mercado Livre, da Shopee e da Amazon (mundo "MAIN"), antes dos scripts dela.
 * Observa as chamadas que a própria página faz (fetch e XMLHttpRequest) e, para as que
 * interessam, manda uma cópia mascarada para a ponte da extensão. Não altera nem bloqueia nada:
 * a página recebe a resposta original, intacta.
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

  function registrar(metodo, url, status, corpoPedido, textoResposta) {
    try {
      if (!N.deveGravar(url, location.href, location.href)) return;
      const resposta = N.interpretarCorpo(textoResposta);
      if (!resposta) return;
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
          promessa.then(function (resp) {
            resp.clone().text().then(function (t) { registrar(metodo, url, resp.status, corpo, t); }, function () {});
          }, function () {});
        }
      } catch (e) { /* nunca quebra a página */ }
      return promessa;
    };
  }

  // XMLHttpRequest
  const abrir = XMLHttpRequest.prototype.open;
  const mandar = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (metodo, url) {
    this.__cofilius = { metodo: metodo, url: String(url) };
    return abrir.apply(this, arguments);
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
          registrar(info.metodo, info.url, xhr.status, typeof corpo === 'string' ? corpo : null, texto);
        } catch (e) { /* nunca quebra a página */ }
      });
    }
    return mandar.apply(this, arguments);
  };
})();
