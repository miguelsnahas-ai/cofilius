/* Cofilius · aba Configuração: nome, senha, chave da IA, modelos, esteira e teste dos agentes. */
'use strict';

(() => {
const { $, el, api, agir, lerForm, avisar, estado } = window.Cofilius;

/** Mostra só o campo de chave do provedor escolhido. */
function mostrarCamposDoProvedor(provedor) {
  for (const campo of document.querySelectorAll('[data-provedor]')) campo.hidden = campo.dataset.provedor !== provedor;
}

const NOMES_EXTENSAO = { 'shopee.conversoes': 'Vendas da Shopee', 'shopee.cliques': 'Cliques da Shopee', 'amazon.link': 'Links da Amazon' };

function quando(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function mostrarExtensao() {
  const alvo = $('estado-extensao');
  if (!estado.cliente) { alvo.replaceChildren(); return; }
  try {
    const r = await api(`/api/extensao?cliente=${encodeURIComponent(estado.cliente)}`);
    alvo.replaceChildren(
      el('p', { classe: 'ajuda', texto: !r.pareado ? 'Ainda não pareada para este cliente.'
        : r.usadoEm ? `Pareada · último contato da extensão ${quando(r.usadoEm)}` : 'Código gerado; a extensão ainda não se conectou.' }),
      r.ultimos.length ? el('ul', {}, ...r.ultimos.map((u) => el('li', {
        classe: u.erro ? 'erro-texto' : '',
        texto: `${NOMES_EXTENSAO[u.tipo] || u.tipo}: ${quando(u.em)}${u.erro ? ` · erro: ${u.erro}` : ''}`,
      }))) : null);
  } catch (e) {
    alvo.replaceChildren(el('p', { classe: 'erro-texto', texto: e.message }));
  }
}

const NOMES_PROGRAMA = { geral: 'Todos os programas', shopee: 'Shopee', amazon: 'Amazon', mercado_livre: 'Mercado Livre' };

async function mostrarConformidade() {
  const alvo = $('lista-conformidade');
  if (!estado.cliente) { alvo.replaceChildren(); return; }
  let c;
  try { c = await api(`/api/conformidade?cliente=${encodeURIComponent(estado.cliente)}`); }
  catch (e) { alvo.replaceChildren(el('p', { classe: 'erro-texto', texto: e.message })); return; }
  $('form-identificacao').elements.identificacao.value = c.identificacao;
  const grupos = ['geral', 'shopee', 'amazon', 'mercado_livre'].map((prog) => {
    const regras = c.regras.filter((r) => r.programa === prog);
    return el('div', { classe: 'grupo-conformidade' },
      el('h3', { texto: NOMES_PROGRAMA[prog] }),
      el('ul', { classe: 'lista-conformidade' }, ...regras.map((r) => {
        const titulo = el('strong', { texto: r.titulo });
        const detalhe = el('span', { classe: 'detalhe', texto: `${r.explicacao}${r.aConferir ? ' (Regra a conferir no texto oficial.)' : ''}` });
        const fonte = el('span', { classe: 'fonte', texto: `Fonte: ${r.fonte}` });
        if (r.tipo === 'automatica') {
          return el('li', { classe: 'automatica' }, el('span', { classe: 'chip ok', texto: 'Automático' }), el('div', {}, titulo, detalhe, fonte));
        }
        const caixa = el('input', { attrs: { type: 'checkbox', 'aria-label': r.titulo } });
        caixa.checked = !!r.feitoEm;
        caixa.addEventListener('change', async () => {
          caixa.disabled = true;
          try {
            await api('/api/conformidade/item', { item: r.id, feito: caixa.checked });
            avisar(caixa.checked ? 'Marcado como feito' : 'Desmarcado');
            mostrarConformidade();
          } catch (e) { avisar(e.message, true); caixa.checked = !caixa.checked; }
          finally { caixa.disabled = false; }
        });
        return el('li', { classe: r.feitoEm ? 'feito' : 'pendente' },
          el('label', { classe: 'marcar' }, caixa),
          el('div', {}, titulo, detalhe, fonte,
            r.feitoEm ? el('span', { classe: 'fonte', texto: `Feito em ${new Date(r.feitoEm).toLocaleDateString('pt-BR')}` }) : null));
      })));
  });
  alvo.replaceChildren(
    el('p', { classe: c.pendentes ? 'aviso' : 'ajuda', texto: c.pendentes
      ? `${c.pendentes} ${c.pendentes === 1 ? 'item pendente' : 'itens pendentes'} na lista abaixo.`
      : 'Lista de conferência completa.' }),
    ...grupos,
    el('p', { classe: 'ajuda', texto: `Regras conferidas em ${c.verificadoEm.split('-').reverse().join('/')}. Os programas mudam as regras: releia os termos a cada trimestre.` }));
}

window.Cofilius.registrar('config', {
  async mostrar() {
    mostrarConformidade();
    $('codigo-pareamento').hidden = true;
    mostrarExtensao();
    const c = await api('/api/config');
    const f = $('form-config');
    f.elements.operador.value = c.operador;
    f.elements.novaSenha.value = '';
    f.elements.anthropicKey.value = '';
    f.elements.geminiKey.value = '';
    f.elements.provedor.value = c.provedor;
    mostrarCamposDoProvedor(c.provedor);
    f.elements.modeloPequeno.value = c.modeloPequeno;
    f.elements.modeloForte.value = c.modeloForte;
    f.elements.esteiraLigada.checked = c.esteiraLigada;
    $('estado-chave-gemini').textContent = c.chaveGemini ? 'Configurada ✓ (para trocar, cole a nova)'
      : 'Pegue a chave grátis em aistudio.google.com, no botão "Get API key".';
    $('estado-chave-claude').textContent = c.chaveClaude ? 'Configurada ✓ (para trocar, cole a nova)' : 'Não configurada.';
    $('estado-whatsapp').textContent = c.whatsapp
      ? 'WhatsApp Cloud API: configurado.'
      : 'WhatsApp Cloud API: não configurado (envio manual). Será ligado quando o número for aprovado pela Meta.';
  },
  iniciar() {
    const f = $('form-config');
    f.elements.provedor.addEventListener('change', (ev) => {
      mostrarCamposDoProvedor(ev.target.value);
      // Os modelos do outro provedor não servem: limpa para usar o padrão do novo.
      f.elements.modeloPequeno.value = '';
      f.elements.modeloForte.value = '';
    });
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const dados = lerForm(f);
      if (!dados.anthropicKey) delete dados.anthropicKey;
      if (!dados.geminiKey) delete dados.geminiKey;
      if (!dados.novaSenha) delete dados.novaSenha;
      agir(f.querySelector('button[type=submit]'), () => api('/api/config', dados),
        (r) => (r.senhaAlterada ? 'Salvo. A senha mudou: o navegador vai pedir a nova.' : 'Configuração salva'));
    });
    $('form-identificacao').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      agir(f.querySelector('button'), () => api('/api/conformidade/identificacao', { identificacao: f.elements.identificacao.value }),
        'Identificação salva. Vale para as próximas mensagens e legendas.');
    });
    $('gerar-pareamento').addEventListener('click', async (ev) => {
      if (!estado.cliente) return avisar('Escolha o cliente no topo.', true);
      if (!window.confirm('Gerar um código novo? Se a extensão já estava pareada com este cliente, ela vai precisar do código novo.')) return;
      const botao = ev.currentTarget;
      botao.disabled = true;
      try {
        const r = await api('/api/extensao/parear', {});
        $('codigo-texto').textContent = r.codigo;
        $('codigo-pareamento').hidden = false;
        mostrarExtensao();
      } catch (e) {
        avisar(e.message, true);
      } finally {
        botao.disabled = false;
      }
    });
    $('copiar-codigo').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('codigo-texto').textContent); avisar('Código copiado'); }
      catch { avisar('Selecione o código e copie com Ctrl+C.', true); }
    });
    $('form-testar').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const agente = ev.currentTarget.elements.agente.value;
      if (!window.confirm(`Testar o ${agente} com a IA de verdade? Usa a sua chave (no Gemini gratuito, conta no limite diário).`)) return;
      const botao = ev.currentTarget.querySelector('button');
      botao.disabled = true;
      $('resultado-testar').replaceChildren(el('p', { classe: 'ajuda', texto: 'Rodando os casos de teste…' }));
      try {
        const r = await api('/api/agentes/testar', { agente });
        $('resultado-testar').replaceChildren(
          el('p', { texto: `${r.casos.filter((x) => x.ok).length} de ${r.casos.length} casos ok · ${r.chamadas} chamadas · US$ ${r.custoUsd}` }),
          el('ul', {}, ...r.casos.map((x) => el('li', { classe: x.ok ? '' : 'erro-texto', texto: `${x.ok ? '✔' : '✘'} ${x.caso}: ${x.detalhe}` }))));
      } catch (e) {
        $('resultado-testar').replaceChildren();
        avisar(e.message, true);
      } finally {
        botao.disabled = false;
      }
    });
  },
});
})();
