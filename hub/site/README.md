# disrupt-hub.ru — платформа v1

Статический сайт на Astro. **С 2026-09-13** контент читается из
`disrupt/hub/articles-published/` (content collection с
`base: "../articles-published"` в `src/content.config.ts`) — зеркало бакета
`disrupt-hub-content`, синхронизируется командой `npm run sync-content`.
`hub-writer` по-прежнему пишет черновики в `disrupt/hub/articles/`
(idea/brief/draft/qc) по контракту `disrupt/hub/HUB.md`; чтобы статья попала
в `articles-published/` и на сайт, её нужно опубликовать через
`disrupt/hub/admin/scripts/publish.mjs` или через веб-админку (см. «Админка»
ниже) — просто поменять `status` в локальном файле недостаточно. Сайт
рендерит только статьи со `status: published`.

## Запуск

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # статическая сборка в dist/
```

## Фронтматтер статьи (контракт со Stage 3 в HUB.md)

```yaml
---
title: "Заголовок"
product: tool        # слаг из src/data/products.ts
status: draft         # idea | brief | draft | qc | published — рендерится только published
h1: "H1 на странице"
metaTitle: "..."
metaDescription: "..."
date: 2026-09-12
# Добавлено 2026-09-13 вместе с админкой — все необязательные:
canonical: ""         # override; по умолчанию считается из адреса статьи
ogImage: ""
robots: ""             # по умолчанию "index, follow"
schemaType: ""          # Article (по умолчанию) | HowTo
---
```

## Дизайн

Токены — `src/styles/deslop/` (colors.css, typography.css, layout.css),
скопированы как есть из `github.com/mishanaer/deslop` (`primitives/`) по их
же конвенции: не npm-пакет, файлы копируются в проект. Тёмная тема включена
жёстко атрибутом `data-color-scheme="dark"` на `<html>` (`BaseLayout.astro`)
— решение Арсения 2026-09-12, сознательное исключение из правила
«независимый брендинг» для дизрапт-продуктов (см. `HUB.md`, «Решения от
2026-09-12»): то правило про рекламные креативы, не про эту поверхность.

Шрифт: токены называют семью «SB Sans Interface», в deslop это файлы
`SBSansUI-*.otf` (не SBSansText) — соответствие уже верно прописано в
скопированном `typography.css`.

## Хостинг — Yandex Object Storage (грант Арсения)

**Живой адрес:** https://disrupt-hub-deploy.website.yandexcloud.net/
(HTTPS работает из коробки на общем домене `*.website.yandexcloud.net`).

- Бакет `disrupt-hub-deploy`, регион `ru-central1`, эндпоинт
  `storage.yandexcloud.net` — S3-совместимый API
- Статический хостинг включён (`IndexDocument: index.html`,
  `ErrorDocument: 404.html`)
- Публичный доступ — через **object ACL** `public-read` при заливке
  (`aws s3 sync --acl public-read`), **не через bucket policy**: bucket
  policy на этом бакете один раз сломал `ListBucket` даже для сервисного
  аккаунта с ролью `storage.admin` — похоже, явная policy в Yandex Object
  Storage перекрывает IAM-доступ вместо того, чтобы складываться с ним, как
  в обычном S3. Если понадобится bucket policy для чего-то другого — сначала
  проверить на некритичном бакете
- Передеплой: `npm run deploy` (требует локально настроенный aws-cli
  профиль `yandex` — `aws configure set ... --profile yandex`, ключи у
  Арсения, в репозиторий не коммитятся)

**Домен `disrupt-hub.ru` пока не подключён** — сайт живёт только на дефолтном
адресе бакета. Подключение кастомного домена потребует Yandex Cloud CDN
(для HTTPS-сертификата на своём домене) — отдельный шаг, не сделан.

## Админка — управление статьями и SEO-чеклист

**Задеплоена и проверена 2026-09-13.** Хостед-панель на собственном Yandex
Cloud Арсения (не Claude Artifact — там CSP блокирует fetch к внешним API).
Полный разбор архитектуры и решений — `disrupt/hub/HUB.md`, раздел «Админка
и SEO-инфраструктура».

**Живой адрес:** https://disrupt-hub-deploy.website.yandexcloud.net/admin/
**Invoke URL функции:** `https://functions.yandexcloud.net/d4eobgv7s83dlj3pqr3n`
(ID функции `d4eobgv7s83dlj3pqr3n`, версия `d4e1p5fkn93ispo04lu2`, сервис-аккаунт
`disrupt-hub-content-sa` / `ajeim1pot30hc517ms3a`)

**Компоненты:**
- `disrupt/hub/admin/function/` — Cloud Function (Node.js 22, entrypoint
  `index.handler`), CRUD статей в бакете `disrupt-hub-content`. Публичная (не
  приватная — иначе браузерный CORS-preflight не проходит), авторизация
  заголовком `X-Admin-Key` внутри кода. **Деплой пакета — только вручную через
  консоль** (Function → загрузить ZIP): автоматическое создание версии из
  ссылки на объект в Object Storage дважды воспроизводимо ломалось (`Cannot
  find module '/function/code/index.js'` при валидном, побайтово сверенном
  архиве) — причина не установлена, ручная загрузка ZIP-файла в консоли
  работает надёжно.
- `disrupt/hub/admin/web/` — статика админки (логин, список статей, редактор
  с markdown-превью, живой SEO-чеклист). Залита в бакет сайта, путь `/admin/`.
  Обновление: `npm run deploy:admin`.
- `disrupt/hub/admin/scripts/publish.mjs` — Stage 5 хэндофф: пушит один
  локальный файл `articles/<slug>/*.md` в бакет с проверкой ETag. Ведёт
  локальный `admin/scripts/.publish-state.json` (untracked, создаётся сам) —
  хранит etag, который скрипт последним записал для каждого ключа, и
  сверяет его перед следующей публикацией того же файла. **Не сверять
  etag свежим GET прямо перед PUT** — в рамках одного процесса такая
  проверка всегда совпадает сама с собой и не ловит реальный конфликт с
  правкой из веб-админки; это была настоящая ошибка первой версии скрипта,
  найдена и исправлена 2026-09-13 при живом тесте (конфликт не сработал в
  первом прогоне, из-за чего локальный черновик тихо затёр правку,
  сделанную «извне»).

**Разовая настройка на стороне Yandex Cloud** (сделано 2026-09-13):
1. ✅ Сервис-аккаунт `disrupt-hub-content-sa`, роль `storage.editor` на
   бакет `disrupt-hub-content`
2. ✅ Статический access key для него (в переменных окружения функции)
3. ✅ Cloud Function `disrupt-hub-admin`, код загружен вручную ZIP-архивом
   через консоль (не из ссылки на Object Storage — см. выше)
4. ✅ Переменные окружения (`BUCKET_NAME`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `ADMIN_SECRET`)
5. ✅ «Allow unauthenticated invoke» включено
6. ✅ `admin/scripts/.env.local` заполнен (untracked, только на машине
   Арсения)

Проверено end-to-end 2026-09-13: `OPTIONS`→204, без ключа→401, с ключом→200,
`GET` несуществующего ключа→404 (был баг: сначала отдавал 500 — исправлен),
`publish.mjs` на реальной статье, конфликт двух источников правки→409,
`npm run sync-content` корректно подтягивает и корректно **удаляет**
локальную копию, когда статья удалена из бакета.

**Деплой:**
```bash
npm run deploy:admin   # заливает admin/web/ в disrupt-hub-deploy/admin/
npm run sync-content   # тянет бакет disrupt-hub-content → articles-published/, только *.md
npm run clean          # сносит .astro, dist, node_modules/.astro — см. ниже, зачем
npm run deploy         # sync-content + clean + build + деплой сайта
```

**Найденный при проверке кеш-баг.** У Astro есть скрытый кеш content layer в
`node_modules/.astro/` — отдельно от видимого `.astro/` в корне проекта.
Удаление статьи из бакета не гарантированно отражается в `astro build`, пока
не очищен именно этот кеш: сборка может продолжать рендерить уже удалённую
статью, даже когда сам загрузчик корректно репортит «файлов не найдено».
`npm run deploy` теперь всегда чистит оба кеша перед сборкой (`npm run
clean`) — без этого шага удаление статьи могло бы не долетать до прода.

**Публикация ≠ выкладка сайта.** Сохранение статьи в админке (или
`publish.mjs`) кладёт файл в бакет `disrupt-hub-content` — это не запускает
`astro build`. Чтобы статья попала на живой disrupt-hub.ru, всё равно нужен
`npm run deploy`.

## Что НЕ реализовано

- **Форма приёма UGC-статей.** `/submit/` — статичная заглушка со ссылкой на
  `t.me/disrupt_team`. Нужен бэкенд/модерация — архитектура не выбрана.
- **Кастомный домен `disrupt-hub.ru`.** Нужны CDN + DNS — см. выше.
- **Автодеплой по факту публикации.** Публикация в админке не триггерит
  пересборку/деплой сайта — см. выше.
- **Rich-редактор, загрузка изображений, история версий, роли доступа** —
  сознательно вне фазы 1 админки (один оператор, textarea + markdown-превью,
  скриншоты — плейсхолдерами `[SCREENSHOT: ...]`).
- **Сэмпл-статьи нет.** Продуктовые страницы показывают пустое состояние
  «статей пока нет», пока темы не пройдут реальный пайплайн `hub-writer`
  (утверждение → ТЗ → черновик → QC → публикация).

## Состав продуктов

`src/data/products.ts` — 9 продуктов с `disrupt.builders` (без Ники, она
приостановлена, см. `HUB.md`) + Река с оговоркой о тонкой фактуре. Стаб-факты
пяти новых продуктов — `disrupt/products/<slug>/PRODUCT.md`, собраны только
с их лендингов 2026-09-12, глубокого брифа от Дизрапта не было.
