# Локальное SEO Eirich IT-Service — этап 1

Главная остаётся обзорной страницей компании в Zürich-Oerlikon. У каждой из четырёх услуг есть немецкая и английская страница со ссылками на связанные услуги и контактами.

| Страницы | Целевые запросы DE | Целевые запросы EN |
| --- | --- | --- |
| [IT-Service](it-service-zuerich/) · [IT support](en/it-support-zurich/) | IT-Service Zürich, PC-Hilfe Zürich, IT-Hilfe Oerlikon | IT support Zurich, computer help Zurich, IT support Oerlikon |
| [WLAN-Hilfe](wlan-hilfe-zuerich/) · [Wi-Fi support](en/wifi-support-zurich/) | WLAN-Hilfe Zürich, Router einrichten Zürich, WLAN-Probleme Oerlikon | Wi-Fi support Zurich, router setup Zurich |
| [Webseiten](webseiten-zuerich/) · [Website design](en/website-design-zurich/) | Website erstellen lassen Zürich, Webseiten für Kleinunternehmen Zürich, Landingpage Zürich | website design Zurich, small business websites Zurich |
| [Individualsoftware](individualsoftware-zuerich/) · [Custom software](en/custom-software-zurich/) | Individualsoftware Zürich, Softwareentwicklung für KMU Zürich, Prozessautomatisierung Zürich | custom software Zurich, workflow automation Zurich |

## Изменения

- У каждой услуги свой заголовок страницы, meta description, H1, канонический URL и FAQ. В JSON-LD описаны страница, услуга и видимые хлебные крошки. Все услуги ссылаются на существующую сущность компании.
- На обеих главных есть меню услуг и ссылки в обзорном разделе. Мобильное меню доступно с клавиатуры, а основные ссылки и список услуг работают при отключённом JavaScript.
- В sitemap десять канонических URL. Каждая страница связана со своим переводом через взаимный `hreflang` и переключатель DE/EN. У английских услуг собственные каталоги с `index.html` под `/en/`.
- Сохранены GitHub Pages, CNAME, действующий robots.txt, общие стили, изображения, цены в CHF, контакты, юридические разделы и код формы.

## Проверки

- Chromium и Playwright проверили HTTP 200 для десяти страниц на ширинах 320, 390, 768 и 1440 px. Проверены загрузка изображений, отсутствие горизонтальной прокрутки, 15 внутренних HTTP-адресов и их якоря, уникальность страниц, sitemap, canonical, hreflang и согласованность JSON-LD.
- Проверены переходы с главной на четыре услуги и обратно, переключение DE/EN, FAQ, клавиатурное управление мобильным меню и работа навигации при отключённом JavaScript. Автоматические проверки axe-core по правилам WCAG 2.0/2.1 A/AA не выявили нарушений. `node --check script.js` и `git diff --check` прошли.
- Обе версии формы проверены на тестовых ответах HTTP 200 и 500. Запросы перехватывались в браузере. Проверка боевого сайта и внешних ссылок из среды остановилась на ответе прокси 403.

## Google Search Console после публикации

1. В подтверждённом ресурсе для `eiricha.com` отправить или повторно отправить `https://eiricha.com/sitemap.xml` в разделе «Файлы Sitemap».
2. Проверить опубликованные страницы услуг обоих языков через «Проверку URL». Убедиться, что каждая доступна Google и содержит ожидаемый canonical, затем запросить индексацию новых URL.
3. После обработки проверить статус индексации и canonical, выбранный Google. В отчёте «Эффективность» отслеживать показы, клики и запросы по каждой странице. После публикации отдельно проверить боевые HTTP-ответы и внешние CTA.
