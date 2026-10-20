export type ModelSlots = { transcribe:string; understand:string; prep:string };
export const emptyModels: ModelSlots = { transcribe:'', understand:'', prep:'' };
/** Prep work (Thanglish conversion + speaker identification) runs on a cheaper, faster model than scoring. */
export const defaultModels: ModelSlots = { transcribe:'microsoft/mai-transcribe-2', understand:'anthropic/claude-sonnet-4.5', prep:'openai/gpt-4o-mini' };
/** Published speech-to-text price (USD per audio hour), used only when OpenRouter does not report the billed cost. */
export const transcribePricePerHour: Record<string, number> = { 'microsoft/mai-transcribe-2': 0.1, 'microsoft/mai-transcribe-1.5': 0.36 };
export type RouterModel = { id:string; name:string; architecture?:{input_modalities?:string[];output_modalities?:string[]}; pricing?:{prompt?:string;completion?:string} };
