const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed"]);

export function isFatalSpeechError(error) {
  return FATAL_ERRORS.has(error);
}
