/* Inflation keeps switching sides — v8
   Rebuilt around ONE map that geometrically zooms, and a story rail that
   never sits on top of the visuals. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- helpers
  var MAP_W = 900, MAP_H = 760;
  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var dur = function (ms) { return reduceMotion ? 0 : ms; };

  // "" , undefined, "  ", "n/a" -> null. The old build did `+d.gap` on
  // undefined and silently produced NaN (Chandigarh), which then crashed
  // the tooltips and the dot plot.
  function num(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim();
    if (s === "") return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function fmt(v, suffix) {
    return v === null ? "—" : v.toFixed(2) + (suffix || "");
  }
  function signed(v, suffix) {
    return v === null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + (suffix || "");
  }
  function byId(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ state
  var steps = [].slice.call(document.querySelectorAll(".step"));
  var stage = byId("visualStage");
  var mapScene = document.querySelector(".scene-map");
  var currentStep = null;

  var states = [], stateByName = {}, history = [], combined = [], switches = [], periods = {};
  var geoFeatures = [], featureByName = {};
  var projection, path, mapG, mapReady = false;

  var SHORT_NAME = {
    "Andaman and Nicobar Islands": "Andaman & Nicobar",
    "The Dadra And Nagar Haveli And Daman And Diu": "Dadra & Nagar Haveli and Daman & Diu",
    "NCT of Delhi": "Delhi"
  };
  // shorter still, for the cramped y-axis of the dot plot
  var CHART_LABEL = {
    "Andaman and Nicobar Islands": "Andaman & Nicobar",
    "The Dadra And Nagar Haveli And Daman And Diu": "Dadra & N. Haveli, Daman & Diu",
    "NCT of Delhi": "Delhi",
    "Jammu and Kashmir": "Jammu & Kashmir"
  };

  var mapMode = null;        // "combined" | "gap"
  var mapFocus = undefined;  // state name, or null for whole India
  var drawn = {};            // charts render once
  var userPeriod = null;     // a clicked basket period survives scrolling

  // ------------------------------------------------------------------ scenes
  var scenes = [].slice.call(document.querySelectorAll(".visual-scene"));
  function showScene(id) {
    stage.classList.toggle("full-visual", id === "combined-history");
    scenes.forEach(function (n) {
      n.classList.toggle("active", n.getAttribute("data-visual") === id);
    });
  }

  // --------------------------------------------------------------- data load
  function csv(url, cb) {
    d3.csv(url, function (err, data) { cb(err, data || []); });
  }

  csv("data/inflation_2026.csv", function (err, data) {
    if (err) { mapError("Could not load data/inflation_2026.csv"); return; }
    states = data.map(function (d) {
      return {
        state: d["State/UT"],
        rural: num(d["Inflation Rural (%)"]),
        urban: num(d["Inflation Urban (%)"]),
        combined: num(d["Inflation Combined (%)"]),
        gap: num(d.gap)
      };
    });
    states.forEach(function (d) { stateByName[d.state] = d; });
    fillDerivedNumbers();
    loadGeo();
  });

  csv("data/history_2014_2025.csv", function (err, data) {
    if (err) return;
    history = data.map(function (d) {
      return { year: num(d.year), gap: num(d.gap), rural: num(d.rural), urban: num(d.urban) };
    }).filter(function (d) { return d.year !== null && d.gap !== null; });
    if (currentStep && currentStep.dataset.visual === "annual-gap") render(currentStep);
  });

  csv("data/annual_combined_2014_2025.csv", function (err, data) {
    if (err) return;
    combined = data.map(function (d) { return { year: num(d.year), value: num(d.combined) }; })
      .filter(function (d) { return d.year !== null && d.value !== null; });
    if (currentStep && currentStep.dataset.visual === "combined-history") render(currentStep);
  });

  csv("data/switches.csv", function (err, data) {
    if (err) return;
    switches = data.map(function (d) {
      return { date: d.date, rural: num(d.rural), urban: num(d.urban), gap: num(d.gap), leader: d.leader };
    }).filter(function (d) { return d.date && d.gap !== null; });
    byId("switchCount").textContent = switches.length;
    if (currentStep && currentStep.dataset.visual === "switches") render(currentStep);
  });

  d3.json("data/decomposition.json", function (err, data) {
    if (!err && data) {
      periods = data;
      if (currentStep && currentStep.dataset.visual === "basket") render(currentStep);
    }
  });

  // Averages, the 27/7/1 split and the switch count are now computed from the
  // data instead of being typed into the HTML, so they cannot drift.
  function fillDerivedNumbers() {
    var comp = states.filter(function (d) {
      return d.gap !== null && d.rural !== null && d.urban !== null;
    });
    if (!comp.length) return;
    var mean = function (k) {
      return comp.reduce(function (s, d) { return s + d[k]; }, 0) / comp.length;
    };
    var r = mean("rural"), u = mean("urban"), g = mean("gap");
    var maxBar = Math.max(r, u);
    byId("avgRural").textContent = r.toFixed(2) + "%";
    byId("avgUrban").textContent = u.toFixed(2) + "%";
    byId("avgGap").textContent = g.toFixed(2);
    byId("avgRuralCopy").textContent = r.toFixed(2) + "%";
    byId("avgUrbanCopy").textContent = u.toFixed(2) + "%";
    byId("avgRuralBar").dataset.w = (r / maxBar * 92).toFixed(1) + "%";
    byId("avgUrbanBar").dataset.w = (u / maxBar * 92).toFixed(1) + "%";
    byId("endRural").textContent = comp.filter(function (d) { return d.gap > 0; }).length;
    byId("endUrban").textContent = comp.filter(function (d) { return d.gap < 0; }).length;
    byId("endEqual").textContent = comp.filter(function (d) { return d.gap === 0; }).length;
    document.querySelector(".scene-average .average-label").textContent =
      "ACROSS " + comp.length + " COMPARABLE STATES & UTs";
  }

  function mapError(msg) {
    var el = byId("mapStatus");
    el.classList.remove("hidden");
    el.classList.add("error");
    el.textContent = msg + " — run the page through serve.py (python3 serve.py) rather than opening index.html directly, or the browser will block the local files.";
  }

  // ------------------------------------------------------------------- map
  function stateName(f) {
    var p = f.properties || {};
    return p.ST_NM || p.st_nm || p.NAME_1 || p.NAME || p.name || "";
  }

  function loadGeo() {
    // Bundled locally: the old build pulled a remote 2011-vintage GeoJSON that
    // had no Andaman & Nicobar and no Ladakh, and spelled five states
    // differently from the CSV, so those states never coloured in and the
    // Andaman zoom step silently did nothing.
   d3.json("india-states.geojson", function(err, geo) {
      if (err || !geo || !geo.features) { mapError("Could not load data/india-states.geojson"); return; }
      geoFeatures = geo.features;
      geoFeatures.forEach(function (f) { featureByName[stateName(f)] = f; });

      projection = d3.geo.mercator().scale(1000).center([82.5, 22]).translate([MAP_W / 2, MAP_H / 2]);
      path = d3.geo.path().projection(projection);

      // fit to the viewBox
      var b = path.bounds(geo);
      var s = 0.94 / Math.max((b[1][0] - b[0][0]) / MAP_W, (b[1][1] - b[0][1]) / MAP_H);
      projection.scale(1000 * s);
      path = d3.geo.path().projection(projection);
      b = path.bounds(geo);
      var t = projection.translate();
      projection.translate([
        t[0] + (MAP_W / 2 - (b[0][0] + b[1][0]) / 2),
        t[1] + (MAP_H / 2 - (b[0][1] + b[1][1]) / 2)
      ]);
      path = d3.geo.path().projection(projection);

      mapG = d3.select("#mapZoom");
      mapG.selectAll("path").data(geoFeatures).enter().append("path")
        .attr("class", "map-state")
        .attr("d", path)
        .attr("tabindex", 0)
        .attr("role", "img")
        .attr("aria-label", function (f) { return stateName(f); })
        .append("title").text(function (f) { return stateName(f); });

      mapG.selectAll("path")
        .on("mouseenter", function (f) { showMapTip(f); })
        .on("mousemove", moveMapTip)
        .on("mouseleave", hideMapTip)
        .on("focus", function (f) { showMapTip(f); })
        .on("blur", hideMapTip)
        .on("click", function (f) { showMapTip(f); })   // tap support
        .on("touchstart", function (f) { showMapTip(f); });

      mapReady = true;
      byId("mapStatus").classList.add("hidden");

      // report any state in the CSV with no polygon (should be none)
      var missing = states.filter(function (d) { return !featureByName[d.state]; })
        .map(function (d) { return d.state; });
      if (missing.length) console.warn("No map polygon for:", missing);

      if (currentStep && currentStep.dataset.visual === "map") render(currentStep, true);
    });
  }

  var combinedColor = d3.scale.linear()
    .domain([1.8, 3.0, 4.5, 6.4])
    .range(["#8a6ba0", "#cd93af", "#d98f2a", "#f8d255"]).clamp(true);
  var gapColor = d3.scale.linear()
    .domain([-1.2, -0.1, 0.1, 1.8])
    .range(["#8a6ba0", "#5a4f53", "#5a4f42", "#d98f2a"]).clamp(true);

  function fillFor(f, mode) {
    var d = stateByName[stateName(f)];
    if (!d) return "#40323a";
    if (mode === "gap") return d.gap === null ? "#40323a" : gapColor(d.gap);
    return d.combined === null ? "#40323a" : combinedColor(d.combined);
  }

  function setMapMode(mode) {
    if (!mapReady || mode === mapMode) return;
    mapMode = mode;
    // fill is CSS-transitioned, so this recolours in place instead of
    // cross-fading between two separate maps
    mapG.selectAll("path").style("fill", function (f) { return fillFor(f, mode); });

    mapScene.classList.toggle("mode-gap", mode === "gap");
    byId("mapLegend").classList.toggle("gap", mode === "gap");
    byId("legendLow").textContent = mode === "gap" ? "URBAN HIGHER" : "LOW";
    byId("legendHigh").textContent = mode === "gap" ? "RURAL HIGHER" : "HIGH";
    byId("mapKicker").textContent = mode === "gap"
      ? "2026 · RURAL − URBAN" : "2026 · COMBINED INFLATION";
    byId("mapTitle").textContent = mode === "gap" ? "Who is higher?" : "State snapshot";
  }

  // Continuous geometric zoom on the SAME map — full India first, then in.
  function setMapFocus(name, instant) {
    if (!mapReady) return;
    if (name === mapFocus && !instant) return;
    mapFocus = name;

    var stat = byId("zoomStat");
    var paths = mapG.selectAll("path");
    var transform = "translate(0,0) scale(1)";

    if (name && featureByName[name]) {
      var f = featureByName[name];
      var b = path.bounds(f);
      var dx = Math.max(b[1][0] - b[0][0], 1);
      var dy = Math.max(b[1][1] - b[0][1], 1);
      var cx = (b[0][0] + b[1][0]) / 2;
      var cy = (b[0][1] + b[1][1]) / 2;
      // sit the state left of centre so the big figure on the right stays clear
      var fx = MAP_W * 0.42, fy = MAP_H * 0.56;
      var k = Math.min(14, Math.max(1.8, Math.min(0.50 * MAP_W / dx, 0.62 * MAP_H / dy)));
      transform = "translate(" + (fx - k * cx) + "," + (fy - k * cy) + ") scale(" + k + ")";

      paths.classed("dim", true).classed("focus", false);
      paths.filter(function (g) { return stateName(g) === name; })
        .classed("dim", false).classed("focus", true);

      var d = stateByName[name] || {};
      byId("zoomName").textContent = SHORT_NAME[name] || name;
      byId("zoomRate").textContent = mapMode === "gap"
        ? signed(d.gap === undefined ? null : d.gap, " pp")
        : fmt(d.combined === undefined ? null : d.combined, "%");
      byId("zoomBreakdown").textContent =
        "Rural " + fmt(d.rural === undefined ? null : d.rural, "%") +
        " · Urban " + fmt(d.urban === undefined ? null : d.urban, "%");
      stat.classList.add("show");
    } else {
      paths.classed("dim", false).classed("focus", false);
      stat.classList.remove("show");
    }

    hideMapTip();
    if (instant || reduceMotion) mapG.attr("transform", transform);
    // d3 v3 interpolates the transform itself, so this is a real zoom,
    // not a cross-fade between two pictures
    else mapG.transition().duration(1150).ease("cubic-in-out").attr("transform", transform);
  }

  // ---------------------------------------------------------------- tooltip
  function tipHTML(d, name) {
    return "<strong>" + name + "</strong>" +
      "<div class='tip-accent'>Combined " + fmt(d.combined, "%") + "</div>" +
      "<div>Rural " + fmt(d.rural, "%") + " · Urban " + fmt(d.urban, "%") + "</div>" +
      "<div>Gap " + signed(d.gap, " pp") + "</div>";
  }
  function showMapTip(f) {
    var name = stateName(f), d = stateByName[name];
    var tip = byId("mapTooltip");
    if (!d) {
      tip.innerHTML = "<strong>" + name + "</strong><div>No value in this dataset</div>";
    } else {
      tip.innerHTML = tipHTML(d, name);
    }
    tip.style.display = "block";
    if (d3.event && d3.event.clientX !== undefined) moveMapTip();
    else placeTip(tip, byId("mapShell"), MAP_W * 0.05, MAP_H * 0.2);
  }
  function moveMapTip() {
    var tip = byId("mapTooltip"), shell = byId("mapShell");
    var e = d3.event;
    if (!e) return;
    var pt = e.touches && e.touches[0] ? e.touches[0] : e;
    if (pt.clientX === undefined) return;
    var host = shell.getBoundingClientRect();
    placeTip(tip, shell, pt.clientX - host.left + 16, pt.clientY - host.top + 16);
  }
  function placeTip(tip, shell, x, y) {
    var host = shell.getBoundingClientRect();
    var w = tip.offsetWidth || 200, h = tip.offsetHeight || 90;
    tip.style.left = Math.max(8, Math.min(x, host.width - w - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(y, host.height - h - 8)) + "px";
  }
  function hideMapTip() { byId("mapTooltip").style.display = "none"; }
  window.addEventListener("scroll", hideMapTip, { passive: true });

  // ----------------------------------------------------------- chart sizing
  // The old build hard-coded viewBoxes like 1060x650 into containers that are
  // nearly square, so every chart was letterboxed into a thin band with
  // unreadably small axis text. Measure the box instead and draw in real px.
  function boxOf(id, fallbackW, fallbackH) {
    var node = byId(id);
    var host = node.parentNode.getBoundingClientRect();
    var W = Math.round(host.width) || fallbackW;
    var H = Math.round(host.height) || fallbackH;
    d3.select(node).attr("viewBox", "0 0 " + W + " " + H);
    return { W: W, H: H, svg: d3.select(node) };
  }

  // ----------------------------------------------------------- state gap dots
  function drawStateGap() {
    if (drawn.stateGap || !states.length) return;
    var rows = states.filter(function (d) {
      return d.gap !== null && d.rural !== null && d.urban !== null;
    }).sort(function (a, b) { return a.gap - b.gap; });
    if (!rows.length) return;

    var box = boxOf("stateGapChart", 640, 690), W = box.W, H = box.H, svg = box.svg;
    if (W < 80 || H < 80) return;
    drawn.stateGap = true;
    svg.selectAll("*").remove();

    var m = { t: 30, r: 18, b: 10, l: Math.min(200, Math.round(W * 0.34)) };
    var rowH = (H - m.t - m.b) / rows.length;
    var fs = Math.max(7.5, Math.min(11.5, rowH * 0.72));
    var x = d3.scale.linear().domain([-1.4, 1.9]).range([m.l, W - m.r]);

    [-1, 0, 1].forEach(function (v) {
      svg.append("line").attr("class", v === 0 ? "zero-line" : "gridline")
        .attr("x1", x(v)).attr("x2", x(v)).attr("y1", m.t - 8).attr("y2", m.t + rows.length * rowH);
      svg.append("text").attr("class", "chart-axis").attr("x", x(v)).attr("y", 16)
        .attr("text-anchor", "middle").text((v > 0 ? "+" : "") + v + " pp");
    });

    var g = svg.selectAll("g.row").data(rows).enter().append("g")
      .attr("class", "row")
      .attr("transform", function (d, i) { return "translate(0," + (m.t + i * rowH) + ")"; });

    var cy = rowH / 2;
    g.append("text").attr("class", "gap-row-name")
      .attr("x", m.l - 10).attr("y", cy + fs * 0.35)
      .style("font-size", fs + "px")
      .attr("text-anchor", "end").text(function (d) { return CHART_LABEL[d.state] || d.state; });

    g.append("line").attr("class", "gap-row-seg")
      .attr("x1", x(0)).attr("x2", x(0)).attr("y1", cy).attr("y2", cy)
      .style("stroke-width", Math.max(3, rowH * 0.32))
      .style("stroke", function (d) { return d.gap >= 0 ? "#d98f2a" : "#8a6ba0"; })
      .transition().delay(function (d, i) { return dur(i * 16); }).duration(dur(550))
      .attr("x2", function (d) { return x(d.gap); });

    var r0 = Math.max(3, rowH * 0.26);
    g.append("circle").attr("class", "gap-row-dot")
      .attr("cy", cy).attr("r", r0).attr("cx", x(0))
      .style("fill", function (d) { return d.gap >= 0 ? "#d98f2a" : "#8a6ba0"; })
      .transition().delay(function (d, i) { return dur(i * 16); }).duration(dur(550))
      .attr("cx", function (d) { return x(d.gap); });

    // full-width invisible hit area: the old build only listened on a 5px dot,
    // which was nearly impossible to hover and impossible to tap
    g.append("rect").attr("class", "gap-row-hit")
      .attr("x", 0).attr("y", 0).attr("width", W).attr("height", rowH)
      .on("mouseenter", rowOn).on("click", rowOn).on("touchstart", rowOn)
      .on("mouseleave", rowOff);

    function rowOn(d) {
      var row = this.parentNode;
      svg.selectAll("g.row").classed("on", false);
      d3.select(row).classed("on", true);
      d3.select(row).select("circle").transition().duration(dur(180)).attr("r", r0 * 1.8);
      byId("stateGapHover").innerHTML = "<strong>" + d.state + "</strong> · rural " +
        fmt(d.rural, "%") + " · urban " + fmt(d.urban, "%") + " · gap " + signed(d.gap, " pp");
    }
    function rowOff() {
      d3.select(this.parentNode).select("circle").transition().duration(dur(180)).attr("r", r0);
    }
  }

  // -------------------------------------------------------- combined history
  function drawCombinedHistory() {
    if (drawn.combinedHistory || !combined.length) return;
    var box = boxOf("combinedHistoryChart", 640, 620), W = box.W, H = box.H, svg = box.svg;
    if (W < 80 || H < 80) return;
    drawn.combinedHistory = true;
    svg.selectAll("*").remove();

    var m = { t: 24, r: 26, b: 34, l: 46 };
    var x = d3.scale.linear().domain([2014, 2025]).range([m.l, W - m.r]);
    var y = d3.scale.linear().domain([2, 7.2]).range([H - m.b, m.t]);

    [2, 3, 4, 5, 6, 7].forEach(function (v) {
      svg.append("line").attr("class", "gridline")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(v)).attr("y2", y(v));
      svg.append("text").attr("class", "chart-axis").attr("x", m.l - 8).attr("y", y(v) + 4)
        .attr("text-anchor", "end").text(v + "%");
    });
    [2014, 2016, 2018, 2020, 2022, 2024].forEach(function (v) {
      svg.append("text").attr("class", "chart-axis").attr("x", x(v)).attr("y", H - 12)
        .attr("text-anchor", "middle").text(v);
    });

    var line = d3.svg.line()
      .x(function (d) { return x(d.year); })
      .y(function (d) { return y(d.value); }).interpolate("monotone");
    var p = svg.append("path").datum(combined).attr("class", "line-main").attr("d", line);
    if (!reduceMotion) {
      var L = p.node().getTotalLength();
      p.attr("stroke-dasharray", L + " " + L).attr("stroke-dashoffset", L)
        .transition().duration(1100).ease("cubic-in-out").attr("stroke-dashoffset", 0);
    }

    svg.selectAll(".hist-dot").data(combined).enter().append("circle")
      .attr("class", "hist-dot")
      .attr("cx", function (d) { return x(d.year); })
      .attr("cy", function (d) { return y(d.value); })
      .attr("r", 6).style("fill", "#f8d255");

    svg.selectAll(".dot-hit").data(combined).enter().append("circle")
      .attr("class", "dot-hit")
      .attr("cx", function (d) { return x(d.year); })
      .attr("cy", function (d) { return y(d.value); })
      .attr("r", Math.max(14, (W - m.l - m.r) / 26))
      .on("mouseenter", onDot).on("click", onDot).on("touchstart", onDot)
      .on("mouseleave", offDot);

    function onDot(d) {
      svg.selectAll(".hist-dot").filter(function (e) { return e.year === d.year; })
        .transition().duration(dur(160)).attr("r", 11);
      byId("combinedHistoryHover").innerHTML =
        "<strong>" + d.year + "</strong> · combined inflation " + fmt(d.value, "%");
    }
    function offDot(d) {
      svg.selectAll(".hist-dot").filter(function (e) { return e.year === d.year; })
        .transition().duration(dur(160)).attr("r", 6);
    }
  }

  // ------------------------------------------------------------- annual gap
  var annualSvg = null;
  function drawAnnualGap() {
    if (drawn.annualGap || !history.length) return;
    var box = boxOf("annualGapChart", 640, 620), W = box.W, H = box.H, svg = box.svg;
    if (W < 80 || H < 80) return;
    drawn.annualGap = true;
    annualSvg = svg;
    svg.selectAll("*").remove();

    var m = { t: 30, r: 26, b: 34, l: 50 };
    var x = d3.scale.linear().domain([2014, 2025]).range([m.l, W - m.r]);
    var y = d3.scale.linear().domain([-1.9, 1.6]).range([H - m.b, m.t]);

    [-1.5, -1, -0.5, 0, 0.5, 1, 1.5].forEach(function (v) {
      svg.append("line").attr("class", v === 0 ? "zero-line" : "gridline")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(v)).attr("y2", y(v));
      svg.append("text").attr("class", "chart-axis").attr("x", m.l - 8).attr("y", y(v) + 4)
        .attr("text-anchor", "end").text(v === 0 ? "0" : (v > 0 ? "+" : "") + v.toFixed(1));
    });
    [2014, 2016, 2018, 2020, 2022, 2024].forEach(function (v) {
      svg.append("text").attr("class", "chart-axis").attr("x", x(v)).attr("y", H - 12)
        .attr("text-anchor", "middle").text(v);
    });
    svg.append("text").attr("class", "chart-axis").attr("x", W - m.r).attr("y", m.t + 4)
      .attr("text-anchor", "end").text("rural higher ↑");
    svg.append("text").attr("class", "chart-axis").attr("x", W - m.r).attr("y", H - m.b - 6)
      .attr("text-anchor", "end").text("urban higher ↓");

    var line = d3.svg.line()
      .x(function (d) { return x(d.year); })
      .y(function (d) { return y(d.gap); }).interpolate("monotone");
    svg.append("path").datum(history).attr("class", "line-gap").attr("d", line);

    svg.selectAll(".gap-dot").data(history).enter().append("circle")
      .attr("class", "hist-dot gap-dot")
      .attr("cx", function (d) { return x(d.year); })
      .attr("cy", function (d) { return y(d.gap); })
      .attr("r", 6)
      .style("fill", function (d) { return d.gap >= 0 ? "#d98f2a" : "#8a6ba0"; });

    // the old build attached no handlers at all to this chart
    svg.selectAll(".dot-hit").data(history).enter().append("circle")
      .attr("class", "dot-hit")
      .attr("cx", function (d) { return x(d.year); })
      .attr("cy", function (d) { return y(d.gap); })
      .attr("r", Math.max(14, (W - m.l - m.r) / 26))
      .on("mouseenter", readAnnual).on("click", readAnnual).on("touchstart", readAnnual);
  }

  function readAnnual(d) {
    byId("annualGapHover").innerHTML = "<strong>" + d.year + "</strong> · " +
      signed(d.gap, " pp") + " · " + (d.gap >= 0 ? "rural higher" : "urban higher");
  }

  function focusAnnualGap(year) {
    if (!annualSvg) return;
    var target = history.filter(function (d) { return d.year === +year; })[0];
    annualSvg.selectAll(".gap-dot")
      .transition().duration(dur(500))
      .attr("r", function (d) { return d.year === +year ? 12 : 6; })
      .style("opacity", function (d) { return d.year === +year ? 1 : 0.42; });
    if (target) readAnnual(target);
  }

  // --------------------------------------------------------------- switches
  function drawSwitchChart() {
    if (drawn.switches || !switches.length) return;
    var box = boxOf("switchChart", 640, 520), W = box.W, H = box.H, svg = box.svg;
    if (W < 80 || H < 80) return;
    drawn.switches = true;
    svg.selectAll("*").remove();

    var m = { t: 24, r: 22, b: 32, l: 44 };
    var x = d3.scale.linear().domain([2014, 2025.5]).range([m.l, W - m.r]);
    // the old domain was [-2.9, 1.9] while the data only spans -1.12..1.33,
    // so every dot was squashed into the top third of the frame
    var y = d3.scale.linear().domain([-1.6, 1.6]).range([H - m.b, m.t]);

    [-1.5, -1, -0.5, 0, 0.5, 1, 1.5].forEach(function (v) {
      svg.append("line").attr("class", v === 0 ? "zero-line" : "gridline")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(v)).attr("y2", y(v));
      svg.append("text").attr("class", "chart-axis").attr("x", m.l - 8).attr("y", y(v) + 4)
        .attr("text-anchor", "end").text(v === 0 ? "0" : (v > 0 ? "+" : "") + v.toFixed(1));
    });
    [2014, 2016, 2018, 2020, 2022, 2024].forEach(function (v) {
      svg.append("text").attr("class", "chart-axis").attr("x", x(v)).attr("y", H - 11)
        .attr("text-anchor", "middle").text(v);
    });

    function xpos(date) {
      return x(+date.slice(0, 4) + (+date.slice(5, 7) - 1) / 12);
    }
    var line = d3.svg.line()
      .x(function (d) { return xpos(d.date); })
      .y(function (d) { return y(d.gap); }).interpolate("linear");
    svg.append("path").datum(switches).attr("class", "switch-line").attr("d", line);

    svg.selectAll(".switch-dot").data(switches).enter().append("circle")
      .attr("class", function (d) { return "switch-dot " + (d.leader === "Rural" ? "rural" : "urban"); })
      .attr("cx", function (d) { return xpos(d.date); })
      .attr("cy", function (d) { return y(d.gap); })
      .attr("r", 6);

    svg.selectAll(".dot-hit").data(switches).enter().append("circle")
      .attr("class", "dot-hit")
      .attr("cx", function (d) { return xpos(d.date); })
      .attr("cy", function (d) { return y(d.gap); })
      .attr("r", 13)
      .on("mouseenter", onSwitch).on("click", onSwitch).on("touchstart", onSwitch)
      .on("mouseleave", offSwitch);

    function onSwitch(d) {
      svg.selectAll(".switch-dot").filter(function (e) { return e.date === d.date; })
        .transition().duration(dur(150)).attr("r", 11);
      byId("switchHover").innerHTML = "<strong>" + d.date + "</strong> · " +
        (d.leader === "Rural" ? "Rural higher" : "Urban higher") +
        " · Rural " + fmt(d.rural, "%") + " · Urban " + fmt(d.urban, "%") +
        " · gap " + signed(d.gap, " pp");
    }
    function offSwitch(d) {
      svg.selectAll(".switch-dot").filter(function (e) { return e.date === d.date; })
        .transition().duration(dur(150)).attr("r", 6);
    }
  }

  // ----------------------------------------------------------------- basket
  var BASKET_KEYS = [
    "Consumer Food Price", "Food and Beverages", "Fuel and Light",
    "Clothing and Footwear", "Miscellaneous", "Pan, Tobacco and Intoxicants", "General"
  ];
  var BASKET_ICONS = {
    "Consumer Food Price": "🌾", "Food and Beverages": "🥣", "Fuel and Light": "⚡",
    "Clothing and Footwear": "👕", "Miscellaneous": "🧺",
    "Pan, Tobacco and Intoxicants": "🍃", "General": "📊"
  };

  function drawBasket(period) {
    if (!periods || !periods[period]) return;
    document.querySelectorAll(".period").forEach(function (b) {
      var on = b.getAttribute("data-period") === period;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });

    var wrap = byId("basketItems");
    wrap.innerHTML = "";
    BASKET_KEYS.forEach(function (k) {
      var v = num(periods[period][k]);
      if (v === null) return;
      // a real <button>, so it responds to tap and keyboard, not hover only
      var item = document.createElement("button");
      item.type = "button";
      item.className = "basket-item";
      item.innerHTML =
        "<div class='basket-icon' aria-hidden='true'>" + (BASKET_ICONS[k] || "\u2022") + "</div>" +
        "<div class='basket-name'>" + k + "</div>" +
        "<div class='basket-gap " + (v >= 0 ? "up" : "down") + "'>" + signed(v, " pp") + "</div>";
      function select() {
        wrap.querySelectorAll(".basket-item").forEach(function (x) { x.classList.remove("active"); });
        item.classList.add("active");
        byId("basketDetail").textContent = k + " \u00b7 " + period +
          " \u00b7 rural minus urban gap: " + signed(v, " percentage points") + ". " +
          (v >= 0 ? "Rural inflation ran higher in this category."
                  : "Urban inflation ran higher in this category.");
      }
      item.addEventListener("mouseenter", select);
      item.addEventListener("focus", select);
      item.addEventListener("click", select);
      wrap.appendChild(item);
    });
    byId("basketDetail").textContent = "Hover or tap an item to inspect the category gap.";
  }

  document.querySelectorAll(".period").forEach(function (btn) {
    btn.addEventListener("click", function () {
      userPeriod = btn.getAttribute("data-period"); // survives further scrolling
      drawBasket(userPeriod);
    });
  });

  // ------------------------------------------------------------- the rail
  function render(step, force) {
    var v = step.dataset.visual;
    showScene(v);

    if (v === "map") {
      setMapMode(step.dataset.mapMode || "combined");
      setMapFocus(step.dataset.mapFocus || null, force);
    }
    if (v === "state-gap") drawStateGap();
    if (v === "average") {
      // animate the bars in each time the scene is entered
      var r = byId("avgRuralBar"), u = byId("avgUrbanBar");
      r.style.width = "0"; u.style.width = "0";
      window.requestAnimationFrame(function () {
        r.style.width = r.dataset.w || "92%";
        u.style.width = u.dataset.w || "78%";
      });
    }
    if (v === "combined-history") drawCombinedHistory();
    if (v === "annual-gap") {
      drawAnnualGap();
      focusAnnualGap(step.dataset.gapFocus || "2014");
    }
    if (v === "switches") drawSwitchChart();
    if (v === "basket") drawBasket(userPeriod || step.dataset.period || "2018-19");
  }

  function activate(step) {
    if (!step || step === currentStep) return;
    currentStep = step;
    stage.classList.toggle("visual-left", step.dataset.side === "right");
    stage.classList.toggle("visual-right", step.dataset.side !== "right");
    render(step);
    document.body.dataset.storyIndex = steps.indexOf(step);
  }

  // A plain "which step owns the middle of the screen" test. The old build
  // used IntersectionObserver at threshold 0.58 on 115vh sections, which can
  // fire for two steps at once and skip steps entirely on short viewports.
  function pickStep() {
    var mid = window.innerHeight * 0.45;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < steps.length; i++) {
      var r = steps[i].getBoundingClientRect();
      var d = (r.top <= mid && r.bottom >= mid) ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestDist) { bestDist = d; best = steps[i]; }
    }
    return best;
  }

  // charts are measured in real pixels now, so a resize needs a redraw
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      drawn = {};
      annualSvg = null;
      if (currentStep) render(currentStep, true);
    }, 250);
  }, { passive: true });

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      activate(pickStep());
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var pct = max > 0 ? Math.min(100, Math.max(0, window.scrollY / max * 100)) : 0;
      byId("progressFill").style.width = pct + "%";
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  activate(steps[0]);
  onScroll();
})();
