/**
 * Ponta a ponta da sincronia extensão → painel num Chromium de verdade, com uma página FALSA da Shopee
 * (requisições interceptadas) e um painel falso local. Confere: pareamento pelo popup, envio sem
 * gravação ligada, páginas seguintes do relatório pedidas com os mesmos cabeçalhos, e a fila quando
 * o painel recusa.
 *
 * Uso: node extensao/testar-sincronia-e2e.mjs
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright'); }
const { chromium } = playwright;

const CODIGO = 'cof-teste-1234567890';
const recebidas = [];
const painel = createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-cofilius-extensao'] !== CODIGO) { res.statusCode = 401; return res.end('{"erro":"código"}'); }
    if (req.url === '/extensao/estado') return res.end('{"ok":true,"cliente":"Silvana"}');
    if (req.url === '/extensao/receber') {
      const capturas = JSON.parse(corpo).capturas;
      recebidas.push(...capturas);
      return res.end(JSON.stringify({ ok: true, usados: capturas.length, falhas: [], resultados: capturas.map(() => ({ ok: true, detalhe: 'ok' })) }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((ok) => painel.listen(0, '127.0.0.1', ok));
const enderecoPainel = `http://127.0.0.1:${painel.address().port}`;

const pasta = dirname(fileURLToPath(import.meta.url));
const perfil = await mkdtemp(join(tmpdir(), 'cofilius-sinc-'));
const contexto = await chromium.launchPersistentContext(perfil, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${pasta}`, `--load-extension=${pasta}`],
});

const cabecalhosVistos = [];
await contexto.route('https://affiliate.shopee.com.br/**', (rota) => {
  const u = new URL(rota.request().url());
  if (u.pathname === '/offer/custom_link') {
    return rota.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Link</title><script>
      const gql = (op) => fetch('/api/v3/gql', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationName: op, query: 'query', variables: { linkParams: [{ originalLink: 'https://shopee.com.br/x-i.9.555',
          advancedLinkParams: { subId1: 'c1', subId2: 'ig', subId3: '20261117', subId4: '555', subId5: '1000' } }] } }) });
      gql('productsRankList'); gql('batchGetCustomLink');
    </script>` });
  }
  if (u.pathname === '/api/v3/gql') {
    return rota.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { batchCustomLink: [{ shortLink: 'https://s.shopee.com.br/IG1', longLink: 'x', failCode: 0 }] } }) });
  }
  if (u.pathname === '/report/conversion_report') {
    return rota.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Relatório</title><script>
      fetch('/api/v3/report/list?page_size=2&page_num=1&version=1', { headers: { 'x-csrftoken': 'abc' }, credentials: 'include' });
    </script>` });
  }
  if (u.pathname === '/api/v3/report/list') {
    const pagina = Number(u.searchParams.get('page_num'));
    cabecalhosVistos.push([pagina, rota.request().headers()['x-csrftoken']]);
    return rota.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: {
      page_num: pagina, page_size: 2, total_count: 5,
      list: [{ checkout_id: `K${pagina}`, utm_content: '----', purchase_time: 1794496500, orders: [] }],
    } }) });
  }
  return rota.fulfill({ contentType: 'application/json', body: '{}' });
});

let [sw] = contexto.serviceWorkers();
if (!sw) sw = await contexto.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;

// Pareia pelo popup.
const popup = await contexto.newPage();
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.fill('#endereco', enderecoPainel);
await popup.fill('#codigo', 'cof-errado-000000000');
await popup.click('#form-parear button');
await popup.waitForFunction(() => /inválido|código/i.test(document.getElementById('estado-painel').textContent));
await popup.fill('#codigo', CODIGO);
await popup.click('#form-parear button');
await popup.waitForSelector('#pareada:not([hidden])');
assert.match(await popup.textContent('#estado-painel'), /Silvana/);

// Sem a opção "ler páginas seguintes" (padrão): só a página que a própria página carregou.
const pag0 = await contexto.newPage();
await pag0.goto('https://affiliate.shopee.com.br/report/conversion_report');
const limite0 = Date.now() + 8000;
while (recebidas.length < 1 && Date.now() < limite0) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 2500));
assert.equal(recebidas.length, 1, 'com a paginação desligada, só a primeira página');
assert.equal(cabecalhosVistos.length, 1, 'nenhuma página extra pedida');
await pag0.close();
recebidas.length = 0;
cabecalhosVistos.length = 0;

// Com a opção ligada: as 3 páginas devem chegar ao painel.
await sw.evaluate(() => chrome.storage.local.set({ paginar: true }));
const pag = await contexto.newPage();
await pag.goto('https://affiliate.shopee.com.br/report/conversion_report');
const limite = Date.now() + 20000;
while (recebidas.length < 3 && Date.now() < limite) await new Promise((r) => setTimeout(r, 200));
assert.deepEqual(recebidas.map((c) => new URL(c.url).searchParams.get('page_num')).sort(), ['1', '2', '3']);
assert.deepEqual(cabecalhosVistos.map(([, h]) => h), ['abc', 'abc', 'abc'], 'páginas seguintes com os mesmos cabeçalhos');
assert.ok(recebidas.every((c) => c.resposta && c.resposta.json && c.resposta.json.code === 0));
const { capturas = [] } = await sw.evaluate(() => chrome.storage.local.get('capturas'));
assert.equal(capturas.length, 0, 'com a gravação desligada, nada é guardado no gravador');

// Link personalizado: do GraphQL, só a operação que gera o link vai para o painel (com o pedido, para ler os sub_ids).
recebidas.length = 0;
const pagLink = await contexto.newPage();
await pagLink.goto('https://affiliate.shopee.com.br/offer/custom_link');
const limiteLink = Date.now() + 10000;
while (recebidas.length < 1 && Date.now() < limiteLink) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 1500));
assert.equal(recebidas.length, 1, 'só o batchGetCustomLink');
assert.equal(recebidas[0].pedido.json.operationName, 'batchGetCustomLink');
assert.equal(recebidas[0].pedido.json.variables.linkParams[0].advancedLinkParams.subId2, 'ig');
await pagLink.close();

// Painel fechado: fica na fila.
await new Promise((ok) => painel.close(ok));
await pag.reload();
let fila = [];
const limite2 = Date.now() + 15000;
while (fila.length < 1 && Date.now() < limite2) {
  await new Promise((r) => setTimeout(r, 300));
  fila = (await sw.evaluate(() => chrome.storage.local.get('pendentes'))).pendentes || [];
}
assert.ok(fila.length >= 1, 'com o painel fechado, a captura fica na fila');
await popup.reload();
assert.match(await popup.textContent('#sincronia'), /fila/);

console.log(`ok: pareamento, paginação só quando ligada, link personalizado capturado, fila com painel fechado (${fila.length})`);
await contexto.close();
await rm(perfil, { recursive: true, force: true });
