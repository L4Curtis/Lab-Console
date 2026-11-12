/**
 * API errors, in the one shape the browser understands (ARCHITECTURE §4):
 *
 *   { "error": "English sentence", "code": "module.reason", "params": {} }
 *
 * The browser translates `code` when it knows it and falls back to `error`.
 * A handler either answers with sendError(), or throws an HttpError and lets
 * the error handler in src/server.js answer (Express 5 forwards rejected
 * async handlers there)
 */
export class HttpError extends Error {
  constructor(status, code, message, params = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.params = params;
    this.expose = true;
  }
}

export const httpError = (status, code, message, params) => new HttpError(status, code, message, params);

export const errorBody = (code, message, params = {}) => ({ error: message, code, params });

export function sendError(res, status, code, message, params) {
  return res.status(status).json(errorBody(code, message, params));
}
