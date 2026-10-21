export type ModelSlots = { transcribe:string; understand:string; prep:string };
export const emptyModels: ModelSlots = { transcribe:'', understand:'', prep:'' };
/** Prep work (Thanglish conversion + speaker identification) runs on a cheaper, faster model than scoring. */
// Scribe v2 gives the pipeline word timestamps and speaker labels in the transcription response,
// replacing the former multi-minute LLM speaker-labelling pass.
export const defaultModels: ModelSlots = { transcribe:'elevenlabs/scribe-v2', understand:'anthropic/claude-sonnet-4.5', prep:'openai/gpt-4o-mini' };
/** Published speech-to-text price (USD per audio hour), used only when OpenRouter does not report the billed cost. */
export const transcribePricePerHour: Record<string, number> = { 'microsoft/mai-transcribe-2': 0.1, 'microsoft/mai-transcribe-1.5': 0.36, 'elevenlabs/scribe-v2': 0.22, 'fish-audio/transcribe-1-pro': 0.36 };
export type RouterModel = { id:string; name:string; architecture?:{input_modalities?:string[];output_modalities?:string[]}; pricing?:{prompt?:string;completion?:string} };

/** Models whose transcription endpoint can return speaker-labelled words. */
export const supportsNativeDiarization = (model: string) => model === 'microsoft/mai-transcribe-2' || model === 'elevenlabs/scribe-v2' || model === 'fish-audio/transcribe-1-pro';
/** Scribe accepts the uploaded MP3/M4A/WAV directly, avoiding an expensive browser re-encode. */
export const supportsOriginalAudio = (model: string) => model === 'elevenlabs/scribe-v2';
