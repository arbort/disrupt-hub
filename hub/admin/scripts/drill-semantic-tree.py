#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Строит "Дерево семантики" (Stage 1, шаги 2-4 — HUB.md, обновлено
2026-09-19): вместо одного среза Wordstat по головной фразе — рекурсивный
разбор вглубь, пока ветка остаётся продуктивной.

Диагноз Арсения 2026-09-19: сборка семантики — творческий процесс, а не
механический, а прежний Stage 1 (один запрос → 10 похожих фраз → сразу
выбор темы по объёму) вёл себя как компьютер. Живая проверка подтвердила:
второй проход вглубь на ветку "нейросеть для презентаций бесплатно" (17981,
уже известная как "зона роста" для tool-1) раскрыл то, чего не было видно
на первом срезе — "...на русском языке" (1980), "...без регистрации" (612),
и соседнюю категорию в associations "бесплатная нейросеть для генерации
изображений" (20883).

Что делает скрипт — механическая часть (сбор дерева), НЕ творческая часть
(выбор темы). Творческий гейт (шаг 5 в HUB.md — "какую сильную сторону
продукта приглашает показать эта ветка") остаётся ручным: скрипт только
раскладывает объём по узлам дерева, решение о хуке фиксируется человеком
текстом в поле "note" узла (правится вручную в semantic-tree.json, тот же
приём, что topic-product-fit.json).

Правила, перенесённые без изменений из apply-topic-frequency.py:
- 403/429 — остановить весь прогон немедленно, без ретраев, сохранить то,
  что уже собрано.
- Кэш общий с остальными Wordstat-скриптами (../../shared/data/wordstat-cache.json)
  — повторный вызов на тот же корень не жжёт квоту заново.

Использование:
    python3 admin/scripts/drill-semantic-tree.py <product> "<головная фраза>" [--scenario "презентация"]

Дерево копится в admin/web/data/semantic-tree.json — можно звать скрипт
повторно с тем же корнем (например, с --max-depth побольше), уже собранные
узлы не переспрашиваются заново благодаря кэшу.
"""
import argparse
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
OUT_FILE = HUB / "admin" / "web" / "data" / "semantic-tree.json"
CACHE_FILE = DISRUPT / "shared" / "data" / "wordstat-cache.json"

spec = importlib.util.spec_from_file_location("wordstat_check", DISRUPT / "shared" / "wordstat-check.py")
wordstat_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wordstat_check)
ROOT, FOLDER, REGION = wordstat_check.ROOT, wordstat_check.FOLDER, wordstat_check.REGION

KEY = os.environ.get("YANDEX_AI_API_KEY")
if not KEY:
    sys.exit("нет YANDEX_AI_API_KEY в окружении")

# Политика дробления — HUB.md, Stage 1, шаг 4. Не интуиция, explicit-условия:
MAX_DEPTH = 3          # практический потолок — глубже квота не оправдывает разницу
CHILDREN_PER_NODE = 5  # топ-N по объёму из 10 похожих — не все десять, квота не бесконечна
MIN_VOLUME_TO_DRILL = 3000  # ветка ниже этого объёма не бурится дальше (leaf)
MIN_VOLUME_TO_KEEP = 500    # ниже — не попадает в дерево вообще (порог 2026-09-18)
N_SIMILAR = 10


def norm(phrase):
    return re.sub(r"\s+", " ", (phrase or "").strip().lower())


def load_cache():
    return json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else {}


def save_cache(cache):
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


def fetch_once(phrase, cache):
    ck = f"top::{phrase}::{N_SIMILAR}"
    if ck in cache:
        return cache[ck], "ok"
    body = json.dumps({"phrase": phrase, "numPhrases": N_SIMILAR, "regions": [REGION], "folderId": FOLDER},
                       ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{ROOT}/topRequests", data=body, method="POST",
                                  headers={"Authorization": f"Api-Key {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            res = json.loads(r.read().decode("utf-8"))
            cache[ck] = res
            time.sleep(0.25)
            return res, "ok"
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            return None, str(e.code)
        return None, "error"
    except Exception:                                        # noqa: BLE001
        return None, "error"


def load_tree_store():
    return json.loads(OUT_FILE.read_text(encoding="utf-8")) if OUT_FILE.exists() else {"generatedAt": None, "products": {}}


def find_tree(store, product, root_phrase):
    trees = store["products"].setdefault(product, {"trees": []})["trees"]
    for t in trees:
        if norm(t["rootPhrase"]) == norm(root_phrase):
            return t
    t = {"rootPhrase": root_phrase, "scenario": None, "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "nodes": []}
    trees.append(t)
    return t


def get_node(tree, phrase):
    key = norm(phrase)
    for n in tree["nodes"]:
        if norm(n["phrase"]) == key:
            return n
    return None


def add_or_update_node(tree, phrase, count, depth, parent_id, source, status):
    existing = get_node(tree, phrase)
    if existing:
        existing["count"] = count
        if status == "exhausted":
            existing["status"] = "exhausted"
        return existing
    node = {
        "id": f"n{len(tree['nodes'])}",
        "phrase": phrase,
        "count": count,
        "depth": depth,
        "parentId": parent_id,
        "source": source,     # "head" | "similar" | "association"
        "status": status,     # "exhausted" | "leaf"
        "note": None,         # шаг 5 (HUB.md) — заполняется вручную: "выбрана, потому что..."
    }
    tree["nodes"].append(node)
    return node


def drill(tree, phrase, depth, cache, stopped_flag, max_depth):
    """Узел `phrase` уже должен существовать в дереве (добавлен вызывающим
    кодом как leaf) — drill() его находит, дособирает данные по нему через
    Wordstat и помечает exhausted; все его дети добавляются как leaf, а
    затем топ-N из них (по объёму, с полом MIN_VOLUME_TO_DRILL) рекурсивно
    бурятся тем же способом. Родитель детей — id ЭТОГО узла (this_id), не
    id узла, который бурил нас самих — отсюда важно брать this_id из
    get_node(), а не тащить parent_id аргументом через рекурсию."""
    res, status = fetch_once(phrase, cache)
    if status in ("403", "429"):
        print(f"  ! {status} на «{phrase}» — останавливаюсь без ретраев, сохраняю то, что собрано")
        stopped_flag["stopped"] = True
        return
    if status == "error" or not res:
        print(f"  ! ошибка/нет данных на «{phrase}» — пропускаю")
        return

    node = get_node(tree, phrase)
    if node is None:
        return  # не должно происходить — узел добавляется до вызова drill()
    total = res.get("totalCount")
    if total is not None:
        node["count"] = int(total)
    node["status"] = "exhausted"
    this_id = node["id"]

    # API отдаёт count строкой (например "159709"), не числом — без явного
    # приведения любое сравнение с MIN_VOLUME_TO_KEEP/MIN_VOLUME_TO_DRILL
    # падает с TypeError (найдено на первом же живом прогоне).
    associations = [{"phrase": s["phrase"], "count": int(s["count"])} for s in res.get("associations", []) if s.get("count") is not None]
    for s in associations:
        if s["count"] < MIN_VOLUME_TO_KEEP:
            continue
        add_or_update_node(tree, s["phrase"], s["count"], depth + 1, this_id, "association", "leaf")

    similar = [{"phrase": s["phrase"], "count": int(s["count"])} for s in res.get("results", []) if s.get("count") is not None]
    kept = [s for s in similar if s["count"] >= MIN_VOLUME_TO_KEEP]
    kept.sort(key=lambda s: -s["count"])
    for s in kept:
        add_or_update_node(tree, s["phrase"], s["count"], depth + 1, this_id, "similar", "leaf")

    if depth + 1 >= max_depth:
        return

    # Wordstat иногда возвращает саму опрашиваемую фразу как "похожую" на
    # себя же (найдено на первом живом прогоне — "нейросеть для
    # презентаций" оказалась в своих же results). Без проверки на
    # exhausted это либо бессмысленный повторный запрос той же фразы, либо
    # (в худшем случае на большей глубине) риск затянутой рекурсии по
    # кругу между несколькими взаимно похожими фразами.
    to_drill = [s for s in kept[:CHILDREN_PER_NODE] if s["count"] >= MIN_VOLUME_TO_DRILL]
    for s in to_drill:
        if stopped_flag["stopped"]:
            return
        child = get_node(tree, s["phrase"])
        if child and child["status"] == "exhausted":
            continue
        print(f"{'  ' * (depth + 1)}-> бурю «{s['phrase']}» ({s['count']})")
        drill(tree, s["phrase"], depth + 1, cache, stopped_flag, max_depth)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("product")
    ap.add_argument("root_phrase")
    ap.add_argument("--scenario", default=None)
    ap.add_argument("--max-depth", type=int, default=MAX_DEPTH)
    args = ap.parse_args()

    cache = load_cache()
    store = load_tree_store()
    tree = find_tree(store, args.product, args.root_phrase)
    if args.scenario:
        tree["scenario"] = args.scenario

    root_node = get_node(tree, args.root_phrase)
    if not root_node:
        root_node = add_or_update_node(tree, args.root_phrase, 0, 0, None, "head", "leaf")

    stopped_flag = {"stopped": False}
    print(f"Бурю дерево для {args.product}: «{args.root_phrase}» (макс. глубина {args.max_depth})")
    drill(tree, args.root_phrase, 0, cache, stopped_flag, args.max_depth)

    save_cache(cache)
    store["generatedAt"] = datetime.now(timezone.utc).isoformat()
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")

    by_depth = {}
    for n in tree["nodes"]:
        by_depth[n["depth"]] = by_depth.get(n["depth"], 0) + 1
    print(f"\nЗаписано: {OUT_FILE}")
    print(f"Узлов в дереве «{args.root_phrase}»: {len(tree['nodes'])}, по глубине: {by_depth}")
    if stopped_flag["stopped"]:
        print("Прогон остановлен по 403/429 — доберите дерево следующим запуском.")


if __name__ == "__main__":
    main()
