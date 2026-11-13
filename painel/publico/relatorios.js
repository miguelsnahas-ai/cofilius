/* Cofilius · aba Relatórios: fechamento (com leitura do Analista), uso por cliente e esteira automática. */
'use strict';

(() => {
const { $, el, api, agir, avisar, dataLocal } = window.Cofilius;

/** Segunda a domingo da semana passada (ou da atual, se hoje for domingo). */
function semanaPadrao() {
  const hoje = new Date();
  const dom = new Date(hoje);
  dom.setDate(hoje.getDate() - (hoje.getDay() === 0 ? 0 : hoje.getDay()));
  const seg = new Date(dom);
  seg.setDate(dom.getDate() - 6);
  return [dataLocal(seg), dataLocal(dom)];
}

function tabela(colunas, linhas) {
  return el('table', {},
    el('thead', {}, el('tr', {}, ...colunas.map(([, rotulo]) => el('th', { texto: rotulo })))),
    el('tbody', {}, ...linhas.map((l) => el('tr', {}, ...colunas.map(([chave]) => el('td', { texto: String(l[chave] ?? '') }))))));
}

async function mostrarEsteira() {
  const s = await api('/api/esteira');
  const u = s.ultima;
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
        const copiar = el('button', { classe: 'secundario', texto: 'Copiar texto', attrs: { type: 'button' } });
        copiar.addEventListener('click', () => navigator.clipboard.writeText(r.texto).then(() => avisar('Fechamento copiado. Cole no WhatsApp dela.')));
        $('resultado-fechamento').replaceChildren(
          el('div', { classe: 'balao' , texto: r.texto }), copiar,
          r.propostas.length ? el('p', { classe: 'aviso', texto: `O Analista propôs ${r.propostas.length} nova(s) diretriz(es): aprove ou descarte na aba Dia.` }) : null);
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
          [['codigo', 'Cliente'], ['mensagensEnviadas', 'Enviadas'], ['minutosOperador', 'Seus minutos'], ['diasComAcao', 'Dias'],
            ['minutosPorDia', 'Minutos/dia'], ['chamadasIa', 'Chamadas IA'], ['custoIaUsd', 'Custo IA (US$)']], linhas));
      } catch (e) {
        avisar(e.message, true);
      }
    });

    $('rodar-esteira').addEventListener('click', (ev) => agir(ev.currentTarget, () => api('/api/esteira/rodar', {}),
      (r) => (r.ultima && r.ultima.resumo ? `Esteira: ${r.ultima.resumo.executadas} etapas executadas` : 'Esteira rodada')));
  },
});
})();
