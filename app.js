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

// Plain-language definitions, shown behind the ⓘ buttons, in percentile tooltips and on table headers
const INFO = {
  goals: "Goals scored.",
  assists: "The last pass before a teammate scored.",
  ga: "Goals plus assists.",
  xg: "Expected goals: each shot gets the probability that an average player scores from that position and situation, and these are added up. Measures the quality of chances a player gets, separate from his finishing.",
  npxg: "Expected goals without penalties, so regular penalty takers don't look more dangerous than they are.",
  gmxg: "Goals minus xG. Positive: he scored more than his chances suggest (good finishing, or luck over a short period).",
  xa: "Expected assists: the xG of the shots that came directly from his passes. Measures chance creation whether or not the teammate scored.",
  shots: "Shots, on target or not, including blocked shots.",
  sot: "Shots that would have gone in without the keeper's save.",
  xg_shot: "Average xG per shot. High means he shoots from good positions; low means many long-range or difficult shots.",
  chances: "Passes that led directly to a teammate's shot (key passes).",
  bigchances: "Passes that set up a big chance: a situation where a goal is reasonably expected, such as one-on-one with the keeper.",
  boxtouches: "Touches of the ball inside the opponent's penalty area.",
  dribbles: "Times he took the ball past an opponent.",
  dribble_pct: "Successful dribbles as a share of attempted dribbles.",
  final3rd: "Completed passes that end in the attacking third of the pitch.",
  passes: "Completed passes.",
  pass_pct: "Completed passes as a share of all passes.",
  longballs: "Completed long passes.",
  longball_pct: "Completed long passes as a share of all long passes.",
  crosses: "Completed crosses into the box.",
  tackles: "Tackles made.",
  interceptions: "Opponent passes he cut out.",
  recoveries: "Times he won back a loose ball.",
  clearances: "Times he cleared the ball away from danger.",
  blocks: "Shots, crosses or passes he blocked.",
  duels: "One-on-one contests for the ball won, on the ground and in the air.",
  aerials: "Headers contested against an opponent and won.",
  aerial_pct: "Aerial duels won as a share of all aerial duels.",
  saves: "Shots on target he stopped.",
  conceded: "Goals conceded while he was on the pitch.",
  xgot_faced: "Expected goals on target faced: for each shot on target, the chance it goes in based on where it was placed. Measures how hard the shots he faced were.",
  prevented: "xGOT faced minus goals conceded. Positive: he stopped more than an average keeper would have.",
  rating: "FotMob's match rating from 0 to 10, calculated from all his stats in the match, averaged over his matches.",
  value: "Transfer market value as shown by FotMob; the latest value in the selected period.",
  min: "Minutes played.",
};
const PER90_NOTE = "Per 90: the total divided by minutes played, times 90, so players with different playing time can be compared.";
const metricInfo = (m, mode = state.mode) => INFO[m.key] + (m.type === "count" && mode === "p90" ? " " + PER90_NOTE : "");

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
  pos: "out", team: "", minMin: 0, minManual: false, mode: "p90", cmp: "role",
  view: "finishing", x: "xg", y: "goals", lb: "goals", selectedId: null, compareId: null,
  vrGrade: "AB", vrAge: 99, sort: { key: "min", desc: true },
};
const DEFAULTS = structuredClone(state); // the URL only stores what differs from these
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
const compared = () => AGG.find(p => p.id === state.compareId && p.id !== state.selectedId);
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

function showTip(event, title, rows, note) {
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
  if (note) tip.append(el("div", "tt-note", note)); // a definition below the values
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
  if (state.compareId === p.id) state.compareId = null; // comparing a player with himself makes no sense
  render();
}

// Open a player's profile and scroll to it (search box, value list, table rows)
function openProfile(p) {
  select(p);
  document.getElementById("profile").scrollIntoView({ behavior: "smooth" });
}

// The search boxes show "Name (Team)"; this finds the player behind such a label
const playerLabel = p => `${p.name} (${p.teams.join(" → ")})`;
const playerByLabel = text => AGG.find(p => playerLabel(p) === text);

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

  const data = filtered().map(p => ({ p, x: val(p, mx), y: val(p, my) }))
    .filter(d => d.x != null && d.y != null && !(mx.key === "value" && d.x <= 0) && !(my.key === "value" && d.y <= 0));
  const xm = d3.median(data, d => d.x), ym = d3.median(data, d => d.y);
  for (const d of data) d.q = (d.y > ym ? "t" : "b") + (d.x > xm ? "r" : "l");

  drawScatter(data, xm, ym, view, mx, my);
  drawQuadrants(data, view, mx, my);
}

const VALUE_TICKS = [1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8];

// Market value spans €100k to €30M+, so it gets a log axis. Only summable stats start at zero;
// for ratings and percentages zero means nothing and would squeeze every dot into a thin band.
function axisScale(m, values, range) {
  const [a, b] = d3.extent(values);
  if (m.key === "value" && a > 0) return d3.scaleLog([a * 0.8, b * 1.25], range);
  if (m.type === "count" || m.type === "ratio") return d3.scaleLinear([Math.min(0, a ?? 0), b ?? 1], range).nice();
  const pad = ((b ?? 1) - (a ?? 0)) * 0.05;
  return d3.scaleLinear([(a ?? 0) - pad, (b ?? 1) + pad], range).nice();
}
const axisTicks = s => s.base ? VALUE_TICKS.filter(v => v >= s.domain()[0] && v <= s.domain()[1]) : s.ticks(6);
const axisFormat = m => m.key === "value" ? v => fmt(M.value, v) : tick;

function drawScatter(data, xm, ym, view, mx, my) {
  const height = 460;
  const { svg, width } = svgIn("scatter", height);
  const mg = { top: 12, right: 24, bottom: 44, left: 60 };
  const x = axisScale(mx, data.map(d => d.x), [mg.left, width - mg.right]);
  const y = axisScale(my, data.map(d => d.y), [height - mg.bottom, mg.top]);
  const [x0, x1] = x.range(), [y0, y1] = y.range();

  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${y0})`)
    .call(d3.axisBottom(x).tickValues(axisTicks(x)).tickSize(-(y0 - y1)).tickFormat(""));
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${x0},0)`)
    .call(d3.axisLeft(y).tickValues(axisTicks(y)).tickSize(-(x1 - x0)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${y0})`)
    .call(d3.axisBottom(x).tickValues(axisTicks(x)).tickFormat(axisFormat(mx)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${x0},0)`)
    .call(d3.axisLeft(y).tickValues(axisTicks(y)).tickFormat(axisFormat(my)).tickSizeOuter(0));
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

// ---------- value rating ----------

const RATINGS = window.RATINGS ?? { meta: null, rows: [] };
const ratingOf = new Map(RATINGS.rows.map(r => [`${r.id}|${r.season}`, r]));
const GRADES = { A: "very undervalued", B: "undervalued", C: "fairly valued or expensive" };
const FEATURE_SHORT = {
  npxg90: "npxG", xa90: "xA", final3rd90: "final-third passes", dribbles90: "dribbles", def90: "tackles + interceptions",
  aerials90: "aerial duels won", passes90: "passes", pass_pct: "pass accuracy", rating: "FotMob rating",
  min_share: "playing time", age: "age", team_ppg: "team results", dutch: "Dutch nationality",
  team_value: "club reputation", prev_rating: "last season's rating", prev_min_share: "last season's playing time",
  has_prev: "Eredivisie experience",
};

// Ratings are per full season: show every season that overlaps the selected range, latest first
const ratingSeasons = () => seasons.filter(s => s.start <= state.to && s.end >= state.from).map(s => s.id);
const ratingsFor = p => ratingSeasons().map(s => ratingOf.get(`${p.id}|${s}`)).filter(Boolean);
const seasonLabel = id => seasons.find(s => s.id === id).label;

function fmtFeature(f, v) {
  if (v == null) return "–";
  if (f === "pass_pct") return v.toFixed(0) + "%";
  if (f === "min_share" || f === "prev_min_share") return (v * 100).toFixed(0) + "% of minutes";
  if (f === "age") return v.toFixed(0);
  if (f === "dutch" || f === "has_prev") return v ? "yes" : "no";
  if (f === "team_value") return fmt(M.value, Math.exp(v)); // stored as log value

  return v.toFixed(2);
}

function ratingSummary(r) {
  const strong = r.reasons.filter(x => x.effect > 0 && !x.context && x.pct >= 50).slice(0, 2).map(x => FEATURE_SHORT[x.feature]);
  const role = ROLES[r.role][0].toLowerCase();
  const lead = strong.length ? `High ${strong.join(" and ")} for a ${role}` : `Profile of a ${role}`;
  const capped = r.too_old
    ? ` Undervalued on performance, but A and B require age ${RATINGS.meta.max_age} or younger: after that, values rarely rise (he's ${r.age}).`
    : "";
  return `${lead}, valued at ${fmt(M.value, r.value)}, model expects ${fmt(M.value, r.expected)} (${r.gap.toFixed(1)}×).${capped}`;
}

function reasonLine(r, x) {
  const where = x.context ? "" : ` (${x.pct >= 50 ? "top " + Math.max(1, 100 - x.pct) : "bottom " + Math.max(1, x.pct)}% of ${ROLES[r.role][1]})`;
  const sign = x.effect >= 0 ? "+" : "−";
  return `${x.label}: ${fmtFeature(x.feature, x.value)}${where} → ${sign}${fmt(M.value, Math.abs(x.effect))} on expected value`;
}

function gradeBadge(g) {
  return el("span", `grade ${g}`, g);
}

function drawValue() {
  const card = document.getElementById("value-card");
  const inRange = ratingSeasons();
  card.hidden = !RATINGS.meta || !inRange.length;
  if (card.hidden) return;
  const m = RATINGS.meta;
  const multi = inRange.length > 1;

  if (group() === "gk") {
    document.getElementById("vr-sub").textContent = "The value rating covers outfield players only; there are too few keepers to train a model on.";
    for (const id of ["vr-legend", "value-chart", "vr-list"]) document.getElementById(id).replaceChildren();
    return;
  }
  const byId = new Map(AGG.map(p => [p.id, p]));
  const data = RATINGS.rows
    .filter(r => inRange.includes(r.season))
    .map(r => ({ r, p: byId.get(r.id), name: byId.get(r.id)?.name + (multi ? ` (${seasonLabel(r.season)})` : "") }))
    .filter(d => d.p && posMatch(d.p, state.pos) && (!state.team || d.p.teams.includes(state.team)));

  document.getElementById("vr-sub").textContent =
    `${inRange.map(seasonLabel).join(" and ")} · ${data.length} ${multi ? "player-seasons" : "players"} with enough minutes · ` +
    `${m.model}, out-of-fold R² ${m.r2} on log value, typical error ×${m.mae_factor}` +
    (state.season === "custom" ? ". Ratings cover full seasons, so dates inside a season don't change them." : "");

  document.getElementById("vr-legend").replaceChildren(...["A", "B", "C"].map(g => {
    const s = el("span");
    const key = el("span", "key");
    key.style.background = `var(--grade-${g.toLowerCase()})`;
    s.append(key, `${g} · ${GRADES[g]} (${data.filter(d => d.r.grade === g).length})`);
    return s;
  }));

  drawValueChart(data);

  // A before B, each by biggest gap, so players capped at B for age don't push the A grades down
  const list = d3.sort(
    data.filter(d => d.r.grade !== "C" && state.vrGrade.includes(d.r.grade) && (d.r.age ?? 0) <= state.vrAge),
    d => d.r.grade, d => -d.r.gap,
  ).slice(0, 25);
  document.getElementById("vr-list").replaceChildren(...(list.length ? list.map(({ r, p, name }) => {
    const li = el("li");
    const body = el("div");
    body.append(el("div", "who", `${name} · ${r.role} · ${p.teams.join(" → ")}`), el("div", "what", ratingSummary(r)));
    li.append(gradeBadge(r.grade), body);
    li.addEventListener("click", () => openProfile(p));
    return li;
  }) : [el("li", null, "No players match these filters.")]));

  const roseText = (label, s) => `${label} ${s.rose}% rose (${s.lo}-${s.hi}%, n=${s.n})`;
  const method = document.getElementById("vr-method");
  method.replaceChildren(el("p", null,
    `A model predicts each player's market value from performance and context, then compares that with his actual value.`));
  const ul = el("ul");
  for (const t of [
    `Grade A: expected value at least ${m.a_gap}× the actual value. B: at least ${m.b_gap}×. Both also need a FotMob rating at or above the median ` +
      `for his position and an age of ${m.max_age} or younger. C: the rest. These rules come from a backtest: they're the ones that predicted a player's value rising.`,
    ...(m.backtest.out_of_sample ? [
      `Backtest on a season the rules never saw (for each season, the rules were chosen on the other one), value change in the ${m.horizon_days} days after the season, ` +
        `following players wherever they went: ` +
        ["A", "B", "C"].map(g => roseText(g, m.backtest.out_of_sample[g])).join(", ") +
        `. For comparison, ${roseText("of all players who pass the same age and rating filters, whatever their gap,", m.backtest.out_of_sample.baseline)}. ` +
        `The ranges are 95% intervals: with this few players, A and B are estimates, not certainties.`] : []),
    `Price matters: among the cheapest third, A/B players rose ${m.backtest.by_price.cheap.ab.rose}% of the time against ${m.backtest.by_price.cheap.c.rose}% for C; ` +
      `among the most expensive third, ${m.backtest.by_price.expensive.ab.rose}% against ${m.backtest.by_price.expensive.c.rose}%. The model helps most for cheaper players.`,
    `Forward test, trained only on earlier seasons: ` +
      Object.entries(m.forward).map(([s, f]) => `${seasonLabel(s)} R² ${f.r2}` + (f.backtest_corr !== null ? ` (gap vs later value change: ${f.backtest_corr > 0 ? "+" : ""}${f.backtest_corr})` : "")).join(", ") + `.`,
    `Market values: ${m.value_source === "transfermarkt" ? "Transfermarkt" : "SciSports (via FotMob)"}. ` +
      `Transfermarkt values were also tested: they're explained slightly better, but the gap predicted their later change much worse.`,
    `Features: ${m.features.join(", ")}, plus position.`,
    `Per-90 stats and rating are pulled towards the position average, more strongly for players with fewer minutes: ` +
      `a player's own numbers count for minutes / (minutes + ${m.shrink_minutes}), so half at ${m.shrink_minutes} minutes and about 86% over a full season. ` +
      `This stops a good spell of a few matches from producing a big gap. The reasons show the player's actual numbers.`,
    `Trained on ${m.n} player-seasons from ${m.seasons.length} seasons (${m.seasons.map(seasonLabel).join(", ")}). Every prediction is out-of-fold: the model that predicts a player never saw any of his seasons.`,
    `Model comparison: ${Object.entries(m.comparison).map(([n, c]) => `${n} R² ${c.r2}`).join(", ")}. A tree model only replaces the linear one when it's at least 0.02 better, ` +
      `because tree models can't extrapolate beyond the prices they've seen. The chosen model is calibrated so predictions aren't squeezed towards the average price.`,
    `Share of A grades by expected value: ${Object.entries(m.a_share_by_expected).map(([b, v]) => `${b} ${v}%`).join(", ")}. By actual price: ${Object.entries(m.a_share_by_price).map(([b, v]) => `${b} ${v}%`).join(", ")}. Cheap players get more A grades partly by construction: with a typical error of ×${m.mae_factor}, some cheap players look undervalued through noise alone.`,
    `Market value doesn't capture everything: contract length and injuries aren't in the model, and they explain part of every gap.`,
  ]) ul.append(el("li", null, t));
  method.append(ul);
}

function drawValueChart(data) {
  const height = 420;
  const { svg, width } = svgIn("value-chart", height);
  const mg = { top: 12, right: 24, bottom: 44, left: 60 };
  if (!data.length) return;
  const all = data.flatMap(d => [d.r.value, d.r.expected]);
  const dom = [d3.min(all) * 0.8, d3.max(all) * 1.25];
  const x = d3.scaleLog(dom, [mg.left, width - mg.right]);
  const y = d3.scaleLog(dom, [height - mg.bottom, mg.top]);
  const [x0, x1] = x.range(), [y0, y1] = y.range();
  const ticks = [1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8].filter(v => v >= dom[0] && v <= dom[1]);
  const eur = v => fmt(M.value, v);

  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${y0})`)
    .call(d3.axisBottom(x).tickValues(ticks).tickSize(-(y0 - y1)).tickFormat(""));
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${x0},0)`)
    .call(d3.axisLeft(y).tickValues(ticks).tickSize(-(x1 - x0)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${y0})`)
    .call(d3.axisBottom(x).tickValues(ticks).tickFormat(eur).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${x0},0)`)
    .call(d3.axisLeft(y).tickValues(ticks).tickFormat(eur).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", x1).attr("y", height - 6).attr("text-anchor", "end").text("Actual market value");
  svg.append("text").attr("class", "axis-title").attr("transform", `translate(14,${y1}) rotate(-90)`).attr("text-anchor", "end").text("Expected value (model)");

  // Reference lines: fair value and the A threshold
  for (const [k, text, cls] of [[1, "fair value", "diagonal"], [RATINGS.meta.a_gap, `${RATINGS.meta.a_gap}× expected`, "median-line"]]) {
    const lo = Math.max(dom[0], dom[0] / k), hi = Math.min(dom[1], dom[1] / k);
    svg.append("line").attr("class", cls).attr("x1", x(lo)).attr("y1", y(lo * k)).attr("x2", x(hi)).attr("y2", y(hi * k));
    const angle = Math.atan2(y(hi * k) - y(lo * k), x(hi) - x(lo)) * 180 / Math.PI;
    const at = Math.sqrt(lo * hi) * (k === 1 ? 4 : 0.25); // fair value label upper right, threshold label lower left
    svg.append("text").attr("class", "quad-label").attr("text-anchor", "middle").attr("dy", -5)
      .attr("transform", `translate(${x(at)},${y(at * k)}) rotate(${angle})`).text(text);
  }
  svg.append("text").attr("class", "quad-label").attr("x", x0 + 8).attr("y", y1 + 14).text("Undervalued ↖");
  svg.append("text").attr("class", "quad-label").attr("x", x1 - 8).attr("y", y0 - 8).attr("text-anchor", "end").text("↘ Expensive");

  const sel = selected();
  // Draw C first so A and B sit on top
  const order = { C: 0, B: 1, A: 2 };
  svg.append("g").selectAll("circle").data(d3.sort(data.filter(d => d.p !== sel), d => order[d.r.grade])).join("circle")
    .attr("cx", d => x(d.r.value)).attr("cy", d => y(d.r.expected)).attr("r", 4)
    .attr("fill", d => `var(--grade-${d.r.grade.toLowerCase()})`).attr("stroke", "var(--surface-1)").attr("stroke-width", 2);
  // The selected player can appear once per season
  const selDs = data.filter(d => d.p === sel);
  svg.append("g").selectAll("circle").data(selDs).join("circle")
    .attr("cx", d => x(d.r.value)).attr("cy", d => y(d.r.expected)).attr("r", 6)
    .attr("fill", "var(--highlight)").attr("stroke", "var(--surface-1)").attr("stroke-width", 2);
  // With several seasons the top A grades crowd together, so then only the selected player is labelled
  const topA = data.length > 300 ? [] : d3.sort(data.filter(d => d.r.grade === "A" && d.p !== sel), d => -d.r.gap).slice(0, 3);
  const labelled = [...topA, ...selDs];
  svg.append("g").selectAll("text").data(labelled).join("text")
    .attr("class", d => d.p === sel ? "label-strong halo" : "halo")
    .attr("x", d => x(d.r.value)).attr("y", d => y(d.r.expected)).attr("dx", 9).attr("dy", "0.32em").text(d => d.name);

  const delaunay = d3.Delaunay.from(data, d => x(d.r.value), d => y(d.r.expected));
  const ring = svg.append("circle").attr("r", 7).attr("fill", "none").attr("stroke", "var(--text-primary)").attr("stroke-width", 1.5).attr("visibility", "hidden");
  const nearest = event => {
    const [px, py] = d3.pointer(event);
    const d = data[delaunay.find(px, py)];
    return d && Math.hypot(x(d.r.value) - px, y(d.r.expected) - py) < 30 ? d : null;
  };
  svg.append("rect").attr("x", x0).attr("y", y1).attr("width", x1 - x0).attr("height", y0 - y1).attr("fill", "transparent")
    .on("pointermove", event => {
      const d = nearest(event);
      event.target.classList.toggle("clickable", !!d);
      if (!d) { ring.attr("visibility", "hidden"); hideTip(); return; }
      ring.attr("cx", x(d.r.value)).attr("cy", y(d.r.expected)).attr("visibility", "visible");
      showTip(event, `${d.name} · ${d.r.role} · ${d.p.teams.join(" → ")}`, [
        ["Grade", `${d.r.grade} · ${GRADES[d.r.grade]}`], ["Actual value", eur(d.r.value)],
        ["Expected value", eur(d.r.expected)], ["Gap", d.r.gap.toFixed(2) + "×"],
      ]);
    })
    .on("pointerleave", () => { ring.attr("visibility", "hidden"); hideTip(); })
    .on("click", event => { const d = nearest(event); if (d) select(d.p); });
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

// One player: blue, like every single-series chart. Two players: the selected one is orange, matching his
// highlight in the explorer, value chart and Top 15, and the compared player blue (the two validated slots).
let PLAYER_COLORS = ["var(--series-1)"];

function percentile(values, v, lowerBetter) {
  const below = values.filter(x => (lowerBetter ? x > v : x < v)).length;
  const equal = values.filter(x => x === v).length;
  return ((below + equal / 2) / values.length) * 100;
}

function colorKey(i, line) {
  const k = el("span", line ? "key line" : "key");
  k.style.background = PLAYER_COLORS[i];
  return k;
}

// Legend for two players; empty for one (the card title already names him)
function playerLegend(id, players, line) {
  document.getElementById(id).replaceChildren(...(players.length > 1 ? players.map((q, i) => {
    const s = el("span");
    s.append(colorKey(i, line), q.name);
    return s;
  }) : []));
}

function drawProfile() {
  const p = selected();
  if (!p) return;
  const q = compared();
  const players = q ? [p, q] : [p];
  PLAYER_COLORS = q ? ["var(--series-2)", "var(--series-1)"] : ["var(--series-1)"];
  document.getElementById("pr-name").textContent = q ? `${p.name} vs ${q.name}` : p.name;
  document.getElementById("pr-vs-clear").hidden = !q;
  const describe = x => `${posLabel(x)} · ${x.teams.join(" → ")}` + (x.switched ? " ⇄ switched teams in this period" : "");
  document.getElementById("pr-sub").textContent = q ? "" : describe(p);

  // One row of tiles per player; with two players each row starts with his color and name
  document.getElementById("pr-tiles").replaceChildren(...players.map((x, i) => {
    const row = el("div", "tile-row");
    if (q) {
      const who = el("div", "who");
      who.append(colorKey(i), `${x.name} · ${describe(x)}`);
      row.append(who);
    }
    const tiles = el("div", "tiles");
    tiles.append(...[
      ["Apps", x.apps], ["Minutes", fmt(M.min, x.min)], ["Avg rating", fmt(M.rating, x.rating)],
      ...(x.line === "GK"
        ? [["Saves", x.saves], ["Goals prevented", fmt(M.prevented, x.prevented, "total")]]
        : [["Goals", x.goals], ["Assists", x.assists], ["xG", fmt(M.xg, x.xg, "total")]]),
      ["Market value", fmt(M.value, x.value)],
    ].map(([k, v]) => {
      const t = el("div", "tile");
      t.append(el("div", "label", k), el("div", "value", v));
      return t;
    }));
    row.append(tiles);
    return row;
  }));

  // Value rating per player and season
  document.getElementById("pr-why").replaceChildren(...players.flatMap(x => {
    const rs = ratingsFor(x);
    return rs.map(r => {
      const block = el("div", "why");
      const text = el("div");
      const season = rs.length > 1 ? ` ${seasonLabel(r.season)}` : "";
      text.append(el("div", "summary", `${q ? x.name + ": v" : "V"}alue rating${season} ${r.grade} (${GRADES[r.grade]}): ${ratingSummary(r)}`));
      const ul = el("ul");
      for (const reason of r.reasons) ul.append(el("li", null, reasonLine(r, reason)));
      text.append(ul);
      block.append(gradeBadge(r.grade), text);
      return block;
    });
  }));

  drawPercentiles(players);
  drawForm(players);
}

// Comparison group for one player: same detailed role (or line when the role is unknown), same line, or all
// outfield players. Keepers are always compared with keepers.
function comparisonPool(x) {
  const cmp = x.line === "GK" ? "line" : state.cmp;
  const same = { role: o => x.role ? o.role === x.role : o.line === x.line, line: o => o.line === x.line, out: o => o.line !== "GK" }[cmp];
  const who = cmp === "out" ? "outfield players" : (cmp === "role" && x.role ? ROLES[x.role] : LINES[x.line])[1];
  return { pool: AGG.filter(o => o.min >= state.minMin && same(o)), who };
}

function drawPercentiles(players) {
  const [p] = players;
  document.getElementById("pr-cmp").disabled = players.every(x => x.line === "GK");
  const groups = players.map(comparisonPool);
  const below = players.filter(x => x.min < state.minMin).map(x => x.name);
  const against = groups.length > 1 && groups[0].who !== groups[1].who
    ? players.map((x, i) => `${x.name} vs ${groups[i].pool.length} ${groups[i].who}`).join(", ")
    : `vs ${groups[0].pool.length} ${groups[0].who}`;
  document.getElementById("pct-sub").textContent =
    `Per 90 where it applies, ${against} with at least ${state.minMin} minutes in this period` +
    (below.length ? `. ${below.join(" and ")} ${below.length > 1 ? "are" : "is"} below that threshold, so treat these as rough.` : ".");
  playerLegend("pct-legend", players, false);

  // The metric list follows the first player's position
  const rows = PROFILE_METRICS[profileSet(p)].map(k => M[k]).map(m => ({
    m,
    bars: players.map((x, i) => {
      const v = val(x, m, "p90");
      const vals = groups[i].pool.map(o => val(o, m, "p90")).filter(o => o != null);
      return { x, v, pct: v == null || !vals.length ? null : percentile(vals, v, m.lowerBetter) };
    }),
  }));

  const n = players.length;
  const rowH = n > 1 ? 34 : 24, barH = n > 1 ? 11 : 14, gap = 2;
  const { svg, width } = svgIn("percentiles", rows.length * rowH);
  const labelW = Math.min(190, width * 0.42), valueW = 40;
  const x = d3.scaleLinear([0, 100], [labelW + 8, width - valueW]);
  const barY = i => (rowH - (n * barH + (n - 1) * gap)) / 2 + i * (barH + gap); // bars stacked within the row

  const g = svg.selectAll("g").data(rows).join("g").attr("transform", (d, i) => `translate(0,${i * rowH})`);
  g.append("text").attr("x", labelW).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end")
    .text(d => d.m.label + (d.m.lowerBetter ? " (fewer is better)" : "")).call(truncate, labelW - 4);
  const bar = g.selectAll("g.bar").data(d => d.bars.map((b, i) => ({ ...b, i }))).join("g").attr("class", "bar");
  bar.append("rect").attr("x", x(0)).attr("y", b => barY(b.i)).attr("width", x(100) - x(0)).attr("height", barH)
    .attr("rx", 4).attr("fill", "var(--series-1-track)").attr("opacity", 0.45);
  bar.filter(b => b.pct != null).append("path")
    .attr("d", b => barPath(x(0), x(Math.max(b.pct, 1)), barY(b.i), barH)).attr("fill", b => PLAYER_COLORS[b.i]);
  bar.append("text").attr("class", "label-strong").attr("x", width - valueW + 8).attr("y", b => barY(b.i) + barH / 2).attr("dy", "0.32em")
    .style("font-size", n > 1 ? "11px" : null).text(b => b.pct == null ? "–" : Math.round(b.pct));
  g.append("rect").attr("width", width).attr("height", rowH).attr("fill", "transparent")
    .on("pointermove", (event, d) => showTip(event, d.m.label,
      d.bars.flatMap(b => {
        const name = n > 1 ? `${b.x.name}: ` : "";
        return [
          [name + "percentile", b.pct == null ? "–" : Math.round(b.pct)],
          [name + (d.m.type === "count" ? "per 90" : "value"), fmt(d.m, b.v, "p90")],
        ];
      }),
      metricInfo(d.m, "p90")))
    .on("pointerleave", hideTip);
}

function drawForm(players) {
  const series = players.map((x, i) => x.matches.filter(m => m.rating != null).map(m => ({ ...m, d: new Date(m.date), x, i })));
  const all = d3.sort(series.flat(), d => d.d);
  const single = players.length === 1;
  document.getElementById("form-sub").textContent = single ? "The hairline marks the player's average." : "One line per player.";
  playerLegend("form-legend", players, true);

  const height = 260;
  const { svg, width } = svgIn("form", height);
  const mg = { top: 20, right: 44, bottom: 28, left: 36 };
  const x = d3.scaleTime([new Date(state.from), new Date(state.to)], [mg.left, width - mg.right]);
  const y = d3.scaleLinear([Math.min(5, d3.min(all, d => d.rating) ?? 5), 10], [height - mg.bottom, mg.top]);

  svg.append("g").attr("class", "gridline").attr("transform", `translate(${mg.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(width - mg.left - mg.right)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - mg.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 90))).tickFormat(d3.timeFormat("%-d %b")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${mg.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));
  if (!all.length) return;

  if (single) {
    const p = players[0], data = series[0];
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
  }

  for (const data of series) {
    if (!data.length) continue;
    const color = PLAYER_COLORS[data[0].i];
    svg.append("path").datum(data).attr("d", d3.line(d => x(d.d), d => y(d.rating)))
      .attr("fill", "none").attr("stroke", color).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("stroke-linecap", "round");
    svg.append("g").selectAll("circle").data(data).join("circle")
      .attr("cx", d => x(d.d)).attr("cy", d => y(d.rating)).attr("r", 4)
      .attr("fill", color).attr("stroke", "var(--surface-1)").attr("stroke-width", 2);
  }

  // Crosshair snapping to the nearest match date; with two players on the same date, the one nearest the pointer
  const cross = svg.append("line").attr("y1", mg.top).attr("y2", height - mg.bottom).attr("stroke", "var(--axis)").attr("visibility", "hidden");
  const focus = svg.append("circle").attr("r", 6).attr("stroke", "var(--surface-1)").attr("stroke-width", 2).attr("visibility", "hidden");
  const bisect = d3.bisector(d => d.d).center;
  svg.append("rect").attr("x", mg.left).attr("y", mg.top)
    .attr("width", width - mg.left - mg.right).attr("height", height - mg.top - mg.bottom).attr("fill", "transparent")
    .on("pointermove", event => {
      const [px, py] = d3.pointer(event);
      const near = all[bisect(all, x.invert(px))];
      const d = d3.least(all.filter(o => +o.d === +near.d), o => Math.abs(y(o.rating) - py));
      cross.attr("x1", x(d.d)).attr("x2", x(d.d)).attr("visibility", "visible");
      focus.attr("cx", x(d.d)).attr("cy", y(d.rating)).attr("fill", PLAYER_COLORS[d.i]).attr("visibility", "visible");
      const rows = [["Rating", d.rating.toFixed(2)], ["Minutes", d.min]];
      if (d.goals) rows.push(["Goals", d.goals]);
      if (d.assists) rows.push(["Assists", d.assists]);
      const who = single ? "" : d.x.name + " · ";
      showTip(event, `${who}${fmtDate(d.date)} · ${d.x.switched ? d.team + " " : ""}vs ${d.opp}`, rows);
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
    if (M[c.key]) th.title = metricInfo(M[c.key]); // hover a header to see what the column means
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
    tr.addEventListener("click", () => openProfile(p));
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

  document.getElementById("pr-list").replaceChildren(...d3.sort(AGG, p => p.name).map(p => new Option(playerLabel(p))));

  // Controls the user normally sets; synced here too because the URL (or Back) can change them
  for (const [id, v] of [["f-pos", state.pos], ["f-mode", state.mode], ["pr-cmp", state.cmp], ["vr-grade", state.vrGrade], ["vr-age", state.vrAge]]) {
    document.getElementById(id).value = v;
  }
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
  drawValue();
  drawLeaderboard();
  drawProfile();
  drawTable();
  writeHash();
}

// ---------- URL ----------

// All settings live in the URL hash, e.g. #season=2025-2026&pos=role:ST&player=942393, so a view can be shared
// as a link. Only settings that differ from the defaults are written, which keeps links short.
function stateToHash() {
  const h = new URLSearchParams();
  const put = (key, v, def) => { if (v != null && v !== "" && String(v) !== String(def)) h.set(key, v); };
  put("season", state.season, DEFAULTS.season);
  if (state.season === "custom") { h.set("from", state.from); h.set("to", state.to); }
  put("pos", state.pos, DEFAULTS.pos);
  put("team", state.team, "");
  if (state.minManual) h.set("min", state.minMin); // otherwise it's derived from the date range
  put("mode", state.mode, DEFAULTS.mode);
  put("view", state.view, DEFAULTS.view);
  if (state.view === "custom") { h.set("x", state.x); h.set("y", state.y); }
  put("lb", state.lb, DEFAULTS.lb);
  put("against", state.cmp, DEFAULTS.cmp);
  put("grade", state.vrGrade, DEFAULTS.vrGrade);
  put("age", state.vrAge, DEFAULTS.vrAge);
  put("player", state.selectedId, null);
  put("vs", state.compareId, null);
  return h.toString() ? "#" + h.toString() : "";
}

// Read the hash into state. Unknown or invalid values are ignored, so an old or edited link still opens.
function hashToState() {
  Object.assign(state, structuredClone(DEFAULTS));
  const h = new URLSearchParams(location.hash.slice(1));
  const s = h.get("season");
  const known = seasons.find(x => x.id === s);
  if (known) Object.assign(state, { season: known.id, from: known.start, to: known.end });
  else if (s === "all") Object.assign(state, { season: "all", from: allStart, to: allEnd });
  else if (s === "custom" && h.get("from") && h.get("to")) Object.assign(state, { season: "custom", from: h.get("from"), to: h.get("to") });
  const pick = (key, allowed) => { const v = h.get(key); return v != null && allowed.includes(v) ? v : null; };
  state.pos = pick("pos", POS_OPTIONS.map(o => o[0])) ?? state.pos;
  state.mode = pick("mode", ["p90", "total"]) ?? state.mode;
  state.cmp = pick("against", ["role", "line", "out"]) ?? state.cmp;
  state.vrGrade = pick("grade", ["AB", "A", "B"]) ?? state.vrGrade;
  state.lb = pick("lb", METRICS.map(m => m.key)) ?? state.lb;
  if (h.has("team")) state.team = h.get("team");
  const view = pick("view", [...VIEWS.map(v => v.id), "custom"]);
  if (view) applyView(view);
  if (state.view === "custom") {
    state.x = pick("x", METRICS.map(m => m.key)) ?? state.x;
    state.y = pick("y", METRICS.map(m => m.key)) ?? state.y;
  }
  if (h.has("min") && MIN_OPTIONS.includes(+h.get("min"))) { state.minMin = +h.get("min"); state.minManual = true; }
  if (h.has("age")) state.vrAge = +h.get("age") || DEFAULTS.vrAge;
  if (h.has("player")) state.selectedId = +h.get("player");
  if (h.has("vs")) state.compareId = +h.get("vs");
}

let lastPlayers = null;
function writeHash() {
  const hash = stateToHash();
  const players = `${state.selectedId}|${state.compareId}`;
  // Opening another player adds a history entry, so Back returns to the previous one; other changes replace it
  const push = lastPlayers !== null && players !== lastPlayers;
  lastPlayers = players;
  if (hash === location.hash) return;
  history[push ? "pushState" : "replaceState"](null, "", hash || location.pathname + location.search);
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
  on("pr-cmp", v => { state.cmp = v; });
  on("vr-grade", v => { state.vrGrade = v; });
  on("vr-age", v => { state.vrAge = +v; });

  // Find player (top bar): opens the profile
  document.getElementById("pr-search").addEventListener("change", e => {
    const p = playerByLabel(e.target.value);
    if (p) { openProfile(p); e.target.value = ""; }
  });
  // Compare with player (profile card)
  document.getElementById("pr-vs").addEventListener("change", e => {
    const p = playerByLabel(e.target.value);
    if (p && p.id !== state.selectedId) { state.compareId = p.id; render(); }
    e.target.value = "";
  });
  document.getElementById("pr-vs-clear").addEventListener("click", () => { state.compareId = null; render(); });

  // ⓘ buttons: show the definition of the metric currently picked in the dropdown next to them.
  // Hover, keyboard focus and tap (mobile) all work.
  for (const b of document.querySelectorAll(".info")) {
    const show = () => {
      const m = M[document.getElementById(b.dataset.select).value];
      const r = b.getBoundingClientRect();
      showTip({ clientX: r.left, clientY: r.bottom }, label(m), [], metricInfo(m));
    };
    for (const ev of ["mouseenter", "focus", "click"]) b.addEventListener(ev, show);
    for (const ev of ["mouseleave", "blur"]) b.addEventListener(ev, hideTip);
  }

  fillSelect("f-pos", POS_OPTIONS, state.pos);
  fillSelect("vr-age", [[99, "Any"], [21, "21 or younger"], [23, "23 or younger"], [25, "25 or younger"], [27, "27 or younger"], [30, "30 or younger"]], state.vrAge);
  hashToState(); // a shared link or a reload restores its settings
  updateRange();
  render();

  // Back / Forward: re-read the settings from the URL
  window.addEventListener("popstate", () => { hashToState(); updateRange(); render(); });

  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w !== lastWidth) { lastWidth = w; render(); }
  }).observe(document.querySelector("main"));
}

init();
