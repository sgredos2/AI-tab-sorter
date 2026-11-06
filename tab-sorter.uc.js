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

  function shortTitle(title) {
    return String(title || "").replace(/\s+/g, " ").trim().slice(0, 90);
  }

  const SYSTEM_PROMPT = `You sort a person's open browser tabs into folders by topic.
You get a numbered list of tabs ("number. [site] title") and the names of folders that already exist.
Answer with ONLY a JSON object, no other text:
{"groups":[{"name":"Folder name","tabs":[0,3,5]}]}
Rules:
- Put a tab in an existing folder (use its name exactly) when it clearly fits that folder.
- Otherwise make a new folder only when at least 2 tabs share a topic, task or project.
- A tab that fits nothing is left out. Never force a tab into a folder.
- A tab is in at most one folder.
- Names are 1-3 words, specific (not "Misc" or "Other"), in the language most of the titles are written in.
- At most MAX new folders.`;

  function buildMessages(items, folderNames, maxGroups, sendHosts) {
    const lines = items.map((item, i) => (sendHosts ? `${i}. [${item.host}] ${item.title}` : `${i}. ${item.title}`));
    const folders = folderNames.length ? folderNames.map((n) => `- ${n}`).join("\n") : "(none)";
    return [
      { role: "system", content: SYSTEM_PROMPT.replace("MAX", String(maxGroups)) },
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
        merged.set(key, { name: existing || name, existing, indices: [] });
      }
      for (const i of indices) {
        taken.add(i);
        merged.get(key).indices.push(i);
      }
    }
    // a new folder that lost tabs to an earlier one may be left with one
    return [...merged.values()].filter((g) => g.existing || g.indices.length >= 2);
  }

  globalThis.__tabSorterHelpers = { isExcluded, cleanLabel, shortTitle, buildMessages, parseAnswer, DEFAULTS };

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

  function foldersInSpace() {
    const element = window.gZenWorkspaces?.activeWorkspaceElement;
    const space = activeSpace();
    return [...document.querySelectorAll("zen-folder")].filter((folder) => {
      if (!folder.isConnected || !cleanLabel(folder.label)) {
        return false;
      }
      if (element) {
        return element.contains(folder);
      }
      return !space || !folder.getAttribute("zen-workspace-id") || folder.getAttribute("zen-workspace-id") === space;
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
    document.getElementById("tabsorter-button")?.toggleAttribute("busy", on);
  }

  async function sortTabs() {
    if (busy) {
      return;
    }
    if (window.PrivateBrowsingUtils?.isWindowPrivate(window)) {
      toast("Tab Sorter does nothing in private windows.");
      return;
    }
    if (!window.gZenFolders?.createFolder) {
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
      const folders = foldersInSpace();
      const names = [...new Set(folders.map((f) => cleanLabel(f.label)))];
      const maxGroups = Math.max(1, parseInt(readPref(PREFS.maxGroups, DEFAULTS.maxGroups), 10) || DEFAULTS.maxGroups);
      const sendHosts = readPref(PREFS.sendHosts, true) !== false;
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
          const folder = group.existing ? folders.find((f) => cleanLabel(f.label) === group.existing) : null;
          if (folder?.isConnected) {
            folder.addTabs(tabs);
          } else {
            window.gZenFolders.createFolder(tabs, { label: group.name, workspaceId: space });
            made++;
          }
          moved += tabs.length;
        } catch (err) {
          console.warn("[Tab Sorter] Couldn't fill", group.name, err);
        }
      }
      toast(moved ? `Sorted ${moved} tabs (${made} new folder${made === 1 ? "" : "s"}).` : "Nothing was moved.");
    } catch (err) {
      console.warn("[Tab Sorter]", err);
      toast(err?.message || String(err), 6000);
    } finally {
      setBusy(false);
    }
  }

  // ---------- where you start it
  // (the sidebar's bottom bar is built after this script runs, so wait for it)
  function addButton(attempt = 0) {
    if (readPref(PREFS.button, true) === false) {
      document.getElementById("tabsorter-button")?.remove();
      return;
    }
    if (document.getElementById("tabsorter-button")) {
      return;
    }
    const foot =
      document.getElementById("zen-sidebar-foot-buttons") ||
      (attempt >= 40 ? document.getElementById("zen-sidebar-top-buttons") || document.getElementById("nav-bar") : null);
    if (!foot) {
      if (attempt < 80) {
        setTimeout(() => addButton(attempt + 1), 500);
      } else {
        log("couldn't find a place for the button; use Alt+Shift+G or the tab menu");
      }
      return;
    }
    const button = document.createXULElement("toolbarbutton");
    button.id = "tabsorter-button";
    button.className = "toolbarbutton-1";
    button.setAttribute("tooltiptext", "Sort tabs into folders (AI)");
    button.addEventListener("command", sortTabs);
    foot.appendChild(button);
    log("button added to", foot.id);
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
    item.setAttribute("label", "Sort tabs into folders (AI)");
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

  window.__tabSorter = { sort: sortTabs, collectTabs, version: "1.0.1" };
  addButton();
  addMenuItem();
  addShortcut();
  log("ready (Alt+Shift+G, tab menu or the sidebar button)");
})();
