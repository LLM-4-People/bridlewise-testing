(function () {
  "use strict";

  var DAY = 24 * 60 * 60 * 1000;

  function text(node, value) {
    if (!node) return;
    node.textContent = value === null || value === undefined || value === "" ? "unknown" : String(value);
  }

  function show(root, prefix, name) {
    var states = root.querySelectorAll("[" + prefix + "-state]");
    for (var i = 0; i < states.length; i += 1) {
      states[i].hidden = states[i].getAttribute(prefix + "-state") !== name;
    }
    if (name !== "loading") root.setAttribute("aria-busy", "false");
  }

  function iso(value) {
    if (!value) return "unknown";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "unknown";
    return date.toISOString().replace("T", " ").replace(".000Z", "Z");
  }

  function duration(value) {
    if (typeof value !== "number" || value < 0) return "unknown";
    if (value < 1000) return value + " ms";
    return Math.round(value / 100) / 10 + " s";
  }

  function safeUrl(value) {
    if (typeof value !== "string") return null;
    try {
      var url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    } catch (error) {
      return null;
    }
  }

  function link(value, label) {
    var url = safeUrl(value);
    if (!url) return document.createTextNode(label || "unknown");
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.textContent = label || url;
    anchor.rel = "noreferrer";
    return anchor;
  }

  function stale(generatedAt, buildTime) {
    var generated = Date.parse(generatedAt);
    var built = Date.parse(buildTime || "");
    if (!Number.isFinite(generated)) return false;
    var reference = Number.isFinite(built) ? Math.max(built, Date.now()) : Date.now();
    return reference - generated > DAY;
  }

  async function fetchJson(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 8000);
    try {
      var response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function pill(value) {
    var node = document.createElement("span");
    node.className = "floor-pill";
    node.setAttribute("data-state", String(value || "unknown"));
    node.textContent = String(value || "unknown");
    return node;
  }

  function addCell(row, child) {
    var cell = document.createElement("td");
    if (typeof child === "string") cell.textContent = child;
    else cell.appendChild(child);
    row.appendChild(cell);
    return cell;
  }

  async function initStatus() {
    var root = document.querySelector("[data-floor-status]");
    if (!root) return;
    var source = root.getAttribute("data-status-src");
    try {
      var data = await fetchJson(source);
      if (data.schemaVersion !== "bridlewise-floor-status/v1") {
        throw new Error("unsupported schema");
      }
      show(root, "data-status", "ready");
      text(root.querySelector("[data-status-generated]"), iso(data.generatedAt));
      var sourceNode = root.querySelector("[data-status-source]");
      if (sourceNode) {
        sourceNode.textContent = "";
        sourceNode.appendChild(link("https://github.com/" + data.source.repository + "/commit/" + data.source.commit, data.source.commit || "unknown"));
      }
      var productNode = root.querySelector("[data-status-product]");
      if (productNode) {
        productNode.textContent = "";
        productNode.appendChild(link("https://github.com/" + data.product.repository + "/commit/" + data.product.commit, data.product.commit || "unknown"));
      }
      text(root.querySelector("[data-status-promotion-state]"), data.promotion?.state);
      text(
        root.querySelector("[data-status-promotion-code]"),
        data.promotion?.lastRun?.code || data.promotion?.reason,
      );
      text(
        root.querySelector("[data-status-pending]"),
        data.promotion?.pending?.commits === null || data.promotion?.pending?.commits === undefined
          ? "not observed"
          : data.promotion.pending.commits,
      );
      text(
        root.querySelector("[data-status-hold]"),
        data.promotion?.hold?.reason || "none recorded",
      );

      var fallback = root.querySelector("[data-status-fallback]");
      if (fallback) {
        fallback.hidden = Boolean(data.github?.available);
        fallback.textContent = data.github?.available
          ? ""
          : "GitHub API data was not available at generation time: " +
            (data.github?.reason || "unknown") +
            ". CI state is unknown.";
      }
      var staleNode = root.querySelector("[data-status-stale]");
      if (staleNode) {
        staleNode.hidden = !stale(data.generatedAt, root.getAttribute("data-status-build-time"));
      }
      text(root.querySelector("[data-status-github-checked]"), iso(data.github?.checkedAt));

      var checksBody = root.querySelector("[data-status-checks]");
      var checksEmpty = root.querySelector("[data-status-checks-empty]");
      if (checksBody) {
        checksBody.textContent = "";
        var checks = Array.isArray(data.checks) ? data.checks : [];
        if (checksEmpty) checksEmpty.hidden = checks.length > 0;
        for (var i = 0; i < checks.length; i += 1) {
          var check = checks[i];
          var row = document.createElement("tr");
          addCell(row, check.label || check.id || "unknown");
          addCell(row, pill(check.status));
          addCell(row, duration(check.durationMs));
          checksBody.appendChild(row);
        }
      }

      var runsBody = root.querySelector("[data-status-runs]");
      var runsEmpty = root.querySelector("[data-status-ci-empty]");
      if (runsBody) {
        runsBody.textContent = "";
        var runs = Array.isArray(data.github?.runs) ? data.github.runs : [];
        if (runsEmpty) runsEmpty.hidden = runs.length > 0;
        for (var j = 0; j < runs.length; j += 1) {
          var run = runs[j];
          var runRow = document.createElement("tr");
          addCell(runRow, run.repository || "unknown");
          addCell(runRow, run.workflow || "unknown");
          addCell(runRow, pill(run.conclusion || run.status));
          var commitCell = document.createElement("td");
          commitCell.appendChild(link(run.url, run.headSha ? run.headSha.slice(0, 7) : "unknown"));
          runRow.appendChild(commitCell);
          runsBody.appendChild(runRow);
        }
      }
    } catch (error) {
      show(root, "data-status", "error");
    }
  }

  function entryRows(data) {
    var rows = [];
    for (var i = 0; i < data.tests.length; i += 1) {
      var test = data.tests[i];
      rows.push({
        kind: "test",
        title: test.path,
        group: test.category,
        state: test.disposition,
        url: test.url,
        search: [test.path, test.category, test.disposition].join(" ").toLowerCase(),
      });
    }
    for (var j = 0; j < data.guards.length; j += 1) {
      var guard = data.guards[j];
      rows.push({
        kind: "guard",
        title: guard.name,
        group: guard.surface + " guard",
        state: guard.complete ? "complete" : "incomplete",
        url: guard.url,
        search: [guard.name, guard.path, guard.surface, guard.failureClass].join(" ").toLowerCase(),
      });
    }
    for (var k = 0; k < data.decisions.length; k += 1) {
      var decision = data.decisions[k];
      rows.push({
        kind: "decision",
        title: decision.id,
        group: decision.group || "decision",
        state: decision.status + (decision.implementation ? " / " + decision.implementation : ""),
        url: decision.url,
        search: [decision.id, decision.title, decision.path, decision.group, decision.status, decision.implementation].join(" ").toLowerCase(),
      });
    }
    rows.sort(function (left, right) {
      return (left.kind + ":" + left.group + ":" + left.title).localeCompare(
        right.kind + ":" + right.group + ":" + right.title,
      );
    });
    return rows;
  }

  function initAtlas() {
    var root = document.querySelector("[data-floor-atlas]");
    if (!root) return;
    var source = root.getAttribute("data-atlas-src");
    var controls = {
      search: root.querySelector("[data-atlas-search]"),
      kind: root.querySelector("[data-atlas-kind]"),
      category: root.querySelector("[data-atlas-category]"),
      disposition: root.querySelector("[data-atlas-disposition]"),
      guardState: root.querySelector("[data-atlas-guard-state]"),
      decisionState: root.querySelector("[data-atlas-decision-state]"),
      reset: root.querySelector("[data-atlas-reset]"),
    };
    var body = root.querySelector("[data-atlas-rows]");
    var countNode = root.querySelector("[data-atlas-count]");
    var noMatches = root.querySelector("[data-atlas-no-matches]");
    var allRows = [];

    function rowMatches(row) {
      if (controls.kind && controls.kind.value && row.kind !== controls.kind.value) return false;
      if (controls.search && controls.search.value) {
        var query = controls.search.value.trim().toLowerCase();
        if (query && row.search.indexOf(query) < 0) return false;
      }
      if (row.kind === "test") {
        if (controls.category && controls.category.value && row.group !== controls.category.value) return false;
        if (controls.disposition && controls.disposition.value && row.state !== controls.disposition.value) return false;
      }
      if (row.kind === "guard" && controls.guardState && controls.guardState.value && row.state !== controls.guardState.value) {
        return false;
      }
      if (row.kind === "decision" && controls.decisionState && controls.decisionState.value) {
        if (row.state.indexOf(controls.decisionState.value) < 0) return false;
      }
      return true;
    }

    function render() {
      var matches = allRows.filter(rowMatches);
      body.textContent = "";
      if (noMatches) noMatches.hidden = matches.length > 0;
      text(
        countNode,
        matches.length + " of " + allRows.length + " entries. One row is an inventory entry, not a passing test.",
      );
      for (var i = 0; i < matches.length; i += 1) {
        var entry = matches[i];
        var row = document.createElement("tr");
        addCell(row, link(entry.url, entry.title));
        addCell(row, entry.kind);
        addCell(row, entry.group || "unknown");
        addCell(row, pill(entry.state));
        var evidence = document.createElement("td");
        evidence.appendChild(link(entry.url, "source"));
        row.appendChild(evidence);
        body.appendChild(row);
      }
    }

    Promise.resolve()
      .then(function () { return fetchJson(source); })
      .then(function (data) {
        if (data.schemaVersion !== "bridlewise-floor-atlas/v1") throw new Error("unsupported schema");
        if (!Array.isArray(data.tests) || !Array.isArray(data.guards) || !Array.isArray(data.decisions)) {
          throw new Error("missing arrays");
        }
        show(root, "data-atlas", "ready");
        text(root.querySelector("[data-atlas-generated]"), iso(data.generatedAt));
        text(root.querySelector("[data-atlas-source]"), data.source?.commit?.slice(0, 7));
        text(
          root.querySelector("[data-atlas-counts]"),
          (data.counts?.testSources ?? "unknown") +
            " test surface rows, " +
            (data.counts?.testNames ?? "unknown") +
            " inventoried test names, " +
            (data.counts?.guards ?? "unknown") +
            " guards, " +
            (data.counts?.decisions ?? "unknown") +
            " decisions.",
        );
        var staleNode = root.querySelector("[data-atlas-stale]");
        if (staleNode) staleNode.hidden = !stale(data.generatedAt, root.getAttribute("data-atlas-build-time"));
        allRows = entryRows(data);
        if (!allRows.length) { show(root, "data-atlas", "empty"); return; }
        if (controls.search) controls.search.addEventListener("input", render);
        ["kind", "category", "disposition", "guardState", "decisionState"].forEach(function (key) {
          if (controls[key]) controls[key].addEventListener("change", render);
        });
        if (controls.reset) {
          controls.reset.addEventListener("click", function () {
            if (controls.search) controls.search.value = "";
            ["kind", "category", "disposition", "guardState", "decisionState"].forEach(function (key) {
              if (controls[key]) controls[key].value = "";
            });
            render();
          });
        }
        render();
      })
      .catch(function () { show(root, "data-atlas", "error"); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initStatus();
      initAtlas();
    });
  } else {
    initStatus();
    initAtlas();
  }
})();
