/**
 * Testes dos serviços contra um Postgres de verdade, com a Shopee simulada.
 * Rodam só com TEST_DATABASE_URL definida, apontando para um banco cujo nome contenha "teste":
 * o schema public desse banco é APAGADO e recriado a cada execução.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Sql } from '../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../testes/banco.ts';
import { importarChave } from '../harness/cripto.ts';
import { buscarCliente, type Cliente } from '../db/clientes.ts';
import { lerCredencialShopee, salvarCredencialShopee } from '../db/credenciais.ts';
import { coletarOfertasShopee } from './ofertas/coletarOfertasShopee.ts';
import { gerarLinkShopee } from './links/gerarLinkShopee.ts';
import { importarPlanilhaShopee } from './ofertas/importarPlanilhaShopee.ts';
import { prepararLinks, registrarLinkManual } from './links/linksManuaisShopee.ts';
import type { BuscaOfertas } from './shopee/client.ts';
import type { OfertaShopee, PaginaOfertas } from './shopee/parser.ts';


function oferta(id: string, preco = '10.00'): OfertaShopee {
  return {
    produtoId: id, lojaId: '9', titulo: `Produto ${id}`, urlProduto: `https://shopee.com.br/product/9/${id}`,
    urlOferta: null, imagemUrl: null, lojaNome: 'Loja', preco, precoMaximo: null, descontoPct: '10.0000',
    comissaoPct: '12.0000', comissaoValor: '1.20', vendas: 5, avaliacao: '4.50', validadeInicio: null,
    validadeFim: null, bruto: { itemId: id },
  };
}

/** Shopee falsa: cada palavra-chave tem páginas de 3 produtos. */
function shopeeFalsa(catalogo: Record<string, string[][]>, preco = '10.00') {
  const chamadas: BuscaOfertas[] = [];
  return {
    chamadas,
    async buscarOfertas(b: BuscaOfertas): Promise<PaginaOfertas> {
      chamadas.push(b);
      const paginas = catalogo[b.palavraChave] ?? [];
      const p = b.pagina ?? 1;
      return {
        ofertas: (paginas[p - 1] ?? []).map((id) => oferta(id, preco)),
        pagina: { page: p, limit: 3, hasNextPage: p < paginas.length },
        descartadas: [],
      };
    },
  };
}

describe.skipIf(!BANCO_HABILITADO)('serviços com banco', () => {
  let sql: Sql;
  let cliente: Cliente;
  const quando = new Date('2026-11-12T11:15:00Z'); // 08:15 em São Paulo

  beforeAll(async () => {
    sql = await bancoLimpo();
    cliente = await buscarCliente(sql, 'c1');
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate links, ofertas, credenciais cascade`; });

  it('seed: cliente de teste com nichos', () => {
    expect(cliente.codigo).toBe('c1');
    expect(cliente.nichos.map((n) => n.slug)).toEqual(['casa', 'beleza']);
  });

  describe('Conector de ofertas', () => {
    it('coleta 10 ofertas distintas usando as palavras do nicho e grava', async () => {
      const shopee = shopeeFalsa({
        'organizador cozinha': [['1', '2', '3'], ['4', '5', '6'], ['7']],
        'air fryer': [['3', '8', '9'], ['10', '11', '12']],
      });
      const r = await coletarOfertasShopee({ sql, shopee }, { cliente, nicho: 'casa', limite: 10, quando });
      expect(r.ofertas).toHaveLength(10);
      expect(new Set(r.ofertas.map((o) => o.produtoId)).size).toBe(10);
      expect(r.novas).toBe(10);
      expect(r.dataColeta).toBe('2026-11-12');
      expect(new Set(shopee.chamadas.map((c) => c.palavraChave))).toEqual(new Set(['organizador cozinha', 'air fryer']));
      const [contagem] = await sql<{ n: number }[]>`select count(*)::int as n from ofertas where cliente_id = ${cliente.clienteId}`;
      expect(contagem!.n).toBe(10);
      const [linha] = await sql`select preco, comissao_pct, data_coleta::text, nicho from ofertas where produto_id = '1'`;
      expect(linha).toMatchObject({ preco: '10.00', comissao_pct: '12.0000', data_coleta: '2026-11-12', nicho: 'casa' });
    });

    it('não duplica: mesma oferta no mesmo dia atualiza o preço', async () => {
      await coletarOfertasShopee({ sql, shopee: shopeeFalsa({ x: [['1', '2']] }) }, { cliente, nicho: 'casa', palavrasChave: ['x'], quando });
      const r = await coletarOfertasShopee(
        { sql, shopee: shopeeFalsa({ x: [['1', '2', '3']] }, '8.50') },
        { cliente, nicho: 'casa', palavrasChave: ['x'], quando },
      );
      expect(r.novas).toBe(1);
      expect(r.atualizadas).toBe(2);
      const linhas = await sql`select produto_id, preco::text from ofertas order by produto_id`;
      expect(linhas.map((l) => [l.produto_id, l.preco])).toEqual([['1', '8.50'], ['2', '8.50'], ['3', '8.50']]);
    });

    it('em outro dia cria nova linha (histórico de preço)', async () => {
      const shopee = shopeeFalsa({ x: [['1']] });
      await coletarOfertasShopee({ sql, shopee }, { cliente, nicho: 'casa', palavrasChave: ['x'], quando });
      await coletarOfertasShopee({ sql, shopee }, {
        cliente, nicho: 'casa', palavrasChave: ['x'], quando: new Date('2026-11-13T12:00:00Z'),
      });
      const [contagem] = await sql<{ n: number }[]>`select count(*)::int as n from ofertas where produto_id = '1'`;
      expect(contagem!.n).toBe(2);
    });

    it('para quando a API não tem mais páginas', async () => {
      const r = await coletarOfertasShopee({ sql, shopee: shopeeFalsa({ x: [['1', '2']] }) }, {
        cliente, nicho: 'casa', palavrasChave: ['x'], limite: 10, quando,
      });
      expect(r.ofertas).toHaveLength(2);
    });
  });

  describe('Links e rastreio', () => {
    const shopeeLinks = () => {
      const pedidos: { url: string; subIds: readonly string[] }[] = [];
      return {
        pedidos,
        async gerarLinkCurto(u: string, subIds: readonly string[]) {
          pedidos.push({ url: u, subIds });
          return `https://s.shopee.com.br/L${pedidos.length}`;
        },
      };
    };

    it('a partir de uma oferta gravada: sub_ids corretos, gravado e ligado à oferta', async () => {
      const col = await coletarOfertasShopee({ sql, shopee: shopeeFalsa({ x: [['22912345']] }) }, {
        cliente, nicho: 'casa', palavrasChave: ['x'], quando,
      });
      const shopee = shopeeLinks();
      const link = await gerarLinkShopee({ sql, shopee }, { cliente, ofertaId: col.ofertas[0]!.id, quando });
      expect(shopee.pedidos[0]).toEqual({
        url: 'https://shopee.com.br/product/9/22912345',
        subIds: ['c1', 'wa', '20261112', '22912345', '0815'],
      });
      expect(link).toMatchObject({
        urlAfiliado: 'https://s.shopee.com.br/L1',
        subIds: ['c1', 'wa', '20261112', '22912345', '0815'],
        chaveRastreio: 'c1-wa-20261112-22912345-0815',
        ofertaId: col.ofertas[0]!.id,
        produtoId: '22912345',
      });
      const [linha] = await sql`select url_afiliado, nicho, canal, plataforma from links where id = ${link.id}`;
      expect(linha).toMatchObject({ url_afiliado: 'https://s.shopee.com.br/L1', nicho: 'casa', canal: 'wa', plataforma: 'shopee' });
    });

    it('a partir de URL: extrai o produto e liga à oferta já coletada', async () => {
      await coletarOfertasShopee({ sql, shopee: shopeeFalsa({ x: [['777']] }) }, { cliente, nicho: 'casa', palavrasChave: ['x'], quando });
      const link = await gerarLinkShopee({ sql, shopee: shopeeLinks() }, {
        cliente, url: 'https://shopee.com.br/Algum-Produto-i.9.777', quando, contexto: { origem: 'teste' },
      });
      expect(link.produtoId).toBe('777');
      expect(link.ofertaId).not.toBeNull();
    });

    it('URL sem ID de produto: campo da oferta vira "avulso"', async () => {
      const link = await gerarLinkShopee({ sql, shopee: shopeeLinks() }, {
        cliente, url: 'https://s.shopee.com.br/AbC', quando, canal: 'ig',
      });
      expect(link.subIds).toEqual(['c1', 'ig', '20261112', 'avulso', '0815']);
      expect(link.ofertaId).toBeNull();
    });

    it('recusa URL de fora da Shopee, sem chamar a API', async () => {
      const shopee = shopeeLinks();
      await expect(gerarLinkShopee({ sql, shopee }, { cliente, url: 'https://exemplo.com/produto' })).rejects.toThrow('Shopee');
      expect(shopee.pedidos).toHaveLength(0);
    });

    it('não usa oferta de outro cliente', async () => {
      await sql`insert into clientes (cliente_id, codigo, nome) values ('00000000-0000-4000-8000-000000000002', 'c2', 'Outro') on conflict do nothing`;
      const outro = await buscarCliente(sql, 'c2');
      const col = await coletarOfertasShopee({ sql, shopee: shopeeFalsa({ x: [['5']] }) }, { cliente: outro, nicho: 'casa', palavrasChave: ['x'], quando });
      await expect(gerarLinkShopee({ sql, shopee: shopeeLinks() }, { cliente, ofertaId: col.ofertas[0]!.id })).rejects.toThrow('não encontrada');
      // e o banco recusa um link de um cliente apontando para oferta de outro
      await expect(sql`
        insert into links (cliente_id, oferta_id, plataforma, url_origem, url_afiliado, chave_rastreio, canal)
        values (${cliente.clienteId}, ${col.ofertas[0]!.id}, 'shopee', 'x', 'y', 'z', 'wa')`).rejects.toThrow(/foreign key/);
    });
  });

  describe('modo manual (sem API)', () => {
    const planilha = [
      'link;titulo;preco;desconto;comissao;nicho',
      'https://shopee.com.br/A-i.9.101;Produto A;29,90;25;12;casa',
      'https://shopee.com.br/B-i.9.102;Produto B;"1.299,00";;7,5;',
      'https://s.shopee.com.br/curto;Produto C;10;;;casa',
    ].join('\n');

    it('importa a planilha, recusa a linha ruim e não duplica ao importar de novo', async () => {
      const r = await importarPlanilhaShopee(sql, cliente, planilha, { nichoPadrao: 'beleza', quando });
      expect(r.ofertas).toHaveLength(2);
      expect(r.erros.map((e) => e.linha)).toEqual([4]);
      const linhas = await sql`select produto_id, preco::text, nicho, dados_brutos->>'origem' as origem from ofertas order by produto_id`;
      expect(linhas.map((l) => [l.produto_id, l.preco, l.nicho, l.origem])).toEqual([
        ['101', '29.90', 'casa', 'planilha'], ['102', '1299.00', 'beleza', 'planilha'],
      ]);
      const r2 = await importarPlanilhaShopee(sql, cliente, planilha, { quando });
      expect(r2.novas).toBe(0);
      expect(r2.atualizadas).toBe(2);
    });

    it('prepara os sub_ids e registra o link colado do painel com os mesmos sub_ids', async () => {
      await importarPlanilhaShopee(sql, cliente, planilha, { quando });
      const preparados = await prepararLinks(sql, cliente, { quando });
      expect(preparados).toHaveLength(2);
      expect(preparados[0]).toMatchObject({
        produtoId: '101', subIds: ['c1', 'wa', '20261112', '101', '0815'], quando: '2026-11-12 08:15', linksExistentes: 0,
      });
      const link = await registrarLinkManual(sql, {
        cliente, ofertaId: preparados[0]!.ofertaId, link: 'https://s.shopee.com.br/Painel1', quando,
      });
      expect(link).toMatchObject({ urlAfiliado: 'https://s.shopee.com.br/Painel1', subIds: preparados[0]!.subIds });
      const [l] = await sql`select contexto->>'origem' as origem from links where id = ${link.id}`;
      expect(l!.origem).toBe('painel');
      expect((await prepararLinks(sql, cliente, { quando }))[0]!.linksExistentes).toBe(1);
      await expect(registrarLinkManual(sql, {
        cliente, ofertaId: preparados[1]!.ofertaId, link: 'https://s.shopee.com.br/Painel1', quando,
      })).rejects.toThrow('já foi registrado');
      await expect(registrarLinkManual(sql, { cliente, ofertaId: preparados[1]!.ofertaId, link: 'https://bit.ly/x', quando }))
        .rejects.toThrow('Shopee');
    });
  });

  describe('credenciais', () => {
    it('grava cifrado e lê de volta', async () => {
      const chave = await importarChave(randomBytes(32).toString('base64'));
      await salvarCredencialShopee(sql, chave, cliente.clienteId, { appId: 'APP1', secret: 'SEGREDO1' });
      const [linha] = await sql`select valor_cifrado from credenciais`;
      expect(linha!.valor_cifrado).not.toContain('SEGREDO1');
      expect(await lerCredencialShopee(sql, chave, cliente.clienteId)).toEqual({ appId: 'APP1', secret: 'SEGREDO1' });
    });
  });
});
