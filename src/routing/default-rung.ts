/** The default rung of the small models that judge and classify (the tier classifier, the effort judge and the handling judge). In its own module so both can import it without a cycle. */
export const DEFAULT_ROUTING_MODEL_RUNG = "anthropic/claude-haiku-5-5:low";

/** The default fallback rung when the default model does not answer or is not installed. */
export const DEFAULT_ROUTING_FALLBACK_RUNG = "openai-codex/gpt-6-luna:low";
