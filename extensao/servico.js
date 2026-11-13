/**
 * Service worker da extensão.
 *
 * 1. Gravador (para entender formatos novos): guarda as capturas em chrome.storage.local, só com a
 *    gravação ligada, e mostra a contagem no ícone.
 * 2. Sincronia com o painel (com a extensão pareada): os relatórios que o painel usa (conversões e
 *    cliques da Shopee, links curtos da Amazon) vão direto para o painel do Cofilius, sem arquivo.
 *    Se o painel estiver fechado, ficam na fila e vão na próxima tentativa (a cada 5 minutos).
 * 3. Busca automática (desligada por padrão; os termos da Shopee proíbem extração automatizada):
 *    a cada 6 horas abre, numa janela minimizada, os relatórios da Shopee e fecha depois.
 */
importScripts('nucleo.js');
const N = globalThis.CofiliusNucleo;

const LIMITE_FILA = 200;
const HORAS_BUSCA = 6;
let fila = Promise.resolve();

async function estado() {
  const { gravando = false, capturas = [] } = await chrome.storage.local.get(['gravando', 'capturas']);
  return { gravando, capturas };
}

async function atualizarIcone() {
  const { gravando, capturas } = await estado();
  const { sincronia = {} } = await chrome.storage.local.get('sincronia');
  await chrome.action.setBadgeBackgroundColor({ color: gravando ? '#c62828' : sincronia.erro ? '#b26a00' : '#757575' });
  await chrome.action.setBadgeText({ text: gravando ? String(capturas.length) : capturas.length ? '■' : sincronia.erro ? '!' : '' });
}

function emSerie(fn) {
  fila = fila.then(fn).catch((e) => console.error('Cofilius:', e));
  return fila;
}

function guardar(captura, forcar) {
  return emSerie(async () => {
    const { gravando, capturas } = await estado();
    if (!gravando && !forcar) return;
    if (capturas.length >= N.LIMITE_CAPTURAS) {
      await chrome.storage.local.set({ gravando: false, aviso: `Limite de ${N.LIMITE_CAPTURAS} capturas atingido. Baixe o arquivo e limpe.` });
    } else {
      capturas.push(N.mascarar(captura)); // segunda máscara: nada é guardado sem passar por ela
      await chrome.storage.local.set({ capturas });
    }
    await atualizarIcone();
  });
}

// ---------------------------------------------------------------------------
// Sincronia com o painel
// ---------------------------------------------------------------------------

async function pareamento() {
  const { painel = null } = await chrome.storage.local.get('painel');
  return painel && painel.endereco && painel.codigo ? painel : null;
}

/** Chamada ao painel (no computador): tempo limite de 30 s. */
async function chamarPainel(painel, caminho, corpo) {
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 30000);
  try {
    const resp = await fetch(painel.endereco.replace(/\/+$/, '') + caminho, {
      method: corpo ? 'POST' : 'GET',
      headers: Object.assign({ 'X-Cofilius-Extensao': painel.codigo }, corpo ? { 'Content-Type': 'application/json' } : {}),
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controle.signal,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Object.assign(new Error(json.erro || `Painel respondeu ${resp.status}`), { status: resp.status });
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('O painel demorou demais para responder.');
    if (e instanceof TypeError) throw new Error('Painel fechado ou endereço errado. Abra o Cofilius no computador.');
    throw e;
  } finally {
    clearTimeout(limite);
  }
}

function enfileirar(captura) {
  return emSerie(async () => {
    const { pendentes = [] } = await chrome.storage.local.get('pendentes');
    pendentes.push(N.mascarar({ tipo: 'resposta', url: captura.url, quando: captura.quando, resposta: captura.resposta }));
    await chrome.storage.local.set({ pendentes: pendentes.slice(-LIMITE_FILA) });
  }).then(enviarPendentes);
}

let enviando = false;
/** Manda a fila ao painel, em lotes de 10. Erro de rede: fica na fila para a próxima tentativa. */
async function enviarPendentes() {
  if (enviando) return;
  const painel = await pareamento();
  if (!painel) return;
  enviando = true;
  try {
    for (;;) {
      const { pendentes = [] } = await chrome.storage.local.get('pendentes');
      if (!pendentes.length) break;
      const lote = pendentes.slice(0, 10);
      let r;
      try {
        r = await chamarPainel(painel, '/extensao/receber', { capturas: lote });
      } catch (e) {
        await chrome.storage.local.set({ sincronia: { em: new Date().toISOString(), erro: e.message, naFila: pendentes.length } });
        if (e.status === 400) { // lote recusado pelo painel: descarta para não travar a fila
          await emSerie(async () => {
            const { pendentes: atual = [] } = await chrome.storage.local.get('pendentes');
            await chrome.storage.local.set({ pendentes: atual.slice(lote.length) });
          });
          continue;
        }
        break;
      }
      await emSerie(async () => {
        const { pendentes: atual = [] } = await chrome.storage.local.get('pendentes');
        await chrome.storage.local.set({
          pendentes: atual.slice(lote.length),
          sincronia: {
            em: new Date().toISOString(), erro: r.falhas && r.falhas.length ? r.falhas.join(' · ') : '',
            detalhe: (r.resultados || []).filter((x) => x.ok).map((x) => x.detalhe).join(' · '), naFila: atual.length - lote.length,
          },
        });
      });
    }
  } finally {
    enviando = false;
    await atualizarIcone();
  }
}

// ---------------------------------------------------------------------------
// Busca automática: abre os relatórios numa janela minimizada e fecha depois
// ---------------------------------------------------------------------------

/** Pedido dela no popup: abre os relatórios em abas normais, para ela navegar (sem fechar sozinho). */
async function abrirRelatorios() {
  if (!(await pareamento())) return { ok: false, erro: 'Pareie a extensão com o painel primeiro.' };
  for (const [i, url] of N.PAGINAS_BUSCA.entries()) await chrome.tabs.create({ url, active: i === 0 });
  return { ok: true };
}

async function buscarAgora() {
  if (!(await pareamento())) return { ok: false, erro: 'Pareie a extensão com o painel primeiro.' };
  const janela = await chrome.windows.create({ url: N.PAGINAS_BUSCA, focused: false, state: 'minimized' });
  await chrome.storage.local.set({ ultimaBusca: new Date().toISOString() });
  // Tempo para as páginas carregarem e as páginas seguintes dos relatórios chegarem.
  setTimeout(() => { chrome.windows.remove(janela.id).catch(() => {}); enviarPendentes(); }, 90000);
  return { ok: true };
}

chrome.alarms.onAlarm.addListener(async (alarme) => {
  if (alarme.name === 'reenviar') return enviarPendentes();
  if (alarme.name === 'buscar') {
    // Desligada por padrão: abrir relatórios sozinha é automação (termos da Shopee, 4.3(d)).
    const { buscaAutomatica = false } = await chrome.storage.local.get('buscaAutomatica');
    if (buscaAutomatica) await buscarAgora();
  }
});

function agendar() {
  chrome.alarms.create('reenviar', { periodInMinutes: 5 });
  chrome.alarms.create('buscar', { delayInMinutes: 2, periodInMinutes: HORAS_BUSCA * 60 });
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, remetente, responder) => {
  if (!msg || remetente.id !== chrome.runtime.id) return;
  const daExtensao = !!remetente.url && remetente.url.startsWith(chrome.runtime.getURL(''));

  if (msg.cofilius === 'captura' && msg.captura) {
    // Captura vinda de aba precisa ser de página permitida (painel de afiliados ou produto).
    if (!daExtensao && !(remetente.url && N.deveGravarPagina(remetente.url))) return;
    const c = msg.captura;
    if (!daExtensao && c.tipo === 'resposta' && c.status === 200 && N.tipoSincronia(c.url)) enfileirar(c);
    // "Salvar esta página" (vem do popup) grava mesmo com a gravação desligada.
    guardar(c, daExtensao && c.tipo === 'pagina');
    return;
  }
  if (!daExtensao) return; // o resto só vem do popup
  if (msg.cofilius === 'parear') {
    const painel = { endereco: String(msg.endereco || '').trim(), codigo: String(msg.codigo || '').trim() };
    chamarPainel(painel, '/extensao/estado')
      .then(async (r) => {
        await chrome.storage.local.set({ painel: Object.assign(painel, { cliente: r.cliente }), sincronia: {} });
        agendar();
        responder({ ok: true, cliente: r.cliente });
        enviarPendentes();
      })
      .catch((e) => responder({ ok: false, erro: e.message }));
    return true;
  }
  if (msg.cofilius === 'buscar') { abrirRelatorios().then(responder); return true; }
  if (msg.cofilius === 'enviar') { enviarPendentes().then(() => responder({ ok: true })); return true; }
});

chrome.storage.onChanged.addListener(() => { atualizarIcone(); });
chrome.runtime.onInstalled.addListener(() => { atualizarIcone(); agendar(); });
chrome.runtime.onStartup.addListener(() => { atualizarIcone(); agendar(); enviarPendentes(); });
