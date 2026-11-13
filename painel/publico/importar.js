/* Cofilius · aba Importar: planilhas de ofertas e de vendas (o arquivo é lido no navegador). */
'use strict';

(() => {
const { $, el, api, estado, lerArquivo, avisar } = window.Cofilius;

function listaErros(erros) {
  if (!erros || !erros.length) return null;
  return el('div', { classe: 'aviso' },
    el('strong', { texto: `${erros.length} linha(s) não importada(s) — corrija na planilha e importe de novo:` }),
    el('ul', {}, ...erros.map((e) => el('li', { texto: `linha ${e.linha}: ${e.motivo}` }))));
}

window.Cofilius.registrar('importar', {
  mostrar() {
    const c = estado.clientes.find((x) => x.codigo === estado.cliente);
    const select = $('form-ofertas').elements.nicho;
    api('/api/gestao/clientes').then((todos) => {
      const atual = todos.find((x) => x.codigo === estado.cliente);
      select.replaceChildren(el('option', { texto: '(usar a coluna da planilha)', attrs: { value: '' } }),
        ...(atual ? atual.nichos : []).map((n) => el('option', { texto: n.nome || n.slug, attrs: { value: n.slug } })));
    }).catch((e) => avisar(e.message, true));
    for (const id of ['resultado-ofertas', 'resultado-vendas', 'resultado-gravacao']) $(id).replaceChildren();
    return c;
  },
  iniciar() {
    $('form-ofertas').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.currentTarget;
      const botao = form.querySelector('button');
      botao.disabled = true;
      try {
        const csv = await lerArquivo(form.elements.arquivo);
        const r = await api('/api/importar/ofertas', { csv, nicho: form.elements.nicho.value || undefined });
        $('resultado-ofertas').replaceChildren(
          el('p', { texto: `${r.gravadas} ofertas gravadas para ${r.dataColeta.split('-').reverse().join('/')} (${r.novas} novas, ${r.atualizadas} atualizadas).` }),
          listaErros(r.erros));
        avisar(`${r.gravadas} ofertas importadas. Vá para a aba Dia e rode o Curador.`);
        form.reset();
      } catch (e) {
        avisar(e.message, true);
      } finally {
        botao.disabled = false;
      }
    });
    $('form-vendas').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.currentTarget;
      const botao = form.querySelector('button');
      botao.disabled = true;
      try {
        const csv = await lerArquivo(form.elements.arquivo);
        const r = await api('/api/importar/vendas', { csv });
        const v = r.resultado;
        $('resultado-vendas').replaceChildren(
          v ? el('p', { texto: `${v.total} vendas (${v.novas} novas, ${v.atualizadas} atualizadas) · ${v.atribuidas} ligadas a postagens, ${v.naoAtribuidas} não atribuídas.` }) : null,
          v && v.mudancasSituacao.length ? el('ul', {}, ...v.mudancasSituacao.map((m) => el('li', { texto: `pedido ${m.pedidoId}: ${m.de} → ${m.para}` }))) : null,
          listaErros(r.erros));
        avisar(v ? `${v.total} vendas importadas` : 'Nenhuma venda válida na planilha', !v);
        form.reset();
      } catch (e) {
        avisar(e.message, true);
      } finally {
        botao.disabled = false;
      }
    });
    $('form-gravacao').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.currentTarget;
      const botao = form.querySelector('button');
      botao.disabled = true;
      try {
        let arquivo;
        try { arquivo = JSON.parse(await lerArquivo(form.elements.arquivo)); } catch { throw new Error('O arquivo não é uma gravação do Cofilius.'); }
        if (!arquivo || arquivo.formato !== 'cofilius-gravacao' || !Array.isArray(arquivo.capturas)) throw new Error('O arquivo não é uma gravação do Cofilius.');
        // Manda só o que o painel usa (a gravação inteira pode ter vários MB). O painel confere de novo.
        const usadas = arquivo.capturas.filter((c) => c && c.tipo === 'resposta' && USADAS.test(String(c.url || '')));
        if (!usadas.length) throw new Error('A gravação não tem relatório de conversões ou de cliques da Shopee, nem link da Amazon.');
        const r = await api('/api/importar/gravacao', { json: JSON.stringify({ formato: arquivo.formato, capturas: usadas }) });
        $('resultado-gravacao').replaceChildren(
          el('ul', {}, ...r.resultados.map((x) => el('li', { classe: x.ok ? '' : 'erro-texto', texto: `${x.ok ? '✔' : '✘'} ${NOMES[x.tipo] || x.tipo}: ${x.detalhe}` }))));
        avisar(`${r.usados} relatório(s) importado(s) da gravação`, r.falhas.length > 0);
        form.reset();
      } catch (e) {
        avisar(e.message, true);
      } finally {
        botao.disabled = false;
      }
    });
  },
});

const USADAS = /^https:\/\/(affiliate\.shopee\.com\.br\/api\/(v3\/report|v1\/click_report)\/list|www\.amazon\.com\.br\/associates\/sitestripe\/getShortUrl)\b/;
const NOMES = { 'shopee.conversoes': 'Vendas da Shopee', 'shopee.cliques': 'Cliques da Shopee', 'amazon.link': 'Link da Amazon' };
})();
