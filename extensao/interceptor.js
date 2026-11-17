/**
 * Roda DENTRO das páginas do Mercado Livre, da Shopee e da Amazon (mundo "MAIN"), antes dos scripts dela.
 * Observa as chamadas que a própria página faz (fetch e XMLHttpRequest) e, para as que
 * interessam, manda uma cópia mascarada para a ponte da extensão. Não altera nem bloqueia nada:
 * a página recebe a resposta original, intacta.
 *
 * Relatórios paginados da Shopee (conversões e cliques): a página só carrega a primeira página.
 * Com a opção "ler as páginas seguintes" ligada no popup (desligada por padrão, porque os termos da
 * Shopee proíbem extração automatizada), o interceptor pede as seguintes do mesmo jeito que a página
 * pediu (mesmo endereço e cabeçalhos, só muda page_num). Os cabeçalhos nunca saem da página.
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
  // Só segue páginas com a opção ligada no popup (vem da ponte). Padrão: desligado.
  let paginar = false;
  window.addEventListener('message', function (ev) {
    if (ev.source === window && ev.data && ev.data.cofilius === 'config') paginar = ev.data.paginar === true;
  });

  /** Pede a próxima página de um relatório paginado e registra como se a página tivesse pedido. */
  function seguirPaginas(url, cabecalhos, json) {
    if (!paginar) return;
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

  // Página de produto da Amazon: a oferta vai ao painel (o Curador pode escolher). A Amazon não tem página
  // de ofertas para afiliados; a afiliada navega pelo site e cada produto aberto vira candidata do dia.
  function ofertaAmazon() {
    try {
      const dados = N.extrairProdutoAmazon(document, location.href);
      if (!dados) return;
      enviar({ tipo: 'oferta', plataforma: 'amazon', quando: new Date().toISOString(), url: N.limparUrl(location.href), dados: dados });
    } catch (e) { /* nunca quebra a página */ }
  }
  if (N.idPlataforma(location.href) === 'amazon' && N.deveGravarPagina(location.href)) {
    // O preço às vezes chega depois do HTML: espera a página terminar de carregar.
    if (document.readyState === 'complete') setTimeout(ofertaAmazon, 1500);
    else window.addEventListener('load', function () { setTimeout(ofertaAmazon, 1500); });
  }

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

  // Cabeçalhos das chamadas GraphQL que a própria página da Shopee faz (CSRF etc.): reusados para gerar
  // links personalizados com a sessão dela. Ficam só na memória da página; nunca são gravados nem enviados.
  let cabecalhosGql = null;
  // Qualquer chamada da API da Shopee Afiliados serve (todas levam os mesmos cabeçalhos de sessão).
  const ehGqlShopee = function (url) {
    try { const u = new URL(url, location.href); return u.hostname === 'affiliate.shopee.com.br' && u.pathname.startsWith('/api/'); } catch (e) { return false; }
  };

  // fetch
  const fetchOriginal = window.fetch;
  if (typeof fetchOriginal === 'function') {
    window.fetch = function (entrada, opcoes) {
      const promessa = fetchOriginal.apply(this, arguments);
      try {
        const url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || String(entrada);
        const metodo = (opcoes && opcoes.method) || (entrada && entrada.method) || 'GET';
        const corpo = opcoes && typeof opcoes.body === 'string' ? opcoes.body : null;
        if (ehGqlShopee(url)) cabecalhosGql = Object.assign({}, cabecalhosGql, copiarCabecalhos((opcoes && opcoes.headers) || (entrada && entrada.headers)));
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
    if (info && ehGqlShopee(info.url)) cabecalhosGql = Object.assign({}, cabecalhosGql, info.cabecalhos);
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

  // Gerar links personalizados (pedido vindo da ponte da extensão): o mesmo pedido da tela "Link
  // personalizado", em lotes de até 5, com uma pausa entre eles. A resposta passa pelo registrar(),
  // como se a página tivesse pedido, e assim chega ao painel.
  async function gerarLinks(itens) {
    if (location.hostname !== 'affiliate.shopee.com.br') return { ok: false, erro: 'Aba fora da Shopee Afiliados.' };
    const validos = (itens || []).filter(N.itemDeLinkValido);
    // Espera a página fazer a primeira chamada (para reaproveitar os cabeçalhos dela).
    for (let i = 0; i < 20 && !cabecalhosGql; i++) await new Promise(function (r) { setTimeout(r, 300); });
    let gerados = 0;
    const erros = [];
    for (let i = 0; i < validos.length; i += N.MAX_LINKS_POR_PEDIDO) {
      const lote = validos.slice(i, i + N.MAX_LINKS_POR_PEDIDO);
      const corpo = JSON.stringify(N.pedidoDeLinks(lote));
      try {
        const resp = await fetchOriginal.call(window, N.URL_GQL_SHOPEE, {
          method: 'POST', credentials: 'include', body: corpo,
          headers: Object.assign({}, cabecalhosGql || {}, { 'content-type': 'application/json' }),
        });
        const texto = await resp.text();
        registrar('POST', N.URL_GQL_SHOPEE, resp.status, corpo, texto);
        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* sem JSON */ }
        const lista = json && json.data && json.data.batchCustomLink;
        if (resp.status === 200 && Array.isArray(lista)) {
          lista.forEach(function (l) { if (l && l.failCode === 0 && l.shortLink) gerados++; else erros.push('a Shopee recusou um link (código ' + (l && l.failCode) + ')'); });
        } else {
          erros.push(resp.status === 401 || resp.status === 403 ? 'sessão da Shopee expirada: entre de novo na Shopee Afiliados' : 'a Shopee respondeu ' + resp.status);
        }
      } catch (e) {
        erros.push('falha de rede ao falar com a Shopee');
      }
      if (i + N.MAX_LINKS_POR_PEDIDO < validos.length) await new Promise(function (r) { setTimeout(r, 1500 + Math.random() * 1500); });
    }
    return { ok: !erros.length, gerados: gerados, erros: erros };
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.cofilius !== 'gerarLinks') return;
    const id = ev.data.id;
    gerarLinks(ev.data.itens).then(function (resultado) {
      window.postMessage({ cofilius: 'linksGerados', id: id, resultado: resultado }, window.location.origin);
    });
  });
})();
