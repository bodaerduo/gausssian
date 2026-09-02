# DEBUG REPORT

- **Symptom:** The generated model appeared vertically inverted in the preview, and the interaction guidance was unclear.
- **Root cause:** Brush's exported COLMAP scene uses the opposite vertical axis from the web viewer's default scene orientation.
- **Fix:** Apply a 180-degree X-axis scene rotation (`[1, 0, 0, 0]`) and clarify the controls as left-drag to rotate and wheel to zoom.
- **Evidence:** `node --test tests/ply-preview-format.test.mjs`, `npm run lint`, and `npm run build` all pass.
- **Status:** DONE_WITH_CONCERNS — visual confirmation requires refreshing the deployed preview with a real generated scene.
