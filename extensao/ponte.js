/**
 * Ponte entre a página e a extensão (mundo isolado da extensão).
 * Só repassa ao service worker as capturas que o interceptor já mascarou; quem decide se grava
 * é o service worker (só com a gravação ligada).
 * Obs.: o nucleo.js roda só no mundo da página (o Chrome não injeta o mesmo arquivo nos dois mundos).
 */
(function () {
  'use strict';
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.cofilius !== 'captura') return;
    const c = ev.data.captura;
    if (!c || (c.tipo !== 'resposta' && c.tipo !== 'visita')) return;
    chrome.runtime.sendMessage({ cofilius: 'captura', captura: c }).catch(function () {});
  });
})();
