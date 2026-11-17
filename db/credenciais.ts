/**
 * Leitura e gravação da tabela `credenciais`. Os valores só existem decifrados em memória.
 */
import type { Sql } from '../harness/db.ts';
import { cifrar, decifrar } from '../harness/cripto.ts';
import type { CredenciaisShopee } from '../services/shopee/client.ts';

type Plataforma = 'shopee' | 'mercado_livre' | 'amazon' | 'whatsapp';

const contexto = (clienteId: string, plataforma: Plataforma, nome: string) => `${clienteId}/${plataforma}/${nome}`;

export async function salvarCredencial(
  sql: Sql, chave: CryptoKey, clienteId: string, plataforma: Plataforma, nome: string, valor: unknown,
): Promise<void> {
  const cifrado = await cifrar(chave, JSON.stringify(valor), contexto(clienteId, plataforma, nome));
  await sql`
    insert into credenciais (cliente_id, plataforma, nome, valor_cifrado)
    values (${clienteId}, ${plataforma}, ${nome}, ${cifrado})
    on conflict (cliente_id, plataforma, nome) do update set valor_cifrado = excluded.valor_cifrado`;
}

export async function lerCredencial<T>(
  sql: Sql, chave: CryptoKey, clienteId: string, plataforma: Plataforma, nome: string,
): Promise<T> {
  const [linha] = await sql`
    select valor_cifrado from credenciais
    where cliente_id = ${clienteId} and plataforma = ${plataforma} and nome = ${nome}`;
  if (!linha) throw new Error(`Credencial ${plataforma}/${nome} não cadastrada para este cliente.`);
  return JSON.parse(await decifrar(chave, linha.valor_cifrado, contexto(clienteId, plataforma, nome))) as T;
}

export const salvarCredencialShopee = (sql: Sql, chave: CryptoKey, clienteId: string, cred: CredenciaisShopee) =>
  salvarCredencial(sql, chave, clienteId, 'shopee', 'open_api', { appId: cred.appId, secret: cred.secret });

export const lerCredencialShopee = (sql: Sql, chave: CryptoKey, clienteId: string) =>
  lerCredencial<CredenciaisShopee>(sql, chave, clienteId, 'shopee', 'open_api');
