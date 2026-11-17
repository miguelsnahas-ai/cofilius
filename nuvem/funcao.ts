/**
 * Cofilius na nuvem (Vercel): uma função só atende o painel inteiro, a extensão e o agendador.
 *
 * - Variáveis no Vercel: DATABASE_URL (Supabase), PAINEL_SENHA (12+ caracteres), CREDENCIAIS_CHAVE,
 *   CRON_SECRET; o resto (chave da IA, provedor, modelos) se configura no próprio painel e fica no banco.
 * - Rotas: tudo chega aqui (config.json manda para /index com o caminho original em __caminho).
 * - /api/cron/esteira?rodada=manha|noite: chamado pelo agendador do Vercel com "Authorization: Bearer CRON_SECRET".
 * - As tabelas são criadas ou atualizadas na primeira chamada de cada instância (migrations são idempotentes).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { conectar, type Sql } from '../harness/db.ts';
import { migrar } from '../db/migrate.ts';
import { carregarConfigDoBanco } from '../harness/configBanco.ts';
import { criarManipulador, montarDepsDoAmbiente } from '../painel/servidor.ts';
import { criarEsteiraAutomatica, rodadaAgendada } from '../painel/esteiraAutomatica.ts';
import { log } from '../harness/log.ts';

export const SENHA_MINIMA_NUVEM = 12;

function texto(res: ServerResponse, status: number, msg: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(msg);
}

function json(res: ServerResponse, status: number, corpo: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

/** O roteamento do Vercel manda tudo para a função com o caminho original em ?__caminho=. */
export function restaurarCaminho(url: string): string {
  const u = new URL(url, 'http://painel');
  const caminho = u.searchParams.get('__caminho');
  if (caminho === null) return url;
  u.searchParams.delete('__caminho');
  const busca = u.searchParams.toString();
  return `/${caminho.replace(/^\/+/, '')}${busca ? `?${busca}` : ''}`;
}

function segredoConfere(recebido: string | undefined, esperado: string): boolean {
  const a = Buffer.from(recebido ?? '');
  const b = Buffer.from(`Bearer ${esperado}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OpcoesFuncao {
  /** Banco já conectado (testes). Sem ele, conecta em DATABASE_URL. */
  sql?: Sql;
  /** Relógio (testes). */
  agora?: () => Date;
}

export function criarFuncao(op: OpcoesFuncao = {}) {
  let sql: Sql | null = op.sql ?? null;
  let preparo: Promise<unknown> | null = null;

  async function preparar(): Promise<Sql> {
    sql ??= conectar();
    preparo ??= migrar(sql).catch((erro) => { preparo = null; throw erro; });
    await preparo;
    return sql;
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.url = restaurarCaminho(req.url ?? '/');
    const faltando = ['DATABASE_URL', 'PAINEL_SENHA', 'CREDENCIAIS_CHAVE'].filter((k) => !process.env[k] && !(k === 'DATABASE_URL' && op.sql));
    if (faltando.length) {
      // Sugestões geradas agora (sem terminal). A chave mestra só vale para um banco novo: se o banco já tem
      // credenciais gravadas pelo painel do computador, use a CREDENCIAIS_CHAVE do .env de lá.
      const sugestoes = [
        faltando.includes('CREDENCIAIS_CHAVE') ? `CREDENCIAIS_CHAVE (banco novo): ${randomBytes(32).toString('base64')}` : null,
        !process.env.CRON_SECRET ? `CRON_SECRET: ${randomBytes(24).toString('base64url')}` : null,
      ].filter(Boolean);
      return texto(res, 503, [
        `O Cofilius ainda não foi configurado na nuvem. Falta nas variáveis do projeto no Vercel: ${faltando.join(', ')}. Depois publique de novo (Redeploy).`,
        ...(sugestoes.length ? ['', 'Valores sugeridos, gerados agora:', ...sugestoes] : []),
      ].join('\n'));
    }
    if ((process.env.PAINEL_SENHA ?? '').length < SENHA_MINIMA_NUVEM) {
      return texto(res, 503, `Na internet a senha do painel precisa de pelo menos ${SENHA_MINIMA_NUVEM} caracteres. Troque PAINEL_SENHA no Vercel e publique de novo.`);
    }
    try {
      const banco = await preparar();
      await carregarConfigDoBanco(banco);
      const deps = montarDepsDoAmbiente(banco);
      const url = new URL(req.url, 'http://painel');

      if (url.pathname === '/api/cron/esteira') {
        const segredo = process.env.CRON_SECRET;
        if (!segredo) return json(res, 503, { erro: 'Defina CRON_SECRET nas variáveis do Vercel para a esteira rodar sozinha.' });
        if (!segredoConfere(req.headers.authorization, segredo)) return json(res, 401, { erro: 'Não autorizado.' });
        if (process.env.PAINEL_ESTEIRA === 'desligada') return json(res, 200, { ok: true, pulada: 'esteira desligada na Configuração' });
        const rodada = url.searchParams.get('rodada') === 'noite' ? 'noite' : 'manha';
        const r = await rodadaAgendada(deps, rodada, { agora: op.agora?.() });
        return json(res, 200, { ok: true, ...r });
      }

      return await criarManipulador({
        deps, nuvem: true, iniciarEsteira: false, criarEsteira: (d) => criarEsteiraAutomatica(d),
      })(req, res);
    } catch (erro) {
      log.error('nuvem.erro', { rota: req.url, erro: (erro as Error).message });
      if (!res.headersSent) json(res, 500, { erro: 'Erro interno no Cofilius. Veja os registros (Logs) do projeto no Vercel.' });
    }
  };
}

export default criarFuncao();
