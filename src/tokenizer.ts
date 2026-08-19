import { encode } from "gpt-tokenizer";

/** Local observable counter (o200k_base). Not a billed Cursor tokenizer. */
export function countObservableTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}
