import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from './db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../testes/banco.ts';
import { buscarCliente, type Cliente } from '../db/clientes.ts';
import { devolverPresas, enfileirar, pegarProxima, processarFila, statusFila } from './fila.ts';
import { agendarDia, criarExecutores, semanaAte } from './esteira.ts';
import type { PaginaOfertas } from '../services/shopee/parser.ts';
import type { ModeloIA } from './agentes.ts';

const T0 = new Date('2026-11-12T09:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describe.skipIf(!BANCO_HABILITADO)('fila de tarefas', () => {
  let sql: Sql;
  let cliente: Cliente;

  beforeAll(async () => {
    sql = await bancoLimpo();
    cliente = await buscarCliente(sql, 'c1');
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate tarefas, credenciais, mensagens, links, ofertas, execucoes_agente cascade`; });

  it('enfileirar com chave não duplica', async () => {
    const a = await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'x', chave: 'x:1', agendadaPara: T0 });
    const b = await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'x', chave: 'x:1', agendadaPara: T0 });
    expect(a.criada).toBe(true);
    expect(b).toEqual({ id: a.id, criada: false });
  });

  it('só pega tarefa vencida, e cada tarefa vai para um só consumidor', async () => {
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'x', agendadaPara: min(10) });
    expect(await pegarProxima(sql, T0)).toBeNull();
    for (let i = 0; i < 5; i++) await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'x', agendadaPara: T0 });
    const pegas = await Promise.all(Array.from({ length: 8 }, () => pegarProxima(sql, T0)));
    const ids = pegas.filter(Boolean).map((t) => t!.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('falha: novas tentativas com espera crescente; esgotadas, "falhou" com o erro', async () => {
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'quebra', agendadaPara: T0 });
    let relogio = T0;
    const executores = { quebra: async () => { throw new Error('plataforma fora do ar'); } };
    const horarios: string[] = [];
    for (let i = 0; i < 6; i++) {
      await processarFila(sql, executores, { agora: () => relogio });
      const [t] = await sql`select estado, tentativas, agendada_para, erro from tarefas`;
      horarios.push(`${t!.estado}:${t!.tentativas}`);
      relogio = new Date(Math.max(relogio.getTime(), new Date(t!.agendada_para).getTime()) + 1000);
      if (t!.estado === 'falhou') break;
    }
    expect(horarios).toEqual(['pendente:1', 'pendente:2', 'pendente:3', 'falhou:4']);
    const [t] = await sql`select erro from tarefas`;
    expect(t!.erro).toBe('plataforma fora do ar');
  });

  it('a espera dobra a cada tentativa', async () => {
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'quebra', agendadaPara: T0 });
    await processarFila(sql, { quebra: async () => { throw new Error('x'); } }, { agora: () => T0 });
    const [a] = await sql`select agendada_para from tarefas`;
    expect(new Date(a!.agendada_para).getTime() - T0.getTime()).toBe(60_000);
    await processarFila(sql, { quebra: async () => { throw new Error('x'); } }, { agora: () => min(2) });
    const [b] = await sql`select agendada_para from tarefas`;
    expect(new Date(b!.agendada_para).getTime() - min(2).getTime()).toBe(120_000);
  });

  it('uma tarefa que falha não segura as outras; tipo sem executor falha de vez', async () => {
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'quebra', agendadaPara: T0 });
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'ok', agendadaPara: T0 });
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'desconhecido', agendadaPara: T0 });
    const r = await processarFila(sql, { quebra: async () => { throw new Error('x'); }, ok: async () => ({ feito: true }) }, { agora: () => T0 });
    expect(r).toEqual({ executadas: 3, concluidas: 1, novasTentativas: 1, falharam: 1 });
    const linhas = await sql`select tipo, estado, resultado from tarefas order by tipo`;
    expect(linhas.map((l) => [l.tipo, l.estado])).toEqual([['desconhecido', 'falhou'], ['ok', 'concluida'], ['quebra', 'pendente']]);
    expect(linhas[1]!.resultado).toEqual({ feito: true });
  });

  it('tarefa presa em "executando" volta para a fila', async () => {
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'x', agendadaPara: T0 });
    await pegarProxima(sql, T0);
    expect(await devolverPresas(sql, min(5))).toBe(0);
    expect(await devolverPresas(sql, min(16))).toBe(1);
    expect((await statusFila(sql, T0))[0]).toMatchObject({ estado: 'pendente', cliente: 'c1' });
  });

  it('agendarDia: pula as etapas da Open API sem credencial, agenda as outras e não duplica', async () => {
    const a = await agendarDia(sql, '2026-11-12');
    expect(a.map((x) => [x.tipo, x.situacao])).toEqual([
      ['ofertas.shopee.coletar', 'pulada'], ['curadoria.curar', 'agendada'], ['links.shopee.gerar', 'pulada'],
      ['redacao.redigir', 'agendada'], ['lista.validar', 'agendada'],
    ]);
    expect(a[4]!.horario.toISOString()).toBe('2026-11-12T09:45:00.000Z'); // 06:45 em São Paulo
    await sql`insert into credenciais (cliente_id, plataforma, nome, valor_cifrado) values (${cliente.clienteId}, 'shopee', 'open_api', 'v1:x:y')`;
    const b = await agendarDia(sql, '2026-11-12');
    expect(b.map((x) => [x.tipo, x.nicho ?? null, x.situacao])).toEqual([
      ['ofertas.shopee.coletar', 'casa', 'agendada'], ['ofertas.shopee.coletar', 'beleza', 'agendada'],
      ['curadoria.curar', null, 'ja_existia'], ['links.shopee.gerar', null, 'agendada'],
      ['redacao.redigir', null, 'ja_existia'], ['lista.validar', null, 'ja_existia'],
    ]);
  });

  it('domingo agenda também o fechamento semanal', async () => {
    const a = await agendarDia(sql, '2026-11-15');
    expect(a.at(-1)).toMatchObject({ tipo: 'analise.semanal', situacao: 'agendada' });
    expect(a.at(-1)!.horario.toISOString()).toBe('2026-11-15T23:00:00.000Z'); // 20h em São Paulo
    expect(semanaAte('2026-11-15')).toEqual({ inicio: '2026-11-09', fim: '2026-11-15' });
    const r = await processarFila(sql, criarExecutores({ sql, shopeeDoCliente: async () => { throw new Error('x'); }, modelo: () => ({ async gerar() { throw new Error('não deveria chamar'); } }) }),
      { agora: () => new Date('2026-11-16T00:00:00Z') });
    expect(r.falharam).toBe(0);
    const [t] = await sql`select resultado from tarefas where tipo = 'analise.semanal'`;
    expect(t!.resultado).toMatchObject({ inicio: '2026-11-09', fim: '2026-11-15', semDados: true, propostas: [] });
    expect(t!.resultado.fechamento).toContain('Sem mensagens enviadas no período');
  });

  it('esteira completa pela fila: coleta, curadoria, links, redação e validação', async () => {
    await sql`insert into credenciais (cliente_id, plataforma, nome, valor_cifrado) values (${cliente.clienteId}, 'shopee', 'open_api', 'v1:x:y')`;
    await agendarDia(sql, '2026-11-12');
    const oferta = (id: string, preco: string) => ({ produtoId: id, lojaId: '9', titulo: `Produto ${id}`, urlProduto: `https://shopee.com.br/product/9/${id}`,
      urlOferta: null, imagemUrl: null, lojaNome: null, preco, precoMaximo: null, descontoPct: '20.0000', comissaoPct: '10.0000',
      comissaoValor: '1.00', vendas: 10, avaliacao: '4.50', validadeInicio: null, validadeFim: null, bruto: {} });
    let links = 0;
    const shopee = {
      async buscarOfertas(b: { palavraChave: string }): Promise<PaginaOfertas> {
        const id = b.palavraChave.length.toString();
        return { ofertas: [oferta(id, '10.00')], pagina: { page: 1, limit: 1, hasNextPage: false }, descartadas: [] };
      },
      async gerarLinkCurto() { links++; return `https://s.shopee.com.br/E${links}`; },
    };
    const modelo: ModeloIA = {
      async gerar(p) {
        if (p.sistema.includes('curador')) {
          const e = JSON.parse(p.entrada) as { candidatas: { id: string }[]; quantidade: number };
          return { texto: JSON.stringify({ escolhas: e.candidatas.slice(0, e.quantidade).map((c) => ({ oferta_id: c.id, motivo: 'ok' })) }), tokensEntrada: 1, tokensSaida: 1 };
        }
        return { texto: '{"texto_modelo":"Achado do dia: {{preco}} 👉 {{link}}"}', tokensEntrada: 1, tokensSaida: 1 };
      },
    };
    const executores = criarExecutores({ sql, shopeeDoCliente: async () => shopee, modelo: () => modelo });
    const r = await processarFila(sql, executores, { agora: () => new Date('2026-11-12T10:00:00Z') });
    expect(r).toEqual({ executadas: 6, concluidas: 6, novasTentativas: 0, falharam: 0 });
    const linhas = await sql`select tipo, resultado from tarefas order by agendada_para, tipo`;
    const res = Object.fromEntries(linhas.map((l) => [l.tipo, l.resultado]));
    // palavras-chave do seed geram 3 produtos distintos (o simulador usa o tamanho da palavra como ID)
    expect(res['curadoria.curar']).toEqual({ candidatas: 3, escolhidas: 3 });
    expect(res['links.shopee.gerar']).toEqual({ gerados: 3 });
    expect(res['redacao.redigir']).toMatchObject({ redigidas: 3, semLink: 0 });
    expect(res['lista.validar']).toEqual({ validadas: 3, barradas: 0 });
  });

  it('etapa de agente sem modelo configurado falha com aviso, sem travar as outras', async () => {
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'curadoria.curar', entrada: { dataLista: '2026-11-12' }, agendadaPara: T0, maxTentativas: 0 });
    await enfileirar(sql, { clienteId: cliente.clienteId, tipo: 'lista.validar', entrada: { dataLista: '2026-11-12' }, agendadaPara: T0 });
    const executores = criarExecutores({ sql, shopeeDoCliente: async () => { throw new Error('sem shopee'); } });
    const r = await processarFila(sql, executores, { agora: () => T0 });
    expect(r).toMatchObject({ concluidas: 1, falharam: 1 });
    const [t] = await sql`select erro from tarefas where tipo = 'curadoria.curar'`;
    expect(t!.erro).toContain('modelo de IA não configurado');
  });
});
