# Terminal-Bench 2.1 — DeepSeek V4 Flash: three file-editing contracts in one harness

This report compares three file-editing tool contracts inside a single agent harness, on the same model, over the same Terminal-Bench 2.1 suite. Everything else is held fixed: the same DeepSeek Harness build, the same persistent-bash tool, the same system persona, the same deadline policy, the same executor. The only thing that moves between arms is how the model is allowed to change a file.

**Run id:** `edit-contracts-v1`, with three follow-up runs that re-ran cells the main run could not score

**Metric:** end-to-end pass@1 by the official task verifier

**Status:** `completed_with_gaps` — 86 of 89 tasks scored on all three arms

**Per-task outcomes:** [`terminal-bench-2.1-deepseek-v4-flash-edit-contracts.csv`](./terminal-bench-2.1-deepseek-v4-flash-edit-contracts.csv)

## TL;DR

- **`str_replace_editor` 56/86, `apply_patch` 56/86, `fs` 53/86. No pair is distinguishable.** The two-tool arms tie exactly; the largest gap is three tasks. Exact McNemar gives p = 1.00, 0.63, and 0.65 for the three comparisons.
- **The suite's own noise is an order of magnitude larger than any gap.** The three arms disagree on **29 of 86 tasks (33.7%)** while their scores span three. A single run of this suite cannot resolve an effect this small, and this run does not.
- **The arms fail differently even though they pass equally.** `fs` records nearly twice the verification failures of the baseline (13 against 7) and fewer deadline losses. It produces more answers and more of them are wrong.
- **`fs` costs 13% more for three fewer passes**, at 30% more reasoning tokens. `str_replace_editor` and `apply_patch` are within 1% of each other on every economic measure.
- **The treatment is a tool family, not a diff format.** The arms differ in tool count, in tool-description length, and in whether guidance lives in the tool or the system prompt. `fs` presents the most tools and the *least* instruction text.

## What was held fixed and what varied

One harness build, one model, one composition, three plugin rows.

| | `str_replace_editor` (baseline) | `fs` | `apply_patch` |
| --- | --- | --- | --- |
| Editing plugin | `@deepseek-ai/dsh-tool-str-replace-editor` | `@deepseek-ai/dsh-tool-fs` | repo-authored V4A plugin |
| Model-facing tools | `bash`, `str_replace_editor` | `bash`, `edit`, `read`, `write` | `apply_patch`, `bash` |
| Tool descriptions | 4,730 chars | 1,096 chars | ~3,140 chars |
| Tool-contributed system prompt | none | 764 chars, 3 sections | none |
| Total instruction text | **4,730** | **1,860** | **3,140** |

The tool surfaces above were read back from the live runs' provider telemetry, not from the composition files, so they are what the model actually saw.

This asymmetry is the reason the treatment cannot be called "the edit contract" in the narrow sense. `fs` does not merely replace one tool with another: it splits reading, writing and editing into three tools, moves its guidance out of the tool description and into the system prompt, and ends up presenting 39% of the baseline's instruction text. Any difference this run measured is attributable to that whole package.

## Results

| Arm | Pass@1 | Passed / scored | Deadline exhausted | Exhausted but still passed | Verification failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| `str_replace_editor` | **65.1%** | 56 / 86 | 30 | 7 | 7 |
| `apply_patch` | **65.1%** | 56 / 86 | 27 | 6 | 9 |
| `fs` | **61.6%** | 53 / 86 | 28 | 8 | 13 |

Harbor raises its agent timeout and then runs the verifier anyway, so exhaustion and failure are two facts about a cell rather than two buckets. Between six and eight exhausted cells per arm still passed. A cell's failure class is therefore "exhausted and unscored" plus "verified and rejected", which is what the last two columns sum to.

## Pairwise significance

Exact two-sided McNemar over discordant task pairs, with the 86 scored tasks as the paired units. The chi-square form is not usable here — every comparison has fewer than 25 discordant pairs.

| Comparison | A-only | B-only | Discordant | p |
| --- | ---: | ---: | ---: | ---: |
| `str_replace_editor` vs `apply_patch` | 11 | 11 | 22 | 1.0000 |
| `str_replace_editor` vs `fs` | 10 | 7 | 17 | 0.6291 |
| `fs` vs `apply_patch` | 8 | 11 | 19 | 0.6476 |

Nothing approaches significance. The first row is the clearest statement this run makes: swapping a `str_replace`-style editor for a V4A patch envelope produced 22 tasks that changed outcome and a net difference of exactly zero.

## The noise floor

| Outcome pattern (`str_replace_editor`, `fs`, `apply_patch`) | Tasks |
| --- | ---: |
| all three pass | 40 |
| all three fail | 17 |
| every other pattern | 29 |

**29 of 86 tasks (33.7%) came out differently on at least one arm.** The six discordant patterns are spread evenly — the largest is six tasks — which is what one expects from independent per-task coin flips, not from a systematic contract effect.

This is the number that governs how the rest of the report should be read. A three-task spread between arms is well inside a regime where a third of the suite is decided by run-to-run variation. Establishing an effect of this size would need repetitions, not more tasks.

## Where the arms actually differ

Equal scores conceal unequal failure modes.

| Diagnostic | `str_replace_editor` | `fs` | `apply_patch` |
| --- | ---: | ---: | ---: |
| Verification failures | 7 | **13** | 9 |
| Requests per cell | 40.8 | 38.8 | 39.1 |
| Output tokens per request | 663 | **842** | 705 |
| Reasoning tokens, total | 1.57 M | **2.03 M** | 1.58 M |
| Median cell | 899 s | 786 s | **700 s** |
| Mean cell | 949 s | 930 s | 949 s |

`fs` takes slightly fewer steps and makes each one substantially larger: 27% more output per request and 30% more reasoning overall. It loses fewer cells to the deadline than the baseline and nearly doubles its verification failures. The shape is an arm that finishes more often and is wrong more often when it does.

`apply_patch` has the fastest median cell by 200 seconds against the baseline while landing on the identical score. Its mean matches the others exactly, so the gain is in the middle of the distribution, not in the tail.

None of these differences is significant on its own, and this run does not establish a cause for any of them.

## Exclusive outcomes

Tasks one arm passed and both others failed, and the reverse:

| Arm | Won alone | Lost alone |
| --- | ---: | ---: |
| `str_replace_editor` | 5 | 5 |
| `fs` | 2 | 5 |
| `apply_patch` | 6 | 6 |

**`str_replace_editor` only:** `adaptive-rejection-sampler`, `cancel-async-tasks`, `crack-7z-hash`, `dna-insert`, `sanitize-git-repo`

**`fs` only:** `feal-linear-cryptanalysis`, `protein-assembly`

**`apply_patch` only:** `db-wal-recovery`, `mailman`, `make-mips-interpreter`, `model-extraction-relu-logits`, `overfull-hbox`, `regex-chess`

No task in any of these sets is obviously an editing task. The lists are consistent with noise and this run offers no evidence that they are anything else.

## Economics

| Arm | Total cost | Passed | Cost per pass | Input tokens | Cache-hit share | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `str_replace_editor` | $1.36 | 56 | **$0.0243** | 145.9 M | 98.40% | 2.33 M |
| `apply_patch` | $1.37 | 56 | $0.0245 | 149.4 M | 98.47% | 2.37 M |
| `fs` | $1.54 | 53 | $0.0291 | 160.3 M | 98.57% | 2.81 M |

The two two-tool arms are within 1% of each other on every column. `fs` spends 13% more in total and 20% more per pass, which follows directly from its larger responses rather than from more of them.

Costs are cache-aware API-equivalent estimates from the published DeepSeek V4 Flash pricing — $0.14 per million uncached input tokens, $0.0028 per million cache-hit input tokens, $0.28 per million output tokens — applied to metered usage. They are not a billing invoice, and they cover only the cells that landed in the final tally. The account was billed considerably more, because the same machine also ran the discarded and aborted attempts described under [Operational findings](#operational-findings).

## Unscored tasks

Three of the 89 tasks are not in the tally.

| Task | Reason |
| --- | --- |
| `torch-pipeline-parallelism` | All three arms exhausted the 900 s agent budget (`exit 124`) in both the main run and a low-concurrency re-run. The verifier, which builds a fresh environment and downloads ~2.5 GB of CUDA wheels against the same 900 s wall, never produced a reward. |
| `torch-tensor-parallelism` | As above. |
| `kv-store-grpc` | `fs` and `apply_patch` completed; the baseline cell came back `indeterminate` (`external subject cancelled`). This is the one asymmetric exclusion in the run. |

The two torch tasks are a symmetric exclusion: the same wall bound every arm, in two runs, under two different concurrency settings. Their scores are missing rather than zero — an agent that ran out of budget may still have left a passing state behind, and only the verifier could have said so. `kv-store-grpc` is asymmetric and was not recovered; recovering it could have moved one arm's count by at most one, which no reading of the significance table would change.

## Operational findings

Four failures in this run were the harness's, not the model's. Each was reproduced on the host before being fixed, and each fix is in this branch.

**Native modules pin a glibc floor.** The toolchain was built on `node:22-bookworm`, and the resulting `pty.node` required `GLIBC_2.34`. Every task whose image is `debian:bullseye-slim` (glibc 2.31) failed at boot with `Failed to load native module: pty.node`, for all three arms — a whole symmetric cohort lost. Rebuilding on `node:22-bullseye` drops every native module in the tree to at most `GLIBC_2.28` (node-pty 2.28, koffi and sharp 2.17, node-addon-require-builtin 2.14) and carries the identical 22.23.2 interpreter. A benchmark toolchain's base image is a compatibility floor for the task images, not an implementation detail.

**A task instruction beginning with `-` was parsed as an option.** The harness CLI re-parses arguments after the first `--`, so an instruction like `-1 ...` needs two separators to survive. `pytorch-model-recovery` was the only affected task in this suite. The fix was verified to be inert elsewhere: for a normal task the outbound request is byte-identical with one separator and with two (3,632 bytes, `cmp` clean).

**`fs.inotify.max_user_instances` is a host-wide budget.** Its default of 128 is shared across every root-run container, and the harness's file watcher exhausts it above roughly 36 concurrent trials, surfacing as `EMFILE: too many open files, watch`. Raising it to 8,192 with `ulimit -n 262144` removed the failure class entirely; the full run recorded zero. Any host reproducing this run needs that setting before it needs more cores.

**Verifier bandwidth is a scheduling constraint, not just a timeout.** Four tasks in this suite build a fresh Python environment in the verifier and pull ~2.5 GB of CUDA wheels against a 900 s wall. At 96 concurrent trials they starved and returned no reward. The host sustains ~10 MB/s on one stream, so a single verifier fits comfortably and twelve do not. Re-running `pytorch-model-recovery` one arm at a time turned three unscored cells into three passes without changing anything else.

Two further fixes were made to the subject wrapper while diagnosing the above: the subject's stderr tail is now written to an artifact file rather than into the result frame, which has a 2 KiB payload cap, and a setup error is now reported to stderr instead of being swallowed by a frame that cannot carry it. The second of these immediately caught a temporal-dead-zone bug introduced by the first.

## Frozen setup

| Dimension | Value |
| --- | --- |
| Benchmark | Terminal-Bench 2.1, revision `d49e28f1e4ddd13d289e85a5f312a66750951932`; all 89 tasks |
| Model | `deepseek-v4-flash` on all three arms |
| Harness | DeepSeek Harness `@deepseek-ai/dsh` 0.1.0-rc.6, identical build on all three arms |
| Toolchain fingerprint | `sha256:04c77f754c07123176f036f8a29ad57da3b5f654dd66ab47ae291e05d08a3e62` (main run), `sha256:e748834fac1977038e297c498f496ab922c726261b666b57d0e20348bd8118bf` (bullseye rebuild, used for the five re-run tasks) |
| Executor | Harbor 0.20.0, Docker environment, containers deleted on exit |
| Repetitions | 1 |
| Metric | Paired pass@1 by the official verifier |
| Deadline policy | Task-native agent timeout ×1 |
| Placement | All three arms execute inside the task container |
| Concurrency | 32 task groups, 96 cells, on 56 vCPU and 256 GiB |
| Host | Tencent Cloud `S8.14XLARGE256`, Ubuntu, `fs.inotify.max_user_instances=8192`, `nofile` 262144 |
| Billing mode | Metered, using the DeepSeek V4 Flash pricing identity above |

The 96-cell ceiling is not a repository convention. The account's postpaid quota is 60 vCPU per zone, which fixes the largest instance available; 96 concurrent trials at the measured 2.7 GiB per trial is what that machine holds.

Five of the 89 tasks were scored by a follow-up run rather than the main run: `qemu-startup`, `qemu-alpine-ssh` and `mteb-retrieve` from a 6-concurrency repair run, and `pytorch-model-recovery` from three single-arm runs. Those cells used the bullseye toolchain and the two-separator argv; the other 84 tasks used the original build. Within every task all three arms shared one build, so the paired comparison is unaffected, but the stratification is real and is recorded per-cell in the CSV.

## Limitations

- One run, one repetition. The measured 33.7% task-level disagreement between arms means this design cannot resolve differences smaller than roughly ten tasks, and the observed differences are three.
- The treatment is a tool family plus its guidance, not an isolated diff format. `fs` differs from the baseline in tool count, in instruction length, and in where the instructions live; no single-variable ablation was run.
- Three tasks are unscored, one of them asymmetrically (`kv-store-grpc`).
- The two torch tasks are reported as unscored rather than as zeros. Treating them as zeros would be an inference about a verifier that never ran.
- Pairwise McNemar tests are reported without multiple-comparison correction. None approaches the uncorrected threshold, so correction would not change any conclusion.
- Cost figures are list-price estimates over metered usage for the landed cells only; they are not the account's spend for this experiment.
- Model conversation traces were not captured. The harness does not persist message history and the task containers are deleted on exit, so the archived evidence is per-cell results, verifier output, subject stderr and token accounting — not trajectories. Capturing trajectories would require the subject wrapper to record request and response bodies, and a re-run.
