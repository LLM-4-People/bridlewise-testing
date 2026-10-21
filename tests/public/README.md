# Public smoke tests

These tests cover the surfaces that a public clone can actually verify without the private corpus, frozen records, or a model provider:

- the `bin/bridlewise.mjs` launcher and its top-level help/version;
- the typed `harness` refusal and the honest `preflight` receipt;
- the secret/privacy scanner, including its failure modes;
- the required safety warning and documentation set;
- the licence and community files;
- (the workflow policy — no workflow can cancel a `main` run, every gating workflow runs unfiltered on every pull request and merge group — is the workflow generator's own lint: `engine/src/workflow/gates/workflows.ts`, tested in `engine/test/workflow/gates/workflows.test.ts`).

Run them with:

```bash
npm run test:public
```

They use Node's built-in test runner. Their one third-party dependency is the `yaml` package, the repository's YAML reader, which the workflow policy parses each workflow with. The larger prevention, cockpit, and engine suites live in the separate `bridlewise-testing` repository and have additional prerequisites.
