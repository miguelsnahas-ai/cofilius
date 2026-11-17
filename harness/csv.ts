/**
 * Leitor de CSV simples, sem dependência. Aceita separador ";" (Excel em português), "," (Google Planilhas)
 * ou tabulação, campos entre aspas, aspas duplicadas ("") e BOM no início.
 */
export function lerCsv(texto: string): string[][] {
  const t = texto.replace(/^﻿/, '');
  const primeira = t.split(/\r?\n/, 1)[0] ?? '';
  const separador = [';', '\t', ','].map((s) => ({ s, n: primeira.split(s).length })).sort((a, b) => b.n - a.n)[0]!.s;

  const linhas: string[][] = [];
  let linha: string[] = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === separador) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      linha.push(campo); linhas.push(linha); linha = []; campo = '';
    } else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((c) => c.trim() !== ''));
}

/**
 * Número em formato brasileiro ou internacional: "R$ 1.299,90", "29,90", "29.90", "25%".
 * Devolve null se vazio ou "-".
 */
export function numeroBr(v: string | undefined): number | null {
  if (v === undefined) return null;
  let s = v.replace(/R\$|%|\s/g, '').trim();
  if (s === '' || s === '-') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
