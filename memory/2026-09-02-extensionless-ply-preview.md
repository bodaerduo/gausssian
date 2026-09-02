# DEBUG REPORT

- **Symptom:** Gaussian viewer reported `File format not supported` for `/api/v1/reconstructions/<id>/download`.
- **Root cause:** `gaussian-splats-3d@0.4.7` infers scene format from the URL suffix. The extensionless API URL returns a PLY with a `.ply` content-disposition filename, but the viewer does not use that response header for format detection.
- **Fix:** Pass `SceneFormat.Ply` explicitly to `Viewer.addSplatScene`.
- **Evidence:** `node --test tests/ply-preview-format.test.mjs`, `npm run lint`, and `npm run build` all pass.
- **Regression test:** `front/tests/ply-preview-format.test.mjs`.
- **Related:** Regression introduced by commit `b6d1d3a`, which replaced the custom PLY fetch/parser with `gaussian-splats-3d` without specifying the scene format.
- **Status:** DONE
