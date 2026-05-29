# CYNSN Pipeline — Detailed Mermaid Diagram

Diagrams the full `runCYNSNComparison` flow in `frontend/src/lib/analyzers/cynsn.ts`.
Identifies two bugs: `n=10` hard cap and CYNSN-2 grid mismatch.

```mermaid
flowchart TD
    A["MatchedPatchPair[]<br/>RGB_R/G/B + spectra (36λ)"] --> B

    B["filter valid<br/>has RGB AND spectra.length ≥ 3"]
    B --> C["N patches total"]

    C --> D["RGB → CMY<br/>c=(255-R)/255, m=(255-G)/255, y=(255-B)/255<br/>→ cmy_all: N×3<br/>→ spec_all: N×36"]

    D --> SPLIT["50/50 split<br/>even i → CAL, odd i → TEST"]
    SPLIT --> CAL["cmy_cal N_cal×3<br/>spec_cal N_cal×36"]
    SPLIT --> TEST["cmy_test N_test×3<br/>spec_test N_test×36"]

    D --> PRIM["extractNeugebauerPrimaries3<br/>source: FULL dataset (N patches)<br/>K=4 IDW nearest<br/>exactTol=0.10"]
    PRIM --> P8["primaries: 8×36<br/>matched[0..7]: bool<br/>matchDistances[0..7]: float"]

    CAL --> YTRAIN
    P8 --> YTRAIN

    subgraph YTRAIN ["trainCYNSN3 — YNSN (n_intervals=1)"]
        Y1["x0 = [0, 0, 0, log(2)]<br/>Nelder-Mead maxIter=600"]
        Y1 --> YLOSS

        subgraph YLOSS ["loss(x) — called ~600× per training"]
            YL1["spreading = unpackTheta3([x0,x1,x2])"]
            YL2["⚠️ n = min(10, max(0.1, exp(x3)))<br/>HARD CAP at n=10"]
            YL3["grid = buildGridFromColorants3(primaries, nL=36, n_intervals=1, n)<br/>→ 2³=8 nodes, YNSN formula"]
            YL4["cmy_eff = applySpreading3(cmy_cal, spreading, N_cal)<br/>polynomial dot-gain per channel"]
            YL5["R_pred = predictSpectra3(grid, nL, n, n_intervals=1, cmy_eff, N_cal)"]
            YL6["spectraToLab(R_pred[i]) for each cal patch<br/>→ deltaE00 vs pre-cached lab_cal[i]"]
            YL7["loss = mean_ΔE00 + L2_reg·‖a‖² + mono_penalty·10"]
            YL1 --> YL2 --> YL3 --> YL4 --> YL5 --> YL6 --> YL7
        end

        Y1 --> YLOSS --> Y1
        YLOSS --> YCONV["converged or maxIter=600"]
    end

    YCONV --> YBEST["optN_YNSN = min(10, exp(result.x3))<br/>optGrid_YNSN = buildGridFromColorants3(primaries, 36, 1, optN_YNSN)<br/>ynsn.model: {n_exponent, n_intervals=1, spreading, grid_spectra}"]

    YBEST --> YEVAL["evaluateCYNSN3 on TEST set"]
    TEST --> YEVAL
    YEVAL --> YRES["YNSN result:<br/>median ΔE00 = ?<br/>mean ΔE00 = ?"]

    YBEST --> CGRID
    CAL --> CGRID

    subgraph CGRID ["buildGridFromData3 — pre-build measured grid"]
        CG1["Start: buildGridFromColorants3(primaries, 36, n_intervals=2, optN_YNSN)<br/>→ 3³=27 nodes baseline"]
        CG2["For each of 27 grid nodes (tc,tm,ty):<br/>find nearest patch in cmy_cal<br/>if bestDist ≤ tol=0.08 → override with measured spectra"]
        CG1 --> CG2
    end

    CGRID --> GC2["grid_cynsn2: 27×36<br/>measured spectra at close nodes<br/>YNSN formula at far nodes"]

    CAL --> CTRAIN
    P8 --> CTRAIN

    subgraph CTRAIN ["trainCYNSN3 — CYNSN-2 (n_intervals=2)"]
        C1["x0 = [0, 0, 0, log(optN_YNSN)]<br/>Nelder-Mead maxIter=600"]
        C1 --> CLOSS

        subgraph CLOSS ["loss(x) — BUG HERE ⚠️"]
            CL1["spreading = unpackTheta3([x0,x1,x2])"]
            CL2["⚠️ n = min(10, max(0.1, exp(x3)))"]
            CL3["🐛 grid = buildGridFromColorants3(primaries, 36, n_intervals=2, n)<br/>IGNORES grid_cynsn2 completely!<br/>optimizer never sees measured grid nodes"]
            CL4["cmy_eff = applySpreading3(cmy_cal, spreading, N_cal)"]
            CL5["R_pred = predictSpectra3(grid, nL, n, n_intervals=2, cmy_eff, N_cal)"]
            CL6["spectraToLab → deltaE00 vs lab_cal"]
            CL7["loss = mean_ΔE00 + L2_reg + mono_penalty"]
            CL1 --> CL2 --> CL3 --> CL4 --> CL5 --> CL6 --> CL7
        end

        C1 --> CLOSS --> C1
        CLOSS --> CCONV["converged or maxIter=600"]
    end

    CCONV --> CBAD["cynsn2.model: spreading optimized for<br/>buildGridFromColorants3 grid<br/>NOT for grid_cynsn2!"]

    CBAD --> COVERRIDE["🐛 POST-TRAINING OVERRIDE:<br/>cynsn2Model = { ...cynsn2.model, grid_spectra: grid_cynsn2 }<br/>Replace trained grid with measured one<br/>but spreading + n were tuned for wrong grid"]

    GC2 --> COVERRIDE

    COVERRIDE --> CEVAL["evaluateCYNSN3 on TEST set<br/>uses grid_cynsn2 + spreading_cynsn2<br/>mismatch → worse than YNSN"]
    TEST --> CEVAL
    CEVAL --> CRES["CYNSN-2 result:<br/>median ΔE00 = ? (likely > YNSN)"]

    YRES --> BEST["best_idx = argmin(median_ΔE00)<br/>→ YNSN wins"]
    CRES --> BEST
```

## Bugs Found

### Bug 1 — n=10 hard cap
`loss()` applies `Math.min(10, Math.exp(x[3]))`. If optimal n > 10 (some substrates need n=15–20),
the optimizer hits the boundary and stalls: gradient ≈ 0, result stuck at n=10.

**Fix:** raise cap to 30, or use uncapped `Math.exp(x[3])` with a soft penalty for very large n.

### Bug 2 — CYNSN-2 grid/spreading mismatch (primary bug)
`trainCYNSN3` for CYNSN-2 calls `buildGridFromColorants3` inside `loss()` — never sees `grid_cynsn2`.
Optimizer tunes `spreading` and `n` for the colorant-formula grid, then the grid is swapped to the
measured one post-training. Spreading parameters are incompatible with the substituted grid.

**Fix:** pass `grid_cynsn2` into `trainCYNSN3` and use it directly inside `loss()`.
Only `spreading` (and optionally `n`) should remain free parameters for CYNSN-2;
the grid itself is fixed from measurements.
