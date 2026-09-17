#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Строит "Семантическую карту" (добавлено 2026-09-18) — для каждого продукта
раскладывает уже собранные фразы (голова темы из topic-phrases.tsv + похожие
из Wordstat, similar[] в topic-frequency-details.json) по полосам объёма
спроса и отдельно выделяет "зоны роста" — фразы приличного объёма, ещё не
занятые ни одной темой продукта.

Зачем такие границы полос — не произвольное решение, а перенос реального
подхода агентства giga.chat. Разбор giga_chat_семантическое_ядро_общее_c_
Ptraf_2025_10_31_обн_04_05.xlsx, лист "Предлагаемые страницы" (387 строк с
[WS] на уровне готовой страницы, не отдельной фразы): медиана WS — 14 068,
самая частая полоса — 5 000-20 000 (25.6% страниц, самая большая из всех).
У наших 90 тем хаба на момент этого анализа медиана частотности — 19(!),
86.6% тем ниже 1000 — почти весь бэклог (кроме тестовой партии Мультитула
2026-09-17) заведён под придуманные узкие формулировки, а не под реальный
спрос. См. HUB.md, "Семантическая карта" — полный логический разбор.

Ничего нового у Wordstat не запрашивает — только раскладывает уже собранные
apply-topic-frequency.py данные. Запуск:
    python3 admin/scripts/build-semantic-map.py
Перезапускать после каждого apply-topic-frequency.py (новые темы/фразы).
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HUB = HERE.parent.parent
TOPICS_FILE = HUB / "admin" / "web" / "data" / "topics.json"
DETAILS_FILE = HUB / "admin" / "web" / "data" / "topic-frequency-details.json"
OUT_FILE = HUB / "admin" / "web" / "data" / "semantic-map.json"

# Границы — см. разбор выше. "Целевая зона" = самая частая полоса у giga.chat
# на уровне готовой страницы (5 000-20 000, медиана 14 068).
BANDS = [
    {"id": "long_tail", "label": "Длинный хвост", "min": 0, "max": 1000},
    {"id": "narrow", "label": "Узкая, но реальная", "min": 1000, "max": 5000},
    {"id": "sweet_spot", "label": "Целевая зона", "min": 5000, "max": 20000},
    {"id": "head", "label": "Широкая голова", "min": 20000, "max": None},
]

AGENCY_BENCHMARK = {
    "source": "giga_chat_семантическое_ядро_общее_c_Ptraf_2025_10_31_обн_04_05.xlsx, лист «Предлагаемые страницы»",
    "pagesWithData": 387,
    "medianWS": 14068,
    "bandSharePct": {"long_tail": 11.6, "narrow": 18.6, "sweet_spot": 25.6, "head": 44.2},
}


def band_for(count):
    for b in BANDS:
        if count >= b["min"] and (b["max"] is None or count < b["max"]):
            return b["id"]
    return BANDS[-1]["id"]


def norm(phrase):
    return re.sub(r"\s+", " ", (phrase or "").strip().lower())


def parse_freq(raw):
    if not raw or raw == "`[TBD]`":
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    return int(digits) if digits else None


topics_data = json.loads(TOPICS_FILE.read_text(encoding="utf-8"))
details = json.loads(DETAILS_FILE.read_text(encoding="utf-8")) if DETAILS_FILE.exists() else {}
topics_by_id = {t["topicId"]: t for t in topics_data["topics"]}

products = {}
for topic_id, t in topics_by_id.items():
    products.setdefault(t["product"], {"topics": [], "occupied": set(), "gap_candidates": {}})

# Проход 1 — темы бэклога + фразы, которые уже "заняты" (голова темы и, если
# анкор бэклога — не голова, а конкретная similar-фраза, тоже она; пример
# из практики: tool-1 голова "презентация нейросеть" 159709, но анкор в
# бэклоге — 14745, это similar-фраза "нейросеть сделать презентацию",
# подобранная вручную как менее зашумлённая брендом конкурента).
for topic_id, t in topics_by_id.items():
    product = t["product"]
    freq = parse_freq(t["frequency"])
    det = details.get(topic_id)
    entry = {
        "topicId": topic_id,
        "number": t["number"],
        "title": t["title"],
        "status": t["status"],
        "frequency": freq,
        "band": band_for(freq) if freq is not None else None,
        "headPhrase": det["phrase"] if det else None,
        "headTotalCount": det["totalCount"] if det else None,
    }
    products[product]["topics"].append(entry)
    occ = products[product]["occupied"]
    if det and det.get("phrase"):
        occ.add(norm(det["phrase"]))
    if det and freq is not None:
        for s in det.get("similar", []):
            if s.get("count") == freq:
                occ.add(norm(s["phrase"]))

# Проход 2 — все similar-фразы как кандидаты в "зоны роста": объём есть,
# фраза ещё не занята ни одной темой ЭТОГО продукта.
for topic_id, t in topics_by_id.items():
    product = t["product"]
    det = details.get(topic_id)
    if not det:
        continue
    occ = products[product]["occupied"]
    gaps = products[product]["gap_candidates"]
    for s in det.get("similar", []):
        phrase, count = s.get("phrase"), s.get("count")
        if not phrase or count is None:
            continue
        key = norm(phrase)
        if key in occ:
            continue
        prev = gaps.get(key)
        if prev is None or count > prev["count"]:
            gaps[key] = {"phrase": phrase, "count": count, "band": band_for(count), "seenFrom": topic_id}

result_products = {}
for product, data in products.items():
    topics_list = sorted(data["topics"], key=lambda x: x["number"])
    band_counts = {b["id"]: 0 for b in BANDS}
    for e in topics_list:
        if e["band"]:
            band_counts[e["band"]] += 1
    # "Зоны роста" — гэпы приличного объёма (длинный хвост и так уже почти
    # весь текущий бэклог, там нечего искать).
    growth_gaps = [g for g in data["gap_candidates"].values() if g["band"] != "long_tail"]
    growth_gaps.sort(key=lambda g: -g["count"])
    result_products[product] = {
        "topics": topics_list,
        "bandCounts": band_counts,
        "topicsWithData": sum(band_counts.values()),
        "topicsTotal": len(topics_list),
        "growthGaps": growth_gaps[:15],
    }

out = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "bands": BANDS,
    "agencyBenchmark": AGENCY_BENCHMARK,
    "products": result_products,
}
OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"Записано: {OUT_FILE}")
for product, data in sorted(result_products.items()):
    print(f"  {product}: {data['bandCounts']} · зон роста найдено: {len(data['growthGaps'])}")
