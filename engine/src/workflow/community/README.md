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

## Where it lives

The folder lives at `engine/src/workflow/community/`.
