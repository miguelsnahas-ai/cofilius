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
import { fileURLToPath } from 'node:url';
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
import {
  aprovar, confirmarPreco, criarRascunho, dataLocal, descartar, listarDia, registrarEnvio, validarDia,
} from '../services/lista/lista.ts';
import { importarVendas, resumoPeriodo } from '../services/vendas/atribuicao.ts';
import { lerPlanilhaVendas } from '../services/vendas/planilhaVendas.ts';
import { processarFila, statusFila } from './fila.ts';
import { agendarDia, criarExecutores } from './esteira.ts';
import { numeroBr } from './csv.ts';
import { criarModeloClaude, precosDoAmbiente } from './modeloClaude.ts';
import { contratoRedator, redigirMensagem } from '../services/lista/redator.ts';
import { carregarAgente, rodarCasos } from './agentes.ts';
import { contratoCurador, curarDia, selecionadasDoDia } from '../services/curadoria/curador.ts';
import { aprovarDiretriz, descartarDiretriz, listarDiretrizes, proporDiretriz } from '../services/curadoria/diretrizes.ts';
import { redigirSelecionadas } from '../services/lista/redator.ts';
import { analisarPeriodo, contratoAnalista } from '../services/relatorios/analista.ts';
import { montarFechamento } from '../services/relatorios/fechamento.ts';
import { registrarAcao, usoPorCliente } from '../services/relatorios/uso.ts';
import { contratoAtendente } from '../services/atendimento/atendente.ts';
import { atualizarCliente, criarCliente, definirAtivo, listarCadastro, removerNicho, salvarNicho, type DadosCliente } from '../services/clientes/cadastro.ts';

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
      Grava o link gerado no painel, com os mesmos sub_ids.

Lista do dia (texto com marcadores; o sistema preenche preço, desconto e link):
  npm run cli -- rascunho --cliente c1 --oferta <id> --texto "Achado! {{preco}} com {{desconto}} off 👉 {{link}}" [--data AAAA-MM-DD]
  npm run cli -- validar --cliente c1 [--data AAAA-MM-DD]
  npm run cli -- lista --cliente c1 [--data AAAA-MM-DD]
  npm run cli -- aprovar --cliente c1 --mensagem <id> [--por nome]
  npm run cli -- descartar --cliente c1 --mensagem <id> --motivo "..."
  npm run cli -- confirmar-preco --cliente c1 --oferta <id> --preco 29,90
  npm run cli -- enviada --cliente c1 --mensagem <id>
      Registra que a mensagem foi enviada (confere preço conferido há até 30 min e repetição antes).

Redator (IA; usa a API do Claude e gera custo):
  npm run cli -- redigir --cliente c1 --oferta <id> [--oferta <id2> ...] [--data AAAA-MM-DD]
      Escreve a mensagem de cada oferta e cria o rascunho (preço e link preenchidos pelo sistema).
  npm run cli -- testar-agente --cliente c1 --agente redator|curador|analista|atendente
      Roda os casos de teste do agente (agents/<nome>/casos) com o modelo de verdade.

Curadoria (IA):
  npm run cli -- curar --cliente c1 [--data AAAA-MM-DD] [--quantidade 5]
      O Curador escolhe as ofertas do dia entre as candidatas, seguindo as diretrizes aprovadas.
  npm run cli -- selecionadas --cliente c1 [--data AAAA-MM-DD]
  npm run cli -- redigir-dia --cliente c1 [--data AAAA-MM-DD]
      O Redator escreve as mensagens das escolhidas que já têm link.
  preparar-links sem --oferta mostra só as escolhidas sem link (use --todas para todas as do dia).

Fechamento e Analista (IA):
  npm run cli -- fechamento --cliente c1 --de AAAA-MM-DD --ate AAAA-MM-DD [--sem-analise]
      Texto do fechamento (números do banco) com as 3 leituras do Analista; mostra as propostas de diretriz.

Diretrizes de nicho (o Curador só usa as aprovadas):
  npm run cli -- diretrizes --cliente c1 [--nicho casa]
  npm run cli -- propor-diretriz --cliente c1 --nicho casa --texto "Priorizar utilidades de cozinha até R$ 60."
  npm run cli -- aprovar-diretriz --cliente c1 --id <id>
  npm run cli -- descartar-diretriz --cliente c1 --id <id>

Vendas:
  npm run cli -- importar-vendas --cliente c1 --arquivo vendas.csv   (modelo: docs/modelos/vendas.csv)
  npm run cli -- resumo --cliente c1 --de AAAA-MM-DD --ate AAAA-MM-DD

Uso (minutos do operador e custo de IA por cliente):
  npm run cli -- uso --de AAAA-MM-DD --ate AAAA-MM-DD

Clientes:
  npm run cli -- clientes
  npm run cli -- novo-cliente --codigo ana --nome "Ana" [--whatsapp 5511999998888] [--horario 08:00] [--limite 5] [--tom "..."]
  npm run cli -- editar-cliente --cliente ana [--nome ...] [--whatsapp ...] [--horario ...] [--limite ...] [--tom ...]
  npm run cli -- nicho --cliente ana --nome "Casa" --palavras "organizador, air fryer"
  npm run cli -- remover-nicho --cliente ana --nicho casa
  npm run cli -- pausar-cliente --cliente ana   |   ativar-cliente --cliente ana

Esteira e fila (todos os clientes):
  npm run cli -- agendar-dia [--data AAAA-MM-DD]
  npm run cli -- fila [--limite 100]
  npm run cli -- fila-status`;

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
    texto: { type: 'string' },
    data: { type: 'string' },
    mensagem: { type: 'string' },
    por: { type: 'string' },
    motivo: { type: 'string' },
    preco: { type: 'string' },
    de: { type: 'string' },
    todas: { type: 'boolean' },
    'sem-analise': { type: 'boolean' },
    agente: { type: 'string' },
    quantidade: { type: 'string' },
    id: { type: 'string' },
    codigo: { type: 'string' },
    nome: { type: 'string' },
    whatsapp: { type: 'string' },
    horario: { type: 'string' },
    tom: { type: 'string' },
    palavras: { type: 'string' },
    ate: { type: 'string' },
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

function exigirOferta(): string {
  const o = op.oferta?.[0];
  if (!o) throw new Error('Falta --oferta.');
  return o;
}

async function shopeeDoCliente(sql: Sql, cliente: Cliente) {
  const chave = await importarChave(process.env.CREDENCIAIS_CHAVE);
  return criarClienteShopee(await lerCredencialShopee(sql, chave, cliente.clienteId), {
    endpoint: process.env.SHOPEE_ENDPOINT || ENDPOINT_BRASIL,
  });
}

/** Comandos que valem para todos os clientes. Devolve true se tratou o comando. */
function dadosDoCadastro(): DadosCliente {
  const d: DadosCliente = {};
  if (op.nome !== undefined) d.nome = op.nome;
  if (op.whatsapp !== undefined) d.whatsapp = op.whatsapp;
  if (op.horario !== undefined) d.horarioEnvio = op.horario;
  if (op.tom !== undefined) d.tomGrupo = op.tom;
  if (op.limite !== undefined) d.limiteMensagensDia = Number(op.limite);
  return d;
}

async function comandoSemCliente(sql: Sql, comando: string): Promise<boolean> {
  switch (comando) {
    case 'uso': {
      const de = exigir('de');
      const ate = exigir('ate');
      const linhas = await usoPorCliente(sql, de, ate);
      console.log(`Uso de ${de} a ${ate} (minutos estimados pelas ações no painel e no terminal):`);
      console.table(linhas.map((u) => ({
        cliente: u.codigo, enviadas: u.mensagensEnviadas, 'minutos (total)': u.minutosOperador, 'dias com ação': u.diasComAcao,
        'minutos/dia': u.minutosPorDia, 'chamadas IA': u.chamadasIa, 'custo IA (US$)': u.custoIaUsd,
      })));
      return true;
    }
    case 'clientes': {
      for (const c of await listarCadastro(sql)) {
        console.log(`\n${c.codigo} · ${c.nome}${c.ativo ? '' : ' · PAUSADO'}`);
        console.log(`  WhatsApp: ${c.whatsapp ?? '-'} · envio: ${c.horarioEnvio ?? '08:00'} · até ${c.limiteMensagensDia} mensagens/dia · tom: ${c.tomGrupo ?? '-'}`);
        for (const n of c.nichos) console.log(`  nicho ${n.slug} (${n.nome ?? n.slug}): ${(n.palavras_chave ?? []).join(', ')}`);
      }
      return true;
    }
    case 'novo-cliente': {
      const c = await criarCliente(sql, exigir('codigo'), { ...dadosDoCadastro(), nome: exigir('nome') });
      console.log(`Cliente ${c.codigo} criado. Próximo passo: npm run cli -- nicho --cliente ${c.codigo} --nome "Casa" --palavras "organizador, air fryer"`);
      return true;
    }
    case 'editar-cliente': {
      const c = await atualizarCliente(sql, exigir('cliente'), dadosDoCadastro());
      console.log(`Cliente ${c.codigo} atualizado.`);
      return true;
    }
    case 'pausar-cliente':
    case 'ativar-cliente': {
      await definirAtivo(sql, exigir('cliente'), comando === 'ativar-cliente');
      console.log(comando === 'ativar-cliente' ? 'Cliente ativado.' : 'Cliente pausado: fica fora da esteira e do painel até ser ativado.');
      return true;
    }
    case 'nicho': {
      const nichos = await salvarNicho(sql, exigir('cliente'), { nome: exigir('nome'), palavrasChave: exigir('palavras').split(',') });
      console.log(`Nichos: ${nichos.map((n) => n.slug).join(', ')}`);
      return true;
    }
    case 'remover-nicho': {
      const nichos = await removerNicho(sql, exigir('cliente'), exigir('nicho'));
      console.log(`Nichos: ${nichos.map((n) => n.slug).join(', ') || '(nenhum)'}`);
      return true;
    }
    case 'agendar-dia': {
      const data = op.data ?? dataLocal(new Date(), 'America/Sao_Paulo');
      const r = await agendarDia(sql, data);
      console.log(`Esteira de ${data}:`);
      for (const a of r) {
        const hora = a.horario.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        console.log(`  ${a.cliente} · ${a.tipo}${a.nicho ? ` (${a.nicho})` : ''} · ${hora} (Brasília) · ${a.situacao}${a.motivo ? `: ${a.motivo}` : ''}`);
      }
      return true;
    }
    case 'fila': {
      const executores = criarExecutores({
        sql, shopeeDoCliente: (c) => shopeeDoCliente(sql, c), modelo: () => criarModeloClaude(), precos: precosDoAmbiente(),
      });
      const limite = op.limite ? Number(op.limite) : undefined;
      const r = await processarFila(sql, executores, { limite });
      console.log(`Fila: ${r.executadas} executadas · ${r.concluidas} concluídas · ${r.novasTentativas} vão tentar de novo · ${r.falharam} falharam`);
      if (r.falharam) process.exitCode = 3;
      return true;
    }
    case 'fila-status': {
      const linhas = await statusFila(sql, new Date(Date.now() - 86_400_000));
      if (!linhas.length) console.log('Fila vazia.');
      else console.table(linhas.map((l) => ({ ...l, agendadaPara: l.agendadaPara.toISOString(), erro: l.erro ?? '' })));
      return true;
    }
    default:
      return false;
  }
}

async function principal(): Promise<void> {
  const comando = positionals[0];
  if (!comando || op.ajuda) {
    console.log(AJUDA);
    return;
  }
  const sql = conectar();
  try {
    if (await comandoSemCliente(sql, comando)) return;
    const cliente = await buscarCliente(sql, exigir('cliente'));
    const dataLista = () => {
      const d = op.data ?? dataLocal(new Date(), cliente.fusoHorario);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('--data no formato AAAA-MM-DD');
      return d;
    };

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
        // Sem --oferta: as escolhidas pelo Curador no dia que ainda não têm link (ou todas do dia, com --todas).
        let ofertaIds = op.oferta;
        if (!ofertaIds?.length && !op.todas) {
          const sel = await selecionadasDoDia(sql, cliente, dataLocal(quando, cliente.fusoHorario));
          if (sel.length) ofertaIds = sel.filter((x) => !x.linkId && x.plataforma === 'shopee').map((x) => x.ofertaId);
          if (sel.length && !ofertaIds?.length) { console.log('Todas as ofertas escolhidas do dia já têm link.'); break; }
        }
        const lista = await prepararLinks(sql, cliente, { quando, canal: op.canal, ofertaIds });
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

      case 'rascunho': {
        const m = await criarRascunho(sql, { cliente, ofertaId: exigirOferta(), textoModelo: exigir('texto'), dataLista: dataLista() });
        console.log(`Rascunho criado (${m.id}):\n\n${m.textoFinal}\n\nPróximo passo: npm run cli -- validar --cliente ${cliente.codigo}`);
        break;
      }

      case 'validar': {
        const r = await validarDia(sql, cliente, dataLista());
        if (!r.length) console.log('Nenhum rascunho para validar neste dia.');
        for (const v of r) {
          console.log(`${v.ok ? '✔ validada' : '✘ barrada '}  ${v.mensagemId}`);
          for (const regra of v.regras.filter((x) => !x.ok)) console.log(`      ${regra.regra}: ${regra.detalhe}`);
        }
        break;
      }

      case 'lista': {
        const linhas = await listarDia(sql, cliente, dataLista());
        if (!linhas.length) console.log('Lista vazia neste dia.');
        for (const l of linhas) {
          console.log(`\n[${l.estado.toUpperCase()}] ${l.id} · ${l.titulo ?? ''}`);
          if (l.textoFinal) console.log(`  ${l.textoFinal.replace(/\n/g, '\n  ')}`);
          for (const r of (l.validacao ?? []).filter((x) => !x.ok)) console.log(`  ✘ ${r.regra}: ${r.detalhe}`);
          if (l.motivoDescarte) console.log(`  motivo: ${l.motivoDescarte}`);
        }
        break;
      }

      case 'aprovar': {
        await aprovar(sql, cliente, exigir('mensagem'), op.por ?? 'operador');
        console.log('Aprovada.');
        break;
      }

      case 'descartar': {
        await descartar(sql, cliente, exigir('mensagem'), exigir('motivo'));
        console.log('Descartada.');
        break;
      }

      case 'confirmar-preco': {
        const preco = numeroBr(exigir('preco'));
        if (preco === null || Number.isNaN(preco) || preco < 0) throw new Error('--preco inválido');
        await confirmarPreco(sql, cliente, exigirOferta(), preco.toFixed(2));
        console.log(`Preço confirmado: ${preco.toFixed(2)}. Mensagens com preço diferente serão barradas.`);
        break;
      }

      case 'enviada': {
        await registrarEnvio(sql, cliente, exigir('mensagem'));
        console.log('Registrada como enviada.');
        break;
      }

      case 'redigir': {
        const ofertas = op.oferta ?? [];
        if (!ofertas.length) throw new Error('Falta --oferta.');
        const modelo = criarModeloClaude();
        const contrato = await contratoRedator();
        const precos = precosDoAmbiente();
        let falhas = 0;
        for (const ofertaId of ofertas) {
          try {
            const r = await redigirMensagem(sql, { cliente, ofertaId, modelo, contrato, precos, dataLista: dataLista() });
            console.log(`\n✔ ${ofertaId} (${r.tentativas} tentativa(s), prompt ${r.versaoPrompt})\n  ${r.mensagem.textoFinal.replace(/\n/g, '\n  ')}`);
          } catch (erro) {
            falhas++;
            console.log(`\n✘ ${ofertaId}: ${(erro as Error).message}`);
          }
        }
        console.log(`\nRascunhos criados: ${ofertas.length - falhas} de ${ofertas.length}. Próximo passo: npm run cli -- validar --cliente ${cliente.codigo}`);
        if (falhas) process.exitCode = 2;
        break;
      }

      case 'testar-redator':
      case 'testar-agente': {
        const nome = comando === 'testar-redator' ? 'redator' : exigir('agente');
        const contratos = { redator: contratoRedator, curador: contratoCurador, analista: contratoAnalista, atendente: contratoAtendente } as Record<string, () => Promise<any>>;
        if (!contratos[nome]) throw new Error(`Agente sem casos de teste: ${nome} (use ${Object.keys(contratos).join(' ou ')})`);
        const { casos } = await carregarAgente(fileURLToPath(new URL(`../agents/${nome}`, import.meta.url)));
        const r = await rodarCasos(sql, {
          contrato: await contratos[nome]!(), casos, modelo: criarModeloClaude(), clienteId: cliente.clienteId, precos: precosDoAmbiente(),
        });
        for (const c of r) console.log(`${c.ok ? '✔' : '✘'} ${c.caso}: ${c.detalhe}`);
        const [custo] = await sql`
          select count(*)::int as chamadas, coalesce(sum(custo_usd), 0)::numeric(12,6)::text as custo
          from execucoes_agente where cliente_id = ${cliente.clienteId} and criado_em > now() - interval '10 minutes'`;
        console.log(`\n${r.filter((c) => c.ok).length} de ${r.length} casos ok · ${custo!.chamadas} chamadas · US$ ${custo!.custo}`);
        if (r.some((c) => !c.ok)) process.exitCode = 2;
        break;
      }

      case 'curar': {
        const q = op.quantidade ? Number(op.quantidade) : undefined;
        const r = await curarDia(sql, { cliente, data: dataLista(), modelo: criarModeloClaude(), precos: precosDoAmbiente(), quantidade: q });
        if (!r.escolhas.length) { console.log('Nenhuma candidata no dia. Importe ofertas primeiro (importar-ofertas).'); break; }
        console.log(`Curadoria de ${r.data}: ${r.escolhas.length} escolhidas entre ${r.candidatas} candidatas\n`);
        for (const e of r.escolhas) console.log(`  ${e.posicao}. ${e.titulo}\n     ${e.motivo}`);
        console.log(`\nPróximo passo: links (preparar-links) e depois redigir-dia.`);
        break;
      }

      case 'selecionadas': {
        const sel = await selecionadasDoDia(sql, cliente, dataLista());
        if (!sel.length) console.log('Nenhuma oferta escolhida neste dia (rode curar).');
        for (const x of sel) {
          const estado = x.mensagemId ? 'com mensagem' : x.linkId ? 'com link, sem mensagem' : 'SEM LINK';
          console.log(`  ${x.posicao}. [${estado}] ${x.titulo} · ${x.ofertaId}\n     ${x.motivo}`);
        }
        break;
      }

      case 'redigir-dia': {
        const r = await redigirSelecionadas(sql, { cliente, data: dataLista(), modelo: criarModeloClaude(), precos: precosDoAmbiente() });
        console.log(`Redigidas: ${r.redigidas.length} · já tinham mensagem: ${r.jaTinhamMensagem} · sem link: ${r.semLink.length} · falhas: ${r.falhas.length}`);
        for (const x of r.semLink) console.log(`  sem link: ${x.titulo} (${x.ofertaId})`);
        for (const x of r.falhas) console.log(`  falha: ${x.ofertaId}: ${x.erro}`);
        if (r.redigidas.length) console.log(`\nPróximo passo: npm run cli -- validar --cliente ${cliente.codigo}`);
        if (r.falhas.length) process.exitCode = 2;
        break;
      }

      case 'analisar':
      case 'fechamento': {
        const inicio = exigir('de');
        const fim = exigir('ate');
        const resumo = await resumoPeriodo(sql, cliente, inicio, fim);
        const analise = op['sem-analise']
          ? null
          : await analisarPeriodo(sql, { cliente, inicio, fim, modelo: criarModeloClaude(), precos: precosDoAmbiente() });
        console.log(montarFechamento(cliente.nome, resumo, analise));
        if (analise?.propostas.length) {
          console.log('\n--- Para o operador: propostas de diretriz do Analista (só valem se aprovadas) ---');
          for (const d of analise.propostas) {
            console.log(`\n${d.nicho} v${d.versao} (${d.id}):\n  ${d.texto}\n  aprovar: npm run cli -- aprovar-diretriz --cliente ${cliente.codigo} --id ${d.id}`);
          }
        }
        break;
      }

      case 'diretrizes': {
        const lista = await listarDiretrizes(sql, cliente, op.nicho);
        if (!lista.length) console.log('Nenhuma diretriz cadastrada.');
        for (const d of lista) {
          console.log(`\n[${d.situacao.toUpperCase()}] ${d.nicho} v${d.versao} · por ${d.propostaPor} · ${d.id}\n  ${d.texto.replace(/\n/g, '\n  ')}`);
        }
        break;
      }

      case 'propor-diretriz': {
        const d = await proporDiretriz(sql, cliente, exigir('nicho'), exigir('texto'), 'operador');
        console.log(`Proposta ${d.nicho} v${d.versao} criada (${d.id}). Para valer: npm run cli -- aprovar-diretriz --cliente ${cliente.codigo} --id ${d.id}`);
        break;
      }

      case 'aprovar-diretriz': {
        const d = await aprovarDiretriz(sql, cliente, exigir('id'));
        console.log(`Diretriz ${d.nicho} v${d.versao} aprovada; o Curador passa a usá-la.`);
        break;
      }

      case 'descartar-diretriz': {
        await descartarDiretriz(sql, cliente, exigir('id'));
        console.log('Proposta descartada.');
        break;
      }

      case 'importar-vendas': {
        const { vendas, erros } = lerPlanilhaVendas(await readFile(exigir('arquivo'), 'utf8'), cliente.fusoHorario);
        const r = vendas.length ? await importarVendas(sql, cliente, vendas) : null;
        if (r) {
          console.log(`Vendas: ${r.total} (${r.novas} novas, ${r.atualizadas} atualizadas) · ${r.atribuidas} atribuídas, ${r.naoAtribuidas} NÃO atribuídas`);
          for (const m of r.mudancasSituacao) console.log(`  pedido ${m.pedidoId}: ${m.de} → ${m.para}`);
        }
        if (erros.length) {
          console.log(`\nLinhas NÃO importadas (${erros.length}):`);
          for (const e of erros) console.log(`  linha ${e.linha}: ${e.motivo}`);
          process.exitCode = 2;
        }
        break;
      }

      case 'resumo': {
        const r = await resumoPeriodo(sql, cliente, exigir('de'), exigir('ate'));
        console.log(`\nResumo ${r.inicio} a ${r.fim} · ${cliente.nome}`);
        console.log(`  Comissão validada:  R$ ${r.comissao.validada}`);
        console.log(`  Comissão pendente:  R$ ${r.comissao.pendente}   (pode cair se o pedido for cancelado)`);
        console.log(`  Comissão cancelada: R$ ${r.comissao.cancelada}`);
        console.log(`  Não atribuídas:     ${r.naoAtribuidas.pedidos} pedidos, R$ ${r.naoAtribuidas.comissao}`);
        console.log(`  Cliques:            ${r.cliques}`);
        if (r.porPlataformaESituacao.length) console.table(r.porPlataformaESituacao);
        if (r.melhoresPostagens.length) {
          console.log('  Melhores postagens:');
          for (const m of r.melhoresPostagens) console.log(`    R$ ${m.comissao} · ${m.pedidos} pedidos · ${m.titulo ?? m.chaveRastreio}`);
        }
        break;
      }

      default:
        throw new Error(`Comando desconhecido: ${comando}\n\n${AJUDA}`);
    }
    // Registro de uso: comandos de trabalho do operador contam para os minutos daquele cliente.
    const ACOES_OPERADOR = new Set(['importar-ofertas', 'registrar-link', 'rascunho', 'validar', 'aprovar', 'descartar', 'confirmar-preco',
      'enviada', 'curar', 'redigir', 'redigir-dia', 'importar-vendas', 'fechamento', 'propor-diretriz', 'aprovar-diretriz', 'descartar-diretriz', 'preparar-links']);
    if (ACOES_OPERADOR.has(comando)) await registrarAcao(sql, cliente.clienteId, comando, 'cli', process.env.PAINEL_OPERADOR || undefined);
  } finally {
    await sql.end();
  }
}

principal().catch((erro) => {
  console.error(`\nErro: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exitCode = 1;
});
