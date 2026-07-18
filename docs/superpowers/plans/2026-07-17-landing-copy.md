# Landing Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant landing-page copy and mark the discussion topic as required.

**Architecture:** This is a static copy-only update. The landing-page HTML remains the source of truth and the existing client test verifies the visible text.

**Tech Stack:** Static HTML, Node.js test runner.

## Global Constraints

- Change only the approved landing-page copy and its regression assertion.
- Preserve the existing required textarea behavior.

---

### Task 1: Update landing-page copy

**Files:**
- Modify: `public/index.html:21-25`
- Modify: `tests/client.test.mjs:728-736`

**Interfaces:**
- Consumes: the topic textarea identified by `id="topic"`.
- Produces: the exact visible label `What would you like to discuss today? (required)`.

- [ ] **Step 1: Write the failing regression assertion**

```js
assert.match(html, /What would you like to discuss today\? \(required\)/);
assert.doesNotMatch(html, /Choose a topic, answer one question at a time/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/client.test.mjs`

Expected: the landing-copy test fails because the old label and paragraph remain.

- [ ] **Step 3: Apply the minimal HTML update**

```html
<h1>Turn Hot Conversations into Deep Learning</h1>
...
<label for="topic">What would you like to discuss today? (required)</label>
```

- [ ] **Step 4: Run the client tests**

Run: `npm.cmd test -- tests/client.test.mjs`

Expected: all tests pass.
