import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from './db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../testes/banco.ts';
import { buscarCliente, type Cliente } from '../db/clientes.ts';
import { devolverPresas, enfileirar, pegarProxima, processarFila, statusFila } from './fila.ts';
import { agendarDia, criarExecutores } from './esteira.ts';
import type { PaginaOfertas } from '../services/shopee/parser.ts';

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
  beforeEach(async () => { await sql`truncate tarefas, credenciais, mensagens, links, ofertas cascade`; });

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

  it('agendarDia: pula a coleta sem credencial, agenda a validação e não duplica', async () => {
    const a = await agendarDia(sql, '2026-11-12');
    expect(a.map((x) => [x.tipo, x.situacao])).toEqual([['ofertas.shopee.coletar', 'pulada'], ['lista.validar', 'agendada']]);
    expect(a[1]!.horario.toISOString()).toBe('2026-11-12T09:45:00.000Z'); // 06:45 em São Paulo
    await sql`insert into credenciais (cliente_id, plataforma, nome, valor_cifrado) values (${cliente.clienteId}, 'shopee', 'open_api', 'v1:x:y')`;
    const b = await agendarDia(sql, '2026-11-12');
    expect(b.map((x) => [x.tipo, x.nicho ?? null, x.situacao])).toEqual([
      ['ofertas.shopee.coletar', 'casa', 'agendada'], ['ofertas.shopee.coletar', 'beleza', 'agendada'], ['lista.validar', null, 'ja_existia'],
    ]);
  });

  it('executores da esteira: coleta (Shopee simulada) e validação rodam pela fila', async () => {
    await sql`insert into credenciais (cliente_id, plataforma, nome, valor_cifrado) values (${cliente.clienteId}, 'shopee', 'open_api', 'v1:x:y')`;
    await agendarDia(sql, '2026-11-12');
    const shopee = {
      async buscarOfertas(): Promise<PaginaOfertas> {
        return {
          ofertas: [{ produtoId: '1', lojaId: '9', titulo: 'P', urlProduto: 'https://shopee.com.br/product/9/1', urlOferta: null, imagemUrl: null,
            lojaNome: null, preco: '10.00', precoMaximo: null, descontoPct: null, comissaoPct: null, comissaoValor: null, vendas: null,
            avaliacao: null, validadeInicio: null, validadeFim: null, bruto: {} }],
          pagina: { page: 1, limit: 1, hasNextPage: false }, descartadas: [],
        };
      },
    };
    let pediuNicho = 0;
    const executores = criarExecutores({ sql, shopeeDoCliente: async () => { pediuNicho++; return shopee; } });
    const r = await processarFila(sql, executores, { agora: () => new Date('2026-11-12T10:00:00Z') });
    expect(r).toEqual({ executadas: 3, concluidas: 3, novasTentativas: 0, falharam: 0 });
    expect(pediuNicho).toBe(2);
    const linhas = await sql`select tipo, resultado from tarefas order by agendada_para, tipo`;
    expect(linhas.at(-1)!.resultado).toEqual({ validadas: 0, barradas: 0 });
  });
});
