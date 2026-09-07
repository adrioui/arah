const VERDICT_WORDS = {
  allow: "Ride",
  warn: "Ride with care",
  withhold: "Wait for better coverage",
  block: "Skip this one",
};

const CHECKS = {
  long: {
    kind: "train",
    session: "long",
    minutes: 150,
    anchor: { lat: -6.2842, lon: 106.7125 },
    departAt: "2026-09-12T05:30:00+07:00",
    night: false,
  },
  night: {
    kind: "train",
    session: "tempo",
    minutes: 60,
    anchor: { lat: -6.2842, lon: 106.7125 },
    departAt: "2026-09-12T19:30:00+07:00",
    night: true,
  },
  cafe: {
    kind: "go",
    origin: { lat: -6.2842, lon: 106.7125 },
    destinationName: "Kemang cafe",
    destination: { lat: -6.256, lon: 106.79 },
    departAt: "2026-09-12T07:00:00+07:00",
    night: false,
  },
};

let geometries = {};
let selectedId = null;

function verdictColor(verdict) {
  const root = getComputedStyle(document.documentElement);
  const tokens = { allow: "--ride", warn: "--caution", withhold: "--hold", block: "--stop" };
  return root.getPropertyValue(tokens[verdict]).trim() || "#1c2b33";
}

function project(points) {
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const spanLon = Math.max(maxLon - minLon, 0.0001);
  const spanLat = Math.max(maxLat - minLat, 0.0001);
  return points
    .map((p) => {
      const x = 20 + ((p.lon - minLon) / spanLon) * 560;
      const y = 20 + (1 - (p.lat - minLat) / spanLat) * 320;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function renderTrace(routeId, verdict) {
  const svg = document.getElementById("trace");
  svg.innerHTML = "";
  const route = geometries[routeId];
  if (route === undefined) {
    return;
  }
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", project(route.points));
  line.setAttribute("stroke", verdictColor(verdict));
  svg.appendChild(line);
}

function renderEvidence(candidate) {
  const box = document.getElementById("evidence");
  box.innerHTML = "";
  if (candidate === null) {
    return;
  }
  const heading = document.createElement("h3");
  heading.textContent = "Why this verdict";
  const reasons = document.createElement("ul");
  candidate.reasons.forEach((reason) => {
    const row = document.createElement("li");
    row.textContent = reason;
    reasons.appendChild(row);
  });
  const coverage = document.createElement("p");
  coverage.className = "coverage";
  coverage.textContent = `Live coverage: ${candidate.coverage}. Evidence: ${candidate.evidenceIds.join(", ") || "none"}.`;
  box.appendChild(heading);
  box.appendChild(reasons);
  box.appendChild(coverage);
}

function select(routeId, verdict) {
  selectedId = routeId;
  renderTrace(routeId, verdict);
  const candidate = (window.__lastRanked || []).find((row) => row.routeId === routeId) || null;
  renderEvidence(candidate);
  document.querySelectorAll("#candidates li").forEach((row) => {
    if (row.dataset.route === routeId) {
      row.setAttribute("aria-current", "true");
    } else {
      row.removeAttribute("aria-current");
    }
  });
}

function render(decision) {
  window.__lastRanked = decision.ranked;
  const title = document.getElementById("resultTitle");
  title.textContent = decision.ranked.length === 0 ? "No routes matched" : `${decision.ranked.length} candidates`;
  const list = document.getElementById("candidates");
  list.innerHTML = "";
  decision.ranked.forEach((candidate) => {
    const item = document.createElement("li");
    item.dataset.verdict = candidate.verdict;
    item.dataset.route = candidate.routeId;
    const route = geometries[candidate.routeId];
    const stats = route === undefined ? "" : `${route.distanceKm} km, ${route.climbM} m climb`;
    const name = document.createElement("div");
    name.textContent = `${candidate.routeName} `;
    const verdict = document.createElement("span");
    verdict.className = "verdict";
    verdict.textContent = VERDICT_WORDS[candidate.verdict];
    name.appendChild(verdict);
    const meta = document.createElement("div");
    meta.className = "stats";
    meta.textContent = stats;
    item.appendChild(name);
    item.appendChild(meta);
    item.addEventListener("click", () => select(candidate.routeId, candidate.verdict));
    list.appendChild(item);
  });
  const options = document.getElementById("feedbackRoute");
  options.innerHTML = "";
  decision.ranked.forEach((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.routeId;
    option.textContent = candidate.routeName;
    options.appendChild(option);
  });
  const first = decision.ranked[0];
  if (first !== undefined) {
    select(first.routeId, first.verdict);
  } else {
    renderTrace(null, "withhold");
    renderEvidence(null);
  }
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok === false) {
    throw new Error(`request failed: ${path}`);
  }
  return response.json();
}

async function runCheck(name) {
  document.querySelectorAll("[data-check]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.check === name ? "true" : "false");
  });
  try {
    render(await postJson("/api/decide", CHECKS[name]));
  } catch {
    document.getElementById("resultTitle").textContent = "That check failed. Try again.";
  }
}

async function boot() {
  try {
    const healthResponse = await fetch("/api/health");
    const health = await healthResponse.json();
    document.getElementById("health").textContent =
      `Feed ${health.provenance}, map ${health.snapshot}, ${health.routes} curated routes.`;
    const routesResponse = await fetch("/api/routes");
    const routes = await routesResponse.json();
    routes.routes.forEach((route) => {
      geometries[route.id] = route;
    });
  } catch {
    document.getElementById("health").textContent = "Feed status unavailable. Start the server first.";
  }
  document.querySelectorAll("[data-check]").forEach((button) => {
    button.addEventListener("click", () => runCheck(button.dataset.check));
  });
  document.getElementById("feedbackForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("feedbackStatus");
    try {
      await postJson("/api/feedback", {
        routeId: document.getElementById("feedbackRoute").value,
        kind: document.getElementById("feedbackKind").value,
        text: document.getElementById("feedbackText").value,
        at: new Date().toISOString(),
      });
      status.textContent = "Report received. Thank you.";
    } catch {
      status.textContent = "Report failed. Check the text and try again.";
    }
  });
}

boot();
