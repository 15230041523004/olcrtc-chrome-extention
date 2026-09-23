export function errorMessage(error, fallback = 'unknown error') {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message;
  if (error != null) {
    try {
      const encoded = JSON.stringify(error);
      if (encoded && encoded !== '{}') return encoded;
    } catch {
      // Fall through to String below.
    }
    const text = String(error);
    if (text && text !== '[object Object]' && text !== 'undefined') return text;
  }
  return fallback;
}
