/* Painel do operador do Cofilius. Sem framework: monta a tela com textContent (nunca HTML com dados). */
'use strict';

const $ = (id) => document.getElementById(id);

const ESTADOS = {
  rascunho: ['Rascunho', 'alerta'],
  validada: ['Validada', 'destaque'],
  aprovada: ['Aprovada', 'ok'],
  enviada: ['Enviada', 'ok'],
  medida: ['Medida', 'ok'],
  descartada: ['Descartada', 'erro'],
};
const REGRAS = { texto: 'Texto', link: 'Link', preco: 'Preço', repeticao: 'Repetição', limite: 'Limite do dia' };

let estado = { cliente: '', data: '' };
let dados = null;

/** Cria um elemento com classe, texto e filhos. */
function el(tag, opcoes = {}, ...filhos) {
  const e = document.createElement(tag);
  if (opcoes.classe) e.className = opcoes.classe;
  if (opcoes.texto !== undefined) e.textContent = opcoes.texto;
  if (opcoes.attrs) for (const [k, v] of Object.entries(opcoes.attrs)) e.setAttribute(k, v);
  if (opcoes.onclick) e.addEventListener('click', opcoes.onclick);
  for (const f of filhos) if (f) e.append(f);
  return e;
}

let temporizador;
function avisar(texto, erro = false) {
  const t = $('aviso');
  t.textContent = texto;
  t.className = erro ? 'toast erro' : 'toast';
  t.hidden = false;
  clearTimeout(temporizador);
  temporizador = setTimeout(() => { t.hidden = true; }, erro ? 7000 : 3500);
}

async function api(caminho, corpo) {
  const opcoes = corpo === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cofilius': '1' }, body: JSON.stringify({ cliente: estado.cliente, ...corpo }) };
  const r = await fetch(caminho, opcoes);
  const json = await r.json().catch(() => ({ erro: `Erro ${r.status}` }));
  if (!r.ok) throw new Error(json.erro || `Erro ${r.status}`);
  return json;
}

/** Executa uma ação com o botão travado, avisa o resultado e recarrega a tela. */
async function agir(botao, fn, sucesso) {
  if (botao) botao.disabled = true;
  try {
    const r = await fn();
    avisar(typeof sucesso === 'function' ? sucesso(r) : sucesso);
    await carregar();
  } catch (e) {
    avisar(e.message, true);
  } finally {
    if (botao) botao.disabled = false;
  }
}

function hojeLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function reais(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function salvarPreferencias() {
  try { localStorage.setItem('cofilius-painel', JSON.stringify({ cliente: estado.cliente })); } catch { /* sem armazenamento */ }
}

// ---------------------------------------------------------------------------
// Seção 1: escolhidas do Curador
// ---------------------------------------------------------------------------

function itemSelecionada(s) {
  const situacao = s.mensagemId ? ['com mensagem', 'ok'] : s.linkId ? ['com link', 'destaque'] : ['sem link', 'alerta'];
  const li = el('li', { classe: 'cartao' },
    el('div', { classe: 'cartao-topo' },
      el('span', { classe: 'titulo', texto: `${s.posicao}. ${s.titulo}` }),
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

function cartaoMensagem(m) {
  const [rotulo, cor] = ESTADOS[m.estado] || [m.estado, ''];
  const cartao = el('article', { classe: 'cartao' },
    el('div', { classe: 'cartao-topo' },
      el('span', { classe: 'titulo', texto: m.titulo || '(oferta removida)' }),
      el('span', { classe: `chip ${cor}`, texto: rotulo })));
  if (m.textoFinal) cartao.append(el('div', { classe: 'balao', texto: m.textoFinal }));

  const falhas = (m.validacao || []).filter((r) => !r.ok);
  if (falhas.length && m.estado === 'rascunho') {
    cartao.append(el('ul', { classe: 'falhas' }, ...falhas.map((f) => el('li', { texto: `${REGRAS[f.regra] || f.regra}: ${f.detalhe}` }))));
  }
  if (m.motivoDescarte) cartao.append(el('p', { classe: 'motivo', texto: `Motivo: ${m.motivoDescarte}` }));
  if (m.enviadaEm) cartao.append(el('p', { classe: 'motivo', texto: `Enviada em ${new Date(m.enviadaEm).toLocaleString('pt-BR')}` }));

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
    cartao.append(
      el('p', { classe: 'motivo', texto: `Preço conferido: ${quando}. Para enviar, precisa ter sido conferido há no máximo 30 minutos: olhe a página do produto e confirme.` }),
      formPreco(m));
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

function desenhar() {
  const d = dados;
  const contagem = {};
  for (const m of d.mensagens) contagem[m.estado] = (contagem[m.estado] || 0) + 1;
  $('resumo').replaceChildren(
    el('span', { classe: 'chip', texto: `${d.candidatas} candidatas` }),
    el('span', { classe: 'chip', texto: `${d.selecionadas.length} escolhidas` }),
    el('span', { classe: 'chip', texto: `envio às ${d.horarioEnvio.slice(11)}` }),
    ...Object.entries(contagem).map(([e, n]) => el('span', { classe: `chip ${(ESTADOS[e] || [])[1] || ''}`, texto: `${n} ${(ESTADOS[e] || [e])[0].toLowerCase()}` })));

  $('aviso-ia').hidden = d.iaDisponivel;
  $('rodar-curador').disabled = !d.iaDisponivel || !d.candidatas;
  $('rodar-redator').disabled = !d.iaDisponivel || !d.selecionadas.some((s) => s.linkId && !s.mensagemId);

  $('selecionadas').replaceChildren(...(d.selecionadas.length
    ? d.selecionadas.map(itemSelecionada)
    : [el('li', { classe: 'vazio', texto: d.candidatas ? 'O Curador ainda não escolheu as ofertas deste dia.' : 'Nenhuma oferta coletada neste dia. Importe a planilha (importar-ofertas).' })]));

  const ordem = ['aprovada', 'validada', 'rascunho', 'enviada', 'medida', 'descartada'];
  const mensagens = [...d.mensagens].sort((a, b) => ordem.indexOf(a.estado) - ordem.indexOf(b.estado));
  $('mensagens').replaceChildren(...(mensagens.length
    ? mensagens.map(cartaoMensagem)
    : [el('p', { classe: 'vazio', texto: 'Nenhuma mensagem neste dia.' })]));

  $('pedidos').replaceChildren(...(d.pedidos.length
    ? d.pedidos.map(cartaoPedido)
    : [el('p', { classe: 'vazio', texto: 'Nenhum pedido esperando você.' })]));
  $('secao-propostas').hidden = !d.propostas.length;
  $('propostas').replaceChildren(...d.propostas.map(cartaoProposta));
}

async function carregar() {
  if (!estado.cliente) return;
  try {
    dados = await api(`/api/dia?cliente=${encodeURIComponent(estado.cliente)}&data=${encodeURIComponent(estado.data)}`);
    desenhar();
  } catch (e) {
    avisar(e.message, true);
  }
}

async function iniciar() {
  let pref = {};
  try { pref = JSON.parse(localStorage.getItem('cofilius-painel') || '{}'); } catch { /* sem armazenamento */ }
  const clientes = await api('/api/clientes');
  const select = $('cliente');
  select.replaceChildren(...clientes.map((c) => el('option', { texto: `${c.nome} (${c.codigo})`, attrs: { value: c.codigo } })));
  if (clientes.some((c) => c.codigo === pref.cliente)) select.value = pref.cliente;
  $('data').value = hojeLocal();
  estado = { cliente: select.value, data: $('data').value };

  $('filtros').addEventListener('submit', (ev) => {
    ev.preventDefault();
    estado = { cliente: select.value, data: $('data').value };
    salvarPreferencias();
    carregar();
  });
  $('rodar-curador').addEventListener('click', (ev) => agir(ev.currentTarget, () => api('/api/curar', { data: estado.data }),
    (r) => `Curador escolheu ${r.escolhidas} de ${r.candidatas} candidatas`));
  $('rodar-redator').addEventListener('click', (ev) => agir(ev.currentTarget, () => api('/api/redigir', { data: estado.data }),
    (r) => `${r.redigidas} mensagens redigidas${r.falhas.length ? `, ${r.falhas.length} falharam` : ''}`));
  $('simular').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const campo = $('simular-texto');
    const botao = ev.currentTarget.querySelector('button');
    agir(botao, () => api('/api/receber', { texto: campo.value }), (r) => {
      campo.value = '';
      const resp = r.respostas && r.respostas.length ? ` Resposta para ela: "${r.respostas.join(' / ')}"` : '';
      if (r.tipo === 'lista') return `Pedido da lista: ${r.enviadas} enviadas.${resp}`;
      if (r.tipo === 'atendimento') return `${INTENCOES[r.intencao] || r.intencao}: ${r.situacao === 'resolvido' ? 'resolvido' : 'ficou para você'}.${resp}`;
      return 'Mensagem processada.';
    });
  });
  await carregar();
}

document.addEventListener('DOMContentLoaded', () => { iniciar().catch((e) => avisar(e.message, true)); });
