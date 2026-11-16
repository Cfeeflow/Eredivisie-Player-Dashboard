const { meta, teams: TEAMS, players: PLAYERS, cols: COLS, rows: ROWS } = window.DATA;
const C = Object.fromEntries(COLS.map((c, i) => [c, i]));
const STAT_KEYS = COLS.slice(C.usual + 1);

// ---------- positions ----------

const ROLES = {
  GK: ["Goalkeeper", "goalkeepers"], CB: ["Centre back", "centre backs"], FB: ["Full back", "full backs"],
  CM: ["Central midfielder", "central midfielders"], AM: ["Attacking midfielder", "attacking midfielders"],
  W: ["Winger", "wingers"], ST: ["Striker", "strikers"],
};
const LINES = { GK: ["Goalkeeper", "goalkeepers"], DEF: ["Defender", "defenders"], MID: ["Midfielder", "midfielders"], FWD: ["Forward", "forwards"] };
const ROLE_LINE = { GK: "GK", CB: "DEF", FB: "DEF", CM: "MID", AM: "MID", W: "FWD", ST: "FWD" };
const USUAL_LINE = ["GK", "DEF", "MID", "FWD"];
const POS_OPTIONS = [
  ["out", "All outfield"],
  ["line:DEF", "Defenders"], ["role:CB", " Centre backs"], ["role:FB", " Full backs"],
  ["line:MID", "Midfielders"], ["role:CM", " Central midfielders"], ["role:AM", " Attacking midfielders"],
  ["line:FWD", "Forwards"], ["role:W", " Wingers"], ["role:ST", " Strikers"],
  ["line:GK", "Goalkeepers"],
];

function posMatch(p, sel) {
  if (sel === "out") return p.line !== "GK";
  const [kind, v] = sel.split(":");
  return kind === "line" ? p.line === v : p.role === v;
}
const posLabel = p => (p.role ? ROLES[p.role] : LINES[p.line])[0];
const posShort = p => p.role || p.line;

// ---------- metrics ----------

// type: count = summable (per 90 or total), pct = success rate, ratio = per-attempt average, avg/raw = shown as-is.
// group: which players the metric makes sense for.
const METRICS = [
  { key: "goals", label: "Goals", type: "count", group: "out" },
  { key: "assists", label: "Assists", type: "count", group: "out" },
  { key: "ga", label: "Goals + assists", type: "count", group: "out", fn: p => p.goals + p.assists },
  { key: "xg", label: "xG", type: "count", group: "out", dp: 1 },
  { key: "npxg", label: "Non-penalty xG", type: "count", group: "out", dp: 1 },
  { key: "gmxg", label: "Goals − xG", type: "count", group: "out", dp: 1, fn: p => p.goals - p.xg },
  { key: "xa", label: "xA", type: "count", group: "out", dp: 1 },
  { key: "shots", label: "Shots", type: "count", group: "out" },
  { key: "sot", label: "Shots on target", type: "count", group: "out" },
  { key: "xg_shot", label: "xG per shot", type: "ratio", group: "out", num: "xg", den: "shots" },
  { key: "chances", label: "Chances created", type: "count", group: "out" },
  { key: "bigchances", label: "Big chances created", type: "count", group: "out" },
  { key: "boxtouches", label: "Touches in opp. box", type: "count", group: "out" },
  { key: "dribbles", label: "Successful dribbles", type: "count", group: "out" },
  { key: "dribble_pct", label: "Dribble success", type: "pct", group: "out", num: "dribbles", den: "dribbles_att" },
  { key: "final3rd", label: "Passes into final third", type: "count", group: "out" },
  { key: "passes", label: "Accurate passes", type: "count", group: "all" },
  { key: "pass_pct", label: "Pass accuracy", type: "pct", group: "all", num: "passes", den: "passes_att" },
  { key: "longballs", label: "Accurate long balls", type: "count", group: "all" },
  { key: "longball_pct", label: "Long ball accuracy", type: "pct", group: "all", num: "longballs", den: "longballs_att" },
  { key: "crosses", label: "Accurate crosses", type: "count", group: "out" },
  { key: "tackles", label: "Tackles", type: "count", group: "out" },
  { key: "interceptions", label: "Interceptions", type: "count", group: "out" },
  { key: "recoveries", label: "Recoveries", type: "count", group: "all" },
  { key: "clearances", label: "Clearances", type: "count", group: "out" },
  { key: "blocks", label: "Blocks", type: "count", group: "out" },
  { key: "duels", label: "Duels won", type: "count", group: "out" },
  { key: "aerials", label: "Aerial duels won", type: "count", group: "out" },
  { key: "aerial_pct", label: "Aerial win rate", type: "pct", group: "out", num: "aerials", den: "aerials_att" },
  { key: "saves", label: "Saves", type: "count", group: "gk" },
  { key: "conceded", label: "Goals conceded", type: "count", group: "gk", lowerBetter: true },
  { key: "xgot_faced", label: "xGOT faced", type: "count", group: "gk", dp: 1 },
  { key: "prevented", label: "Goals prevented", type: "count", group: "gk", dp: 1 },
  { key: "rating", label: "FotMob rating", type: "avg", group: "all" },
  { key: "value", label: "Market value", type: "raw", group: "all" },
  { key: "min", label: "Minutes", type: "raw", group: "all" },
];
const M = Object.fromEntries(METRICS.map(m => [m.key, m]));

const PROFILE_METRICS = {
  att: ["goals", "npxg", "shots", "xg_shot", "xa", "chances", "boxtouches", "dribbles", "final3rd",
        "passes", "pass_pct", "recoveries", "aerials", "aerial_pct"],
  mid: ["npxg", "xa", "chances", "final3rd", "passes", "pass_pct", "longballs", "dribbles",
        "tackles", "interceptions", "recoveries", "duels", "aerial_pct"],
  def: ["passes", "pass_pct", "longballs", "final3rd", "crosses", "chances", "dribbles",
        "tackles", "interceptions", "recoveries", "clearances", "blocks", "aerials", "aerial_pct"],
  gk: ["prevented", "saves", "conceded", "pass_pct", "passes", "longballs", "longball_pct", "recoveries", "rating"],
};
const profileSet = p => p.line === "GK" ? "gk" : p.line === "DEF" ? "def" : p.line === "MID" && p.role !== "AM" ? "mid" : "att";

// ---------- explorer views ----------

// Each view is an X/Y pair that answers one question, with names for the four quadrants
// (split at the median): tr = high X & high Y, tl = low X & high Y, br = high X & low Y, bl = low on both.
const VIEWS = [
  { id: "finishing", group: "out", name: "Finishing", x: "xg", y: "goals", diagonal: "goals = xG",
    question: "Who scores more than the quality of their chances suggests?",
    q: { tr: ["Prolific", "Gets good chances and puts them away"], tl: ["Clinical", "Scores more than their chances suggest"],
         br: ["Wasteful", "Gets chances but doesn't convert them"], bl: ["Low threat", "Few chances, few goals"] } },
  { id: "shooting", group: "out", name: "Shot selection", x: "shots", y: "xg_shot",
    question: "Who shoots a lot, and who waits for a good chance?",
    q: { tr: ["Volume and quality", "Shoots often from good positions"], tl: ["Selective", "Few shots, but good ones"],
         br: ["Shoots from anywhere", "Lots of shots, mostly low quality"], bl: ["Rarely shoots", "Few shots, low quality"] } },
  { id: "creating", group: "out", name: "Chance creation", x: "xa", y: "assists", diagonal: "assists = xA",
    question: "Who creates chances, and do teammates finish them?",
    q: { tr: ["Creator", "Creates good chances that get finished"], tl: ["Benefiting from finishers", "More assists than the chances created suggest"],
         br: ["Unrewarded creator", "Creates good chances, teammates miss them"], bl: ["Low creation", "Few chances created"] } },
  { id: "output", group: "out", name: "Attacking profile", x: "npxg", y: "xa",
    question: "Is a player more of a scorer or a creator?",
    q: { tr: ["Complete attacker", "Threat as scorer and creator"], tl: ["Creator", "Sets up more than they shoot"],
         br: ["Finisher", "Gets on the end of chances"], bl: ["Limited output", "Low threat either way"] } },
  { id: "progression", group: "out", name: "Ball progression", x: "final3rd", y: "dribbles",
    question: "How does a player move the ball forward: passing or carrying?",
    q: { tr: ["Progresses both ways", "Passes and dribbles the ball forward"], tl: ["Dribbler", "Carries the ball past opponents"],
         br: ["Progressive passer", "Moves the ball forward with passes"], bl: ["Low progression", "Rarely moves the ball forward"] } },
  { id: "passing", group: "out", name: "Passing security", x: "passes", y: "pass_pct",
    question: "Who sees a lot of the ball and keeps it?",
    q: { tr: ["Metronome", "Lots of passes, rarely loses it"], tl: ["Safe, less involved", "Accurate but sees less of the ball"],
         br: ["High volume, risky", "Lots of passes, more of them go astray"], bl: ["Less involved", "Few passes, lower accuracy"] } },
  { id: "defending", group: "out", name: "Defensive activity", x: "tackles", y: "interceptions",
    question: "How does a player win the ball back: in the tackle or by reading the game?",
    q: { tr: ["Ball winner", "Tackles and intercepts a lot"], tl: ["Reads the game", "Intercepts more than tackles"],
         br: ["Tackler", "Goes to ground more than intercepting"], bl: ["Less defensive work", "Few tackles and interceptions"] } },
  { id: "aerial", group: "out", name: "Aerial duels", x: "aerials", y: "aerial_pct",
    question: "Who contests the most headers, and who wins them?",
    q: { tr: ["Dominant in the air", "Many aerial duels, high win rate"], tl: ["Efficient", "Fewer duels, but wins most of them"],
         br: ["Busy, often beaten", "Contests a lot, loses many"], bl: ["Not an aerial presence", "Few duels, low win rate"] } },
  { id: "value", group: "out", name: "Value for money", x: "value", y: "rating",
    question: "Who performs above or below their market value?",
    q: { tr: ["Expensive, delivering", "High value, high rating"], tl: ["Bargain", "Rated above what their value suggests"],
         br: ["Underperforming", "High value, lower rating"], bl: ["Squad level", "Lower value, lower rating"] } },
  { id: "gk-shotstopping", group: "gk", name: "Shot stopping", x: "xgot_faced", y: "prevented",
    question: "Which keepers save more than expected, and how busy are they?",
    q: { tr: ["Busy and saving", "Faces a lot, stops more than expected"], tl: ["Quiet but sharp", "Faces less, still stops more than expected"],
         br: ["Busy, conceding", "Faces a lot and lets in more than expected"], bl: ["Quiet, below par", "Faces less, concedes more than expected"] } },
  { id: "gk-distribution", group: "gk", name: "Distribution", x: "longballs", y: "longball_pct",
    question: "Which keepers go long, and do the long balls arrive?",
    q: { tr: ["Accurate long passer", "Goes long often and finds a teammate"], tl: ["Picks the long ball", "Goes long less, accurate when doing so"],
         br: ["Long and loose", "Goes long often, many don't arrive"], bl: ["Plays short", "Rarely goes long"] } },
  { id: "gk-value", group: "gk", name: "Value for money", x: "value", y: "rating",
    question: "Which keepers perform above or below their market value?",
    q: { tr: ["Expensive, delivering", "High value, high rating"], tl: ["Bargain", "Rated above what their value suggests"],
         br: ["Underperforming", "High value, lower rating"], bl: ["Squad level", "Lower value, lower rating"] } },
];

// Recommended Y metrics for a chosen X, each with the question the pair answers.
const SUGGEST = {
  goals: [["xg", "finishing"], ["shots", "shot volume"], ["assists", "scorer or provider"]],
  assists: [["xa", "luck vs creation"], ["chances", "chances created"], ["goals", "scorer or provider"]],
  ga: [["value", "value for money"], ["rating", "overall rating"]],
  xg: [["goals", "finishing"], ["xa", "scorer or creator"], ["shots", "shot volume"]],
  npxg: [["xa", "scorer or creator"], ["goals", "finishing"]],
  gmxg: [["xg", "over/underperformance vs chances"], ["shots", "volume"]],
  xa: [["assists", "luck vs creation"], ["chances", "quality of chances"], ["npxg", "scorer or creator"]],
  shots: [["xg_shot", "shot selection"], ["goals", "conversion"], ["sot", "accuracy"]],
  sot: [["goals", "conversion"], ["shots", "accuracy"]],
  xg_shot: [["shots", "shot selection"], ["goals", "finishing"]],
  chances: [["xa", "quality of chances"], ["assists", "end product"], ["bigchances", "big chances"]],
  bigchances: [["chances", "chance quality"], ["assists", "end product"]],
  boxtouches: [["xg", "threat in the box"], ["goals", "end product"]],
  dribbles: [["dribble_pct", "dribble success"], ["final3rd", "carry vs pass"]],
  dribble_pct: [["dribbles", "volume vs success"]],
  final3rd: [["dribbles", "carry vs pass"], ["passes", "involvement"], ["chances", "end product"]],
  passes: [["pass_pct", "passing security"], ["final3rd", "progression"]],
  pass_pct: [["passes", "passing security"], ["longball_pct", "short vs long"]],
  longballs: [["longball_pct", "long ball accuracy"]],
  longball_pct: [["longballs", "volume vs accuracy"]],
  crosses: [["chances", "end product"], ["xa", "chance quality"]],
  tackles: [["interceptions", "defensive style"], ["duels", "duels won"], ["recoveries", "ball winning"]],
  interceptions: [["tackles", "defensive style"], ["recoveries", "ball winning"]],
  recoveries: [["tackles", "ball winning"], ["interceptions", "reading the game"]],
  clearances: [["aerials", "box defending"], ["blocks", "last-ditch defending"]],
  blocks: [["clearances", "last-ditch defending"]],
  duels: [["aerials", "ground vs air"], ["tackles", "ball winning"]],
  aerials: [["aerial_pct", "aerial dominance"], ["clearances", "box defending"]],
  aerial_pct: [["aerials", "aerial dominance"]],
  saves: [["prevented", "shot stopping"], ["conceded", "busy vs leaky"]],
  conceded: [["xgot_faced", "expected vs actual"], ["saves", "busy vs leaky"]],
  xgot_faced: [["prevented", "shot stopping"], ["conceded", "expected vs actual"]],
  prevented: [["xgot_faced", "shot stopping"], ["value", "value for money"]],
  rating: [["value", "value for money"], ["min", "how much they play"]],
  value: [["rating", "value for money"], ["ga", "output for the money"]],
  min: [["rating", "how much they play"], ["value", "value vs playing time"]],
};

// ---------- state & aggregation ----------

const seasons = [...meta.seasons].sort((a, b) => b.id.localeCompare(a.id));
const allStart = d3.min(seasons, s => s.start), allEnd = d3.max(seasons, s => s.end);
const MIN_OPTIONS = [0, 90, 270, 450, 900, 1350, 1800, 2250];

const state = {
  season: seasons[0].id, from: seasons[0].start, to: seasons[0].end,
  pos: "out", team: "", minMin: 0, minManual: false, mode: "p90",
  view: "finishing", x: "xg", y: "goals", lb: "goals", selectedId: null,
  sort: { key: "min", desc: true },
};
let AGG = [];

// Sum every match row in [from, to] into one record per player.
function aggregate(from, to) {
  const by = new Map();
  for (const r of ROWS) {
    const date = r[C.date];
    if (date < from || date > to) continue;
    let p = by.get(r[C.player]);
    if (!p) {
      p = { ...PLAYERS[r[C.player]], apps: 0, min: 0, ratingSum: 0, ratingN: 0, value: null, gkN: 0,
            matches: [], teamMin: new Map(), roleMin: {}, usualN: {} };
      for (const k of STAT_KEYS) p[k] = 0;
      by.set(r[C.player], p);
    }
    const team = TEAMS[r[C.team]];
    p.apps++;
    p.min += r[C.min];
    if (r[C.rating] != null) { p.ratingSum += r[C.rating]; p.ratingN++; }
    if (r[C.value] != null) p.value = r[C.value]; // rows are sorted by date, so this ends on the latest value
    p.gkN += r[C.gk];
    p.teamMin.set(team, (p.teamMin.get(team) ?? 0) + r[C.min]); // Map keeps first-appearance order
    if (r[C.role]) p.roleMin[r[C.role]] = (p.roleMin[r[C.role]] ?? 0) + r[C.min];
    if (r[C.usual] != null) p.usualN[r[C.usual]] = (p.usualN[r[C.usual]] ?? 0) + 1;
    for (const k of STAT_KEYS) p[k] += r[C[k]];
    p.matches.push({ date, team, opp: TEAMS[r[C.opp]], rating: r[C.rating], min: r[C.min], goals: r[C.goals], assists: r[C.assists] });
  }
  const most = obj => Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0];
  return [...by.values()].map(p => {
    p.rating = p.ratingN ? p.ratingSum / p.ratingN : null;
    p.teams = [...p.teamMin.keys()];
    p.team = d3.greatest(p.teamMin, ([, m]) => m)[0];
    p.switched = p.teams.length > 1;
    p.role = p.gkN > p.apps / 2 ? "GK" : (most(p.roleMin) ?? "");
    p.line = p.role ? ROLE_LINE[p.role] : (USUAL_LINE[most(p.usualN)] ?? "MID");
    return p;
  });
}

const group = () => state.pos === "line:GK" ? "gk" : "out";
const metricsFor = g => METRICS.filter(m => m.group === "all" || m.group === g);
const selected = () => AGG.find(p => p.id === state.selectedId);
const filtered = () => AGG.filter(p => posMatch(p, state.pos) && p.min >= state.minMin && (!state.team || p.teams.includes(state.team)));

// ---------- values & formatting ----------

function val(p, m, mode = state.mode) {
  if (m.type === "count") {
    const total = m.fn ? m.fn(p) : p[m.key];
    return mode === "p90" ? (p.min > 0 ? (total / p.min) * 90 : null) : total;
  }
  if (m.type === "pct") return p[m.den] > 0 ? (p[m.num] / p[m.den]) * 100 : null;
  if (m.type === "ratio") return p[m.den] > 0 ? p[m.num] / p[m.den] : null;
  return p[m.key];
}

const label = (m, mode = state.mode) => m.type === "count" && mode === "p90" ? `${m.label} per 90` : m.label;

function fmt(m, v, mode = state.mode) {
  if (v == null || Number.isNaN(v)) return "–";
  if (m.key === "value") return "€" + d3.format(".3~s")(v).replace("G", "B");
  if (m.type === "pct") return v.toFixed(0) + "%";
  if (m.type === "avg" || m.type === "ratio") return v.toFixed(2);
  if (m.type === "count" && mode === "p90") return v.toFixed(2);
  if (m.dp) return v.toFixed(m.dp);
  return d3.format(",")(Math.round(v));
}

const fmtDate = d => d3.timeFormat("%-d %b %Y")(new Date(d));
const tick = v => Math.abs(v) >= 1000 ? d3.format("~s")(v) : d3.format("~g")(v); // SI only from 1,000 up, else 0.1 reads "100m"

// ---------- tooltip ----------

const tip = document.getElementById("tooltip");

function showTip(event, title, rows) {
  tip.replaceChildren();
  const t = document.createElement("div");
  t.className = "tt-title";
  t.textContent = title;
  tip.append(t);
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "tt-row";
    const a = document.createElement("span"); a.textContent = k;
    const b = document.createElement("span"); b.textContent = v;
    row.append(a, b);
    tip.append(row);
  }
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(event.clientX + 14, window.innerWidth - r.width - 8) + "px";
  tip.style.top = Math.min(event.clientY + 14, window.innerHeight - r.height - 8) + "px";
}
const hideTip = () => { tip.hidden = true; };

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- shared chart helpers ----------

function svgIn(id, height) {
  const node = document.getElementById(id);
  node.replaceChildren();
  const width = node.clientWidth;
  const svg = d3.select(node).append("svg").attr("width", width).attr("height", height);
  return { svg, width };
}

// Bar from x0 to x1 with a 4px rounded data end and a square baseline end.
function barPath(x0, x1, y, h) {
  const r = Math.min(4, Math.abs(x1 - x0), h / 2);
  const s = x1 >= x0 ? -1 : 1;
  return `M${x0},${y}H${x1 + s * r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 + s * r},${y + h}H${x0}Z`;
}

function truncate(textSel, maxWidth) {
  textSel.each(function () {
    let s = this.textContent;
    while (s.length > 3 && this.getComputedTextLength() > maxWidth) {
      s = s.slice(0, -1);
      this.textContent = s + "…";
    }
  });
}

function select(p) {
  state.selectedId = p.id;
  render();
}

// ---------- explorer ----------

function currentView() {
  const v = VIEWS.find(v => v.id === state.view);
  if (v) return v;
  const mx = M[state.x], my = M[state.y];
  return {
    id: "custom", question: `How do players compare on ${mx.label} and ${my.label}?`,
    q: { tr: ["High on both", `Above the median on both`], tl: [`High ${my.label}`, `Above median ${my.label}, below median ${mx.label}`],
         br: [`High ${mx.label}`, `Above median ${mx.label}, below median ${my.label}`], bl: ["Low on both", "Below the median on both"] },
  };
}

let scatterDots = null;

function drawExplorer() {
  const view = currentView();
  const mx = M[state.x], my = M[state.y];
  document.getElementById("ex-question").textContent = view.question;

  const sug = document.getElementById("ex-suggest");
  const chips = (SUGGEST[state.x] ?? []).filter(([k]) => k !== state.y && metricsFor(group()).includes(M[k]));
  sug.replaceChildren(...(chips.length ? [el("span", null, `Good Y pairings for ${mx.label}:`)] : []), ...chips.map(([k, why]) => {
    const b = el("button", "chip", M[k].label + " ");
    b.append(el("span", null, "· " + why));
    b.addEventListener("click", () => { state.y = k; matchView(); syncControls(); render(); });
    return b;
  }));

  const data = filtered().map(p => ({ p, x: val(p, mx), y: val(p, my) })).filter(d => d.x != null && d.y != null);
  const xm = d3.median(data, d => d.x), ym = d3.median(data, d => d.y);
  for (const d of data) d.q = (d.y > ym ? "t" : "b") + (d.x > xm ? "r" : "l");

  drawScatter(data, xm, ym, view, mx, my);
  drawQuadrants(data, view, mx, my);
}

function drawScatter(data, xm, ym, view, mx, my) {
  const height = 460;
  const { svg, width } = svgIn("scatter", height);
  const mg = { top: 12, right: 24, bottom: 44, left: 60 };
  const ext = k => { const [a, b] = d3.extent(data, d => d[k]); return [Math.min(0, a ?? 0), b ?? 1]; };
  const x = d3.scaleLinear(ext("x"), [mg.left, width - mg.right]).nice();
  const y = d3.scaleLinear(ext("y"), [height - mg.bottom, mg.top]).nice();
  const [x0, x1] = x.range(), [y0, y1] = y.range();

  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${y0})`)
    .call(d3.axisBottom(x).ticks(6).tickSize(-(y0 - y1)).tickFormat(""));
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${x0},0)`)
    .call(d3.axisLeft(y).ticks(6).tickSize(-(x1 - x0)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${y0})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(tick).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${x0},0)`)
    .call(d3.axisLeft(y).ticks(6).tickFormat(tick).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", x1).attr("y", height - 6).attr("text-anchor", "end").text(label(mx));
  svg.append("text").attr("class", "axis-title").attr("transform", `translate(14,${y1}) rotate(-90)`)
    .attr("text-anchor", "end").text(label(my));

  if (!data.length) return;

  // y = x reference for pairs on the same scale (goals vs xG), only within the plotted area
  if (view.diagonal) {
    const top = Math.min(x.domain()[1], y.domain()[1]);
    svg.append("line").attr("class", "diagonal").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(top)).attr("y2", y(top));
    // Label sits on the line, partway up, so it doesn't collide with the corner labels
    const angle = Math.atan2(y(top) - y(0), x(top) - x(0)) * 180 / Math.PI;
    svg.append("text").attr("class", "quad-label").attr("text-anchor", "middle").attr("dy", -5)
      .attr("transform", `translate(${x(top * 0.6)},${y(top * 0.6)}) rotate(${angle})`).text(view.diagonal);
  }

  // Median split
  svg.append("line").attr("class", "median-line").attr("x1", x(xm)).attr("x2", x(xm)).attr("y1", y1).attr("y2", y0);
  svg.append("line").attr("class", "median-line").attr("x1", x0).attr("x2", x1).attr("y1", y(ym)).attr("y2", y(ym));

  const sel = selected();
  scatterDots = svg.append("g").selectAll("circle").data(data.filter(d => d.p !== sel)).join("circle")
    .attr("cx", d => x(d.x)).attr("cy", d => y(d.y)).attr("r", 4)
    .attr("fill", "var(--series-1)").attr("stroke", "var(--surface-1)").attr("stroke-width", 2);
  const selD = data.find(d => d.p === sel);
  if (selD) {
    svg.append("circle").attr("cx", x(selD.x)).attr("cy", y(selD.y)).attr("r", 6)
      .attr("fill", "var(--highlight)").attr("stroke", "var(--surface-1)").attr("stroke-width", 2);
  }

  // Quadrant names in the corners
  const corners = [["tl", x0 + 8, y1 + 14, "start"], ["tr", x1 - 8, y1 + 14, "end"],
                   ["bl", x0 + 8, y0 - 8, "start"], ["br", x1 - 8, y0 - 8, "end"]];
  svg.append("g").selectAll("text").data(corners).join("text").attr("class", "quad-label")
    .attr("x", d => d[1]).attr("y", d => d[2]).attr("text-anchor", d => d[3]).text(d => view.q[d[0]][0]);

  // Direct labels: the selected player plus the top 3 on Y
  const labelled = d3.sort(data, d => -d.y).slice(0, 3).filter(d => d !== selD);
  if (selD) labelled.push(selD);
  svg.append("g").selectAll("text").data(labelled).join("text")
    .attr("class", d => d === selD ? "label-strong halo" : "halo")
    .attr("x", d => x(d.x)).attr("y", d => y(d.y))
    .attr("dx", d => x(d.x) > width - 140 ? -9 : 9).attr("dy", "0.32em")
    .attr("text-anchor", d => x(d.x) > width - 140 ? "end" : "start")
    .text(d => d.p.name);

  // Nearest-point hover layer
  const delaunay = d3.Delaunay.from(data, d => x(d.x), d => y(d.y));
  const ring = svg.append("circle").attr("r", 7).attr("fill", "none")
    .attr("stroke", "var(--text-primary)").attr("stroke-width", 1.5).attr("visibility", "hidden");
  const nearest = event => {
    const [px, py] = d3.pointer(event);
    const d = data[delaunay.find(px, py)];
    return d && Math.hypot(x(d.x) - px, y(d.y) - py) < 30 ? d : null;
  };
  svg.append("rect").attr("x", x0).attr("y", y1).attr("width", x1 - x0).attr("height", y0 - y1).attr("fill", "transparent")
    .on("pointermove", event => {
      const d = nearest(event);
      event.target.classList.toggle("clickable", !!d);
      if (!d) { ring.attr("visibility", "hidden"); hideTip(); return; }
      ring.attr("cx", x(d.x)).attr("cy", y(d.y)).attr("visibility", "visible");
      showTip(event, `${d.p.name} · ${posShort(d.p)} · ${d.p.teams.join(" → ")}`, [
        [label(my), fmt(my, d.y)], [label(mx), fmt(mx, d.x)], ["Minutes", fmt(M.min, d.p.min)], ["Quadrant", view.q[d.q][0]],
      ]);
    })
    .on("pointerleave", () => { ring.attr("visibility", "hidden"); hideTip(); })
    .on("click", event => { const d = nearest(event); if (d) select(d.p); });
}

// The four blocks next to the scatter, laid out like the chart: top row = high Y, right column = high X.
function drawQuadrants(data, view, mx, my) {
  const xs = d3.extent(data, d => d.x), ys = d3.extent(data, d => d.y);
  const norm = (v, [a, b]) => (b > a ? (v - a) / (b - a) : 0);
  const blocks = ["tl", "tr", "bl", "br"].map(q => {
    const sy = q[0] === "t" ? 1 : -1, sx = q[1] === "r" ? 1 : -1;
    const inQ = data.filter(d => d.q === q);
    // Most extreme players first: furthest into the quadrant's corner
    const top = d3.sort(inQ, d => -(sx * norm(d.x, xs) + sy * norm(d.y, ys))).slice(0, 3);
    const b = el("div", "quad");
    b.append(
      el("div", "q-pos", `${sy > 0 ? "High" : "Low"} ${my.label} · ${sx > 0 ? "high" : "low"} ${mx.label}`),
      el("div", "q-name", view.q[q][0]),
      el("div", "q-count", `${inQ.length} player${inQ.length === 1 ? "" : "s"}`),
      el("div", "q-desc", view.q[q][1]),
      el("div", "q-top", top.length ? "e.g. " + top.map(d => d.p.name).join(", ") : ""),
    );
    b.addEventListener("mouseenter", () => scatterDots?.attr("opacity", d => d.q === q ? 1 : 0.15));
    b.addEventListener("mouseleave", () => scatterDots?.attr("opacity", 1));
    return b;
  });
  document.getElementById("quadrants").replaceChildren(...blocks);
}

// ---------- leaderboard ----------

function drawLeaderboard() {
  const m = M[state.lb];
  const data = d3.sort(
    filtered().map(p => ({ p, v: val(p, m) })).filter(d => d.v != null),
    d => (m.lowerBetter ? 1 : -1) * d.v,
  ).slice(0, 15);
  document.getElementById("lb-sub").textContent =
    `${label(m)}${m.lowerBetter ? " (lowest first)" : ""}, players with at least ${state.minMin} minutes.`;

  const rowH = 26, barH = 16;
  const height = data.length * rowH + 8;
  const { svg, width } = svgIn("leaderboard", height);
  const labelW = Math.min(170, width * 0.38), valueW = 56;
  const [lo, hi] = d3.extent(data, d => d.v);
  const x = d3.scaleLinear([Math.min(0, lo ?? 0), Math.max(0, hi ?? 1)], [labelW + 8, width - valueW]);
  const sel = selected();

  const rows = svg.selectAll("g").data(data).join("g").attr("transform", (d, i) => `translate(0,${i * rowH})`).attr("class", "clickable");
  rows.append("text").attr("x", labelW).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end")
    .attr("class", d => d.p === sel ? "label-strong" : null)
    .text(d => d.p.name + (d.p.switched ? " ⇄" : "")).call(truncate, labelW - 4);
  rows.append("path").attr("d", d => barPath(x(0), x(d.v), (rowH - barH) / 2, barH))
    .attr("fill", d => d.p === sel ? "var(--highlight)" : "var(--series-1)");
  rows.append("text").attr("x", d => x(Math.max(0, d.v)) + 6).attr("y", rowH / 2).attr("dy", "0.32em").text(d => fmt(m, d.v));
  rows.append("rect").attr("width", width).attr("height", rowH).attr("fill", "transparent")
    .on("pointermove", (event, d) => showTip(event, `${posShort(d.p)} · ${d.p.teams.join(" → ")}`,
      [[d.p.name, fmt(m, d.v)], ["Minutes", fmt(M.min, d.p.min)]]))
    .on("pointerleave", hideTip)
    .on("click", (event, d) => select(d.p));
  svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", height - 8).attr("stroke", "var(--axis)");
}

// ---------- profile ----------

function percentile(values, v, lowerBetter) {
  const below = values.filter(x => (lowerBetter ? x > v : x < v)).length;
  const equal = values.filter(x => x === v).length;
  return ((below + equal / 2) / values.length) * 100;
}

function drawProfile() {
  const p = selected();
  if (!p) return;
  document.getElementById("pr-name").textContent = p.name;
  document.getElementById("pr-sub").textContent =
    `${posLabel(p)} · ${p.teams.join(" → ")}` + (p.switched ? " ⇄ switched teams in this period" : "");

  const tiles = [
    ["Apps", p.apps], ["Minutes", fmt(M.min, p.min)], ["Avg rating", fmt(M.rating, p.rating)],
    ...(p.line === "GK"
      ? [["Saves", p.saves], ["Goals prevented", fmt(M.prevented, p.prevented, "total")]]
      : [["Goals", p.goals], ["Assists", p.assists], ["xG", fmt(M.xg, p.xg, "total")]]),
    ["Market value", fmt(M.value, p.value)],
  ];
  document.getElementById("pr-tiles").replaceChildren(...tiles.map(([k, v]) => {
    const t = el("div", "tile");
    t.append(el("div", "label", k), el("div", "value", v));
    return t;
  }));

  drawPercentiles(p);
  drawForm(p);
}

function drawPercentiles(p) {
  // Compare with the same detailed role when known, otherwise the same line
  const pool = AGG.filter(q => q.min >= state.minMin && (p.role ? q.role === p.role : q.line === p.line));
  const who = (p.role ? ROLES[p.role] : LINES[p.line])[1];
  document.getElementById("pct-sub").textContent =
    `Per 90 where it applies, vs ${pool.length} ${who} with at least ${state.minMin} minutes in this period` +
    (p.min < state.minMin ? `. ${p.name} is below that threshold, so treat these as rough.` : ".");

  const rows = PROFILE_METRICS[profileSet(p)].map(k => M[k]).map(m => {
    const v = val(p, m, "p90");
    const vals = pool.map(q => val(q, m, "p90")).filter(x => x != null);
    return { m, v, pct: v == null || !vals.length ? null : percentile(vals, v, m.lowerBetter) };
  });

  const rowH = 24, barH = 14;
  const { svg, width } = svgIn("percentiles", rows.length * rowH);
  const labelW = Math.min(190, width * 0.42), valueW = 40;
  const x = d3.scaleLinear([0, 100], [labelW + 8, width - valueW]);

  const g = svg.selectAll("g").data(rows).join("g").attr("transform", (d, i) => `translate(0,${i * rowH})`);
  g.append("text").attr("x", labelW).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end")
    .text(d => d.m.label + (d.m.lowerBetter ? " (fewer is better)" : "")).call(truncate, labelW - 4);
  g.append("rect").attr("x", x(0)).attr("y", (rowH - barH) / 2).attr("width", x(100) - x(0)).attr("height", barH)
    .attr("rx", 4).attr("fill", "var(--series-1-track)").attr("opacity", 0.45);
  g.filter(d => d.pct != null).append("path")
    .attr("d", d => barPath(x(0), x(Math.max(d.pct, 1)), (rowH - barH) / 2, barH)).attr("fill", "var(--series-1)");
  g.append("text").attr("class", "label-strong").attr("x", width - valueW + 8).attr("y", rowH / 2).attr("dy", "0.32em")
    .text(d => d.pct == null ? "–" : Math.round(d.pct));
  g.append("rect").attr("width", width).attr("height", rowH).attr("fill", "transparent")
    .on("pointermove", (event, d) => showTip(event, d.m.label, [
      ["Percentile", d.pct == null ? "–" : Math.round(d.pct)],
      [d.m.type === "count" ? "Per 90" : "Value", fmt(d.m, d.v, "p90")],
      ...(d.m.type === "count" ? [["Total", fmt(d.m, val(p, d.m, "total"), "total")]] : []),
    ]))
    .on("pointerleave", hideTip);
}

function drawForm(p) {
  const data = p.matches.filter(m => m.rating != null).map(m => ({ ...m, d: new Date(m.date) }));
  const height = 260;
  const { svg, width } = svgIn("form", height);
  const mg = { top: 20, right: 44, bottom: 28, left: 36 };
  const x = d3.scaleTime([new Date(state.from), new Date(state.to)], [mg.left, width - mg.right]);
  const y = d3.scaleLinear([Math.min(5, d3.min(data, d => d.rating) ?? 5), 10], [height - mg.bottom, mg.top]);

  svg.append("g").attr("class", "gridline").attr("transform", `translate(${mg.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(width - mg.left - mg.right)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - mg.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 90))).tickFormat(d3.timeFormat("%-d %b")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${mg.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));
  if (!data.length) return;

  // Mark the first match for each new team
  if (p.switched) {
    const firsts = p.teams.slice(1).map(t => p.matches.find(m => m.team === t));
    const g = svg.append("g").selectAll("g").data(firsts).join("g")
      .attr("transform", m => `translate(${x(new Date(m.date))},0)`);
    g.append("line").attr("y1", mg.top - 6).attr("y2", height - mg.bottom).attr("stroke", "var(--text-muted)");
    g.append("text").attr("class", "halo").attr("x", 4).attr("y", mg.top - 8).text(m => "→ " + m.team);
  }

  const avg = d3.mean(data, d => d.rating);
  svg.append("line").attr("x1", mg.left).attr("x2", width - mg.right).attr("y1", y(avg)).attr("y2", y(avg)).attr("stroke", "var(--text-muted)");
  svg.append("text").attr("x", width - mg.right + 4).attr("y", y(avg)).attr("dy", "0.32em").text(avg.toFixed(2));

  svg.append("path").datum(data).attr("d", d3.line(d => x(d.d), d => y(d.rating)))
    .attr("fill", "none").attr("stroke", "var(--series-1)").attr("stroke-width", 2)
    .attr("stroke-linejoin", "round").attr("stroke-linecap", "round");
  svg.append("g").selectAll("circle").data(data).join("circle")
    .attr("cx", d => x(d.d)).attr("cy", d => y(d.rating)).attr("r", 4)
    .attr("fill", "var(--series-1)").attr("stroke", "var(--surface-1)").attr("stroke-width", 2);

  // Crosshair snapping to the nearest match
  const cross = svg.append("line").attr("y1", mg.top).attr("y2", height - mg.bottom).attr("stroke", "var(--axis)").attr("visibility", "hidden");
  const focus = svg.append("circle").attr("r", 6).attr("fill", "var(--series-1)")
    .attr("stroke", "var(--surface-1)").attr("stroke-width", 2).attr("visibility", "hidden");
  const bisect = d3.bisector(d => d.d).center;
  svg.append("rect").attr("x", mg.left).attr("y", mg.top)
    .attr("width", width - mg.left - mg.right).attr("height", height - mg.top - mg.bottom).attr("fill", "transparent")
    .on("pointermove", event => {
      const d = data[bisect(data, x.invert(d3.pointer(event)[0]))];
      cross.attr("x1", x(d.d)).attr("x2", x(d.d)).attr("visibility", "visible");
      focus.attr("cx", x(d.d)).attr("cy", y(d.rating)).attr("visibility", "visible");
      const rows = [["Rating", d.rating.toFixed(2)], ["Minutes", d.min]];
      if (d.goals) rows.push(["Goals", d.goals]);
      if (d.assists) rows.push(["Assists", d.assists]);
      showTip(event, `${fmtDate(d.date)} · ${p.switched ? d.team + " " : ""}vs ${d.opp}`, rows);
    })
    .on("pointerleave", () => { cross.attr("visibility", "hidden"); focus.attr("visibility", "hidden"); hideTip(); });
}

// ---------- table ----------

function drawTable() {
  const cols = [
    { key: "name", label: "Player", get: p => p.name, f: (v, p) => v + (p.switched ? " ⇄" : ""), text: true },
    { key: "team", label: "Team", get: p => p.teams.join(" → "), text: true },
    { key: "pos", label: "Pos", get: p => posShort(p), text: true },
    { key: "apps", label: "Apps", get: p => p.apps, f: v => v },
    { key: "min", label: "Min", get: p => p.min, f: v => fmt(M.min, v) },
    ...(group() === "gk" ? ["saves", "conceded", "prevented", "pass_pct"] : ["goals", "assists", "xg", "xa", "shots", "chances"])
      .map(k => ({ key: k, label: M[k].type === "count" && state.mode === "p90" ? `${M[k].label} /90` : M[k].label,
                   get: p => val(p, M[k]), f: v => fmt(M[k], v) })),
    { key: "rating", label: "Rating", get: p => p.rating, f: v => fmt(M.rating, v) },
    { key: "value", label: "Value", get: p => p.value, f: v => fmt(M.value, v) },
  ];
  if (!cols.some(c => c.key === state.sort.key)) state.sort = { key: "min", desc: true };
  const col = cols.find(c => c.key === state.sort.key);
  const rows = d3.sort(filtered(), (a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = col.text ? va.localeCompare(vb) : va - vb;
    return state.sort.desc ? -c : c;
  });

  const thead = document.createElement("thead");
  const hr = thead.insertRow();
  for (const c of cols) {
    const th = el("th", c.key === state.sort.key ? "sorted" : null, c.label);
    th.addEventListener("click", () => {
      state.sort = { key: c.key, desc: c.key === state.sort.key ? !state.sort.desc : !c.text };
      drawTable();
    });
    hr.append(th);
  }
  const tbody = document.createElement("tbody");
  const sel = selected();
  for (const p of rows) {
    const tr = tbody.insertRow();
    if (p === sel) tr.className = "selected";
    for (const c of cols) tr.insertCell().textContent = c.f ? c.f(c.get(p), p) : c.get(p);
    tr.addEventListener("click", () => {
      select(p);
      document.getElementById("profile").scrollIntoView({ behavior: "smooth" });
    });
  }
  document.getElementById("table").replaceChildren(thead, tbody);
}

// ---------- controls ----------

function fillSelect(id, options, value) {
  document.getElementById(id).replaceChildren(...options.map(([v, text]) => new Option(text, v, false, String(v) === String(value))));
}

// After X or Y changes by hand: switch to the view with that pair, or to Custom
function matchView() {
  state.view = VIEWS.find(v => v.group === group() && v.x === state.x && v.y === state.y)?.id ?? "custom";
}

function applyView(id) {
  const v = VIEWS.find(v => v.id === id);
  state.view = id;
  if (v) { state.x = v.x; state.y = v.y; }
}

function syncControls() {
  const g = group();
  const ms = metricsFor(g), keys = ms.map(m => m.key);
  if (state.view !== "custom" && VIEWS.find(v => v.id === state.view)?.group !== g) applyView(VIEWS.find(v => v.group === g).id);
  if (!keys.includes(state.x) || !keys.includes(state.y)) applyView(VIEWS.find(v => v.group === g).id);
  if (!keys.includes(state.lb)) state.lb = g === "gk" ? "prevented" : "goals";

  fillSelect("ex-view", [...VIEWS.filter(v => v.group === g).map(v => [v.id, v.name]), ["custom", "Custom (pick X and Y)"]], state.view);
  const opts = ms.map(m => [m.key, label(m)]);
  fillSelect("sc-x", opts, state.x);
  fillSelect("sc-y", opts, state.y);
  fillSelect("lb-metric", opts.filter(([k]) => k !== "min"), state.lb);
  fillSelect("f-min", MIN_OPTIONS.map(v => [v, d3.format(",")(v)]), state.minMin);
  fillSelect("f-season", [...seasons.map(s => [s.id, s.label]), ["all", "All seasons"], ["custom", "Custom range"]], state.season);
  document.getElementById("f-from").value = state.from;
  document.getElementById("f-to").value = state.to;

  const teams = [...new Set(AGG.map(p => p.teams).flat())].sort();
  if (state.team && !teams.includes(state.team)) state.team = "";
  fillSelect("f-team", [["", "All teams"], ...teams.map(t => [t, t])], state.team);

  document.getElementById("pr-list").replaceChildren(
    ...d3.sort(AGG, p => p.name).map(p => new Option(`${p.name} (${p.teams.join(" → ")})`)));
}

// Re-aggregate after the date range changes
function updateRange() {
  AGG = aggregate(state.from, state.to);
  if (!state.minManual) {
    // Default threshold: about a third of the most minutes anyone played in the period
    const most = d3.max(AGG, p => p.min) ?? 0;
    state.minMin = d3.max(MIN_OPTIONS.filter(v => v <= most * 0.35)) ?? 0;
  }
  syncControls();
}

function render() {
  if (!selected()) {
    const pool = filtered();
    const best = d3.greatest(pool, p => group() === "gk" ? p.prevented : p.goals) ?? d3.greatest(AGG, p => p.min);
    state.selectedId = best?.id ?? null;
  }
  const nMatches = new Set(ROWS.filter(r => r[C.date] >= state.from && r[C.date] <= state.to).map(r => r[C.date] + r[C.team])).size / 2;
  document.getElementById("meta").textContent =
    `${meta.league} · ${fmtDate(state.from)} to ${fmtDate(state.to)} · ${Math.round(nMatches)} matches · ` +
    `data up to ${fmtDate(allEnd)} · source: FotMob`;
  drawExplorer();
  drawLeaderboard();
  drawProfile();
  drawTable();
}

function init() {
  const dateInputs = ["f-from", "f-to"].map(id => document.getElementById(id));
  for (const input of dateInputs) { input.min = allStart; input.max = allEnd; }

  const on = (id, fn) => document.getElementById(id).addEventListener("change", e => { fn(e.target.value); render(); });
  on("f-season", v => {
    state.season = v;
    if (v === "custom") return;
    const s = seasons.find(s => s.id === v);
    [state.from, state.to] = s ? [s.start, s.end] : [allStart, allEnd];
    updateRange();
  });
  const onDate = () => {
    let [from, to] = dateInputs.map(i => i.value || null);
    if (!from || !to) return;
    if (from > to) [from, to] = [to, from];
    Object.assign(state, { from, to });
    state.season = seasons.find(s => s.start === from && s.end === to)?.id ?? (from === allStart && to === allEnd ? "all" : "custom");
    updateRange();
  };
  on("f-from", onDate);
  on("f-to", onDate);
  on("f-pos", v => { state.pos = v; syncControls(); });
  on("f-team", v => { state.team = v; });
  on("f-min", v => { state.minMin = +v; state.minManual = true; });
  on("f-mode", v => { state.mode = v; syncControls(); });
  on("ex-view", v => { applyView(v); syncControls(); });
  on("sc-x", v => { state.x = v; matchView(); syncControls(); });
  on("sc-y", v => { state.y = v; matchView(); syncControls(); });
  on("lb-metric", v => { state.lb = v; });

  document.getElementById("pr-search").addEventListener("change", e => {
    const p = AGG.find(p => `${p.name} (${p.teams.join(" → ")})` === e.target.value);
    if (p) { select(p); e.target.value = ""; }
  });

  fillSelect("f-pos", POS_OPTIONS, state.pos);
  updateRange();
  render();

  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w !== lastWidth) { lastWidth = w; render(); }
  }).observe(document.querySelector("main"));
}

init();
