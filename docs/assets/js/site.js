/* Bridlewise docs — theme and navigation. No dependencies, no network. */
(function () {
  "use strict";

  // The page leads in Logbook (paper): no attribute. Carbon is the one
  // explicit choice, remembered per viewer. The ground the browser paints
  // around the page is read from the live token, never restated here.
  // A moved page names its new place; follow it (the visible link stays for
  // a reader without scripts).
  var moved = document.querySelector("[data-moved-to]");
  if (moved) {
    location.replace(moved.getAttribute("data-moved-to"));
    return;
  }

  var root = document.documentElement;
  var themeButton = document.querySelector("[data-theme-toggle]");
  var themeLabel = document.querySelector("[data-theme-label]");
  var themeMeta = document.querySelector('meta[name="theme-color"]');

  function currentTheme() {
    return root.dataset.theme === "carbon" ? "carbon" : "logbook";
  }

  function paintThemeControls() {
    var dark = currentTheme() === "carbon";
    if (themeLabel) themeLabel.textContent = dark ? "Light" : "Dark";
    if (themeButton) themeButton.setAttribute("aria-label", dark ? "Use the light theme" : "Use the dark theme");
    if (themeMeta) themeMeta.setAttribute("content", getComputedStyle(root).getPropertyValue("--ground-0").trim());
  }

  function setTheme(theme) {
    if (theme === "carbon") root.dataset.theme = "carbon";
    else delete root.dataset.theme;
    try {
      if (theme === "carbon") localStorage.setItem("bridlewise-theme", "carbon");
      else localStorage.removeItem("bridlewise-theme");
    } catch (error) {}
    paintThemeControls();
  }

  if (themeButton) {
    paintThemeControls();
    themeButton.addEventListener("click", function () {
      setTheme(currentTheme() === "carbon" ? "logbook" : "carbon");
    });
  }

  // The phone menu is a <details>: Escape closes it and returns focus.
  var menu = document.querySelector(".site-menu");
  if (menu) {
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && menu.open) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
    });
  }

  // Each section of a reading page gets a link to itself, for citing a
  // part of a page. The heading's own text names it for assistive tech.
  var headings = document.querySelectorAll(".doc h2[id], .doc h3[id]");
  for (var h = 0; h < headings.length; h += 1) {
    var link = document.createElement("a");
    link.className = "heading-anchor";
    link.href = "#" + headings[h].id;
    link.textContent = "#";
    link.setAttribute("aria-label", "Link to the section " + headings[h].textContent.trim());
    headings[h].appendChild(link);
  }

  // GitHub renders `> [!WARNING]` as an alert; Jekyll does not. Strip the
  // marker from the first text node and tag the blockquote so the static site
  // keeps the same intent as the Markdown on GitHub.
  var article = document.querySelector("main");
  if (article) {
    var quotes = article.querySelectorAll("blockquote");
    for (var q = 0; q < quotes.length; q += 1) {
      var firstParagraph = quotes[q].querySelector("p");
      if (!firstParagraph) continue;
      var walker = document.createTreeWalker(firstParagraph, NodeFilter.SHOW_TEXT, null);
      var node = walker.nextNode();
      if (!node) continue;
      var match = node.nodeValue.match(/^\[!(WARNING|NOTE|TIP|IMPORTANT|CAUTION)\]\s*/);
      if (!match) continue;
      node.nodeValue = node.nodeValue.slice(match[0].length);
      quotes[q].className += " callout callout-" + match[1].toLowerCase();
    }
  }

})();

/* Command-palette search over the static page index. No network beyond the
   site's own /search.json; no dependencies, no tracking. */
(function () {
  "use strict";

  var dialog = document.querySelector("[data-search-dialog]");
  if (!dialog || typeof dialog.showModal !== "function") return;
  var input = dialog.querySelector("[data-search-input]");
  var status = dialog.querySelector("[data-search-status]");
  var list = dialog.querySelector("[data-search-results]");
  var openers = document.querySelectorAll("[data-search-open]");
  var index = null;
  var loading = false;
  var filtered = [];
  var active = 0;

  function isTyping(target) {
    if (!target) return false;
    var tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  function loadIndex() {
    if (index !== null || loading) return Promise.resolve(index);
    loading = true;
    return fetch(dialog.dataset.searchUrl, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("search index unavailable");
        return response.json();
      })
      .then(function (data) {
        index = Array.isArray(data) ? data : [];
        return index;
      })
      .catch(function () {
        index = [];
        return index;
      })
      .finally(function () {
        loading = false;
      });
  }

  function render() {
    var query = input.value.trim().toLowerCase();
    var source = index || [];
    if (query.length === 0) {
      filtered = source.slice(0, 8);
    } else {
      filtered = source.filter(function (entry) {
        return (entry.title + " " + (entry.description || "")).toLowerCase().indexOf(query) !== -1;
      }).slice(0, 20);
    }
    active = 0;
    list.textContent = "";
    if (filtered.length === 0) {
      status.textContent = source.length === 0 ? "The index is unavailable. Use the footer links." : "No match in the record. Try a broader word.";
      return;
    }
    status.textContent = query.length === 0
      ? "Start with these pages, or type to search " + source.length + " entries."
      : filtered.length + " match" + (filtered.length === 1 ? "" : "es") + " in the record.";
    filtered.forEach(function (entry, position) {
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = entry.url;
      link.className = "search-result";
      link.dataset.index = String(position);
      var title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = entry.title;
      var description = document.createElement("span");
      description.className = "search-result-description";
      description.textContent = entry.description || entry.url;
      link.appendChild(title);
      link.appendChild(description);
      item.appendChild(link);
      list.appendChild(item);
    });
    paintActive();
  }

  function paintActive() {
    var links = list.querySelectorAll(".search-result");
    for (var i = 0; i < links.length; i += 1) {
      var selected = i === active;
      links[i].classList.toggle("is-active", selected);
      links[i].setAttribute("aria-selected", selected ? "true" : "false");
    }
    if (links[active]) links[active].scrollIntoView({ block: "nearest" });
  }

  function open() {
    if (dialog.open) return;
    dialog.showModal();
    document.body.classList.add("search-open");
    loadIndex().then(render);
    input.value = "";
    input.focus();
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    document.body.classList.remove("search-open");
  }

  for (var i = 0; i < openers.length; i += 1) openers[i].addEventListener("click", open);
  dialog.querySelector("[data-search-close]").addEventListener("click", close);
  dialog.addEventListener("cancel", function () { document.body.classList.remove("search-open"); });
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) close();
  });
  input.addEventListener("input", render);
  input.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
      paintActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      paintActive();
    } else if (event.key === "Enter" && filtered[active]) {
      event.preventDefault();
      window.location.href = filtered[active].url;
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "/" && !isTyping(event.target)) {
      event.preventDefault();
      open();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
    }
  });
})();

/* Copy buttons on code blocks. Progressive enhancement: the code remains
   selectable and readable if the Clipboard API is unavailable. */
(function () {
  "use strict";
  var blocks = document.querySelectorAll("pre");
  if (!blocks.length) return;
  for (var i = 0; i < blocks.length; i += 1) {
    (function (pre) {
      var code = pre.querySelector("code");
      if (!code) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code to clipboard");
      button.addEventListener("click", function () {
        var text = code.innerText;
        var done = function () {
          button.textContent = "Copied";
          button.classList.add("is-copied");
          window.setTimeout(function () {
            button.textContent = "Copy";
            button.classList.remove("is-copied");
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { button.textContent = "Select"; });
        } else {
          var range = document.createRange();
          range.selectNodeContents(code);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          button.textContent = "Select";
        }
      });
      pre.appendChild(button);
    })(blocks[i]);
  }
})();
