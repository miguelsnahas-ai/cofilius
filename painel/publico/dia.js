/* Cofilius · aba Dia: escolhidas do Curador, mensagens, pedidos da afiliada e propostas de diretriz. */
'use strict';

(() => {
const { $, el, avisar, api, agir, estado, reais } = window.Cofilius;

const ESTADOS = {
  rascunho: ['Rascunho', 'alerta'],
  validada: ['Validada', 'destaque'],
  aprovada: ['Aprovada', 'ok'],
  enviada: ['Enviada', 'ok'],
  medida: ['Medida', 'ok'],
  descartada: ['Descartada', 'erro'],
};
const REGRAS = { texto: 'Texto', link: 'Link', preco: 'Preço', repeticao: 'Repetição', limite: 'Limite do dia' };

let dados = null;

// ---------------------------------------------------------------------------
// Seção 1: escolhidas do Curador
// ---------------------------------------------------------------------------

function itemSelecionada(s) {
  const situacao = s.mensagemId ? ['com mensagem', 'ok'] : s.linkId ? ['com link', 'destaque'] : ['sem link', 'alerta'];
  const li = el('li', { classe: 'cartao' },
    el('div', { classe: 'cartao-topo' },
      el('span', { classe: 'titulo' }, el('span', { classe: 'posicao', texto: String(s.posicao).padStart(2, '0') }), s.titulo),
      el('span', { classe: `chip ${situacao[1]}`, texto: situacao[0] })),
    el('p', { classe: 'motivo', texto: s.motivo }));

  if (!s.linkId && s.preparoLink) {
    const p = s.preparoLink;
    const subids = el('div', { classe: 'subids' });
    p.subIds.forEach((v, i) => {
      subids.append(el('span', { classe: 'subid' }, `Sub_id${i + 1}: ${v}`,
        el('button', { classe: 'secundario', texto: 'copiar', attrs: { type: 'button', 'aria-label': `Copiar Sub_id${i + 1}` },
          onclick: () => navigator.clipboard.writeText(v).then(() => avisar(`Sub_id${i + 1} copiado`)) })));
    });
    const campo = el('input', { attrs: { type: 'url', placeholder: 'Cole o link gerado no painel (https://s.shopee.com.br/...)', 'aria-label': 'Link de afiliado' } });
    const botao = el('button', { texto: 'Registrar link', attrs: { type: 'button' } });
    botao.addEventListener('click', () => agir(botao,
      () => api(`/api/ofertas/${s.ofertaId}/link`, { link: campo.value, quando: p.quando }), 'Link registrado'));
    li.append(
      el('p', { classe: 'motivo' }, 'Produto: ', el('a', { texto: p.urlProduto, attrs: { href: p.urlProduto, target: '_blank', rel: 'noopener noreferrer' } })),
      subids,
      el('div', { classe: 'linha-form' }, campo, botao));
  }
  return li;
}

// ---------------------------------------------------------------------------
// Seção 2: mensagens
// ---------------------------------------------------------------------------

function formPreco(m) {
  const campo = el('input', { attrs: { inputmode: 'decimal', placeholder: 'Preço atual na página (ex.: 29,90)', 'aria-label': 'Preço atual' } });
  const botao = el('button', { classe: 'secundario', texto: 'Confirmar preço', attrs: { type: 'button' } });
  botao.addEventListener('click', () => agir(botao,
    () => api(`/api/ofertas/${m.ofertaId}/preco`, { preco: campo.value }),
    (r) => `Preço confirmado: ${reais(r.preco)}. Se mudou, a mensagem será barrada.`));
  return el('div', { classe: 'linha-form' }, campo, botao);
}

/** Resultado da postagem: cliques (quando a plataforma mede por postagem), pedidos e comissão. */
function linhaDesempenho(d) {
  const comissao = d.comissaoPendente + d.comissaoValidada;
  const partes = [];
  if (d.medivel) partes.push(`${d.cliques} ${d.cliques === 1 ? 'clique' : 'cliques'}`);
  partes.push(`${d.pedidos} ${d.pedidos === 1 ? 'pedido' : 'pedidos'}`);
  if (comissao > 0) partes.push(`${reais(comissao)}${d.comissaoPendente > 0 ? ` (${d.comissaoValidada > 0 ? `${reais(d.comissaoPendente)} pendente` : 'pendente'})` : ''}`);
  if (d.cancelados) partes.push(`${d.cancelados} cancelado(s)`);
  const vendeu = d.pedidos > 0;
  return el('p', { classe: `desempenho ${vendeu ? 'vendeu' : ''}` },
    el('span', { classe: 'rotulo', texto: 'Resultado' }),
    el('span', { classe: 'num', texto: partes.join(' · ') }),
    !d.medivel ? el('span', { classe: 'motivo', texto: ' (cliques por postagem só na Shopee)' }) : null);
}

/** O mesmo resumo que o Curador recebe: o que funcionou no grupo nas últimas 4 semanas. */
function desenharAprendizado(a) {
  const caixa = $('aprendizado');
  caixa.hidden = !a;
  if (!a) return;
  const plural = (n, um, varios) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${n === 1 ? um : varios}`;
  const grupo = (g) => el('li', {}, el('strong', { texto: g.grupo }),
    el('span', { classe: 'detalhe', texto: `${plural(g.postagens, 'postagem', 'postagens')} · ${plural(g.cliques_por_postagem, 'clique', 'cliques')} por postagem · ${plural(g.pedidos, 'pedido', 'pedidos')} · ${reais(g.comissao)}` }));
  const dataBr = (d) => d.split('-').reverse().slice(0, 2).join('/');
  caixa.replaceChildren(
    el('summary', { texto: `O que o Curador está aprendendo (${a.postagens} postage${a.postagens === 1 ? 'm' : 'ns'}, ${dataBr(a.periodo.de)} a ${dataBr(a.periodo.ate)})` }),
    a.amostra_pequena ? el('p', { classe: 'ajuda', texto: 'Ainda são poucas postagens: o Curador usa isto como pista fraca.' }) : null,
    el('div', { classe: 'aprendizado-grade' },
      el('div', {}, el('h3', { texto: 'Por nicho' }), el('ul', {}, ...a.por_nicho.map(grupo))),
      el('div', {}, el('h3', { texto: 'Por faixa de preço' }), el('ul', {}, ...a.por_faixa_preco.map(grupo))),
      el('div', {}, el('h3', { texto: 'Mais venderam' }), a.melhores.length
        ? el('ul', {}, ...a.melhores.map((p) => el('li', {}, p.titulo, el('span', { classe: 'detalhe', texto: `${plural(p.pedidos, 'pedido', 'pedidos')} · ${reais(p.comissao)}` }))))
        : el('p', { classe: 'ajuda', texto: 'Nenhuma postagem vendeu ainda.' })),
      el('div', {}, el('h3', { texto: 'Não venderam' }), a.sem_resultado.length
        ? el('ul', {}, ...a.sem_resultado.map((p) => el('li', {}, p.titulo, el('span', { classe: 'detalhe', texto: plural(p.cliques, 'clique', 'cliques') }))))
        : el('p', { classe: 'ajuda', texto: 'Todas venderam.' }))),
    el('p', { classe: 'ajuda', texto: 'Calculado pelo sistema a partir das vendas e cliques de cada link. As diretrizes que você aprova valem mais do que isto.' }));
}

const NOMES_PLATAFORMA = { shopee: 'Shopee', mercado_livre: 'Mercado Livre', amazon: 'Amazon' };

/** Vendas que caíram desde a última vez: o que era pendente ou validado e a plataforma cancelou. */
function desenharCancelamentos(lista) {
  const caixa = $('cancelamentos');
  caixa.hidden = !lista.length;
  if (!lista.length) { caixa.replaceChildren(); return; }
  const total = lista.reduce((s, c) => s + Number(c.comissao || 0), 0);
  const dataCurta = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const entendi = el('button', { classe: 'secundario', texto: 'Entendi', attrs: { type: 'button' } });
  entendi.addEventListener('click', () => agir(entendi, () => api('/api/cancelamentos/vistos', { ids: lista.map((c) => c.id) }), 'Avisos de cancelamento arquivados'));
  caixa.replaceChildren(
    el('div', { classe: 'secao-topo' },
      el('h2', {}, el('span', { classe: 'icone-queda', texto: '↓ ', attrs: { 'aria-hidden': 'true' } }),
        `${lista.length === 1 ? '1 venda cancelada' : `${lista.length} vendas canceladas`}${total > 0 ? ` · ${reais(total)} de comissão que não vem mais` : ''}`),
      entendi),
    el('ul', { classe: 'lista-cancelamentos' }, ...lista.map((c) => el('li', {},
      el('strong', { texto: c.produtoNome || (c.postagem && c.postagem.titulo) || `Pedido ${c.pedidoId}` }),
      el('span', { classe: 'detalhe', texto: [
        NOMES_PLATAFORMA[c.plataforma] || c.plataforma,
        c.dataPedido ? `pedido de ${dataCurta(c.dataPedido)}` : null,
        c.comissao ? `${reais(c.comissao)} ${c.de === 'validada' ? 'que já estava confirmada' : 'que estava pendente'}` : null,
        c.postagem ? (c.postagem.enviadaEm ? `da postagem de ${dataCurta(c.postagem.enviadaEm)}` : 'de uma postagem da lista') : 'sem postagem identificada',
        `cancelada em ${dataCurta(c.canceladaEm)}`,
      ].filter(Boolean).join(' · ') })))),
    el('p', { classe: 'ajuda', texto: 'Cancelamento é normal (desistência, devolução). Se um produto cancela muito, vale evitar.' }));
}

/** Fechamento semanal pronto: prévia como ela vai receber, copiar, enviar e marcar como enviado. */
function desenharFechamento(d) {
  const caixa = $('fechamento-semana');
  const f = d.fechamento;
  caixa.hidden = !f;
  if (!f) { caixa.replaceChildren(); return; }
  const dataCurta = (x) => x.split('-').reverse().slice(0, 2).join('/');
  const primeiro = (d.cliente.nome || '').split(' ')[0];
  const acoes = el('div', { classe: 'acoes' });
  const copiar = el('button', { texto: 'Copiar para o WhatsApp', attrs: { type: 'button' } });
  copiar.addEventListener('click', () => navigator.clipboard.writeText(f.texto)
    .then(() => avisar(`Copiado. Cole na conversa com ${primeiro} e depois marque como enviado.`))
    .catch(() => avisar('Não consegui copiar: selecione o texto e use Ctrl+C.', true)));
  acoes.append(copiar);
  if (d.whatsappDisponivel) {
    const zap = el('button', { classe: 'secundario', texto: 'Enviar pelo WhatsApp', attrs: { type: 'button' } });
    zap.addEventListener('click', () => agir(zap, () => api(`/api/fechamentos/${f.id}/whatsapp`, {}), 'Fechamento enviado pelo WhatsApp'));
    acoes.append(zap);
  }
  const enviado = el('button', { classe: 'secundario', texto: 'Marcar como enviado', attrs: { type: 'button' } });
  enviado.addEventListener('click', () => agir(enviado, () => api(`/api/fechamentos/${f.id}/enviado`, {}), 'Fechamento marcado como enviado'));
  acoes.append(enviado);
  caixa.replaceChildren(
    el('div', { classe: 'secao-topo' },
      el('div', {}, el('span', { classe: 'rotulo', texto: `Fechamento · ${dataCurta(f.inicio)} a ${dataCurta(f.fim)}` }),
        el('h2', { texto: `Resumo da semana pronto para ${primeiro}` }))),
    el('p', { classe: 'ajuda', texto: 'Montado pelo sistema com os números das vendas e cliques. Confira e mande.' }),
    el('div', { classe: 'conversa' }, el('div', { classe: 'balao', texto: f.texto })),
    acoes);
}

function cartaoMensagem(m) {
  const [rotulo, cor] = ESTADOS[m.estado] || [m.estado, ''];
  const cartao = el('article', { classe: 'cartao' },
    el('div', { classe: 'cartao-topo' },
      el('span', { classe: 'titulo' }, m.titulo || '(oferta removida)', m.preco ? el('span', { classe: 'num motivo', texto: ` · ${reais(m.preco)}` }) : null),
      el('span', { classe: `chip ${cor}`, texto: rotulo })));
  // Prévia como ela vai receber no WhatsApp.
  if (m.textoFinal) cartao.append(el('div', { classe: 'conversa' }, el('div', { classe: 'balao', texto: m.textoFinal })));

  const falhas = (m.validacao || []).filter((r) => !r.ok);
  if (falhas.length && m.estado === 'rascunho') {
    cartao.append(el('ul', { classe: 'falhas' }, ...falhas.map((f) => el('li', { texto: `${REGRAS[f.regra] || f.regra}: ${f.detalhe}` }))));
  }
  if (m.motivoDescarte) cartao.append(el('p', { classe: 'motivo', texto: `Motivo: ${m.motivoDescarte}` }));
  if (m.enviadaEm) cartao.append(el('p', { classe: 'motivo num', texto: `Enviada em ${new Date(m.enviadaEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` }));
  if (m.desempenho) cartao.append(linhaDesempenho(m.desempenho));

  const acoes = el('div', { classe: 'acoes' });
  const botao = (texto, classe, fn) => {
    const b = el('button', { classe, texto, attrs: { type: 'button' } });
    b.addEventListener('click', () => fn(b));
    acoes.append(b);
  };
  const descartar = () => botao('Descartar', 'perigo', (b) => {
    const motivo = window.prompt('Motivo do descarte:');
    if (motivo && motivo.trim()) agir(b, () => api(`/api/mensagens/${m.id}/descartar`, { motivo }), 'Descartada');
  });

  if (m.estado === 'rascunho') {
    botao('Validar', '', (b) => agir(b, () => api(`/api/mensagens/${m.id}/validar`, {}),
      (r) => (r.ok ? 'Validada' : `Barrada: ${r.falhas.map((f) => REGRAS[f.regra] || f.regra).join(', ')}`)));
    descartar();
  } else if (m.estado === 'validada') {
    botao('Aprovar', '', (b) => agir(b, () => api(`/api/mensagens/${m.id}/aprovar`, {}), 'Aprovada'));
    descartar();
  } else if (m.estado === 'aprovada') {
    if (dados.whatsappDisponivel) {
      botao('Enviar pelo WhatsApp', '', (b) => agir(b, () => api(`/api/mensagens/${m.id}/whatsapp`, {}), 'Enviada pelo WhatsApp'));
    }
    botao('Copiar texto', 'secundario', () => navigator.clipboard.writeText(m.textoFinal).then(() => avisar('Texto copiado. Cole no WhatsApp.')));
    botao('Marcar como enviada', dados.whatsappDisponivel ? 'secundario' : '', (b) => agir(b, () => api(`/api/mensagens/${m.id}/enviada`, {}), 'Registrada como enviada'));
    descartar();
  }
  if (acoes.childElementCount) cartao.append(acoes);
  if (m.estado === 'aprovada' && m.ofertaId) {
    const quando = m.precoConferidoEm
      ? new Date(m.precoConferidoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
      : 'nunca';
    cartao.append(el('div', { classe: 'preco-conferir' },
      el('p', { classe: 'motivo', texto: `Preço conferido: ${quando}. Para enviar, ele precisa ter sido conferido há no máximo 30 minutos: olhe a página do produto e confirme.` }),
      formPreco(m)));
  }
  return cartao;
}

// ---------------------------------------------------------------------------
// Seção 3: pedidos da afiliada
// ---------------------------------------------------------------------------

const INTENCOES = {
  transformar_link: 'Quer um link', rastrear_produto: 'Acompanhar produto', mudar_nicho: 'Mudar nicho',
  pausar: 'Pausar', desconhecida: 'Não reconhecido', quanto_ganhei: 'Ganhos',
};

function cartaoPedido(p) {
  const campo = el('textarea', { attrs: { rows: '2', placeholder: 'O que você respondeu (opcional)', 'aria-label': 'Resposta dada' } });
  const concluir = el('button', { texto: 'Concluir', attrs: { type: 'button' } });
  concluir.addEventListener('click', () => agir(concluir, () => api(`/api/pedidos/${p.id}/concluir`, { resposta: campo.value }), 'Pedido concluído'));
  const cartao = el('article', { classe: 'cartao' },
    el('div', { classe: 'cartao-topo' },
      el('span', { classe: 'titulo', texto: INTENCOES[p.intencao] || p.intencao || 'Pedido' }),
      el('span', { classe: 'chip', texto: new Date(p.recebidoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) })),
    el('div', { classe: 'balao recebido', texto: p.mensagem }));
  if (p.resumo) cartao.append(el('p', { classe: 'motivo', texto: `Resumo: ${p.resumo}` }));
  if (p.respostaEnviada) cartao.append(el('p', { classe: 'motivo', texto: `Já respondido automaticamente: "${p.respostaEnviada}"` }));
  cartao.append(el('div', { classe: 'linha-form' }, campo, concluir));
  return cartao;
}

// ---------------------------------------------------------------------------
// Seção 4: propostas de diretriz
// ---------------------------------------------------------------------------

function cartaoProposta(d) {
  const aprovar = el('button', { texto: 'Aprovar', attrs: { type: 'button' } });
  const descartar = el('button', { classe: 'perigo', texto: 'Descartar', attrs: { type: 'button' } });
  aprovar.addEventListener('click', () => agir(aprovar, () => api(`/api/diretrizes/${d.id}/aprovar`, {}), `Diretriz de ${d.nicho} aprovada`));
  descartar.addEventListener('click', () => agir(descartar, () => api(`/api/diretrizes/${d.id}/descartar`, {}), 'Proposta descartada'));
  return el('article', { classe: 'cartao' },
    el('div', { classe: 'cartao-topo' },
      el('span', { classe: 'titulo', texto: `${d.nicho} · versão ${d.versao}` }),
      el('span', { classe: 'chip', texto: `por ${d.propostaPor}` })),
    el('p', { texto: d.texto }),
    el('div', { classe: 'acoes' }, aprovar, descartar));
}

// ---------------------------------------------------------------------------

/** O que fazer agora, a partir do estado do dia. Um só botão de marca (goiaba) por tela: o deste bloco. */
/** Extensão pareada mas parada há mais de um dia (login da Shopee vencido, Chrome fechado...). */
function avisoExtensao(e) {
  if (!e) return null;
  if (!e.ultimoRecebimento) return 'A extensão está pareada mas ainda não mandou dados. No Chrome, clique no ícone do Cofilius e em Buscar agora.';
  const horas = (Date.now() - new Date(e.ultimoRecebimento).getTime()) / 36e5;
  if (horas < 24) return null;
  const dias = Math.floor(horas / 24);
  return `As vendas da Shopee não chegam há ${dias === 1 ? '1 dia' : `${dias} dias`}. Abra o Chrome, confira se está logada na Shopee Afiliados e clique em Buscar agora no ícone do Cofilius.`
    + (e.ultimoErro ? ` Último erro: ${e.ultimoErro}` : '');
}

function proximoPasso(d, n) {
  const ir = (id) => () => document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!d.candidatas) return { titulo: 'Comece pelas ofertas de hoje', texto: 'Importe a planilha de ofertas do dia.', botao: 'Importar ofertas', acao: () => window.Cofilius.mostrarAba('importar') };
  if (!d.selecionadas.length) {
    return d.iaDisponivel
      ? { titulo: `${d.candidatas} ofertas esperando o Curador`, texto: 'O Curador escolhe as melhores do dia, seguindo as diretrizes do nicho.', botao: 'Rodar Curador', acao: 'curar' }
      : { titulo: 'Ligue a IA para o Curador escolher', texto: 'Coloque a chave da IA (Gemini, gratuita) na Configuração.', botao: 'Abrir Configuração', acao: () => window.Cofilius.mostrarAba('config') };
  }
  if (n.semLink) return { titulo: `Gere ${n.semLink === 1 ? 'o link que falta' : `os ${n.semLink} links que faltam`}`, texto: 'Use os Sub_ids de cada oferta no painel da Shopee e cole o link aqui.', botao: 'Ver as ofertas sem link', acao: ir('secao-escolhidas') };
  if (n.paraRedigir && d.iaDisponivel) return { titulo: 'Hora das mensagens', texto: `${n.paraRedigir} ${n.paraRedigir === 1 ? 'oferta tem' : 'ofertas têm'} link e ainda não ${n.paraRedigir === 1 ? 'tem' : 'têm'} mensagem.`, botao: 'Redigir mensagens', acao: 'redigir' };
  if (n.rascunho) return { titulo: `Valide ${n.rascunho === 1 ? 'a mensagem' : `as ${n.rascunho} mensagens`}`, texto: 'O sistema confere link, preço, repetição e o limite do dia.', botao: 'Validar todas', acao: 'validar' };
  if (n.validada) return { titulo: `Revise e aprove ${n.validada === 1 ? 'a mensagem' : `as ${n.validada} mensagens`}`, texto: 'Leia cada uma como ela vai receber e aprove.', botao: 'Ver mensagens', acao: ir('secao-mensagens') };
  if (n.aprovada) return { titulo: 'Envie a lista para ela', texto: 'Confira o preço, copie cada mensagem para o WhatsApp e marque como enviada.', botao: 'Ver mensagens aprovadas', acao: ir('secao-mensagens') };
  if (n.enviada) return { titulo: 'Lista de hoje enviada', texto: 'Agora é com ela. Os cliques e as vendas aparecem na aba Resultados.', concluido: true };
  return { titulo: 'Tudo em dia', texto: 'Nada pendente para este dia.', concluido: true };
}

function desenhar() {
  const d = dados;
  const n = { rascunho: 0, validada: 0, aprovada: 0, enviada: 0 };
  for (const m of d.mensagens) {
    if (m.estado === 'medida') n.enviada++;
    else if (m.estado in n) n[m.estado]++;
  }
  n.semLink = d.selecionadas.filter((s) => !s.linkId && s.plataforma === 'shopee').length;
  n.paraRedigir = d.selecionadas.filter((s) => s.linkId && !s.mensagemId).length;

  // Título com a data por extenso
  const [a, mes, dia] = d.data.split('-').map(Number);
  const hoje = window.Cofilius.dataLocal() === d.data;
  $('rotulo-dia').textContent = new Date(a, mes - 1, dia).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('titulo-dia').textContent = hoje ? 'Sua lista de hoje' : 'Lista do dia';

  // Próximo passo
  const p = proximoPasso(d, n);
  const caixa = $('proximo');
  caixa.className = p.concluido ? 'proximo concluido' : 'proximo';
  const filhos = [el('div', {}, el('span', { classe: 'rotulo', texto: p.concluido ? 'Pronto' : 'Próximo passo' }), el('h2', { texto: p.titulo }), el('p', { classe: 'motivo', texto: p.texto }))];
  if (p.botao) {
    const b = el('button', { classe: 'primario', texto: p.botao, attrs: { type: 'button' } });
    b.addEventListener('click', () => {
      if (typeof p.acao === 'function') return p.acao();
      const rotas = { curar: ['/api/curar', (r) => `Curador escolheu ${r.escolhidas} de ${r.candidatas}`], redigir: ['/api/redigir', (r) => `${r.redigidas} mensagens redigidas`], validar: ['/api/validar-dia', (r) => `${r.validadas} validadas, ${r.barradas} barradas`] };
      const [rota, msg] = rotas[p.acao];
      agir(b, () => api(rota, { data: $('data').value }), msg);
    });
    filhos.push(b);
  }
  caixa.replaceChildren(...filhos);

  // Andamento do dia
  const passos = [
    ['Ofertas', d.candidatas, d.candidatas > 0],
    ['Escolhidas', d.selecionadas.length, d.selecionadas.length > 0],
    ['Com link', d.selecionadas.filter((s) => s.linkId).length, d.selecionadas.length > 0 && !n.semLink],
    ['Mensagens', d.mensagens.filter((m) => m.estado !== 'descartada').length, d.mensagens.length > 0 && !n.paraRedigir],
    ['Aprovadas', n.aprovada + n.enviada, n.aprovada + n.enviada > 0 && !n.rascunho && !n.validada],
    ['Enviadas', n.enviada, n.enviada > 0 && !n.aprovada],
  ];
  $('andamento').replaceChildren(...passos.map(([rotulo, valor, feito]) =>
    el('li', { classe: feito ? 'feito' : '' }, el('span', { classe: 'valor', texto: String(valor) }), el('span', { classe: 'rotulo', texto: rotulo }))));

  $('aviso-ia').hidden = d.iaDisponivel;
  desenharAprendizado(d.aprendizado);
  desenharFechamento(d);
  desenharCancelamentos(d.cancelamentos || []);
  const pend = d.conformidadePendente || 0;
  $('aviso-conformidade').hidden = !pend;
  if (pend) {
    const ir = el('button', { classe: 'secundario', texto: 'Ver a lista', attrs: { type: 'button' } });
    ir.addEventListener('click', () => window.Cofilius.mostrarAba('config').then(() => document.getElementById('secao-conformidade').scrollIntoView({ behavior: 'smooth' })));
    $('aviso-conformidade').replaceChildren(
      el('span', { texto: `${pend} ${pend === 1 ? 'cuidado' : 'cuidados'} com as regras dos programas ainda não ${pend === 1 ? 'foi conferido' : 'foram conferidos'}. Evita bloqueio da conta.` }), ir);
  }
  const aviso = avisoExtensao(d.extensao);
  $('aviso-extensao').hidden = !aviso;
  $('aviso-extensao').textContent = aviso || '';
  $('rodar-curador').disabled = !d.iaDisponivel || !d.candidatas;
  $('rodar-redator').disabled = !d.iaDisponivel || !n.paraRedigir;
  $('validar-todas').disabled = !n.rascunho;

  $('selecionadas').replaceChildren(...(d.selecionadas.length
    ? d.selecionadas.map(itemSelecionada)
    : [el('li', { classe: 'vazio', texto: d.candidatas ? 'O Curador ainda não escolheu as ofertas deste dia.' : 'Nenhuma oferta neste dia ainda. Importe a planilha na aba Importar.' })]));

  const ordem = ['aprovada', 'validada', 'rascunho', 'enviada', 'medida', 'descartada'];
  const mensagens = [...d.mensagens].sort((x, y) => ordem.indexOf(x.estado) - ordem.indexOf(y.estado));
  $('mensagens').replaceChildren(...(mensagens.length
    ? mensagens.map(cartaoMensagem)
    : [el('p', { classe: 'vazio', texto: 'Nenhuma mensagem ainda. Elas aparecem aqui depois que o Redator escreve (ou quando você cria um rascunho).' })]));

  $('pedidos').replaceChildren(...(d.pedidos.length
    ? d.pedidos.map(cartaoPedido)
    : [el('p', { classe: 'vazio', texto: 'Nenhum pedido esperando você.' })]));
  $('secao-propostas').hidden = !d.propostas.length;
  $('propostas').replaceChildren(...d.propostas.map(cartaoProposta));
}

async function carregar() {
  if (!$('data').value) $('data').value = window.Cofilius.dataLocal();
  dados = await api(`/api/dia?cliente=${encodeURIComponent(estado.cliente)}&data=${encodeURIComponent($('data').value)}`);
  desenhar();
}

window.Cofilius.registrar('dia', {
  mostrar: carregar,
  iniciar() {
    $('data').value = window.Cofilius.dataLocal();
    $('data').addEventListener('change', () => carregar().catch((e) => avisar(e.message, true)));
    $('rodar-curador').addEventListener('click', (ev) => agir(ev.currentTarget, () => api('/api/curar', { data: $('data').value }),
      (r) => `Curador escolheu ${r.escolhidas} de ${r.candidatas} candidatas`));
    $('rodar-redator').addEventListener('click', (ev) => agir(ev.currentTarget, () => api('/api/redigir', { data: $('data').value }),
      (r) => `${r.redigidas} mensagens redigidas${r.falhas.length ? `, ${r.falhas.length} falharam` : ''}`));
    $('validar-todas').addEventListener('click', (ev) => agir(ev.currentTarget, () => api('/api/validar-dia', { data: $('data').value }),
      (r) => `${r.validadas} validadas, ${r.barradas} barradas`));
    $('simular').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const campo = $('simular-texto');
      agir(ev.currentTarget.querySelector('button'), () => api('/api/receber', { texto: campo.value }), (r) => {
        campo.value = '';
        const resp = r.respostas && r.respostas.length ? ` Resposta para ela: "${r.respostas.join(' / ')}"` : '';
        if (r.tipo === 'lista') return `Pedido da lista: ${r.enviadas} enviadas.${resp}`;
        if (r.tipo === 'atendimento') return `${INTENCOES[r.intencao] || r.intencao}: ${r.situacao === 'resolvido' ? 'resolvido' : 'ficou para você'}.${resp}`;
        return 'Mensagem processada.';
      });
    });
  },
});
})();
