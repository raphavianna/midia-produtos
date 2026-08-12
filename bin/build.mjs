#!/usr/bin/env node
// Reconstroi a biblioteca de midia:
//   originais/<tipo>/<grupo>/<arquivo>  ->  cdn/<tipo>/<grupo>/<arquivo>--<formato>.jpg
// e regenera indice.csv + index.html.
//
// Incremental: so reprocessa o que mudou (hash do arquivo de origem) e apaga
// derivados orfaos. Rodar de novo sem mudanca nenhuma nao altera nenhum arquivo.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR_ORIGINAIS = join(RAIZ, 'originais');
const DIR_CDN = join(RAIZ, 'cdn');
const ARQ_CACHE = join(RAIZ, '.midia-cache.json');

const EXTENSOES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.gif']);

const cfg = JSON.parse(readFileSync(join(RAIZ, 'midia.config.json'), 'utf8'));

const urlCdn = (p) =>
  `https://cdn.jsdelivr.net/gh/${cfg.repositorio}@${cfg.branch}/${encodeURI(p)}`;
const urlRaw = (p) =>
  `https://raw.githubusercontent.com/${cfg.repositorio}/${cfg.branch}/${encodeURI(p)}`;

/** Lista recursivamente os arquivos de imagem sob `dir`. */
async function listarImagens(dir) {
  if (!existsSync(dir)) return [];
  const achados = [];
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    if (entrada.name.startsWith('.')) continue;
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...(await listarImagens(caminho)));
    else if (EXTENSOES.has(extname(entrada.name).toLowerCase())) achados.push(caminho);
  }
  return achados;
}

/** Lista recursivamente todos os arquivos sob `dir` (usado para achar orfaos). */
async function listarTudo(dir) {
  if (!existsSync(dir)) return [];
  const achados = [];
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    if (entrada.name.startsWith('.')) continue;
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...(await listarTudo(caminho)));
    else achados.push(caminho);
  }
  return achados;
}

const hashDe = (caminho) => createHash('sha1').update(readFileSync(caminho)).digest('hex');

// cdn/ precisa existir mesmo sem nenhuma imagem: o passo de commit do Action
// referencia esse caminho, e um pathspec inexistente aborta o `git add`.
mkdirSync(DIR_CDN, { recursive: true });
writeFileSync(join(DIR_CDN, '.gitkeep'), '');

const cache = existsSync(ARQ_CACHE) ? JSON.parse(readFileSync(ARQ_CACHE, 'utf8')) : {};
const cacheNovo = {};

const origens = (await listarImagens(DIR_ORIGINAIS)).sort();
const linhas = [];
const esperados = new Set();
let gerados = 0;
let reaproveitados = 0;

for (const origem of origens) {
  const rel = relative(DIR_ORIGINAIS, origem).split(sep);
  const tipo = rel[0];                                   // produtos | campanhas
  const grupo = rel.length > 2 ? rel[1] : '(sem grupo)'; // SKU ou nome da campanha
  const nomeBase = basename(origem, extname(origem));

  const ajuste = cfg.ajustePorPasta?.[tipo] ?? 'contain';
  const hash = hashDe(origem);
  const relOrigem = join('originais', relative(DIR_ORIGINAIS, origem)).split(sep).join('/');

  let meta;
  try {
    meta = await sharp(origem).metadata();
  } catch (erro) {
    console.error(`  ! ignorado (nao e imagem valida): ${relOrigem} — ${erro.message}`);
    continue;
  }

  // A origem em resolucao cheia tambem ganha link.
  linhas.push({
    tipo, grupo, arquivo: nomeBase, formato: 'original',
    largura: meta.width ?? '', altura: meta.height ?? '',
    peso_kb: Math.round((await stat(origem)).size / 1024),
    caminho: relOrigem,
  });

  const saidas = [];
  for (const [nomeFormato, dim] of Object.entries(cfg.formatos)) {
    const extensoes = cfg.gerarWebp ? ['jpg', 'webp'] : ['jpg'];

    for (const ext of extensoes) {
      const relSaida = join('cdn', tipo, grupo === '(sem grupo)' ? '' : grupo,
        `${nomeBase}--${nomeFormato}.${ext}`).split(sep).join('/');
      const destino = join(RAIZ, relSaida);
      esperados.add(relSaida);
      saidas.push(relSaida);

      const registro = cache[relOrigem];
      const jaValido = registro?.hash === hash
        && registro?.ajuste === ajuste
        && registro?.qualidade === cfg.qualidade
        && registro?.fundo === cfg.fundo
        && registro?.saidas?.includes(relSaida)
        && existsSync(destino);

      if (!jaValido) {
        mkdirSync(dirname(destino), { recursive: true });
        let pipe = sharp(origem).resize(dim.largura, dim.altura, {
          fit: ajuste,
          background: cfg.fundo,
          withoutEnlargement: false,
        });
        pipe = ext === 'webp'
          ? pipe.webp({ quality: cfg.qualidade })
          : pipe.flatten({ background: cfg.fundo }).jpeg({ quality: cfg.qualidade, mozjpeg: true });
        await pipe.toFile(destino);
        gerados++;
      } else {
        reaproveitados++;
      }

      linhas.push({
        tipo, grupo, arquivo: nomeBase, formato: `${nomeFormato} (${ext})`,
        largura: dim.largura, altura: dim.altura,
        peso_kb: Math.round((await stat(destino)).size / 1024),
        caminho: relSaida,
      });
    }
  }

  cacheNovo[relOrigem] = { hash, ajuste, qualidade: cfg.qualidade, fundo: cfg.fundo, saidas };
}

// Remove derivados de origens que sumiram ou de formatos que saíram da config.
let removidos = 0;
for (const arquivo of await listarTudo(DIR_CDN)) {
  const rel = relative(RAIZ, arquivo).split(sep).join('/');
  if (!esperados.has(rel)) {
    rmSync(arquivo);
    removidos++;
  }
}

writeFileSync(ARQ_CACHE, JSON.stringify(cacheNovo, null, 2) + '\n');

// ---------------------------------------------------------------- indice.csv
const COLUNAS = ['tipo', 'grupo', 'arquivo', 'formato', 'largura', 'altura', 'peso_kb', 'url_cdn', 'url_raw'];
const csvCampo = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csv = [COLUNAS.join(',')];
for (const l of linhas) {
  csv.push([l.tipo, l.grupo, l.arquivo, l.formato, l.largura, l.altura, l.peso_kb,
    urlCdn(l.caminho), urlRaw(l.caminho)].map(csvCampo).join(','));
}
writeFileSync(join(RAIZ, 'indice.csv'), '﻿' + csv.join('\n') + '\n');

// O `index.html` NAO e mais gerado aqui.
//
// Ele passou a ser o menu de navegacao escrito a mao, que le `catalogo.json` e
// `artes.json` em runtime. Regerar a galeria antiga aqui apagaria o menu a
// cada build. O `indice.csv` acima continua sendo o registro dos derivados
// locais, para quem precisa conferir o que foi gerado.

console.log(`origens: ${origens.length} | derivados gerados: ${gerados} | reaproveitados: ${reaproveitados} | orfaos removidos: ${removidos}`);
console.log(`linhas no indice: ${linhas.length}`);
