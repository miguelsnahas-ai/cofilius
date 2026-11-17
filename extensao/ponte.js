/**
 * Ponte entre a página e a extensão (mundo isolado da extensão).
 * Só repassa ao service worker as capturas que o interceptor já mascarou; quem decide se grava
 * é o service worker (só com a gravação ligada).
 * Obs.: o nucleo.js roda só no mundo da página (o Chrome não injeta o mesmo arquivo nos dois mundos).
 */
(function () {
  'use strict';
  // Avisa o interceptor (mundo da página, sem acesso ao chrome.storage) se pode ler as páginas seguintes
  // dos relatórios. Desligado por padrão: os termos da Shopee proíbem extração automatizada (4.3(d)).
  function avisarConfig() {
    chrome.storage.local.get({ paginar: false }).then(function (c) {
      window.postMessage({ cofilius: 'config', paginar: c.paginar === true }, window.location.origin);
    }).catch(function () {});
  }
  avisarConfig();
  chrome.storage.onChanged.addListener(function (mudou) { if (mudou.paginar) avisarConfig(); });
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.cofilius !== 'captura') return;
    const c = ev.data.captura;
    if (!c || (c.tipo !== 'resposta' && c.tipo !== 'visita' && c.tipo !== 'oferta')) return;
    chrome.runtime.sendMessage({ cofilius: 'captura', captura: c }).catch(function () {});
  });

  // Pedido da extensão (service worker): gerar links personalizados nesta aba da Shopee Afiliados.
  // A ponte repassa para o interceptor (que roda na página e usa a sessão dela) e devolve o resultado.
  let sequencia = 0;
  chrome.runtime.onMessage.addListener(function (msg, remetente, responder) {
    if (remetente.id !== chrome.runtime.id || !msg || msg.cofilius !== 'gerarLinks') return;
    if (location.hostname !== 'affiliate.shopee.com.br') { responder({ ok: false, erro: 'Aba fora da Shopee Afiliados.' }); return; }
    const id = 'l' + Date.now() + '-' + (sequencia++);
    const limite = setTimeout(function () { window.removeEventListener('message', ouvir); responder({ ok: false, erro: 'A Shopee demorou demais para responder.' }); }, 60000);
    function ouvir(ev) {
      if (ev.source !== window || !ev.data || ev.data.cofilius !== 'linksGerados' || ev.data.id !== id) return;
      clearTimeout(limite);
      window.removeEventListener('message', ouvir);
      responder(ev.data.resultado);
    }
    window.addEventListener('message', ouvir);
    window.postMessage({ cofilius: 'gerarLinks', id: id, itens: msg.itens }, window.location.origin);
    return true;
  });
})();
