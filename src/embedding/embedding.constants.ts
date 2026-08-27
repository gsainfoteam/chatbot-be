export const DOCUMENT_CHUNK_EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
export const DEFAULT_VECTOR_CANDIDATE_LIMIT = 20;

/**
 * A conservative UTF-8 byte cap for 8K-token-class embedding models. Since a
 * token always consumes at least one input byte, this also bounds the token
 * count without coupling the provider-agnostic client to one tokenizer.
 */
export const MAX_EMBEDDING_INPUT_BYTES = 8_000;
