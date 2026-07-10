import { useState, useRef, useEffect, useCallback } from "react";

const PROMPT_PHASE1 = "You are a Senior Java & IDIT Performance Architect with deep expertise in JPA/Hibernate, JDO, EJB3, and the IDIT insurance platform.\n\nARCHITECTURE CONTEXT -- IDIT-specific patterns you MUST recognize:\n- getFullPolicy / getFullPolicyWithQuestionnaire: Loading an entire policy object graph. If count > 50 in a single transaction it is a critical loop problem. Each call touches 20+ tables.\n- PolicyToSubPolicyJDOBean queries: If count > 10 with avg > 100ms, the POLICY_ID or STATUS index is missing. Flag MISSING_INDEX with exact CREATE INDEX DDL.\n- DynamicDataDictionary / TDynamicDataDictionaryJDOBean: Static config table. ANY query count > 100 is a missing JVM-level cache. Severity CRITICAL.\n- TProductLineJDOBean / TProductLineOptionJDOBean: Reference data. Count > 200 = missing Hibernate L2 cache. Flag MISSING_CACHE.\n- ContactJDOBean / ContactTTCJDOBean / getPrimaryDetailedContactVO: If count > 50, contacts are being reloaded in a loop (coinsurance or sub-policy iteration). Flag N+1 with specific fix to cache in a Map<Long, ContactVO>.\n- isCatPerilRiskScoresEmpty / buildPolicyLobsPresentationTree / buildPolicyLobs: If samples > 100, called inside a loop per sub-policy. Must be memoized or called once at master level.\n- performAllUnderwritingChecks / UnderwritingChecksSession: If samples > 100 per sub-policy count, UW checks are running redundantly per sub-policy. Should run once at master level.\n- handleSaveGenAgrmntMultiAssetPolicy: Wrapper for per-sub-policy save loop. Total time here x sub-policy count reveals per-iteration cost.\n- coinsuranceParticipantPresentationValueList: If count > 50, rebuilding coinsurance list per sub-policy. Cache on PolicyVO.\n- RuleEngineSessionBean.getDynamicDataDictionaryValues: Each call hits TDynamicDataDictionary table. Count > 200 = critical missing cache.\n- SELECT 1 / connection keepalive: Count > 50 in one transaction = connection pool under pressure from long-running queries above.\n- AssetItemJDOBean find count > 200: Asset items loaded individually. Should use batch fetch or collection join.\n- GroupAssetLocationJDOBean / PolicyHeaderUnderwritingAlertJDOBean: If count matches sub-policy count x location count, N+1 loading pattern.\n\nCROSS-SIGNAL RULES -- detect these combinations:\n1. CPU: method with high sample count + DB: find/getResultList for same entity = N+1. Report in BOTH cpuFindings (loop) and dbFindings (query).\n2. CPU: getDynamicDataDictionaryValues high samples + DB: TDynamicDataDictionary high count = missing JVM cache. CRITICAL.\n3. CPU: buildPolicyLobs/getFullPolicy high samples + DB: PolicyJDOBean find count = policy reloaded per iteration. CRITICAL loop.\n4. CPU: coinsuranceParticipant high samples + DB: ContactJDOBean count > 100 = contact N+1. HIGH.\n5. DB: any JPA find with count > (sub-policy count x 10) = N+1 inside location/cover loop.\n\nSEVERITY THRESHOLDS (use exactly these):\n- CRITICAL: total time > 10000ms OR own time > 1000ms OR call count > 5000 OR avg ms > 500 for repeated queries\n- HIGH: total time > 2000ms OR own time > 100ms OR call count > 500 OR avg ms > 100 for repeated queries\n- MEDIUM: total time > 500ms OR call count > 100 OR avg ms > 50\n- LOW: everything else worth noting\n\nSECTION ROUTING:\n- CPU PROFILING section -> cpuFindings ONLY (method-level hotspots, call counts, loop patterns)\n- SQL/DB PROFILING section -> dbFindings ONLY (queries, JPA find/getResultList, index gaps, missing caches)\n- OTHER ARTIFACTS -> iditFindings (config issues, IDIT-specific settings)\nNEVER mix: SQL findings never go in cpuFindings; CPU methods never go in dbFindings.\n\nFOR EACH CPU FINDING: Extract exact method signature, total ms, own ms, sample/call count. Identify WHY it is expensive (loop, missing cache, repeated DB call, heavy object graph). Give exact code fix with before/after. Flag if it is called inside a loop per sub-policy / per location / per cover.\n\nFOR EACH DB FINDING: Extract exact entity or SQL, total ms, avg ms, call count. Classify problem: MISSING_INDEX / N+1 / MISSING_CACHE / FULL_SCAN / LOCK / HIGH_FREQUENCY. For MISSING_INDEX: provide exact CREATE INDEX DDL using actual table/column names from the entity name (e.g. PolicyToSubPolicyJDOBean -> P_POLICY_TO_SUB_POLICY). For N+1: identify which parent loop drives it and what batch alternative exists. For MISSING_CACHE: specify whether it needs Hibernate L2 cache annotation or JVM-level Map.\n\nOUTPUT: Return ONLY valid JSON -- no markdown, no fences, no text outside the object. Use \\n for newlines in strings. Max 400 chars per string field.\n\n{\"summary\":{\"rating\":\"CRITICAL|HIGH|MEDIUM|LOW\",\"score\":0,\"topFix\":\"single most impactful fix\",\"impact\":\"business process affected\",\"counts\":{\"critical\":0,\"high\":0,\"medium\":0,\"low\":0,\"total\":0}},\"cpuFindings\":[{\"sev\":\"SEV\",\"hotspot\":\"com.idit.ClassName.method()\",\"cpu\":\"TotalMs\",\"calls\":\"Count\",\"cause\":\"exact reason -- loop/cache/graph\",\"fix\":\"step-by-step fix\",\"code\":\"//before\\n//after\",\"gain\":\"estimated % or ms improvement\"}],\"dbFindings\":[{\"sev\":\"SEV\",\"id\":\"QRY-001\",\"sql\":\"entity name or SQL snippet\",\"execHr\":\"N\",\"avgMs\":\"N\",\"costHr\":\"Nms total\",\"problem\":\"N+1|MISSING_INDEX|MISSING_CACHE|FULL_SCAN|LOCK|HIGH_FREQUENCY\",\"sourceClass\":\"com.idit.Class driving this query\",\"index\":\"CREATE INDEX IDX_... ON TABLE (COL1, COL2) INCLUDE (COL3)\",\"fix\":\"exact fix -- cache strategy, batch load, or query rewrite\",\"code\":\"//before\\n//after\",\"gain\":\"estimated improvement\"}],\"iditFindings\":[{\"sev\":\"SEV\",\"component\":\"com.idit.Component\",\"issue\":\"what is wrong\",\"current\":\"current behavior with numbers\",\"fix\":\"exact fix\",\"code\":\"before/after\",\"gain\":\"improvement\"}]}";
const PROMPT_PHASE2 = "You are a Senior Java & IDIT Performance Architect producing a prioritised remediation plan from Phase 1 findings.\n\nRULES:\n- Base EVERY action on actual findings provided. Never invent classes or problems not in the data.\n- Rank by business impact: transaction time saved x frequency.\n- For N+1 findings: solution must specify the exact batch/cache mechanism, not just \"use caching\".\n- For MISSING_INDEX: repeat the exact CREATE INDEX DDL from Phase 1.\n- For MISSING_CACHE: specify whether Hibernate @Cache annotation, JVM ConcurrentHashMap, or application-level VO field caching.\n- Cross-signal findings (same problem appearing in both CPU and DB) must be ONE action that addresses both sides.\n- codeImprovements must have working before/after Java snippets -- not pseudocode.\n- If Phase 1 found no data for a category, leave that array empty.\n\nCATEGORIES: CPU | DATABASE | IDIT | CODE\nIMPROVEMENT TYPES: N+1_QUERY | INEFFICIENT_LOOP | MISSING_CACHE | MISSING_INDEX | COLLECTION_MISUSE | ALGORITHM\n\nOUTPUT: Return ONLY valid JSON -- no markdown, no fences. Use \\n for newlines. Max 400 chars per string field.\n\n{\"actions\":[{\"rank\":1,\"category\":\"CPU|DATABASE|IDIT|CODE\",\"sev\":\"SEV\",\"title\":\"concise action title\",\"class\":\"com.idit.Class\",\"problem\":\"exact bottleneck with numbers from findings\",\"solution\":\"step 1: ...\\nstep 2: ...\\nstep 3: ...\",\"gain\":\"estimated ms or % saved\"}],\"codeImprovements\":[{\"sev\":\"SEV\",\"file\":\"ClassName.java\",\"class\":\"com.idit.full.ClassName\",\"method\":\"methodName()\",\"type\":\"N+1_QUERY|INEFFICIENT_LOOP|MISSING_CACHE|MISSING_INDEX|COLLECTION_MISUSE|ALGORITHM\",\"before\":\"// actual problematic code pattern\",\"after\":\"// fixed code with cache/batch/index\",\"why\":\"root cause explanation\",\"gain\":\"improvement\"}],\"scorecard\":{\"cpu\":0,\"db\":0,\"idit\":0,\"overall\":0,\"cpuNote\":\"one-line CPU health summary\",\"dbNote\":\"one-line DB health summary\",\"iditNote\":\"one-line IDIT config summary\"}";

const ENVIRONMENTS = ["DEVELOPMENT","SIT","UAT","PRE-PROD","PRODUCTION"];
const PROJECTS = [
  "ABSA","AGS","BHSF","BKI","BLDR","BLTC","CZ","EIG","FNB","GF","HGS",
  "HLRD","LB","MBV","MBVS","MSA","OPES","PNR","RACI","TCS","TTC","UCOR"
].sort();

const SEV_STYLE = {
  CRITICAL: { dot:"#ef4444", bg:"#fef2f2", text:"#b91c1c", border:"#fca5a5" },
  HIGH:     { dot:"#f97316", bg:"#fff7ed", text:"#c2410c", border:"#fdba74" },
  MEDIUM:   { dot:"#eab308", bg:"#fefce8", text:"#a16207", border:"#fde047" },
  LOW:      { dot:"#22c55e", bg:"#f0fdf4", text:"#15803d", border:"#86efac" },
};
const DARK = {
  bg:"#0d1117", surf:"#161b22", surf2:"#21262d", bdr:"#30363d",
  txt:"#e6edf3", muted:"#8b949e", faint:"#6e7681",
  acc:"#58a6ff", accBg:"#0d1f38",
  logBg:"#010409", logTxt:"#8b949e", logOk:"#3fb950", logErr:"#f85149", logInfo:"#58a6ff", logWarn:"#d29922",
  codeBadBg:"#3d0c0c", codeBadBdr:"#7f1d1d", codeBadTxt:"#fca5a5",
  codeGoodBg:"#0d2d1a", codeGoodBdr:"#166534", codeGoodTxt:"#86efac",
};
const LIGHT = {
  bg:"#f6f8fa", surf:"#ffffff", surf2:"#f0f2f5", bdr:"#d0d7de",
  txt:"#1f2328", muted:"#57606a", faint:"#8c959f",
  acc:"#0969da", accBg:"#ddf4ff",
  logBg:"#0d1117", logTxt:"#8b949e", logOk:"#3fb950", logErr:"#f85149", logInfo:"#58a6ff", logWarn:"#d29922",
  codeBadBg:"#fff1f2", codeBadBdr:"#fecaca", codeBadTxt:"#991b1b",
  codeGoodBg:"#f0fdf4", codeGoodBdr:"#bbf7d0", codeGoodTxt:"#166534",
};
const SAMPLE = "CPU TRACE REPORT\ncom.idit.eig.service.CustomerCalculationService.calculatePremium() - 34.2% CPU\ncom.idit.core.engine.RuleEngine.evaluateProductRules() - 22.1% CPU\n\nTHREAD DUMP\nidit-worker-pool: 45/50 BLOCKED on com.idit.eig.repository.PolicyRepository\n\nSQL REPORT\nSELECT * FROM IDIT_POLICY WHERE status='ACTIVE' 22000/hr 847ms avg\nSELECT * FROM IDIT_PREMIUM_HIST WHERE policy_id=? 45000/hr N+1\n\nIDIT CONFIG\ncom.idit.eig.config.EIGProductConfig: 847 rules cache TTL=0";

function tryParse(raw) {
  if (!raw || !raw.trim()) throw new Error("Empty response from Claude");

  let clean = raw
    .split("\n")
    .filter(l => !l.trim().startsWith("```"))
    .join("\n")
    .trim();
  const first = clean.indexOf("{");
  const last  = clean.lastIndexOf("}");
  if (first === -1) throw new Error("No JSON object found — Claude returned: " + raw.slice(0,200));
  const extracted = clean.slice(first, last + 1);

  try { return JSON.parse(extracted); } catch(e1) {
    let fixed = extracted
      .replace(/\\'/g, "'")                          // unnecessary \'
      .replace(/\t/g, " ")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/,\s*([}\]])/g, "$1");

    try { return JSON.parse(fixed); } catch(e2) {
      for (let i = extracted.length - 1; i >= 0; i--) {
        if (extracted[i] === "}") {
          try { return JSON.parse(extracted.slice(0, i + 1)); } catch(_) {}
        }
      }

      const truncated = extracted
        .replace(/,[^,{}[\]]*$/, "")
        .replace(/,\s*\{[^}]*$/, "");
      const opens = (truncated.match(/\[/g)||[]).length - (truncated.match(/\]/g)||[]).length;
      const closing = "]".repeat(Math.max(0,opens)) + "}";
      try { return JSON.parse(truncated + closing); } catch(_) {}

      const fallback = {
        summary: { rating:"HIGH", score:40, topFix:"See individual tabs for findings", impact:"Analysis completed with formatting issues — findings extracted below.", counts:{critical:0,high:0,medium:0,low:0,total:0} },
        cpuFindings:[], threadFindings:[], dbFindings:[], iditFindings:[]
      };
      for (const key of ["cpuFindings","threadFindings","dbFindings","iditFindings"]) {
        const rx = new RegExp('"'+key+'"\\s*:\\s*\\[');
        const m = extracted.match(rx);
        if (m) {
          const start = extracted.indexOf(m[0]) + m[0].length - 1;
          let depth=0, i=start;
          while (i < extracted.length) {
            if (extracted[i]==="[") depth++;
            else if (extracted[i]==="]") { depth--; if (!depth) break; }
            i++;
          }
          try { fallback[key] = JSON.parse(extracted.slice(start, i+1)); } catch(_) {}
        }
      }
      return fallback;
    }
  }
}

// ─── COLUMN DETECTION ────────────────────────────────────────────────────────
// Maps profiler header variants to canonical column indices
function detectCsvColumns(headerLine) {
  const h = headerLine.toLowerCase().split(",").map(c => c.replace(/^"|"$/g,"").trim());
  const find = (...candidates) => {
    for (const c of candidates) {
      const idx = h.findIndex(col => col.includes(c));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  return {
    method:  find("method", "name", "class", "function", "signature") ?? 0,
    total:   find("total time", "cumulative", "inclusive", "elapsed", "wall time", "time (ms)", "total") ?? 1,
    pct:     find("time %", "percent", "cpu%", "self %") ?? 2,
    own:     find("own time", "self time", "self", "exclusive", "net time") ?? 3,
    count:   find("invocations", "count", "calls", "hit count", "call count") ?? 4,
    avgOwn:  find("avg own", "avg self", "average self") ?? -1,
    avgTotal:find("avg total", "avg inclusive") ?? -1,
  };
}

function parseCsvArtifact(csvText, isDbMode) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return csvText;

  const hdrRaw = lines[0];
  const hdr    = hdrRaw.toLowerCase();

  // Accept if header contains any profiling keyword
  const isProfileHeader = /time|count|invoc|method|self|own|elapsed|inclusive|exclusive|cumul/i.test(hdr);
  if (!isProfileHeader) return csvText;

  const cols = detectCsvColumns(hdrRaw);

  const pt = v => {
    if (!v || v === "0") return 0;
    const s = String(v).replace(/,/g, "").trim();
    if (s.startsWith("<")) return 0.05;
    // microseconds → ms
    if (/µs|us$/i.test(s)) return parseFloat(s) / 1000;
    // seconds → ms
    if (/s$/i.test(s) && !/ms$/i.test(s)) return parseFloat(s) * 1000;
    return parseFloat(s) || 0;
  };
  const pct = v => { const n = parseInt(String(v).replace(/,/g,"")); return isNaN(n) ? 0 : n; };

  const allRows = lines.slice(1).map(line => {
    const parts = line.match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g) || [];
    return parts.map(c => c.replace(/^"|"$/g, "").replace(/""/g, '"').replace(/,$/,"").trim());
  }).filter(r => r.length > cols.method && r[cols.method] && r[cols.method].trim().length > 0);

  const EXCL = [
    "framework.backend.interceptor", "framework.common.vo",
    "framework.common.utils", "framework.common.context",
    "framework.common.jaas", "framework.backend.ejb3",
    "framework.backend.session", "framework.backend.mqueue",
    "framework.backend.manager.Embed", "framework.security",
    "framework.web.filters", "framework.web.i18n",
    "framework.sce.server.session", "framework.sce.server.engine",
    "framework.sce.common.ifc", "reference.common.vo",
  ];
  const isExcl = sig => EXCL.some(e => sig.includes(e));

  const isDbMethod = sig => {
    const s = sig.toLowerCase();
    return s.includes("jdbc") || s.includes("preparedstatement") ||
           s.includes("hibernate") || s.includes("datanucleus") ||
           s.includes("persistencemanager") || s.includes("jdoql") ||
           s.includes("sqlmanager") || s.includes("fetchplan") ||
           s.includes("connectionpool") || s.includes("hikari") ||
           s.includes("c3p0") || s.includes("datasource") ||
           (s.includes("jdo") && (s.includes("manager") || s.includes("query")));
  };

  // Smart DB-mode: auto-detect even if file wasn't named *db*
  const dbMethodCount = allRows.filter(r => isDbMethod(r[cols.method])).length;
  const effectiveDbMode = isDbMode || (dbMethodCount > allRows.length * 0.25);

  const relevantRows = effectiveDbMode
    ? allRows.filter(r => r[cols.method] && !r[cols.method].startsWith('"'))
    : allRows.filter(r => {
        const m = r[cols.method];
        if (!m) return false;
        if (m.includes("com.idit") || m.includes("com.alphacsp")) return true;
        // Also include rows from the selected project even without full package name
        // e.g. rows labelled "ChargesManagerTTC" or "PolicyManagerTTC" in some profilers
        return false;
      });

  if (effectiveDbMode) {
    // Route to DB report with full column awareness
    const enrichedRows = relevantRows.map(r => [
      r[cols.method],
      r[cols.total] || "0",
      r[cols.pct]   || "0",
      r[cols.own]   || "0",
      r[cols.count] || "0",
    ]);
    return buildDbCsvReport(enrichedRows, cols);
  }

  const layer = s => {
    if (s.includes("SCECommand") && s.includes("perform")) return 0;
    if (/\.command\.|Command\.do|Command\.perform|Command\.back|Command\.rebuild|Command\.continue/.test(s)) return 1;
    if (/server\.session\.bean|session_ifc|session\.ifc|Session\$\$\$view|SessionBean\./.test(s)) return 2;
    if (/server\.jdo\.manager|DataManager|JDOManager/.test(s)) return 4;
    if (/jdo\.business\.bean|JDOBean|interfaces\.common\.ivo|\.ivo\./.test(s)) return 5;
    if (/server\.manager/.test(s)) return 3;
    return 3;
  };

  // Build method registry — keep all call sites, not just the highest-total one
  const reg = new Map();
  relevantRows.forEach(r => {
    const sig  = r[cols.method];
    const p    = sig.indexOf("(");
    const base = p > 0 ? sig.slice(0, p) : sig;
    if (isExcl(sig)) return;
    const totalVal = pt(r[cols.total]);
    const ownVal   = pt(r[cols.own]);
    const cntVal   = pct(r[cols.count]);
    if (!reg.has(base) || totalVal > pt(reg.get(base).raw[cols.total])) {
      reg.set(base, {
        base, sig,
        total: totalVal,
        own:   ownVal,
        count: cntVal,
        raw:   r,
      });
    }
  });

  const methods = Array.from(reg.values()).sort((a, b) => b.total - a.total);
  const root    = methods.find(m => m.sig.includes("SCECommand") && m.sig.includes("perform"));
  if (!root) return buildFlatReport(methods, relevantRows.length);

  const assigned = new Set([root.base]);

  function assignChildren(parent, pool, depth) {
    if (depth <= 0) return [];
    const pL = layer(parent.sig);
    const eligible = pool
      .filter(m =>
        !assigned.has(m.base) &&
        m.total <= parent.total * 1.10 &&
        m.total >= parent.total * 0.01 &&
        layer(m.sig) > pL
      )
      .sort((a, b) => b.total - a.total);
    const result = [];
    for (const m of eligible) {
      if (assigned.has(m.base)) continue;
      assigned.add(m.base);
      m.children = assignChildren(m, eligible, depth - 1);
      result.push(m);
    }
    return result;
  }
  root.children = assignChildren(root, methods, 12);

  const short = sig => {
    const p = sig.indexOf("(");
    const before = p > 0 ? sig.slice(0, p) : sig;
    return before.split(".").slice(-2).join(".") + (p > 0 ? sig.slice(p, p + 60) : "");
  };
  const ownMark = own => own >= 1 ? "  \u25c4 OWN=" + own + "ms" : own >= 0.1 ? "  (own=" + own + "ms)" : "";

  function render(node, depth, out) {
    const pad = "  ".repeat(depth);
    out.push(pad + (depth > 0 ? "\u2514\u2500 " : "") + short(node.sig));
    out.push(pad + "   Total=" + node.raw[cols.total] + "ms  Own=" + node.raw[cols.own] + "ms  Count=" + node.raw[cols.count] + ownMark(node.own));
    (node.children || []).forEach(c => render(c, depth + 1, out));
  }

  const treeOut = [];
  render(root, 0, treeOut);

  const unplaced = methods
    .filter(m => !assigned.has(m.base) && m.own >= 0.5)
    .sort((a, b) => b.own - a.own)
    .slice(0, 25);

  // N+1 detection: high call count AND non-trivial own time → strong N+1 signal
  const highCall = methods
    .filter(m => m.count > 1000)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const n1suspects = methods
    .filter(m => m.count > 500 && m.own > 0.1 && !assigned.has(m.base))
    .sort((a, b) => (b.count * b.own) - (a.count * a.own))
    .slice(0, 15);

  // ── IDIT-specific CPU loop pattern detection ─────────────────────────────
  const IDIT_LOOP_PATTERNS = [
    { pat: /getfullpolicy|getfullpolicywithquestionnaire/i,       label: "POLICY_GRAPH_RELOAD",  fix: "Load policy once before loop. Do NOT call getFullPolicy inside sub-policy iteration." },
    { pat: /iscatperilriskscoresempty|buildpolicylobs/i,           label: "MEMOIZE_ON_VO",        fix: "Cache result on PolicyTTCVO with transient boolean. Recompute only when covers change." },
    { pat: /performallunderwritingchecks/i,                        label: "UW_PER_SUBPOLICY",     fix: "Run performAllUnderwritingChecks once at master level, not per sub-policy." },
    { pat: /coinsuranceparticipant|coinsurancepresentation/i,      label: "COINSURANCE_N1",       fix: "Cache coinsurance list on PolicyVO after first load — does not change during confirmation." },
    { pat: /getprimarydetailedcontact|findbasiccontact|findcontactbyid/i, label: "CONTACT_N1",   fix: "Build Map<Long,ContactVO> before loop. Load all contacts in one batch call." },
    { pat: /getdynamicdatadictionaryvalues|dynamicdatadictionary/i, label: "MISSING_JVM_CACHE", fix: "Load TDynamicDataDictionary into ConcurrentHashMap<String,VO> at startup — static config." },
    { pat: /handlesavegenagrmntmultiasset/i,                       label: "MULTI_ASSET_LOOP",    fix: "Audit what runs inside this loop. Total ms / sub-policy count = per-iteration cost." },
  ];
  const diagLines = [];
  IDIT_LOOP_PATTERNS.forEach(({ pat, label, fix }) => {
    methods.filter(m => pat.test(m.sig)).forEach(m => {
      if (m.count > 20 || m.total > 1000) {
        const sev = (m.count > 500 || m.total > 10000) ? "CRITICAL" : (m.count > 100 || m.total > 2000) ? "HIGH" : "MEDIUM";
        diagLines.push("  [" + sev + "][" + label + "] " + short(m.sig));
        diagLines.push("  Total=" + (m.raw[cols.total]||"?") + "ms  Own=" + (m.raw[cols.own]||"?") + "ms  Count=" + m.count);
        diagLines.push("  FIX: " + fix);
      }
    });
  });

  return [
    "CPU PROFILING \u2014 MERGED CALL TREE (architect-level pre-analysis included)",
    "Framework internals excluded. Only project business classes shown.",
    "Root: SCECommand.perform | com.idit business methods: " + methods.length + " | Tree nodes: " + assigned.size,
    "\u25c4 OWN = CPU spent IN this method (not children) \u2014 these are the real hotspots",
    "",
    ...(diagLines.length > 0 ? [
      "=== PRE-DIAGNOSED IDIT PATTERNS (Claude MUST raise findings for each) ===",
      ...diagLines,
      "",
    ] : []),
    "=== CALL TREE (SCECommand.perform \u2192 ... \u2192 leaf hotspots) ===",
    ...treeOut,
    "",
    "=== OWN-TIME WORKERS NOT IN MAIN TREE ===",
    ...(unplaced.length
      ? unplaced.map(m => "  " + short(m.sig) + "\n  Total=" + m.raw[cols.total] + "ms  Own=" + m.raw[cols.own] + "ms  Count=" + m.raw[cols.count] + "  \u25c4 OWN")
      : ["  (none)"]),
    "",
    "=== HIGH CALL COUNT \u2014 N+1 SUSPECTS ===",
    ...(highCall.length
      ? highCall.map(m => "  " + short(m.sig) + "\n  Total=" + m.raw[cols.total] + "ms  Own=" + m.raw[cols.own] + "ms  Count=" + m.raw[cols.count] + "  \u2192 " + m.count + "x calls")
      : ["  (none)"]),
    "",
    "=== COMPOUND N+1 SUSPECTS (count \xd7 own time) ===",
    ...(n1suspects.length
      ? n1suspects.map(m => "  " + short(m.sig) + "  Count=" + m.count + "  Own=" + m.own + "ms  Score=" + Math.round(m.count * m.own))
      : ["  (none)"]),
  ].join("\n");
}

function buildFlatReport(methods, totalRows) {
  const workers = methods.filter(m => m.own >= 0.1).sort((a, b) => b.own - a.own);
  const short = sig => {
    const p = sig.indexOf("(");
    const before = p > 0 ? sig.slice(0, p) : sig;
    return before.split(".").slice(-2).join(".");
  };
  return [
    "CPU PROFILING \u2014 FLAT REPORT (SCECommand.perform not found; showing all own-time methods)",
    "Total rows: " + totalRows + " | Methods with own time: " + workers.length,
    ""
  ].concat(workers.slice(0, 60).map(m =>
    "  " + short(m.sig) + "  Total=" + (m.raw[1] || "?") + "ms  Own=" + (m.raw[3] || "?") + "ms  Count=" + (m.raw[4] || "?")
  )).join("\n");
}

function buildDbCsvReport(rows) {
  const pt  = v => { if (!v || v === "0") return 0; const s = String(v).replace(/,/g,"").trim(); if (s.startsWith("<")) return 0.05; if (/µs|us$/i.test(s)) return parseFloat(s)/1000; if (/s$/i.test(s) && !/ms$/i.test(s)) return parseFloat(s)*1000; return parseFloat(s)||0; };
  const pct = v => { const n = parseInt(String(v).replace(/,/g,"")); return isNaN(n) ? 0 : n; };

  // Deduplicate — keep highest total, SUM counts across overloads
  const reg = new Map();
  rows.forEach(r => {
    const p    = r[0].indexOf("(");
    const base = p > 0 ? r[0].slice(0, p) : r[0];
    const totalVal = pt(r[1]), ownVal = pt(r[3]), cntVal = pct(r[4]);
    if (!reg.has(base)) {
      reg.set(base, { sig: r[0], total: totalVal, own: ownVal, count: cntVal, raw: r });
    } else {
      const ex = reg.get(base);
      ex.count += cntVal;
      if (totalVal > ex.total) { ex.total = totalVal; ex.sig = r[0]; ex.raw = r; }
      if (ownVal   > ex.own)     ex.own = ownVal;
    }
  });

  const methods = Array.from(reg.values())
    .filter(m => m.own > 0 || m.total > 5 || m.count > 50)
    .sort((a, b) => b.own - a.own || b.total - a.total);

  // ── IDIT-specific pattern detectors ─────────────────────────────────────
  const sig = m => (m.sig || "").toLowerCase();

  // Known static reference tables that should be cached
  const STATIC_CACHE_PATTERNS = [
    "dynamicdatadictionary", "tproductline", "tproductlineoption", "tproductlineoptionamount",
    "tproductlinedependency", "tchargesubtype", "tchargetypejdo", "tproductunderwritingcheck",
    "tcoverstatus", "tcontactrelationshiptype", "tdeliverytype", "tpagemetadata",
    "tstatustostatus", "tsystementity", "tsystemmodule", "batchjobcontext",
  ];
  const isStaticCache = m => STATIC_CACHE_PATTERNS.some(p => sig(m).includes(p));

  // Entities loaded per-sub-policy / per-contact (N+1 signals)
  const N1_ENTITY_PATTERNS = [
    "contactjdobean", "contactttcjdobean", "policytosubpolicyjdobean",
    "assetitemjdobean", "groupassetlocationjdobean", "policyheaderunderwritingalertjdobean",
    "coverjdobean", "coverexcessjdobean", "policycontactjdobean", "coverttcjdobean",
    "policycontactttcjdobean", "propertyjdobean",
  ];
  const isN1Entity = m => N1_ENTITY_PATTERNS.some(p => sig(m).includes(p));

  // Policy graph loading (getFullPolicy equivalent)
  const isPolicyGraph = m => sig(m).includes("policyjdobean") || sig(m).includes("policyheaderjdobean");

  // Connection pool pressure
  const isConnPool = m => sig(m).includes("select 1") || sig(m).includes("createentitymanager") || sig(m).includes("connectionpool");

  // ── Pre-diagnose patterns ─────────────────────────────────────────────────
  const staticCacheMethods = methods.filter(m => isStaticCache(m) && m.count > 50);
  const n1EntityMethods    = methods.filter(m => isN1Entity(m) && m.count > 10);
  const policyGraphMethods = methods.filter(m => isPolicyGraph(m) && m.count > 5);
  const connPoolMethods    = methods.filter(m => isConnPool(m) && m.count > 20);

  const categorise = sig => {
    const s = (sig || "").toLowerCase();
    if (s.includes("jdbc") || s.includes("preparedstatement") || s.includes("resultset") || s.includes("statement.execute")) return "JDBC";
    if ((s.includes("hibernate") || s.includes("org.hibernate")) && (s.includes("session") || s.includes("impl"))) return "Hibernate";
    if (s.includes("datanucleus") || s.includes("jdo") || s.includes("persistencemanager") || s.includes("jdoql") || s.includes("fetchplan")) return "JDO";
    if (s.includes("datasource") || s.includes("connectionpool") || s.includes("hikari") || s.includes("c3p0") || s.includes("dbcp")) return "ConnPool";
    if (s.includes("com.idit") && (s.includes("jdo") || s.includes("datamanager") || s.includes("sqlmanager") || s.includes("bulk") || s.includes("batch"))) return "IDIT-DB";
    if (s.includes("com.idit")) return "IDIT";
    return "Other";
  };

  const lines = [
    "DB PROFILING REPORT \u2014 pre-analysed for architect-level patterns",
    "Columns: Total ms | Avg ms | Call count | Diagnosis",
    "",
  ];

  // ── Section 1: PRE-DIAGNOSED CRITICAL PATTERNS (top of report for Claude) ─
  lines.push("=== PRE-DIAGNOSED PATTERNS (architect-level analysis) ===");
  lines.push("These patterns were detected by the pre-processor. Claude MUST raise findings for each.");
  lines.push("");

  if (staticCacheMethods.length > 0) {
    lines.push("--- MISSING JVM/L2 CACHE: Static reference tables queried repeatedly ---");
    lines.push("These tables hold configuration that never changes at runtime. Every query is a wasted DB round-trip.");
    lines.push("Fix: Hibernate @Cache(READ_ONLY) OR load into ConcurrentHashMap<Long,VO> at startup.");
    staticCacheMethods.sort((a,b) => b.count - a.count).forEach(m => {
      const avgMs = m.count > 0 ? Math.round(m.total / m.count) : 0;
      const sev = m.count > 1000 ? "CRITICAL" : m.count > 200 ? "HIGH" : "MEDIUM";
      lines.push("  [" + sev + "] " + m.sig);
      lines.push("  Total=" + m.raw[1] + "ms  Avg=" + avgMs + "ms  Count=" + m.count + "  \u2192 MISSING_CACHE");
    });
    lines.push("");
  }

  if (n1EntityMethods.length > 0) {
    lines.push("--- N+1 ENTITY LOADING: Entities loaded individually in a loop ---");
    lines.push("These entities are loaded per-sub-policy, per-location, or per-contact iteration.");
    lines.push("Fix: Batch load before loop (getObjectsById / IN clause / JOIN FETCH), or cache in Map<Long,VO>.");
    n1EntityMethods.sort((a,b) => b.count - a.count).forEach(m => {
      const avgMs = m.count > 0 ? Math.round(m.total / m.count) : 0;
      const sev = m.count > 500 ? "CRITICAL" : m.count > 100 ? "HIGH" : "MEDIUM";
      lines.push("  [" + sev + "] " + m.sig);
      lines.push("  Total=" + m.raw[1] + "ms  Avg=" + avgMs + "ms  Count=" + m.count + "  \u2192 N+1_LOOP");
    });
    lines.push("");
  }

  if (policyGraphMethods.length > 0) {
    lines.push("--- POLICY OBJECT GRAPH RELOADED IN LOOP ---");
    lines.push("PolicyJDOBean / PolicyHeaderJDOBean loaded multiple times. getFullPolicy loads 20+ tables each call.");
    lines.push("Fix: Load policy once before loop, pass by reference. Do NOT call getFullPolicy inside iteration.");
    policyGraphMethods.sort((a,b) => b.count - a.count).forEach(m => {
      const avgMs = m.count > 0 ? Math.round(m.total / m.count) : 0;
      lines.push("  [CRITICAL] " + m.sig);
      lines.push("  Total=" + m.raw[1] + "ms  Avg=" + avgMs + "ms  Count=" + m.count + "  \u2192 GRAPH_RELOAD_IN_LOOP");
    });
    lines.push("");
  }

  if (connPoolMethods.length > 0) {
    lines.push("--- CONNECTION POOL PRESSURE ---");
    lines.push("High SELECT 1 / createEntityManager count = pool exhaustion from long-running queries above.");
    connPoolMethods.forEach(m => {
      lines.push("  " + m.sig + "  Count=" + m.count + "  \u2192 POOL_PRESSURE_SYMPTOM");
    });
    lines.push("");
  }

  lines.push("=== ALL METHODS BY CATEGORY (sorted by own time) ===");
  lines.push("");

  // ── Section 2: Full categorised listing ───────────────────────────────────
  const cats = ["JDBC", "JDO", "Hibernate", "ConnPool", "IDIT-DB", "IDIT", "Other"];
  cats.forEach(cat => {
    const group = methods.filter(m => categorise(m.sig) === cat);
    if (!group.length) return;
    lines.push("=== " + cat + " (" + group.length + " methods) ===");
    group.slice(0, 50).forEach(m => {
      const avgMs = m.count > 0 ? Math.round(m.total / m.count) : 0;
      const sev = (m.own >= 1000 || m.count >= 5000) ? " \u25c4 CRITICAL"
                : (m.own >= 100  || m.count >= 500)  ? " \u25c4 HIGH"
                : (m.own >= 10   || m.count >= 50)   ? " \u25c4 MEDIUM" : "";
      const diag = isStaticCache(m) ? "  [MISSING_CACHE]"
                 : isN1Entity(m)    ? "  [N+1_CANDIDATE]"
                 : isPolicyGraph(m) ? "  [POLICY_GRAPH]"
                 : "";
      lines.push("  " + m.sig);
      lines.push("  Total=" + m.raw[1] + "ms  Avg=" + avgMs + "ms  Count=" + m.count + sev + diag);
    });
    lines.push("");
  });

  return lines.join("\n");
}

function parseSqlArtifact(text) {
  const lines = text.split("\n");
  if (lines.length < 3) return text;

  const hasSql   = lines.some(l => /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|MERGE|CALL)/i.test(l));
  const hasStats = lines.some(l => /\d+\s*(ms|µs|us|s\b)|\d+\/hr|elapsed|executions|avg|rows|cost/i.test(l));
  if (!hasSql && !hasStats) return text;

  const parseMs = s => {
    if (!s) return 0;
    const str = s.replace(/,/g, "");
    // microseconds
    const us = str.match(/(\d+(?:\.\d+)?)\s*(?:µs|us)\b/i);
    if (us) return parseFloat(us[1]) / 1000;
    // milliseconds
    const ms = str.match(/(\d+(?:\.\d+)?)\s*ms\b/i);
    if (ms) return parseFloat(ms[1]);
    // seconds (explicit)
    const sec = str.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i);
    if (sec) return parseFloat(sec[1]) * 1000;
    // /hr → average ms per call
    const perhr = str.match(/(\d+(?:\.\d+)?)\s*\/hr\b/i);
    if (perhr) return parseFloat(perhr[1]) / 3600 * 1000;
    return 0;
  };

  const parseRows = s => {
    const m = s.match(/rows[_\s]*(?:examined|scanned|returned|processed|fetched)?[:\s=]*(\d[\d,]*)/i)
           || s.match(/(\d[\d,]*)\s*rows/i)
           || s.match(/rows=(\d[\d,]*)/i);
    return m ? parseInt(m[1].replace(/,/g, "")) : 0;
  };

  const parseExecs = s => {
    const m = s.match(/(?:exec(?:utions?)?|calls?|count|invoc)[:\s=]*(\d[\d,]*)/i)
           || s.match(/(\d[\d,]*)\s*(?:exec|call|invoc)/i)
           || s.match(/(\d[\d,]*)\s*\/\s*hr/i);
    return m ? parseInt(m[1].replace(/,/g, "")) : 0;
  };

  const blocks = [];
  let current = [];

  const isBlockStart = l => {
    const t = l.trim();
    if (!t) return false;
    return /^\d+[\.\)\-]\s+\S/.test(t)
      || /^(SELECT|INSERT|UPDATE|DELETE|MERGE|CALL|BEGIN|WITH)\b/i.test(t)
      || /^SQL[_\s#-]/i.test(t)
      || /^Query\s*[#\d]/i.test(t)
      || /^-{3,}/.test(t)
      || /^={3,}/.test(t);
  };

  for (const line of lines) {
    if (isBlockStart(line) && current.length > 0) {
      blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);

  if (blocks.length <= 1) {
    return "SQL REPORT (full text, " + lines.length + " lines):\n" + text.slice(0, 14000);
  }

  const scored = blocks.map((b, idx) => {
    const joined   = b.join(" ");
    const elapsed  = parseMs(joined);
    const execs    = parseExecs(joined);
    const rows     = parseRows(joined);
    const avgMs    = execs > 1 && elapsed > 0 ? elapsed / execs : elapsed;
    const totalCost = elapsed > 0 ? elapsed : avgMs * Math.max(1, execs);

    const problems = [];
    if (/full.?table.?scan|type.*ALL\b|table.?access.?full/i.test(joined)) problems.push("FULL_SCAN");
    if (/no.*index|missing.*index|index.*miss|without.*index/i.test(joined)) problems.push("MISSING_INDEX");
    if (execs > 1000 || (execs > 100 && avgMs > 100)) problems.push("HIGH_FREQUENCY");
    if (/lock|wait.*lock|row.*lock|deadlock/i.test(joined)) problems.push("LOCK");
    if (/n\+1|n \+ 1|loop.*select/i.test(joined) || (execs > 5000 && avgMs < 5)) problems.push("N+1");
    if (/cartesian|cross.*join/i.test(joined)) problems.push("CARTESIAN");
    if (/select \*/i.test(joined)) problems.push("SELECT_STAR");
    if (rows > 100000) problems.push("LARGE_ROWSET");

    return { lines: b, totalCost, elapsed, avgMs, execs, rows, problems, idx };
  }).filter(b => b.lines.some(l => l.trim().length > 5));

  scored.sort((a, b) => b.totalCost - a.totalCost);

  const out = [
    "SQL EXECUTION REPORT \u2014 " + scored.length + " queries sorted by total cost (slowest first)",
    "FORMAT: Each block = full query + all timing/stats. Analyze ALL queries.",
    "For each: identify problem, suggest CREATE INDEX or rewrite. Flag N+1 if execs > 1000 with low avg ms.",
    ""
  ];

  scored.forEach((b, i) => {
    const costStr = b.totalCost > 0
      ? " [cost=" + Math.round(b.totalCost) + "ms"
        + (b.execs > 0 ? ", execs=" + b.execs : "")
        + (b.avgMs > 0 ? ", avg=" + Math.round(b.avgMs) + "ms" : "")
        + (b.rows  > 0 ? ", rows=" + b.rows : "")
        + (b.problems.length > 0 ? ", flags=" + b.problems.join("+") : "")
        + "]"
      : "";
    out.push("=== QUERY " + (i + 1) + costStr + " ===");
    b.lines.forEach(l => { if (l.trim()) out.push(l); });
    out.push("");
  });

  return out.join("\n");
}


function parseDbCallList(csvText) {
  // Parses JProfiler/YourKit DB tab: "Call","Time (ms)","Avg. (ms)","Count"
  // NO project filtering — all queries analysed. Top 30 by score, rest summarised.
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return csvText;

  const parseNum = v => parseFloat(String(v||"0").replace(/[",]/g,"").trim()) || 0;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Parse CSV row (handle quoted fields that contain commas)
    const cols = [];
    let col = "", inQ = false;
    for (const ch of lines[i] + ",") {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cols.push(col.trim()); col = ""; continue; }
      col += ch;
    }
    if (cols.length < 3 || !cols[0]) continue;
    const call  = cols[0];
    const total = parseNum(cols[1]);
    const avg   = parseNum(cols[2]);
    const count = parseNum(cols[3]);
    if (total === 0 && count === 0) continue;
    rows.push({ call, total, avg, count });
  }

  if (rows.length === 0) return csvText;

  // Score = total ms weighted by count (high total AND high count = worst)
  const score = r => r.total * 0.6 + r.count * r.avg * 0.4;
  rows.sort((a, b) => score(b) - score(a));

  const pt = v => { if (!v || v === "0") return 0; return parseFloat(String(v).replace(/,/g,"").trim()) || 0; };

  // ── Pattern detectors ────────────────────────────────────────────────────
  const STATIC_CACHE = ["dynamicdatadictionary","tproductline","tproductlineoption",
    "tchargesubtype","tchargetypejdo","tproductunderwritingcheck","tcoverstatus",
    "tcontactrelationshiptype","tsystementity","tsystemmodule","batchjobcontext"];
  const N1_ENTITIES = ["contactjdo","policytosubpolicyjdo","assetitemjdo",
    "groupassetlocationjdo","policyheaderunderwritingalert","coverjdo",
    "coverexcessjdo","policycontactjdo","propertyjdo","policyjdo"];
  const cl = r => r.call.toLowerCase();
  const isCache = r => STATIC_CACHE.some(p => cl(r).includes(p));
  const isN1    = r => N1_ENTITIES.some(p => cl(r).includes(p)) && r.count > 10;
  const isGraph = r => (cl(r).includes("policyjdo") || cl(r).includes("policyheaderjdo")) && r.count > 5;
  const isPool  = r => cl(r).includes("select 1") || cl(r).includes("createentitymanager");
  const isMissIdx = r => cl(r).includes("policytosubpolicy") && r.avg > 50;

  const sevOf = r => {
    if (r.total > 10000 || r.count > 5000 || r.avg > 500) return "CRITICAL";
    if (r.total > 2000  || r.count > 500  || r.avg > 100) return "HIGH";
    if (r.total > 500   || r.count > 100  || r.avg > 30)  return "MEDIUM";
    return "LOW";
  };

  const diagOf = r => {
    const tags = [];
    if (isCache(r))   tags.push("MISSING_CACHE — static reference data, load into JVM ConcurrentHashMap at startup");
    if (isN1(r))      tags.push("N+1 — entity loaded individually per-sub-policy/per-contact, use batch fetch");
    if (isGraph(r))   tags.push("POLICY_GRAPH_RELOAD — getFullPolicy called in loop, load once before iteration");
    if (isMissIdx(r)) tags.push("MISSING_INDEX — verify index on POLICY_ID + STATUS columns");
    if (isPool(r))    tags.push("POOL_PRESSURE — symptom of long-running queries above");
    return tags.join("; ") || "";
  };

  const lines2 = [
    "DB CALL-LIST REPORT — Top 30 by cost (total ms + count weighted) — NO project filter applied",
    "ALL queries included. Columns: Total ms | Avg ms | Count | Severity | Diagnosis",
    "Source rows: " + rows.length + " unique calls analysed",
    "",
  ];

  // ── Pre-diagnosed critical patterns block ─────────────────────────────────
  const critRows = rows.filter(r => isCache(r) || isN1(r) || isGraph(r) || isMissIdx(r));
  if (critRows.length > 0) {
    lines2.push("=== PRE-DIAGNOSED PATTERNS (Claude MUST raise a dbFinding for each) ===");
    critRows.forEach(r => {
      const sev = sevOf(r);
      lines2.push("  [" + sev + "] " + r.call);
      lines2.push("  Total=" + r.total + "ms  Avg=" + Math.round(r.avg) + "ms  Count=" + r.count);
      lines2.push("  DIAGNOSIS: " + diagOf(r));
    });
    lines2.push("");
  }

  // ── Top 30 by score ───────────────────────────────────────────────────────
  lines2.push("=== TOP 30 CALLS BY COST (slowest + most frequent) ===");
  rows.slice(0, 30).forEach((r, i) => {
    const sev  = sevOf(r);
    const diag = diagOf(r);
    lines2.push((i+1) + ". [" + sev + "] " + r.call);
    lines2.push("   Total=" + r.total + "ms  Avg=" + Math.round(r.avg) + "ms  Count=" + r.count
      + (diag ? "  ← " + diag.split(";")[0] : ""));
  });
  lines2.push("");

  // ── Remaining summary ─────────────────────────────────────────────────────
  if (rows.length > 30) {
    const rest = rows.slice(30);
    const restTotal = rest.reduce((s,r) => s + r.total, 0);
    lines2.push("=== REMAINING " + rest.length + " CALLS (total " + Math.round(restTotal) + "ms) ===");
    rest.forEach(r => {
      lines2.push("  " + r.call + "  Total=" + r.total + "ms  Avg=" + Math.round(r.avg) + "ms  Count=" + r.count);
    });
  }

  return lines2.join("\n");
}

function detectAndProcess(text, filename) {
  const ext      = (filename || "").split(".").pop().toLowerCase();
  const nameLower = (filename || "").toLowerCase();

  // Excel binary — can't parse, signal clearly
  if (ext === "xlsx" || ext === "xls") {
    return {
      type: "unsupported",
      content: "[Excel file detected: " + filename + ". Please export as CSV (File \u2192 Save As \u2192 CSV) and re-upload.]"
    };
  }

  const sample = text.slice(0, 1500);

  // ── JProfiler / YourKit DB call-list format: "Call","Time (ms)","Avg. (ms)","Count" ──
  const isDbCallList =
    text.includes(",") &&
    /^"?Call"?\s*,\s*"?Time/i.test(text.trim()) &&
    /(JPA\/Hibernate|jdbc|SELECT|INSERT|UPDATE|DELETE|getResultList)/i.test(text.slice(0, 3000));

  if (isDbCallList || (ext === "csv" && /db|database|sql|query|jdbc|hibernate|jdo|persist/i.test(nameLower) && /JPA\/Hibernate|getResultList/i.test(sample))) {
    return { type: "dbcsv", content: parseDbCallList(text) };
  }

  // ── Method-level CPU/DB profiling CSV: has Own Time / Invocations columns ─
  const isProfilingCsv =
    text.includes(",") &&
    /Time \(ms\)|Own Time|Self Time|Cumulative|Inclusive|Exclusive|Invocations|Method.*Count|Call Count|Self,|Total,/i.test(sample);

  if (ext === "csv" || isProfilingCsv) {
    const isDbByName    = /db|database|sql|query|jdbc|hibernate|jdo|persist/i.test(nameLower);
    const isDbByContent = /jdbc|preparedstatement|hibernate|datanucleus|persistencemanager|jdoql|sqlmanager/i.test(sample);
    const isDbCsv       = isDbByName || isDbByContent;
    const result        = parseCsvArtifact(text, isDbCsv);
    const type          = result.startsWith("DB PROFILING") ? "dbcsv" : "csv";
    return { type, content: result };
  }

  const upper    = text.slice(0, 2000).toUpperCase();
  const sqlCount = (upper.match(/\bSELECT\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b/g) || []).length;
  if (sqlCount >= 2 && /\d+\s*(MS|µS|US)\b|\d+\/HR|ELAPSED|EXECUTIONS|AVG.*MS/i.test(upper)) {
    return { type: "sql", content: parseSqlArtifact(text) };
  }

  return { type: "text", content: text };
}


function filterIdit(text, projectName) {
  const nameLower = (projectName||"").toLowerCase().trim();
  // Always include core IDIT and alphacsp packages
  const prefixes = ["com.idit", "com.alphacsp"];

  // Add project-specific package: e.g. "TTC" → "com.idit.ttc", "EIG" → "com.idit.eig"
  // This ensures CSV rows are filtered to the selected project's classes
  if (nameLower.length >= 2) {
    prefixes.push("com.idit." + nameLower);          // com.idit.ttc, com.idit.eig, etc.
    prefixes.push("com.alphacsp." + nameLower);       // com.alphacsp.ttc if exists
    // Also match classes ending with the project name (e.g. PolicyManagerTTC, ChargesManagerTTC)
    prefixes.push(nameLower.toUpperCase());            // raw suffix match e.g. "TTC"
  }

  if (text.startsWith("SQL EXECUTION REPORT") || text.startsWith("SQL REPORT")
      || text.startsWith("DB PROFILING REPORT")) {
    return text;  // DB reports always pass through unfiltered
  }

  return text.split("\n").filter(l => {
    const ll = l.toLowerCase();
    const t  = l.trim();
    // Include lines that mention any relevant package prefix
    if (prefixes.some(p => ll.includes(p.toLowerCase()))) return true;
    // Include structural/header lines
    if (/^(CPU|THREAD|SQL|IDIT|===|---|SELECT|UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)/i.test(t)) return true;
    // Include metric lines
    if (/\d+\s*ms\b|\d+\/hr|avg.*ms|elapsed|executions|table scan|index|lock|wait|Total=|Own=|Count=/i.test(t)) return true;
    // Include blank lines (preserve structure)
    return t === "";
  }).join("\n");
}

function Badge({ s, T }) {
  const c = SEV_STYLE[s]||SEV_STYLE.LOW;
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:c.bg,color:c.text,border:"1px solid "+c.border,fontFamily:"var(--font-mono)",whiteSpace:"nowrap"}}>
    <span style={{width:5,height:5,borderRadius:"50%",background:c.dot}}/>{s}
  </span>;
}
function Pill({text,color}) {
  return <span style={{fontSize:10,padding:"2px 7px",borderRadius:20,fontFamily:"var(--font-mono)",fontWeight:600,background:color+"18",color,border:"1px solid "+color+"44",whiteSpace:"nowrap"}}>{text}</span>;
}
function Ring({score,label,note,large,T}) {
  const sz=large?88:70, r=large?32:24;
  const c=2*Math.PI*r, p=Math.min(100,Math.max(0,score||0));
  const col=p>=70?"#22c55e":p>=40?"#f97316":"#ef4444";
  const trk=p>=70?"#bbf7d0":p>=40?"#fed7aa":"#fecaca";
  return <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
    <svg width={sz} height={sz} viewBox="0 0 80 80">
      <circle cx="40" cy="40" r={r} fill="none" stroke={trk} strokeWidth={large?7:6}/>
      <circle cx="40" cy="40" r={r} fill="none" stroke={col} strokeWidth={large?7:6}
        strokeDasharray={(p/100*c)+" "+c} strokeLinecap="round" transform="rotate(-90 40 40)"/>
      <text x="40" y="45" textAnchor="middle" fontSize={large?17:13} fontWeight="700" fill={col} fontFamily="var(--font-mono)">{p}</text>
    </svg>
    <div style={{textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:600,color:T.txt}}>{label}</div>
      {note&&<div style={{fontSize:9,color:T.muted,maxWidth:72,lineHeight:1.3,marginTop:1}}>{note}</div>}
    </div>
  </div>;
}
function CodeBlock({v,good,T}) {
  if (!v) return null;
  const bg=good?T.codeGoodBg:T.codeBadBg, bdr=good?T.codeGoodBdr:T.codeBadBdr, col=good?T.codeGoodTxt:T.codeBadTxt;
  return <pre style={{fontFamily:"var(--font-mono)",fontSize:11,margin:0,background:bg,padding:"8px 10px",borderRadius:6,border:"0.5px solid "+bdr,borderLeft:"3px solid "+bdr,whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.6,color:col}}>{(v||"").replace(/\\n/g,"\n")}</pre>;
}
function FL({label,value,T,mono,code,good}) {
  if (!value&&value!==0) return null;
  return <div style={{marginBottom:7}}>
    <div style={{fontSize:10,color:T.muted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2,fontWeight:600}}>{label}</div>
    {code?<CodeBlock v={String(value)} good={good} T={T}/>:<div style={{fontSize:12,lineHeight:1.6,color:T.txt,fontFamily:mono?"var(--font-mono)":undefined}}>{value}</div>}
  </div>;
}
function Gain({text}) {
  if (!text) return null;
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"#f0fdf4",border:"1px solid #86efac",borderRadius:20,padding:"2px 9px",fontSize:10,color:"#15803d",fontWeight:600,marginTop:5}}>
    <i className="ti ti-trending-up" style={{fontSize:11}} aria-hidden="true"/>{text}
  </span>;
}
function CardWrap({sev,head,children,T}) {
  const dot=SEV_STYLE[sev]?.dot||"#888";
  return <div style={{background:T.surf,border:"0.5px solid "+T.bdr,borderLeft:"3px solid "+dot,borderRadius:9,overflow:"hidden",marginBottom:9}}>
    <div style={{padding:"9px 12px",background:T.surf2,borderBottom:"0.5px solid "+T.bdr,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:6}}>{head}</div>
    <div style={{padding:"11px 12px"}}>{children}</div>
  </div>;
}
function Empty({label,T}) {
  return <div style={{textAlign:"center",padding:"32px 20px"}}>
    <i className="ti ti-circle-check" style={{fontSize:26,color:"#22c55e",display:"block",marginBottom:6}} aria-hidden="true"/>
    <div style={{fontSize:13,fontWeight:600,color:T.txt,marginBottom:2}}>No {label} issues found</div>
    <div style={{fontSize:11,color:T.muted}}>No com.idit.* evidence for this category in the artifacts.</div>
  </div>;
}
function SectionBox({title,icon,accent,children,T}) {
  return <div style={{background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:9,overflow:"hidden",marginBottom:11}}>
    <div style={{display:"flex",alignItems:"center",gap:7,padding:"9px 13px",background:T.surf2,borderBottom:"0.5px solid "+T.bdr,borderLeft:accent?"3px solid "+accent:undefined}}>
      <i className={"ti "+icon} style={{fontSize:14,color:T.muted}} aria-hidden="true"/>
      <span style={{fontSize:12,fontWeight:600,color:T.txt}}>{title}</span>
    </div>
    <div style={{padding:"11px 13px"}}>{children}</div>
  </div>;
}

function MethodFixer({finding, findingType, T}) {
  const [expanded, setExpanded] = useState(false);
  const [methodSrc, setMethodSrc] = useState("");
  const [status, setStatus]  = useState("idle");
  const [result, setResult]  = useState(null);
  const [copied, setCopied]  = useState(false);

  const hotspotName = (finding.hotspot||finding.component||finding.id||"method").split("(")[0].split(".").pop();

  const fixMethod = async () => {
    if (!methodSrc.trim()) return;
    setStatus("loading"); setResult(null);

    const sys = 'You are a Java performance engineer. Fix ONLY the described issue in the method. Keep same signature and business logic. Add comment on each changed line. Return ONLY JSON: {"fixedCode":"full fixed method (\\n for newlines)","changes":"what changed","estimatedGain":"improvement"}';

    const msg = findingType+" finding: "+(finding.hotspot||finding.component||"")
      +"\nProblem: "+(finding.cause||finding.issue||finding.problem||"")
      +"\nFix: "+(finding.fix||"")+"\n\nJAVA SOURCE CODE:\n"+methodSrc
      +"\n\nFix the performance issue. Return only the JSON.";

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-6",
          max_tokens:3000,
          system: sys,
          messages:[{role:"user", content:msg}]
        })
      });
      if (!resp.ok) throw new Error("API error "+resp.status);
      const data = await resp.json();
      const raw = (data.content||[]).map(b=>b.type==="text"?b.text:"").join("");
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      if (s===-1) throw new Error("No JSON in response");
      let extracted = raw.slice(s, e+1);
      let parsed;
      try { parsed = JSON.parse(extracted); }
      catch(_) {
        const fixed = extracted
          .replace(/\\'/g,"'").replace(/\t/g," ")
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"")
          .replace(/,\s*([}\]])/g,"$1");
        try { parsed = JSON.parse(fixed); }
        catch(e2) { throw new Error("Could not parse Claude response: "+e2.message); }
      }
      setResult(parsed); setStatus("done");
    } catch(err) {
      setResult({error: err.message}); setStatus("error");
    }
  };

  return (
    <div style={{marginTop:10, border:"1px solid "+T.bdr, borderRadius:8, overflow:"hidden", background:T.surf2}}>
      <button onClick={()=>setExpanded(x=>!x)}
        style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"8px 11px",background:"transparent",border:"none",cursor:"pointer",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <i className="ti ti-wand" style={{fontSize:13,color:"#7c3aed"}} aria-hidden="true"/>
          <span style={{fontSize:11,fontWeight:700,color:"#7c3aed"}}>Fix This Method</span>
          <span style={{fontSize:10,color:T.muted}}>paste the Java source → get optimised version</span>
        </div>
        <i className={"ti ti-chevron-"+(expanded?"up":"down")} style={{fontSize:12,color:T.muted}} aria-hidden="true"/>
      </button>

      {expanded && (
        <div style={{padding:"10px 11px",borderTop:"0.5px solid "+T.bdr}}>
          <div style={{fontSize:11,color:T.muted,marginBottom:7,display:"flex",alignItems:"center",gap:5}}>
            <i className="ti ti-info-circle" style={{fontSize:11}} aria-hidden="true"/>
            Open your IDE, copy the full source of
            <code style={{fontFamily:"var(--font-mono)",fontSize:10,color:T.acc,background:T.accBg,padding:"0 4px",borderRadius:3}}>
              {hotspotName}
            </code>
            and paste it below
          </div>

          <textarea
            value={methodSrc}
            onChange={e=>setMethodSrc(e.target.value)}
            placeholder={"public void "+hotspotName+"(...) {\n    // paste your full method source here\n}"}
            rows={8}
            style={{width:"100%",boxSizing:"border-box",
              background:"#010409",color:"#79c0ff",
              border:"1px solid "+T.bdr,borderRadius:7,
              padding:"8px 10px",fontFamily:"var(--font-mono)",
              fontSize:11,lineHeight:1.7,resize:"vertical",
              marginBottom:8,outline:"none"}}
          />

          <button
            onClick={fixMethod}
            disabled={!methodSrc.trim() || status==="loading"}
            style={{display:"flex",alignItems:"center",gap:6,
              padding:"8px 16px",borderRadius:8,border:"none",cursor:"pointer",
              background:methodSrc.trim()&&status!=="loading"?"linear-gradient(135deg,#4c1d95,#7c3aed)":"#21262d",
              color:methodSrc.trim()&&status!=="loading"?"#fff":"#8b949e",
              fontSize:12,fontWeight:700,opacity:!methodSrc.trim()?0.5:1}}
          >
            {status==="loading"
              ? <><i className="ti ti-loader-2" style={{fontSize:13,animation:"spin 1s linear infinite"}} aria-hidden="true"/>Fixing...</>
              : <><i className="ti ti-wand" style={{fontSize:13}} aria-hidden="true"/>Fix This Method</>}
          </button>

          {status==="done" && result && !result.error && (
            <div style={{marginTop:11}}>
              <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                <div style={{flex:1,background:"#0d2d1a",border:"0.5px solid #166534",borderRadius:8,padding:"8px 11px"}}>
                  <div style={{fontSize:9,color:"#3fb950",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>What Changed</div>
                  <div style={{fontSize:11,color:"#56d364",lineHeight:1.6}}>{result.changes}</div>
                </div>
                <div style={{background:"#0d1f38",border:"0.5px solid #1e40af",borderRadius:8,padding:"8px 11px",minWidth:140}}>
                  <div style={{fontSize:9,color:"#58a6ff",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>Expected Gain</div>
                  <div style={{fontSize:12,color:"#79c0ff",fontWeight:600}}>{result.estimatedGain}</div>
                </div>
              </div>

              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <div style={{fontSize:10,color:"#3fb950",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",display:"flex",alignItems:"center",gap:4}}>
                  <i className="ti ti-check" style={{fontSize:11}} aria-hidden="true"/>Fixed Method
                </div>
                <button onClick={()=>{
                    try{navigator.clipboard.writeText(result.fixedCode||"");}catch(e){}
                    setCopied(true); setTimeout(()=>setCopied(false),2000);
                  }}
                  style={{display:"flex",alignItems:"center",gap:4,padding:"3px 9px",
                    background:copied?"#0d2d1a":"#21262d",
                    border:"1px solid "+(copied?"#3fb950":"#30363d"),
                    borderRadius:20,cursor:"pointer",
                    color:copied?"#3fb950":"#8b949e",fontSize:10,fontWeight:600}}>
                  <i className={"ti "+(copied?"ti-check":"ti-copy")} style={{fontSize:11}} aria-hidden="true"/>
                  {copied?"Copied!":"Copy"}
                </button>
              </div>

              <pre style={{background:"#010409",color:"#56d364",
                border:"0.5px solid #166534",borderLeft:"3px solid #3fb950",
                borderRadius:7,padding:"10px 12px",
                fontFamily:"var(--font-mono)",fontSize:11,
                lineHeight:1.7,overflowX:"auto",
                whiteSpace:"pre-wrap",wordBreak:"break-word",
                maxHeight:400,overflowY:"auto",margin:0}}>
                {result.fixedCode||""}
              </pre>

              <button onClick={()=>{setStatus("idle");setResult(null);}}
                style={{marginTop:8,display:"flex",alignItems:"center",gap:4,
                  padding:"4px 10px",background:"transparent",
                  border:"1px solid "+T.bdr,borderRadius:20,cursor:"pointer",
                  color:T.muted,fontSize:10}}>
                <i className="ti ti-refresh" style={{fontSize:11}} aria-hidden="true"/>Try again
              </button>
            </div>
          )}

          {status==="error" && (
            <div style={{marginTop:9,background:"#3d1414",border:"1px solid #7f1d1d",
              borderRadius:8,padding:"8px 11px",color:"#ff7b72",fontSize:11}}>
              <i className="ti ti-alert-circle" style={{fontSize:12,marginRight:5}} aria-hidden="true"/>
              {result?.error||"Error — check your API key and try again"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CpuCard({f,T}) {
  return <CardWrap sev={f.sev} T={T} head={<>
    <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}><Badge s={f.sev} T={T}/><span style={{fontFamily:"var(--font-mono)",fontSize:11,fontWeight:600,color:T.txt}}>{f.hotspot}</span></div>
    <div style={{display:"flex",gap:5}}>{f.cpu&&<Pill text={f.cpu} color="#ef4444"/>}{f.calls&&<Pill text={f.calls} color="#3b82f6"/>}</div>
  </>}>
    <FL label="Root Cause" value={f.cause} T={T}/>
    <FL label="Fix" value={f.fix} T={T}/>
    {f.code&&<FL label="Code Change" value={f.code} T={T} code good/>}
    <Gain text={f.gain}/>
    <MethodFixer finding={f} findingType="CPU" T={T}/>
  </CardWrap>;
}
function ThreadCard({f,T}) {
  const tc={DEADLOCK:"#dc2626",CONTENTION:"#ea580c",EXHAUSTION:"#7c3aed",BLOCKED:"#d97706",WAITING:"#2563eb"}[f.type]||"#6b7280";
  return <CardWrap sev={f.sev} T={T} head={<>
    <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}><Badge s={f.sev} T={T}/><span style={{fontFamily:"var(--font-mono)",fontSize:11,fontWeight:600,color:T.txt}}>{f.pool}</span></div>
    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{f.type&&<Pill text={f.type} color={tc}/>}{f.active&&<Pill text={f.active} color="#6b7280"/>}{f.blocked&&<Pill text={f.blocked+" blocked"} color="#dc2626"/>}</div>
  </>}>
    {f.lock&&<FL label="Lock" value={f.lock} T={T} mono/>}
    <FL label="Root Cause" value={f.cause} T={T}/>
    <FL label="Fix" value={f.fix} T={T}/>
    {f.code&&<FL label="Code Change" value={f.code} T={T} code good/>}
    <Gain text={f.gain}/>
  </CardWrap>;
}
function DbCard({f,T}) {
  const probColors = {"FULL_SCAN":"#dc2626","MISSING_INDEX":"#ea580c","N+1":"#7c3aed","LOCK":"#d97706","HIGH_FREQUENCY":"#2563eb"};
  const probCol = probColors[f.problem] || probColors[(f.problem||"").split("|")[0]] || "#6b7280";
  return <CardWrap sev={f.sev} T={T} head={<>
    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
      <Badge s={f.sev} T={T}/>
      {f.id&&<Pill text={f.id} color="#6b7280"/>}
      {f.table&&<Pill text={f.table} color="#0891b2"/>}
      {f.problem&&<Pill text={f.problem} color={probCol}/>}
    </div>
    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
      {f.execs&&<Pill text={f.execs+" execs"} color="#7c3aed"/>}
      {f.avgMs&&<Pill text={f.avgMs+"ms avg"} color="#dc2626"/>}
      {f.totalCost&&<Pill text={"total: "+f.totalCost} color="#d97706"/>}
      {f.execHr&&<Pill text={f.execHr+"/hr"} color="#7c3aed"/>}
      {f.costHr&&<Pill text={f.costHr} color="#d97706"/>}
    </div>
  </>}>
    {f.sql&&<FL label="SQL Query" value={f.sql} T={T} code/>}
    <FL label="Problem" value={f.problem} T={T}/>
    {f.index&&<div style={{marginBottom:7}}>
      <div style={{fontSize:10,color:T.muted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2,fontWeight:600}}>Suggested Index</div>
      <CodeBlock v={f.index} good T={T}/>
    </div>}
    <FL label="Fix" value={f.fix} T={T}/>
    {f.code&&<FL label="Code Change" value={f.code} T={T} code good/>}
    <Gain text={f.gain}/>
  </CardWrap>;
}

function IditCard({f,T}) {
  return <CardWrap sev={f.sev} T={T} head={<div style={{display:"flex",alignItems:"center",gap:7}}><Badge s={f.sev} T={T}/><span style={{fontFamily:"var(--font-mono)",fontSize:11,fontWeight:600,color:T.txt}}>{f.component}</span></div>}>
    <FL label="Issue" value={f.issue} T={T}/>
    <FL label="Current Behavior" value={f.current} T={T}/>
    <FL label="Fix" value={f.fix} T={T}/>
    {f.code&&<FL label="Config Change" value={f.code} T={T} code good/>}
    <Gain text={f.gain}/>
    <MethodFixer finding={f} findingType="IDIT" T={T}/>
  </CardWrap>;
}
function CodeCard({f,T}) {
  const tc={"N+1_QUERY":"#7c3aed","INEFFICIENT_LOOP":"#ea580c","MISSING_CACHE":"#2563eb","SYNCHRONIZATION":"#dc2626","COLLECTION_MISUSE":"#d97706","ALGORITHM":"#0891b2"}[f.type]||"#6b7280";
  return <CardWrap sev={f.sev} T={T} head={<>
    <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}><Badge s={f.sev} T={T}/><span style={{fontFamily:"var(--font-mono)",fontSize:10,color:T.muted}}>{f.class}</span><span style={{color:T.faint}}>›</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,fontWeight:700,color:T.txt}}>{f.method}</span></div>
    {f.type&&<Pill text={f.type.replace(/_/g," ")} color={tc}/>}
  </>}>
    {f.file&&<div style={{fontSize:10,color:T.muted,marginBottom:7,fontFamily:"var(--font-mono)",display:"flex",alignItems:"center",gap:4}}><i className="ti ti-file-code" style={{fontSize:11}} aria-hidden="true"/>{f.file}</div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:7}}>
      <div><div style={{fontSize:9,color:"#dc2626",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Before</div><CodeBlock v={f.before} T={T}/></div>
      <div><div style={{fontSize:9,color:"#16a34a",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>After</div><CodeBlock v={f.after} T={T} good/></div>
    </div>
    <FL label="Why" value={f.why} T={T}/>
    <Gain text={f.gain}/>
  </CardWrap>;
}


// ── HistoryPanel component ─────────────────────────────────────────────────
function HistoryPanel({ history, T, onOpen, onDelete }) {
  const sevColor = {CRITICAL:"#b91c1c",HIGH:"#c2410c",MEDIUM:"#a16207",LOW:"#15803d"};
  const sevBg    = {CRITICAL:"#fef2f2",HIGH:"#fff7ed",MEDIUM:"#fefce8",LOW:"#f0fdf4"};

  if (!history || history.length === 0) {
    return <div style={{textAlign:"center",padding:"48px 20px",color:T.muted}}>
      <i className="ti ti-history" style={{fontSize:36,display:"block",marginBottom:12,opacity:.3}} aria-hidden="true"/>
      <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>No saved analyses yet</div>
      <div style={{fontSize:12}}>Every analysis is saved automatically. Run an analysis to see it here.</div>
    </div>;
  }

  return <div>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
      <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.08em"}}>
        {history.length} saved {history.length===1?"analysis":"analyses"} (newest first)
      </div>
      <button
        onClick={()=>{ if(window.confirm("Delete all saved analyses?")){ localStorage.removeItem("idit_analysis_history"); window.location.reload(); } }}
        style={{fontSize:10,color:"#ef4444",background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:6,padding:"3px 8px",cursor:"pointer",fontWeight:600}}>
        Clear all
      </button>
    </div>

    {history.map(entry => {
      const rc = sevColor[entry.rating]||T.muted;
      const rb = sevBg[entry.rating]||T.surf2;
      const c  = entry.counts||{};
      return <div key={entry.id}
        style={{background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:10,marginBottom:10,overflow:"hidden",transition:"box-shadow .15s"}}
        onMouseEnter={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(0,0,0,0.1)"}
        onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>

        {/* Card header */}
        <div style={{padding:"11px 14px",borderBottom:"0.5px solid "+T.bdr,display:"flex",alignItems:"center",gap:10,background:T.surf2}}>
          <div style={{width:34,height:34,borderRadius:8,background:"linear-gradient(135deg,#1e1b4b,#1e40af)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <i className="ti ti-report-analytics" style={{fontSize:15,color:"#fff"}} aria-hidden="true"/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12,fontWeight:700,color:T.txt,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{entry.label}</div>
            <div style={{fontSize:10,color:T.muted,marginTop:2}}>{historyFmtDate(entry.savedAt)} · {(entry.tokens||0).toLocaleString()} tokens</div>
          </div>
          {entry.rating&&<span style={{fontSize:10,fontWeight:700,color:rc,background:rb,border:"1px solid "+rc+"44",padding:"2px 9px",borderRadius:12,flexShrink:0}}>{entry.rating}</span>}
        </div>

        {/* Counts row */}
        <div style={{padding:"9px 14px",display:"flex",gap:8,alignItems:"center",borderBottom:"0.5px solid "+T.bdr}}>
          {[["CRITICAL",c.critical,"#ef4444"],["HIGH",c.high,"#f97316"],["MEDIUM",c.medium,"#eab308"],["LOW",c.low,"#22c55e"]].map(([lbl,n,col])=>
            n>0 ? <span key={lbl} style={{fontSize:10,fontWeight:700,color:col,background:col+"15",padding:"2px 7px",borderRadius:8}}>
              {n} {lbl}
            </span> : null
          )}
          {c.total>0&&<span style={{fontSize:10,color:T.muted,marginLeft:"auto"}}>{c.total} total finding{c.total!==1?"s":""}</span>}
        </div>

        {/* Action row */}
        <div style={{padding:"9px 14px",display:"flex",gap:8}}>
          <button
            onClick={()=>onOpen(entry)}
            style={{flex:1,padding:"7px 14px",background:"linear-gradient(135deg,#1e40af,#0369a1)",color:"#fff",border:"none",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <i className="ti ti-eye" style={{fontSize:12}} aria-hidden="true"/>
            Open Analysis
          </button>
          <button
            onClick={()=>{ if(window.confirm("Delete this analysis?")) onDelete(entry.id); }}
            style={{padding:"7px 10px",background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:7,cursor:"pointer",color:T.muted,display:"flex",alignItems:"center"}}>
            <i className="ti ti-trash" style={{fontSize:13}} aria-hidden="true"/>
          </button>
        </div>
      </div>;
    })}
  </div>;
}

const TABS = [
  {id:"actions", label:"Actions",   icon:"ti-bolt"},
  {id:"summary", label:"Overview",  icon:"ti-layout-dashboard"},
  {id:"cpu",     label:"CPU",       icon:"ti-cpu"},
  {id:"db",      label:"Database",  icon:"ti-database"},
  {id:"audit",   label:"Audit Log", icon:"ti-terminal-2"},
  {id:"history", label:"History",   icon:"ti-history"},
];

// ── History helpers ────────────────────────────────────────────────────────
const HISTORY_KEY = "idit_analysis_history";
const MAX_HISTORY = 30;

function historyLoad() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)||"[]"); }
  catch(_) { return []; }
}
function historySave(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch(_) {}
}
function historyAdd(entry) {
  const list = historyLoad();
  list.unshift(entry);
  historySave(list.slice(0, MAX_HISTORY));
}
function historyDelete(id) {
  historySave(historyLoad().filter(e => e.id !== id));
}
function historyFmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"})
      + " " + d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});
  } catch(_) { return iso; }
}

export default function App() {
  const [dark, setDark] = useState(false);
  const T = dark ? DARK : LIGHT;

  const [projName, setProjName] = useState("");
  const [env, setEnv] = useState("UAT");
  const [build, setBuild] = useState("");
  const [goal, setGoal] = useState("");
  const [pasted, setPasted] = useState(SAMPLE);
  const [files, setFiles] = useState([]);
  const [ferrs, setFerrs] = useState({});
  const [gErr, setGErr] = useState("");

  const [phase, setPhase] = useState("input");
  const [result, setResult] = useState(null);
  const [tab, setTab] = useState("actions");
  const [dragOver, setDragOver] = useState(false);

  const [auditLog, setAuditLog] = useState([]);
  const [tokens, setTokens] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [streamDone, setStreamDone] = useState(false);
  const [history, setHistory] = useState(() => historyLoad());
  const [viewingHistory, setViewingHistory] = useState(false); // true when result loaded from history
  const [analyzingPhase, setAnalyzingPhase] = useState("");

  const logRef = useRef(null);
  const timerRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [auditLog]);

  const addLog = useCallback((msg, type="info") => {
    const ts = new Date().toLocaleTimeString("en-US",{hour12:false});
    setAuditLog(p => [...p, {msg, type, ts}]);
  }, []);

  const validate = () => {
    const e = {};
    if (!projName.trim()) e.projName = "Please select a project";
    if (!build.trim())    e.build    = "Analysis Name is required";
    if (!pasted.trim() && files.length===0) e.arts = "Provide at least one artifact";
    return e;
  };

  const readAllFiles = async (flist) => {
    return Promise.all(flist.map(async f => {
      const ext = f.name.split(".").pop().toLowerCase();
      setFiles(p => p.map(pf => pf.name===f.name ? {...pf, st:"reading"} : pf));
      addLog("Reading "+f.name+" ("+Math.round(f.size/1024)+"KB)", "info");
      if (["zip","xlsx","xls","jar","class"].includes(ext)) {
        setFiles(p => p.map(pf => pf.name===f.name ? {...pf, st:"skipped", note:"binary"} : pf));
        addLog("Skipped binary: "+f.name, "warn");
        return "";
      }
      try {
        const text = await new Promise((res,rej) => {
          const r = new FileReader();
          r.onload = e => res(e.target.result);
          r.onerror = () => rej(new Error("Read failed"));
          r.readAsText(f.file);
        });
        setFiles(p => p.map(pf => pf.name===f.name ? {...pf, st:"ok"} : pf));

        const detected = detectAndProcess(text, f.name);
        if (detected.type === "unsupported") {
          addLog("⚠ "+detected.content, "warn");
          return "";
        }
        if (detected.type === "csv") {
          addLog("✓ CPU profiling CSV: "+f.name+" — "+text.split("\n").length+" rows → call tree ("+detected.content.split("\n").length+" lines)", "ok");
          return "\n===CSV===\n"+detected.content+"\n===ENDCSV===";
        }
        if (detected.type === "dbcsv") {
          addLog("✓ DB profiling CSV: "+f.name+" — "+text.split("\n").length+" rows → N+1 analysis + method report ("+detected.content.split("\n").length+" lines)", "ok");
          return "\n===SQL===\n"+detected.content+"\n===ENDSQL===";
        }
        if (detected.type === "sql") {
          addLog("✓ SQL report: "+f.name+" — "+text.split("\n").length+" lines → "+detected.content.split("\n").length+" lines (sorted by cost)", "ok");
          return "\n===SQL===\n"+detected.content+"\n===ENDSQL===";
        }
        addLog("✓ Loaded "+f.name+" — "+text.split("\n").length+" lines", "ok");
        return "\n=== "+f.name+" ===\n"+text.slice(0,18000);
      } catch(err) {
        setFiles(p => p.map(pf => pf.name===f.name ? {...pf, st:"error", note:err.message} : pf));
        addLog("Error reading "+f.name+": "+err.message, "error");
        return "";
      }
    })).then(r => r.filter(Boolean).join("\n"));
  };

  const apiCall = async (systemPrompt, messages, label) => {
    addLog(label+" — calling Claude...", "info");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-6",
        max_tokens:8000,
        system: systemPrompt,
        messages
      })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(()=>"");
      if (resp.status===401) throw new Error("API authentication failed — check your API key");
      if (resp.status===429) throw new Error("Rate limit reached — wait 30 seconds and retry");
      if (resp.status===400) throw new Error("Bad request (400) — "+body.slice(0,200));
      if (resp.status>=500) throw new Error("Claude server error ("+resp.status+") — retry in a few seconds");
      throw new Error("API error "+resp.status+": "+body.slice(0,200));
    }
    const data = await resp.json();
    const raw = (data.content||[]).map(b => b.type==="text" ? b.text : "").join("");
    const inputTok  = data.usage?.input_tokens  || 0;
    const outputTok = data.usage?.output_tokens || 0;
    const stopReason = data.stop_reason || "unknown";
    setTokens(t => t + inputTok + outputTok);
    addLog(label+" done — in:"+inputTok+" out:"+outputTok+" tokens, stop:"+stopReason, stopReason==="max_tokens"?"warn":"ok");
    if (stopReason==="max_tokens") addLog("Response hit token limit — attempting partial recovery", "warn");
    return { raw, inputTok, outputTok, stopReason };
  };

  const analyze = async () => {
    const errs = validate();
    setFerrs(errs);
    setGErr("");
    if (Object.keys(errs).length>0) return;

    setPhase("analyzing");
    setAuditLog([]);
    setTokens(0);
    setElapsed(0);
    setStreamDone(false);
    setResult(null);

    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now()-t0)/1000)), 500);

    try {
      addLog("=== ANALYSIS START: "+projName+" ===", "info");
      addLog("Project: "+projName+" | Env: "+env+(build?" | Analysis: "+build:""), "info");
      addLog("Goal: "+(goal||"General performance investigation"), "info");
      addLog("", "info");

      let fileText = "";
      if (files.length>0) {
        addLog("Reading "+files.length+" file(s) in parallel (CPU+DB CSVs will each be routed separately)...", "info");
        fileText = await readAllFiles(files);
        addLog("Files loaded.", "ok");
      }

      let pastedProcessed = pasted.trim();
      if (pastedProcessed) {
        const pastedDetected = detectAndProcess(pastedProcessed, "pasted.txt");
        if (pastedDetected.type === "csv") {
          pastedProcessed = "===CSV===\n" + pastedDetected.content + "\n===ENDCSV===";
          addLog("Pasted content detected as CPU profiling CSV", "ok");
        } else if (pastedDetected.type === "dbcsv") {
          pastedProcessed = "===SQL===\n" + pastedDetected.content + "\n===ENDSQL===";
          addLog("Pasted content detected as DB profiling CSV — routing to DB section", "ok");
        } else if (pastedDetected.type === "sql") {
          pastedProcessed = "===SQL===\n" + pastedDetected.content + "\n===ENDSQL===";
          addLog("Pasted content detected as SQL report", "ok");
        }
      }

      const combined = [pastedProcessed, fileText.trim()].filter(Boolean).join("\n\n");

      const csvSections = [], sqlSections = [];
      const csvRx = /===CSV===\n([\s\S]*?)\n===ENDCSV===/g;
      const sqlRx = /===SQL===\n([\s\S]*?)\n===ENDSQL===/g;
      let csvMatch, sqlMatch;
      while ((csvMatch = csvRx.exec(combined)) !== null) csvSections.push(csvMatch[1]);
      while ((sqlMatch = sqlRx.exec(combined)) !== null) sqlSections.push(sqlMatch[1]);
      const nonSpecialText = combined
        .replace(/===CSV===\n[\s\S]*?\n===ENDCSV===/g, "")
        .replace(/===SQL===\n[\s\S]*?\n===ENDSQL===/g, "");

      const raw = nonSpecialText.trim();
      const scoped = raw.length > 0 ? filterIdit(raw, projName) : "";

      addLog("", "info");
      addLog("=== ARTIFACT SCOPING ===", "info");
      if (csvSections.length > 0)
        addLog("CPU call tree: "+csvSections.reduce((a,c)=>a+c.split("\n").length,0)+" lines", "ok");
      if (sqlSections.length > 0)
        addLog("SQL reports: "+sqlSections.reduce((a,c)=>a+c.split("\n").length,0)+" lines (all queries kept)", "ok");
      if (raw.length > 0)
        addLog("Text artifacts: "+raw.split("\n").length+" lines → "+scoped.split("\n").length+" after filter", "info");
      addLog("", "info");

      // ── Separate budgets so CPU never starves DB ────────────────────────────
      const csvBlock  = csvSections.length > 0  ? csvSections.join("\n\n").slice(0, 28000) : "";
      const sqlBlock  = sqlSections.length > 0  ? sqlSections.join("\n\n").slice(0, 28000) : "";
      const textBlock = (scoped.trim().length > 10 ? scoped : raw).slice(0, 6000);

      const hasAnything = csvBlock || sqlBlock || textBlock;
      if (!hasAnything) {
        throw new Error("No analyzable content found. Upload a CPU profiling CSV, SQL report, or paste artifact text.");
      }

      const ctxHeader = "Project: "+projName+" | Env: "+env+(build?" | Analysis: "+build:"")+"\nGoal: "+(goal||"General performance investigation")+"\n\n";

      addLog("Artifact budget — CPU:"+csvBlock.length+" SQL:"+sqlBlock.length+" Text:"+textBlock.length+" chars", "info");

      // ── Chunked analysis: safe chunk size keeps input+output within limits ──
      // Each chunk: ~7500 chars data + system prompt (~5500 chars) ~ 13000 input tokens
      // Output budget: 8000 tokens is enough for 5-8 findings per chunk
      const CHUNK_SIZE = 7500;

      const chunkText = (text, size) => {
        if (!text) return [];
        const lines = text.split("\n");
        const chunks = [];
        let cur = [];
        let len = 0;
        for (const line of lines) {
          if (len + line.length > size && cur.length > 0) {
            chunks.push(cur.join("\n"));
            cur = [line];
            len = line.length;
          } else {
            cur.push(line);
            len += line.length + 1;
          }
        }
        if (cur.length > 0) chunks.push(cur.join("\n"));
        return chunks;
      };

      // ── Helper: call Claude once per chunk and accumulate findings ───────────
      const analyzeChunks = async (chunks, sectionLabel, findingKey, phaseLabel, phaseId) => {
        const allFindings = [];
        let lastSummary = null;
        for (let i = 0; i < chunks.length; i++) {
          const chunkNum = i + 1;
          const total    = chunks.length;
          setAnalyzingPhase(phaseId);
          const chunkHeader = ctxHeader
            + "CHUNK " + chunkNum + " OF " + total + " -- analyze ONLY this chunk. "
            + (total > 1 ? "Other chunks are being analyzed in separate calls -- do NOT worry about coverage gaps. " : "")
            + "\n\n=== SECTION: " + sectionLabel + " ===\n"
            + (findingKey === "cpuFindings"
                ? "Analyze for cpuFindings ONLY. Do NOT produce dbFindings.\n\n"
                : "Analyze for dbFindings ONLY. IMPORTANT: raise a dbFinding for EVERY method tagged [MISSING_CACHE], [N+1], [CRITICAL], [HIGH]. For MISSING_CACHE: name the cache. For N+1: name the loop.\nDo NOT produce cpuFindings.\n\n")
            + chunks[i];

          addLog(phaseLabel+" chunk "+chunkNum+"/"+total+" ("+chunks[i].length+" chars) ...", "info");
          const { raw: chunkRaw, stopReason } = await apiCall(
            PROMPT_PHASE1,
            [{role:"user", content: chunkHeader}],
            phaseLabel+" ["+chunkNum+"/"+total+"]"
          );
          if (stopReason === "max_tokens") {
            addLog("Chunk "+chunkNum+" hit token limit — recovering partial findings", "warn");
          }
          try {
            const parsed = tryParse(chunkRaw);
            const found  = parsed[findingKey] || [];
            allFindings.push(...found);
            if (parsed.summary && !lastSummary) lastSummary = parsed.summary;
            addLog("Chunk "+chunkNum+": "+found.length+" findings (running total: "+allFindings.length+")", "ok");
          } catch(e) {
            addLog("Chunk "+chunkNum+" parse failed: "+e.message, "warn");
          }
        }
        return { findings: allFindings, summary: lastSummary };
      };

      // ── Phase 1a: CPU — split into chunks ────────────────────────────────────
      setAnalyzingPhase("phase1");
      addLog("=== PHASE 1a: CPU Findings (chunked) ===", "info");
      let cpuResult = { cpuFindings: [], iditFindings: [] };

      if (csvBlock || textBlock) {
        const cpuFull = [
          csvBlock ? "=== CPU PROFILING ===\n" + csvBlock : "",
          textBlock ? "=== OTHER ARTIFACTS ===\n" + textBlock : "",
        ].filter(Boolean).join("\n\n");

        const cpuChunks = chunkText(cpuFull, CHUNK_SIZE);
        addLog("CPU data: "+cpuFull.length+" chars split into "+cpuChunks.length+" chunk(s)", "info");
        const { findings } = await analyzeChunks(cpuChunks, "CPU PROFILING", "cpuFindings", "CPU", "phase1");
        cpuResult.cpuFindings = findings;
        addLog("Phase 1a complete: "+findings.length+" CPU findings total", "ok");
      } else {
        addLog("No CPU/text data — skipping Phase 1a", "info");
      }

      // ── Phase 1b: DB — split into chunks ─────────────────────────────────────
      addLog("", "info");
      setAnalyzingPhase("phase1b");
      addLog("=== PHASE 1b: DB Findings (chunked) ===", "info");
      let dbResult = { dbFindings: [], summary: null };

      if (sqlBlock) {
        const dbFull = sqlBlock;
        const dbChunks = chunkText(dbFull, CHUNK_SIZE);
        addLog("DB data: "+dbFull.length+" chars split into "+dbChunks.length+" chunk(s)", "info");
        const { findings, summary } = await analyzeChunks(dbChunks, "DB PROFILING", "dbFindings", "DB", "phase1b");
        dbResult.dbFindings = findings;
        dbResult.summary    = summary;
        addLog("Phase 1b complete: "+findings.length+" DB findings total", "ok");
      } else {
        addLog("No DB data — skipping Phase 1b", "info");
      }

      // ── Merge all chunks ─────────────────────────────────────────────────────
      addLog("", "info");
      let phase1;
      try {
        phase1 = {
          summary:        dbResult.summary || { rating:"HIGH", score:50, topFix:"See findings", impact:"", counts:{critical:0,high:0,medium:0,low:0,total:0} },
          cpuFindings:    cpuResult.cpuFindings,
          threadFindings: [],
          dbFindings:     dbResult.dbFindings,
          iditFindings:   [],
        };
        const n = phase1.cpuFindings.length + phase1.dbFindings.length;
        addLog("Phase 1 merged: "+n+" total findings — CPU:"+phase1.cpuFindings.length+" DB:"+phase1.dbFindings.length, "ok");
      } catch(pe) {
        addLog("Phase 1 merge failed: "+pe.message, "error");
        throw new Error("Phase 1 merge failed: "+pe.message);
      }

      addLog("", "info");

      setAnalyzingPhase("phase2");
      addLog("=== PHASE 2: Actions, Code Improvements & Scorecard ===", "info");

      const compactP1 = JSON.stringify({
        summary: phase1.summary,
        cpuFindings: (phase1.cpuFindings||[]).map(f=>({sev:f.sev,hotspot:f.hotspot,cause:f.cause,fix:f.fix,gain:f.gain})),
        threadFindings: (phase1.threadFindings||[]).map(f=>({sev:f.sev,pool:f.pool,type:f.type,cause:f.cause,fix:f.fix,gain:f.gain})),
        dbFindings: (phase1.dbFindings||[]).map(f=>({sev:f.sev,id:f.id,problem:f.problem,fix:f.fix,gain:f.gain})),
        iditFindings: (phase1.iditFindings||[]).map(f=>({sev:f.sev,component:f.component,issue:f.issue,fix:f.fix,gain:f.gain}))
      });
      addLog("Phase 2 input size: "+compactP1.length+" chars (compact P1 summary)", "info");
      const p2Input = "Phase 1 findings (compact):\n"+compactP1;
      const { raw: p2raw, stopReason: p2stop } = await apiCall(
        PROMPT_PHASE2,
        [{role:"user", content: p2Input}],
        "Phase 2"
      );

      addLog("Phase 2 raw response (first 400 chars):", "info");
      addLog(p2raw.slice(0,400), "stream");
      addLog("", "info");

      let phase2;
      try {
        phase2 = tryParse(p2raw);
        addLog("Phase 2 parsed OK: "+(phase2.actions?.length||0)+" actions, "+(phase2.correlations?.length||0)+" correlations", "ok");
      } catch(pe) {
        addLog("Phase 2 parse failed: "+pe.message+" — synthesizing actions from Phase 1", "warn");
        addLog(p2raw.slice(0,400), "warn");
        phase2 = null;
      }
      if (!phase2 || (phase2.actions?.length||0) === 0) {
        addLog("Phase 2 actions empty — synthesizing action plan from Phase 1 findings", "warn");
        const allFindings = [
          ...(phase1.cpuFindings||[]).map(f=>({...f, _type:"CPU"})),
          ...(phase1.threadFindings||[]).map(f=>({...f, _type:"THREAD"})),
          ...(phase1.dbFindings||[]).map(f=>({...f, _type:"DATABASE"})),
          ...(phase1.iditFindings||[]).map(f=>({...f, _type:"IDIT"})),
        ];
        const sevOrder = {CRITICAL:0,HIGH:1,MEDIUM:2,LOW:3};
        allFindings.sort((a,b)=>(sevOrder[a.sev]||3)-(sevOrder[b.sev]||3));
        const synthActions = allFindings.slice(0,10).map((f,i)=>({
          rank: i+1,
          category: f._type,
          sev: f.sev,
          title: (f.hotspot||f.pool||f.component||f.id||"Finding "+(i+1)).split(".").slice(-1)[0].slice(0,40),
          class: f.hotspot||f.component||f.sourceClass||"",
          problem: f.cause||f.issue||f.problem||"See finding details",
          solution: f.fix||"See finding details",
          gain: f.gain||""
        }));
        const existingScorecard = phase2?.scorecard || {cpu:0,db:0,thread:0,idit:0,overall:0,cpuNote:"",dbNote:"",threadNote:"",iditNote:""};
        phase2 = {
          actions: synthActions,
          codeImprovements: phase2?.codeImprovements||[],
          correlations: phase2?.correlations||[],
          scorecard: existingScorecard
        };
        addLog("Synthesized "+synthActions.length+" actions from Phase 1 findings", "ok");
      }

      clearInterval(timerRef.current);

      addLog("", "info");
      addLog("=== ANALYSIS COMPLETE ===", "ok");
      addLog("Elapsed time: "+Math.floor((Date.now()-t0)/1000)+"s", "ok");
      addLog("Findings: CPU="+(phase1.cpuFindings?.length||0)+" Thread="+(phase1.threadFindings?.length||0)+" DB="+(phase1.dbFindings?.length||0)+" IDIT="+(phase1.iditFindings?.length||0)+" Actions="+(phase2.actions?.length||0), "ok");

      const sc = phase2.scorecard || {};
      const allZero = !sc.cpu && !sc.db && !sc.overall;
      if (allZero) {
        const sevWeight = {CRITICAL:0, HIGH:25, MEDIUM:50, LOW:75};
        const calcScore = arr => {
          if (!arr || arr.length === 0) return 100;
          const worst = arr.reduce((w,f) => Math.min(w, sevWeight[f.sev]??50), 100);
          return Math.max(5, worst - Math.max(0, (arr.length-1)*5));
        };
        phase2.scorecard = {
          cpu:     calcScore(phase1.cpuFindings),
          db:      calcScore(phase1.dbFindings),
          overall: phase1.summary?.score || calcScore([
            ...(phase1.cpuFindings||[]), ...(phase1.dbFindings||[]),
          ]),
          cpuNote: (phase1.cpuFindings?.length||0)+" CPU hotspot(s) found",
          dbNote:  (phase1.dbFindings?.length||0)+" DB issue(s) found",
        };
        addLog("Scorecard auto-calculated from Phase 1 findings", "ok");
      }

      // Recompute severity counts from actual findings (Claude often returns 0s in summary)
      const allFindings = [
        ...(phase1.cpuFindings||[]),
        ...(phase1.dbFindings||[]),
        ...(phase1.iditFindings||[]),
      ];
      const recount = { critical:0, high:0, medium:0, low:0, total: allFindings.length };
      allFindings.forEach(f => {
        const s = (f.sev||"").toUpperCase();
        if (s === "CRITICAL") recount.critical++;
        else if (s === "HIGH") recount.high++;
        else if (s === "MEDIUM") recount.medium++;
        else if (s === "LOW") recount.low++;
      });
      if (phase1.summary) phase1.summary.counts = recount;

      setStreamDone(true);
      const finalResult = { ...phase1, ...phase2 };
      setResult(finalResult);

      // Save to history
      const now = new Date().toISOString();
      const datePart = new Date().toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"});
      const histEntry = {
        id: now + "_" + Math.random().toString(36).slice(2,8),
        savedAt: now,
        label: [build.trim()||"Unnamed", projName, env, datePart].filter(Boolean).join(" · "),
        projName, env, build, goal,
        tokens,
        counts: (phase1.summary?.counts) || {critical:0,high:0,medium:0,low:0,total:0},
        rating: phase1.summary?.rating || "",
        result: finalResult,
        auditSnapshot: auditLog.slice(-30),
      };
      historyAdd(histEntry);
      setHistory(historyLoad());

      setTimeout(() => { setPhase("results"); setTab("actions"); }, 400);

    } catch(err) {
      clearInterval(timerRef.current);
      addLog("", "info");
      addLog("=== ANALYSIS FAILED ===", "error");
      addLog(err.message, "error");
      setStreamDone(true);
      setGErr(err.message);
      setTimeout(() => setPhase("input"), 2000);
    }
  };

  const exportToPDF = () => {
    if (!result) return;
    const d  = result.summary||{};
    const sc = result.scorecard||{};
    const sevColor = {CRITICAL:"#b91c1c",HIGH:"#c2410c",MEDIUM:"#a16207",LOW:"#15803d"};
    const catColor = {CPU:"#dc2626",DATABASE:"#2563eb",CODE:"#16a34a"};

    const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br/>");

    const sevBadge = s => {
      const c = sevColor[s]||"#888";
      return `<span style="padding:2px 9px;border-radius:12px;font-size:10px;font-weight:700;background:${c}18;color:${c};border:1px solid ${c}40;letter-spacing:0.04em">${s||""}</span>`;
    };

    const card = (hdr, body) =>
      `<div style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px;overflow:hidden;page-break-inside:avoid">` +
      `<div style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${hdr}</div>` +
      `<div style="padding:12px 14px;font-size:12px;line-height:1.8;color:#374151">${body}</div></div>`;

    const field = (lbl, val) => val
      ? `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:3px">${lbl}</div><div style="color:#1e293b">${esc(val)}</div></div>`
      : "";

    const codeBlock = (lbl, val, good) => val
      ? `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${good?"#15803d":"#991b1b"};margin-bottom:3px">${lbl}</div>` +
        `<pre style="font-family:monospace;font-size:11px;background:${good?"#f0fdf4":"#fff1f2"};border:1px solid ${good?"#bbf7d0":"#fecaca"};border-left:3px solid ${good?"#86efac":"#fca5a5"};border-radius:5px;padding:8px 10px;white-space:pre-wrap;word-break:break-all;margin:0;color:${good?"#166534":"#991b1b"};line-height:1.6">${esc(val)}</pre></div>`
      : "";

    const sectionHdr = (title, n, col) =>
      `<div style="margin:24px 0 12px;padding-bottom:6px;border-bottom:2px solid ${col}30;display:flex;align-items:baseline;gap:8px">` +
      `<span style="font-size:15px;font-weight:800;color:#1e293b">${title}</span>` +
      `<span style="font-size:11px;font-weight:600;color:${col};background:${col}12;padding:1px 8px;border-radius:10px">${n}</span></div>`;

    const scoreBox = (lbl, score, note) => {
      const col = score>=70?"#16a34a":score>=40?"#ea580c":"#dc2626";
      const bg  = score>=70?"#f0fdf4":score>=40?"#fff7ed":"#fef2f2";
      return `<div style="text-align:center;background:${bg};border:1px solid ${col}30;border-radius:10px;padding:14px 18px;min-width:110px">` +
        `<div style="font-size:32px;font-weight:900;color:${col};font-family:monospace;line-height:1">${score||0}</div>` +
        `<div style="font-size:10px;font-weight:700;color:${col};text-transform:uppercase;letter-spacing:0.08em;margin-top:4px">${lbl}</div>` +
        (note?`<div style="font-size:10px;color:#64748b;margin-top:4px;line-height:1.4">${esc(note)}</div>`:"") +
        `</div>`;
    };

    const actionsHtml = (result.actions||[]).map((a,i) => {
      const cc = catColor[a.category]||"#6b7280";
      const sc2 = sevColor[a.sev]||"#888";
      return card(
        `<span style="width:22px;height:22px;border-radius:50%;background:${sc2}18;border:1px solid ${sc2}40;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:${sc2}">${i+1}</span>
         <span style="font-size:13px;font-weight:700;color:#1e293b;flex:1">${esc(a.title)}</span>
         ${sevBadge(a.sev)}
         <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${cc}15;color:${cc};border:1px solid ${cc}35;font-weight:700">${esc(a.category||"")}</span>`,
        (a.class?`<div style="font-family:monospace;font-size:10px;color:#64748b;margin-bottom:8px;padding:3px 7px;background:#f1f5f9;border-radius:4px;display:inline-block">${esc(a.class)}</div>`:"")+
        field("Problem",a.problem)+
        `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-left:3px solid #22c55e;border-radius:6px;padding:10px 12px;margin:8px 0">
           <div style="font-size:9px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Solution</div>
           <div style="font-size:12px;color:#166534;white-space:pre-wrap;line-height:1.7">${esc(a.solution)}</div>
         </div>`+
        (a.gain?`<span style="font-size:11px;color:#15803d;font-weight:700;padding:2px 8px;background:#f0fdf4;border:1px solid #86efac;border-radius:4px">Gain: ${esc(a.gain)}</span>`:"")
      );
    }).join("");

    const cpuHtml = (result.cpuFindings||[]).map(f => card(
      `${sevBadge(f.sev)} <code style="font-size:11px;font-weight:700;background:#f1f5f9;padding:2px 6px;border-radius:4px">${esc(f.hotspot||"")}</code>`+
      (f.cpu?` <span style="font-size:10px;color:#dc2626;font-weight:600;padding:1px 6px;background:#fef2f2;border-radius:4px">${esc(f.cpu)}</span>`:"")+
      (f.calls?` <span style="font-size:10px;color:#2563eb;font-weight:600;padding:1px 6px;background:#dbeafe;border-radius:4px">${esc(f.calls)} calls</span>`:""),
      field("Root Cause",f.cause)+field("Fix",f.fix)+codeBlock("Code Change",f.code,true)+
      (f.gain?`<span style="font-size:11px;color:#15803d;font-weight:700;padding:2px 8px;background:#f0fdf4;border:1px solid #86efac;border-radius:4px">Gain: ${esc(f.gain)}</span>`:"")
    )).join("");

    const dbHtml = (result.dbFindings||[]).map(f => card(
      `${sevBadge(f.sev)}`+
      (f.id?` <span style="font-size:10px;font-family:monospace;font-weight:600;color:#6b7280;background:#f1f5f9;padding:2px 6px;border-radius:4px">${esc(f.id)}</span>`:"")+
      ` <span style="font-size:11px;color:#7c3aed;font-weight:700">${esc(f.problem||"")}</span>`+
      (f.sourceClass?` <span style="font-size:9px;color:#64748b;font-family:monospace">${esc(f.sourceClass)}</span>`:""),
      (f.sql?codeBlock("SQL Query",f.sql,false):"")+
      field("Problem Detail",f.problem)+
      (f.index?codeBlock("Suggested Index",f.index,true):"")+
      field("Fix",f.fix)+
      (f.code?codeBlock("Code Change",f.code,true):"")+
      (f.gain?`<span style="font-size:11px;color:#15803d;font-weight:700;padding:2px 8px;background:#f0fdf4;border:1px solid #86efac;border-radius:4px">Gain: ${esc(f.gain)}</span>`:"")
    )).join("");

    const codeHtml = ""; // Code improvements removed from report

    const datestamp = new Date().toISOString().slice(0,10);
    const fname = [build||projName, projName, env, datestamp].filter(Boolean).join("_").replace(/[^a-z0-9_-]/gi,"_")+"_report.html";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(build)||esc(projName)} - IDIT Performance Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;color:#1e293b;background:#fff;padding:32px 40px;max-width:960px;margin:0 auto}
@media print{body{padding:8px 12px;max-width:100%}@page{margin:1.5cm 1.8cm;size:A4}.no-print{display:none!important}h2{page-break-after:avoid}}
code,pre{font-family:"SFMono-Regular",Consolas,monospace}
</style>
</head>
<body>
<div class="no-print" style="display:flex;gap:10px;margin-bottom:24px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;align-items:center">
  <span style="font-weight:600;color:#374151;flex:1">${esc(build)} — ${esc(projName)} · ${esc(env)}</span>
  <button onclick="window.print()" style="padding:7px 18px;background:#1e40af;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Print / Save as PDF</button>
</div>
<div style="background:linear-gradient(135deg,#1e1b4b,#1e40af,#0369a1);color:#fff;padding:24px 28px;border-radius:12px;margin-bottom:24px">
  <div style="font-size:22px;font-weight:900;margin-bottom:4px">${esc(build)||"Performance Report"}</div>
  <div style="font-size:14px;font-weight:600;opacity:.85;margin-bottom:4px">IDIT Performance Analysis</div>
  <div style="font-size:12px;opacity:.75">${esc(build)} | ${esc(projName)} | ${esc(env)} | ${new Date().toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"})}</div>
  ${d.topFix?`<div style="margin-top:12px;padding:10px 14px;background:rgba(255,255,255,0.12);border-radius:8px;border-left:3px solid rgba(255,255,255,0.5)"><div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px">Top Priority</div><div style="font-size:14px;font-weight:700">${esc(d.topFix)}</div></div>`:""}
  <div style="display:flex;gap:24px;margin-top:16px;flex-wrap:wrap">
    ${["CRITICAL","HIGH","MEDIUM","LOW"].map(s=>{const n=d.counts?.[s.toLowerCase()]||0;const c={CRITICAL:"#fca5a5",HIGH:"#fdba74",MEDIUM:"#fde047",LOW:"#86efac"}[s];return `<div style="text-align:center"><div style="font-size:28px;font-weight:900;color:${c};font-family:monospace">${n}</div><div style="font-size:9px;opacity:.8;text-transform:uppercase;letter-spacing:.1em;margin-top:2px">${s}</div></div>`;}).join("")}
  </div>
</div>
<div style="display:flex;gap:14px;margin-bottom:24px;flex-wrap:wrap">
  ${scoreBox("CPU Score",sc.cpu,sc.cpuNote)}
  ${scoreBox("DB Score",sc.db,sc.dbNote)}
  ${scoreBox("Overall",sc.overall,"")}
</div>
${d.impact?`<div style="margin-bottom:20px;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #ef4444;border-radius:8px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#b91c1c;margin-bottom:4px">Business Impact</div><div style="line-height:1.7">${esc(d.impact)}</div></div>`:""}
${(result.actions||[]).length>0?sectionHdr("Priority Actions",""+result.actions.length,"#16a34a")+actionsHtml:""}
${(result.cpuFindings||[]).length>0?sectionHdr("CPU Findings",""+result.cpuFindings.length,"#dc2626")+cpuHtml:""}
${(result.dbFindings||[]).length>0?sectionHdr("Database Findings",""+result.dbFindings.length,"#7c3aed")+dbHtml:""}

<div style="margin-top:32px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;text-align:center">IDIT Performance Analyzer | ${esc(build)} | ${esc(projName)} | ${esc(env)} | ${new Date().toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"})}</div>
</body></html>`;

    // Direct download — no popup, no print dialog on load
    const blob = new Blob([html], {type:"text/html;charset=utf-8"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const reset = () => {
    setPhase("input"); setResult(null); setGErr(""); setTab("actions");
    setFiles(p => p.map(f => ({...f, st:undefined, note:undefined})));
    clearInterval(timerRef.current);
  };
  const fullReset = () => {
    setProjName(""); setEnv("UAT"); setBuild(""); setGoal("");
    setPasted(SAMPLE); setFiles([]); setFerrs({}); setGErr("");
    setPhase("input"); setResult(null); setTab("actions");
    setAuditLog([]); setTokens(0); setElapsed(0); setStreamDone(false);
    clearInterval(timerRef.current);
    if (fileRef.current) fileRef.current.value="";
  };
  const addFiles = list => {
    const nf = Array.from(list).map(f => ({name:f.name, size:f.size, file:f, st:"queued"}));
    setFiles(p => { const ex=new Set(p.map(f=>f.name)); return [...p, ...nf.filter(f=>!ex.has(f.name))]; });
    setFerrs(p => ({...p, arts:undefined}));
    if (!projName.trim()) {
      for (const f of Array.from(list)) {
        const nameUpper = f.name.toUpperCase();
        const match = PROJECTS.find(p => nameUpper.includes(p.toUpperCase()));
        if (match) { setProjName(match); setFerrs(p=>({...p,projName:undefined})); break; }
      }
    }
  };
  const fmtSz = b => b<1024?b+"B":b<1048576?(b/1024).toFixed(1)+"KB":(b/1048576).toFixed(1)+"MB";
  const fIcon = n => ({sql:"ti-database",log:"ti-file-text",txt:"ti-file-text",csv:"ti-table",xlsx:"ti-table",xls:"ti-table",xml:"ti-code",json:"ti-braces",zip:"ti-file-zip"}[n.split(".").pop().toLowerCase()]||"ti-file");
  const fSt = f => ({ok:{i:"ti-circle-check",c:"#22c55e"},error:{i:"ti-circle-x",c:"#ef4444"},reading:{i:"ti-loader-2",c:"#3b82f6"},skipped:{i:"ti-minus-circle",c:"#f97316"},queued:{i:"ti-circle",c:T.faint}}[f.st||"queued"]||{i:"ti-circle",c:T.faint});
  const logC = t => ({ok:T.logOk,error:T.logErr,warn:T.logWarn,stream:T.logInfo,info:T.logTxt}[t]||T.logTxt);
  const logP = t => ({ok:"✓ ",error:"✗ ",warn:"⚠ ",stream:"→ ",info:"  "}[t]||"  ");
  const inp = err => ({width:"100%",boxSizing:"border-box",background:T.surf,color:T.txt,border:"1px solid "+(err?"#ef4444":T.bdr),borderRadius:7,padding:"7px 10px",fontSize:13});
  const errEl = msg => msg?<div style={{fontSize:11,color:"#ef4444",marginTop:3,display:"flex",alignItems:"center",gap:3}}><i className="ti ti-alert-circle" style={{fontSize:11}} aria-hidden="true"/>{msg}</div>:null;
  const darkBtn = () => (
    <button onClick={()=>setDark(d=>!d)} style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:7,padding:"4px 9px",cursor:"pointer",color:"#fff",display:"flex",alignItems:"center",gap:4,fontSize:11}}>
      <i className={"ti "+(dark?"ti-sun":"ti-moon")} style={{fontSize:13}} aria-hidden="true"/>{dark?"Light":"Dark"}
    </button>
  );

  if (phase==="analyzing") {
    const p1done = (analyzingPhase==="phase1b"||analyzingPhase==="phase2"||streamDone);
    const p2done = streamDone;
    const p1active = analyzingPhase==="phase1" || analyzingPhase==="phase1b";
    const p2active = analyzingPhase==="phase2";
    return <div style={{background:T.bg,padding:13,minHeight:460,fontFamily:"var(--font-sans)"}}>
      <h2 className="sr-only">Analyzing</h2>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:11}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#1e40af,#0369a1)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <i className="ti ti-cpu" style={{fontSize:15,color:"#fff"}} aria-hidden="true"/>
          </div>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:T.txt}}>
              {analyzingPhase==="phase1"?"Analyzing CPU...":analyzingPhase==="phase1b"?"Analyzing DB...":p2active?"Building action plan...":streamDone?"Complete":"Preparing..."}
            </div>
            <div style={{fontSize:10,color:T.muted}}>{projName} · com.idit.* · non-streaming mode</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <div style={{textAlign:"center",padding:"4px 8px",background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:7}}>
            <div style={{fontSize:12,fontWeight:700,color:T.acc,fontFamily:"var(--font-mono)"}}>{tokens.toLocaleString()}</div>
            <div style={{fontSize:9,color:T.muted}}>tokens used</div>
          </div>
          <div style={{textAlign:"center",padding:"4px 8px",background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:7}}>
            <div style={{fontSize:12,fontWeight:700,color:T.txt,fontFamily:"var(--font-mono)"}}>{elapsed}s</div>
            <div style={{fontSize:9,color:T.muted}}>elapsed</div>
          </div>
        </div>
      </div>

      {/* Phase cards */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:11}}>
        {[
          {label:"Phase 1a",sub:"CPU (chunked)",done:p1done&&!p1active,active:analyzingPhase==="phase1"},
          {label:"Phase 1b",sub:"DB (chunked)",done:analyzingPhase==="phase2"||streamDone,active:analyzingPhase==="phase1b"},
          {label:"Phase 2",sub:"Actions · Scorecard",done:p2done,active:p2active},
        ].map((s,i) => (
          <div key={i} style={{padding:"10px 12px",background:T.surf,border:"0.5px solid "+(s.active?"#1e40af":s.done?"#22c55e":T.bdr),borderRadius:8,display:"flex",alignItems:"center",gap:8,transition:"border-color 0.3s"}}>
            <i className={"ti "+(s.done?"ti-circle-check":s.active?"ti-loader-2":"ti-circle")} style={{fontSize:16,color:s.done?"#22c55e":s.active?"#1e40af":T.faint,flexShrink:0,animation:s.active?"spin 1s linear infinite":undefined}} aria-hidden="true"/>
            <div>
              <div style={{fontSize:11,fontWeight:600,color:s.done?"#22c55e":s.active?T.acc:T.muted}}>{s.label} {s.active&&"— waiting for response..."}</div>
              <div style={{fontSize:9,color:T.muted}}>{s.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Live audit log */}
      <div ref={logRef} style={{background:T.logBg,borderRadius:9,padding:"10px 13px",height:290,overflowY:"auto",fontFamily:"var(--font-mono)",fontSize:11,border:"1px solid "+T.bdr,lineHeight:1.8}}>
        {auditLog.length===0&&<span style={{color:T.logTxt}}>Initializing...</span>}
        {auditLog.map((e,i) => (
          <div key={i} style={{display:"flex",gap:10,wordBreak:"break-all"}}>
            <span style={{color:T.logTxt,flexShrink:0,fontSize:10}}>{e.ts}</span>
            <span style={{color:logC(e.type)}}>{logP(e.type)}{e.msg}</span>
          </div>
        ))}
        {!streamDone&&(
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,color:"#58a6ff"}}>
            <i className="ti ti-loader-2" style={{fontSize:12,animation:"spin 1s linear infinite"}} aria-hidden="true"/>
            <span style={{fontSize:10}}>Waiting for Claude response...</span>
          </div>
        )}
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>;
  }

  if (phase==="results" && result) {
    const cpu  = result.cpuFindings||[];
    const thr  = result.threadFindings||[];
    const db   = result.dbFindings||[];
    const idit = result.iditFindings||[];
    const acts = result.actions||[];
    const code = result.codeImprovements||[];
    const corr = result.correlations||[];
    const sc   = result.scorecard||{};
    const sum  = result.summary||{};
    const cnts = {actions:acts.length,cpu:cpu.length,thread:thr.length,db:db.length,idit:idit.length,code:code.length,corr:corr.length};
    const rc   = {CRITICAL:"#ef4444",HIGH:"#f97316",MEDIUM:"#eab308",LOW:"#22c55e"};

    return <div style={{background:T.bg,fontFamily:"var(--font-sans)"}}>
      <h2 className="sr-only">Analysis results</h2>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 13px",background:T.surf2,borderBottom:"0.5px solid "+T.bdr}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:30,height:30,borderRadius:7,background:"linear-gradient(135deg,#1e1b4b,#1e40af)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <i className="ti ti-report-analytics" style={{fontSize:14,color:"#fff"}} aria-hidden="true"/>
          </div>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.txt}}>{projName||"Unknown Project"}</div>
            <div style={{fontSize:10,color:T.muted,fontFamily:"var(--font-mono)"}}>{build||projName} · {projName} · {env} · {tokens.toLocaleString()} tokens</div>
          </div>
        </div>
        <div style={{display:"flex",gap:7,alignItems:"center"}}>
          {sum.rating&&<span style={{fontSize:11,fontWeight:700,color:rc[sum.rating]||T.muted,background:(rc[sum.rating]||"#888")+"20",border:"1px solid "+(rc[sum.rating]||"#888")+"44",padding:"2px 9px",borderRadius:20}}>{sum.rating}</span>}
          <button onClick={()=>setDark(d=>!d)} style={{background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:7,padding:"4px 8px",cursor:"pointer",color:T.muted,display:"flex",alignItems:"center",gap:4,fontSize:11}}>
            <i className={"ti "+(dark?"ti-sun":"ti-moon")} style={{fontSize:12}} aria-hidden="true"/>{dark?"Light":"Dark"}
          </button>
          {viewingHistory&&<span style={{fontSize:10,color:"#0891b2",background:"#ecfeff",border:"1px solid #67e8f940",borderRadius:6,padding:"3px 8px",fontWeight:600,display:"flex",alignItems:"center",gap:4}}>
            <i className="ti ti-history" style={{fontSize:11}} aria-hidden="true"/>From history
          </span>}
          <button onClick={()=>{ setViewingHistory(false); reset(); }} style={{background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:7,padding:"4px 9px",cursor:"pointer",color:T.muted,display:"flex",alignItems:"center",gap:4,fontSize:11}}>
            <i className="ti ti-refresh" style={{fontSize:12}} aria-hidden="true"/>Re-run
          </button>
          <button onClick={fullReset} style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:7,padding:"4px 9px",cursor:"pointer",color:"#b91c1c",display:"flex",alignItems:"center",gap:4,fontSize:11}}>
            <i className="ti ti-rotate-clockwise" style={{fontSize:12}} aria-hidden="true"/>New
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",borderBottom:"0.5px solid "+T.bdr,overflowX:"auto",background:T.surf}}>
        {TABS.map(t => {
          const cnt = cnts[t.id==="corr"?"corr":t.id];
          const active = tab===t.id;
          return <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"8px 11px",border:"none",borderBottom:active?"2px solid "+T.acc:"2px solid transparent",background:"transparent",cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5,fontSize:11,fontWeight:active?700:400,color:active?T.acc:T.muted,borderRadius:0}}>
            <i className={"ti "+t.icon} style={{fontSize:12}} aria-hidden="true"/>{t.label}
            {cnt!=null&&cnt>0&&<span style={{background:active?T.accBg:T.surf2,color:active?T.acc:T.muted,border:"0.5px solid "+(active?T.acc+"44":T.bdr),borderRadius:20,padding:"0 5px",fontSize:9,fontFamily:"var(--font-mono)",fontWeight:700}}>{cnt}</span>}
          </button>;
        })}
      </div>

      <div style={{padding:12,background:T.bg}}>

        {/* ACTIONS */}
        {tab==="actions"&&<div>
          {sum.topFix&&<div style={{background:T.acc+"15",border:"1px solid "+T.acc+"33",borderLeft:"3px solid "+T.acc,borderRadius:8,padding:"10px 13px",marginBottom:12,display:"flex",gap:8,alignItems:"flex-start"}}>
            <i className="ti ti-bolt" style={{fontSize:13,color:T.acc,flexShrink:0,marginTop:1}} aria-hidden="true"/>
            <div><div style={{fontSize:10,color:T.acc,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Top Priority</div><div style={{fontSize:13,fontWeight:600,color:T.txt}}>{sum.topFix}</div></div>
          </div>}
          {acts.length===0?<Empty label="actions" T={T}/>:acts.map((a,i)=>{
            const catCol={CPU:"#ef4444",THREAD:"#7c3aed",DATABASE:"#2563eb",IDIT:"#0891b2",CODE:"#16a34a"}[a.category]||"#6b7280";
            const dot=SEV_STYLE[a.sev]?.dot||"#888";
            return <div key={i} style={{background:T.surf,border:"0.5px solid "+T.bdr,borderLeft:"4px solid "+dot,borderRadius:9,marginBottom:10,overflow:"hidden"}}>
              <div style={{padding:"9px 12px",background:T.surf2,borderBottom:"0.5px solid "+T.bdr,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:6}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{width:20,height:20,borderRadius:"50%",background:dot+"20",border:"1px solid "+dot+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:dot,fontWeight:800,fontFamily:"var(--font-mono)",flexShrink:0}}>{a.rank}</span>
                  <span style={{fontSize:12,fontWeight:700,color:T.txt}}>{a.title}</span>
                </div>
                <div style={{display:"flex",gap:5}}><Badge s={a.sev} T={T}/><Pill text={a.category} color={catCol}/></div>
              </div>
              <div style={{padding:"11px 12px"}}>
                {a.class&&<div style={{fontSize:10,fontFamily:"var(--font-mono)",color:T.muted,marginBottom:7,display:"flex",alignItems:"center",gap:4}}><i className="ti ti-code" style={{fontSize:11}} aria-hidden="true"/>{a.class}</div>}
                <FL label="Problem" value={a.problem} T={T}/>
                <div style={{background:T.codeGoodBg,border:"0.5px solid "+T.codeGoodBdr,borderLeft:"3px solid "+T.codeGoodBdr,borderRadius:7,padding:"10px 12px",marginBottom:6}}>
                  <div style={{fontSize:9,color:"#16a34a",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4}}>Solution</div>
                  <div style={{fontSize:12,lineHeight:1.7,color:T.codeGoodTxt,whiteSpace:"pre-wrap"}}>{(a.solution||"").replace(/\\n/g,"\n")}</div>
                </div>
                {a.gain&&<Gain text={a.gain}/>}
              </div>
            </div>;
          })}
        </div>}

        {/* OVERVIEW */}
        {tab==="summary"&&<div>
          {/* Export PDF button */}
          <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>
            <button onClick={exportToPDF}
              style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",
                background:"linear-gradient(135deg,#dc2626,#b91c1c)",
                color:"#fff",border:"none",borderRadius:8,cursor:"pointer",
                fontSize:12,fontWeight:700,boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}>
              <i className="ti ti-file-type-pdf" style={{fontSize:14}} aria-hidden="true"/>
              Export Full Report to PDF
            </button>
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center",padding:"10px 0 14px"}}>
            <Ring score={sc.cpu} label="CPU" note={sc.cpuNote} T={T}/>
            <Ring score={sc.db} label="Database" note={sc.dbNote} T={T}/>
            <Ring score={sc.overall} label="Overall" large T={T}/>
          </div>
          <div style={{display:"flex",gap:7,flexWrap:"wrap",justifyContent:"center",marginBottom:13}}>
            {[["CRITICAL",sum.counts?.critical||0,"#ef4444"],["HIGH",sum.counts?.high||0,"#f97316"],["MEDIUM",sum.counts?.medium||0,"#eab308"],["LOW",sum.counts?.low||0,"#22c55e"],["TOTAL",sum.counts?.total||0,T.acc]].map(([l,v,c])=>(
              <div key={l} style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"9px 14px",borderRadius:8,background:c+"15",border:"1px solid "+c+"30"}}>
                <span style={{fontSize:19,fontWeight:800,color:c,fontFamily:"var(--font-mono)",lineHeight:1}}>{v}</span>
                <span style={{fontSize:9,color:c,fontWeight:700,letterSpacing:"0.08em",marginTop:2}}>{l}</span>
              </div>
            ))}
          </div>
          {sum.impact&&<SectionBox title="Business Impact" icon="ti-building" accent="#ef4444" T={T}>
            <p style={{fontSize:13,lineHeight:1.7,margin:0,color:T.txt}}>{sum.impact}</p>
          </SectionBox>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
            {[["Actions",acts.length,"ti-bolt","actions","#16a34a"],["CPU",cpu.length,"ti-cpu","cpu","#ef4444"],["Database",db.length,"ti-database","db","#2563eb"],["DB Findings",db.length,"ti-database","db","#7c3aed"]].map(([l,n,ic,tid,c])=>(
              <button key={tid} onClick={()=>setTab(tid)} style={{background:T.surf,border:"0.5px solid "+T.bdr,borderLeft:"3px solid "+c,borderRadius:9,padding:"10px 12px",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:9}}>
                <i className={"ti "+ic} style={{fontSize:19,color:c}} aria-hidden="true"/>
                <div><div style={{fontSize:19,fontWeight:800,color:T.txt,fontFamily:"var(--font-mono)",lineHeight:1}}>{n}</div><div style={{fontSize:10,color:T.muted,marginTop:2}}>{l}</div></div>
                <i className="ti ti-arrow-right" style={{marginLeft:"auto",fontSize:12,color:T.faint}} aria-hidden="true"/>
              </button>
            ))}
          </div>
        </div>}

        {tab==="cpu"&&(cpu.length===0?<Empty label="CPU" T={T}/>:cpu.map((f,i)=><CpuCard key={i} f={f} T={T}/>))}
        {tab==="thread"&&(thr.length===0?<Empty label="thread" T={T}/>:thr.map((f,i)=><ThreadCard key={i} f={f} T={T}/>))}
        {tab==="db"&&(db.length===0?<Empty label="database" T={T}/>:db.map((f,i)=><DbCard key={i} f={f} T={T}/>))}



        {/* CORRELATION */}
        {tab==="corr"&&(corr.length===0?<Empty label="correlation" T={T}/>:corr.map((c,i)=>(
          <div key={i} style={{background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:9,marginBottom:11,overflow:"hidden"}}>
            <div style={{padding:"9px 12px",background:T.surf2,borderBottom:"0.5px solid "+T.bdr,display:"flex",alignItems:"center",gap:7}}>
              <Pill text={c.id} color={T.acc}/><span style={{fontSize:12,fontWeight:600,color:T.txt}}>{c.title}</span>
            </div>
            <div style={{padding:"11px 12px"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:9}}>
                {[["CPU",c.cpu,"ti-cpu","#ef4444"],["Database",c.db,"ti-database","#2563eb"]].map(([l,v,ic,col])=>(
                  <div key={l} style={{background:T.surf2,border:"0.5px solid "+T.bdr,borderRadius:7,padding:"8px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:4}}><i className={"ti "+ic} style={{fontSize:11,color:col}} aria-hidden="true"/><span style={{fontSize:9,color:col,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em"}}>{l}</span></div>
                    <div style={{fontSize:11,lineHeight:1.5,color:T.txt}}>{v}</div>
                  </div>
                ))}
              </div>
              <FL label="Root Cause" value={c.cause} T={T}/>
              <div style={{background:T.codeGoodBg,border:"0.5px solid "+T.codeGoodBdr,borderLeft:"3px solid "+T.codeGoodBdr,borderRadius:7,padding:"9px 11px"}}>
                <div style={{fontSize:9,color:"#16a34a",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>Fix</div>
                <div style={{fontSize:12,lineHeight:1.6,color:T.codeGoodTxt}}>{c.fix}</div>
              </div>
              {c.gain&&<div style={{marginTop:6}}><Gain text={c.gain}/></div>}
            </div>
          </div>
        )))}

        {/* AUDIT LOG */}
        {tab==="audit"&&<div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:9}}>
            <div style={{fontSize:11,color:T.muted}}>Full record of what was analyzed, what was sent, and what Claude returned.</div>
            <Pill text={tokens.toLocaleString()+" tokens · "+elapsed+"s"} color={T.acc}/>
          </div>
          {/* What was sent */}
          <SectionBox title={"Artifact Scope Sent to Claude (com.idit.* filtered)"} icon="ti-send" accent={T.acc} T={T}>
            <pre style={{fontFamily:"var(--font-mono)",fontSize:10,color:T.muted,background:T.surf2,padding:"8px 10px",borderRadius:6,maxHeight:180,overflowY:"auto",whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.6,margin:0}}>{filterIdit(pasted, projName).slice(0,2000)||"(none — paste artifact text to preview scope)"}</pre>
          </SectionBox>
          {/* Live log */}
          <SectionBox title="Analysis Log" icon="ti-terminal-2" T={T}>
            <div ref={logRef} style={{background:T.logBg,borderRadius:7,padding:"8px 11px",maxHeight:400,overflowY:"auto",fontFamily:"var(--font-mono)",fontSize:10,lineHeight:1.8}}>
              {auditLog.length===0&&<span style={{color:T.logTxt}}>No log yet — run analysis first.</span>}
              {auditLog.map((e,i)=><div key={i} style={{display:"flex",gap:9}}>
                <span style={{color:T.logTxt,flexShrink:0}}>{e.ts}</span>
                <span style={{color:logC(e.type)}}>{logP(e.type)}{e.msg}</span>
              </div>)}
            </div>
          </SectionBox>
        </div>}


        {/* HISTORY TAB */}
        {tab==="history"&&<HistoryPanel
          history={history}
          T={T}
          onOpen={entry=>{
            setResult(entry.result);
            setProjName(entry.projName||"");
            setEnv(entry.env||"UAT");
            setBuild(entry.build||"");
            setGoal(entry.goal||"");
            setTokens(entry.tokens||0);
            setViewingHistory(true);
            setTab("actions");
          }}
          onDelete={id=>{
            historyDelete(id);
            setHistory(historyLoad());
          }}
        />}
      </div>
    </div>;
  }

  return <div style={{background:T.bg,fontFamily:"var(--font-sans)"}}>
    <h2 className="sr-only">IDIT Performance Analyzer</h2>

    <div style={{background:"linear-gradient(135deg,#1e1b4b 0%,#1e40af 60%,#0369a1 100%)",padding:"15px 15px 12px",borderRadius:"10px 10px 0 0"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:37,height:37,borderRadius:9,background:"rgba(255,255,255,0.15)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <i className="ti ti-activity" style={{fontSize:19,color:"#fff"}} aria-hidden="true"/>
          </div>
          <div>
            <div style={{fontSize:14,fontWeight:800,color:"#fff",letterSpacing:"-0.01em"}}>IDIT Performance Analyzer</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.65)"}}>Two-phase AI analysis · com.idit.* scope · No infra recommendations</div>
          </div>
        </div>
        {darkBtn()}
      </div>
      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {["CPU Traces","Thread Dumps","SQL Reports","IDIT Config","Source Code","AWR Reports"].map(tag=>(
          <span key={tag} style={{fontSize:9,color:"rgba(255,255,255,0.75)",background:"rgba(255,255,255,0.1)",padding:"2px 7px",borderRadius:20,border:"1px solid rgba(255,255,255,0.18)"}}>{tag}</span>
        ))}
      </div>
    </div>

    {gErr&&<div style={{background:"#fff0f0",border:"1px solid #ef4444",borderRadius:8,padding:"9px 12px",margin:"11px 12px 0",display:"flex",gap:7,alignItems:"flex-start"}}>
      <i className="ti ti-alert-circle" style={{fontSize:14,color:"#ef4444",flexShrink:0,marginTop:1}} aria-hidden="true"/>
      <div><div style={{fontSize:12,fontWeight:700,color:"#b91c1c",marginBottom:1}}>Error</div><div style={{fontSize:12,color:"#b91c1c",lineHeight:1.5}}>{gErr}</div></div>
    </div>}

    <div style={{padding:"12px 12px 0"}}>
      <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Project Details</div>
      <div style={{marginBottom:10}}>
        <label style={{fontSize:12,fontWeight:600,color:T.txt,display:"flex",gap:3,marginBottom:4}}>
          Project<span style={{color:"#ef4444"}}>*</span>
        </label>
        <select
          value={projName}
          onChange={e=>{setProjName(e.target.value);setFerrs(p=>({...p,projName:undefined}));}}
          style={{...inp(ferrs.projName),fontFamily:"var(--font-mono)",fontWeight:600,cursor:"pointer"}}
        >
          <option value="">— Select project —</option>
          {PROJECTS.map(p=><option key={p} value={p}>{p}</option>)}
        </select>
        {errEl(ferrs.projName)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
        <div>
          <label style={{fontSize:12,fontWeight:600,color:T.txt,display:"block",marginBottom:4}}>Environment</label>
          <select value={env} onChange={e=>setEnv(e.target.value)} style={inp(false)}>{ENVIRONMENTS.map(e=><option key={e}>{e}</option>)}</select>
        </div>
        <div>
          <label style={{fontSize:12,fontWeight:600,color:T.txt,display:"flex",gap:3,marginBottom:4}}>
            Analysis Name<span style={{color:"#ef4444"}}>*</span>
          </label>
          <input
            value={build}
            onChange={e=>{setBuild(e.target.value);setFerrs(p=>({...p,build:undefined}));}}
            placeholder="e.g. FinishPolicy-MasterConfirmation-40Loc"
            style={{...inp(ferrs.build)}}
          />
          {errEl(ferrs.build)}
        </div>
      </div>
      <div style={{marginBottom:12}}>
        <label style={{fontSize:12,fontWeight:600,color:T.txt,display:"block",marginBottom:4}}>Analysis Goal</label>
        <input value={goal} onChange={e=>setGoal(e.target.value)} placeholder="e.g. Investigate slowness during renewal batch" style={inp(false)}/>
      </div>
    </div>

    <div style={{padding:"0 12px 12px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.08em"}}>Performance Artifacts</div>
        <button onClick={fullReset} style={{display:"flex",alignItems:"center",gap:3,fontSize:10,color:"#ef4444",background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:20,padding:"2px 9px",cursor:"pointer",fontWeight:600}}>
          <i className="ti ti-rotate-clockwise" style={{fontSize:11}} aria-hidden="true"/>Reset all
        </button>
      </div>

      <div style={{marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
          <label style={{fontSize:12,fontWeight:600,color:T.txt}}>Paste artifact text</label>
          <div style={{display:"flex",gap:5}}>
            <button onClick={()=>setPasted(SAMPLE)} style={{fontSize:10,padding:"2px 7px",color:T.acc,border:"1px solid "+T.acc+"40",background:T.accBg,borderRadius:20,cursor:"pointer",display:"flex",alignItems:"center",gap:3}}>
              <i className="ti ti-file-plus" style={{fontSize:11}} aria-hidden="true"/>Sample
            </button>
            {pasted&&<button onClick={()=>{setPasted("");setFerrs(p=>({...p,arts:undefined}));}} style={{fontSize:10,padding:"2px 7px",color:"#ef4444",border:"1px solid #fca5a5",background:"#fef2f2",borderRadius:20,cursor:"pointer",display:"flex",alignItems:"center",gap:3}}>
              <i className="ti ti-trash" style={{fontSize:11}} aria-hidden="true"/>Clear
            </button>}
          </div>
        </div>
        <textarea value={pasted} onChange={e=>{setPasted(e.target.value);setFerrs(p=>({...p,arts:undefined}));}}
          placeholder="Paste CPU traces, thread dumps, SQL reports, IDIT config... com.idit.* lines will be analyzed."
          rows={6} style={{...inp(ferrs.arts),fontFamily:"var(--font-mono)",fontSize:11,lineHeight:1.6,resize:"vertical",minHeight:120}}/>
        {pasted&&<div style={{fontSize:9,color:T.muted,marginTop:2,textAlign:"right"}}>{pasted.split("\n").length} lines · {pasted.length} chars</div>}
        {errEl(ferrs.arts)}
      </div>

      <div onDrop={e=>{e.preventDefault();setDragOver(false);addFiles(e.dataTransfer.files);}}
        onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)}
        onClick={()=>fileRef.current?.click()}
        style={{border:"1.5px dashed "+(dragOver?T.acc:ferrs.arts?"#ef4444":T.bdr),borderRadius:9,padding:"12px",textAlign:"center",cursor:"pointer",background:dragOver?T.accBg:T.surf2,transition:"all 0.15s",marginBottom:8}}>
        <i className="ti ti-upload" style={{fontSize:18,color:dragOver?T.acc:T.muted,marginBottom:3,display:"block"}} aria-hidden="true"/>
        <div style={{fontSize:12,fontWeight:600,color:dragOver?T.acc:T.txt,marginBottom:1}}>Drop files or click to upload</div>
        <div style={{fontSize:10,color:T.muted}}>Multiple files read in parallel · .txt .log .sql .csv .xml .json</div>
        <input ref={fileRef} type="file" multiple accept=".txt,.log,.sql,.csv,.xml,.json,.xlsx,.xls,.zip" style={{display:"none"}} onChange={e=>addFiles(e.target.files)}/>
      </div>

      {files.length>0&&<div style={{background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:8,padding:"7px 10px",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
          <span style={{fontSize:10,color:T.muted,fontWeight:600}}>{files.length} file(s) — read in parallel</span>
          <button onClick={()=>setFiles([])} style={{fontSize:10,color:"#ef4444",background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:20,padding:"1px 7px",cursor:"pointer",display:"flex",alignItems:"center",gap:3}}>
            <i className="ti ti-trash" style={{fontSize:10}} aria-hidden="true"/>Remove all
          </button>
        </div>
        {files.map((f,i)=>{
          const si=fSt(f);
          return <div key={i} style={{display:"flex",alignItems:"center",gap:7,padding:"4px 7px",background:T.surf2,border:"0.5px solid "+T.bdr,borderRadius:7,marginBottom:3}}>
            <i className={"ti "+fIcon(f.name)} style={{fontSize:12,color:T.acc,flexShrink:0}} aria-hidden="true"/>
            <span style={{fontSize:11,fontFamily:"var(--font-mono)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:T.txt}}>{f.name}</span>
            <span style={{fontSize:9,color:T.muted,whiteSpace:"nowrap",flexShrink:0}}>{fmtSz(f.size)}</span>
            <i className={"ti "+si.i} style={{fontSize:12,color:si.c,flexShrink:0}} aria-hidden="true" title={f.note||f.st||"queued"}/>
            {f.note&&<span style={{fontSize:9,color:si.c,maxWidth:65,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.note}</span>}
            <button onClick={e=>{e.stopPropagation();setFiles(p=>p.filter((_,j)=>j!==i));}} style={{padding:"2px 4px",border:"1px solid #fca5a5",background:"#fef2f2",borderRadius:5,cursor:"pointer",color:"#ef4444",display:"flex",alignItems:"center"}}>
              <i className="ti ti-trash" style={{fontSize:10}} aria-hidden="true"/>
            </button>
          </div>;
        })}
      </div>}

      {/* Scope notice */}
      <div style={{background:T.accBg,border:"1px solid "+T.acc+"33",borderRadius:8,padding:"8px 11px",marginBottom:10,display:"flex",gap:6,alignItems:"flex-start"}}>
        <i className="ti ti-info-circle" style={{fontSize:12,color:T.acc,flexShrink:0,marginTop:1}} aria-hidden="true"/>
        <div style={{fontSize:11,color:T.acc,lineHeight:1.6}}>
          <strong>CSV files</strong> (like CPU profiling exports) are parsed automatically — top hotspots extracted from all rows. Scoped to <code style={{fontFamily:"var(--font-mono)",fontSize:10}}>com.idit</code> and <code style={{fontFamily:"var(--font-mono)",fontSize:10}}>com.alphacsp</code>. Different package? Mention it in Analysis Goal (e.g. "package is com.myorg").
        </div>
      </div>

      <button onClick={analyze} style={{width:"100%",padding:"11px 16px",fontSize:13,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:7,cursor:"pointer",background:"linear-gradient(135deg,#1e1b4b 0%,#1e40af 60%,#0369a1 100%)",color:"#fff",border:"none",borderRadius:9}}>
        <i className="ti ti-search" style={{fontSize:15}} aria-hidden="true"/>
        {projName?"Analyze "+projName+" →":"Analyze performance →"}
      </button>

      <div style={{display:"flex",gap:10,marginTop:8,justifyContent:"center",flexWrap:"wrap"}}>
        {[["ti-bolt","2-phase analysis"],["ti-filter","com.idit scope"],["ti-shield-check","No infra recommendations"],["ti-terminal-2","Full audit log"]].map(([ic,txt])=>(
          <div key={txt} style={{display:"flex",alignItems:"center",gap:3,fontSize:10,color:T.muted}}>
            <i className={"ti "+ic} style={{fontSize:11}} aria-hidden="true"/>{txt}
          </div>
        ))}
      </div>
    </div>

    {/* Recent analyses quick-access */}
    {history.length>0&&<div style={{marginTop:10}}>
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:7}}>
        <i className="ti ti-history" style={{fontSize:12,color:T.muted}} aria-hidden="true"/>
        <span style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.08em"}}>Recent Analyses</span>
        <span style={{fontSize:10,color:T.faint,marginLeft:2}}>({history.length})</span>
      </div>
      {history.slice(0,5).map(entry=>{
        const rc={CRITICAL:"#ef4444",HIGH:"#f97316",MEDIUM:"#eab308",LOW:"#22c55e"}[entry.rating]||T.muted;
        const c=entry.counts||{};
        return <div key={entry.id}
          onClick={()=>{setResult(entry.result);setProjName(entry.projName||"");setEnv(entry.env||"UAT");setBuild(entry.build||"");setGoal(entry.goal||"");setTokens(entry.tokens||0);setViewingHistory(true);setPhase("results");setTab("actions");}}
          style={{background:T.surf,border:"0.5px solid "+T.bdr,borderRadius:8,padding:"8px 11px",marginBottom:6,cursor:"pointer",display:"flex",alignItems:"center",gap:9,transition:"all .15s"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=T.acc;e.currentTarget.style.background=T.surf2;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=T.bdr;e.currentTarget.style.background=T.surf;}}>
          <i className="ti ti-report-analytics" style={{fontSize:13,color:T.muted,flexShrink:0}} aria-hidden="true"/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:600,color:T.txt,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{entry.label}</div>
            <div style={{fontSize:10,color:T.muted}}>{historyFmtDate(entry.savedAt)}</div>
          </div>
          {entry.rating&&<span style={{fontSize:9,fontWeight:700,color:rc,background:rc+"15",padding:"1px 6px",borderRadius:6,flexShrink:0}}>{entry.rating}</span>}
          {c.total>0&&<span style={{fontSize:9,color:T.muted,flexShrink:0}}>{c.total} findings</span>}
          <i className="ti ti-chevron-right" style={{fontSize:11,color:T.faint,flexShrink:0}} aria-hidden="true"/>
        </div>;
      })}
      {history.length>5&&<button
        onClick={()=>{setResult(history[0].result);setProjName(history[0].projName||"");setEnv(history[0].env||"UAT");setTokens(history[0].tokens||0);setViewingHistory(true);setPhase("results");setTab("history");}}
        style={{width:"100%",padding:"6px",background:"transparent",border:"0.5px dashed "+T.bdr,borderRadius:8,cursor:"pointer",fontSize:11,color:T.muted}}>
        View all {history.length} saved analyses ->
      </button>}
    </div>}
  </div>;
}
