/* Popup do gravador: liga/desliga, salva a página atual, baixa o arquivo e limpa. */
'use strict';
const N = globalThis.CofiliusNucleo;
const $ = (id) => document.getElementById(id);

async function ler() {
  return chrome.storage.local.get({ gravando: false, capturas: [], aviso: '' });
}

function descrever(c) {
  const p = (N.PLATAFORMAS.find((x) => x.id === c.plataforma) || { nome: '?' }).nome;
  if (c.tipo === 'visita') return `${p} · página · ${c.titulo || c.pagina}`;
  if (c.tipo === 'pagina') return `${p} · página salva · ${c.titulo || c.pagina}`;
  return `${p} · ${c.metodo} ${c.status} · ${c.url}`;
}

async function desenhar() {
  const { gravando, capturas, aviso } = await ler();
  if (gravando || capturas.length) $('gravador').open = true;
  $('ponto').classList.toggle('ligado', gravando);
  $('estado').textContent = gravando ? 'Gravando' : 'Parado';
  $('alternar').textContent = gravando ? 'Parar de gravar' : 'Começar a gravar';
  $('contagem').textContent = capturas.length
    ? N.PLATAFORMAS.map((p) => {
        const daqui = capturas.filter((c) => c.plataforma === p.id);
        const respostas = daqui.filter((c) => c.tipo === 'resposta').length;
        return `${p.nome}: ${respostas} dados, ${daqui.length - respostas} páginas`;
      }).join(' · ')
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
  if (!aba || !aba.url || !N.deveGravarPagina(aba.url)) {
    await chrome.storage.local.set({ aviso: 'Abra uma página de afiliado (ou de produto) do Mercado Livre, Shopee ou Amazon para salvar.' });
    return;
  }
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: aba.id }, func: copiarPaginaNaAba });
  await chrome.runtime.sendMessage({
    cofilius: 'captura',
    captura: {
      tipo: 'pagina',
      plataforma: N.idPlataforma(result.url),
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
  a.download = `cofilius-gravacao-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
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

// ---------------------------------------------------------------------------
// Painel: pareamento, estado da sincronia, busca
// ---------------------------------------------------------------------------

function quando(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function desenharPainel() {
  const { painel = null, sincronia = {}, buscaAutomatica = false, paginar = false, pendentes = [], ultimaBusca = '' } =
    await chrome.storage.local.get(['painel', 'sincronia', 'buscaAutomatica', 'paginar', 'pendentes', 'ultimaBusca']);
  const pareada = !!(painel && painel.codigo);
  $('form-parear').hidden = pareada;
  $('pareada').hidden = !pareada;
  $('estado-painel').textContent = pareada ? `Pareada com o painel · cliente ${painel.cliente}` : 'Não pareada.';
  $('estado-painel').className = pareada ? 'ok' : 'suave';
  $('busca-auto').checked = buscaAutomatica;
  $('paginar').checked = paginar;
  const partes = [];
  if (sincronia.em) partes.push(`Último envio ${quando(sincronia.em)}`);
  if (sincronia.detalhe) partes.push(sincronia.detalhe);
  if (sincronia.erro) partes.push(`Atenção: ${sincronia.erro}`);
  if (pendentes.length) partes.push(`${pendentes.length} na fila`);
  if (ultimaBusca) partes.push(`Última busca ${quando(ultimaBusca)}`);
  $('sincronia').textContent = partes.join(' · ') || 'Nada enviado ainda. Abra o relatório de conversões e o de cliques da Shopee (e passe pelas páginas da tabela): os dados vão sozinhos para o painel.';
  $('sincronia').className = sincronia.erro ? 'aviso' : 'suave';
}

$('form-parear').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const botao = ev.currentTarget.querySelector('button');
  botao.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ cofilius: 'parear', endereco: $('endereco').value, codigo: $('codigo').value });
    $('estado-painel').textContent = r.ok ? `Pareada · cliente ${r.cliente}` : r.erro;
    $('estado-painel').className = r.ok ? 'ok' : 'aviso';
    if (r.ok) $('codigo').value = '';
  } finally {
    botao.disabled = false;
  }
});

const AVISO_AUTOMACAO = 'Os termos da Shopee proíbem extração automatizada de dados (item 4.3(d)). Ligar isto aumenta o risco de bloqueio da conta. Ligar mesmo assim?';
$('busca-auto').addEventListener('change', (ev) => {
  if (ev.target.checked && !window.confirm(AVISO_AUTOMACAO)) { ev.target.checked = false; return; }
  chrome.storage.local.set({ buscaAutomatica: ev.target.checked });
});
$('paginar').addEventListener('change', (ev) => {
  if (ev.target.checked && !window.confirm(AVISO_AUTOMACAO)) { ev.target.checked = false; return; }
  chrome.storage.local.set({ paginar: ev.target.checked });
});

$('buscar').addEventListener('click', async () => {
  $('buscar').disabled = true;
  const r = await chrome.runtime.sendMessage({ cofilius: 'buscar' });
  $('sincronia').textContent = r.ok
    ? 'Abri os relatórios de conversões e de cliques. Passe pelas páginas da tabela; os dados vão sozinhos para o painel.'
    : r.erro;
  setTimeout(() => { $('buscar').disabled = false; }, 3000);
});

$('despareada').addEventListener('click', async () => {
  const { painel } = await chrome.storage.local.get('painel');
  if (painel) $('endereco').value = painel.endereco;
  await chrome.storage.local.remove('painel');
});

chrome.storage.onChanged.addListener(desenharPainel);
desenharPainel();
