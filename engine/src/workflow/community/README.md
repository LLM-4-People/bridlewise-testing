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
  contact) and the intake registry (`docs/community/intake.json`: the issue
  forms with the issue type each sets, the chooser's contact links, the
  Discussion categories and their forms). `roleForPermission` maps a
  collaborator's permission answer to a role; `teamsOf` is the teams the forge
  applies. Anything inconsistent is `community_source_invalid`.
- `health-files.ts` — THE GENERATED HEALTH FILES AND FORMS: CONTRIBUTING,
  CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE and the pull-request template
  from `docs/community/templates/*.tmpl` (their `{{slot}}`s filled from the
  sources, `package.json` and the guardian's declared compiler), and the issue
  forms, `config.yml` and the Discussion forms from the intake registry.
  `syncCommunityFiles` is `harness sync`'s and `harness check`'s
  `community-files` arm: a hand edit, or a form the registry no longer
  declares, is drift. Forms set an issue type and never labels: labels are the
  projector's.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/community/`.

- `health-files.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `sources.ts` is consumed by `engine/src/workflow/community/health-files.ts`.

<!-- /consumers:generated -->
