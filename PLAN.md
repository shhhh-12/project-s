# CallScore Stage 1 plan

## Architecture
Vite + React + strict TypeScript single-page app with small feature modules: input, pipeline, results, history and settings. Validated `Analysis` records persist through `idb-keyval`; localStorage holds the user-selected OpenRouter key and models. The knowledge pack is split into raw-imported Markdown plus a typed inbound rubric JSON. Pure scoring, quote verification, metrics and transcript parsers are independently tested. There is no mock/demo path: analysis is blocked until a current model and local key are selected.

The browser OpenRouter client calls `/chat/completions` for understand, score and coach, and supports retry/cancel/usage. Audio transcription is isolated behind a provider interface: OpenRouter STT uses `/audio/transcriptions` (text + usage); an audio-chat provider can use `input_audio` for structured turns. Browser audio preparation (`src/lib/audio.ts`) decodes to 16 kHz mono WAV and splits into 60 s parts; if decoding is unavailable the original file is sent whole. Speaker roles come from a verified labelling pass (`src/lib/diarize.ts`).

## Assumptions and decisions
- Enabled rubric is exactly inbound_lead + b2c. Other pack modules are present but disabled by config.
- Models are selected in Settings from the current Models API. A transcription-capable model is required for audio; a text-capable model is required for analysis.
- OpenRouter documentation checked 2026-10-16: Models API exposes input/output modalities; transcription models are discovered using `output_modalities=transcription`; `/audio/transcriptions` accepts base64 `input_audio` and returns transcript JSON/usage. The STT endpoint does not promise speaker diarization, so Stage B owns role separation.
- Unsupported live response shapes report a recoverable step error rather than fabricating an analysis.

## Risks / limits
Browser-held API keys are appropriate only for private/local use; no backend proxy is included. Mono diarization, Tanglish recognition and timestamp alignment depend on the selected model and need a Tamil-language golden set. Live audio work cannot be verified without an API key and a real recording. The supplied prompt is broader than a single implementation pass; the delivered core prioritizes a live transcript/audio flow, rubric accuracy, parsers, scoring, metrics, responsive results, local history, and a cancellable live pipeline.
