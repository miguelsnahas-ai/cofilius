/* Cofilius · aba Configuração: nome, senha, chave da IA, modelos, esteira e teste dos agentes. */
'use strict';

(() => {
const { $, el, api, agir, lerForm, avisar } = window.Cofilius;

window.Cofilius.registrar('config', {
  async mostrar() {
    const c = await api('/api/config');
    const f = $('form-config');
    f.elements.operador.value = c.operador;
    f.elements.novaSenha.value = '';
    f.elements.anthropicKey.value = '';
    f.elements.modeloPequeno.value = c.modeloPequeno;
    f.elements.modeloForte.value = c.modeloForte;
    f.elements.esteiraLigada.checked = c.esteiraLigada;
    $('estado-chave').textContent = c.ia ? 'Configurada ✓ (para trocar, cole a nova)' : 'Não configurada: Curador, Redator, Analista e Atendente ficam desligados.';
    $('estado-whatsapp').textContent = c.whatsapp
      ? 'WhatsApp Cloud API: configurado.'
      : 'WhatsApp Cloud API: não configurado (envio manual). Será ligado quando o número for aprovado pela Meta.';
  },
  iniciar() {
    const f = $('form-config');
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const dados = lerForm(f);
      if (!dados.anthropicKey) delete dados.anthropicKey;
      if (!dados.novaSenha) delete dados.novaSenha;
      agir(f.querySelector('button[type=submit]'), () => api('/api/config', dados),
        (r) => (r.senhaAlterada ? 'Salvo. A senha mudou: o navegador vai pedir a nova.' : 'Configuração salva'));
    });
    $('form-testar').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const agente = ev.currentTarget.elements.agente.value;
      if (!window.confirm(`Testar o ${agente} com a IA de verdade? Usa a sua chave da API (custo de poucos centavos).`)) return;
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
