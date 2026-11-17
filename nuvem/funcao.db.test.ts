import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Sql } from '../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../testes/banco.ts';
import { criarFuncao, restaurarCaminho } from './funcao.ts';

describe('caminho reescrito pelo Vercel', () => {
  it('devolve o caminho original e mantém a busca', () => {
    expect(restaurarCaminho('/index?__caminho=api/dia&cliente=c1')).toBe('/api/dia?cliente=c1');
    expect(restaurarCaminho('/index?__caminho=')).toBe('/');
    expect(restaurarCaminho('/index?__caminho=api/cron/esteira&rodada=noite')).toBe('/api/cron/esteira?rodada=noite');
    expect(restaurarCaminho('/api/estado')).toBe('/api/estado');
  });
});

describe.skipIf(!BANCO_HABILITADO)('função da nuvem', () => {
  let sql: Sql;
  let srv: Server;
  let base: string;
  const SENHA = 'senha-da-nuvem-123';
  const ambienteAntes = { ...process.env };
  const auth = (s = SENHA) => ({ Authorization: `Basic ${Buffer.from(`x:${s}`).toString('base64')}` });

  beforeAll(async () => {
    sql = await bancoLimpo();
    Object.assign(process.env, { PAINEL_SENHA: SENHA, CREDENCIAIS_CHAVE: Buffer.alloc(32, 3).toString('base64'), CRON_SECRET: 'segredo' });
    delete process.env.GEMINI_API_KEY;
    const handler = criarFuncao({ sql, agora: () => new Date('2026-11-17T09:20:00Z') });
    srv = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      const b = new URLSearchParams(u.search);
      b.set('__caminho', u.pathname.slice(1));
      req.url = `/index?${b}`;
      void handler(req, res);
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    srv?.close();
    await sql?.end();
    for (const k of ['PAINEL_SENHA', 'CREDENCIAIS_CHAVE', 'CRON_SECRET', 'GEMINI_API_KEY', 'PAINEL_OPERADOR']) {
      if (ambienteAntes[k] === undefined) delete process.env[k]; else process.env[k] = ambienteAntes[k];
    }
  });

  it('senha, telas, configuração no banco (chave cifrada) e senha só pelo Vercel', async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/`, { headers: auth() })).status).toBe(200);
    const post = (c: string, corpo: unknown) => fetch(base + c, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json', 'X-Cofilius': '1' }, body: JSON.stringify(corpo) });
    expect(await (await post('/api/config', { geminiKey: 'AIza-teste', operador: 'Miguel' })).json()).toEqual({ ok: true, senhaAlterada: false });
    expect((await (await post('/api/config', { novaSenha: 'outra-senha-bem-longa' })).json()).erro).toContain('PAINEL_SENHA');
    const linhas = await sql`select chave, valor, cifrado from configuracoes order by chave`;
    expect(linhas.map((l) => [l.chave, l.cifrado])).toEqual([['GEMINI_API_KEY', true], ['PAINEL_OPERADOR', false]]);
    expect(linhas[0]!.valor).not.toContain('AIza-teste');
    // Outra instância (process.env limpo) lê do banco a cada pedido.
    delete process.env.GEMINI_API_KEY;
    const cfg = await (await fetch(`${base}/api/config`, { headers: auth() })).json();
    expect(cfg).toMatchObject({ chaveGemini: true, operador: 'Miguel', nuvem: true });
  });

  it('agendador: segredo obrigatório; rodada da manhã roda o que vence até as 7h', async () => {
    expect((await fetch(`${base}/api/cron/esteira?rodada=manha`)).status).toBe(401);
    expect((await fetch(`${base}/api/cron/esteira?rodada=manha`, { headers: { Authorization: 'Bearer errado' } })).status).toBe(401);
    const r = await (await fetch(`${base}/api/cron/esteira?rodada=manha`, { headers: { Authorization: 'Bearer segredo' } })).json();
    expect(r).toMatchObject({ ok: true, rodada: 'manha', dia: '2026-11-17' });
    const tarefas = await sql`select tipo, estado from tarefas where cliente_id is not null order by agendada_para`;
    expect(tarefas.filter((t) => t.estado === 'pendente').map((t) => t.tipo)).toEqual([]); // nada da manhã ficou para trás
  });

  it('bloqueia o IP depois de dez senhas erradas, sem afetar outros', async () => {
    for (let i = 0; i < 10; i++) await fetch(`${base}/api/estado`, { headers: { ...auth('errada'), 'X-Forwarded-For': '203.0.113.5' } });
    expect((await fetch(`${base}/api/estado`, { headers: { ...auth(), 'X-Forwarded-For': '203.0.113.5' } })).status).toBe(429);
    expect((await fetch(`${base}/api/estado`, { headers: { ...auth(), 'X-Forwarded-For': '203.0.113.6' } })).status).toBe(200);
  });

  it('senha curta demais na internet: avisa e não abre', async () => {
    process.env.PAINEL_SENHA = 'curta';
    const r = await fetch(`${base}/`, { headers: auth('curta') });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('12 caracteres');
    process.env.PAINEL_SENHA = SENHA;
  });
});
