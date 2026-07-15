# class: TestRun
* since: v1.62
* langs: js

Controls which tests will run and their expected status. A [TestRun] is available during [`method: Reporter.preprocess`].

## method: TestRun.exclude
* since: v1.62

Excludes a test or suite from the run. Excluded tests do not appear in the report and their bodies are not executed.

### param: TestRun.exclude.test
* since: v1.62
- `test` <[TestCase]|[Suite]>

Test or suite to exclude. The root suite and setup or teardown projects cannot be excluded.

## method: TestRun.fail
* since: v1.62

Marks a test or every test in a suite as "should fail". Playwright runs the tests and ensures they are actually failing, useful for documenting broken functionality until it is fixed.

### param: TestRun.fail.test
* since: v1.62
- `test` <[TestCase]|[Suite]>

Test or suite to mark as expected-to-fail. Setup and teardown projects cannot be changed.

### param: TestRun.fail.reason
* since: v1.62
- `reason` ?<[string]>

Optional explanation surfaced as the annotation description.

## method: TestRun.fixme
* since: v1.62

Marks a test or every test in a suite as fixme. The test bodies are not executed and the tests are reported as skipped, with the intention to fix them.

### param: TestRun.fixme.test
* since: v1.62
- `test` <[TestCase]|[Suite]>

Test or suite to mark as fixme. Setup and teardown projects cannot be changed.

### param: TestRun.fixme.reason
* since: v1.62
- `reason` ?<[string]>

Optional explanation surfaced as the annotation description.

## method: TestRun.skip
* since: v1.62

Skips a test or every test in a suite. The test bodies are not executed and the tests are reported as skipped.

### param: TestRun.skip.test
* since: v1.62
- `test` <[TestCase]|[Suite]>

Test or suite to skip. Setup and teardown projects cannot be changed.

### param: TestRun.skip.reason
* since: v1.62
- `reason` ?<[string]>

Optional explanation surfaced as the annotation description.
