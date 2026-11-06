# OpenRouter Tab Sorter

A [Sine](https://github.com/CosmoCreeper/Sine) mod for [Zen Browser](https://zen-browser.app). One click sorts the loose tabs of your current space into tab groups (or Zen folders, your choice), named and given an emoji icon by an AI model you pick on [OpenRouter](https://openrouter.ai).

- Fits tabs into your existing groups first, and makes new ones only for tabs that share a topic.
- The model also picks an emoji icon (and a colour for tab groups) for each new group.
- Never touches pinned tabs, essentials, splits or tabs already in a folder.
- Cheap: a sort of ~30 tabs is about 1-2 thousand tokens, a few hundredths of a cent with a small model such as `z-ai/glm-5.3-flash`.
- Original code, written from scratch (not a fork of another tab-sorting mod).

## Install

1. Install [Sine](https://github.com/CosmoCreeper/Sine) in Zen.
2. In Sine's marketplace window add this mod by its repository name: `sgredos2/AI-tab-sorter`.
3. Restart Zen, open the mod's settings and paste your OpenRouter API key (from <https://openrouter.ai/keys>).

## Use

- **Alt+Shift+G**, the broom button on the line above the loose tabs (next to *Clear*), or right-click a tab → *Sort tabs into groups (AI)*.
- Select several tabs first to sort only those.

## Privacy

Sorting sends, for each loose tab, **its title and its site name** (for example `github.com`) to OpenRouter and the model provider you chose. Page addresses with paths, query strings, page text and tabs in private windows are never sent. You can turn the site name off, and the list *Never send tabs from these sites* keeps mail, messengers, banks and such out (edit it to taste). Your API key stays in the browser's own settings.

## Settings

| Setting | What it does |
|---|---|
| OpenRouter API key | Required. |
| Model | Default `z-ai/glm-5.3-flash`; any OpenRouter model works. |
| Provider order | Optional, e.g. `Wafer`. Others are used if these fail. |
| Sort into | Tab groups (default) or Zen folders. |
| Emoji icons | Let the model pick an icon for each new group. |
| Most new groups | 4 / 6 / 8 / 12. |
| Send site name | Off: titles only. |
| Never send tabs from | Comma-separated words matched against the address. |
| Button / shortcut | Turn them off if you don't want them. |

## Notes

- Icons: a Zen folder takes the emoji as its icon; a tab group takes it with the Advanced Tab Groups mod (recommended for groups), otherwise the emoji is put in front of its name.
- It relies on Zen's own folder and tab-group code (`gZenFolders`, `gBrowser.addTabGroup`), so a big Zen update can break it. Please open an issue then.
- The model decides the grouping; it can be wrong. Undo with Zen's usual means (drag tabs out of the folder).

## По-русски

Мод для Zen через Sine: по одной кнопке (Alt+Shift+G, кнопка в сайдбаре или пункт в меню вкладки) раскладывает свободные вкладки текущего пространства по папкам с помощью модели на OpenRouter. Сначала подбирает уже существующие папки, новые создаёт только для вкладок с общей темой. Отправляются только заголовки и названия сайтов, не адреса целиком, не вкладки из приватных окон и не сайты из списка исключений (почта, мессенджеры, банки). Ключ OpenRouter вводится в настройках мода и хранится только в браузере.

## Credits

The broom icon, the button next to *Clear* and the wave the divider turns into while sorting come from [Zen Tidy Tabs](https://github.com/Vertex-Mods/Zen-Tidy-Tabs) by Vertex. Everything else here is original code.

## License

MIT
