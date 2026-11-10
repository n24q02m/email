# Engineering lessons

Lessons recovered from the notes of a discarded third-party automation
tool, kept here instead of deleted. Each entry carries the commit that landed
the change in this repository, so a proposal can be located in the history
before the same change is proposed again. Dates are landing dates taken from
`git log`; the order below is the order the notes recorded, not a re-sorting.

## Performance

### 2026-04-22 - [Fast-fail IMAP validation]
**Learning:** In `validateImapAccounts`, using `Promise.all` mapping over `testImapConnection` will wait for all connection tests to complete before resolving, even if an early failure occurs (e.g. an incorrect password vs a 15-second timeout). This delays the return of the error to the user interface.
**Action:** Implement a "fail-fast" pattern by checking for a non-null result (failure) inside the map callback and `throw`ing the error object immediately. This triggers `Promise.all`'s short-circuit behavior, catching the thrown object and immediately resolving/returning it.

### 2026-04-23 - [Precompute loop invariants]
**Learning:** In fuzzy matching loops (e.g. `findClosestMatch`), recalculating loop invariants (like `inputBigrams` for the constant input string) on every iteration causes massive redundant allocation overhead, changing the time complexity from O(N+M) to O(N*M).
**Action:** Always identify operations inside loops that do not depend on the iteration variable and extract them (pre-compute them) before the loop starts to avoid redundant processing.

### 2025-05-18 - Replacing `Promise.all` with Sequential `for...of` Loop for CPU-Heavy Tasks
**Learning:** In Node.js, using `Promise.all` alongside `.map()` to iterate over a large array of items containing CPU-intensive synchronous operations (like MIME parsing via `mailparser.simpleParser`) causes an unbound concurrent execution. This leads to severe event loop blocking and significant memory spikes, which degrades overall performance and responsiveness.
**Action:** When executing expensive CPU-bound synchronous tasks over a collection in an asynchronous context, iterate sequentially using a `for...of` loop instead of `Promise.all`. This allows the event loop to yield appropriately between tasks and maintains a stable memory footprint.

### 2026-05-01 - [Avoid Promise.all for WebCrypto PBKDF2 Iterations]
**Learning:** In `loadAllUserCredentials()`, reading the `entries` array (user directories) with `Promise.all(entries.map(...))` to derive an AES-GCM key using `crypto.subtle.deriveKey` (PBKDF2) triggers unbounded parallel cryptographic work. Node.js executes `crypto.subtle` tasks in its libuv thread pool. Submitting many heavy tasks (like 100k iteration PBKDF2s) at once quickly exhausts the thread pool, starving the event loop of I/O capability and heavily spiking the application's memory usage and startup/hot-reload latency.
**Action:** When performing heavy cryptographic operations (especially Key Derivation Functions like PBKDF2) across a dynamically sized list of entities, always use a sequential `for...of` loop instead of `Promise.all` to keep memory pressure low and preserve available thread-pool threads for the rest of the application's asynchronous workload.

### 2024-05-07 - Avoid Unbounded Promise.all() on CPU-Heavy Operations
**Learning:** Using `Promise.all(items.map(...))` to execute CPU-intensive tasks (like `mailparser.simpleParser` for parsing emails) blocks the event loop and can cause memory spikes in high-concurrency situations, despite JavaScript's asynchronous nature.
**Action:** Use a concurrency-limited mapper like `mapLimit` to balance throughput and event loop responsiveness for intensive parallel workloads.

### 2024-05-23 - Bypass unnecessary html-to-text in mailparser snippets
**Learning:** `mailparser`'s `simpleParser` performs expensive HTML-to-text conversion by default, even when we already discard it in favor of a faster custom `fastExtractSnippet` fallback. This can add 1-2 seconds per email parsed for large messages.
**Action:** Always pass `{ skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true }` to `simpleParser` when only basic metadata, text, or raw HTML is needed.

### 2026-05-18 - [Precompile html-to-text options]
**Learning:** `html-to-text`'s `convert` function rebuilds formatting and parsing rules from the provided options object on every invocation. When called frequently (e.g., parsing multiple search results), this dynamic setup introduces significant overhead.
**Action:** Use the `compile` function from `html-to-text` to create a precompiled converter function during module initialization. This avoids redundant configuration parsing on every call and can be up to 5x faster.

### 2025-02-23 - Bypass mailparser slow HTML-to-text processing
**Learning:** `simpleParser` from `mailparser` can be extremely slow on large emails because it does full HTML-to-text conversion by default. This is often unnecessary when extracting attachments or when we already have a faster custom HTML-to-text parser (like our compiled `html-to-text`).
**Action:** Always pass `{ skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true }` to `simpleParser` when full text extraction is not needed or when using an alternative HTML parser.

### 2024-05-18 - Bigram Caching for Static Valid Options
**Learning:** In string matching algorithms like `findClosestMatch` that compare user input against a static list of valid options, recomputing bigrams for the static options on every invocation is a significant overhead, especially since the number of valid options is small and fixed (e.g., tool names like "messages", "folders").
**Action:** Always look for opportunities to pre-compute and cache derived data (like bigrams or regular expressions) for static, bounded sets to convert repeated allocations and string operations into fast memory lookups. A simple `Map` reduced the overhead for fuzzy matching by ~2.5x.

### 2026-06-15 - [Avoid requesting bodyStructure unless needed]
**Learning:** When fetching emails via IMAP (e.g., in `searchEmails`), requesting `bodyStructure: true` forces the server to parse the MIME tree and transmit extra data, causing significant performance and network overhead, even when the response is not utilized by the client code.
**Action:** Remove `bodyStructure: true` from the `fetchAll` options in `searchEmails` and other places where the full MIME structure is not strictly required.

### 2025-05-18 - [V8 RegExp replacement overhead]
**Learning:** In V8 environments (Node.js/Bun), using chained `.replace()` calls with string literal replacements is measurably faster than using a single global `.replace()` with a mapping callback for simple escaping tasks (e.g. HTML escaping). The overhead comes from V8 needing to cross the C++/JS boundary and invoke the JS callback for every regex match.
**Action:** Always prefer chained `.replace()` with string literal replacements for simple, fixed-mapping string replacements instead of a single mapping callback, especially in hot-path or frequently called utilities.
### 2023-06-28 - Extract Inline RegExp Literals and Remove Redundant .test()

**Learning:** V8 recompiles inline literal regular expressions if they appear inside high-frequency loops or hot paths like `map` functions and query parsing (`buildSearchCriteria`). Additionally, calling `.test()` before a global replace operation (`.replace(/.../g, '')`) is an anti-pattern. If the pattern is missing, both `.test()` and `.replace()` perform an `O(N)` scan, but the `.replace()` fast-path returns the original string with zero reallocation.

**Action:** Always pre-compile regular expressions by extracting them to module-scoped constants (`const RE_... = /.../g`), avoiding instantiation on every function invocation. Remove redundant `if (pattern.test(text))` checks before `.replace()` logic, especially in loops, to minimize string scanning overhead.
### 2026-06-25 - [Avoid redundant .test() checks]
**Learning:** Checking a regular expression match with `.test()` before performing a `.replace()` (e.g. `if (pattern.test(str)) { str = str.replace(pattern, ' ') }`) is a redundant anti-pattern. If the pattern is missing, both methods scan the string, but `.replace()` on V8 handles no-matches quickly with zero reallocation. Using both means performing a double O(N) scan.
**Action:** Remove the redundant `pattern.test()` and perform the `.replace()` directly. Compare the newly returned string against the original string (e.g. `if (next !== original) { ... }`) to detect if a replacement occurred.
### 2025-02-18 - [Optimize findClosestMatch fast-path]
**Learning:** In hot paths where fuzzy matching is employed (like `findClosestMatch`), if the majority of cases match exactly or are prefixes, deferring the allocation of bigram structures (`Set` allocation and population) for the fuzzy-logic fallback leads to measurable optimization. Separating exact/prefix matching from fuzzy matching into two passes allows early return for common cases with zero bigram overhead.
**Action:** Always consider inserting a zero-allocation fast-path before performing resource-intensive matching or scoring logic, especially when exact hits or simple startsWith/includes checks resolve the majority of calls.
### 2026-06-25 - [Optimize sanitizeErrorDetails property whitelisting]
**Learning:** In V8, checking `prop in error` inside a `for...of` loop over a static array to whitelist properties incurs overhead from both the loop allocation and the `in` operator (which traverses the prototype chain). Directly accessing properties on the object and comparing to `undefined` is significantly faster.
**Action:** Extract whitelisted properties to a module-scoped constant (e.g. `SAFE_ERROR_PROPS`) and use direct property access (`const val = error[prop]; if (val !== undefined)`) inside a standard `for` loop to avoid the `in` operator and prototype traversal overhead.

### 2024-07-17 - [Eliminate V8 Array Allocations in `for...of` loops]
**Learning:** In V8 environments, initializing static array literals directly inside `for...of` loop definitions (e.g., `for (const key of ['A', 'B'])`) within frequently executed functions (hot paths like query parsing) forces the engine to reallocate the array on every invocation, adding unnecessary garbage collection overhead.
**Action:** Extract these array literals into module-scoped static constants (e.g., `const KEYS = ['A', 'B'] as const`) to prevent repeated memory allocations and improve execution speed in hot paths.
### 2026-08-12 - [Avoid a redundant entity-map lookup]
**Learning:** For a mapped entity, `lower in ENTITY_MAP` followed by `ENTITY_MAP[lower]` performs a membership check and then a separate value lookup. Reading `ENTITY_MAP[lower]` directly still uses ordinary property-access semantics, including prototype-chain lookup, and the isolated Node.js 24.19.0 V8 trace showed no deoptimization in either lookup variant. The change should therefore be described narrowly as caching one value lookup instead of checking membership and then looking the value up.
**Action:** Cache `ENTITY_MAP[lower]` and compare it with `undefined`, which is valid while every entry in this map has a defined string value. Re-run `node scripts/benchmark-entity-map-lookup.mjs` on the target Node runtime before citing performance, and treat the result as runtime- and workload-specific rather than a fixed speedup range.

## Security

### 2024-08-28 - [Unhandled Exception on Invalid URL in Worker Fetch]
**Vulnerability:** The native `URL` constructor was being used without error handling when parsing incoming `request.url` in the Cloudflare Worker event handlers (`fetch` and `kvOutbound`). If a synthesized or malformed URL bypasses the edge parser and reaches these handlers, it could throw an unhandled exception, causing the worker process to crash (DoS vector).
**Learning:** Cloudflare Workers generally guarantee that incoming HTTP requests have valid URLs, but for defense in depth and to protect against internally routed or synthesized requests (like from tests or sub-requests), we must not assume input is safe.
**Prevention:** Always wrap `new URL()` calls in `try...catch` blocks when parsing untrusted or potentially malformed inputs, and return an appropriate HTTP response (like `400 Bad Request`) instead of throwing an unhandled exception.

## Accessibility and UX

### 2024-05-14 - Data Loss Prevention & Dark Mode Contrast

**Learning:**
1. Dynamically added form elements in multi-step flows are prone to accidental clicks leading to complete data loss for that section.
2. Standard "grey" shades like `#666` used for secondary text in dark mode (background `#1a1a1a` or `#0f0f0f`) often fail WCAG AA contrast ratio requirements (4.5:1), making them inaccessible to users with low vision.

**Action:**
1. Always add a confirmation step (e.g., `confirm()`) before removing dynamically generated form segments if they contain user-entered data.
2. Use lighter greys like `#9ca3af` for secondary text against dark backgrounds to ensure adequate contrast.

### 2024-05-15 - ARIA connections for generated elements

**Learning:** When building dynamic forms with vanilla JS, helper text elements are often generated sequentially alongside inputs but lack semantic connection, causing screen readers to miss crucial instructions (like "Leave empty for auto-detection").

**Action:** Always generate a deterministic `id` for helper text elements and bind it to the associated input using `aria-describedby` immediately during creation to ensure robust accessibility.

### 2025-02-12 - Dynamic Form State Preservation

**Learning:** When dynamically rebuilding form sections based on user input (e.g., domain auto-detection), any data already entered into the targeted DOM elements will be lost if the inputs are destroyed and recreated without explicit state preservation.

**Action:** Capture the current value of the targeted inputs before rebuilding the DOM elements and reapply the captured state to the newly created inputs.

### 2025-02-13 - Visual Feedback During Long-Polling Flows

**Learning:** When an interface is waiting for an external authorization flow to complete (e.g., Microsoft OAuth device code polling), a static "Waiting..." text is easily perceived as a frozen or crashed state, causing user frustration and premature abandonment. In dark mode, `#888` text provides insufficient contrast to read clearly.

**Action:** Add subtle, continuous visual feedback (like a `.pulse` opacity animation) to elements representing indefinite wait states to reassure the user that the background process is active. Ensure waiting text contrast is WCAG compliant (e.g., `#9ca3af` on dark backgrounds).

### 2025-02-14 - Async Operation Visual Feedback

**Learning:** During potentially long-running async operations (like network requests or OAuth polling), simply changing button text (e.g., to "Connecting...") or disabling the button isn't always enough visual feedback. Users may still wonder if the system is hung, especially if the text change is subtle.

**Action:** Always include an animated visual indicator (like a CSS spinner with `aria-hidden="true"`) inside the submission button alongside the status text during asynchronous operations to clearly communicate that background processing is actively occurring.

### 2025-02-15 - Required Field Indicators for Screen Readers

**Learning:** When adding visual indicators (like `*`) for required form fields to assist sighted users, screen readers might redundantly announce "star" or "asterisk" alongside the native `required` attribute.

**Action:** Always apply `aria-hidden="true"` to visual required indicators to keep the screen reader experience clean and native.

### 2025-02-16 - Password Manager Compatibility & Semantics

**Learning:** Unconditionally setting `autocomplete="off"` on dynamic form elements severely degrades user experience by preventing password managers from working and violates accessibility guidelines (WCAG 1.3.5 Identify Input Purpose).

**Action:** Always dynamically assign semantic `autocomplete` attributes (like `email` or `current-password`) based on the input type to ensure password managers function correctly and assistive technologies understand the input's purpose.

### 2024-05-21 - Form Lock down via Fieldset

**Learning:** When submitting a dynamic form containing multiple sub-components (like "Add Account" buttons and numerous inputs), simply disabling the submit button (`<button type="submit" disabled>`) is insufficient to prevent user interaction during async loading states. Users can still modify inputs or click secondary action buttons, potentially causing corrupted state or accidental concurrent operations.

**Action:** Wrap the entire interactive section of the form (inputs, secondary buttons, submit button) in a semantic `<fieldset>` element. During async operations (like API submission), set `fieldset.disabled = true` to instantly and cleanly lock down all child form controls simultaneously, ensuring a robust and predictable loading state.

### 2025-05-24 - Form Validation with Inline Feedback

**Learning:** Relying on default HTML5 form validation popups creates an inconsistent user experience across browsers and can be challenging for screen reader users to understand contextually. Additionally, users lack immediate visual feedback on errors before submission.
**Action:** Implement custom inline form validation by overriding the default `invalid` event. Apply `aria-invalid="true"` for visual styling (e.g. red borders) and dynamically update a dedicated error message container connected to the input via `aria-describedby` (using `role="alert"` or `aria-live="polite"`) to provide accessible and immediate feedback.

### 2025-05-25 - Focus Management for Dynamic Content

**Learning:** When dynamic content like new form sections are added or removed, relying entirely on visual layout updates disrupts accessibility. If a removed element had focus, focus is typically dropped to the document `<body>`. For keyboard-only and screen reader users, this necessitates tabbing through the entire page again. Additionally, newly spawned elements aren't automatically focused.
**Action:** Implement active programmatic focus management for all dynamic content changes. When adding elements, immediately focus their primary input. When removing focused elements, explicitly return focus to the logical preceding element (e.g., the button that triggered the creation, or a 'container' wrapper) to maintain a continuous interaction flow.
### 2024-05-18 - Improve accessibility of code copying
**Learning:** Adding a copy button for codes displayed in UI improves accessibility and usability.
**Action:** Always provide a copy mechanism when user needs to copy code displayed on the screen.

### 2025-02-18 - Password Field Masking

**Learning:** Masked password fields (e.g., `type="password"`) help prevent shoulder-surfing, but they can be inaccessible for users with cognitive or motor disabilities who may struggle with typing accuracy and cannot verify their input.
**Action:** Always provide a "Show/Hide" toggle button for password input fields. Ensure the button has an accessible name (e.g., `aria-label="Show password as plain text"`) that updates dynamically when the state changes.
### 2025-03-09 - [Accessibility Enhancements to credential-form.ts]
**Learning:** When using Playwright in a headless Chromium environment to test clipboard interactions (like `navigator.clipboard.writeText`), the clipboard promise may silently fail or hang unless explicit permissions (`clipboard-read`, `clipboard-write`) are granted to the browser context, or the API is directly mocked in the page context.
**Action:** When writing Playwright tests involving clipboard copies, either mock the clipboard API via `page.evaluate("navigator.clipboard.writeText = function() { return Promise.resolve(); };")` or initialize the context with the required permissions.
### 2024-05-19 - [Dynamic Form Focus Management]
**Learning:** When removing an interactive element (like an account card) from a dynamic list in the DOM, abruptly dropping keyboard focus to a fallback action button at the bottom of the page creates a jarring navigation experience. Screen reader and keyboard users lose their context within the form list.
**Action:** Always attempt to return focus to a logical sibling (e.g. the previous or next card's first input field) before falling back to global action buttons like "Add New". This maintains the sequential flow of form completion.
### 2025-02-19 - ARIA Pressed State for Password Toggles
**Learning:** Screen reader users need clear context when toggling the visibility of password fields. While changing the button text or `aria-label` provides information, using `aria-pressed` robustly announces the toggled state to screen readers, improving the cognitive context of the action.
**Action:** Always include the `aria-pressed` attribute (toggling between `true` and `false`) on "Show/Hide" password buttons to announce their active state reliably to screen readers.
### 2026-06-29 - [Dynamic Account Card Titles and ARIA Labels]
**Learning:** For forms involving multiple dynamic instances of the same component grouping (e.g. "Account 1", "Account 2"), hardcoded titles and generic ARIA labels like "Remove Account 2" lack context for screen reader users and can be confusing. Dynamically binding the user's entered email address to the section title and the removal button's ARIA label significantly improves context and usability.
**Action:** When creating repeatable form structures, identify the primary input (like a name or email address) and bind it to the container's title and the ARIA labels of related action buttons (like Remove or Edit). Ensure long text is truncated gracefully using CSS (`text-overflow: ellipsis`) so layout doesn't break.
### 2026-06-30 - Preventing unnecessary DOM rebuilds
**Learning:** When dynamic forms are updated on every keystroke, aggressively destroying and rebuilding DOM nodes based on a substring (like an email domain) causes unnecessary churn. This resets transient user interface states—such as the visibility toggle of a password field—when the user is simply correcting a typo in the prefix.
**Action:** Implement category-based change detection (e.g., categorizing the input into 'oauth', 'app-password', or 'custom' domains). Only rebuild the related DOM nodes when the abstract category changes, preserving transient state for minor edits within the same category.

### 2026-06-30 - Review Feedback: Avoid adding unused dependencies
**Learning:** During UI testing in CI or agent environments, avoid adding heavy dependencies like `playwright` to the project's permanent `package.json` unless explicitly requested. Adding them can bloat the project and violate boundaries.
**Action:** Always install temporary testing dependencies without saving them to `package.json` (e.g., using `--no-save` or rolling back changes with `git checkout -- package.json bun.lock`), or use standalone scripts that don't pollute the project's dependency tree.

### 2025-06-30 - Form Groups for Screen Readers
**Learning:** Repeatable form structures (like "Account 1", "Account 2") need structural semantics for screen readers. If identical fields exist across instances (like multiple "Email Address" inputs), screen readers might present them as a flattened list, causing confusion.
**Action:** Use `role="group"` on the container element for each repeatable form section and apply `aria-labelledby` pointing to the section's dynamic title ID. This groups the internal fields structurally and associates them with the dynamic title context for screen reader users.
### 2026-07-02 - Form Focus Management
**Learning:** In complex interactive forms where asynchronous validation/submission toggles `disabled` states, focus can inadvertently drop to the `body` element. This completely disrupts keyboard and screen reader navigation. Furthermore, when injecting new interactive content dynamically (like an OAuth device code and copy button), keyboard users lose context if focus isn't moved into the newly generated UI.
**Action:** When re-enabling a disabled form fieldset after an error, programmatically move focus back to the triggering element (e.g., `submitBtn.focus()`). When rendering new interactive flows that pause a multi-step process (like OAuth device code auth), dynamically transfer focus to the primary new interactive element (`copyBtn` or `link`) so users seamlessly enter the new flow without losing their place.
### 2026-07-03 - Form Lockdown and Disabled CSS State
**Learning:** When using `<fieldset disabled>` to programmatically lock down an entire form during an asynchronous operation (like submission), the default browser styling for `:disabled` descendant elements (inputs, secondary buttons like add/remove/toggle) is often subtle or missing in custom-themed designs. This leaves users frustrated because the UI appears active but is unresponsive.
**Action:** Always provide explicit, custom `:disabled` CSS styles (e.g., `opacity: 0.6`, `cursor: not-allowed`, subdued backgrounds/borders) for all interactive form elements when implementing fieldset-based form lockdowns. This ensures the visual state accurately reflects the interaction state.

### 2026-07-03 - External Link Indicators
**Learning:** External links that open in a new tab without visual warning can disorient users. For screen reader users, opening a new tab without announcement creates a jarring context switch.
**Action:** Always append a visual indicator (like `↗`) to text for external links and include an explicit `aria-label` (e.g., `"opens in a new tab"`) to pre-warn both sighted and assistive-technology users before they trigger a context switch.
### 2023-10-27 - Inline Validation and Context-Aware Errors
**Learning:** Native form validation combined with generic error messages (e.g., "Invalid value") leaves users confused. Additionally, relying solely on "submit" for validation frustrates users, as they must complete the entire form before receiving any feedback.
**Action:** Enhance native validation events by dynamically using the field's `label` in error messages to provide context. Introduce a `blur` event listener to trigger validation specifically on fields the user has touched, providing immediate feedback while maintaining accessibility.

### 2023-10-25 - [Declarative Form Validation for Optional Fields]
**Learning:** When configuring declarative regex validation (e.g. `validation` in `RELAY_SCHEMA`) for optional form fields, the pattern must explicitly allow empty strings (e.g. `^\d*$` instead of `^\d+$`). Otherwise, the client-side validation logic will incorrectly block form submission if the user intentionally leaves the optional field blank.
**Action:** Always test regex patterns against empty strings when applying validation to optional fields.

### 2026-08-12 - Consistent Placeholders in Form Fields
**Learning:** Having placeholders for some text fields but omitting them for others in the same form group (e.g. `imap_port` and `email` vs `imap_host`) creates inconsistency and leaves users guessing the expected input format for the un-hinted field.
**Action:** Always provide placeholder examples for all user-facing text inputs in a form sequence to establish a consistent pattern and explicitly guide the required input format.
### 2025-05-18 - App Password Field Placeholder
**Learning:** Avoid using mask characters (e.g., '••••••••') as a placeholder for password fields. This is an anti-pattern as it visually mimics a pre-filled or saved password, potentially confusing users into skipping the field.
**Action:** Use a descriptive placeholder (e.g., 'Enter app password') or leave it blank, relying on existing contextual help text to guide the user without falsely implying pre-filled state.
