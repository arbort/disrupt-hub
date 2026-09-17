// Источник фактов — disrupt/products/<slug>/PRODUCT.md и disrupt.builders
// (снято 2026-09-12). Ника приостановлена — см. disrupt/hub/HUB.md,
// «Решения от 2026-09-12» — сюда не добавлена.
export interface Product {
  slug: string;
  name: string;
  tagline: string;
  href: string;
  stub: boolean; // true — факты минимальны, собраны только с лендинга
}

export const products: Product[] = [
  {
    slug: "tool",
    name: "Мультитул",
    tagline:
      "Помощник, который работает на вашем компьютере: собирает презентации и таблицы, анализирует документы, проводит исследования и пишет код",
    href: "https://multitool.works/",
    stub: false,
  },
  {
    slug: "type",
    name: "Тайп",
    tagline:
      "Самая быстрая голосовая клавиатура для русского языка. Работает локально, без интернета и полностью приватно",
    href: "https://gigatype.app/",
    stub: false,
  },
  {
    slug: "concierge",
    name: "ИИ-Консьерж",
    tagline:
      "Бот в Телеграме, которому можно поручить задание — забронировать столик, поставить встречу или завести напоминание",
    href: "https://yourconcierge.ru/",
    stub: false,
  },
  {
    slug: "aiwa",
    name: "Айва",
    tagline:
      "Советы с учётом самочувствия, персональное меню и тренировки. Для женщин — календарь цикла и поддержка во время беременности и менопаузы",
    href: "https://aiwa-wellness.app/",
    stub: false,
  },
  {
    slug: "gochi",
    name: "Гочи",
    tagline:
      "Создай в телефоне друга, который живёт своей жизнью: ухаживай за ним, подбирай ему одежду и отправляй в путешествия",
    href: "https://your-gochi.app/",
    stub: true,
  },
  {
    slug: "narra",
    name: "Narra",
    tagline: "Интерактивная читалка: озвучит книгу, оживит героев и даст с ними поговорить",
    href: "https://get-narra.app/",
    stub: true,
  },
  {
    slug: "memento",
    name: "Memento",
    tagline:
      "Записывает встречи, расшифровывает речь и собирает итоги. Спросите Мементо что угодно по вашим встречам — и он ответит",
    href: "https://get-memento.app/",
    stub: true,
  },
  {
    slug: "korche",
    name: "Короче",
    tagline:
      "Все ваши новости в одной ленте. Задавайте любые вопросы по новости всезнающему Корочеславу, меняйте стилистику, добавляйте любые источники",
    href: "https://krch.wtf/about",
    stub: true,
  },
  {
    slug: "radar",
    name: "Disrupt Radar",
    tagline:
      "Радар рынка ИИ: показывает, какие стартапы набирают обороты, что запускают крупные игроки, и проверяет ваши гипотезы исследованием, а не мнениями",
    href: "https://disrupt-radar.app/",
    stub: true,
  },
  {
    slug: "reka",
    name: "Река",
    tagline: "Друзья друг другу рекомендуют фильмы, сериалы и аниме",
    href: "https://t.me/FriendsRekaBot",
    stub: true,
  },
];
