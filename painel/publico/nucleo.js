/* Cofilius · núcleo do painel: abas, cliente selecionado, chamadas à API e avisos. */
'use strict';

window.Cofilius = (() => {
  const $ = (id) => document.getElementById(id);
  const estado = { cliente: '', clientes: [], aba: 'dia' };
  const abas = {};

  /** Cria um elemento com classe, texto, atributos e filhos (texto sempre como texto, nunca HTML). */
  function el(tag, opcoes = {}, ...filhos) {
    const e = document.createElement(tag);
    if (opcoes.classe) e.className = opcoes.classe;
    if (opcoes.texto !== undefined) e.textContent = opcoes.texto;
    if (opcoes.attrs) for (const [k, v] of Object.entries(opcoes.attrs)) e.setAttribute(k, v);
    if (opcoes.onclick) e.addEventListener('click', opcoes.onclick);
    for (const f of filhos) if (f !== null && f !== undefined && f !== false) e.append(f);
    return e;
  }

  let temporizador;
  function avisar(texto, erro = false) {
    const t = $('aviso');
    t.textContent = texto;
    t.className = erro ? 'toast erro' : 'toast';
    t.hidden = false;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { t.hidden = true; }, erro ? 8000 : 4000);
  }

  /** GET (sem corpo) ou POST (com corpo; o cliente selecionado vai junto, salvo se o corpo trouxer outro). */
  async function api(caminho, corpo) {
    const opcoes = corpo === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cofilius': '1' }, body: JSON.stringify({ cliente: estado.cliente, ...corpo }) };
    const r = await fetch(caminho, opcoes);
    const json = await r.json().catch(() => ({ erro: `Erro ${r.status}` }));
    if (!r.ok) throw new Error(json.erro || `Erro ${r.status}`);
    return json;
  }

  /** Executa uma ação com o botão travado, avisa o resultado e redesenha a aba atual. */
  async function agir(botao, fn, sucesso) {
    if (botao) botao.disabled = true;
    try {
      const r = await fn();
      if (sucesso) avisar(typeof sucesso === 'function' ? sucesso(r) : sucesso);
      await recarregar();
      return r;
    } catch (e) {
      avisar(e.message, true);
      return null;
    } finally {
      if (botao) botao.disabled = false;
    }
  }

  function dataLocal(d = new Date()) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function reais(v) {
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  /** Campos de um formulário como objeto (checkbox vira true/false). */
  function lerForm(form) {
    const dados = {};
    for (const campo of form.elements) {
      if (!campo.name || campo.type === 'file' || campo.type === 'submit') continue;
      dados[campo.name] = campo.type === 'checkbox' ? campo.checked : campo.value;
    }
    return dados;
  }

  function lerArquivo(campo) {
    return new Promise((ok, falha) => {
      const arquivo = campo.files && campo.files[0];
      if (!arquivo) return falha(new Error('Escolha o arquivo.'));
      if (arquivo.size > 2_500_000) return falha(new Error('Arquivo grande demais (máximo 2,5 MB).'));
      const leitor = new FileReader();
      leitor.onload = () => ok(String(leitor.result));
      leitor.onerror = () => falha(new Error('Não consegui ler o arquivo.'));
      leitor.readAsText(arquivo, 'utf-8');
    });
  }

  function salvarPreferencias() {
    try { localStorage.setItem('cofilius-painel', JSON.stringify({ cliente: estado.cliente, aba: estado.aba })); } catch { /* sem armazenamento */ }
  }

  async function carregarClientes() {
    estado.clientes = await api('/api/clientes');
    const select = $('cliente');
    select.replaceChildren(...estado.clientes.map((c) => el('option', { texto: `${c.nome} (${c.codigo})`, attrs: { value: c.codigo } })));
    if (!estado.clientes.some((c) => c.codigo === estado.cliente)) estado.cliente = estado.clientes[0] ? estado.clientes[0].codigo : '';
    select.value = estado.cliente;
  }

  /** Registra uma aba: { mostrar(), iniciar() }. */
  function registrar(nome, aba) { abas[nome] = aba; }

  async function mostrarAba(nome) {
    if (!abas[nome]) nome = 'dia';
    estado.aba = nome;
    salvarPreferencias();
    for (const b of document.querySelectorAll('nav.abas button')) b.setAttribute('aria-current', b.dataset.aba === nome ? 'page' : 'false');
    for (const p of document.querySelectorAll('[data-painel]')) p.hidden = p.dataset.painel !== nome;
    // Sem cliente, só as abas de cadastro e configuração fazem sentido.
    if (!estado.cliente && !['clientes', 'config'].includes(nome)) {
      avisar('Cadastre o primeiro cliente para começar.');
      return mostrarAba('clientes');
    }
    try { await abas[nome].mostrar(); } catch (e) { avisar(e.message, true); }
  }

  const recarregar = () => mostrarAba(estado.aba);

  async function iniciar() {
    const est = await fetch('/api/estado').then((r) => r.json()).catch(() => ({}));
    if (est.modo === 'configuracao') { location.href = '/'; return; }
    try {
      const pref = JSON.parse(localStorage.getItem('cofilius-painel') || '{}');
      estado.cliente = pref.cliente || '';
      estado.aba = pref.aba || 'dia';
    } catch { /* sem armazenamento */ }
    await carregarClientes();
    $('cliente').addEventListener('change', (ev) => { estado.cliente = ev.target.value; salvarPreferencias(); recarregar(); });
    for (const b of document.querySelectorAll('nav.abas button')) b.addEventListener('click', () => mostrarAba(b.dataset.aba));
    for (const aba of Object.values(abas)) if (aba.iniciar) aba.iniciar();
    await mostrarAba(estado.aba);
  }

  document.addEventListener('DOMContentLoaded', () => { iniciar().catch((e) => avisar(e.message, true)); });

  return { $, el, avisar, api, agir, estado, registrar, recarregar, carregarClientes, dataLocal, reais, lerForm, lerArquivo, mostrarAba };
})();
