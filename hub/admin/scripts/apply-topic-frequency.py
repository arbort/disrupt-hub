#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Снимает широкую частотность по topic-phrases.tsv через Wordstat API и:
1) пишет число в колонку "Частотность" соответствующей строки
   disrupt/hub/topics/<product>-backlog.md (заменяет `[TBD]`);
2) пишет полную разбивку (похожие запросы + смежные ассоциации с их
   собственными числами) в admin/web/data/topic-frequency-details.json —
   источник для детальной карточки в реестре ("из чего складывается число").

    python3 apply-topic-frequency.py

Правило Арсения 2026-09-13: НЕ ретраить 403 и НЕ продолжать после квоты
(429) — при любом из двух сразу останавливаем весь прогон, недоснятые темы
остаются `[TBD]` и доснимаются следующим запуском. Раньше 403 ретраился
(флейк ~1/6 запросов) — здесь сознательно другое поведение: батч разовый и
не срочный, дешевле подождать следующего запуска, чем жечь квоту повторами.
Поэтому HTTP-вызов сделан заново (single-attempt), а не через retry-цикл
Wordstat из disrupt/shared/wordstat-check.py — оттуда переиспользованы
только константы ROOT/FOLDER/REGION, не логика ретраев.
"""
import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HUB = HERE.parent.parent
DISRUPT = HUB.parent
TOPICS_DIR = HUB / "topics"
PHRASES_FILE = HERE / "topic-phrases.tsv"
DETAILS_OUT = HUB / "admin" / "web" / "data" / "topic-frequency-details.json"
CACHE_FILE = DISRUPT / "shared" / "data" / "wordstat-cache.json"

spec = importlib.util.spec_from_file_location("wordstat_check", DISRUPT / "shared" / "wordstat-check.py")
wordstat_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wordstat_check)
ROOT, FOLDER, REGION = wordstat_check.ROOT, wordstat_check.FOLDER, wordstat_check.REGION

KEY = os.environ.get("YANDEX_AI_API_KEY")
if not KEY:
    sys.exit("нет YANDEX_AI_API_KEY в окружении")

N_SIMILAR = 10  # сколько похожих фраз тянуть — нужно для детальной карточки, не только сумма


def load_phrases():
    pairs = []
    for line in PHRASES_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "\t" not in line:
            continue
        topic_id, phrase = line.split("\t", 1)
        pairs.append((topic_id.strip(), phrase.strip()))
    return pairs


def load_cache():
    return json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else {}


def save_cache(cache):
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


def fetch_once(phrase, n, key):
    """Один запрос, без ретраев. Возвращает (result_or_None, status), status
    — "ok" | "403" | "429" | "error"."""
    body = json.dumps({"phrase": phrase, "numPhrases": n, "regions": [REGION], "folderId": FOLDER},
                       ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{ROOT}/topRequests", data=body, method="POST",
        headers={"Authorization": f"Api-Key {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8")), "ok"
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return None, "403"
        if e.code == 429:
            return None, "429"
        return {"error": f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:160]}"}, "error"
    except Exception as e:                                        # noqa: BLE001
        return {"error": str(e)}, "error"


def format_count(total):
    return f"{total:,}".replace(",", " ") if total is not None else None


def apply_backlog(results):
    by_product = {}
    for topic_id, count in results.items():
        if count is None:
            continue
        product, number = topic_id.rsplit("-", 1)
        by_product.setdefault(product, {})[number] = count

    for product, numbers in by_product.items():
        path = TOPICS_DIR / f"{product}-backlog.md"
        if not path.exists():
            print(f"  ! нет файла {path.name}, пропускаю {product}")
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        changed = 0
        for i, line in enumerate(lines):
            if not line.strip().startswith("|"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if not cells or not cells[0].isdigit():
                continue
            number = cells[0]
            if number not in numbers:
                continue
            new_cell = format_count(numbers[number])
            new_line, n = re.subn(r"`\[TBD\]`", new_cell, line, count=1)
            if n:
                lines[i] = new_line
                changed += 1
        if changed:
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            print(f"  {path.name}: обновлено строк — {changed}")


def main():
    pairs = load_phrases()
    cache = load_cache()
    details = json.loads(DETAILS_OUT.read_text(encoding="utf-8")) if DETAILS_OUT.exists() else {}

    print(f"Тем к проверке: {len(pairs)}")
    counts = {}
    calls = 0
    stopped = False
    remaining = []

    for topic_id, phrase in pairs:
        ck = f"top::{phrase}::{N_SIMILAR}"
        if ck in cache:
            res = cache[ck]
        elif stopped:
            remaining.append(topic_id)
            continue
        else:
            res, status = fetch_once(phrase, N_SIMILAR, KEY)
            calls += 1
            if status in ("403", "429"):
                label = "квота часа исчерпана (429)" if status == "429" else "403 — стоп без ретраев по правилу"
                print(f"  ! {label} на {topic_id} ({phrase}) — останавливаюсь, остальное доснимем в следующий запуск")
                stopped = True
                remaining.append(topic_id)
                continue
            if status == "error" or (res and "error" in res):
                print(f"  ! {topic_id} ({phrase}): {(res or {}).get('error', 'нет ответа')}")
                continue
            cache[ck] = res
            time.sleep(0.25)

        total = res.get("totalCount")
        total = int(total) if total is not None else None
        counts[topic_id] = total
        details[topic_id] = {
            "phrase": phrase,
            "totalCount": total,
            "similar": [{"phrase": r["phrase"], "count": int(r["count"])} for r in res.get("results", [])],
            "associations": [{"phrase": r["phrase"], "count": int(r["count"])} for r in res.get("associations", [])],
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
        print(f"  {topic_id:14s} {phrase:42s} {total if total is not None else '—'}")

    save_cache(cache)
    DETAILS_OUT.parent.mkdir(parents=True, exist_ok=True)
    DETAILS_OUT.write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nвызовов к API: {calls}, получено чисел: {len(counts)}")
    if remaining:
        print(f"Осталось на следующий запуск ({len(remaining)}): {', '.join(remaining)}")
    apply_backlog(counts)


if __name__ == "__main__":
    main()
