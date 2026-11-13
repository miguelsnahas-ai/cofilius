import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
import type { Sql } from '../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo, URL_TESTE } from '../testes/banco.ts';
import { criarAplicacao, criarServidorPainel, type DepsPainel } from './servidor.ts';
import { criarEsteiraAutomatica } from './esteiraAutomatica.ts';

const SENHA = 'senha-teste';
const auth = (s = SENHA) => ({ Authorization: `Basic ${Buffer.from(`x:${s}`).toString('base64')}` });

async function ouvir(servidor: Server): Promise<string> {
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
}

describe.skipIf(!BANCO_HABILITADO)('painel: telas de gestão e configuração', () => {
  let sql: Sql;
  let servidor: Server;
  let base: string;
  let deps: DepsPainel;
  const get = async (c: string, s = SENHA) => { const r = await fetch(base + c, { headers: auth(s) }); return { status: r.status, json: (await r.json().catch(() => null)) as any, r }; };
  const post = async (c: string, corpo: Record<string, unknown>) => {
    const r = await fetch(base + c, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json', 'X-Cofilius': '1' }, body: JSON.stringify(corpo) });
    return { status: r.status, json: (await r.json()) as any };
  };

  beforeAll(async () => {
    sql = await bancoLimpo();
    process.env.CREDENCIAIS_CHAVE = randomBytes(32).toString('base64');
    deps = { sql, senha: SENHA, operador: 'Miguel' };
    servidor = criarServidorPainel(deps);
    base = await ouvir(servidor);
  });
  afterAll(async () => { servidor?.close(); await sql?.end(); delete process.env.CREDENCIAIS_CHAVE; });

  it('clientes: cadastrar, editar, nichos, Shopee e pausar pela tela', async () => {
    expect((await post('/api/gestao/clientes', { codigo: 'Ana', nome: 'Ana', whatsapp: '(11) 98888-7777', horarioEnvio: '09:00', limiteMensagensDia: '6' })).json).toEqual({ ok: true, codigo: 'ana' });
    expect((await post('/api/gestao/clientes', { codigo: 'ana', nome: 'De novo' })).json.erro).toContain('Já existe');
    expect((await post('/api/gestao/clientes/ana', { tomGrupo: 'Divertido', limiteMensagensDia: '4' })).json).toEqual({ ok: true });
    expect((await post('/api/gestao/clientes/ana/nichos', { nome: 'Pets', palavras: 'ração, arranhador\ncoleira' })).json.nichos)
      .toEqual([{ slug: 'pets', nome: 'Pets', palavras_chave: ['ração', 'arranhador', 'coleira'] }]);
    expect((await post('/api/gestao/clientes/ana/shopee', { appId: 'APP', secret: 'SEGREDO' })).json).toEqual({ ok: true });
    const [cred] = await sql`select valor_cifrado from credenciais`;
    expect(cred!.valor_cifrado).not.toContain('SEGREDO');
    let lista = (await get('/api/gestao/clientes')).json;
    const ana = lista.find((c: any) => c.codigo === 'ana');
    expect(ana).toMatchObject({ whatsapp: '5511988887777', horarioEnvio: '09:00', limiteMensagensDia: 4, tomGrupo: 'Divertido', shopeeApi: true, ativo: true });
    expect(ana.clienteId).toBeUndefined();
    expect((await post('/api/diretrizes', { cliente: 'ana', nicho: 'pets', texto: 'Só ração premium.' })).json).toMatchObject({ ok: true, versao: 1 });
    expect((await get('/api/diretrizes?cliente=ana')).json[0]).toMatchObject({ nicho: 'pets', situacao: 'proposta' });
    expect((await post('/api/gestao/clientes/ana/nichos/pets/remover', {})).json.nichos).toEqual([]);
    expect((await post('/api/gestao/clientes/ana/ativo', { ativo: false })).json).toEqual({ ok: true });
    lista = (await get('/api/clientes')).json;
    expect(lista.map((c: any) => c.codigo)).toEqual(['c1']);
  });

  it('importar ofertas e vendas pela tela; modelos para baixar', async () => {
    const ofertas = await post('/api/importar/ofertas', { cliente: 'c1', nicho: 'casa', csv: 'link;titulo;preco\nhttps://shopee.com.br/A-i.9.1;Produto A;10,00\nhttps://s.shopee.com.br/x;Curto;5' });
    expect(ofertas.json).toMatchObject({ ok: true, gravadas: 1, novas: 1, erros: [{ linha: 3 }] });
    const vendas = await post('/api/importar/vendas', { cliente: 'c1', csv: 'plataforma;pedido;produto;comissao;situacao;data\nshopee;P1;1;2,50;pendente;10/03/2026\nloja;P2;2;1;pendente;10/03/2026' });
    expect(vendas.json.resultado).toMatchObject({ total: 1, novas: 1, naoAtribuidas: 1 });
    expect(vendas.json.erros).toEqual([{ linha: 3, motivo: expect.stringContaining('plataforma') }]);
    const modelo = await fetch(`${base}/modelos/vendas.csv`, { headers: auth() });
    expect(modelo.headers.get('content-disposition')).toContain('vendas.csv');
    expect(await modelo.text()).toContain('plataforma;pedido');
    expect((await fetch(`${base}/modelos/..%2F.env`, { headers: auth() })).status).toBe(404);
  });

  it('extensão: pareia pelo painel e manda dados sem a senha do painel', async () => {
    const { json } = await post('/api/extensao/parear', { cliente: 'c1' });
    expect(json.codigo).toMatch(/^cof-/);
    const ext = (caminho: string, codigo: string, corpo?: unknown, extra: Record<string, string> = {}) => fetch(base + caminho, {
      method: corpo ? 'POST' : 'GET',
      headers: { 'X-Cofilius-Extensao': codigo, ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...extra },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    expect((await ext('/extensao/estado', 'cof-errado-1234567')).status).toBe(401);
    expect(await (await ext('/extensao/estado', json.codigo)).json()).toEqual({ ok: true, cliente: 'Cliente Teste' });
    const capturas = [{ tipo: 'resposta', url: 'https://www.amazon.com.br/associates/sitestripe/getShortUrl?storeId=loja-20',
      resposta: { json: { ok: true, longUrl: 'https://www.amazon.com.br/x/dp/B0DMTGP55X', shortUrl: 'https://link.amazon/abc' } } }];
    const r = await (await ext('/extensao/receber', json.codigo, { capturas })).json();
    expect(r).toMatchObject({ ok: true, usados: 1, falhas: [] });
    expect((await fetch(base + '/extensao/receber', { method: 'POST', headers: { 'X-Cofilius-Extensao': json.codigo, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const est = (await get('/api/extensao?cliente=c1')).json;
    expect(est).toMatchObject({ pareado: true, ultimos: [{ tipo: 'amazon.link', erro: null }] });
    // gravação inteira pelo Importar
    const gr = await post('/api/importar/gravacao', { cliente: 'c1', json: JSON.stringify({ formato: 'cofilius-gravacao', capturas }) });
    expect(gr.json).toMatchObject({ ok: true, usados: 1 });
    expect((await post('/api/importar/gravacao', { cliente: 'c1', json: '{"x":1}' })).json.erro).toContain('gravação');
    // O Dia sabe que a extensão mandou dados; Resultados responde pelo período e recusa plataforma inventada.
    expect((await get('/api/dia?cliente=c1')).json.extensao.ultimoRecebimento).toBeTruthy();
    const res = await get('/api/resultados?cliente=c1&de=2026-11-01&ate=2026-11-07&plataforma=shopee');
    expect(res.json.dias).toHaveLength(7);
    expect((await get('/api/resultados?cliente=c1&de=2026-11-01&ate=2026-11-07&plataforma=ebay')).json.erro).toContain('Plataforma');
  });

  it('fechamento, uso e esteira pela tela', async () => {
    const f = await post('/api/fechamento', { cliente: 'c1', de: '2026-01-01', ate: '2030-12-31' });
    expect(f.json.texto).toContain('⏳ R$ 2,50 pendente');
    expect(f.json.textoOperador).toContain('Comissão pendente: R$ 2,50');
    // Fica pronto no Dia e é marcado como enviado por lá.
    const dia = (await get('/api/dia?cliente=c1&data=2030-12-31')).json;
    expect(dia.fechamento).toMatchObject({ id: f.json.fechamentoId, situacao: 'pronto' });
    expect((await post(`/api/fechamentos/${f.json.fechamentoId}/whatsapp`, { cliente: 'c1' })).json.erro).toContain('não configurado');
    expect((await post(`/api/fechamentos/${f.json.fechamentoId}/enviado`, { cliente: 'c1' })).json).toEqual({ ok: true, situacao: 'enviado' });
    expect((await post(`/api/fechamentos/${f.json.fechamentoId}/enviado`, { cliente: 'c1' })).json.erro).toContain('já foi enviado');
    expect((await get('/api/dia?cliente=c1&data=2030-12-31')).json.fechamento).toBeNull();
    // Avisos de cancelamento: a venda P1 (pendente) cai e aparece no Dia até o operador dar ciência.
    await post('/api/importar/vendas', { cliente: 'c1', csv: 'plataforma;pedido;produto;comissao;situacao;data\nshopee;P1;1;2,50;cancelada;10/03/2026' });
    expect((await get('/api/dia?cliente=c1&data=2030-12-31')).json.cancelamentos).toMatchObject([{ pedidoId: 'P1', comissao: '2.50' }]);
    expect((await post('/api/cancelamentos/vistos', { cliente: 'c1' })).json).toEqual({ ok: true, vistos: 1 });
    expect((await get('/api/dia?cliente=c1&data=2030-12-31')).json.cancelamentos).toEqual([]);
    // Criativos: tela abre, criar sem IA explica, foto de outro site é recusada.
    const cr = (await get('/api/criativos?cliente=c1&data=2026-03-10')).json;
    expect(cr).toMatchObject({ data: '2026-03-10', iaDisponivel: false, criativos: [] });
    expect((await post('/api/criativos', { cliente: 'c1', formato: 'reels', ofertaId: '00000000-0000-0000-0000-000000000000' })).json.erro).toContain('chave da IA');
    const img = await get('/api/imagem?url=' + encodeURIComponent('https://exemplo.com/x.jpg'));
    expect(img.status).toBe(400);
    expect(img.json.erro).toContain('não permitido');
    // Conformidade: lista com fonte, itens marcados, identificação validada e aviso no Dia.
    let conf = (await get('/api/conformidade?cliente=c1')).json;
    expect(conf.identificacao).toBe('#publi');
    const pendentesAntes = conf.pendentes;
    expect(pendentesAntes).toBeGreaterThan(5);
    expect((await get('/api/dia?cliente=c1&data=2030-12-31')).json.conformidadePendente).toBe(pendentesAntes);
    expect((await post('/api/conformidade/item', { cliente: 'c1', item: 'sem_autocompra', feito: true })).json).toEqual({ ok: true });
    expect((await post('/api/conformidade/item', { cliente: 'c1', item: 'identificacao', feito: true })).json.erro).toContain('desconhecido');
    conf = (await get('/api/conformidade?cliente=c1')).json;
    expect(conf.pendentes).toBe(pendentesAntes - 1);
    expect(conf.regras.find((r: any) => r.id === 'sem_autocompra').feitoEm).toBeTruthy();
    await post('/api/conformidade/item', { cliente: 'c1', item: 'sem_autocompra', feito: false });
    expect((await get('/api/conformidade?cliente=c1')).json.pendentes).toBe(pendentesAntes);
    expect((await post('/api/conformidade/identificacao', { cliente: 'c1', identificacao: 'oi' })).json.erro).toContain('3 a 40');
    expect((await post('/api/conformidade/identificacao', { cliente: 'c1', identificacao: 'Promo top' })).json.erro).toContain('publicidade');
    expect((await post('/api/conformidade/identificacao', { cliente: 'c1', identificacao: 'Publicidade' })).json).toEqual({ ok: true, identificacao: 'Publicidade' });
    await post('/api/conformidade/identificacao', { cliente: 'c1', identificacao: '#publi' });
    expect((await post('/api/fechamento', { cliente: 'c1', de: '2026-01-01', ate: '2026-01-31', comAnalise: true })).json.erro).toContain('IA');
    expect((await post('/api/fechamento', { cliente: 'c1', de: '2026-02-01', ate: '2026-01-01' })).json.erro).toContain('depois');
    const u = await get('/api/uso?de=2026-01-01&ate=2030-12-31');
    expect(u.json.find((x: any) => x.codigo === 'c1').acoes).toBeGreaterThan(0);
    expect((await get('/api/esteira')).json).toMatchObject({ ligada: false, tarefas: [] });
    expect((await post('/api/agentes/testar', { cliente: 'c1', agente: 'redator' })).json.erro).toContain('chave da IA');
  });

  it('configuração: troca nome, senha e liga a IA sem reiniciar; nunca devolve a chave', async () => {
    const pasta = await mkdtemp(join(tmpdir(), 'painel-'));
    const arquivoEnv = join(pasta, '.env');
    const d: DepsPainel = { sql, senha: SENHA, operador: 'op' };
    const app = criarAplicacao({ deps: d, arquivoEnv, criarEsteira: (x) => criarEsteiraAutomatica(x, { intervaloMs: 3_600_000 }) });
    const url = await ouvir(app);
    const enviar = (corpo: object, s = SENHA) => fetch(`${url}/api/config`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json', 'X-Cofilius': '1' }, body: JSON.stringify(corpo) }).then((r) => r.json() as any);
    expect(await enviar({ operador: 'Miguel', geminiKey: 'chave-gemini-teste', esteiraLigada: false, novaSenha: 'nova-senha' })).toEqual({ ok: true, senhaAlterada: true });
    expect((await fetch(`${url}/api/config`, { headers: auth() })).status).toBe(401);
    const cfg = await (await fetch(`${url}/api/config`, { headers: auth('nova-senha') })).json() as any;
    expect(cfg).toMatchObject({ operador: 'Miguel', ia: true, provedor: 'gemini', chaveGemini: true, esteiraLigada: false, modeloPequeno: 'gemini-3.5-flash-lite', modeloForte: 'gemini-4-hydrogen' });
    expect(JSON.stringify(cfg)).not.toContain('chave-gemini-teste');
    const env = parse(await readFile(arquivoEnv, 'utf8'));
    expect(env).toMatchObject({ PAINEL_OPERADOR: 'Miguel', GEMINI_API_KEY: 'chave-gemini-teste', PAINEL_SENHA: 'nova-senha', PAINEL_ESTEIRA: 'desligada' });
    // trocar para o Claude sem a chave dele desliga a IA, e os modelos voltam ao padrão do Claude
    expect(await enviar({ provedor: 'claude', modeloPequeno: 'gemini-3.5-flash-lite' }, 'nova-senha')).toMatchObject({ ok: true });
    const cfg2 = await (await fetch(`${url}/api/config`, { headers: auth('nova-senha') })).json() as any;
    expect(cfg2).toMatchObject({ provedor: 'claude', ia: false, modeloPequeno: 'claude-haiku-5-5' });
    expect(await enviar({ provedor: 'openai' }, 'nova-senha')).toMatchObject({ erro: expect.stringContaining('desconhecido') });
    expect(await enviar({ novaSenha: '123' }, 'nova-senha')).toMatchObject({ erro: expect.stringContaining('6 caracteres') });
    app.close();
    for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'IA_PROVEDOR', 'MODELO_IA_PEQUENO', 'MODELO_IA_FORTE', 'PAINEL_SENHA', 'PAINEL_OPERADOR', 'PAINEL_ESTEIRA']) delete process.env[k];
  });

  it('modo configuração: só a tela inicial; configurar conecta, grava o .env e entra no modo normal', async () => {
    const pasta = await mkdtemp(join(tmpdir(), 'painel-'));
    const arquivoEnv = join(pasta, '.env');
    let preparado = '';
    const app = criarAplicacao({
      deps: null, arquivoEnv,
      prepararBanco: async (u) => { preparado = u; return sql; },
      montarDeps: (s) => ({ sql: s, senha: process.env.PAINEL_SENHA!, operador: process.env.PAINEL_OPERADOR! }),
    });
    const url = await ouvir(app);
    const chaveAntes = process.env.CREDENCIAIS_CHAVE;
    delete process.env.CREDENCIAIS_CHAVE; // primeira configuração: o painel gera a chave
    expect(await (await fetch(`${url}/api/estado`)).json()).toEqual({ modo: 'configuracao' });
    expect(await (await fetch(`${url}/`)).text()).toContain('Vamos ligar o seu painel');
    expect((await fetch(`${url}/api/clientes`)).status).toBe(503);
    const configurar = (corpo: object) => fetch(`${url}/api/configurar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cofilius': '1' }, body: JSON.stringify(corpo) });
    expect((await (await configurar({ databaseUrl: 'mysql://x', senha: '123456' })).json() as any).erro).toContain('postgresql://');
    expect((await (await configurar({ databaseUrl: 'postgresql://u:[YOUR-PASSWORD]@h/db', senha: '123456' })).json() as any).erro).toContain('YOUR-PASSWORD');
    expect((await (await configurar({ databaseUrl: URL_TESTE, senha: '12' })).json() as any).erro).toContain('6 caracteres');
    expect((await configurar({ databaseUrl: URL_TESTE, senha: 'minha-senha', operador: 'Miguel' })).status).toBe(200);
    expect(preparado).toBe(URL_TESTE);
    const env = parse(await readFile(arquivoEnv, 'utf8'));
    expect(env).toMatchObject({ DATABASE_URL: URL_TESTE, PAINEL_SENHA: 'minha-senha', PAINEL_OPERADOR: 'Miguel' });
    expect(Buffer.from(env.CREDENCIAIS_CHAVE!, 'base64')).toHaveLength(32);
    expect((await fetch(`${url}/api/estado`)).status).toBe(401);
    expect(await (await fetch(`${url}/api/estado`, { headers: auth('minha-senha') })).json()).toEqual({ modo: 'normal' });
    app.close();
    for (const k of ['DATABASE_URL', 'PAINEL_SENHA', 'PAINEL_OPERADOR']) delete process.env[k];
    process.env.CREDENCIAIS_CHAVE = chaveAntes;
  });
});
