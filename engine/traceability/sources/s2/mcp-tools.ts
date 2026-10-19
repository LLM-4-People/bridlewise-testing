 * Sent from the client to request a list of tools the server has.
 *
 * @category `tools/list`
 */
export interface ListToolsRequest extends PaginatedRequest {
  method: "tools/list";
}

/**
 * The server's response to a tools/list request from the client.
 *
 * @category `tools/list`
 */
export interface ListToolsResult extends PaginatedResult {
  tools: Tool[];
}

/**
 * The server's response to a tool call.
 *
 * @category `tools/call`
 */
export interface CallToolResult extends Result {
  /**
   * A list of content objects that represent the unstructured result of the tool call.
   */
  content: ContentBlock[];

  /**
   * An optional JSON object that represents the structured result of the tool call.
   */
  structuredContent?: { [key: string]: unknown };

  /**
   * Whether the tool call ended in an error.
   *
   * If not set, this is assumed to be false (the call was successful).
   *
   * Any errors that originate from the tool SHOULD be reported inside the result
   * object, with `isError` set to true, _not_ as an MCP protocol-level error
   * response. Otherwise, the LLM would not be able to see that an error occurred
   * and self-correct.
   *
   * However, any errors in _finding_ the tool, an error indicating that the
   * server does not support tool calls, or any other exceptional conditions,
   * should be reported as an MCP error response.
   */
  isError?: boolean;
}

/**
 * Parameters for a `tools/call` request.
 *
 * @category `tools/call`
 */
export interface CallToolRequestParams extends TaskAugmentedRequestParams {
  /**
   * The name of the tool.
   */
  name: string;
  /**
   * Arguments to use for the tool call.
   */
  arguments?: { [key: string]: unknown };
}

