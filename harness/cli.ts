/**
 * Comando de linha para testar os serviços com a conta real.
 *
 *   npm run cli -- credenciais-shopee --cliente c1
 *   npm run cli -- ofertas --cliente c1 --nicho casa [--palavra "air fryer"] [--limite 10] [--ordenacao 2]
 *   npm run cli -- link --cliente c1 --oferta <id da oferta>
 *   npm run cli -- link --cliente c1 --url https://shopee.com.br/... [--canal wa] [--nicho casa]
 *   npm run cli -- teste --cliente c1 --nicho casa [--limite 10]
 *
 * Modo manual (sem a Open API):
 *   npm run cli -- importar-ofertas --cliente c1 --arquivo ofertas.csv [--nicho casa]
 *   npm run cli -- preparar-links --cliente c1 [--quando "2026-11-12 08:15"] [--oferta <id> ...]
 *   npm run cli -- registrar-link --cliente c1 --oferta <id> --quando "2026-11-12 08:15" --link https://s.shopee.com.br/...
 *
 * Opção em ofertas, link e teste: --gravar <pasta> salva as respostas brutas da Shopee em JSON
 * (para virar resposta de exemplo nos testes).
 *
 * O resultado vai para a saída padrão; o log (JSON) vai para a saída de erro.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { conectar, type Sql } from './db.ts';
import { importarChave } from './cripto.ts';
import { buscarCliente, type Cliente } from '../db/clientes.ts';
import { lerCredencialShopee, salvarCredencialShopee } from '../db/credenciais.ts';
import { criarClienteShopee, ENDPOINT_BRASIL } from '../services/shopee/client.ts';
import { coletarOfertasShopee, type ResultadoColeta } from '../services/ofertas/coletarOfertasShopee.ts';
import { gerarLinkShopee, type LinkGravado } from '../services/links/gerarLinkShopee.ts';
import { importarPlanilhaShopee } from '../services/ofertas/importarPlanilhaShopee.ts';
import { prepararLinks, registrarLinkManual } from '../services/links/linksManuaisShopee.ts';
import { horarioLocalParaData } from '../services/etiquetas/etiquetas.ts';
import { readFile } from 'node:fs/promises';

const AJUDA = `Uso:
  npm run cli -- credenciais-shopee --cliente c1
      Lê SHOPEE_APP_ID e SHOPEE_SECRET do .env e grava cifrado na tabela credenciais.

  npm run cli -- ofertas --cliente c1 --nicho casa [--palavra "air fryer" ...] [--limite 10] [--ordenacao N]
      Busca ofertas na Shopee e grava em ofertas (sem duplicar no mesmo dia).

  npm run cli -- link --cliente c1 (--oferta <id> | --url <url>) [--canal wa] [--nicho casa]
      Gera link de afiliado com sub_ids e grava em links.

  npm run cli -- teste --cliente c1 --nicho casa [--limite 10]
      Faz os dois: busca as ofertas e gera o link da primeira.

Opções comuns: --gravar <pasta>  salva as respostas brutas da Shopee.

Modo manual (sem a Open API):
  npm run cli -- importar-ofertas --cliente c1 --arquivo ofertas.csv [--nicho casa]
      Lê a planilha (modelo: docs/modelos/ofertas-shopee.csv) e grava em ofertas.

  npm run cli -- preparar-links --cliente c1 [--quando "2026-11-12 08:15"] [--oferta <id> ...] [--canal wa]
      Mostra os 5 sub_ids de cada oferta do dia, para digitar no painel da Shopee.

  npm run cli -- registrar-link --cliente c1 --oferta <id> --quando "2026-11-12 08:15" --link <link do painel>
      Grava o link gerado no painel, com os mesmos sub_ids.`;

const { values: op, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cliente: { type: 'string' },
    nicho: { type: 'string' },
    palavra: { type: 'string', multiple: true },
    limite: { type: 'string' },
    ordenacao: { type: 'string' },
    oferta: { type: 'string', multiple: true },
    arquivo: { type: 'string' },
    link: { type: 'string' },
    quando: { type: 'string' },
    url: { type: 'string' },
    canal: { type: 'string' },
    gravar: { type: 'string' },
    ajuda: { type: 'boolean', short: 'h' },
  },
});

function exigir(nome: keyof typeof op): string {
  const v = op[nome];
  if (typeof v !== 'string' || !v) throw new Error(`Falta --${nome}.\n\n${AJUDA}`);
  return v;
}

function inteiro(nome: 'limite' | 'ordenacao', padrao?: number): number | undefined {
  const v = op[nome];
  if (v === undefined) return padrao;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${nome} precisa ser um inteiro positivo.`);
  return n;
}

async function clienteShopee(sql: Sql, cliente: Cliente) {
  const chave = await importarChave(process.env.CREDENCIAIS_CHAVE);
  const cred = await lerCredencialShopee(sql, chave, cliente.clienteId);
  const pasta = op.gravar;
  if (pasta) await mkdir(pasta, { recursive: true });
  return criarClienteShopee(cred, {
    endpoint: process.env.SHOPEE_ENDPOINT || ENDPOINT_BRASIL,
    aoResponder: pasta
      ? async (operacao, texto) => {
          const arquivo = join(pasta, `real-${operacao}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
          await writeFile(arquivo, texto);
          console.error(`Resposta gravada em ${arquivo}`);
        }
      : undefined,
  });
}

function mostrarOfertas(r: ResultadoColeta): void {
  console.log(`\nOfertas gravadas (${r.ofertas.length}; ${r.novas} novas, ${r.atualizadas} atualizadas, ${r.descartadas} descartadas) · coleta ${r.dataColeta}\n`);
  console.table(
    r.ofertas.map((o) => ({
      id: o.id,
      produto: o.produtoId,
      titulo: o.titulo.length > 45 ? o.titulo.slice(0, 44) + '…' : o.titulo,
      preco: `R$ ${o.preco}`,
      desconto: o.descontoPct ? `${Number(o.descontoPct)}%` : '-',
      comissao: o.comissaoPct ? `${Number(o.comissaoPct)}%` : '-',
      'comissão R$': o.comissaoValor ?? '-',
    })),
  );
}

function mostrarLink(l: LinkGravado): void {
  console.log('\nLink gravado:');
  console.log(`  id            ${l.id}`);
  console.log(`  link afiliado ${l.urlAfiliado}`);
  console.log(`  origem        ${l.urlOrigem}`);
  console.log(`  sub_ids       ${l.subIds.join(' | ')}`);
  console.log(`  oferta        ${l.ofertaId ?? '(nenhuma)'}`);
}

async function principal(): Promise<void> {
  const comando = positionals[0];
  if (!comando || op.ajuda) {
    console.log(AJUDA);
    return;
  }
  const sql = conectar();
  try {
    const cliente = await buscarCliente(sql, exigir('cliente'));

    switch (comando) {
      case 'credenciais-shopee': {
        const appId = process.env.SHOPEE_APP_ID?.trim();
        const secret = process.env.SHOPEE_SECRET?.trim();
        if (!appId || !secret) throw new Error('Defina SHOPEE_APP_ID e SHOPEE_SECRET no .env.');
        const chave = await importarChave(process.env.CREDENCIAIS_CHAVE);
        await salvarCredencialShopee(sql, chave, cliente.clienteId, { appId, secret });
        console.log(`Credenciais da Shopee gravadas (cifradas) para o cliente ${cliente.codigo}. Já pode apagá-las do .env.`);
        break;
      }

      case 'ofertas': {
        const shopee = await clienteShopee(sql, cliente);
        const r = await coletarOfertasShopee({ sql, shopee }, {
          cliente, nicho: exigir('nicho'), palavrasChave: op.palavra,
          limite: inteiro('limite', 10), ordenacao: inteiro('ordenacao'),
        });
        mostrarOfertas(r);
        break;
      }

      case 'link': {
        if (!op.oferta && !op.url) throw new Error('Informe --oferta <id> ou --url <url>.');
        const shopee = await clienteShopee(sql, cliente);
        const l = await gerarLinkShopee({ sql, shopee }, {
          cliente, ofertaId: op.oferta?.[0], url: op.url, canal: op.canal, nicho: op.nicho,
          contexto: { origem: 'cli' },
        });
        mostrarLink(l);
        break;
      }

      case 'teste': {
        const shopee = await clienteShopee(sql, cliente);
        const r = await coletarOfertasShopee({ sql, shopee }, {
          cliente, nicho: exigir('nicho'), palavrasChave: op.palavra,
          limite: inteiro('limite', 10), ordenacao: inteiro('ordenacao'),
        });
        mostrarOfertas(r);
        const primeira = r.ofertas[0];
        if (!primeira) throw new Error('Nenhuma oferta encontrada; não há o que transformar em link.');
        const l = await gerarLinkShopee({ sql, shopee }, {
          cliente, ofertaId: primeira.id, canal: op.canal, contexto: { origem: 'cli-teste' },
        });
        mostrarLink(l);
        const [cont] = await sql<{ ofertas: number; links: number }[]>`
          select (select count(*)::int from ofertas where cliente_id = ${cliente.clienteId} and data_coleta = ${r.dataColeta}) as ofertas,
                 (select count(*)::int from links where cliente_id = ${cliente.clienteId} and id = ${l.id}) as links`;
        console.log(`\nConferência no banco: ${cont!.ofertas} ofertas de hoje e ${cont!.links} link gravado.`);
        break;
      }

      case 'importar-ofertas': {
        const texto = await readFile(exigir('arquivo'), 'utf8');
        const r = await importarPlanilhaShopee(sql, cliente, texto, {
          nichoPadrao: op.nicho,
          quando: op.quando ? horarioLocalParaData(op.quando, cliente.fusoHorario) : undefined,
        });
        mostrarOfertas({ ...r, descartadas: r.erros.length });
        if (r.erros.length) {
          console.log(`\nLinhas NÃO importadas (${r.erros.length}) — corrija na planilha e importe de novo:`);
          for (const e of r.erros) console.log(`  linha ${e.linha}: ${e.motivo}`);
          process.exitCode = 2;
        }
        break;
      }

      case 'preparar-links': {
        const quando = op.quando ? horarioLocalParaData(op.quando, cliente.fusoHorario) : new Date();
        const lista = await prepararLinks(sql, cliente, { quando, canal: op.canal, ofertaIds: op.oferta });
        if (!lista.length) {
          console.log('Nenhuma oferta encontrada para o dia. Importe a planilha primeiro (importar-ofertas).');
          break;
        }
        console.log(`\nNo painel de afiliados da Shopee, gere um link por produto, com estes Sub_ids.`);
        console.log(`Depois cole cada link gerado no comando "registrar-link" mostrado abaixo dele.\n`);
        lista.forEach((l, i) => {
          console.log(`${i + 1}. ${l.titulo} · R$ ${l.preco}${l.linksExistentes ? `  (já tem ${l.linksExistentes} link)` : ''}`);
          console.log(`   Produto: ${l.urlProduto}`);
          l.subIds.forEach((s, j) => console.log(`   Sub_id${j + 1}: ${s}`));
          console.log(`   npm run cli -- registrar-link --cliente ${cliente.codigo} --oferta ${l.ofertaId} --quando "${l.quando}"${op.canal ? ` --canal ${op.canal}` : ''} --link COLE_O_LINK_AQUI\n`);
        });
        break;
      }

      case 'registrar-link': {
        const l = await registrarLinkManual(sql, {
          cliente,
          ofertaId: op.oferta?.[0],
          url: op.url,
          link: exigir('link'),
          quando: horarioLocalParaData(exigir('quando'), cliente.fusoHorario),
          canal: op.canal,
          nicho: op.nicho,
        });
        mostrarLink(l);
        break;
      }

      default:
        throw new Error(`Comando desconhecido: ${comando}\n\n${AJUDA}`);
    }
  } finally {
    await sql.end();
  }
}

principal().catch((erro) => {
  console.error(`\nErro: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exitCode = 1;
});
