}

/**
 * @category Common Types
 */
export interface Result {
  /**
   * See [General fields: `_meta`](/specification/2025-11-25/basic/index#meta) for notes on `_meta` usage.
   */
  _meta?: { [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * @category Common Types
 */
export interface Error {
  /**
   * The error type that occurred.
   */
  code: number;
  /**
   * A short description of the error. The message SHOULD be limited to a concise single sentence.
   */
  message: string;
  /**
   * Additional information about the error. The value of this member is defined by the sender (e.g. detailed error information, nested errors etc.).
   */
  data?: unknown;
}

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 *
 * @category Common Types
 */
export type RequestId = string | number;

/**
 * A request that expects a response.
 *
 * @category JSON-RPC
 */
export interface JSONRPCRequest extends Request {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
}

/**
 * A notification which does not expect a response.
 *
 * @category JSON-RPC
 */
export interface JSONRPCNotification extends Notification {
  jsonrpc: typeof JSONRPC_VERSION;
}

/**
 * A successful (non-error) response to a request.
 *
 * @category JSON-RPC
 */
export interface JSONRPCResultResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: Result;
}

/**
 * A response to a request that indicates an error occurred.
 *
 * @category JSON-RPC
 */
export interface JSONRPCErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: RequestId;
  error: Error;
}

/**
 * A response to a request, containing either the result or error.
 */
export type JSONRPCResponse = JSONRPCResultResponse | JSONRPCErrorResponse;

// Standard JSON-RPC error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
