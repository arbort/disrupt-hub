#!/usr/bin/env node
// Stage 7 (синдикация) — HUB.md, "Дашборд «Синдикация»". Зеркало
// publish-brief.mjs: кладёт локальный файл syndication/<slug>/<platform>-
// <topic-slug>-<DATE>.md в тот же бакет disrupt-hub-content под префиксом
// _syndication/, тем же приёмом, что ТЗ (_briefs/) и оверрайды тем
// (_topics/) — валидация Cloud Function требует только key.endsWith(".md"),
// без единой правки бэкенда.
//
// Ключ вычисляется из фронтматтера файла (platform + topicId), не из имени
// файла/папки — пакетов синдикации на одну тему может быть до трёх (по
// одному на площадку), и дашборду "Синдикация" нужно находить их по этим
// полям, а не по человекочитаемому слагу.
//
// Использование:
//   node disrupt/hub/admin/scripts/publish-syndication.mjs disrupt/hub/syndication/tool/vc-prezentaciya-2026-09-17.md
//
// Настройки (API_BASE, ADMIN_KEY) — тот же disrupt/hub/admin/scripts/.env.local,
// что и у publish.mjs/publish-brief.mjs.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORMS = ["dzen", "vc", "habr"];

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
    console.error("Использование: node publish-syndication.mjs <путь-к-локальному-пакету.md>");
    process.exit(1);
  }
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`Файл не найден: ${absPath}`);
    process.exit(1);
  }

  const raw = readFileSync(absPath, "utf-8");
  const { fm } = parseFrontmatter(raw);
  if (!fm.topicId || !fm.product || !fm.platform) {
    console.error("Фронтматтер пакета должен содержать topicId, product и platform (см. HUB.md, Stage 7).");
    process.exit(1);
  }
  if (!PLATFORMS.includes(fm.platform)) {
    console.error(`platform должен быть одним из: ${PLATFORMS.join(", ")} (сейчас: ${fm.platform}).`);
    process.exit(1);
  }
  if (!fm.status || !["draft", "ready", "published"].includes(fm.status)) {
    console.error(`status во фронтматтере должен быть "draft"/"ready"/"published" (сейчас: ${fm.status || "не задан"}).`);
    process.exit(1);
  }

  const env = loadEnvLocal();
  if (!env.API_BASE || !env.ADMIN_KEY) {
    console.error(".env.local должен содержать API_BASE и ADMIN_KEY");
    process.exit(1);
  }

  const key = `_syndication/${fm.platform}/${fm.topicId}.md`;
  const headers = { "X-Admin-Key": env.ADMIN_KEY, "Content-Type": "application/json" };

  const res = await fetch(env.API_BASE, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key, raw }),
  });

  if (res.status === 200) {
    const data = await res.json();
    console.log(`Опубликован пакет синдикации: ${key} (etag ${data.etag}, status ${fm.status})`);
    console.log("Откройте вкладку «Синдикация» в админке, чтобы проверить и обновить статус.");
  } else {
    console.error(`Ошибка ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
}

main();
