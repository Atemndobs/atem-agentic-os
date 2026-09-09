/**
 * A read-cost report a maintainer can open, one per repository.
 *
 * Self-contained HTML with inline SVG. No build step, no CDN, no dependency:
 * the Harness ships zero dependencies and a report that needs a network to
 * render is a report nobody opens on a plane.
 *
 * The audience is a maintainer who did not ask for this. So the report leads
 * with the two or three things worth doing, names the files, and explains each
 * rule in terms of what it costs rather than what it matches. A wall of 451
 * findings persuades nobody; "clamp the batch size in four files" does.
 */

const RULES = {
  "unbounded-index-collect": {
    title: "Unbounded index reads",
    cost: "An index chooses WHICH rows are read, never HOW MANY. A collect over an indexed range reads every row in it, and the range grows with the data.",
    fix: "Add .take(cap) at the read, or paginate. If the range is genuinely small, say so in a comment so the next reader does not have to guess.",
  },
  "scan-to-count": {
    title: "Counting by reading",
    cost: "Reads every matching document to produce one number. The cost is the whole table; the answer is an integer.",
    fix: "Keep a denormalised counter, or bound the read when the ceiling is genuinely small.",
  },
  "index-without-range": {
    title: "Index with no bound",
    cost: "withIndex without q.eq/gte/lt narrows nothing. It walks the whole index in order, which is a full scan with extra steps.",
    fix: "Add the range the index exists for.",
  },
  "dynamic-large-take": {
    title: "Caller-controlled limits",
    cost: "take(args.limit) lets whoever calls the function decide how much of the database to read. It is a limit in name only.",
    fix: "Clamp it: Math.min(args.limit ?? DEFAULT, HARD_CAP).",
  },
  "post-collect-cap": {
    title: "Capping after the read",
    cost: "collect().slice() reads every row and then throws most of them away. The cost was paid before the slice ran.",
    fix: "Move the cap into the read with .take(n).",
  },
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Horizontal bars. Widths are proportional to the largest value, not the total. */
function barChart(entries, { width = 560, rowH = 34 } = {}) {
  if (entries.length === 0) return "";
  const max = Math.max(...entries.map(([, n]) => n));
  const labelW = 210;
  const barW = width - labelW - 60;
  const rows = entries
    .map(([label, n], i) => {
      const w = Math.max(2, Math.round((n / max) * barW));
      const y = i * rowH;
      return `<g transform="translate(0 ${y})">
      <text x="0" y="${rowH / 2 + 4}" class="bl">${esc(label)}</text>
      <rect x="${labelW}" y="${rowH / 2 - 9}" width="${w}" height="18" rx="4" class="bar b${i}"/>
      <text x="${labelW + w + 10}" y="${rowH / 2 + 4}" class="bn">${n}</text>
    </g>`;
    })
    .join("\n");
  return `<svg viewBox="0 0 ${width} ${entries.length * rowH}" width="100%" role="img"
     aria-label="findings by rule">${rows}</svg>`;
}

/** The two or three things worth doing first, in the maintainer's words. */
function recommendations(byRule, byFile) {
  const ranked = Object.entries(byRule).sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [rule, n] of ranked.slice(0, 3)) {
    const meta = RULES[rule];
    if (!meta) continue;
    const files = byFile
      .filter((f) => f.rules[rule])
      .slice(0, 3)
      .map((f) => `${f.file} (${f.rules[rule]})`);
    out.push({ rule, n, ...meta, files });
  }
  return out;
}

export function renderRepoReport({ name, generatedAt, findings, guard, convexVersion, adopted }) {
  const byRule = {};
  const fileMap = {};
  for (const f of findings) {
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    (fileMap[f.file] ??= { file: f.file, total: 0, rules: {} });
    fileMap[f.file].total += 1;
    fileMap[f.file].rules[f.rule] = (fileMap[f.file].rules[f.rule] ?? 0) + 1;
  }
  const byFile = Object.values(fileMap).sort((a, b) => b.total - a.total);
  const recs = recommendations(byRule, byFile);
  const ruleRows = Object.entries(byRule).sort((a, b) => b[1] - a[1]);

  const worst = byFile.slice(0, 12);
  const examples = findings
    .filter((f) => f.rule === (ruleRows[0]?.[0] ?? ""))
    .slice(0, 5);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Convex read cost: ${esc(name)}</title>
<style>
  :root{
    --bg:#fbfbfd; --fg:#16161a; --dim:#6b7280; --line:#e5e7eb; --card:#fff;
    --a:#0f766e; --b:#b45309; --c:#b91c1c; --d:#4338ca; --e:#0369a1;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme=light]){
    --bg:#0f1115; --fg:#e8e8ea; --dim:#9aa1ab; --line:#242832; --card:#161922;
    --a:#5eead4; --b:#fbbf24; --c:#fca5a5; --d:#a5b4fc; --e:#7dd3fc;}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:40px 24px 72px}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
     margin:40px 0 12px;font-weight:600}
  .sub{color:var(--dim);margin:0 0 28px}
  .kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  .kpi{flex:1 1 150px;background:var(--card);border:1px solid var(--line);
       border-radius:12px;padding:14px 16px}
  .kpi b{display:block;font-size:28px;letter-spacing:-.02em}
  .kpi span{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
  .rec{margin-bottom:12px}
  .rec h3{margin:0 0 6px;font-size:16px}
  .rec p{margin:0 0 8px;color:var(--dim)}
  .rec .fix{color:var(--fg)}
  code,.mono{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  .bl{fill:var(--fg);font:13px ui-sans-serif,sans-serif}
  .bn{fill:var(--dim);font:12px ui-monospace,monospace}
  .bar{opacity:.9}.b0{fill:var(--c)}.b1{fill:var(--b)}.b2{fill:var(--d)}
  .b3{fill:var(--e)}.b4{fill:var(--a)}
  .foot{color:var(--dim);font-size:13px;margin-top:36px;border-top:1px solid var(--line);padding-top:16px}
  .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;
        padding:2px 10px;font-size:12px;color:var(--dim)}
</style></head><body><div class="wrap">

<h1>Convex read cost: ${esc(name)}</h1>
<p class="sub">${findings.length} finding${findings.length === 1 ? "" : "s"} across ${byFile.length} file${byFile.length === 1 ? "" : "s"}.
  <span class="pill">convex ${esc(convexVersion ?? "unknown")}</span>
  <span class="pill">guard ${esc(guard)}</span>
  <span class="pill">${adopted ? "adopted" : "not adopted"}</span></p>

<div class="kpis">
  ${ruleRows
    .slice(0, 4)
    .map(([r, n]) => `<div class="kpi"><b>${n}</b><span>${esc(RULES[r]?.title ?? r)}</span></div>`)
    .join("")}
</div>

<h2>Start here</h2>
<div class="card">
${
  recs.length === 0
    ? "<p>Nothing found. This backend reads within its bounds.</p>"
    : recs
        .map(
          (r) => `<div class="rec">
    <h3>${esc(r.title)} <span class="pill">${r.n}</span></h3>
    <p>${esc(r.cost)}</p>
    <p class="fix">${esc(r.fix)}</p>
    ${r.files.length ? `<p class="mono">${r.files.map(esc).join("<br>")}</p>` : ""}
  </div>`,
        )
        .join("")
}
</div>

<h2>Findings by rule</h2>
<div class="card">${barChart(ruleRows.map(([r, n]) => [RULES[r]?.title ?? r, n]))}</div>

<h2>Files to look at</h2>
<div class="card"><table>
<tr><th>File</th><th class="n">Findings</th><th>Mostly</th></tr>
${worst
  .map((f) => {
    const top = Object.entries(f.rules).sort((a, b) => b[1] - a[1])[0];
    return `<tr><td class="mono">${esc(f.file)}</td><td class="n">${f.total}</td><td>${esc(RULES[top[0]]?.title ?? top[0])}</td></tr>`;
  })
  .join("")}
</table></div>

${
  examples.length
    ? `<h2>What it looks like</h2><div class="card">
${examples
  .map(
    (e) => `<p class="mono">${esc(e.file)}:${e.line} &nbsp;<span style="color:var(--dim)">${esc(e.scope)}</span><br>
    ${esc(e.chain.replace(/\s+/g, " ").slice(0, 160))}</p>`,
  )
  .join("")}
</div>`
    : ""
}

<p class="foot">
  Generated by ATEM Convex Guard ${esc(guard)} on ${esc(generatedAt)}.
  Findings are structural: they describe reads whose size is decided by the data
  rather than by the code. Some will be genuinely small and fine, and the scanner
  cannot tell those apart, which is why this is a report and not a gate.
  Re-run with <code>atem guardrails convex report</code>.
</p>
</div></body></html>`;
}
