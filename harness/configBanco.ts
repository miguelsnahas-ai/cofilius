/**
 * Configuração do painel guardada no banco, para quando ele roda na nuvem (Vercel), onde não existe .env
 * gravável. As chaves de API ficam cifradas (AES-GCM) com CREDENCIAIS_CHAVE, que só existe nas variáveis
 * do Vercel. Na carga, o banco vale por cima das variáveis de ambiente (é o que a pessoa mudou no painel).
 */
import type { Sql } from './db.ts';
import { cifrar, decifrar, importarChave } from './cripto.ts';
import { log } from './log.ts';

/** O que o painel pode gravar, e o que vai cifrado. Senha, banco e chave mestra ficam fora: só no Vercel. */
export const CHAVES_CONFIG: Record<string, { cifrado: boolean }> = {
  PAINEL_OPERADOR: { cifrado: false },
  IA_PROVEDOR: { cifrado: false },
  MODELO_IA_PEQUENO: { cifrado: false },
  MODELO_IA_FORTE: { cifrado: false },
  PAINEL_ESTEIRA: { cifrado: false },
  GEMINI_API_KEY: { cifrado: true },
  ANTHROPIC_API_KEY: { cifrado: true },
};

const contexto = (chave: string) => `configuracao/${chave}`;

/** Grava (null apaga) e já aplica em process.env. */
export async function salvarConfigNoBanco(sql: Sql, valores: Record<string, string | null>): Promise<void> {
  const chaveMestra = Object.entries(valores).some(([k, v]) => v !== null && CHAVES_CONFIG[k]?.cifrado)
    ? await importarChave(process.env.CREDENCIAIS_CHAVE)
    : null;
  for (const [k, v] of Object.entries(valores)) {
    const regra = CHAVES_CONFIG[k];
    if (!regra) throw new Error(`Configuração "${k}" não pode ser gravada pelo painel na nuvem.`);
    if (v === null) {
      await sql`delete from configuracoes where chave = ${k}`;
      delete process.env[k];
      continue;
    }
    const valor = regra.cifrado ? await cifrar(chaveMestra!, v, contexto(k)) : v;
    await sql`
      insert into configuracoes (chave, valor, cifrado) values (${k}, ${valor}, ${regra.cifrado})
      on conflict (chave) do update set valor = excluded.valor, cifrado = excluded.cifrado, atualizado_em = now()`;
    process.env[k] = v;
  }
}

/** Lê o banco e aplica em process.env. Uma chave que não decifra é ignorada (com log), sem derrubar o painel. */
export async function carregarConfigDoBanco(sql: Sql): Promise<number> {
  const linhas = await sql<{ chave: string; valor: string; cifrado: boolean }[]>`select chave, valor, cifrado from configuracoes`;
  let chaveMestra: CryptoKey | null = null;
  let aplicadas = 0;
  for (const l of linhas) {
    if (!CHAVES_CONFIG[l.chave]) continue;
    try {
      if (l.cifrado) {
        chaveMestra ??= await importarChave(process.env.CREDENCIAIS_CHAVE);
        process.env[l.chave] = await decifrar(chaveMestra, l.valor, contexto(l.chave));
      } else {
        process.env[l.chave] = l.valor;
      }
      aplicadas++;
    } catch (erro) {
      log.error('config.nao_decifrou', { chave: l.chave, erro: (erro as Error).message });
    }
  }
  return aplicadas;
}

// ---------------------------------------------------------------------------
// Bloqueio de quem erra a senha (ou o código da extensão) muitas vezes
// ---------------------------------------------------------------------------

export const MAX_TENTATIVAS = 10;
export const JANELA_MINUTOS = 15;

export async function bloqueado(sql: Sql, ip: string, tipo: 'senha' | 'extensao'): Promise<boolean> {
  const [r] = await sql`
    select count(*)::int as n from tentativas_acesso
    where ip = ${ip} and tipo = ${tipo} and em > now() - make_interval(mins => ${JANELA_MINUTOS})`;
  return r!.n >= MAX_TENTATIVAS;
}

export async function registrarTentativaErrada(sql: Sql, ip: string, tipo: 'senha' | 'extensao'): Promise<void> {
  await sql`insert into tentativas_acesso (ip, tipo) values (${ip}, ${tipo})`;
  // Limpeza: guarda só o último dia.
  if (Math.random() < 0.05) await sql`delete from tentativas_acesso where em < now() - interval '1 day'`;
}
