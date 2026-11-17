/* Cofilius · aba Clientes: cadastro, nichos, credenciais da Shopee e diretrizes de curadoria. */
'use strict';

(() => {
const { $, el, api, agir, estado, lerForm, carregarClientes, avisar } = window.Cofilius;

function campo(rotulo, nome, valor, attrs = {}) {
  return el('label', {}, rotulo, el('input', { attrs: { name: nome, value: valor ?? '', ...attrs } }));
}

function formEditar(c) {
  const form = el('form', { classe: 'grade-form' },
    campo('Nome', 'nome', c.nome, { required: '' }),
    campo('WhatsApp', 'whatsapp', c.whatsapp, { inputmode: 'tel' }),
    campo('Horário de envio', 'horarioEnvio', c.horarioEnvio || '08:00', { type: 'time' }),
    campo('Mensagens por dia', 'limiteMensagensDia', c.limiteMensagensDia, { type: 'number', min: '1', max: '100' }),
    el('label', { classe: 'largo' }, 'Tom do grupo', el('input', { attrs: { name: 'tomGrupo', value: c.tomGrupo || '' } })),
    el('div', { classe: 'largo' }, el('button', { texto: 'Salvar dados', attrs: { type: 'submit' } })));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    agir(form.querySelector('button'), () => api(`/api/gestao/clientes/${c.codigo}`, lerForm(form)), 'Dados salvos');
  });
  return form;
}

function blocoNichos(c) {
  const lista = el('ul', { classe: 'nichos' }, ...c.nichos.map((n) => {
    const remover = el('button', { classe: 'perigo pequeno', texto: 'remover', attrs: { type: 'button' } });
    remover.addEventListener('click', () => {
      if (window.confirm(`Remover o nicho "${n.nome || n.slug}"?`)) agir(remover, () => api(`/api/gestao/clientes/${c.codigo}/nichos/${n.slug}/remover`, {}), 'Nicho removido');
    });
    return el('li', {}, el('strong', { texto: n.nome || n.slug }), el('span', { classe: 'palavras', texto: (n.palavras_chave || []).join(', ') }), remover);
  }));
  const form = el('form', { classe: 'linha-form' },
    el('input', { attrs: { name: 'nome', placeholder: 'Nicho (ex.: Casa)', required: '' } }),
    el('input', { attrs: { name: 'palavras', placeholder: 'Palavras de busca, separadas por vírgula', required: '' } }),
    el('button', { classe: 'secundario', texto: 'Adicionar ou atualizar nicho', attrs: { type: 'submit' } }));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    agir(form.querySelector('button'), () => api(`/api/gestao/clientes/${c.codigo}/nichos`, lerForm(form)), 'Nicho salvo');
  });
  return el('div', {}, el('h3', { texto: 'Nichos' }), c.nichos.length ? lista : el('p', { classe: 'vazio', texto: 'Nenhum nicho ainda.' }), form);
}

function blocoShopee(c) {
  const form = el('form', { classe: 'linha-form' },
    el('input', { attrs: { name: 'appId', placeholder: 'App ID', autocomplete: 'off', required: '' } }),
    el('input', { attrs: { name: 'secret', type: 'password', placeholder: 'Secret', autocomplete: 'off', required: '' } }),
    el('button', { classe: 'secundario', texto: 'Salvar credenciais', attrs: { type: 'submit' } }));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    agir(form.querySelector('button'), () => api(`/api/gestao/clientes/${c.codigo}/shopee`, lerForm(form)), 'Credenciais da Shopee salvas (cifradas)');
  });
  return el('div', {},
    el('h3', { texto: 'Open API da Shopee' }),
    el('p', { classe: 'ajuda', texto: c.shopeeApi
      ? 'Configurada. Coleta de ofertas e links passam a ser automáticos. Para trocar, salve de novo.'
      : 'Não configurada: as ofertas entram pela planilha e os links pelo painel da Shopee.' }),
    form);
}

async function blocoDiretrizes(c) {
  const lista = await api(`/api/diretrizes?cliente=${encodeURIComponent(c.codigo)}`);
  const vigentes = lista.filter((d) => d.situacao === 'aprovada' || d.situacao === 'proposta');
  const form = el('form', { classe: 'linha-form' },
    el('select', { attrs: { name: 'nicho', 'aria-label': 'Nicho' } }, ...c.nichos.map((n) => el('option', { texto: n.nome || n.slug, attrs: { value: n.slug } }))),
    el('input', { attrs: { name: 'texto', placeholder: 'Ex.: priorizar utilidades de cozinha até R$ 60', required: '' } }),
    el('button', { classe: 'secundario', texto: 'Propor', attrs: { type: 'submit' } }));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    agir(form.querySelector('button'), () => api('/api/diretrizes', { ...lerForm(form), cliente: c.codigo }), 'Proposta criada: aprove na aba Dia');
  });
  return el('div', {},
    el('h3', { texto: 'Diretrizes de curadoria' }),
    el('p', { classe: 'ajuda', texto: 'O texto que o Curador segue em cada nicho. Propostas são aprovadas na aba Dia.' }),
    vigentes.length
      ? el('ul', { classe: 'nichos' }, ...vigentes.map((d) => el('li', {},
        el('strong', { texto: `${d.nicho} · versão ${d.versao}` }),
        el('span', { classe: `chip ${d.situacao === 'aprovada' ? 'ok' : 'alerta'}`, texto: d.situacao === 'aprovada' ? 'em vigor' : 'proposta' }),
        el('span', { classe: 'palavras', texto: d.texto }))))
      : el('p', { classe: 'vazio', texto: 'Nenhuma diretriz ainda.' }),
    c.nichos.length ? form : null);
}

async function cartaoCliente(c) {
  const ativo = el('button', { classe: c.ativo ? 'perigo' : '', texto: c.ativo ? 'Pausar cliente' : 'Reativar cliente', attrs: { type: 'button' } });
  ativo.addEventListener('click', () => {
    if (c.ativo && !window.confirm(`Pausar ${c.nome}? Ela sai da esteira e do painel até ser reativada.`)) return;
    agir(ativo, async () => { const r = await api(`/api/gestao/clientes/${c.codigo}/ativo`, { ativo: !c.ativo }); await carregarClientes(); return r; },
      c.ativo ? 'Cliente pausado' : 'Cliente reativado');
  });
  const detalhes = el('details', { classe: 'cartao', attrs: c.codigo === estado.cliente ? { open: '' } : {} },
    el('summary', {},
      el('span', { classe: 'titulo', texto: c.nome }),
      el('span', { classe: 'etiqueta', texto: c.codigo }),
      el('span', { classe: `chip ${c.ativo ? 'ok' : 'erro'}`, texto: c.ativo ? 'ativo' : 'pausado' }),
      el('span', { classe: 'chip', texto: `${c.nichos.length} ${c.nichos.length === 1 ? 'nicho' : 'nichos'}` }),
      c.shopeeApi ? el('span', { classe: 'chip destaque', texto: 'Open API Shopee' }) : null),
    formEditar(c), blocoNichos(c), blocoShopee(c));
  if (c.ativo) detalhes.append(await blocoDiretrizes(c));
  detalhes.append(el('div', { classe: 'acoes' }, ativo));
  return detalhes;
}

window.Cofilius.registrar('clientes', {
  async mostrar() {
    const clientes = await api('/api/gestao/clientes');
    const cartoes = [];
    for (const c of clientes) cartoes.push(await cartaoCliente(c));
    $('lista-clientes').replaceChildren(...(cartoes.length ? cartoes : [el('p', { classe: 'vazio', texto: 'Nenhum cliente ainda. Cadastre o primeiro acima.' })]));
  },
  iniciar() {
    const form = $('form-novo-cliente');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const dados = lerForm(form);
      const r = await agir(form.querySelector('button[type=submit]'), async () => {
        const res = await api('/api/gestao/clientes', dados);
        estado.cliente = res.codigo;
        await carregarClientes();
        return res;
      }, `Cliente ${dados.codigo} cadastrado. Agora adicione os nichos.`);
      if (r) form.reset();
    });
  },
});
})();
