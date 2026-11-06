// ==UserScript==
// @name           OpenRouter Tab Sorter
// @description    Sorts the tabs of the current space into Zen folders with an AI model through OpenRouter.
// @include        main
// ==/UserScript==

(() => {
  "use strict";

  // ---------- settings (Sine writes them as prefs)
  const PREFS = {
    key: "tabsorter.api_key",
    model: "tabsorter.model",
    provider: "tabsorter.provider",
    maxGroups: "tabsorter.max_groups",
    exclude: "tabsorter.exclude",
    sendHosts: "tabsorter.send_hosts",
    button: "tabsorter.button",
    mode: "tabsorter.mode",
    icons: "tabsorter.icons",
    shortcut: "tabsorter.shortcut",
  };
  const DEFAULTS = {
    model: "z-ai/glm-5.3-flash",
    maxGroups: 8,
    // a word matches any address that contains it
    exclude: "mail.google.com,outlook.live.com,outlook.office.com,web.whatsapp.com,web.telegram.org,accounts.google.com,paypal,bank,sber,tinkoff,alfabank,vtb,gosuslugi",
  };
  const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
  const TIMEOUT_MS = 60000;

  function readPref(name, fallback) {
    try {
      const prefs = globalThis.Services?.prefs;
      if (!prefs) {
        return fallback;
      }
      switch (prefs.getPrefType(name)) {
        case prefs.PREF_STRING:
          return prefs.getStringPref(name);
        case prefs.PREF_INT:
          return prefs.getIntPref(name);
        case prefs.PREF_BOOL:
          return prefs.getBoolPref(name);
        default:
          return fallback;
      }
    } catch (err) {
      return fallback;
    }
  }

  // ---------- pure helpers (no browser needed: they are tested on their own)
  function isExcluded(host, list) {
    const h = String(host || "").toLowerCase();
    return String(list || "")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .some((word) => h.includes(word.toLowerCase()));
  }

  function cleanLabel(text) {
    return String(text || "")
      .replace(/[\u0000-\u001f"“”<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32)
      .trim();
  }

  // The first emoji of the text, or ""
  function pickEmoji(text) {
    const value = String(text || "").trim();
    if (!value || !/\p{Extended_Pictographic}/u.test(value)) {
      return "";
    }
    try {
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
        if (/\p{Extended_Pictographic}/u.test(segment)) {
          return segment;
        }
      }
    } catch (err) {
      const match = value.match(/\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*/u);
      return match ? match[0] : "";
    }
    return "";
  }

  function emojiSvg(emoji) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="8" y="13" font-size="13" text-anchor="middle">${emoji}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function shortTitle(title) {
    return String(title || "").replace(/\s+/g, " ").trim().slice(0, 90);
  }

  const COLORS = ["blue", "purple", "cyan", "orange", "yellow", "pink", "green", "gray", "red"];

  const SYSTEM_PROMPT = `You sort a person's open browser tabs into groups by topic.
You get a numbered list of tabs ("number. [site] title") and the names of groups that already exist.
Answer with ONLY a JSON object, no other text:
{"groups":[{"name":"Group name","icon":"🚗","color":"blue","tabs":[0,3,5]}]}
Rules:
- Put a tab in an existing group (use its name exactly) when it clearly fits that group.
- Otherwise make a new group only when at least 2 tabs share a topic, task or project.
- A tab that fits nothing is left out. Never force a tab into a group.
- A tab is in at most one group.
- Names are 1-3 words, specific (not "Misc" or "Other"), in the language most of the titles are written in.
- "icon" is ONE emoji that suits the group's topic. "color" is one of: COLORS.
- At most MAX new groups.`;

  function buildMessages(items, folderNames, maxGroups, sendHosts) {
    const lines = items.map((item, i) => (sendHosts ? `${i}. [${item.host}] ${item.title}` : `${i}. ${item.title}`));
    const folders = folderNames.length ? folderNames.map((n) => `- ${n}`).join("\n") : "(none)";
    return [
      { role: "system", content: SYSTEM_PROMPT.replace("MAX", String(maxGroups)).replace("COLORS", COLORS.join(", ")) },
      { role: "user", content: `Existing folders:\n${folders}\n\nTabs:\n${lines.join("\n")}` },
    ];
  }

  // The model's text as a plan: [{ name, existing (the folder's name or null), indices }]
  function parseAnswer(text, count, folderNames, maxGroups) {
    const raw = String(text || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("The model's answer wasn't JSON.");
    }
    let data;
    try {
      data = JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      throw new Error("The model's answer wasn't valid JSON.");
    }
    if (!Array.isArray(data.groups)) {
      throw new Error("The model's answer had no groups.");
    }
    const byLower = new Map(folderNames.map((n) => [n.toLowerCase(), n]));
    const taken = new Set();
    const merged = new Map();
    let fresh = 0;
    for (const group of data.groups) {
      const name = cleanLabel(group?.name);
      if (!name || !Array.isArray(group.tabs)) {
        continue;
      }
      const indices = [];
      for (const value of group.tabs) {
        const i = Number(value);
        if (Number.isInteger(i) && i >= 0 && i < count && !taken.has(i) && !indices.includes(i)) {
          indices.push(i);
        }
      }
      const existing = byLower.get(name.toLowerCase()) || null;
      if (!existing && indices.length < 2) {
        continue;
      }
      if (!indices.length) {
        continue;
      }
      const key = (existing || name).toLowerCase();
      if (!merged.has(key)) {
        if (!existing) {
          if (fresh >= maxGroups) {
            continue;
          }
          fresh++;
        }
        const color = COLORS.includes(String(group.color || "").toLowerCase()) ? String(group.color).toLowerCase() : "";
        merged.set(key, { name: existing || name, existing, icon: pickEmoji(group.icon), color, indices: [] });
      }
      for (const i of indices) {
        taken.add(i);
        merged.get(key).indices.push(i);
      }
    }
    // a new folder that lost tabs to an earlier one may be left with one
    return [...merged.values()].filter((g) => g.existing || g.indices.length >= 2);
  }

  globalThis.__tabSorterHelpers = { isExcluded, cleanLabel, shortTitle, pickEmoji, emojiSvg, buildMessages, parseAnswer, DEFAULTS };

  if (typeof location === "undefined" || location.href !== "chrome://browser/content/browser.xhtml" || window.__tabSorter) {
    return;
  }

  // ---------- the browser side
  const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const log = (...args) => console.log("[Tab Sorter]", ...args);
  let busy = false;

  function toast(text, ms = 3500) {
    try {
      document.getElementById("tabsorter-toast")?.remove();
      const el = document.createElement("div");
      el.id = "tabsorter-toast";
      el.textContent = text;
      document.documentElement.appendChild(el);
      requestAnimationFrame(() => el.setAttribute("show", "true"));
      setTimeout(() => {
        el.removeAttribute("show");
        setTimeout(() => el.remove(), 400);
      }, ms);
    } catch (err) {
      log(text);
    }
  }

  function activeSpace() {
    return window.gZenWorkspaces?.activeWorkspace || null;
  }

  // "groups": Firefox tab groups (like the original Tidy Tabs); "folders": Zen folders
  function currentMode() {
    const wanted = String(readPref(PREFS.mode, "groups"));
    if (wanted === "groups" && typeof gBrowser.addTabGroup === "function") {
      return "groups";
    }
    return "folders";
  }

  function containersInSpace(mode) {
    const element = window.gZenWorkspaces?.activeWorkspaceElement;
    const space = activeSpace();
    const all = mode === "folders" ? [...document.querySelectorAll("zen-folder")] : [...document.querySelectorAll("tab-group:not([split-view-group])")].filter((g) => !g.isZenFolder && g.localName !== "zen-folder");
    return all.filter((group) => {
      if (!group.isConnected || !cleanLabel(group.label)) {
        return false;
      }
      if (element) {
        return element.contains(group);
      }
      return !space || !group.getAttribute("zen-workspace-id") || group.getAttribute("zen-workspace-id") === space;
    });
  }

  function collectTabs() {
    const space = activeSpace();
    const chosen = gBrowser.selectedTabs?.length > 1 ? [...gBrowser.selectedTabs] : [...gBrowser.tabs];
    const exclude = readPref(PREFS.exclude, DEFAULTS.exclude);
    const items = [];
    for (const tab of chosen) {
      if (!tab.isConnected || tab.closing || tab.pinned || tab.hasAttribute("zen-essential") || tab.hasAttribute("zen-empty-tab")) {
        continue;
      }
      if (space && tab.getAttribute("zen-workspace-id") && tab.getAttribute("zen-workspace-id") !== space) {
        continue;
      }
      if (tab.group) {
        continue; // already in a folder, a group or a split
      }
      let url;
      try {
        url = tab.linkedBrowser?.currentURI;
        if (!url || !/^https?$/.test(url.scheme)) {
          continue;
        }
      } catch (err) {
        continue;
      }
      const host = url.host || "";
      if (isExcluded(host, exclude)) {
        continue;
      }
      const title = shortTitle(tab.label || tab.linkedBrowser?.contentTitle);
      if (!title) {
        continue;
      }
      items.push({ tab, host: host.replace(/^www\./, ""), title });
    }
    return items;
  }

  async function ask(messages) {
    const key = String(readPref(PREFS.key, "")).trim();
    if (!key) {
      throw new Error("Add your OpenRouter API key in the mod's settings.");
    }
    const model = String(readPref(PREFS.model, DEFAULTS.model)).trim() || DEFAULTS.model;
    const providers = String(readPref(PREFS.provider, ""))
      .split(/[\s,;]+/)
      .filter(Boolean);
    const body = {
      model,
      temperature: 0.2,
      max_tokens: 2000,
      reasoning: { effort: "low" },
      messages,
    };
    if (providers.length) {
      body.provider = { order: providers, allow_fallbacks: true };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "X-Title": "OpenRouter Tab Sorter",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        let reason = "";
        try {
          reason = (await response.json())?.error?.message || "";
        } catch (err) {}
        if (response.status === 401) {
          throw new Error("OpenRouter rejected the API key.");
        }
        throw new Error(`OpenRouter error ${response.status}${reason ? `: ${String(reason).slice(0, 160)}` : ""}`);
      }
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error("OpenRouter took too long.");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function setBusy(on) {
    busy = on;
    for (const button of document.querySelectorAll(".tabsorter-button")) {
      button.toggleAttribute("busy", on);
    }
  }

  // The model's emoji as the group's icon: a Zen folder's icon, or Advanced
  // Tab Groups' icon when that mod is there; else the emoji leads the name
  function applyIcon(container, emoji, name) {
    if (!emoji || !container) {
      return;
    }
    try {
      if (container.localName === "zen-folder" && window.gZenFolders?.setFolderUserIcon) {
        window.gZenFolders.setFolderUserIcon(container, emojiSvg(emoji));
        container.dispatchEvent(new CustomEvent("TabGroupUpdate", { bubbles: true }));
        if (container.iconURL) {
          return;
        }
      } else if (window.advancedTabGroups?.applyGroupIcon) {
        window.advancedTabGroups.applyGroupIcon(container, emoji);
        return;
      }
    } catch (err) {
      console.warn("[Tab Sorter] Couldn't set the icon:", err);
    }
    try {
      container.label = `${emoji} ${name}`;
    } catch (err) {}
  }

  async function sortTabs() {
    if (busy) {
      return;
    }
    if (window.PrivateBrowsingUtils?.isWindowPrivate(window)) {
      toast("Tab Sorter does nothing in private windows.");
      return;
    }
    const mode = currentMode();
    if (mode === "folders" && !window.gZenFolders?.createFolder) {
      toast("This Zen has no folders to sort into.");
      return;
    }
    const items = collectTabs();
    if (items.length < 3) {
      toast("Not enough loose tabs to sort.");
      return;
    }
    setBusy(true);
    toast("Sorting tabs…", 60000);
    try {
      const existing = containersInSpace(mode);
      const names = [...new Set(existing.map((g) => cleanLabel(g.label)))];
      const maxGroups = Math.max(1, parseInt(readPref(PREFS.maxGroups, DEFAULTS.maxGroups), 10) || DEFAULTS.maxGroups);
      const sendHosts = readPref(PREFS.sendHosts, true) !== false;
      const useIcons = readPref(PREFS.icons, true) !== false;
      const text = await ask(buildMessages(items, names, maxGroups, sendHosts));
      const plan = parseAnswer(text, items.length, names, maxGroups);
      if (!plan.length) {
        toast("The model found nothing worth grouping.");
        return;
      }
      const space = activeSpace() || undefined;
      let moved = 0;
      let made = 0;
      for (const group of plan) {
        const tabs = group.indices.map((i) => items[i].tab).filter((tab) => tab.isConnected && !tab.group && !tab.pinned);
        if (!tabs.length) {
          continue;
        }
        try {
          const target = group.existing ? existing.find((g) => cleanLabel(g.label) === group.existing) : null;
          if (target?.isConnected) {
            target.addTabs(tabs);
          } else {
            let created;
            if (mode === "groups") {
              created = gBrowser.addTabGroup(tabs, { label: group.name, color: group.color || undefined, insertBefore: tabs[0] });
            } else {
              created = window.gZenFolders.createFolder(tabs, { label: group.name, workspaceId: space });
              created = created?.localName === "zen-folder" ? created : tabs[0]?.group;
            }
            made++;
            if (useIcons) {
              applyIcon(created || tabs[0]?.group, group.icon, group.name);
            }
          }
          moved += tabs.length;
        } catch (err) {
          console.warn("[Tab Sorter] Couldn't fill", group.name, err);
        }
      }
      const noun = mode === "groups" ? "group" : "folder";
      toast(moved ? `Sorted ${moved} tabs (${made} new ${noun}${made === 1 ? "" : "s"}).` : "Nothing was moved.");
    } catch (err) {
      console.warn("[Tab Sorter]", err);
      toast(err?.message || String(err), 6000);
    } finally {
      setBusy(false);
    }
  }

  // ---------- where you start it
  const SPARKLES =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='context-fill'%3E%3Cpath d='M6.2 2.2l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1z'/%3E%3Cpath d='M12 8.6l.6 1.7 1.7.6-1.7.6L12 13.2l-.6-1.7-1.7-.6 1.7-.6z'/%3E%3Cpath d='M12.3 1.8l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4z'/%3E%3C/svg%3E";

  // Each space has a line between its pinned and loose tabs (with Zen's "Clear"
  // on it): the button sits there, just before "Clear"
  function placeButtons() {
    if (readPref(PREFS.button, true) === false) {
      document.querySelectorAll(".tabsorter-button").forEach((b) => b.remove());
      return;
    }
    const lines = document.querySelectorAll(".pinned-tabs-container-separator");
    for (const line of lines) {
      if (line.querySelector(".tabsorter-button")) {
        continue;
      }
      const button = document.createXULElement("toolbarbutton");
      button.className = "tabsorter-button";
      button.setAttribute("tooltiptext", "Sort tabs into groups (AI)");
      button.addEventListener("command", sortTabs);
      button.addEventListener("click", (event) => {
        if (event.button === 0) {
          event.stopPropagation();
        }
      });
      const clear = line.querySelector(".zen-workspace-close-unpinned-tabs-button, #zen-workspaces-close-unpinned-tabs-button, [class*='close-unpinned'], [class*='clear']");
      if (clear && clear.parentNode) {
        clear.parentNode.insertBefore(button, clear);
      } else {
        line.appendChild(button);
      }
    }
  }

  function watchButtons() {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(placeButtons, 400);
    };
    new MutationObserver(schedule).observe(document.getElementById("browser") || document.documentElement, { childList: true, subtree: true });
    placeButtons();
    gBrowser.tabContainer.addEventListener("TabSelect", schedule);
    window.addEventListener("ZenWorkspaceChanged", schedule);
  }

  function addMenuItem(attempt = 0) {
    const menu = document.getElementById("tabContextMenu");
    if (!menu) {
      if (attempt < 40) {
        setTimeout(() => addMenuItem(attempt + 1), 500);
      }
      return;
    }
    if (document.getElementById("tabsorter-menuitem")) {
      return;
    }
    const item = document.createXULElement("menuitem");
    item.id = "tabsorter-menuitem";
    item.setAttribute("label", "Sort tabs into groups (AI)");
    item.addEventListener("command", sortTabs);
    const anchor = document.getElementById("context_duplicateTab") || document.getElementById("context_reloadTab");
    if (anchor?.parentNode) {
      anchor.parentNode.insertBefore(item, anchor.nextSibling);
    } else {
      menu.appendChild(item);
    }
  }

  function addShortcut() {
    window.addEventListener(
      "keydown",
      (event) => {
        if (readPref(PREFS.shortcut, true) === false) {
          return;
        }
        if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyG") {
          event.preventDefault();
          sortTabs();
        }
      },
      true
    );
  }

  window.__tabSorter = { sort: sortTabs, collectTabs, place: placeButtons, version: "1.1.0" };
  document.documentElement.style.setProperty("--tabsorter-icon", `url("${SPARKLES}")`);
  setTimeout(watchButtons, 1500);
  addMenuItem();
  addShortcut();
  log("ready (Alt+Shift+G, tab menu or the button next to Clear)");
})();
