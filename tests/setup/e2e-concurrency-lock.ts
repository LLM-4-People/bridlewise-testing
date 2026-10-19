import { playwrightConcurrencyLock } from "./playwright-concurrency-lock.ts";

export default playwrightConcurrencyLock("browser e2e suite");
