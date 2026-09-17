#!/usr/bin/env node
// Stage 5 (хэндофф на публикацию) — HUB.md. Пушит один локальный файл статьи
// в бакет disrupt-hub-content через Cloud Function, вместо того чтобы просто
// поменять status в articles/ (там его не видит ни бакет, ни веб-админка).
//
// Использование:
//   node disrupt/hub/admin/scripts/publish.mjs disrupt/hub/articles/tool/kejs-sajt.md
//
// Ключ объекта в бакете = <имя-папки-продукта>/<имя-файла>.md — то же самое
// соглашение, что уже определяет URL на сайте (content.config.ts + [slug].astro).
//
// Настройки (API_BASE, ADMIN_KEY) читаются из disrupt/hub/admin/scripts/.env.local
// — untracked-файл, создать вручную по .env.local.example. Не класть значение
// ADMIN_SECRET ни в один файл, который читает hub-writer как контекст (HUB.md,
// briefing/*, topics/*) — только сюда.
//
// Защита от перезаписи: локальный файл .publish-state.json (untracked, рядом
// с этим скриптом) хранит последний etag, который САМ ЭТОТ скрипт видел для
// каждого ключа. Он сверяется с текущим состоянием бакета при публикации —
// если между прошлым запуском publish.mjs для этого файла и сейчас кто-то
// (например, веб-админка) поменял объект в бакете, будет 409, а не тихая
// перезапись. Свежий GET прямо перед PUT для этого НЕ годится: между чтением
// и записью в одном и том же процессе ничего не успевает измениться, поэтому
// такая проверка всегда бы совпадала сама с собой — это было реальным багом
// первой версии скрипта, найденным вручную 2026-09-13.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, ".publish-state.json");

function loadEnvLocal() {
  const path = resolve(__dirname, ".env.local");
  if (!existsSync(path)) {
    console.error(
      `Не найден ${path}.\nСоздайте его по образцу .env.local.example: API_BASE=<invoke-url>, ADMIN_KEY=<секрет>.`,
    );
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Использование: node publish.mjs <путь-к-локальному-файлу.md>");
    process.exit(1);
  }
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`Файл не найден: ${absPath}`);
    process.exit(1);
  }

  const env = loadEnvLocal();
  if (!env.API_BASE || !env.ADMIN_KEY) {
    console.error(".env.local должен содержать API_BASE и ADMIN_KEY");
    process.exit(1);
  }

  const raw = readFileSync(absPath, "utf-8");
  const key = `${basename(dirname(absPath))}/${basename(absPath)}`;
  const headers = { "X-Admin-Key": env.ADMIN_KEY, "Content-Type": "application/json" };
  const state = loadState();

  let ifMatch = state[key];

  if (!ifMatch) {
    // Этот скрипт ещё не публиковал такой ключ — проверяем, не существует ли
    // он уже в бакете (создан кем-то другим, например веб-админкой), чтобы не
    // затереть его вслепую при первом контакте.
    const existing = await fetch(`${env.API_BASE}?action=get&key=${encodeURIComponent(key)}`, { headers });
    if (existing.status === 200) {
      const data = await existing.json();
      ifMatch = data.etag;
      console.error(`Внимание: ${key} уже существует в бакете (не публиковался этим скриптом раньше). Публикую поверх текущей версии.`);
    } else if (existing.status !== 404) {
      console.error(`Не удалось проверить текущее состояние (${existing.status}): ${await existing.text()}`);
      process.exit(1);
    }
  }

  const res = await fetch(env.API_BASE, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key, raw, ifMatch }),
  });

  if (res.status === 200) {
    const data = await res.json();
    state[key] = data.etag;
    saveState(state);
    console.log(`Опубликовано: ${key} (etag ${data.etag})`);
    console.log("Это положило файл в disrupt-hub-content. Чтобы статья появилась на живом сайте — npm run deploy в disrupt/hub/site/.");
  } else if (res.status === 409) {
    const data = await res.json();
    console.error(`Конфликт: объект в бакете изменился с прошлой публикации этим скриптом.\nТекущее содержимое в бакете (первые 300 символов):\n${data.currentRaw.slice(0, 300)}...`);
    console.error("Сверьте вручную и повторите — автослияния нет.");
    process.exit(1);
  } else {
    console.error(`Ошибка ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
}

main();
