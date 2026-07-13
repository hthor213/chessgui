# Human Mistake Mining in Chess — Literature & Prior-Art Survey

*Researcher-agent report, 2026-07-13. Feeds roadmap Phase 9 (human-like bot & mistake
mining) and spec 211 (avoidance puzzles). Preserved verbatim below the summary.*

## Distilled conclusions (team summary)

1. **Our core method is novel.** Per-rating conditional-miss-rate over *refutation
   perceptual features* with cognitive cause labels appears unpublished — Maia predicts
   *that* a blunder happens (black-box CNN, 71.7% accuracy), never *why*; all commercial
   taxonomies (chess.com Game Review, CB18 Error Report, lichess Insights, Aimchess)
   classify by magnitude/situation, none by perceptual cause.
2. **The long-range-piece hypothesis is untested in humans** at the academic level — only
   coach folklore ("bishop blindness") and one LLM-play study. Our corpus could produce
   the first real answer.
3. **Don't train the bot from scratch: build on Maia.** Maia-1/2 are GPL-3.0, Maia-3 is
   Apache-2.0 — all compatible with this project. Fine-tune/condition on our cause-labeled
   data. Maia4All gets per-player models from ~20 games (personalized training path).
4. **The user's chess.com critique is empirically confirmed** (Eisma et al. 2024 Turing
   tests): weakened Stockfish is detectably fake — it perturbs move *choice* while
   understanding stays superhuman; Maia's bounded understanding reads as human. Never
   build depth/noise weakening.
5. **Adopt Guid–Bratko complexity** as the primary difficulty feature (only metric
   validated against real human error rates); Barthélemy 2025 entropy as a secondary,
   single-source signal. **CQL / Bizjak-Guid motif detection** for feature tagging
   (verify CQL redistribution license before bundling).
6. **Noctie.ai is the direct commercial competitor** (human-like bots + puzzles from your
   own mistakes, closed-source).

**First five experiments once the eval-tagged corpus exists (priority order):**
(1) replicate Guid-Bratko complexity-vs-error on our corpus as a pipeline sanity check;
(2) test the long-range-piece hypothesis controlling for complexity; (3) motif-tagged
conditional-miss-rate table per band; (4) fine-tune Maia-2/3 conditioned on cause labels,
mini Turing-test it; (5) cross-validate entropy vs Guid-Bratko — divergence is itself
informative.

---

## Full report (verbatim)

Your planned method — per-rating conditional-miss-rate over refutation features (i.e.,
"given a threat-type X is present and requires seeing it, what fraction of players at
rating R fail to respond correctly, broken out by *why* it's missed") — is **not directly
published anywhere I found**. The closest analog is Maia's blunder-prediction work (KDD
2020), but that predicts *whether* a blunder happens from board features + metadata, not
*why*, and it is not broken into cognitively interpretable failure categories (long-range
piece, backward move, quiet move, etc.) at all. This gap is real and is your opening.

The Maia line (CSSLab, Toronto) is the dominant, most mature body of work for population-
and individual-level human move modeling and is GPL-3.0 for the versions you'd likely want
(v1/v2); Maia-3 is Apache-2.0. Cognitive science gives a solid *theoretical* frame
(chunking/templates, forced-vs-open positions, time pressure) but almost no work targets
the specific perceptual-blindness-by-piece-geometry hypothesis — that's a genuinely open,
testable question. Commercial taxonomy tools classify mistakes by *outcome magnitude and
category label*, not by *cognitive cause*. Noctie.ai is the most direct competitor for the
human-like-bot half and is closed-source/commercial.

### 1. Maia Chess line (CSSLab / Anderson & McIlroy-Young, U. Toronto)

| Work | Venue/Year | What it does | Numbers | Source |
|---|---|---|---|---|
| Maia-1 ("Aligning Superhuman AI with Human Behavior") | KDD 2020 | 9 Leela-derived nets, one per ~100-Elo bin 1100–1900, trained on 12M Lichess games each, predict next human move | Move-match: Stockfish 33–41%, Leela max 46%, Maia 46–52% peaking at its training band. Blunder prediction (>10pp win-prob drop): board-only RF 56.4%, +metadata 63%, residual CNN 71.7%, frequent positions 76.9%. 182M blunder + 272M non-blunder moves. | [arxiv 2006.01855](https://arxiv.org/abs/2006.01855), [KDD PDF](https://www.cs.toronto.edu/~ashton/pubs/maia-kdd2020.pdf), [morning paper](https://blog.acolyer.org/2020/09/14/aligning-superhuman-ai-with-human-behaviour/) |
| Maia-2 | NeurIPS 2024 | Single unified 23.3M-param model, full rating range via skill-aware attention | ~2pp over per-band ensemble | [arxiv 2409.20553](https://arxiv.org/abs/2409.20553), [GitHub](https://github.com/CSSLab/maia2) |
| Maia-3 | ICML 2026 (per repo) | "Chessformer" transformer | 57.1% top-1 move-match, quarter the params of prior SOTA | [GitHub CSSLab/maia3](https://github.com/CSSLab/maia3), [HF weights](https://huggingface.co/UofTCSSLab/Maia3-79M) |
| Individual behavior models | KDD 2022 | Fine-tunes population Maia to a specific player (~5000 games); stylometry | — | [arxiv 2008.10086](https://arxiv.org/abs/2008.10086) |
| Maia4All | 2025 | Few-shot individual modeling from ~20 games (250x data reduction) | — | [arxiv 2507.21488](https://arxiv.org/abs/2507.21488) |
| ChessMimic (independent) | 2026 preprint | Per-band transformers for move + clock + outcome | Beats Maia-2 per band; outcome AUC 0.78 | [arxiv 2606.04473](https://arxiv.org/abs/2606.04473) |

**Licensing:** Maia-1/2 GPL-3.0 (Leela-format nets, lc0 as body); Maia-3 Apache-2.0 with
code/weights/training data open. Both compatible with GPL-3.0 chessgui.
([chessprogramming wiki](https://www.chessprogramming.org/Maia_Chess))

**Gap confirmed:** no Maia paper decomposes *why* a position is missed. (Inference from
absence across a systematic search, not a verified negative.)

### 2. Cognitive science of chess

- de Groot (1946); Chase & Simon (1973) chunking (~50–100k patterns); Gobet template
  theory / CHREST computational model ([chrest.info](http://chrest.info/fg/bibliography-by-topic.html)).
- Holding (1985/92): search matters more than chunking implies — unresolved debate our
  data could inform.
- Chabris & Hearst (2003): GM blunders 6.85/1000 moves in rapid — time pressure is a
  major confound to tag ([Cognitive Science](https://onlinelibrary.wiley.com/doi/10.1207/s15516709cog2704_3)).
- Reingold et al. (2001) eye-tracking: experts fixate empty squares between pieces —
  relational scanning; closest existing methodology to testing gaze-level blindness
  ([SAGE](https://journals.sagepub.com/doi/10.1111/1467-9280.00309)).
- Intuition study (2023, [Psych. Research](https://link.springer.com/article/10.1007/s00426-023-01823-x)):
  rating explains ~44% of evaluation-error variance — room for cognitive features to add power.
- Kahneman & Klein (2009): chess = high-validity intuition domain — theoretical grounding
  for the "what players learned to SEE" lens.
- **Long-range-piece hypothesis: no peer-reviewed human study found.** Only coach
  folklore ([chess.com blog](https://www.chess.com/blog/MomirRadovic/chess-blindness-blunders-are-there-waiting-to-be-made))
  and an LLM (not human) path-obstruction finding ([arxiv 2604.10158](https://arxiv.org/pdf/2604.10158)).

### 3. Existing taxonomies — all magnitude/situation, none causal

- chess.com Game Review: rating-adjusted expected-points thresholds; labels only
  ([support](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc)).
- CB18 Error Report: "calculation Elo," phase/attacker context — situational, not causal
  ([ChessBase](https://en.chessbase.com/post/chessbase-18-error-report-what-is-your-blunder-elo)).
- lichess Insights: descriptive dashboard. Aimchess: 6 skill buckets + puzzles from your
  misses. DecodeChess: explains the ENGINE's move, not the human's failure.
- **Reusable infra:** CQL (Chess Query Language — free, license terms to verify:
  [vlasak.biz](https://www.vlasak.biz/vcql6.htm)) and Bizjak & Guid ML motif recognition
  ([ACG 2021](https://icga.org/wp-content/uploads/2021/11/ACG_2021_paper_30.pdf)).

### 4. Complexity metrics

- **Guid–Bratko complexity** (eval-instability across depth): validated directly against
  human error rates — adopt as primary
  ([champions paper](https://www.researchgate.net/profile/Ivan-Bratko/publication/220174548_Computer_Analysis_of_World_Chess_Champions/links/00463531ebec10d56f000000/Computer-Analysis-of-World-Chess-Champions.pdf),
  [tactical difficulty](https://www.researchgate.net/publication/335985540_Assessing_the_difficulty_of_chess_tactical_problems)).
- Barthélemy 2025 variation entropy over MultiPV gaps ([arxiv 2505.03251](https://arxiv.org/abs/2505.03251)) —
  elegant, SINGLE-SOURCE/UNREPLICATED, validated against theoretical thresholds only.
- Leela WDL sharpness ([lc0 blog](https://lczero.org/blog/2023/07/the-lc0-v0.30.0-wdl-rescale/contempt-implementation/)) — engineering signal.

### 5. Human-like engines

- **Noctie.ai** — closed commercial; per-user 600–2700, puzzles from own mistakes; most
  direct competitor ([noctie.ai](https://noctie.ai/)).
- **Stockfish Skill/UCI_Elo**: randomized score-bias among MultiPV candidates — produces
  non-human error signature (full understanding + injected noise).
- **Eisma, Koerts & de Winter 2024 Turing tests** ([ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2451958824001295)):
  weakened Stockfish flagged as "strange"; Maia often mistaken for human. Replicated
  negative result: never weaken by noise.
- Chessiverse / chess.com personality bots: methods unverified/closed.

### Gaps flagged by the researcher

CQL redistribution license unconfirmed; Guid-Bratko rating-estimation correlation not
full-text-verified; Chessiverse method unverified; Maia KDD numbers partly from a
secondary summary (Colyer) cross-checked with arXiv; long-range-piece gap is
absence-of-evidence after systematic search.
