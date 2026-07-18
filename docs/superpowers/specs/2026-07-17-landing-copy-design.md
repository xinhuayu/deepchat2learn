# Landing Copy Design

## Goal

Make the landing page more concise and make the required topic input explicit.

## Approved changes

- Remove the descriptive paragraph immediately below “Turn Hot Conversations into Deep Learning.”
- Change the topic-field label to “What would you like to discuss today? (required)”.
- Keep the existing `required` HTML attribute on the topic textarea.
- Update the existing client copy regression so the removed paragraph cannot return and the required label is preserved.

## Scope

Only `public/index.html` and its matching assertion in `tests/client.test.mjs` change. No layout, styling, form behavior, or API behavior changes.
