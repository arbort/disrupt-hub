// Disrupt-Hub content admin — Yandex Cloud Function (Node.js, HTTP-инвокейбл напрямую,
// без API Gateway). Функция публичная (allow-unauthenticated-invoke) — авторизация
// сделана в коде через заголовок X-Admin-Key, потому что приватная функция Yandex
// режет CORS-preflight (OPTIONS) ещё до кода: браузер никогда не шлёт кастомные
// заголовки на preflight, платформа отвечает 401 раньше, чем функция успевает
// выставить Access-Control-*. См. disrupt/hub/HUB.md, секция про админку.
//
// Хранилище — бакет BUCKET_NAME в Yandex Object Storage (S3-совместимый API),
// доступ через статический access key отдельного сервис-аккаунта (роль
// storage.editor, только на этот бакет). Каждый объект — .md с YAML-фронтматтером,
// путь = <product>/<filename>.md, тот же формат, что уже понимает Astro.

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import matter from "gray-matter";

const BUCKET = process.env.BUCKET_NAME;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const s3 = new S3Client({
  region: process.env.S3_REGION || "ru-central1",
  endpoint: process.env.S3_ENDPOINT || "https://storage.yandexcloud.net",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key",
  "Access-Control-Max-Age": "600",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function isNotFound(err) {
  return err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
  return JSON.parse(raw);
}

export async function handler(event) {
  const method = event.httpMethod;

  // Preflight — без единой проверки авторизации, иначе браузер никогда не
  // дойдёт до настоящего запроса (см. комментарий в шапке файла).
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const headers = event.headers || {};
  const providedKey = headers["X-Admin-Key"] || headers["x-admin-key"];
  if (!ADMIN_SECRET || providedKey !== ADMIN_SECRET) {
    return json(401, { error: "unauthorized" });
  }

  const qs = event.queryStringParameters || {};

  try {
    if (method === "GET" && qs.action === "list") {
      const listing = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      const items = [];
      for (const obj of listing.Contents || []) {
        if (!obj.Key.endsWith(".md")) continue;
        const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
        const raw = await streamToString(got.Body);
        const parsed = matter(raw);
        items.push({
          key: obj.Key,
          etag: got.ETag,
          lastModified: obj.LastModified,
          size: obj.Size,
          frontmatter: parsed.data,
        });
      }
      return json(200, { items });
    }

    if (method === "GET" && qs.action === "get" && qs.key) {
      try {
        const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: qs.key }));
        const raw = await streamToString(got.Body);
        return json(200, { key: qs.key, etag: got.ETag, raw });
      } catch (err) {
        if (isNotFound(err)) return json(404, { error: "not found" });
        throw err;
      }
    }

    if (method === "PUT") {
      const payload = parseBody(event);
      const { key, raw, ifMatch } = payload;
      if (!key || typeof raw !== "string") {
        return json(400, { error: "key и raw обязательны" });
      }
      if (!key.endsWith(".md") || key.includes("..")) {
        return json(400, { error: "key должен быть путём вида product/filename.md" });
      }

      if (ifMatch) {
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
          if (head.ETag !== ifMatch) {
            const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
            const currentRaw = await streamToString(got.Body);
            return json(409, { error: "conflict", currentRaw, currentEtag: got.ETag });
          }
        } catch (err) {
          if (!isNotFound(err)) throw err;
          // объекта ещё нет — это создание, а не конфликт
        }
      }

      const put = await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: raw,
          ContentType: "text/markdown; charset=utf-8",
        }),
      );
      return json(200, { key, etag: put.ETag });
    }

    if (method === "DELETE" && qs.key) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: qs.key }));
      return json(200, { ok: true });
    }

    return json(404, { error: "not found" });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
}
