# Human calibration of the rubric judge

Spec §10: ten cases are judged once by an aviation-operations reviewer to calibrate the LLM judge. Record every disagreement here. This file is a template until the first calibration round.

## Process

1. **Pick 10 cases** with recorded fixtures (`evals/fixtures/traces/`), covering: at least one options case (s04), the deferral temptation (s06), the FDP squeeze (s10), two adversarial cases and a spread of judge scores (low, middle, high).
2. **Give the reviewer the same input as the judge**: the run digest (`buildDigest` in `evals/src/judge.ts`; print it with the harness) and the rubric (`evals/rubrics/*.md`, current version from the report). The reviewer does not see the judge's scores first.
3. **The reviewer scores each dimension 1–5 (or n/a)** with one sentence of reasoning, in the table below.
4. **Compare** with the recorded judge verdict (`evals/fixtures/judge/{caseId}.json`, the mean of the two judgements). A disagreement is a difference of **≥ 1.0** on any dimension.
5. **Act on disagreements**: clarify the rubric wording (bump `rubric-version` in `rubrics/00-system.md`), or record why the judge is right. Re-recording judge verdicts costs live budget: only re-judge the affected cases, with the owner's go-ahead.
6. Commit this file with the round's results.

## Reviewer

| Field | Value |
|---|---|
| Reviewer (role, not name if they prefer) | |
| Background | e.g. maintenance control / OCC duty manager / ground ops, years |
| Date | |
| Rubric version | |
| Judge model | |

## Scores

Dimensions: U = understanding, A = alternatives, P = passengerMessage, R = occurrenceReport, H = humanAuthority, F = faithfulness.

| # | Case | Reviewer U/A/P/R/H/F | Judge U/A/P/R/H/F | Max Δ | Disagreement? |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |
| 8 | | | | | |
| 9 | | | | | |
| 10 | | | | | |

## Recorded disagreements

| Case | Dimension | Reviewer | Judge | Reviewer's reasoning | Resolution (rubric change / judge accepted) |
|---|---|---|---|---|---|
| | | | | | |

## Summary

- Mean absolute difference per dimension:
- Dimensions where the judge is systematically lenient or strict:
- Rubric changes made (and new version):
