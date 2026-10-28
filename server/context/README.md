# Context domain

The context domain owns what the model knows before it answers: the assembled
conversation history, the project it is working in, and the long-term memory
the harness carries between sessions. The LLM never reads the database or the
memory store directly — these modules build the prompt context once.

## What each file does

- `context-bridge.ts` — wires the canonical unified context manager and memory
  store into the web chat pipeline.
- `chat-history.ts` — reconstructs the `ChatMessage[]` projection from the
  database so the model has memory of the conversation.
- `project-context.ts` — builds the system prompt that gives the model
  awareness of the selected project: name, path, and file listing.
- `memory-bridge.ts` — the single server-side owner of harness memory access;
  every memory store, retrieve, and inject goes through here.

## Where it lives

The folder lives at `server/context/`.
