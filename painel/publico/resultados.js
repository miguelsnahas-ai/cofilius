/* Cofilius · aba Resultados: comissão e cliques por dia, totais, produtos e vendas recentes. */
'use strict';

(() => {
const { $, el, api, avisar, dataLocal, reais, estado } = window.Cofilius;
const SVG = 'http://www.w3.org/2000/svg';
const PLATAFORMAS = { shopee: 'Shopee', mercado_livre: 'Mercado Livre', amazon: 'Amazon' };
const SITUACOES = { validada: ['✓', 'Validada', 'ok'], pendente: ['◷', 'Pendente', 'espera'], cancelada: ['✕', 'Cancelada', 'caiu'] };
const filtro = { dias: 30, plataforma: '' };

const dataBr = (d) => d.split('-').reverse().join('/');
const diaCurto = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const inteiro = (n) => Number(n).toLocaleString('pt-BR');

function s(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Topo "redondo" do eixo e os 4 intervalos (0, 1/4, ... topo). */
function escala(maximo) {
  if (!(maximo > 0)) return { topo: 4, passos: [0, 1, 2, 3, 4] };
  const bruto = maximo / 4;
  const pot = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= bruto);
  return { topo: passo * 4, passos: [0, 1, 2, 3, 4].map((i) => i * passo) };
}

/**
 * Colunas por dia, uma série. valor(d) → número; rotuloValor(n) → texto; detalhe(d) → linhas do tooltip.
 * Cada dia tem uma área de passar o mouse maior que a coluna. Abaixo, a mesma informação em tabela.
 */
function colunas(dias, { valor, rotuloValor, rotuloEixo, detalhe, titulo, largura: L }) {
  const A = L < 500 ? 180 : 210, esq = 52, dir = 8, topo = 12, base = 28;
  const largura = L - esq - dir, altura = A - topo - base;
  const { topo: max, passos } = escala(Math.max(...dias.map(valor)));
  const banda = largura / dias.length;
  const barra = Math.max(2, Math.min(24, banda - 2));
  const y = (v) => topo + altura - (v / max) * altura;

  // Desenhado na largura real do cartão: o texto do eixo fica sempre em 12px, também no celular.
  const svg = s('svg', { viewBox: `0 0 ${L} ${A}`, width: L, height: A, class: 'grafico', role: 'img', 'aria-label': titulo });
  for (const p of passos) {
    svg.append(s('line', { x1: esq, x2: L - dir, y1: y(p), y2: y(p), class: p === 0 ? 'eixo' : 'grade' }));
    const t = s('text', { x: esq - 8, y: y(p) + 4, 'text-anchor': 'end', class: 'marca-eixo' });
    t.textContent = rotuloEixo(p);
    svg.append(t);
  }
  // Rótulos do eixo x: primeiro, meio e último dia (nunca um em cada).
  const marcas = [...new Set(L < 500 ? [0, dias.length - 1] : [0, Math.floor((dias.length - 1) / 2), dias.length - 1])];
  for (const i of marcas) {
    const t = s('text', { x: esq + banda * i + banda / 2, y: A - 8, 'text-anchor': 'middle', class: 'marca-eixo' });
    t.textContent = diaCurto(dias[i].dia);
    svg.append(t);
  }

  const caixa = el('div', { classe: 'grafico-caixa' });
  const dica = el('div', { classe: 'dica', attrs: { role: 'status' } });
  dica.hidden = true;
  dias.forEach((d, i) => {
    const v = valor(d);
    const x = esq + banda * i + (banda - barra) / 2;
    if (v > 0) {
      const h = Math.max(1, y(0) - y(v));
      const r = Math.min(4, barra / 2, h);
      const yt = y(0) - h;
      // Topo arredondado (4px), base reta no eixo.
      svg.append(s('path', {
        class: 'coluna',
        d: `M${x},${y(0)} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barra - r} Q${x + barra},${yt} ${x + barra},${yt + r} V${y(0)} Z`,
      }));
    }
    const alvo = s('rect', { x: esq + banda * i, y: topo, width: banda, height: altura, class: 'alvo' });
    alvo.addEventListener('mouseenter', () => {
      dica.replaceChildren(el('strong', { texto: dataBr(d.dia) }), el('span', { texto: rotuloValor(v) }), ...detalhe(d).map((t) => el('span', { classe: 'suave', texto: t })));
      dica.hidden = false;
      // Ao lado da coluna (à esquerda na metade direita), para não cobrir o dia em foco.
      const centro = esq + banda * i + banda / 2;
      const aDireita = centro < L / 2;
      dica.style.left = `${aDireita ? centro + banda / 2 + 8 : centro - banda / 2 - 8}px`;
      dica.classList.toggle('a-esquerda', !aDireita);
      alvo.classList.add('ativo');
    });
    alvo.addEventListener('mouseleave', () => { dica.hidden = true; alvo.classList.remove('ativo'); });
    svg.append(alvo);
  });
  caixa.append(svg, dica);

  const tabela = el('details', { classe: 'ver-tabela' },
    el('summary', { texto: 'Ver como tabela' }),
    el('div', { classe: 'rolagem' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', { texto: 'Dia' }), el('th', { classe: 'num', texto: titulo }))),
      el('tbody', {}, ...dias.filter((d) => valor(d) > 0).map((d) => el('tr', {}, el('td', { texto: dataBr(d.dia) }), el('td', { classe: 'num', texto: rotuloValor(valor(d)) })))))));
  return el('div', {}, caixa, tabela);
}

function tile(rotulo, valor, nota, destaque) {
  return el('div', { classe: destaque ? 'tile destaque' : 'tile' },
    el('p', { classe: 'rotulo', texto: rotulo }), el('p', { classe: 'valor num', texto: valor }), nota ? el('p', { classe: 'nota', texto: nota }) : null);
}

function situacao(sit) {
  const [icone, rotulo, classe] = SITUACOES[sit] || ['·', sit, ''];
  return el('span', { classe: `situacao ${classe}` }, el('span', { classe: 'icone', texto: icone, attrs: { 'aria-hidden': 'true' } }), rotulo);
}

function frescor(a) {
  const ultimo = a.extensao || a.vendas;
  if (!ultimo) return 'Ainda não há vendas. Pareie a extensão em Configuração ou importe a planilha.';
  const horas = (Date.now() - new Date(ultimo).getTime()) / 36e5;
  const quando = new Date(ultimo).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const origem = a.extensao ? 'pela extensão' : 'por planilha';
  return horas > 24
    ? `Atenção: os dados chegaram ${origem} pela última vez em ${quando}. Abra o Chrome logado na Shopee Afiliados para atualizar.`
    : `Dados atualizados ${origem} em ${quando}.`;
}

async function carregar() {
  const alvo = $('resultados-conteudo');
  if (!estado.cliente) { alvo.replaceChildren(); return; }
  const fim = dataLocal();
  const ini = new Date();
  ini.setDate(ini.getDate() - (filtro.dias - 1));
  const q = new URLSearchParams({ cliente: estado.cliente, de: dataLocal(ini), ate: fim });
  if (filtro.plataforma) q.set('plataforma', filtro.plataforma);
  // Largura útil do cartão (página menos o recuo do cartão).
  const largura = Math.max(300, Math.min(1000, alvo.clientWidth - 50));
  let r;
  try { r = await api(`/api/resultados?${q}`); } catch (e) { avisar(e.message, true); return; }
  const t = r.totais;
  const conversao = t.cliques ? `${((t.pedidos / t.cliques) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% dos cliques` : null;
  $('resultados-frescor').textContent = frescor(r.atualizado);
  $('resultados-frescor').className = /Atenção/.test($('resultados-frescor').textContent) ? 'aviso' : 'ajuda';
  alvo.replaceChildren(
    el('div', { classe: 'tiles' },
      tile('Comissão validada', reais(t.comissaoValidada), 'já confirmada pela plataforma', true),
      tile('Comissão pendente', reais(t.comissaoPendente), 'ainda pode cair'),
      tile('Pedidos', inteiro(t.pedidos), conversao),
      tile('Cliques', inteiro(t.cliques), null),
      tile('Cancelados', inteiro(t.pedidosCancelados), Number(t.comissaoCancelada) ? `${reais(t.comissaoCancelada)} que não entram` : null)),
    el('section', { classe: 'cartao' },
      el('h2', { texto: 'Comissão por dia' }),
      el('p', { classe: 'ajuda', texto: 'Pendente + validada, sem as canceladas. Passe o mouse num dia para ver o detalhe.' }),
      colunas(r.dias, {
        titulo: 'Comissão', largura,
        valor: (d) => Number(d.pendente) + Number(d.validada),
        rotuloValor: (v) => reais(v),
        rotuloEixo: (v) => (v >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR')} mil` : `R$ ${v.toLocaleString('pt-BR')}`),
        detalhe: (d) => [`validada ${reais(d.validada)}`, `pendente ${reais(d.pendente)}`, `${d.pedidos} pedido(s)`],
      })),
    el('section', { classe: 'cartao' },
      el('h2', { texto: 'Cliques por dia' }),
      el('p', { classe: 'ajuda', texto: 'Cliques nos links, como a plataforma conta.' }),
      colunas(r.dias, {
        titulo: 'Cliques', largura,
        valor: (d) => d.cliques,
        rotuloValor: (v) => `${inteiro(v)} clique(s)`,
        rotuloEixo: (v) => inteiro(v),
        detalhe: (d) => (d.pedidos ? [`${d.pedidos} pedido(s) no dia`] : []),
      })),
    el('section', { classe: 'cartao' },
      el('h2', { texto: 'Produtos que mais renderam' }),
      r.produtos.length
        ? el('div', { classe: 'rolagem' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', { texto: 'Produto' }), el('th', { texto: 'Plataforma' }), el('th', { classe: 'num', texto: 'Pedidos' }), el('th', { classe: 'num', texto: 'Comissão' }))),
          el('tbody', {}, ...r.produtos.map((p) => el('tr', {},
            el('td', { texto: p.nome || `Produto ${p.produtoId}` }), el('td', { texto: PLATAFORMAS[p.plataforma] || p.plataforma }),
            el('td', { classe: 'num', texto: String(p.pedidos) }), el('td', { classe: 'num', texto: reais(p.comissao) }))))))
        : el('p', { classe: 'ajuda', texto: 'Nenhuma venda no período.' })),
    el('section', { classe: 'cartao' },
      el('h2', { texto: 'Vendas recentes' }),
      t.naoAtribuidas ? el('p', { classe: 'ajuda', texto: `${t.naoAtribuidas} venda(s) sem postagem identificada: vieram de links sem os Sub_ids do Cofilius.` }) : null,
      r.recentes.length
        ? el('div', { classe: 'rolagem' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', { texto: 'Quando' }), el('th', { texto: 'Produto' }), el('th', { texto: 'Situação' }), el('th', { classe: 'num', texto: 'Valor' }), el('th', { classe: 'num', texto: 'Comissão' }))),
          el('tbody', {}, ...r.recentes.map((v) => el('tr', {},
            el('td', { classe: 'num', texto: v.data ? `${diaCurto(v.data.slice(0, 10))} ${v.data.slice(11)}` : '—' }),
            el('td', {}, el('span', { texto: v.nome || v.pedidoId }), el('span', { classe: 'suave', texto: ` · ${PLATAFORMAS[v.plataforma] || v.plataforma}${v.atribuida ? ' · da lista' : ''}` })),
            el('td', {}, situacao(v.situacao)),
            el('td', { classe: 'num', texto: v.valor ? reais(v.valor) : '—' }),
            el('td', { classe: 'num', texto: v.comissao ? reais(v.comissao) : '—' }))))))
        : el('p', { classe: 'ajuda', texto: 'Nenhuma venda no período.' })));
}

window.Cofilius.registrar('resultados', {
  mostrar() { return carregar(); },
  iniciar() {
    for (const b of document.querySelectorAll('[data-periodo]')) {
      b.addEventListener('click', () => {
        filtro.dias = Number(b.dataset.periodo);
        for (const x of document.querySelectorAll('[data-periodo]')) x.setAttribute('aria-pressed', String(x === b));
        carregar();
      });
    }
    $('resultados-plataforma').addEventListener('change', (ev) => { filtro.plataforma = ev.target.value; carregar(); });
    // Girou o celular ou mudou o tamanho da janela: redesenha na nova largura.
    let espera;
    let larguraAntes = window.innerWidth;
    window.addEventListener('resize', () => {
      clearTimeout(espera);
      espera = setTimeout(() => {
        if (estado.aba === 'resultados' && Math.abs(window.innerWidth - larguraAntes) > 40) { larguraAntes = window.innerWidth; carregar(); }
      }, 300);
    });
  },
});
})();
