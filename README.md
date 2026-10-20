# CallScore

Browser-only evaluation of English/Tanglish inbound B2C sales calls. Upload a recording (or paste a transcript) and get an evidence-backed rubric score, coaching, objection review and a playable transcript.

## Run

```
npm install
npm run dev        # http://localhost:5173
```

`npm test`, `npm run lint`, `npm run typecheck` and `npm run build` are the checks. There is no mock/demo mode.

## First use (audio)

1. Open **Settings**, paste your OpenRouter key and click **Load available models**.
2. Choose a **transcription model** (speech-to-text, e.g. a Whisper model) and an **analysis model** (any capable chat model). You can also type a model id directly. Save.
3. Choose an audio file (up to 25 MB) and click **Analyze call**.

What happens:

1. **Prepare** – the browser decodes the file, converts it to 16 kHz mono WAV and cuts it into 60-second parts (OpenRouter STT providers time out at ~60 s per request). If the browser cannot decode the file it is sent as-is in one part.
2. **Transcribe** – each part goes to `/audio/transcriptions`; the text is joined.
3. **Identify speakers** – the analysis model labels rep/customer turns. Each piece is checked to contain exactly the transcribed words; a piece that fails the check stays unlabeled (with a warning) instead of failing the run.
4. **Score** – one call returns the 8-criterion scorecard, coaching, red flags and objections using the full knowledge pack (`knowledge/source_pack.md`).
5. **Validate** – every quote must exist in the transcript. Unverifiable quotes are removed, criteria left without evidence are excluded from the total, and everything dropped is listed under *Review notes*. Totals, bands and the compliance gate are computed in code.

Pasted transcripts skip steps 1–2 and, if they already have speaker labels or SRT/VTT cues, step 3.

## Notes

- The recording is stored in IndexedDB next to the analysis so the transcript tab can play it and jump to a line.
- Keys are entered in Settings and kept in `localStorage` only. There is no build-time key; do not put one in `.env`.
- Browser-held keys are for private/local use. A shared deployment needs a server-side key proxy.
- Timestamps for audio are estimated inside each 60-second part from text length (the STT endpoint returns text only), so they are accurate to a few seconds.

## Enable another call type

Add its complete anchored rubric JSON, source Markdown and tests, then flip the matching flag in `knowledge/config.yaml`. Do not reuse the inbound weights.

## Stage 2

Key proxy, Tamil golden-set/eval runner, B2B rubrics, provider-side diarization (`provider.options`), two-channel recordings, roleplay.
