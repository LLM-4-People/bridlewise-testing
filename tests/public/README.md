# Public smoke tests

These tests cover the surfaces that a public clone can actually verify without the private corpus, frozen records, or a model provider:

- the `bin/bridlewise.mjs` launcher and its top-level help/version;
- the typed `harness` refusal and the honest `preflight` receipt;
- the secret/privacy scanner, including its failure modes;
- the required safety warning and documentation set;
- the licence and community files;
- the workflow policy: no workflow can cancel a `main` run, every pull-request check also runs in the merge queue, and every workflow is fork-safe (no `pull_request_target`; no privileged run checks out a pull request's head);
- the one YAML emitter (`engine/src/text/yaml-emit.ts`): 3,000 seeded random documents read back as their value under YAML 1.1 and 1.2.

Run them with:

```bash
npm run test:public
```

They use Node's built-in test runner. Their one third-party dependency is the `yaml` package, the repository's YAML reader, which the workflow policy parses each workflow with and the emitter's round trip reads back with. The larger prevention, cockpit, and engine suites live in the separate `bridlewise-testing` repository and have additional prerequisites.
