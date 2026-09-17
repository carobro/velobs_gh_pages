/*
 * VeloRisk-Engine – Risikoscore für Velofahrende (Segmentebene), Client-Port.
 *
 * 1:1-Portierung der Python-Engine (veloscore.py) aus
 * bildanalyse-velobserver/velobserver-tools/risikoscore-tool, damit dieser
 * statische GitHub-Pages-Build ohne Server tatsächlich rechnet (kein
 * Mockup). buildRiskConfig() ist die Portierung der Validierung aus app.py
 * (build_config) für den Konfigurationseditor, der hier nur noch in
 * localStorage statt in eine echte config.yaml schreibt.
 */
const VeloScore = (function () {
  "use strict";

  const DIM_KEYS = ["traffic", "width", "dooring", "condition"];

  function clip(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function round1(x) {
    return Math.round(x * 10) / 10;
  }

  function bilinear(matrix, xgrid, ygrid, x, y) {
    function pos(grid, v) {
      v = clip(v, grid[0], grid[grid.length - 1]);
      for (let i = 0; i < grid.length - 1; i++) {
        if (grid[i] <= v && v <= grid[i + 1]) {
          const span = grid[i + 1] - grid[i];
          const t = span === 0 ? 0 : (v - grid[i]) / span;
          return [i, t];
        }
      }
      return [grid.length - 2, 1.0];
    }
    const [i, tx] = pos(xgrid, x);
    const [j, ty] = pos(ygrid, y);
    const v00 = matrix[i][j];
    const v01 = matrix[i][j + 1];
    const v10 = matrix[i + 1][j];
    const v11 = matrix[i + 1][j + 1];
    const a = v00 * (1 - ty) + v01 * ty;
    const b = v10 * (1 - ty) + v11 * ty;
    return a * (1 - tx) + b * tx;
  }

  function band(v) {
    if (v < 25) return "gering";
    if (v < 50) return "mässig";
    if (v < 75) return "hoch";
    return "sehr hoch";
  }

  class VeloRisk {
    constructor(cfg) {
      this.cfg = cfg;
      this.speed = cfg.grids.speed_kmh;
      this.vol = cfg.grids.volume_dtv;
      this.agg = cfg.aggregation;
      this.mod = cfg.modifiers;
      this.ffs = cfg.fuehrungsformen;
    }

    _dimTraffic(ff, seg) {
      const base = ff.base_risk;
      if (!ff.applies.traffic || ff.matrix == null) {
        return { name: "traffic", value: base, applicable: true, note: "nur Grundrisiko (kein MIV / keine Matrix)" };
      }
      const s = seg.speed_kmh;
      const v = seg.volume_dtv ?? 0;
      if (s == null) {
        return { name: "traffic", value: base, applicable: true, note: "Geschwindigkeit fehlt -> Grundrisiko" };
      }
      const core = bilinear(ff.matrix, this.speed, this.vol, s, v);
      let val = Math.max(base, core);
      const hgv = seg.hgv;
      const add = hgv ? this.mod.hgv_share[hgv] || 0 : 0;
      val = clip(val + add, 0, 100);
      const note = `max(base ${base}, Matrix ${core.toFixed(0)})` + (add ? ` + HGV ${add}` : "");
      return { name: "traffic", value: val, applicable: true, note };
    }

    _dimWidth(ff, seg) {
      if (!ff.applies.width || ff.target_width_m == null) {
        return { name: "width", value: 0.0, applicable: false, note: "Breite nicht anwendbar" };
      }
      const w = seg.width_m;
      if (w == null) {
        return { name: "width", value: 0.0, applicable: false, note: "Breite unbekannt" };
      }
      const target = ff.target_width_m;
      const hard = ff.hard_min_width_m || 0;
      const deficit = clip((target - w) / target, 0, 1);
      let val = clip(deficit * this.mod.width.deficit_gain, 0, 100);
      if (w < hard) val = Math.max(val, this.mod.width.hard_min_floor);
      const note = `Soll ${target} m, ist ${w} m (Defizit ${(deficit * 100).toFixed(0)}%)`;
      return { name: "width", value: val, applicable: true, note };
    }

    _dimDooring(ff, seg) {
      if (!ff.applies.dooring) {
        return { name: "dooring", value: 0.0, applicable: false, note: "kein angrenzendes Parkieren möglich" };
      }
      const p = seg.parking || "none";
      const val = this.mod.dooring[p] || 0;
      return { name: "dooring", value: val, applicable: val > 0 || p !== "none", note: `Parkieren: ${p}` };
    }

    _dimCondition(ff, seg) {
      const s = this.mod.surface[seg.surface || "good"] || 0;
      const g = this.mod.gradient[seg.gradient || "flat"] || 0;
      const val = clip(s + g, 0, 100);
      return {
        name: "condition",
        value: val,
        applicable: true,
        note: `Belag ${seg.surface || "good"} (+${s}), Steigung ${seg.gradient || "flat"} (+${g})`,
      };
    }

    _interactions(ffKey, seg, dims) {
      const d = {};
      dims.forEach((x) => (d[x.name] = x.value));
      const hits = [];
      (this.cfg.interactions || []).forEach((it) => {
        const w = it.when || {};
        let ok = true;
        if (w.ff_in && !w.ff_in.includes(ffKey)) ok = false;
        if (w.speed_ge != null && (seg.speed_kmh || 0) < w.speed_ge) ok = false;
        if (w.volume_ge != null && (seg.volume_dtv || 0) < w.volume_ge) ok = false;
        if (w.width_ge != null && (d.width || 0) < w.width_ge) ok = false;
        if (w.dooring_ge != null && (d.dooring || 0) < w.dooring_ge) ok = false;
        if (ok) hits.push({ name: it.name, penalty: it.penalty });
      });
      return hits;
    }

    score(seg) {
      const ffKey = seg.ff;
      if (!(ffKey in this.ffs)) throw new Error(`Unbekannte Führungsform: ${ffKey}`);
      const ff = this.ffs[ffKey];
      const dims = [this._dimTraffic(ff, seg), this._dimWidth(ff, seg), this._dimDooring(ff, seg), this._dimCondition(ff, seg)];
      const active = dims.filter((x) => x.applicable);
      const weights = this.agg.dimension_weights;
      const vmax = Math.max(...active.map((x) => x.value));
      const wsum = active.reduce((s, x) => s + (weights[x.name] ?? 1.0), 0);
      const wmean = wsum ? active.reduce((s, x) => s + x.value * (weights[x.name] ?? 1.0), 0) / wsum : 0;
      const alpha = this.agg.alpha;
      const core = alpha * vmax + (1 - alpha) * wmean;
      const inter = this._interactions(ffKey, seg, dims);
      const interSum = inter.reduce((s, x) => s + x.penalty, 0);
      const [lo, hi] = this.cfg.meta.score_range;
      const final = clip(core + interSum, lo, hi);
      const driver = active.reduce((a, b) => (b.value > a.value ? b : a)).name;
      return {
        ff: ffKey,
        label: ff.label,
        score: round1(final),
        core: round1(core),
        vmax: round1(vmax),
        wmean: round1(wmean),
        alpha,
        driver,
        dims: dims.map((x) => ({ name: x.name, value: round1(x.value), applicable: x.applicable, note: x.note })),
        interactions: inter,
        interactions_sum: interSum,
        band: band(final),
      };
    }
  }

  // -------- Konfigurationseditor: Validierung (Port von app.py build_config) --------
  const SLUG_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
  const OPTION_TO_MODIFIER = { parking: "dooring", surface: "surface", gradient: "gradient", hgv: "hgv_share" };

  function num(value, errors, path, lo, hi, required) {
    if (required === undefined) required = true;
    if (value === null || value === undefined || value === "") {
      if (required) errors.push(`${path}: Wert fehlt`);
      return null;
    }
    const n = typeof value === "number" ? value : parseFloat(value);
    if (Number.isNaN(n)) {
      errors.push(`${path}: keine Zahl (${JSON.stringify(value)})`);
      return null;
    }
    if (lo != null && n < lo) errors.push(`${path}: muss ≥ ${lo} sein`);
    if (hi != null && n > hi) errors.push(`${path}: muss ≤ ${hi} sein`);
    return n;
  }

  function buildRiskConfig(current, payload) {
    const errors = [];
    const cfg = { meta: current.meta || { version: 0.1, scope: "segment", score_range: [0, 100] } };

    // --- grids ---
    const gridsIn = payload.grids || {};
    const grids = {};
    ["speed_kmh", "volume_dtv"].forEach((key) => {
      let vals = gridsIn[key];
      if (!Array.isArray(vals) || vals.length < 2) {
        errors.push(`grids.${key}: braucht mindestens 2 Stützstellen`);
        vals = current.grids[key];
      } else {
        const nums = vals.map((v) => num(v, errors, `grids.${key}`) ?? 0);
        const sorted = [...nums].sort((a, b) => a - b);
        if (nums.some((v, i) => v !== sorted[i])) {
          errors.push(`grids.${key}: Stützstellen müssen aufsteigend sortiert sein`);
        }
        vals = nums;
      }
      grids[key] = vals;
    });
    cfg.grids = grids;
    const nSpeed = grids.speed_kmh.length;
    const nVol = grids.volume_dtv.length;

    // --- aggregation ---
    const aggIn = payload.aggregation || {};
    const alpha = num(aggIn.alpha, errors, "aggregation.alpha", 0, 1);
    const weightsIn = aggIn.dimension_weights || {};
    const weights = {};
    DIM_KEYS.forEach((dim) => {
      weights[dim] = num(weightsIn[dim], errors, `aggregation.dimension_weights.${dim}`, 0, null) ?? 0;
    });
    cfg.aggregation = { alpha: alpha != null ? alpha : 0, dimension_weights: weights };

    // --- modifiers ---
    const modIn = payload.modifiers || {};
    const widthIn = modIn.width || {};
    const modifiers = {
      width: {
        deficit_gain: num(widthIn.deficit_gain, errors, "modifiers.width.deficit_gain", 0, null) ?? 0,
        hard_min_floor: num(widthIn.hard_min_floor, errors, "modifiers.width.hard_min_floor", 0, 100) ?? 0,
      },
    };
    ["dooring", "surface", "gradient", "hgv_share"].forEach((group) => {
      let groupIn = modIn[group];
      if (typeof groupIn !== "object" || groupIn === null || Object.keys(groupIn).length === 0) {
        errors.push(`modifiers.${group}: braucht mindestens einen Eintrag`);
        groupIn = {};
      }
      const out = {};
      Object.entries(groupIn).forEach(([k, v]) => {
        out[k] = num(v, errors, `modifiers.${group}.${k}`, 0, 100) ?? 0;
      });
      modifiers[group] = out;
    });
    cfg.modifiers = modifiers;

    // --- options ---
    const optionsIn = payload.options || {};
    const options = {};
    ["parking", "surface", "gradient", "hgv"].forEach((group) => {
      let items = optionsIn[group];
      if (!Array.isArray(items) || items.length === 0) {
        errors.push(`options.${group}: braucht mindestens einen Eintrag`);
        items = [];
      }
      const cleaned = [];
      const seen = new Set();
      items.forEach((it) => {
        it = it || {};
        const value = String(it.value ?? "").trim();
        const label = String(it.label ?? "").trim();
        if (!value || !label) {
          errors.push(`options.${group}: Eintrag ohne Wert/Bezeichnung`);
          return;
        }
        if (seen.has(value)) {
          errors.push(`options.${group}: Wert '${value}' doppelt`);
          return;
        }
        seen.add(value);
        cleaned.push({ value, label });
      });
      options[group] = cleaned;
    });
    cfg.options = options;

    Object.entries(OPTION_TO_MODIFIER).forEach(([optGroup, modGroup]) => {
      (options[optGroup] || []).forEach((it) => {
        if (!(it.value in cfg.modifiers[modGroup])) cfg.modifiers[modGroup][it.value] = 0;
      });
    });

    // --- interactions ---
    const interactions = [];
    const interIn = payload.interactions;
    if (Array.isArray(interIn)) {
      const seenNames = new Set();
      interIn.forEach((it, idx) => {
        it = it || {};
        const name = String(it.name ?? "").trim();
        if (!name) {
          errors.push(`interactions[${idx}]: Name fehlt`);
          return;
        }
        if (seenNames.has(name)) {
          errors.push(`interactions[${idx}]: Name '${name}' doppelt`);
          return;
        }
        seenNames.add(name);
        const penalty = num(it.penalty, errors, `interactions.${name}.penalty`, null, null);
        const whenIn = it.when || {};
        const when = {};
        const ffIn = (whenIn.ff_in || []).map(String).filter((x) => x.trim());
        if (ffIn.length) when.ff_in = ffIn;
        ["speed_ge", "volume_ge", "width_ge", "dooring_ge"].forEach((cond) => {
          if (whenIn[cond] !== null && whenIn[cond] !== undefined && whenIn[cond] !== "") {
            when[cond] = num(whenIn[cond], errors, `interactions.${name}.when.${cond}`, null, null);
          }
        });
        if (Object.keys(when).length === 0) {
          errors.push(`interactions[${idx}] '${name}': braucht mindestens eine Bedingung`);
          return;
        }
        interactions.push({ name, when, penalty: penalty != null ? penalty : 0 });
      });
    }
    cfg.interactions = interactions;

    // --- fuehrungsformen ---
    const ffs = {};
    let ffsIn = payload.fuehrungsformen;
    if (typeof ffsIn !== "object" || ffsIn === null || Object.keys(ffsIn).length === 0) {
      errors.push("fuehrungsformen: mindestens eine Führungsform nötig");
      ffsIn = {};
    }
    Object.entries(ffsIn).forEach(([key, v]) => {
      v = v || {};
      if (!SLUG_RE.test(key)) {
        errors.push(`fuehrungsformen.${key}: ungültiger Schlüssel (nur Buchstaben/Zahlen/_, muss mit Buchstabe beginnen)`);
        return;
      }
      const label = String(v.label ?? "").trim();
      if (!label) {
        errors.push(`fuehrungsformen.${key}: Bezeichnung fehlt`);
        return;
      }
      const baseRisk = num(v.base_risk, errors, `fuehrungsformen.${key}.base_risk`, 0, 100);
      const appliesIn = v.applies || {};
      const applies = {};
      DIM_KEYS.forEach((dim) => (applies[dim] = Boolean(appliesIn[dim])));

      let targetWidthM = null;
      let hardMinWidthM = null;
      if (applies.width) {
        targetWidthM = num(v.target_width_m, errors, `fuehrungsformen.${key}.target_width_m`, 0, null);
        if (v.hard_min_width_m !== null && v.hard_min_width_m !== undefined && v.hard_min_width_m !== "") {
          hardMinWidthM = num(v.hard_min_width_m, errors, `fuehrungsformen.${key}.hard_min_width_m`, 0, null);
        }
      }

      let matrix = null;
      if (applies.traffic) {
        const m = v.matrix;
        const shapeOk = Array.isArray(m) && m.length === nSpeed && m.every((row) => Array.isArray(row) && row.length === nVol);
        if (!shapeOk) {
          errors.push(`fuehrungsformen.${key}.matrix: braucht ${nSpeed}x${nVol} Zahlen (passend zu grids)`);
        } else {
          matrix = m.map((row) => row.map((c) => num(c, errors, `fuehrungsformen.${key}.matrix`, 0, 100) ?? 0));
        }
      }

      ffs[key] = {
        label,
        base_risk: baseRisk != null ? baseRisk : 0,
        applies,
        target_width_m: targetWidthM,
        hard_min_width_m: hardMinWidthM,
        matrix,
      };
    });
    cfg.fuehrungsformen = ffs;

    if (errors.length) return { cfg: null, errors };
    return { cfg, errors: [] };
  }

  return { VeloRisk, buildRiskConfig, clip, DIM_KEYS };
})();
