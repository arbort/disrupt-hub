#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Строит "Семантическую карту" (2026-09-18, дополнено 2026-09-18 вечером) —
для каждого продукта сводит три независимых сигнала о реальном спросе:

1. **Полосы объёма Wordstat** — темы бэклога и ещё не занятые similar-фразы,
   разложенные по полосам (длинный хвост / узкая / целевая зона / широкая
   голова). Логика полос — перенос подхода агентства giga.chat, разбор в
   HUB.md, "Семантическая карта: полосы объёма спроса".
2. **Подтверждено рекламой** (добавлено вечером 2026-09-18) — реальные
   ad-группы Яндекс.Директа из отчёта `reports/15.09/Disrupt-15-09.xlsx`
   с фактическими показами/кликами/конверсиями. Это сильнее любой оценки
   по Wordstat: это не потенциальный, а уже подтверждённый деньгами и
   кликами спрос нашей же аудитории. Синтез с находкой 1 — вот что Арсений
   назвал "найти середину": не гадать по формуле объёма, а в первую очередь
   опираться на то, что уже доказанно работает в рекламе, и только для
   продуктов/тем без рекламных данных — на полосы Wordstat.
3. **Зоны роста** — Wordstat-фразы приличного объёма, ещё не занятые темой.

Ничего нового у Wordstat/Директа не запрашивает — только читает уже
существующие файлы. Запуск:
    python3 admin/scripts/build-semantic-map.py
Перезапускать после apply-topic-frequency.py (новые темы) или после
обновления отчёта Disrupt-DD-MM.xlsx (новые рекламные данные).
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HUB = HERE.parent.parent
DISRUPT = HUB.parent
TOPICS_FILE = HUB / "admin" / "web" / "data" / "topics.json"
DETAILS_FILE = HUB / "admin" / "web" / "data" / "topic-frequency-details.json"
OUT_FILE = HUB / "admin" / "web" / "data" / "semantic-map.json"
ADS_FILE = DISRUPT / "reports" / "15.09" / "Disrupt-15-09.xlsx"

# Границы — см. разбор в HUB.md. "Целевая зона" = самая частая полоса у
# giga.chat на уровне готовой страницы (5 000-20 000, медиана 14 068).
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

# Правило Арсения 2026-09-18: темы ниже этого порога никогда не показываются
# в "Реестре тем" — трафика физически нет, писать под них статьи бессмысленно.
MIN_TOPIC_FREQUENCY = 500

# Листы отчёта Директа → продукт хаба + признак "нужно ли менять местами
# Клики/CTR и Конверсии/CR". Обнаружено и провалидировано вручную 2026-09-18:
# у листа "Айва Ключи" эти пары колонок физически переставлены относительно
# заголовков (проверено самосогласованностью: CPC*клики должно давать
# расход, CPA*конверсии — тоже; при чтении "в лоб" получались абсурдные
# дробные числа показов/конверсий — 0.9 "кликов" на 1 млн показов). У
# "Мультитул"/"Тайп"/"Ника" колонки читаются напрямую, без перестановки.
# "Консьерж Ключи" не включён — сумма конверсий по всему листу равна 0
# независимо от направления чтения (проверено), нет усвояемого сигнала.
ADS_SHEETS = {
    "Мультитул Ключи": ("tool", False),
    "Тайп Ключи": ("type", False),
    "Айва Ключи": ("aiwa", True),
}

# Значимые слова короче — почти всегда служебные (предлоги, частицы) и не
# несут смысла для сопоставления ad-группы с темой SEO-бэклога.
STOPWORDS = {
    "ии", "нейросеть", "нейросети", "нейросетью", "с", "для", "и", "в", "на",
    "по", "из", "от", "до", "что", "как", "без", "или", "под", "это",
    "помощью", "через", "у", "к", "не", "за", "при", "об", "про",
}


def band_for(count):
    for b in BANDS:
        if count >= b["min"] and (b["max"] is None or count < b["max"]):
            return b["id"]
    return BANDS[-1]["id"]


def norm(phrase):
    return re.sub(r"\s+", " ", (phrase or "").strip().lower())


def significant_words(text):
    words = re.findall(r"[а-яёa-z]+", (text or "").lower())
    return {w for w in words if len(w) >= 4 and w not in STOPWORDS}


def parse_freq(raw):
    if not raw or raw == "`[TBD]`":
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    return int(digits) if digits else None


# ---------- Wordstat: темы бэклога + зоны роста ----------

def build_wordstat_layer():
    topics_data = json.loads(TOPICS_FILE.read_text(encoding="utf-8"))
    details = json.loads(DETAILS_FILE.read_text(encoding="utf-8")) if DETAILS_FILE.exists() else {}
    topics_by_id = {t["topicId"]: t for t in topics_data["topics"]}

    products = {}
    for topic_id, t in topics_by_id.items():
        products.setdefault(t["product"], {"topics": [], "occupied": set(), "gap_candidates": {}})

    # Проход 1 — темы + "занятые" фразы (голова темы и, если анкор бэклога —
    # не голова, а конкретная similar-фраза, тоже она; пример: tool-1 голова
    # "презентация нейросеть" 159709, анкор в бэклоге — 14745, это
    # similar-фраза "нейросеть сделать презентацию", подобранная вручную как
    # менее зашумлённая брендом конкурента).
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

    # Проход 2 — similar-фразы как кандидаты в "зоны роста".
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

    result = {}
    for product, data in products.items():
        topics_list = sorted(data["topics"], key=lambda x: x["number"])
        band_counts = {b["id"]: 0 for b in BANDS}
        for e in topics_list:
            if e["band"]:
                band_counts[e["band"]] += 1
        growth_gaps = [g for g in data["gap_candidates"].values() if g["band"] != "long_tail"]
        growth_gaps.sort(key=lambda g: -g["count"])
        result[product] = {
            "topics": topics_list,
            "bandCounts": band_counts,
            "topicsWithData": sum(band_counts.values()),
            "topicsTotal": len(topics_list),
            "growthGaps": growth_gaps[:15],
        }
    return result


# ---------- Директ: подтверждено рекламой ----------

def extract_ads_sheet(ws, swap):
    """(campaign, group) — не group в одиночку: одно и то же название группы
    встречается в разных кампаниях (напр. network_kw и search_general у
    Айвы) с независимой статистикой. Если у комбинации есть отдельная
    "итоговая" строка (Ключевая фраза пустая) — берём только её, не
    суммируя с дочерними строками (иначе задвоим числа). Если итоговой
    строки нет (обнаружено у Айвы: кампания network_kw вообще не выдаёт
    строк-итогов, только построчный разбор по фразам, 360 строк) —
    суммируем построчно. Дальше сворачиваем по имени группы (объединяя
    показатели одной и той же группы из разных кампаний)."""
    has_total = set()
    for r in range(6, ws.max_row + 1):
        camp = ws.cell(row=r, column=1).value
        group = ws.cell(row=r, column=2).value
        kw = ws.cell(row=r, column=3).value
        if not camp or not group:
            continue
        if not (kw and str(kw).strip()):
            has_total.add((camp, group))

    by_group = {}
    for r in range(6, ws.max_row + 1):
        camp = ws.cell(row=r, column=1).value
        group = ws.cell(row=r, column=2).value
        kw = ws.cell(row=r, column=3).value
        if not camp or not group:
            continue
        is_total_row = not (kw and str(kw).strip())
        combo_has_total = (camp, group) in has_total
        if combo_has_total and not is_total_row:
            continue  # есть отдельный итог — построчные дети этой комбинации пропускаем
        vals = [ws.cell(row=r, column=c).value for c in range(4, 12)]
        if not all(isinstance(v, (int, float)) for v in vals):
            continue
        spend, impr, clicks, ctr, cpc, conv, cr, cpa = vals
        if swap:
            clicks, ctr, conv, cr = ctr, clicks, cr, conv
        acc = by_group.setdefault(group, [0, 0, 0, 0])
        acc[0] += spend
        acc[1] += impr
        acc[2] += clicks
        acc[3] += conv

    result = []
    for group, (spend, impr, clicks, conv) in by_group.items():
        if conv <= 0:
            continue
        ctr = round(clicks / impr * 100, 2) if impr else 0
        cr = round(conv / clicks * 100, 2) if clicks else 0
        cpa = round(spend / conv, 1) if conv else None
        result.append({
            "group": group,
            "spend": round(spend),
            "impressions": round(impr),
            "clicks": round(clicks),
            "ctr": ctr,
            "conversions": round(conv),
            "cr": cr,
            "cpa": cpa,
            "isBrandCompetitor": bool(group[:1].isupper()),
        })
    result.sort(key=lambda x: -x["conversions"])
    return result


def is_covered_by_seo(group_name, product_topics):
    """Найдена и исправлена вручную 2026-09-18: первая версия считала
    "покрыто", если совпадало ХОТЯ БЫ одно значимое слово — из-за этого
    "улучшить текст" (топ-1 конверсий Мультитула, 3036) ложно считалась
    покрытой темой tool-2 про превращение текста в презентацию: общее
    слово только "текст", а задача другая (улучшить/исправить текст —
    не то же самое, что собрать из него презентацию). То же самое
    произошло с "голос в текст с ии" у Тайпа (общее слово "текст" с
    темой type-1, которая про надиктовку делового письма — тоже другая
    задача). Правило теперь: если у ad-группы больше одного значимого
    слова, совпадения одного слова недостаточно — нужно совпадение
    минимум двух (более специфичный сигнал, что это та же тема, а не
    просто общий термин домена продукта). Однослойные группы («документ»,
    «презентация», «диктовка») по-прежнему считаются покрытыми при
    совпадении своего единственного слова — там нет второго слова, с
    которым можно потребовать пересечение."""
    words = significant_words(group_name)
    if not words:
        return False
    best_overlap = 0
    for t in product_topics:
        haystack = " ".join(filter(None, [t.get("title"), t.get("headPhrase")]))
        overlap = len(words & significant_words(haystack))
        best_overlap = max(best_overlap, overlap)
    if len(words) <= 1:
        return best_overlap >= 1
    return best_overlap >= 2


def build_ads_layer(wordstat_products):
    try:
        import openpyxl
    except ImportError:
        return {}, "openpyxl не установлен — секция «Подтверждено рекламой» пропущена"
    if not ADS_FILE.exists():
        return {}, f"файл не найден: {ADS_FILE} — секция «Подтверждено рекламой» пропущена"

    wb = openpyxl.load_workbook(ADS_FILE, data_only=True)
    result = {}
    for sheet_name, (product, swap) in ADS_SHEETS.items():
        if sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        groups = extract_ads_sheet(ws, swap)
        product_topics = wordstat_products.get(product, {}).get("topics", [])
        for g in groups:
            g["coveredBySeo"] = is_covered_by_seo(g["group"], product_topics)
        result[product] = groups[:15]
    note = (
        f"Источник — {ADS_FILE.name}, данные по 13.09. Консьерж и Ника не включены: "
        "у Консьержа сумма конверсий по листу равна 0 (нет усвояемого сигнала на "
        "уровне ключей на эту дату), Ника не входит в ростер хаба (продукт "
        "приостановлен, см. HUB.md)."
    )
    return result, note


def main():
    wordstat_products = build_wordstat_layer()
    ads_products, ads_note = build_ads_layer(wordstat_products)

    result_products = {}
    for product, data in wordstat_products.items():
        result_products[product] = {**data, "adPerformance": ads_products.get(product, [])}

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "bands": BANDS,
        "agencyBenchmark": AGENCY_BENCHMARK,
        "minTopicFrequency": MIN_TOPIC_FREQUENCY,
        "adPerformanceNote": ads_note,
        "products": result_products,
    }
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Записано: {OUT_FILE}")
    for product, data in sorted(result_products.items()):
        ads_count = len(data["adPerformance"])
        uncovered = sum(1 for g in data["adPerformance"] if not g["coveredBySeo"] and not g["isBrandCompetitor"])
        print(f"  {product}: {data['bandCounts']} · зон роста: {len(data['growthGaps'])} · рекламных групп: {ads_count} (не покрыто SEO: {uncovered})")
    print(f"\n{ads_note}")


if __name__ == "__main__":
    main()
