import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Sql } from '../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../testes/banco.ts';
import { buscarCliente, type Cliente } from '../db/clientes.ts';
import type { ModeloIA } from '../harness/agentes.ts';
import { importarPlanilhaShopee } from '../services/ofertas/importarPlanilhaShopee.ts';
import { criarServidorPainel } from './servidor.ts';

const SENHA = 'senha-de-teste';
const DIA = '2026-11-12';
const PLANILHA = [
  'link;titulo;preco;desconto;comissao_valor;nicho',
  'https://shopee.com.br/A-i.9.1;Organizador de Gaveta;29,90;25;3,59;casa',
  'https://shopee.com.br/B-i.9.2;Kit Potes;49,90;40;4,99;casa',
].join('\n');

const modelo: ModeloIA = {
  async gerar(p) {
    if (p.sistema.includes('curador')) {
      const e = JSON.parse(p.entrada) as { candidatas: { id: string }[]; quantidade: number };
      return { texto: JSON.stringify({ escolhas: e.candidatas.slice(0, 2).map((c) => ({ oferta_id: c.id, motivo: 'bom desconto' })) }), tokensEntrada: 1, tokensSaida: 1 };
    }
    return { texto: '{"texto_modelo":"Achado do dia 😍 {{preco}} com {{desconto}} off 👉 {{link}}"}', tokensEntrada: 1, tokensSaida: 1 };
  },
};

describe.skipIf(!BANCO_HABILITADO)('painel do operador', () => {
  let sql: Sql;
  let cliente: Cliente;
  let servidor: Server;
  let base: string;
  const auth = { Authorization: `Basic ${Buffer.from(`op:${SENHA}`).toString('base64')}` };

  const get = (caminho: string) => fetch(base + caminho, { headers: auth });
  const post = async (caminho: string, corpo: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const r = await fetch(base + caminho, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Cofilius': '1', ...extra },
      body: JSON.stringify({ cliente: 'c1', ...corpo }),
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    sql = await bancoLimpo();
    cliente = await buscarCliente(sql, 'c1');
    servidor = criarServidorPainel({ sql, senha: SENHA, operador: 'Miguel', modelo: () => modelo });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });
  afterAll(async () => { servidor?.close(); await sql?.end(); });
  beforeEach(async () => {
    await sql`truncate mensagens, execucoes_agente, links, ofertas, diretrizes_nicho cascade`;
    await importarPlanilhaShopee(sql, cliente, PLANILHA, { quando: new Date('2026-11-12T09:00:00Z') });
  });

  it('exige senha; ação exige o cabeçalho de origem; página tem CSP', async () => {
    expect((await fetch(`${base}/api/clientes`)).status).toBe(401);
    expect((await fetch(`${base}/api/clientes`, { headers: { Authorization: `Basic ${Buffer.from('op:errada').toString('base64')}` } })).status).toBe(401);
    expect(await (await get('/api/clientes')).json()).toEqual([{ codigo: 'c1', nome: 'Cliente Teste' }]);
    const semCabecalho = await fetch(`${base}/api/curar`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"cliente":"c1"}' });
    expect(semCabecalho.status).toBe(403);
    const formulario = await fetch(`${base}/api/curar`, { method: 'POST', headers: { ...auth, 'X-Cofilius': '1', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'cliente=c1' });
    expect(formulario.status).toBe(403);
    const pagina = await get('/');
    expect(pagina.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await pagina.text()).toContain('Cofilius');
    expect((await get('/../package.json')).status).toBe(404);
  });

  it('fluxo do dia pela tela: Curador → link → Redator → validar → aprovar → enviada', async () => {
    let dia = await (await get(`/api/dia?cliente=c1&data=${DIA}`)).json() as Record<string, any>;
    expect(dia).toMatchObject({ candidatas: 2, selecionadas: [], mensagens: [], iaDisponivel: true, horarioEnvio: `${DIA} 08:00` });

    expect((await post('/api/curar', { data: DIA })).json).toMatchObject({ ok: true, escolhidas: 2 });
    dia = await (await get(`/api/dia?cliente=c1&data=${DIA}`)).json() as Record<string, any>;
    const [primeira] = dia.selecionadas;
    expect(primeira.preparoLink.subIds).toEqual(['c1', 'wa', '20261112', primeira.preparoLink.subIds[3], '0800']);
    expect(primeira.preparoLink.quando).toBe(`${DIA} 08:00`);

    const link = await post(`/api/ofertas/${primeira.ofertaId}/link`, { link: 'https://s.shopee.com.br/Tela1', quando: primeira.preparoLink.quando });
    expect(link.json.subIds).toEqual(primeira.preparoLink.subIds);
    expect((await post(`/api/ofertas/${primeira.ofertaId}/link`, { link: 'https://bit.ly/x', quando: primeira.preparoLink.quando })).status).toBe(400);

    expect((await post('/api/redigir', { data: DIA })).json).toMatchObject({ redigidas: 1, semLink: 1 });
    dia = await (await get(`/api/dia?cliente=c1&data=${DIA}`)).json() as Record<string, any>;
    const m = dia.mensagens[0];
    // a primeira escolhida é a de maior comissão (Kit Potes, R$ 49,90 com 40%)
    expect(m).toMatchObject({ estado: 'rascunho', titulo: 'Kit Potes', textoFinal: 'Achado do dia 😍 R$ 49,90 com 40% off 👉 https://s.shopee.com.br/Tela1' });

    expect((await post(`/api/mensagens/${m.id}/aprovar`, {})).json.erro).toContain('esperado: validada');
    expect((await post(`/api/mensagens/${m.id}/validar`, {})).json).toMatchObject({ ok: true, estado: 'validada' });
    expect((await post(`/api/mensagens/${m.id}/aprovar`, {})).json).toEqual({ ok: true });
    const [aprovada] = await sql`select aprovada_por from mensagens where id = ${m.id}`;
    expect(aprovada!.aprovada_por).toBe('Miguel');
    expect((await post(`/api/mensagens/${m.id}/enviada`, {})).json).toEqual({ ok: true });
    dia = await (await get(`/api/dia?cliente=c1&data=${DIA}`)).json() as Record<string, any>;
    expect(dia.mensagens[0].estado).toBe('enviada');
  });

  it('preço desatualizado barra o envio; confirmar preço libera; preço mudado descarta', async () => {
    await post('/api/curar', { data: DIA });
    let dia = await (await get(`/api/dia?cliente=c1&data=${DIA}`)).json() as Record<string, any>;
    for (const s of dia.selecionadas) {
      await post(`/api/ofertas/${s.ofertaId}/link`, { link: `https://s.shopee.com.br/P${s.posicao}`, quando: s.preparoLink.quando });
    }
    await post('/api/redigir', { data: DIA });
    dia = await (await get(`/api/dia?cliente=c1&data=${DIA}`)).json() as Record<string, any>;
    const [a, b] = dia.mensagens;
    for (const m of [a, b]) { await post(`/api/mensagens/${m.id}/validar`, {}); await post(`/api/mensagens/${m.id}/aprovar`, {}); }
    await sql`update ofertas set preco_conferido_em = now() - interval '2 hours'`;
    expect((await post(`/api/mensagens/${a.id}/enviada`, {})).json.erro).toContain('confira de novo');
    expect((await post(`/api/ofertas/${a.ofertaId}/preco`, { preco: a.preco.replace('.', ',') })).json).toEqual({ ok: true, preco: a.preco });
    expect((await post(`/api/mensagens/${a.id}/enviada`, {})).status).toBe(200);
    await post(`/api/ofertas/${b.ofertaId}/preco`, { preco: '59,90' });
    expect((await post(`/api/mensagens/${b.id}/enviada`, {})).json.erro).toContain('preço mudou');
    const [descartada] = await sql`select estado from mensagens where id = ${b.id}`;
    expect(descartada!.estado).toBe('descartada');
  });

  it('descartar com motivo; propostas de diretriz aparecem e são aprovadas', async () => {
    await sql`insert into diretrizes_nicho (cliente_id, nicho, versao, texto, proposta_por) values (${cliente.clienteId}, 'casa', 1, 'Priorizar cozinha.', 'analista')`;
    const dia = await (await get(`/api/dia?cliente=c1&data=${DIA}`)).json() as Record<string, any>;
    expect(dia.propostas).toEqual([expect.objectContaining({ nicho: 'casa', versao: 1, propostaPor: 'analista' })]);
    expect((await post(`/api/diretrizes/${dia.propostas[0].id}/aprovar`, {})).json).toEqual({ ok: true });
    const [d] = await sql`select situacao from diretrizes_nicho`;
    expect(d!.situacao).toBe('aprovada');
    expect((await post('/api/mensagens/00000000-0000-4000-8000-000000000000/descartar', { motivo: 'x' })).status).toBe(400);
    expect((await post('/api/curar', { cliente: 'zz' })).json.erro).toContain('não encontrado');
  });

  it('sem IA configurada, Curador e Redator respondem com orientação', async () => {
    const semIa = criarServidorPainel({ sql, senha: SENHA, operador: 'op' });
    await new Promise<void>((ok) => semIa.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(semIa.address() as AddressInfo).port}`;
    const r = await fetch(`${url}/api/curar`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Cofilius': '1' }, body: '{"cliente":"c1"}' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { erro: string }).erro).toContain('ANTHROPIC_API_KEY');
    semIa.close();
  });

  it('não sobe sem senha', () => {
    expect(() => criarServidorPainel({ sql, senha: '', operador: 'op' })).toThrow('PAINEL_SENHA');
  });
});
