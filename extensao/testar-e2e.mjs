/**
 * Teste de ponta a ponta da extensão num Chromium de verdade, com páginas FALSAS do Mercado Livre
 * (as requisições são interceptadas; nada sai para a internet).
 *
 * Uso: node extensao/testar-e2e.mjs
 * Requer o pacote playwright e o Chromium instalados.
 */
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright'); }
const { chromium } = playwright;

const pasta = dirname(fileURLToPath(import.meta.url));
const perfil = await mkdtemp(join(tmpdir(), 'cofilius-e2e-'));
const contexto = await chromium.launchPersistentContext(perfil, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${pasta}`, `--load-extension=${pasta}`],
});

const PAGINA = `<!doctype html><html><head><title>Afiliados | Mercado Livre</title></head><body>
<h1>Painel</h1><div id="saida"></div><input id="campo" value="digitado">
<script>
  fetch('/afiliados/api/ganhos?access_token=SEGREDO').then(r => r.json()).then(d => {
    document.getElementById('saida').textContent = d.email + ' ' + d.total;
  });
  const x = new XMLHttpRequest();
  x.open('POST', 'https://api.mercadolibre.com/affiliates/links');
  x.setRequestHeader('Content-Type', 'application/json');
  x.send(JSON.stringify({ url: 'https://produto.mercadolivre.com.br/MLB-123', tag: 'wa-s46-casa' }));
  fetch('/melidata/tracks', { method: 'POST', body: '{}' });
</script></body></html>`;

await contexto.route('https://www.mercadolivre.com.br/**', (rota) => {
  const u = new URL(rota.request().url());
  if (u.pathname === '/afiliados/painel') return rota.fulfill({ contentType: 'text/html', body: PAGINA });
  if (u.pathname === '/afiliados/api/ganhos') {
    return rota.fulfill({ contentType: 'application/json', body: JSON.stringify({ email: 'dona@exemplo.com', total: 242.52, etiquetas: [{ nome: 'wa-s46-casa', cliques: 10 }] }) });
  }
  return rota.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
});
await contexto.route('https://api.mercadolibre.com/**', (rota) =>
  rota.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify({ short_url: 'https://mercadolivre.com/sec/AbC123', tag: 'wa-s46-casa' }),
  }),
);

// Páginas falsas da Shopee e da Amazon.
const paginaQueChama = (titulo, chamadas) => `<!doctype html><html><head><title>${titulo}</title></head><body><h1>${titulo}</h1><script>
  ${chamadas.map((c) => `fetch(${JSON.stringify(c)}).catch(() => {});`).join('\n')}
</script></body></html>`;
const json = (rota, corpo) => rota.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(corpo) });
await contexto.route('https://affiliate.shopee.com.br/**', (rota) => {
  const u = new URL(rota.request().url());
  if (u.pathname === '/report/conversion') return rota.fulfill({ contentType: 'text/html', body: paginaQueChama('Relatório de conversões', ['/api/v3/report/list?page=1', '/__t__/ping']) });
  return json(rota, { data: { list: [{ order_id: '1', sub_id1: 'c1', sub_id4: '22912345678', commission: '3.59', buyer_email: 'comprador@exemplo.com' }] } });
});
await contexto.route('https://shopee.com.br/**', (rota) => {
  const u = new URL(rota.request().url());
  if (u.pathname.includes('-i.')) return rota.fulfill({ contentType: 'text/html', body: paginaQueChama('Produto Shopee', ['/api/v4/affiliate/get_link?item=2', '/api/v4/pdp/get_pc?item=2']) });
  if (u.pathname === '/user/purchase') return rota.fulfill({ contentType: 'text/html', body: paginaQueChama('Minhas compras', ['/api/v4/affiliate/qualquer']) });
  return json(rota, { link: 'https://s.shopee.com.br/Xyz' });
});
await contexto.route('https://associados.amazon.com.br/**', (rota) => {
  const u = new URL(rota.request().url());
  if (u.pathname === '/home/reports') return rota.fulfill({ contentType: 'text/html', body: paginaQueChama('Relatórios | Associados', ['/home/reports/table.json?type=orders']) });
  return json(rota, { records: [{ asin: 'B0FH7C4YCS', tracking_id: 'loja-20', earnings: 1.2 }] });
});
await contexto.route('https://www.amazon.com.br/**', (rota) => {
  const u = new URL(rota.request().url());
  if (u.pathname.includes('/dp/')) return rota.fulfill({ contentType: 'text/html', body: paginaQueChama('Creme Weleda', ['/associates/sitestripe/getShortUrl?longUrl=x', '/gp/cart/view.json', '/1/events/com.amazon.csm']) });
  if (u.pathname.startsWith('/gp/css/')) return rota.fulfill({ contentType: 'text/html', body: paginaQueChama('Seus pedidos', ['/associates/sitestripe/getShortUrl?longUrl=y']) });
  return json(rota, { shortUrl: 'https://amzn.to/abc' });
});

let [sw] = contexto.serviceWorkers();
if (!sw) sw = await contexto.waitForEvent('serviceworker');
const idExtensao = new URL(sw.url()).host;
const popup = await contexto.newPage();
await popup.goto(`chrome-extension://${idExtensao}/popup.html`);
const capturas = () => popup.evaluate(() => chrome.storage.local.get({ capturas: [] }).then((r) => r.capturas));

// 1. Desligado: nada é gravado.
const pagina = await contexto.newPage();
await pagina.goto('https://www.mercadolivre.com.br/afiliados/painel');
await pagina.waitForTimeout(800);
assert.equal((await capturas()).length, 0, 'gravou com a gravação desligada');

// 2. Ligado: grava visita, fetch e XHR, mascarado; ignora métricas; a página recebe o dado original.
await popup.click('#gravador summary');
await popup.click('#alternar');
await popup.waitForFunction(() => document.getElementById('estado').textContent === 'Gravando');
await pagina.reload();
await pagina.waitForFunction(() => document.getElementById('saida').textContent.includes('242.52'));
await pagina.waitForTimeout(800);
assert.equal(await pagina.textContent('#saida'), 'dona@exemplo.com 242.52', 'a página não recebeu a resposta original');

let lista = await capturas();
const tipos = lista.map((c) => c.tipo + ' ' + (c.url || c.pagina));
console.log('Capturas:', tipos);
const ganhos = lista.find((c) => c.url && c.url.includes('/afiliados/api/ganhos'));
assert.ok(ganhos, 'não gravou o fetch');
assert.equal(ganhos.resposta.json.email, '***');
assert.equal(ganhos.resposta.json.total, 242.52);
assert.ok(ganhos.url.includes('access_token=***') && !ganhos.url.includes('SEGREDO'), 'vazou o token da URL');
const link = lista.find((c) => c.url && c.url.includes('api.mercadolibre.com/affiliates/links'));
assert.ok(link, 'não gravou o XHR');
assert.equal(link.metodo, 'POST');
assert.deepEqual(link.pedido.json, { url: 'https://produto.mercadolivre.com.br/MLB-123', tag: 'wa-s46-casa' });
assert.equal(link.resposta.json.short_url, 'https://mercadolivre.com/sec/AbC123');
assert.ok(!lista.some((c) => c.url && c.url.includes('melidata')), 'gravou métrica');
assert.ok(lista.some((c) => c.tipo === 'visita' && c.titulo === 'Afiliados | Mercado Livre'), 'não gravou a visita');
assert.equal(await popup.evaluate(() => chrome.action.getBadgeText({})), String(lista.length));

// 2b. Shopee e Amazon: grava painel e produto; ignora métricas, carrinho e páginas de compras.
for (const url of [
  'https://affiliate.shopee.com.br/report/conversion',
  'https://shopee.com.br/Organizador-i.1.2',
  'https://shopee.com.br/user/purchase',
  'https://associados.amazon.com.br/home/reports',
  'https://www.amazon.com.br/Creme-Weleda/dp/B0FH7C4YCS',
  'https://www.amazon.com.br/gp/css/order-history',
]) {
  await pagina.goto(url);
  await pagina.waitForTimeout(500);
}
lista = await capturas();
const urls = lista.map((c) => c.url || c.pagina);
const tem = (trecho) => urls.some((u) => u.includes(trecho));
assert.ok(tem('affiliate.shopee.com.br/api/v3/report/list'), 'Shopee: não gravou o relatório');
const conv = lista.find((c) => c.url && c.url.includes('report/list'));
assert.equal(conv.plataforma, 'shopee');
assert.equal(conv.resposta.json.data.list[0].buyer_email, '[email]', 'Shopee: e-mail do comprador vazou');
assert.ok(tem('/api/v4/affiliate/get_link'), 'Shopee: não gravou a chamada de afiliado na página de produto');
assert.ok(!tem('/api/v4/pdp/get_pc'), 'Shopee: gravou chamada da loja');
assert.ok(!tem('/__t__/'), 'Shopee: gravou métrica');
assert.ok(!tem('/user/purchase') && !tem('affiliate/qualquer'), 'Shopee: gravou página de compras');
assert.ok(tem('associados.amazon.com.br/home/reports/table.json'), 'Amazon: não gravou o relatório');
assert.equal(lista.find((c) => c.url && c.url.includes('table.json')).plataforma, 'amazon');
assert.ok(tem('sitestripe/getShortUrl?longUrl=x'), 'Amazon: não gravou o SiteStripe');
assert.ok(!tem('/gp/cart') && !tem('/1/events'), 'Amazon: gravou carrinho ou métrica');
assert.ok(!tem('order-history') && !tem('longUrl=y'), 'Amazon: gravou página de pedidos');
console.log('Shopee e Amazon OK:', lista.length, 'capturas no total');
await pagina.goto('https://www.mercadolivre.com.br/afiliados/painel');
await pagina.waitForTimeout(500);


// 3. Salvar página: HTML sem scripts e sem o valor digitado.
await pagina.bringToFront();
await popup.evaluate(async () => {
  // Simula o botão "Salvar esta página" apontando para a aba do Mercado Livre.
  const [aba] = (await chrome.tabs.query({})).filter((t) => t.url && t.url.includes('mercadolivre'));
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: aba.id },
    func: () => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, iframe, svg, img, video').forEach((e) => e.remove());
      clone.querySelectorAll('input, textarea').forEach((e) => { e.removeAttribute('value'); e.textContent = ''; });
      return { url: location.href, titulo: document.title, html: clone.outerHTML };
    },
  });
  await chrome.runtime.sendMessage({ cofilius: 'captura', captura: { tipo: 'pagina', quando: '', pagina: result.url, titulo: result.titulo, html: result.html } });
});
await popup.waitForTimeout(300);
lista = await capturas();
const salva = lista.find((c) => c.tipo === 'pagina');
assert.ok(salva && salva.html.includes('<h1>Painel</h1>'), 'não salvou a página');
assert.ok(!salva.html.includes('<script') && !salva.html.includes('digitado'), 'página salva com script ou valor digitado');

// 4. Baixar arquivo.
const [download] = await Promise.all([popup.waitForEvent('download'), popup.click('#baixar')]);
const arquivo = JSON.parse(await readFile(await download.path(), 'utf8'));
assert.equal(arquivo.formato, 'cofilius-gravacao');
assert.equal(arquivo.total, lista.length);
assert.ok(!JSON.stringify(arquivo).includes('dona@exemplo.com'), 'e-mail vazou no arquivo');
console.log('Arquivo baixado:', download.suggestedFilename(), `${arquivo.total} capturas`);

// 5. Parar: nada mais é gravado. 6. Limpar (dois cliques).
await popup.click('#alternar');
await popup.waitForFunction(() => document.getElementById('estado').textContent === 'Parado');
const antes = (await capturas()).length;
await pagina.reload();
await pagina.waitForTimeout(800);
assert.equal((await capturas()).length, antes, 'gravou depois de parar');
await popup.click('#limpar');
assert.equal((await capturas()).length, antes, 'apagou no primeiro clique');
await popup.click('#limpar');
await popup.waitForTimeout(200);
assert.equal((await capturas()).length, 0, 'não apagou');

await contexto.close();
await rm(perfil, { recursive: true, force: true });
console.log('E2E OK');
