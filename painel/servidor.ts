/**
 * Painel do operador: servidor web local (sem dependências além do Node).
 *
 *   npm run painel        → http://127.0.0.1:3000
 *
 * Segurança:
 * - Escuta só no próprio computador (127.0.0.1), salvo PAINEL_HOST no .env.
 * - Senha obrigatória (PAINEL_SENHA no .env), pedida pelo navegador (usuário: qualquer).
 * - Toda ação (POST) exige JSON e o cabeçalho X-Cofilius, que outro site não consegue enviar:
 *   uma página maliciosa aberta no navegador não aprova nada por você.
 */
import 'dotenv/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { conectar, erroDeConexao } from '../harness/db.ts';
import { log } from '../harness/log.ts';
import { criarModeloClaude, precosDoAmbiente } from '../harness/modeloClaude.ts';
import { registrarAcao } from '../services/relatorios/uso.ts';
import {
  acaoDiretriz, acaoMensagem, confirmarPrecoOferta, ErroPedido, listarClientes, painelDoDia, registrarLinkOferta,
  rodarCurador, rodarRedator, simularRecebida, concluirPedidoAfiliado, type DepsApi,
} from './api.ts';
import { canalWhatsapp } from '../services/disparador/disparador.ts';
import { configWhatsappDoAmbiente } from '../services/disparador/whatsapp.ts';
import { importarChave } from '../harness/cripto.ts';
import { lerCredencialShopee } from '../db/credenciais.ts';
import { criarClienteShopee, ENDPOINT_BRASIL } from '../services/shopee/client.ts';

const PUBLICO = join(dirname(fileURLToPath(import.meta.url)), 'publico');
const TIPOS: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LIMITE_CORPO = 20_000;

function responder(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function senhaConfere(req: IncomingMessage, senha: string): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [, recebida = ''] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
  const a = Buffer.from(recebida);
  const b = Buffer.from(senha);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function lerCorpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const partes: Buffer[] = [];
  for await (const p of req) {
    total += (p as Buffer).length;
    if (total > LIMITE_CORPO) throw new ErroPedido('Pedido grande demais.');
    partes.push(p as Buffer);
  }
  if (!partes.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(partes).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ErroPedido('Corpo do pedido não é JSON válido.');
  }
}

export function criarServidorPainel(deps: DepsApi & { senha: string }): Server {
  if (!deps.senha) throw new Error('Defina PAINEL_SENHA no .env para usar o painel.');
  const rotasPost: [RegExp, (m: RegExpMatchArray, corpo: Record<string, unknown>) => Promise<unknown>][] = [
    [/^\/api\/mensagens\/([0-9a-f-]{36})\/(validar|aprovar|descartar|enviada|whatsapp)$/, (m, c) => acaoMensagem(deps, m[1]!, m[2]!, c)],
    [/^\/api\/ofertas\/([0-9a-f-]{36})\/preco$/, (m, c) => confirmarPrecoOferta(deps, m[1]!, c)],
    [/^\/api\/ofertas\/([0-9a-f-]{36})\/link$/, (m, c) => registrarLinkOferta(deps, m[1]!, c)],
    [/^\/api\/diretrizes\/([0-9a-f-]{36})\/(aprovar|descartar)$/, (m, c) => acaoDiretriz(deps, m[1]!, m[2]!, c)],
    [/^\/api\/curar$/, (_m, c) => rodarCurador(deps, c)],
    [/^\/api\/receber$/, (_m, c) => simularRecebida(deps, c)],
    [/^\/api\/pedidos\/([0-9a-f-]{36})\/concluir$/, (m, c) => concluirPedidoAfiliado(deps, m[1]!, c)],
    [/^\/api\/redigir$/, (_m, c) => rodarRedator(deps, c)],
  ];

  /** Registro de uso: cada ação (e cada abertura do dia) conta para os minutos do operador naquele cliente. */
  const registrar = async (codigo: unknown, acao: string) => {
    if (typeof codigo !== 'string') return;
    const [c] = await deps.sql`select cliente_id from clientes where codigo = ${codigo}`;
    if (c) await registrarAcao(deps.sql, c.cliente_id, acao, 'painel', deps.operador);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://painel');
    try {
      if (!senhaConfere(req, deps.senha)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cofilius", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Senha necessária.');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/clientes') return responder(res, 200, await listarClientes(deps));
      if (req.method === 'GET' && url.pathname === '/api/dia') {
        const cliente = url.searchParams.get('cliente');
        if (!cliente) throw new ErroPedido('Falta "cliente".');
        const dia = await painelDoDia(deps, cliente, url.searchParams.get('data') ?? undefined);
        await registrar(cliente, 'abrir_dia');
        return responder(res, 200, dia);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-cofilius'] !== '1' || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return responder(res, 403, { erro: 'Pedido recusado (origem não confirmada).' });
        }
        const corpo = await lerCorpo(req);
        for (const [re, fn] of rotasPost) {
          const m = url.pathname.match(re);
          if (m) {
            const r = await fn(m, corpo);
            log.info('painel.acao', { rota: url.pathname });
            await registrar(corpo.cliente, url.pathname.replace(/[0-9a-f-]{36}\//, '').replace(/^\/api\//, ''));
            return responder(res, 200, r);
          }
        }
        return responder(res, 404, { erro: 'Rota desconhecida.' });
      }
      if (req.method === 'GET') {
        const arquivo = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(arquivo)) return responder(res, 404, { erro: 'Não encontrado.' });
        const conteudo = await readFile(join(PUBLICO, arquivo)).catch(() => null);
        if (!conteudo) return responder(res, 404, { erro: 'Não encontrado.' });
        res.writeHead(200, {
          'Content-Type': TIPOS[extname(arquivo)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
          'X-Frame-Options': 'DENY',
        });
        res.end(conteudo);
        return;
      }
      responder(res, 405, { erro: 'Método não permitido.' });
    } catch (erro) {
      const msg = erro instanceof Error ? erro.message : String(erro);
      // Erros de regra (estado errado, preço desatualizado, link de outro site) voltam para a tela como estão.
      // Falha de conexão ou erro de programação é interno.
      const interno = erro instanceof TypeError || erro instanceof ReferenceError || erroDeConexao(erro);
      const deUso = erro instanceof ErroPedido || !interno;
      if (!deUso) log.error('painel.erro', { rota: url.pathname, erro: msg });
      responder(res, deUso ? 400 : 500, { erro: deUso ? msg : `Erro interno: ${msg}` });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sql = conectar();
  const temIa = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const servidor = criarServidorPainel({
    sql,
    senha: process.env.PAINEL_SENHA ?? '',
    operador: process.env.PAINEL_OPERADOR || 'operador',
    modelo: temIa ? () => criarModeloClaude() : undefined,
    precos: precosDoAmbiente(),
    whatsapp: configWhatsappDoAmbiente() ? canalWhatsapp(configWhatsappDoAmbiente()!) : undefined,
    // Com a Open API da Shopee do cliente, o Atendente gera o link na hora; sem ela, vira tarefa sua.
    shopeeDoCliente: async (c) => {
      try {
        const chave = await importarChave(process.env.CREDENCIAIS_CHAVE);
        return criarClienteShopee(await lerCredencialShopee(sql, chave, c.clienteId), { endpoint: process.env.SHOPEE_ENDPOINT || ENDPOINT_BRASIL });
      } catch {
        return null;
      }
    },
  });
  const porta = Number(process.env.PAINEL_PORTA || 3000);
  const host = process.env.PAINEL_HOST || '127.0.0.1';
  servidor.listen(porta, host, () => {
    console.log(`Painel do Cofilius em http://${host}:${porta} (IA ${temIa ? 'ligada' : 'desligada: falta ANTHROPIC_API_KEY'})`);
  });
}
