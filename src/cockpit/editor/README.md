# Editor

The editor room: the project's files and what you can do with them — buffer, tree, save path, and the delete shield a destructive verb must pass.

## What each file does

- `buffer.ts` — THE EDITOR BUFFER — the single owner of "which file is open".
- `destructive.ts` — THE DELETE SHIELD — the rule a destructive verb must pass.
- `editor-config.ts` — EDITOR ROOM (the room's tunable constants).
- `feed.ts` — EDITOR — the doors to the server, and the honest states of each.
- `file-kind.ts` — WHAT A FILE IS, AND WHAT THE ROOM MAY HONESTLY SAY ABOUT IT.
- `open-request.ts` — FILE, ASKED FOR FROM OUTSIDE THE EDITOR — the one-shot seam.
- `save.ts` — THE SAVE PATH — and the two things it makes impossible.
- `tree.ts` — THE FOLDER STRUCTURE — pure data.
- `DeleteConfirm.svelte` — THE DELETE CONFIRMATION — the one destructive control.
- `FilePane.svelte` — THE FILE — the right half of the room.
- `FileTree.svelte` — THE FOLDER STRUCTURE — the left half of the room.
- `TextEditor.svelte` — THE TEXT AREA — where an edit actually happens.

## Where it lives

The folder lives at `src/cockpit/editor/`.
