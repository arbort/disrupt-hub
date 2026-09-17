#!/usr/bin/env node
// Гейт 2 (Stage 2, ТЗ) — HUB.md, "Семантика вперёд тем" / "Двухступенчатый гейт".
// Зеркало publish.mjs (Stage 5), но для ТЗ, не для статей: кладёт локальный
// файл briefs/<slug>/<topic-slug>-<DATE>.md в тот же бакет disrupt-hub-content
// под префиксом _briefs/ — тем же приёмом, что уже используют живые
// оверрайды статуса тем (_topics/): валидация Cloud Function требует только
// key.endsWith(".md"), без единой правки бэкенда.
//
// В отличие от publish.mjs — ключ вычисляется из фронтматтера файла
// (product + topicId), не из имени файла/папки: путь к ТЗ уже содержит дату
// и человекочитаемый слаг темы (<topic-slug>-<DATE>.md), а объект в бакете
// должен адресоваться по topicId — так его находит дашборд "ТЗ" и реестр
// тем при поиске "есть ли ТЗ у этой темы".
//
// Использование:
//   node disrupt/hub/admin/scripts/publish-brief.mjs disrupt/hub/briefs/tool/kejs-sajt-2026-09-17.md
//
// Настройки (API_BASE, ADMIN_KEY) — тот же disrupt/hub/admin/scripts/.env.local,
// что и у publish.mjs.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Фронтматтер ТЗ — плоские строковые поля, тот же минимальный парсер, что и
// в app.js (полноценный YAML не нужен для {topicId, product, status, createdAt}).
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fm, body: m[2] };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Использование: node publish-brief.mjs <путь-к-локальному-ТЗ.md>");
    process.exit(1);
  }
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`Файл не найден: ${absPath}`);
    process.exit(1);
  }

  const raw = readFileSync(absPath, "utf-8");
  const { fm } = parseFrontmatter(raw);
  if (!fm.topicId || !fm.product) {
    console.error("Фронтматтер ТЗ должен содержать topicId и product (см. HUB.md, Stage 2).");
    process.exit(1);
  }
  if (!fm.status || !["draft", "approved"].includes(fm.status)) {
    console.error(`status во фронтматтере должен быть "draft" или "approved" (сейчас: ${fm.status || "не задан"}).`);
    process.exit(1);
  }

  const env = loadEnvLocal();
  if (!env.API_BASE || !env.ADMIN_KEY) {
    console.error(".env.local должен содержать API_BASE и ADMIN_KEY");
    process.exit(1);
  }

  const key = `_briefs/${fm.product}/${fm.topicId}.md`;
  const headers = { "X-Admin-Key": env.ADMIN_KEY, "Content-Type": "application/json" };

  const res = await fetch(env.API_BASE, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key, raw }),
  });

  if (res.status === 200) {
    const data = await res.json();
    console.log(`Опубликовано ТЗ: ${key} (etag ${data.etag}, status ${fm.status})`);
    console.log("Откройте вкладку «ТЗ» в админке, чтобы утвердить его перед черновиком (Гейт 2).");
  } else {
    console.error(`Ошибка ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
}

main();
