// Disrupt-Hub admin — генератор реестра тем для дашборда админки.
// Парсит disrupt/hub/topics/<product>-backlog.md (таблицы "Тема") в единый
// JSON, который просто лежит статикой в admin/web/data/topics.json и уходит
// в бакет вместе с остальной админкой через `npm run deploy:admin` — без
// изменений в Cloud Function и без отдельного шага деплоя.
//
// Запуск: node admin/scripts/sync-topics.mjs (из disrupt/hub/)
// Перезапускать после любой правки статусов в topics/*-backlog.md.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_DIR = path.resolve(__dirname, "..", "..");
const TOPICS_DIR = path.join(HUB_DIR, "topics");
const OUT_FILE = path.join(HUB_DIR, "admin", "web", "data", "topics.json");
const PRODUCT_FIT_FILE = path.join(__dirname, "topic-product-fit.json");

// Ручная разметка "якорная / периферийная" по каждой теме (см. комментарий
// в самом файле) — не выводится автоматически, привязка сценария темы к
// ведущему сценарию продукта требует чтения briefing-файла человеком/агентом.
const productFit = JSON.parse(readFileSync(PRODUCT_FIT_FILE, "utf-8"));
delete productFit._comment;

// Тот же список продуктов, что и в admin/web/app.js (PRODUCTS) — держим руками
// синхронизированным, это тонкий список из 10 строк, менявшийся редко.
// nika-backlog.md сознательно не парсим: продукт приостановлен и не входит
// в подтверждённый ростер хаба (см. project_disrupt_hub в памяти сессии).
const PRODUCT_SLUGS = ["tool", "type", "concierge", "aiwa", "gochi", "narra", "memento", "korche", "radar", "reka"];

// Колонки различаются между файлами (напр. aiwa-backlog.md вставляет
// дополнительную "Линия" между Темой и Кластером) — сопоставляем по имени
// заголовка, а не по фиксированной позиции, иначе съезжает частотность/статус.
const HEADER_MAP = {
  "тема": "title",
  "кластер": "cluster",
  "доказывает": "feature",
  "аудитория": "audience",
  "частотность": "frequency",
  "статус": "status",
};

function matchHeaderField(headerCell) {
  const norm = headerCell.toLowerCase();
  for (const [needle, field] of Object.entries(HEADER_MAP)) {
    if (norm.includes(needle)) return field;
  }
  return null;
}

function parseBacklog(slug, raw) {
  const lines = raw.split(/\r?\n/);
  const topics = [];
  let fieldByIndex = null; // индекс ячейки -> имя поля, задаётся при встрече заголовка
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) { fieldByIndex = null; continue; }
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    if (!cells.length) continue;

    if (cells[0] === "#") {
      fieldByIndex = cells.map(matchHeaderField);
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue; // разделитель "---|---|..."
    if (!fieldByIndex) continue;

    const number = parseInt(cells[0], 10);
    if (!Number.isFinite(number)) continue;

    const row = { title: "", cluster: "", feature: "", audience: "", frequency: "", status: "идея" };
    for (let i = 1; i < cells.length; i++) {
      const field = fieldByIndex[i];
      if (field) row[field] = cells[i];
    }
    const topicId = `${slug}-${number}`;
    const fit = productFit[topicId];
    if (!fit) console.warn(`  ! нет productFit для ${topicId} в topic-product-fit.json — считаю "peripheral"`);
    topics.push({ topicId, product: slug, number, ...row, status: row.status.trim(), productFit: fit || "peripheral" });
  }
  return topics;
}

const files = readdirSync(TOPICS_DIR).filter((f) => f.endsWith("-backlog.md"));
const allTopics = [];
for (const file of files) {
  const slug = file.replace(/-backlog\.md$/, "");
  if (!PRODUCT_SLUGS.includes(slug)) continue; // nika и любые будущие паузы
  const raw = readFileSync(path.join(TOPICS_DIR, file), "utf-8");
  allTopics.push(...parseBacklog(slug, raw));
}

allTopics.sort((a, b) => (a.product === b.product ? a.number - b.number : a.product.localeCompare(b.product)));

writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), topics: allTopics }, null, 2) + "\n");
console.log(`Записано ${allTopics.length} тем из ${files.length} файлов → ${path.relative(HUB_DIR, OUT_FILE)}`);
