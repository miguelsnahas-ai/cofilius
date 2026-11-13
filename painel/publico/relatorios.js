/* Cofilius · aba Relatórios: fechamento (com leitura do Analista), uso por cliente e esteira automática. */
'use strict';

(() => {
const { $, el, api, agir, avisar, dataLocal, reais } = window.Cofilius;
const dataBr = (d) => d.split('-').reverse().join('/');
const PLATAFORMAS = { shopee: 'Shopee', mercado_livre: 'Mercado Livre', amazon: 'Amazon' };

/** Cartão de fechamento da marca: cabeçalho jabuticaba, número principal no bloco lima, linhas por plataforma. */
function cartaoFechamento(r) {
  const z = r.resumo;
  const porPlataforma = {};
  for (const l of z.porPlataformaESituacao) {
    if (l.situacao === 'cancelada') continue;
    porPlataforma[l.plataforma] = (porPlataforma[l.plataforma] || 0) + Number(l.comissao);
  }
  const linhas = [
    ...Object.entries(porPlataforma).map(([p, v]) => el('div', { classe: 'ln' }, el('span', { texto: PLATAFORMAS[p] || p }), el('span', { classe: 'num up', texto: `+ ${reais(v)}` }))),
    el('div', { classe: 'ln' }, el('span', { texto: 'Pendente (ainda pode cair)' }), el('span', { classe: 'num', texto: reais(z.comissao.pendente) })),
  ];
  if (Number(z.comissao.cancelada) > 0) linhas.push(el('div', { classe: 'ln' }, el('span', { texto: 'Cancelada' }), el('span', { classe: 'num down', texto: `− ${reais(z.comissao.cancelada)}` })));
  linhas.push(el('div', { classe: 'ln' }, el('span', { texto: 'Cliques' }), el('span', { classe: 'num', texto: String(z.cliques) })));
  if (z.naoAtribuidas.pedidos) linhas.push(el('div', { classe: 'ln' }, el('span', { texto: 'Sem postagem identificada' }), el('span', { classe: 'num', texto: `${z.naoAtribuidas.pedidos} · ${reais(z.naoAtribuidas.comissao)}` })));

  const cartao = el('div', { classe: 'fechamento' },
    el('div', { classe: 'cabeca' }, el('p', { classe: 'rotulo', texto: `Fechamento · ${dataBr(z.inicio)} a ${dataBr(z.fim)}` }), el('h3', { texto: 'O que rendeu no período' })),
    el('div', { classe: 'ganho-bloco' }, el('p', { classe: 'rotulo', texto: 'Comissão validada' }), el('div', { classe: 'grande', texto: reais(z.comissao.validada) })),
    el('div', { classe: 'linhas' }, ...linhas));
  const extras = [];
  if (r.leituras && r.leituras.length) {
    extras.push(el('h3', { texto: 'Leitura do Analista' }), el('ol', { classe: 'cartoes' }, ...r.leituras.map((l) => el('li', { classe: 'cartao' },
      el('p', { classe: 'titulo', texto: l.texto }),
      ...l.evidencias.map((e) => el('p', { classe: 'motivo num', texto: `${e.rotulo}: ${e.mensagens} msg · ${e.cliques} cliques · ${e.pedidos} pedidos · ${reais(e.comissao)}` }))))));
  }
  return [cartao, ...extras];
}

/** Segunda a domingo da semana passada (ou da atual, se hoje for domingo). */
function semanaPadrao() {
  const hoje = new Date();
  const dom = new Date(hoje);
  dom.setDate(hoje.getDate() - (hoje.getDay() === 0 ? 0 : hoje.getDay()));
  const seg = new Date(dom);
  seg.setDate(dom.getDate() - 6);
  return [dataLocal(seg), dataLocal(dom)];
}

/** colunas: [chave, rótulo, numérica?] — números em DM Mono, alinhados à direita. */
function tabela(colunas, linhas) {
  return el('table', {},
    el('thead', {}, el('tr', {}, ...colunas.map(([, rotulo, n]) => el('th', { classe: n ? 'num' : '', texto: rotulo })))),
    el('tbody', {}, ...linhas.map((l) => el('tr', {}, ...colunas.map(([chave, , n]) => el('td', { classe: n ? 'num' : '', texto: String(l[chave] ?? '') }))))));
}

async function mostrarEsteira() {
  const s = await api('/api/esteira');
  const u = s.ultima;
  $('estado-esteira').className = 'motivo';
  $('estado-esteira').textContent = `${s.ligada ? 'Ligada' : 'Desligada (ligue na Configuração)'}${s.rodando ? ' · rodando agora' : ''}`
    + (u ? ` · última rodada: ${new Date(u.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      + (u.erro ? ` · erro: ${u.erro}` : u.resumo ? ` · ${u.resumo.executadas} etapas executadas, ${u.resumo.falharam} falharam` : '') : '');
  const NOMES = {
    'lista.medir': 'Medição', 'ofertas.shopee.coletar': 'Coleta Shopee', 'curadoria.curar': 'Curador', 'links.shopee.gerar': 'Links Shopee',
    'redacao.redigir': 'Redator', 'lista.validar': 'Validação', 'analise.semanal': 'Fechamento semanal',
  };
  $('tarefas-esteira').replaceChildren(s.tarefas.length
    ? tabela([['cliente', 'Cliente'], ['etapa', 'Etapa'], ['hora', 'Horário'], ['estado', 'Situação'], ['erro', 'Observação']],
      s.tarefas.map((t) => ({
        cliente: t.cliente, etapa: NOMES[t.tipo] || t.tipo, estado: t.pulada ? 'pulada' : t.estado, erro: t.pulada || t.erro || '',
        hora: new Date(t.agendadaPara).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
      })))
    : el('p', { classe: 'vazio', texto: 'Nenhuma etapa agendada ainda.' }));
}

window.Cofilius.registrar('relatorios', {
  mostrar: mostrarEsteira,
  iniciar() {
    const [seg, dom] = semanaPadrao();
    const ff = $('form-fechamento');
    ff.elements.de.value = seg;
    ff.elements.ate.value = dom;
    ff.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const botao = ff.querySelector('button');
      botao.disabled = true;
      try {
        const r = await api('/api/fechamento', { de: ff.elements.de.value, ate: ff.elements.ate.value, comAnalise: ff.elements.comAnalise.checked });
        const copiar = el('button', { classe: 'secundario', texto: 'Copiar texto para o WhatsApp', attrs: { type: 'button' } });
        copiar.addEventListener('click', () => navigator.clipboard.writeText(r.texto).then(() => avisar('Fechamento copiado. Cole no WhatsApp dela e marque como enviado na aba Dia.')));
        const texto = el('details', { classe: 'texto-fechamento' }, el('summary', { texto: r.situacao === 'enviado' ? 'Ver o texto (já enviado)' : 'Ver o texto que vai para ela (fica pronto também na aba Dia)' }),
          el('div', { classe: 'conversa' }, el('div', { classe: 'balao', texto: r.texto })));
        const partes = [...cartaoFechamento(r), texto, el('div', { classe: 'acoes' }, copiar)];
        if (r.propostas.length) partes.push(el('p', { classe: 'aviso', texto: `O Analista propôs ${r.propostas.length} ${r.propostas.length === 1 ? 'nova diretriz' : 'novas diretrizes'}: aprove ou descarte na aba Dia.` }));
        $('resultado-fechamento').replaceChildren(...partes);
      } catch (e) {
        avisar(e.message, true);
      } finally {
        botao.disabled = false;
      }
    });

    const fu = $('form-uso');
    const hoje = new Date();
    fu.elements.de.value = dataLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    fu.elements.ate.value = dataLocal(hoje);
    fu.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const linhas = await api(`/api/uso?de=${fu.elements.de.value}&ate=${fu.elements.ate.value}`);
        $('resultado-uso').replaceChildren(tabela(
          [['codigo', 'Cliente'], ['mensagensEnviadas', 'Enviadas', true], ['minutosOperador', 'Seus minutos', true], ['diasComAcao', 'Dias', true],
            ['minutosPorDia', 'Minutos/dia', true], ['chamadasIa', 'Chamadas IA', true], ['custoIaUsd', 'Custo IA (US$)', true]], linhas));
      } catch (e) {
        avisar(e.message, true);
      }
    });

    $('rodar-esteira').addEventListener('click', (ev) => agir(ev.currentTarget, () => api('/api/esteira/rodar', {}),
      (r) => (r.ultima && r.ultima.resumo ? `Esteira: ${r.ultima.resumo.executadas} etapas executadas` : 'Esteira rodada')));
  },
});
})();
