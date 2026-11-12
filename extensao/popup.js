/* Popup do gravador: liga/desliga, salva a página atual, baixa o arquivo e limpa. */
'use strict';
const N = globalThis.CofiliusNucleo;
const $ = (id) => document.getElementById(id);

async function ler() {
  return chrome.storage.local.get({ gravando: false, capturas: [], aviso: '' });
}

function descrever(c) {
  if (c.tipo === 'visita') return `página · ${c.titulo || c.pagina}`;
  if (c.tipo === 'pagina') return `página salva · ${c.titulo || c.pagina}`;
  return `${c.metodo} ${c.status} · ${c.url}`;
}

async function desenhar() {
  const { gravando, capturas, aviso } = await ler();
  $('ponto').classList.toggle('ligado', gravando);
  $('estado').textContent = gravando ? 'Gravando' : 'Parado';
  $('alternar').textContent = gravando ? 'Parar de gravar' : 'Começar a gravar';
  const respostas = capturas.filter((c) => c.tipo === 'resposta').length;
  const paginas = capturas.length - respostas;
  $('contagem').textContent = capturas.length
    ? `${respostas} respostas de dados e ${paginas} páginas gravadas.`
    : 'Nada gravado.';
  $('aviso').hidden = !aviso;
  $('aviso').textContent = aviso;
  $('baixar').disabled = $('limpar').disabled = capturas.length === 0;
  $('lista').replaceChildren(
    ...capturas.slice(-12).reverse().map((c) => {
      const li = document.createElement('li');
      li.textContent = descrever(c);
      li.title = descrever(c);
      return li;
    }),
  );
}

$('alternar').addEventListener('click', async () => {
  const { gravando } = await ler();
  await chrome.storage.local.set({ gravando: !gravando, aviso: '' });
});

/** Roda na aba: copia o HTML visível, sem scripts e sem valores digitados em campos. */
function copiarPaginaNaAba() {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, iframe, link[rel="stylesheet"], svg, img, video').forEach((e) => e.remove());
  clone.querySelectorAll('input, textarea').forEach((e) => { e.removeAttribute('value'); e.textContent = ''; });
  return { url: location.href, titulo: document.title, html: clone.outerHTML };
}

$('pagina').addEventListener('click', async () => {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!aba || !aba.url || !N.deveGravar(aba.url)) {
    await chrome.storage.local.set({ aviso: 'Abra uma página do Mercado Livre para salvar.' });
    return;
  }
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: aba.id }, func: copiarPaginaNaAba });
  await chrome.runtime.sendMessage({
    cofilius: 'captura',
    captura: {
      tipo: 'pagina',
      quando: new Date().toISOString(),
      pagina: N.limparUrl(result.url),
      titulo: N.mascararTexto(result.titulo || ''),
      html: N.mascararTexto(result.html).slice(0, 3000000),
    },
  });
});

$('baixar').addEventListener('click', async () => {
  const { capturas } = await ler();
  const arquivo = N.montarArquivo(capturas, { versao: chrome.runtime.getManifest().version });
  const blob = new Blob([JSON.stringify(arquivo, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cofilius-mercadolivre-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

let confirmarLimpeza = false;
$('limpar').addEventListener('click', async () => {
  if (!confirmarLimpeza) {
    confirmarLimpeza = true;
    $('limpar').textContent = 'Clique de novo para apagar tudo';
    setTimeout(() => { confirmarLimpeza = false; $('limpar').textContent = 'Limpar tudo'; }, 4000);
    return;
  }
  confirmarLimpeza = false;
  $('limpar').textContent = 'Limpar tudo';
  await chrome.storage.local.set({ capturas: [], aviso: '' });
});

chrome.storage.onChanged.addListener(desenhar);
desenhar();
