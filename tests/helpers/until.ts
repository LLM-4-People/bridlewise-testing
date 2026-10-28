/**
 * WAIT FOR A CONDITION, NEVER FOR A WALL CLOCK (NO-LOAD-BLOCK).
 *
 * Polls `cond` every 10 ms until it holds. There is NO deadline: a deadline
 * of N ms fails a correct test whenever the host is busy enough that the
 * condition needs longer to come true, which is a judgement of the host,
 * not the code (measured: thirteen cockpit tests each carried a private
 * `waitFor` that threw after 4 s). A condition that NEVER holds is a hang,
 * and a hang is ended by the suite's one wall bound, the hang backstop
 * (`testExecution.testHangBackstopMs`), which reports the test as hung by
 * name. The one wait every test uses; a private copy with its own deadline
 * is the defect this replaced.
 */
export async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((resolve) => setTimeout(resolve, 10));
}
