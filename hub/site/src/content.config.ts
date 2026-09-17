import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Читает Markdown из disrupt/hub/articles-published/ — зеркало бакета
// disrupt-hub-content (см. disrupt/hub/admin/), не копия рабочей папки
// hub-writer. hub-writer по-прежнему пишет черновики в disrupt/hub/articles/;
// туда файл попадает только через disrupt/hub/admin/scripts/publish.mjs
// (Stage 5, HUB.md). Не менять base обратно на "../articles" — это удалит
// разделение, которое защищает черновики hub-writer от синка бакета.
const articles = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "../articles-published" }),
  schema: z.object({
    title: z.string(),
    product: z.string(),
    status: z.enum(["idea", "brief", "draft", "qc", "published"]),
    h1: z.string().optional(),
    metaTitle: z.string().optional(),
    metaDescription: z.string().optional(),
    date: z.coerce.date().optional(),
    // Добавлено при сборке админки (HUB.md, «Решения» с датой) — у каждого
    // есть реальный потребитель в BaseLayout/[slug].astro в этой же задаче.
    // Сознательно НЕ добавлены поля процесса (дедлайн/копирайтер/редполитика,
    // giga.chat-прецедент) — нет живого потребителя, см. HUB.md.
    canonical: z.string().optional(),
    ogImage: z.string().optional(),
    robots: z.string().optional(),
    schemaType: z.enum(["Article", "HowTo"]).optional(),
  }),
});

export const collections = { articles };
