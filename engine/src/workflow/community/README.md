# Community

The community surface of the repository (github-only §10): the files GitHub
shows a contributor, generated from single sources, and the sources every
community bot reads. People and agents contribute through the same door; this
folder owns what they are told and who may do what.

## What each file does

- `sources.ts` — THE COMMUNITY SOURCES, read and validated in one place: the
  role table (`docs/community/roles.json`: the ladder contributor → triager →
  reviewer → maintainer, each role's GitHub permission and team, whether its
  approval counts as independent verification, the members and the conduct
  contact), the intake registry (`docs/community/intake.json`: the issue forms
  with the issue type each sets, the chooser's contact links, the Discussion
  categories and their forms) and the features (`docs/community/features.json`).
  EVERY CLAIM HAS ITS RECEIPT: each category, form type and feature is
  `{ "live": "<receipt>" }` or `{ "planned": "<tracking URL>" }`. The form
  schema refuses what GitHub would (a dropdown without options, `render` off a
  textarea, a repeated field id, the generated `confirmations` id).
  `roleForPermission` maps a collaborator's permission answer to a role;
  `teamsOf` is the teams the forge applies. Anything inconsistent is
  `community_source_invalid`.
- `health-files.ts` — THE GENERATED HEALTH FILES AND FORMS: CONTRIBUTING,
  CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE and the pull-request template
  from `docs/community/templates/*.tmpl` (their `{{slot}}`s filled from the
  sources, `package.json` and the guardian's declared compiler; `{{feature:id}}`
  is a feature's sentence only while it is live, and `{{planned}}` lists every
  planned claim with its tracking link), and the issue forms, `config.yml` and
  the Discussion forms from the intake registry (a planned issue type is never
  named, a planned category has no form and no link). The generator owns every
  place GitHub reads these from (the root, `.github/`, `docs/`; any case, any
  extension; every file in a template folder): a file there it did not write is
  a shadow — drift for `harness check`, and for `harness sync` its own stale
  output deleted or a person's file refused (`community_shadow_file`). A
  template that names no output is drift. A tree with no community surface at
  all is converged by absence; otherwise a missing source is a typed failure.
  `syncCommunityFiles` is the `community-files` arm of `harness sync` and
  `harness check` (a refusal is the step's failure, never a crash).

- `commands.ts` — THE ISSUEOPS COMMANDS: the one registry (`/help`, `/status`,
  `/accept`, `/decline`, `/duplicate`, `/reproduce`, `/explain`: each one's
  minimum role, where it works, its usage and summary), `parseCommandLine` (a
  comment's FIRST non-blank line only, so a quote never re-runs a command),
  `authorise` (the commenter's permission against the role ladder, never
  `author_association`) and `commandTable` (the generated command table).
- `issue-ops.ts` — THE DECISION, pure: `decide(comment, facts)` answers a reply
  and possibly an action — a tracker RECORD to add through a pull request
  (`/accept`, `/decline`, `/duplicate`: the issue's state is the projector's,
  never a command's), or the test a Flake report's path field names
  (`/reproduce`: checked, repository-relative, never free text); `/explain` is
  the door's. `parseFormBody` reads an issue form's answers by the intake
  registry's labels; `untrusted` neutralises what a person typed (no mention,
  no marker, one bounded line).
- `replies.ts` — THE BOT REPLIES: `docs/community/replies/<key>.md.tmpl`, each
  key's slots declared once (`REPLY_SLOTS`, judged by `replyTemplateViolations`
  in `harness check`), rendered under a marker naming what they answer.
- `executor.ts` — THE EXECUTOR on the forge port: one `issue_comment` event
  carried out — the commenter's permission (`GET …/collaborators/{u}/permission`),
  the tracker records, the door's check run for `/explain` — and the ONE reply
  per command comment posted or edited (`upsertReply`: only the bot's own
  comment carrying the marker). A bot's comment, an edit and a comment with no
  command cost no request; a record action is handed back to the caller.
- `record.ts` — THE INTAKE RECORD, LANDED: `intakeItemText` (the decision as a
  `bridlewise-tracker-item/v1` item in lane `floor`, its title made a plain YAML
  scalar, its body where it came from — never the reporter's text, which stays
  the issue's), `writeIntakeRecord` (judged with every other item by the
  tracker's reader first, then the board regenerated) and `landIntakeRecord`
  (committed on `intake/<id>`, published by `publishBranch` as a signed twin,
  one ready pull request). The issue is never touched: the projector adopts it
  from the record's `gh` field once the record lands.

- `welcome.ts` — THE WELCOME AND THE THANK-YOU: a newcomer's first issue
  (`welcomeIssue`, on the `issues: opened` event) or open pull request
  (`welcomeOpenPullRequests`, a scheduled pass, since a fork's own run cannot
  comment) gets one welcome, and a first landed pull request one thank-you
  (`thankFirstLanding`), each under its marker. "First" is GitHub's search
  count; `author_association` only picks the greeting; a bot is never greeted.
- `credit.ts` — CONTRIBUTOR CREDIT, pure: `contributorsOf` (each commit's
  author and `Co-authored-by:` people, keyed by email, the tooling — bots,
  Apps, identities the caller declares — never credited) and `releaseCredit`
  (a release's contributors and its newcomers, for the release notes).
- `moderation.ts` — MODERATION, from `docs/community/moderation.json`: the
  spam signal by mode (`off`, `manual` reports, `approval` proposes a limit;
  a limit is never applied automatically), `lockDue` (when the projector locks
  a closed issue) and `applyInteractionLimit` (the maintainer's action).
- `community-cli.ts` — THE `harness community` DOOR: `comment`, `issue`,
  `welcome-pulls`, `thank`, `credit`, `spam-signal` and `limit`, on the
  `forge` configuration's trunk with the token in `GH_TOKEN`; events are read
  from the file GitHub writes, never from a command line.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/community/`.

- `commands.ts` is consumed by `engine/src/workflow/community/health-files.ts`, `engine/src/workflow/community/issue-ops.ts`.
- `community-cli.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `credit.ts` is consumed by `engine/src/workflow/community/community-cli.ts`.
- `executor.ts` is consumed by `engine/src/workflow/community/community-cli.ts`, `engine/src/workflow/community/welcome.ts`.
- `health-files.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `issue-ops.ts` is consumed by `engine/src/workflow/community/executor.ts`, `engine/src/workflow/community/record.ts`.
- `moderation.ts` is consumed by `engine/src/workflow/community/community-cli.ts`, `engine/src/workflow/community/health-files.ts`.
- `record.ts` is consumed by nothing yet.
- `replies.ts` is consumed by `engine/src/workflow/community/executor.ts`, `engine/src/workflow/community/health-files.ts`, `engine/src/workflow/community/issue-ops.ts`, `engine/src/workflow/community/welcome.ts`.
- `sources.ts` is consumed by `engine/src/workflow/community/commands.ts`, `engine/src/workflow/community/executor.ts`, `engine/src/workflow/community/health-files.ts`, `engine/src/workflow/community/issue-ops.ts`, `engine/src/workflow/community/moderation.ts`, `engine/src/workflow/community/replies.ts` and 2 more.
- `welcome.ts` is consumed by `engine/src/workflow/community/community-cli.ts`.

<!-- /consumers:generated -->
