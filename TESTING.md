# Testing & Verification

This document records how items 4 and 5 (and supporting crash recovery) were verified on the actual environment.

## (a) Real Grok CLI headless single-image generation end-to-end

Command:
```
npm run test:grok
```

What it does:
- Spawns `grok -p "..." --yolo --no-plan --max-turns 12 --output-format json`
- Prompt instructs agent to use Imagine capability and copy result to a target path in test-artifacts/.
- Asserts exit code handling, file written with reasonable size, and marker in response.

Result (run on 2026-07-07):
- Exit 0
- 164kB+ PNG written at target
- Confirmed via `grok --help` + agent/headless docs + @-attachment tests beforehand that this is the correct syntax (no --generate-image etc.).
- See `test-grok-image.js` and previous experiments in `test-grok-invoke.js`.

This test must be re-run after any change to `lib/grokBatch.js`.

## (b) Synthetic 700+ frame stitch test completing + audio sync

Command:
```
npm run test:stitch
```

What it does:
- Generates 720 distinct tiny frames via ffmpeg (frame_0000.png ...).
- Generates matching-length sine audio (72s at BEAT_SECONDS=0.1).
- Calls the real `stitch()` using 720 beats (exercises 36 sub-clips).
- Uses ffprobe on final.mp4 and audio.
- Asserts diff <= 0.25s and successful completion (no open-file or filter errors).

Result:
- Completed in ~10s wall time.
- final duration 72.000s, audio 72.000s, diff 0.000s.
- 36 subclips + concat + mux path exercised.
- See `test-stitch-long.js` + `lib/stitch.js` (SUBCLIP_FRAMES, hold compensation math, concat demuxer).

This proves the rewrite scales past the old single-pass 700-input xfade graph.

## (c) Simulated worker crash + recovery

How to simulate:

1. Start worker + submit a job (or manually create a job.json with status:"generating", progress:{batchesDone:2, batchesTotal:10}, and a few frame_*.png already present in output/images).
2. Kill the worker process (`pkill -f worker.js` or Ctrl-C).
3. Restart `node worker.js` (or via pm2 restart).
4. Observe in logs: `[recover] queued <id> to resume generating from batch 2`
5. Job should pick up, skip already-done batches (no re-generation), finish the remaining, reach "done".

Implementation:
- `recoverInterruptedJobs()` runs at worker module load.
- For status=generating with batchesDone < total: reset to "queued".
- `processJob` uses persisted `segments`, `styleSummary`, `beats` + `progress.batchesDone` to skip completed work and start the for-loop at the right index.
- Per-batch retry (up to 3, backoff) + isRetryable() also exercised on transient errors.

Manual test (or scripted) must show a mid-generation crash does not restart from batch 0 and that already-written images are not overwritten.

## Additional notes

- All changes preserve: one job at a time, fresh grok per batch, file state, 4GB-friendly RAM profile.
- After edits, run `npm run test:grok && npm run test:stitch` before considering stitch/grok work complete.
- Real 2h jobs will take wall-clock time; the tests use time-scaled equivalents that still hit the large-N code paths.
