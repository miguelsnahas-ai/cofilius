/**
 * Leitura e gravação do arquivo .env pelo painel (configuração sem terminal).
 * Preserva comentários e as outras linhas; troca só as chaves pedidas (inclusive linhas "# CHAVE=" comentadas).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pasta raiz do projeto (onde fica o .env). */
export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ARQUIVO_ENV = join(RAIZ, '.env');

const CHAVE = /^[A-Z][A-Z0-9_]*$/;

function formatar(valor: string): string {
  if (/[\r\n]/.test(valor)) throw new Error('Valor com quebra de linha não é aceito.');
  if (/^[A-Za-z0-9_./:@+\-=,]*$/.test(valor)) return valor;
  // O dotenv lê o conteúdo entre aspas simples, duplas ou crase sem interpretar escapes: usa a que não aparece no valor.
  for (const aspa of ["'", '"', '`']) if (!valor.includes(aspa)) return `${aspa}${valor}${aspa}`;
  throw new Error('Valor com aspas simples, duplas e crase ao mesmo tempo não é aceito.');
}

/**
 * Grava valores no .env (null apaga a chave). Cria o arquivo a partir do .env.example se não existir.
 * Também atualiza process.env, para valer sem reiniciar o que lê do ambiente na hora do uso.
 */
export async function salvarNoEnv(valores: Record<string, string | null>, arquivo = ARQUIVO_ENV): Promise<void> {
  let texto = existsSync(arquivo)
    ? await readFile(arquivo, 'utf8')
    : existsSync(join(dirname(arquivo), '.env.example')) ? await readFile(join(dirname(arquivo), '.env.example'), 'utf8') : '';
  const linhas = texto.split(/\r?\n/);
  for (const [chave, valor] of Object.entries(valores)) {
    if (!CHAVE.test(chave)) throw new Error(`Chave inválida: ${chave}`);
    const re = new RegExp(`^\\s*#?\\s*${chave}=`);
    const i = linhas.findIndex((l) => re.test(l));
    const nova = valor === null ? null : `${chave}=${formatar(valor)}`;
    if (i >= 0) {
      if (nova === null) linhas.splice(i, 1);
      else linhas[i] = nova;
    } else if (nova !== null) {
      linhas.push(nova);
    }
    if (valor === null) delete process.env[chave];
    else process.env[chave] = valor;
  }
  texto = linhas.join('\n').replace(/\n*$/, '\n');
  await writeFile(arquivo, texto, { encoding: 'utf8', mode: 0o600 });
}
