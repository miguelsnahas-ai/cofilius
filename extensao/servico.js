/**
 * Service worker da extensão: guarda as capturas em chrome.storage.local, uma de cada vez
 * (fila), só enquanto a gravação está ligada, e mostra a contagem no ícone.
 */
importScripts('nucleo.js');
const N = globalThis.CofiliusNucleo;

let fila = Promise.resolve();

async function estado() {
  const { gravando = false, capturas = [] } = await chrome.storage.local.get(['gravando', 'capturas']);
  return { gravando, capturas };
}

async function atualizarIcone() {
  const { gravando, capturas } = await estado();
  await chrome.action.setBadgeBackgroundColor({ color: gravando ? '#c62828' : '#757575' });
  await chrome.action.setBadgeText({ text: gravando ? String(capturas.length) : capturas.length ? '■' : '' });
}

function guardar(captura, forcar) {
  fila = fila.then(async () => {
    const { gravando, capturas } = await estado();
    if (!gravando && !forcar) return;
    if (capturas.length >= N.LIMITE_CAPTURAS) {
      await chrome.storage.local.set({ gravando: false, aviso: `Limite de ${N.LIMITE_CAPTURAS} capturas atingido. Baixe o arquivo e limpe.` });
    } else {
      capturas.push(N.mascarar(captura)); // segunda máscara: nada é guardado sem passar por ela
      await chrome.storage.local.set({ capturas });
    }
    await atualizarIcone();
  }).catch((e) => console.error('Cofilius: falha ao guardar captura', e));
  return fila;
}

chrome.runtime.onMessage.addListener((msg, remetente) => {
  if (!msg || msg.cofilius !== 'captura' || !msg.captura) return;
  if (remetente.id !== chrome.runtime.id) return;
  const daExtensao = !!remetente.url && remetente.url.startsWith(chrome.runtime.getURL(''));
  // Captura vinda de aba precisa ser de página permitida (painel de afiliados ou produto).
  if (!daExtensao && !(remetente.url && N.deveGravarPagina(remetente.url))) return;
  // "Salvar esta página" (vem do popup) grava mesmo com a gravação desligada.
  guardar(msg.captura, daExtensao && msg.captura.tipo === 'pagina');
});

chrome.storage.onChanged.addListener(() => { atualizarIcone(); });
chrome.runtime.onInstalled.addListener(() => { atualizarIcone(); });
chrome.runtime.onStartup.addListener(() => { atualizarIcone(); });
