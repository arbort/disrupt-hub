// Disrupt-Hub admin — vanilla JS, без сборки. Логика: аутентификация через
// заголовок X-Admin-Key (см. disrupt/hub/admin/function/index.js), CRUD статей
// в бакете disrupt-hub-content, живой SEO-чеклист поверх текущих значений формы.
// Фронтматтер разбирается/собирается вручную (плоские строковые поля — полноценный
// YAML-парсер не нужен), совместимо с gray-matter на стороне функции.

const PRODUCTS = [
  { slug: "tool", name: "Мультитул" },
  { slug: "type", name: "Тайп" },
  { slug: "concierge", name: "ИИ-Консьерж" },
  { slug: "aiwa", name: "Айва" },
  { slug: "gochi", name: "Гочи" },
  { slug: "narra", name: "Narra" },
  { slug: "memento", name: "Memento" },
  { slug: "korche", name: "Короче" },
  { slug: "radar", name: "Disrupt Radar" },
  { slug: "reka", name: "Река" },
];

// Живые статус-оверрайды тем ("Утвердить" в реестре) хранятся как крошечные
// .md-объекты с этим префиксом в том же бакете disrupt-hub-content — не
// настоящие статьи, но проходят валидацию существующего PUT (key.endsWith
// ".md") без единой правки Cloud Function. Отфильтровываются из списка
// статей и из "не привязанных к бэклогу", видны только в реестре тем.
const TOPIC_OVERRIDE_PREFIX = "_topics/";
const isTopicOverride = (item) => item.key.startsWith(TOPIC_OVERRIDE_PREFIX);

// ТЗ (Stage 2, Гейт 2 — HUB.md "Двухступенчатый гейт", добавлено 2026-09-17)
// хранятся тем же приёмом: крошечные .md-объекты под отдельным префиксом в
// том же бакете, проходят ту же валидацию PUT (key.endsWith(".md")), без
// единой правки Cloud Function. Ключ — _briefs/<product>/<topicId>.md.
const BRIEF_PREFIX = "_briefs/";
const isBrief = (item) => item.key.startsWith(BRIEF_PREFIX);

// Синдикация (Stage 7, добавлено 2026-09-17 — "ремесло хуков для ленты",
// HUB.md) — тот же приём хранения: _syndication/<platform>/<topicId>.md в
// том же бакете, без единой правки Cloud Function.
const SYNDICATION_PREFIX = "_syndication/";
const isSyndication = (item) => item.key.startsWith(SYNDICATION_PREFIX);
const SYNDICATION_PLATFORMS = [
  { slug: "dzen", name: "Dzen", hint: "Число или контраст в заголовке; короткий связный абзац-затравка — Dzen показывает сниппет интро в ленте, от него зависит клик. Тон тела — ближе к оригиналу, RU-нативная площадка." },
  { slug: "vc", name: "VC", hint: "Личный/инсайдерский заход («мы попробовали», «команда протестировала»); вопрос в конце текста, провоцирующий комментарии. Подаётся как инсайт/личный опыт команды, не пресс-релиз." },
  { slug: "habr", name: "Habr", hint: "Технический/любопытствующий заход («как мы»), не маркетинговый. Только органичный голос команды — никакого рекламного тона (лессон в ../shared/channels.md)." },
];
const SYNDICATION_STATUS_ORDER = ["draft", "ready", "published"];

// ---------- SEO-приоритет тем (добавлено 2026-09-13) ----------
// Интегральный балл = частотность (Wordstat) × вес интента × вес продуктового
// соответствия. Веса — не измерены (нет данных о CTR/конверсии на сайте,
// который ещё не публиковал статей), это осознанные объективные прокси, а не
// точный прогноз трафика — см. HUB.md, раздел про SEO-приоритет. Правило
// 70/20/10 по продуктам сюда не входит намеренно: это фильтр ОЧЕРЁДности
// продвижения (какой продукт продвигать активнее), а не часть оценки темы —
// тема оценивается объективно вне зависимости от того, чей это продукт.
// P/traf-оценка (HUB.md, "Семантика вперёд тем", добавлено 2026-09-17):
// широкая частотность × 0.13 — эмпирическая пропорция, замеченная в реальном
// файле P/traf giga.chat (внешний ориентир, не откалиброванный нами факт).
// Пока ни одна статья хаба не ранжируется, P/traf текущий = 0 везде, поэтому
// P/traf-оценка ≈ верхняя граница потенциального трафика, не готовый прогноз.
const PTRAF_FACTOR = 0.13;
const INTENT_LABELS = { commercial: "коммерческое", brand: "брендовое", navigational: "навигационное", informational: "информационное" };
const INTENT_WEIGHT = { commercial: 1.0, brand: 0.6, navigational: 0.4, informational: 0.35 };
const FIT_LABELS = { anchor: "якорная", peripheral: "периферийная" };
const FIT_WEIGHT = { anchor: 1.0, peripheral: 0.6 };

function deriveIntent(cluster) {
  const c = (cluster || "").toLowerCase();
  if (c.includes("коммерческ")) return "commercial";
  if (c.includes("навигацион")) return "navigational";
  if (c.includes("брендов")) return "brand";
  return "informational";
}

function parseFrequencyNumber(freq) {
  if (!freq || freq === "`[TBD]`") return null;
  const n = parseInt(String(freq).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

const STATUS_ORDER = ["idea", "brief", "draft", "qc", "published"];
const STRING_FIELDS = ["title", "h1", "metaTitle", "metaDescription", "canonical", "ogImage"];
const FIELD_ORDER = ["title", "product", "topicId", "status", "h1", "metaTitle", "metaDescription", "date", "canonical", "ogImage", "robots", "schemaType"];

// ---------- frontmatter parse/serialize ----------

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw || "" };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    try { value = JSON.parse(value); } catch { /* bare token — keep as string */ }
    fm[key] = String(value);
  }
  return { fm, body: m[2] || "" };
}

function serializeFrontmatter(fm, body) {
  const lines = ["---"];
  for (const key of FIELD_ORDER) {
    const value = (fm[key] || "").trim();
    if (!value) continue;
    lines.push(`${key}: ${STRING_FIELDS.includes(key) ? JSON.stringify(value) : value}`);
  }
  lines.push("---", "");
  return lines.join("\n") + (body || "");
}

// ---------- auth / api ----------

function getAuth() {
  return {
    apiBase: localStorage.getItem("disruptHubApiBase") || "",
    adminKey: localStorage.getItem("disruptHubAdminKey") || "",
  };
}
function setAuth(apiBase, adminKey) {
  localStorage.setItem("disruptHubApiBase", apiBase);
  localStorage.setItem("disruptHubAdminKey", adminKey);
}
function clearAuth() {
  localStorage.removeItem("disruptHubApiBase");
  localStorage.removeItem("disruptHubAdminKey");
}

async function api(path, options = {}) {
  const { apiBase, adminKey } = getAuth();
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  return res;
}

// ---------- state ----------

let articles = [];
let current = null; // { key, etag, fm, body, isNew }
let seoState = { focusKeyword: "", gateBrief: false, gateBrand: false, gateQc: false };

// ---------- boot ----------

const loginScreen = document.getElementById("login-screen");
const app = document.getElementById("app");
const editorEl = document.getElementById("editor");
const seoPanelEl = document.getElementById("seo-panel");
const articleListEl = document.getElementById("article-list");
const articleCountEl = document.getElementById("article-count");

function boot() {
  const { apiBase, adminKey } = getAuth();
  if (apiBase && adminKey) {
    showApp();
    loadArticles();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.style.display = "flex";
  app.classList.remove("is-active");
}
function showApp() {
  loginScreen.style.display = "none";
  app.classList.add("is-active");
}

document.getElementById("login-btn").addEventListener("click", async () => {
  const apiBase = document.getElementById("api-base").value.trim().replace(/\/$/, "");
  const adminKey = document.getElementById("admin-key").value.trim();
  const errorEl = document.getElementById("login-error");
  errorEl.hidden = true;
  if (!apiBase || !adminKey) {
    errorEl.textContent = "Заполните оба поля";
    errorEl.hidden = false;
    return;
  }
  setAuth(apiBase, adminKey);
  try {
    const res = await api("?action=list");
    if (res.status === 401) {
      errorEl.textContent = "Неверный ключ доступа";
      errorEl.hidden = false;
      clearAuth();
      return;
    }
    if (!res.ok) {
      errorEl.textContent = `Функция ответила ${res.status} — проверьте адрес`;
      errorEl.hidden = false;
      clearAuth();
      return;
    }
    showApp();
    loadArticles();
  } catch (e) {
    errorEl.textContent = "Не удалось подключиться — проверьте адрес функции";
    errorEl.hidden = false;
    clearAuth();
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearAuth();
  location.reload();
});

// ---------- article list ----------

async function loadArticles() {
  articleListEl.innerHTML = '<div class="empty-list">Загрузка…</div>';
  const res = await api("?action=list");
  if (!res.ok) {
    articleListEl.innerHTML = `<div class="empty-list">Ошибка ${res.status}</div>`;
    return;
  }
  const data = await res.json();
  articles = data.items.sort((a, b) => (a.key > b.key ? 1 : -1));
  renderArticleList();
}

function renderArticleList() {
  const realArticles = articles.filter((item) => !isTopicOverride(item) && !isBrief(item) && !isSyndication(item));
  articleCountEl.textContent = `${realArticles.length} шт.`;
  if (!realArticles.length) {
    articleListEl.innerHTML = '<div class="empty-list">Статей в бакете пока нет</div>';
    return;
  }
  articleListEl.innerHTML = "";
  for (const item of realArticles) {
    const btn = document.createElement("button");
    btn.className = "article-row" + (current && current.key === item.key ? " is-active" : "");
    const status = item.frontmatter.status || "idea";
    const product = PRODUCTS.find((p) => p.slug === item.frontmatter.product);
    btn.innerHTML =
      `<span class="article-row__title">${escapeHtml(item.frontmatter.title || item.key)}</span>` +
      `<span class="article-row__meta"><span class="chip ${status}">${status}</span>${product ? product.name : (item.frontmatter.product || "?")}</span>`;
    btn.addEventListener("click", () => openArticle(item.key));
    articleListEl.appendChild(btn);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- open / new ----------

async function openArticle(key) {
  const res = await api(`?action=get&key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    alert(`Не удалось загрузить статью (${res.status})`);
    return;
  }
  const data = await res.json();
  const { fm, body } = parseFrontmatter(data.raw);
  current = { key, etag: data.etag, fm, body, isNew: false };
  seoState = { focusKeyword: "", gateBrief: false, gateBrand: false, gateQc: false };
  renderArticleList();
  renderEditor();
}

document.getElementById("new-article-btn").addEventListener("click", () => {
  const product = prompt(`Слаг продукта (${PRODUCTS.map((p) => p.slug).join(", ")}):`, "tool");
  if (!product) return;
  const filename = prompt("Имя файла без расширения (латиницей, дефисы):", "novaya-statya");
  if (!filename) return;
  const key = `${product.trim()}/${filename.trim()}.md`;
  current = {
    key,
    etag: null,
    fm: { title: "", product: product.trim(), topicId: "", status: "idea", h1: "", metaTitle: "", metaDescription: "", date: "", canonical: "", ogImage: "", robots: "", schemaType: "" },
    body: "\n",
    isNew: true,
  };
  seoState = { focusKeyword: "", gateBrief: false, gateBrand: false, gateQc: false };
  renderArticleList();
  renderEditor();
});

// ---------- editor ----------

function renderEditor() {
  if (!current) {
    editorEl.innerHTML = '<div class="editor__placeholder">Выберите статью слева или создайте новую.</div>';
    seoPanelEl.hidden = true;
    return;
  }
  seoPanelEl.hidden = false;
  const fm = current.fm;

  editorEl.innerHTML = `
    <div class="key-preview">${current.isNew ? "Новый файл" : "Файл"}: ${current.key}${current.isNew ? "" : ` · etag ${current.etag}`}</div>
    <div class="editor-grid">
      <div class="field"><label>Заголовок (title)</label><input id="f-title" value="${escapeHtml(fm.title || "")}" /></div>
      <div class="field"><label>Продукт</label>
        <select id="f-product">${PRODUCTS.map((p) => `<option value="${p.slug}" ${p.slug === fm.product ? "selected" : ""}>${p.name}</option>`).join("")}</select>
      </div>
      <div class="field"><label>ID темы из бэклога (напр. tool-5, необязательно)</label><input id="f-topicId" value="${escapeHtml(fm.topicId || "")}" placeholder="product-N" /></div>
      <div class="field"><label>H1 (если отличается от title)</label><input id="f-h1" value="${escapeHtml(fm.h1 || "")}" /></div>
      <div class="field"><label>Статус</label>
        <select id="f-status">${STATUS_ORDER.map((s) => `<option value="${s}" ${s === fm.status ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
      <div class="field full"><label>Meta title (если отличается от title)</label><input id="f-metaTitle" value="${escapeHtml(fm.metaTitle || "")}" /></div>
      <div class="field full"><label>Meta description</label><input id="f-metaDescription" value="${escapeHtml(fm.metaDescription || "")}" /></div>
      <div class="field"><label>Дата (YYYY-MM-DD)</label><input id="f-date" value="${escapeHtml(fm.date || "")}" /></div>
      <div class="field"><label>Robots</label>
        <select id="f-robots">
          <option value="" ${!fm.robots ? "selected" : ""}>по умолчанию (index, follow)</option>
          <option value="index, follow" ${fm.robots === "index, follow" ? "selected" : ""}>index, follow</option>
          <option value="noindex, follow" ${fm.robots === "noindex, follow" ? "selected" : ""}>noindex, follow</option>
          <option value="noindex, nofollow" ${fm.robots === "noindex, nofollow" ? "selected" : ""}>noindex, nofollow</option>
        </select>
      </div>
      <div class="field"><label>Тип микроразметки</label>
        <select id="f-schemaType">
          <option value="" ${!fm.schemaType ? "selected" : ""}>по умолчанию (Article)</option>
          <option value="Article" ${fm.schemaType === "Article" ? "selected" : ""}>Article</option>
          <option value="HowTo" ${fm.schemaType === "HowTo" ? "selected" : ""}>HowTo</option>
        </select>
      </div>
      <div class="field"><label>OG-изображение (URL, необязательно)</label><input id="f-ogImage" value="${escapeHtml(fm.ogImage || "")}" /></div>
      <div class="field full"><label>Canonical override (обычно не нужен — считается из адреса статьи)</label><input id="f-canonical" value="${escapeHtml(fm.canonical || "")}" /></div>
    </div>

    <div class="field">
      <label>Текст статьи (Markdown)</label>
      <textarea id="f-body" class="body-editor">${escapeHtml(current.body)}</textarea>
    </div>

    <div class="editor-footer">
      <div class="btn-row">
        <button id="save-btn" class="btn primary">Сохранить</button>
        <button id="preview-btn" class="btn">Превью</button>
        ${current.isNew ? "" : '<button id="delete-btn" class="btn danger">Удалить</button>'}
      </div>
      <div id="save-status" class="save-status"></div>
    </div>
    <div id="conflict-box"></div>
    <div id="preview-box" class="preview-box" hidden></div>
  `;

  for (const id of ["f-title", "f-product", "f-topicId", "f-h1", "f-status", "f-metaTitle", "f-metaDescription", "f-date", "f-robots", "f-schemaType", "f-ogImage", "f-canonical", "f-body"]) {
    document.getElementById(id).addEventListener("input", onFieldChange);
  }
  document.getElementById("save-btn").addEventListener("click", saveArticle);
  document.getElementById("preview-btn").addEventListener("click", togglePreview);
  const delBtn = document.getElementById("delete-btn");
  if (delBtn) delBtn.addEventListener("click", deleteArticle);

  renderSeoPanel();
}

function readFormIntoCurrent() {
  current.fm.title = document.getElementById("f-title").value;
  current.fm.product = document.getElementById("f-product").value;
  current.fm.topicId = document.getElementById("f-topicId").value;
  current.fm.h1 = document.getElementById("f-h1").value;
  current.fm.status = document.getElementById("f-status").value;
  current.fm.metaTitle = document.getElementById("f-metaTitle").value;
  current.fm.metaDescription = document.getElementById("f-metaDescription").value;
  current.fm.date = document.getElementById("f-date").value;
  current.fm.robots = document.getElementById("f-robots").value;
  current.fm.schemaType = document.getElementById("f-schemaType").value;
  current.fm.ogImage = document.getElementById("f-ogImage").value;
  current.fm.canonical = document.getElementById("f-canonical").value;
  current.body = document.getElementById("f-body").value;
}

function onFieldChange() {
  readFormIntoCurrent();
  renderSeoChecksList();
}

function togglePreview() {
  readFormIntoCurrent();
  const box = document.getElementById("preview-box");
  box.hidden = !box.hidden;
  if (!box.hidden) box.innerHTML = window.marked.parse(current.body || "");
}

// ---------- save / delete ----------

async function saveArticle() {
  readFormIntoCurrent();
  const statusEl = document.getElementById("save-status");
  const conflictBox = document.getElementById("conflict-box");
  conflictBox.innerHTML = "";
  statusEl.textContent = "Сохраняю…";
  statusEl.className = "save-status";

  if (!current.fm.title || !current.fm.product) {
    statusEl.textContent = "Нужны хотя бы title и product";
    statusEl.className = "save-status err";
    return;
  }
  if (current.fm.status === "published" && !(seoState.gateBrief && seoState.gateBrand && seoState.gateQc)) {
    statusEl.textContent = "Отметьте все три пункта «широкой» проверки в SEO-панели перед публикацией";
    statusEl.className = "save-status err";
    return;
  }

  const raw = serializeFrontmatter(current.fm, current.body);
  const res = await api("", {
    method: "PUT",
    body: JSON.stringify({ key: current.key, raw, ifMatch: current.isNew ? undefined : current.etag }),
  });

  if (res.status === 200) {
    const data = await res.json();
    current.etag = data.etag;
    current.isNew = false;
    statusEl.textContent = "Сохранено. Не забудьте npm run deploy на сайте, чтобы попало в прод.";
    statusEl.className = "save-status ok";
    loadArticles();
  } else if (res.status === 409) {
    const data = await res.json();
    statusEl.textContent = "Конфликт: файл изменили параллельно";
    statusEl.className = "save-status err";
    conflictBox.innerHTML = `<div class="conflict-box">Текущее содержимое в бакете:<pre>${escapeHtml(data.currentRaw)}</pre>Обновите вручную и повторите сохранение.</div>`;
  } else {
    statusEl.textContent = `Ошибка ${res.status}`;
    statusEl.className = "save-status err";
  }
}

async function deleteArticle() {
  if (!confirm(`Удалить ${current.key} из бакета? Действие необратимо (истории версий нет).`)) return;
  const res = await api(`?key=${encodeURIComponent(current.key)}`, { method: "DELETE" });
  if (res.ok) {
    current = null;
    renderEditor();
    loadArticles();
  } else {
    alert(`Не удалось удалить (${res.status})`);
  }
}

// ---------- SEO panel ----------

function computeSeoChecks() {
  const fm = current.fm;
  const body = current.body || "";
  const [productSlug, filenameWithExt] = current.key.split("/");
  const filename = (filenameWithExt || "").replace(/\.md$/, "");
  const effectiveTitle = fm.metaTitle || fm.title || "";
  const effectiveH1 = fm.h1 || fm.title || "";
  const computedCanonical = `https://disrupt-hub.ru/${productSlug}/${filename}/`;
  const canonical = fm.canonical || computedCanonical;
  const keyword = seoState.focusKeyword.trim().toLowerCase();
  const bodyLower = body.toLowerCase();
  const first100Words = body.trim().split(/\s+/).slice(0, 100).join(" ").toLowerCase();
  const internalLinks = (body.match(/\]\(\//g) || []).length;
  const images = [...body.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)];
  const emptyAltImages = images.filter((m) => !m[1].trim()).length;
  const hasArtifactPlaceholder = /\[SCREENSHOT:|\[SETTING:/.test(body);
  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;

  const checks = [];

  const titleLen = effectiveTitle.length;
  checks.push({
    label: "Meta title, символов",
    value: String(titleLen),
    level: !titleLen ? "bad" : titleLen > 60 ? "warn" : titleLen < 30 ? "warn" : "ok",
  });

  const descLen = (fm.metaDescription || "").length;
  checks.push({
    label: "Meta description, символов",
    value: descLen ? String(descLen) : "нет",
    level: !descLen ? "bad" : descLen > 160 ? "warn" : descLen < 70 ? "warn" : "ok",
  });

  checks.push({ label: "H1 задан", value: effectiveH1 ? "да" : "нет", level: effectiveH1 ? "ok" : "bad" });

  checks.push({ label: "Canonical", value: fm.canonical ? "override" : "авто", level: "ok" });
  checks.push({ label: "Robots", value: fm.robots || "index, follow (по умолчанию)", level: "ok" });
  checks.push({ label: "Микроразметка", value: fm.schemaType || "Article (по умолчанию)", level: "ok" });

  checks.push({
    label: "Внутренние ссылки в тексте",
    value: String(internalLinks),
    level: internalLinks === 0 ? "warn" : "ok",
  });
  checks.push({
    label: "Изображения без alt",
    value: String(emptyAltImages),
    level: emptyAltImages > 0 ? "warn" : "ok",
  });
  checks.push({
    label: "Реальный артефакт продукта",
    value: hasArtifactPlaceholder ? "есть плейсхолдер" : "не найден",
    level: hasArtifactPlaceholder ? "ok" : "bad",
  });
  checks.push({ label: "Объём текста, слов", value: String(wordCount), level: wordCount < 200 ? "warn" : "ok" });

  if (keyword) {
    const inTitle = effectiveTitle.toLowerCase().includes(keyword);
    const inH1 = effectiveH1.toLowerCase().includes(keyword);
    const inFirst100 = first100Words.includes(keyword);
    const inMeta = (fm.metaDescription || "").toLowerCase().includes(keyword);
    const inUrl = filename.toLowerCase().includes(keyword.replace(/\s+/g, "-"));
    checks.push({ label: "Ключевое слово в title", value: inTitle ? "да" : "нет", level: inTitle ? "ok" : "warn" });
    checks.push({ label: "Ключевое слово в H1", value: inH1 ? "да" : "нет", level: inH1 ? "ok" : "warn" });
    checks.push({ label: "Ключевое слово в первых 100 словах", value: inFirst100 ? "да" : "нет", level: inFirst100 ? "ok" : "warn" });
    checks.push({ label: "Ключевое слово в meta description", value: inMeta ? "да" : "нет", level: inMeta ? "ok" : "warn" });
    checks.push({ label: "Ключевое слово в URL", value: inUrl ? "да" : "нет", level: inUrl ? "ok" : "warn" });
  }

  return { checks, canonical };
}

// Баг 2026-09-17: renderSeoPanel() раньше пересобирала innerHTML всей
// панели, включая сам <input id="seo-keyword">, на КАЖДЫЙ ввод символа в
// это же поле (обработчик "input" вызывал renderSeoPanel() снова). Браузер
// на каждый keystroke уничтожал и создавал заново DOM-узел input — фокус и
// позиция курсора слетали, приходилось кликать в поле заново на каждую
// букву. Чек-лист при этом честно пересчитывался под введённый текст, но
// из-за постоянной потери фокуса буквы вставлялись не туда, куда печатали
// (клик мышью не всегда ставит курсor туда же, где остановился ввод) — со
// стороны это выглядело как "рандомная" смена анализа.
// Фикс: оболочка панели (заголовок, само поле keyword, чекбоксы широкого
// ревью) рисуется один раз в renderSeoPanel(); обновление под ввод — только
// внутри #seo-checks-container через renderSeoChecksList(), не трогая узел
// input вообще. onFieldChange() (ввод в поля статьи слева) теперь тоже
// зовёт renderSeoChecksList(), а не полный renderSeoPanel().
function renderSeoChecksList() {
  const { checks, canonical } = computeSeoChecks();
  const icon = { ok: "✓", warn: "!", bad: "✕" };
  const container = document.getElementById("seo-checks-container");
  if (!container) return;
  container.innerHTML = `
    <div class="seo-check__value" style="display:block;margin-bottom:12px;">URL: ${escapeHtml(canonical)}</div>
    <h3>Технически (platform-technical-seo.md)</h3>
    ${checks.map((c) => `
      <div class="seo-check ${c.level}">
        <span class="seo-check__icon">${icon[c.level]}</span>
        <span class="seo-check__label">${c.label}</span>
        <span class="seo-check__value">${escapeHtml(c.value)}</span>
      </div>
    `).join("")}
  `;
}

function renderSeoPanel() {
  seoPanelEl.innerHTML = `
    <h2>SEO-чеклист</h2>
    <div class="field">
      <label>Ключевое слово (для проверки, не сохраняется в файл)</label>
      <input id="seo-keyword" value="${escapeHtml(seoState.focusKeyword)}" placeholder="напр. надиктовать письмо" />
    </div>
    <div id="seo-checks-container"></div>

    <h3>Широкое ревью (сессионное, не сохраняется)</h3>
    <div class="gate-checklist">
      <label><input type="checkbox" id="gate-brief" ${seoState.gateBrief ? "checked" : ""}/> ТЗ существует в briefs/ и соблюдено</label>
      <label><input type="checkbox" id="gate-brand" ${seoState.gateBrand ? "checked" : ""}/> Бренд-правила и запреты продукта проверены</label>
      <label><input type="checkbox" id="gate-qc" ${seoState.gateQc ? "checked" : ""}/> 3 QC-чекпойнта из HUB.md пройдены</label>
    </div>
    <div class="gate-note">Пока не отмечены все три — статус «published» не сохранится. Ничего из этого блока не пишется в файл.</div>
  `;

  document.getElementById("seo-keyword").addEventListener("input", (e) => {
    seoState.focusKeyword = e.target.value;
    renderSeoChecksList();
  });
  document.getElementById("gate-brief").addEventListener("change", (e) => { seoState.gateBrief = e.target.checked; });
  document.getElementById("gate-brand").addEventListener("change", (e) => { seoState.gateBrand = e.target.checked; });
  document.getElementById("gate-qc").addEventListener("change", (e) => { seoState.gateQc = e.target.checked; });

  renderSeoChecksList();
}

// ---------- tabs ----------

const viewArticlesEl = document.getElementById("view-articles");
const viewRegistryEl = document.getElementById("view-registry");
const viewBriefsEl = document.getElementById("view-briefs");
const viewSyndicationEl = document.getElementById("view-syndication");
let topics = null; // кэш data/topics.json, грузится один раз за сессию
let topicFreqDetails = null; // кэш data/topic-frequency-details.json — разбивка по похожим/смежным запросам
let registrySort = { key: null, dir: "desc" }; // сортировка таблицы реестра по клику на заголовок колонки
let registryRowsById = new Map(); // последний рендер реестра — для модалки деталей по клику
let briefRowsByTopicId = new Map(); // последний рендер вкладки "ТЗ" — для модалки и для ссылки "ТЗ →" из реестра тем

document.getElementById("tab-articles").addEventListener("click", () => switchTab("articles"));
document.getElementById("tab-registry").addEventListener("click", () => switchTab("registry"));
document.getElementById("tab-briefs").addEventListener("click", () => switchTab("briefs"));
document.getElementById("tab-syndication").addEventListener("click", () => switchTab("syndication"));

function switchTab(name) {
  for (const btn of document.querySelectorAll(".tab")) btn.classList.toggle("is-active", btn.dataset.tab === name);
  viewArticlesEl.hidden = name !== "articles";
  viewRegistryEl.hidden = name !== "registry";
  viewBriefsEl.hidden = name !== "briefs";
  viewSyndicationEl.hidden = name !== "syndication";
  if (name === "registry") loadRegistry();
  if (name === "briefs") loadBriefs();
  if (name === "syndication") loadSyndications();
}

// ---------- registry (реестр тем) ----------

async function loadRegistry(forceRefresh) {
  document.getElementById("registry-table").innerHTML = '<div class="empty-list">Загрузка…</div>';
  try {
    if (!topics) {
      const res = await fetch("data/topics.json", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      topics = data.topics;
    }
    if (!topicFreqDetails) {
      try {
        const res = await fetch("data/topic-frequency-details.json", { cache: "no-store" });
        topicFreqDetails = res.ok ? await res.json() : {};
      } catch {
        topicFreqDetails = {};
      }
    }
    if (!articles.length || forceRefresh) {
      const res = await api("?action=list");
      if (res.ok) {
        const data = await res.json();
        articles = data.items;
      }
    }
    renderRegistry();
  } catch (e) {
    document.getElementById("registry-table").innerHTML = `<div class="empty-list">Не удалось загрузить реестр тем (data/topics.json) — обновите его: node admin/scripts/sync-topics.mjs и задеплойте админку.</div>`;
  }
}

function registryFilterSetup() {
  const productSelect = document.getElementById("registry-filter-product");
  if (!productSelect.options.length) {
    productSelect.innerHTML =
      '<option value="">Все продукты</option>' +
      PRODUCTS.map((p) => `<option value="${p.slug}">${p.name}</option>`).join("");
    productSelect.addEventListener("change", renderRegistry);
    document.getElementById("registry-filter-status").addEventListener("change", renderRegistry);
    document.getElementById("registry-filter-intent").addEventListener("change", renderRegistry);
    document.getElementById("registry-filter-fit").addEventListener("change", renderRegistry);
  }
}

// ---------- одобрение темы прямо из реестра ----------

async function setTopicOverride(topicId, status) {
  const raw = `---\ntopicId: ${topicId}\nstatus: ${status}\n---\n`;
  const res = await api("", { method: "PUT", body: JSON.stringify({ key: `${TOPIC_OVERRIDE_PREFIX}${topicId}.md`, raw }) });
  if (!res.ok) {
    alert(`Не удалось сохранить статус (${res.status})`);
    return;
  }
  await loadRegistry(true);
}

async function clearTopicOverride(topicId) {
  const res = await api(`?key=${encodeURIComponent(`${TOPIC_OVERRIDE_PREFIX}${topicId}.md`)}`, { method: "DELETE" });
  if (!res.ok) {
    alert(`Не удалось откатить статус (${res.status})`);
    return;
  }
  await loadRegistry(true);
}

function registryActionCell(r) {
  if (r.written) return `<button class="btn btn-sm registry-open" data-key="${escapeHtml(r.article.key)}">Открыть →</button>`;
  if (r.baseStatus.includes("блокировано")) return `<span class="muted">заблокировано в бэклоге</span>`;
  if (r.baseStatus === "утверждено") {
    return r.hasOverride
      ? `<button class="btn btn-sm registry-unapprove" data-topic-id="${escapeHtml(r.topicId)}">Вернуть в идею</button>`
      : `<span class="muted">утверждено в бэклоге</span>`;
  }
  return `<button class="btn btn-sm primary registry-approve" data-topic-id="${escapeHtml(r.topicId)}">Утвердить</button>`;
}

function renderRegistry() {
  registryFilterSetup();
  briefRowsByTopicId = computeBriefRows();
  const productFilter = document.getElementById("registry-filter-product").value;
  const statusFilter = document.getElementById("registry-filter-status").value;

  // topicId -> статья, для тем, у которых уже есть написанный текст;
  // отдельно — живые оверрайды статуса ("Утвердить" в реестре)
  const articleByTopicId = new Map();
  const overrideByTopicId = new Map();
  const orphanArticles = [];
  for (const item of articles) {
    if (isTopicOverride(item) || isBrief(item) || isSyndication(item)) {
      if (isTopicOverride(item)) {
        const tid = item.frontmatter.topicId || item.key.slice(TOPIC_OVERRIDE_PREFIX.length).replace(/\.md$/, "");
        overrideByTopicId.set(tid, item.frontmatter.status);
      }
      continue;
    }
    const tid = item.frontmatter.topicId;
    if (tid) articleByTopicId.set(tid, item);
    else orphanArticles.push(item);
  }

  const rows = topics.map((t) => {
    const article = articleByTopicId.get(t.topicId);
    const override = overrideByTopicId.get(t.topicId);
    const baseStatus = override || t.status; // оверрайд перекрывает статус из бэклог-файла
    const effectiveStatus = article ? (article.frontmatter.status || "idea") : baseStatus;
    const written = Boolean(article);
    const intent = deriveIntent(t.cluster);
    const fit = t.productFit || "peripheral";
    const freqNum = parseFrequencyNumber(t.frequency);
    const ptraf = freqNum != null ? Math.round(freqNum * PTRAF_FACTOR) : null;
    const score = ptraf != null ? Math.round(ptraf * INTENT_WEIGHT[intent] * FIT_WEIGHT[fit]) : null;
    const phrase = (topicFreqDetails && topicFreqDetails[t.topicId] && topicFreqDetails[t.topicId].phrase) || null;
    return { ...t, article, hasOverride: Boolean(override), baseStatus, effectiveStatus, written, intent, fit, freqNum, ptraf, score, phrase };
  });
  registryRowsById = new Map(rows.map((r) => [r.topicId, r]));

  // --- сводка ---
  const total = rows.length;
  const approved = rows.filter((r) => r.baseStatus === "утверждено").length;
  const writtenCount = rows.filter((r) => r.written).length;
  const publishedCount = rows.filter((r) => r.effectiveStatus === "published").length;
  const inQueue = rows.filter((r) => r.written && r.effectiveStatus !== "published").length;

  const byProduct = {};
  for (const r of rows) {
    byProduct[r.product] ||= { total: 0, approved: 0, written: 0, published: 0 };
    byProduct[r.product].total++;
    if (r.baseStatus === "утверждено") byProduct[r.product].approved++;
    if (r.written) byProduct[r.product].written++;
    if (r.effectiveStatus === "published") byProduct[r.product].published++;
  }

  document.getElementById("registry-summary").innerHTML = `
    <div class="summary-cards">
      <div class="summary-card"><div class="summary-card__value">${total}</div><div class="summary-card__label">тем в бэклоге</div></div>
      <div class="summary-card"><div class="summary-card__value">${approved}</div><div class="summary-card__label">утверждено</div></div>
      <div class="summary-card"><div class="summary-card__value">${inQueue}</div><div class="summary-card__label">написано, не опубликовано</div></div>
      <div class="summary-card"><div class="summary-card__value">${publishedCount}</div><div class="summary-card__label">опубликовано</div></div>
    </div>
    <table class="registry-summary-table">
      <thead><tr><th>Продукт</th><th>Тем</th><th>Утверждено</th><th>Написано</th><th>Опубликовано</th></tr></thead>
      <tbody>
        ${PRODUCTS.map((p) => {
          const s = byProduct[p.slug];
          if (!s) return "";
          return `<tr><td>${p.name}</td><td>${s.total}</td><td>${s.approved}</td><td>${s.written}</td><td>${s.published}</td></tr>`;
        }).join("")}
      </tbody>
    </table>
  `;

  // --- таблица тем ---
  const intentFilter = document.getElementById("registry-filter-intent").value;
  const fitFilter = document.getElementById("registry-filter-fit").value;

  let filtered = rows;
  if (productFilter) filtered = filtered.filter((r) => r.product === productFilter);
  if (statusFilter) {
    filtered = filtered.filter((r) => {
      if (statusFilter === "идея" || statusFilter === "утверждено") return !r.written && r.baseStatus === statusFilter;
      if (statusFilter === "блокировано") return !r.written && r.baseStatus.includes("блокировано");
      return r.effectiveStatus === statusFilter;
    });
  }
  if (intentFilter) filtered = filtered.filter((r) => r.intent === intentFilter);
  if (fitFilter) filtered = filtered.filter((r) => r.fit === fitFilter);

  const SORT_KEYS = {
    rawFrequency: (r) => (r.freqNum == null ? -1 : r.freqNum),
    frequency: (r) => (r.ptraf == null ? -1 : r.ptraf),
    intentWeight: (r) => INTENT_WEIGHT[r.intent],
    fitWeight: (r) => FIT_WEIGHT[r.fit],
    score: (r) => (r.score == null ? -1 : r.score),
  };
  if (registrySort.key) {
    const getVal = SORT_KEYS[registrySort.key];
    const dir = registrySort.dir === "asc" ? 1 : -1;
    filtered = [...filtered].sort((a, b) => (getVal(a) - getVal(b)) * dir);
  }

  const statusLabel = (r) => (r.written ? r.effectiveStatus : r.baseStatus);
  const statusChipClass = (r) => (r.written ? r.effectiveStatus : r.baseStatus === "утверждено" ? "approved" : "idea");
  const rawFreqLabel = (r) => (r.freqNum != null ? r.freqNum.toLocaleString("ru-RU") : "—");
  const freqLabel = (r) => (r.ptraf != null ? r.ptraf.toLocaleString("ru-RU") : "—");
  const scoreLabel = (r) => (r.score != null ? r.score : "—");

  const sortIndicator = (key) => (registrySort.key === key ? (registrySort.dir === "asc" ? " ▲" : " ▼") : "");
  const sortableHeader = (key, label) => `<th class="sortable" data-sort-key="${key}">${label}${sortIndicator(key)}</th>`;

  document.getElementById("registry-table").innerHTML = filtered.length
    ? `<table class="registry-table">
        <thead><tr>
          <th>Продукт</th><th>#</th><th>Тема</th><th>Аудитория</th>
          ${sortableHeader("rawFrequency", "Частотность фразы")}
          ${sortableHeader("frequency", "P/traf-оценка")}
          ${sortableHeader("intentWeight", "Интент")}
          ${sortableHeader("fitWeight", "Соответствие")}
          ${sortableHeader("score", "Балл")}
          <th>Статус</th><th>ТЗ</th><th></th>
        </tr></thead>
        <tbody>
          ${filtered.map((r) => {
            const product = PRODUCTS.find((p) => p.slug === r.product);
            const brief = briefRowsByTopicId.get(r.topicId);
            const briefCell = brief
              ? `<button class="btn btn-sm registry-open-brief" data-topic-id="${escapeHtml(r.topicId)}">ТЗ → <span class="chip ${brief.status}">${escapeHtml(brief.status)}</span></button>`
              : `<span class="muted">нет</span>`;
            return `<tr>
              <td>${product ? product.name : r.product}</td>
              <td>${r.number}</td>
              <td class="title-cell registry-detail" data-topic-id="${escapeHtml(r.topicId)}" title="Кликните, чтобы посмотреть разбивку частотности и P/traf-оценку">${escapeHtml(r.title)}</td>
              <td class="muted">${escapeHtml(r.audience || "")}</td>
              <td class="muted registry-freq-cell">${escapeHtml(rawFreqLabel(r))}${r.phrase ? `<div class="registry-phrase">«${escapeHtml(r.phrase)}»</div>` : ""}</td>
              <td class="muted">${escapeHtml(freqLabel(r))}</td>
              <td class="muted">${escapeHtml(INTENT_LABELS[r.intent])} ×${INTENT_WEIGHT[r.intent]}</td>
              <td class="muted">${escapeHtml(FIT_LABELS[r.fit])} ×${FIT_WEIGHT[r.fit]}</td>
              <td><strong>${escapeHtml(String(scoreLabel(r)))}</strong></td>
              <td><span class="chip ${statusChipClass(r)}">${escapeHtml(statusLabel(r))}</span></td>
              <td>${briefCell}</td>
              <td>${registryActionCell(r)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`
    : '<div class="empty-list">Ничего не найдено по этому фильтру</div>';

  for (const th of document.querySelectorAll(".registry-table th.sortable")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      registrySort = registrySort.key === key
        ? { key, dir: registrySort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" };
      renderRegistry();
    });
  }
  for (const btn of document.querySelectorAll(".registry-open")) {
    btn.addEventListener("click", () => {
      switchTab("articles");
      openArticle(btn.dataset.key);
    });
  }
  for (const btn of document.querySelectorAll(".registry-approve")) {
    btn.addEventListener("click", () => setTopicOverride(btn.dataset.topicId, "утверждено"));
  }
  for (const btn of document.querySelectorAll(".registry-unapprove")) {
    btn.addEventListener("click", () => clearTopicOverride(btn.dataset.topicId));
  }
  for (const cell of document.querySelectorAll(".registry-detail")) {
    cell.addEventListener("click", () => openTopicDetail(cell.dataset.topicId));
  }
  for (const btn of document.querySelectorAll(".registry-open-brief")) {
    btn.addEventListener("click", () => {
      switchTab("briefs");
      openBriefDetail(btn.dataset.topicId);
    });
  }

  // --- статьи без topicId (не привязаны к бэклогу) ---
  // Баг 2026-09-17: этот блок раньше жил внутри openTopicDetail() и ссылался
  // на orphanArticles из чужой функции (ReferenceError при каждом клике по
  // теме, сам блок никогда не рендерился). Возвращён туда, где вычисляется
  // orphanArticles, — см. HUB.md "Дашборд «Реестр тем»".
  document.getElementById("registry-orphans").innerHTML = orphanArticles.length
    ? `<h3 class="registry-orphans__title">Статьи без ID темы из бэклога (${orphanArticles.length})</h3>
       <div class="registry-orphans__list">
         ${orphanArticles.map((item) => `
           <button class="article-row registry-open" data-key="${escapeHtml(item.key)}">
             <span class="article-row__title">${escapeHtml(item.frontmatter.title || item.key)}</span>
             <span class="article-row__meta"><span class="chip ${item.frontmatter.status || "idea"}">${item.frontmatter.status || "idea"}</span>${escapeHtml(item.key)}</span>
           </button>
         `).join("")}
       </div>`
    : "";
  for (const btn of document.querySelectorAll("#registry-orphans .registry-open")) {
    btn.addEventListener("click", () => {
      switchTab("articles");
      openArticle(btn.dataset.key);
    });
  }
}

// ---------- ТЗ (Stage 2, Гейт 2 — добавлено 2026-09-17) ----------

// Объекты _briefs/<product>/<topicId>.md уже приходят вместе с остальным
// списком (?action=list грузит весь бакет разом) — отдельного запроса не
// нужно, только фильтр по префиксу поверх уже загруженного `articles`.
function computeBriefRows() {
  const map = new Map();
  for (const item of articles) {
    if (!isBrief(item)) continue;
    const topicId = item.frontmatter.topicId || item.key.slice(BRIEF_PREFIX.length).replace(/\.md$/, "");
    map.set(topicId, {
      topicId,
      product: item.frontmatter.product || topicId.split("-").slice(0, -1).join("-"),
      status: item.frontmatter.status || "draft",
      key: item.key,
      etag: item.etag,
      lastModified: item.lastModified,
    });
  }
  return map;
}

let currentBriefTopicId = null; // какое ТЗ сейчас открыто в #brief-page — для подсветки строки слева

async function loadBriefs(forceRefresh) {
  document.getElementById("briefs-list").innerHTML = '<div class="empty-list">Загрузка…</div>';
  if (!articles.length || forceRefresh) {
    const res = await api("?action=list");
    if (res.ok) {
      const data = await res.json();
      articles = data.items;
    }
  }
  renderBriefs();
}

function briefsFilterSetup() {
  const productSelect = document.getElementById("briefs-filter-product");
  if (!productSelect.options.length) {
    productSelect.innerHTML =
      '<option value="">Все продукты</option>' +
      PRODUCTS.map((p) => `<option value="${p.slug}">${p.name}</option>`).join("");
    productSelect.addEventListener("change", renderBriefs);
    document.getElementById("briefs-filter-status").addEventListener("change", renderBriefs);
  }
}

// Список слева — тот же article-row, что и во вкладках "Статьи"/"Синдикация"
// (не таблица-реестр): клик открывает ТЗ полноразмерной страницей справа,
// а не поп-ап (см. openBriefDetail ниже — по прямому запросу Арсения
// 2026-09-17, второй проход: "верстка как в статьях", не модалка).
function renderBriefs() {
  briefsFilterSetup();
  briefRowsByTopicId = computeBriefRows();
  const rows = [...briefRowsByTopicId.values()];

  const productFilter = document.getElementById("briefs-filter-product").value;
  const statusFilter = document.getElementById("briefs-filter-status").value;
  let filtered = rows;
  if (productFilter) filtered = filtered.filter((r) => r.product === productFilter);
  if (statusFilter) filtered = filtered.filter((r) => r.status === statusFilter);
  filtered.sort((a, b) => (a.topicId > b.topicId ? 1 : -1));

  const draftCount = rows.filter((r) => r.status === "draft").length;
  const approvedCount = rows.filter((r) => r.status === "approved").length;
  document.getElementById("briefs-summary").textContent =
    `${rows.length} ТЗ всего · ${draftCount} ждут решения · ${approvedCount} одобрено`;

  const listEl = document.getElementById("briefs-list");
  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-list">ТЗ пока нет — появятся, когда hub-writer или routine материализуют Stage 2 по утверждённой теме.</div>';
    return;
  }
  listEl.innerHTML = "";
  for (const r of filtered) {
    const product = PRODUCTS.find((p) => p.slug === r.product);
    const topicTitle = topics ? topics.find((t) => t.topicId === r.topicId)?.title : null;
    const btn = document.createElement("button");
    btn.className = "article-row" + (currentBriefTopicId === r.topicId ? " is-active" : "");
    btn.innerHTML =
      `<span class="article-row__title">${escapeHtml(topicTitle || r.topicId)}</span>` +
      `<span class="article-row__meta"><span class="chip ${r.status}">${escapeHtml(r.status)}</span>${product ? product.name : r.product} · ${escapeHtml(r.topicId)}</span>`;
    btn.addEventListener("click", () => openBriefDetail(r.topicId));
    listEl.appendChild(btn);
  }
}

// ---------- разбивка ТЗ по разделам (2026-09-17) ----------
// ТЗ (см. hub/briefs/.../*.md) устроено как markdown с заголовками верхнего
// уровня `## Раздел` (Мета, Кластер интентов, Конкурентная выдача, Аутлайн,
// Внутренняя перелинковка, Источники фактов, Продуктовые ограничения) — то
// же деление, что задаёт структура Stage 2 в HUB.md. Раньше вся модалка была
// одним marked.parse(body) — здесь режем по `## ` на отдельные секции и
// рендерим каждую отдельным боксом, а не одним длинным полотном для скролла.
function splitBriefSections(body) {
  const lines = (body || "").split(/\r?\n/);
  const sections = [];
  let current = { title: null, lines: [] };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      sections.push(current);
      current = { title: m[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ title: s.title, content: s.lines.join("\n").trim() }))
    .filter((s) => s.title || s.content);
}

// Рендерит тело ТЗ как полноразмерную страницу — заголовок ТЗ + мета-строки
// (текст до первого `## `) вводным блоком сверху, каждый раздел `## ...`
// дальше отдельной секцией на всю ширину с крупным заголовком, друг под
// другом (не сетка карточек — тут именно "как в статье", один поток сверху
// вниз, с разделителями между разделами).
function renderBriefBody(body) {
  const sections = splitBriefSections(body);
  if (!sections.length) return '<div class="modal-note">ТЗ пустое.</div>';

  const intro = sections[0].title ? null : sections[0];
  const rest = sections[0].title ? sections : sections.slice(1);

  const introHtml = intro && intro.content
    ? `<div class="brief-intro">${window.marked ? marked.parse(intro.content) : escapeHtml(intro.content)}</div>`
    : "";

  const sectionsHtml = rest
    .map((s) => {
      const parsed = window.marked ? marked.parse(s.content || "") : `<p>${escapeHtml(s.content || "")}</p>`;
      return `<section class="brief-section"><h2 class="brief-section__title">${escapeHtml(s.title || "")}</h2><div class="brief-section__body">${parsed}</div></section>`;
    })
    .join("");

  return `${introHtml}<div class="brief-page">${sectionsHtml}</div>`;
}

// ---------- страница ТЗ (открывается в #brief-page, не поп-апом) ----------

async function setBriefStatus(key, raw, status) {
  const { fm, body } = parseFrontmatter(raw);
  fm.status = status;
  const newRaw = `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
  const res = await api("", { method: "PUT", body: JSON.stringify({ key, raw: newRaw }) });
  if (!res.ok) {
    alert(`Не удалось обновить статус ТЗ (${res.status})`);
    return;
  }
  await loadBriefs(true);
  await openBriefDetail(fm.topicId);
  if (!viewRegistryEl.hidden) renderRegistry();
}

async function openBriefDetail(topicId) {
  const r = briefRowsByTopicId.get(topicId) || computeBriefRows().get(topicId);
  if (!r) return;
  currentBriefTopicId = topicId;
  renderBriefs(); // перерисовать список слева — подсветить активную строку

  const pageEl = document.getElementById("brief-page");
  pageEl.innerHTML = '<div class="editor__placeholder">Загрузка ТЗ…</div>';

  const res = await api(`?action=get&key=${encodeURIComponent(r.key)}`);
  if (!res.ok) {
    pageEl.innerHTML = `<div class="editor__placeholder">Не удалось загрузить ТЗ (${res.status})</div>`;
    return;
  }
  const data = await res.json();
  const { fm, body } = parseFrontmatter(data.raw);
  const product = PRODUCTS.find((p) => p.slug === fm.product);

  const actionsHtml =
    fm.status === "approved"
      ? `<button class="btn" id="brief-unapprove-btn">Вернуть на доработку</button>`
      : `<button class="btn primary" id="brief-approve-btn">Утвердить ТЗ</button>`;

  pageEl.innerHTML = `
    <div class="key-preview">ТЗ · ${escapeHtml(fm.topicId || topicId)} · ${r.key}</div>
    <div class="brief-page__header">
      <div>
        <div class="brief-page__product">${product ? product.name : fm.product || ""}</div>
        <span class="chip ${fm.status}">${escapeHtml(fm.status || "draft")}</span>
      </div>
      <div class="btn-row">${actionsHtml}</div>
    </div>
    <div class="modal-note" style="margin:var(--ui-space-12) 0 var(--ui-space-4)">Гейт 2 (HUB.md, «Двухступенчатый гейт») — пока статус не «approved», ни hub-writer, ни routine не начинают черновик по этой теме.</div>
    ${renderBriefBody(body)}
  `;
  const approveBtn = document.getElementById("brief-approve-btn");
  if (approveBtn) approveBtn.addEventListener("click", () => setBriefStatus(r.key, data.raw, "approved"));
  const unapproveBtn = document.getElementById("brief-unapprove-btn");
  if (unapproveBtn) unapproveBtn.addEventListener("click", () => setBriefStatus(r.key, data.raw, "draft"));
}

// ---------- модалка "из чего складывается частотность" ----------

const topicDetailModal = document.getElementById("topic-detail-modal");
const topicDetailContent = document.getElementById("topic-detail-content");

function closeTopicDetail() {
  topicDetailModal.hidden = true;
  topicDetailContent.innerHTML = "";
}

topicDetailModal.addEventListener("click", (e) => {
  if (e.target === topicDetailModal) closeTopicDetail();
});

function phraseListHtml(items, emptyText) {
  if (!items || !items.length) return `<div class="modal-note">${emptyText}</div>`;
  return `<ul class="modal-phrase-list">${items.map((it) => `<li><span>${escapeHtml(it.phrase)}</span><span class="count">${it.count.toLocaleString("ru-RU")}</span></li>`).join("")}</ul>`;
}

function openTopicDetail(topicId) {
  const r = registryRowsById.get(topicId);
  if (!r) return;
  const details = topicFreqDetails[topicId];
  const product = PRODUCTS.find((p) => p.slug === r.product);

  const registryNumber = r.freqNum; // то, что реально в колонке реестра / в backlog-файле — источник правды
  const driftWarning =
    details && details.totalCount != null && registryNumber != null && details.totalCount !== registryNumber
      ? `<div class="modal-note" style="color:var(--accent-orange)">⚠ При последнем снятии разбивки Wordstat вернул другое число для той же фразы — ${details.totalCount.toLocaleString("ru-RU")} вместо ${registryNumber.toLocaleString("ru-RU")} в реестре. Это известная нестабильность самого API между вызовами (замечено примерно в четверти случаев при сверке), не ошибка расчёта. Число в реестре не трогаем без явного пересчёта — ниже показана разбивка именно из последнего снятия.</div>`
      : "";

  const ptrafLine = r.ptraf != null
    ? `<div class="modal-card__row"><span>P/traf-оценка (× ${PTRAF_FACTOR}, идёт в «Балл»)</span><span>${r.ptraf.toLocaleString("ru-RU")}</span></div>`
    : "";

  const body = !details
    ? `
      <div class="modal-headline">${registryNumber != null ? registryNumber.toLocaleString("ru-RU") : "—"}</div>
      ${ptrafLine}
      <div class="modal-note">${registryNumber != null ? "Число в реестре есть, но разбивка на похожие/смежные запросы по нему ещё не снята (снята позже, отдельным прогоном) — " : "Частотность по этой теме ещё не снята — "}запустите <code>admin/scripts/apply-topic-frequency.py</code> и передеплойте админку, чтобы получить разбивку.</div>
    `
    : `
      <div class="modal-card__row"><span>Поисковая фраза</span><span>«${escapeHtml(details.phrase)}»</span></div>
      <div class="modal-headline">${registryNumber != null ? registryNumber.toLocaleString("ru-RU") : "—"}</div>
      ${ptrafLine}
      <div class="modal-note">Широкая частотность — верхняя граница спроса по фразе целиком (Wordstat, без операторов, включает словоформы и порядок слов). Не прогноз показов. P/traf-оценка — прикидка трафика на её основе (см. HUB.md, «Семантика вперёд тем»), пока P/traf текущий = 0 везде (сайт без истории ранжирования).</div>
      ${driftWarning}

      <h3>Из каких запросов складывается это число</h3>
      ${phraseListHtml(details.similar, "Нет данных о похожих запросах.")}

      <h3>Смежные запросы (associations — может быть шумно, не всегда по теме)</h3>
      ${phraseListHtml(details.associations, "Смежных запросов не найдено.")}

      <div class="modal-note">Разбивка снята: ${new Date(details.fetchedAt).toLocaleString("ru-RU")}</div>
    `;

  topicDetailContent.innerHTML = `
    <h2>${escapeHtml(r.title)}</h2>
    <div class="modal-subtitle">${product ? product.name : r.product} · тема #${r.number} · ${escapeHtml(INTENT_LABELS[r.intent])} · ${escapeHtml(FIT_LABELS[r.fit])}</div>
    ${body}
    <div class="modal-close-row"><button class="btn primary" id="topic-detail-close">Закрыть</button></div>
  `;
  topicDetailModal.hidden = false;
  document.getElementById("topic-detail-close").addEventListener("click", closeTopicDetail);
}

// ---------- Синдикация (Stage 7, добавлено 2026-09-17) ----------

const syndicationEditorEl = document.getElementById("syndication-editor");
let currentSyndication = null; // { key, etag, fm, body, isNew }

function syndicationItems() {
  return articles.filter(isSyndication);
}

async function loadSyndications(forceRefresh) {
  document.getElementById("syndication-list").innerHTML = '<div class="empty-list">Загрузка…</div>';
  if (!articles.length || forceRefresh) {
    const res = await api("?action=list");
    if (res.ok) {
      const data = await res.json();
      articles = data.items;
    }
  }
  renderSyndicationList();
}

function syndicationFilterSetup() {
  const el = document.getElementById("syndication-filter-platform");
  if (!el.dataset.wired) {
    el.addEventListener("change", renderSyndicationList);
    el.dataset.wired = "1";
  }
}

function renderSyndicationList() {
  syndicationFilterSetup();
  const platformFilter = document.getElementById("syndication-filter-platform").value;
  const listEl = document.getElementById("syndication-list");
  let items = syndicationItems();
  if (platformFilter) items = items.filter((i) => i.frontmatter.platform === platformFilter);
  items.sort((a, b) => (a.key > b.key ? 1 : -1));

  if (!items.length) {
    listEl.innerHTML = '<div class="empty-list">Пакетов синдикации пока нет</div>';
    return;
  }
  listEl.innerHTML = "";
  for (const item of items) {
    const fm = item.frontmatter;
    const platform = SYNDICATION_PLATFORMS.find((p) => p.slug === fm.platform);
    const btn = document.createElement("button");
    btn.className = "article-row" + (currentSyndication && currentSyndication.key === item.key ? " is-active" : "");
    btn.innerHTML =
      `<span class="article-row__title">${escapeHtml(fm.hookHeadline || fm.topicId || item.key)}</span>` +
      `<span class="article-row__meta"><span class="chip ${fm.status || "draft"}">${escapeHtml(fm.status || "draft")}</span>${platform ? platform.name : (fm.platform || "?")} · ${escapeHtml(fm.topicId || "")}</span>`;
    btn.addEventListener("click", () => openSyndication(item.key));
    listEl.appendChild(btn);
  }
}

document.getElementById("new-syndication-btn").addEventListener("click", () => {
  const topicId = prompt("ID темы (например tool-1):", "");
  if (!topicId) return;
  const product = topicId.split("-").slice(0, -1).join("-");
  const platform = prompt(`Площадка (${SYNDICATION_PLATFORMS.map((p) => p.slug).join(" / ")}):`, "vc");
  if (!platform || !SYNDICATION_PLATFORMS.some((p) => p.slug === platform.trim())) {
    alert("Площадка должна быть одной из: " + SYNDICATION_PLATFORMS.map((p) => p.slug).join(", "));
    return;
  }
  const original = articles.find((i) => !isTopicOverride(i) && !isBrief(i) && !isSyndication(i) && i.frontmatter.topicId === topicId);
  if (!original) {
    alert(`Статья с topicId "${topicId}" не найдена в бакете — синдикация готовится после публикации оригинала (Stage 7, гейт «после индексации»). Убедитесь, что статья уже есть во вкладке «Статьи».`);
    return;
  }
  const key = `${SYNDICATION_PREFIX}${platform.trim()}/${topicId}.md`;
  currentSyndication = {
    key,
    etag: null,
    fm: {
      topicId, product, platform: platform.trim(), status: "draft",
      originalKey: original.key, liveUrl: "", hookHeadline: "",
      createdAt: new Date().toISOString().slice(0, 10),
    },
    body: "\n",
    isNew: true,
  };
  renderSyndicationList();
  renderSyndicationEditor();
});

async function openSyndication(key) {
  const res = await api(`?action=get&key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    alert(`Не удалось загрузить пакет (${res.status})`);
    return;
  }
  const data = await res.json();
  const { fm, body } = parseFrontmatter(data.raw);
  currentSyndication = { key, etag: data.etag, fm, body, isNew: false };
  renderSyndicationList();
  renderSyndicationEditor();
}

function serializeSyndicationFrontmatter(fm) {
  const order = ["topicId", "product", "platform", "status", "originalKey", "liveUrl", "hookHeadline", "createdAt"];
  const lines = ["---"];
  for (const key of order) {
    const value = (fm[key] || "").trim();
    if (!value) continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function renderSyndicationEditor() {
  if (!currentSyndication) {
    syndicationEditorEl.innerHTML = '<div class="editor__placeholder">Выберите пакет слева или создайте новый.</div>';
    return;
  }
  const fm = currentSyndication.fm;
  const platform = SYNDICATION_PLATFORMS.find((p) => p.slug === fm.platform);

  syndicationEditorEl.innerHTML = `
    <div class="key-preview">${currentSyndication.isNew ? "Новый пакет" : "Файл"}: ${currentSyndication.key}${currentSyndication.isNew ? "" : ` · etag ${currentSyndication.etag}`}</div>
    ${platform ? `<div class="modal-note" style="margin-bottom:var(--ui-space-12)"><strong>${platform.name}:</strong> ${escapeHtml(platform.hint)}</div>` : ""}
    <div class="editor-grid">
      <div class="field"><label>Тема (topicId)</label><input id="s-topicId" value="${escapeHtml(fm.topicId || "")}" disabled /></div>
      <div class="field"><label>Продукт</label><input id="s-product" value="${escapeHtml(fm.product || "")}" disabled /></div>
      <div class="field"><label>Площадка</label><input id="s-platform" value="${platform ? platform.name : (fm.platform || "")}" disabled /></div>
      <div class="field"><label>Оригинал в бакете</label><input id="s-originalKey" value="${escapeHtml(fm.originalKey || "")}" disabled /></div>
      <div class="field"><label>Статус</label>
        <select id="s-status">${SYNDICATION_STATUS_ORDER.map((s) => `<option value="${s}" ${s === fm.status ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Живая ссылка (после публикации на площадке)</label><input id="s-liveUrl" value="${escapeHtml(fm.liveUrl || "")}" placeholder="https://..." /></div>
      <div class="field full"><label>Заголовок-хук (отдельно от H1 оригинала)</label><input id="s-hookHeadline" value="${escapeHtml(fm.hookHeadline || "")}" /></div>
    </div>

    <div class="field">
      <label>Открывающий абзац-затравка + адаптированное тело (Markdown)</label>
      <textarea id="s-body" class="body-editor">${escapeHtml(currentSyndication.body)}</textarea>
    </div>

    <div class="editor-footer">
      <div class="btn-row">
        <button id="s-save-btn" class="btn primary">Сохранить</button>
        <button id="s-preview-btn" class="btn">Превью</button>
        ${currentSyndication.isNew ? "" : '<button id="s-delete-btn" class="btn danger">Удалить</button>'}
      </div>
      <div id="s-save-status" class="save-status"></div>
    </div>
    <div id="s-conflict-box"></div>
    <div id="s-preview-box" class="preview-box" hidden></div>
  `;

  for (const id of ["s-status", "s-liveUrl", "s-hookHeadline", "s-body"]) {
    document.getElementById(id).addEventListener("input", readSyndicationForm);
  }
  document.getElementById("s-save-btn").addEventListener("click", saveSyndication);
  document.getElementById("s-preview-btn").addEventListener("click", () => {
    const box = document.getElementById("s-preview-box");
    box.hidden = !box.hidden;
    if (!box.hidden) box.innerHTML = window.marked ? marked.parse(currentSyndication.body || "") : escapeHtml(currentSyndication.body || "");
  });
  const delBtn = document.getElementById("s-delete-btn");
  if (delBtn) delBtn.addEventListener("click", deleteSyndication);
}

function readSyndicationForm() {
  currentSyndication.fm.status = document.getElementById("s-status").value;
  currentSyndication.fm.liveUrl = document.getElementById("s-liveUrl").value;
  currentSyndication.fm.hookHeadline = document.getElementById("s-hookHeadline").value;
  currentSyndication.body = document.getElementById("s-body").value;
}

async function saveSyndication() {
  readSyndicationForm();
  const statusEl = document.getElementById("s-save-status");
  const conflictBox = document.getElementById("s-conflict-box");
  conflictBox.innerHTML = "";
  statusEl.textContent = "Сохраняю…";
  statusEl.className = "save-status";

  const raw = `${serializeSyndicationFrontmatter(currentSyndication.fm)}\n${currentSyndication.body}`;
  const res = await api("", {
    method: "PUT",
    body: JSON.stringify({ key: currentSyndication.key, raw, ifMatch: currentSyndication.isNew ? undefined : currentSyndication.etag }),
  });

  if (res.status === 200) {
    const data = await res.json();
    currentSyndication.etag = data.etag;
    currentSyndication.isNew = false;
    statusEl.textContent = "Сохранено.";
    statusEl.className = "save-status ok";
    await loadSyndications(true);
  } else if (res.status === 409) {
    const data = await res.json();
    statusEl.textContent = "Конфликт: файл изменили параллельно";
    statusEl.className = "save-status err";
    conflictBox.innerHTML = `<div class="conflict-box">Текущее содержимое в бакете:<pre>${escapeHtml(data.currentRaw)}</pre>Обновите вручную и повторите сохранение.</div>`;
  } else {
    statusEl.textContent = `Ошибка ${res.status}`;
    statusEl.className = "save-status err";
  }
}

async function deleteSyndication() {
  if (!confirm(`Удалить пакет ${currentSyndication.key}? Действие необратимо.`)) return;
  const res = await api(`?key=${encodeURIComponent(currentSyndication.key)}`, { method: "DELETE" });
  if (!res.ok) {
    alert(`Не удалось удалить (${res.status})`);
    return;
  }
  currentSyndication = null;
  await loadSyndications(true);
  renderSyndicationEditor();
}

boot();
