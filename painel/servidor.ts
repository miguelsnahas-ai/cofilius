/**
 * Painel do operador: servidor web local (sem dependências além do Node).
 *
 *   Windows: dois cliques em Cofilius.bat   ·   ou: npm run painel   →   http://127.0.0.1:3000
 *
 * Dois modos:
 * - configuração: sem banco ou sem senha no .env, mostra a tela de configuração inicial (só para este computador);
 * - normal: o painel completo (dia, clientes, importações, relatórios, configuração) e a esteira automática.
 *
 * Segurança:
 * - Escuta só no próprio computador (127.0.0.1), salvo PAINEL_HOST no .env (nunca no modo configuração).
 * - Senha obrigatória no modo normal (pedida pelo navegador; usuário: qualquer).
 * - Toda ação (POST) exige JSON e o cabeçalho X-Cofilius, que outro site não consegue enviar.
 * - Chaves e senhas nunca voltam para a tela: só "configurada" ou não.
 */
import { config as carregarEnv } from 'dotenv';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { exec } from 'node:child_process';
import { executadoDiretamente } from '../harness/execucao.ts';
import { ARQUIVO_ENV, salvarNoEnv } from '../harness/configLocal.ts';
import { conectar, erroDeConexao, type Sql } from '../harness/db.ts';
import { log } from '../harness/log.ts';
import { precosDoAmbiente } from '../harness/modeloClaude.ts';
import { criarModeloDoAmbiente, iaConfigurada, modeloDoPorte, provedorAtual } from '../harness/provedores.ts';
import { migrar } from '../db/migrate.ts';
import { registrarAcao } from '../services/relatorios/uso.ts';
import {
  acaoDiretriz, acaoFechamento, acaoMensagem, verCancelamentos, confirmarPrecoOferta, ErroPedido, listarClientes, painelDoDia, registrarLinkOferta,
  rodarCurador, rodarRedator, simularRecebida, concluirPedidoAfiliado, validarDiaInteiro, type DepsApi,
} from './api.ts';
import {
  ativarCliente, cadastroClientes, diretrizesDoCliente, editarCliente, fechamento, importarOfertas, importarVendasPlanilha,
  MODELOS_PLANILHA, novaDiretriz, novoCliente, removerNichoCliente, salvarNichoCliente, salvarShopeeCliente, testarAgente, uso,
} from './apiGestao.ts';
import { criarEsteiraAutomatica, type EsteiraAutomatica } from './esteiraAutomatica.ts';
import { clientePareado, gerarPareamento, receberCapturas, ultimosRecebimentos } from '../services/extensao/receber.ts';
import { buscarCliente } from '../db/clientes.ts';
import { resultadosPeriodo, type FiltroPlataforma } from '../services/relatorios/resultados.ts';
import { acaoCriativo, novoCriativo, telaCriativos } from './apiCriativos.ts';
import { buscarImagem } from '../services/criativos/imagem.ts';
import { canalWhatsapp } from '../services/disparador/disparador.ts';
import { configWhatsappDoAmbiente } from '../services/disparador/whatsapp.ts';
import { importarChave } from '../harness/cripto.ts';
import { lerCredencialShopee } from '../db/credenciais.ts';
import { criarClienteShopee, ENDPOINT_BRASIL } from '../services/shopee/client.ts';

const PUBLICO = join(dirname(fileURLToPath(import.meta.url)), 'publico');
const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png',
};
const LIMITE_CORPO = 3_000_000; // planilhas importadas vêm no corpo
const CODIGO = '([a-z0-9]{1,12})';

export type DepsPainel = DepsApi & { senha: string };

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

const doProprioComputador = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

async function lerCorpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const partes: Buffer[] = [];
  for await (const p of req) {
    total += (p as Buffer).length;
    if (total > LIMITE_CORPO) throw new ErroPedido('Pedido grande demais (máximo 3 MB).');
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

async function servirArquivo(res: ServerResponse, arquivo: string): Promise<void> {
  if (!/^[a-z0-9-]+\.(html|js|css|svg|woff2|png)$/.test(arquivo)) return responder(res, 404, { erro: 'Não encontrado.' });
  const conteudo = await readFile(join(PUBLICO, arquivo)).catch(() => null);
  if (!conteudo) return responder(res, 404, { erro: 'Não encontrado.' });
  res.writeHead(200, {
    'Content-Type': TIPOS[extname(arquivo)] ?? 'application/octet-stream',
    // Fontes e logo mudam pouco: cache de 1 dia. Páginas e scripts: sempre frescos.
    'Cache-Control': /\.(woff2|svg|png)$/.test(arquivo) ? 'public, max-age=86400' : 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:",
    'X-Frame-Options': 'DENY',
  });
  res.end(conteudo);
}

/** Monta as dependências do modo normal a partir do ambiente (.env). */
export function montarDepsDoAmbiente(sql: Sql): DepsPainel {
  return {
    sql,
    senha: process.env.PAINEL_SENHA ?? '',
    operador: process.env.PAINEL_OPERADOR || 'operador',
    modelo: iaConfigurada() ? () => criarModeloDoAmbiente() : undefined,
    precos: precosDoAmbiente(),
    whatsapp: configWhatsappDoAmbiente() ? canalWhatsapp(configWhatsappDoAmbiente()!) : undefined,
    // Com a Open API da Shopee do cliente: coleta, links e Atendente gerando link na hora.
    shopeeDoCliente: async (c) => {
      try {
        const chave = await importarChave(process.env.CREDENCIAIS_CHAVE);
        return criarClienteShopee(await lerCredencialShopee(sql, chave, c.clienteId), { endpoint: process.env.SHOPEE_ENDPOINT || ENDPOINT_BRASIL });
      } catch {
        return null;
      }
    },
  };
}

export interface OpcoesAplicacao {
  /** null = modo configuração. */
  deps: DepsPainel | null;
  arquivoEnv?: string;
  /** Como montar as dependências depois da configuração inicial. */
  montarDeps?: (sql: Sql) => DepsPainel;
  /** Esteira automática (o principal liga; os testes, não). */
  criarEsteira?: (deps: DepsPainel) => EsteiraAutomatica;
  /** Testa a conexão e cria as tabelas (substituível nos testes). */
  prepararBanco?: (url: string) => Promise<Sql>;
}

async function prepararBancoPadrao(url: string): Promise<Sql> {
  const sql = conectar(url);
  try {
    await Promise.race([
      sql`select 1`,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('o banco não respondeu em 20 segundos')), 20_000)),
    ]);
    await migrar(sql);
    return sql;
  } catch (erro) {
    await sql.end({ timeout: 1 }).catch(() => {});
    throw new ErroPedido(`Não consegui conectar ao banco: ${(erro as Error).message}. Confira o endereço e a senha do Supabase.`);
  }
}

export function criarAplicacao(op: OpcoesAplicacao): Server {
  let deps = op.deps;
  let esteira = deps && op.criarEsteira ? op.criarEsteira(deps) : null;
  esteira?.iniciar();
  const arquivoEnv = op.arquivoEnv ?? ARQUIVO_ENV;

  /** Registro de uso: cada ação (e cada abertura do dia) conta para os minutos do operador naquele cliente. */
  const registrar = async (codigo: unknown, acao: string) => {
    if (typeof codigo !== 'string' || !deps) return;
    const [c] = await deps.sql`select cliente_id from clientes where codigo = ${codigo}`;
    if (c) await registrarAcao(deps.sql, c.cliente_id, acao, 'painel', deps.operador);
  };

  type Rota = [RegExp, (m: RegExpMatchArray, corpo: Record<string, unknown>, d: DepsPainel) => Promise<unknown>];
  const rotasPost: Rota[] = [
    [/^\/api\/mensagens\/([0-9a-f-]{36})\/(validar|aprovar|descartar|enviada|whatsapp)$/, (m, c, d) => acaoMensagem(d, m[1]!, m[2]!, c)],
    [/^\/api\/ofertas\/([0-9a-f-]{36})\/preco$/, (m, c, d) => confirmarPrecoOferta(d, m[1]!, c)],
    [/^\/api\/ofertas\/([0-9a-f-]{36})\/link$/, (m, c, d) => registrarLinkOferta(d, m[1]!, c)],
    [/^\/api\/criativos$/, (_m, c, d) => novoCriativo(d, c)],
    [/^\/api\/criativos\/([0-9a-f-]{36})\/(aprovar|publicado|descartar)$/, (m, c, d) => acaoCriativo(d, m[1]!, m[2]!, c)],
    [/^\/api\/cancelamentos\/vistos$/, (_m, c, d) => verCancelamentos(d, c)],
    [/^\/api\/fechamentos\/([0-9a-f-]{36})\/(enviado|whatsapp)$/, (m, c, d) => acaoFechamento(d, m[1]!, m[2]!, c)],
    [/^\/api\/diretrizes\/([0-9a-f-]{36})\/(aprovar|descartar)$/, (m, c, d) => acaoDiretriz(d, m[1]!, m[2]!, c)],
    [/^\/api\/diretrizes$/, (_m, c, d) => novaDiretriz(d, c)],
    [/^\/api\/curar$/, (_m, c, d) => rodarCurador(d, c)],
    [/^\/api\/redigir$/, (_m, c, d) => rodarRedator(d, c)],
    [/^\/api\/validar-dia$/, (_m, c, d) => validarDiaInteiro(d, c)],
    [/^\/api\/receber$/, (_m, c, d) => simularRecebida(d, c)],
    [/^\/api\/extensao\/parear$/, async (_m, c, d) => ({ ok: true, codigo: await gerarPareamento(d.sql, String(c.cliente ?? '')) })],
    [/^\/api\/importar\/gravacao$/, async (_m, c, d) => {
      const cliente = await buscarCliente(d.sql, String(c.cliente ?? ''));
      let arquivo: { formato?: string; capturas?: unknown[] };
      try { arquivo = JSON.parse(String(c.json ?? '')); } catch { throw new ErroPedido('O arquivo não é uma gravação do Cofilius (JSON inválido).'); }
      if (arquivo?.formato !== 'cofilius-gravacao' || !Array.isArray(arquivo.capturas)) throw new ErroPedido('O arquivo não é uma gravação do Cofilius.');
      return { ok: true, ...(await receberCapturas(d.sql, cliente, arquivo.capturas)) };
    }],
    [/^\/api\/pedidos\/([0-9a-f-]{36})\/concluir$/, (m, c, d) => concluirPedidoAfiliado(d, m[1]!, c)],
    [/^\/api\/gestao\/clientes$/, (_m, c, d) => novoCliente(d, c)],
    [new RegExp(`^/api/gestao/clientes/${CODIGO}$`), (m, c, d) => editarCliente(d, m[1]!, c)],
    [new RegExp(`^/api/gestao/clientes/${CODIGO}/ativo$`), (m, c, d) => ativarCliente(d, m[1]!, c)],
    [new RegExp(`^/api/gestao/clientes/${CODIGO}/nichos$`), (m, c, d) => salvarNichoCliente(d, m[1]!, c)],
    [new RegExp(`^/api/gestao/clientes/${CODIGO}/nichos/([a-z0-9]+)/remover$`), (m, _c, d) => removerNichoCliente(d, m[1]!, m[2]!)],
    [new RegExp(`^/api/gestao/clientes/${CODIGO}/shopee$`), (m, c, d) => salvarShopeeCliente(d, m[1]!, c)],
    [/^\/api\/importar\/ofertas$/, (_m, c, d) => importarOfertas(d, c)],
    [/^\/api\/importar\/vendas$/, (_m, c, d) => importarVendasPlanilha(d, c)],
    [/^\/api\/fechamento$/, (_m, c, d) => fechamento(d, c)],
    [/^\/api\/agentes\/testar$/, (_m, c, d) => testarAgente(d, c)],
    [/^\/api\/esteira\/rodar$/, async () => {
      if (!esteira) throw new ErroPedido('Esteira automática indisponível.');
      await esteira.rodarAgora();
      return { ok: true, ...(await esteira.status()) };
    }],
    [/^\/api\/config$/, (_m, c, d) => salvarConfig(d, c)],
  ];

  async function salvarConfig(d: DepsPainel, c: Record<string, unknown>) {
    const valores: Record<string, string | null> = {};
    const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).trim() : undefined);
    if (str('operador')) valores.PAINEL_OPERADOR = str('operador')!;
    if (str('novaSenha') !== undefined && str('novaSenha') !== '') {
      if (str('novaSenha')!.length < 6) throw new ErroPedido('A senha precisa ter pelo menos 6 caracteres.');
      valores.PAINEL_SENHA = str('novaSenha')!;
    }
    if (str('anthropicKey')) valores.ANTHROPIC_API_KEY = str('anthropicKey')!;
    if (c.removerAnthropicKey === true) valores.ANTHROPIC_API_KEY = null;
    if (str('geminiKey')) valores.GEMINI_API_KEY = str('geminiKey')!;
    if (str('provedor') !== undefined) {
      if (!['gemini', 'claude'].includes(str('provedor')!)) throw new ErroPedido('Provedor de IA desconhecido.');
      // Ao trocar de provedor, volta aos modelos padrão dele (os nomes de modelo não servem no outro).
      if (str('provedor') !== provedorAtual()) { valores.MODELO_IA_PEQUENO = null; valores.MODELO_IA_FORTE = null; }
      valores.IA_PROVEDOR = str('provedor')!;
    }
    // Modelos: só grava o que difere do padrão do provedor (assim, trocar de provedor não deixa modelo do outro).
    const provedorFinal = (valores.IA_PROVEDOR as 'gemini' | 'claude' | undefined) ?? provedorAtual();
    if (str('provedor') === undefined || str('provedor') === provedorAtual()) {
      for (const [campo, chave, porte] of [['modeloPequeno', 'MODELO_IA_PEQUENO', 'pequeno'], ['modeloForte', 'MODELO_IA_FORTE', 'forte']] as const) {
        const v = str(campo);
        if (v === undefined) continue;
        valores[chave] = v && v !== modeloDoPorte(porte, { IA_PROVEDOR: provedorFinal }) ? v : null;
      }
    }
    if (typeof c.esteiraLigada === 'boolean') valores.PAINEL_ESTEIRA = c.esteiraLigada ? 'ligada' : 'desligada';
    if (!Object.keys(valores).length) throw new ErroPedido('Nada para salvar.');
    await salvarNoEnv(valores, arquivoEnv);
    // Vale na hora, sem reiniciar.
    d.operador = process.env.PAINEL_OPERADOR || 'operador';
    d.senha = process.env.PAINEL_SENHA ?? d.senha;
    d.modelo = iaConfigurada() ? () => criarModeloDoAmbiente() : undefined;
    d.precos = precosDoAmbiente();
    if (typeof c.esteiraLigada === 'boolean') esteira?.definirLigada(c.esteiraLigada);
    return { ok: true, senhaAlterada: 'PAINEL_SENHA' in valores };
  }

  function config(d: DepsPainel) {
    return {
      operador: d.operador,
      ia: !!d.modelo,
      provedor: provedorAtual(),
      chaveGemini: !!process.env.GEMINI_API_KEY,
      chaveClaude: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      modeloPequeno: modeloDoPorte('pequeno'),
      modeloForte: modeloDoPorte('forte'),
      whatsapp: !!d.whatsapp,
      esteiraLigada: esteira?.estado.ligada ?? false,
      chaveCredenciais: !!process.env.CREDENCIAIS_CHAVE,
    };
  }

  async function configurar(c: Record<string, unknown>) {
    const url = typeof c.databaseUrl === 'string' ? c.databaseUrl.trim() : '';
    const senha = typeof c.senha === 'string' ? c.senha : '';
    if (!/^postgres(ql)?:\/\//.test(url)) throw new ErroPedido('Cole o endereço de conexão do Supabase (começa com postgresql://).');
    if (/\[YOUR-PASSWORD\]/i.test(url)) throw new ErroPedido('Troque [YOUR-PASSWORD] pela senha do banco no endereço.');
    if (senha.length < 6) throw new ErroPedido('Escolha uma senha do painel com pelo menos 6 caracteres.');
    const sql = await (op.prepararBanco ?? prepararBancoPadrao)(url);
    const valores: Record<string, string> = {
      DATABASE_URL: url,
      PAINEL_SENHA: senha,
      PAINEL_OPERADOR: typeof c.operador === 'string' && c.operador.trim() ? c.operador.trim() : 'operador',
    };
    if (!process.env.CREDENCIAIS_CHAVE) valores.CREDENCIAIS_CHAVE = randomBytes(32).toString('base64');
    if (typeof c.anthropicKey === 'string' && c.anthropicKey.trim()) valores.ANTHROPIC_API_KEY = c.anthropicKey.trim();
    if (typeof c.geminiKey === 'string' && c.geminiKey.trim()) { valores.GEMINI_API_KEY = c.geminiKey.trim(); valores.IA_PROVEDOR = 'gemini'; }
    await salvarNoEnv(valores, arquivoEnv);
    deps = (op.montarDeps ?? montarDepsDoAmbiente)(sql);
    esteira = op.criarEsteira ? op.criarEsteira(deps) : null;
    esteira?.iniciar();
    log.info('painel.configurado');
    return { ok: true };
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://painel');
    try {
      // ---------------- modo configuração ----------------
      if (!deps) {
        if (!doProprioComputador(req)) return responder(res, 403, { erro: 'Configuração só pelo próprio computador.' });
        if (req.method === 'GET' && url.pathname === '/api/estado') return responder(res, 200, { modo: 'configuracao' });
        if (req.method === 'POST' && url.pathname === '/api/configurar') {
          if (req.headers['x-cofilius'] !== '1' || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
            return responder(res, 403, { erro: 'Pedido recusado (origem não confirmada).' });
          }
          return responder(res, 200, await configurar(await lerCorpo(req)));
        }
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
          return servirArquivo(res, url.pathname === '/' ? 'configurar.html' : url.pathname.slice(1));
        }
        return responder(res, 503, { erro: 'O painel ainda não foi configurado.' });
      }

      // ---------------- modo normal ----------------
      const d = deps;
      // Extensão do Chrome: entra pelo código de pareamento do cliente, não pela senha do painel.
      if (url.pathname.startsWith('/extensao/')) return await rotaExtensao(req, res, url, d);
      if (!senhaConfere(req, d.senha)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cofilius", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Senha necessária.');
        return;
      }
      if (req.method === 'GET') {
        const q = url.searchParams;
        switch (url.pathname) {
          case '/api/estado': return responder(res, 200, { modo: 'normal' });
          case '/api/clientes': return responder(res, 200, await listarClientes(d));
          case '/api/gestao/clientes': return responder(res, 200, await cadastroClientes(d));
          case '/api/config': return responder(res, 200, config(d));
          case '/api/esteira': return responder(res, 200, esteira ? await esteira.status() : { ligada: false, rodando: false, ultima: null, tarefas: [] });
          case '/api/uso': return responder(res, 200, await uso(d, q.get('de'), q.get('ate')));
          case '/api/extensao': return responder(res, 200, await ultimosRecebimentos(d.sql, await buscarCliente(d.sql, q.get('cliente') ?? '')));
          case '/api/criativos': return responder(res, 200, await telaCriativos(d, q.get('cliente') ?? '', q.get('data')));
          case '/api/imagem': {
            const img = await buscarImagem(q.get('url') ?? '');
            res.writeHead(200, { 'Content-Type': img.tipo, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            res.end(img.dados);
            return;
          }
          case '/api/resultados': {
            const p = q.get('plataforma');
            if (p && !['shopee', 'mercado_livre', 'amazon'].includes(p)) throw new ErroPedido('Plataforma desconhecida.');
            const r = await resultadosPeriodo(d.sql, await buscarCliente(d.sql, q.get('cliente') ?? ''), q.get('de') ?? '', q.get('ate') ?? '', (p || null) as FiltroPlataforma);
            return responder(res, 200, r);
          }
          case '/api/diretrizes': return responder(res, 200, await diretrizesDoCliente(d, q.get('cliente') ?? ''));
          case '/api/dia': {
            const cliente = q.get('cliente');
            if (!cliente) throw new ErroPedido('Falta "cliente".');
            const dia = await painelDoDia(d, cliente, q.get('data') ?? undefined);
            await registrar(cliente, 'abrir_dia');
            return responder(res, 200, dia);
          }
        }
        const modelo = url.pathname.match(/^\/modelos\/([a-z-]+\.csv)$/);
        if (modelo && MODELOS_PLANILHA[modelo[1]!]) {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${modelo[1]}"` });
          res.end(await readFile(MODELOS_PLANILHA[modelo[1]!]!));
          return;
        }
        if (!url.pathname.startsWith('/api/')) return servirArquivo(res, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        return responder(res, 404, { erro: 'Rota desconhecida.' });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-cofilius'] !== '1' || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return responder(res, 403, { erro: 'Pedido recusado (origem não confirmada).' });
        }
        const corpo = await lerCorpo(req);
        for (const [re, fn] of rotasPost) {
          const m = url.pathname.match(re);
          if (m) {
            const r = await fn(m, corpo, d);
            log.info('painel.acao', { rota: url.pathname });
            await registrar(corpo.cliente, url.pathname.replace(/[0-9a-f-]{36}\//, '').replace(/^\/api\//, ''));
            return responder(res, 200, r);
          }
        }
        return responder(res, 404, { erro: 'Rota desconhecida.' });
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

/**
 * Rotas da extensão. O código vem no cabeçalho X-Cofilius-Extensao (outro site não consegue mandar
 * esse cabeçalho sem a permissão do painel, que não é dada: não há CORS).
 */
async function rotaExtensao(req: IncomingMessage, res: ServerResponse, url: URL, d: DepsPainel): Promise<void> {
  const codigo = req.headers['x-cofilius-extensao'];
  const cliente = await clientePareado(d.sql, typeof codigo === 'string' ? codigo : undefined);
  if (!cliente) return responder(res, 401, { erro: 'Código de pareamento inválido. Gere um novo no painel, em Configuração.' });
  if (req.method === 'GET' && url.pathname === '/extensao/estado') return responder(res, 200, { ok: true, cliente: cliente.nome });
  if (req.method === 'POST' && url.pathname === '/extensao/receber') {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return responder(res, 415, { erro: 'Envie JSON.' });
    const corpo = await lerCorpo(req);
    if (!Array.isArray(corpo.capturas)) throw new ErroPedido('Falta "capturas".');
    return responder(res, 200, { ok: true, cliente: cliente.nome, ...(await receberCapturas(d.sql, cliente, corpo.capturas)) });
  }
  responder(res, 404, { erro: 'Rota desconhecida.' });
}

/** Compatível com os testes e usos anteriores: painel já configurado, sem esteira automática. */
export function criarServidorPainel(deps: DepsPainel): Server {
  if (!deps.senha) throw new Error('Defina PAINEL_SENHA no .env para usar o painel.');
  return criarAplicacao({ deps });
}

function abrirNavegador(endereco: string): void {
  const comando = process.platform === 'win32' ? `start "" "${endereco}"` : process.platform === 'darwin' ? `open "${endereco}"` : `xdg-open "${endereco}"`;
  exec(comando, () => { /* sem navegador disponível: o endereço fica no terminal */ });
}

if (executadoDiretamente(import.meta.url)) {
  carregarEnv({ path: ARQUIVO_ENV, quiet: true });
  const configurado = !!(process.env.DATABASE_URL && process.env.PAINEL_SENHA);
  const deps = configurado ? montarDepsDoAmbiente(conectar()) : null;
  // Atualizações trazem tabelas novas: aplica as migrations pendentes ao abrir (as já aplicadas são puladas).
  if (deps) {
    try { await migrar(deps.sql); }
    catch (erro) { console.error(`Não consegui atualizar as tabelas do banco: ${(erro as Error).message}. Confira a internet e abra de novo.`); }
  }
  const servidor = criarAplicacao({
    deps, montarDeps: montarDepsDoAmbiente, criarEsteira: (d) => criarEsteiraAutomatica(d),
  });
  const porta = Number(process.env.PAINEL_PORTA || 3000);
  const host = configurado ? process.env.PAINEL_HOST || '127.0.0.1' : '127.0.0.1';
  servidor.listen(porta, host, () => {
    const endereco = `http://127.0.0.1:${porta}`;
    console.log(configurado
      ? `Painel do Cofilius em ${endereco} (IA ${deps!.modelo ? `ligada: ${provedorAtual()}` : 'desligada'}). Deixe esta janela aberta enquanto usa.`
      : `Painel do Cofilius em ${endereco}: abra no navegador para a configuração inicial. Deixe esta janela aberta.`);
    if (process.env.PAINEL_ABRIR_NAVEGADOR !== '0') abrirNavegador(endereco);
  });
}
