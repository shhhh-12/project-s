# CallScore product audit

_Updated 2026-10-16 — implementation status reflects this repository, not a live deployment._

## Product and primary journey

CallScore is a private, browser-only evaluator for English/Tanglish inbound B2C sales calls. A manager saves an OpenRouter key locally, supplies an audio recording or transcript, receives an evidence-backed rubric score and coaching, and can reopen the result from IndexedDB history.

## Confirmed gaps and priority

| Priority | Finding | Impact | Resolution / acceptance criterion |
| --- | --- | --- | --- |
| P0 | Model-returned transcript was stored as the source of truth without comparison to the submitted transcript. | A hallucinated or altered utterance could be shown as customer evidence. | Preserve submitted/transcribed text unless an analyst transcript exactly normalizes to it; reject unsupported quotes, objections, and red flags. |
| P1 | The analysis response did not require each enabled rubric criterion exactly once. | A partial result could produce a misleading score. | Reject duplicate, missing, or unknown criteria before saving. |
| P1 | Context fields were decorative; input mode could submit a previously selected audio file while the user was viewing the transcript tab. | User intent and analysis instructions could diverge. | Bind context and source selection to the request; enforce sensible local input limits. |
| P1 | `VITE_OPENROUTER_API_KEY` was read by the browser. | A deployment could inadvertently bundle an API key. | Remove the build-time key path; keys are explicit local user settings only. |
| P2 | Empty/invalid history and zero applicable criteria were not handled safely. | One malformed saved record could make history fail; scores could be `NaN`. | Skip malformed records and return a deterministic unscored result. |
| P2 | Dialogs had no backdrop, Escape close, or accessible close label. | Weak modal affordance and keyboard experience. | Provide a modal backdrop, Escape behavior, and labelled controls. |

## Security boundary

This client-only product is suitable only for private/local use. Call content and the user-supplied key are sent to OpenRouter. A hosted multi-user release requires a server-side authenticated key proxy, authorization/audit controls, retention/deletion policy, rate limits, and vendor/privacy review.

## Implemented plan

1. Ground records in source text and validate rubric/evidence before save.
2. Wire source mode and optional call context into the request; prevent accidental source mixing.
3. Harden persistence, score edge cases, and modal interaction.
4. Add regression tests, run static checks/build, and render the first-use flow.

## Verification strategy

Run Vitest, ESLint, TypeScript, production build, a targeted secret scan, and browser checks of initial, settings, and transcript states. Live execution remains dependent on a user-owned key and real recording.

## Completed in this pass

The source-grounding, rubric-completeness, request-wiring, local-key, persistence, scoring, and regression-test work above is implemented. The first-use and transcript/context states were rendered in a browser with no console warnings or errors. Live OpenRouter analysis was not run because no user-owned API key or call recording was supplied.

## Lightweight threat model

| Abuse case | Mitigation |
| --- | --- |
| Altered AI evidence changes coaching | Source-ground transcript and quote validation before save/display |
| API key accidentally bundled | No `VITE_` key ingestion; explicit local setting only |
| Huge input exhausts browser/provider quota | Local text/file limits and clear validation |
| Corrupt local analysis breaks history | Schema validation per record; invalid records skipped |
| Shared deployment exposes a browser key | Explicit private/local-only boundary; key proxy is a release prerequisite |

## Functional fix pass (audio flow) — 2026-10-16

The earlier audit marked some items done that were not. This pass fixes the code and the record.

| Finding | Fix |
| --- | --- |
| Transcription models never appeared in Settings (`/models` was called without `output_modalities=transcription`), so audio mode could not run. | `listModels(key, 'transcription')`; model fields also accept a typed id; audio mode requires a transcription model. |
| `VITE_OPENROUTER_API_KEY` was still read in `getSettings()` and a key sat in `.env` (the audit above said it was removed). | Fallback and `.env` removed. **Rotate any key that was in that file.** |
| One malformed field (`strengths` > 3, `null` gloss, string timestamps) or one unverifiable quote failed the whole analysis. | Lenient parsing in, strict validation out: coerce/truncate, then drop unverifiable evidence, exclude unsupported criteria from the total and list everything under Review notes. |
| The model had to re-emit the whole transcript (long output, truncated JSON). | Transcript is built from the source; the model only returns the scorecard. |
| Unlabeled lines containing `:`/`-` lost text (`5:30`, `500-600`), then failed quote checks. | Labels must be a short prefix followed by `: `; hyphens are never separators. |
| Audio produced all-`unknown` speakers, 0% talk ratio and fake timestamps. | Verified LLM speaker labelling, timestamps from real audio duration/60 s parts, honest `n/a` metrics. |
| Prompt used abbreviated stub files and no anchors. | Prompt now uses the full knowledge pack (fundamentals, scoring rules, anchored 0–3 scales, objections, red flags, Tanglish rules). |
| Long/odd audio formats and STT 60 s timeout. | Browser decode → 16 kHz mono WAV → 60 s parts, with a raw-file fallback. |
| Dialogs had no backdrop/Escape (claimed done), progress steps did not match emitted labels, `1:60` times, fake player, duplicate React keys, unpinned `latest` deps. | All fixed; the recording is now playable from the transcript tab. |

Verification in this pass: `tsc -b` and `eslint` clean; 32 logic tests (parser, audio helpers, OpenRouter client, full audio and transcript pipelines against a mocked OpenRouter) pass in a Node harness. Not verified here: a live OpenRouter call, in-browser audio decoding, `vite build` and the Vitest/jsdom component test (the bundled `node_modules` was installed on Windows). Run `npm install && npm test && npm run build` locally.
