import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * true quando o arquivo (import.meta.url) foi chamado direto pelo terminal (ex.: `tsx painel/servidor.ts`).
 * No Windows, compara sem diferenciar maiúsculas (a letra do disco pode vir "c:" ou "C:").
 */
export function executadoDiretamente(importMetaUrl: string): boolean {
  const chamado = process.argv[1];
  if (!chamado) return false;
  const a = resolve(fileURLToPath(importMetaUrl));
  const b = resolve(chamado);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
